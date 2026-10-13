//! render_bridge — the `RENDERED` / `RENDER_INPUT` feeds.
//!
//! tugcast renders every streaming session's assistant text natively
//! (`tugmark::render_blocks`) and ships it to the deck on `RENDERED` (0xB0),
//! one JSON [`RenderedFrame`] per frame; the deck answers on `RENDER_INPUT`
//! (0xB1) with one JSON [`RenderInput`] per frame. These types are the Rust
//! half of `tugproto/src/rendered.ts`, and both halves are held to
//! `tugproto/src/__tests__/fixtures/rendered-parity.json`.
//!
//! A message is addressed by the wire's key for it (`message_key`). An
//! emission carries the message's ordered block list from the first block
//! that changed since the message's previous emission (`blocks_from`, read
//! against the emission numbered `base_seq`), and `html` only for hashes new
//! since that emission; hashes are FNV-1a 64 as decimal strings.
//!
//! The bridge task is the impure half around [`RenderStage`]: it taps
//! `CODE_OUTPUT` and `SESSION_STATE`, reads the pages' controls, and owns the
//! clock. The stage renders at most once per the shortest display period any
//! page asked for, with a timer armed only while something is dirty, and the
//! parse runs on a blocking thread so the loop keeps reading frames while it
//! renders.
//!
//! Every shell and body page, and any connection that has sent a control, has
//! its own pacer: its display period, its motion holders and its buffer. Each
//! render's batch is cut to the sessions the page subscribes to and sent to
//! that page alone, at most once per its period. While any of a page's
//! holders holds, its renders merge into its buffer, which the release, or
//! the last holder's expiry, sends as one bundle; one page's hold parks no
//! other page's renders. A connection with no pacer — a tool — takes every
//! batch whole.
//!
//! A `find` control is answered at once, to the page that asked, and never
//! held: the stage hands over each asked unit's text, `find_index` answers
//! on a blocking thread, and the rendered texts it had to extract come back
//! to the stage.
//!
//! Both directions carry the feed's version, [`RENDERED_FEED_VERSION`]: a
//! `render-batch` names the version it was written at, and a control the
//! bridge cannot read at its own version is refused. A deck's handshake
//! asks for a resync of every message, and the bridge answers that page at
//! once with an empty `render-batch`, so a deck learns that this tugcast
//! renders, and at which version, before any Message streams; a deck that
//! hears no such answer draws its own.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tugcast_core::{FeedId, Frame, PageRole};

use super::find_index::{FindAnswer, FindJob};
use super::render_stage::{RenderOutput, RenderStage};
use super::session_digest::SCOPE_IDLE_SWEEP_MS;
use crate::pages::{AddressedFrame, ClientFrame, Delivery, PageRegistry, SessionSubscription};

/// One top-level block of a rendered message, without its HTML.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedBlockWire {
    /// FNV-1a 64 over the block's source bytes, decimal.
    pub hash: String,
    pub kind: String,
    /// UTF-16 offsets into the message text.
    pub start_char: u32,
    pub end_char: u32,
    pub depth: u8,
    pub item_count: u16,
    pub row_count: u16,
}

impl From<&tugmark::RenderedBlock> for RenderedBlockWire {
    fn from(block: &tugmark::RenderedBlock) -> Self {
        Self {
            hash: block.hash.to_string(),
            kind: block.kind.clone(),
            start_char: block.start_char,
            end_char: block.end_char,
            depth: block.depth,
            item_count: block.item_count,
            row_count: block.row_count,
        }
    }
}

/// Which of a turn's text streams a message is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderChannel {
    Text,
    Thinking,
}

/// One message's emission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedMessageWire {
    pub message_key: String,
    pub channel: RenderChannel,
    /// This emission's number for the message, counting from 1.
    pub seq: u64,
    /// The emission `blocks` continues, when `blocks_from` is not zero: the
    /// receiver keeps that emission's first `blocks_from` blocks and appends
    /// `blocks`. Zero when the list is whole.
    pub base_seq: u64,
    /// Where `blocks` starts in the message's whole block list.
    pub blocks_from: u32,
    /// The ordered block list from `blocks_from` on.
    pub blocks: Vec<RenderedBlockWire>,
    /// Sanitized HTML by block hash, only for hashes new since the last
    /// emission.
    pub html: BTreeMap<String, String>,
    /// The rendered text's length in UTF-16 code units.
    pub text_length: u32,
    /// FNV-1a 64 over the rendered text's UTF-8 bytes, decimal.
    pub text_hash: String,
}

/// One session's messages in a render batch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedSessionWire {
    pub tug_session_id: String,
    pub messages: Vec<RenderedMessageWire>,
}

/// One literal-mode find match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindMatch {
    pub unit: String,
    pub start: u32,
    pub end: u32,
}

/// The version of the `RENDERED` / `RENDER_INPUT` protocol this tugcast
/// speaks: `RENDERED_FEED_VERSION` in `tugproto/src/rendered.ts`.
pub const RENDERED_FEED_VERSION: u32 = 1;

/// A frame on `RENDERED`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RenderedFrame {
    /// One tick's renders, every session's changed messages bundled, at
    /// protocol version `v`. Empty in answer to a deck's whole resync.
    #[serde(rename_all = "camelCase")]
    RenderBatch {
        v: u32,
        sessions: Vec<RenderedSessionWire>,
    },
    /// The answer to a [`RenderInput::Find`].
    #[serde(rename_all = "camelCase")]
    FindResult {
        request_id: String,
        tug_session_id: String,
        /// The query did not compile (grep mode only). Present only as
        /// `true`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        invalid: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        matches: Option<Vec<FindMatch>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        texts: Option<BTreeMap<String, String>>,
        missing: Vec<String>,
    },
}

/// A find query's options.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub grep: bool,
}

/// One `RENDER_INPUT` frame: a control, and the protocol version the deck
/// wrote it at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RenderInputFrame {
    pub v: u32,
    #[serde(flatten)]
    pub control: RenderInput,
}

/// A control on `RENDER_INPUT`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RenderInput {
    /// The deck's motion hold: renders buffer while any holder is held.
    #[serde(rename_all = "camelCase")]
    Motion {
        holder: String,
        held: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cap_ms: Option<u64>,
    },
    /// The display period emissions are paced to.
    #[serde(rename_all = "camelCase")]
    DisplayPeriod { period_ms: f64 },
    /// Every block's HTML on the next emission: one message, one session's,
    /// or all.
    #[serde(rename_all = "camelCase")]
    Resync {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tug_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_key: Option<String>,
    },
    /// A find query over a session's rendered text.
    #[serde(rename_all = "camelCase")]
    Find {
        request_id: String,
        tug_session_id: String,
        query: String,
        options: FindOptions,
        limit: u32,
        units: Vec<String>,
        mounted_units: Vec<String>,
        /// The text hash of each unit's rendered text the page already
        /// holds; a unit whose text still hashes the same is left out of
        /// the answer's `texts`.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        known_texts: BTreeMap<String, String>,
    },
}

/// The period emissions are paced to until the deck posts one.
pub const DEFAULT_PERIOD: Duration = Duration::from_millis(16);

/// The shortest hold a holder may ask for: the Worker's `MIN_HOLD_CAP_MS`.
pub const MIN_HOLD_CAP_MS: u64 = 1_000;

/// The shortest gap between idle sweeps. A sweep rides a render tick and
/// never a timer of its own, so a quiet process keeps no clock for it.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// Everything the bridge task needs besides the `RENDERED` lane it publishes
/// on.
pub(crate) struct RenderBridgeConfig {
    /// The shared `CODE_OUTPUT` broadcast, tapped for assistant text,
    /// thinking prose and the replay brackets.
    pub code_tx: broadcast::Sender<Frame>,
    /// `SESSION_STATE`, tapped for `closed`: a closed session's state is
    /// dropped whole.
    pub session_state_tx: broadcast::Sender<Frame>,
    /// The `RENDER_INPUT` sink the router feeds, each control with the
    /// connection that sent it.
    pub input_rx: mpsc::Receiver<ClientFrame>,
    /// The live pages: who is paced, which sessions each takes, who left.
    pub pages: Arc<PageRegistry>,
}

/// Run the bridge until `cancel`, publishing on `rendered_tx`, the addressed
/// `RENDERED` lane.
pub(crate) async fn run_render_bridge(
    config: RenderBridgeConfig,
    rendered_tx: broadcast::Sender<AddressedFrame>,
    cancel: CancellationToken,
) {
    let RenderBridgeConfig {
        code_tx,
        session_state_tx,
        input_rx,
        pages,
    } = config;
    let taps = Taps {
        code_rx: code_tx.subscribe(),
        state_rx: session_state_tx.subscribe(),
        input_rx,
        departures: pages.departures(),
    };
    render_bridge_task(taps, pages, rendered_tx, cancel).await;
}

/// The wires the bridge reads.
struct Taps {
    code_rx: broadcast::Receiver<Frame>,
    state_rx: broadcast::Receiver<Frame>,
    input_rx: mpsc::Receiver<ClientFrame>,
    departures: broadcast::Receiver<u64>,
}

/// One page's pace and hold ([P07]).
struct PagePacer {
    period: Duration,
    /// When this page was last sent a batch.
    last_flush: Option<Instant>,
    /// Each holder's expiry.
    holders: HashMap<String, Instant>,
    /// What this page has not been sent yet, merged.
    buffer: Vec<RenderedSessionWire>,
}

impl PagePacer {
    fn new() -> Self {
        Self {
            period: DEFAULT_PERIOD,
            last_flush: None,
            holders: HashMap::new(),
            buffer: Vec::new(),
        }
    }

    /// When the buffer is due: only while unheld and holding something, a
    /// period after the last batch this page was sent.
    fn flush_at(&self, now: Instant) -> Option<Instant> {
        (self.holders.is_empty() && !self.buffer.is_empty()).then(|| match self.last_flush {
            Some(last) => (last + self.period).max(now),
            None => now,
        })
    }

    fn next_expiry(&self) -> Option<Instant> {
        self.holders.values().min().copied()
    }

    fn set_period(&mut self, period_ms: f64) {
        if period_ms.is_finite() && period_ms > 0.0 {
            self.period = Duration::from_secs_f64(period_ms.clamp(1.0, 1_000.0) / 1_000.0);
        }
    }

    fn take(&mut self, now: Instant) -> Vec<RenderedSessionWire> {
        self.last_flush = Some(now);
        std::mem::take(&mut self.buffer)
    }

    /// A render's emission for this page: sent now when the page is unheld
    /// and due, merged into its buffer otherwise.
    fn deliver(
        &mut self,
        batch: Vec<RenderedSessionWire>,
        now: Instant,
    ) -> Option<Vec<RenderedSessionWire>> {
        if batch.is_empty() {
            return None;
        }
        merge_batch(&mut self.buffer, batch);
        self.flush_due(now)
    }

    /// The buffer, when it is due.
    fn flush_due(&mut self, now: Instant) -> Option<Vec<RenderedSessionWire>> {
        match self.flush_at(now) {
            Some(at) if at <= now => Some(self.take(now)),
            _ => None,
        }
    }

    /// A holder's `motion` control. Returns the bundle when it ended the hold.
    fn motion(
        &mut self,
        holder: String,
        held: bool,
        cap_ms: Option<u64>,
        now: Instant,
    ) -> Option<Vec<RenderedSessionWire>> {
        if held {
            let cap = cap_ms.unwrap_or(0).max(MIN_HOLD_CAP_MS);
            self.holders
                .insert(holder, now + Duration::from_millis(cap));
            return None;
        }
        self.holders.remove(&holder);
        self.release(now)
    }

    /// Drop every holder whose cap has run out. Returns the bundle when the
    /// last one went.
    fn expire(&mut self, now: Instant) -> Option<Vec<RenderedSessionWire>> {
        let before = self.holders.len();
        self.holders.retain(|_, expiry| *expiry > now);
        if self.holders.len() == before {
            return None;
        }
        warn!(
            expired = before - self.holders.len(),
            "render bridge: a motion hold ran out without a release"
        );
        self.release(now)
    }

    /// A hold's end sends the bundle at once, whatever the period.
    fn release(&mut self, now: Instant) -> Option<Vec<RenderedSessionWire>> {
        if !self.holders.is_empty() || self.buffer.is_empty() {
            return None;
        }
        Some(self.take(now))
    }

    fn drop_session(&mut self, session: &str) {
        self.buffer.retain(|s| s.tug_session_id != session);
    }
}

/// The block list of an emission that follows `earlier`, as one diff read
/// against `earlier`'s base: the later list from `later_from` on, preceded
/// by whatever of `earlier`'s list lies before it.
fn compose_blocks(
    earlier: &RenderedMessageWire,
    later_from: u32,
    later: Vec<RenderedBlockWire>,
) -> (u64, u32, Vec<RenderedBlockWire>) {
    if later_from == 0 {
        return (0, 0, later);
    }
    // The later diff starts at or before the earlier one's start, so the
    // earlier one's base holds every block it keeps.
    if later_from <= earlier.blocks_from {
        return (earlier.base_seq, later_from, later);
    }
    let keep = (later_from - earlier.blocks_from) as usize;
    let mut blocks: Vec<RenderedBlockWire> = earlier.blocks.iter().take(keep).cloned().collect();
    blocks.extend(later);
    (earlier.base_seq, earlier.blocks_from, blocks)
}

/// Merge a later emission into an earlier one ([P05]): per message, the later
/// block list and text facts win, and each block's HTML comes from the latest
/// emission that carried it. Two block-list diffs compose into one read
/// against the earlier one's base.
fn merge_batch(into: &mut Vec<RenderedSessionWire>, batch: Vec<RenderedSessionWire>) {
    for session in batch {
        let Some(held) = into
            .iter_mut()
            .find(|s| s.tug_session_id == session.tug_session_id)
        else {
            into.push(session);
            continue;
        };
        for message in session.messages {
            match held
                .messages
                .iter_mut()
                .find(|m| m.message_key == message.message_key)
            {
                None => held.messages.push(message),
                Some(earlier) => {
                    let mut html = std::mem::take(&mut earlier.html);
                    html.extend(message.html);
                    let (base_seq, blocks_from, blocks) =
                        compose_blocks(earlier, message.blocks_from, message.blocks);
                    *earlier = RenderedMessageWire {
                        html,
                        base_seq,
                        blocks_from,
                        blocks,
                        ..message
                    };
                }
            }
        }
    }
}

/// The stage renders as often as the fastest page asks to be sent.
fn render_period(pacers: &HashMap<u64, PagePacer>) -> Duration {
    pacers
        .values()
        .map(|p| p.period)
        .min()
        .unwrap_or(DEFAULT_PERIOD)
}

/// When the loop should start a render: only while something is dirty and
/// no render is in flight, so a quiet stage arms no timer.
fn next_render_at(
    stage: &RenderStage,
    last_tick: Option<Instant>,
    period: Duration,
    rendering: bool,
    now: Instant,
) -> Option<Instant> {
    (!rendering && stage.is_dirty()).then(|| match last_tick {
        Some(last) => (last + period).max(now),
        None => now,
    })
}

/// The part of a batch a page's session subscription takes.
fn for_sessions(
    batch: &[RenderedSessionWire],
    sessions: &SessionSubscription,
) -> Vec<RenderedSessionWire> {
    batch
        .iter()
        .filter(|s| sessions.admits(&s.tug_session_id))
        .cloned()
        .collect()
}

/// Hand one render's batch to every page. Shell and body pages are paced
/// and cut to their sessions from the first batch, whether or not they have
/// sent a control; a page the registry does not list takes every session.
/// The connections with no pacer take the batch whole, and it is sent only
/// when one is live.
fn hand_out(
    batch: Vec<RenderedSessionWire>,
    pacers: &mut HashMap<u64, PagePacer>,
    pages: &PageRegistry,
    tx: &broadcast::Sender<AddressedFrame>,
    now: Instant,
) {
    if batch.is_empty() {
        return;
    }
    let live = pages.snapshot();
    for page in &live {
        if page.role != PageRole::Tool {
            pacers.entry(page.client_id).or_insert_with(PagePacer::new);
        }
    }
    let every = SessionSubscription::All;
    for (&id, pacer) in pacers.iter_mut() {
        let sessions = live
            .iter()
            .find(|p| p.client_id == id)
            .map_or(&every, |p| &p.sessions);
        if let Some(out) = pacer.deliver(for_sessions(&batch, sessions), now) {
            publish(tx, Delivery::Client(id), out);
        }
    }
    if live.iter().any(|p| !pacers.contains_key(&p.client_id)) {
        let mut paced: Vec<u64> = pacers.keys().copied().collect();
        paced.sort_unstable();
        publish(tx, Delivery::AllExcept(paced.into()), batch);
    }
}

/// The session a `SESSION_STATE` frame reports closed.
fn closed_session(payload: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct StateFrame {
        tug_session_id: String,
        state: String,
    }
    let frame: StateFrame = serde_json::from_slice(payload).ok()?;
    (frame.state == "closed").then_some(frame.tug_session_id)
}

/// What one `RENDER_INPUT` control asks of the loop.
#[derive(Debug, Default)]
struct Applied {
    /// A bundle a released hold let go.
    batch: Option<Vec<RenderedSessionWire>>,
    /// A find query to answer off the loop.
    find: Option<FindJob>,
    /// A whole resync, answered at once with an empty batch that tells the
    /// deck this tugcast renders.
    hello: bool,
}

/// Apply one page's `RENDER_INPUT` control. The resync it asks for is the
/// stage's, so every page's next emission carries the blocks it names.
fn apply_input(
    payload: &[u8],
    stage: &mut RenderStage,
    pacer: &mut PagePacer,
    now: Instant,
) -> Applied {
    let input = match serde_json::from_slice::<RenderInputFrame>(payload) {
        Ok(RenderInputFrame { v, control }) if v == RENDERED_FEED_VERSION => control,
        Ok(RenderInputFrame { v, .. }) => {
            warn!(
                v,
                ours = RENDERED_FEED_VERSION,
                "RENDER_INPUT: a control at another version; refused"
            );
            return Applied::default();
        }
        Err(e) => {
            warn!(error = %e, "RENDER_INPUT: malformed control");
            return Applied::default();
        }
    };
    match input {
        RenderInput::Motion {
            holder,
            held,
            cap_ms,
        } => Applied {
            batch: pacer.motion(holder, held, cap_ms, now),
            ..Applied::default()
        },
        RenderInput::DisplayPeriod { period_ms } => {
            pacer.set_period(period_ms);
            Applied::default()
        }
        RenderInput::Resync {
            tug_session_id,
            message_key,
        } => {
            stage.resync(tug_session_id.as_deref(), message_key.as_deref());
            Applied {
                hello: tug_session_id.is_none() && message_key.is_none(),
                ..Applied::default()
            }
        }
        RenderInput::Find {
            request_id,
            tug_session_id,
            query,
            options,
            limit,
            units,
            mounted_units,
            known_texts,
        } => {
            let snapshot = |keys: Vec<String>| {
                keys.into_iter()
                    .map(|key| {
                        let text = stage.find_unit(&tug_session_id, &key);
                        (key, text)
                    })
                    .collect()
            };
            let units = snapshot(units);
            let mounted = snapshot(mounted_units);
            Applied {
                find: Some(FindJob {
                    request_id,
                    tug_session_id,
                    query,
                    options,
                    limit,
                    units,
                    mounted,
                    known_texts,
                }),
                ..Applied::default()
            }
        }
    }
}

fn publish(
    tx: &broadcast::Sender<AddressedFrame>,
    to: Delivery,
    sessions: Vec<RenderedSessionWire>,
) {
    publish_frame(
        tx,
        to,
        &RenderedFrame::RenderBatch {
            v: RENDERED_FEED_VERSION,
            sessions,
        },
    );
}

fn publish_frame(tx: &broadcast::Sender<AddressedFrame>, to: Delivery, frame: &RenderedFrame) {
    match serde_json::to_vec(frame) {
        // No subscriber is not an error: nobody is drawing.
        Ok(bytes) => {
            let _ = tx.send(AddressedFrame {
                to,
                frame: Frame::new(FeedId::RENDERED, bytes),
            });
        }
        Err(e) => warn!(error = %e, "render bridge: a frame did not serialize"),
    }
}

/// One broadcast receive. A lagged `CODE_OUTPUT` tap can leave a partial
/// message short of text, until its next whole frame repairs it. While the
/// Message streams, the deck draws a render of that text as it draws any
/// render a tick behind: only a record longer than the deck's own text is
/// refused. The deck's text-hash check refuses it once the Message is
/// final, and the deck then parses its own text.
fn take_frame(
    recv: Result<Frame, broadcast::error::RecvError>,
    wire: &str,
    closed: &mut bool,
) -> Option<Frame> {
    match recv {
        Ok(frame) => Some(frame),
        Err(broadcast::error::RecvError::Lagged(skipped)) => {
            warn!(
                skipped,
                wire, "render bridge: broadcast lagged; frames dropped"
            );
            None
        }
        Err(broadcast::error::RecvError::Closed) => {
            info!(wire, "render bridge: broadcast closed");
            *closed = true;
            None
        }
    }
}

/// The earliest of `instants`, if any.
fn earliest(instants: impl Iterator<Item = Option<Instant>>) -> Option<Instant> {
    instants.flatten().min()
}

async fn render_bridge_task(
    taps: Taps,
    pages: Arc<PageRegistry>,
    rendered_tx: broadcast::Sender<AddressedFrame>,
    cancel: CancellationToken,
) {
    let Taps {
        mut code_rx,
        mut state_rx,
        mut input_rx,
        mut departures,
    } = taps;
    let (mut code_closed, mut state_closed, mut input_closed, mut departures_closed) =
        (false, false, false, false);
    let mut stage = RenderStage::new();
    let mut pacers: HashMap<u64, PagePacer> = HashMap::new();
    let mut last_tick: Option<Instant> = None;
    let mut rendering: Option<JoinHandle<RenderOutput>> = None;
    let mut finds: JoinSet<(u64, FindAnswer)> = JoinSet::new();
    let start = Instant::now();
    let clock_ms = move |now: Instant| now.duration_since(start).as_millis() as u64;
    let mut last_sweep = start;
    // A disabled branch still evaluates its future; this is what it sleeps to.
    let never = || Instant::now() + Duration::from_secs(3_600);

    loop {
        let now = Instant::now();
        let render_at = next_render_at(
            &stage,
            last_tick,
            render_period(&pacers),
            rendering.is_some(),
            now,
        );
        let expiry = earliest(pacers.values().map(PagePacer::next_expiry));
        let flush = earliest(pacers.values().map(|p| p.flush_at(now)));

        // Biased, controls first: a hold or a close read in the same pass as
        // the frames it governs applies before them. A page's controls are
        // read before its departure, which the router publishes after its
        // last forwarded frame, so a departed page leaves no pacer behind.
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                if let Some(handle) = rendering {
                    handle.abort();
                }
                info!("render bridge: cancelled");
                return;
            }
            input = input_rx.recv(), if !input_closed => {
                match input {
                    None => input_closed = true,
                    Some(ClientFrame { client_id, frame }) => {
                        let pacer = pacers.entry(client_id).or_insert_with(PagePacer::new);
                        let applied = apply_input(&frame.payload, &mut stage, pacer, Instant::now());
                        if let Some(batch) = applied.batch {
                            publish(&rendered_tx, Delivery::Client(client_id), batch);
                        }
                        if applied.hello {
                            publish(&rendered_tx, Delivery::Client(client_id), Vec::new());
                        }
                        if let Some(job) = applied.find {
                            finds.spawn_blocking(move || (client_id, job.answer()));
                        }
                    }
                }
            }
            departed = departures.recv(), if !departures_closed => {
                match departed {
                    Ok(client_id) => {
                        pacers.remove(&client_id);
                    }
                    // Departures were missed: keep only the pacers of pages
                    // the registry still lists ([P06]).
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let live: HashSet<u64> =
                            pages.snapshot().iter().map(|p| p.client_id).collect();
                        pacers.retain(|id, _| live.contains(id));
                    }
                    Err(broadcast::error::RecvError::Closed) => departures_closed = true,
                }
            }
            Some(answered) = finds.join_next(), if !finds.is_empty() => {
                match answered {
                    Ok((asker, FindAnswer { frame, extracted })) => {
                        if let RenderedFrame::FindResult { tug_session_id, .. } = &frame {
                            stage.keep_find_texts(tug_session_id, extracted);
                        }
                        publish_frame(&rendered_tx, Delivery::Client(asker), &frame);
                    }
                    Err(e) => warn!(error = %e, "render bridge: a find task failed"),
                }
            }
            recv = state_rx.recv(), if !state_closed => {
                if let Some(frame) = take_frame(recv, "session_state", &mut state_closed)
                    && let Some(session) = closed_session(&frame.payload)
                {
                    stage.drop_session(&session);
                    for pacer in pacers.values_mut() {
                        pacer.drop_session(&session);
                    }
                }
            }
            recv = code_rx.recv(), if !code_closed => {
                if let Some(frame) = take_frame(recv, "code", &mut code_closed) {
                    stage.ingest(&frame.payload, clock_ms(Instant::now()));
                }
            }
            joined = async { rendering.as_mut().expect("guarded by is_some").await }, if rendering.is_some() => {
                rendering = None;
                match joined {
                    Ok(output) => {
                        let batch = stage.settle(output);
                        hand_out(batch, &mut pacers, &pages, &rendered_tx, Instant::now());
                    }
                    Err(e) => warn!(error = %e, "render bridge: a render task failed"),
                }
            }
            _ = tokio::time::sleep_until(expiry.unwrap_or_else(never)), if expiry.is_some() => {
                let now = Instant::now();
                for (&id, pacer) in pacers.iter_mut() {
                    if let Some(batch) = pacer.expire(now) {
                        publish(&rendered_tx, Delivery::Client(id), batch);
                    }
                }
            }
            _ = tokio::time::sleep_until(flush.unwrap_or_else(never)), if flush.is_some() => {
                let now = Instant::now();
                for (&id, pacer) in pacers.iter_mut() {
                    if let Some(batch) = pacer.flush_due(now) {
                        publish(&rendered_tx, Delivery::Client(id), batch);
                    }
                }
            }
            _ = tokio::time::sleep_until(render_at.unwrap_or_else(never)), if render_at.is_some() => {
                let now = Instant::now();
                last_tick = Some(now);
                if now.duration_since(last_sweep) >= SWEEP_EVERY {
                    last_sweep = now;
                    stage.sweep_idle(clock_ms(now), SCOPE_IDLE_SWEEP_MS);
                }
                let job = stage.take_dirty();
                if !job.is_empty() {
                    rendering = Some(tokio::task::spawn_blocking(move || job.render()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The fixture both halves of the protocol are held to.
    fn fixture() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tugproto/src/__tests__/fixtures/rendered-parity.json"
        );
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        serde_json::from_str(&text).expect("rendered-parity.json is JSON")
    }

    fn block(hash: &str, kind: &str, start: u32, end: u32) -> RenderedBlockWire {
        RenderedBlockWire {
            hash: hash.into(),
            kind: kind.into(),
            start_char: start,
            end_char: end,
            depth: 0,
            item_count: 0,
            row_count: 0,
        }
    }

    fn frames() -> Vec<RenderedFrame> {
        vec![
            RenderedFrame::RenderBatch {
                v: 1,
                sessions: vec![RenderedSessionWire {
                    tug_session_id: "s1".into(),
                    messages: vec![RenderedMessageWire {
                        message_key: "m1:0".into(),
                        channel: RenderChannel::Text,
                        seq: 2,
                        base_seq: 1,
                        blocks_from: 1,
                        blocks: vec![
                            RenderedBlockWire {
                                depth: 2,
                                ..block("12638187200555641996", "heading", 0, 9)
                            },
                            block("9113197264227342466", "paragraph", 9, 21),
                        ],
                        html: BTreeMap::from([(
                            "9113197264227342466".to_string(),
                            "<p>Body text.</p>\n".to_string(),
                        )]),
                        text_length: 21,
                        text_hash: "18446744073709551557".into(),
                    }],
                }],
            },
            RenderedFrame::FindResult {
                request_id: "r1".into(),
                tug_session_id: "s1".into(),
                invalid: None,
                matches: Some(vec![FindMatch {
                    unit: "u1".into(),
                    start: 3,
                    end: 7,
                }]),
                texts: Some(BTreeMap::from([("u1".to_string(), "the text".to_string())])),
                missing: vec!["u2".into()],
            },
            RenderedFrame::FindResult {
                request_id: "r2".into(),
                tug_session_id: "s1".into(),
                invalid: Some(true),
                matches: None,
                texts: None,
                missing: vec![],
            },
        ]
    }

    fn inputs() -> Vec<RenderInputFrame> {
        let controls = vec![
            RenderInput::Motion {
                holder: "h1".into(),
                held: true,
                cap_ms: Some(600),
            },
            RenderInput::DisplayPeriod { period_ms: 8.33 },
            RenderInput::Resync {
                tug_session_id: Some("s1".into()),
                message_key: None,
            },
            RenderInput::Find {
                request_id: "r1".into(),
                tug_session_id: "s1".into(),
                query: "text".into(),
                options: FindOptions {
                    case_sensitive: false,
                    whole_word: true,
                    grep: false,
                },
                limit: 500,
                units: vec!["u1".into(), "u2".into()],
                mounted_units: vec!["u1".into()],
                known_texts: BTreeMap::from([("u2".to_string(), "42".to_string())]),
            },
        ];
        controls
            .into_iter()
            .map(|control| RenderInputFrame { v: 1, control })
            .collect()
    }

    #[test]
    fn frames_serialize_to_the_parity_fixture() {
        let fixture = fixture();
        assert_eq!(serde_json::to_value(frames()).unwrap(), fixture["frames"]);
        let back: Vec<RenderedFrame> = serde_json::from_value(fixture["frames"].clone()).unwrap();
        assert_eq!(back, frames());
    }

    #[test]
    fn inputs_parse_from_the_parity_fixture() {
        let fixture = fixture();
        let parsed: Vec<RenderInputFrame> =
            serde_json::from_value(fixture["inputs"].clone()).unwrap();
        assert_eq!(parsed, inputs());
        assert_eq!(serde_json::to_value(inputs()).unwrap(), fixture["inputs"]);
    }

    #[test]
    fn a_block_converts_with_its_hash_in_decimal() {
        let rendered = tugmark::render_blocks("# Hi\n", tugmark::Highlight::Off);
        let wire = RenderedBlockWire::from(&rendered[0]);
        assert_eq!(wire.hash, rendered[0].hash.to_string());
        assert_eq!(
            (wire.kind.as_str(), wire.depth, wire.end_char),
            ("heading", 1, 5)
        );
    }

    fn emission(seq: u64, base_seq: u64, from: u32, hashes: &[&str]) -> RenderedSessionWire {
        RenderedSessionWire {
            tug_session_id: "s1".into(),
            messages: vec![RenderedMessageWire {
                message_key: "m1".into(),
                channel: RenderChannel::Text,
                seq,
                base_seq,
                blocks_from: from,
                blocks: hashes.iter().map(|h| block(h, "paragraph", 0, 0)).collect(),
                html: BTreeMap::new(),
                text_length: 0,
                text_hash: "0".into(),
            }],
        }
    }

    fn list(batch: &[RenderedSessionWire]) -> (u64, u64, u32, Vec<String>) {
        let m = &batch[0].messages[0];
        let hashes = m.blocks.iter().map(|b| b.hash.clone()).collect();
        (m.seq, m.base_seq, m.blocks_from, hashes)
    }

    #[test]
    fn held_diffs_compose_against_the_first_ones_base() {
        // The page holds emission 1: [a, b, c].
        // 2 changes c to c2 and adds d; 3 changes d to d2.
        let mut buffer = vec![emission(2, 1, 2, &["c2", "d"])];
        merge_batch(&mut buffer, vec![emission(3, 2, 3, &["d2"])]);
        assert_eq!(list(&buffer), (3, 1, 2, vec!["c2".into(), "d2".into()]));

        // 4 reaches back before the held diff's start: its own list, base 1.
        merge_batch(&mut buffer, vec![emission(4, 3, 1, &["b2", "c3"])]);
        assert_eq!(list(&buffer), (4, 1, 1, vec!["b2".into(), "c3".into()]));

        // A whole list replaces whatever was held.
        merge_batch(&mut buffer, vec![emission(1, 0, 0, &["x"])]);
        assert_eq!(list(&buffer), (1, 0, 0, vec!["x".into()]));

        // A diff after a whole list stays whole.
        merge_batch(&mut buffer, vec![emission(2, 1, 1, &["y"])]);
        assert_eq!(list(&buffer), (2, 0, 0, vec!["x".into(), "y".into()]));
    }

    // ── the bridge, under a paused clock ──────────────────────────────────

    use serde_json::json;
    use std::sync::Mutex;
    use tugcast_core::PageIdentity;

    /// The page the single-page tests speak as: a tool, so it takes every
    /// batch whole until it sends a control and is paced.
    const A: u64 = 1;

    /// One frame the bridge published, with the (virtual) instant it left.
    #[derive(Clone, Debug)]
    struct Sent {
        at: Instant,
        to: Delivery,
        frame: RenderedFrame,
    }

    /// A running bridge and the wires around it.
    struct Harness {
        code_tx: broadcast::Sender<Frame>,
        state_tx: broadcast::Sender<Frame>,
        input_tx: mpsc::Sender<ClientFrame>,
        pages: Arc<PageRegistry>,
        sent: Arc<Mutex<Vec<Sent>>>,
        cancel: CancellationToken,
    }

    fn identity(role: PageRole, card: Option<&str>) -> PageIdentity {
        PageIdentity {
            role,
            page_id: Some(format!("page-{role:?}-{card:?}")),
            card_id: card.map(str::to_owned),
        }
    }

    impl Harness {
        /// A bridge with page [`A`] registered as a tool.
        fn start() -> Self {
            let h = Self::bare();
            h.pages.register(A, &PageIdentity::tool());
            h
        }

        /// A bridge with no pages.
        fn bare() -> Self {
            let (code_tx, _) = broadcast::channel(4096);
            let (state_tx, _) = broadcast::channel(64);
            let (input_tx, input_rx) = mpsc::channel(16);
            let (rendered_tx, mut rendered_rx) = broadcast::channel::<AddressedFrame>(64);
            let pages = Arc::new(PageRegistry::new());
            let taps = Taps {
                code_rx: code_tx.subscribe(),
                state_rx: state_tx.subscribe(),
                input_rx,
                departures: pages.departures(),
            };
            let cancel = CancellationToken::new();
            tokio::spawn(render_bridge_task(
                taps,
                Arc::clone(&pages),
                rendered_tx,
                cancel.clone(),
            ));
            let sent = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&sent);
            tokio::spawn(async move {
                while let Ok(AddressedFrame { to, frame }) = rendered_rx.recv().await {
                    let frame = serde_json::from_slice(&frame.payload).unwrap();
                    sink.lock().unwrap().push(Sent {
                        at: Instant::now(),
                        to,
                        frame,
                    });
                }
            });
            Self {
                code_tx,
                state_tx,
                input_tx,
                pages,
                sent,
                cancel,
            }
        }

        fn text(&self, session: &str, partial: bool, text: &str) {
            let payload = json!({
                "type": "assistant_text",
                "tug_session_id": session,
                "msg_id": "m1",
                "block_index": 1,
                "is_partial": partial,
                "text": text,
            });
            let bytes = serde_json::to_vec(&payload).unwrap();
            self.code_tx
                .send(Frame::new(FeedId::CODE_OUTPUT, bytes))
                .unwrap();
        }

        /// Send a control as [`A`].
        async fn control(&self, control: Value) {
            self.control_from(A, control).await;
        }

        /// Send a control as `client`, stamped at this tugcast's version
        /// unless it carries one.
        async fn control_from(&self, client: u64, mut control: Value) {
            if control.get("v").is_none() {
                control["v"] = json!(RENDERED_FEED_VERSION);
            }
            self.raw_from(client, serde_json::to_vec(&control).unwrap())
                .await;
        }

        async fn raw_from(&self, client_id: u64, bytes: Vec<u8>) {
            self.input_tx
                .send(ClientFrame {
                    client_id,
                    frame: Frame::new(FeedId::RENDER_INPUT, bytes),
                })
                .await
                .unwrap();
        }

        fn state(&self, session: &str, state: &str) {
            let bytes = serde_json::to_vec(&json!({
                "tug_session_id": session,
                "state": state,
                "detail": null,
            }))
            .unwrap();
            self.state_tx
                .send(Frame::new(FeedId::SESSION_STATE, bytes))
                .unwrap();
        }

        fn sent(&self) -> Vec<Sent> {
            self.sent.lock().unwrap().clone()
        }

        /// Every non-empty batch `client` was sent, with when.
        fn batches_for(&self, client: u64) -> Vec<(Instant, Vec<RenderedSessionWire>)> {
            self.sent()
                .into_iter()
                .filter(|s| s.to.admits(client))
                .filter_map(|s| match s.frame {
                    RenderedFrame::RenderBatch { sessions, .. } if !sessions.is_empty() => {
                        Some((s.at, sessions))
                    }
                    _ => None,
                })
                .collect()
        }

        /// The batches [`A`] was sent.
        fn frames(&self) -> Vec<(Instant, Vec<RenderedSessionWire>)> {
            self.batches_for(A)
        }

        /// The empty batches — the answers to whole resyncs — with their
        /// delivery and version.
        fn hellos(&self) -> Vec<(Delivery, u32)> {
            self.sent()
                .into_iter()
                .filter_map(|s| match s.frame {
                    RenderedFrame::RenderBatch { v, sessions } if sessions.is_empty() => {
                        Some((s.to, v))
                    }
                    _ => None,
                })
                .collect()
        }

        /// Wait for the next find answer, with its delivery.
        async fn find_result(&self) -> (Delivery, RenderedFrame) {
            for _ in 0..1_000 {
                let found = self
                    .sent()
                    .into_iter()
                    .find(|s| matches!(s.frame, RenderedFrame::FindResult { .. }));
                if let Some(Sent { to, frame, .. }) = found {
                    return (to, frame);
                }
                self.wait(1).await;
            }
            panic!("no find answer");
        }

        /// Let the bridge settle for `ms` of virtual time.
        async fn wait(&self, ms: u64) {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.cancel.cancel();
        }
    }

    fn session_ids(batch: &[RenderedSessionWire]) -> Vec<&str> {
        let mut ids: Vec<&str> = batch.iter().map(|s| s.tug_session_id.as_str()).collect();
        ids.sort_unstable();
        ids
    }

    /// A deck's whole resync is answered at once, to that page alone, with
    /// an empty batch at this tugcast's version; a narrower one is not.
    #[tokio::test(start_paused = true)]
    async fn a_whole_resync_is_answered_with_the_feeds_version() {
        let h = Harness::start();
        h.control(json!({"kind": "resync", "tugSessionId": "s1"}))
            .await;
        h.wait(5).await;
        assert!(h.hellos().is_empty());
        h.control(json!({"kind": "resync"})).await;
        h.wait(5).await;
        assert_eq!(
            h.hellos(),
            vec![(Delivery::Client(A), RENDERED_FEED_VERSION)]
        );
        assert!(h.frames().is_empty());
    }

    /// A control written at a version this tugcast does not speak is
    /// refused, as one with no version is.
    #[tokio::test(start_paused = true)]
    async fn a_control_at_another_version_is_refused() {
        let h = Harness::start();
        h.control(json!({"v": RENDERED_FEED_VERSION + 1, "kind": "resync"}))
            .await;
        h.wait(5).await;
        assert!(h.hellos().is_empty());
        h.raw_from(A, serde_json::to_vec(&json!({"kind": "resync"})).unwrap())
            .await;
        h.wait(5).await;
        assert!(h.hellos().is_empty());
    }

    /// A find over replayed and live text alike, answered at once and to
    /// the page that asked: the replayed Message's rendered text is
    /// extracted for it, a unit the stage never saw comes back missing, and
    /// a mounted unit carries its text.
    #[tokio::test(start_paused = true)]
    async fn a_find_is_answered_over_replayed_and_live_text() {
        let h = Harness::start();
        let replay = |kind: &str| {
            let bytes =
                serde_json::to_vec(&json!({ "type": kind, "tug_session_id": "s1" })).unwrap();
            h.code_tx
                .send(Frame::new(FeedId::CODE_OUTPUT, bytes))
                .unwrap();
        };
        replay("replay_started");
        let restored = json!({
            "type": "assistant_text", "tug_session_id": "s1", "msg_id": "m0",
            "block_index": 1, "is_partial": false, "text": "An *old* needle.\n",
        });
        h.code_tx
            .send(Frame::new(
                FeedId::CODE_OUTPUT,
                serde_json::to_vec(&restored).unwrap(),
            ))
            .unwrap();
        replay("replay_complete");
        h.text("s1", false, "A live Needle and a needle.");
        h.wait(50).await;

        h.control(json!({
            "kind": "find", "requestId": "q1", "tugSessionId": "s1", "query": "needle",
            "options": { "caseSensitive": false, "wholeWord": true, "grep": false },
            "limit": 100, "units": ["m0-b1", "m1-b1", "nope-b1"], "mountedUnits": ["m1-b1"],
        }))
        .await;
        let (
            to,
            RenderedFrame::FindResult {
                request_id,
                matches,
                texts,
                missing,
                ..
            },
        ) = h.find_result().await
        else {
            panic!("a find result");
        };
        assert_eq!(to, Delivery::Client(A));
        assert_eq!(request_id, "q1");
        let matches: Vec<(String, u32, u32)> = matches
            .unwrap()
            .into_iter()
            .map(|m| (m.unit, m.start, m.end))
            .collect();
        assert_eq!(
            matches,
            vec![
                ("m0-b1".to_string(), 7, 13),
                ("m1-b1".to_string(), 7, 13),
                ("m1-b1".to_string(), 20, 26),
            ]
        );
        assert_eq!(missing, vec!["nope-b1"]);
        assert_eq!(texts.unwrap()["m1-b1"], "A live Needle and a needle.\n");
    }

    fn only_message(sessions: &[RenderedSessionWire]) -> &RenderedMessageWire {
        assert_eq!(sessions.len(), 1, "{sessions:?}");
        assert_eq!(sessions[0].messages.len(), 1, "{sessions:?}");
        &sessions[0].messages[0]
    }

    #[tokio::test(start_paused = true)]
    async fn two_streaming_sessions_flush_at_most_once_per_period() {
        let h = Harness::start();
        for i in 0..80 {
            h.text("s1", true, &format!("word{i} "));
            h.text("s2", true, &format!("other{i} "));
            h.wait(1).await;
        }
        h.wait(100).await;
        let frames = h.frames();
        assert!(frames.len() >= 4, "{} frames", frames.len());
        for pair in frames.windows(2) {
            let gap = pair[1].0 - pair[0].0;
            assert!(gap >= DEFAULT_PERIOD, "frames {gap:?} apart");
        }
        // Both sessions ride one frame.
        assert!(frames.iter().any(|(_, sessions)| sessions.len() == 2));
        // And the last frame of each describes all of its text.
        for (session, word) in [("s1", "word"), ("s2", "other")] {
            let last = frames
                .iter()
                .rev()
                .find_map(|(_, s)| s.iter().find(|s| s.tug_session_id == session))
                .unwrap();
            let text: String = (0..80).map(|i| format!("{word}{i} ")).collect();
            assert_eq!(
                last.messages[0].text_hash,
                tugmark::text_hash(&text).to_string()
            );
        }
    }

    #[test]
    fn nothing_dirty_arms_no_timer() {
        let mut stage = RenderStage::new();
        let now = Instant::now();
        let at = |stage: &RenderStage, rendering| {
            next_render_at(stage, None, DEFAULT_PERIOD, rendering, now)
        };
        assert_eq!(at(&stage, false), None);
        let frame = br#"{"type":"assistant_text","tug_session_id":"s1","msg_id":"m","block_index":0,"is_partial":true,"text":"x"}"#;
        stage.ingest(frame, 0);
        assert_eq!(at(&stage, false), Some(now));
        // A render in flight holds the next one back.
        assert_eq!(at(&stage, true), None);
        // The clock waits a period after the last tick.
        assert_eq!(
            next_render_at(&stage, Some(now), DEFAULT_PERIOD, false, now),
            Some(now + DEFAULT_PERIOD)
        );
        stage.take_dirty();
        assert_eq!(at(&stage, false), None);
    }

    /// The stage renders as often as the fastest page asks.
    #[test]
    fn the_render_clock_follows_the_fastest_page() {
        let mut pacers = HashMap::new();
        assert_eq!(render_period(&pacers), DEFAULT_PERIOD);
        let mut slow = PagePacer::new();
        slow.set_period(50.0);
        pacers.insert(1, slow);
        assert_eq!(render_period(&pacers), Duration::from_millis(50));
        let mut fast = PagePacer::new();
        fast.set_period(8.0);
        pacers.insert(2, fast);
        assert_eq!(render_period(&pacers), Duration::from_millis(8));
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_bridge_publishes_nothing() {
        let h = Harness::start();
        h.text("s1", false, "Once.");
        h.wait(50).await;
        assert_eq!(h.frames().len(), 1);
        h.wait(10_000).await;
        assert_eq!(h.frames().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_hold_buffers_merges_and_releases_one_bundle() {
        let h = Harness::start();
        h.control(json!({"kind": "motion", "holder": "h1", "held": true, "capMs": 600}))
            .await;
        h.text("s1", true, "# Title\n\n");
        h.wait(40).await;
        h.text("s1", true, "First.\n\n");
        h.wait(40).await;
        h.text("s1", true, "Second.");
        h.wait(40).await;
        assert!(h.frames().is_empty(), "held");

        h.control(json!({"kind": "motion", "holder": "h1", "held": false}))
            .await;
        h.wait(1).await;
        let frames = h.frames();
        assert_eq!(frames.len(), 1, "one bundle");
        let message = only_message(&frames[0].1);
        assert_eq!(message.blocks.len(), 3);
        // Every block's HTML, gathered from three emissions.
        for block in &message.blocks {
            assert!(message.html.contains_key(&block.hash), "{}", block.hash);
        }
        let expected =
            tugmark::render_blocks("# Title\n\nFirst.\n\nSecond.", tugmark::Highlight::On);
        let hashes: Vec<String> = expected.iter().map(|b| b.hash.to_string()).collect();
        let got: Vec<String> = message.blocks.iter().map(|b| b.hash.clone()).collect();
        assert_eq!(got, hashes);
    }

    #[tokio::test(start_paused = true)]
    async fn a_holder_that_never_releases_expires_at_the_floor() {
        let h = Harness::start();
        let held_at = Instant::now();
        h.control(json!({"kind": "motion", "holder": "h1", "held": true, "capMs": 200}))
            .await;
        h.text("s1", false, "Waiting.");
        h.wait(990).await;
        assert!(h.frames().is_empty(), "a 200 ms cap is floored at 1000 ms");
        h.wait(20).await;
        let frames = h.frames();
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0].0 - held_at,
            Duration::from_millis(MIN_HOLD_CAP_MS)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn two_holders_hold_until_both_release() {
        let h = Harness::start();
        for holder in ["h1", "h2"] {
            h.control(json!({"kind": "motion", "holder": holder, "held": true, "capMs": 5000}))
                .await;
        }
        h.text("s1", false, "Held.");
        h.wait(50).await;
        h.control(json!({"kind": "motion", "holder": "h1", "held": false}))
            .await;
        h.wait(50).await;
        assert!(h.frames().is_empty(), "h2 still holds");
        h.control(json!({"kind": "motion", "holder": "h2", "held": false}))
            .await;
        h.wait(1).await;
        assert_eq!(h.frames().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_resync_makes_the_next_emission_carry_every_block() {
        let h = Harness::start();
        h.text("s1", false, "One.\n\nTwo.\n\n");
        h.wait(50).await;
        h.text("s1", true, "Three.");
        h.wait(50).await;
        let frames = h.frames();
        assert_eq!(frames.len(), 2);
        assert_eq!(
            only_message(&frames[1].1).html.len(),
            1,
            "only the new block"
        );

        h.control(json!({"kind": "resync", "tugSessionId": "s1"}))
            .await;
        h.wait(50).await;
        let frames = h.frames();
        assert_eq!(frames.len(), 3);
        assert_eq!(only_message(&frames[2].1).html.len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn a_posted_period_paces_the_flush() {
        let h = Harness::start();
        h.control(json!({"kind": "display-period", "periodMs": 50.0}))
            .await;
        for i in 0..100 {
            h.text("s1", true, &format!("w{i} "));
            h.wait(1).await;
        }
        h.wait(100).await;
        let frames = h.frames();
        for pair in frames.windows(2) {
            assert!(pair[1].0 - pair[0].0 >= Duration::from_millis(50));
        }
        assert!(frames.len() <= 4, "{} frames in 200 ms", frames.len());
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_session_is_dropped() {
        let h = Harness::start();
        h.text("s1", false, "Before.");
        h.wait(50).await;
        assert_eq!(h.frames().len(), 1);

        // Held renders of a session that closes are dropped with it.
        h.control(json!({"kind": "motion", "holder": "h1", "held": true}))
            .await;
        h.text("s1", true, " More.");
        h.wait(50).await;
        h.state("s1", "closed");
        h.wait(1).await;
        h.control(json!({"kind": "motion", "holder": "h1", "held": false}))
            .await;
        h.wait(50).await;
        assert_eq!(h.frames().len(), 1, "nothing released for a closed session");

        // And nothing is left to resync.
        h.control(json!({"kind": "resync"})).await;
        h.wait(50).await;
        assert_eq!(h.frames().len(), 1);

        // Another state leaves a session alone.
        h.text("s2", false, "Alive.");
        h.wait(50).await;
        h.state("s2", "idle");
        h.control(json!({"kind": "resync", "tugSessionId": "s2"}))
            .await;
        h.wait(50).await;
        assert_eq!(h.frames().len(), 3);
    }

    // ── many pages ────────────────────────────────────────────────────────

    /// One page's hold parks only its own renders: the other page is sent
    /// each tick at once, and the held page's release sends it one merged
    /// bundle, to it alone.
    #[tokio::test(start_paused = true)]
    async fn one_pages_hold_parks_only_its_own_renders() {
        const B: u64 = 2;
        let h = Harness::bare();
        h.pages.register(A, &identity(PageRole::Shell, None));
        h.pages.register(B, &identity(PageRole::Body, Some("cB")));
        h.control_from(
            A,
            json!({"kind": "motion", "holder": "h1", "held": true, "capMs": 5000}),
        )
        .await;
        h.text("s1", true, "# Title\n\n");
        h.wait(40).await;
        h.text("s1", true, "First.");
        h.wait(40).await;
        assert!(h.batches_for(A).is_empty(), "A is held");
        let b_before = h.batches_for(B).len();
        assert_eq!(b_before, 2, "B is sent each tick at once");

        let released_at = Instant::now();
        h.control_from(A, json!({"kind": "motion", "holder": "h1", "held": false}))
            .await;
        h.wait(1).await;
        let a = h.batches_for(A);
        assert_eq!(a.len(), 1, "one bundle");
        assert!(a[0].0 >= released_at);
        assert_eq!(only_message(&a[0].1).blocks.len(), 2);
        assert_eq!(h.batches_for(B).len(), b_before, "the release is A's alone");
        // Every batch went to one page; with no tool live, none went whole.
        for sent in h.sent() {
            assert!(matches!(sent.to, Delivery::Client(_)), "{:?}", sent.to);
        }
    }

    /// A page with a 50 ms period is sent one merged emission for two
    /// ticks the faster page takes 16 ms apart, read against the base it
    /// already holds.
    #[tokio::test(start_paused = true)]
    async fn a_slower_page_takes_one_merged_emission_for_two_ticks() {
        const B: u64 = 2;
        let h = Harness::bare();
        h.pages.register(A, &identity(PageRole::Shell, None));
        h.pages.register(B, &identity(PageRole::Body, Some("cB")));
        h.control_from(A, json!({"kind": "display-period", "periodMs": 50.0}))
            .await;
        h.text("s1", true, "One.\n\n");
        h.wait(20).await;
        h.text("s1", true, "Two.\n\n");
        // Ingested well before the next tick, 16 ms after this one.
        h.wait(10).await;
        h.text("s1", true, "Three.");
        h.wait(100).await;

        let b = h.batches_for(B);
        assert_eq!(b.len(), 3, "B takes every tick");
        let a = h.batches_for(A);
        assert_eq!(a.len(), 2, "A takes the first and one merged emission");
        assert!(a[1].0 - a[0].0 >= Duration::from_millis(50));
        let (first, merged) = (only_message(&a[0].1), only_message(&a[1].1));
        assert_eq!(merged.seq, only_message(&b[2].1).seq);
        assert!(
            merged.blocks_from == 0 || merged.base_seq == first.seq,
            "{merged:?} reads against {first:?}"
        );
        assert_eq!(merged.text_hash, only_message(&b[2].1).text_hash);
    }

    /// Each page is sent only its sessions — one that has spoken on
    /// `RENDER_INPUT` and a body that never has — and a tool takes the
    /// batch whole.
    #[tokio::test(start_paused = true)]
    async fn each_page_takes_only_its_sessions_and_a_tool_takes_all() {
        const QUIET_BODY: u64 = 2;
        const TOOL: u64 = 3;
        let h = Harness::bare();
        let only_s1 = || SessionSubscription::Only(["s1".to_string()].into());
        h.pages.register(A, &identity(PageRole::Shell, None));
        h.pages.set_sessions(A, only_s1());
        h.pages
            .register(QUIET_BODY, &identity(PageRole::Body, Some("c1")));
        h.pages.set_sessions(QUIET_BODY, only_s1());
        h.pages.register(TOOL, &PageIdentity::tool());
        h.control_from(A, json!({"kind": "display-period", "periodMs": 16.0}))
            .await;
        h.text("s1", false, "One.");
        h.text("s2", false, "Two.");
        h.wait(50).await;

        for page in [A, QUIET_BODY] {
            let batches = h.batches_for(page);
            assert!(!batches.is_empty(), "page {page} was sent its session");
            for (_, batch) in batches {
                assert_eq!(session_ids(&batch), vec!["s1"], "page {page}");
            }
        }
        let whole = h.batches_for(TOOL);
        assert!(
            whole
                .iter()
                .any(|(_, batch)| session_ids(batch) == vec!["s1", "s2"]),
            "{whole:?}"
        );
        let to_tools: Vec<Delivery> = h
            .sent()
            .into_iter()
            .map(|s| s.to)
            .filter(|to| matches!(to, Delivery::AllExcept(_)))
            .collect();
        assert!(!to_tools.is_empty());
        for to in to_tools {
            assert_eq!(to, Delivery::AllExcept(vec![A, QUIET_BODY].into()));
        }
    }

    /// A departed page's pacer goes with it: its held renders are never
    /// sent, and the batch tools take no longer names it.
    #[tokio::test(start_paused = true)]
    async fn a_departure_drops_the_pacer() {
        const TOOL: u64 = 3;
        let h = Harness::start();
        h.pages.register(TOOL, &PageIdentity::tool());
        h.control(json!({"kind": "motion", "holder": "h1", "held": true, "capMs": 5000}))
            .await;
        h.text("s1", true, "Held.");
        h.wait(50).await;
        assert!(
            h.sent()
                .iter()
                .any(|s| s.to == Delivery::AllExcept(vec![A].into()))
        );

        h.pages.depart(A);
        h.wait(1).await;
        h.text("s1", true, " More.");
        h.wait(6_000).await;
        let sent = h.sent();
        assert!(
            sent.iter().all(|s| s.to != Delivery::Client(A)),
            "a departed page is sent nothing, not even its expired hold"
        );
        assert_eq!(
            sent.last().map(|s| s.to.clone()),
            Some(Delivery::AllExcept(Vec::new().into()))
        );
    }
}

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
//! emission carries the message's whole ordered block list but `html` only
//! for hashes new since that message's previous emission; hashes are FNV-1a
//! 64 as decimal strings.
//!
//! The bridge task is the impure half around [`RenderStage`]: it taps
//! `CODE_OUTPUT` and `SESSION_STATE`, reads the deck's controls, and owns the
//! clock. It flushes at most once per display period, with a timer armed only
//! while something is dirty, and the parse runs on a blocking thread so the
//! loop keeps reading frames while it renders. While any holder holds the
//! deck's motion, renders merge into a buffer that the release, or the last
//! holder's expiry, publishes as one bundle.
//!
//! A `find` control is answered at once and never held: the stage hands
//! over each asked unit's text, `find_index` answers on a blocking thread,
//! and the rendered texts it had to extract come back to the stage.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tugcast_core::{FeedId, Frame, StreamFeed};

use super::find_index::{FindAnswer, FindJob};
use super::render_stage::{RenderOutput, RenderStage};
use super::session_digest::SCOPE_IDLE_SWEEP_MS;

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
    /// The whole ordered block list.
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

/// A frame on `RENDERED`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RenderedFrame {
    /// One tick's renders, every session's changed messages bundled.
    #[serde(rename_all = "camelCase")]
    RenderBatch { sessions: Vec<RenderedSessionWire> },
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
    },
}

/// The period emissions are paced to until the deck posts one.
pub const DEFAULT_PERIOD: Duration = Duration::from_millis(16);

/// The shortest hold a holder may ask for: the Worker's `MIN_HOLD_CAP_MS`.
pub const MIN_HOLD_CAP_MS: u64 = 1_000;

/// The shortest gap between idle sweeps. A sweep rides a render tick and
/// never a timer of its own, so a quiet process keeps no clock for it.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// Everything the bridge task needs. The `RENDERED` sender is not part of
/// it: the bridge is a [`StreamFeed`], so the router hands it the channel at
/// `run`.
pub struct RenderBridgeConfig {
    /// The shared `CODE_OUTPUT` broadcast, tapped for assistant text,
    /// thinking prose and the replay brackets.
    pub code_tx: broadcast::Sender<Frame>,
    /// `SESSION_STATE`, tapped for `closed`: a closed session's state is
    /// dropped whole.
    pub session_state_tx: broadcast::Sender<Frame>,
    /// The `RENDER_INPUT` sink the router feeds.
    pub input_rx: mpsc::Receiver<Frame>,
}

/// The `RENDERED` feed.
pub struct RenderBridge {
    config: RenderBridgeConfig,
}

impl RenderBridge {
    pub fn new(config: RenderBridgeConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl StreamFeed for RenderBridge {
    fn feed_id(&self) -> FeedId {
        FeedId::RENDERED
    }

    fn name(&self) -> &str {
        "rendered"
    }

    /// One frame per period at most, but a hold's release is a burst; a lost
    /// frame is answered by the deck's `resync`.
    fn channel_capacity(&self) -> usize {
        64
    }

    async fn run(self: Box<Self>, tx: broadcast::Sender<Frame>, cancel: CancellationToken) {
        let RenderBridgeConfig {
            code_tx,
            session_state_tx,
            input_rx,
        } = self.config;
        let taps = Taps {
            code_rx: code_tx.subscribe(),
            state_rx: session_state_tx.subscribe(),
            input_rx,
        };
        render_bridge_task(taps, tx, cancel).await;
    }
}

/// The three wires the bridge reads.
struct Taps {
    code_rx: broadcast::Receiver<Frame>,
    state_rx: broadcast::Receiver<Frame>,
    input_rx: mpsc::Receiver<Frame>,
}

/// The pace and the hold ([P07]).
struct Pacer {
    period: Duration,
    /// When the last render started.
    last_tick: Option<Instant>,
    /// Each holder's expiry.
    holders: HashMap<String, Instant>,
    /// What renders produced while held, merged.
    buffer: Vec<RenderedSessionWire>,
}

impl Pacer {
    fn new() -> Self {
        Self {
            period: DEFAULT_PERIOD,
            last_tick: None,
            holders: HashMap::new(),
            buffer: Vec::new(),
        }
    }

    /// When the next render may start.
    fn next_tick(&self, now: Instant) -> Instant {
        match self.last_tick {
            Some(last) => (last + self.period).max(now),
            None => now,
        }
    }

    fn next_expiry(&self) -> Option<Instant> {
        self.holders.values().min().copied()
    }

    fn set_period(&mut self, period_ms: f64) {
        if period_ms.is_finite() && period_ms > 0.0 {
            self.period = Duration::from_secs_f64(period_ms.clamp(1.0, 1_000.0) / 1_000.0);
        }
    }

    /// A render's emission: published now, or merged into the buffer while
    /// held.
    fn deliver(&mut self, batch: Vec<RenderedSessionWire>) -> Option<Vec<RenderedSessionWire>> {
        if batch.is_empty() {
            return None;
        }
        if self.holders.is_empty() {
            return Some(batch);
        }
        merge_batch(&mut self.buffer, batch);
        None
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
        self.release()
    }

    /// Drop every holder whose cap has run out. Returns the bundle when the
    /// last one went.
    fn expire(&mut self, now: Instant) -> Option<Vec<RenderedSessionWire>> {
        let before = self.holders.len();
        self.holders.retain(|_, expiry| *expiry > now);
        if self.holders.len() < before {
            warn!(
                expired = before - self.holders.len(),
                "render bridge: a motion hold ran out without a release"
            );
        }
        self.release()
    }

    fn release(&mut self) -> Option<Vec<RenderedSessionWire>> {
        if !self.holders.is_empty() || self.buffer.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.buffer))
    }

    fn drop_session(&mut self, session: &str) {
        self.buffer.retain(|s| s.tug_session_id != session);
    }
}

/// Merge a later emission into an earlier one ([P05]): per message, the later
/// block list and text facts win, and each block's HTML comes from the latest
/// emission that carried it.
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
                    *earlier = RenderedMessageWire { html, ..message };
                }
            }
        }
    }
}

/// When the loop should start a render: only while something is dirty and
/// no render is in flight, so a quiet stage arms no timer.
fn next_render_at(
    stage: &RenderStage,
    pacer: &Pacer,
    rendering: bool,
    now: Instant,
) -> Option<Instant> {
    (!rendering && stage.is_dirty()).then(|| pacer.next_tick(now))
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
}

/// Apply one `RENDER_INPUT` control.
fn apply_input(
    payload: &[u8],
    stage: &mut RenderStage,
    pacer: &mut Pacer,
    now: Instant,
) -> Applied {
    let input: RenderInput = match serde_json::from_slice(payload) {
        Ok(input) => input,
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
            find: None,
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
            Applied::default()
        }
        RenderInput::Find {
            request_id,
            tug_session_id,
            query,
            options,
            limit,
            units,
            mounted_units,
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
                batch: None,
                find: Some(FindJob {
                    request_id,
                    tug_session_id,
                    query,
                    options,
                    limit,
                    units,
                    mounted,
                }),
            }
        }
    }
}

fn publish(tx: &broadcast::Sender<Frame>, sessions: Vec<RenderedSessionWire>) {
    publish_frame(tx, &RenderedFrame::RenderBatch { sessions });
}

fn publish_frame(tx: &broadcast::Sender<Frame>, frame: &RenderedFrame) {
    match serde_json::to_vec(frame) {
        // No subscriber is not an error: nobody is drawing.
        Ok(bytes) => {
            let _ = tx.send(Frame::new(FeedId::RENDERED, bytes));
        }
        Err(e) => warn!(error = %e, "render bridge: a frame did not serialize"),
    }
}

/// One broadcast receive. A lagged `CODE_OUTPUT` tap can leave a partial
/// message short of text; its next whole frame repairs it, and until then
/// the deck's text-hash check refuses the render.
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

async fn render_bridge_task(
    taps: Taps,
    rendered_tx: broadcast::Sender<Frame>,
    cancel: CancellationToken,
) {
    let Taps {
        mut code_rx,
        mut state_rx,
        mut input_rx,
    } = taps;
    let (mut code_closed, mut state_closed, mut input_closed) = (false, false, false);
    let mut stage = RenderStage::new();
    let mut pacer = Pacer::new();
    let mut rendering: Option<JoinHandle<RenderOutput>> = None;
    let mut finds: JoinSet<FindAnswer> = JoinSet::new();
    let start = Instant::now();
    let clock_ms = move |now: Instant| now.duration_since(start).as_millis() as u64;
    let mut last_sweep = start;
    // A disabled branch still evaluates its future; this is what it sleeps to.
    let never = || Instant::now() + Duration::from_secs(3_600);

    loop {
        let render_at = next_render_at(&stage, &pacer, rendering.is_some(), Instant::now());
        let expiry = pacer.next_expiry();

        // Biased, controls first: a hold or a close read in the same pass as
        // the frames it governs applies before them.
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
                    Some(frame) => {
                        let applied = apply_input(&frame.payload, &mut stage, &mut pacer, Instant::now());
                        if let Some(batch) = applied.batch {
                            publish(&rendered_tx, batch);
                        }
                        if let Some(job) = applied.find {
                            finds.spawn_blocking(move || job.answer());
                        }
                    }
                }
            }
            Some(answered) = finds.join_next(), if !finds.is_empty() => {
                match answered {
                    Ok(FindAnswer { frame, extracted }) => {
                        if let RenderedFrame::FindResult { tug_session_id, .. } = &frame {
                            stage.keep_find_texts(tug_session_id, extracted);
                        }
                        publish_frame(&rendered_tx, &frame);
                    }
                    Err(e) => warn!(error = %e, "render bridge: a find task failed"),
                }
            }
            recv = state_rx.recv(), if !state_closed => {
                if let Some(frame) = take_frame(recv, "session_state", &mut state_closed)
                    && let Some(session) = closed_session(&frame.payload)
                {
                    stage.drop_session(&session);
                    pacer.drop_session(&session);
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
                        if let Some(batch) = pacer.deliver(batch) {
                            publish(&rendered_tx, batch);
                        }
                    }
                    Err(e) => warn!(error = %e, "render bridge: a render task failed"),
                }
            }
            _ = tokio::time::sleep_until(expiry.unwrap_or_else(never)), if expiry.is_some() => {
                if let Some(batch) = pacer.expire(Instant::now()) {
                    publish(&rendered_tx, batch);
                }
            }
            _ = tokio::time::sleep_until(render_at.unwrap_or_else(never)), if render_at.is_some() => {
                let now = Instant::now();
                pacer.last_tick = Some(now);
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
                sessions: vec![RenderedSessionWire {
                    tug_session_id: "s1".into(),
                    messages: vec![RenderedMessageWire {
                        message_key: "m1:0".into(),
                        channel: RenderChannel::Text,
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

    fn inputs() -> Vec<RenderInput> {
        vec![
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
            },
        ]
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
        let parsed: Vec<RenderInput> = serde_json::from_value(fixture["inputs"].clone()).unwrap();
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

    // ── the bridge, under a paused clock ──────────────────────────────────

    use serde_json::json;
    use std::sync::{Arc, Mutex};

    /// Every published batch, with the (virtual) instant it arrived.
    type Published = Arc<Mutex<Vec<(Instant, Vec<RenderedSessionWire>)>>>;

    /// A running bridge and the wires around it. Every published frame is
    /// recorded with the (virtual) instant it arrived.
    struct Harness {
        code_tx: broadcast::Sender<Frame>,
        state_tx: broadcast::Sender<Frame>,
        input_tx: mpsc::Sender<Frame>,
        frames: Published,
        finds: Arc<Mutex<Vec<RenderedFrame>>>,
        cancel: CancellationToken,
    }

    impl Harness {
        fn start() -> Self {
            let (code_tx, _) = broadcast::channel(4096);
            let (state_tx, _) = broadcast::channel(64);
            let (input_tx, input_rx) = mpsc::channel(16);
            let (rendered_tx, mut rendered_rx) = broadcast::channel::<Frame>(64);
            let taps = Taps {
                code_rx: code_tx.subscribe(),
                state_rx: state_tx.subscribe(),
                input_rx,
            };
            let cancel = CancellationToken::new();
            tokio::spawn(render_bridge_task(taps, rendered_tx, cancel.clone()));
            let frames: Published = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&frames);
            let finds = Arc::new(Mutex::new(Vec::new()));
            let find_sink = Arc::clone(&finds);
            tokio::spawn(async move {
                while let Ok(frame) = rendered_rx.recv().await {
                    match serde_json::from_slice(&frame.payload).unwrap() {
                        RenderedFrame::RenderBatch { sessions } => {
                            sink.lock().unwrap().push((Instant::now(), sessions));
                        }
                        found @ RenderedFrame::FindResult { .. } => {
                            find_sink.lock().unwrap().push(found);
                        }
                    }
                }
            });
            Self {
                code_tx,
                state_tx,
                input_tx,
                frames,
                finds,
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

        async fn control(&self, control: Value) {
            let bytes = serde_json::to_vec(&control).unwrap();
            self.input_tx
                .send(Frame::new(FeedId::RENDER_INPUT, bytes))
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

        fn frames(&self) -> Vec<(Instant, Vec<RenderedSessionWire>)> {
            self.frames.lock().unwrap().clone()
        }

        /// Wait for the next find answer.
        async fn find_result(&self) -> RenderedFrame {
            for _ in 0..1_000 {
                if let Some(found) = self.finds.lock().unwrap().pop() {
                    return found;
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

    /// A find over replayed and live text alike, answered at once: the
    /// replayed Message's rendered text is extracted for it, a unit the
    /// stage never saw comes back missing, and a mounted unit carries its
    /// text.
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
        let RenderedFrame::FindResult {
            request_id,
            matches,
            texts,
            missing,
            ..
        } = h.find_result().await
        else {
            panic!("a find result");
        };
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
        let pacer = Pacer::new();
        let now = Instant::now();
        assert_eq!(next_render_at(&stage, &pacer, false, now), None);
        let frame = br#"{"type":"assistant_text","tug_session_id":"s1","msg_id":"m","block_index":0,"is_partial":true,"text":"x"}"#;
        stage.ingest(frame, 0);
        assert_eq!(next_render_at(&stage, &pacer, false, now), Some(now));
        // A render in flight holds the next one back.
        assert_eq!(next_render_at(&stage, &pacer, true, now), None);
        stage.take_dirty();
        assert_eq!(next_render_at(&stage, &pacer, false, now), None);
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
}

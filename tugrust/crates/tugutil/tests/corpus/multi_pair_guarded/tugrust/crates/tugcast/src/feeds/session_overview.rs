//! Session overview — a one-line answer to "what is this session working on?",
//! written by the local model and broadcast on PULSE above the live beat.
//!
//! The beat line says what just happened; the overview says what the whole
//! session is *for*. The overview follows the transcript, not the toolbelt: it
//! is composed from the user's own prompts (read from the claude JSONL) and an
//! interleaved stream of everything the transcript shows — assistant prose,
//! tool calls, and Session-card shell commands, in arrival order. Those go to
//! the local model as one digest, and the sentence that comes back is the
//! line. Either half alone is enough — a session that only answers questions
//! is described by its prompts.
//!
//! **One-way, like the pulse bridge.** This module taps the CODE_OUTPUT
//! broadcast and produces exactly two outputs — a PULSE frame and tracing. It
//! reads no client state and answers no requests, so nothing downstream can
//! block a session on it.
//!
//! **It costs nothing when it can't run.** No model, the tenant switched off,
//! PULSE itself switched off, an unresolvable session identity, a refusal — all
//! of them end the tick silently, and the strip renders exactly as it does
//! today.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

// tokio's `Instant`, not std's: the emitter is clock-driven, and this is the
// clock the paused-time tests can steer.
use tokio::sync::{broadcast, mpsc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::feeds::draft_engine::SessionResolver;
use crate::feeds::pulse::forwardable_session;
use crate::local_model::SharedLocalModelState;
use tugcast_core::{FeedId, Frame};

/// Beats since the last emit that on their own justify a new overview: enough
/// has happened that the last sentence is probably stale. Counted over every
/// beat a session can produce — a tool running, prose streaming, a shell
/// command, a turn ending.
const BURST_BEATS: u32 = 8;

/// Elapsed time that justifies a new overview on its own, given any activity
/// at all — so a slow session still gets a refreshed line.
const IDLE_PERIOD: Duration = Duration::from_secs(20);

/// Minimum spacing between two overviews for one session, whatever the burst
/// says. Inference isn't free and the line isn't worth twitching.
///
/// `pub` so `local_model.rs` can assert its `summarize` ceiling sits under it:
/// a ceiling above this floor would make the emitter's cadence inference-bound
/// rather than designed.
pub const EMIT_FLOOR: Duration = Duration::from_secs(8);

/// How often the emitter wakes to sweep sessions against the cadence. Frames
/// are evidence, not triggers, so this is the only evaluation point — well
/// inside every floor, so nothing due waits perceptibly.
const TICK_INTERVAL: Duration = Duration::from_secs(2);

/// Minimum spacing between forced (human-act) fires — two sweep ticks. A lone
/// submission still re-aims at typing speed, but every `$` command's start
/// arms the fire too, and an unspaced burst of them would drive one inference
/// per tick into the model that also serves the `$` route's classify calls.
const FORCED_EMIT_FLOOR: Duration = Duration::from_secs(4);

/// Sessions with no frames for this long are dropped at the sweep. The map is
/// a rolling picture, not an archive: a closed or abandoned session's state
/// would otherwise ride in memory for the life of the process.
const SESSION_RETENTION: Duration = Duration::from_secs(3600);

/// Activity lines carried per session — tool, prose, and shell lines in one
/// interleaved deque. Enough to show the shape of the work, bounded so the
/// digest can't grow without limit.
const MAX_ACTIVITY_LINES: usize = 24;

/// Background lines the digest actually carries — the newest of the
/// background slice, clipped at compose time. A long session's ancient
/// history drops out of the model's input entirely; the deque above keeps
/// enough spare for the next recency split.
const MAX_BACKGROUND_LINES: usize = 12;

/// User prompts fed into the digest: the session's pinned first prompt — the
/// standing goal — plus the most recent ones, the live direction. The middle
/// prompts are the least informative slice and used to outvote the subject.
/// `MAX_PROMPT_CHARS` clips per prompt, not across the set; real sessions
/// land far under the worst case.
const MAX_RECENT_PROMPTS: usize = 2;
const MAX_PROMPT_CHARS: usize = 1_500;

/// Characters of a tool's target kept in its digest line.
const MAX_TARGET_CHARS: usize = 60;

/// Characters of a prose block's head kept in its `said:` digest line.
const MAX_SAID_CHARS: usize = 100;

/// Slack past `MAX_SAID_CHARS` buffered while waiting for a sentence boundary.
/// Accumulation stops at cap + slack — the tail of a long block is never
/// buffered.
const SAID_SLACK: usize = 40;

/// A sentence terminator this early is bait — "e.g." and version numbers, not
/// a sentence — so the head keeps reading past it.
const MIN_SENTENCE_CHARS: usize = 20;

/// PulseLine doctrine: one line, and it has to fit the strip as a *headline* —
/// the bright leading run of the strip's single row, not a sentence about the
/// session. Long enough for the work's name with slack, short enough that prose
/// cannot pass. A tuning value; the live matrix may move it.
const MAX_HEADLINE_CHARS: usize = 56;

/// Words a headline runs to. The character budget alone cannot enforce this: a
/// long-enough run of short words fits 56 characters and still reads as a
/// sentence.
const MAX_HEADLINE_WORDS: usize = 6;

/// Joiners a headline's dispensable tail hangs from.
///
/// Past the word budget, what a model has added is almost always the parts list
/// a label headline drags behind it — "Author command-line calculator **with
/// makefile and readme**". Headline register drops exactly this: `and` gives way
/// to a comma or is cut, and trailing modifiers go. Cutting at the joiner keeps
/// a whole phrase rather than a truncated one.
const TAIL_JOINERS: &[&str] = &["and", "with", "plus", "including", "featuring"];

/// First and last back-off after the model refuses or fails.
const BACKOFF_START: Duration = Duration::from_secs(60);
const BACKOFF_MAX: Duration = Duration::from_secs(600);

/// Which of the three independent conditions currently allow a tick.
///
/// Separated from the loop so the truth table is a fact about the module rather
/// than an accident of control flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gates {
    /// The `pulse-overview` tenant switch.
    pub tenant_enabled: bool,
    /// PULSE itself. The strip hides entirely when it's off, and there is no
    /// sense spending inference on a line nobody can see.
    pub pulse_enabled: bool,
    /// Whether the model is currently in refusal back-off.
    pub backing_off: bool,
}

impl Gates {
    pub fn allow(self) -> bool {
        self.tenant_enabled && self.pulse_enabled && !self.backing_off
    }
}

/// When an overview is worth emitting. Injectable so the loop can be exercised
/// without waiting out real seconds; production always uses [`Cadence::default`].
#[derive(Clone, Copy, Debug)]
pub struct Cadence {
    pub burst_beats: u32,
    pub idle_period: Duration,
    pub floor: Duration,
    /// Minimum spacing on the forced (human-act) fire path — the only floor
    /// that path honors.
    pub forced_floor: Duration,
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            burst_beats: BURST_BEATS,
            idle_period: IDLE_PERIOD,
            floor: EMIT_FLOOR,
            forced_floor: FORCED_EMIT_FLOOR,
        }
    }
}

impl Cadence {
    /// Whether enough has happened, long enough ago, to be worth a new
    /// sentence. Evaluated on the sweep clock, so "nothing new" truly means
    /// nothing happened — not "no frame arrived to ask."
    ///
    /// `since_last_emit` runs from the session's first beat until its first
    /// overview, so the floor applies to the opening line too.
    pub fn fires(self, new_beats: u32, since_last_emit: Duration) -> bool {
        if new_beats == 0 {
            return false;
        }
        if since_last_emit < self.floor {
            return false;
        }
        new_beats >= self.burst_beats || since_last_emit >= self.idle_period
    }
}

/// What a frame contributes to a session's picture — the transcript's beat
/// vocabulary.
///
/// Every kind advances the cadence; the content-bearing kinds also carry the
/// digest line describing what happened. The vocabulary covers everything that
/// streams into the transcript — tool calls, assistant prose, and Session-card
/// shell commands — so a session that only talks, or only runs `$` commands,
/// reaches the cadence exactly as a tool-running one does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionBeat {
    /// A tool ran; the digest line describing it.
    Tool(String),
    /// The assistant said something; the `said:` digest line holding the head
    /// of the block.
    Said(String),
    /// A `$` shell command started or settled. `Some` carries the digest line;
    /// `None` is a zero-exit completion — the command already has its started
    /// line, so settling cleanly advances the cadence and says nothing new.
    Shell(Option<String>),
    /// A turn ended. No line, but the session is demonstrably alive and the
    /// user has said something new since the last overview.
    Turn,
    /// The user submitted a message — a human act tapped from CODE_INPUT.
    /// Carries the clipped ask text, `None` for an image-only submission.
    /// A counter beat, never an activity line: the prompt is direction, not
    /// activity.
    Asked(Option<String>),
}

/// What a CODE_OUTPUT frame hands the accumulator: either a finished beat, or
/// a prose fragment the session state accumulates into one.
///
/// Prose is not a beat at parse time because a block earns exactly one `Said`
/// line however many deltas carry it — the accumulation (and its dedup against
/// reconnect snapshots) lives on `SessionState`, not in the parser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodeOutputEvent {
    Beat(SessionBeat),
    Prose {
        msg_id: String,
        block_index: u64,
        is_partial: bool,
        text: String,
    },
}

/// What, if anything, a CODE_OUTPUT frame contributes.
///
/// The frame is already known to be forwardable and un-muted; this is only the
/// question of which frames are evidence of work happening. `turn_cancelled`
/// counts alongside `turn_complete`: a cancelled turn ended all the same, and
/// its trailing prose — what the session was saying when the user hit Escape —
/// still deserves its line.
pub fn code_output_event(payload: &serde_json::Value) -> Option<CodeOutputEvent> {
    match payload.get("type").and_then(|v| v.as_str())? {
        "tool_use" => tool_line(payload).map(|line| CodeOutputEvent::Beat(SessionBeat::Tool(line))),
        "turn_complete" | "turn_cancelled" => Some(CodeOutputEvent::Beat(SessionBeat::Turn)),
        "assistant_text" => Some(CodeOutputEvent::Prose {
            msg_id: payload.get("msg_id").and_then(|v| v.as_str())?.to_string(),
            block_index: payload
                .get("block_index")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            is_partial: payload
                .get("is_partial")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            text: payload.get("text").and_then(|v| v.as_str())?.to_string(),
        }),
        _ => None,
    }
}

/// A prose block mid-stream: its identity on the wire and the bounded head
/// accumulated so far.
struct ProseBlock {
    key: (String, u64),
    text: String,
}

/// A session's incrementally read prompts. The JSONL is append-only in the
/// normal case, so each refresh stats the file and parses only the bytes
/// added since the last one — never the whole transcript, which runs to tens
/// of megabytes on long sessions.
#[derive(Default)]
struct PromptCache {
    /// Bytes parsed so far — always at a line boundary, so a partial trailing
    /// line (the writer mid-append) is left for the next refresh.
    offset: u64,
    /// The session's first prompt, pinned: it never changes and it is the
    /// standing goal the digest leads with.
    first: Option<String>,
    /// The most recent prompts, oldest evicted.
    recent: VecDeque<String>,
}

impl PromptCache {
    /// Fold any newly appended complete lines into the cache. Runs blocking
    /// I/O — call from `spawn_blocking`. Every failure leaves the cache as it
    /// was: an unreadable file costs the refresh, never the tick.
    fn refresh(&mut self, jsonl: &std::path::Path) {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(meta) = std::fs::metadata(jsonl) else {
            return;
        };
        let len = meta.len();
        if len == self.offset {
            return;
        }
        if len < self.offset {
            // The file shrank — rewritten, not appended. Start over.
            self.offset = 0;
            self.first = None;
            self.recent.clear();
        }
        let Ok(file) = std::fs::File::open(jsonl) else {
            return;
        };
        let mut file = file;
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        if file.take(len - self.offset).read_to_end(&mut buf).is_err() {
            return;
        }
        let Some(last_newline) = buf.iter().rposition(|&b| b == b'\n') else {
            // No complete line yet; nothing consumable.
            return;
        };
        let complete = String::from_utf8_lossy(&buf[..=last_newline]);
        for line in complete.lines() {
            let Some(prompt) = crate::scribe::prompt_from_jsonl_line(line, 0, MAX_PROMPT_CHARS)
            else {
                continue;
            };
            if self.first.is_none() {
                self.first = Some(prompt.clone());
            }
            if self.recent.len() == MAX_RECENT_PROMPTS {
                self.recent.pop_front();
            }
            self.recent.push_back(prompt);
        }
        self.offset += last_newline as u64 + 1;
    }

    /// The digest's prompt set: the pinned first prompt, then the recent ones
    /// — minus a recent entry that still *is* the first prompt, so a young
    /// session doesn't state its goal twice.
    fn digest_prompts(&self) -> Vec<String> {
        let mut prompts = Vec::new();
        if let Some(first) = &self.first {
            prompts.push(first.clone());
        }
        for prompt in &self.recent {
            if Some(prompt) != self.first.as_ref() {
                prompts.push(prompt.clone());
            }
        }
        prompts
    }

    /// Whether the cache already spells this ask — as its newest recent entry
    /// (the JSONL caught up) or as the pinned first (a young session's opening
    /// ask). Exact string equality: the submission tap clips through the same
    /// extraction this cache reads back.
    fn carries(&self, ask: &str) -> bool {
        self.recent.back().map(String::as_str) == Some(ask) || self.first.as_deref() == Some(ask)
    }
}

/// One session's rolling picture of what it is doing.
struct SessionState {
    /// Interleaved activity lines — tool, prose, and shell — in arrival order.
    activity: VecDeque<String>,
    new_beats: u32,
    /// Activity lines recorded since the last committed tick. The trailing
    /// slice of `activity` this counts is the digest's *right now* section.
    activity_since_emit: usize,
    /// The one prose block currently streaming, if any. Blocks arrive
    /// serially, so a delta for a new key finalizes the previous one.
    open: Option<ProseBlock>,
    /// Blocks that already earned their `Said` beat. Later deltas and
    /// reconnect-snapshot terminals for these keys are dropped — the
    /// consolidated snapshot re-sends whole blocks the live stream already
    /// narrated. Cleared at turn end; msg ids never recur across turns.
    beaten: HashSet<(String, u64)>,
    /// The incrementally read prompt set (see [`PromptCache`]).
    prompts: PromptCache,
    /// Armed by a human act — a submission or a `$` command starting — and
    /// cleared by the committed tick: the next sweep treats this session as
    /// due past the forced floor, regardless of burst, idle, or the full
    /// anti-twitch floor. Gates still apply.
    fire_asap: bool,
    /// A text-bearing submission arrived since the last committed tick — the
    /// freshness signal the digest's synthesized right-now section requires,
    /// so a later quiet tick cannot resurrect a finished ask as live work.
    asked_since_emit: bool,
    /// The newest submission's clipped ask, carried into the digest as the
    /// current directive until the prompt cache reads the same text back from
    /// the JSONL.
    pending_ask: Option<String>,
    /// When any frame last arrived for this session — the retention clock.
    last_seen: Instant,
    last_emit: Instant,
    last_digest: Option<String>,
    last_headline: Option<String>,
    beat: i64,
}

impl SessionState {
    fn new(now: Instant) -> Self {
        Self {
            activity: VecDeque::new(),
            new_beats: 0,
            activity_since_emit: 0,
            open: None,
            beaten: HashSet::new(),
            prompts: PromptCache::default(),
            fire_asap: false,
            asked_since_emit: false,
            pending_ask: None,
            last_seen: now,
            last_emit: now,
            last_digest: None,
            last_headline: None,
            beat: 0,
        }
    }

    /// A human act — a submission or a `$` command starting — re-aims the
    /// pulse. The recency boundary zeroes *before* the act's own beat is
    /// recorded, so the act begins "right now": a shell command's line is the
    /// first entry, and a submission leaves "right now" empty until the
    /// response streams. Prose state is untouched — an ask neither finalizes
    /// an open block nor clears the dedup set; those stay keyed to
    /// CODE_OUTPUT turn frames.
    fn human_act(&mut self) {
        self.activity_since_emit = 0;
        self.fire_asap = true;
    }

    /// Commit a due tick: reset the counters the cadence and the digest read,
    /// and snapshot what the emit needs — the activity lines, how many of them
    /// are "right now", and whether the stretch contained a fresh ask. Runs on
    /// the loop at spawn time, so a session never emits from a half-committed
    /// picture.
    fn commit_tick(&mut self, now: Instant) -> (Vec<String>, usize, bool) {
        let recent = self.activity_since_emit;
        let asked = self.asked_since_emit;
        self.new_beats = 0;
        self.activity_since_emit = 0;
        self.asked_since_emit = false;
        self.fire_asap = false;
        self.last_emit = now;
        (self.activity.iter().cloned().collect(), recent, asked)
    }

    fn record(&mut self, beat: SessionBeat) {
        let line = match beat {
            SessionBeat::Tool(line) | SessionBeat::Said(line) => Some(line),
            SessionBeat::Shell(line) => line,
            SessionBeat::Turn | SessionBeat::Asked(_) => None,
        };
        if let Some(line) = line {
            if self.activity.len() == MAX_ACTIVITY_LINES {
                self.activity.pop_front();
            }
            self.activity.push_back(line);
            self.activity_since_emit += 1;
        }
        self.new_beats += 1;
    }

    /// Route a CODE_OUTPUT event into beats and record them. Prose fragments
    /// accumulate; everything else records directly, and a `Turn` first
    /// settles the prose state (finalize the open block, clear the dedup set).
    fn observe(&mut self, event: CodeOutputEvent) {
        match event {
            CodeOutputEvent::Beat(SessionBeat::Turn) => {
                if let Some(said) = self.finalize_open() {
                    self.record(said);
                }
                self.beaten.clear();
                self.record(SessionBeat::Turn);
            }
            CodeOutputEvent::Beat(beat) => self.record(beat),
            CodeOutputEvent::Prose {
                msg_id,
                block_index,
                is_partial,
                text,
            } => {
                let beats = if is_partial {
                    self.prose_delta((msg_id, block_index), &text)
                } else {
                    self.prose_terminal((msg_id, block_index), &text)
                };
                for beat in beats {
                    self.record(beat);
                }
            }
        }
    }

    /// Close the open block, yielding its `Said` beat when it has anything
    /// unbeaten to say.
    fn finalize_open(&mut self) -> Option<SessionBeat> {
        let block = self.open.take()?;
        if self.beaten.contains(&block.key) {
            return None;
        }
        let head = said_head(&block.text, true)?;
        self.beaten.insert(block.key);
        Some(SessionBeat::Said(head))
    }

    /// A live streaming fragment (`is_partial: true`). At most two beats come
    /// back: a finalization of the previous block when the key changed, and
    /// this block's own beat when its head just crossed the threshold.
    fn prose_delta(&mut self, key: (String, u64), text: &str) -> Vec<SessionBeat> {
        let mut beats = Vec::new();
        if self.beaten.contains(&key) {
            return beats;
        }
        if self.open.as_ref().is_some_and(|block| block.key != key) {
            beats.extend(self.finalize_open());
        }
        let block = self.open.get_or_insert_with(|| ProseBlock {
            key: key.clone(),
            text: String::new(),
        });
        let room = (MAX_SAID_CHARS + SAID_SLACK).saturating_sub(block.text.chars().count());
        block.text.extend(text.chars().take(room));
        if let Some(head) = said_head(&block.text, false) {
            // The block stays open as a key marker; its text has done its job.
            block.text.clear();
            self.beaten.insert(key);
            beats.push(SessionBeat::Said(head));
        }
        beats
    }

    /// A whole-block frame (`is_partial: false`) — a reconnect snapshot or a
    /// synthetic message. A beaten key is the snapshot re-sending what the
    /// live stream already narrated; an unseen key is a real block.
    fn prose_terminal(&mut self, key: (String, u64), text: &str) -> Vec<SessionBeat> {
        let mut beats = Vec::new();
        if self.beaten.contains(&key) {
            if self.open.as_ref().is_some_and(|block| block.key == key) {
                self.open = None;
            }
            return beats;
        }
        match &self.open {
            Some(block) if block.key == key => self.open = None,
            Some(_) => beats.extend(self.finalize_open()),
            None => {}
        }
        if let Some(head) = said_head(text, true) {
            self.beaten.insert(key);
            beats.push(SessionBeat::Said(head));
        }
        beats
    }
}

/// The `said:` digest line for a prose block, once the block has earned one.
///
/// The head is the block's first sentence — the first `.`, `!`, or `?` at
/// character index `MIN_SENTENCE_CHARS` or later, followed by whitespace — or
/// the first `MAX_SAID_CHARS` characters when no boundary arrives in budget.
/// `finalized` marks the text as complete: a trailing terminator then counts
/// as a boundary, and any nonempty remainder is a head even under the cap.
/// Mid-stream, `None` means keep accumulating.
pub fn said_head(text: &str, finalized: bool) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut count = 0;
    let mut sentence = None;
    let mut chars = collapsed.chars().peekable();
    let mut head = String::new();
    while let Some(ch) = chars.next() {
        head.push(ch);
        count += 1;
        if count >= MIN_SENTENCE_CHARS
            && matches!(ch, '.' | '!' | '?')
            && chars.peek().is_none_or(|next| next.is_whitespace())
            && (finalized || chars.peek().is_some())
        {
            sentence = Some(head.clone());
            break;
        }
    }
    let head = sentence.or_else(|| {
        let long_enough = collapsed.chars().count() >= MAX_SAID_CHARS;
        (long_enough || (finalized && !collapsed.is_empty()))
            .then(|| clip(&collapsed, MAX_SAID_CHARS))
    })?;
    Some(format!("said: {head}"))
}

/// Refusal back-off, doubling from a minute to ten.
///
/// A model that just refused (or isn't there, or timed out) will almost
/// certainly refuse the next tick too, and every session in the process shares
/// one model — so the back-off is process-wide rather than per session.
struct BackOff {
    until: Option<Instant>,
    delay: Duration,
}

impl BackOff {
    fn new() -> Self {
        Self {
            until: None,
            delay: BACKOFF_START,
        }
    }

    fn active(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now < until)
    }

    fn fail(&mut self, now: Instant) {
        self.until = Some(now + self.delay);
        self.delay = next_backoff(self.delay);
    }

    fn succeed(&mut self) {
        self.until = None;
        self.delay = BACKOFF_START;
    }
}

/// Double the back-off, capped. Separate so the ladder is testable without a
/// clock.
pub fn next_backoff(current: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    if doubled > BACKOFF_MAX {
        BACKOFF_MAX
    } else {
        doubled
    }
}

/// What, if anything, a SHELL_OUTPUT frame contributes.
///
/// A command starting and a command settling are both transcript events, so
/// both advance the cadence; only the failing settle has anything new to say —
/// a clean exit adds nothing beyond the started line. Only `type`, `command`,
/// and `exit_code` are read; the settle frame's full `output` is never
/// retained. Never returns `Turn` — turn side effects (prose finalization, the
/// dedup-set clear) key off CODE_OUTPUT turn frames alone.
pub fn shell_beat(payload: &serde_json::Value) -> Option<SessionBeat> {
    let command = payload
        .get("command")
        .and_then(|v| v.as_str())
        .map(|command| clip(command.trim(), MAX_TARGET_CHARS));
    match payload.get("type").and_then(|v| v.as_str())? {
        "exchange_started" => Some(SessionBeat::Shell(Some(format!("$ {}", command?)))),
        "exchange_complete" => match payload.get("exit_code").and_then(|v| v.as_i64()) {
            // A missing exit code (spawn failure, kill) has no number to
            // narrate; the settle still counts as evidence of life.
            Some(0) | None => Some(SessionBeat::Shell(None)),
            Some(code) => Some(SessionBeat::Shell(Some(format!(
                "$ {} → exit {code}",
                command?
            )))),
        },
        _ => None,
    }
}

/// What, if anything, a CODE_INPUT frame contributes: the session it belongs
/// to and its `Asked` beat. Only `user_message` is a submission — every other
/// CODE_INPUT verb (interrupts, tool approvals, permission answers) returns
/// `None`. The ask text mirrors the prompt cache's own extraction — text
/// blocks concatenated, trimmed, character-clipped to `MAX_PROMPT_CHARS` — so
/// the same submission read later from the session JSONL spells identically.
pub fn submission_beat(payload: &serde_json::Value) -> Option<(String, SessionBeat)> {
    let session_id = payload.get("tug_session_id").and_then(|v| v.as_str())?;
    if payload.get("type").and_then(|v| v.as_str())? != "user_message" {
        return None;
    }
    let text = payload
        .get("content")
        .map(crate::external_sessions::submission_text)
        .and_then(|text| {
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.chars().take(MAX_PROMPT_CHARS).collect())
            }
        });
    Some((session_id.to_string(), SessionBeat::Asked(text)))
}

/// A `tool_use` frame reduced to one digest line: the tool's name and what it
/// acted on. The target is whichever of the well-known input fields is present
/// — a path, a command, a pattern, a URL — clipped, because the digest is about
/// shape, not detail.
///
/// The name field is `tool_name`, which is what tugcode puts on the wire
/// (`ToolUseFrame` in `tugcode/src/types.ts`) and what every other consumer of
/// this frame reads. Anthropic's own tool-use block calls it `name`, but that
/// shape never reaches CODE_OUTPUT — tugcode has already reframed it.
pub fn tool_line(payload: &serde_json::Value) -> Option<String> {
    let name = payload.get("tool_name").and_then(|v| v.as_str())?;
    let target = payload
        .get("input")
        .and_then(|input| {
            [
                "command",
                "file_path",
                "path",
                "notebook_path",
                "pattern",
                "url",
            ]
            .iter()
            .find_map(|field| input.get(*field).and_then(|v| v.as_str()))
        })
        .map(|target| clip(target.trim(), MAX_TARGET_CHARS))
        .unwrap_or_default();
    if target.is_empty() {
        Some(name.to_string())
    } else {
        Some(format!("{name}({target})"))
    }
}

/// Compose the digest the model summarizes: what the user asked for, what the
/// session has been doing about it, and what it is doing right now.
///
/// `recent_count` is how many of the trailing `activity` entries arrived since
/// the last committed tick, clamped to `activity.len()`. Those entries are the
/// *right now* section and the ones before them are the background — of which
/// only the newest `MAX_BACKGROUND_LINES` reach the digest, so a long
/// session's history cannot outvote its own present. A section with no
/// entries is omitted entirely, heading and all — so a session's first
/// overview (everything recent) carries no background section, and a tick
/// with no new activity carries no *right now* section.
///
/// `asked` marks a stretch that contained a text submission. When it did, and
/// no activity has arrived since, the digest closes with a synthesized *right
/// now* section carrying the newest ask — the session was just re-aimed, and
/// taking up that ask is what it is doing.
///
/// Returns `None` when there is nothing to describe — with neither prompts nor
/// activity there is no session to have an opinion about.
pub fn compose_digest(
    prompts: &[String],
    activity: &[String],
    recent_count: usize,
    asked: bool,
) -> Option<String> {
    if prompts.is_empty() && activity.is_empty() {
        return None;
    }
    let split = activity.len() - recent_count.min(activity.len());
    let background_start = split.saturating_sub(MAX_BACKGROUND_LINES);
    let mut out = String::new();
    if !prompts.is_empty() {
        out.push_str("What the user asked for:\n");
        for prompt in prompts {
            out.push_str("- ");
            out.push_str(&clip(prompt.trim(), 240));
            out.push('\n');
        }
    }
    for (heading, lines) in [
        (
            "What the session has been doing:",
            &activity[background_start..split],
        ),
        ("What it is doing right now:", &activity[split..]),
    ] {
        if lines.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(heading);
        out.push('\n');
        for line in lines {
            out.push_str("- ");
            out.push_str(line);
            out.push('\n');
        }
    }
    // No activity is "now" but an ask arrived this stretch: the session was
    // just re-aimed, and taking up the newest ask *is* what it is doing
    // right now. `asked` holds this to a stretch that actually contained a
    // submission — without it, any quiet tick (a turn settling, a clean `$`
    // exit) would resurrect the finished ask as live work. Without the line
    // itself the digest ends on the old turn's background and a small model
    // headlines the work it can see instead of the directive it was given.
    // The line is the ask verbatim — a meta-prefix ("taking up:") makes the
    // model discount the line as commentary and fall back to the background.
    if asked && activity[split..].is_empty() && prompts.len() >= 2 {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str("What it is doing right now:\n- ");
        out.push_str(&clip(prompts[prompts.len() - 1].trim(), 240));
        out.push('\n');
    }
    Some(out)
}

/// Clip to a character budget, on a character boundary, with an ellipsis when
/// anything was dropped.
pub fn clip(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_none() {
        head
    } else {
        format!("{head}…")
    }
}

/// Openers a model reaches for when it describes the act of working instead of
/// naming the work. Matched case-insensitively, on the prefix only.
const FILLER_OPENERS: &[&str] = &[
    "working on ",
    "trying to ",
    "currently ",
    "the user is ",
    "this session is ",
    "it looks like ",
];

/// Articles, stripped only from the very front — a headline names a thing, and
/// the article is the one word that never carries any of that name.
const LEADING_ARTICLES: &[&str] = &["the ", "a ", "an "];

/// Strip a case-insensitive prefix from `text`, returning the remainder.
///
/// Compares the original's leading characters rather than lowercasing the whole
/// string and slicing by the prefix's byte length: lowercasing can change a
/// character's byte width, and the resulting offset would not be a char
/// boundary in the original.
fn strip_prefix_ci<'a>(text: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    prefixes.iter().find_map(|prefix| {
        let head: String = text.chars().take(prefix.chars().count()).collect();
        (head.to_lowercase() == *prefix).then(|| &text[head.len()..])
    })
}

/// What the register normalizer produced, and what it had to do to get there.
///
/// The three flags are the standing read on whether the prompt is still in
/// register. They are different failures: a `trimmed` answer means the model
/// wrote a parts list, a `clipped` one means it wrote prose, and `normalized`
/// alone means it wrote a headline with an article or a filler opener in front.
/// A `String` return cannot express any of that, which is why the normalizer
/// reports rather than only returning.
#[derive(Debug, Clone)]
pub struct HeadlineReport {
    pub text: String,
    /// The normalizer changed the string at all.
    pub normalized: bool,
    /// The six-word budget cut a tail.
    pub trimmed: bool,
    /// The 56-character budget clipped, after any trim.
    pub clipped: bool,
}

/// Impose headline register on whatever the model wrote, and report the work.
///
/// Mechanical only: it removes the forms a model in the wrong register
/// produces, and never rewrites content. Paraphrase would be a second model
/// with none of the first one's context, so the rules stop at quotes, filler
/// openers, articles, whitespace and terminal punctuation, then clip.
///
/// Order is load-bearing. Filler openers go before articles, so
/// `The user is working on the pulse strip` reduces in one pass; clipping is
/// last, so a stripped prefix buys back budget instead of wasting it.
///
/// Total: any input, including empty or whitespace-only, yields a string.
pub fn headline_register_report(raw: &str) -> HeadlineReport {
    let mut text = raw.trim();

    // Matched wrapping quotes, straight or curly. A model asked for one line
    // often hands back that line in quotes.
    for (open, close) in [('"', '"'), ('\'', '\''), ('\u{201c}', '\u{201d}')] {
        if text.chars().count() >= 2 && text.starts_with(open) && text.ends_with(close) {
            let mut chars = text.chars();
            chars.next();
            chars.next_back();
            text = chars.as_str().trim();
            break;
        }
    }

    while let Some(rest) = strip_prefix_ci(text, FILLER_OPENERS) {
        text = rest.trim_start();
    }
    if let Some(rest) = strip_prefix_ci(text, LEADING_ARTICLES) {
        text = rest.trim_start();
    }

    // Collapse internal whitespace runs, including any the model wrapped with.
    let mut collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");

    // A trailing period is sentence punctuation and never belongs on a
    // headline. `?` and `!` are content; `…` is `clip`'s own marker and is a
    // different character entirely, and a spelled-out `...` is left alone too.
    if collapsed.ends_with('.') && !collapsed.ends_with("..") {
        collapsed.pop();
    }

    let collapsed = collapsed.trim();
    let trimmed_text = trim_to_word_budget(collapsed);
    let text = clip(&trimmed_text, MAX_HEADLINE_CHARS);
    HeadlineReport {
        normalized: text != raw.trim(),
        trimmed: trimmed_text != collapsed,
        clipped: text != trimmed_text,
        text,
    }
}

/// Bring a headline within the word budget by dropping its tail.
///
/// Cuts at the earliest joiner in range, so the whole tail goes rather than
/// part of it — "Author command-line calculator with makefile and readme" loses
/// everything from `with`, not just `and readme`. A headline with no
/// joiner to cut at is truncated, because a bounded headline is the guarantee
/// and an unbounded one is prose. Never cuts below three words: past that there
/// is no headline left to save.
pub fn trim_to_word_budget(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= MAX_HEADLINE_WORDS {
        return text.to_string();
    }
    let joiner_at = words.iter().enumerate().find(|(i, word)| {
        let bare = word
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        *i >= 3 && *i <= MAX_HEADLINE_WORDS && TAIL_JOINERS.contains(&bare.as_str())
    });
    let end = match joiner_at {
        Some((i, _)) => i,
        None => MAX_HEADLINE_WORDS,
    };
    words[..end].join(" ")
}

/// The PULSE frame carrying an overview. `kind` is what tells the deck to file
/// it above the beat line instead of in the beat stream; parsers that predate
/// the field ignore it.
pub fn overview_frame(session_id: &str, headline: &str, beat: i64, at_ms: i64) -> Frame {
    let body = serde_json::json!({
        "type": "pulse",
        "kind": "overview",
        "text": headline,
        "scopes": [session_id],
        "beat": beat,
        "at": at_ms,
    });
    Frame::new(FeedId::PULSE, serde_json::to_vec(&body).unwrap_or_default())
}

/// How the emitter resolves a `tug_session_id` into the claude JSONL that holds
/// the user's prompts. Both halves live in the supervisor and the ledger, which
/// a bare task can't reach, so they are handed in at wiring time.
/// Resolves a `tug_session_id` to its project dir, when known.
pub type ProjectDirResolver = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Clone)]
pub struct SessionIdentity {
    pub resolver: SessionResolver,
    pub project_dir: ProjectDirResolver,
    pub claude_projects_root: PathBuf,
}

impl SessionIdentity {
    /// The session's JSONL, or `None` when either half of the identity is
    /// unresolvable.
    ///
    /// The ledger records the path the user typed, which may be any spelling of
    /// the directory — `/u/src/tugtool` and `/Users/…/Mounts/u/src/tugtool` are
    /// one directory with two names, and claude names its project folder after
    /// only one of them. Routing through `claude_project_dir` is what makes the
    /// two agree ([L29]); encoding the raw string finds nothing and costs the
    /// digest the user's own prompts without saying so.
    pub fn jsonl_path(&self, tug_session_id: &str) -> Option<PathBuf> {
        let claude_id = (self.resolver)(tug_session_id)?;
        let project_dir = (self.project_dir)(tug_session_id)?;
        let (dir, _canonical) =
            crate::session_ledger::claude_project_dir(&self.claude_projects_root, &project_dir);
        Some(dir.join(format!("{claude_id}.jsonl")))
    }
}

pub struct SessionOverviewConfig {
    /// The shared CODE_OUTPUT broadcast — subscribed inside the task.
    pub code_tx: broadcast::Sender<Frame>,
    /// The shared SHELL_OUTPUT broadcast — the Session card's `$` route.
    /// Subscribed inside the task; frames route by the `tug_session_id` the
    /// feed splices into every payload. No mute set: SHELL_OUTPUT carries no
    /// replay brackets (restore is a CONTROL ledger read), so every frame the
    /// subscription sees is live work.
    pub shell_tx: broadcast::Sender<Frame>,
    /// The CODE_INPUT submission broadcast — the relay in `main.rs` publishes
    /// every client→session frame here before forwarding it to the supervisor.
    /// Inherently live: replay and reconnect never ride CODE_INPUT, so this
    /// wire needs no mute set and no snapshot dedup.
    pub submission_tx: broadcast::Sender<Frame>,
    /// The PULSE broadcast to publish overviews on.
    pub pulse_tx: broadcast::Sender<Frame>,
    /// The `pulse-overview` tenant switch, read per tick so a flip is live.
    pub tenant_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// PULSE's own switch, same closure shape the bridge uses.
    pub pulse_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub local_model: SharedLocalModelState,
    pub identity: SessionIdentity,
    pub cadence: Cadence,
}

/// The CODE_INPUT relay: the router's registered sink feeds `relay_rx`; every
/// frame is published to the submission broadcast, then forwarded verbatim to
/// the supervisor's dispatcher. Publish before forward, so the overview's copy
/// never trails the supervisor's by more than the broadcast hop; a lagged or
/// absent subscriber drops frames on the broadcast side and can never delay
/// dispatch. Ends when either side closes — the sink closing and the
/// dispatcher going away are the same shutdown.
pub async fn relay_code_input(
    mut relay_rx: mpsc::Receiver<Frame>,
    submission_tx: broadcast::Sender<Frame>,
    forward_tx: mpsc::Sender<Frame>,
) {
    while let Some(frame) = relay_rx.recv().await {
        let _ = submission_tx.send(frame.clone());
        if forward_tx.send(frame).await.is_err() {
            return;
        }
    }
}

/// Which wire an inbound frame arrived on.
enum Inbound {
    Code(Frame),
    Shell(Frame),
    Submission(Frame),
}

/// A due session's snapshot, committed on the loop and carried onto the emit
/// task. Everything the digest needs rides along, so the task never touches
/// the session map.
struct EmitJob {
    session_id: String,
    activity: Vec<String>,
    recent_activity: usize,
    asked: bool,
    cache: PromptCache,
    pending_ask: Option<String>,
    last_digest: Option<String>,
    jsonl: Option<PathBuf>,
    local_model: SharedLocalModelState,
}

/// What an emit task hands back to the loop.
struct EmitOutcome {
    session_id: String,
    /// The prompt cache, back from its round trip through the emit.
    cache: PromptCache,
    /// The pending ask the cache caught up with — cleared on the state only
    /// while it is still the current one, so a submission landing mid-emit
    /// survives.
    caught_up_ask: Option<String>,
    /// The digest the model actually saw. Recorded as `last_digest` only on
    /// success, so a digest the model never saw retries once the model
    /// returns instead of dying to the digest-unchanged dedup.
    seen_digest: Option<String>,
    /// The normalized headline, when the model produced one.
    headline: Option<String>,
    /// The model was absent or failed — arm the back-off.
    failed: bool,
}

/// Run the emitter until cancelled.
///
/// The loop is clock-driven: frame arrival only accumulates evidence, and the
/// tick arm is the sole place the cadence is evaluated — so a session emits
/// when its overview is due, not when the next frame happens to arrive. That
/// is what lets a prose-only stretch fire on the idle path and the final
/// stretch of a session get summarized with no trailing frame.
///
/// Emits run off the loop: a due session's tick commits synchronously, then
/// its prompt refresh and summarize ride a spawned task while the loop keeps
/// observing frames and cancellation — an emit held at the transport timeout
/// cannot deafen the accumulator. One emit is in flight at a time (the one
/// shared model serializes inference anyway); the other due sessions queue
/// behind it with their ticks uncommitted, so a back-off arming mid-queue
/// leaves their evidence — and any armed forced fire — intact.
pub async fn session_overview_task(config: SessionOverviewConfig, cancel: CancellationToken) {
    let mut code_rx = config.code_tx.subscribe();
    let mut shell_rx = config.shell_tx.subscribe();
    let mut submission_rx = config.submission_tx.subscribe();
    let mut sessions: HashMap<String, SessionState> = HashMap::new();
    // Sessions inside a replay bracket: their frames are history being
    // re-emitted, not live work. Maintained exactly as the pulse bridge does.
    // CODE_OUTPUT only — the shell wire has no replay to mute.
    let mut muted: HashSet<String> = HashSet::new();
    let mut backoff = BackOff::new();
    let mut tick = tokio::time::interval(TICK_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Due sessions waiting behind the in-flight emit, and — in `active` —
    // every session currently queued or in flight, excluded from the sweep
    // and from pruning until its outcome lands.
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut active: HashSet<String> = HashSet::new();
    let mut in_flight: Option<(String, tokio::task::JoinHandle<EmitOutcome>)> = None;

    loop {
        let inbound = tokio::select! {
            _ = cancel.cancelled() => {
                info!("session overview: cancelled");
                break;
            }
            _ = tick.tick() => None,
            done = async { (&mut in_flight.as_mut().expect("guarded by is_some").1).await },
                if in_flight.is_some() =>
            {
                let (session_id, _) = in_flight.take().expect("guarded by is_some");
                active.remove(&session_id);
                match done {
                    Ok(outcome) => apply_emit_outcome(
                        outcome,
                        &mut sessions,
                        &mut backoff,
                        &mut queue,
                        &mut active,
                        &config.pulse_tx,
                    ),
                    Err(error) => {
                        warn!(%error, session = %session_id, "session overview: emit task failed");
                    }
                }
                spawn_next(&mut queue, &mut active, &mut in_flight, &mut sessions, &backoff, &config);
                continue;
            }
            recv = code_rx.recv() => match recv {
                Ok(frame) => Some(Inbound::Code(frame)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    // The digest is about shape, not completeness — a gap in
                    // activity lines never justifies backpressuring the session.
                    warn!(skipped, "session overview: code broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("session overview: code broadcast closed");
                    break;
                }
            },
            recv = shell_rx.recv() => match recv {
                Ok(frame) => Some(Inbound::Shell(frame)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "session overview: shell broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("session overview: shell broadcast closed");
                    break;
                }
            },
            recv = submission_rx.recv() => match recv {
                Ok(frame) => Some(Inbound::Submission(frame)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "session overview: submission broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("session overview: submission broadcast closed");
                    break;
                }
            },
        };

        let now = Instant::now();
        match inbound {
            Some(Inbound::Code(frame)) => {
                let Some(session_id) = forwardable_session(&frame.payload, &mut muted) else {
                    continue;
                };
                let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                else {
                    continue;
                };
                let Some(event) = code_output_event(&payload) else {
                    continue;
                };
                let state = sessions
                    .entry(session_id)
                    .or_insert_with(|| SessionState::new(now));
                state.last_seen = now;
                state.observe(event);
                continue;
            }
            Some(Inbound::Shell(frame)) => {
                let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                else {
                    continue;
                };
                let Some(session_id) = payload
                    .get("tug_session_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                else {
                    continue;
                };
                let Some(beat) = shell_beat(&payload) else {
                    continue;
                };
                let state = sessions
                    .entry(session_id)
                    .or_insert_with(|| SessionState::new(now));
                state.last_seen = now;
                // A command starting is the human act; its settle is just the
                // machine reporting back.
                if payload.get("type").and_then(|v| v.as_str()) == Some("exchange_started") {
                    state.human_act();
                }
                state.record(beat);
                continue;
            }
            Some(Inbound::Submission(frame)) => {
                let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                else {
                    continue;
                };
                let Some((session_id, beat)) = submission_beat(&payload) else {
                    continue;
                };
                let state = sessions
                    .entry(session_id)
                    .or_insert_with(|| SessionState::new(now));
                state.last_seen = now;
                state.human_act();
                if let SessionBeat::Asked(Some(text)) = &beat {
                    state.pending_ask = Some(text.clone());
                    state.asked_since_emit = true;
                }
                state.record(beat);
                continue;
            }
            None => {}
        }

        // The tick sweep. Sessions past the retention window drop first —
        // unless queued or in flight, whose outcome still needs its state.
        sessions.retain(|id, state| {
            active.contains(id) || now.duration_since(state.last_seen) < SESSION_RETENTION
        });
        // Gates are process-wide, so one closed gate ends the whole sweep.
        let gates = Gates {
            tenant_enabled: (config.tenant_enabled)(),
            pulse_enabled: (config.pulse_enabled)(),
            backing_off: backoff.active(now),
        };
        if !gates.allow() {
            continue;
        }
        let due: Vec<String> = sessions
            .iter()
            .filter(|(id, _)| !active.contains(*id))
            .filter(|(_, state)| {
                // An armed session is due at the first tick past the forced
                // floor — a human act is the strongest possible signal the
                // standing headline is stale, so it never waits out the full
                // anti-twitch floor meant for streaming evidence. The forced
                // floor still spaces a run of `$` starts, each of which
                // re-arms the fire.
                (state.fire_asap
                    && state.new_beats > 0
                    && now.duration_since(state.last_emit) >= config.cadence.forced_floor)
                    || config
                        .cadence
                        .fires(state.new_beats, now.duration_since(state.last_emit))
            })
            .map(|(session_id, _)| session_id.clone())
            .collect();
        for session_id in due {
            active.insert(session_id.clone());
            queue.push_back(session_id);
        }
        spawn_next(
            &mut queue,
            &mut active,
            &mut in_flight,
            &mut sessions,
            &backoff,
            &config,
        );
    }
    if let Some((_, handle)) = in_flight {
        handle.abort();
    }
}

/// Start the next queued emit when none is in flight: commit the session's
/// tick, snapshot its job, and spawn it. A back-off arming mid-queue drops
/// the rest with their ticks uncommitted, so their evidence survives for the
/// first allowed sweep after it lifts.
fn spawn_next(
    queue: &mut VecDeque<String>,
    active: &mut HashSet<String>,
    in_flight: &mut Option<(String, tokio::task::JoinHandle<EmitOutcome>)>,
    sessions: &mut HashMap<String, SessionState>,
    backoff: &BackOff,
    config: &SessionOverviewConfig,
) {
    while in_flight.is_none() {
        if backoff.active(Instant::now()) {
            for id in queue.drain(..) {
                active.remove(&id);
            }
            return;
        }
        let Some(session_id) = queue.pop_front() else {
            return;
        };
        let Some(state) = sessions.get_mut(&session_id) else {
            active.remove(&session_id);
            continue;
        };
        let (activity, recent_activity, asked) = state.commit_tick(Instant::now());
        let job = EmitJob {
            jsonl: config.identity.jsonl_path(&session_id),
            cache: std::mem::take(&mut state.prompts),
            pending_ask: state.pending_ask.clone(),
            last_digest: state.last_digest.clone(),
            local_model: Arc::clone(&config.local_model),
            session_id: session_id.clone(),
            activity,
            recent_activity,
            asked,
        };
        *in_flight = Some((session_id, tokio::spawn(run_emit(job))));
    }
}

/// One due session's emit, off the loop: refresh the prompts, compose the
/// digest, dedupe, summarize, impose the register. Every early return is a
/// silent skip — the tick was committed at spawn, so a failing model can't
/// make every subsequent sweep retry.
async fn run_emit(job: EmitJob) -> EmitOutcome {
    let EmitJob {
        session_id,
        activity,
        recent_activity,
        asked,
        cache,
        pending_ask,
        last_digest,
        jsonl,
        local_model,
    } = job;
    let mut outcome = EmitOutcome {
        session_id: session_id.clone(),
        cache: PromptCache::default(),
        caught_up_ask: None,
        seen_digest: None,
        headline: None,
        failed: false,
    };
    // The prompts are the better half of the digest but not a required
    // one: `compose_digest` describes a session from its activity alone.
    // An identity that won't resolve — the supervisor's map has no claude
    // id yet, or the ledger has no project dir — costs the digest its
    // goals, not the whole tick. The refresh reads only appended bytes, off
    // the async thread; a panicked read costs the cache, never the tick.
    let mut prompts = match jsonl {
        Some(jsonl) => {
            let read = tokio::task::spawn_blocking(move || {
                let mut cache = cache;
                cache.refresh(&jsonl);
                let prompts = cache.digest_prompts();
                (cache, prompts)
            })
            .await;
            match read {
                Ok((cache, prompts)) => {
                    outcome.cache = cache;
                    prompts
                }
                Err(error) => {
                    warn!(%error, session = %session_id, "session overview: prompt read panicked");
                    Vec::new()
                }
            }
        }
        None => {
            debug!(
                session = %session_id,
                "session overview: identity unresolved; digest from activity alone",
            );
            outcome.cache = cache;
            Vec::new()
        }
    };
    // The standing ask rides last in the prompt section — the current
    // directive, which compose marks — until the JSONL catches up and the
    // cache spells it itself; from then on the cache carries it.
    if let Some(ask) = pending_ask {
        if outcome.cache.carries(&ask) {
            outcome.caught_up_ask = Some(ask);
        } else {
            prompts.push(ask);
        }
    }
    let Some(digest) = compose_digest(&prompts, &activity, recent_activity, asked) else {
        debug!(session = %session_id, "session overview: nothing to describe");
        return outcome;
    };
    if last_digest.as_deref() == Some(digest.as_str()) {
        debug!(session = %session_id, "session overview: digest unchanged");
        return outcome;
    }

    let Some(requester) = local_model.requester() else {
        debug!(session = %session_id, "session overview: no local model host");
        outcome.failed = true;
        return outcome;
    };
    // Turnaround is the standing measure of whether this feature is usable:
    // the request deadline is a transport timeout, far above the point at
    // which a headline stops being worth having.
    let started = Instant::now();
    match requester.summarize(digest.clone()).await {
        Ok(text) => {
            let report = headline_register_report(&text);
            info!(
                session = %session_id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                raw = %text,
                headline = %report.text,
                normalized = report.normalized,
                trimmed = report.trimmed,
                clipped = report.clipped,
                "session overview: summarized",
            );
            outcome.seen_digest = Some(digest);
            outcome.headline = Some(report.text);
        }
        Err(error) => {
            warn!(
                %error,
                session = %session_id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "session overview: summarize failed",
            );
            outcome.failed = true;
        }
    }
    outcome
}

/// Land an emit outcome back on the loop's state: restore the cache, settle
/// the back-off, record the digest the model saw, and publish the headline
/// when it is new.
fn apply_emit_outcome(
    outcome: EmitOutcome,
    sessions: &mut HashMap<String, SessionState>,
    backoff: &mut BackOff,
    queue: &mut VecDeque<String>,
    active: &mut HashSet<String>,
    pulse_tx: &broadcast::Sender<Frame>,
) {
    let EmitOutcome {
        session_id,
        cache,
        caught_up_ask,
        seen_digest,
        headline,
        failed,
    } = outcome;
    if failed {
        // The back-off is process-wide. The queued sessions behind this one
        // drop with their ticks uncommitted, so their evidence survives for
        // the first allowed sweep after the back-off lifts.
        backoff.fail(Instant::now());
        for id in queue.drain(..) {
            active.remove(&id);
        }
    } else if seen_digest.is_some() {
        backoff.succeed();
    }
    let Some(state) = sessions.get_mut(&session_id) else {
        return;
    };
    state.prompts = cache;
    if let Some(ask) = caught_up_ask {
        if state.pending_ask.as_ref() == Some(&ask) {
            state.pending_ask = None;
        }
    }
    if let Some(digest) = seen_digest {
        state.last_digest = Some(digest);
    }
    let Some(headline) = headline else {
        return;
    };
    if headline.is_empty() {
        debug!(session = %session_id, "session overview: headline empty after register");
        return;
    }
    if state.last_headline.as_deref() == Some(headline.as_str()) {
        debug!(session = %session_id, "session overview: headline unchanged");
        return;
    }
    state.beat += 1;
    state.last_headline = Some(headline.clone());
    let frame = overview_frame(
        &session_id,
        &headline,
        state.beat,
        crate::session_ledger::now_millis(),
    );
    let receivers = pulse_tx.send(frame).unwrap_or(0);
    info!(
        session = %session_id,
        beat = state.beat,
        receivers,
        "session overview: emitted",
    );
}

#[cfg(test)]
mod tests {

    /// The register normalizer's text alone. Every production path wants the
    /// report; these tests are about the string it produces.
    fn headline_register(raw: &str) -> String {
        headline_register_report(raw).text
    }

    use super::*;

    #[test]
    fn gate_truth_table() {
        let gates = |tenant, pulse, backing| {
            Gates {
                tenant_enabled: tenant,
                pulse_enabled: pulse,
                backing_off: backing,
            }
            .allow()
        };
        assert!(gates(true, true, false));
        assert!(!gates(false, true, false));
        assert!(!gates(true, false, false));
        assert!(!gates(true, true, true));
        assert!(!gates(false, false, true));
    }

    #[test]
    fn cadence_needs_activity() {
        assert!(!Cadence::default().fires(0, Duration::from_secs(3600)));
    }

    #[test]
    fn cadence_holds_the_floor_even_against_a_burst() {
        let c = Cadence::default();
        assert!(!c.fires(BURST_BEATS, EMIT_FLOOR - Duration::from_secs(1)));
        assert!(c.fires(BURST_BEATS, EMIT_FLOOR));
    }

    #[test]
    fn cadence_fires_on_a_burst_before_the_idle_period() {
        let c = Cadence::default();
        let between = EMIT_FLOOR + (IDLE_PERIOD - EMIT_FLOOR) / 2;
        assert!(c.fires(BURST_BEATS, between));
        assert!(!c.fires(BURST_BEATS - 1, between));
    }

    #[test]
    fn cadence_fires_on_elapsed_time_with_a_single_beat() {
        let c = Cadence::default();
        assert!(c.fires(1, IDLE_PERIOD));
        assert!(!c.fires(1, IDLE_PERIOD - Duration::from_secs(1)));
    }

    /// The numbers themselves are design values: the ladder in `local_model.rs`
    /// asserts `SUMMARIZE_TIMEOUT < EMIT_FLOOR`, and the tick has to land well
    /// inside every floor for the sweep to be the sole evaluation point.
    #[test]
    fn cadence_numbers_hold_their_ordering() {
        assert!(TICK_INTERVAL < EMIT_FLOOR);
        assert!(EMIT_FLOOR < IDLE_PERIOD);
        assert_eq!(EMIT_FLOOR, Duration::from_secs(8));
        assert_eq!(IDLE_PERIOD, Duration::from_secs(20));
        // The forced floor sits between the sweep tick and the full floor:
        // at least two sweeps apart, still faster than streaming evidence.
        assert!(TICK_INTERVAL <= FORCED_EMIT_FLOOR);
        assert!(FORCED_EMIT_FLOOR < EMIT_FLOOR);
        // Retention dwarfs every cadence number: pruning can never race a
        // session that is merely between beats.
        assert!(SESSION_RETENTION > 100 * IDLE_PERIOD);
    }

    #[test]
    fn backoff_doubles_to_a_ten_minute_ceiling() {
        let mut delay = BACKOFF_START;
        let mut seen = vec![delay];
        for _ in 0..8 {
            delay = next_backoff(delay);
            seen.push(delay);
        }
        assert_eq!(seen[0], Duration::from_secs(60));
        assert_eq!(seen[1], Duration::from_secs(120));
        assert_eq!(seen[2], Duration::from_secs(240));
        assert_eq!(seen[3], Duration::from_secs(480));
        assert_eq!(*seen.last().unwrap(), BACKOFF_MAX);
    }

    #[test]
    fn backoff_resets_on_success() {
        let now = Instant::now();
        let mut backoff = BackOff::new();
        backoff.fail(now);
        assert!(backoff.active(now));
        assert_eq!(backoff.delay, Duration::from_secs(120));
        backoff.succeed();
        assert!(!backoff.active(now));
        assert_eq!(backoff.delay, BACKOFF_START);
    }

    #[test]
    fn tool_lines_name_what_was_acted_on() {
        let bash = serde_json::json!({
            "tool_name": "Bash",
            "input": { "command": "cargo nextest run", "description": "run tests" },
        });
        assert_eq!(tool_line(&bash).unwrap(), "Bash(cargo nextest run)");

        let read = serde_json::json!({
            "tool_name": "Read",
            "input": { "file_path": "/tmp/main.rs" },
        });
        assert_eq!(tool_line(&read).unwrap(), "Read(/tmp/main.rs)");
    }

    #[test]
    fn a_tool_with_no_recognizable_target_is_still_worth_a_line() {
        let value = serde_json::json!({ "tool_name": "TodoWrite", "input": { "todos": [] } });
        assert_eq!(tool_line(&value).unwrap(), "TodoWrite");
    }

    /// The headline eval corpus (`tests/model-eval/corpus`) feeds frozen
    /// digests to the real model to score its wording. Those digests are only
    /// worth scoring if they are the bytes the emitter would actually send, so
    /// they are generated by this very function and pinned here: change
    /// `compose_digest`'s wording and this fails, naming the file to regenerate.
    ///
    /// `TUG_REGENERATE_DIGESTS=1 cargo nextest run corpus_digests` rewrites them.
    #[test]
    fn corpus_digests_are_what_compose_digest_produces() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/model-eval/corpus");
        let regenerate = std::env::var("TUG_REGENERATE_DIGESTS").is_ok();
        let mut checked = 0;
        let mut entries: Vec<_> = std::fs::read_dir(&root)
            .unwrap_or_else(|e| panic!("read {}: {e}", root.display()))
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        entries.sort();
        for input in entries {
            let raw = std::fs::read_to_string(&input).unwrap();
            let body: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let strings = |key: &str| -> Vec<String> {
                body[key]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let recent_tools = body["recent_tools"].as_u64().unwrap_or(0) as usize;
            let asked = body["asked"].as_bool().unwrap_or(false);
            let digest =
                compose_digest(&strings("prompts"), &strings("tools"), recent_tools, asked)
                    .unwrap_or_else(|| panic!("{} describes nothing", input.display()));
            let frozen = input.with_extension("digest.txt");
            if regenerate {
                std::fs::write(&frozen, &digest).unwrap();
            } else {
                let on_disk = std::fs::read_to_string(&frozen).unwrap_or_else(|_| {
                    panic!(
                        "{} is missing; regenerate with TUG_REGENERATE_DIGESTS=1",
                        frozen.display()
                    )
                });
                assert_eq!(on_disk, digest, "{} is stale", frozen.display());
            }
            checked += 1;
        }
        assert!(checked >= 12, "corpus shrank to {checked} entries");
    }

    /// The live failure this budget exists for: the model obeyed every other
    /// rule and still dragged a parts list behind the verb.
    #[test]
    fn a_parts_list_tail_is_cut_at_its_joiner() {
        assert_eq!(
            headline_register("Author command-line calculator with makefile and readme"),
            "Author command-line calculator"
        );
        assert_eq!(
            headline_register("Salvage corrupted ledger and harden open path"),
            "Salvage corrupted ledger"
        );
    }

    #[test]
    fn a_headline_inside_the_budget_is_left_alone() {
        for headline in [
            "Fix pulse overview never emitting",
            "Port shell router to async",
            "Hunt focus drift in Lens",
            // Exactly at the budget, joiner and all.
            "Wire cadence gate and emit line",
        ] {
            assert_eq!(headline_register(headline), headline);
        }
    }

    #[test]
    fn an_overlong_headline_with_no_joiner_is_truncated_to_the_budget() {
        assert_eq!(
            trim_to_word_budget("Fix sparkline idle burn regression across every open session"),
            "Fix sparkline idle burn regression across"
        );
    }

    /// Cutting at a joiner that leaves one or two words would trade a long
    /// headline for a meaningless one, so the budget yields instead.
    #[test]
    fn a_joiner_too_early_to_cut_at_falls_back_to_truncation() {
        assert_eq!(
            trim_to_word_budget("Fix and harden the resume path across every backend"),
            "Fix and harden the resume path"
        );
    }

    #[test]
    fn a_long_target_is_clipped() {
        let value = serde_json::json!({
            "tool_name": "Bash",
            "input": { "command": "x".repeat(200) },
        });
        let line = tool_line(&value).unwrap();
        assert!(line.chars().count() <= MAX_TARGET_CHARS + "Bash()…".len());
        assert!(line.ends_with("…)"));
    }

    #[test]
    fn a_payload_without_a_name_yields_nothing() {
        assert!(tool_line(&serde_json::json!({ "input": {} })).is_none());
    }

    /// The whole SHELL_OUTPUT mapping, one row per frame shape it can see.
    #[test]
    fn shell_beats_narrate_starts_and_failures_and_count_the_rest() {
        let beat = |body: serde_json::Value| shell_beat(&body);
        assert_eq!(
            beat(serde_json::json!({
                "type": "exchange_started", "exchange_id": "e1",
                "command": "cargo build", "cwd": "/proj", "started_at": 1,
            })),
            Some(SessionBeat::Shell(Some("$ cargo build".to_string())))
        );
        assert_eq!(
            beat(serde_json::json!({
                "type": "exchange_complete", "command": "cargo build", "exit_code": 0,
                "output": "…", "duration_ms": 5,
            })),
            Some(SessionBeat::Shell(None))
        );
        assert_eq!(
            beat(serde_json::json!({
                "type": "exchange_complete", "command": "cargo build", "exit_code": 101,
                "output": "…", "duration_ms": 5,
            })),
            Some(SessionBeat::Shell(Some(
                "$ cargo build → exit 101".to_string()
            )))
        );
        // A killed or spawn-failed exchange settles with a null exit code:
        // evidence of life with no number to narrate.
        assert_eq!(
            beat(serde_json::json!({
                "type": "exchange_complete", "command": "sleep 999", "exit_code": null,
            })),
            Some(SessionBeat::Shell(None))
        );
        // Other SHELL_OUTPUT types are not transcript events.
        assert_eq!(
            beat(serde_json::json!({ "type": "shell_state", "cwd": "/p" })),
            None
        );
        assert_eq!(
            beat(serde_json::json!({ "type": "path_commands", "paths": [] })),
            None
        );
        // A start with no command has nothing to say.
        assert_eq!(
            beat(serde_json::json!({ "type": "exchange_started" })),
            None
        );
    }

    #[test]
    fn a_long_shell_command_is_clipped_like_a_tool_target() {
        let beat = shell_beat(&serde_json::json!({
            "type": "exchange_started", "command": "x".repeat(200),
        }))
        .unwrap();
        let SessionBeat::Shell(Some(line)) = beat else {
            panic!("a started exchange carries a line");
        };
        assert!(line.chars().count() <= "$ ".len() + MAX_TARGET_CHARS + 1);
        assert!(line.ends_with('…'));
    }

    /// The whole CODE_INPUT mapping, one row per payload shape it can see.
    #[test]
    fn submission_beats_count_user_messages_and_nothing_else() {
        let beat = |body: serde_json::Value| submission_beat(&body);
        assert_eq!(
            beat(serde_json::json!({
                "tug_session_id": "s1", "type": "user_message",
                "content": [{ "type": "text", "text": "  fix the flaky test  " }],
            })),
            Some((
                "s1".to_string(),
                SessionBeat::Asked(Some("fix the flaky test".to_string()))
            ))
        );
        // Text blocks concatenate exactly as the prompt cache's extraction
        // does; non-text blocks contribute nothing.
        assert_eq!(
            beat(serde_json::json!({
                "tug_session_id": "s1", "type": "user_message",
                "content": [
                    { "type": "text", "text": "look at " },
                    { "type": "image", "source": { "type": "base64", "data": "…" } },
                    { "type": "text", "text": "this screenshot" },
                ],
            })),
            Some((
                "s1".to_string(),
                SessionBeat::Asked(Some("look at this screenshot".to_string()))
            ))
        );
        // An image-only submission is still a human act, with nothing quotable.
        assert_eq!(
            beat(serde_json::json!({
                "tug_session_id": "s1", "type": "user_message",
                "content": [{ "type": "image", "source": { "type": "base64", "data": "…" } }],
            })),
            Some(("s1".to_string(), SessionBeat::Asked(None)))
        );
        // Other CODE_INPUT verbs are not submissions.
        assert_eq!(
            beat(serde_json::json!({ "tug_session_id": "s1", "type": "interrupt" })),
            None
        );
        assert_eq!(
            beat(serde_json::json!({
                "tug_session_id": "s1", "type": "tool_approval",
                "request_id": "r1", "approved": true,
            })),
            None
        );
        // No session id, no route.
        assert_eq!(
            beat(serde_json::json!({
                "type": "user_message",
                "content": [{ "type": "text", "text": "hello" }],
            })),
            None
        );
        // A payload that is not an object at all maps to nothing.
        assert_eq!(beat(serde_json::json!(null)), None);
    }

    /// The ask clip is the prompt cache's clip — a plain character take with
    /// no ellipsis — so the two spell an identical submission identically.
    #[test]
    fn a_long_ask_is_clipped_to_the_prompt_cache_bound() {
        let (_, beat) = submission_beat(&serde_json::json!({
            "tug_session_id": "s1", "type": "user_message",
            "content": [{ "type": "text", "text": "x".repeat(MAX_PROMPT_CHARS + 100) }],
        }))
        .unwrap();
        let SessionBeat::Asked(Some(text)) = beat else {
            panic!("a text submission carries its ask");
        };
        assert_eq!(text, "x".repeat(MAX_PROMPT_CHARS));
    }

    /// Verbatim CODE_OUTPUT lines, copied off the wire rather than composed
    /// here. Every other fixture in this module is hand-written, and a
    /// hand-written frame agrees with whatever the reader happens to expect —
    /// which is how the emitter spent its whole life reading a field tugcode
    /// does not send, recording no tool lines, and never reaching the model.
    #[test]
    fn tool_lines_read_the_frame_tugcode_actually_sends() {
        let write = br#"{"type":"tool_use","msg_id":"m1","seq":0,"tool_name":"Write","tool_use_id":"tu-1","input":{"file_path":"/proj/a.rs","content":"x"},"ipc_version":1}"#;
        let bash = br#"{"type":"tool_use","msg_id":"m2","seq":1,"tool_name":"Bash","tool_use_id":"tu-2","input":{"command":"cargo nextest run"},"ipc_version":1}"#;
        for (line, expected) in [
            (&write[..], "Write(/proj/a.rs)"),
            (&bash[..], "Bash(cargo nextest run)"),
        ] {
            let payload: serde_json::Value = serde_json::from_slice(line).unwrap();
            assert_eq!(tool_line(&payload).as_deref(), Some(expected));
        }
    }

    #[test]
    fn a_digest_carries_both_halves() {
        let digest = compose_digest(
            &["make the watch loop resilient".to_string()],
            &[
                "Bash(cargo build)".to_string(),
                "Edit(watch.rs)".to_string(),
            ],
            0,
            false,
        )
        .expect("both halves present");
        assert!(digest.contains("make the watch loop resilient"));
        assert!(digest.contains("Bash(cargo build)"));
        assert!(digest.contains("Edit(watch.rs)"));
    }

    #[test]
    fn a_digest_with_only_tool_use_is_still_a_digest() {
        let digest = compose_digest(&[], &["Bash(cargo build)".to_string()], 0, false).unwrap();
        assert!(digest.contains("Bash(cargo build)"));
        assert!(!digest.contains("What the user asked for"));
    }

    #[test]
    fn nothing_to_describe_yields_no_digest() {
        assert!(compose_digest(&[], &[], 0, false).is_none());
    }

    /// The recency split is the whole point of carrying a count: the model is
    /// asked what the session is doing *now*, so the digest has to be able to
    /// say which lines are now.
    #[test]
    fn recent_tool_lines_get_their_own_section() {
        let tools: Vec<String> = [
            "Read(a.rs)",
            "Read(b.rs)",
            "Edit(c.rs)",
            "Bash(cargo build)",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let digest = compose_digest(&["port the router".to_string()], &tools, 2, false).unwrap();

        let (background, right_now) = digest
            .split_once("What it is doing right now:")
            .expect("the recent section is present");
        assert!(background.contains("What the session has been doing:"));
        assert!(background.contains("Read(a.rs)"));
        assert!(background.contains("Read(b.rs)"));
        assert!(!background.contains("Edit(c.rs)"));
        assert!(!background.contains("Bash(cargo build)"));
        assert!(right_now.contains("Edit(c.rs)"));
        assert!(right_now.contains("Bash(cargo build)"));
        assert!(!right_now.contains("Read(a.rs)"));
        assert!(!right_now.contains("Read(b.rs)"));
    }

    #[test]
    fn an_empty_recency_section_is_omitted_entirely() {
        let tools = vec!["Read(a.rs)".to_string(), "Edit(b.rs)".to_string()];

        // A session's first overview: everything on record arrived this tick,
        // so there is no background to speak of.
        let all_recent = compose_digest(&[], &tools, tools.len(), false).unwrap();
        assert!(!all_recent.contains("What the session has been doing:"));
        assert!(all_recent.contains("What it is doing right now:"));

        // A tick with no new tool use: nothing is happening right now.
        let none_recent = compose_digest(&[], &tools, 0, false).unwrap();
        assert!(none_recent.contains("What the session has been doing:"));
        assert!(!none_recent.contains("What it is doing right now:"));
    }

    /// The digest keeps only the newest background — a long session's ancient
    /// history is dropped at compose time, while the recent section is never
    /// clipped.
    #[test]
    fn the_background_is_clipped_to_its_newest_lines() {
        let activity: Vec<String> = (0..(MAX_BACKGROUND_LINES + 8))
            .map(|i| format!("Read(file_{i}.rs)"))
            .collect();
        let digest = compose_digest(&[], &activity, 2, false).unwrap();
        let (background, right_now) = digest
            .split_once("What it is doing right now:")
            .expect("the recent section is present");
        // The oldest background lines are gone entirely.
        for i in 0..6 {
            assert!(
                !background.contains(&format!("Read(file_{i}.rs)")),
                "line {i} should have been clipped"
            );
        }
        // The newest MAX_BACKGROUND_LINES before the split survive.
        let split = activity.len() - 2;
        for i in (split - MAX_BACKGROUND_LINES)..split {
            assert!(
                background.contains(&format!("Read(file_{i}.rs)")),
                "line {i} missing"
            );
        }
        assert_eq!(
            background.matches("- ").count(),
            MAX_BACKGROUND_LINES,
            "exactly the budget, no more"
        );
        for i in split..activity.len() {
            assert!(right_now.contains(&format!("Read(file_{i}.rs)")));
        }
    }

    #[test]
    fn a_recent_count_past_the_end_is_clamped() {
        let tools = vec!["Read(a.rs)".to_string()];
        let digest = compose_digest(&[], &tools, 99, false).unwrap();
        assert!(digest.contains("What it is doing right now:"));
        assert!(!digest.contains("What the session has been doing:"));
        assert!(digest.contains("Read(a.rs)"));
    }

    /// Only a content-bearing beat is a line in the digest, so only those move
    /// the count that decides where the recency boundary falls.
    #[test]
    fn activity_since_emit_counts_content_bearing_beats_alone() {
        let mut state = SessionState::new(Instant::now());
        state.record(SessionBeat::Turn);
        state.record(SessionBeat::Tool("Read(a.rs)".to_string()));
        state.record(SessionBeat::Shell(None));
        state.record(SessionBeat::Said("said: porting the router".to_string()));
        assert_eq!(state.activity_since_emit, 2);
        assert_eq!(state.new_beats, 4);
    }

    /// The digest is a compressed transcript: prose, tool, and shell lines in
    /// one stream, in the order they happened.
    #[test]
    fn record_interleaves_the_transcript_vocabulary_in_arrival_order() {
        let mut state = SessionState::new(Instant::now());
        state.record(SessionBeat::Said("said: porting the router".to_string()));
        state.record(SessionBeat::Tool("Edit(router.rs)".to_string()));
        state.record(SessionBeat::Shell(Some("$ cargo build".to_string())));
        state.record(SessionBeat::Shell(None));
        state.record(SessionBeat::Turn);
        let lines: Vec<String> = state.activity.iter().cloned().collect();
        assert_eq!(
            lines,
            [
                "said: porting the router",
                "Edit(router.rs)",
                "$ cargo build"
            ]
            .map(String::from)
        );
        assert_eq!(state.new_beats, 5);
    }

    /// A turn ending advances the cadence without saying anything.
    #[test]
    fn a_turn_beat_advances_counters_without_a_line() {
        let mut state = SessionState::new(Instant::now());
        state.record(SessionBeat::Turn);
        assert!(state.activity.is_empty());
        assert_eq!(state.activity_since_emit, 0);
        assert_eq!(state.new_beats, 1);
    }

    fn prose(msg_id: &str, block_index: u64, is_partial: bool, text: &str) -> CodeOutputEvent {
        CodeOutputEvent::Prose {
            msg_id: msg_id.to_string(),
            block_index,
            is_partial,
            text: text.to_string(),
        }
    }

    fn turn() -> CodeOutputEvent {
        CodeOutputEvent::Beat(SessionBeat::Turn)
    }

    /// One block, many deltas, one line: the beat fires the moment the head
    /// crosses the sentence boundary, and the rest of the block is silence.
    #[test]
    fn a_streaming_block_beats_exactly_once_at_the_sentence_boundary() {
        let mut state = SessionState::new(Instant::now());
        state.observe(prose("m1", 0, true, "I will widen the "));
        assert!(state.activity.is_empty());
        state.observe(prose("m1", 0, true, "beat enum first. Then the"));
        assert_eq!(state.activity.len(), 1);
        assert_eq!(
            state.activity.front().unwrap(),
            "said: I will widen the beat enum first."
        );
        state.observe(prose("m1", 0, true, " cadence, then the digest."));
        state.observe(prose("m1", 0, true, " And more after that."));
        assert_eq!(state.activity.len(), 1);
    }

    /// A block that never crosses the threshold still gets its line — from the
    /// next block's arrival, or from either kind of turn end.
    #[test]
    fn a_short_block_beats_at_finalization() {
        // Finalized by a delta for a new key.
        let mut state = SessionState::new(Instant::now());
        state.observe(prose("m1", 0, true, "Short answer"));
        assert!(state.activity.is_empty());
        state.observe(prose("m1", 1, true, "Next block starts"));
        assert_eq!(state.activity.len(), 1);
        assert_eq!(state.activity.front().unwrap(), "said: Short answer");

        // Finalized by turn_complete / turn_cancelled — same event shape.
        for _ in 0..2 {
            let mut state = SessionState::new(Instant::now());
            state.observe(prose("m1", 0, true, "Short answer"));
            state.observe(turn());
            assert_eq!(state.activity.len(), 1);
            assert_eq!(state.activity.front().unwrap(), "said: Short answer");
            assert!(state.open.is_none());
            assert!(state.beaten.is_empty());
        }
    }

    /// The wire maps both turn frames to the same beat, so a cancelled turn's
    /// trailing prose is narrated exactly like a completed one's.
    #[test]
    fn turn_cancelled_maps_to_a_turn_beat() {
        for frame_type in ["turn_complete", "turn_cancelled"] {
            let payload = serde_json::json!({ "type": frame_type });
            assert_eq!(
                code_output_event(&payload),
                Some(CodeOutputEvent::Beat(SessionBeat::Turn)),
                "frame: {frame_type}"
            );
        }
    }

    /// A shell command settling mid-stream must not finalize an open assistant
    /// block or clear the dedup set — those side effects belong to CODE_OUTPUT
    /// turn frames alone.
    #[test]
    fn a_shell_beat_mid_stream_leaves_the_prose_state_alone() {
        let mut state = SessionState::new(Instant::now());
        state.observe(prose(
            "m1",
            0,
            true,
            "This sentence has already beaten, yes. And",
        ));
        assert_eq!(state.activity.len(), 1);
        state.observe(prose("m1", 1, true, "still streaming"));
        assert_eq!(state.beaten.len(), 1);
        state.record(SessionBeat::Shell(None));
        assert!(state.open.is_some());
        assert_eq!(state.beaten.len(), 1);
        assert_eq!(state.activity.len(), 1);
    }

    /// The reconnect snapshot re-sends whole blocks as `is_partial: false`;
    /// ones the live stream already narrated stay silent, unseen ones beat.
    #[test]
    fn a_terminal_frame_dedupes_against_beaten_keys() {
        let mut state = SessionState::new(Instant::now());
        state.observe(prose(
            "m1",
            0,
            true,
            "Wiring the shell subscription now. More",
        ));
        assert_eq!(state.activity.len(), 1);

        state.observe(prose(
            "m1",
            0,
            false,
            "Wiring the shell subscription now. More prose after it.",
        ));
        assert_eq!(state.activity.len(), 1, "a beaten key must not beat twice");

        state.observe(prose("m2", 0, false, "A block the live stream never sent."));
        assert_eq!(state.activity.len(), 2);
        assert_eq!(
            state.activity.back().unwrap(),
            "said: A block the live stream never sent."
        );
        state.observe(prose("m2", 0, false, "A block the live stream never sent."));
        assert_eq!(
            state.activity.len(),
            2,
            "terminal replays drop on the beaten key"
        );
    }

    /// The buffer stops at cap + slack however much the block streams.
    #[test]
    fn prose_accumulation_is_bounded() {
        let mut state = SessionState::new(Instant::now());
        // No whitespace and no terminator: nothing to beat on, only to buffer.
        for _ in 0..100 {
            state.observe(prose("m1", 0, true, &"x".repeat(100)));
        }
        // The head beat at the cap; the open block keeps only the key marker.
        assert_eq!(state.activity.len(), 1);
        let line = state.activity.front().unwrap();
        assert!(line.chars().count() <= "said: ".len() + MAX_SAID_CHARS + 1);
        assert!(state.open.as_ref().unwrap().text.is_empty());
    }

    #[test]
    fn said_head_waits_for_a_real_sentence() {
        // Under budget mid-stream: keep accumulating.
        assert_eq!(said_head("Working on the", false), None);
        // A terminator before MIN_SENTENCE_CHARS is bait, not a boundary.
        assert_eq!(
            said_head("e.g. the cadence gate keeps this run", false),
            None
        );
        // A sentence with following text beats mid-stream.
        assert_eq!(
            said_head("The cadence gate holds. Next up", false),
            Some("said: The cadence gate holds.".to_string())
        );
        // A trailing terminator only counts once the block is final — the next
        // delta could continue "3." into "3.5".
        assert_eq!(said_head("The cadence gate holds.", false), None);
        assert_eq!(
            said_head("The cadence gate holds.", true),
            Some("said: The cadence gate holds.".to_string())
        );
        // Finalized short text is a head even with no terminator at all.
        assert_eq!(
            said_head("wiring the gate", true),
            Some("said: wiring the gate".to_string())
        );
        assert_eq!(said_head("   ", true), None);
        // Whitespace collapses into single spaces.
        assert_eq!(
            said_head("wiring\n  the\tgate", true),
            Some("said: wiring the gate".to_string())
        );
    }

    #[test]
    fn said_head_caps_a_sentenceless_block() {
        let long = "word ".repeat(60);
        let head = said_head(&long, false).expect("past the cap");
        assert!(head.starts_with("said: word word"));
        assert!(head.chars().count() <= "said: ".len() + MAX_SAID_CHARS + 1);
        assert!(head.ends_with('…'));
    }

    #[test]
    fn assistant_text_frames_parse_into_prose_events() {
        let payload = serde_json::json!({
            "type": "assistant_text",
            "msg_id": "m7",
            "block_index": 2,
            "seq": 40,
            "rev": 1,
            "text": "Now the digest",
            "is_partial": true,
            "status": "streaming",
            "ipc_version": 1,
        });
        assert_eq!(
            code_output_event(&payload),
            Some(prose("m7", 2, true, "Now the digest"))
        );
    }

    #[test]
    fn clip_only_marks_text_it_actually_shortened() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("exactly-10", 10), "exactly-10");
        assert_eq!(clip("more than ten", 10), "more than …");
    }

    #[test]
    fn clip_respects_character_boundaries() {
        // Four multi-byte characters: a naive byte slice here would panic.
        assert_eq!(clip("日本語です", 3), "日本語…");
    }

    /// Every shape the normalizer is expected to fix, paired with what it owes.
    /// Reused by the idempotence test so a rule that is not stable under a
    /// second pass cannot pass the first.
    const REGISTER_CORPUS: &[(&str, &str)] = &[
        ("\"Wiring the watch loop\"", "Wiring the watch loop"),
        ("'Wiring the watch loop'", "Wiring the watch loop"),
        (
            "\u{201c}Wiring the watch loop\u{201d}",
            "Wiring the watch loop",
        ),
        ("Working on the pulse strip", "pulse strip"),
        ("Trying to fix download resume", "fix download resume"),
        ("Currently hunting focus drift", "hunting focus drift"),
        ("The user is working on the pulse strip", "pulse strip"),
        (
            "This session is wiring cadence gates",
            "wiring cadence gates",
        ),
        (
            "It looks like a refactor of the ledger",
            "refactor of the ledger",
        ),
        ("The pulse strip", "pulse strip"),
        ("A cadence gate", "cadence gate"),
        ("An overview emitter", "overview emitter"),
        ("Fixing   spaced\tout  text", "Fixing spaced out text"),
        // Articles come off the front only — one inside the headline is part
        // of what the headline says.
        ("Wiring the cadence gate.", "Wiring the cadence gate"),
        ("What broke the resume?", "What broke the resume?"),
        ("Ship it!", "Ship it!"),
        ("Wiring the gate...", "Wiring the gate..."),
        ("   ", ""),
        ("", ""),
    ];

    #[test]
    fn the_normalizer_imposes_headline_register() {
        for (raw, want) in REGISTER_CORPUS {
            assert_eq!(&headline_register(raw), want, "input: {raw:?}");
        }
    }

    #[test]
    fn the_normalizer_is_idempotent() {
        for (raw, _) in REGISTER_CORPUS {
            let once = headline_register(raw);
            assert_eq!(headline_register(&once), once, "input: {raw:?}");
        }
    }

    #[test]
    fn the_normalizer_clips_to_the_headline_budget() {
        let long = "x".repeat(MAX_HEADLINE_CHARS + 20);
        let out = headline_register(&long);
        assert_eq!(out.chars().count(), MAX_HEADLINE_CHARS + 1);
        assert!(out.ends_with('…'));
        // The clip marker is not a trailing period, so a second pass leaves it.
        assert_eq!(headline_register(&out), out);
    }

    #[test]
    fn the_normalizer_clips_on_character_boundaries() {
        let long = "日".repeat(MAX_HEADLINE_CHARS + 5);
        let out = headline_register(&long);
        assert_eq!(out.chars().count(), MAX_HEADLINE_CHARS + 1);
    }

    #[test]
    fn the_normalizer_strips_a_prefix_before_it_counts_the_budget() {
        // The filler opener comes off first, so the headline underneath fits
        // where the raw string would have been clipped.
        let raw = format!("The user is working on {}", "y".repeat(MAX_HEADLINE_CHARS));
        let out = headline_register(&raw);
        assert_eq!(out, "y".repeat(MAX_HEADLINE_CHARS));
        assert!(!out.ends_with('…'));
    }

    /// The normalizer's work rate is only readable if a headline it left alone
    /// says so.
    #[test]
    fn a_headline_already_in_register_reports_no_work() {
        let report = headline_register_report("Wire overview cadence gate");
        assert_eq!(report.text, "Wire overview cadence gate");
        assert!(!report.normalized);
        assert!(!report.trimmed);
        assert!(!report.clipped);
    }

    /// The live failure the word budget was built for: a parts list dragged
    /// behind an otherwise correct headline.
    #[test]
    fn a_parts_list_tail_reports_a_trim_and_no_clip() {
        let report =
            headline_register_report("Author command-line calculator with makefile and readme");
        assert_eq!(report.text, "Author command-line calculator");
        assert!(report.normalized);
        assert!(report.trimmed);
        assert!(!report.clipped);
    }

    /// The two budgets fire independently: six short words pass the word budget
    /// and still overrun the character budget.
    #[test]
    fn a_long_but_short_worded_headline_reports_a_clip_and_no_trim() {
        let raw = "Fix aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee";
        let report = headline_register_report(raw);
        assert_eq!(raw.split_whitespace().count(), MAX_HEADLINE_WORDS);
        assert!(report.clipped);
        assert!(!report.trimmed);
        assert!(report.normalized);
    }

    /// Article stripping alone is work worth reporting, with neither budget
    /// involved.
    #[test]
    fn article_stripping_alone_reports_normalized() {
        let report = headline_register_report("The download resume path");
        assert_eq!(report.text, "download resume path");
        assert!(report.normalized);
        assert!(!report.trimmed);
        assert!(!report.clipped);
    }

    #[test]
    fn the_accumulator_keeps_only_the_recent_tail() {
        let mut state = SessionState::new(Instant::now());
        for i in 0..(MAX_ACTIVITY_LINES + 5) {
            state.record(SessionBeat::Tool(format!("Bash(round {i})")));
        }
        assert_eq!(state.activity.len(), MAX_ACTIVITY_LINES);
        assert_eq!(state.activity.front().unwrap(), "Bash(round 5)");
        assert_eq!(state.new_beats as usize, MAX_ACTIVITY_LINES + 5);
    }

    #[test]
    fn the_frame_is_a_scoped_overview_pulse_line() {
        let frame = overview_frame("sess-1", "Wiring the watch loop.", 3, 1_700_000_000_000);
        assert_eq!(frame.feed_id, FeedId::PULSE);
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["type"], "pulse");
        assert_eq!(body["kind"], "overview");
        assert_eq!(body["text"], "Wiring the watch loop.");
        assert_eq!(body["scopes"], serde_json::json!(["sess-1"]));
        assert_eq!(body["beat"], 3);
        assert_eq!(body["at"], 1_700_000_000_000i64);
    }

    #[test]
    fn replay_bracketed_frames_are_muted_like_the_pulse_bridge() {
        let mut muted = HashSet::new();
        let tool_use = br#"{"tug_session_id":"s1","type":"tool_use","tool_name":"Bash"}"#;
        assert_eq!(
            forwardable_session(tool_use, &mut muted),
            Some("s1".to_string())
        );
        forwardable_session(
            br#"{"tug_session_id":"s1","type":"replay_started"}"#,
            &mut muted,
        );
        assert_eq!(forwardable_session(tool_use, &mut muted), None);
        forwardable_session(
            br#"{"tug_session_id":"s1","type":"replay_complete"}"#,
            &mut muted,
        );
        assert_eq!(
            forwardable_session(tool_use, &mut muted),
            Some("s1".to_string())
        );
    }

    #[test]
    fn an_unresolvable_identity_yields_no_path() {
        let none: SessionResolver = Arc::new(|_| None);
        let identity = SessionIdentity {
            resolver: none,
            project_dir: Arc::new(|_| Some("/tmp/project".to_string())),
            claude_projects_root: PathBuf::from("/tmp/projects"),
        };
        assert!(identity.jsonl_path("s1").is_none());

        let identity = SessionIdentity {
            resolver: Arc::new(|_| Some("claude-1".to_string())),
            project_dir: Arc::new(|_| None),
            claude_projects_root: PathBuf::from("/tmp/projects"),
        };
        assert!(identity.jsonl_path("s1").is_none());
    }

    #[test]
    fn a_resolvable_identity_names_the_session_jsonl() {
        let identity = SessionIdentity {
            resolver: Arc::new(|_| Some("claude-1".to_string())),
            project_dir: Arc::new(|_| Some("/tmp/project".to_string())),
            claude_projects_root: PathBuf::from("/tmp/projects"),
        };
        let path = identity.jsonl_path("s1").unwrap();
        assert!(path.ends_with("claude-1.jsonl"));
        assert!(path.starts_with("/tmp/projects"));
    }

    // -----------------------------------------------------------------------
    // The prompt cache
    // -----------------------------------------------------------------------

    fn user_line(prompt: &str) -> String {
        serde_json::json!({
            "type": "user",
            "timestamp": "2026-07-29T00:00:00.000Z",
            "message": { "role": "user", "content": prompt },
        })
        .to_string()
    }

    fn cache_tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tugcast-prompt-cache-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn the_prompt_cache_reads_only_appended_bytes() {
        let path = cache_tmp("append");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                user_line("build the emitter"),
                r#"{"type":"assistant","message":{}}"#
            ),
        )
        .unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);
        let first_len = std::fs::metadata(&path).unwrap().len();
        assert_eq!(cache.offset, first_len);
        assert_eq!(cache.first.as_deref(), Some("build the emitter"));

        let appended = format!(
            "{}\n{}\n",
            user_line("now the cache"),
            user_line("and the digest")
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(appended.as_bytes())
            .unwrap();
        cache.refresh(&path);
        assert_eq!(
            cache.offset - first_len,
            appended.len() as u64,
            "the second read consumed exactly the appended bytes"
        );
        assert_eq!(cache.first.as_deref(), Some("build the emitter"));
        let recent: Vec<String> = cache.recent.iter().cloned().collect();
        assert_eq!(
            recent,
            ["now the cache", "and the digest"].map(String::from)
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_partial_trailing_line_waits_for_its_newline() {
        let path = cache_tmp("partial");
        let complete = format!("{}\n", user_line("the whole first line"));
        let partial = user_line("a line still being written");
        let (head, tail) = partial.split_at(30);
        std::fs::write(&path, format!("{complete}{head}")).unwrap();

        let mut cache = PromptCache::default();
        cache.refresh(&path);
        assert_eq!(
            cache.offset as usize,
            complete.len(),
            "stopped at the last newline"
        );
        assert_eq!(cache.recent.len(), 1);

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(format!("{tail}\n").as_bytes())
            .unwrap();
        cache.refresh(&path);
        assert_eq!(cache.offset, std::fs::metadata(&path).unwrap().len());
        assert_eq!(
            cache.recent.back().map(String::as_str),
            Some("a line still being written")
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_shrunk_file_resets_and_repins() {
        let path = cache_tmp("shrunk");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                user_line("the original goal"),
                user_line("its follow-up")
            ),
        )
        .unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);
        assert_eq!(cache.first.as_deref(), Some("the original goal"));

        std::fs::write(&path, format!("{}\n", user_line("rewritten"))).unwrap();
        cache.refresh(&path);
        assert_eq!(cache.first.as_deref(), Some("rewritten"));
        assert_eq!(cache.offset, std::fs::metadata(&path).unwrap().len());
        assert_eq!(cache.recent.len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_missing_file_leaves_the_cache_untouched() {
        let mut cache = PromptCache {
            offset: 42,
            first: Some("pinned".to_string()),
            recent: VecDeque::from(["recent".to_string()]),
        };
        cache.refresh(std::path::Path::new("/nonexistent/tugcast/prompts.jsonl"));
        assert_eq!(cache.offset, 42);
        assert_eq!(cache.first.as_deref(), Some("pinned"));
        assert_eq!(cache.recent.len(), 1);
    }

    #[test]
    fn digest_prompts_lead_with_the_pinned_first() {
        // A young session: the first prompt is still among the recent ones,
        // and the goal is not stated twice.
        let cache = PromptCache {
            offset: 0,
            first: Some("the goal".to_string()),
            recent: VecDeque::from(["the goal".to_string()]),
        };
        assert_eq!(cache.digest_prompts(), ["the goal"].map(String::from));

        // An older session: first + the recents, oldest of the middle gone.
        let cache = PromptCache {
            offset: 0,
            first: Some("the goal".to_string()),
            recent: VecDeque::from([
                "a course correction".to_string(),
                "and a refinement".to_string(),
            ]),
        };
        assert_eq!(
            cache.digest_prompts(),
            ["the goal", "a course correction", "and a refinement"].map(String::from)
        );
    }

    // -----------------------------------------------------------------------
    // The loop, end to end
    // -----------------------------------------------------------------------

    use crate::local_model::{LocalModelRequester, LocalModelState};
    use std::io::Write;

    /// Stand up a local-model host that answers every summarize with `answer`
    /// (or refuses when it is `None`), wired through the real requester and the
    /// real reply-routing path.
    /// A model host that answers every request with `answer` (`None` = a
    /// refusal) and forwards each request's digest, so a test can assert on
    /// what the model was actually shown.
    fn fake_host(
        state: &SharedLocalModelState,
        answer: Option<&'static str>,
    ) -> tokio::sync::mpsc::Receiver<String> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
        let (seen_tx, seen_rx) = tokio::sync::mpsc::channel::<String>(8);
        let requester = LocalModelRequester::new(tx);
        state.set_requester(Arc::clone(&requester));
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                let body: serde_json::Value = serde_json::from_str(&line).unwrap();
                let id = body["id"].as_str().unwrap().to_string();
                let reply = match answer {
                    Some(text) => crate::local_model::LocalModelReply {
                        ok: true,
                        text: Some(text.to_string()),
                        error: None,
                    },
                    None => crate::local_model::LocalModelReply {
                        ok: false,
                        text: None,
                        error: Some("guardrail refusal".to_string()),
                    },
                };
                requester.resolve(&id, reply);
                let digest = body["prompt"].as_str().unwrap_or_default().to_string();
                let _ = seen_tx.send(digest).await;
            }
        });
        seen_rx
    }

    /// A claude JSONL holding one user prompt, at the path the identity below
    /// resolves to.
    ///
    /// Seeded through the same `claude_project_dir` chokepoint the emitter
    /// uses, so the fixture and production agree on the spelling ([L29]) — a
    /// fixture that encoded the raw string would keep passing while the
    /// emitter looked somewhere else.
    fn seed_jsonl(root: &std::path::Path, project_dir: &str, claude_id: &str, prompt: &str) {
        let (dir, _canonical) = crate::session_ledger::claude_project_dir(root, project_dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut file = std::fs::File::create(dir.join(format!("{claude_id}.jsonl"))).unwrap();
        let line = serde_json::json!({
            "type": "user",
            "timestamp": "2026-07-27T00:00:00.000Z",
            "message": { "role": "user", "content": prompt },
        });
        writeln!(file, "{line}").unwrap();
    }

    fn tool_use_frame(session: &str, command: &str) -> Frame {
        let body = serde_json::json!({
            "tug_session_id": session,
            "type": "tool_use",
            "tool_name": "Bash",
            "input": { "command": command },
        });
        Frame::new(FeedId::CODE_OUTPUT, serde_json::to_vec(&body).unwrap())
    }

    fn turn_complete_frame(session: &str) -> Frame {
        let body = serde_json::json!({
            "tug_session_id": session,
            "type": "turn_complete",
        });
        Frame::new(FeedId::CODE_OUTPUT, serde_json::to_vec(&body).unwrap())
    }

    struct Harness {
        code_tx: broadcast::Sender<Frame>,
        shell_tx: broadcast::Sender<Frame>,
        submission_tx: broadcast::Sender<Frame>,
        pulse_rx: broadcast::Receiver<Frame>,
        /// Each summarize request's digest, in order — what the model saw.
        /// `None` when the harness started without a model host.
        digests: Option<tokio::sync::mpsc::Receiver<String>>,
        /// The shared model-host slot, so a test can install a host after
        /// exercising the no-host path.
        model: SharedLocalModelState,
        cancel: CancellationToken,
        _tmp: PathBuf,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.cancel.cancel();
            let _ = std::fs::remove_dir_all(&self._tmp);
        }
    }

    /// `start` with the loop-test cadence: zero floor and a one-beat burst,
    /// so any beat is due at the next tick. The cadence itself is covered by
    /// the pure tests above; that harness shape is about the loop.
    fn start(
        answer: Option<&'static str>,
        tenant_on: bool,
        pulse_on: bool,
        with_model: bool,
    ) -> Harness {
        start_cadenced(
            answer,
            tenant_on,
            pulse_on,
            with_model,
            Cadence {
                burst_beats: 1,
                idle_period: Duration::ZERO,
                floor: Duration::ZERO,
                forced_floor: Duration::ZERO,
            },
        )
    }

    fn start_cadenced(
        answer: Option<&'static str>,
        tenant_on: bool,
        pulse_on: bool,
        with_model: bool,
        cadence: Cadence,
    ) -> Harness {
        let tmp = std::env::temp_dir().join(format!(
            "tugcast-overview-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let projects = tmp.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        seed_jsonl(
            &projects,
            "/tmp/project",
            "claude-1",
            "make the watch loop resilient",
        );

        let (code_tx, _) = broadcast::channel(64);
        let (shell_tx, _) = broadcast::channel(64);
        let (submission_tx, _) = broadcast::channel(64);
        let (pulse_tx, pulse_rx) = broadcast::channel(64);
        let state = LocalModelState::new(tmp.join("models"), "http://127.0.0.1:1".to_string());
        let digests = with_model.then(|| fake_host(&state, answer));
        let cancel = CancellationToken::new();
        let config = SessionOverviewConfig {
            code_tx: code_tx.clone(),
            shell_tx: shell_tx.clone(),
            submission_tx: submission_tx.clone(),
            pulse_tx,
            tenant_enabled: Arc::new(move || tenant_on),
            pulse_enabled: Arc::new(move || pulse_on),
            local_model: state.clone(),
            identity: SessionIdentity {
                resolver: Arc::new(|_| Some("claude-1".to_string())),
                project_dir: Arc::new(|_| Some("/tmp/project".to_string())),
                claude_projects_root: projects,
            },
            cadence,
        };
        let task_cancel = cancel.clone();
        tokio::spawn(async move { session_overview_task(config, task_cancel).await });
        Harness {
            code_tx,
            shell_tx,
            submission_tx,
            pulse_rx,
            digests,
            model: state,
            cancel,
            _tmp: tmp,
        }
    }

    /// Await one PULSE frame, or `None` if none arrives promptly. The window
    /// is virtual: every loop test runs on the paused clock, so it covers
    /// several sweep ticks and costs no real time.
    async fn next_overview(rx: &mut broadcast::Receiver<Frame>) -> Option<serde_json::Value> {
        match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await {
            Ok(Ok(frame)) => serde_json::from_slice(&frame.payload).ok(),
            _ => None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_tool_use_frame_becomes_an_overview_line() {
        let mut h = start(Some("Hardening the watch loop."), true, true, true);
        // The subscription is created inside the task; give it a beat to exist
        // before the first send, or the frame is broadcast into an empty room.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();

        let body = next_overview(&mut h.pulse_rx).await.expect("an overview");
        assert_eq!(body["type"], "pulse");
        assert_eq!(body["kind"], "overview");
        // The model answered with a sentence; what reaches the wire is a
        // headline. The emit path runs every answer through the normalizer, so
        // the trailing period never leaves this task.
        assert_eq!(body["text"], "Hardening the watch loop");
        assert_eq!(body["scopes"], serde_json::json!(["s1"]));
        assert_eq!(body["beat"], 1);
    }

    #[test]
    fn an_aliased_project_path_still_finds_the_session_jsonl() {
        // `/tmp` is a symlink to `/private/tmp`, which makes it the same
        // two-spellings-one-directory case as `/u/src/tugtool` versus
        // `/Users/…/Mounts/u/src/tugtool`. The project directory must exist
        // before either side resolves it — the resolver falls back to its
        // input for a path that isn't on disk, which would make both spellings
        // agree for the wrong reason and leave this test proving nothing.
        let name = format!("tugcast-l29-project-{}", std::process::id());
        let project_dir = format!("/tmp/{name}");
        std::fs::create_dir_all(&project_dir).unwrap();

        let root = std::env::temp_dir().join(format!("tugcast-l29-root-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        seed_jsonl(&root, &project_dir, "claude-1", "goal text");

        let project_for_closure = project_dir.clone();
        let identity = SessionIdentity {
            resolver: Arc::new(|_| Some("claude-1".to_string())),
            project_dir: Arc::new(move |_| Some(project_for_closure.clone())),
            claude_projects_root: root.clone(),
        };
        let path = identity.jsonl_path("s1").expect("a resolvable identity");
        assert!(
            path.exists(),
            "jsonl_path resolved to {path:?}, which does not exist — the raw \
             encoder is back and the digest has silently lost its prompts",
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&project_dir);
    }

    #[tokio::test(start_paused = true)]
    async fn the_tenant_switch_silences_it() {
        let mut h = start(Some("Hardening the watch loop."), false, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn pulse_being_off_silences_it() {
        let mut h = start(Some("Hardening the watch loop."), true, false, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn no_model_host_is_silence_not_an_error() {
        let mut h = start(None, true, true, false);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_refusal_emits_nothing_and_backs_off() {
        let mut h = start(None, true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
        // Back-off is now armed for a minute, so a second frame is silent too
        // rather than hammering a model that just said no.
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn an_unchanged_headline_is_not_republished() {
        let mut h = start(Some("Hardening the watch loop."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_some());
        // A different digest (new tool line) but the same sentence back from
        // the model: the strip already says it, so nothing is sent.
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn replayed_frames_never_produce_an_overview() {
        let mut h = start(Some("Hardening the watch loop."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let replay_started = serde_json::json!({
            "tug_session_id": "s1", "type": "replay_started",
        });
        h.code_tx
            .send(Frame::new(
                FeedId::CODE_OUTPUT,
                serde_json::to_vec(&replay_started).unwrap(),
            ))
            .unwrap();
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }

    /// A session that only ever answers questions — no tool calls anywhere in
    /// it — still earns an overview. Its digest is the user's prompts alone,
    /// which `compose_digest` has always supported; what was missing is that
    /// nothing but a `tool_use` frame could advance the cadence, so a purely
    /// conversational session sat at zero frames forever and never got there.
    #[tokio::test(start_paused = true)]
    async fn a_session_with_no_tool_use_still_gets_an_overview() {
        let mut h = start(Some("Explaining Maxwell's equations."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(turn_complete_frame("s1")).unwrap();
        let overview = next_overview(&mut h.pulse_rx).await.expect("an overview");
        assert_eq!(overview["kind"], "overview");
        assert_eq!(overview["text"], "Explaining Maxwell's equations");
        assert_eq!(overview["scopes"], serde_json::json!(["s1"]));
    }

    /// A session doing only `$` work — nothing on CODE_OUTPUT at all — reaches
    /// the cadence and earns an overview. This is the wire the overview never
    /// listened to: a typed command used to contribute neither a digest line
    /// nor a cadence advance.
    #[tokio::test(start_paused = true)]
    async fn a_shell_only_session_still_gets_an_overview() {
        let mut h = start(Some("Building the workspace."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = serde_json::json!({
            "tug_session_id": "s1", "type": "exchange_started", "exchange_id": "e1",
            "command": "cargo build", "cwd": "/proj", "started_at": 1,
        });
        h.shell_tx
            .send(Frame::new(
                FeedId::SHELL_OUTPUT,
                serde_json::to_vec(&started).unwrap(),
            ))
            .unwrap();
        let overview = next_overview(&mut h.pulse_rx).await.expect("an overview");
        assert_eq!(overview["kind"], "overview");
        assert_eq!(overview["text"], "Building the workspace");
        assert_eq!(overview["scopes"], serde_json::json!(["s1"]));
    }

    fn user_message_frame(session: &str, text: &str) -> Frame {
        let body = serde_json::json!({
            "tug_session_id": session,
            "type": "user_message",
            "content": [{ "type": "text", "text": text }],
        });
        Frame::new(FeedId::CODE_INPUT, serde_json::to_vec(&body).unwrap())
    }

    /// A session the overview has only ever seen submit — nothing on
    /// CODE_OUTPUT or SHELL_OUTPUT — accumulates beats and emits once the
    /// cadence is met: the third wire is live end to end.
    #[tokio::test(start_paused = true)]
    async fn a_submission_only_session_still_gets_an_overview() {
        let mut h = start(Some("Weighing the ask."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.submission_tx
            .send(user_message_frame("s1", "how does the prompt cache work?"))
            .unwrap();
        let overview = next_overview(&mut h.pulse_rx).await.expect("an overview");
        assert_eq!(overview["kind"], "overview");
        assert_eq!(overview["text"], "Weighing the ask");
        assert_eq!(overview["scopes"], serde_json::json!(["s1"]));
    }

    /// The relay is a tee, not a transform: everything sent into the relayed
    /// sink reaches the supervisor-side receiver unchanged and in order, with
    /// the submission broadcast fed first — and a vanished subscriber costs
    /// the broadcast copy, never the forward.
    #[tokio::test]
    async fn the_relay_forwards_frames_unchanged_and_in_order() {
        let (relay_tx, relay_rx) = mpsc::channel(8);
        let (submission_tx, mut submission_rx) = broadcast::channel(8);
        let (forward_tx, mut forward_rx) = mpsc::channel(8);
        tokio::spawn(relay_code_input(relay_rx, submission_tx, forward_tx));

        let frames: Vec<Frame> = ["first ask", "second ask", "third ask"]
            .iter()
            .enumerate()
            .map(|(i, text)| user_message_frame(&format!("s{i}"), text))
            .collect();
        for frame in &frames {
            relay_tx.send(frame.clone()).await.unwrap();
        }
        for frame in &frames {
            assert_eq!(&forward_rx.recv().await.unwrap(), frame);
            assert_eq!(&submission_rx.recv().await.unwrap(), frame);
        }

        drop(submission_rx);
        let extra = user_message_frame("s9", "no one is listening");
        relay_tx.send(extra.clone()).await.unwrap();
        assert_eq!(forward_rx.recv().await.unwrap(), extra);
    }

    /// A cadence strict enough that nothing fires inside a test's window
    /// without a human act: an eight-beat burst, an eight-second floor, and a
    /// five-minute idle period.
    fn strict_cadence() -> Cadence {
        Cadence {
            burst_beats: 8,
            idle_period: Duration::from_secs(300),
            floor: Duration::from_secs(8),
            forced_floor: FORCED_EMIT_FLOOR,
        }
    }

    async fn next_digest(rx: &mut tokio::sync::mpsc::Receiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("a summarize request")
            .expect("the host is alive")
    }

    /// The proper-coast defect, pinned: a submission landing mid-quiet-stretch
    /// — full floor unexpired, burst nowhere near — emits at the first tick
    /// past the forced floor instead of waiting out the cadence.
    #[tokio::test(start_paused = true)]
    async fn a_mid_stretch_submission_re_aims_within_the_forced_floor() {
        let mut h = start_cadenced(
            Some("Answering the new ask."),
            true,
            true,
            true,
            strict_cadence(),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        // Three seconds in: inside the floor, one beat deep. The cadence
        // alone would sit silent for minutes.
        tokio::time::sleep(Duration::from_secs(3)).await;
        h.submission_tx
            .send(user_message_frame("s1", "look at the parser instead"))
            .unwrap();
        let overview = next_overview(&mut h.pulse_rx)
            .await
            .expect("a re-aimed overview");
        assert_eq!(overview["scopes"], serde_json::json!(["s1"]));
    }

    /// The recency boundary is turn-relative: a new ask empties "right now",
    /// demotes the old turn's lines to background, and rides last in the
    /// prompt section as the current directive.
    #[tokio::test(start_paused = true)]
    async fn a_new_ask_resets_right_now_and_rides_last_in_the_digest() {
        let mut h = start(Some("Refocusing on the parser."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let mut digests = h.digests.take().unwrap();
        let first = next_digest(&mut digests).await;
        assert!(first.contains("What it is doing right now:\n- Bash(cargo build)"));

        h.submission_tx
            .send(user_message_frame("s1", "look at the parser instead"))
            .unwrap();
        let second = next_digest(&mut digests).await;
        assert!(second.contains("What the session has been doing:\n- Bash(cargo build)"));
        assert!(second.contains(
            "What the user asked for:\n- make the watch loop resilient\n- look at the parser instead\n"
        ));
        // Nothing stale is "right now" — the section carries the fresh
        // directive itself, and the digest ends on it.
        assert!(second.ends_with("What it is doing right now:\n- look at the parser instead\n"));
    }

    /// A `$` command re-aims too, and — because the reset lands before the
    /// beat is recorded — its own line is the sole "right now" entry.
    #[tokio::test(start_paused = true)]
    async fn an_exchange_started_re_aims_with_its_line_as_the_sole_right_now() {
        let mut h = start_cadenced(
            Some("Running the build."),
            true,
            true,
            true,
            strict_cadence(),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo check")).unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        let started = serde_json::json!({
            "tug_session_id": "s1", "type": "exchange_started", "exchange_id": "e1",
            "command": "cargo build", "cwd": "/proj", "started_at": 1,
        });
        h.shell_tx
            .send(Frame::new(
                FeedId::SHELL_OUTPUT,
                serde_json::to_vec(&started).unwrap(),
            ))
            .unwrap();
        next_overview(&mut h.pulse_rx)
            .await
            .expect("a re-aimed overview");
        let mut digests = h.digests.take().unwrap();
        let digest = next_digest(&mut digests).await;
        assert!(digest.contains("What the session has been doing:\n- Bash(cargo check)"));
        assert!(digest.ends_with("What it is doing right now:\n- $ cargo build\n"));
    }

    /// A young session's opening ask is the cache's pinned first prompt; the
    /// pending ask defers to it rather than doubling it.
    #[tokio::test(start_paused = true)]
    async fn a_young_sessions_opening_ask_never_doubles_against_the_pinned_first() {
        let mut h = start(Some("Hardening the loop."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.submission_tx
            .send(user_message_frame("s1", "make the watch loop resilient"))
            .unwrap();
        let mut digests = h.digests.take().unwrap();
        let digest = next_digest(&mut digests).await;
        assert_eq!(digest.matches("make the watch loop resilient").count(), 1);
    }

    /// Once the JSONL catches up and the cache reads the same ask back, the
    /// pending copy clears and the cache's copy carries it — once.
    #[tokio::test(start_paused = true)]
    async fn a_pending_ask_clears_once_the_jsonl_catches_up() {
        let mut h = start(Some("Chasing the parser."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.submission_tx
            .send(user_message_frame("s1", "now fix the parser"))
            .unwrap();
        let mut digests = h.digests.take().unwrap();
        let first = next_digest(&mut digests).await;
        assert!(first.contains("- now fix the parser"));

        append_jsonl(
            &h._tmp.join("projects"),
            "/tmp/project",
            "claude-1",
            "now fix the parser",
        );
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        let second = next_digest(&mut digests).await;
        assert_eq!(second.matches("now fix the parser").count(), 1);
    }

    /// An ask arriving mid-prose-stream neither finalizes the open block nor
    /// clears the dedup set — those stay keyed to CODE_OUTPUT turn frames —
    /// and the reset lands before the ask's own (line-less) beat, so the
    /// block's eventual `said:` line is the first "right now" entry.
    #[test]
    fn an_ask_mid_prose_stream_leaves_the_open_block_and_dedup_untouched() {
        let mut state = SessionState::new(Instant::now());
        state.observe(CodeOutputEvent::Prose {
            msg_id: "m1".to_string(),
            block_index: 0,
            is_partial: true,
            text: "Working through the cadence".to_string(),
        });
        // The submission arm's exact sequence.
        state.human_act();
        state.pending_ask = Some("and check the floor".to_string());
        state.record(SessionBeat::Asked(Some("and check the floor".to_string())));
        state.observe(CodeOutputEvent::Prose {
            msg_id: "m1".to_string(),
            block_index: 0,
            is_partial: true,
            text: " logic and what the floor guards.".to_string(),
        });
        state.observe(CodeOutputEvent::Beat(SessionBeat::Turn));

        let said: Vec<&String> = state
            .activity
            .iter()
            .filter(|line| line.starts_with("said:"))
            .collect();
        assert_eq!(
            said.len(),
            1,
            "one block, one said line: {:?}",
            state.activity
        );
        assert_eq!(state.activity_since_emit, 1);
        assert_eq!(state.pending_ask.as_deref(), Some("and check the floor"));
    }

    /// The unsummarized-digest fix, pinned: a digest the model never saw is
    /// not recorded, so the identical digest emits once the host returns
    /// instead of dying to the digest-unchanged dedup.
    #[tokio::test(start_paused = true)]
    async fn a_digest_unseen_by_the_model_retries_after_the_host_returns() {
        let mut h = start(None, true, true, false);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.submission_tx
            .send(user_message_frame("s1", "fix the flaky test"))
            .unwrap();
        // The forced fire commits its tick, finds no host, and arms the
        // back-off; the digest must survive unrecorded.
        tokio::time::sleep(Duration::from_secs(5)).await;
        let mut digests = fake_host(&h.model, Some("Fixing the flaky test."));
        tokio::time::sleep(Duration::from_secs(61)).await;
        h.submission_tx
            .send(user_message_frame("s1", "fix the flaky test"))
            .unwrap();
        let overview = next_overview(&mut h.pulse_rx)
            .await
            .expect("the retried overview");
        assert_eq!(overview["text"], "Fixing the flaky test");
        let digest = next_digest(&mut digests).await;
        assert!(digest.contains("fix the flaky test"));
    }

    /// Gates outrank the arm — and outlast it: with the back-off active the
    /// sweep short-circuits before any tick commits, so `fire_asap` survives
    /// and fires on the first allowed tick after the back-off lifts.
    #[tokio::test(start_paused = true)]
    async fn a_forced_fire_survives_the_back_off_and_fires_when_it_lifts() {
        let mut h = start_cadenced(None, true, true, true, strict_cadence());
        tokio::time::sleep(Duration::from_millis(50)).await;
        // One session reaches the cadence honestly and gets refused: the
        // back-off arms for everyone.
        for _ in 0..8 {
            h.code_tx.send(tool_use_frame("s2", "cargo build")).unwrap();
        }
        tokio::time::sleep(Duration::from_secs(11)).await;
        // A human act while the back-off is active.
        h.submission_tx
            .send(user_message_frame("s1", "start on the lens bug"))
            .unwrap();
        let _digests = fake_host(&h.model, Some("Starting on the lens bug."));
        tokio::time::sleep(Duration::from_secs(65)).await;
        let overview = next_overview(&mut h.pulse_rx)
            .await
            .expect("the armed session fires once the back-off lifts");
        assert_eq!(overview["scopes"], serde_json::json!(["s1"]));
    }

    /// The synthesized right-now section requires the stretch to have
    /// contained the ask: on any later quiet tick the same prompt shape must
    /// end on the background, not resurrect a finished directive as live
    /// work.
    #[test]
    fn the_synthesized_right_now_requires_a_fresh_ask() {
        let prompts = vec![
            "fix the parser".to_string(),
            "now chase the lag".to_string(),
        ];
        let activity = vec!["Bash(cargo build)".to_string()];
        let with = compose_digest(&prompts, &activity, 0, true).unwrap();
        assert!(with.ends_with("What it is doing right now:\n- now chase the lag\n"));
        let without = compose_digest(&prompts, &activity, 0, false).unwrap();
        assert!(!without.contains("What it is doing right now:"));
    }

    /// The stale-resurrection defect, pinned end to end: after the re-aimed
    /// emit and the response's own emit, a trailing `turn_complete` — a beat
    /// with no line — must yield a digest with no right-now section at all,
    /// not one that claims the finished ask is being taken up.
    #[tokio::test(start_paused = true)]
    async fn a_settled_turn_does_not_resurrect_the_ask_as_right_now() {
        let mut h = start(Some("Chasing the lag."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.submission_tx
            .send(user_message_frame("s1", "now chase the lag"))
            .unwrap();
        let mut digests = h.digests.take().unwrap();
        let first = next_digest(&mut digests).await;
        assert!(first.ends_with("What it is doing right now:\n- now chase the lag\n"));

        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let second = next_digest(&mut digests).await;
        assert!(second.ends_with("What it is doing right now:\n- Bash(cargo build)\n"));

        h.code_tx.send(turn_complete_frame("s1")).unwrap();
        let third = next_digest(&mut digests).await;
        assert!(
            !third.contains("What it is doing right now:"),
            "a finished ask was claimed as live work:\n{third}"
        );
    }

    /// The session map is a rolling picture, not an archive: a session with
    /// no frames for the retention window is dropped at the sweep, and its
    /// next frame starts fresh — no stale background rides along.
    #[tokio::test(start_paused = true)]
    async fn an_idle_session_is_pruned_at_the_retention_window() {
        let mut h = start(Some("Building again."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let mut digests = h.digests.take().unwrap();
        let first = next_digest(&mut digests).await;
        assert!(first.contains("Bash(cargo build)"));

        tokio::time::sleep(SESSION_RETENTION + TICK_INTERVAL).await;
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        let second = next_digest(&mut digests).await;
        assert!(second.contains("Bash(cargo test)"));
        assert!(
            !second.contains("cargo build"),
            "the pruned session's old activity resurfaced:\n{second}"
        );
    }

    /// A burst of `$` commands cannot drive one inference per sweep: each
    /// start re-arms the fire, and the forced floor spaces the fires so the
    /// shared model — which also serves the `$` route's classify calls — is
    /// asked at most once per two ticks.
    #[tokio::test(start_paused = true)]
    async fn forced_fires_are_spaced_by_the_forced_floor() {
        let cadence = Cadence {
            burst_beats: 100,
            idle_period: Duration::from_secs(3_000),
            floor: Duration::from_secs(3_000),
            forced_floor: FORCED_EMIT_FLOOR,
        };
        let mut h = start_cadenced(Some("Running commands."), true, true, true, cadence);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let exec = |n: u32| {
            let body = serde_json::json!({
                "tug_session_id": "s1", "type": "exchange_started",
                "exchange_id": format!("e{n}"), "command": format!("echo {n}"),
                "cwd": "/proj", "started_at": n,
            });
            Frame::new(FeedId::SHELL_OUTPUT, serde_json::to_vec(&body).unwrap())
        };
        h.shell_tx.send(exec(1)).unwrap();
        let mut digests = h.digests.take().unwrap();
        let _first = next_digest(&mut digests).await;
        // The second command lands right after the first emit; the forced
        // floor holds it to the second sweep, not the first.
        let sent = Instant::now();
        h.shell_tx.send(exec(2)).unwrap();
        let second = next_digest(&mut digests).await;
        assert!(second.contains("$ echo 2"));
        let waited = Instant::now().duration_since(sent);
        assert!(
            waited >= FORCED_EMIT_FLOOR - TICK_INTERVAL / 2,
            "the forced fire ignored its floor: {waited:?}"
        );
    }

    /// A host that accepts requests — forwarding each digest so the test can
    /// see the summarize is in flight — and never answers them.
    fn mute_host(state: &SharedLocalModelState) -> tokio::sync::mpsc::Receiver<String> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(8);
        let (seen_tx, seen_rx) = tokio::sync::mpsc::channel::<String>(8);
        let requester = LocalModelRequester::new(tx);
        state.set_requester(Arc::clone(&requester));
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                let body: serde_json::Value = serde_json::from_str(&line).unwrap();
                let digest = body["prompt"].as_str().unwrap_or_default().to_string();
                let _ = seen_tx.send(digest).await;
            }
        });
        seen_rx
    }

    /// The emit rides its own task: with a summarize hung at the transport
    /// timeout, the loop still observes cancellation immediately. No virtual
    /// time passes after the cancel, so a loop blocked inside the emit would
    /// still hold its subscription — the receiver count is the tell.
    #[tokio::test(start_paused = true)]
    async fn cancellation_is_observed_mid_emit() {
        let h = start(None, true, true, false);
        let mut digests = mute_host(&h.model);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let _ = next_digest(&mut digests).await;
        h.cancel.cancel();
        for _ in 0..32 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            h.code_tx.receiver_count(),
            0,
            "the loop did not observe cancellation while an emit was in flight"
        );
    }

    /// Append one more user prompt to an already-seeded session JSONL — the
    /// scribe catching up with a submission the tap already narrated.
    fn append_jsonl(root: &std::path::Path, project_dir: &str, claude_id: &str, prompt: &str) {
        let (dir, _canonical) = crate::session_ledger::claude_project_dir(root, project_dir);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join(format!("{claude_id}.jsonl")))
            .unwrap();
        let line = serde_json::json!({
            "type": "user",
            "timestamp": "2026-07-27T00:00:01.000Z",
            "message": { "role": "user", "content": prompt },
        });
        writeln!(file, "{line}").unwrap();
    }

    fn assistant_text_frame(session: &str, msg_id: &str, text: &str) -> Frame {
        let body = serde_json::json!({
            "tug_session_id": session,
            "type": "assistant_text",
            "msg_id": msg_id,
            "block_index": 0,
            "is_partial": true,
            "text": text,
        });
        Frame::new(FeedId::CODE_OUTPUT, serde_json::to_vec(&body).unwrap())
    }

    /// The frozen-headline freeze case, now impossible: a session that only
    /// writes prose — zero `tool_use` frames — reaches the idle path and emits
    /// within `IDLE_PERIOD` of its first beat, because the tick evaluates the
    /// cadence whether or not another frame ever arrives.
    #[tokio::test(start_paused = true)]
    async fn a_prose_only_session_emits_within_the_idle_period() {
        let mut h = start_cadenced(
            Some("Explaining the cadence."),
            true,
            true,
            true,
            Cadence::default(),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx
            .send(assistant_text_frame(
                "s1",
                "m1",
                "The emitter now runs on a clock, not on frames. More to come",
            ))
            .unwrap();
        // One beat is under the burst, so nothing may fire before the idle
        // period — not even past the floor.
        tokio::time::sleep(EMIT_FLOOR + TICK_INTERVAL).await;
        assert!(h.pulse_rx.try_recv().is_err());
        tokio::time::sleep(IDLE_PERIOD).await;
        let overview = next_overview(&mut h.pulse_rx).await.expect("an overview");
        assert_eq!(overview["kind"], "overview");
        assert_eq!(overview["text"], "Explaining the cadence");
        assert_eq!(overview["scopes"], serde_json::json!(["s1"]));
    }

    /// A burst then silence: the emit fires from the tick arm alone, with zero
    /// trailing frames — the final stretch of a session is summarized.
    #[tokio::test(start_paused = true)]
    async fn the_trailing_stretch_is_summarized_with_no_further_frames() {
        let mut h = start_cadenced(
            Some("Hardening the watch loop."),
            true,
            true,
            true,
            Cadence::default(),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        for i in 0..BURST_BEATS {
            h.code_tx
                .send(tool_use_frame("s1", &format!("cargo build --round {i}")))
                .unwrap();
        }
        // Below the floor nothing fires, however big the burst.
        tokio::time::sleep(EMIT_FLOOR - TICK_INTERVAL).await;
        assert!(h.pulse_rx.try_recv().is_err());
        // Past the floor the sweep fires it with no further frame to help.
        tokio::time::sleep(EMIT_FLOOR).await;
        let overview = next_overview(&mut h.pulse_rx)
            .await
            .expect("the trailing emit");
        assert_eq!(overview["text"], "Hardening the watch loop");
    }

    /// `new_beats == 0` truly means nothing happened: after one emit, ticks
    /// pass forever without a re-emit until a new beat arrives.
    #[tokio::test(start_paused = true)]
    async fn a_quiet_session_is_never_re_summarized() {
        let mut h = start_cadenced(
            Some("Hardening the watch loop."),
            true,
            true,
            true,
            Cadence::default(),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        for i in 0..BURST_BEATS {
            h.code_tx
                .send(tool_use_frame("s1", &format!("cargo build --round {i}")))
                .unwrap();
        }
        tokio::time::sleep(EMIT_FLOOR + TICK_INTERVAL).await;
        assert!(next_overview(&mut h.pulse_rx).await.is_some());
        tokio::time::sleep(IDLE_PERIOD * 4).await;
        assert!(h.pulse_rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn an_unresolvable_session_skips_the_tick_silently() {
        let mut h = start(Some("Hardening the watch loop."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        // The identity closures answer for any id, but the JSONL only exists
        // for the seeded project — a session whose file is missing yields no
        // prompts, and with tool use present the digest still composes, so the
        // meaningful "unresolvable" case is the frame with no session id.
        let anonymous = serde_json::json!({ "type": "tool_use", "tool_name": "Bash" });
        h.code_tx
            .send(Frame::new(
                FeedId::CODE_OUTPUT,
                serde_json::to_vec(&anonymous).unwrap(),
            ))
            .unwrap();
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }
}

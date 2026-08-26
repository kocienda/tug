//! Session overview — a one-line answer to "what is this session working on?",
//! written by the SharedAgent and broadcast on PULSE above the live beat.
//!
//! The beat line says what just happened; the overview says what the whole
//! session is *for*. The overview follows the transcript, not the toolbelt: it
//! is composed from the user's own prompts (read from the claude JSONL) and an
//! interleaved stream of everything the transcript shows — assistant prose,
//! tool calls, and Session-card shell commands, in arrival order. Those go to
//! the agent as one digest, and the sentence that comes back is the
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
//!
//! **A settled session says what it did.** When a turn ends — or a `$` command
//! settles cleanly — and nothing follows for `IDLE_COLLAPSE_AFTER`, the emitter
//! runs one last summarize over the whole stretch and the strip switches from
//! the present tense to the past. Leaving the final intent up would be a claim
//! the session has stopped making.
//!
//! The collapse rides the ordinary emit machinery — the same queue, the single
//! in-flight slot, the same back-off, register, and gate — so it inherits every
//! safety property already built rather than duplicating one. It differs in
//! exactly two places, both deliberate: the gate runs in its retrospective mode
//! (see `ground_headline`), and the attempt is marked spent when the model
//! *answers* rather than when a headline emits. The second is not an
//! optimization: the collapse fires on `settled_at`, which no refusal changes,
//! so an attempt marked only on success would be retried on every sweep for as
//! long as the session stayed idle.
//!
//! One retrospective per settled stretch. Any beat resumes ordinary intents and
//! re-arms the next collapse, so nothing is lost — the intent it replaced was
//! stale by the definition of the trigger.

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
/// `pub` so `shared_agent.rs` can assert its `summarize` ceiling sits under
/// it: a ceiling above this floor would make the emitter's cadence
/// inference-bound rather than designed.
pub const EMIT_FLOOR: Duration = Duration::from_secs(8);

/// How often the emitter wakes to sweep sessions against the cadence. Frames
/// are evidence, not triggers, so this is the only evaluation point — well
/// inside every floor, so nothing due waits perceptibly.
const TICK_INTERVAL: Duration = Duration::from_secs(2);

/// How long a settled session stays quiet before the strip stops saying what it
/// is doing and starts saying what it did.
const IDLE_COLLAPSE_AFTER: Duration = Duration::from_secs(30);

/// Minimum spacing between forced (human-act) fires — two sweep ticks. A lone
/// submission still re-aims at typing speed, but every `$` command's start
/// arms the fire too, and an unspaced burst of them would drive one inference
/// per tick into the model that also serves the `$` route's classify calls.
const FORCED_EMIT_FLOOR: Duration = Duration::from_secs(4);

/// Minimum spacing between two asks for one session's standing description
/// ([P07], [Q01]).
///
/// The description rides the emit's digest rather than accumulating its own
/// evidence — an emit has already composed the sections the description needs,
/// and composing them twice would buy nothing but a second read of the JSONL.
/// The two clocks are deliberately far apart: the headline is meant to move
/// (`EMIT_FLOOR`, 8s), and the description is meant to stand, so it re-asks at
/// most once a minute even while the headline is changing every few seconds.
///
/// Why sixty seconds specifically: it is the shortest interval at which the
/// line does not visibly strobe under sustained work, and at one Haiku call per
/// session-minute the cost sits well under the headline's own. It is a tuned
/// starting point, not a derived constant — raise it if descriptions read as
/// restless, lower it if they read as stale.
///
/// One coupling worth stating: because it rides the emit outcome, the
/// description inherits the emit's gates. With PULSE or the overview tenant
/// switched off, no digest is composed and no description is written.
const SYNOPSIS_MIN_INTERVAL: Duration = Duration::from_secs(60);

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
/// session. This is the register's only budget: a headline is whatever says the
/// work in the room 56 characters gives it, at whatever word count that takes.
/// A tuning value; the live matrix may move it.
const MAX_HEADLINE_CHARS: usize = 56;

/// The standing description's budget, and it is deliberately not the
/// headline's.
///
/// The headline is a *headline* — it has one bright line of a strip to live in
/// and 56 characters is the room. The description is a *summary*: it sits under
/// the callsign on a card-wide chrome line, it is read days later, and it is
/// the only line that ever gets to say what the whole session is about. At 56
/// it could not say that — it could only produce a second headline, in the same
/// register, one line above the first, which is what it was doing. Room for a
/// clause and its qualifier is what makes the two lines read as two levels
/// rather than as one sentence printed twice.
///
/// 72, not more: the line's real display room is the Lens row and the picker
/// row, both of which cut around 96 characters mid-word — and a description
/// that routinely arrives clipped, by this budget's `…` or the row's, reads as
/// a broken line rather than a standing one. The budget is the display's, and
/// the wording asks the model for less than it so the clip is the exception.
const MAX_SYNOPSIS_CHARS: usize = 72;

/// Joiners a headline's dispensable tail hangs from.
///
/// Past the budget, what a model has added is almost always the parts list a
/// label headline drags behind it — "Author command-line calculator **with
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
    /// How long a settled session stays quiet before its intent collapses into
    /// a retrospective. Longer than `idle_period`, so the last live intent of a
    /// stretch always gets its turn on the strip before the stretch is called
    /// done.
    pub idle_collapse_after: Duration,
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            burst_beats: BURST_BEATS,
            idle_period: IDLE_PERIOD,
            floor: EMIT_FLOOR,
            forced_floor: FORCED_EMIT_FLOOR,
            idle_collapse_after: IDLE_COLLAPSE_AFTER,
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
    /// The cache has taken its first look at the file. On that first look,
    /// the transcript already on disk is history from before this cache
    /// existed — behind an unknown number of idle barriers — so only a
    /// trailing run of unanswered asks survives it (see [`Self::refresh`]).
    /// Without this, a restarted process reads every finished stretch's asks
    /// into the digest, and the summary reaches back across every barrier
    /// ever crossed.
    primed: bool,
    /// The current stretch's first prompt, pinned as the standing goal the
    /// digest leads with. It changes only at an idle barrier, which clears it
    /// so the next stretch's opening ask takes the slot.
    first: Option<String>,
    /// The most recent prompts, oldest evicted.
    recent: VecDeque<String>,
    /// The SESSION's opening ask — the first prompt in the transcript, set
    /// once and never cleared.
    ///
    /// Deliberately not `first`, which is the *stretch's* opener and is wiped
    /// at every idle barrier. That distinction is the whole difference between
    /// the two things this cache feeds: the headline is about the stretch, so
    /// it wants `first`; the standing description is about the session, and a
    /// "standing" goal that resets every time the user pauses for coffee is
    /// not standing at all. Reading the headline's own notion of a goal was
    /// what made the description and the headline print the same sentence.
    opening: Option<String>,
    /// The newest ask in the transcript — the work item the session is ON.
    /// Session-level, like `opening`: an idle barrier does not clear it,
    /// because the user pausing for coffee does not change what they last
    /// asked for. Only a rewritten transcript resets it.
    current_ask: Option<String>,
    /// Every ask BEFORE the current one, in order, oldest evicted — the
    /// session's work items. An ask is pushed here the moment the next one
    /// arrives: the user's messages are the boundaries between work items, so
    /// a session whose user typed three jobs into one warm stretch has three
    /// entries, not one. The stretch used to be the unit here, and a stretch
    /// swallowed every ask after its first — which is how a description came
    /// to lead with the morning's cleanup while the afternoon's work went
    /// unmentioned.
    arc: VecDeque<String>,
}

/// Asks carried in the arc. Enough to show a session that has moved through
/// several work items, bounded so a day-long session's history cannot crowd
/// the digest — the oldest go first, which is the right end to lose under a
/// description that leads with the newest.
const MAX_ARC_ASKS: usize = 8;

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
        if len < self.offset {
            // The file shrank — rewritten, not appended. The rewritten
            // transcript is as unseen as a pre-existing one: start over and
            // read it as a first look.
            self.offset = 0;
            self.primed = false;
            self.first = None;
            self.recent.clear();
            // A rewritten transcript is a different history, so the
            // session-lifetime memory goes with it rather than describing a
            // file that no longer exists.
            self.opening = None;
            self.current_ask = None;
            self.arc.clear();
        }
        if len == self.offset {
            self.primed = true;
            return;
        }
        // A first look reads under the barrier doctrine: a non-prompt record
        // is a response, and every ask above a response was answered on a
        // stretch this cache never watched — behind an unknown number of
        // idle barriers, and out of bounds. Only the trailing run of asks
        // nothing has answered yet is the live stretch's. Bytes appended
        // after the first look were watched being written, so they read
        // plainly.
        let priming = !self.primed;
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
                if priming {
                    // A response, so every ask above it was answered: a
                    // barrier this cache did not watch being crossed. Only the
                    // stretch-scoped fields go with it — the session-level
                    // memory (`opening`, `current_ask`, the arc) is built ask
                    // by ask below, so a restart reconstructs it from exactly
                    // the file it is already reading.
                    self.barrier();
                }
                continue;
            };
            if self.first.is_none() {
                self.first = Some(prompt.clone());
            }
            // The session's own opener, and the one field priming does NOT
            // discard: a first look reads the whole file, so the very first
            // ask in it is the session's opening ask whatever number of
            // barriers have been crossed since. Losing it to a process restart
            // is the difference between a description that knows what the
            // session set out to do and one that only knows this afternoon.
            if self.opening.is_none() {
                self.opening = Some(prompt.clone());
            }
            // The ask that was current until this line is a finished work item
            // now: the user's next message is the boundary that closes it.
            // This is where the arc is built — at ask granularity, live and
            // during priming alike — never at the idle barrier, whose stretch
            // unit swallowed every ask after the stretch's first.
            if let Some(prev) = self.current_ask.take() {
                if prev != prompt && self.arc.back() != Some(&prev) {
                    if self.arc.len() == MAX_ARC_ASKS {
                        self.arc.pop_front();
                    }
                    self.arc.push_back(prev);
                }
            }
            self.current_ask = Some(prompt.clone());
            if self.recent.len() == MAX_RECENT_PROMPTS {
                self.recent.pop_front();
            }
            self.recent.push_back(prompt);
        }
        self.offset += last_newline as u64 + 1;
        self.primed = true;
    }

    /// Drop every ask read so far while keeping the read position. The asks
    /// behind an idle barrier belong to a finished request; the preserved
    /// offset means they are gone for good rather than re-read on the next
    /// refresh.
    /// Only the STRETCH's fields fall here. `opening`, `current_ask`, and the
    /// arc belong to the session, not to any stretch of it — the barrier is
    /// the headline's boundary, and the description's boundaries are the
    /// user's own messages, recorded as each ask arrives.
    fn barrier(&mut self) {
        self.first = None;
        self.recent.clear();
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
    /// When the session last came to rest — a turn ended, or a `$` command
    /// settled with a zero exit — with nothing recorded since. `None` means
    /// work is in flight. This is the idle collapse's clock: any other beat,
    /// and every human act, clears it.
    settled_at: Option<Instant>,
    /// Whether this idle stretch's retrospective has already been attempted.
    /// Cleared by any beat, so a session that resumes and settles again
    /// collapses again.
    collapsed: bool,
    /// The session has come to rest since the last human act. Unlike
    /// `settled_at`, no machinery beat clears this — trailing prose or a
    /// snapshot replay can un-settle the collapse clock, but the rest still
    /// happened, and the next human act crosses the idle barrier because of
    /// it.
    rested: bool,
    /// How many idle barriers this session has crossed. An emit snapshots the
    /// epoch at spawn; an outcome carrying an older epoch describes a
    /// finished stretch and lands nothing.
    barrier_epoch: u64,
    /// Activity lines recorded since the last collapse was marked. A settled
    /// stretch with none has nothing new to say it did, which is what keeps a
    /// session that merely reconnects from re-announcing old work.
    activity_since_collapse: usize,
    /// When this session's standing description was last asked for ([P07]).
    /// `None` until the first ask. The description rides the emit's digest but
    /// on its own, much slower clock — see [`SYNOPSIS_MIN_INTERVAL`].
    last_synopsis: Option<Instant>,
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
            settled_at: None,
            collapsed: false,
            rested: false,
            barrier_epoch: 0,
            activity_since_collapse: 0,
            last_synopsis: None,
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
        if self.rested {
            self.cross_idle_barrier();
        }
        self.activity_since_emit = 0;
        self.fire_asap = true;
        self.resume();
    }

    /// A human act on a session that has been at rest starts a new stretch,
    /// and the idle boundary behind it is hard: nothing before it may appear
    /// in a summary again. The finished stretch's activity, cached asks,
    /// pending ask, and standing digest all drop, and the epoch bump
    /// invalidates any emit still in flight from before the barrier. The read
    /// offset inside the prompt cache survives, so asks the cache already
    /// consumed stay behind the barrier instead of being re-read.
    fn cross_idle_barrier(&mut self) {
        self.activity.clear();
        self.activity_since_emit = 0;
        self.activity_since_collapse = 0;
        self.prompts.barrier();
        self.pending_ask = None;
        self.last_digest = None;
        self.rested = false;
        self.barrier_epoch += 1;
    }

    /// The session is working again: it is no longer at rest, and whatever it
    /// goes on to do earns a fresh retrospective when it next settles.
    fn resume(&mut self) {
        self.settled_at = None;
        self.collapsed = false;
    }

    /// Whether this session has been at rest long enough to say what it did.
    ///
    /// Reads `settled_at` rather than `new_beats` — an idle session has no new
    /// beats, which is the entire point of the trigger. That is also why
    /// `collapsed` is marked on attempt rather than on emit: this arm does not
    /// inherit the brake `commit_tick` applies to the intent path.
    /// Record at the current instant, for the tests that exercise accumulation
    /// rather than the settle clock.
    #[cfg(test)]
    fn record_now(&mut self, beat: SessionBeat) {
        self.record(beat, Instant::now());
    }

    #[cfg(test)]
    fn observe_now(&mut self, event: CodeOutputEvent) {
        self.observe(event, Instant::now());
    }

    fn collapse_due(&self, now: Instant, after: Duration) -> bool {
        !self.collapsed
            && self.activity_since_collapse > 0
            && self
                .settled_at
                .is_some_and(|at| now.duration_since(at) >= after)
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

    /// Record a beat, and with it whether the session is now at rest.
    ///
    /// A turn ending and a `$` command settling cleanly are the two ways work
    /// finishes; every other beat means work is still happening. A *failed* `$`
    /// command is `Shell(Some(line))` — a recorded beat like any other — so it
    /// does not arm the collapse, and a session whose last act was an error
    /// keeps its standing intent rather than announcing what it did.
    fn record(&mut self, beat: SessionBeat, now: Instant) {
        match beat {
            SessionBeat::Turn | SessionBeat::Shell(None) => {
                self.collapsed = false;
                self.settled_at = Some(now);
                self.rested = true;
            }
            _ => self.resume(),
        }
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
            self.activity_since_collapse += 1;
        }
        self.new_beats += 1;
    }

    /// Route a CODE_OUTPUT event into beats and record them. Prose fragments
    /// accumulate; everything else records directly, and a `Turn` first
    /// settles the prose state (finalize the open block, clear the dedup set).
    fn observe(&mut self, event: CodeOutputEvent, now: Instant) {
        match event {
            CodeOutputEvent::Beat(SessionBeat::Turn) => {
                if let Some(said) = self.finalize_open() {
                    self.record(said, now);
                }
                self.beaten.clear();
                self.record(SessionBeat::Turn, now);
            }
            CodeOutputEvent::Beat(beat) => self.record(beat, now),
            CodeOutputEvent::Prose {
                msg_id,
                block_index,
                is_partial,
                text,
            } => {
                // Prose arriving is the assistant talking, so the session is
                // working whether or not this fragment completes a block. A
                // delta that earns no beat still has to un-settle the session,
                // or a stretch that resumes mid-block would collapse under it.
                self.resume();
                let beats = if is_partial {
                    self.prose_delta((msg_id, block_index), &text)
                } else {
                    self.prose_terminal((msg_id, block_index), &text)
                };
                for beat in beats {
                    self.record(beat, now);
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

/// Compose the digest the model summarizes: the standing goal, the current ask,
/// what the session has been doing about it, and what it is doing right now.
///
/// The two prompt sections are separate because the headline is meant to be
/// biased toward the newest declaration of intent while still moving as the
/// machinery works. One combined section made the current ask one bullet among
/// three, indistinguishable from the goal it was supposed to redirect; a
/// labeled section of its own is the only per-request lever strong enough for a
/// small model. A session whose newest prompt still *is* its first has one goal
/// and no redirection, and gets the standing-goal section alone.
///
/// Only the newest recent prompt reaches the digest. Anything between it and
/// the pinned first is the same middle slice `digest_prompts` already trims for
/// — least informative, and able to outvote the ask it precedes.
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
    push_prompt_sections(&mut out, prompts);
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

/// Write the two intent sections — the standing goal, then the current ask when
/// the newest prompt is not still the first. Shared so the live digest and the
/// retrospective state the session's intent in exactly the same words.
fn push_prompt_sections(out: &mut String, prompts: &[String]) {
    let Some((goal, rest)) = prompts.split_first() else {
        return;
    };
    out.push_str(STANDING_GOAL_HEADING);
    out.push('\n');
    out.push_str("- ");
    out.push_str(&clip(goal.trim(), 240));
    out.push('\n');
    if let Some(current) = rest.last() {
        out.push('\n');
        out.push_str(CURRENT_ASK_HEADING);
        out.push('\n');
        out.push_str("- ");
        out.push_str(&clip(current.trim(), 240));
        out.push('\n');
    }
}

/// Compose the digest the STANDING DESCRIPTION is written from — a different
/// question, asked of different evidence ([P07]).
///
/// The headline's digest is about a stretch: it leads with the stretch's
/// opening ask under "The standing goal", narrows to the newest ask, and closes
/// on what is running this second. Handing that same digest to the description
/// and telling the model to "describe the standing goal" produced exactly what
/// you would expect — the description and the headline, one under the other,
/// saying the same sentence in the same words. The two lines were never asked
/// different questions; they were asked the same question about the same
/// paragraph, and the model answered honestly twice.
///
/// So the description gets evidence the headline cannot see, ordered newest
/// first — the user's messages are the boundaries between work items, and the
/// newest item is the subject:
///
///  - **The most recent ask** — `PromptCache::current_ask`, the work item the
///    session is on. This LEADS the digest, because a description that led
///    with the session's opening kept naming the morning's cleanup after the
///    session had moved on to the afternoon's work.
///  - **The arc** — every prior ask, presented newest first. Earlier work is
///    evidence the line may mention, never the half it leads with.
///  - **The session's opening ask** — `PromptCache::opening`, which survives
///    every idle barrier. Labelled as context: where the session began, which
///    matters exactly when the session is still doing it.
///  - **The live headline** — LABELLED AS THE PRESENT and explicitly not the
///    subject. It is here so the description is current, not so it is about
///    it.
///  - **The description it is replacing**, when there is one, so a re-run
///    revises a standing line rather than composing a new one from scratch
///    every minute — stability of voice, while the subject moves with the
///    work.
///
/// Returns `None` when the session has said nothing yet — with no ask there
/// is no undertaking to describe, and an honestly empty description line is
/// the right answer.
pub fn compose_synopsis_digest(
    opening: Option<&str>,
    arc: &[String],
    recent_ask: Option<&str>,
    headline: Option<&str>,
    previous: Option<&str>,
) -> Option<String> {
    if opening.is_none() && arc.is_empty() && recent_ask.is_none() {
        return None;
    }
    let mut out = String::new();
    if let Some(recent) = recent_ask.map(str::trim).filter(|r| !r.is_empty()) {
        out.push_str(SESSION_RECENT_HEADING);
        out.push_str("\n- ");
        out.push_str(&clip(recent, 240));
        out.push('\n');
    }
    // Prior work items, NEWEST FIRST — the order the description weighs them
    // in. The opener is omitted here because it gets its own labelled section,
    // and an entry that merely restates the current ask says nothing new.
    let prior: Vec<&String> = arc
        .iter()
        .rev()
        .filter(|ask| Some(ask.as_str()) != opening && Some(ask.as_str()) != recent_ask)
        .collect();
    if !prior.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(SESSION_ARC_HEADING);
        out.push('\n');
        for ask in prior {
            out.push_str("- ");
            out.push_str(&clip(ask.trim(), 160));
            out.push('\n');
        }
    }
    // Where the session began — context, and skipped entirely when the newest
    // ask IS the opener: a one-ask session would otherwise weight its one ask
    // twice.
    if let Some(opening) = opening.filter(|o| Some(*o) != recent_ask) {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(SESSION_OPENING_HEADING);
        out.push_str("\n- ");
        out.push_str(&clip(opening.trim(), 240));
        out.push('\n');
    }
    // The present, under a heading that says so: evidence the work is live,
    // never the subject.
    if let Some(headline) = headline.map(str::trim).filter(|h| !h.is_empty()) {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(SESSION_PRESENT_HEADING);
        out.push_str("\n- ");
        out.push_str(&clip(headline, 160));
        out.push('\n');
    }
    if let Some(previous) = previous.map(str::trim).filter(|p| !p.is_empty()) {
        out.push('\n');
        out.push_str(SESSION_PREVIOUS_HEADING);
        out.push_str("\n- ");
        out.push_str(&clip(previous, 240));
        out.push('\n');
    }
    Some(out)
}

/// Headings the synopsis digest states its evidence under. Separate constants
/// because the prompt names each one verbatim, and a heading the wording does
/// not name is a section the model has no instruction about.
const SESSION_RECENT_HEADING: &str = "What the session was most recently asked to do:";
const SESSION_ARC_HEADING: &str = "What it worked on before that, newest first:";
const SESSION_OPENING_HEADING: &str =
    "What the session set out to do at the start (context, not the subject):";
const SESSION_PRESENT_HEADING: &str = "Where it stands right now (background, not the subject):";
const SESSION_PREVIOUS_HEADING: &str = "The description you are revising:";

/// Compose the digest a settled session is summarized from: the same intent
/// sections, then every activity line the stretch produced under one heading.
///
/// No recency split. The live digest divides activity into background and right
/// now because the question is what the session is doing *at this moment*; the
/// retrospective asks what it did across the whole stretch, and a boundary
/// inside that stretch would only invite the model to answer about half of it.
///
/// Returns `None` when there is nothing to describe.
pub fn compose_retrospective_digest(prompts: &[String], activity: &[String]) -> Option<String> {
    if prompts.is_empty() && activity.is_empty() {
        return None;
    }
    let mut out = String::new();
    push_prompt_sections(&mut out, prompts);
    if !activity.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(RETROSPECTIVE_HEADING);
        out.push('\n');
        for line in activity {
            out.push_str("- ");
            out.push_str(line);
            out.push('\n');
        }
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
    /// The same line **before the character budget clipped it** — the model's
    /// own words, in register, whole.
    ///
    /// This is what the grounding gate judges, and the distinction is not
    /// cosmetic: [`clip`] marks a cut with `…`, and rule 3 refuses any token
    /// carrying that marker because a model quoting a truncated path out of the
    /// digest is the defect that rule exists to catch. Judging `text` therefore
    /// made the gate refuse its OWN marker — every answer a few characters over
    /// budget came back `path-bearing`, which on 2026-08-09 was 101 of the 112
    /// descriptions refused in a day, and a session's description sat frozen for
    /// as long as the model kept writing long. The clip is the strip's doing and
    /// says nothing about whether the line is true; the gate must not read it as
    /// evidence. What ships is still `text`.
    pub unclipped: String,
    /// The normalizer changed the string at all.
    pub normalized: bool,
    /// An over-budget headline hung from a joiner, and the tail was cut there.
    pub trimmed: bool,
    /// The character budget clipped, after any trim.
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
    register_report(raw, MAX_HEADLINE_CHARS, true)
}

/// Impose the STANDING DESCRIPTION's register: the same mechanical cleanup at
/// the description's own budget, and without the joiner trim.
///
/// The joiner trim is a headline rule and only a headline rule. It exists
/// because past 56 characters what a model has added is the parts list a label
/// headline drags behind it, so `and` marks a dispensable tail. A description
/// is allowed to be a sentence with two halves — "Rework how a session names
/// itself **and** adopt it at every surface that cites one" is the description
/// doing its job, and cutting it at `and` would throw away the half that says
/// how far the work reaches.
pub fn synopsis_register_report(raw: &str) -> HeadlineReport {
    register_report(raw, MAX_SYNOPSIS_CHARS, false)
}

fn register_report(raw: &str, budget: usize, trim_joiner_tail: bool) -> HeadlineReport {
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
    let trimmed_text = if trim_joiner_tail {
        trim_tail_to_char_budget(collapsed)
    } else {
        collapsed.to_string()
    };
    let text = clip(&trimmed_text, budget);
    HeadlineReport {
        normalized: text != raw.trim(),
        trimmed: trimmed_text != collapsed,
        clipped: text != trimmed_text,
        unclipped: trimmed_text,
        text,
    }
}

/// Headings under which a digest line states intent rather than activity: what
/// the session is for, and what it was most recently pointed at.
const STANDING_GOAL_HEADING: &str = "The standing goal:";
const CURRENT_ASK_HEADING: &str = "The current ask:";

/// Headings under which a digest line describes activity rather than intent.
///
/// The tool-name and restatement rules read only these sections. `compose_digest`
/// writes the user's own prompts under the intent headings above in the same
/// `- ` form, and reading those as activity would put the user's verbs into the
/// tool-name set — an ask opening `fix the lag` would make every legitimate
/// `Fix …` headline unemittable for that session. Membership here is the whole
/// scoping mechanism, so a heading that is not listed is excluded by default.
const RETROSPECTIVE_HEADING: &str = "What the session did:";

const ACTIVITY_HEADINGS: &[&str] = &[
    "What the session has been doing:",
    "What it is doing right now:",
    RETROSPECTIVE_HEADING,
];

/// Words that carry none of a headline's subject, so whether the digest spells
/// them says nothing about whether the headline came from it.
const GROUNDING_STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "by", "for", "with", "from",
    "into", "its", "it", "this", "that", "after", "before",
];

/// How much of a headline's subject the digest must account for.
///
/// Read as a fraction: `GROUNDED_MIN_NUMERATOR / GROUNDED_MIN_DENOMINATOR` of the
/// content words after the opening verb.
///
/// Swept over the thirteen frozen digests, the real defective answers, and the
/// resident model's own answers at the 64-character budget. Correct headlines
/// ground no worse than two thirds; the surviving defects ground three fifths
/// and one third. Two thirds is therefore both the loosest value that refuses
/// every defect and the strictest that accepts every correct headline, and the
/// band between them is one word wide — which is why the sweep is pinned by a
/// test rather than left as a comment.
///
/// The budget widening did not move it. The worry was that a 64-character
/// headline carries more subject words, so one invented word costs a smaller
/// fraction and the same ratio reads looser. Real answers do run longer — four
/// to eight subject words against the six-word register's three to five — but
/// the two edges landed on the same numbers, because a model that invents
/// invents a phrase rather than a word: the defect that survives furthest is
/// still three fifths, and correct answers still bottom out at exactly two
/// thirds, now with real model output sitting there and not only a hand-written
/// headline.
const GROUNDED_MIN_NUMERATOR: usize = 2;
const GROUNDED_MIN_DENOMINATOR: usize = 3;

/// How many words an activity line may carry beyond a headline's subject and
/// still count as the line that headline restates.
///
/// The tool name itself is one of them, so the slack is small on purpose. Its job
/// is to keep a long `Name(target)` — a commit message, a multi-flag grep — from
/// containing a headline's whole subject by coincidence.
const RESTATEMENT_SLACK: usize = 3;

/// Punctuation trimmed off a word before comparison. The same set `run.py` uses,
/// so the Rust gate and the Python contamination check agree about what a word is.
const GROUNDING_TRIM: &str = ".,:;!?\"'`()[]<>";

/// Appended to the digest on the one corrective re-ask.
///
/// The correction rides on the digest because the instruction text is a
/// compile-time constant in the Swift service and the digest is the only
/// per-request input. Temperature is 0, so naming the rejected answer is the only
/// thing that can make the second answer differ from the first.
const GROUNDING_CORRECTION: &str =
    "\nThat is not what happened. This answer was rejected and must not be repeated:";

/// Whether a headline is derived from the digest it claims to describe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroundingVerdict {
    Grounded,
    Ungrounded {
        /// Which rule refused it. A static string so it can go straight into a
        /// log field the batch analyzer counts.
        rule: &'static str,
        /// What in particular tripped the rule, for the log and for the re-ask.
        detail: String,
    },
}

/// A crude stem, enough that `restart` matches `restarts` and `resumed`.
///
/// A port of `stem()` in `tests/model-eval/run.py`, blunt on purpose and blunt
/// in the same way. Surface-form comparison is not sufficient: the first version
/// of the contamination check compared surface forms and let two of six known
/// leaks through.
fn stem(word: &str) -> &str {
    for suffix in ["ing", "ed", "es", "s"] {
        if word.len() > suffix.len() + 2 && word.ends_with(suffix) {
            return word[..word.len() - suffix.len()].trim_end_matches('e');
        }
    }
    word.trim_end_matches('e')
}

/// A text reduced to comparable words, in order.
///
/// Splits on whitespace and on the characters that join words inside one token —
/// hyphen, slash, underscore — so `command-line` and `session_overview`
/// contribute their parts. Follows `words()` in `run.py`, minus its set collapse:
/// the first word has to stay identifiable because it is the verb.
///
/// Parentheses split here where `run.py` only trims them at a token's ends,
/// because this function reads activity lines and `run.py` does not. `tool_line`
/// writes `Name(target)`, so without the split the first word of every target
/// arrives glued to the tool name — `Bash(cargo` — and no headline can ever
/// match it. That would silently weaken the restatement rule, which exists
/// precisely to catch a headline that repeats a target.
///
/// A dotted token yields its parts *and* itself: `nocturne.css` contributes
/// `nocturne`, `css`, and `nocturne.css`. The dot is not in the split set
/// because a bare filename is a word in its own right — rule 3 admits one as a
/// proper name — so splitting it away would leave a headline naming the file
/// exactly with nothing to match. Emitting both is what lets a headline reading
/// `nocturne` ground against a digest that only ever writes
/// `Read(tugdeck/styles/themes/nocturne.css)`, which at 56 characters is a
/// common correct shape and was refused outright at six words.
fn content_words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.split(|c: char| {
        c.is_whitespace() || c == '-' || c == '/' || c == '_' || c == '(' || c == ')'
    }) {
        let bare = raw
            .trim_matches(|c: char| GROUNDING_TRIM.contains(c))
            .to_lowercase();
        // The whole token goes first so `first()` is still the opening word:
        // the verb rule and the subject's `skip(1)` both read this in order.
        let stemmed = stem(&bare);
        if !stemmed.is_empty() {
            out.push(stemmed.to_string());
        }
        if bare.contains('.') {
            out.extend(
                bare.split('.')
                    .map(stem)
                    .filter(|part| !part.is_empty())
                    .map(str::to_string),
            );
        }
    }
    out
}

/// The tool name an activity item opens with, if it is shaped like one.
///
/// `Name(target)` as `tool_line` writes it, or a bare `Name` for a tool called
/// with no recognized target field. The shape test — a leading capital, no
/// whitespace, nothing but word characters — is what keeps the user's own words
/// out even inside an activity section: `compose_digest` synthesizes a *right
/// now* section holding the newest ask **verbatim** when a stretch was re-aimed
/// without acting yet, so prose appears under an activity heading by design, and
/// section-awareness alone would not exclude it. It also excludes a shell beat
/// (`$ cargo test`) and a prose beat (`said: …`), neither of which is a tool.
fn tool_name_of(item: &str) -> Option<String> {
    let head = match item.find('(') {
        Some(open) if item.ends_with(')') => &item[..open],
        _ => item,
    };
    let first = head.chars().next()?;
    if !first.is_uppercase() {
        return None;
    }
    if !head.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }
    Some(stem(&head.to_lowercase()).to_string())
}

/// Every activity line in the digest that names a tool, as (stemmed name, line).
fn digest_tool_activity(digest: &str) -> Vec<(String, &str)> {
    let mut out = Vec::new();
    let mut in_activity = false;
    for line in digest.lines() {
        if line.ends_with(':') && !line.starts_with("- ") {
            in_activity = ACTIVITY_HEADINGS.contains(&line);
            continue;
        }
        if !in_activity {
            continue;
        }
        if let Some(item) = line.strip_prefix("- ") {
            if let Some(name) = tool_name_of(item) {
                out.push((name, item));
            }
        }
    }
    out
}

/// The tool names a digest's activity lines mention.
fn digest_tool_names(digest: &str) -> HashSet<String> {
    digest_tool_activity(digest)
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

/// Whether the digest supports this headline, and if not, which rule refused it.
///
/// The normalizer imposes register and never checks truth; this is the other
/// half. It runs on the normalized text, so it judges the string the strip would
/// actually wear, and it refuses rather than rewrites — rewriting would be
/// paraphrase, which is a second model with none of the first one's context, and
/// a gate that edits can introduce a new falsehood where a gate that declines
/// cannot.
///
/// Rules fire in order, first match winning:
///
/// 1. **empty** — nothing left after register. Checked here so the gate is total
///    over its input and no caller needs a pre-check.
/// 2. **tool-name opener** — the headline opens on a tool the digest names, which
///    means the intent line is restating the activity line.
/// 3. **path-bearing** — a token holding a `/` or `clip`'s `…` marker. A bare
///    filename is allowed: `score.py`'s rubric exempts identifiers and dotted
///    paths as proper names, and the gate must not contradict the rubric.
///    The `…` half catches a model quoting a truncated path out of the digest,
///    so what is judged must be the model's own words — callers pass
///    [`HeadlineReport::unclipped`], never the clipped `text`, or the gate reads
///    its own marker as the defect.
/// 4. **activity restatement** — the subject is contained in one tool line. Only
///    tool lines, because restating a *synthesized ask* line is the correct
///    behavior — that line exists precisely so the headline follows the new
///    directive rather than the old background.
/// 5. **ungrounded** — too little of the subject appears anywhere in the digest.
///
/// The opening word is exempt from grounding throughout: it is the verb, and a
/// digest of tool lines will rarely contain one. `Salvage` does not appear in a
/// digest about a corrupted ledger.
///
/// No copy of the prompt's example list is needed or wanted. Every example is
/// disjoint from every corpus digest, so a lifted example's words are by
/// definition absent from the digest and rule 5 already rejects it; a duplicated
/// list here would go stale the first time the Swift string was edited.
///
/// # The retrospective's exemption from rule 2
///
/// A retrospective opens in the past tense, and past-tense verbs collide with
/// tool names by construction. `stem` is deliberately crude — it strips `ed`, so
/// `stem("edited")` is `"edit"`, which is exactly `stem("Edit")`. `Read` is
/// worse: it is its own past tense and collides with no stemming at all. So
/// `Edited keymap shortcut conflicts`, a correct line for a session that ran
/// `Edit(keymap.ts)`, would be refused as a tool-name opener.
///
/// In `Retrospective` mode rule 2 therefore reads past the first word. This
/// costs nothing rule 2 was buying: it exists to catch a headline whose
/// *subject* is the tool, and a past-tense verb that happens to spell a tool
/// name is a verb. Rule 4 still catches a line that restates the activity. Every
/// other rule is byte-identical across modes — which is why
/// `RETROSPECTIVE_HEADING` is in `ACTIVITY_HEADINGS`, without which rules 2 and
/// 4 would both go inert over a digest that is nothing but tool lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroundingMode {
    /// A live headline: the whole line is checked.
    Intent,
    /// A settled stretch's retrospective: the opening past-tense verb is exempt
    /// from the tool-name rule.
    Retrospective,
}

pub fn ground_headline(headline: &str, digest: &str, mode: GroundingMode) -> GroundingVerdict {
    let headline = headline.trim();
    if headline.is_empty() {
        return GroundingVerdict::Ungrounded {
            rule: "empty",
            detail: String::new(),
        };
    }

    let words = content_words(headline);
    let Some(verb) = words.first() else {
        return GroundingVerdict::Ungrounded {
            rule: "empty",
            detail: String::new(),
        };
    };

    if mode == GroundingMode::Intent && digest_tool_names(digest).contains(verb) {
        return GroundingVerdict::Ungrounded {
            rule: "tool-name-opener",
            detail: verb.clone(),
        };
    }

    for token in headline.split_whitespace() {
        if token.contains('/') || token.contains('…') {
            return GroundingVerdict::Ungrounded {
                rule: "path-bearing",
                detail: token.to_string(),
            };
        }
    }

    let stopwords: HashSet<&str> = GROUNDING_STOPWORDS.iter().map(|w| stem(w)).collect();
    let subject: HashSet<&String> = words
        .iter()
        .skip(1)
        .filter(|word| !stopwords.contains(word.as_str()))
        .collect();
    // A headline that is nothing but a verb and stopwords has no subject to
    // ground. The register normalizer's word budget already bounds it, and there
    // is no claim in it that the digest could contradict.
    if subject.is_empty() {
        return GroundingVerdict::Grounded;
    }

    for (_, line) in digest_tool_activity(digest) {
        let line_words: HashSet<String> = content_words(line).into_iter().collect();
        // Restatement means the headline says the same thing the line says, so
        // containment only counts when the two are about the same size. A
        // word-rich target — a commit message, a long grep — contains a great
        // many subjects by accident, and letting it match refuses good headlines:
        // `Investigate local model roadmap` is a fair headline for a session
        // whose activity includes `Bash(tugutil commit --message "plan(new):
        // roadmap/local-model-inv)`, and nothing about it restates that command.
        if line_words.len() > subject.len() + RESTATEMENT_SLACK {
            continue;
        }
        if subject.iter().all(|word| line_words.contains(*word)) {
            return GroundingVerdict::Ungrounded {
                rule: "activity-restatement",
                detail: line.to_string(),
            };
        }
    }

    let have: HashSet<String> = content_words(digest).into_iter().collect();
    let grounded = subject.iter().filter(|word| have.contains(**word)).count();
    if grounded * GROUNDED_MIN_DENOMINATOR < subject.len() * GROUNDED_MIN_NUMERATOR {
        let mut missing: Vec<&str> = subject
            .iter()
            .filter(|word| !have.contains(**word))
            .map(|word| word.as_str())
            .collect();
        missing.sort_unstable();
        return GroundingVerdict::Ungrounded {
            rule: "ungrounded",
            detail: missing.join(" "),
        };
    }

    GroundingVerdict::Grounded
}

/// Bring an over-budget headline within the character budget by dropping the
/// tail it hangs from a joiner.
///
/// Fires only on overflow: a headline inside the budget is whatever the model
/// wrote, at any word count. Over budget, cutting at the earliest joiner takes
/// the whole tail rather than part of it — "Author command-line calculator with
/// makefile and readme" loses everything from `with`, not just `and readme`.
/// Never cuts below three words: past that there is no headline left to save.
///
/// The cut has to earn itself. If even the earliest joiner leaves the text over
/// budget, the text comes back untouched and `clip` truncates it — a headline
/// that is both amputated and clipped reads worse than one that is only
/// clipped, and the phrase boundary buys nothing once the ellipsis lands.
pub fn trim_tail_to_char_budget(text: &str) -> String {
    if text.chars().count() <= MAX_HEADLINE_CHARS {
        return text.to_string();
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    words
        .iter()
        .enumerate()
        .filter(|(i, word)| {
            let bare = word
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase();
            *i >= 3 && TAIL_JOINERS.contains(&bare.as_str())
        })
        .map(|(i, _)| words[..i].join(" "))
        .find(|cut| cut.chars().count() <= MAX_HEADLINE_CHARS)
        .unwrap_or_else(|| text.to_string())
}

/// The PULSE frame carrying an overview. `kind` is what tells the deck to file
/// it above the beat line instead of in the beat stream; parsers that predate
/// the field ignore it.
///
/// `phase` is `"done"` on a retrospective and absent on a live intent — present
/// so the deck can eventually give a settled stretch its own register, and
/// absent rather than `"live"` so nothing existing has to learn a new value.
pub fn overview_frame(
    session_id: &str,
    headline: &str,
    beat: i64,
    at_ms: i64,
    phase: Option<&str>,
) -> Frame {
    let mut body = serde_json::json!({
        "type": "pulse",
        "kind": "overview",
        "text": headline,
        "scopes": [session_id],
        "beat": beat,
        "at": at_ms,
    });
    if let (Some(phase), Some(map)) = (phase, body.as_object_mut()) {
        map.insert("phase".to_string(), serde_json::json!(phase));
    }
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
    /// Where a published overview is also written, so a card comes back
    /// from a relaunch still wearing its headline. Absent in tests and in
    /// a ledger-less build, where an overview is broadcast and forgotten.
    pub ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
    /// The CONTROL broadcast, for the `session_updated` push that carries a
    /// written description to every surface showing that session ([P07]).
    /// Absent in tests and in a ledger-less build; the write still lands, and
    /// the next listing picks it up.
    pub control_tx: Option<broadcast::Sender<Frame>>,
    /// The `pulse-overview` tenant switch, read per tick so a flip is live.
    pub tenant_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// PULSE's own switch, same closure shape the bridge uses.
    pub pulse_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The Haiku SharedAgent the headline is asked of, absent in a build that
    /// never made one — which reads exactly like the old no-model posture.
    pub shared_agent: crate::shared_agent::SharedAgentHandle,
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
    shared_agent: crate::shared_agent::SharedAgentHandle,
    /// Whether a refused headline may be re-asked. Decided on the loop, because
    /// the spawned task cannot see the queue and reading it across the loop
    /// boundary would be a lock held over the emit.
    ///
    /// One emit is in flight at a time across all sessions and the summarize
    /// timeout is 6 s, so an unconditional re-ask would let one refusing session
    /// hold the only slot for twice that while every queued session waits. A
    /// refusal would then cost liveliness globally, which is the opposite of what
    /// the re-ask exists to protect.
    may_reask: bool,
    /// Whether this emit says what the session did rather than what it is
    /// doing. Chosen on the loop by the collapse arm; the task carries it into
    /// the digest, the requester, the gate, and back out on the outcome.
    retrospective: bool,
    /// The session's barrier epoch at spawn. Echoed on the outcome so the
    /// loop can tell an emit that predates an idle barrier from one that
    /// still describes the current stretch.
    barrier_epoch: u64,
}

/// What the one corrective re-ask did, for the rescue rate.
///
/// A grounded headline has no variant here and logs no re-ask line at all, so
/// the rescue rate's denominator is re-asks *reached* rather than ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reask {
    /// A refusal, but another session was waiting for the emit slot.
    Skipped,
    /// Asked again; the second answer was refused too, or the call failed.
    Failed,
    /// Asked again; the second answer was grounded.
    Rescued,
}

impl Reask {
    /// A space-free token, because `analyze.py` splits log fields on whitespace
    /// unless the value is quoted.
    fn as_str(self) -> &'static str {
        match self {
            Reask::Skipped => "skipped",
            Reask::Failed => "failed",
            Reask::Rescued => "rescued",
        }
    }
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
    /// The normalized headline, when the model produced one the digest supports.
    /// A refused headline leaves this `None`, so the previous headline stands.
    headline: Option<String>,
    /// The model was absent or failed — arm the back-off.
    failed: bool,
    /// Echoed back from the job. Paired with `seen_digest`, this is what tells
    /// the loop a retrospective was attempted and answered, which is when the
    /// collapse is marked — see `apply_emit_outcome`.
    retrospective: bool,
    /// Echoed from the job. An outcome whose epoch is behind the session's
    /// crossed an idle barrier in flight: it describes a finished stretch,
    /// and only its cache's read position survives the landing.
    barrier_epoch: u64,
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
    // Each entry carries whether it is a retrospective, decided by the arm that
    // queued it.
    let mut queue: VecDeque<(String, bool)> = VecDeque::new();
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
                    Ok(outcome) => {
                        // The digest the model saw, borrowed before the outcome
                        // is consumed: the standing description is composed from
                        // the same evidence, on its own much slower clock.
                        let digest = outcome.seen_digest.clone();
                        apply_emit_outcome(
                            outcome,
                            &mut sessions,
                            &mut backoff,
                            &mut queue,
                            &mut active,
                            &config.pulse_tx,
                            config.ledger.as_ref(),
                        );
                        // The description rides the emit's CADENCE, not its
                        // evidence: an emit having happened is what says the
                        // session moved, and `take_synopsis_job` then composes
                        // the session-lifetime digest of its own.
                        if digest.is_some() {
                            if let Some(job) = take_synopsis_job(
                                &session_id,
                                &mut sessions,
                                &config,
                                &cancel,
                                Instant::now(),
                            ) {
                                tokio::spawn(run_synopsis(job));
                            }
                        }
                    }
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
                state.observe(event, now);
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
                state.record(beat, now);
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
                state.record(beat, now);
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
            queue.push_back((session_id, false));
        }
        // The collapse arm. A session already queued for an intent is skipped
        // by the `active` guard and reconsidered on a later sweep — by which
        // time the intent it just emitted is the one being collapsed, which is
        // the right order to say the two things in.
        let collapse_due: Vec<String> = sessions
            .iter()
            .filter(|(id, _)| !active.contains(*id))
            .filter(|(_, state)| state.collapse_due(now, config.cadence.idle_collapse_after))
            .map(|(session_id, _)| session_id.clone())
            .collect();
        for session_id in collapse_due {
            active.insert(session_id.clone());
            queue.push_back((session_id, true));
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
    queue: &mut VecDeque<(String, bool)>,
    active: &mut HashSet<String>,
    in_flight: &mut Option<(String, tokio::task::JoinHandle<EmitOutcome>)>,
    sessions: &mut HashMap<String, SessionState>,
    backoff: &BackOff,
    config: &SessionOverviewConfig,
) {
    while in_flight.is_none() {
        if backoff.active(Instant::now()) {
            for (id, _) in queue.drain(..) {
                active.remove(&id);
            }
            return;
        }
        let Some((session_id, retrospective)) = queue.pop_front() else {
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
            shared_agent: config.shared_agent.clone(),
            session_id: session_id.clone(),
            activity,
            recent_activity,
            asked,
            // Read after the pop: nobody is left behind this emit.
            may_reask: queue.is_empty(),
            retrospective,
            barrier_epoch: state.barrier_epoch,
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
        shared_agent,
        may_reask,
        retrospective,
        barrier_epoch,
    } = job;
    let mut outcome = EmitOutcome {
        session_id: session_id.clone(),
        cache: PromptCache::default(),
        caught_up_ask: None,
        seen_digest: None,
        headline: None,
        failed: false,
        retrospective,
        barrier_epoch,
    };
    let mode = if retrospective {
        GroundingMode::Retrospective
    } else {
        GroundingMode::Intent
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
    let composed = if retrospective {
        compose_retrospective_digest(&prompts, &activity)
    } else {
        compose_digest(&prompts, &activity, recent_activity, asked)
    };
    let Some(digest) = composed else {
        debug!(session = %session_id, "session overview: nothing to describe");
        return outcome;
    };
    // The dedup is for the intent path only. A retrospective is attempted once
    // per settled stretch and is marked spent by having been *asked*, so a path
    // that returns before the model is reached would leave the collapse unmarked
    // and re-fire on every sweep — this arm has no `new_beats` brake to stop it.
    if !retrospective && last_digest.as_deref() == Some(digest.as_str()) {
        debug!(session = %session_id, "session overview: digest unchanged");
        return outcome;
    }

    let Some(agent) = shared_agent else {
        debug!(session = %session_id, "session overview: no shared agent");
        outcome.failed = true;
        return outcome;
    };
    // Turnaround is the standing measure of whether this feature is usable:
    // the job's own ceiling bounds the wait, and it sits under the emit floor
    // so a headline can never still be in flight when the next one is due.
    let started = Instant::now();
    let job_name = if retrospective {
        "summarize_done"
    } else {
        "summarize"
    };
    let answer = agent.run(job_name, digest.clone()).await;
    let report = match answer {
        Ok(text) => {
            let report = headline_register_report(&text);
            let elapsed_ms = started.elapsed().as_millis() as u64;
            if retrospective {
                info!(
                    session = %session_id,
                    elapsed_ms,
                    raw = %text,
                    headline = ?report.text,
                    "session overview: collapsed",
                );
            } else {
                info!(
                    session = %session_id,
                    elapsed_ms,
                    raw = %text,
                    headline = %report.text,
                    normalized = report.normalized,
                    trimmed = report.trimmed,
                    clipped = report.clipped,
                    "session overview: summarized",
                );
            }
            report
        }
        Err(error) => {
            warn!(
                %error,
                session = %session_id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                retrospective,
                "session overview: summarize failed",
            );
            outcome.failed = true;
            return outcome;
        }
    };
    // The model answered, so it saw this digest — record it whether or not the
    // answer survives the gate, or the next tick re-summarizes evidence that has
    // not changed. On the re-ask below this stays the *original* digest: the
    // correction is appended for the model's benefit only.
    outcome.seen_digest = Some(digest.clone());

    // Judged unclipped — see `HeadlineReport::unclipped`. What ships is `text`.
    let refusal = match ground_headline(&report.unclipped, &digest, mode) {
        GroundingVerdict::Grounded => {
            outcome.headline = Some(report.text);
            return outcome;
        }
        GroundingVerdict::Ungrounded { rule, detail } => {
            info!(
                session = %session_id,
                rule = %rule,
                headline = ?report.unclipped,
                detail = ?detail,
                "session overview: headline refused",
            );
            (rule, detail)
        }
    };

    if !may_reask {
        info!(
            session = %session_id,
            reask = %Reask::Skipped.as_str(),
            "session overview: headline reask",
        );
        return outcome;
    }

    // Grounded against the original digest, never against the corrected one —
    // the correction quotes the rejected headline, so grounding the second answer
    // against it would let the model pass by repeating itself.
    // The rejected line as the gate SAW it, which is the unclipped one: quoting
    // the clipped form would show the model a `…` nothing said about it.
    let corrected = format!(
        "{digest}{GROUNDING_CORRECTION} {}\nIt failed because: {} {}\n",
        report.unclipped, refusal.0, refusal.1,
    );
    let second = agent.run("summarize", corrected).await;
    let reask = match second {
        Ok(text) => {
            let report = headline_register_report(&text);
            match ground_headline(&report.unclipped, &digest, mode) {
                GroundingVerdict::Grounded => {
                    outcome.headline = Some(report.text);
                    Reask::Rescued
                }
                GroundingVerdict::Ungrounded { .. } => Reask::Failed,
            }
        }
        Err(error) => {
            warn!(%error, session = %session_id, "session overview: reask failed");
            Reask::Failed
        }
    };
    // Debug-formatted so the text arrives quoted: `analyze.py` reads a field's
    // value as space-free unless it is quoted, and a bare headline would parse as
    // its first word with the rest silently dropped.
    info!(
        session = %session_id,
        reask = %reask.as_str(),
        headline = ?outcome.headline.as_deref().unwrap_or_default(),
        "session overview: headline reask",
    );
    outcome
}

/// Everything one description ask needs, snapshotted on the loop.
struct SynopsisJob {
    /// The tug session id — what the loop keys by, and what the resolver takes.
    session_id: String,
    /// The session-lifetime evidence, everything except the description this
    /// ask is revising — that one is read from the ledger row inside the job,
    /// so the revision target comes from the row as it stands when the ask runs.
    digest: String,
    shared_agent: crate::shared_agent::SharedAgentHandle,
    ledger: Arc<crate::session_ledger::SessionLedger>,
    control_tx: Option<broadcast::Sender<Frame>>,
    /// Ends the ask when the process is going down — the job runs detached, so
    /// this is the only thing that stops it writing after the loop is gone.
    cancel: CancellationToken,
    /// The row the description belongs to, always the resolver's answer.
    ///
    /// Ledger rows are keyed by **claude's** session id, which is the tug id
    /// for a plain fresh spawn and something else after a rewind fork or an id
    /// rotation. There is deliberately **no fallback to the tug id**: the
    /// resolver returns `None` both for a session it has no entry for and for a
    /// momentarily contended lock (it reads through `try_lock`), and those two
    /// are indistinguishable here. Guessing the tug id would, for a fork, name
    /// the *parent's* row — writing one session's description onto another's,
    /// which is the confidently-wrong outcome [D132] ranks below saying nothing.
    /// An unresolvable session simply waits for the next window.
    row_id: String,
}

/// Decide whether this session's standing description is due, and snapshot the
/// job if it is. Runs on the loop so the debounce clock is read and written in
/// one place; the ask itself runs detached, because it must not occupy the
/// single emit slot that paces every session's headline.
///
/// The digest is composed HERE, from the session's own lifetime evidence, and
/// is not the headline's digest under a different question — see
/// [`compose_synopsis_digest`] for why that distinction is the whole point.
fn take_synopsis_job(
    session_id: &str,
    sessions: &mut HashMap<String, SessionState>,
    config: &SessionOverviewConfig,
    cancel: &CancellationToken,
    now: Instant,
) -> Option<SynopsisJob> {
    let ledger = config.ledger.as_ref()?;
    // The row this description belongs to, resolved BEFORE the debounce is
    // marked: a session whose row cannot be identified is not "asked and
    // failed", it is not asked at all, and the next emit should try again
    // rather than wait out a window it never used. See `SynopsisJob::row_id`
    // for why there is no fallback.
    let row_id = (config.identity.resolver)(session_id)?;
    let state = sessions.get_mut(session_id)?;
    if let Some(last) = state.last_synopsis {
        if now.duration_since(last) < SYNOPSIS_MIN_INTERVAL {
            return None;
        }
    }
    let arc: Vec<String> = state.prompts.arc.iter().cloned().collect();
    let digest = compose_synopsis_digest(
        state.prompts.opening.as_deref(),
        &arc,
        state.prompts.current_ask.as_deref(),
        state.last_headline.as_deref(),
        None,
    )?;
    // Marked on the ask, not on the answer: a model that fails or a row that
    // turns out to be frozen must not make every subsequent emit retry. Marked
    // AFTER the digest, so a session with nothing to describe yet has not
    // burned its window on a question that was never put.
    state.last_synopsis = Some(now);
    Some(SynopsisJob {
        row_id,
        session_id: session_id.to_owned(),
        digest,
        shared_agent: config.shared_agent.clone(),
        ledger: Arc::clone(ledger),
        control_tx: config.control_tx.clone(),
        cancel: cancel.clone(),
    })
}

/// Ask for one session's standing description and persist it ([P07], Spec S07).
///
/// Detached from the emit loop: the answer is wanted but nothing waits on it,
/// and a description held at the transport timeout must not delay the next
/// session's headline. Every failure is a silent skip — the debounce was
/// already marked, so the next ask comes a minute later either way.
///
/// Detached does not mean unowned. The task holds a ledger handle and would
/// otherwise outlive the loop that spawned it, so the ask races the loop's own
/// cancellation token and a shutdown that lands mid-flight writes nothing.
async fn run_synopsis(job: SynopsisJob) {
    let SynopsisJob {
        session_id,
        digest,
        shared_agent,
        ledger,
        control_tx,
        cancel,
        row_id,
    } = job;
    // The read yields the description this ask is revising, which is the last
    // section of the digest: a re-run should revise a standing line, not compose
    // a fresh one every minute against slightly different evidence.
    //
    // A rename does not stop the ask. The name is the session's title and this
    // is the line beneath it ([D132]), so both are wanted on a renamed session.
    let previous = match ledger.get(&row_id) {
        Ok(Some(row)) => row.synopsis,
        Ok(None) => {
            debug!(session = %session_id, row = %row_id, "session synopsis: no ledger row");
            return;
        }
        Err(error) => {
            warn!(%error, session = %session_id, "session synopsis: ledger read failed");
            return;
        }
    };
    let digest = match previous.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(previous) => {
            format!(
                "{digest}\n{SESSION_PREVIOUS_HEADING}\n- {}\n",
                clip(previous, 240)
            )
        }
        None => digest,
    };
    let Some(agent) = shared_agent else {
        return;
    };
    let started = Instant::now();
    let answer = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            debug!(session = %session_id, "session synopsis: cancelled mid-ask");
            return;
        }
        answered = agent.run("synopsis", digest.clone()) => match answered {
            Ok(text) => text,
            Err(error) => {
                warn!(%error, session = %session_id, "session synopsis: ask failed");
                return;
            }
        },
    };
    // The description's OWN register — a summary's budget, and no joiner trim
    // — and the headline's grounding gate unchanged: a description the digest
    // does not support is the invention the gate exists to refuse, and that is
    // true whatever length the line is allowed to be.
    let report = synopsis_register_report(&answer);
    match ground_headline(&report.unclipped, &digest, GroundingMode::Intent) {
        GroundingVerdict::Grounded => {}
        GroundingVerdict::Ungrounded { rule, detail } => {
            info!(
                session = %session_id,
                rule = %rule,
                synopsis = ?report.unclipped,
                detail = ?detail,
                "session synopsis: refused",
            );
            return;
        }
    }
    if report.text.is_empty() {
        return;
    }
    match ledger.record_synopsis(&row_id, &report.text) {
        Ok(true) => {
            info!(
                session = %session_id,
                row = %row_id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                synopsis = %report.text,
                "session synopsis: written",
            );
            if let (Some(tx), Ok(Some(row))) = (control_tx, ledger.get(&row_id)) {
                // Every push carries the scan pair, this one included — see
                // `build_session_updated_frame`.
                let metrics = ledger.scan_metrics_for(&row_id).unwrap_or(None);
                let _ = tx.send(crate::feeds::agent_supervisor::build_session_updated_frame(
                    &row, metrics,
                ));
            }
        }
        // The description already said exactly this.
        Ok(false) => {}
        Err(error) => {
            warn!(%error, session = %session_id, "session synopsis: ledger write failed");
        }
    }
}

/// Land an emit outcome back on the loop's state: restore the cache, settle
/// the back-off, record the digest the model saw, and publish the headline
/// when it is new.
fn apply_emit_outcome(
    outcome: EmitOutcome,
    sessions: &mut HashMap<String, SessionState>,
    backoff: &mut BackOff,
    queue: &mut VecDeque<(String, bool)>,
    active: &mut HashSet<String>,
    pulse_tx: &broadcast::Sender<Frame>,
    ledger: Option<&Arc<crate::session_ledger::SessionLedger>>,
) {
    let EmitOutcome {
        session_id,
        cache,
        caught_up_ask,
        seen_digest,
        headline,
        failed,
        retrospective,
        barrier_epoch,
    } = outcome;
    if failed {
        // The back-off is process-wide. The queued sessions behind this one
        // drop with their ticks uncommitted, so their evidence survives for
        // the first allowed sweep after the back-off lifts.
        backoff.fail(Instant::now());
        for (id, _) in queue.drain(..) {
            active.remove(&id);
        }
    } else if seen_digest.is_some() {
        backoff.succeed();
    }
    let Some(state) = sessions.get_mut(&session_id) else {
        return;
    };
    // An emit that crossed an idle barrier in flight describes a finished
    // stretch, and the barrier is hard: no digest, no collapse mark, no
    // headline. Only the cache's read position survives — with its asks
    // dropped — because losing the offset would make the next refresh
    // re-read the whole transcript and haul the old stretch back in.
    if barrier_epoch != state.barrier_epoch {
        let mut cache = cache;
        cache.barrier();
        state.prompts = cache;
        debug!(session = %session_id, "session overview: emit predates idle barrier");
        return;
    }
    state.prompts = cache;
    if let Some(ask) = caught_up_ask {
        if state.pending_ask.as_ref() == Some(&ask) {
            state.pending_ask = None;
        }
    }
    // The collapse is spent once the model has answered, whatever the gate then
    // rules. Marking it on a successful emit instead would loop: the collapse
    // arm fires on `settled_at`, which no refusal changes, so a retrospective
    // the gate keeps refusing would be re-asked on every sweep for as long as
    // the session stayed idle.
    if retrospective && seen_digest.is_some() {
        state.collapsed = true;
        state.activity_since_collapse = 0;
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
    let at_ms = crate::session_ledger::now_millis();
    let phase = retrospective.then_some("done");
    let frame = overview_frame(&session_id, &headline, state.beat, at_ms, phase);
    let receivers = pulse_tx.send(frame).unwrap_or(0);
    if let Some(ledger) = ledger {
        if let Err(error) =
            ledger.record_pulse_overview(&session_id, at_ms, state.beat, &headline, phase)
        {
            warn!(%error, session = %session_id, "session overview: ledger write failed");
        }
    }
    info!(
        session = %session_id,
        beat = state.beat,
        receivers,
        retrospective,
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

    /// The numbers themselves are design values: the job table in
    /// `shared_agent.rs` asserts its summarize ceiling sits under `EMIT_FLOOR`,
    /// and the tick has to land well inside every floor for the sweep to be the
    /// sole evaluation point.
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
        let mut checked = 0;
        for entry in corpus_entries() {
            let digest = compose_digest(
                &entry.prompts,
                &entry.tools,
                entry.recent_tools,
                entry.asked,
            )
            .unwrap_or_else(|| panic!("{} describes nothing", entry.input.display()));
            freeze(&entry.input.with_extension("digest.txt"), &digest);
            checked += 1;
        }
        assert!(checked >= 12, "corpus shrank to {checked} entries");
    }

    /// The retrospective's own frozen surface, pinned at birth so the lane that
    /// scores it has a fixed thing to score.
    #[test]
    fn corpus_retrospectives_are_what_the_retrospective_composer_produces() {
        let mut checked = 0;
        for entry in corpus_entries() {
            let digest = compose_retrospective_digest(&entry.prompts, &entry.tools)
                .unwrap_or_else(|| panic!("{} describes nothing", entry.input.display()));
            freeze(&entry.input.with_extension("done.txt"), &digest);
            checked += 1;
        }
        assert!(checked >= 12, "corpus shrank to {checked} entries");
    }

    struct CorpusEntry {
        input: PathBuf,
        prompts: Vec<String>,
        tools: Vec<String>,
        recent_tools: usize,
        asked: bool,
    }

    /// The corpus inputs — `compose_digest`'s four arguments, in file order.
    fn corpus_entries() -> Vec<CorpusEntry> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/model-eval/corpus");
        let mut inputs: Vec<_> = std::fs::read_dir(&root)
            .unwrap_or_else(|e| panic!("read {}: {e}", root.display()))
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        inputs.sort();
        inputs
            .into_iter()
            .map(|input| {
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
                CorpusEntry {
                    prompts: strings("prompts"),
                    tools: strings("tools"),
                    recent_tools: body["recent_tools"].as_u64().unwrap_or(0) as usize,
                    asked: body["asked"].as_bool().unwrap_or(false),
                    input,
                }
            })
            .collect()
    }

    /// Compare one frozen file against what the composer produces now, or
    /// rewrite it under `TUG_REGENERATE_DIGESTS`.
    fn freeze(frozen: &std::path::Path, digest: &str) {
        if std::env::var("TUG_REGENERATE_DIGESTS").is_ok() {
            std::fs::write(frozen, digest).unwrap();
            return;
        }
        let on_disk = std::fs::read_to_string(frozen).unwrap_or_else(|_| {
            panic!(
                "{} is missing; regenerate with TUG_REGENERATE_DIGESTS=1",
                frozen.display()
            )
        });
        assert_eq!(&on_disk, digest, "{} is stale", frozen.display());
    }

    /// One frozen corpus digest, by name.
    fn digest(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/model-eval/corpus")
            .join(format!("{name}.digest.txt"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    fn refusal(headline: &str, name: &str) -> (&'static str, String) {
        match ground_headline(headline, &digest(name), GroundingMode::Intent) {
            GroundingVerdict::Grounded => {
                panic!("{headline:?} was accepted against {name}, expected a refusal")
            }
            GroundingVerdict::Ungrounded { rule, detail } => (rule, detail),
        }
    }

    fn assert_grounded(headline: &str, name: &str) {
        if let GroundingVerdict::Ungrounded { rule, detail } =
            ground_headline(headline, &digest(name), GroundingMode::Intent)
        {
            panic!("{headline:?} refused against {name} by {rule} ({detail})");
        }
    }

    /// Every defective headline recorded during the 2026-07-29 measurement pass,
    /// against a real digest, with the rule that has to catch it.
    #[test]
    fn the_real_defective_headlines_are_refused() {
        // A tool line copied straight through as the intent line.
        assert_eq!(
            refusal("Bash make", "parts-list-tail").0,
            "tool-name-opener"
        );
        // The mid-token truncation seen on the strip. `…` is `clip`'s marker.
        assert_eq!(
            refusal("Write jul29-p…", "tools-without-prompts").0,
            "path-bearing"
        );
        assert_eq!(
            refusal("Write /tmp/calc/calc.c", "tools-without-prompts").0,
            "path-bearing"
        );
        // Prompt examples returned verbatim. The examples are disjoint from every
        // digest, so grounding catches them with no copy of the example list.
        assert_eq!(
            refusal("Fix cursor loss after descend", "tools-without-prompts").0,
            "ungrounded"
        );
        assert_eq!(
            refusal("Wire schema migration backfill", "parts-list-tail").0,
            "ungrounded"
        );
        // The `lag/2a4460f9` cluster, against the digest of the session that was
        // actually about a command-line calculator.
        for headline in [
            "Fix lagging editor input",
            "Fix sed command lagging",
            "Fix typing lag in command-line calculator",
        ] {
            assert_eq!(refusal(headline, "parts-list-tail").0, "ungrounded");
        }
    }

    /// The false-positive guard. A correct headline for each frozen digest must
    /// survive, or the gate buys truth with silence.
    #[test]
    fn a_correct_headline_survives_every_frozen_digest() {
        for (headline, name) in [
            (
                "Trace release version tags for self update",
                "app-self-update",
            ),
            (
                "Explain maxwell equations and primality",
                "conversation-only",
            ),
            ("Diagnose debug splash screen hang", "debug-launch-stuck"),
            (
                "Repair file completion path canonicalization",
                "file-completion-paths",
            ),
            ("Chase composer typing lag", "fresh-directive"),
            (
                // `TugSetup` is the wording this frozen digest actually holds —
                // a headline is grounded against its own digest's words, so a
                // product rename can never be swept through this corpus.
                "Plan local model onboarding for TugSetup",
                "local-model-onboarding",
            ),
            (
                "Evaluate Bonsai models for local scribe",
                "local-model-scribe",
            ),
            ("Audit theme token contrast budgets", "noun-pile-bait"),
            ("Bundle tmux statically from source", "one-line-goal"),
            ("Author a command line calculator in C", "parts-list-tail"),
            (
                "Instrument the splash screen teardown block",
                "splash-screen-stall",
            ),
            (
                "Trace session overview cadence gate",
                "tools-without-prompts",
            ),
            (
                "Fix download resume and port shell router",
                "two-goals-one-session",
            ),
        ] {
            assert_grounded(headline, name);
        }
    }

    /// The threshold in `GROUNDED_MIN_*` is a choice, so it is pinned by the
    /// cases that rule the neighbouring values out rather than by assertion.
    ///
    /// Looser (one half) accepts a real defect: `Fix typing lag in command-line
    /// calculator` grounds 3 of its 5 subject words against `parts-list-tail`,
    /// because that session really was about a command-line calculator — the
    /// words it invents are the ones that matter. Stricter (three quarters)
    /// refuses correct headlines that reach for one word the digest spells
    /// differently, which is the staleness the gate must not buy.
    ///
    /// The third case is what the 64-character re-sweep added: the model's own
    /// answer, not a hand-written one, landing on the same lower edge. Three
    /// quarters is therefore ruled out by what ships, not only by a headline
    /// written to rule it out.
    #[test]
    fn the_grounding_threshold_is_the_loosest_that_still_refuses_the_defects() {
        // Two thirds is what ships.
        assert_eq!(GROUNDED_MIN_NUMERATOR, 2);
        assert_eq!(GROUNDED_MIN_DENOMINATOR, 3);

        let ratio = |headline: &str, name: &str| -> (usize, usize) {
            let digest = digest(name);
            let words = content_words(headline);
            let stopwords: HashSet<&str> = GROUNDING_STOPWORDS.iter().map(|w| stem(w)).collect();
            let subject: HashSet<&String> = words
                .iter()
                .skip(1)
                .filter(|w| !stopwords.contains(w.as_str()))
                .collect();
            let have: HashSet<String> = content_words(&digest).into_iter().collect();
            (
                subject.iter().filter(|w| have.contains(**w)).count(),
                subject.len(),
            )
        };

        // A defect that one half would accept and two thirds refuses.
        let (grounded, total) = ratio(
            "Fix typing lag in command-line calculator",
            "parts-list-tail",
        );
        assert!(
            grounded * 2 >= total,
            "one half would accept {grounded}/{total}"
        );
        assert!(
            grounded * 3 < total * 2,
            "two thirds must refuse {grounded}/{total}"
        );

        // A correct headline that three quarters would refuse and two thirds keeps.
        let (grounded, total) = ratio(
            "Explain maxwell equations and primality",
            "conversation-only",
        );
        assert!(
            grounded * 4 < total * 3,
            "three quarters would refuse {grounded}/{total}"
        );
        assert!(
            grounded * 3 >= total * 2,
            "two thirds must accept {grounded}/{total}"
        );

        // The resident model's own 64-character answer for `one-line-goal`, a
        // fair reading of a session that found the tmux mirror serving gzip
        // where the script expected xz. It carries six subject words to the
        // hand-written headline's three and still sits on the same edge.
        let (grounded, total) = ratio(
            "Fix tmux static bundle gzip to xz mismatch",
            "one-line-goal",
        );
        assert_eq!(
            (grounded, total),
            (4, 6),
            "the sweep's captured edge case moved"
        );
        assert!(
            grounded * 4 < total * 3,
            "three quarters would refuse {grounded}/{total}"
        );
        assert!(
            grounded * 3 >= total * 2,
            "two thirds must accept {grounded}/{total}"
        );
    }

    /// A digest writes filenames and a 56-character headline has room to name
    /// one, so a dotted token has to contribute the parts a headline says.
    ///
    /// Found by the re-sweep, not by reasoning: two of the resident model's
    /// twelve answers were refused as ungrounded while being plainly correct —
    /// `nocturne` and `aria` appear in the digest only inside
    /// `Read(tugdeck/styles/themes/nocturne.css)`, and `vite config` only
    /// inside `Read(vite.config.ts)`. No threshold reaches that; both would
    /// need a value loose enough to admit the three-fifths defect.
    #[test]
    fn a_headline_grounds_against_a_filename_the_digest_only_spells_dotted() {
        assert_grounded(
            "Audit theme contrast in nocturne and aria css",
            "noun-pile-bait",
        );
        assert_grounded(
            "Diagnose splash screen stall from vite config hold",
            "splash-screen-stall",
        );
        // The whole token survives beside its parts, so a headline naming the
        // file exactly still matches — the reason the dot is not simply added
        // to the split set.
        assert_eq!(
            content_words("Read(calc.c)"),
            ["read", "calc.c", "calc", "c"]
        );
    }

    /// The refusal rate the gate would produce over real model answers, printed
    /// rather than asserted.
    ///
    /// Reads `/tmp/register-<pack>.json` as written by `run.py --json`, so it is a
    /// no-op wherever those captures are absent — which is everywhere except a
    /// machine that has just run the register bake-off. It exists because the
    /// refusal rate is otherwise only observable from a live session, and a
    /// threshold chosen against thirteen hand-written correct headlines deserves a
    /// look at what the models actually write.
    ///
    ///   cargo nextest run -p tugcast the_refusal_rate --nocapture
    #[test]
    fn the_refusal_rate_over_captured_answers() {
        let corpus = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/model-eval/corpus");
        let mut looked = 0;
        for entry in std::fs::read_dir("/tmp").into_iter().flatten().flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if !name.starts_with("register-") || !name.ends_with(".json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            // `run.py --json` writes the scored rows as a bare array; each row
            // carries `name` (the corpus entry) and `headline` (the normalized
            // answer) among the rubric's own fields.
            let Ok(rows) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
                continue;
            };
            looked += 1;
            let mut refused = 0;
            let mut total = 0;
            for row in rows {
                let Some(case) = row.get("name").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(headline) = row.get("headline").and_then(|v| v.as_str()) else {
                    continue;
                };
                // Which lane wrote the row decides both the fixture and the
                // mode. Grounding a retrospective as an intent would refuse
                // every past-tense opener that spells a tool name — `Edited`,
                // `Read` — and report the gate's own mode error as the pack's
                // refusal rate. A row without the field predates the lane and
                // is an intent by construction.
                let retrospective = row
                    .get("retrospective")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let (fixture, mode) = if retrospective {
                    ("done", GroundingMode::Retrospective)
                } else {
                    ("digest", GroundingMode::Intent)
                };
                let Ok(digest) =
                    std::fs::read_to_string(corpus.join(format!("{case}.{fixture}.txt")))
                else {
                    continue;
                };
                total += 1;
                if let GroundingVerdict::Ungrounded { rule, detail } =
                    ground_headline(headline, &digest, mode)
                {
                    refused += 1;
                    println!("REFUSED {name} {case}: {headline:?} — {rule} ({detail})");
                }
            }
            if total > 0 {
                println!("RATE {name}: {refused}/{total} refused");
            }
        }
        if looked == 0 {
            println!("no /tmp/register-*.json captures; nothing to rate");
        }
    }

    /// A bare filename is a proper name, not a path — `score.py`'s rubric exempts
    /// identifiers and dotted paths, and the gate must not contradict it.
    #[test]
    fn a_bare_filename_is_allowed_where_a_path_is_not() {
        assert_grounded(
            "Trace session_overview.rs cadence gate",
            "tools-without-prompts",
        );
        assert_eq!(
            refusal(
                "Trace tugcast/src/feeds cadence gate",
                "tools-without-prompts"
            )
            .0,
            "path-bearing"
        );
    }

    /// The digest's own activity lines are the tool-name set, so a new Claude
    /// tool needs no change here.
    #[test]
    fn tool_names_come_from_activity_lines_only() {
        let names = digest_tool_names(&digest("parts-list-tail"));
        assert_eq!(
            names,
            ["writ", "bash"].iter().map(|s| s.to_string()).collect()
        );

        // `fresh-directive`'s *right now* section is the newest ask, verbatim,
        // under an activity heading — which is what makes the shape test load
        // bearing rather than section-awareness alone.
        let names = digest_tool_names(&digest("fresh-directive"));
        assert_eq!(
            names,
            ["read", "edit", "bash"]
                .iter()
                .map(|s| s.to_string())
                .collect()
        );
        for ask_word in ["good", "now", "chase", "typing", "lag", "composer"] {
            assert!(
                !names.contains(ask_word),
                "{ask_word} entered the tool-name set"
            );
        }
    }

    /// The poisoned-set regression, direct: `Fix` is the most common opener in
    /// the corpus by a wide margin, and an unscoped parse would make it
    /// unemittable for any session whose ask happens to open on the same word.
    #[test]
    fn an_ask_verb_does_not_become_a_tool_name() {
        let digest = compose_digest(
            &["fix the typing lag in the composer".to_string()],
            &["Read(tugdeck/src/components/tugways/tug-prompt-entry.tsx)".to_string()],
            1,
            false,
        )
        .expect("describes something");
        assert_eq!(
            digest_tool_names(&digest),
            ["read"].iter().map(|s| s.to_string()).collect()
        );
        assert_eq!(
            ground_headline("Fix composer typing lag", &digest, GroundingMode::Intent),
            GroundingVerdict::Grounded
        );
    }

    /// The gate must never read its OWN clip marker as the defect it is looking
    /// for. `…` in a token means the model quoted a truncated path out of the
    /// digest — but the register normalizer appends exactly that character when
    /// an answer runs past the budget, so grounding the clipped text refused
    /// every over-long description as `path-bearing`. On 2026-08-09 that was 101
    /// of the day's 112 refusals, and the Lens showed a description frozen for as
    /// long as the model kept writing long.
    #[test]
    fn an_over_budget_answer_is_not_refused_for_the_gate_s_own_clip_marker() {
        let digest = compose_digest(
            &[
                "align the session description and pulse activity indent flush \
                 with the title across the picker, the title bar, and the Lens"
                    .to_string(),
            ],
            &["Edit(tugdeck/src/components/tugways/tug-session-row.css)".to_string()],
            1,
            false,
        )
        .expect("describes something");
        let answer = "Align the session description and pulse activity indent \
                      flush with the title across the picker, the title bar, and the Lens";
        let report = synopsis_register_report(answer);
        assert!(report.clipped, "the fixture must exercise the clip");
        assert!(report.text.ends_with('…'));

        assert_eq!(
            ground_headline(&report.unclipped, &digest, GroundingMode::Intent),
            GroundingVerdict::Grounded
        );
        // The same line judged clipped is what the defect looked like. Pinned so
        // a caller that goes back to grounding `text` fails here rather than in
        // a log nobody reads.
        assert!(matches!(
            ground_headline(&report.text, &digest, GroundingMode::Intent),
            GroundingVerdict::Ungrounded {
                rule: "path-bearing",
                ..
            }
        ));
    }

    /// Restating one tool line is the intent/activity collapse the strip showed:
    /// the intent line says what the digest already said the session is doing,
    /// instead of naming what it is for.
    #[test]
    fn restating_a_single_tool_line_is_refused() {
        // Every word but the verb comes from `Bash(cargo nextest run
        // session_overview)`, which is one activity line of this digest.
        assert_eq!(
            refusal(
                "Trace cargo nextest session overview",
                "tools-without-prompts"
            )
            .0,
            "activity-restatement"
        );
        // The words that make a headline about *purpose* rather than about the
        // command are exactly what keeps it clear of the rule.
        assert_grounded(
            "Trace session overview cadence gate",
            "tools-without-prompts",
        );
    }

    /// An empty headline is the gate's business too, so no caller needs a
    /// pre-check for it.
    #[test]
    fn an_empty_headline_is_refused_by_the_gate_itself() {
        for text in ["", "   ", "\n"] {
            assert_eq!(refusal(text, "one-line-goal").0, "empty");
        }
    }

    /// The live failure this budget exists for: the model obeyed every other
    /// rule and still dragged a parts list behind the verb. The cut fires on
    /// overflow, so both of these run past the budget to reach it.
    #[test]
    fn a_parts_list_tail_is_cut_at_its_joiner() {
        assert_eq!(
            headline_register(
                "Author command-line calculator with makefile and readme and integration tests"
            ),
            "Author command-line calculator"
        );
        assert_eq!(
            headline_register(
                "Salvage corrupted ledger and harden every writable open path in tugcore"
            ),
            "Salvage corrupted ledger"
        );
    }

    /// The headline the old word budget mangled for no reason: nine words that
    /// say the work and fit the strip. Nothing touches it now.
    #[test]
    fn a_many_worded_headline_inside_the_budget_is_left_alone() {
        let headline = "Wire grader bands into composed submit path for shell";
        assert_eq!(headline.split_whitespace().count(), 9);
        assert!(headline.chars().count() <= MAX_HEADLINE_CHARS);
        assert_eq!(headline_register(headline), headline);
    }

    #[test]
    fn a_headline_inside_the_budget_is_left_alone() {
        for headline in [
            "Fix pulse overview never emitting",
            "Port shell router to async",
            "Hunt focus drift in Lens",
            // A joiner inside the budget is not a cut site.
            "Wire cadence gate and emit line",
        ] {
            assert_eq!(headline_register(headline), headline);
        }
    }

    /// With nothing to hang a cut on, the trim yields and leaves the string for
    /// `clip` — one ellipsis reads better than an amputation plus an ellipsis.
    #[test]
    fn an_overlong_headline_with_no_joiner_is_left_for_the_clip() {
        let raw = "Fix sparkline idle burn regression across every open session everywhere";
        assert!(raw.chars().count() > MAX_HEADLINE_CHARS);
        assert_eq!(trim_tail_to_char_budget(raw), raw);
        assert!(headline_register(raw).ends_with('…'));
    }

    /// Cutting at a joiner that leaves one or two words would trade a long
    /// headline for a meaningless one, so the trim yields instead.
    #[test]
    fn a_joiner_too_early_to_cut_at_is_not_cut_at() {
        let raw = "Fix and harden the resume path across every backend on every platform";
        assert!(raw.chars().count() > MAX_HEADLINE_CHARS);
        assert_eq!(trim_tail_to_char_budget(raw), raw);
    }

    /// A cut that still overruns buys nothing — and since every later joiner
    /// cuts later still, one that cannot reach the budget means none can. The
    /// text goes to `clip` whole rather than amputated *and* clipped.
    #[test]
    fn a_cut_that_cannot_reach_the_budget_is_not_taken() {
        let raw = "Reconcile aaaaaaaaaaa bbbbbbbbbbb ccccccccccc ddddddddddd eeeeeeeeeee and ffff";
        let joiner_cut = "Reconcile aaaaaaaaaaa bbbbbbbbbbb ccccccccccc ddddddddddd eeeeeeeeeee";
        assert!(joiner_cut.chars().count() > MAX_HEADLINE_CHARS);
        assert_eq!(trim_tail_to_char_budget(raw), raw);
    }

    /// A headline inside the budget is whatever the model wrote, however many
    /// words that took and whatever joiners sit inside it.
    #[test]
    fn the_trim_does_not_fire_inside_the_budget() {
        for raw in [
            "Wire the grammar grader bands into the composed submit path",
            "Salvage the ledger and harden the open path",
        ] {
            assert_eq!(trim_tail_to_char_budget(raw), raw);
        }
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

    /// The whole point of the split: the newest ask stands in its own labeled
    /// section, after the goal it redirects, so a small model can tell the two
    /// apart at a glance instead of reading three bullets under one heading.
    #[test]
    fn a_re_aimed_session_names_its_goal_and_its_current_ask_in_order() {
        let digest = compose_digest(
            &[
                "make the watch loop resilient".to_string(),
                "look at the parser instead".to_string(),
            ],
            &["Bash(cargo build)".to_string()],
            0,
            false,
        )
        .unwrap();
        assert!(digest.starts_with(
            "The standing goal:\n- make the watch loop resilient\n\n\
             The current ask:\n- look at the parser instead\n"
        ));
    }

    /// Only the newest ask reaches the digest. The prompts between it and the
    /// pinned first are the same middle slice `digest_prompts` trims for, and
    /// letting them accumulate is what let an old ask outvote a fresh one.
    #[test]
    fn only_the_newest_ask_reaches_the_current_ask_section() {
        let digest = compose_digest(
            &[
                "make the watch loop resilient".to_string(),
                "actually start with the parser".to_string(),
                "no, the shell router first".to_string(),
            ],
            &[],
            0,
            false,
        )
        .unwrap();
        assert!(digest.contains("The current ask:\n- no, the shell router first\n"));
        assert!(!digest.contains("actually start with the parser"));
    }

    /// A session that has said one thing has a goal and nothing to redirect it.
    #[test]
    fn a_young_session_carries_a_standing_goal_alone() {
        let digest = compose_digest(
            &["bundle tmux statically from source".to_string()],
            &["Bash(cargo build)".to_string()],
            0,
            false,
        )
        .unwrap();
        assert!(digest.contains("The standing goal:\n- bundle tmux statically from source\n"));
        assert!(!digest.contains(CURRENT_ASK_HEADING));
    }

    #[test]
    fn a_digest_with_only_tool_use_is_still_a_digest() {
        let digest = compose_digest(&[], &["Bash(cargo build)".to_string()], 0, false).unwrap();
        assert!(digest.contains("Bash(cargo build)"));
        assert!(!digest.contains(STANDING_GOAL_HEADING));
        assert!(!digest.contains(CURRENT_ASK_HEADING));
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
        state.record_now(SessionBeat::Turn);
        state.record_now(SessionBeat::Tool("Read(a.rs)".to_string()));
        state.record_now(SessionBeat::Shell(None));
        state.record_now(SessionBeat::Said("said: porting the router".to_string()));
        assert_eq!(state.activity_since_emit, 2);
        assert_eq!(state.new_beats, 4);
    }

    /// The digest is a compressed transcript: prose, tool, and shell lines in
    /// one stream, in the order they happened.
    #[test]
    fn record_interleaves_the_transcript_vocabulary_in_arrival_order() {
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Said("said: porting the router".to_string()));
        state.record_now(SessionBeat::Tool("Edit(router.rs)".to_string()));
        state.record_now(SessionBeat::Shell(Some("$ cargo build".to_string())));
        state.record_now(SessionBeat::Shell(None));
        state.record_now(SessionBeat::Turn);
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
        state.record_now(SessionBeat::Turn);
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
        state.observe_now(prose("m1", 0, true, "I will widen the "));
        assert!(state.activity.is_empty());
        state.observe_now(prose("m1", 0, true, "beat enum first. Then the"));
        assert_eq!(state.activity.len(), 1);
        assert_eq!(
            state.activity.front().unwrap(),
            "said: I will widen the beat enum first."
        );
        state.observe_now(prose("m1", 0, true, " cadence, then the digest."));
        state.observe_now(prose("m1", 0, true, " And more after that."));
        assert_eq!(state.activity.len(), 1);
    }

    /// A block that never crosses the threshold still gets its line — from the
    /// next block's arrival, or from either kind of turn end.
    #[test]
    fn a_short_block_beats_at_finalization() {
        // Finalized by a delta for a new key.
        let mut state = SessionState::new(Instant::now());
        state.observe_now(prose("m1", 0, true, "Short answer"));
        assert!(state.activity.is_empty());
        state.observe_now(prose("m1", 1, true, "Next block starts"));
        assert_eq!(state.activity.len(), 1);
        assert_eq!(state.activity.front().unwrap(), "said: Short answer");

        // Finalized by turn_complete / turn_cancelled — same event shape.
        for _ in 0..2 {
            let mut state = SessionState::new(Instant::now());
            state.observe_now(prose("m1", 0, true, "Short answer"));
            state.observe_now(turn());
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
        state.observe_now(prose(
            "m1",
            0,
            true,
            "This sentence has already beaten, yes. And",
        ));
        assert_eq!(state.activity.len(), 1);
        state.observe_now(prose("m1", 1, true, "still streaming"));
        assert_eq!(state.beaten.len(), 1);
        state.record_now(SessionBeat::Shell(None));
        assert!(state.open.is_some());
        assert_eq!(state.beaten.len(), 1);
        assert_eq!(state.activity.len(), 1);
    }

    /// The reconnect snapshot re-sends whole blocks as `is_partial: false`;
    /// ones the live stream already narrated stay silent, unseen ones beat.
    #[test]
    fn a_terminal_frame_dedupes_against_beaten_keys() {
        let mut state = SessionState::new(Instant::now());
        state.observe_now(prose(
            "m1",
            0,
            true,
            "Wiring the shell subscription now. More",
        ));
        assert_eq!(state.activity.len(), 1);

        state.observe_now(prose(
            "m1",
            0,
            false,
            "Wiring the shell subscription now. More prose after it.",
        ));
        assert_eq!(state.activity.len(), 1, "a beaten key must not beat twice");

        state.observe_now(prose("m2", 0, false, "A block the live stream never sent."));
        assert_eq!(state.activity.len(), 2);
        assert_eq!(
            state.activity.back().unwrap(),
            "said: A block the live stream never sent."
        );
        state.observe_now(prose("m2", 0, false, "A block the live stream never sent."));
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
            state.observe_now(prose("m1", 0, true, &"x".repeat(100)));
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

    /// The live failure the trim was built for: a parts list dragged behind an
    /// otherwise correct headline, far enough to overrun the budget.
    #[test]
    fn a_parts_list_tail_reports_a_trim_and_no_clip() {
        let report = headline_register_report(
            "Author command-line calculator with makefile and readme and integration tests",
        );
        assert_eq!(report.text, "Author command-line calculator");
        assert!(report.normalized);
        assert!(report.trimmed);
        assert!(!report.clipped);
    }

    /// The two flags name different failures: with no joiner to cut at, the
    /// overrun is the clip's to report and the trim's to keep quiet about.
    #[test]
    fn an_overrun_with_no_joiner_reports_a_clip_and_no_trim() {
        let report = headline_register_report(
            "Fix aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff",
        );
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
            state.record_now(SessionBeat::Tool(format!("Bash(round {i})")));
        }
        assert_eq!(state.activity.len(), MAX_ACTIVITY_LINES);
        assert_eq!(state.activity.front().unwrap(), "Bash(round 5)");
        assert_eq!(state.new_beats as usize, MAX_ACTIVITY_LINES + 5);
    }

    #[test]
    fn the_frame_is_a_scoped_overview_pulse_line() {
        let frame = overview_frame(
            "sess-1",
            "Wiring the watch loop.",
            3,
            1_700_000_000_000,
            None,
        );
        assert_eq!(frame.feed_id, FeedId::PULSE);
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["type"], "pulse");
        assert_eq!(body["kind"], "overview");
        assert_eq!(body["text"], "Wiring the watch loop.");
        assert_eq!(body["scopes"], serde_json::json!(["sess-1"]));
        assert_eq!(body["beat"], 3);
        assert_eq!(body["at"], 1_700_000_000_000i64);
        // A live intent carries no phase at all, so nothing downstream has to
        // learn a value for the ordinary case.
        assert!(body.get("phase").is_none());
    }

    #[test]
    fn a_retrospective_frame_is_marked_done() {
        let frame = overview_frame("sess-1", "Bundled tmux from source", 4, 1, Some("done"));
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["kind"], "overview");
        assert_eq!(body["phase"], "done");
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

    /// Any record the prompt extractor does not read as an ask. Under the
    /// barrier doctrine a non-prompt record IS a response, which is what
    /// closes a stretch during a priming pass.
    fn assistant_line(text: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-07-29T00:00:00.000Z",
            "message": { "role": "assistant", "content": text },
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
        std::fs::write(&path, "").unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                user_line("build the emitter"),
                r#"{"type":"assistant","message":{}}"#
            ),
        )
        .unwrap();
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

    /// The barrier drops the asks but keeps the read position, so a
    /// consumed ask is gone for good rather than re-read on the next
    /// refresh, while an ask appended after the barrier arrives normally.
    #[test]
    fn the_prompt_cache_barrier_forgets_asks_but_not_its_place() {
        let path = cache_tmp("barrier");
        std::fs::write(&path, "").unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);
        std::fs::write(&path, format!("{}\n", user_line("the finished request"))).unwrap();
        cache.refresh(&path);
        assert_eq!(cache.first.as_deref(), Some("the finished request"));

        cache.barrier();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(format!("{}\n", user_line("the new request")).as_bytes())
            .unwrap();
        cache.refresh(&path);
        assert_eq!(
            cache.digest_prompts(),
            ["the new request"].map(String::from),
            "only the new stretch's ask may survive the barrier"
        );
        assert_eq!(
            cache.first.as_deref(),
            Some("the new request"),
            "the new stretch's opening ask takes the pinned slot"
        );
        // The barrier is the STRETCH's boundary, not the session's. What the
        // session set out to do outlives it, and the ask it answered became an
        // arc entry the moment the next ask arrived — the user's messages are
        // the boundaries the description reads, and the headline's digest has
        // no way to see them.
        assert_eq!(
            cache.opening.as_deref(),
            Some("the finished request"),
            "the session's opening ask survives every barrier"
        );
        assert_eq!(
            cache.current_ask.as_deref(),
            Some("the new request"),
            "the newest ask is the session's current work item"
        );
        assert_eq!(
            cache.arc.iter().cloned().collect::<Vec<_>>(),
            ["the finished request"].map(String::from),
            "the answered ask is kept as the session's arc"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// A restart reads the whole transcript at once, and the barrier doctrine
    /// discards every ask above a response. It must not discard the SESSION's
    /// memory with them: a priming pass reconstructs the opening ask and the
    /// arc from exactly the file it is already reading, so a tugcast restart
    /// does not cost a session its description's subject.
    #[test]
    fn priming_reconstructs_the_session_arc_from_the_transcript() {
        let path = cache_tmp("priming-arc");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n{}\n{}\n",
                user_line("audit the ledger's migrations"),
                assistant_line("looked at them"),
                user_line("now repair the wedge it found"),
                assistant_line("repaired"),
                user_line("write the doctrine entry"),
            ),
        )
        .unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);

        // The live stretch is the trailing run of unanswered asks — unchanged.
        assert_eq!(
            cache.first.as_deref(),
            Some("write the doctrine entry"),
            "the stretch's goal is still the trailing unanswered ask"
        );
        // And the session's own history came back with it.
        assert_eq!(
            cache.opening.as_deref(),
            Some("audit the ledger's migrations"),
            "the file's first ask is the session's opening ask"
        );
        assert_eq!(
            cache.current_ask.as_deref(),
            Some("write the doctrine entry"),
            "the newest ask in the file is the current work item"
        );
        assert_eq!(
            cache.arc.iter().cloned().collect::<Vec<_>>(),
            [
                "audit the ledger's migrations",
                "now repair the wedge it found"
            ]
            .map(String::from),
            "every prior ask is an entry in the arc"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// The tiny-movie case, and the reason the arc is built at ask granularity:
    /// a user who types the next job into a WARM session never crosses an idle
    /// barrier, and under stretch granularity the whole afternoon collapsed
    /// into the first job's ask. The user's messages are the boundaries
    /// between work items — three jobs typed back-to-back are three items,
    /// with the newest as the current one.
    #[test]
    fn asks_in_a_warm_session_are_work_item_boundaries() {
        let path = cache_tmp("warm-asks");
        std::fs::write(&path, "").unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);
        for ask in [
            "clean up the usage sheet",
            "clean up the gutter selection",
            "fix the focus caret in Lens",
        ] {
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(format!("{}\n{}\n", user_line(ask), assistant_line("done")).as_bytes())
                .unwrap();
            cache.refresh(&path);
        }

        assert_eq!(
            cache.current_ask.as_deref(),
            Some("fix the focus caret in Lens"),
            "the newest ask is the current work item, no barrier required"
        );
        assert_eq!(
            cache.arc.iter().cloned().collect::<Vec<_>>(),
            ["clean up the usage sheet", "clean up the gutter selection"].map(String::from),
            "each earlier ask closed into the arc when the next one arrived"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// The description's digest leads with the NEWEST work item and files
    /// everything older behind it. It shipped the other way — opener first,
    /// arc in chronological order — and the line it produced named a session's
    /// first job ahead of the work actually under way. The headline digest is
    /// still the stretch's; this one is the session's, newest first, with the
    /// live headline filed under a heading that says it is background.
    #[test]
    fn the_description_digest_leads_with_the_newest_work_item() {
        let digest = compose_synopsis_digest(
            Some("audit the ledger's migrations"),
            &[
                "audit the ledger's migrations".to_string(),
                "now repair the wedge".to_string(),
            ],
            Some("write the doctrine entry"),
            Some("Draft doctrine entry for ledger wedge"),
            Some("Audit and repair the ledger's migrations"),
        )
        .expect("a session with an ask has something to describe");

        // The newest ask opens the digest as the subject.
        assert!(digest.starts_with(SESSION_RECENT_HEADING));
        let recent = digest.split_once(SESSION_ARC_HEADING).expect("the arc").0;
        assert!(recent.contains("write the doctrine entry"));
        // Prior work follows; the opener is not repeated there, because it has
        // its own labelled section below — every ask appears exactly once.
        assert!(digest.contains("now repair the wedge"));
        assert_eq!(digest.matches("audit the ledger's migrations").count(), 1);
        // The opening comes AFTER the work items, labelled as context.
        assert!(digest.contains(SESSION_OPENING_HEADING));
        assert!(
            digest.find(SESSION_ARC_HEADING).unwrap()
                < digest.find(SESSION_OPENING_HEADING).unwrap(),
            "earlier work outranks the opening"
        );
        // The present is present, and labelled as background.
        let present = digest
            .split_once(SESSION_PRESENT_HEADING)
            .expect("the present section")
            .1;
        assert!(present.contains("Draft doctrine entry for ledger wedge"));
        // The standing line the model is revising closes it out.
        assert!(digest.contains(SESSION_PREVIOUS_HEADING));
        assert!(digest.contains("Audit and repair the ledger's migrations"));

        // Nothing said yet is nothing to describe: an honestly empty
        // description line beats a composed one about no evidence.
        assert!(compose_synopsis_digest(None, &[], None, Some("Fix things"), None).is_none());
    }

    /// Prior asks print newest first — the order the description weighs them
    /// in — and a one-ask session prints its one ask once, under the subject
    /// heading, with no context section restating it.
    #[test]
    fn the_description_digest_orders_prior_asks_newest_first() {
        let digest = compose_synopsis_digest(
            Some("first job"),
            &["first job".to_string(), "second job".to_string()],
            Some("third job"),
            None,
            None,
        )
        .expect("three asks are something to describe");
        let arc = digest
            .split_once(SESSION_ARC_HEADING)
            .expect("the arc section")
            .1
            .split_once(SESSION_OPENING_HEADING)
            .expect("the opening section")
            .0;
        assert_eq!(arc.trim(), "- second job", "newest prior ask leads the arc");

        let young =
            compose_synopsis_digest(Some("the only ask"), &[], Some("the only ask"), None, None)
                .expect("one ask is something to describe");
        assert!(young.starts_with(SESSION_RECENT_HEADING));
        assert_eq!(young.matches("the only ask").count(), 1);
        assert!(!young.contains(SESSION_OPENING_HEADING));
    }

    /// The description's register is a SUMMARY's, and the difference from the
    /// headline's is load-bearing: at the headline's budget, under the
    /// headline's joiner trim, the line cannot say more than a headline can —
    /// which is how it ended up printing one.
    #[test]
    fn the_description_register_keeps_what_a_headline_would_lose() {
        let long = "Rework how a session names itself and adopt it at every surface";
        let as_headline = headline_register_report(long);
        let as_description = synopsis_register_report(long);

        // The headline cuts at the joiner and clips; the description keeps the
        // whole sentence, because the half past `and` is the half that says how
        // far the work reaches.
        assert!(as_headline.text.chars().count() <= MAX_HEADLINE_CHARS);
        assert!(!as_headline.text.contains("every surface"));
        assert_eq!(as_description.text, long);
        assert!(as_description.text.chars().count() <= MAX_SYNOPSIS_CHARS);

        // Everything mechanical is still imposed: quotes, filler openers, the
        // leading article, the terminal period.
        let messy = "\"The user is working on the wedge recovery path.\"";
        assert_eq!(synopsis_register_report(messy).text, "wedge recovery path",);

        // And the budget really does clip — the line is chrome, not prose.
        let overlong = "x".repeat(MAX_SYNOPSIS_CHARS + 40);
        assert_eq!(
            synopsis_register_report(&overlong).text.chars().count(),
            MAX_SYNOPSIS_CHARS + 1,
            "clip marks what it dropped with one ellipsis"
        );
    }

    /// An emit that crossed the idle barrier in flight lands nothing: its
    /// headline never publishes, its digest and collapse mark never record,
    /// and its cache comes back with only the read position intact.
    #[test]
    fn an_emit_from_behind_the_barrier_lands_only_the_read_offset() {
        let mut sessions = HashMap::new();
        let mut state = SessionState::new(Instant::now());
        state.barrier_epoch = 1;
        sessions.insert("s1".to_string(), state);

        let mut cache = PromptCache {
            offset: 42,
            first: Some("the finished request".to_string()),
            ..Default::default()
        };
        cache.recent.push_back("the finished request".to_string());
        let outcome = EmitOutcome {
            session_id: "s1".to_string(),
            cache,
            caught_up_ask: None,
            seen_digest: Some("the old digest".to_string()),
            headline: Some("Doing the finished thing".to_string()),
            failed: false,
            retrospective: true,
            barrier_epoch: 0,
        };
        let (pulse_tx, mut pulse_rx) = broadcast::channel(8);
        apply_emit_outcome(
            outcome,
            &mut sessions,
            &mut BackOff::new(),
            &mut VecDeque::new(),
            &mut HashSet::new(),
            &pulse_tx,
            None,
        );

        let state = &sessions["s1"];
        assert_eq!(state.prompts.offset, 42, "the read position survives");
        assert!(
            state.prompts.first.is_none() && state.prompts.recent.is_empty(),
            "the asks do not"
        );
        assert!(state.last_digest.is_none());
        assert!(
            !state.collapsed,
            "a stale retrospective must not mark the new stretch collapsed"
        );
        assert!(
            pulse_rx.try_recv().is_err(),
            "no headline may publish from behind the barrier"
        );
    }

    /// A transcript that predates the cache is behind an unknown number of
    /// idle barriers: every ask a response follows was answered on a stretch
    /// this process never watched, and a restarted process must not haul it
    /// back into the digest. Only a trailing ask nothing has answered — the
    /// live stretch's opening — survives the first look, and lines appended
    /// after it read plainly, responses and all.
    #[test]
    fn a_first_look_keeps_only_the_trailing_unanswered_asks() {
        let path = cache_tmp("first-look");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                user_line("a request finished long ago"),
                r#"{"type":"assistant","message":{}}"#,
                user_line("the live request, not yet answered")
            ),
        )
        .unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);
        assert_eq!(
            cache.offset,
            std::fs::metadata(&path).unwrap().len(),
            "the first look consumes the whole file"
        );
        assert_eq!(
            cache.digest_prompts(),
            ["the live request, not yet answered"].map(String::from),
            "only the unanswered trailing ask survives the first look"
        );

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(
                format!(
                    "{}\n{}\n",
                    r#"{"type":"assistant","message":{}}"#,
                    user_line("a follow-up")
                )
                .as_bytes(),
            )
            .unwrap();
        cache.refresh(&path);
        assert_eq!(
            cache.digest_prompts(),
            ["the live request, not yet answered", "a follow-up"].map(String::from),
            "watched appends read plainly; a response no longer clears"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_partial_trailing_line_waits_for_its_newline() {
        let path = cache_tmp("partial");
        let complete = format!("{}\n", user_line("the whole first line"));
        let partial = user_line("a line still being written");
        let (head, tail) = partial.split_at(30);
        std::fs::write(&path, "").unwrap();

        let mut cache = PromptCache::default();
        cache.refresh(&path);
        std::fs::write(&path, format!("{complete}{head}")).unwrap();
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
        std::fs::write(&path, "").unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                user_line("the original goal"),
                user_line("its follow-up")
            ),
        )
        .unwrap();
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
            primed: true,
            first: Some("pinned".to_string()),
            recent: VecDeque::from(["recent".to_string()]),
            opening: Some("pinned".to_string()),
            current_ask: Some("pinned".to_string()),
            arc: VecDeque::new(),
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
            primed: true,
            first: Some("the goal".to_string()),
            recent: VecDeque::from(["the goal".to_string()]),
            opening: Some("the goal".to_string()),
            current_ask: Some("the goal".to_string()),
            arc: VecDeque::new(),
        };
        assert_eq!(cache.digest_prompts(), ["the goal"].map(String::from));

        // An older session: first + the recents, oldest of the middle gone.
        let cache = PromptCache {
            offset: 0,
            primed: true,
            first: Some("the goal".to_string()),
            recent: VecDeque::from([
                "a course correction".to_string(),
                "and a refinement".to_string(),
            ]),
            opening: Some("the goal".to_string()),
            current_ask: Some("the goal".to_string()),
            arc: VecDeque::new(),
        };
        assert_eq!(
            cache.digest_prompts(),
            ["the goal", "a course correction", "and a refinement"].map(String::from)
        );
    }

    // -----------------------------------------------------------------------
    // The loop, end to end
    // -----------------------------------------------------------------------

    use crate::shared_agent::{
        AgentSpec, AgentWorkerSpawner, JobSpec, SharedAgentPool, TurnRequest,
    };
    use std::io::Write;

    /// How the scripted agent answers one lane.
    #[derive(Clone, Copy)]
    enum Lane {
        /// Answer with this text.
        Says(&'static str),
        /// Fail the job, the way a refusal or a dead worker does.
        Refuses,
        /// Accept the turn and never answer it, so the job hits its ceiling.
        Mute,
    }

    /// The agent the overview asks, scripted per summarize lane.
    ///
    /// The two lanes must be answerable differently: an emit whose headline
    /// matches the one already on the strip is suppressed as unchanged, so an
    /// agent answering both lanes with one string would show a retrospective
    /// asked for and never published — indistinguishable from the collapse not
    /// firing.
    ///
    /// The script is swappable at runtime because several tests exercise the
    /// no-answer path first and install an answering agent afterward.
    #[derive(Clone)]
    struct FakeAgent {
        inner: Arc<std::sync::Mutex<FakeAgentScript>>,
    }

    struct FakeAgentScript {
        live: Lane,
        done: Lane,
        /// Each job's digest, so a test can assert what the model was shown.
        seen: Option<tokio::sync::mpsc::Sender<String>>,
    }

    /// The job table the overview is exercised against.
    ///
    /// Instruction bodies are bare markers rather than the shipped wording:
    /// these tests are about the emitter — which lane it picks, how it gates an
    /// answer, when it backs off — and pinning them to prompt prose would make
    /// every wording edit look like an emitter regression. The shipped
    /// instructions carry their own contract test in `shared_agent.rs`.
    static OVERVIEW_TEST_JOBS: &[JobSpec] = &[
        JobSpec {
            name: "summarize",
            instructions: "SUMMARIZE",
            timeout: Duration::from_secs(6),
            slow: None,
        },
        JobSpec {
            name: "summarize_done",
            instructions: "SUMMARIZE-DONE",
            timeout: Duration::from_secs(6),
            slow: None,
        },
    ];

    impl FakeAgent {
        fn new(live: Lane, done: Lane) -> Self {
            Self {
                inner: Arc::new(std::sync::Mutex::new(FakeAgentScript {
                    live,
                    done,
                    seen: None,
                })),
            }
        }

        /// Rewrite the script and take a fresh digest channel.
        fn script(&self, live: Lane, done: Lane) -> tokio::sync::mpsc::Receiver<String> {
            let (seen_tx, seen_rx) = tokio::sync::mpsc::channel::<String>(64);
            let mut inner = self.inner.lock().unwrap();
            inner.live = live;
            inner.done = done;
            inner.seen = Some(seen_tx);
            seen_rx
        }

        /// The same, in the shape most collapse tests want: a text per lane,
        /// `None` meaning that lane refuses.
        fn script_lanes(
            &self,
            live: Option<&'static str>,
            done: Option<&'static str>,
        ) -> tokio::sync::mpsc::Receiver<String> {
            let lane = |text: Option<&'static str>| match text {
                Some(text) => Lane::Says(text),
                None => Lane::Refuses,
            };
            self.script(lane(live), lane(done))
        }

        fn pool(&self) -> Arc<SharedAgentPool> {
            SharedAgentPool::new(
                AgentSpec {
                    name: "test",
                    model: Arc::new(|| "test-model".to_string()),
                    jobs: OVERVIEW_TEST_JOBS,
                    max_workers: 2,
                },
                Arc::new(self.clone()) as Arc<dyn AgentWorkerSpawner>,
            )
        }
    }

    impl AgentWorkerSpawner for FakeAgent {
        fn spawn(&self, _model: String) -> Result<tokio::sync::mpsc::Sender<TurnRequest>, String> {
            let (tx, mut rx) = tokio::sync::mpsc::channel::<TurnRequest>(8);
            let inner = Arc::clone(&self.inner);
            tokio::spawn(async move {
                while let Some(TurnRequest { turn, reply }) = rx.recv().await {
                    // The turn is `<instructions>\n\n<digest>`, so the marker
                    // says which lane asked and the remainder is the digest.
                    let text = turn.text;
                    let (marker, digest) = text.split_once("\n\n").unwrap_or((text.as_str(), ""));
                    let (lane, seen) = {
                        let script = inner.lock().unwrap();
                        let lane = if marker == "SUMMARIZE-DONE" {
                            script.done
                        } else {
                            script.live
                        };
                        (lane, script.seen.clone())
                    };
                    if let Some(seen) = seen {
                        let _ = seen.send(digest.to_string()).await;
                    }
                    match lane {
                        Lane::Says(text) => {
                            let _ = reply.send(Ok(text.to_string()));
                        }
                        Lane::Refuses => {
                            let _ = reply.send(Err("guardrail refusal".to_string()));
                        }
                        // Hold the reply forever; the pool's ceiling ends the
                        // wait, exactly as a wedged worker would.
                        Lane::Mute => std::mem::forget(reply),
                    }
                }
            });
            Ok(tx)
        }
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
        /// Each summarize job's digest, in order — what the model saw.
        /// `None` when the harness started without an agent.
        digests: Option<tokio::sync::mpsc::Receiver<String>>,
        /// The scripted agent, so a test can rewrite its answers after
        /// exercising an earlier path.
        agent: FakeAgent,
        cancel: CancellationToken,
        _tmp: PathBuf,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.cancel.cancel();
            let _ = std::fs::remove_dir_all(&self._tmp);
        }
    }

    /// Far enough out that the collapse arm never fires in a test that is not
    /// about it — every one of these harnesses runs a session to rest and would
    /// otherwise pick up a retrospective it never asked for.
    const NEVER_COLLAPSE: Duration = Duration::from_secs(3_600);

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
                idle_collapse_after: NEVER_COLLAPSE,
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
        // `with_model` false starts the agent refusing every job and hands the
        // test no digest channel — the same observable posture as no agent at
        // all, and the one several tests start from before scripting an agent
        // that answers. The genuinely absent handle is covered directly by
        // `an_absent_agent_emits_no_headline`.
        let lane = match answer {
            Some(text) => Lane::Says(text),
            None => Lane::Refuses,
        };
        let agent = FakeAgent::new(lane, lane);
        let digests = with_model.then(|| agent.script(lane, lane));
        let cancel = CancellationToken::new();
        let config = SessionOverviewConfig {
            code_tx: code_tx.clone(),
            shell_tx: shell_tx.clone(),
            submission_tx: submission_tx.clone(),
            pulse_tx,
            ledger: None,
            control_tx: None,
            tenant_enabled: Arc::new(move || tenant_on),
            pulse_enabled: Arc::new(move || pulse_on),
            shared_agent: Some(agent.pool()),
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
            agent,
            cancel,
            _tmp: tmp,
        }
    }

    /// A config carrying nothing but what `take_synopsis_job` reads: a ledger
    /// (its presence is the gate) and a resolver (its answer is the row key).
    fn synopsis_config(
        ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
        claude_id: Option<&'static str>,
    ) -> SessionOverviewConfig {
        let (code_tx, _) = broadcast::channel(4);
        let (shell_tx, _) = broadcast::channel(4);
        let (submission_tx, _) = broadcast::channel(4);
        let (pulse_tx, _) = broadcast::channel(4);
        SessionOverviewConfig {
            code_tx,
            shell_tx,
            submission_tx,
            pulse_tx,
            ledger,
            control_tx: None,
            tenant_enabled: Arc::new(|| true),
            pulse_enabled: Arc::new(|| true),
            shared_agent: None,
            identity: SessionIdentity {
                resolver: Arc::new(move |_| claude_id.map(str::to_owned)),
                project_dir: Arc::new(|_| Some("/tmp/project".to_string())),
                claude_projects_root: PathBuf::from("/tmp/tugcast-tests"),
            },
            cadence: Cadence::default(),
        }
    }

    /// A session state carrying just enough for a description to be composable:
    /// an opening ask. Without one there is no undertaking to describe and
    /// `take_synopsis_job` correctly declines, which is a different thing from
    /// the debounce these tests are about.
    fn described_session(now: Instant, opening: &str) -> SessionState {
        let mut state = SessionState::new(now);
        state.prompts.opening = Some(opening.to_string());
        state.prompts.first = Some(opening.to_string());
        state
    }

    #[test]
    fn the_description_asks_far_more_slowly_than_the_headline() {
        let ledger = Arc::new(
            crate::session_ledger::SessionLedger::open_in_memory().expect("in-memory ledger"),
        );
        let config = synopsis_config(Some(ledger), Some("claude-1"));
        let cancel = CancellationToken::new();
        let start = Instant::now();
        let mut sessions = HashMap::new();
        sessions.insert(
            "s1".to_string(),
            described_session(start, "bundle tmux statically from source"),
        );

        // The first emit asks.
        assert!(take_synopsis_job("s1", &mut sessions, &config, &cancel, start).is_some());
        // Every emit inside the window is refused — the headline moves on its
        // own 8s floor and the description must not follow it.
        let soon = start + SYNOPSIS_MIN_INTERVAL - Duration::from_secs(1);
        assert!(take_synopsis_job("s1", &mut sessions, &config, &cancel, soon).is_none());
        // Past the window it asks again.
        let later = start + SYNOPSIS_MIN_INTERVAL;
        let job = take_synopsis_job("s1", &mut sessions, &config, &cancel, later)
            .expect("due past the interval");
        // The digest is the SESSION's, composed here — not the headline's
        // digest handed over under a different question.
        assert!(job.digest.contains(SESSION_OPENING_HEADING));
        assert!(job.digest.contains("bundle tmux statically from source"));
        // The row key is claude's id, not the tug id: a fork's description must
        // not land on its parent's row.
        assert_eq!(job.row_id, "claude-1");
        assert_eq!(job.session_id, "s1");
    }

    #[test]
    fn a_session_with_nothing_to_describe_is_not_asked_and_keeps_its_window() {
        let ledger = Arc::new(
            crate::session_ledger::SessionLedger::open_in_memory().expect("in-memory ledger"),
        );
        let config = synopsis_config(Some(ledger), Some("claude-1"));
        let cancel = CancellationToken::new();
        let now = Instant::now();
        let mut sessions = HashMap::new();
        sessions.insert("s1".to_string(), SessionState::new(now));
        // No opening ask, no arc, no goal: there is no undertaking, and an
        // honestly empty description line is the right answer.
        assert!(take_synopsis_job("s1", &mut sessions, &config, &cancel, now).is_none());
        // And the debounce was not spent on a question that was never put — the
        // moment the session says something, the very next emit asks.
        sessions.get_mut("s1").expect("seeded").prompts.opening =
            Some("audit the ledger's migrations".to_string());
        assert!(take_synopsis_job("s1", &mut sessions, &config, &cancel, now).is_some());
    }

    #[test]
    fn an_unresolvable_session_is_not_asked_at_all() {
        let ledger = Arc::new(
            crate::session_ledger::SessionLedger::open_in_memory().expect("in-memory ledger"),
        );
        let config = synopsis_config(Some(ledger), None);
        let cancel = CancellationToken::new();
        let now = Instant::now();
        let mut sessions = HashMap::new();
        sessions.insert(
            "s1".to_string(),
            described_session(now, "port the shell router"),
        );
        // The resolver answers `None` both for "no such entry" and for a
        // contended lock, so there is no row this description is known to
        // belong to. Guessing the tug id would name a fork's PARENT row.
        assert!(take_synopsis_job("s1", &mut sessions, &config, &cancel, now).is_none());
        // And the window was not spent: the moment the resolver can answer, the
        // very next emit asks rather than waiting out a minute it never used.
        let config = synopsis_config(
            Some(Arc::new(
                crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"),
            )),
            Some("claude-1"),
        );
        let job = take_synopsis_job("s1", &mut sessions, &config, &cancel, now)
            .expect("due as soon as the row is known");
        assert_eq!(job.row_id, "claude-1");
    }

    #[test]
    fn no_ledger_means_no_description_to_persist() {
        let config = synopsis_config(None, Some("claude-1"));
        let cancel = CancellationToken::new();
        let now = Instant::now();
        let mut sessions = HashMap::new();
        sessions.insert("s1".to_string(), described_session(now, "trace the wedge"));
        assert!(take_synopsis_job("s1", &mut sessions, &config, &cancel, now).is_none());
        // A session the sweep has already dropped is likewise nothing to do.
        let config = synopsis_config(
            Some(Arc::new(
                crate::session_ledger::SessionLedger::open_in_memory().expect("ledger"),
            )),
            Some("claude-1"),
        );
        assert!(take_synopsis_job("gone", &mut sessions, &config, &cancel, now).is_none());
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
        let mut h = start(Some("Harden the watch loop."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(turn_complete_frame("s1")).unwrap();
        let overview = next_overview(&mut h.pulse_rx).await.expect("an overview");
        assert_eq!(overview["kind"], "overview");
        assert_eq!(overview["text"], "Harden the watch loop");
        assert_eq!(overview["scopes"], serde_json::json!(["s1"]));
    }

    /// A session doing only `$` work — nothing on CODE_OUTPUT at all — reaches
    /// the cadence and earns an overview. This is the wire the overview never
    /// listened to: a typed command used to contribute neither a digest line
    /// nor a cadence advance.
    #[tokio::test(start_paused = true)]
    async fn a_shell_only_session_still_gets_an_overview() {
        let mut h = start(Some("Harden the watch loop."), true, true, true);
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
        assert_eq!(overview["text"], "Harden the watch loop");
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
            idle_collapse_after: NEVER_COLLAPSE,
        }
    }

    async fn next_digest(rx: &mut tokio::sync::mpsc::Receiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("a summarize request")
            .expect("the host is alive")
    }

    /// The next summarize request, or `None` once the host has gone quiet — for
    /// counting how many requests a stretch produced rather than awaiting a
    /// known number of them.
    async fn next_digest_opt(rx: &mut tokio::sync::mpsc::Receiver<String>) -> Option<String> {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .ok()
            .flatten()
    }

    /// The proper-coast defect, pinned: a submission landing mid-quiet-stretch
    /// — full floor unexpired, burst nowhere near — emits at the first tick
    /// past the forced floor instead of waiting out the cadence.
    #[tokio::test(start_paused = true)]
    async fn a_mid_stretch_submission_re_aims_within_the_forced_floor() {
        let mut h = start_cadenced(
            Some("Harden the watch loop."),
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

    /// A headline the digest does not support is re-asked once, with the
    /// rejected answer named, and if the second answer fails too nothing is
    /// emitted — the previous headline stands rather than a wrong one replacing
    /// it. The canned host answers the same thing both times, which is what a
    /// blind retry at temperature 0 would do and why the correction has to name
    /// the failure.
    #[tokio::test(start_paused = true)]
    async fn a_refused_headline_is_re_asked_once_then_held() {
        let mut h = start(Some("Wire schema migration backfill."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let mut digests = h.digests.take().unwrap();

        let first = next_digest(&mut digests).await;
        assert!(!first.contains(GROUNDING_CORRECTION));
        let second = next_digest(&mut digests).await;
        assert!(
            second.starts_with(&first),
            "the re-ask keeps the original digest"
        );
        assert!(second.contains(GROUNDING_CORRECTION));
        assert!(second.contains("Wire schema migration backfill"));

        // Two summarize calls and no third, and no frame from either.
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }

    /// The two refusal lines, as bytes, so the shapes `analyze.py` parses are
    /// pinned against the call site that emits them.
    ///
    /// The analyzer reads a field's value as space-free unless it is quoted, so a
    /// countable field carrying a space would parse as its first word with the
    /// rest dropped — silently, reporting a plausible number. `rule` and `reask`
    /// must therefore be single tokens and the headline text must arrive quoted.
    #[tokio::test(start_paused = true)]
    async fn the_refusal_log_lines_carry_analyzer_readable_fields() {
        use std::sync::{Arc as StdArc, Mutex as StdMutex};
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone)]
        struct Buffer(StdArc<StdMutex<Vec<u8>>>);
        impl std::io::Write for Buffer {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Buffer {
            type Writer = Buffer;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let sink = Buffer(StdArc::new(StdMutex::new(Vec::new())));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(sink.clone())
            .with_ansi(false)
            .without_time()
            .finish();
        let captured = {
            let _guard = tracing::subscriber::set_default(subscriber);
            let mut h = start(Some("Wire schema migration backfill."), true, true, true);
            tokio::time::sleep(Duration::from_millis(50)).await;
            h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
            let mut digests = h.digests.take().unwrap();
            next_digest(&mut digests).await;
            next_digest(&mut digests).await;
            assert!(next_overview(&mut h.pulse_rx).await.is_none());
            String::from_utf8(sink.0.lock().unwrap().clone()).unwrap()
        };

        let refused = captured
            .lines()
            .find(|l| l.contains("headline refused"))
            .unwrap_or_else(|| panic!("no refusal line in:\n{captured}"));
        let reask = captured
            .lines()
            .find(|l| l.contains("headline reask"))
            .unwrap_or_else(|| panic!("no reask line in:\n{captured}"));

        // Space-free countable fields.
        assert!(refused.contains("rule=ungrounded"), "{refused}");
        assert!(reask.contains("reask=failed"), "{reask}");
        // Quoted text, so a headline holding spaces survives the field split.
        assert!(
            refused.contains("headline=\"Wire schema migration backfill\""),
            "{refused}"
        );
        assert!(reask.contains("headline=\"\""), "{reask}");
    }

    /// The re-ask is skipped whenever another session is waiting for the emit
    /// slot. One emit runs at a time across all sessions, so an unconditional
    /// re-ask would let one refusing session hold the only slot for twice the
    /// summarize timeout while every queued session went stale behind it.
    ///
    /// Two sessions come due together. The first is spawned with the second
    /// still queued, so it may not re-ask; the second is spawned with nothing
    /// behind it, so it may. Exactly one corrected digest therefore reaches the
    /// host, not two.
    #[tokio::test(start_paused = true)]
    async fn a_contended_emit_slot_skips_the_re_ask() {
        let mut h = start(Some("Wire schema migration backfill."), true, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        h.code_tx.send(tool_use_frame("s2", "cargo test")).unwrap();
        let mut digests = h.digests.take().unwrap();

        let mut seen = Vec::new();
        while let Some(digest) = next_digest_opt(&mut digests).await {
            seen.push(digest);
        }
        let corrected = seen
            .iter()
            .filter(|d| d.contains(GROUNDING_CORRECTION))
            .count();
        assert_eq!(
            corrected,
            1,
            "one session re-asked and one was contended; saw {} digests",
            seen.len()
        );
        assert_eq!(seen.len(), 3, "two first asks and one re-ask");
        assert!(next_overview(&mut h.pulse_rx).await.is_none());
    }

    /// The recency boundary is turn-relative: a new ask empties "right now",
    /// demotes the old turn's lines to background, and takes the current-ask
    /// section as the directive standing over the session's goal.
    #[tokio::test(start_paused = true)]
    async fn a_new_ask_resets_right_now_and_rides_last_in_the_digest() {
        let mut h = start(Some("Harden the watch loop."), true, true, true);
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
        assert!(second.contains("The standing goal:\n- make the watch loop resilient\n"));
        assert!(second.contains("The current ask:\n- look at the parser instead\n"));
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
        state.observe_now(CodeOutputEvent::Prose {
            msg_id: "m1".to_string(),
            block_index: 0,
            is_partial: true,
            text: "Working through the cadence".to_string(),
        });
        // The submission arm's exact sequence.
        state.human_act();
        state.pending_ask = Some("and check the floor".to_string());
        state.record_now(SessionBeat::Asked(Some("and check the floor".to_string())));
        state.observe_now(CodeOutputEvent::Prose {
            msg_id: "m1".to_string(),
            block_index: 0,
            is_partial: true,
            text: " logic and what the floor guards.".to_string(),
        });
        state.observe_now(CodeOutputEvent::Beat(SessionBeat::Turn));

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

    /// A return to idle is a hard barrier: the next human act starts a new
    /// stretch, and nothing from the finished one — activity, pending ask,
    /// standing digest — may appear in a summary again.
    #[test]
    fn a_human_act_after_rest_crosses_the_idle_barrier() {
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Tool("Bash(cargo test)".to_string()));
        state.pending_ask = Some("fix the parser".to_string());
        state.last_digest = Some("the old digest".to_string());
        state.record_now(SessionBeat::Turn);
        let epoch = state.barrier_epoch;

        state.human_act();
        assert!(
            state.activity.is_empty(),
            "the finished stretch's lines must not survive the barrier: {:?}",
            state.activity
        );
        assert!(state.pending_ask.is_none());
        assert!(state.last_digest.is_none());
        assert_eq!(state.barrier_epoch, epoch + 1);
    }

    /// Machinery beats after the rest — trailing prose, a snapshot replay —
    /// un-settle the collapse clock, but the rest still happened: the next
    /// human act crosses the barrier all the same, and the twitch's own
    /// lines fall behind it too.
    #[test]
    fn machinery_beats_after_rest_do_not_disarm_the_barrier() {
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Tool("Bash(cargo test)".to_string()));
        state.record_now(SessionBeat::Turn);
        state.observe_now(CodeOutputEvent::Prose {
            msg_id: "m1".to_string(),
            block_index: 0,
            is_partial: false,
            text: "One trailing remark after the turn already ended, long enough to record."
                .to_string(),
        });
        assert!(
            state.settled_at.is_none(),
            "the twitch un-settled the clock"
        );

        state.human_act();
        assert!(
            state.activity.is_empty(),
            "the barrier drops the stretch and its trailing twitch alike: {:?}",
            state.activity
        );
    }

    /// An act on a session that never came to rest is steering, not a new
    /// request — the stretch's history stays.
    #[test]
    fn a_mid_stretch_act_keeps_its_history() {
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Tool("Bash(cargo test)".to_string()));
        let epoch = state.barrier_epoch;

        state.human_act();
        assert_eq!(state.activity.len(), 1);
        assert_eq!(state.barrier_epoch, epoch);
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
        let mut digests = h.agent.script(
            Lane::Says("Fixing the flaky test."),
            Lane::Says("Fixing the flaky test."),
        );
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
        let _digests = h.agent.script_lanes(
            Some("Starting on the lens bug."),
            Some("Starting on the lens bug."),
        );
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
        let mut h = start(Some("Harden the watch loop."), true, true, true);
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
            idle_collapse_after: NEVER_COLLAPSE,
        };
        let mut h = start_cadenced(Some("Harden the watch loop."), true, true, true, cadence);
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

    /// The emit rides its own task: with a summarize hung at its ceiling,
    /// the loop still observes cancellation immediately. No virtual
    /// time passes after the cancel, so a loop blocked inside the emit would
    /// still hold its subscription — the receiver count is the tell.
    #[tokio::test(start_paused = true)]
    async fn cancellation_is_observed_mid_emit() {
        let h = start(None, true, true, false);
        // An agent that takes the job and never answers, so the emit is
        // genuinely in flight when the cancel arrives.
        let mut digests = h.agent.script(Lane::Mute, Lane::Mute);
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
            Some("Run the emitter on a clock."),
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
        assert_eq!(overview["text"], "Run the emitter on a clock");
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

    // -----------------------------------------------------------------------
    // The idle collapse
    // -----------------------------------------------------------------------

    /// Intents fire on any beat, and a settled session collapses a short way
    /// past its last one.
    fn collapsing_cadence() -> Cadence {
        Cadence {
            burst_beats: 1,
            idle_period: Duration::ZERO,
            floor: Duration::ZERO,
            forced_floor: Duration::ZERO,
            idle_collapse_after: Duration::from_secs(30),
        }
    }

    /// Every retrospective *attempt* the model was asked to answer.
    ///
    /// A refused retrospective is followed by the one corrective re-ask, whose
    /// prompt is the same digest with the correction appended — counting those
    /// as attempts would report two for every one and hide the very loop these
    /// tests exist to catch.
    fn drain_retrospective_attempts(rx: &mut tokio::sync::mpsc::Receiver<String>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(digest) = rx.try_recv() {
            if digest.contains(RETROSPECTIVE_HEADING) && !digest.contains(GROUNDING_CORRECTION) {
                out.push(digest);
            }
        }
        out
    }

    fn drain_overviews(rx: &mut broadcast::Receiver<Frame>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            if let Ok(body) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                out.push(body);
            }
        }
        out
    }

    #[tokio::test(start_paused = true)]
    async fn a_settled_session_collapses_into_one_retrospective() {
        let h = start_cadenced(None, true, true, false, collapsing_cadence());
        let mut digests = h.agent.script_lanes(
            Some("Hardening the watch loop."),
            Some("Hardened the watch loop."),
        );
        let mut pulse_rx = h.pulse_rx.resubscribe();
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        h.code_tx.send(turn_complete_frame("s1")).unwrap();

        // Before the window, the strip is still saying what the session is
        // doing — the last live intent gets its turn.
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert!(
            drain_retrospective_attempts(&mut digests).is_empty(),
            "collapsed before the idle window elapsed"
        );

        tokio::time::sleep(Duration::from_secs(60)).await;
        let attempts = drain_retrospective_attempts(&mut digests);
        assert_eq!(attempts.len(), 1, "expected one retrospective");
        assert!(attempts[0].contains("- Bash(cargo build)"));

        let done: Vec<_> = drain_overviews(&mut pulse_rx)
            .into_iter()
            .filter(|body| body["phase"] == "done")
            .collect();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["text"], "Hardened the watch loop");

        // And it stays one, however long the session stays at rest.
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert!(drain_retrospective_attempts(&mut digests).is_empty());
    }

    /// The collapse is per settled stretch, not per session: work that resumes
    /// goes back to live intents and earns exactly one more retrospective when
    /// it next comes to rest.
    #[tokio::test(start_paused = true)]
    async fn work_after_a_collapse_re_arms_exactly_one_more() {
        let h = start_cadenced(None, true, true, false, collapsing_cadence());
        let mut digests = h.agent.script_lanes(
            Some("Hardening the watch loop."),
            Some("Hardened the watch loop."),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        h.code_tx.send(turn_complete_frame("s1")).unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(drain_retrospective_attempts(&mut digests).len(), 1);

        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert!(
            drain_retrospective_attempts(&mut digests).is_empty(),
            "the session went back to work; it is not settled"
        );

        h.code_tx.send(turn_complete_frame("s1")).unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
        let attempts = drain_retrospective_attempts(&mut digests);
        assert_eq!(
            attempts.len(),
            1,
            "the second stretch earns one, and one only"
        );
        assert!(attempts[0].contains("- Bash(cargo test)"));
    }

    /// A session still working never collapses, however long the emitter runs.
    #[tokio::test(start_paused = true)]
    async fn a_session_that_never_settles_never_collapses() {
        let h = start_cadenced(None, true, true, false, collapsing_cadence());
        let mut digests = h.agent.script_lanes(
            Some("Hardening the watch loop."),
            Some("Hardened the watch loop."),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert!(drain_retrospective_attempts(&mut digests).is_empty());
    }

    /// A `$` command that *failed* is a recorded beat, so it leaves the session
    /// working rather than settled. The stretch ended on an error; "what was
    /// done" is not yet a true thing to say.
    #[tokio::test(start_paused = true)]
    async fn a_failed_shell_command_does_not_arm_the_collapse() {
        let h = start_cadenced(None, true, true, false, collapsing_cadence());
        let mut digests = h.agent.script_lanes(
            Some("Hardening the watch loop."),
            Some("Hardened the watch loop."),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(turn_complete_frame("s1")).unwrap();
        let failed = serde_json::json!({
            "tug_session_id": "s1",
            "type": "exchange_settled",
            "exit_code": 1,
            "command": "make test",
        });
        h.shell_tx
            .send(Frame::new(
                FeedId::SHELL_OUTPUT,
                serde_json::to_vec(&failed).unwrap(),
            ))
            .unwrap();
        tokio::time::sleep(Duration::from_secs(600)).await;
        assert!(drain_retrospective_attempts(&mut digests).is_empty());
    }

    /// The direct pin on the retry loop. The collapse arm reads `settled_at`,
    /// which a refusal does not change, and it never sees `commit_tick`'s beat
    /// counter — so a retrospective marked spent only on a *successful* emit
    /// would be re-asked on every sweep for as long as the session stayed idle.
    /// Marking it on the answer is what bounds it at one.
    #[tokio::test(start_paused = true)]
    async fn a_refused_retrospective_is_attempted_exactly_once() {
        // Grounded in nothing the digest says, so the gate refuses it every
        // time, including on the re-ask.
        let h = start_cadenced(None, true, true, false, collapsing_cadence());
        let mut digests = h.agent.script_lanes(
            Some("Hardening the watch loop."),
            Some("Harvested the mango orchard."),
        );
        let mut pulse_rx = h.pulse_rx.resubscribe();
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        h.code_tx.send(turn_complete_frame("s1")).unwrap();

        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(drain_retrospective_attempts(&mut digests).len(), 1);

        // Hundreds of sweeps later, still one.
        tokio::time::sleep(Duration::from_secs(1_800)).await;
        let extra = drain_retrospective_attempts(&mut digests);
        assert!(
            extra.is_empty(),
            "the refused retrospective was re-asked {} more times",
            extra.len()
        );
        assert!(
            drain_overviews(&mut pulse_rx)
                .iter()
                .all(|body| body["phase"] != "done"),
            "a refused retrospective reached the strip"
        );
    }

    /// A build that never made a pool emits nothing and arms the back-off —
    /// the degraded posture [P06] preserves, reached through the absent handle
    /// rather than through a refusing agent.
    #[tokio::test]
    async fn an_absent_agent_emits_no_headline() {
        let activity = vec!["Bash(cargo build)".to_string()];
        let outcome = run_emit(EmitJob {
            session_id: "s1".to_string(),
            activity,
            recent_activity: 0,
            asked: false,
            cache: PromptCache::default(),
            pending_ask: None,
            last_digest: None,
            jsonl: None,
            shared_agent: None,
            may_reask: false,
            retrospective: false,
            barrier_epoch: 0,
        })
        .await;
        assert!(outcome.headline.is_none());
        assert!(outcome.failed, "an absent agent arms the back-off");
        assert!(
            outcome.seen_digest.is_none(),
            "nothing saw the digest, so it must stay eligible",
        );
    }

    /// The other door into the same loop: the digest-unchanged dedup returns
    /// before the model is reached, which would leave the attempt unmarked. The
    /// retrospective path skips that dedup for exactly this reason.
    #[tokio::test]
    async fn a_retrospective_is_asked_even_when_its_digest_is_unchanged() {
        let agent = FakeAgent::new(
            Lane::Says("Hardened the watch loop."),
            Lane::Says("Hardened the watch loop."),
        );
        let mut digests = agent.script_lanes(
            Some("Hardened the watch loop."),
            Some("Hardened the watch loop."),
        );
        let activity = vec!["Bash(cargo build)".to_string()];
        let composed = compose_retrospective_digest(&[], &activity).unwrap();
        let outcome = run_emit(EmitJob {
            session_id: "s1".to_string(),
            activity,
            recent_activity: 0,
            asked: false,
            cache: PromptCache::default(),
            pending_ask: None,
            // Exactly what this emit is about to compose.
            last_digest: Some(composed.clone()),
            jsonl: None,
            shared_agent: Some(agent.pool()),
            may_reask: false,
            retrospective: true,
            barrier_epoch: 0,
        })
        .await;
        assert_eq!(digests.recv().await.as_deref(), Some(composed.as_str()));
        assert!(
            outcome.seen_digest.is_some(),
            "the model answered, so the collapse is spent — an unmarked attempt re-fires forever"
        );
        assert!(outcome.retrospective);
    }

    /// Past-tense register and tool names overlap by construction: `stem` strips
    /// `ed`, so `edited` and `Edit` are the same word to the gate. Rule 2 reads
    /// past the retrospective's opening verb for exactly this reason — and no
    /// further, which the restatement case below proves.
    #[test]
    fn a_retrospective_may_open_on_what_reads_as_a_tool_name() {
        let digest = compose_retrospective_digest(
            &["resolve the keymap shortcut conflicts".to_string()],
            &[
                "Edit(keymap.ts)".to_string(),
                "Bash(bun test keymap)".to_string(),
            ],
        )
        .unwrap();
        assert!(digest.contains(RETROSPECTIVE_HEADING));

        let headline = "Edited keymap shortcut conflicts";
        assert!(
            matches!(
                ground_headline(headline, &digest, GroundingMode::Intent),
                GroundingVerdict::Ungrounded {
                    rule: "tool-name-opener",
                    ..
                }
            ),
            "the collision this exemption exists for is gone; re-read the rule"
        );
        assert_eq!(
            ground_headline(headline, &digest, GroundingMode::Retrospective),
            GroundingVerdict::Grounded
        );
    }

    /// The exemption is one word wide. A retrospective that restates a whole
    /// activity line is the intent/activity collapse the gate was built to
    /// refuse, and scoping the heading into `ACTIVITY_HEADINGS` is what keeps
    /// that rule awake over a digest made entirely of tool lines.
    #[test]
    fn a_retrospective_that_restates_an_activity_line_is_still_refused() {
        let digest = compose_retrospective_digest(
            &["resolve the keymap shortcut conflicts".to_string()],
            &["Bash(bun test keymap)".to_string()],
        )
        .unwrap();
        let (rule, _) =
            match ground_headline("Ran bun test keymap", &digest, GroundingMode::Retrospective) {
                GroundingVerdict::Ungrounded { rule, detail } => (rule, detail),
                GroundingVerdict::Grounded => panic!("a restated activity line was accepted"),
            };
        assert_eq!(rule, "activity-restatement");
    }

    #[test]
    fn the_retrospective_digest_states_intent_then_everything_that_happened() {
        let digest = compose_retrospective_digest(
            &[
                "make the watch loop resilient".to_string(),
                "look at the parser instead".to_string(),
            ],
            &[
                "Bash(cargo build)".to_string(),
                "Edit(parser.rs)".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            digest,
            "The standing goal:\n- make the watch loop resilient\n\n\
             The current ask:\n- look at the parser instead\n\n\
             What the session did:\n- Bash(cargo build)\n- Edit(parser.rs)\n"
        );
        // No recency split: the question is what the whole stretch did.
        assert!(!digest.contains("What it is doing right now:"));
    }

    #[test]
    fn a_retrospective_with_nothing_to_describe_is_no_digest() {
        assert!(compose_retrospective_digest(&[], &[]).is_none());
    }
}

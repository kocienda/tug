//! Session synopsis — the standing description of a session: one sentence
//! saying what the session is *about*, written by the SharedAgent and persisted
//! on the session's ledger row.
//!
//! The description follows the transcript, not the toolbelt. It is composed
//! from the user's own messages (read from the claude JSONL) — the newest ask
//! is the subject, the asks before it are the arc, the session's opening ask is
//! context — plus a cut of what the session is doing this minute, taken from an
//! interleaved stream of everything the transcript shows: assistant prose, tool
//! calls, and Session-card shell commands. Those go to the agent as one digest,
//! and the sentence that comes back is written to `sessions.synopsis` and
//! pushed to every surface showing that session ([D132]).
//!
//! **One ask, one sentence.** This module makes exactly one kind of model call.
//! It taps three broadcasts, writes one ledger column, and pushes one CONTROL
//! frame; it reads no client state and answers no requests, so nothing
//! downstream can block a session on it.
//!
//! **It costs nothing when it can't run.** No model, the tenant switched off,
//! an unresolvable session identity, no ledger to write to, a refusal — all of
//! them end the tick silently and the session keeps the description it has.
//!
//! **The trigger is "the session moved."** A session is due when any beat has
//! arrived since its last ask, or when it has settled and its stretch has not
//! been described yet. Due-ness persists until an ask actually reaches the
//! model, so a session that comes due inside the debounce window is deferred to
//! the next window rather than dropped. The debounce
//! ([`SYNOPSIS_MIN_INTERVAL`]) is the only pacing: the line is meant to stand,
//! not to twitch.
//!
//! **A settled session gets one refresh.** When a turn ends — or a `$` command
//! settles cleanly — and nothing follows for `SETTLE_REFRESH_AFTER`, the
//! session is due once more so its description reflects the finished stretch.
//! The refresh is marked spent when the model *answers* rather than when a
//! description is written: it fires on `settled_at`, which no refusal changes,
//! so an attempt marked only on success would be retried on every sweep for as
//! long as the session stayed idle. Any beat re-arms the next one.

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
use tugcast_core::Frame;

/// How often the loop wakes to sweep sessions against the trigger. Frames are
/// evidence, not triggers, so this is the only evaluation point — well inside
/// the debounce, so nothing due waits perceptibly.
const TICK_INTERVAL: Duration = Duration::from_secs(2);

/// How long a settled session stays quiet before its description is refreshed
/// once more, so the line describes the finished stretch rather than the
/// moment work stopped.
const SETTLE_REFRESH_AFTER: Duration = Duration::from_secs(30);

/// Minimum spacing between two asks for one session's description.
///
/// `pub` so `shared_agent.rs` can assert the `synopsis` job's ceiling sits
/// under it: a ceiling above this floor would make the cadence inference-bound
/// rather than designed.
///
/// Why sixty seconds specifically: it is the shortest interval at which the
/// line does not visibly strobe under sustained work, and at one Haiku call per
/// session-minute the cost is small. It is a tuned starting point, not a
/// derived constant — raise it if descriptions read as restless, lower it if
/// they read as stale.
pub const SYNOPSIS_MIN_INTERVAL: Duration = Duration::from_secs(60);

/// Sessions with no frames for this long are dropped at the sweep. The map is
/// a rolling picture, not an archive: a closed or abandoned session's state
/// would otherwise ride in memory for the life of the process.
const SESSION_RETENTION: Duration = Duration::from_secs(3600);

/// Activity lines carried per session — tool, prose, and shell lines in one
/// interleaved deque. Enough to show the shape of the work, bounded so the
/// accumulator can't grow without limit.
const MAX_ACTIVITY_LINES: usize = 24;

/// Activity lines the digest's present section actually carries — the newest of
/// the deque above. The section is background, never the subject, so it needs
/// only enough lines to show what the work currently touches.
const SYNOPSIS_ACTIVITY_LINES: usize = 8;

/// User prompts fed into the stretch-scoped half of the cache: the session's
/// pinned first prompt plus the most recent ones. `MAX_PROMPT_CHARS` clips per
/// prompt, not across the set; real sessions land far under the worst case.
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

/// The description's character budget.
///
/// The description is a *summary*: it sits under the callsign on a card-wide
/// chrome line, it is read days later, and it is the only line that ever gets
/// to say what the whole session is about. Room for a clause and its qualifier
/// is what lets it say that.
///
/// 72, not more: the line's real display room is the rail row and the picker
/// row, both of which cut around 96 characters mid-word — and a description
/// that routinely arrives clipped, by this budget's `…` or the row's, reads as
/// a broken line rather than a standing one. The budget is the display's, and
/// the wording asks the model for less than it so the clip is the exception.
const MAX_SYNOPSIS_CHARS: usize = 72;

/// First and last back-off after the model refuses or fails.
const BACKOFF_START: Duration = Duration::from_secs(60);
const BACKOFF_MAX: Duration = Duration::from_secs(600);

/// Which of the two independent conditions currently allow a tick.
///
/// Separated from the loop so the truth table is a fact about the module rather
/// than an accident of control flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gates {
    /// The `synopsis` tenant switch.
    pub tenant_enabled: bool,
    /// Whether the model is currently in refusal back-off.
    pub backing_off: bool,
}

impl Gates {
    pub fn allow(self) -> bool {
        self.tenant_enabled && !self.backing_off
    }
}

/// The two durations the loop paces itself by. Injectable so the loop can be
/// exercised without waiting out real seconds; production always uses
/// [`Clocks::default`].
#[derive(Clone, Copy, Debug)]
pub struct Clocks {
    /// Minimum spacing between two asks for one session.
    pub min_interval: Duration,
    /// How long a settled session stays quiet before it earns its one refresh.
    pub settle_after: Duration,
}

impl Default for Clocks {
    fn default() -> Self {
        Self {
            min_interval: SYNOPSIS_MIN_INTERVAL,
            settle_after: SETTLE_REFRESH_AFTER,
        }
    }
}

/// What a frame contributes to a session's picture — the transcript's beat
/// vocabulary.
///
/// Every kind says the session moved; the content-bearing kinds also carry the
/// digest line describing what happened. The vocabulary covers everything that
/// streams into the transcript — tool calls, assistant prose, and Session-card
/// shell commands — so a session that only talks, or only runs `$` commands,
/// comes due exactly as a tool-running one does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionBeat {
    /// A tool ran; the digest line describing it.
    Tool(String),
    /// The assistant said something; the `said:` digest line holding the head
    /// of the block.
    Said(String),
    /// A `$` shell command started or settled. `Some` carries the digest line;
    /// `None` is a zero-exit completion — the command already has its started
    /// line, so settling cleanly says the session moved and nothing more.
    Shell(Option<String>),
    /// A turn ended. No line, but the session is demonstrably alive.
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
    /// into the cache and the description reaches back across every barrier
    /// ever crossed.
    primed: bool,
    /// The current stretch's first prompt. It changes only at an idle barrier,
    /// which clears it so the next stretch's opening ask takes the slot.
    first: Option<String>,
    /// The most recent prompts, oldest evicted.
    recent: VecDeque<String>,
    /// The SESSION's opening ask — the first prompt in the transcript, set
    /// once and never cleared.
    ///
    /// Deliberately not `first`, which is the *stretch's* opener and is wiped
    /// at every idle barrier. The description is about the session, and a
    /// standing goal that resets every time the user pauses for coffee is not
    /// standing at all.
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

    /// Drop the stretch's asks while keeping the read position. The asks
    /// behind an idle barrier belong to a finished request; the preserved
    /// offset means they are gone for good rather than re-read on the next
    /// refresh.
    ///
    /// Only the STRETCH's fields fall here. `opening`, `current_ask`, and the
    /// arc belong to the session, not to any stretch of it — the description's
    /// boundaries are the user's own messages, recorded as each ask arrives.
    fn barrier(&mut self) {
        self.first = None;
        self.recent.clear();
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
    /// Beats since the last ask spawned. Non-zero is the whole of "the session
    /// moved", and it is not cleared by a skipped window — only by an ask
    /// actually being taken — so a due session defers rather than being lost.
    new_beats: u32,
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
    /// The newest submission's clipped ask, carried into the digest as the
    /// current work item until the prompt cache reads the same text back from
    /// the JSONL.
    pending_ask: Option<String>,
    /// When any frame last arrived for this session — the retention clock.
    last_seen: Instant,
    /// When the session last came to rest — a turn ended, or a `$` command
    /// settled with a zero exit — with nothing recorded since. `None` means
    /// work is in flight. This is the settle refresh's clock: any other beat,
    /// and every human act, clears it.
    settled_at: Option<Instant>,
    /// Whether this idle stretch's refresh has already been asked for.
    /// Cleared by any beat, so a session that resumes and settles again earns
    /// another one.
    settle_refreshed: bool,
    /// The session has come to rest since the last human act. Unlike
    /// `settled_at`, no machinery beat clears this — trailing prose or a
    /// snapshot replay can un-settle the refresh clock, but the rest still
    /// happened, and the next human act crosses the idle barrier because of
    /// it.
    rested: bool,
    /// How many idle barriers this session has crossed. An ask snapshots the
    /// epoch at spawn; an outcome carrying an older epoch describes a
    /// finished stretch and lands nothing but its read position.
    barrier_epoch: u64,
    /// Activity lines recorded since the last settle refresh was marked. A
    /// settled stretch with none has nothing new to describe, which is what
    /// keeps a session that merely reconnects from re-asking.
    activity_since_settle: usize,
    /// When this session's description was last asked for. `None` until the
    /// first ask; the debounce clock.
    last_synopsis: Option<Instant>,
}

impl SessionState {
    fn new(now: Instant) -> Self {
        Self {
            activity: VecDeque::new(),
            new_beats: 0,
            open: None,
            beaten: HashSet::new(),
            prompts: PromptCache::default(),
            pending_ask: None,
            last_seen: now,
            settled_at: None,
            settle_refreshed: false,
            rested: false,
            barrier_epoch: 0,
            activity_since_settle: 0,
            last_synopsis: None,
        }
    }

    /// A human act — a submission or a `$` command starting. Prose state is
    /// untouched: an ask neither finalizes an open block nor clears the dedup
    /// set; those stay keyed to CODE_OUTPUT turn frames.
    fn human_act(&mut self) {
        if self.rested {
            self.cross_idle_barrier();
        }
        self.resume();
    }

    /// A human act on a session that has been at rest starts a new stretch,
    /// and the idle boundary behind it is hard: nothing before it may appear
    /// in a description again. The finished stretch's activity, cached asks,
    /// and pending ask all drop, and the epoch bump invalidates any ask still
    /// in flight from before the barrier. The read offset inside the prompt
    /// cache survives, so asks the cache already consumed stay behind the
    /// barrier instead of being re-read.
    fn cross_idle_barrier(&mut self) {
        self.activity.clear();
        self.activity_since_settle = 0;
        self.prompts.barrier();
        self.pending_ask = None;
        self.rested = false;
        self.barrier_epoch += 1;
    }

    /// The session is working again: it is no longer at rest, and whatever it
    /// goes on to do earns a fresh refresh when it next settles.
    fn resume(&mut self) {
        self.settled_at = None;
        self.settle_refreshed = false;
    }

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

    /// Whether this session has been at rest long enough, with something to
    /// show for the stretch, to earn its one refresh.
    ///
    /// Reads `settled_at` rather than `new_beats` — an idle session has no new
    /// beats, which is the entire point of the trigger.
    fn settle_refresh_due(&self, now: Instant, after: Duration) -> bool {
        !self.settle_refreshed
            && self.activity_since_settle > 0
            && self
                .settled_at
                .is_some_and(|at| now.duration_since(at) >= after)
    }

    /// Whether the session has moved since its last ask. Derived from the
    /// counters the beats already keep, so nothing has to be armed or cleared
    /// on a window the loop declines to use.
    fn synopsis_due(&self, now: Instant, clocks: &Clocks) -> bool {
        self.new_beats > 0 || self.settle_refresh_due(now, clocks.settle_after)
    }

    /// Whether the debounce window is open.
    fn debounce_open(&self, now: Instant, min_interval: Duration) -> bool {
        self.last_synopsis
            .is_none_or(|last| now.duration_since(last) >= min_interval)
    }

    /// Take the ask: snapshot the activity the digest reads and consume the
    /// beats that made this session due. Runs on the loop at spawn time, so a
    /// session never asks from a half-committed picture.
    fn commit_ask(&mut self) -> Vec<String> {
        self.new_beats = 0;
        self.activity.iter().cloned().collect()
    }

    /// Record a beat, and with it whether the session is now at rest.
    ///
    /// A turn ending and a `$` command settling cleanly are the two ways work
    /// finishes; every other beat means work is still happening. A *failed* `$`
    /// command is `Shell(Some(line))` — a recorded beat like any other — so it
    /// does not arm the refresh, and a session whose last act was an error is
    /// not yet a stretch worth re-describing.
    fn record(&mut self, beat: SessionBeat, now: Instant) {
        match beat {
            SessionBeat::Turn | SessionBeat::Shell(None) => {
                self.settle_refreshed = false;
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
            self.activity_since_settle += 1;
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
                // or a stretch that resumes mid-block would be refreshed under
                // it.
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
/// both say the session moved; only the failing settle has anything new to say
/// — a clean exit adds nothing beyond the started line. Only `type`, `command`,
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

/// Compose the digest the description is written from, ordered newest first —
/// the user's messages are the boundaries between work items, and the newest
/// item is the subject:
///
///  - **The most recent ask** — the work item the session is on. This LEADS the
///    digest, because a description that led with the session's opening kept
///    naming the morning's cleanup after the session had moved on to the
///    afternoon's work.
///  - **The arc** — every prior ask, presented newest first. Earlier work is
///    evidence the line may mention, never the half it leads with.
///  - **The session's opening ask**, which survives every idle barrier.
///    Labelled as context: where the session began, which matters exactly when
///    the session is still doing it.
///  - **The newest activity lines** — LABELLED AS THE PRESENT and explicitly
///    not the subject. They are here so the description is current and knows
///    what the work touches, not so it is about them. Only the newest
///    `SYNOPSIS_ACTIVITY_LINES` reach the digest, in arrival order.
///  - **The description it is replacing**, when there is one, so a re-run
///    revises a standing line rather than composing a new one from scratch
///    every minute — stability of voice, while the subject moves with the
///    work.
///
/// Returns `None` when the session has said nothing yet — with no ask there
/// is no undertaking to describe, and an honestly empty description line is
/// the right answer. Activity alone never asks: a session with no human act
/// has nothing to be about.
pub fn compose_synopsis_digest(
    opening: Option<&str>,
    arc: &[String],
    recent_ask: Option<&str>,
    activity: &[String],
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
    let present = &activity[activity.len().saturating_sub(SYNOPSIS_ACTIVITY_LINES)..];
    if !present.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(SESSION_PRESENT_HEADING);
        out.push('\n');
        for line in present {
            out.push_str("- ");
            out.push_str(line);
            out.push('\n');
        }
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

/// Headings the digest states its evidence under. Separate constants because
/// the prompt names each one verbatim, and a heading the wording does not name
/// is a section the model has no instruction about.
const SESSION_RECENT_HEADING: &str = "What the session was most recently asked to do:";
const SESSION_ARC_HEADING: &str = "What it worked on before that, newest first:";
const SESSION_OPENING_HEADING: &str =
    "What the session set out to do at the start (context, not the subject):";
const SESSION_PRESENT_HEADING: &str = "Where it stands right now (background, not the subject):";
const SESSION_PREVIOUS_HEADING: &str = "The description you are revising:";

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

/// Articles, stripped only from the very front — the line names a thing, and
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
/// The two flags are the standing read on whether the prompt is still in
/// register: a `clipped` answer means the model wrote past its room, and
/// `normalized` alone means it wrote a description with an article or a filler
/// opener in front. A `String` return cannot express any of that, which is why
/// the normalizer reports rather than only returning.
#[derive(Debug, Clone)]
pub struct RegisterReport {
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
    /// as long as the model kept writing long. The clip is the display's doing
    /// and says nothing about whether the line is true; the gate must not read
    /// it as evidence. What ships is still `text`.
    pub unclipped: String,
    /// The normalizer changed the string at all.
    pub normalized: bool,
    /// The character budget clipped.
    pub clipped: bool,
}

/// Impose the description's register on whatever the model wrote, and report
/// the work.
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
pub fn synopsis_register_report(raw: &str) -> RegisterReport {
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

    // A trailing period is sentence punctuation and never belongs on a line of
    // chrome. `?` and `!` are content; `…` is `clip`'s own marker and is a
    // different character entirely, and a spelled-out `...` is left alone too.
    if collapsed.ends_with('.') && !collapsed.ends_with("..") {
        collapsed.pop();
    }

    let collapsed = collapsed.trim().to_string();
    let text = clip(&collapsed, MAX_SYNOPSIS_CHARS);
    RegisterReport {
        normalized: text != raw.trim(),
        clipped: text != collapsed,
        unclipped: collapsed,
        text,
    }
}

/// Words that carry none of a description's subject, so whether the digest
/// spells them says nothing about whether the description came from it.
const GROUNDING_STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "by", "for", "with", "from",
    "into", "its", "it", "this", "that", "after", "before",
];

/// How much of a description's subject the digest must account for.
///
/// Read as a fraction: `GROUNDED_MIN_NUMERATOR / GROUNDED_MIN_DENOMINATOR` of the
/// content words after the opening verb.
///
/// Swept over the frozen corpus digests, the real defective answers, and the
/// resident model's own answers. Correct lines ground no worse than two thirds;
/// the surviving defects ground three fifths and one third. Two thirds is
/// therefore both the loosest value that refuses every defect and the strictest
/// that accepts every correct line, and the band between them is one word wide
/// — which is why the sweep is pinned by a test rather than left as a comment.
const GROUNDED_MIN_NUMERATOR: usize = 2;
const GROUNDED_MIN_DENOMINATOR: usize = 3;

/// How many words an activity line may carry beyond a description's subject and
/// still count as the line that description restates.
///
/// The tool name itself is one of them, so the slack is small on purpose. Its job
/// is to keep a long `Name(target)` — a commit message, a multi-flag grep — from
/// containing a description's whole subject by coincidence.
const RESTATEMENT_SLACK: usize = 3;

/// Punctuation trimmed off a word before comparison. The same set `run.py` uses,
/// so the Rust gate and the Python contamination check agree about what a word is.
const GROUNDING_TRIM: &str = ".,:;!?\"'`()[]<>";

/// Whether a description is derived from the digest it claims to describe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroundingVerdict {
    Grounded,
    Ungrounded {
        /// Which rule refused it. A static string so it can go straight into a
        /// log field the batch analyzer counts.
        rule: &'static str,
        /// What in particular tripped the rule, for the log.
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
/// hyphen, slash, underscore — so `command-line` and `session_synopsis`
/// contribute their parts. Follows `words()` in `run.py`, minus its set collapse:
/// the first word has to stay identifiable because it is the verb.
///
/// Parentheses split here where `run.py` only trims them at a token's ends,
/// because this function reads activity lines and `run.py` does not. `tool_line`
/// writes `Name(target)`, so without the split the first word of every target
/// arrives glued to the tool name — `Bash(cargo` — and no line can ever match
/// it. That would silently weaken the restatement rule, which exists precisely
/// to catch a line that repeats a target.
///
/// A dotted token yields its parts *and* itself: `nocturne.css` contributes
/// `nocturne`, `css`, and `nocturne.css`. The dot is not in the split set
/// because a bare filename is a word in its own right — rule 3 admits one as a
/// proper name — so splitting it away would leave a line naming the file
/// exactly with nothing to match. Emitting both is what lets a line reading
/// `nocturne` ground against a digest that only ever writes
/// `Read(tugdeck/styles/themes/nocturne.css)`.
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
/// whitespace, nothing but word characters — excludes a shell beat
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
///
/// Scoped to the present section alone. The digest states the user's own
/// prompts under the intent headings in the same `- ` form, and reading those
/// as activity would put the user's verbs into the tool-name set — an ask
/// opening `fix the lag` would make every legitimate `Fix …` description
/// unemittable for that session. Membership is the whole scoping mechanism, so
/// a heading that is not the present one is excluded by default.
fn digest_tool_activity(digest: &str) -> Vec<(String, &str)> {
    let mut out = Vec::new();
    let mut in_activity = false;
    for line in digest.lines() {
        if line.ends_with(':') && !line.starts_with("- ") {
            in_activity = line == SESSION_PRESENT_HEADING;
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

/// Whether the digest supports this description, and if not, which rule refused
/// it.
///
/// The normalizer imposes register and never checks truth; this is the other
/// half. It runs on the normalized text, so it judges the string the row would
/// actually wear, and it refuses rather than rewrites — rewriting would be
/// paraphrase, which is a second model with none of the first one's context, and
/// a gate that edits can introduce a new falsehood where a gate that declines
/// cannot.
///
/// Rules fire in order, first match winning:
///
/// 1. **empty** — nothing left after register. Checked here so the gate is total
///    over its input and no caller needs a pre-check.
/// 2. **tool-name opener** — the line opens on a tool the digest names, which
///    means the description is restating an activity line.
/// 3. **path-bearing** — a token holding a `/` or `clip`'s `…` marker. A bare
///    filename is allowed: `score.py`'s rubric exempts identifiers and dotted
///    paths as proper names, and the gate must not contradict the rubric.
///    The `…` half catches a model quoting a truncated path out of the digest,
///    so what is judged must be the model's own words — callers pass
///    [`RegisterReport::unclipped`], never the clipped `text`, or the gate reads
///    its own marker as the defect.
/// 4. **activity restatement** — the subject is contained in one tool line.
/// 5. **ungrounded** — too little of the subject appears anywhere in the digest.
///
/// The opening word is exempt from grounding throughout: it is the verb, and a
/// digest of tool lines will rarely contain one. `Salvage` does not appear in a
/// digest about a corrupted ledger.
///
/// No copy of the prompt's example list is needed or wanted. Every example is
/// disjoint from every corpus digest, so a lifted example's words are by
/// definition absent from the digest and rule 5 already rejects it; a duplicated
/// list here would go stale the first time the instruction string was edited.
pub fn ground_synopsis(line: &str, digest: &str) -> GroundingVerdict {
    let line = line.trim();
    if line.is_empty() {
        return GroundingVerdict::Ungrounded {
            rule: "empty",
            detail: String::new(),
        };
    }

    let words = content_words(line);
    let Some(verb) = words.first() else {
        return GroundingVerdict::Ungrounded {
            rule: "empty",
            detail: String::new(),
        };
    };

    if digest_tool_names(digest).contains(verb) {
        return GroundingVerdict::Ungrounded {
            rule: "tool-name-opener",
            detail: verb.clone(),
        };
    }

    for token in line.split_whitespace() {
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
    // A line that is nothing but a verb and stopwords has no subject to
    // ground. The register normalizer's budget already bounds it, and there is
    // no claim in it that the digest could contradict.
    if subject.is_empty() {
        return GroundingVerdict::Grounded;
    }

    for (_, activity) in digest_tool_activity(digest) {
        let line_words: HashSet<String> = content_words(activity).into_iter().collect();
        // Restatement means the description says the same thing the line says,
        // so containment only counts when the two are about the same size. A
        // word-rich target — a commit message, a long grep — contains a great
        // many subjects by accident, and letting it match refuses good lines:
        // `Investigate local model roadmap` is a fair description for a session
        // whose activity includes `Bash(tugtool commit --message "plan(new):
        // dash/local-model-inv)`, and nothing about it restates that command.
        if line_words.len() > subject.len() + RESTATEMENT_SLACK {
            continue;
        }
        if subject.iter().all(|word| line_words.contains(*word)) {
            return GroundingVerdict::Ungrounded {
                rule: "activity-restatement",
                detail: activity.to_string(),
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

/// How the loop resolves a `tug_session_id` into the claude JSONL that holds
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

pub struct SessionSynopsisConfig {
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
    /// Where a written description lands. Absent in a ledger-less build, and
    /// then nothing is ever asked — there would be nowhere to put the answer.
    pub ledger: Option<Arc<crate::session_ledger::SessionLedger>>,
    /// The CONTROL broadcast, for the `session_updated` push that carries a
    /// written description to every surface showing that session. Absent in
    /// tests and in a ledger-less build; the write still lands, and the next
    /// listing picks it up.
    pub control_tx: Option<broadcast::Sender<Frame>>,
    /// The `synopsis` tenant switch, read per tick so a flip is live.
    pub tenant_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The Haiku SharedAgent the description is asked of, absent in a build
    /// that never made one — which reads exactly like the old no-model posture.
    pub shared_agent: crate::shared_agent::SharedAgentHandle,
    pub identity: SessionIdentity,
    pub clocks: Clocks,
}

/// The CODE_INPUT relay: the router's registered sink feeds `relay_rx`; every
/// frame is published to the submission broadcast, then forwarded verbatim to
/// the supervisor's dispatcher. Publish before forward, so this module's copy
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

/// A due session's snapshot, committed on the loop and carried onto the ask
/// task. Everything the digest needs rides along, so the task never touches
/// the session map.
struct SynopsisJob {
    /// The tug session id — what the loop keys by, and what the resolver takes.
    session_id: String,
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
    /// An unresolvable session simply stays due for the next sweep.
    row_id: String,
    activity: Vec<String>,
    cache: PromptCache,
    pending_ask: Option<String>,
    jsonl: Option<PathBuf>,
    shared_agent: crate::shared_agent::SharedAgentHandle,
    ledger: Arc<crate::session_ledger::SessionLedger>,
    control_tx: Option<broadcast::Sender<Frame>>,
    /// Ends the ask when the process is going down. The task holds a ledger
    /// handle, so this is what stops it writing after the loop is gone.
    cancel: CancellationToken,
    /// The session's barrier epoch at spawn. Echoed on the outcome so the
    /// loop can tell an ask that predates an idle barrier from one that
    /// still describes the current stretch.
    barrier_epoch: u64,
    /// Whether the settle refresh is what made this session due. Echoed on the
    /// outcome, and what decides whether the refresh is marked spent.
    settle_refresh: bool,
    /// When the loop took this ask — the debounce clock's new value, applied
    /// only if the model was actually reached.
    asked_at: Instant,
}

/// What an ask task hands back to the loop.
struct SynopsisOutcome {
    session_id: String,
    /// The prompt cache, back from its round trip through the ask.
    cache: PromptCache,
    /// The pending ask the cache caught up with — cleared on the state only
    /// while it is still the current one, so a submission landing mid-ask
    /// survives.
    caught_up_ask: Option<String>,
    /// The model answered. This is what spends the debounce window and the
    /// settle refresh — not whether a description was written, because the
    /// refresh fires on `settled_at`, which no refusal changes.
    asked: bool,
    /// The model was absent or failed — arm the back-off.
    failed: bool,
    barrier_epoch: u64,
    settle_refresh: bool,
    asked_at: Instant,
}

/// Run the description writer until cancelled.
///
/// The loop is clock-driven: frame arrival only accumulates evidence, and the
/// tick arm is the sole place the trigger is evaluated — so a session is asked
/// about when its description is due, not when the next frame happens to
/// arrive. That is what lets a prose-only stretch come due and the final
/// stretch of a session be described with no trailing frame.
///
/// Asks run off the loop: a due session's snapshot commits synchronously, then
/// its prompt refresh, model call, and ledger write ride a spawned task while
/// the loop keeps observing frames and cancellation — an ask held at the
/// transport timeout cannot deafen the accumulator. One ask is in flight at a
/// time (the one shared model serializes inference anyway); the other due
/// sessions queue behind it with their beats unconsumed, so a back-off arming
/// mid-queue leaves their evidence — and their due-ness — intact.
pub async fn session_synopsis_task(config: SessionSynopsisConfig, cancel: CancellationToken) {
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
    // Due sessions waiting behind the in-flight ask, and — in `active` —
    // every session currently queued or in flight, excluded from the sweep
    // and from pruning until its outcome lands.
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut active: HashSet<String> = HashSet::new();
    let mut in_flight: Option<(String, tokio::task::JoinHandle<SynopsisOutcome>)> = None;

    loop {
        let inbound = tokio::select! {
            _ = cancel.cancelled() => {
                info!("session synopsis: cancelled");
                break;
            }
            _ = tick.tick() => None,
            done = async { (&mut in_flight.as_mut().expect("guarded by is_some").1).await },
                if in_flight.is_some() =>
            {
                let (session_id, _) = in_flight.take().expect("guarded by is_some");
                active.remove(&session_id);
                match done {
                    Ok(outcome) => apply_synopsis_outcome(
                        outcome,
                        &mut sessions,
                        &mut backoff,
                        &mut queue,
                        &mut active,
                    ),
                    Err(error) => {
                        warn!(%error, session = %session_id, "session synopsis: task failed");
                    }
                }
                spawn_next(
                    &mut queue, &mut active, &mut in_flight, &mut sessions, &backoff, &config,
                    &cancel,
                );
                continue;
            }
            recv = code_rx.recv() => match recv {
                Ok(frame) => Some(Inbound::Code(frame)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    // The digest is about shape, not completeness — a gap in
                    // activity lines never justifies backpressuring the session.
                    warn!(skipped, "session synopsis: code broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("session synopsis: code broadcast closed");
                    break;
                }
            },
            recv = shell_rx.recv() => match recv {
                Ok(frame) => Some(Inbound::Shell(frame)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "session synopsis: shell broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("session synopsis: shell broadcast closed");
                    break;
                }
            },
            recv = submission_rx.recv() => match recv {
                Ok(frame) => Some(Inbound::Submission(frame)),
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "session synopsis: submission broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("session synopsis: submission broadcast closed");
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
        // Nowhere to persist a description is nowhere to put one. The sweep
        // still prunes; nothing is ever asked.
        if config.ledger.is_none() {
            continue;
        }
        // Gates are process-wide, so one closed gate ends the whole sweep.
        let gates = Gates {
            tenant_enabled: (config.tenant_enabled)(),
            backing_off: backoff.active(now),
        };
        if !gates.allow() {
            continue;
        }
        let due: Vec<String> = sessions
            .iter()
            .filter(|(id, _)| !active.contains(*id))
            .filter(|(_, state)| {
                state.synopsis_due(now, &config.clocks)
                    && state.debounce_open(now, config.clocks.min_interval)
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
            &cancel,
        );
    }
    if let Some((_, handle)) = in_flight {
        handle.abort();
    }
}

/// Start the next queued ask when none is in flight: resolve the row, snapshot
/// the session's evidence, and spawn it. A back-off arming mid-queue drops the
/// rest with their beats unconsumed, so their due-ness survives for the first
/// allowed sweep after it lifts.
fn spawn_next(
    queue: &mut VecDeque<String>,
    active: &mut HashSet<String>,
    in_flight: &mut Option<(String, tokio::task::JoinHandle<SynopsisOutcome>)>,
    sessions: &mut HashMap<String, SessionState>,
    backoff: &BackOff,
    config: &SessionSynopsisConfig,
    cancel: &CancellationToken,
) {
    while in_flight.is_none() {
        let now = Instant::now();
        if backoff.active(now) {
            for id in queue.drain(..) {
                active.remove(&id);
            }
            return;
        }
        let Some(session_id) = queue.pop_front() else {
            return;
        };
        let Some(ledger) = config.ledger.as_ref() else {
            active.remove(&session_id);
            continue;
        };
        // The row this description belongs to, resolved BEFORE anything is
        // consumed: a session whose row cannot be identified is not "asked and
        // failed", it is not asked at all, and the next sweep should try again
        // rather than lose the beats that made it due. See `SynopsisJob::row_id`
        // for why there is no fallback.
        let Some(row_id) = (config.identity.resolver)(&session_id) else {
            active.remove(&session_id);
            continue;
        };
        let Some(state) = sessions.get_mut(&session_id) else {
            active.remove(&session_id);
            continue;
        };
        let settle_refresh = state.settle_refresh_due(now, config.clocks.settle_after);
        let job = SynopsisJob {
            jsonl: config.identity.jsonl_path(&session_id),
            cache: std::mem::take(&mut state.prompts),
            pending_ask: state.pending_ask.clone(),
            barrier_epoch: state.barrier_epoch,
            activity: state.commit_ask(),
            shared_agent: config.shared_agent.clone(),
            ledger: Arc::clone(ledger),
            control_tx: config.control_tx.clone(),
            cancel: cancel.clone(),
            session_id: session_id.clone(),
            row_id,
            settle_refresh,
            asked_at: now,
        };
        *in_flight = Some((session_id, tokio::spawn(run_synopsis(job))));
    }
}

/// One due session's ask, off the loop: refresh the prompts, compose the
/// digest, ask, impose the register, gate, write, push. Every early return is a
/// silent skip.
async fn run_synopsis(job: SynopsisJob) -> SynopsisOutcome {
    let SynopsisJob {
        session_id,
        row_id,
        activity,
        cache,
        pending_ask,
        jsonl,
        shared_agent,
        ledger,
        control_tx,
        cancel,
        barrier_epoch,
        settle_refresh,
        asked_at,
    } = job;
    let mut outcome = SynopsisOutcome {
        session_id: session_id.clone(),
        cache: PromptCache::default(),
        caught_up_ask: None,
        asked: false,
        failed: false,
        barrier_epoch,
        settle_refresh,
        asked_at,
    };
    // The prompts are the better half of the digest and the required one: with
    // no ask there is nothing to describe. An identity that won't resolve — the
    // supervisor's map has no claude id yet, or the ledger has no project dir —
    // still leaves the pending ask, which is enough for a young session. The
    // refresh reads only appended bytes, off the async thread; a panicked read
    // costs the cache, never the tick.
    match jsonl {
        Some(jsonl) => {
            let read = tokio::task::spawn_blocking(move || {
                let mut cache = cache;
                cache.refresh(&jsonl);
                cache
            })
            .await;
            match read {
                Ok(cache) => outcome.cache = cache,
                Err(error) => {
                    warn!(%error, session = %session_id, "session synopsis: prompt read panicked");
                }
            }
        }
        None => {
            debug!(
                session = %session_id,
                "session synopsis: identity unresolved; digest from the pending ask alone",
            );
            outcome.cache = cache;
        }
    }
    // The newest submission leads the digest until the JSONL spells it back;
    // until then the cache's own current ask is the item it closed, and it
    // takes its place at the head of the arc exactly as a refresh would put it
    // there.
    let mut arc: Vec<String> = outcome.cache.arc.iter().cloned().collect();
    let mut recent_ask = outcome.cache.current_ask.clone();
    if let Some(ask) = pending_ask {
        if outcome.cache.carries(&ask) {
            outcome.caught_up_ask = Some(ask);
        } else {
            if let Some(current) = recent_ask.take() {
                if current != ask && arc.last() != Some(&current) {
                    arc.push(current);
                }
            }
            recent_ask = Some(ask);
        }
    }
    let Some(digest) = compose_synopsis_digest(
        outcome.cache.opening.as_deref(),
        &arc,
        recent_ask.as_deref(),
        &activity,
        None,
    ) else {
        debug!(session = %session_id, "session synopsis: nothing to describe");
        return outcome;
    };
    // The read yields the description this ask is revising, which is the last
    // section of the digest: a re-run should revise a standing line, not
    // compose a fresh one every minute against slightly different evidence.
    //
    // A rename does not stop the ask. The name is the session's title and this
    // is the line beneath it ([D132]), so both are wanted on a renamed session.
    let previous = match ledger.get(&row_id) {
        Ok(Some(row)) => row.synopsis,
        Ok(None) => {
            debug!(session = %session_id, row = %row_id, "session synopsis: no ledger row");
            return outcome;
        }
        Err(error) => {
            warn!(%error, session = %session_id, "session synopsis: ledger read failed");
            return outcome;
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
        debug!(session = %session_id, "session synopsis: no shared agent");
        outcome.failed = true;
        return outcome;
    };
    let started = Instant::now();
    let answer = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            debug!(session = %session_id, "session synopsis: cancelled mid-ask");
            return outcome;
        }
        answered = agent.run("synopsis", digest.clone()) => match answered {
            Ok(text) => text,
            Err(error) => {
                warn!(
                    %error,
                    session = %session_id,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "session synopsis: ask failed",
                );
                outcome.failed = true;
                return outcome;
            }
        },
    };
    // The model answered, so the window and the settle refresh are spent
    // whatever the gate then rules. Marking only on a written description would
    // loop: the refresh fires on `settled_at`, which no refusal changes, so a
    // line the gate keeps refusing would be re-asked for as long as the session
    // stayed idle.
    outcome.asked = true;
    // Judged unclipped — see `RegisterReport::unclipped`. What ships is `text`.
    let report = synopsis_register_report(&answer);
    match ground_synopsis(&report.unclipped, &digest) {
        GroundingVerdict::Grounded => {}
        GroundingVerdict::Ungrounded { rule, detail } => {
            info!(
                session = %session_id,
                rule = %rule,
                synopsis = ?report.unclipped,
                detail = ?detail,
                "session synopsis: refused",
            );
            return outcome;
        }
    }
    if report.text.is_empty() {
        return outcome;
    }
    match ledger.record_synopsis(&row_id, &report.text) {
        Ok(true) => {
            info!(
                session = %session_id,
                row = %row_id,
                elapsed_ms = started.elapsed().as_millis() as u64,
                raw = %answer,
                synopsis = %report.text,
                normalized = report.normalized,
                clipped = report.clipped,
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
    outcome
}

/// Land an ask's outcome back on the loop's state: restore the cache, settle
/// the back-off, and spend the debounce window and the settle refresh when the
/// model was actually reached.
fn apply_synopsis_outcome(
    outcome: SynopsisOutcome,
    sessions: &mut HashMap<String, SessionState>,
    backoff: &mut BackOff,
    queue: &mut VecDeque<String>,
    active: &mut HashSet<String>,
) {
    let SynopsisOutcome {
        session_id,
        cache,
        caught_up_ask,
        asked,
        failed,
        barrier_epoch,
        settle_refresh,
        asked_at,
    } = outcome;
    if failed {
        // The back-off is process-wide. The queued sessions behind this one
        // drop with their beats unconsumed, so their evidence survives for
        // the first allowed sweep after the back-off lifts.
        backoff.fail(Instant::now());
        for id in queue.drain(..) {
            active.remove(&id);
        }
    } else if asked {
        backoff.succeed();
    }
    let Some(state) = sessions.get_mut(&session_id) else {
        return;
    };
    // An ask that crossed an idle barrier in flight describes a finished
    // stretch, and the barrier is hard: no window spent, no refresh marked.
    // Only the cache's read position survives — with its asks dropped —
    // because losing the offset would make the next refresh re-read the whole
    // transcript and haul the old stretch back in.
    if barrier_epoch != state.barrier_epoch {
        let mut cache = cache;
        cache.barrier();
        state.prompts = cache;
        debug!(session = %session_id, "session synopsis: outcome predates idle barrier");
        return;
    }
    state.prompts = cache;
    if let Some(ask) = caught_up_ask {
        if state.pending_ask.as_ref() == Some(&ask) {
            state.pending_ask = None;
        }
    }
    if asked {
        state.last_synopsis = Some(asked_at);
        if settle_refresh {
            state.settle_refreshed = true;
            state.activity_since_settle = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcast_core::FeedId;

    /// The register normalizer's text alone. Every production path wants the
    /// report; these tests are about the string it produces.
    fn register(raw: &str) -> String {
        synopsis_register_report(raw).text
    }

    #[test]
    fn gate_truth_table() {
        let gates = |tenant, backing| {
            Gates {
                tenant_enabled: tenant,
                backing_off: backing,
            }
            .allow()
        };
        assert!(gates(true, false));
        assert!(!gates(false, false));
        assert!(!gates(true, true));
        assert!(!gates(false, true));
    }

    /// The numbers themselves are design values: the job table in
    /// `shared_agent.rs` asserts its `synopsis` ceiling sits under the debounce,
    /// and the tick has to land well inside it for the sweep to be the sole
    /// evaluation point.
    #[test]
    fn the_clocks_hold_their_ordering() {
        assert!(TICK_INTERVAL < SETTLE_REFRESH_AFTER);
        assert!(SETTLE_REFRESH_AFTER < SYNOPSIS_MIN_INTERVAL);
        assert_eq!(SETTLE_REFRESH_AFTER, Duration::from_secs(30));
        assert_eq!(SYNOPSIS_MIN_INTERVAL, Duration::from_secs(60));
        // Retention dwarfs the pacing: pruning can never race a session that is
        // merely between beats.
        assert!(SESSION_RETENTION > 10 * SYNOPSIS_MIN_INTERVAL);
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

    // -----------------------------------------------------------------------
    // The transcript vocabulary
    // -----------------------------------------------------------------------

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

    /// Verbatim CODE_OUTPUT lines, copied off the wire rather than composed
    /// here. Every other fixture in this module is hand-written, and a
    /// hand-written frame agrees with whatever the reader happens to expect —
    /// which is how this module spent its whole life reading a field tugcode
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

    // -----------------------------------------------------------------------
    // Accumulation
    // -----------------------------------------------------------------------

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

    /// A turn ending says the session moved without saying anything.
    #[test]
    fn a_turn_beat_advances_counters_without_a_line() {
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Turn);
        assert!(state.activity.is_empty());
        assert_eq!(state.activity_since_settle, 0);
        assert_eq!(state.new_beats, 1);
    }

    /// Only a content-bearing beat is a line in the digest, so only those count
    /// toward a settled stretch having something to say it did.
    #[test]
    fn activity_since_settle_counts_content_bearing_beats_alone() {
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Turn);
        state.record_now(SessionBeat::Tool("Read(a.rs)".to_string()));
        state.record_now(SessionBeat::Shell(None));
        state.record_now(SessionBeat::Said("said: porting the router".to_string()));
        assert_eq!(state.activity_since_settle, 2);
        assert_eq!(state.new_beats, 4);
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

    /// An ask arriving mid-prose-stream neither finalizes the open block nor
    /// clears the dedup set — those stay keyed to CODE_OUTPUT turn frames.
    #[test]
    fn an_ask_mid_prose_stream_leaves_the_open_block_and_dedup_untouched() {
        let mut state = SessionState::new(Instant::now());
        state.observe_now(prose("m1", 0, true, "Working through the cadence"));
        // The submission arm's exact sequence.
        state.human_act();
        state.pending_ask = Some("and check the floor".to_string());
        state.record_now(SessionBeat::Asked(Some("and check the floor".to_string())));
        state.observe_now(prose("m1", 0, true, " logic and what the floor guards."));
        state.observe_now(turn());

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
        assert_eq!(state.pending_ask.as_deref(), Some("and check the floor"));
    }

    /// A return to idle is a hard barrier: the next human act starts a new
    /// stretch, and nothing from the finished one — activity, pending ask —
    /// may appear in a description again.
    #[test]
    fn a_human_act_after_rest_crosses_the_idle_barrier() {
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Tool("Bash(cargo test)".to_string()));
        state.pending_ask = Some("fix the parser".to_string());
        state.record_now(SessionBeat::Turn);
        let epoch = state.barrier_epoch;

        state.human_act();
        assert!(
            state.activity.is_empty(),
            "the finished stretch's lines must not survive the barrier: {:?}",
            state.activity
        );
        assert!(state.pending_ask.is_none());
        assert_eq!(state.barrier_epoch, epoch + 1);
    }

    /// Machinery beats after the rest — trailing prose, a snapshot replay —
    /// un-settle the refresh clock, but the rest still happened: the next
    /// human act crosses the barrier all the same, and the twitch's own
    /// lines fall behind it too.
    #[test]
    fn machinery_beats_after_rest_do_not_disarm_the_barrier() {
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Tool("Bash(cargo test)".to_string()));
        state.record_now(SessionBeat::Turn);
        state.observe_now(prose(
            "m1",
            0,
            false,
            "One trailing remark after the turn already ended, long enough to record.",
        ));
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

    // -----------------------------------------------------------------------
    // The trigger
    // -----------------------------------------------------------------------

    /// "The session moved" is the whole condition, and it is derived from the
    /// beats themselves — a session with nothing new is never due, however long
    /// it waits.
    #[tokio::test(start_paused = true)]
    async fn a_session_is_due_the_moment_it_moves() {
        let clocks = Clocks::default();
        let mut state = SessionState::new(Instant::now());
        assert!(!state.synopsis_due(Instant::now(), &clocks));

        state.record_now(SessionBeat::Tool("Bash(cargo build)".to_string()));
        assert!(state.synopsis_due(Instant::now(), &clocks));

        // Taking the ask consumes the beats; nothing new means nothing due,
        // however many windows pass.
        state.commit_ask();
        tokio::time::advance(SYNOPSIS_MIN_INTERVAL * 10).await;
        assert!(!state.synopsis_due(Instant::now(), &clocks));

        // And one more beat re-arms it.
        state.record_now(SessionBeat::Tool("Bash(cargo test)".to_string()));
        assert!(state.synopsis_due(Instant::now(), &clocks));
    }

    /// The debounce is the only pacing, and due-ness outlives a window it was
    /// not allowed to use: a session that comes due inside the window is
    /// deferred to the next one rather than dropped.
    #[tokio::test(start_paused = true)]
    async fn due_ness_survives_a_window_it_could_not_use() {
        let clocks = Clocks::default();
        let mut state = SessionState::new(Instant::now());
        state.last_synopsis = Some(Instant::now());
        state.record_now(SessionBeat::Tool("Bash(cargo build)".to_string()));

        tokio::time::advance(SYNOPSIS_MIN_INTERVAL / 2).await;
        let now = Instant::now();
        assert!(state.synopsis_due(now, &clocks));
        assert!(
            !state.debounce_open(now, clocks.min_interval),
            "the window is still closed"
        );

        tokio::time::advance(SYNOPSIS_MIN_INTERVAL).await;
        let now = Instant::now();
        assert!(state.synopsis_due(now, &clocks), "still due, not swallowed");
        assert!(state.debounce_open(now, clocks.min_interval));
    }

    /// A settled stretch earns exactly one refresh, and only once it has been
    /// quiet long enough and has something to show for itself.
    #[tokio::test(start_paused = true)]
    async fn a_settled_stretch_is_due_once_and_re_arms_on_work() {
        let clocks = Clocks::default();
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Tool("Bash(cargo build)".to_string()));
        state.record_now(SessionBeat::Turn);
        state.commit_ask();

        // Inside the settle window, nothing is due — the beats are spent.
        tokio::time::advance(clocks.settle_after / 2).await;
        assert!(!state.synopsis_due(Instant::now(), &clocks));

        tokio::time::advance(clocks.settle_after).await;
        assert!(state.settle_refresh_due(Instant::now(), clocks.settle_after));

        // Marked when the model is asked, and then it stays marked however
        // long the session lies idle.
        state.settle_refreshed = true;
        state.activity_since_settle = 0;
        tokio::time::advance(clocks.settle_after * 100).await;
        assert!(!state.synopsis_due(Instant::now(), &clocks));

        // Work resumes and settles again: exactly one more.
        state.record_now(SessionBeat::Tool("Bash(cargo test)".to_string()));
        state.record_now(SessionBeat::Turn);
        state.commit_ask();
        tokio::time::advance(clocks.settle_after).await;
        assert!(state.settle_refresh_due(Instant::now(), clocks.settle_after));
    }

    /// A stretch that produced no lines has nothing new to say it did, which is
    /// what keeps a session that merely reconnects from re-asking.
    #[tokio::test(start_paused = true)]
    async fn a_settled_stretch_with_no_activity_is_not_due() {
        let clocks = Clocks::default();
        let mut state = SessionState::new(Instant::now());
        state.record_now(SessionBeat::Turn);
        state.commit_ask();
        tokio::time::advance(clocks.settle_after * 4).await;
        assert!(!state.synopsis_due(Instant::now(), &clocks));
    }

    // -----------------------------------------------------------------------
    // Register and clipping
    // -----------------------------------------------------------------------

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
        ("An idle barrier crossing", "idle barrier crossing"),
        ("Fixing   spaced\tout  text", "Fixing spaced out text"),
        // Articles come off the front only — one inside the line is part of
        // what the line says.
        ("Wiring the cadence gate.", "Wiring the cadence gate"),
        ("What broke the resume?", "What broke the resume?"),
        ("Ship it!", "Ship it!"),
        ("Wiring the gate...", "Wiring the gate..."),
        ("   ", ""),
        ("", ""),
    ];

    #[test]
    fn the_normalizer_imposes_the_descriptions_register() {
        for (raw, want) in REGISTER_CORPUS {
            assert_eq!(&register(raw), want, "input: {raw:?}");
        }
    }

    #[test]
    fn the_normalizer_is_idempotent() {
        for (raw, _) in REGISTER_CORPUS {
            let once = register(raw);
            assert_eq!(register(&once), once, "input: {raw:?}");
        }
    }

    #[test]
    fn the_normalizer_clips_to_the_budget() {
        let long = "x".repeat(MAX_SYNOPSIS_CHARS + 20);
        let out = register(&long);
        assert_eq!(out.chars().count(), MAX_SYNOPSIS_CHARS + 1);
        assert!(out.ends_with('…'));
        // The clip marker is not a trailing period, so a second pass leaves it.
        assert_eq!(register(&out), out);
    }

    #[test]
    fn the_normalizer_clips_on_character_boundaries() {
        let long = "日".repeat(MAX_SYNOPSIS_CHARS + 5);
        let out = register(&long);
        assert_eq!(out.chars().count(), MAX_SYNOPSIS_CHARS + 1);
    }

    #[test]
    fn the_normalizer_strips_a_prefix_before_it_counts_the_budget() {
        // The filler opener comes off first, so the line underneath fits where
        // the raw string would have been clipped.
        let raw = format!("The user is working on {}", "y".repeat(MAX_SYNOPSIS_CHARS));
        let out = register(&raw);
        assert_eq!(out, "y".repeat(MAX_SYNOPSIS_CHARS));
        assert!(!out.ends_with('…'));
    }

    /// The normalizer's work rate is only readable if a line it left alone
    /// says so.
    #[test]
    fn a_line_already_in_register_reports_no_work() {
        let report = synopsis_register_report("Wire the synopsis trigger to the beats");
        assert_eq!(report.text, "Wire the synopsis trigger to the beats");
        assert!(!report.normalized);
        assert!(!report.clipped);
    }

    /// Article stripping alone is work worth reporting, with the budget
    /// uninvolved.
    #[test]
    fn article_stripping_alone_reports_normalized() {
        let report = synopsis_register_report("The download resume path");
        assert_eq!(report.text, "download resume path");
        assert!(report.normalized);
        assert!(!report.clipped);
    }

    /// The description is allowed to be a sentence with two halves. "Rework how
    /// a session names itself **and** adopt it at every surface" is the line
    /// doing its job, and the half past `and` is the half that says how far the
    /// work reaches.
    #[test]
    fn a_two_part_sentence_survives_the_register_whole() {
        let long = "Rework how a session names itself and adopt it at every surface";
        let report = synopsis_register_report(long);
        assert_eq!(report.text, long);
        assert!(!report.clipped);
        assert!(report.text.chars().count() <= MAX_SYNOPSIS_CHARS);

        // Everything mechanical is still imposed: quotes, filler openers, the
        // leading article, the terminal period.
        let messy = "\"The user is working on the wedge recovery path.\"";
        assert_eq!(synopsis_register_report(messy).text, "wedge recovery path");

        // And the budget really does clip — the line is chrome, not prose.
        let overlong = "x".repeat(MAX_SYNOPSIS_CHARS + 40);
        assert_eq!(
            synopsis_register_report(&overlong).text.chars().count(),
            MAX_SYNOPSIS_CHARS + 1,
            "clip marks what it dropped with one ellipsis"
        );
    }

    // -----------------------------------------------------------------------
    // The digest
    // -----------------------------------------------------------------------

    /// The eval corpus (`tests/model-eval/corpus`) feeds frozen digests to the
    /// real model to score its wording. Those digests are only worth scoring if
    /// they are the bytes this module would actually send, so they are
    /// generated by this very function and pinned here: change
    /// `compose_synopsis_digest`'s wording and this fails, naming the file to
    /// regenerate.
    ///
    /// `TUG_REGENERATE_DIGESTS=1 cargo nextest run corpus_digests` rewrites them.
    #[test]
    fn corpus_digests_are_what_the_composer_produces() {
        let mut checked = 0;
        for entry in corpus_entries() {
            let digest = compose_synopsis_digest(
                entry.opening.as_deref(),
                &entry.arc,
                entry.recent_ask.as_deref(),
                &entry.activity,
                None,
            )
            .unwrap_or_else(|| panic!("{} describes nothing", entry.input.display()));
            freeze(&entry.input.with_extension("digest.txt"), &digest);
            checked += 1;
        }
        assert!(checked >= 12, "corpus shrank to {checked} entries");
    }

    struct CorpusEntry {
        input: PathBuf,
        opening: Option<String>,
        arc: Vec<String>,
        recent_ask: Option<String>,
        activity: Vec<String>,
    }

    /// The corpus inputs, read as the composer's arguments: the prompt list is
    /// the session's asks in order, so its first entry is the opening, its last
    /// is the current work item, and everything before that is the arc.
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
                let prompts = strings("prompts");
                CorpusEntry {
                    opening: prompts.first().cloned(),
                    recent_ask: prompts.last().cloned(),
                    arc: prompts[..prompts.len().saturating_sub(1)].to_vec(),
                    activity: strings("tools"),
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

    /// The digest leads with the NEWEST work item and files everything older
    /// behind it. It shipped the other way — opener first, arc in chronological
    /// order — and the line it produced named a session's first job ahead of
    /// the work actually under way.
    #[test]
    fn the_digest_leads_with_the_newest_work_item() {
        let digest = compose_synopsis_digest(
            Some("audit the ledger's migrations"),
            &[
                "audit the ledger's migrations".to_string(),
                "now repair the wedge".to_string(),
            ],
            Some("write the doctrine entry"),
            &["Edit(doctrine.md)".to_string()],
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
        assert!(present.contains("- Edit(doctrine.md)"));
        // The standing line the model is revising closes it out.
        assert!(digest.contains(SESSION_PREVIOUS_HEADING));
        assert!(digest.contains("Audit and repair the ledger's migrations"));
    }

    /// Prior asks print newest first — the order the description weighs them
    /// in — and a one-ask session prints its one ask once, under the subject
    /// heading, with no context section restating it.
    #[test]
    fn the_digest_orders_prior_asks_newest_first() {
        let digest = compose_synopsis_digest(
            Some("first job"),
            &["first job".to_string(), "second job".to_string()],
            Some("third job"),
            &[],
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
            compose_synopsis_digest(Some("the only ask"), &[], Some("the only ask"), &[], None)
                .expect("one ask is something to describe");
        assert!(young.starts_with(SESSION_RECENT_HEADING));
        assert_eq!(young.matches("the only ask").count(), 1);
        assert!(!young.contains(SESSION_OPENING_HEADING));
    }

    /// The present section is background, so it carries only the newest lines —
    /// a long session's ancient history never reaches the model, and the
    /// section is omitted entirely when there is nothing running.
    #[test]
    fn the_present_section_carries_only_the_newest_activity_lines() {
        let activity: Vec<String> = (0..(SYNOPSIS_ACTIVITY_LINES + 6))
            .map(|i| format!("Read(file_{i}.rs)"))
            .collect();
        let digest =
            compose_synopsis_digest(None, &[], Some("port the router"), &activity, None).unwrap();
        let present = digest
            .split_once(SESSION_PRESENT_HEADING)
            .expect("the present section")
            .1;
        assert_eq!(
            present.matches("- ").count(),
            SYNOPSIS_ACTIVITY_LINES,
            "exactly the budget, no more"
        );
        for i in 0..6 {
            assert!(
                !present.contains(&format!("Read(file_{i}.rs)")),
                "line {i} should have been dropped"
            );
        }
        for i in 6..activity.len() {
            assert!(
                present.contains(&format!("Read(file_{i}.rs)")),
                "line {i} missing"
            );
        }

        let quiet = compose_synopsis_digest(None, &[], Some("port the router"), &[], None).unwrap();
        assert!(!quiet.contains(SESSION_PRESENT_HEADING));
    }

    /// Nothing said yet is nothing to describe: an honestly empty description
    /// beats a composed one about no evidence. Activity alone never asks — a
    /// session with no human act has nothing to be about.
    #[test]
    fn nothing_said_yet_is_nothing_to_describe() {
        assert!(compose_synopsis_digest(None, &[], None, &[], None).is_none());
        assert!(
            compose_synopsis_digest(None, &[], None, &["Bash(cargo build)".to_string()], None)
                .is_none()
        );
    }

    // -----------------------------------------------------------------------
    // The grounding gate
    // -----------------------------------------------------------------------

    fn refusal(line: &str, name: &str) -> (&'static str, String) {
        match ground_synopsis(line, &digest(name)) {
            GroundingVerdict::Grounded => {
                panic!("{line:?} was accepted against {name}, expected a refusal")
            }
            GroundingVerdict::Ungrounded { rule, detail } => (rule, detail),
        }
    }

    fn assert_grounded(line: &str, name: &str) {
        if let GroundingVerdict::Ungrounded { rule, detail } = ground_synopsis(line, &digest(name))
        {
            panic!("{line:?} refused against {name} by {rule} ({detail})");
        }
    }

    /// Every defective answer recorded during the measurement passes, against a
    /// real digest, with the rule that has to catch it.
    #[test]
    fn the_real_defective_lines_are_refused() {
        // A tool line copied straight through as the description.
        assert_eq!(
            refusal("Bash make", "parts-list-tail").0,
            "tool-name-opener"
        );
        // The mid-token truncation seen on the row. `…` is `clip`'s marker.
        assert_eq!(refusal("Write jul29-p…", "one-line-goal").0, "path-bearing");
        assert_eq!(
            refusal("Write /tmp/calc/calc.c", "one-line-goal").0,
            "path-bearing"
        );
        // Prompt examples returned verbatim. The examples are disjoint from
        // every digest, so grounding catches them with no copy of the example
        // list.
        assert_eq!(
            refusal("Fix cursor loss after descend", "one-line-goal").0,
            "ungrounded"
        );
        assert_eq!(
            refusal("Wire schema migration backfill", "parts-list-tail").0,
            "ungrounded"
        );
        // The `lag/2a4460f9` cluster, against the digest of the session that was
        // actually about a command-line calculator.
        for line in [
            "Fix lagging editor input",
            "Fix sed command lagging",
            "Fix typing lag in command-line calculator",
        ] {
            assert_eq!(refusal(line, "parts-list-tail").0, "ungrounded");
        }
    }

    /// The false-positive guard. A correct description for each frozen digest
    /// must survive, or the gate buys truth with silence.
    #[test]
    fn a_correct_description_survives_every_frozen_digest() {
        for (line, name) in [
            (
                "Trace release version tags for self update",
                "app-self-update",
            ),
            (
                "Explain maxwell equations and primality",
                "conversation-only",
            ),
            (
                "Diagnose the debug instance stuck at the launch screen",
                "debug-launch-stuck",
            ),
            (
                "Repair file completion path canonicalization",
                "file-completion-paths",
            ),
            ("Chase composer typing lag", "fresh-directive"),
            (
                // `TugSetup` is the wording this frozen digest actually holds —
                // a line is grounded against its own digest's words, so a
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
                "Fix download resume and port shell router",
                "two-goals-one-session",
            ),
        ] {
            assert_grounded(line, name);
        }
    }

    /// The threshold in `GROUNDED_MIN_*` is a choice, so it is pinned by the
    /// cases that rule the neighbouring values out rather than by assertion.
    ///
    /// Looser (one half) accepts a real defect: `Fix typing lag in command-line
    /// calculator` grounds most of its subject against `parts-list-tail`,
    /// because that session really was about a command-line calculator — the
    /// words it invents are the ones that matter. Stricter (three quarters)
    /// refuses correct lines that reach for one word the digest spells
    /// differently, which is the staleness the gate must not buy.
    #[test]
    fn the_grounding_threshold_is_the_loosest_that_still_refuses_the_defects() {
        // Two thirds is what ships.
        assert_eq!(GROUNDED_MIN_NUMERATOR, 2);
        assert_eq!(GROUNDED_MIN_DENOMINATOR, 3);

        let ratio = |line: &str, name: &str| -> (usize, usize) {
            let digest = digest(name);
            let words = content_words(line);
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

        // A correct line that three quarters would refuse and two thirds keeps.
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
    }

    /// A digest writes filenames and a description has room to name one, so a
    /// dotted token has to contribute the parts a description says.
    ///
    /// Found by a sweep, not by reasoning: two of the resident model's twelve
    /// answers were refused as ungrounded while being plainly correct —
    /// `nocturne` and `aria` appear in the digest only inside
    /// `Read(tugdeck/styles/themes/nocturne.css)`, and `vite config` only
    /// inside `Read(vite.config.ts)`. No threshold reaches that.
    #[test]
    fn a_description_grounds_against_a_filename_the_digest_only_spells_dotted() {
        assert_grounded(
            "Audit theme contrast in nocturne and aria css",
            "noun-pile-bait",
        );
        // The whole token survives beside its parts, so a line naming the file
        // exactly still matches — the reason the dot is not simply added to the
        // split set.
        assert_eq!(
            content_words("Read(calc.c)"),
            ["read", "calc.c", "calc", "c"]
        );
    }

    /// A bare filename is a proper name, not a path — `score.py`'s rubric
    /// exempts identifiers and dotted paths, and the gate must not contradict
    /// it.
    #[test]
    fn a_bare_filename_is_allowed_where_a_path_is_not() {
        assert_eq!(
            refusal("Trace tugcast/src/feeds cadence gate", "one-line-goal").0,
            "path-bearing"
        );
    }

    /// The digest's own present section is the tool-name set, so a new Claude
    /// tool needs no change here — and the user's own verbs stay out of it.
    #[test]
    fn tool_names_come_from_the_present_section_only() {
        let digest = compose_synopsis_digest(
            Some("fix the typing lag in the composer"),
            &[],
            Some("fix the typing lag in the composer"),
            &["Read(tugdeck/src/components/tugways/tug-prompt-entry.tsx)".to_string()],
            None,
        )
        .expect("describes something");
        assert_eq!(
            digest_tool_names(&digest),
            ["read"].iter().map(|s| s.to_string()).collect()
        );
        for ask_word in ["fix", "typing", "lag", "composer"] {
            assert!(
                !digest_tool_names(&digest).contains(ask_word),
                "{ask_word} entered the tool-name set"
            );
        }
    }

    /// The poisoned-set regression, direct: `Fix` is the most common opener by
    /// a wide margin, and an unscoped parse would make it unemittable for any
    /// session whose ask happens to open on the same word.
    #[test]
    fn an_ask_verb_does_not_become_a_tool_name() {
        let digest = compose_synopsis_digest(
            Some("fix the typing lag in the composer"),
            &[],
            Some("fix the typing lag in the composer"),
            &["Read(tugdeck/src/components/tugways/tug-prompt-entry.tsx)".to_string()],
            None,
        )
        .expect("describes something");
        assert_eq!(
            ground_synopsis("Fix composer typing lag", &digest),
            GroundingVerdict::Grounded
        );
    }

    /// The gate must never read its OWN clip marker as the defect it is looking
    /// for. `…` in a token means the model quoted a truncated path out of the
    /// digest — but the register normalizer appends exactly that character when
    /// an answer runs past the budget, so grounding the clipped text refused
    /// every over-long description as `path-bearing`. On 2026-08-09 that was 101
    /// of the day's 112 refusals, and the card showed a description frozen for as
    /// long as the model kept writing long.
    #[test]
    fn an_over_budget_answer_is_not_refused_for_the_gate_s_own_clip_marker() {
        let ask = "align the session description and pulse activity indent flush \
                   with the title across the picker, the title bar, and the rail";
        let digest = compose_synopsis_digest(
            Some(ask),
            &[],
            Some(ask),
            &["Edit(tugdeck/src/components/tugways/tug-session-row.css)".to_string()],
            None,
        )
        .expect("describes something");
        let answer = "Align the session description and pulse activity indent \
                      flush with the title across the picker, the title bar, and the rail";
        let report = synopsis_register_report(answer);
        assert!(report.clipped, "the fixture must exercise the clip");
        assert!(report.text.ends_with('…'));

        assert_eq!(
            ground_synopsis(&report.unclipped, &digest),
            GroundingVerdict::Grounded
        );
        // The same line judged clipped is what the defect looked like. Pinned so
        // a caller that goes back to grounding `text` fails here rather than in
        // a log nobody reads.
        assert!(matches!(
            ground_synopsis(&report.text, &digest),
            GroundingVerdict::Ungrounded {
                rule: "path-bearing",
                ..
            }
        ));
    }

    /// Restating one tool line is the description/activity collapse the gate was
    /// built to refuse: the line says what the digest already said the session
    /// is doing, instead of naming what it is for.
    #[test]
    fn restating_a_single_tool_line_is_refused() {
        let digest = compose_synopsis_digest(
            Some("make the emitter run on a clock"),
            &[],
            Some("make the emitter run on a clock"),
            &["Bash(cargo nextest run session_synopsis)".to_string()],
            None,
        )
        .expect("describes something");
        // Every word but the verb comes from the one activity line.
        assert!(matches!(
            ground_synopsis("Trace cargo nextest session synopsis", &digest),
            GroundingVerdict::Ungrounded {
                rule: "activity-restatement",
                ..
            }
        ));
        // The words that make a description about *purpose* rather than about
        // the command are exactly what keeps it clear of the rule.
        assert_eq!(
            ground_synopsis("Make the emitter run on a clock", &digest),
            GroundingVerdict::Grounded
        );
    }

    /// An empty line is the gate's business too, so no caller needs a
    /// pre-check for it.
    #[test]
    fn an_empty_line_is_refused_by_the_gate_itself() {
        for text in ["", "   ", "\n"] {
            assert_eq!(refusal(text, "one-line-goal").0, "empty");
        }
    }

    /// The refusal rate the gate would produce over real model answers, printed
    /// rather than asserted.
    ///
    /// Reads `/tmp/register-<pack>.json` as written by `run.py --json`, so it is
    /// a no-op wherever those captures are absent — which is everywhere except a
    /// machine that has just run the register bake-off. It exists because the
    /// refusal rate is otherwise only observable from a live session.
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
            // carries `name` (the corpus entry) and `synopsis` (the normalized
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
                let Some(line) = row
                    .get("synopsis")
                    .or_else(|| row.get("headline"))
                    .and_then(|v| v.as_str())
                else {
                    continue;
                };
                let Ok(digest) = std::fs::read_to_string(corpus.join(format!("{case}.digest.txt")))
                else {
                    continue;
                };
                total += 1;
                if let GroundingVerdict::Ungrounded { rule, detail } =
                    ground_synopsis(line, &digest)
                {
                    refused += 1;
                    println!("REFUSED {name} {case}: {line:?} — {rule} ({detail})");
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

    // -----------------------------------------------------------------------
    // Identity
    // -----------------------------------------------------------------------

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
        use std::io::Write;
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

    /// The barrier drops the stretch's asks but keeps the read position, so a
    /// consumed ask is gone for good rather than re-read on the next refresh,
    /// while the session's own memory outlives it.
    #[test]
    fn the_prompt_cache_barrier_forgets_asks_but_not_its_place() {
        use std::io::Write;
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
            cache.first.as_deref(),
            Some("the new request"),
            "the new stretch's opening ask takes the pinned slot"
        );
        // The barrier is the STRETCH's boundary, not the session's. What the
        // session set out to do outlives it, and the ask it answered became an
        // arc entry the moment the next ask arrived.
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
            "the stretch's opener is still the trailing unanswered ask"
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
    /// into the first job's ask.
    #[test]
    fn asks_in_a_warm_session_are_work_item_boundaries() {
        use std::io::Write;
        let path = cache_tmp("warm-asks");
        std::fs::write(&path, "").unwrap();
        let mut cache = PromptCache::default();
        cache.refresh(&path);
        for ask in [
            "clean up the usage sheet",
            "clean up the gutter selection",
            "fix the focus caret in Jots",
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
            Some("fix the focus caret in Jots"),
            "the newest ask is the current work item, no barrier required"
        );
        assert_eq!(
            cache.arc.iter().cloned().collect::<Vec<_>>(),
            ["clean up the usage sheet", "clean up the gutter selection"].map(String::from),
            "each earlier ask closed into the arc when the next one arrived"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// A transcript that predates the cache is behind an unknown number of
    /// idle barriers: every ask a response follows was answered on a stretch
    /// this process never watched, and a restarted process must not haul it
    /// back into the digest.
    #[test]
    fn a_first_look_keeps_only_the_trailing_unanswered_asks() {
        use std::io::Write;
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
            cache.first.as_deref(),
            Some("the live request, not yet answered"),
            "only the unanswered trailing ask survives the first look"
        );
        assert!(cache.recent.len() == 1);

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
            cache.recent.iter().cloned().collect::<Vec<_>>(),
            ["the live request, not yet answered", "a follow-up"].map(String::from),
            "watched appends read plainly; a response no longer clears"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_partial_trailing_line_waits_for_its_newline() {
        use std::io::Write;
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
        assert_eq!(cache.opening.as_deref(), Some("rewritten"));
        assert!(cache.arc.is_empty());

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

    // -----------------------------------------------------------------------
    // The ask, end to end
    // -----------------------------------------------------------------------

    use crate::session_ledger::SessionLedger;
    use crate::shared_agent::{
        AgentSpec, AgentWorkerSpawner, JobSpec, SharedAgentPool, TurnRequest,
    };

    /// How the scripted agent answers.
    #[derive(Clone, Copy)]
    enum Lane {
        /// Answer with this text.
        Says(&'static str),
        /// Fail the job, the way a refusal or a dead worker does.
        Refuses,
        /// Accept the turn and never answer it, so the job hits its ceiling.
        Mute,
    }

    /// The agent the description is asked of.
    ///
    /// The script is swappable at runtime because several tests exercise the
    /// no-answer path first and install an answering agent afterward.
    #[derive(Clone)]
    struct FakeAgent {
        inner: Arc<std::sync::Mutex<FakeAgentScript>>,
    }

    struct FakeAgentScript {
        lane: Lane,
        /// Each job's digest, so a test can assert what the model was shown.
        seen: Option<tokio::sync::mpsc::Sender<String>>,
    }

    /// The job table this module is exercised against.
    ///
    /// The instruction body is a bare marker rather than the shipped wording:
    /// these tests are about the loop — when it asks, how it gates an answer,
    /// when it backs off — and pinning them to prompt prose would make every
    /// wording edit look like a loop regression. The shipped instructions carry
    /// their own contract test in `shared_agent.rs`.
    static SYNOPSIS_TEST_JOBS: &[JobSpec] = &[JobSpec {
        name: "synopsis",
        instructions: "SYNOPSIS",
        timeout: Duration::from_secs(6),
        slow: None,
    }];

    impl FakeAgent {
        fn new(lane: Lane) -> Self {
            Self {
                inner: Arc::new(std::sync::Mutex::new(FakeAgentScript { lane, seen: None })),
            }
        }

        /// Rewrite the script and take a fresh digest channel.
        fn script(&self, lane: Lane) -> tokio::sync::mpsc::Receiver<String> {
            let (seen_tx, seen_rx) = tokio::sync::mpsc::channel::<String>(64);
            let mut inner = self.inner.lock().unwrap();
            inner.lane = lane;
            inner.seen = Some(seen_tx);
            seen_rx
        }

        fn pool(&self) -> Arc<SharedAgentPool> {
            SharedAgentPool::new(
                AgentSpec {
                    name: "test",
                    model: Arc::new(|| "test-model".to_string()),
                    jobs: SYNOPSIS_TEST_JOBS,
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
                    // The turn is `<instructions>\n\n<digest>`, so the
                    // remainder past the marker is the digest.
                    let text = turn.text;
                    let (_, digest) = text.split_once("\n\n").unwrap_or((text.as_str(), ""));
                    let (lane, seen) = {
                        let script = inner.lock().unwrap();
                        (script.lane, script.seen.clone())
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
    /// Seeded through the same `claude_project_dir` chokepoint this module
    /// uses, so the fixture and production agree on the spelling ([L29]) — a
    /// fixture that encoded the raw string would keep passing while the loop
    /// looked somewhere else.
    fn seed_jsonl(root: &std::path::Path, project_dir: &str, claude_id: &str, prompt: &str) {
        use std::io::Write;
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

    /// Append one more user prompt to an already-seeded session JSONL — the
    /// scribe catching up with a submission the tap already narrated.
    fn append_jsonl(root: &std::path::Path, project_dir: &str, claude_id: &str, prompt: &str) {
        use std::io::Write;
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

    fn user_message_frame(session: &str, text: &str) -> Frame {
        let body = serde_json::json!({
            "tug_session_id": session,
            "type": "user_message",
            "content": [{ "type": "text", "text": text }],
        });
        Frame::new(FeedId::CODE_INPUT, serde_json::to_vec(&body).unwrap())
    }

    struct Harness {
        code_tx: broadcast::Sender<Frame>,
        shell_tx: broadcast::Sender<Frame>,
        submission_tx: broadcast::Sender<Frame>,
        control_rx: broadcast::Receiver<Frame>,
        /// Each ask's digest, in order — what the model saw.
        digests: tokio::sync::mpsc::Receiver<String>,
        /// The scripted agent, so a test can rewrite its answer after
        /// exercising an earlier path.
        agent: FakeAgent,
        ledger: Arc<SessionLedger>,
        cancel: CancellationToken,
        tmp: PathBuf,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.cancel.cancel();
            let _ = std::fs::remove_dir_all(&self.tmp);
        }
    }

    /// Far enough out that the settle refresh never fires in a test that is not
    /// about it — every one of these harnesses runs a session to rest and would
    /// otherwise pick up a refresh it never asked for.
    const NEVER_SETTLE: Duration = Duration::from_secs(3_600);

    /// `start` with the loop-test clocks: no debounce, no settle refresh, so
    /// any beat is due at the next tick. The trigger itself is covered by the
    /// pure tests above; this harness shape is about the loop.
    fn start(answer: Option<&'static str>, tenant_on: bool, with_model: bool) -> Harness {
        start_clocked(
            answer,
            tenant_on,
            with_model,
            Clocks {
                min_interval: Duration::ZERO,
                settle_after: NEVER_SETTLE,
            },
        )
    }

    fn start_clocked(
        answer: Option<&'static str>,
        tenant_on: bool,
        with_model: bool,
        clocks: Clocks,
    ) -> Harness {
        let tmp = std::env::temp_dir().join(format!(
            "tugcast-synopsis-{}-{:?}",
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

        let ledger = Arc::new(SessionLedger::open_in_memory().expect("in-memory ledger"));
        ledger
            .record_spawn(
                "claude-1",
                "ws-alpha",
                "/tmp/project",
                "card-1",
                0,
                "claude-1",
                None,
            )
            .expect("seed the row the description lands on");

        let (code_tx, _) = broadcast::channel(64);
        let (shell_tx, _) = broadcast::channel(64);
        let (submission_tx, _) = broadcast::channel(64);
        let (control_tx, control_rx) = broadcast::channel(64);
        let lane = match answer {
            Some(text) => Lane::Says(text),
            None => Lane::Refuses,
        };
        let agent = FakeAgent::new(lane);
        let digests = agent.script(lane);
        let cancel = CancellationToken::new();
        let config = SessionSynopsisConfig {
            code_tx: code_tx.clone(),
            shell_tx: shell_tx.clone(),
            submission_tx: submission_tx.clone(),
            ledger: Some(Arc::clone(&ledger)),
            control_tx: Some(control_tx),
            tenant_enabled: Arc::new(move || tenant_on),
            shared_agent: with_model.then(|| agent.pool()),
            identity: SessionIdentity {
                resolver: Arc::new(|_| Some("claude-1".to_string())),
                project_dir: Arc::new(|_| Some("/tmp/project".to_string())),
                claude_projects_root: projects,
            },
            clocks,
        };
        let task_cancel = cancel.clone();
        tokio::spawn(async move { session_synopsis_task(config, task_cancel).await });
        Harness {
            code_tx,
            shell_tx,
            submission_tx,
            control_rx,
            digests,
            agent,
            ledger,
            cancel,
            tmp,
        }
    }

    /// Await the description carried by the next `session_updated` push, or
    /// `None` if none arrives promptly. The window is virtual: every loop test
    /// runs on the paused clock, so it covers several sweep ticks and costs no
    /// real time.
    async fn next_written(rx: &mut broadcast::Receiver<Frame>) -> Option<String> {
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await {
                Ok(Ok(frame)) => {
                    let Ok(body) = serde_json::from_slice::<serde_json::Value>(&frame.payload)
                    else {
                        continue;
                    };
                    if body["action"] != "session_updated" {
                        continue;
                    }
                    return body["fields"]["synopsis"].as_str().map(str::to_string);
                }
                _ => return None,
            }
        }
    }

    async fn next_digest(rx: &mut tokio::sync::mpsc::Receiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("an ask")
            .expect("the host is alive")
    }

    /// The next ask, or `None` once the host has gone quiet — for counting how
    /// many asks a stretch produced rather than awaiting a known number.
    async fn next_digest_opt(rx: &mut tokio::sync::mpsc::Receiver<String>) -> Option<String> {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .ok()
            .flatten()
    }

    fn drain_digests(rx: &mut tokio::sync::mpsc::Receiver<String>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(digest) = rx.try_recv() {
            out.push(digest);
        }
        out
    }

    /// Every ask made in the next `window` of the clock.
    ///
    /// For a test that cares which stretch produced the asks rather than how
    /// many: a gesture is a tool line plus the turn that closed it, and both
    /// are beats, so it lands as one ask when a sweep drains them together and
    /// as two when a tick falls between them. Which of those happens is a fact
    /// about scheduling, not about the module, and a fixed count makes the test
    /// fail on a loaded machine.
    async fn digests_within(
        rx: &mut tokio::sync::mpsc::Receiver<String>,
        window: Duration,
    ) -> Vec<String> {
        let deadline = tokio::time::Instant::now() + window;
        let mut out = Vec::new();
        while let Ok(Some(digest)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            out.push(digest);
        }
        out
    }

    #[tokio::test(start_paused = true)]
    async fn a_tool_use_frame_becomes_a_written_description() {
        let mut h = start(Some("Harden the watch loop."), true, true);
        // The subscription is created inside the task; give it a beat to exist
        // before the first send, or the frame is broadcast into an empty room.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();

        // The model answered with a sentence; what lands is a line of chrome,
        // so the trailing period never leaves this task.
        assert_eq!(
            next_written(&mut h.control_rx).await.as_deref(),
            Some("Harden the watch loop")
        );
        assert_eq!(
            h.ledger
                .get("claude-1")
                .unwrap()
                .unwrap()
                .synopsis
                .as_deref(),
            Some("Harden the watch loop"),
        );
        // The digest is the session's own: the user's ask leads it and the tool
        // line is filed under the present heading.
        let digest = next_digest(&mut h.digests).await;
        assert!(digest.starts_with(SESSION_RECENT_HEADING));
        assert!(digest.contains("make the watch loop resilient"));
        assert!(digest.contains(&format!("{SESSION_PRESENT_HEADING}\n- Bash(cargo build)\n")));
    }

    #[tokio::test(start_paused = true)]
    async fn the_tenant_switch_silences_it() {
        let mut h = start(Some("Harden the watch loop."), false, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        assert!(next_written(&mut h.control_rx).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn no_model_host_is_silence_not_an_error() {
        let mut h = start(None, true, false);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        assert!(next_written(&mut h.control_rx).await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_refusal_writes_nothing_and_backs_off() {
        let mut h = start(None, true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let _ = next_digest(&mut h.digests).await;
        assert!(next_written(&mut h.control_rx).await.is_none());
        // Back-off is now armed for a minute, so a second frame is silent too
        // rather than hammering a model that just said no.
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        assert!(next_digest_opt(&mut h.digests).await.is_none());
    }

    /// A line the digest does not support is refused, and the previous
    /// description stands rather than a wrong one replacing it.
    #[tokio::test(start_paused = true)]
    async fn an_ungrounded_line_is_refused_and_nothing_is_written() {
        let mut h = start(Some("Harvest the mango orchard."), true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let _ = next_digest(&mut h.digests).await;
        assert!(next_written(&mut h.control_rx).await.is_none());
        assert!(
            h.ledger
                .get("claude-1")
                .unwrap()
                .unwrap()
                .synopsis
                .is_none()
        );
    }

    /// Both outcome lines are data sources, not just prose: `tests/model-eval`'s
    /// batch analyzer counts refusals by `rule` and the normalizer's work rate
    /// off `normalized`/`clipped`, so every field it counts has to survive a
    /// split on whitespace — a rule with a space in it, or a flag sitting
    /// behind an unquoted description, reads as zero rather than as a failure.
    /// Captured from the emitting call sites rather than transcribed, so a
    /// formatting change fails here instead of turning into a quiet zero
    /// downstream.
    #[tokio::test(start_paused = true)]
    async fn the_outcome_lines_carry_analyzer_readable_fields() {
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
            let mut h = start(Some("Harvest the mango orchard."), true, true);
            tokio::time::sleep(Duration::from_millis(50)).await;
            h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
            let _ = next_digest(&mut h.digests).await;
            assert!(next_written(&mut h.control_rx).await.is_none());
            // Then one the digest does support, for the written line.
            h.digests = h.agent.script(Lane::Says("Harden the watch loop."));
            h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
            let _ = next_digest(&mut h.digests).await;
            assert!(next_written(&mut h.control_rx).await.is_some());
            String::from_utf8(sink.0.lock().unwrap().clone()).unwrap()
        };

        let line_with = |needle: &str| {
            captured
                .lines()
                .find(|l| l.contains(needle))
                .unwrap_or_else(|| panic!("no {needle:?} line in:\n{captured}"))
                .to_string()
        };
        let field = |line: &str, key: &str| {
            let prefix = format!("{key}=");
            line.split_whitespace()
                .find_map(|word| word.strip_prefix(&prefix).map(str::to_string))
                .unwrap_or_else(|| panic!("no {key} in {line}"))
        };

        let refused = line_with("session synopsis: refused");
        let rule = field(&refused, "rule");
        assert!(
            !rule.is_empty() && rule.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
            "a rule with a space in it splits into two counts: {rule:?}",
        );
        assert!(
            refused.contains(r#"synopsis="Harvest the mango orchard""#),
            "the refused line rides quoted so its spaces survive: {refused}",
        );

        // The flags sit at the end, past the unquoted description, so the split
        // reaches them whatever the model wrote.
        let written = line_with("session synopsis: written");
        assert_eq!(field(&written, "normalized"), "true");
        assert_eq!(field(&written, "clipped"), "false");
    }

    #[tokio::test(start_paused = true)]
    async fn replayed_frames_never_produce_a_description() {
        let mut h = start(Some("Harden the watch loop."), true, true);
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
        assert!(next_written(&mut h.control_rx).await.is_none());
    }

    /// A session doing only `$` work — nothing on CODE_OUTPUT at all — comes
    /// due and earns a description.
    #[tokio::test(start_paused = true)]
    async fn a_shell_only_session_is_still_described() {
        let mut h = start(Some("Harden the watch loop."), true, true);
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
        assert_eq!(
            next_written(&mut h.control_rx).await.as_deref(),
            Some("Harden the watch loop")
        );
    }

    /// The debounce is the only pacing, and a session that comes due inside the
    /// window is DEFERRED, not dropped — the ask arrives when the window opens,
    /// with no further frame to prompt it. Under the old design the post-settle
    /// ask ran exactly once and returned inside the window, so an idle session
    /// never got its final description at all.
    #[tokio::test(start_paused = true)]
    async fn a_session_due_inside_the_window_is_asked_when_it_opens() {
        let mut h = start_clocked(
            Some("Harden the watch loop."),
            true,
            true,
            Clocks {
                min_interval: SYNOPSIS_MIN_INTERVAL,
                settle_after: NEVER_SETTLE,
            },
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let first = next_digest(&mut h.digests).await;
        assert!(first.contains("Bash(cargo build)"));

        // A beat well inside the window: due, but not yet allowed.
        tokio::time::sleep(Duration::from_secs(5)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        tokio::time::sleep(Duration::from_secs(20)).await;
        assert!(
            drain_digests(&mut h.digests).is_empty(),
            "the window was closed"
        );

        // And it fires the moment the window opens, with nothing new arriving.
        tokio::time::sleep(SYNOPSIS_MIN_INTERVAL).await;
        let second = next_digest(&mut h.digests).await;
        assert!(second.contains("Bash(cargo test)"));
    }

    /// A settled session gets exactly one refresh per stretch, and work that
    /// resumes earns exactly one more.
    #[tokio::test(start_paused = true)]
    async fn a_settled_session_is_refreshed_exactly_once_per_stretch() {
        let mut h = start_clocked(
            Some("Harden the watch loop."),
            true,
            true,
            Clocks {
                min_interval: Duration::ZERO,
                settle_after: SETTLE_REFRESH_AFTER,
            },
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        h.code_tx.send(turn_complete_frame("s1")).unwrap();
        // The live work is described first — as one ask or two, which is a fact
        // about where the sweep boundary fell. Then the settle refresh once the
        // stretch has been quiet long enough, and nothing more however long it
        // stays at rest. The drain window is far inside `SETTLE_REFRESH_AFTER`,
        // so it can never swallow the refresh it is clearing the way for.
        assert!(
            !digests_within(&mut h.digests, TICK_INTERVAL * 4)
                .await
                .is_empty(),
            "the live work was never described"
        );
        tokio::time::sleep(SETTLE_REFRESH_AFTER + TICK_INTERVAL * 2).await;
        let refresh = next_digest(&mut h.digests).await;
        assert!(refresh.contains("Bash(cargo build)"));
        tokio::time::sleep(Duration::from_secs(1_800)).await;
        assert!(
            drain_digests(&mut h.digests).is_empty(),
            "the refresh was re-asked while the session lay idle"
        );

        // Work resumes and settles again: exactly one more refresh.
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        h.code_tx.send(turn_complete_frame("s1")).unwrap();
        assert!(
            !digests_within(&mut h.digests, TICK_INTERVAL * 4)
                .await
                .is_empty(),
            "the resumed work was never described"
        );
        tokio::time::sleep(SETTLE_REFRESH_AFTER + TICK_INTERVAL * 2).await;
        let refresh = next_digest(&mut h.digests).await;
        assert!(refresh.contains("Bash(cargo test)"));
        tokio::time::sleep(Duration::from_secs(1_800)).await;
        assert!(
            drain_digests(&mut h.digests).is_empty(),
            "the second stretch's refresh was re-asked while the session lay idle"
        );
    }

    /// The newest submission leads the digest until the JSONL spells it back,
    /// and then the cache carries it — once.
    #[tokio::test(start_paused = true)]
    async fn a_pending_ask_leads_the_digest_until_the_jsonl_catches_up() {
        let mut h = start(Some("Chase the parser bug."), true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.submission_tx
            .send(user_message_frame("s1", "now fix the parser"))
            .unwrap();
        let first = next_digest(&mut h.digests).await;
        assert!(first.starts_with(&format!("{SESSION_RECENT_HEADING}\n- now fix the parser\n")));
        // The ask the cache was carrying became the item this one closed.
        assert!(first.contains("make the watch loop resilient"));

        append_jsonl(
            &h.tmp.join("projects"),
            "/tmp/project",
            "claude-1",
            "now fix the parser",
        );
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        let second = next_digest(&mut h.digests).await;
        assert_eq!(second.matches("now fix the parser").count(), 1);
    }

    /// The session map is a rolling picture, not an archive: a session with
    /// no frames for the retention window is dropped at the sweep, and its
    /// next frame starts fresh — no stale background rides along.
    #[tokio::test(start_paused = true)]
    async fn an_idle_session_is_pruned_at_the_retention_window() {
        let mut h = start(Some("Harden the watch loop."), true, true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.code_tx.send(tool_use_frame("s1", "cargo build")).unwrap();
        let first = next_digest(&mut h.digests).await;
        assert!(first.contains("Bash(cargo build)"));

        tokio::time::sleep(SESSION_RETENTION + TICK_INTERVAL).await;
        h.code_tx.send(tool_use_frame("s1", "cargo test")).unwrap();
        let second = next_digest(&mut h.digests).await;
        assert!(second.contains("Bash(cargo test)"));
        assert!(
            !second.contains("cargo build"),
            "the pruned session's old activity resurfaced:\n{second}"
        );
    }

    /// The ask rides its own task: with the model hung at its ceiling, the loop
    /// still observes cancellation immediately. No virtual time passes after
    /// the cancel, so a loop blocked inside the ask would still hold its
    /// subscription — the receiver count is the tell.
    #[tokio::test(start_paused = true)]
    async fn cancellation_is_observed_mid_ask() {
        let h = start(None, true, true);
        // An agent that takes the job and never answers, so the ask is
        // genuinely in flight when the cancel arrives.
        let mut digests = h.agent.script(Lane::Mute);
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
            "the loop did not observe cancellation while an ask was in flight"
        );
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

    // -----------------------------------------------------------------------
    // The job, directly
    // -----------------------------------------------------------------------

    fn bare_job(
        ledger: Arc<SessionLedger>,
        shared_agent: crate::shared_agent::SharedAgentHandle,
        cache: PromptCache,
        pending_ask: Option<String>,
        activity: Vec<String>,
    ) -> SynopsisJob {
        SynopsisJob {
            session_id: "s1".to_string(),
            row_id: "claude-1".to_string(),
            activity,
            cache,
            pending_ask,
            jsonl: None,
            shared_agent,
            ledger,
            control_tx: None,
            cancel: CancellationToken::new(),
            barrier_epoch: 0,
            settle_refresh: false,
            asked_at: Instant::now(),
        }
    }

    fn seeded_ledger() -> Arc<SessionLedger> {
        let ledger = Arc::new(SessionLedger::open_in_memory().expect("in-memory ledger"));
        ledger
            .record_spawn(
                "claude-1",
                "ws-alpha",
                "/tmp/project",
                "card-1",
                0,
                "claude-1",
                None,
            )
            .unwrap();
        ledger
    }

    /// A session with no ask is never put to the model: activity alone is not
    /// an undertaking, and the window it never used stays open.
    #[tokio::test]
    async fn a_session_with_nothing_to_describe_is_not_asked() {
        let agent = FakeAgent::new(Lane::Says("Harden the watch loop."));
        let outcome = run_synopsis(bare_job(
            seeded_ledger(),
            Some(agent.pool()),
            PromptCache::default(),
            None,
            vec!["Bash(cargo build)".to_string()],
        ))
        .await;
        assert!(!outcome.asked, "the model must not have been reached");
        assert!(!outcome.failed);
    }

    /// A build that never made a pool writes nothing and arms the back-off —
    /// the degraded posture, reached through the absent handle rather than
    /// through a refusing agent.
    #[tokio::test]
    async fn an_absent_agent_writes_nothing_and_arms_the_back_off() {
        let cache = PromptCache {
            opening: Some("harden the watch loop".to_string()),
            current_ask: Some("harden the watch loop".to_string()),
            ..Default::default()
        };
        let ledger = seeded_ledger();
        let outcome = run_synopsis(bare_job(
            Arc::clone(&ledger),
            None,
            cache,
            None,
            vec!["Bash(cargo build)".to_string()],
        ))
        .await;
        assert!(outcome.failed, "an absent agent arms the back-off");
        assert!(!outcome.asked, "nothing reached the model");
        assert!(ledger.get("claude-1").unwrap().unwrap().synopsis.is_none());
    }

    /// A refused line still spends the window and the settle refresh: the
    /// refresh fires on `settled_at`, which no refusal changes, so an attempt
    /// marked only on a written description would re-fire on every sweep for as
    /// long as the session stayed idle.
    #[tokio::test]
    async fn a_refused_line_still_counts_as_asked() {
        let agent = FakeAgent::new(Lane::Says("Harvest the mango orchard."));
        let cache = PromptCache {
            opening: Some("harden the watch loop".to_string()),
            current_ask: Some("harden the watch loop".to_string()),
            ..Default::default()
        };
        let ledger = seeded_ledger();
        let mut job = bare_job(
            Arc::clone(&ledger),
            Some(agent.pool()),
            cache,
            None,
            vec!["Bash(cargo build)".to_string()],
        );
        job.settle_refresh = true;
        let outcome = run_synopsis(job).await;
        assert!(outcome.asked, "the model answered; the window is spent");
        assert!(!outcome.failed);
        assert!(outcome.settle_refresh);
        assert!(ledger.get("claude-1").unwrap().unwrap().synopsis.is_none());
    }

    /// An outcome that crossed the idle barrier in flight lands nothing: its
    /// window is not spent, its refresh is not marked, and its cache comes back
    /// with only the read position intact.
    #[test]
    fn an_outcome_from_behind_the_barrier_lands_only_the_read_offset() {
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
        let outcome = SynopsisOutcome {
            session_id: "s1".to_string(),
            cache,
            caught_up_ask: None,
            asked: true,
            failed: false,
            barrier_epoch: 0,
            settle_refresh: true,
            asked_at: Instant::now(),
        };
        apply_synopsis_outcome(
            outcome,
            &mut sessions,
            &mut BackOff::new(),
            &mut VecDeque::new(),
            &mut HashSet::new(),
        );

        let state = &sessions["s1"];
        assert_eq!(state.prompts.offset, 42, "the read position survives");
        assert!(
            state.prompts.first.is_none() && state.prompts.recent.is_empty(),
            "the asks do not"
        );
        assert!(
            state.last_synopsis.is_none(),
            "a stale ask must not spend the new stretch's window"
        );
        assert!(
            !state.settle_refreshed,
            "a stale ask must not mark the new stretch refreshed"
        );
    }
}

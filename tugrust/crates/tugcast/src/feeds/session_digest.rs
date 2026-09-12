//! session_digest — the one account of what a session is doing.
//!
//! Tug used to write three independent accounts of a session's work from
//! three independent taps on the same `CODE_OUTPUT` broadcast, in two
//! languages: the masthead's beat (a bun-compiled TypeScript daemon, retired
//! with this consolidation), the standing synopsis sentence
//! (a Haiku ask on its own cadence, retired with this consolidation), and the
//! Observer's posts (`observer_wake.rs`).
//! Three copies of one classification, and one
//! event spelled two ways — "Reading foo.ts" in TypeScript, `Read(foo.ts)` in
//! Rust. This module is the single digester every reader now reads: one
//! allowlist, one replay-mute classifier, one frame-to-line vocabulary, and a
//! per-session rolling deque of lines.
//!
//! **Time enters as a parameter. Nothing here reads a clock.** That is the
//! purity invariant `observer_wake.rs` already holds and for the same reason:
//! the live bridge (`digest_bridge.rs`) and the fixture drift test drive this
//! exact code, so a line the test pins is the line the strip shows. Nothing
//! here does IO, spawns a task, or knows a broadcast channel exists. The
//! emission throttle, which needs a clock, belongs to the bridge.
//!
//! The prose-extraction and tool-narration rules below are ports of
//! that daemon's `voice.ts`, function for function, with its constants at
//! their tuned values — they are what make a beat read as a thought rather
//! than as a log line. The frame-parsing helpers (`said_head`, `shell_beat`,
//! `submission_beat`, `tool_line`, `clip`) moved in from
//! the standing sentence's own module, which this consolidation retired.

// Everything here has a reader — the bridge, the Observer, the standing
// sentence — except a handful of items whose readers are still to come or have
// only tests: `tail` is the per-session read a reconnecting deck will make,
// and `said_head` / `tool_line` are the vocabulary's own halves, exercised by
// this module's tests and not by its dispatch. (`DigestKind::as_str` left this
// list when the beat payload started carrying the kind.) Closing it out is the
// consolidation's cleanup step, not this one.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use super::observer_wake::ELISION_MARKER;
use super::overview_agent::{BUFFER_MAX_BYTES, DEFAULT_BUFFER_MAX_FRAMES};
use super::payload_inspector::InspectedPayload;

// ───────────────────────────── the one allowlist ─────────────────────────────

/// The one forward allowlist: the union of the Observer's list and the beat's.
///
/// The two additions relative to the Observer's are load-bearing.
/// `control_request_forward` / `control_request_cancel` are how a permission
/// wait gets said at all — a session waiting for permission is the state a
/// watched card is most often IN, and until these two crossed the tap the strip
/// narrated the tool call and then froze. The wait's END rides `tool_result`,
/// already here: it is the only frame that arrives on both an allow and a deny.
///
/// `replay_started` / `replay_complete` are consumed as mute brackets and never
/// enter the digest — a reconnect flood must not re-narrate history.
pub const DIGEST_FORWARD_ALLOWLIST: &[&str] = &[
    "tool_use",
    "tool_result",
    "tool_input_progress",
    "assistant_text",
    "turn_complete",
    "turn_cancelled",
    "task_started",
    "task_updated",
    "task_progress",
    "api_retry",
    "error",
    "wake_started",
    "model_refusal_fallback",
    "output_truncated",
    "compact_boundary",
    "control_request_forward",
    "control_request_cancel",
];

/// Classify one `CODE_OUTPUT` frame for the tap. Returns the spliced session id
/// when the frame should reach the digester; maintains the replay-mute set as
/// brackets pass (mute state tracks the wire, not any toggle).
pub fn forwardable_session(payload: &[u8], muted: &mut HashSet<String>) -> Option<String> {
    let inspected = InspectedPayload::from_slice(payload)?;
    let msg_type = inspected.msg_type.as_deref()?;
    let session = inspected.tug_session_id.clone();
    match msg_type {
        "replay_started" => {
            if let Some(session) = session {
                muted.insert(session);
            }
            None
        }
        "replay_complete" => {
            if let Some(session) = session {
                muted.remove(&session);
            }
            None
        }
        t if DIGEST_FORWARD_ALLOWLIST.contains(&t) => {
            let session = session?;
            if muted.contains(&session) {
                None
            } else {
                Some(session)
            }
        }
        _ => None,
    }
}

// ──────────────────────────────── constants ─────────────────────────────────

/// Minimum spacing between throttled updates per scope. The bridge holds the
/// clock this is measured against; the digester never does.
pub const VOICE_THROTTLE_MS: u64 = 1_000;

/// Scopes silent this long are swept.
pub const SCOPE_IDLE_SWEEP_MS: u64 = 30 * 60 * 1000;

/// An in-progress thought this long may show before any sentence settles
/// (marked with a streaming ellipsis).
const PARTIAL_MIN_CHARS: usize = 40;

/// Raw-markdown budget per line. Generous: LaTeX source is several times wider
/// than its rendered form, and the strip's CSS ellipsis owns VISUAL overflow.
const LINE_CLIP: usize = 300;

/// A math-only segment borrows a label this short from the segment before it
/// ("**2. Gauss's Law** $$…$$").
const LABEL_MAX_CHARS: usize = 80;

/// The transport guard on a phrase quoted into a beat — a command, a search
/// pattern, a question's header.
///
/// Deliberately far above any display width, because it is NOT a display
/// budget. How much of a phrase fits is the DECK's to decide, at the width the
/// surface actually has: the Z2 strip and a Cards session row are different
/// widths, both move with the window, and the activity line truncates in the
/// MIDDLE — which it can only do given the whole string, since a command
/// identifies itself at the head and names what it acts on at the tail. What
/// the guard is for is a pathological input riding the feed: a heredoc, a
/// minified blob, a pasted file.
const PHRASE_GUARD: usize = 400;

/// Characters of a tool's target kept in a [`tool_line`].
///
/// 160, not the standing sentence's old 60: a ref can only be linked if the
/// digest spelled the whole path, and the Observer's refs now validate against
/// the rendered digest. `voice.ts`'s own narration path keeps
/// [`PHRASE_GUARD`] for the phrases it quotes, which is wider still.
pub const MAX_TARGET_CHARS: usize = 160;

/// Characters of a prose block's head kept in its `said:` line.
const MAX_SAID_CHARS: usize = 100;

/// A sentence terminator this early is bait — "e.g." and version numbers, not
/// a sentence — so the head keeps reading past it.
const MIN_SENTENCE_CHARS: usize = 20;

/// Characters of a submitted prompt kept in its `asked:` line.
pub const MAX_PROMPT_CHARS: usize = 1_500;

/// Characters of a tool result kept in its `→` line. The result is evidence,
/// not a transcript: enough to say what came back.
const RESULT_CLIP: usize = 200;

// ─────────────────────────────── the vocabulary ──────────────────────────────

/// What a digest line is an account of. Spec S02's table, one variant per row.
///
/// The kind is on the wire (the beat payload carries it in place of the old
/// `intent`), which is what lets the deck tell an Ask line from a tool line —
/// a distinction the old payload could not express.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DigestKind {
    /// The user's own submission. The beat has never had this.
    Ask,
    /// The assistant's running monologue.
    Said,
    /// A tool call, narrated.
    Tool,
    /// What a tool call came back with. Evidence for the Observer's window,
    /// and NOT a beat: the deck's beat walks past it to the call it answers,
    /// because 200 characters of a grep hit or a file's first bytes read as
    /// line noise on a card, and the Tool line above it already says what the
    /// session is doing.
    Result,
    /// A tool call that came back with an error. Distinct from [`Self::Result`]
    /// so the deck can show it: a failure is news at the session's own pace,
    /// where a success is only evidence.
    Error,
    /// A shell exchange.
    Shell,
    /// A turn ended — `Done` or `Stopped`.
    Turn,
    /// A compaction, a retry, a fallback, a truncation, a wake, a background
    /// job's terminal state.
    Notice,
    /// A permission request went out to the user.
    Wait,
}

impl DigestKind {
    /// The wire spelling, and what the fixture golden pins.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Said => "said",
            Self::Tool => "tool",
            Self::Result => "result",
            Self::Error => "error",
            Self::Shell => "shell",
            Self::Turn => "turn",
            Self::Notice => "notice",
            Self::Wait => "wait",
        }
    }
}

/// When a line may reach the strip.
///
/// The throttle is **not uniform**, and applying it as if it were loses beats.
/// `voice.ts` throttles only its flush path — the monologue and the
/// superseding tool line. A turn end, a cancel and a compaction emit
/// immediately, because on a manual `/compact` the boundary is followed within
/// a frame or two by `turn_complete`, which resets the scope: a throttled beat
/// is swallowed and the run reads as if it never happened. The Ask line and
/// the permission-wait pair join them — an ask throttled behind a tool line is
/// an ask the deck never receives, and a strip that freezes on a wait says
/// nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Emission {
    /// Bypasses the bridge's throttle.
    Now,
    /// Subject to [`VOICE_THROTTLE_MS`] per scope.
    Throttled,
}

/// One line of the digest, scoped to its session by the deque it sits in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DigestLine {
    pub text: String,
    pub at_ms: u64,
    /// Monotonic within the process, across scopes.
    pub beat: u64,
    pub kind: DigestKind,
    /// The identity a later line supersedes this one by: a `tool_use_id` for a
    /// Tool line, a `(msg_id, block_index)` pair for a Said line, `None` for a
    /// line nothing supersedes. See [`SessionDigest::push`].
    pub supersede_key: Option<String>,
}

/// A line and when it may be emitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Digested {
    pub line: DigestLine,
    pub emission: Emission,
    /// Whether the line is an *event*, to be recorded in the session's digest,
    /// or only a *beat* — something the strip must show without the deque
    /// gaining a row for it.
    ///
    /// One case needs the distinction: a permission wait ending restores the
    /// line the wait superseded, so the beat stops saying "waiting". Nothing
    /// new happened in the session, so recording it would put the same line in
    /// the deque once per wait — noise in the Observer's window and in the beat
    /// history, describing work that happened once.
    pub record: bool,
}

// ─────────────────────────── the per-session deque ───────────────────────────

/// A session's rolling digest: the one spelling of every event it produced,
/// newest last, bounded by a line count and a byte budget.
///
/// This absorbs `observer_wake::FrameBuffer`'s whole API surface — `push`,
/// `rendered`, `is_empty`, `len`, `byte_len`, `was_elided`, `take`,
/// `restore_front` — so the Observer's call sites read digest lines instead of
/// raw payload JSON without moving.
#[derive(Clone, Debug)]
pub struct SessionDigest {
    lines: VecDeque<DigestLine>,
    bytes: usize,
    max_lines: usize,
    max_bytes: usize,
    /// True once anything has been dropped, so the composed input says so.
    elided: bool,
}

impl Default for SessionDigest {
    fn default() -> Self {
        Self::new(DEFAULT_BUFFER_MAX_FRAMES, BUFFER_MAX_BYTES)
    }
}

impl SessionDigest {
    pub fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            bytes: 0,
            max_lines: max_lines.max(1),
            max_bytes: max_bytes.max(1),
            elided: false,
        }
    }

    /// Add one line — appending, superseding, or dropping it.
    ///
    /// **Supersede, not append.** `voice.ts` is not a log: its `directLine` is
    /// overwritten on every `tool_input_progress` and its `shownText` dedupes
    /// what reaches the strip. A deque that appended one line per frame would
    /// be flooded — `tugcode/src/session.ts` emits a cumulative
    /// `tool_input_progress` frame every time its `progressKey` changes, so one
    /// `Write` of a long file emits on the order of a hundred of them and
    /// spends the whole line cap inside a single tool call. That starves the
    /// Observer's window of the rest of the stretch and empties the beat
    /// history. So:
    ///
    /// - a line replaces the newest line when both carry the same
    ///   [`DigestLine::supersede_key`] and the same kind — the progress frames
    ///   of one tool call, and the settled `tool_use` that ends them, are one
    ///   line; so are the deltas of one prose block;
    /// - a line whose text is byte-identical to the newest line is dropped —
    ///   `shownText`'s rule, applied to the deque instead of to the strip;
    /// - anything else appends.
    ///
    /// A Result line never supersedes the Tool line it answers, because the
    /// kinds differ: what came back is evidence the Observer needs beside the
    /// call, not a correction of it.
    pub fn push(&mut self, line: DigestLine) {
        if let Some(newest) = self.lines.back() {
            let supersedes = line.supersede_key.is_some()
                && newest.supersede_key == line.supersede_key
                && newest.kind == line.kind;
            if supersedes {
                let dropped = self.lines.pop_back().map(|l| l.text.len()).unwrap_or(0);
                self.bytes = self.bytes.saturating_sub(dropped);
            } else if newest.text == line.text {
                return;
            }
        }
        self.bytes += line.text.len();
        self.lines.push_back(line);
        self.trim();
    }

    fn trim(&mut self) {
        while self.lines.len() > self.max_lines
            || (self.bytes > self.max_bytes && self.lines.len() > 1)
        {
            if let Some(dropped) = self.lines.pop_front() {
                self.bytes = self.bytes.saturating_sub(dropped.text.len());
                self.elided = true;
            }
        }
    }

    /// True when nothing has arrived since the last wake.
    ///
    /// This is the whole of "an idle session never wakes": silence is not news,
    /// so a sitrep timer that fires over an empty digest produces no wake at
    /// all rather than a wake the model then declines.
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn byte_len(&self) -> usize {
        self.bytes
    }

    pub fn was_elided(&self) -> bool {
        self.elided
    }

    /// The newest line, which is the beat.
    pub fn newest(&self) -> Option<&DigestLine> {
        self.lines.back()
    }

    /// The newest line that is not itself a permission wait.
    ///
    /// This is what a wait supersedes and what its ending restores. It cannot
    /// be [`Self::newest`]: a wait's end records nothing, so when a second wait
    /// opens the newest line is still the first wait's, and restoring that
    /// would put the beat back on a wait that is already over — announcing a
    /// question the user has answered.
    pub fn newest_non_wait(&self) -> Option<&DigestLine> {
        self.lines.iter().rev().find(|l| l.kind != DigestKind::Wait)
    }

    /// The newest `n` lines, oldest first — what a reconnecting deck reads.
    pub fn tail(&self, n: usize) -> Vec<DigestLine> {
        let skip = self.lines.len().saturating_sub(n);
        self.lines.iter().skip(skip).cloned().collect()
    }

    /// Every line newer than `beat`, oldest first.
    ///
    /// A reader that only *looks* at the digest — one that keeps no deque of
    /// its own — resumes from the beat it last saw rather than from a
    /// position, because the deque rolls: a position goes stale as soon as
    /// something is dropped from the front, and `beat` is monotonic across
    /// the process.
    pub fn since(&self, beat: u64) -> impl Iterator<Item = &DigestLine> {
        self.lines.iter().filter(move |line| line.beat > beat)
    }

    /// The newest line's beat, or 0 for a digest that has never held one.
    pub fn newest_beat(&self) -> u64 {
        self.newest().map(|line| line.beat).unwrap_or(0)
    }

    /// The digest as one block, newest last, with the elision marker on top
    /// when anything was dropped. This exact text is what refs are validated
    /// against, which is why nothing reshapes a line on the way out.
    pub fn rendered(&self) -> String {
        let mut out = String::new();
        if self.elided {
            out.push_str(ELISION_MARKER);
            out.push('\n');
        }
        for line in &self.lines {
            out.push_str(&line.text);
            out.push('\n');
        }
        out
    }

    /// Hand back the contents and reset, which is what a wake does before it
    /// runs the job off-thread.
    pub fn take(&mut self) -> SessionDigest {
        let taken = SessionDigest {
            lines: std::mem::take(&mut self.lines),
            bytes: self.bytes,
            max_lines: self.max_lines,
            max_bytes: self.max_bytes,
            elided: self.elided,
        };
        self.bytes = 0;
        self.elided = false;
        taken
    }

    /// Put a taken digest's lines back at the front, for a wake whose job
    /// failed.
    ///
    /// An editorial "no post" and an infrastructure failure are different
    /// events: the first means the model read the work and judged it not worth
    /// telling, the second means nobody read it at all. Dropping the window on
    /// a failure would silently lose a stretch of real work, so it goes back —
    /// bounded by the same caps, so a persistently failing pool degrades to
    /// narrating only the most recent window instead of growing without limit.
    pub fn restore_front(&mut self, mut earlier: SessionDigest) {
        if earlier.lines.is_empty() {
            return;
        }
        self.elided |= earlier.elided;
        earlier.lines.append(&mut self.lines);
        self.lines = earlier.lines;
        self.bytes = self.lines.iter().map(|l| l.text.len()).sum();
        self.trim();
    }
}

// ──────────────────────── voice.ts: the sentence rules ───────────────────────

/// Every byte a payload string carries that was never text.
///
/// A tool result is whatever the tool printed, and a `grep` that thought it
/// was talking to a terminal printed color: `ESC [ 3 6 m` around every match.
/// Nothing downstream has any use for those bytes — the deck draws U+001B as
/// tofu and the ledger stores it — so they are dropped here, at the one place
/// the line is composed, rather than by each reader for itself.
///
/// Dropped: CSI (`ESC [` … final byte), the string-introducing escapes (OSC,
/// DCS, SOS, PM, APC) up to their `ESC \` or BEL terminator, any other escape
/// (its intermediate bytes, then its final one), a bare 8-bit CSI, and every
/// remaining C0/C1 control. Whitespace survives untouched: the sentence rules
/// below are what decide what a newline means.
fn visible_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\u{1b}' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    consume_control_sequence(&mut chars);
                }
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    chars.next();
                    consume_string_sequence(&mut chars);
                }
                // Every other escape: its intermediates, then its final byte.
                Some(_) => consume_escape_sequence(&mut chars),
                // A trailing ESC introduces nothing, and is still not text.
                None => {}
            },
            // The 8-bit spelling of CSI, from a producer writing C1 directly.
            '\u{9b}' => consume_control_sequence(&mut chars),
            ch if ch.is_control() && !ch.is_whitespace() => {}
            ch => out.push(ch),
        }
    }
    out
}

/// A CSI's parameter and intermediate bytes, then its one final byte.
fn consume_control_sequence(chars: &mut impl Iterator<Item = char>) {
    for ch in chars {
        if matches!(ch, '\u{40}'..='\u{7e}') {
            break;
        }
    }
}

/// A non-CSI escape's intermediate bytes, then its final one — `ESC ( B`
/// (select character set) is three bytes, not two.
fn consume_escape_sequence(chars: &mut impl Iterator<Item = char>) {
    for ch in chars {
        if !matches!(ch, '\u{20}'..='\u{2f}') {
            break;
        }
    }
}

/// An OSC-style sequence's payload, up to `ESC \` (ST) or BEL.
fn consume_string_sequence(chars: &mut impl Iterator<Item = char>) {
    let mut escaped = false;
    for ch in chars {
        match ch {
            '\u{07}' => break,
            '\\' if escaped => break,
            '\u{1b}' => escaped = true,
            _ => escaped = false,
        }
    }
}

/// Collapse whitespace to one line, over [`visible_text`]'s reduction — so
/// nothing a scrubbed escape left behind survives as a stray double space.
fn one_line(text: &str) -> String {
    visible_text(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Token counts at strip scale: thousands above 1k, exact below.
fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000 {
        format!("{}k", (tokens as f64 / 1_000.0).round() as u64)
    } else {
        format!("{tokens}")
    }
}

/// `$…$` / `$$…$$` spans, conservatively matched (mirrors the deck's
/// inline-math walker grammar): `$$` pairs may span anything; single `$` must
/// hug its content (no space after the opener or before the closer, no digit
/// after the closer). Math is ATOMIC for extraction — no sentence boundary and
/// no clip point ever lands inside a span.
///
/// Spans are **character** index ranges, half-open. Every helper below slices
/// by character index for the same reason [`clip`] does:
/// a byte offset into prose the model wrote is a panic waiting for its first
/// emoji.
pub fn find_math_spans(text: &str) -> Vec<(usize, usize)> {
    let c: Vec<char> = text.chars().collect();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut i = 0usize;
    while i < c.len() {
        if c[i] != '$' || (i > 0 && c[i - 1] == '\\') {
            i += 1;
            continue;
        }
        if c.get(i + 1) == Some(&'$') {
            // Unclosed display math: no partial match.
            let Some(close) = find_double_dollar(&c, i + 2) else {
                break;
            };
            spans.push((i, close + 2));
            i = close + 2;
            continue;
        }
        // Inline `$`: not followed by whitespace; closer not preceded by
        // whitespace, not followed by a digit.
        match c.get(i + 1) {
            None => {
                i += 1;
                continue;
            }
            Some(next) if next.is_whitespace() => {
                i += 1;
                continue;
            }
            Some(_) => {}
        }
        let mut j = i + 1;
        let mut close = None;
        while j < c.len() {
            let prev = c[j - 1];
            let next_is_digit = c.get(j + 1).is_some_and(|n| n.is_ascii_digit());
            if c[j] == '$' && prev != '\\' && !prev.is_whitespace() && !next_is_digit {
                close = Some(j);
                break;
            }
            j += 1;
        }
        match close {
            Some(cl) => {
                spans.push((i, cl + 1));
                i = cl + 1;
            }
            None => i += 1,
        }
    }
    spans
}

fn find_double_dollar(c: &[char], from: usize) -> Option<usize> {
    let mut k = from;
    while k + 1 < c.len() {
        if c[k] == '$' && c[k + 1] == '$' {
            return Some(k);
        }
        k += 1;
    }
    None
}

fn inside_span(index: usize, spans: &[(usize, usize)]) -> bool {
    spans.iter().any(|(s, e)| index >= *s && index < *e)
}

/// Does the text carry any math span?
fn has_math(text: &str) -> bool {
    !find_math_spans(text).is_empty()
}

/// Sentence boundaries OUTSIDE math spans, tolerating a closing `)`/`"`, and
/// skipping list enumerators ("2.") — an enumerator's dot introduces an item;
/// it never ends a thought. Each entry is the character index of the
/// sentence's last character.
fn sentence_ends(text: &str) -> Vec<usize> {
    let spans = find_math_spans(text);
    let c: Vec<char> = text.chars().collect();
    let mut ends = Vec::new();
    for i in 0..c.len() {
        if !matches!(c[i], '.' | '!' | '?') {
            continue;
        }
        if inside_span(i, &spans) {
            continue;
        }
        // Enumerator: the token before the dot is digits only.
        let mut t = i as isize - 1;
        while t >= 0 && c[t as usize].is_ascii_digit() {
            t -= 1;
        }
        if t < i as isize - 1 && (t < 0 || c[t as usize] == ' ' || c[t as usize] == '*') {
            continue;
        }
        let mut j = i + 1;
        if matches!(c.get(j), Some(&(')' | '"' | '\u{201d}'))) {
            j += 1;
        }
        // A bold/italic span may close right after the terminator ("…the same
        // thing.**") — the markers belong to the sentence.
        while c.get(j) == Some(&'*') {
            j += 1;
        }
        if j >= c.len() || c[j] == ' ' {
            ends.push(j - 1);
        }
    }
    ends
}

/// Drop one stray `**` when a slice ends up with an odd count — a literal
/// double-asterisk is worse than losing one bold span.
pub fn balance_emphasis(text: &str) -> String {
    if text.matches("**").count() % 2 == 0 {
        return text.to_string();
    }
    match text.rfind("**") {
        // `**` is ASCII, so these byte offsets are on character boundaries.
        Some(last) => one_line(&format!("{}{}", &text[..last], &text[last + 2..])),
        None => text.to_string(),
    }
}

/// A prose chunk worth pinning: a real clause, or any math at all.
fn is_showable(chunk: &str) -> bool {
    if has_math(chunk) {
        return true;
    }
    chunk.chars().count() >= 12 && chunk.contains(' ')
}

/// A heading-style label that only introduces what follows — "Verified
/// behavior:" or "**What's next:**" — never a thought on its own. Trailing
/// emphasis markers and whitespace are stripped before the colon test.
fn is_dangling_label(chunk: &str) -> bool {
    chunk
        .trim_end_matches(|ch: char| ch.is_whitespace() || ch == '*' || ch == '_')
        .ends_with(':')
}

/// A segment counts as settled when it ends like a finished thought.
fn ends_settled(segment: &str) -> bool {
    let t = segment.trim_end();
    if t.ends_with("$$") {
        return true;
    }
    let mut back = t.chars().rev();
    let Some(last) = back.next() else {
        return false;
    };
    if matches!(last, '.' | '!' | '?') {
        return true;
    }
    let before = back.next();
    matches!(last, ')' | '"') && matches!(before, Some('.' | '!' | '?'))
}

/// Clip to `n` characters, cutting at a space and never inside a math span.
pub fn clip_outside_math(text: &str, n: usize) -> String {
    let c: Vec<char> = text.chars().collect();
    if c.len() <= n {
        return text.to_string();
    }
    let spans = find_math_spans(text);
    let mut cut = n as isize - 1;
    while cut > 0 && (c[cut as usize] != ' ' || inside_span(cut as usize, &spans)) {
        cut -= 1;
    }
    if cut <= 0 {
        let head: String = c[..n.saturating_sub(1)].iter().collect();
        return format!("{head}…");
    }
    let head: String = c[..cut as usize].iter().collect();
    format!("{}…", head.trim_end())
}

/// Blank-line paragraphs, trimmed, empties dropped — `voice.ts`'s
/// `raw.split(/\n[ \t]*\n+/)`.
fn paragraphs(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in raw.split('\n') {
        if line.trim().is_empty() {
            if !cur.trim().is_empty() {
                out.push(cur.trim().to_string());
            }
            cur.clear();
        } else {
            if !cur.is_empty() {
                cur.push('\n');
            }
            cur.push_str(line);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// The display chunk of an accumulating thought, sliced along the document's
/// own structure so markup never tears:
///
///  - segments are blank-line paragraphs; the newest SETTLED segment speaks
///    (every segment but the last is settled; the last counts once it ends
///    like a finished thought);
///  - a math-only segment borrows its short label segment ("**2. Gauss's Law**
///    $$…$$") so equations keep their names;
///  - a long prose segment narrows to its last showable sentence
///    (math-atomic, enumerator-aware boundaries);
///  - before anything settles, a long clean tail shows with a streaming
///    ellipsis;
///  - the byte clip never cuts inside a math span — rendered math is far
///    narrower than its source, and the strip's CSS owns visual overflow.
///
/// Returns RAW MARKDOWN — the deck renders it with full transcript parity; the
/// digester never rewrites the machine's words.
pub fn extract_display(raw: &str) -> Option<String> {
    let segments = paragraphs(raw);
    if segments.is_empty() {
        return None;
    }

    for i in (0..segments.len()).rev() {
        let settled = i < segments.len() - 1 || ends_settled(&segments[i]);
        if !settled {
            continue;
        }
        let mut display = one_line(&segments[i]);
        if !is_showable(&display) {
            continue;
        }
        // Skip a bare heading label ("Verified behavior:") — it introduces the
        // next segment but says nothing itself; fall through to an older
        // thought.
        if !has_math(&display) && is_dangling_label(&display) {
            continue;
        }
        let spans = find_math_spans(&display);
        let math_only = !spans.is_empty() && {
            let mut stripped: Vec<char> = display.chars().collect();
            for (s, e) in &spans {
                for slot in stripped[*s..*e].iter_mut() {
                    *slot = ' ';
                }
            }
            one_line(&stripped.iter().collect::<String>())
                .chars()
                .count()
                < 4
        };
        if math_only && i > 0 {
            let label = one_line(&segments[i - 1]);
            if label.chars().count() <= LABEL_MAX_CHARS {
                display = format!("{label} {display}");
            }
        }
        if !has_math(&display) {
            // Long prose narrows to its freshest showable sentence.
            if let Some(sentence) = freshest_sentence(&display) {
                display = sentence;
            }
        }
        return Some(clip_outside_math(&balance_emphasis(&display), LINE_CLIP));
    }

    // Nothing settled yet: show the streaming tail once it reads as a thought —
    // cut before any unclosed math rather than inside it.
    let mut tail = one_line(&segments[segments.len() - 1]);
    let tail_chars: Vec<char> = tail.chars().collect();
    if let Some(last_open) = rfind_double_dollar(&tail_chars) {
        if !inside_span(last_open, &find_math_spans(&tail)) {
            tail = tail_chars[..last_open]
                .iter()
                .collect::<String>()
                .trim_end()
                .to_string();
        }
    }
    // The tail segment may itself contain finished sentences (it just hasn't
    // closed its paragraph) — show the freshest one.
    if let Some(sentence) = freshest_sentence(&tail) {
        return Some(clip_outside_math(&balance_emphasis(&sentence), LINE_CLIP));
    }
    if tail.chars().count() >= PARTIAL_MIN_CHARS && is_showable(&tail) {
        return Some(format!(
            "{}…",
            clip_outside_math(&balance_emphasis(&tail), LINE_CLIP - 1)
        ));
    }
    None
}

/// The newest showable sentence of a one-line chunk, or `None` when it holds
/// no sentence boundary at all.
fn freshest_sentence(text: &str) -> Option<String> {
    let c: Vec<char> = text.chars().collect();
    let ends = sentence_ends(text);
    for s in (0..ends.len()).rev() {
        let start = if s == 0 { 0 } else { ends[s - 1] + 1 };
        let sentence: String = c[start..=ends[s]].iter().collect();
        let sentence = sentence.trim().to_string();
        if is_showable(&sentence) {
            return Some(sentence);
        }
    }
    None
}

fn rfind_double_dollar(c: &[char]) -> Option<usize> {
    if c.len() < 2 {
        return None;
    }
    let mut k = c.len() - 2;
    loop {
        if c[k] == '$' && c[k + 1] == '$' {
            return Some(k);
        }
        if k == 0 {
            return None;
        }
        k -= 1;
    }
}

// ─────────────────────── voice.ts: the tool narration ────────────────────────

/// Present-progressive verb for a tool, else the tool name itself.
fn tool_verb(tool_name: &str) -> &str {
    match tool_name {
        "Write" => "Writing",
        "Edit" | "NotebookEdit" => "Editing",
        other => other,
    }
}

/// One line, whole — see [`PHRASE_GUARD`] for the one case it is not.
fn narrated_phrase(text: &str) -> String {
    let t = one_line(text);
    if t.chars().count() <= PHRASE_GUARD {
        t
    } else {
        let head: String = t.chars().take(PHRASE_GUARD - 1).collect();
        format!("{head}…")
    }
}

/// A tool's file target as the beat should carry it: relative to the session's
/// own root when it is under it, and otherwise exactly as it arrived.
///
/// **`root` is `None` at every call site, and that is deliberate rather than
/// unfinished.** In the daemon it was learned from a `system_metadata` frame —
/// which is in no allowlist and never crossed the tap, as `session_digest.rs`'s own
/// classification test asserted — so it was always null there too, and every
/// tool line already shows the whole path. Making the digester read the
/// session's cwd (which tugcast, unlike the daemon, actually holds) would
/// change what the reader sees, so it is a follow-on rather than part of this
/// consolidation. The parameter stays so that follow-on is a one-line change.
///
/// Reducing a path to a bare file name would be a display budget guessed at
/// the producer — it throws the tail away at one width for every surface at
/// once, and it throws away the part the activity line is built to keep: the
/// deck truncates in the MIDDLE precisely so a path keeps its verb at the head
/// and its file at the tail, which it can only do given the whole string.
fn display_path(path: &str, root: Option<&str>) -> String {
    let Some(root) = root.filter(|r| !r.is_empty()) else {
        return path.to_string();
    };
    let prefix = if root.ends_with('/') {
        root.to_string()
    } else {
        format!("{root}/")
    };
    path.strip_prefix(&prefix).unwrap_or(path).to_string()
}

/// Display names for the agent-type slugs that don't read as a clean word on
/// their own.
const AGENT_LABEL_OVERRIDES: &[(&str, &str)] = &[
    ("general-purpose", "General"),
    ("statusline-setup", "Statusline"),
    ("output-style-setup", "Output style"),
];

/// A subagent-type slug as a display label: a known override, else the slug
/// with separators turned to spaces and the first letter capitalized
/// ("code-reviewer" → "Code reviewer"). Keeps a raw slug ("general-purpose",
/// which clips to "general-p…" on the strip) from ever reaching the beat.
pub fn agent_display_label(slug: &str) -> String {
    if let Some((_, label)) = AGENT_LABEL_OVERRIDES.iter().find(|(k, _)| *k == slug) {
        return (*label).to_string();
    }
    let spaced = slug
        .chars()
        .map(|ch| if ch == '-' || ch == '_' { ' ' } else { ch })
        .collect::<String>();
    let spaced = one_line(&spaced);
    if spaced.is_empty() {
        return slug.to_string();
    }
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

/// `<verb>: <first question's header>`, or `<verb> a question` when the call
/// carries none.
///
/// Shared by the `AskUserQuestion` tool beat and the permission wait's own
/// question branch: a question forwarded for an answer and a question
/// announced as a tool call are the same call read at two moments, so they read
/// the header the same way rather than each parsing the input for itself.
fn question_beat(input: Option<&Value>, verb: &str) -> String {
    let header = input
        .and_then(|input| input.get("questions"))
        .and_then(|q| q.as_array())
        .and_then(|q| q.first())
        .and_then(|first| first.get("header"))
        .and_then(|h| h.as_str())
        .filter(|h| !h.is_empty());
    match header {
        Some(header) => format!("{verb}: {}", narrated_phrase(header)),
        None => format!("{verb} a question"),
    }
}

/// A beat for an `AskUserQuestion` tool call — the turn is pausing for the
/// user. Borrows the first question's short `header` when present ("Asking:
/// Auth method"), else a bare "Asking a question". Without this the strip would
/// freeze on the assistant's last pre-question thought.
fn ask_question_beat(input: Option<&Value>) -> String {
    question_beat(input, "Asking")
}

/// The skill name for a skill invocation, or `None` when the call is not a
/// skill. Two wire shapes: a `<plugin>:<skill>` tool name surfaced directly
/// (e.g. `tugplug:vet`), or the generic `Skill` tool carrying the id in its
/// input. A skill drives its own turn with little interstitial narration, so
/// naming it keeps the strip off "None".
fn skill_label(tool_name: &str, input: Option<&Value>) -> Option<String> {
    if is_plugin_skill_name(tool_name) {
        return Some(
            tool_name
                .rsplit(':')
                .next()
                .unwrap_or(tool_name)
                .to_string(),
        );
    }
    if tool_name == "Skill" {
        for key in ["command", "name", "skill"] {
            let value = input
                .and_then(|i| i.get(key))
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty());
            if let Some(value) = value {
                return Some(match value.contains(':') {
                    true => value.rsplit(':').next().unwrap_or(value).to_string(),
                    false => value.to_string(),
                });
            }
        }
        return Some("a skill".to_string());
    }
    None
}

/// `voice.ts`'s `/^[\w.-]+:[\w.-]+$/` — one colon, word characters, dots and
/// dashes either side.
fn is_plugin_skill_name(name: &str) -> bool {
    let ok = |ch: char| ch.is_alphanumeric() || ch == '_' || ch == '.' || ch == '-';
    let mut parts = name.split(':');
    let (Some(left), Some(right), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !left.is_empty() && !right.is_empty() && left.chars().all(ok) && right.chars().all(ok)
}

/// A tool with no file target — narrated generically as a fallback so the strip
/// moves; a file tool (with `file_path`) defers to the monologue /
/// `tool_input_progress` line instead.
fn is_generic_non_file_tool(input: Option<&Value>) -> bool {
    !input
        .and_then(|i| i.get("file_path"))
        .is_some_and(|v| v.is_string())
}

/// Narrate a generic tool call ("Reading foo.ts", "Running make test") for the
/// beat — also used for SUBAGENT tool calls, which are the only activity a
/// subagent streams to the parent (no text/thinking deltas cross over).
pub fn narrate_tool(tool_name: &str, input: Option<&Value>, root: Option<&str>) -> String {
    let field = |key: &str| {
        input
            .and_then(|i| i.get(key))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(visible_text)
    };
    let path =
        field("file_path").map(|p| clip_path_left(&display_path(&p, root), MAX_TARGET_CHARS));
    match tool_name {
        "Read" => path.map_or_else(|| "Reading".to_string(), |p| format!("Reading {p}")),
        "Write" => path.map_or_else(|| "Writing".to_string(), |p| format!("Writing {p}")),
        "Edit" | "NotebookEdit" => {
            path.map_or_else(|| "Editing".to_string(), |p| format!("Editing {p}"))
        }
        "Bash" => field("command").map_or_else(
            || "Running a command".to_string(),
            |c| format!("Running {}", narrated_phrase(&c)),
        ),
        "Grep" => field("pattern").map_or_else(
            || "Searching".to_string(),
            |p| format!("Searching {}", narrated_phrase(&p)),
        ),
        "Glob" => field("pattern").map_or_else(
            || "Finding files".to_string(),
            |p| format!("Finding {}", narrated_phrase(&p)),
        ),
        other => other.to_string(),
    }
}

/// Render a `tool_input_progress` frame into a one-line beat, e.g. "Writing
/// voice.ts — 37 lines". Falls back to the bare file name (or verb) before any
/// content has streamed.
fn synthesize_tool_line(payload: &Value, root: Option<&str>) -> String {
    let tool_name = payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let verb = tool_verb(tool_name);
    let target = payload
        .get("file_path")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .map(|p| clip_path_left(&display_path(&visible_text(p), root), MAX_TARGET_CHARS));
    let lines = payload
        .get("content_lines")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    match target {
        Some(target) if lines > 0 => {
            let noun = if lines == 1 { "line" } else { "lines" };
            format!("{verb} {target} — {lines} {noun}")
        }
        Some(target) => format!("{verb} {target}…"),
        None => format!("{verb}…"),
    }
}

/// Render a task-list `tool_use` (TaskCreate / TaskUpdate) into a one-line
/// lifecycle beat, else `None`. Reads the assembled tool input — the
/// empty-input `content_block_start` frame yields `None` and is skipped; the
/// filled continuation frame carries subject / status.
fn task_beat(tool_name: &str, input: Option<&Value>) -> Option<String> {
    let field = |key: &str| input.and_then(|i| i.get(key));
    if tool_name == "TaskCreate" {
        let subject = field("subject")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())?;
        return Some(format!("Created: {}", visible_text(subject)));
    }
    if tool_name == "TaskUpdate" {
        let status = field("status").and_then(|v| v.as_str())?;
        let id = field("taskId").map(value_to_string)?;
        return match status {
            "in_progress" => Some(format!("Started task {id}")),
            "completed" => Some(format!("Completed task {id}")),
            "deleted" => Some(format!("Dropped task {id}")),
            _ => None,
        };
    }
    None
}

/// `String(input.taskId)` — the wire spells a task id as a number or a string
/// and the beat reads either.
fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// ───────────────────────── the frame-parsing helpers ─────────────────────────

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

/// Clip a path from the LEFT, keeping the basename and as much of the tail as
/// fits.
///
/// A path is the one target where the right-hand clip is wrong: a truncated
/// tail is a path that resolves to nothing, and the Observer's refs can only
/// link what the digest actually spelled. A command is the opposite — it
/// identifies itself at the head — so [`clip`] keeps that.
pub fn clip_path_left(path: &str, max_chars: usize) -> String {
    let count = path.chars().count();
    if count <= max_chars || max_chars == 0 {
        return path.to_string();
    }
    let tail: String = path
        .chars()
        .skip(count - (max_chars - 1))
        .collect::<String>();
    format!("…{tail}")
}

/// The `said:` line for a prose block, once the block has earned one.
///
/// The head is the block's first sentence — the first `.`, `!`, or `?` at
/// character index [`MIN_SENTENCE_CHARS`] or later, followed by whitespace — or
/// the first [`MAX_SAID_CHARS`] characters when no boundary arrives in budget.
/// `finalized` marks the text as complete: a trailing terminator then counts as
/// a boundary, and any nonempty remainder is a head even under the cap.
/// Mid-stream, `None` means keep accumulating.
pub fn said_head(text: &str, finalized: bool) -> Option<String> {
    let collapsed = one_line(text);
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

/// A `tool_use` frame reduced to one line the synopsis's way: the tool's name
/// and what it acted on.
///
/// The beat's own spelling is [`narrate_tool`]'s ("Reading foo.ts"), which is
/// the one the deck shows; this is the shape the synopsis digest reads, kept so
/// Step 6 has it. The target is whichever well-known input field is present —
/// a path, a command, a pattern, a URL — clipped to [`MAX_TARGET_CHARS`], and a
/// path clipped from the left so its basename survives.
///
/// The name field is `tool_name`, which is what tugcode puts on the wire and
/// what every other consumer of this frame reads. Anthropic's own tool-use
/// block calls it `name`, but that shape never reaches `CODE_OUTPUT` — tugcode
/// has already reframed it.
pub fn tool_line(payload: &Value) -> Option<String> {
    let name = payload.get("tool_name").and_then(|v| v.as_str())?;
    let target = payload
        .get("input")
        .and_then(|input| {
            [
                ("command", false),
                ("file_path", true),
                ("path", true),
                ("notebook_path", true),
                ("pattern", false),
                ("url", false),
            ]
            .iter()
            .find_map(|(field, is_path)| {
                input
                    .get(*field)
                    .and_then(|v| v.as_str())
                    .map(|v| (v, *is_path))
            })
        })
        .map(|(target, is_path)| {
            let target = visible_text(target.trim());
            if is_path {
                clip_path_left(&target, MAX_TARGET_CHARS)
            } else {
                clip(&target, MAX_TARGET_CHARS)
            }
        })
        .unwrap_or_default();
    if target.is_empty() {
        Some(name.to_string())
    } else {
        Some(format!("{name}({target})"))
    }
}

/// What, if anything, a `SHELL_OUTPUT` frame contributes.
///
/// A command starting and a command settling are both transcript events, so
/// both say the session moved; only the failing settle has anything new to say
/// — a clean exit adds nothing beyond the started line. Only `type`,
/// `command`, and `exit_code` are read; the settle frame's full `output` is
/// never retained.
pub fn shell_beat(payload: &Value) -> Option<String> {
    let command = payload
        .get("command")
        .and_then(|v| v.as_str())
        .map(|command| clip(&visible_text(command.trim()), MAX_TARGET_CHARS));
    match payload.get("type").and_then(|v| v.as_str())? {
        "exchange_started" => Some(format!("$ {}", command?)),
        "exchange_complete" => match payload.get("exit_code").and_then(|v| v.as_i64()) {
            // A missing exit code (spawn failure, kill) has no number to
            // narrate, and a clean exit has nothing to add.
            Some(0) | None => None,
            Some(code) => Some(format!("$ {} → exit {code}", command?)),
        },
        _ => None,
    }
}

/// What, if anything, a `CODE_INPUT` frame contributes: the session it belongs
/// to and its `asked:` line. Only `user_message` is a submission — every other
/// `CODE_INPUT` verb (interrupts, tool approvals, permission answers) returns
/// `None`. The text mirrors the prompt cache's own extraction — text blocks
/// concatenated, trimmed, character-clipped to [`MAX_PROMPT_CHARS`] — so the
/// same submission read later from the session JSONL spells identically.
///
/// This is the line the beat has never had: the digest holds what the turn was
/// asked for, which neither the daemon nor its tap could see.
pub fn submission_beat(payload: &Value) -> Option<(String, String)> {
    let (session_id, text) = submission_ask(payload)?;
    let text = text?;
    Some((
        session_id.to_string(),
        format!("asked: {}", one_line(&text)),
    ))
}

/// The session a `CODE_INPUT` submission belongs to, and the prompt text it
/// carries — clipped to [`MAX_PROMPT_CHARS`], `None` for an image-only
/// submission that has no text at all.
///
/// This is the extraction [`submission_beat`] narrates and the standing
/// sentence's prompt cache matches against, kept in one place because the
/// match is exact string equality: the cache reads the same prompt back out
/// of the session JSONL, and a second extraction that clipped or trimmed one
/// character differently would never agree with the first. The digest line
/// collapses newlines on top of this; the cache wants the text as submitted.
pub fn submission_ask(payload: &Value) -> Option<(String, Option<String>)> {
    let session_id = payload.get("tug_session_id").and_then(|v| v.as_str())?;
    if payload.get("type").and_then(|v| v.as_str())? != "user_message" {
        return None;
    }
    let text: Option<String> = payload
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
    Some((session_id.to_string(), text))
}

// ────────────────────────────── the scope state ──────────────────────────────

/// One session's in-flight state: the accumulating prose block, the permission
/// wait, the launched-agent labels, and the digest itself.
///
/// There is no `root` field. See [`display_path`] for why the daemon's was
/// always null and why re-plumbing it is a follow-on rather than part of this
/// consolidation.
#[derive(Debug, Default)]
pub struct ScopeState {
    /// The newest text block — the latest thought is the only speaker.
    block_key: Option<String>,
    block_text: String,
    /// The line a permission wait superseded, held so the wait can end by
    /// putting it back.
    pre_wait_line: Option<DigestLine>,
    /// The `tool_use_id` the in-flight forward named, or `None` when it named
    /// none — the QUESTION case, where the field is optional and absent. The
    /// wait ends on the `tool_result` carrying this id, and on any
    /// `tool_result` when it is `None`.
    waiting_tool_use_id: Option<String>,
    /// Whether a wait is in flight at all.
    ///
    /// `voice.ts` inferred this from its two wait fields both being null, which
    /// mis-reads the question case (no tool id, nothing superseded) as "no wait
    /// in flight" and leaves the strip on the wait's own text after the answer
    /// lands. One explicit flag is the fix, and it is the only place this port
    /// knowingly diverges from the daemon.
    wait_in_flight: bool,
    /// Launched-agent labels: `Agent`/`Task` tool_use_id → a short label
    /// (subagent type or description). A subagent's own tool calls arrive with
    /// `parent_tool_use_id` set to its launching call, so this lets the beat
    /// prefix them ("Explore · Reading foo.ts").
    agent_labels: HashMap<String, String>,
    last_activity_at: u64,
    digest: SessionDigest,
}

impl ScopeState {
    fn reset_turn(&mut self) {
        self.block_key = None;
        self.block_text.clear();
        self.pre_wait_line = None;
        self.waiting_tool_use_id = None;
        self.wait_in_flight = false;
        self.agent_labels.clear();
    }

    pub fn digest(&self) -> &SessionDigest {
        &self.digest
    }

    pub fn digest_mut(&mut self) -> &mut SessionDigest {
        &mut self.digest
    }
}

/// The digester: one scope state per session, one monotonic beat counter.
///
/// Nothing here reads a clock — `at_ms` arrives on every call, which is what
/// lets the fixture test drive a whole recorded stream at a fixed time.
#[derive(Debug, Default)]
pub struct SessionDigester {
    scopes: HashMap<String, ScopeState>,
    beat: u64,
}

impl SessionDigester {
    pub fn new() -> Self {
        Self::default()
    }

    fn scope_state(&mut self, scope: &str, at_ms: u64) -> &mut ScopeState {
        let state = self.scopes.entry(scope.to_string()).or_default();
        state.last_activity_at = at_ms;
        state
    }

    /// Ingest one allowlisted, un-muted `CODE_OUTPUT` frame and push whatever
    /// line it produced onto the session's digest.
    pub fn on_code_frame(&mut self, scope: &str, payload: &Value, at_ms: u64) -> Option<Digested> {
        let digested = self.line_for_code_frame(scope, payload, at_ms)?;
        if digested.record
            && let Some(state) = self.scopes.get_mut(scope)
        {
            state.digest.push(digested.line.clone());
        }
        Some(digested)
    }

    /// Digest one frame and return its line **without** recording it in the
    /// scope's own deque.
    ///
    /// This is what a reader that keeps its own window calls — the Observer,
    /// whose window is taken at every wake and handed back when a job fails,
    /// and the replay harness, which segments one. The scope's narration state
    /// still advances (the prose block, the wait, the agent labels), because
    /// that state is what makes the next line correct; only the deque is left
    /// alone, so the reader holds one copy of the stretch rather than two.
    ///
    /// The one line that needs the deque is a wait's ending, which reads
    /// [`SessionDigest::newest`] to decide whether the beat is still on the
    /// wait. That line is a beat rather than an event (`record` is false), so a
    /// reader keeping its own window never wanted it in the first place.
    pub fn line_for_code_frame(
        &mut self,
        scope: &str,
        payload: &Value,
        at_ms: u64,
    ) -> Option<Digested> {
        self.beat += 1;
        let beat = self.beat;
        let state = self.scopes.entry(scope.to_string()).or_default();
        state.last_activity_at = at_ms;
        digest_line_for_code_frame(state, payload, at_ms, beat)
    }

    /// Ingest one `CODE_INPUT` frame. Returns the session and its line — the
    /// submission wire carries its own session id rather than a scope.
    pub fn on_submission(&mut self, payload: &Value, at_ms: u64) -> Option<(String, Digested)> {
        let (session, digested) = self.line_for_submission(payload, at_ms)?;
        if let Some(state) = self.scopes.get_mut(&session) {
            state.digest.push(digested.line.clone());
        }
        Some((session, digested))
    }

    /// One `CODE_INPUT` frame's line, not recorded — [`Self::line_for_code_frame`]'s
    /// reasoning, on the wire the prompt arrives by.
    pub fn line_for_submission(
        &mut self,
        payload: &Value,
        at_ms: u64,
    ) -> Option<(String, Digested)> {
        let (session, text) = submission_beat(payload)?;
        self.beat += 1;
        let line = DigestLine {
            text,
            at_ms,
            beat: self.beat,
            kind: DigestKind::Ask,
            supersede_key: None,
        };
        self.scope_state(&session, at_ms);
        Some((
            session,
            Digested {
                line,
                emission: Emission::Now,
                record: true,
            },
        ))
    }

    /// Ingest one `SHELL_OUTPUT` frame for a session.
    pub fn on_shell_frame(&mut self, scope: &str, payload: &Value, at_ms: u64) -> Option<Digested> {
        let text = shell_beat(payload)?;
        self.beat += 1;
        let line = DigestLine {
            text,
            at_ms,
            beat: self.beat,
            kind: DigestKind::Shell,
            supersede_key: None,
        };
        let state = self.scope_state(scope, at_ms);
        state.digest.push(line.clone());
        Some(Digested {
            line,
            emission: Emission::Throttled,
            record: true,
        })
    }

    pub fn digest(&self, scope: &str) -> Option<&SessionDigest> {
        self.scopes.get(scope).map(|s| &s.digest)
    }

    pub fn digest_mut(&mut self, scope: &str) -> Option<&mut SessionDigest> {
        self.scopes.get_mut(scope).map(|s| &mut s.digest)
    }

    /// Take a session's digest, which is what an Observer wake does before it
    /// runs the job off-thread. `None` for a session with no state at all.
    pub fn take_digest(&mut self, scope: &str) -> Option<SessionDigest> {
        self.scopes.get_mut(scope).map(|s| s.digest.take())
    }

    /// Put a taken digest back, for a wake whose job failed.
    pub fn restore_digest(&mut self, scope: &str, earlier: SessionDigest) {
        if let Some(state) = self.scopes.get_mut(scope) {
            state.digest.restore_front(earlier);
        }
    }

    pub fn scopes(&self) -> impl Iterator<Item = (&String, &ScopeState)> {
        self.scopes.iter()
    }

    /// Drop scopes idle past [`SCOPE_IDLE_SWEEP_MS`]. `now` is a parameter for
    /// the same reason everything else here takes one.
    pub fn sweep_inactive(&mut self, at_ms: u64) -> Vec<String> {
        let swept: Vec<String> = self
            .scopes
            .iter()
            .filter(|(_, state)| {
                at_ms.saturating_sub(state.last_activity_at) >= SCOPE_IDLE_SWEEP_MS
            })
            .map(|(scope, _)| scope.clone())
            .collect();
        for scope in &swept {
            self.scopes.remove(scope);
        }
        swept
    }
}

/// The digester, shared between the one task that fills it and the readers
/// that only look.
///
/// [P01] is one vocabulary, not one instance of a type. A reader that only
/// *looks* at what a session is doing — the deck's per-session tail read —
/// reads the deque `digest_bridge` fills rather than taking a tap of its own;
/// the Observer keeps a window it takes and clears at every wake, which a
/// shared deque cannot be. Both run this code, so both spell an event one way.
///
/// A `std::sync::Mutex`
/// rather than tokio's because nothing here awaits — every call is a parse and
/// a push — and a guard held across an await point is the one way this could
/// stall a feed.
pub type SharedDigester = std::sync::Arc<std::sync::Mutex<SessionDigester>>;

/// Lock the shared digester, taking a poisoned lock's contents rather than
/// panicking.
///
/// Narration is advisory: a panic anywhere under the lock must not silence the
/// beat, the standing sentence and the Observer for the life of the process,
/// which is what propagating the poison would do. The state behind it is a
/// rolling deque of display lines, so the worst a poisoned digest carries is a
/// half-accumulated prose block.
pub fn lock_digester(digester: &SharedDigester) -> std::sync::MutexGuard<'_, SessionDigester> {
    digester
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ──────────────────────────────── the dispatch ───────────────────────────────

/// One frame, one line — the retired daemon's `onFrame` dispatch and the
/// standing sentence's own frame parser, become one.
///
/// Pure: it mutates the scope's in-flight state and returns the line, and the
/// caller is what puts the line in the deque. Every arm that returns `None`
/// does so because the frame moved state without saying anything new — a
/// `tool_result` that ends no wait, a `tool_use` whose input has not finished
/// streaming, an `assistant_text` delta whose block has not earned a head.
pub fn digest_line_for_code_frame(
    state: &mut ScopeState,
    payload: &Value,
    at_ms: u64,
    beat: u64,
) -> Option<Digested> {
    let msg_type = payload.get("type").and_then(|v| v.as_str())?;
    let input = payload.get("input");
    let tool_name = payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let tool_use_id = payload
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    // Every tool-shaped line supersedes the previous line for the same call.
    let tool = |text: String, id: Option<&str>| {
        Some(Digested {
            line: DigestLine {
                text,
                at_ms,
                beat,
                kind: DigestKind::Tool,
                supersede_key: id.map(|id| format!("tool:{id}")),
            },
            emission: Emission::Throttled,
            record: true,
        })
    };
    let notice = |text: String, emission: Emission| {
        Some(Digested {
            line: DigestLine {
                text,
                at_ms,
                beat,
                kind: DigestKind::Notice,
                supersede_key: None,
            },
            emission,
            record: true,
        })
    };

    match msg_type {
        "assistant_text" => {
            on_assistant_text(state, payload);
            let display = extract_display(&state.block_text)?;
            Some(Digested {
                line: DigestLine {
                    text: display,
                    at_ms,
                    beat,
                    kind: DigestKind::Said,
                    supersede_key: state.block_key.clone().map(|key| format!("said:{key}")),
                },
                emission: Emission::Throttled,
                record: true,
            })
        }

        "tool_input_progress" => {
            let text = synthesize_tool_line(payload, None);
            tool(text, tool_use_id)
        }

        // ── The narrated wait ──────────────────────────────────────────────
        // A permission request went out to the user. The beat's whole job for
        // the next stretch is to say so: a watched card sitting on the tool
        // call that opened the request tells the reader nothing about why it
        // stopped, and this is the most common state a watched card is in.
        "control_request_forward" => {
            let is_question = payload
                .get("is_question")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // A second forward while one is already in flight keeps the FIRST
            // wait's superseded line: the second's would be the first wait's
            // own text, and putting that back at the end would leave the beat
            // narrating a wait that is over.
            if !state.wait_in_flight {
                state.pre_wait_line = state.digest.newest_non_wait().cloned();
            }
            state.wait_in_flight = true;
            state.waiting_tool_use_id = tool_use_id.map(str::to_string);
            let text = if is_question {
                question_beat(input, "Waiting on")
            } else {
                format!(
                    "Waiting for permission: {}",
                    narrate_tool(tool_name, input, None)
                )
            };
            Some(Digested {
                line: DigestLine {
                    text,
                    at_ms,
                    beat,
                    kind: DigestKind::Wait,
                    supersede_key: None,
                },
                emission: Emission::Now,
                record: true,
            })
        }

        // The request was withdrawn — one of the two ways a wait ends.
        "control_request_cancel" => end_wait(state, at_ms, beat),

        // A tool reported. Two things at once: the result is evidence the
        // Observer wants beside the call (new to the beat), and it is the other
        // way a wait ends — the one that covers an ALLOW. Nothing outbound
        // announces the user's decision, but an approved call runs and reports
        // and a denied one reports the denial, so `tool_result` is the one
        // frame that arrives either way. Correlated by `tool_use_id`, so a
        // result for some OTHER call in flight does not end this wait; a
        // forward that named none is the question case, where any result is
        // the answer.
        "tool_result" => {
            let ends_wait = state.wait_in_flight
                && (state.waiting_tool_use_id.is_none()
                    || state.waiting_tool_use_id.as_deref() == tool_use_id);
            let restored = if ends_wait {
                end_wait(state, at_ms, beat)
            } else {
                None
            };
            let output = payload
                .get("output")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|o| !o.is_empty());
            // A result with nothing to say still ends the wait, and then the
            // restored line is the only thing that moves the beat off it.
            let Some(output) = output else {
                return restored;
            };
            let is_error = payload
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let clipped = clip(&one_line(output), RESULT_CLIP);
            let (text, kind) = if is_error {
                (format!("→ error: {clipped}"), DigestKind::Error)
            } else {
                (format!("→ {clipped}"), DigestKind::Result)
            };
            Some(Digested {
                line: DigestLine {
                    text,
                    at_ms,
                    beat,
                    kind,
                    supersede_key: tool_use_id.map(|id| format!("result:{id}")),
                },
                // When a wait ended here, this line is what moves the beat off
                // it. A success is not itself shown — the deck's beat walks
                // past a Result, and past a Wait that anything follows — so
                // what the reader sees is the call that ran; but the line has
                // to arrive NOW for that walk to happen at all.
                emission: if ends_wait {
                    Emission::Now
                } else {
                    Emission::Throttled
                },
                record: true,
            })
        }

        "tool_use" => {
            let parent = payload
                .get("parent_tool_use_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            if let Some(parent) = parent {
                // A SUBAGENT's tool call — the only activity a subagent streams
                // to the parent. Narrate it (prefixed with the agent's label)
                // so the beat isn't frozen while an agent works.
                let has_input = input
                    .and_then(|i| i.as_object())
                    .is_some_and(|o| !o.is_empty());
                if !has_input {
                    return None;
                }
                let label = state
                    .agent_labels
                    .get(parent)
                    .cloned()
                    .unwrap_or_else(|| "Agent".to_string());
                let text = format!("{label} · {}", narrate_tool(tool_name, input, None));
                return tool(text, tool_use_id);
            }
            // A launched agent: remember its label so its tool calls can be
            // prefixed, and announce the launch.
            if tool_name == "Agent" || tool_name == "Task" {
                let field = |key: &str| {
                    input
                        .and_then(|i| i.get(key))
                        .and_then(|v| v.as_str())
                        .filter(|v| !v.is_empty())
                };
                let label = field("subagent_type")
                    .map(agent_display_label)
                    // `description` is a tool input like any other, and a
                    // tool input carries escapes as readily as a result does
                    // (`[B04]`). `agent_display_label` scrubs the slug arm
                    // through `one_line`; this arm is the other one.
                    .or_else(|| field("description").map(visible_text))?;
                if let Some(id) = tool_use_id {
                    state.agent_labels.insert(id.to_string(), label.clone());
                }
                return tool(format!("Launching {label}…"), tool_use_id);
            }
            // Task-list lifecycle is a materially interesting beat the prose
            // monologue glosses over. `task_beat` owns these tools; an
            // empty-input frame (the `content_block_start`) is intentionally
            // silent, so never fall through to a generic label.
            if tool_name == "TaskCreate" || tool_name == "TaskUpdate" {
                let beat_text = task_beat(tool_name, input)?;
                return tool(beat_text, tool_use_id);
            }
            // AskUserQuestion — the turn is pausing for the user.
            if tool_name == "AskUserQuestion" {
                return tool(ask_question_beat(input), tool_use_id);
            }
            // A skill invocation — a distinct, always-shown beat: a skill
            // drives its own turn with little narration, so without this the
            // beat sits on "None".
            if let Some(skill) = skill_label(tool_name, input) {
                return tool(format!("Running {skill}"), tool_use_id);
            }
            // Generic non-file tool FALLBACK — only when the assistant has NOT
            // narrated. This keeps a tool-only stretch (a lone search, a plugin
            // tool with no prose) off "None", while a foreground Bash/Grep
            // DURING narration stays quiet (the monologue keeps the beat). A
            // file tool defers to the monologue / progress line regardless.
            if state.block_text.is_empty() && is_generic_non_file_tool(input) {
                return tool(narrate_tool(tool_name, input, None), tool_use_id);
            }
            None
        }

        "turn_complete" => Some(on_turn_end(state, "Done", at_ms, beat)),
        "turn_cancelled" => Some(on_turn_end(state, "Stopped", at_ms, beat)),

        // A compaction landed — on a manual `/compact` (the whole turn) or
        // mid-turn at capacity. Everything the scope was carrying describes the
        // context that was just summarized away, so the scope starts clean.
        "compact_boundary" => {
            let verb = match payload.get("trigger").and_then(|v| v.as_str()) {
                Some("auto") => "Auto-compacted context",
                _ => "Compacted context",
            };
            let pre = payload
                .get("pre_tokens")
                .and_then(|v| v.as_u64())
                .filter(|t| *t > 0)
                .map(|t| format!(" (was {})", format_tokens(t)))
                .unwrap_or_default();
            state.block_key = None;
            state.block_text.clear();
            notice(format!("{verb}{pre}"), Emission::Now)
        }

        // A backgrounded job reached a terminal state. (The launch and a
        // subagent's own tool calls are narrated on the `tool_use` path; this
        // is the completion beat, which isn't.)
        "task_updated" => {
            let verb = match payload.get("status").and_then(|v| v.as_str()) {
                Some("completed") => "finished",
                Some("failed") => "failed",
                _ => "stopped",
            };
            notice(format!("Background job {verb}"), Emission::Throttled)
        }

        // Woke from idle to service a deferred/background completion.
        "wake_started" => notice("Resumed".to_string(), Emission::Throttled),

        // A transient stall the user should read as recovery, not a hang.
        "api_retry" => {
            let attempt = payload.get("attempt").and_then(|v| v.as_u64()).unwrap_or(0);
            let text = if attempt > 0 {
                format!("Retrying (attempt {attempt})…")
            } else {
                "Retrying…".to_string()
            };
            notice(text, Emission::Throttled)
        }

        // The model declined and the SDK fell back to another model.
        "model_refusal_fallback" => {
            let text = match payload
                .get("fallback_model")
                .and_then(|v| v.as_str())
                .filter(|m| !m.is_empty())
            {
                Some(model) => format!("Switched to {model}"),
                None => "Switched to a fallback model".to_string(),
            };
            notice(text, Emission::Throttled)
        }

        // The turn hit the output ceiling.
        "output_truncated" => notice("Response truncated".to_string(), Emission::Throttled),

        // A backgrounded agent made progress. Its own tool calls do NOT stream
        // to the parent (unlike a foreground subagent), so this per-step frame
        // — carrying the agent's most recent tool — is the ONLY thing keeping
        // the beat alive while it works. Without it the beat freezes on "Done"
        // the instant the launch turn ends.
        "task_progress" => {
            let label = tool_use_id
                .and_then(|id| state.agent_labels.get(id).cloned())
                .or_else(|| {
                    payload
                        .get("subagent_type")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(agent_display_label)
                })
                .unwrap_or_else(|| "Agent".to_string());
            let text = match payload
                .get("last_tool_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                Some(last) => format!("{label} · {last}"),
                None => format!("{label} working…"),
            };
            tool(text, tool_use_id)
        }

        _ => None,
    }
}

/// Accumulate one `assistant_text` delta under the deck reducer's rule:
/// partial appends, complete replaces, and only the NEWEST block speaks.
fn on_assistant_text(state: &mut ScopeState, payload: &Value) {
    let Some(text) = payload.get("text").and_then(|v| v.as_str()) else {
        return;
    };
    let msg_id = payload
        .get("msg_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let block_index = payload
        .get("block_index")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let is_partial = payload
        .get("is_partial")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let key = format!("{msg_id}:{block_index}");
    if state.block_key.as_deref() != Some(key.as_str()) {
        // A new block starts a new thought; the old one is history.
        state.block_key = Some(key);
        state.block_text = text.to_string();
        return;
    }
    if is_partial {
        state.block_text.push_str(text);
    } else {
        state.block_text = text.to_string();
    }
}

/// End the wait in flight, if there is one: the superseded line goes back as
/// the newest line so the beat moves off the wait, and the wait fields clear
/// together.
///
/// A no-op when nothing is waiting, which is the ordinary case for every
/// `tool_result` in a turn nobody was asked to approve. The Wait line itself
/// stays in the digest — that a session waited is history the Observer wants;
/// what must not persist is the beat still saying so after the answer landed.
fn end_wait(state: &mut ScopeState, at_ms: u64, beat: u64) -> Option<Digested> {
    if !state.wait_in_flight {
        return None;
    }
    let restored = state.pre_wait_line.take();
    state.waiting_tool_use_id = None;
    state.wait_in_flight = false;
    let newest_is_wait = state
        .digest
        .newest()
        .is_some_and(|line| line.kind == DigestKind::Wait);
    if !newest_is_wait {
        return None;
    }
    let earlier = restored?;
    Some(Digested {
        line: DigestLine {
            text: earlier.text,
            at_ms,
            beat,
            kind: earlier.kind,
            supersede_key: None,
        },
        emission: Emission::Now,
        // A beat, not an event: the work this line describes was recorded when
        // it happened, and the wait ending is only the beat moving back onto it.
        record: false,
    })
}

/// The turn-end marker. It rides both spellings; the deck decides that only
/// `Done` reads as finished.
fn on_turn_end(state: &mut ScopeState, marker: &str, at_ms: u64, beat: u64) -> Digested {
    state.reset_turn();
    Digested {
        line: DigestLine {
            text: marker.to_string(),
            at_ms,
            beat,
            kind: DigestKind::Turn,
            supersede_key: None,
        },
        emission: Emission::Now,
        record: true,
    }
}

// ─────────────────────────────────── tests ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── voice.ts's extraction rules, case for case ──────────────────────────

    #[test]
    fn a_complete_sentence_shows_as_itself() {
        assert_eq!(
            extract_display("I'll dig into how Tug tracks and resumes sessions today.").as_deref(),
            Some("I'll dig into how Tug tracks and resumes sessions today.")
        );
    }

    #[test]
    fn the_last_complete_sentence_wins_when_the_tail_is_trivial() {
        assert_eq!(
            extract_display("There's a ~/.claude/sessions directory. Checking it now. OK")
                .as_deref(),
            Some("Checking it now.")
        );
    }

    #[test]
    fn a_long_in_progress_tail_shows_marked_as_streaming() {
        assert_eq!(
            extract_display("Quick final checks on disk format details before I summar").as_deref(),
            Some("Quick final checks on disk format details before I summar…")
        );
    }

    #[test]
    fn a_settled_sentence_beats_a_fresher_mid_clause_tail() {
        assert_eq!(
            extract_display(
                "That self-feeding ripple is light. When Maxwell calculated its speed, it came out to ~300,000 km",
            )
            .as_deref(),
            Some("That self-feeding ripple is light.")
        );
    }

    #[test]
    fn a_short_fragment_with_nothing_settled_shows_nothing() {
        assert_eq!(extract_display("Now the"), None);
        assert_eq!(extract_display("   "), None);
    }

    #[test]
    fn markdown_passes_through_raw() {
        assert_eq!(
            extract_display("Reading **the devise skeleton** first, then `pulse.md` gets the fix.")
                .as_deref(),
            Some("Reading **the devise skeleton** first, then `pulse.md` gets the fix.")
        );
    }

    #[test]
    fn very_long_content_clips_at_the_raw_budget_never_inside_math() {
        let long = format!("{}end.", "word ".repeat(70));
        let display = extract_display(&long).expect("a settled sentence");
        assert!(display.chars().count() <= LINE_CLIP);

        let mathy = format!(
            "intro words $${}x$$ trailing prose continues here.",
            "x+".repeat(150)
        );
        let clipped = extract_display(&mathy).expect("a settled sentence");
        // The cut never lands inside the span: either the whole math survives
        // or the line ends before it opens.
        assert_eq!(clipped.matches("$$").count() % 2, 0);
    }

    #[test]
    fn structured_math_keeps_its_label_and_balanced_markup() {
        // Real shape from a live session — the broken-line bug this rule set
        // exists to prevent.
        let maxwell = [
            "**1. Gauss's Law (electricity)**",
            "",
            r"$$\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}$$",
            "",
            "**2. Gauss's Law for Magnetism**",
            "",
            r"$$\nabla \cdot \mathbf{B} = 0$$",
        ]
        .join("\n");
        let display = extract_display(&maxwell).expect("the newest settled segment");
        assert_eq!(
            display,
            r"**2. Gauss's Law for Magnetism** $$\nabla \cdot \mathbf{B} = 0$$"
        );
        assert_eq!(display.matches("**").count() % 2, 0);
        assert_eq!(display.matches("$$").count() % 2, 0);
    }

    #[test]
    fn an_enumerator_dot_never_ends_a_sentence() {
        assert_eq!(
            extract_display(
                "The four equations follow. **3.** Faraday describes induction quite neatly here",
            )
            .as_deref(),
            Some("The four equations follow.")
        );
    }

    #[test]
    fn a_heading_label_that_introduces_a_table_is_skipped_for_real_prose() {
        let raw = "I finished the calculator and it builds clean.\n\nVerified behavior:\n\n| expr | result |";
        assert_eq!(
            extract_display(raw).as_deref(),
            Some("I finished the calculator and it builds clean.")
        );
    }

    #[test]
    fn a_bold_heading_label_is_skipped_too() {
        let raw =
            "The parser handles precedence correctly now.\n\n**What's next:**\n\n- add modulo";
        assert_eq!(
            extract_display(raw).as_deref(),
            Some("The parser handles precedence correctly now.")
        );
    }

    // ── the tool-verb table and its labels ──────────────────────────────────

    #[test]
    fn the_tool_verb_table_reads_as_the_deck_spells_it() {
        let read = json!({"file_path": "tugdeck/src/deck-manager.ts"});
        assert_eq!(
            narrate_tool("Read", Some(&read), None),
            "Reading tugdeck/src/deck-manager.ts"
        );
        assert_eq!(
            narrate_tool("Write", Some(&read), None),
            "Writing tugdeck/src/deck-manager.ts"
        );
        assert_eq!(
            narrate_tool("Edit", Some(&read), None),
            "Editing tugdeck/src/deck-manager.ts"
        );
        assert_eq!(
            narrate_tool("NotebookEdit", Some(&read), None),
            "Editing tugdeck/src/deck-manager.ts"
        );
        assert_eq!(
            narrate_tool("Bash", Some(&json!({"command": "cargo nextest run"})), None),
            "Running cargo nextest run"
        );
        assert_eq!(
            narrate_tool("Grep", Some(&json!({"pattern": "FORWARD_ALLOWLIST"})), None),
            "Searching FORWARD_ALLOWLIST"
        );
        assert_eq!(
            narrate_tool("Glob", Some(&json!({"pattern": "**/*.rs"})), None),
            "Finding **/*.rs"
        );
        // No target: the verb alone, never an empty trailing space.
        assert_eq!(narrate_tool("Read", Some(&json!({})), None), "Reading");
        assert_eq!(
            narrate_tool("Bash", Some(&json!({})), None),
            "Running a command"
        );
        // An unknown tool is its own name.
        assert_eq!(narrate_tool("WebFetch", Some(&json!({})), None), "WebFetch");
    }

    #[test]
    fn a_long_command_reaches_the_deck_whole() {
        // The producer budgets no widths: how much of a command fits is the
        // deck's to decide at the width the surface actually has.
        let command = "a".repeat(300);
        let line = narrate_tool("Bash", Some(&json!({"command": command})), None);
        assert_eq!(line, format!("Running {}", "a".repeat(300)));
        // Only the transport guard bounds it.
        let pathological = "b".repeat(PHRASE_GUARD + 50);
        let guarded = narrate_tool("Bash", Some(&json!({"command": pathological})), None);
        assert_eq!(guarded.chars().count(), "Running ".len() + PHRASE_GUARD);
    }

    #[test]
    fn a_slug_agent_type_shows_a_clean_display_label() {
        assert_eq!(agent_display_label("general-purpose"), "General");
        assert_eq!(agent_display_label("statusline-setup"), "Statusline");
        assert_eq!(agent_display_label("output-style-setup"), "Output style");
        assert_eq!(agent_display_label("code-reviewer"), "Code reviewer");
        assert_eq!(agent_display_label("Explore"), "Explore");
        assert_eq!(agent_display_label(""), "");
    }

    #[test]
    fn display_path_passes_a_path_through_when_no_root_is_known() {
        // `root` is None at every call site today — see the docblock. The
        // parameter is exercised here so the follow-on that supplies one is a
        // one-line change against a tested function.
        assert_eq!(display_path("/u/src/tug/a.rs", None), "/u/src/tug/a.rs");
        assert_eq!(display_path("/u/src/tug/a.rs", Some("/u/src/tug")), "a.rs");
        assert_eq!(display_path("/u/src/tug/a.rs", Some("/u/src/tug/")), "a.rs");
        assert_eq!(
            display_path("/elsewhere/a.rs", Some("/u/src/tug")),
            "/elsewhere/a.rs"
        );
        assert_eq!(display_path("/u/src/tug/a.rs", Some("")), "/u/src/tug/a.rs");
    }

    #[test]
    fn a_skill_invocation_names_the_skill() {
        assert_eq!(skill_label("tugplug:vet", None).as_deref(), Some("vet"));
        assert_eq!(
            skill_label("Skill", Some(&json!({"command": "tugplug:arc-implement"}))).as_deref(),
            Some("arc-implement")
        );
        assert_eq!(
            skill_label("Skill", Some(&json!({"name": "dataviz"}))).as_deref(),
            Some("dataviz")
        );
        assert_eq!(
            skill_label("Skill", Some(&json!({}))).as_deref(),
            Some("a skill")
        );
        assert_eq!(skill_label("Bash", Some(&json!({}))), None);
        // Not a plugin name: two colons, or a space.
        assert_eq!(skill_label("a:b:c", None), None);
        assert_eq!(skill_label("a b:c", None), None);
    }

    // ── the one allowlist and its mute brackets ─────────────────────────────

    #[test]
    fn forwardable_session_classification() {
        let mut muted = HashSet::new();
        // Allowlisted + spliced → forwarded with its session.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"tool_use","tool_name":"Bash"}"#,
                &mut muted,
            ),
            Some("s1".to_string())
        );
        // Background-agent progress IS forwarded, so the digest can narrate
        // what a backgrounded agent is doing (not just its start/terminal).
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"task_progress","last_tool_name":"Bash"}"#,
                &mut muted,
            ),
            Some("s1".to_string())
        );
        // A compaction boundary is the only frame a compacting stretch emits.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"compact_boundary","trigger":"manual"}"#,
                &mut muted,
            ),
            Some("s1".to_string())
        );
        // The permission pair, which the Observer's old list lacked.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"control_request_forward","tool_name":"Bash"}"#,
                &mut muted,
            ),
            Some("s1".to_string())
        );
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"control_request_cancel"}"#,
                &mut muted,
            ),
            Some("s1".to_string())
        );
        // Not allowlisted.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"system_metadata"}"#,
                &mut muted,
            ),
            None
        );
        // Allowlisted but unspliced (defensive — relay lines are always
        // spliced).
        assert_eq!(
            forwardable_session(br#"{"type":"tool_use"}"#, &mut muted),
            None
        );
        // Brackets maintain the mute set and are themselves dropped.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"replay_started"}"#,
                &mut muted,
            ),
            None
        );
        assert!(muted.contains("s1"));
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"tool_result"}"#,
                &mut muted,
            ),
            None
        );
        // One session's replay never blocks another's live work.
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s2","type":"tool_use","tool_name":"Read"}"#,
                &mut muted,
            ),
            Some("s2".to_string())
        );
        assert_eq!(
            forwardable_session(
                br#"{"tug_session_id":"s1","type":"replay_complete"}"#,
                &mut muted,
            ),
            None
        );
        assert!(muted.is_empty());
        // Malformed JSON never panics.
        assert_eq!(forwardable_session(b"not json", &mut muted), None);
    }

    // ── the deque's caps ────────────────────────────────────────────────────

    fn line(text: &str) -> DigestLine {
        DigestLine {
            text: text.to_string(),
            at_ms: 0,
            beat: 0,
            kind: DigestKind::Notice,
            supersede_key: None,
        }
    }

    #[test]
    fn the_digest_drops_oldest_first_on_the_line_cap() {
        let mut digest = SessionDigest::new(3, 1_000);
        for i in 0..5 {
            digest.push(line(&format!("line {i}")));
        }
        assert_eq!(digest.len(), 3);
        assert!(digest.was_elided());
        let rendered = digest.rendered();
        assert!(rendered.starts_with(ELISION_MARKER));
        assert!(!rendered.contains("line 0"));
        assert!(rendered.contains("line 4"));
    }

    #[test]
    fn the_digest_drops_oldest_first_on_the_byte_cap() {
        let mut digest = SessionDigest::new(100, 40);
        for i in 0..6 {
            digest.push(line(&format!("{i}{}", "x".repeat(15))));
        }
        assert!(digest.byte_len() <= 40);
        assert!(digest.was_elided());
        // A single line over the whole budget still survives — the deque never
        // empties itself.
        let mut one = SessionDigest::new(100, 4);
        one.push(line("a line far past the byte budget"));
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn an_empty_digest_is_what_makes_an_idle_session_never_wake() {
        let mut digest = SessionDigest::default();
        assert!(digest.is_empty());
        digest.push(line("something happened"));
        assert!(!digest.is_empty());
    }

    #[test]
    fn take_and_restore_front_round_trip() {
        let mut digest = SessionDigest::new(10, 1_000);
        digest.push(line("first"));
        digest.push(line("second"));
        let taken = digest.take();
        assert_eq!(taken.len(), 2);
        assert!(digest.is_empty());
        assert_eq!(digest.byte_len(), 0);

        digest.push(line("third"));
        digest.restore_front(taken);
        assert_eq!(digest.len(), 3);
        let rendered = digest.rendered();
        let order: Vec<&str> = rendered.lines().collect();
        assert_eq!(order, vec!["first", "second", "third"]);
        assert_eq!(
            digest.byte_len(),
            "first".len() + "second".len() + "third".len()
        );

        // Restoring nothing is a no-op.
        digest.restore_front(SessionDigest::new(10, 1_000));
        assert_eq!(digest.len(), 3);
    }

    #[test]
    fn the_tail_is_the_newest_n_lines_oldest_first() {
        let mut digest = SessionDigest::new(10, 1_000);
        for i in 0..5 {
            digest.push(line(&format!("line {i}")));
        }
        let tail: Vec<String> = digest.tail(2).into_iter().map(|l| l.text).collect();
        assert_eq!(tail, vec!["line 3".to_string(), "line 4".to_string()]);
        assert_eq!(digest.tail(99).len(), 5);
        assert_eq!(digest.newest().map(|l| l.text.as_str()), Some("line 4"));
    }

    #[test]
    fn a_line_identical_to_the_newest_is_dropped() {
        let mut digest = SessionDigest::new(10, 1_000);
        digest.push(line("Reading foo.ts"));
        digest.push(line("Reading foo.ts"));
        assert_eq!(digest.len(), 1);
        // …but the same text later in the stretch is a real second event.
        digest.push(line("Done"));
        digest.push(line("Reading foo.ts"));
        assert_eq!(digest.len(), 3);
    }

    // ── the supersede rule, which is what keeps the cap from starving ───────

    fn progress(id: &str, path: &str, lines: u64) -> Value {
        json!({
            "type": "tool_input_progress",
            "tool_use_id": id,
            "tool_name": "Write",
            "file_path": path,
            "content_lines": lines,
        })
    }

    #[test]
    fn a_streaming_write_leaves_one_line_and_spares_the_stretch() {
        // The cap-starvation guard. `tugcode/src/session.ts` emits a cumulative
        // `tool_input_progress` frame every time its progressKey changes, so a
        // single long Write emits on the order of a hundred of them. Without
        // the supersede rule they would spend the whole line cap inside one
        // tool call and starve the Observer's window of the rest of the work.
        let mut digester = SessionDigester::new();
        digester.on_code_frame("s1", &json!({"type": "wake_started"}), 0);
        assert_eq!(digester.digest("s1").map(SessionDigest::len), Some(1));

        for i in 1..=100 {
            digester.on_code_frame("s1", &progress("toolu_1", "tugdeck/src/big.ts", i), i);
        }
        let digest = digester.digest("s1").expect("a digest");
        assert_eq!(
            digest.len(),
            2,
            "a hundred progress frames are one line, and the line before them survived"
        );
        assert_eq!(
            digest.newest().map(|l| l.text.as_str()),
            Some("Writing tugdeck/src/big.ts — 100 lines")
        );

        // The settled `tool_use` for a FILE tool adds nothing: the progress
        // line's final state already IS the finished call, and "Writing big.ts
        // — 100 lines" says more than "Writing big.ts" would. That is
        // `voice.ts`'s rule — a file tool defers to its progress line — and the
        // deque holds one line for the call either way.
        assert!(
            digester
                .on_code_frame(
                    "s1",
                    &json!({
                        "type": "tool_use",
                        "tool_use_id": "toolu_1",
                        "tool_name": "Write",
                        "input": {"file_path": "tugdeck/src/big.ts"},
                    }),
                    200,
                )
                .is_none()
        );
        assert_eq!(digester.digest("s1").map(SessionDigest::len), Some(2));
    }

    #[test]
    fn a_settled_tool_use_supersedes_its_own_progress_lines() {
        // Where the settled frame DOES speak — a generic tool with no file
        // target — it replaces the progress line rather than standing beside
        // it, because they are one call.
        let mut digester = SessionDigester::new();
        for i in 1..=20 {
            digester.on_code_frame(
                "s1",
                &json!({
                    "type": "tool_input_progress",
                    "tool_use_id": "toolu_g",
                    "tool_name": "Grep",
                    "file_path": Value::Null,
                    "content_lines": i,
                }),
                i,
            );
        }
        assert_eq!(digester.digest("s1").map(SessionDigest::len), Some(1));
        let settled = digester
            .on_code_frame(
                "s1",
                &json!({
                    "type": "tool_use",
                    "tool_use_id": "toolu_g",
                    "tool_name": "Grep",
                    "input": {"pattern": "FORWARD_ALLOWLIST"},
                }),
                100,
            )
            .expect("a settled beat");
        assert_eq!(settled.line.text, "Searching FORWARD_ALLOWLIST");
        assert_eq!(digester.digest("s1").map(SessionDigest::len), Some(1));
    }

    #[test]
    fn a_different_tool_call_appends_rather_than_superseding() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame("s1", &progress("toolu_1", "a.ts", 3), 0);
        digester.on_code_frame("s1", &progress("toolu_2", "b.ts", 4), 1);
        assert_eq!(digester.digest("s1").map(SessionDigest::len), Some(2));
    }

    #[test]
    fn a_result_never_supersedes_the_call_it_answers() {
        // The kinds differ, so what came back stands beside the call: it is the
        // evidence the Observer's posts are built out of.
        let mut digester = SessionDigester::new();
        digester.on_code_frame("s1", &progress("toolu_1", "a.ts", 3), 0);
        digester.on_code_frame(
            "s1",
            &json!({"type": "tool_result", "tool_use_id": "toolu_1", "output": "wrote 3 lines", "is_error": false}),
            1,
        );
        let digest = digester.digest("s1").expect("a digest");
        assert_eq!(digest.len(), 2);
        assert_eq!(
            digest.newest().map(|l| l.text.as_str()),
            Some("→ wrote 3 lines")
        );
        assert_eq!(digest.newest().map(|l| l.kind), Some(DigestKind::Result));
    }

    #[test]
    fn an_error_result_says_so() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame(
            "s1",
            &json!({"type": "tool_result", "tool_use_id": "t", "output": "  File not found\n", "is_error": true}),
            0,
        );
        assert_eq!(
            digester
                .digest("s1")
                .and_then(|d| d.newest())
                .map(|l| (l.text.as_str(), l.kind)),
            Some(("→ error: File not found", DigestKind::Error))
        );
    }

    #[test]
    fn one_prose_block_earns_one_line_however_many_deltas_carry_it() {
        let mut digester = SessionDigester::new();
        let delta = |text: &str, partial: bool| {
            json!({
                "type": "assistant_text",
                "msg_id": "m1",
                "block_index": 0,
                "is_partial": partial,
                "text": text,
            })
        };
        digester.on_code_frame("s1", &delta("Working through the reducer ", true), 0);
        digester.on_code_frame("s1", &delta("tests now.", true), 1);
        digester.on_code_frame("s1", &delta(" Then the edit.", true), 2);
        let digest = digester.digest("s1").expect("a digest");
        assert_eq!(digest.len(), 1);
        assert_eq!(
            digest.newest().map(|l| l.text.as_str()),
            Some("Then the edit.")
        );

        // A new block is a new thought, and a new line.
        digester.on_code_frame(
            "s1",
            &json!({
                "type": "assistant_text",
                "msg_id": "m2",
                "block_index": 0,
                "is_partial": false,
                "text": "Now checking how the reducer handles task transitions.",
            }),
            3,
        );
        let digest = digester.digest("s1").expect("a digest");
        assert_eq!(digest.len(), 2);
        assert_eq!(
            digest.newest().map(|l| l.text.as_str()),
            Some("Now checking how the reducer handles task transitions.")
        );
    }

    #[test]
    fn a_complete_frame_replaces_accumulated_deltas() {
        // The deck reducer's rule: partial appends, complete replaces.
        let mut digester = SessionDigester::new();
        digester.on_code_frame(
            "s1",
            &json!({"type": "assistant_text", "msg_id": "m1", "block_index": 0, "is_partial": true, "text": "Half a thought"}),
            0,
        );
        digester.on_code_frame(
            "s1",
            &json!({"type": "assistant_text", "msg_id": "m1", "block_index": 0, "is_partial": false, "text": "The whole thought, settled here."}),
            1,
        );
        let digest = digester.digest("s1").expect("a digest");
        assert_eq!(digest.len(), 1);
        assert_eq!(
            digest.newest().map(|l| l.text.as_str()),
            Some("The whole thought, settled here.")
        );
    }

    // ── the ref surface ─────────────────────────────────────────────────────

    #[test]
    fn a_long_path_keeps_its_basename_after_clipping() {
        // [P04]'s ref surface: a ref can only be linked if the digest spelled
        // the path, and a path clipped from the right resolves to nothing.
        let deep = format!(
            "/Users/kocienda/{}/deck-manager.ts",
            "a-long-directory".repeat(20)
        );
        let clipped = clip_path_left(&deep, MAX_TARGET_CHARS);
        assert!(clipped.chars().count() <= MAX_TARGET_CHARS);
        assert!(clipped.ends_with("deck-manager.ts"), "got {clipped}");
        assert!(clipped.starts_with('…'));

        // Through the tool line the beat actually shows.
        let narrated = narrate_tool("Read", Some(&json!({"file_path": deep})), None);
        assert!(narrated.ends_with("deck-manager.ts"), "got {narrated}");

        // And through the synopsis's spelling.
        let line = tool_line(&json!({"tool_name": "Read", "input": {"file_path": deep}}))
            .expect("a tool line");
        assert!(line.ends_with("deck-manager.ts)"), "got {line}");

        // A short path is untouched.
        assert_eq!(clip_path_left("a.rs", MAX_TARGET_CHARS), "a.rs");
    }

    #[test]
    fn a_command_is_clipped_from_the_head_it_identifies_itself_by() {
        let long = format!("cargo nextest run {}", "-p tugcast ".repeat(40));
        let line = tool_line(&json!({"tool_name": "Bash", "input": {"command": long}}))
            .expect("a tool line");
        assert!(line.starts_with("Bash(cargo nextest run"), "got {line}");
        assert!(line.ends_with("…)"));
    }

    // ── the moved-in frame parsers ──────────────────────────────────────────

    #[test]
    fn shell_beats_narrate_starts_and_failures_and_nothing_else() {
        assert_eq!(
            shell_beat(&json!({"type": "exchange_started", "command": " just lint "})).as_deref(),
            Some("$ just lint")
        );
        assert_eq!(
            shell_beat(
                &json!({"type": "exchange_complete", "command": "just lint", "exit_code": 1})
            )
            .as_deref(),
            Some("$ just lint → exit 1")
        );
        // A clean exit adds nothing beyond the started line.
        assert_eq!(
            shell_beat(
                &json!({"type": "exchange_complete", "command": "just lint", "exit_code": 0})
            ),
            None
        );
        // A missing exit code (spawn failure, kill) has no number to narrate.
        assert_eq!(
            shell_beat(&json!({"type": "exchange_complete", "command": "just lint"})),
            None
        );
        assert_eq!(shell_beat(&json!({"type": "something_else"})), None);
    }

    #[test]
    fn a_submission_is_the_line_the_beat_has_never_had() {
        let payload = json!({
            "tug_session_id": "s1",
            "type": "user_message",
            "content": [{"type": "text", "text": "  Fix the reducer's task transitions.  "}],
        });
        assert_eq!(
            submission_beat(&payload),
            Some((
                "s1".to_string(),
                "asked: Fix the reducer's task transitions.".to_string()
            ))
        );
        // Every other CODE_INPUT verb is not a submission.
        assert_eq!(
            submission_beat(&json!({"tug_session_id": "s1", "type": "tool_approval"})),
            None
        );
        // An empty submission says nothing.
        assert_eq!(
            submission_beat(&json!({
                "tug_session_id": "s1",
                "type": "user_message",
                "content": [{"type": "text", "text": "   "}],
            })),
            None
        );
    }

    #[test]
    fn a_submission_clips_to_the_prompt_budget() {
        let long = "x".repeat(MAX_PROMPT_CHARS + 100);
        let (_, text) = submission_beat(&json!({
            "tug_session_id": "s1",
            "type": "user_message",
            "content": [{"type": "text", "text": long}],
        }))
        .expect("a submission");
        assert_eq!(text.chars().count(), "asked: ".len() + MAX_PROMPT_CHARS);
    }

    #[test]
    fn said_head_waits_for_a_real_sentence_then_caps() {
        assert_eq!(said_head("Short.", false), None);
        assert_eq!(
            said_head(
                "Working through the reducer tests now. And then the edit.",
                false
            )
            .as_deref(),
            Some("said: Working through the reducer tests now.")
        );
        // Finalized, a nonempty remainder is a head even under the cap.
        assert_eq!(said_head("Short.", true).as_deref(), Some("said: Short."));
        // No boundary in budget: the first MAX_SAID_CHARS characters.
        let long = "word ".repeat(60);
        let head = said_head(&long, false).expect("a capped head");
        assert!(head.chars().count() <= "said: ".len() + MAX_SAID_CHARS + 1);
    }

    #[test]
    fn clip_only_marks_text_it_actually_shortened() {
        assert_eq!(clip("exact", 5), "exact");
        assert_eq!(clip("exceeds", 5), "excee…");
        // Character boundaries, not byte offsets.
        assert_eq!(clip("é".repeat(6).as_str(), 3), "ééé…");
    }

    // ── the visible-text scrub ──────────────────────────────────────────────

    #[test]
    fn a_colored_grep_line_composes_a_beat_with_no_escape_bytes() {
        // What `grep --color=always` hands back when it thought it was talking
        // to a terminal, and what the digester quoted verbatim until now.
        let output = "\u{1b}[35m\u{1b}[Ksrc/voice.rs\u{1b}[m\u{1b}[K\u{1b}[36m\u{1b}[K:\u{1b}[m\u{1b}[K12:fn \u{1b}[01;31m\u{1b}[Knarrate\u{1b}[m\u{1b}[K(text: &str)";
        let beat = clip(&one_line(output), RESULT_CLIP);
        assert!(!beat.contains('\u{1b}'), "no ESC survives: {beat:?}");
        assert!(!beat.contains("[K"), "no CSI residue survives: {beat:?}");
        // And the visible text is whole, spacing included.
        assert_eq!(beat, "src/voice.rs:12:fn narrate(text: &str)");
    }

    #[test]
    fn visible_text_drops_the_sequences_and_keeps_the_text() {
        // OSC, terminated by BEL and by ST.
        assert_eq!(visible_text("\u{1b}]0;a title\u{07}after"), "after");
        assert_eq!(visible_text("\u{1b}]8;;https://x\u{1b}\\link"), "link");
        // A two-byte escape is its second byte, and nothing more.
        assert_eq!(visible_text("a\u{1b}(Bb"), "ab");
        // The 8-bit spelling of CSI.
        assert_eq!(visible_text("a\u{9b}31mb"), "ab");
        // A bare ESC at the end introduces nothing.
        assert_eq!(visible_text("done\u{1b}"), "done");
        // Every other C0/C1 control goes; whitespace stays, because the
        // sentence rules are what decide what a newline means.
        assert_eq!(visible_text("a\u{0}\u{7}\u{8}\u{9f}b"), "ab");
        assert_eq!(visible_text("a\nb\tc d"), "a\nb\tc d");
        // Text with nothing to drop is returned as it arrived.
        assert_eq!(visible_text("plain — text"), "plain — text");
    }

    #[test]
    fn a_tool_input_is_scrubbed_as_readily_as_a_result() {
        // `[B04]`: a command carries escapes as readily as output does.
        let beat = shell_beat(&json!({
            "type": "exchange_started",
            "command": "\u{1b}[32mgrep\u{1b}[0m -rn needle",
        }));
        assert_eq!(beat.as_deref(), Some("$ grep -rn needle"));

        let line = tool_line(&json!({
            "tool_name": "Bash",
            "input": { "command": "\u{1b}[1mls\u{1b}[0m -la" },
        }));
        assert_eq!(line.as_deref(), Some("Bash(ls -la)"));

        let narrated = narrate_tool(
            "Grep",
            Some(&json!({ "pattern": "\u{1b}[31mfn narrate\u{1b}[0m" })),
            None,
        );
        assert_eq!(narrated, "Searching fn narrate");
    }

    // ── the narrated permission wait ────────────────────────────────────────

    fn forward(
        tool_name: &str,
        input: Value,
        tool_use_id: Option<&str>,
        is_question: bool,
    ) -> Value {
        let mut payload = json!({
            "type": "control_request_forward",
            "tool_name": tool_name,
            "input": input,
            "is_question": is_question,
        });
        if let Some(id) = tool_use_id {
            payload["tool_use_id"] = json!(id);
        }
        payload
    }

    #[test]
    fn a_permission_forward_says_what_is_being_waited_on() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame(
            "s1",
            &progress("toolu_1", "tugdeck/src/deck-manager.ts", 12),
            0,
        );
        let digested = digester
            .on_code_frame(
                "s1",
                &forward(
                    "Bash",
                    json!({"command": "cargo nextest run"}),
                    Some("toolu_2"),
                    false,
                ),
                1_200,
            )
            .expect("a wait line");
        assert_eq!(
            digested.line.text,
            "Waiting for permission: Running cargo nextest run"
        );
        assert_eq!(digested.line.kind, DigestKind::Wait);
        // A wait that waits for the throttle is a strip that says nothing.
        assert_eq!(digested.emission, Emission::Now);
    }

    #[test]
    fn a_forwarded_question_borrows_the_first_questions_header() {
        let mut digester = SessionDigester::new();
        let digested = digester
            .on_code_frame(
                "s1",
                &forward(
                    "AskUserQuestion",
                    json!({"questions": [{"header": "Auth method"}]}),
                    None,
                    true,
                ),
                0,
            )
            .expect("a wait line");
        assert_eq!(digested.line.text, "Waiting on: Auth method");
        // A question announced as a tool call reads its header the same way.
        let announced = digester
            .on_code_frame(
                "s1",
                &json!({
                    "type": "tool_use",
                    "tool_use_id": "toolu_9",
                    "tool_name": "AskUserQuestion",
                    "input": {"questions": [{"header": "Auth method"}]},
                }),
                1,
            )
            .expect("an ask beat");
        assert_eq!(announced.line.text, "Asking: Auth method");
        // A call carrying no header.
        let bare = question_beat(Some(&json!({"questions": []})), "Waiting on");
        assert_eq!(bare, "Waiting on a question");
    }

    #[test]
    fn a_cancel_puts_the_superseded_line_back() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame(
            "s1",
            &progress("toolu_1", "tugdeck/src/deck-manager.ts", 12),
            0,
        );
        digester.on_code_frame(
            "s1",
            &forward(
                "Bash",
                json!({"command": "rm -rf build"}),
                Some("toolu_2"),
                false,
            ),
            1_200,
        );
        let restored = digester
            .on_code_frame("s1", &json!({"type": "control_request_cancel"}), 2_400)
            .expect("the superseded line, back");
        assert_eq!(
            restored.line.text,
            "Writing tugdeck/src/deck-manager.ts — 12 lines"
        );
        assert_eq!(restored.emission, Emission::Now);
        // The wait itself stays in the digest — that a session waited is
        // history the Observer wants.
        let rendered = digester.digest("s1").expect("a digest").rendered();
        assert!(rendered.contains("Waiting for permission: Running rm -rf build"));
    }

    #[test]
    fn the_approved_calls_own_tool_result_ends_the_wait() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame("s1", &progress("toolu_1", "a.ts", 3), 0);
        digester.on_code_frame(
            "s1",
            &forward(
                "Bash",
                json!({"command": "just lint"}),
                Some("toolu_2"),
                false,
            ),
            1_200,
        );
        // A result for some OTHER call in flight does not end this wait.
        digester.on_code_frame(
            "s1",
            &json!({"type": "tool_result", "tool_use_id": "toolu_other", "output": "", "is_error": false}),
            1_300,
        );
        assert_eq!(
            digester
                .digest("s1")
                .and_then(|d| d.newest())
                .map(|l| l.kind),
            Some(DigestKind::Wait),
            "an unrelated result leaves the wait standing"
        );
        // The named call's own result does.
        let ended = digester
            .on_code_frame(
                "s1",
                &json!({"type": "tool_result", "tool_use_id": "toolu_2", "output": "ok", "is_error": false}),
                2_400,
            )
            .expect("the wait ends");
        assert_eq!(ended.line.text, "→ ok");
        assert_eq!(ended.emission, Emission::Now);
    }

    #[test]
    fn a_questions_wait_which_names_no_call_ends_on_any_tool_result() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame("s1", &progress("toolu_1", "tugdeck/src/main.tsx", 3), 0);
        digester.on_code_frame(
            "s1",
            &forward(
                "AskUserQuestion",
                json!({"questions": [{"header": "Auth method"}]}),
                None,
                true,
            ),
            1_200,
        );
        // No output on the frame, so the restored line is what moves the beat.
        let restored = digester
            .on_code_frame(
                "s1",
                &json!({"type": "tool_result", "tool_use_id": "toolu_whatever", "is_error": false}),
                2_400,
            )
            .expect("the superseded line, back");
        assert_eq!(restored.line.text, "Writing tugdeck/src/main.tsx — 3 lines");
    }

    // ── turn boundaries and notices ─────────────────────────────────────────

    #[test]
    fn a_turns_end_is_a_bare_marker_the_deck_reads() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame(
            "s1",
            &json!({
                "type": "assistant_text",
                "msg_id": "m1",
                "block_index": 0,
                "is_partial": false,
                "text": "I'll fold the transcript and the composer on the settle's own clock.",
            }),
            0,
        );
        digester.on_code_frame(
            "s1",
            &progress("toolu_1", "tugdeck/src/lib/layout-imposer.ts", 6),
            100,
        );
        let done = digester
            .on_code_frame("s1", &json!({"type": "turn_complete"}), 2_000)
            .expect("a turn marker");
        assert_eq!(done.line.text, "Done");
        assert_eq!(done.line.kind, DigestKind::Turn);
        assert_eq!(done.emission, Emission::Now);
        let stopped = digester
            .on_code_frame("s1", &json!({"type": "turn_cancelled"}), 3_000)
            .expect("a turn marker");
        assert_eq!(stopped.line.text, "Stopped");
        assert_eq!(stopped.line.kind, DigestKind::Turn);
    }

    #[test]
    fn a_compaction_speaks_immediately_and_starts_the_scope_clean() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame(
            "s1",
            &json!({"type": "assistant_text", "msg_id": "m1", "block_index": 0, "is_partial": false, "text": "A substantial thought worth pinning here."}),
            0,
        );
        let compacted = digester
            .on_code_frame(
                "s1",
                &json!({"type": "compact_boundary", "trigger": "auto", "pre_tokens": 154_000}),
                1,
            )
            .expect("a compaction beat");
        assert_eq!(compacted.line.text, "Auto-compacted context (was 154k)");
        // Immediately, ahead of any throttle: on a manual /compact the boundary
        // is followed within a frame or two by turn_complete, which resets the
        // scope — a throttled beat would be swallowed.
        assert_eq!(compacted.emission, Emission::Now);
        // A manual boundary without metadata stays plain.
        let plain = digester
            .on_code_frame(
                "s2",
                &json!({"type": "compact_boundary", "trigger": "manual"}),
                2,
            )
            .expect("a compaction beat");
        assert_eq!(plain.line.text, "Compacted context");
        // The scope started clean: the accumulated prose block went with the
        // context it describes, so the next beat narrates the tool alone.
        let after = digester
            .on_code_frame("s1", &progress("toolu_1", "a.ts", 2), 3)
            .expect("a tool line");
        assert_eq!(after.line.kind, DigestKind::Tool);
    }

    #[test]
    fn the_notice_beats_the_monologue_never_covers() {
        let mut digester = SessionDigester::new();
        let mut text = |payload: Value| {
            digester
                .on_code_frame("s1", &payload, 0)
                .map(|d| d.line.text)
        };
        assert_eq!(
            text(json!({"type": "task_updated", "status": "completed"})).as_deref(),
            Some("Background job finished")
        );
        assert_eq!(
            text(json!({"type": "task_updated", "status": "failed"})).as_deref(),
            Some("Background job failed")
        );
        assert_eq!(
            text(json!({"type": "task_updated", "status": "cancelled"})).as_deref(),
            Some("Background job stopped")
        );
        assert_eq!(
            text(json!({"type": "wake_started"})).as_deref(),
            Some("Resumed")
        );
        assert_eq!(
            text(json!({"type": "api_retry", "attempt": 2})).as_deref(),
            Some("Retrying (attempt 2)…")
        );
        assert_eq!(
            text(json!({"type": "api_retry"})).as_deref(),
            Some("Retrying…")
        );
        assert_eq!(
            text(json!({"type": "model_refusal_fallback", "fallback_model": "haiku"})).as_deref(),
            Some("Switched to haiku")
        );
        assert_eq!(
            text(json!({"type": "model_refusal_fallback", "fallback_model": ""})).as_deref(),
            Some("Switched to a fallback model")
        );
        assert_eq!(
            text(json!({"type": "output_truncated"})).as_deref(),
            Some("Response truncated")
        );
    }

    #[test]
    fn task_list_lifecycle_surfaces_as_beats() {
        let mut digester = SessionDigester::new();
        let use_frame = |name: &str, input: Value| json!({"type": "tool_use", "tool_use_id": "toolu_t", "tool_name": name, "input": input});
        // The empty-input content_block_start is intentionally silent.
        assert!(
            digester
                .on_code_frame("s1", &use_frame("TaskCreate", json!({})), 0)
                .is_none()
        );
        assert_eq!(
            digester
                .on_code_frame(
                    "s1",
                    &use_frame("TaskCreate", json!({"subject": "Port the digester"})),
                    1
                )
                .map(|d| d.line.text)
                .as_deref(),
            Some("Created: Port the digester")
        );
        assert_eq!(
            digester
                .on_code_frame(
                    "s1",
                    &use_frame("TaskUpdate", json!({"taskId": 1, "status": "in_progress"})),
                    2
                )
                .map(|d| d.line.text)
                .as_deref(),
            Some("Started task 1")
        );
        assert_eq!(
            digester
                .on_code_frame(
                    "s1",
                    &use_frame("TaskUpdate", json!({"taskId": "1", "status": "completed"})),
                    3
                )
                .map(|d| d.line.text)
                .as_deref(),
            Some("Completed task 1")
        );
        assert_eq!(
            digester
                .on_code_frame(
                    "s1",
                    &use_frame("TaskUpdate", json!({"taskId": 1, "status": "deleted"})),
                    4
                )
                .map(|d| d.line.text)
                .as_deref(),
            Some("Dropped task 1")
        );
        // An unknown status says nothing rather than guessing.
        assert!(
            digester
                .on_code_frame(
                    "s1",
                    &use_frame("TaskUpdate", json!({"taskId": 1, "status": "queued"})),
                    5
                )
                .is_none()
        );
    }

    #[test]
    fn a_launched_agent_labels_its_own_tool_calls() {
        let mut digester = SessionDigester::new();
        let launch = digester
            .on_code_frame(
                "s1",
                &json!({
                    "type": "tool_use",
                    "tool_use_id": "toolu_agent",
                    "tool_name": "Agent",
                    "input": {"subagent_type": "general-purpose", "description": "sweep the tree"},
                }),
                0,
            )
            .expect("a launch beat");
        assert_eq!(launch.line.text, "Launching General…");
        // And a launch with no slug labels itself from the `description`
        // input, which is scrubbed like every other one (`[B04]`).
        let described = SessionDigester::new()
            .on_code_frame(
                "s1",
                &json!({
                    "type": "tool_use",
                    "tool_use_id": "toolu_described",
                    "tool_name": "Agent",
                    "input": {"description": "\u{1b}[33msweep the tree\u{1b}[0m"},
                }),
                0,
            )
            .expect("a launch beat");
        assert_eq!(described.line.text, "Launching sweep the tree…");
        // A subagent's tool call is the only activity it streams to the parent.
        let subagent = digester
            .on_code_frame(
                "s1",
                &json!({
                    "type": "tool_use",
                    "tool_use_id": "toolu_sub",
                    "parent_tool_use_id": "toolu_agent",
                    "tool_name": "Grep",
                    "input": {"pattern": "FORWARD_ALLOWLIST"},
                }),
                1,
            )
            .expect("a subagent beat");
        assert_eq!(subagent.line.text, "General · Searching FORWARD_ALLOWLIST");
        // A backgrounded agent's progress keeps the beat alive — its own tool
        // calls do NOT stream to the parent.
        let progress_beat = digester
            .on_code_frame(
                "s1",
                &json!({"type": "task_progress", "tool_use_id": "toolu_agent", "last_tool_name": "Grep"}),
                2,
            )
            .expect("a progress beat");
        assert_eq!(progress_beat.line.text, "General · Grep");
        let unlabelled = digester
            .on_code_frame(
                "s2",
                &json!({"type": "task_progress", "tool_use_id": "toolu_x"}),
                3,
            )
            .expect("a progress beat");
        assert_eq!(unlabelled.line.text, "Agent working…");
        // A subagent frame with no input yet says nothing.
        assert!(digester
            .on_code_frame(
                "s1",
                &json!({"type": "tool_use", "parent_tool_use_id": "toolu_agent", "tool_name": "Grep", "input": {}}),
                4,
            )
            .is_none());
    }

    #[test]
    fn a_generic_non_file_tool_speaks_only_when_the_assistant_has_not() {
        let mut digester = SessionDigester::new();
        let grep = json!({
            "type": "tool_use",
            "tool_use_id": "toolu_g",
            "tool_name": "Grep",
            "input": {"pattern": "needle"},
        });
        // No monologue: the fallback keeps a tool-only stretch off "None".
        assert_eq!(
            digester
                .on_code_frame("s1", &grep, 0)
                .map(|d| d.line.text)
                .as_deref(),
            Some("Searching needle")
        );
        // During narration the monologue keeps the beat.
        digester.on_code_frame(
            "s2",
            &json!({"type": "assistant_text", "msg_id": "m1", "block_index": 0, "is_partial": false, "text": "Reading the reducer before I touch it."}),
            1,
        );
        assert!(digester.on_code_frame("s2", &grep, 2).is_none());
        // A file tool defers to the monologue / progress line regardless.
        assert!(digester
            .on_code_frame(
                "s2",
                &json!({"type": "tool_use", "tool_use_id": "t", "tool_name": "Read", "input": {"file_path": "a.rs"}}),
                3,
            )
            .is_none());
    }

    #[test]
    fn a_skill_invocation_is_an_always_shown_beat() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame(
            "s1",
            &json!({"type": "assistant_text", "msg_id": "m1", "block_index": 0, "is_partial": false, "text": "Reaching for the review skill now."}),
            0,
        );
        // Even under narration — a skill drives its own turn with little prose.
        assert_eq!(
            digester
                .on_code_frame(
                    "s1",
                    &json!({"type": "tool_use", "tool_use_id": "t", "tool_name": "tugplug:arc-implement", "input": {}}),
                    1,
                )
                .map(|d| d.line.text)
                .as_deref(),
            Some("Running arc-implement")
        );
    }

    // ── scopes, submissions, shell, and the idle sweep ──────────────────────

    #[test]
    fn scopes_speak_independently() {
        let mut digester = SessionDigester::new();
        let say = |text: &str| json!({"type": "assistant_text", "msg_id": "m1", "block_index": 0, "is_partial": false, "text": text});
        digester.on_code_frame("s1", &say("Working through the reducer tests."), 0);
        digester.on_code_frame("s2", &say("Drafting the probe harness adaptation."), 0);
        assert_eq!(
            digester
                .digest("s1")
                .and_then(|d| d.newest())
                .map(|l| l.text.as_str()),
            Some("Working through the reducer tests.")
        );
        assert_eq!(
            digester
                .digest("s2")
                .and_then(|d| d.newest())
                .map(|l| l.text.as_str()),
            Some("Drafting the probe harness adaptation.")
        );
    }

    #[test]
    fn a_submission_and_a_shell_exchange_reach_the_right_session() {
        let mut digester = SessionDigester::new();
        let (session, asked) = digester
            .on_submission(
                &json!({
                    "tug_session_id": "s1",
                    "type": "user_message",
                    "content": [{"type": "text", "text": "Consolidate the three taps."}],
                }),
                0,
            )
            .expect("an ask");
        assert_eq!(session, "s1");
        assert_eq!(asked.line.text, "asked: Consolidate the three taps.");
        assert_eq!(asked.line.kind, DigestKind::Ask);
        // An ask throttled behind a tool line is an ask the deck never gets.
        assert_eq!(asked.emission, Emission::Now);

        let shell = digester
            .on_shell_frame(
                "s1",
                &json!({"type": "exchange_started", "command": "just lint"}),
                1,
            )
            .expect("a shell line");
        assert_eq!(shell.line.text, "$ just lint");
        assert_eq!(shell.line.kind, DigestKind::Shell);
        assert_eq!(digester.digest("s1").map(SessionDigest::len), Some(2));
    }

    #[test]
    fn idle_scopes_are_swept_on_a_clock_that_is_a_parameter() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame("s-idle", &json!({"type": "wake_started"}), 0);
        digester.on_code_frame(
            "s-live",
            &json!({"type": "wake_started"}),
            SCOPE_IDLE_SWEEP_MS,
        );
        assert_eq!(
            digester.sweep_inactive(SCOPE_IDLE_SWEEP_MS - 1),
            Vec::<String>::new()
        );
        assert_eq!(
            digester.sweep_inactive(SCOPE_IDLE_SWEEP_MS + 1),
            vec!["s-idle".to_string()]
        );
        assert!(digester.digest("s-live").is_some());
        assert!(digester.digest("s-idle").is_none());
    }

    #[test]
    fn a_wake_takes_the_window_and_a_failed_job_puts_it_back() {
        let mut digester = SessionDigester::new();
        digester.on_code_frame("s1", &json!({"type": "wake_started"}), 0);
        digester.on_code_frame("s1", &progress("toolu_1", "a.ts", 3), 1);
        let taken = digester.take_digest("s1").expect("a digest");
        assert_eq!(taken.len(), 2);
        assert!(digester.digest("s1").is_some_and(SessionDigest::is_empty));

        digester.on_code_frame("s1", &json!({"type": "turn_complete"}), 2);
        digester.restore_digest("s1", taken);
        let rendered = digester.digest("s1").expect("a digest").rendered();
        let order: Vec<&str> = rendered.lines().collect();
        assert_eq!(order, vec!["Resumed", "Writing a.ts — 3 lines", "Done"]);
    }

    #[test]
    fn the_beat_counter_is_monotonic_across_scopes() {
        let mut digester = SessionDigester::new();
        let first = digester
            .on_code_frame("s1", &json!({"type": "wake_started"}), 0)
            .expect("a line");
        let second = digester
            .on_code_frame("s2", &json!({"type": "wake_started"}), 0)
            .expect("a line");
        assert!(second.line.beat > first.line.beat);
    }

    #[test]
    fn every_kind_has_a_wire_spelling() {
        // The fixture golden pins these, so a new variant that forgets one is
        // a name nothing can read.
        for kind in [
            DigestKind::Ask,
            DigestKind::Said,
            DigestKind::Tool,
            DigestKind::Result,
            DigestKind::Error,
            DigestKind::Shell,
            DigestKind::Turn,
            DigestKind::Notice,
            DigestKind::Wait,
        ] {
            assert!(!kind.as_str().is_empty());
        }
    }
}

// ────────────────────── the fixture drift guard ([P03]) ──────────────────────

/// The drift guard's own module: it reads a recorded frame stream, runs it
/// through the digester on a fixed clock, and compares the produced lines to a
/// checked-in golden.
///
/// This is what replaces the compile-time guard the retired TypeScript daemon
/// had — its `OutboundMessage` types meant a renamed wire field broke the
/// build. A pinned line set is the stronger guard of the two: a compile error
/// only ever caught a rename, while this catches a semantic change as well. Add
/// a frame kind and forget the fixture, and
/// [`golden::the_fixture_covers_every_kind`]
/// fails; change what a kind says, and the golden fails.
#[cfg(test)]
mod golden {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    const UPDATE_ENV: &str = "TUG_DIGEST_GOLDEN_UPDATE";

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/session-digest")
    }

    /// Which wire a recorded line arrived on, read off its own `type`. The live
    /// bridge knows this from which broadcast it is subscribed to; a JSONL line
    /// has no envelope, so the fixture recovers it from the payload.
    fn wire_of(msg_type: &str) -> &'static str {
        match msg_type {
            "user_message" => "code_input",
            "exchange_started" | "exchange_complete" => "shell_output",
            _ => "code_output",
        }
    }

    /// Run the whole stream and render what it produced.
    ///
    /// The clock is the line's own index times a second, which is a fixed clock
    /// in the only sense that matters: the same stream produces the same
    /// numbers on every machine and every run.
    fn render_stream(raw: &str) -> String {
        let mut digester = SessionDigester::new();
        let mut muted = std::collections::HashSet::new();
        let mut emitted: Vec<String> = Vec::new();

        for (index, line) in raw.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let at_ms = index as u64 * 1_000;
            let Ok(payload) = serde_json::from_str::<Value>(trimmed) else {
                // Malformed JSON never panics and never produces a line. The
                // classifier is still asked, because that is where the live
                // bridge asks it.
                assert_eq!(forwardable_session(trimmed.as_bytes(), &mut muted), None);
                continue;
            };
            let msg_type = payload
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            let digested = match wire_of(msg_type) {
                // CODE_INPUT and SHELL_OUTPUT carry no replay brackets and need
                // no mute set — a reconnect flood only ever arrives on
                // CODE_OUTPUT.
                "code_input" => digester
                    .on_submission(&payload, at_ms)
                    .map(|(_, digested)| digested),
                "shell_output" => {
                    let scope = payload
                        .get("tug_session_id")
                        .and_then(|v| v.as_str())
                        .expect("a shell frame names its session");
                    digester.on_shell_frame(scope, &payload, at_ms)
                }
                _ => match forwardable_session(trimmed.as_bytes(), &mut muted) {
                    Some(scope) => digester.on_code_frame(&scope, &payload, at_ms),
                    // Dropped by the allowlist, or muted by a replay bracket.
                    None => None,
                },
            };

            let session = payload
                .get("tug_session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("—");
            match digested {
                Some(d) => {
                    let emission = match d.emission {
                        Emission::Now => "now",
                        Emission::Throttled => "throttled",
                    };
                    emitted.push(format!(
                        "{session} {} {emission} | {}",
                        d.line.kind.as_str(),
                        d.line.text
                    ));
                }
                None => emitted.push(format!("{session} — | (no line)")),
            }
        }

        // Sessions in a stable order, whatever the map's iteration order is.
        let digests: BTreeMap<String, String> = digester
            .scopes()
            .map(|(scope, state)| (scope.clone(), state.digest().rendered()))
            .collect();

        let mut out = String::new();
        out.push_str("# What each frame produced, in wire order\n#\n");
        out.push_str("# <session> <kind> <emission> | <text>\n\n");
        for row in &emitted {
            out.push_str(row);
            out.push('\n');
        }
        out.push_str("\n# What each session's digest holds at the end\n");
        for (scope, rendered) in &digests {
            out.push_str(&format!("\n## {scope}\n"));
            out.push_str(rendered);
        }
        out
    }

    #[test]
    fn the_digest_matches_its_golden() {
        let dir = fixture_dir();
        let frames = std::fs::read_to_string(dir.join("frames.jsonl")).expect("frames.jsonl");
        let produced = render_stream(&frames);
        let golden_path = dir.join("lines.golden");

        if std::env::var_os(UPDATE_ENV).is_some() {
            std::fs::write(&golden_path, &produced).expect("write the golden");
            return;
        }

        let golden = std::fs::read_to_string(&golden_path).unwrap_or_default();
        assert_eq!(
            produced, golden,
            "the digest's lines moved. Read the diff: if the change is intended, \
             rebuild with `{UPDATE_ENV}=1 cargo nextest run -p tugcast session_digest` \
             (or `just golden`) and commit the result. If it is not, the frame \
             vocabulary drifted underneath the digester."
        );
    }

    #[test]
    fn the_fixture_covers_every_kind() {
        // A guard that covers eleven of fourteen kinds has holes exactly where
        // the rare ones are, so an extension of the vocabulary that forgets the
        // fixture fails here rather than shipping unpinned.
        let frames =
            std::fs::read_to_string(fixture_dir().join("frames.jsonl")).expect("frames.jsonl");
        let produced = render_stream(&frames);
        for kind in [
            DigestKind::Ask,
            DigestKind::Said,
            DigestKind::Tool,
            DigestKind::Result,
            DigestKind::Error,
            DigestKind::Shell,
            DigestKind::Turn,
            DigestKind::Notice,
            DigestKind::Wait,
        ] {
            assert!(
                produced.contains(&format!(" {} ", kind.as_str())),
                "the fixture produces no {} line — add a frame for it",
                kind.as_str()
            );
        }
    }

    #[test]
    fn the_stream_exercises_both_of_the_other_wires_and_the_mute_brackets() {
        // The three properties the golden cannot assert by shape alone: the
        // submission wire reaches the digest at all, a replay flood is muted,
        // and one session's replay does not block another's live work.
        let frames =
            std::fs::read_to_string(fixture_dir().join("frames.jsonl")).expect("frames.jsonl");
        let produced = render_stream(&frames);
        assert!(produced.contains("asked: Consolidate the three taps"));
        assert!(produced.contains("$ cargo nextest run -p tugcast"));
        assert!(
            !produced.contains("This sentence is history"),
            "a replayed frame was narrated — the mute brackets are not holding"
        );
        assert!(
            produced.contains("Finding tugrust/crates/tugcast/src/feeds/*.rs"),
            "a live frame was muted by another session's replay"
        );
    }
}

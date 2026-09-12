//! observer_wake — the Observer's decision core, with no IO in it.
//!
//! Rust decides *when* to wake the Observer; the model decides *whether and
//! what* to post. This module is the whole of the first half plus the parsing
//! of the second, and it is deliberately pure: buffers, wake reasons, the
//! composition of a wake's input, and the strict read of the envelope that
//! comes back. The live bridge owns the tokio wiring and nothing else.
//!
//! ## Why purity is the point here
//!
//! The offline replay harness and the live bridge must run **the same**
//! segmentation and composition, or the cadence tuned against real transcripts
//! is not the cadence that ships. Keeping this module free of channels, clocks,
//! and sockets is what lets both drive it — and it makes "an idle session never
//! wakes" and "a malformed envelope posts nothing" testable without standing
//! anything up.
//!
//! Time enters as a parameter. Nothing here reads a clock.

// The composition and validation surface is authored ahead of the bridge and
// the replay harness that call it; suppress dead-code for the phased rollout,
// as `session_ledger.rs` and `path_resolver.rs` do.
#![allow(dead_code)]

use serde::Deserialize;
use tugcast_core::{OverviewRef, OverviewRefKind};

use super::session_digest::SessionDigest;

// MARK: - The tap

/// Whether a tapped frame is the session doing work, as opposed to the wire
/// closing a turn.
///
/// A turn-end wake fires only when the turn actually held work: a `/model`
/// slash command is a user message and a `turn_complete` and nothing else, and
/// waking a model to be told that a setting changed spends a call to learn
/// there is nothing to say. A user prompt does not count either — it arrives on
/// the submission feed and never reaches this predicate, which is why "the user
/// asked something and nothing happened yet" is not post-worthy.
///
/// Shared rather than written twice: both the live bridge and the replay
/// harness gate their turn-end wake on this, so the wake count the harness
/// reports is the wake count the bridge would fire. Two copies of this rule is
/// exactly the drift [R01] exists to prevent — and did drift, until a live log
/// showing one wake was read beside a replay claiming three.
pub fn counts_as_assistant_activity(msg_type: &str) -> bool {
    !matches!(msg_type, "turn_complete" | "turn_cancelled")
}

// MARK: - Wake reasons

/// Why the Observer is being asked now.
///
/// The reason rides the job input because the model uses it well — a
/// session-end wake produces a wrap-up, a turn-end wake produces "here is what
/// that turn did", and a sitrep wake produces either progress or silence. It
/// is a fact about the moment, not a hint about the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeReason {
    /// A turn finished. Functions as a flush and as the "ready for you to look
    /// in" signal; real turns routinely outrun the sitrep timer, so this is
    /// not the primary cadence.
    TurnEnd,
    /// Enough continuous activity has accumulated since this session's last
    /// post. The dominant wake in practice.
    SitrepTimer,
    /// The session ended.
    SessionEnd,
    /// Cumulative token usage since the last post crossed the threshold.
    TokenThreshold,
}

impl WakeReason {
    /// The wire spelling, which is also what the job input carries and what a
    /// post records in `wake_reason`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TurnEnd => "turn-end",
            Self::SitrepTimer => "sitrep-timer",
            Self::SessionEnd => "session-end",
            Self::TokenThreshold => "token-threshold",
        }
    }
}

/// What a window prints in place of lines it dropped.
///
/// Explicit rather than silent: a model shown a truncated window with no
/// marker would describe the window as if it were the whole stretch. Read by
/// [`SessionDigest::rendered`], which is what a window renders through.
pub const ELISION_MARKER: &str = "[earlier frames elided]";

// MARK: - Composing a wake

/// One prior post, as the wake input renders it.
pub struct PriorPost {
    pub at_ms: i64,
    pub body: String,
}

/// One settled fact, as the wake input renders it ([P10]).
///
/// The `text` is the ledger's stored rendering, not a re-derivation: the FTS
/// index and this section read the same column, so search and narration can
/// never describe the same fact differently (Risk R01).
pub struct FactLine {
    pub at_ms: i64,
    pub text: String,
}

/// The header the facts section prints. Pinned by the instructions' contract
/// test — the Observer is told about this exact heading.
pub const FACTS_SECTION_HEADER: &str = "SETTLED FACTS SINCE YOUR LAST POST:";

/// What the facts section prints in place of facts it dropped — the frame
/// buffer's `ELISION_MARKER` reasoning, applied to the other corpus.
pub const FACTS_ELISION_MARKER: &str = "[earlier facts elided]";

/// Facts per section, newest kept. A wake is one turn, and twenty facts is
/// already more settled ground truth than a ~44-word post can cite.
pub const FACTS_SECTION_MAX: usize = 20;

/// Byte ceiling for the section, so one pathological rendering cannot displace
/// the activity window it sits above.
pub const FACTS_SECTION_MAX_BYTES: usize = 4 * 1024;

/// The header under which the wake input carries the sentence currently
/// standing under the session's callsign. Pinned by the instructions'
/// contract test — the Observer is told about this exact heading, and told
/// to answer `null` for the sentence when the session is still about what
/// it says.
pub const STANDING_SENTENCE_HEADER: &str = "STANDING SENTENCE NOW:";

/// What the standing-sentence section prints when no sentence stands yet.
pub const STANDING_SENTENCE_NONE: &str = "(none — no sentence stands yet; write one)";

/// Render the `SETTLED FACTS` section ([P10], Spec S04).
///
/// Oldest-first within the section, but the *drops* come off the front: the
/// newest facts are the ones a post is most likely to be about. The rendered
/// string is also a ref-validation corpus in its own right, which is why it is
/// built once here and handed to `validate_refs` rather than reconstructed.
pub fn render_facts_section(facts: &[FactLine]) -> String {
    let mut out = String::new();
    out.push_str(FACTS_SECTION_HEADER);
    out.push('\n');
    if facts.is_empty() {
        out.push_str("(none)\n");
        return out;
    }
    // Take from the tail: count first, then bytes, so a run of ordinary facts
    // is bounded by the count and one enormous rendering is bounded by bytes.
    let mut kept: Vec<&FactLine> = Vec::new();
    let mut bytes = 0usize;
    for fact in facts.iter().rev() {
        if kept.len() >= FACTS_SECTION_MAX {
            break;
        }
        let cost = fact.text.len() + 24;
        if !kept.is_empty() && bytes + cost > FACTS_SECTION_MAX_BYTES {
            break;
        }
        bytes += cost;
        kept.push(fact);
    }
    kept.reverse();
    if kept.len() < facts.len() {
        out.push_str(FACTS_ELISION_MARKER);
        out.push('\n');
    }
    for fact in kept {
        out.push_str("- [");
        out.push_str(&fact.at_ms.to_string());
        out.push_str("] ");
        out.push_str(&fact.text);
        out.push('\n');
    }
    out
}

/// Build the self-contained turn for one wake.
///
/// Every wake is independent: the reason, the session, the frames, and the
/// Observer's own last few posts about this session all ride the message, so
/// any turn can be a worker's first. The prior posts are the entire dedup
/// mechanism — nothing compares text, the model simply sees what it already
/// said and declines to repeat itself.
///
/// The facts section ([P10]) sits between the prior posts and the activity: the
/// activity window is what the wire happened to carry, and the facts are what
/// actually settled — SHAs, test totals, the prompt in full — which is what the
/// rubric wants to cite. It is returned alongside the composed input because the
/// caller needs its exact rendered text as a ref-validation corpus.
///
/// The standing sentence rides between the prior posts and the facts. The
/// Observer is the writer of that sentence and is told to keep it unless the
/// session's subject has moved — which it can only judge by seeing the
/// sentence it is being asked to revise. Before this section existed every
/// wake composed a fresh sentence blind, and the line's stability was a
/// coincidence of five consecutive rewrites landing on similar words.
pub fn compose_observer_input(
    reason: WakeReason,
    session_id: &str,
    window: &SessionDigest,
    prior_posts: &[PriorPost],
    facts: &[FactLine],
    standing: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("WAKE REASON: ");
    out.push_str(reason.as_str());
    out.push_str("\nSESSION: ");
    out.push_str(session_id);
    out.push_str("\n\n");

    out.push_str("YOUR RECENT POSTS ABOUT THIS SESSION:\n");
    if prior_posts.is_empty() {
        out.push_str("(none — this session has not been posted about yet)\n");
    } else {
        for post in prior_posts {
            out.push_str("- [");
            out.push_str(&post.at_ms.to_string());
            out.push_str("] ");
            out.push_str(&post.body);
            out.push('\n');
        }
    }

    out.push('\n');
    out.push_str(STANDING_SENTENCE_HEADER);
    out.push('\n');
    match standing.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sentence) => out.push_str(sentence),
        None => out.push_str(STANDING_SENTENCE_NONE),
    }
    out.push('\n');

    out.push('\n');
    out.push_str(&render_facts_section(facts));

    out.push_str("\nSESSION ACTIVITY SINCE THEN:\n");
    out.push_str(&window.rendered());
    out
}

// MARK: - The envelope

/// What `observer-post` answers with.
///
/// One ask writes both accounts of the session: the post that goes to the
/// Overview, and the standing sentence under the session's callsign. They are
/// independent answers to one reading of the same work — a wake may post and
/// not revise the sentence, revise the sentence and not post, do both, or do
/// neither — and that is the point of carrying them together: a post and a
/// sentence written from one reading cannot contradict each other.
///
/// `deny_unknown_fields` throughout: the contract is narrow on purpose, and a
/// model that invented a field has drifted from it in a way worth noticing at
/// the parse rather than absorbing.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ObserverEnvelope {
    /// `None` is a real answer — the model read the work and judged it not
    /// worth telling.
    pub post: Option<ObserverPost>,
    /// The standing sentence under the session's callsign, or `None` for "what
    /// stands is still right". Absent as well as null, because an older answer
    /// shape is a wake that says nothing about the sentence rather than a wake
    /// that fails.
    #[serde(default)]
    pub synopsis: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ObserverPost {
    pub body: String,
    #[serde(default)]
    pub refs: Vec<OverviewRef>,
}

/// Read the envelope, or decide to post nothing.
///
/// A missing field, an unknown ref kind, malformed JSON, or no envelope at all
/// yields `None`, meaning no post. Silence is always the safe failure mode, and
/// a repaired or partially-salvaged post is worse than none: it would put words
/// in the channel that no one wrote on purpose.
///
/// **The envelope does not have to be the entire answer.** The instructions ask
/// for bare JSON, and the offline replay showed the model prefacing it with a
/// sentence of its own about four times in ten anyway — discarding those threw
/// away complete, well-formed envelopes at a rate that swamped every real
/// editorial silence and made the channel look far quieter than the model
/// intended. So the outermost `{…}` span is located and parsed, which is
/// finding the envelope rather than repairing one: what gets parsed is still
/// the model's own JSON, still whole, still strict about its fields. A preamble
/// is a wrapper; a broken envelope is a broken envelope, and that still yields
/// silence.
///
/// **One level of double-wrapping is unwrapped, for the same reason.** The model
/// sometimes answers `{"post": {"post": {…}}}` — the example in the
/// instructions shows a `post` key holding an object, and it occasionally
/// supplies both. The offline sweep produced it once in fifteen wakes, and what
/// was thrown away each time was a complete, well-formed post: body, refs, and
/// all. Peeling one layer is finding the envelope, not repairing it; nothing is
/// invented, no field is filled in, and the payload is still parsed strictly.
/// Exactly one layer, deliberately — an unbounded unwrap would start guessing
/// at structure rather than recognizing a known slip.
///
/// **The answer may hold more than one candidate, and the last one wins.** A
/// model that notices its own malformed envelope writes a corrected one after
/// it — verbatim, from a real run: a double-wrapped object, then "Let me fix
/// that JSON:", then the right envelope. Taking the outermost `{…}` span spans
/// both objects *and* the prose between them, which parses as nothing and threw
/// away an answer the model had already corrected. So every balanced top-level
/// object is a candidate and they are tried newest-first: a correction
/// supersedes what it corrects, and picking the last is reading the model's
/// final answer rather than reassembling one.
pub fn parse_envelope(raw: &str) -> Option<ObserverEnvelope> {
    // Newest-first: the model's last word on the matter is its answer.
    for span in json_object_spans(raw.trim()).into_iter().rev() {
        if let Some(envelope) = parse_one_envelope(span) {
            return Some(envelope);
        }
    }
    None
}

/// Parse one candidate span, tolerating a single `{"post": <envelope>}` wrap.
fn parse_one_envelope(span: &str) -> Option<ObserverEnvelope> {
    if let Ok(envelope) = serde_json::from_str::<ObserverEnvelope>(span) {
        return Some(envelope);
    }
    let value: serde_json::Value = serde_json::from_str(span).ok()?;
    let inner = value.as_object()?.get("post")?;
    if !inner.as_object()?.contains_key("post") {
        return None;
    }
    serde_json::from_value::<ObserverEnvelope>(inner.clone()).ok()
}

/// Every balanced top-level `{…}` in `text`, in the order they appear.
///
/// Braces inside string literals do not count, which is what keeps a post whose
/// body quotes JSON — or a Windows path ending in a backslash — from splitting
/// its own envelope in half.
/// The Operator reads its own envelopes with the same scanner: the models are
/// the same models, and they preface, double-wrap, and self-correct the same
/// ways whichever job they are answering.
pub(crate) fn json_object_spans(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = i;
                }
                depth += 1;
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    spans.push(&text[start..=i]);
                }
            }
            _ => {}
        }
    }
    spans
}

/// Outcome of checking a post's refs against what the model was actually shown.
pub struct ValidatedRefs {
    pub kept: Vec<OverviewRef>,
    /// Dropped targets, for the log — a rising drop rate means the wording is
    /// drifting or the buffer is too small, and both are worth seeing.
    pub dropped: Vec<OverviewRef>,
}

/// Keep only the refs whose targets appear verbatim in something the model was
/// shown.
///
/// A ref exists to be clicked. A path or sha the model reconstructed, shortened,
/// or invented points nowhere, and a chip that goes nowhere is worse than an
/// absent one — so it is dropped and the body stands on its own.
///
/// **The corpora are a slice, not one concatenated string** ([P10]). The wake
/// shows the model two surfaces — the activity window and the facts section —
/// and a ref is kept when **any one** of them contains its target. Concatenating
/// first would admit a target that spans the join between two corpora: absurd
/// for a path or a sha, but a free class of false positive to eliminate, and
/// separate corpora also let a caller say which surface a ref came from.
///
/// `Session` refs are exempt: the bridge stamps the session id itself from the
/// wake, so it is ground truth rather than something the model recalled, and it
/// legitimately may not appear in any frame's text.
pub fn validate_refs(refs: Vec<OverviewRef>, corpora: &[&str]) -> ValidatedRefs {
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for r in refs {
        let ok = matches!(r.kind, OverviewRefKind::Session)
            || (!r.target.is_empty() && corpora.iter().any(|c| c.contains(&r.target)));
        if ok {
            kept.push(r);
        } else {
            dropped.push(r);
        }
    }
    ValidatedRefs { kept, dropped }
}

// MARK: - The standing sentence's register

/// The standing sentence's character budget.
///
/// It sits under the callsign on a card-wide row, and it has to say what the
/// whole session is about. Room for a clause and its qualifier is what lets it
/// say that.
///
/// 72, not more: the line's real display room is the rail row and the picker
/// row, both of which cut around 96 characters mid-word — and a sentence that
/// routinely arrives clipped, by this budget's `…` or the row's, reads as a
/// broken line rather than a standing one. The budget is the display's, and
/// the wording asks the model for less than it so the clip is the exception.
pub const MAX_SYNOPSIS_CHARS: usize = 72;

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
/// `normalized` alone means it wrote a sentence with an article or a filler
/// opener in front. A `String` return cannot express any of that, which is why
/// the normalizer reports rather than only returning.
#[derive(Debug, Clone)]
pub struct RegisterReport {
    pub text: String,
    /// The normalizer changed the string at all.
    pub normalized: bool,
    /// The character budget clipped.
    pub clipped: bool,
}

/// Impose the standing sentence's register on whatever the model wrote, and
/// report the work.
///
/// Mechanical only: it removes the forms a model in the wrong register
/// produces, and never rewrites content. Paraphrase would be a second model
/// with none of the first one's context, so the rules stop at quotes, filler
/// openers, articles, whitespace and terminal punctuation, then clip.
///
/// Order is load-bearing. Filler openers go before articles, so
/// `The user is working on the digest strip` reduces in one pass; clipping is
/// last, so a stripped prefix buys back budget instead of wasting it.
///
/// Total: any input, including empty or whitespace-only, yields a string. An
/// empty result is how a wake that answered with nothing usable leaves the
/// standing sentence alone.
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
        text,
    }
}

// MARK: - The prose budget

/// The Observer's body budget, in characters of prose.
///
/// The instructions state the same number, so this clamp is the backstop for a
/// model that ignored them, not the working limit. It is a *prose* budget:
/// tokens that name something exactly — paths, commit shas, session ids — are
/// excluded from the count, so precision is never what the clamp squeezes out.
pub const OBSERVER_PROSE_LIMIT: usize = 200;

/// How far past the budget a sentence already underway may run to finish.
///
/// A model composes tokens; it cannot count the characters it is about to emit,
/// so it cannot land a sentence on a number the way the instructions ask. The
/// budget still shapes the post — it is why these are two short sentences and
/// not a paragraph — but the last sentence routinely closes a little past it,
/// and cutting backward to 200 then throws away a whole finished thought to
/// save forty characters. The grace lets that sentence end.
///
/// It is +20%, not the ten or twenty characters that would look tidier: a
/// Observer sentence runs 60–100 characters of prose, so a fragment in flight
/// at the budget typically needs 30–60 more to close, and a grace too small to
/// close it buys a backward cut anyway. It only ever extends to a **sentence
/// end** — never to more room. Prose that simply runs on is still cut at
/// [`OBSERVER_PROSE_LIMIT`].
///
/// The instructions do not state this number and must not: a limit the model is
/// told about is the limit it composes toward, and a stated 240 would overshoot
/// to 280. The model aims at 200 and this catches where it lands.
pub const OBSERVER_PROSE_GRACE: usize = 240;

/// Characters of prose in `body` — every character except those of tokens that
/// read as exact names rather than prose.
///
/// A token is exempt when it contains a path separator, reads as a commit sha
/// (7+ lowercase hex with at least one digit — the digit requirement keeps
/// ordinary all-hex words like "defaced" countable), reads as a UUID, or reads
/// as a file name (stem.ext, both at least two characters, so "e.g." and
/// "i.e." stay prose). Whitespace counts as prose: the budget measures how much
/// there is to read, and a name is the only thing reading skips.
pub fn prose_len(body: &str) -> usize {
    pieces(body)
        .map(|(piece, is_ws)| {
            if !is_ws && token_is_exempt(piece) {
                0
            } else {
                piece.chars().count()
            }
        })
        .sum()
}

/// `body` unchanged when it is within the prose budget; otherwise cut at the
/// last SENTENCE boundary inside `grace` when there is one, and at the last
/// token boundary inside `limit` — with an ellipsis marking the cut — when
/// there is not.
///
/// The instructions ask for complete sentences that fit the budget, so this is
/// the backstop for a model that ignored them; cutting at a sentence end is the
/// same principle applied to the failure, and it is why a clamped post can end
/// on a period rather than mid-clause. The ellipsis stays on the token-boundary
/// cut, where something really was dropped mid-thought.
///
/// The two budgets are what makes the sentence cut usually available. The walk
/// runs to `grace`, so a sentence that was underway at `limit` and closed
/// shortly after is found and kept whole; a search stopping at `limit` would
/// only ever find sentence ends *before* the overshoot and would drop the last
/// finished thought to reach one. Prose with no sentence end in the grace zone
/// gets no benefit from it: the fallback cut is at `limit`, because the grace
/// exists to finish a sentence, not to hand out more room.
pub fn clamp_post_body(body: &str, limit: usize, grace: usize) -> String {
    if prose_len(body) <= limit {
        return body.to_string();
    }
    // Walk to `grace`, remembering the prefix as it stood at `limit` — that
    // shorter prefix is what the ellipsis fallback cuts back to.
    let mut out = String::new();
    let mut at_limit: Option<usize> = None;
    let mut prose = 0usize;
    for (piece, is_ws) in pieces(body) {
        let cost = if !is_ws && token_is_exempt(piece) {
            0
        } else {
            piece.chars().count()
        };
        if !is_ws && prose + cost > grace {
            break;
        }
        if !is_ws && at_limit.is_none() && prose + cost > limit {
            at_limit = Some(out.len());
        }
        prose += cost;
        out.push_str(piece);
    }
    if let Some(end) = last_sentence_end(&out) {
        return out[..end].trim_end().to_string();
    }
    let trimmed = out[..at_limit.unwrap_or(out.len())].trim_end();
    format!("{trimmed}…")
}

/// Tokens whose trailing `.` ends an abbreviation rather than a sentence.
///
/// A deny-list because the alternative — inferring it from the token's shape —
/// cannot tell `e.g.` from `main.rs.`, and those are exactly the two cases that
/// matter here. `prose_len`'s own exemption rule already names these two
/// explicitly, so this is the same judgment stated in the same place twice.
const ABBREVIATIONS: &[&str] = &["e.g.", "i.e.", "etc.", "cf.", "vs.", "approx."];

/// The byte offset just past the last sentence-ending punctuation in `text`, or
/// `None` when it holds no sentence end.
///
/// A sentence ends at `.`, `!`, or `?` followed by whitespace or the end of the
/// text — so the `.` inside `main.rs` is not one, while the `.` closing
/// `…edited main.rs.` is. An abbreviation's trailing dot is not one either,
/// however well it fits that rule.
fn last_sentence_end(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut found = None;
    for (i, ch) in text.char_indices() {
        if ch != '.' && ch != '!' && ch != '?' {
            continue;
        }
        let after = i + ch.len_utf8();
        let ends_run = after >= bytes.len()
            || text[after..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace);
        if !ends_run {
            continue;
        }
        let start = text[..after]
            .rfind(char::is_whitespace)
            .map_or(0, |ws| ws + 1);
        let token = text[start..after].to_ascii_lowercase();
        if ABBREVIATIONS.contains(&token.as_str()) {
            continue;
        }
        found = Some(after);
    }
    found
}

/// `body` as alternating whitespace / non-whitespace runs, each flagged.
fn pieces(body: &str) -> impl Iterator<Item = (&str, bool)> {
    let mut runs = Vec::new();
    let mut start = 0usize;
    let mut in_ws: Option<bool> = None;
    for (i, ch) in body.char_indices() {
        let ws = ch.is_whitespace();
        match in_ws {
            None => in_ws = Some(ws),
            Some(prev) if prev != ws => {
                runs.push((&body[start..i], prev));
                start = i;
                in_ws = Some(ws);
            }
            Some(_) => {}
        }
    }
    if let Some(ws) = in_ws {
        runs.push((&body[start..], ws));
    }
    runs.into_iter()
}

/// Whether one whitespace-delimited token names something exactly.
fn token_is_exempt(token: &str) -> bool {
    let core = token.trim_matches(|c: char| {
        !(c.is_alphanumeric() || c == '/' || c == '.' || c == '_' || c == '-')
    });
    if core.is_empty() {
        return false;
    }
    if core.contains('/') {
        return true;
    }
    let len = core.chars().count();
    if len >= 7
        && core
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        && core.chars().any(|c| c.is_ascii_digit())
    {
        return true;
    }
    if len == 36
        && core.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
    {
        return true;
    }
    if let Some((stem, ext)) = core.rsplit_once('.') {
        if stem.chars().count() >= 2
            && (2..=6).contains(&ext.chars().count())
            && ext.chars().all(|c| c.is_ascii_alphanumeric())
            && !stem.contains('.')
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // MARK: - The standing sentence's register

    fn register(raw: &str) -> String {
        synopsis_register_report(raw).text
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
        ("Working on the digest strip", "digest strip"),
        ("Trying to fix download resume", "fix download resume"),
        ("Currently hunting focus drift", "hunting focus drift"),
        ("The user is working on the digest strip", "digest strip"),
        (
            "This session is wiring cadence gates",
            "wiring cadence gates",
        ),
        (
            "It looks like a refactor of the ledger",
            "refactor of the ledger",
        ),
        ("The digest strip", "digest strip"),
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
    fn the_normalizer_imposes_the_sentences_register() {
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

    /// The sentence is allowed to be one with two halves. "Rework how a session
    /// names itself **and** adopt it at every surface" is the line doing its
    /// job, and the half past `and` is the half that says how far the work
    /// reaches.
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

    /// Nothing usable in, nothing out — which is what leaves the standing
    /// sentence alone rather than blanking it.
    #[test]
    fn a_synopsis_of_nothing_normalizes_to_nothing() {
        assert!(synopsis_register_report("").text.is_empty());
        assert!(synopsis_register_report("   \n\t ").text.is_empty());
        assert!(synopsis_register_report("\"\"").text.is_empty());
    }

    // MARK: - The prose budget

    #[test]
    fn prose_len_counts_prose_and_exempts_exact_names() {
        // Plain prose counts every character, whitespace included.
        assert_eq!(prose_len("hello there"), 11);
        // A path costs nothing; the words and spaces around it still count.
        assert_eq!(
            prose_len("touched tugdeck/src/main.tsx today"),
            prose_len("touched  today")
        );
        // A sha costs nothing — but only with a digit in it, so ordinary
        // all-hex words stay prose.
        assert_eq!(
            prose_len("commit a1b2c3d4e landed"),
            prose_len("commit  landed")
        );
        assert_eq!(prose_len("defaced facade"), 14);
        // A UUID costs nothing.
        assert_eq!(
            prose_len("session 123e4567-e89b-42d3-a456-426614174000 ended"),
            prose_len("session  ended"),
        );
        // A bare file name costs nothing; "e.g." is prose.
        assert_eq!(
            prose_len("edited main.rs e.g. twice"),
            prose_len("edited  e.g. twice")
        );
        // Punctuation stuck to a name rides along with it.
        assert_eq!(prose_len("(tugdeck/src/main.tsx)."), 0);
    }

    /// `clamp_post_body` under the shipping budgets.
    fn clamp(body: &str) -> String {
        clamp_post_body(body, OBSERVER_PROSE_LIMIT, OBSERVER_PROSE_GRACE)
    }

    #[test]
    fn clamp_post_body_passes_short_bodies_and_cuts_long_ones() {
        let short = "Fixed the flaky test in tugrust/crates/tugcast/src/feeds/observer.rs.";
        assert_eq!(clamp(short), short);

        // A body whose prose is long, and holds no sentence end to fall back
        // to, gets cut at a token boundary — marked, because something really
        // was dropped mid-thought. The grace does not extend this cut: it
        // exists to finish a sentence, and there is no sentence here.
        let long = "word ".repeat(80);
        let clamped = clamp(&long);
        assert!(
            clamped.ends_with("word…"),
            "cut lands between tokens, not inside one"
        );
        assert!(prose_len(&clamped) <= OBSERVER_PROSE_LIMIT + 1);

        // A body long only because of its paths is not cut at all.
        let path_heavy = format!(
            "Retuned the theme tokens in {} and {} to match.",
            "tugdeck/styles/themes/a-very-long-theme-file-name-indeed.css".repeat(2),
            "tugdeck/styles/themes/another-name.css",
        );
        assert_eq!(clamp(&path_heavy), path_heavy);
    }

    #[test]
    fn clamp_post_body_prefers_a_sentence_boundary_and_drops_the_ellipsis() {
        // Two sentences: the first fits the budget, the second runs past both
        // budgets without ending. The cut takes the first whole and ends on
        // its period — no ellipsis, because nothing was left hanging.
        let body = format!("All the tests pass now. {}", "word ".repeat(80));
        let clamped = clamp(&body);
        assert_eq!(clamped, "All the tests pass now.");
        assert!(!clamped.ends_with('…'));
    }

    #[test]
    fn clamp_post_body_lets_a_sentence_underway_at_the_budget_finish() {
        // The shape this is for: two sentences, the second still going at the
        // budget and closing a little past it. Cutting back to the budget
        // would throw the whole second sentence away to save a few dozen
        // characters; the grace keeps it, and the post still ends on a period.
        let second = format!("Then {} closed the loop.", "a fix ".repeat(26));
        let body = format!("The suite is green again. {second}");
        assert!(prose_len(&body) > OBSERVER_PROSE_LIMIT);
        assert!(prose_len(&body) <= OBSERVER_PROSE_GRACE);

        let clamped = clamp(&body);
        assert_eq!(clamped, body.trim_end());
        assert!(!clamped.ends_with('…'));
    }

    #[test]
    fn clamp_post_body_keeps_the_tally_sentence_a_real_post_lost() {
        // A real Observer post, cut mid-clause at "6 skipped;" — the tally is
        // the most useful thing in it and the budget landed inside it. The
        // first sentence ends at ~180 characters of prose, so a cut back to
        // the budget would have kept only that; the grace keeps both.
        let body = "`just ci` is green: refactored shell_fact into a ShellFact struct to clear \
             clippy's too-many-arguments, fixed two let-and-return warnings in session_ledger.rs, \
             and ran cargo fmt. Full suite now 2310 passed, 6 skipped; clippy clean.";
        assert!(prose_len(body) > OBSERVER_PROSE_LIMIT, "over the budget");
        let clamped = clamp(body);
        assert!(
            clamped.ends_with("6 skipped; clippy clean."),
            "the tally sentence closed inside the grace: {clamped}"
        );
    }

    #[test]
    fn clamp_post_body_gives_the_grace_only_to_a_sentence_that_closes_in_it() {
        // A sentence still unfinished at the far edge of the grace gets no
        // benefit from it: the fallback cuts at the budget, not at the grace,
        // so an unclosed thought never buys itself extra room.
        let body = format!("The suite is green again. {}", "word ".repeat(80));
        let clamped = clamp(&body);
        assert_eq!(clamped, "The suite is green again.");

        // Same body with no earlier sentence to fall back to: the ellipsis cut
        // still lands at the budget rather than the grace.
        let runs_on = "word ".repeat(80);
        assert!(prose_len(&clamp(&runs_on)) <= OBSERVER_PROSE_LIMIT + 1);
    }

    #[test]
    fn clamp_post_body_reads_a_trailing_file_name_as_a_sentence_end() {
        // `main.rs.` ends a sentence: the LAST `.` is followed by whitespace,
        // the one inside `main.rs` is not. Nothing may cut inside the name.
        let body = format!("Rewrote the parser in main.rs. {}", "word ".repeat(80));
        assert_eq!(clamp(&body), "Rewrote the parser in main.rs.");
    }

    #[test]
    fn clamp_post_body_does_not_mistake_an_abbreviation_for_a_sentence_end() {
        // Every `.` in the walked prefix belongs to `e.g.` / `i.e.`, so there
        // is no sentence to cut at and the token-boundary behavior with its
        // ellipsis stands.
        let body = format!("Touched a few surfaces e.g. i.e. {}", "word ".repeat(80));
        let clamped = clamp(&body);
        assert!(
            clamped.ends_with('…'),
            "an abbreviation is not a sentence end: {clamped}"
        );
        assert!(prose_len(&clamped) <= OBSERVER_PROSE_LIMIT + 1);
    }

    // MARK: - Composition

    /// A window holding the digest lines a stretch of work produced. The
    /// Observer never sees a payload again, so a composition test that built
    /// one from JSON would be testing a shape nothing produces.
    fn window_of(texts: &[&str]) -> SessionDigest {
        use crate::feeds::session_digest::{DigestKind, DigestLine};
        let mut window = SessionDigest::default();
        for (i, text) in texts.iter().enumerate() {
            window.push(DigestLine {
                text: (*text).to_string(),
                at_ms: 1_700_000_000_000 + i as u64,
                beat: i as u64 + 1,
                kind: DigestKind::Said,
                supersede_key: None,
            });
        }
        window
    }

    #[test]
    fn a_wake_input_carries_its_reason_session_and_prior_posts() {
        let window = window_of(&["Wiring the bridge"]);
        let priors = vec![PriorPost {
            at_ms: 1_700_000_000_000,
            body: "Started on the bridge".to_string(),
        }];
        let input =
            compose_observer_input(WakeReason::SitrepTimer, "s1", &window, &priors, &[], None);

        assert!(input.contains("WAKE REASON: sitrep-timer"));
        assert!(input.contains("SESSION: s1"));
        assert!(
            input.contains("Started on the bridge"),
            "dedup needs the priors"
        );
        assert!(input.contains("Wiring the bridge"));
    }

    /// A first post for a session must say so rather than showing an empty
    /// heading, which reads as "you said nothing" instead of "there is no
    /// history here".
    #[test]
    fn a_first_wake_says_there_are_no_prior_posts() {
        let window = window_of(&["Something happened"]);
        let input = compose_observer_input(WakeReason::TurnEnd, "s1", &window, &[], &[], None);
        assert!(input.contains("(none"));
    }

    /// The Observer revises a sentence it can see. The section sits between
    /// the priors and the facts, carries the sentence verbatim, and says so
    /// in words when nothing stands yet — an empty heading would read as "the
    /// sentence is blank" rather than "there is none to keep".
    #[test]
    fn the_standing_sentence_rides_the_input_between_the_priors_and_the_facts() {
        let window = window_of(&["Reading the resume path"]);
        let input = compose_observer_input(
            WakeReason::SitrepTimer,
            "s1",
            &window,
            &[],
            &[],
            Some("Rework how a session names itself"),
        );
        let section = format!("{STANDING_SENTENCE_HEADER}\nRework how a session names itself\n");
        assert!(input.contains(&section), "{input}");
        let priors_at = input
            .find("YOUR RECENT POSTS ABOUT THIS SESSION:")
            .expect("priors");
        let standing_at = input.find(STANDING_SENTENCE_HEADER).expect("standing");
        let facts_at = input.find(FACTS_SECTION_HEADER).expect("facts");
        assert!(priors_at < standing_at && standing_at < facts_at);

        for absent in [None, Some(""), Some("   ")] {
            let input =
                compose_observer_input(WakeReason::TurnEnd, "s1", &window, &[], &[], absent);
            assert!(
                input.contains(&format!(
                    "{STANDING_SENTENCE_HEADER}\n{STANDING_SENTENCE_NONE}\n"
                )),
                "{absent:?} should read as no sentence",
            );
        }
    }

    fn fact(at_ms: i64, text: &str) -> FactLine {
        FactLine {
            at_ms,
            text: text.to_string(),
        }
    }

    #[test]
    fn the_facts_section_renders_between_the_priors_and_the_activity() {
        let window = window_of(&["Ran the suite"]);
        let facts = vec![
            fact(1_700_000_000_000, "$ cargo nextest run -p tugcast → ok"),
            fact(
                1_700_000_001_000,
                "tests: cargo nextest — passed (1574 passed, 0 failed)",
            ),
        ];
        let input = compose_observer_input(WakeReason::TurnEnd, "s1", &window, &[], &facts, None);

        assert!(input.contains(FACTS_SECTION_HEADER));
        assert!(input.contains("- [1700000000000] $ cargo nextest run -p tugcast → ok"));
        assert!(input.contains("1574 passed"));
        // Order matters: the facts are what settled, the activity is what the
        // wire carried, and the model reads them in that order.
        let facts_at = input.find(FACTS_SECTION_HEADER).expect("facts section");
        let priors_at = input
            .find("YOUR RECENT POSTS ABOUT THIS SESSION:")
            .expect("priors section");
        let activity_at = input
            .find("SESSION ACTIVITY SINCE THEN:")
            .expect("activity section");
        assert!(priors_at < facts_at && facts_at < activity_at);
    }

    /// An empty section says so. A bare heading over nothing reads as a facts
    /// base that failed rather than one with nothing new in it.
    #[test]
    fn an_empty_facts_section_says_none() {
        let rendered = render_facts_section(&[]);
        assert!(rendered.starts_with(FACTS_SECTION_HEADER));
        assert!(rendered.contains("(none)"));
        assert!(!rendered.contains(FACTS_ELISION_MARKER));
    }

    #[test]
    fn the_facts_section_keeps_the_newest_and_marks_what_it_dropped() {
        let facts: Vec<FactLine> = (0..FACTS_SECTION_MAX as i64 + 5)
            .map(|i| fact(1_000 + i, &format!("fact number {i}")))
            .collect();
        let rendered = render_facts_section(&facts);
        assert!(rendered.contains(FACTS_ELISION_MARKER));
        assert_eq!(
            rendered.lines().filter(|l| l.starts_with("- [")).count(),
            FACTS_SECTION_MAX
        );
        // The newest survive — a post is about the end of a stretch, not its
        // beginning.
        assert!(rendered.contains(&format!("fact number {}", FACTS_SECTION_MAX + 4)));
        assert!(!rendered.contains("fact number 0]"));
    }

    #[test]
    fn one_enormous_fact_cannot_displace_the_window_below_it() {
        let facts = vec![
            fact(1_000, &"a".repeat(FACTS_SECTION_MAX_BYTES)),
            fact(2_000, &"b".repeat(FACTS_SECTION_MAX_BYTES)),
        ];
        let rendered = render_facts_section(&facts);
        assert!(rendered.len() < FACTS_SECTION_MAX_BYTES * 2);
        assert!(rendered.contains(FACTS_ELISION_MARKER));
        // A single fact over the ceiling still renders: something is better than
        // a section that silently held nothing.
        let one = render_facts_section(&[fact(1_000, &"a".repeat(FACTS_SECTION_MAX_BYTES * 2))]);
        assert!(one.contains("- [1000]"));
        assert!(!one.contains(FACTS_ELISION_MARKER));
    }

    #[test]
    fn every_wake_reason_has_a_stable_wire_spelling() {
        assert_eq!(WakeReason::TurnEnd.as_str(), "turn-end");
        assert_eq!(WakeReason::SitrepTimer.as_str(), "sitrep-timer");
        assert_eq!(WakeReason::SessionEnd.as_str(), "session-end");
        assert_eq!(WakeReason::TokenThreshold.as_str(), "token-threshold");
    }

    // MARK: - The envelope

    #[test]
    fn an_explicit_null_post_is_a_real_answer() {
        let parsed = parse_envelope(r#"{"post": null}"#).expect("parses");
        assert!(parsed.post.is_none());
        // Whitespace around the JSON is normal model output.
        assert!(parse_envelope("  {\"post\": null}\n").is_some());
    }

    #[test]
    fn a_post_parses_with_its_refs() {
        let parsed = parse_envelope(
            r#"{"post": {"body": "Landed it", "refs": [{"kind": "commit", "target": "abc1234"}]}}"#,
        )
        .expect("parses");
        let post = parsed.post.expect("a post");
        assert_eq!(post.body, "Landed it");
        assert_eq!(post.refs.len(), 1);
        assert_eq!(post.refs[0].kind, OverviewRefKind::Commit);

        // refs may be omitted entirely.
        let bare = parse_envelope(r#"{"post": {"body": "Just prose"}}"#).expect("parses");
        assert!(bare.post.expect("a post").refs.is_empty());
    }

    /// One ask, two answers, and each of the four combinations is a real one.
    /// The pair is independent by design ([P08]): a wake may post and not
    /// revise the sentence, or revise it and not post.
    #[test]
    fn both_fields_are_read_and_either_may_be_absent() {
        let both = parse_envelope(
            r#"{"post": {"body": "Landed it"}, "synopsis": "Consolidate the narration producers"}"#,
        )
        .expect("parses");
        assert_eq!(both.post.expect("a post").body, "Landed it");
        assert_eq!(
            both.synopsis.as_deref(),
            Some("Consolidate the narration producers")
        );

        let sentence_only = parse_envelope(r#"{"post": null, "synopsis": "Chase the parser bug"}"#)
            .expect("parses");
        assert!(sentence_only.post.is_none());
        assert_eq!(
            sentence_only.synopsis.as_deref(),
            Some("Chase the parser bug")
        );

        let post_only =
            parse_envelope(r#"{"post": {"body": "Landed it"}, "synopsis": null}"#).expect("parses");
        assert!(post_only.post.is_some());
        assert!(post_only.synopsis.is_none());

        let neither = parse_envelope(r#"{"post": null, "synopsis": null}"#).expect("parses");
        assert!(neither.post.is_none());
        assert!(neither.synopsis.is_none());

        // An answer that says nothing about the sentence at all is the same as
        // one that says null, so the older shape still parses.
        let omitted = parse_envelope(r#"{"post": null}"#).expect("parses");
        assert!(omitted.synopsis.is_none());
    }

    /// Every malformed shape posts nothing. Silence is the safe failure mode;
    /// a salvaged half-post would put words in the channel nobody wrote.
    #[test]
    fn every_malformed_envelope_posts_nothing() {
        for raw in [
            "I think the session is going well.",
            r#"{"post": {"body": "no closing brace""#,
            r#"{"post": {}}"#,                               // body is required
            r#"{"post": {"body": "x", "urgency": "high"}}"#, // unknown field
            r#"{"posts": null}"#,                            // wrong key
            r#"{"post": null, "summary": "x"}"#,             // unknown field beside a known one
            r#"{"post": {"body": "x", "refs": [{"kind": "wiki", "target": "y"}]}}"#, // unknown kind
            "",
        ] {
            assert!(
                parse_envelope(raw).is_none(),
                "should have posted nothing: {raw:?}",
            );
        }
    }

    /// The wrapping a model actually puts around its answer does not cost the
    /// post. Every shape here was observed in the offline replay, where a run
    /// reported 22 of 52 wakes as unparseable and every one of them held a
    /// complete envelope behind a sentence of preamble.
    #[test]
    fn an_envelope_wrapped_in_prose_or_a_fence_still_posts() {
        for raw in [
            "```json\n{\"post\": null}\n```",
            "Worth flagging, so:\n\n{\"post\": {\"body\": \"Vendored the light faces.\"}}",
            "{\"post\": {\"body\": \"x\"}}\n\nThat's the update.",
        ] {
            assert!(
                parse_envelope(raw).is_some(),
                "a wrapper is not a broken envelope: {raw:?}",
            );
        }
    }

    /// A post wrapped in a second `post` key is still that post. Observed once
    /// in fifteen wakes on a real session; the body and both refs were intact
    /// inside, and the whole thing was being discarded.
    #[test]
    fn a_double_wrapped_post_is_still_the_models_own_post() {
        let raw = r#"{"post": {"post": {"body": "Committed the fix.",
            "refs": [{"kind": "commit", "target": "e6a7de7b5"}]}}}"#;
        let post = parse_envelope(raw)
            .expect("one layer of double-wrapping is a known slip, not a broken envelope")
            .post
            .expect("the post survives the unwrap");
        assert_eq!(post.body, "Committed the fix.");
        assert_eq!(post.refs.len(), 1, "refs ride through the unwrap");

        // Strictness is not relaxed by the unwrap: the inner envelope is parsed
        // by the same rules, so a bad post nested twice is still no post.
        assert!(
            parse_envelope(r#"{"post": {"post": {"urgency": "high"}}}"#).is_none(),
            "the unwrap finds an envelope; it does not repair one",
        );
        // And unwrapping stops at one layer rather than hunting for structure.
        assert!(
            parse_envelope(r#"{"post": {"post": {"post": {"body": "x"}}}}"#).is_none(),
            "exactly one layer, deliberately",
        );
    }

    /// A model that catches its own bad envelope and rewrites it is answered
    /// by the rewrite. Verbatim from a real run — the double-wrap, the
    /// admission, then the correct envelope. Reading the outermost `{…}` span
    /// swallowed all three and posted nothing.
    #[test]
    fn a_self_corrected_envelope_is_read_as_corrected() {
        let raw = concat!(
            r#"{"post": {"post": {"body": "wrapped twice", "refs": []}}}"#,
            "\n\nLet me fix that JSON:\n\n",
            r#"{"post": {"body": "the corrected post", "refs": []}}"#,
        );
        let post = parse_envelope(raw)
            .expect("a correction is an answer, not a broken envelope")
            .post
            .expect("the corrected post survives");
        assert_eq!(
            post.body, "the corrected post",
            "the later envelope supersedes the one it corrects",
        );
    }

    /// A body that quotes JSON must not split its own envelope: the scanner
    /// counts braces, so it has to know when it is inside a string.
    #[test]
    fn braces_inside_a_body_do_not_end_the_envelope() {
        let raw = r#"{"post": {"body": "the model answered {\"post\": null} and stopped"}}"#;
        let post = parse_envelope(raw)
            .expect("a quoted brace is text, not structure")
            .post
            .expect("the post survives");
        assert!(post.body.contains(r#"{"post": null}"#));
    }

    // MARK: - Ref validation

    #[test]
    fn refs_the_model_was_never_shown_are_dropped() {
        let context = r#"{"type":"tool_use","command":"git show 4fe4d3fcd"}
{"type":"tool_result","output":"tugdeck/styles/themes/brio.css | 3 +-"}"#;
        let result = validate_refs(
            vec![
                OverviewRef {
                    kind: OverviewRefKind::Commit,
                    target: "4fe4d3fcd".to_string(),
                },
                OverviewRef {
                    kind: OverviewRefKind::File,
                    target: "tugdeck/styles/themes/brio.css".to_string(),
                },
                // Plausible, never shown — exactly the shape that would make a
                // dead chip.
                OverviewRef {
                    kind: OverviewRefKind::File,
                    target: "tugdeck/styles/themes/nocturne.css".to_string(),
                },
                // A shortened sha cannot be matched, so it cannot be linked.
                OverviewRef {
                    kind: OverviewRefKind::Commit,
                    target: "4fe4d3fcdaaaa".to_string(),
                },
            ],
            &[context],
        );
        assert_eq!(result.kept.len(), 2);
        assert_eq!(result.dropped.len(), 2);
        assert!(result.kept.iter().all(|r| context.contains(&r.target)));
    }

    /// The bridge stamps the session itself, so that ref is ground truth and
    /// need not appear in any frame's text.
    #[test]
    fn session_refs_are_exempt_from_the_verbatim_check() {
        let result = validate_refs(
            vec![OverviewRef {
                kind: OverviewRefKind::Session,
                target: "a-session-id-in-no-frame".to_string(),
            }],
            &["frames that never name the session"],
        );
        assert_eq!(result.kept.len(), 1);
        assert!(result.dropped.is_empty());
    }

    #[test]
    fn an_empty_target_is_dropped() {
        let result = validate_refs(
            vec![OverviewRef {
                kind: OverviewRefKind::File,
                target: String::new(),
            }],
            &["anything"],
        );
        assert!(result.kept.is_empty());
    }

    /// [P10]: a sha the frame window never carried but a `commit` fact did is
    /// still provable, and this is the whole reason the corpora are a slice.
    #[test]
    fn a_target_present_only_in_the_facts_section_validates() {
        let window = r#"{"type":"assistant_text","text":"landed the change"}"#;
        let facts_section = render_facts_section(&[fact(
            1_000,
            "commit 03fcaa08712a \"private sessions\" — 14 file(s)",
        )]);
        let result = validate_refs(
            vec![
                OverviewRef {
                    kind: OverviewRefKind::Commit,
                    target: "03fcaa08712a".to_string(),
                },
                // In neither corpus: still dropped. The facts section widens
                // what can be proved, it does not stop refs being checked.
                OverviewRef {
                    kind: OverviewRefKind::Commit,
                    target: "deadbeefcafe".to_string(),
                },
            ],
            &[window, &facts_section],
        );
        assert_eq!(result.kept.len(), 1);
        assert_eq!(result.kept[0].target, "03fcaa08712a");
        assert_eq!(result.dropped.len(), 1);
    }

    /// The corpora are separate for a reason: a target that exists only by
    /// spanning the boundary between two of them was never shown to anybody.
    #[test]
    fn a_target_spanning_two_corpora_is_not_a_match() {
        let result = validate_refs(
            vec![OverviewRef {
                kind: OverviewRefKind::File,
                target: "tugdeck/styles".to_string(),
            }],
            &["...tugdeck/", "styles/themes/brio.css..."],
        );
        assert!(result.kept.is_empty(), "a concatenation would have kept it");
    }

    /// The end-to-end shape the bridge runs: parse what the model said, then
    /// keep only what it can prove.
    #[test]
    fn parse_then_validate_is_the_whole_post_path() {
        let window = window_of(&["Bash → HEAD is now 9a9051001"]);
        let raw = r#"{"post": {"body": "A commit landed.", "refs": [
            {"kind": "commit", "target": "9a9051001"},
            {"kind": "commit", "target": "deadbeef"}
        ]}}"#;
        let envelope = parse_envelope(raw).expect("parses");
        let post = envelope.post.expect("a post");
        let validated = validate_refs(post.refs, &[&window.rendered()]);
        assert_eq!(validated.kept.len(), 1);
        assert_eq!(validated.kept[0].target, "9a9051001");
        assert_eq!(validated.dropped.len(), 1);
    }
}

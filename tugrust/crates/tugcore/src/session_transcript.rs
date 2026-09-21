//! Reading a claude transcript back as turns.
//!
//! The one place in Tug that knows the shape of claude code's JSONL well
//! enough to *render* it. `tugtool session show` is its only consumer, and
//! the point of the module is that a model asked to read a session gets a
//! stable face — a header and numbered turns — rather than a path to a file
//! whose record shape is nobody's contract.
//!
//! It deliberately does not reuse tugcast's `external_sessions` engine:
//! that engine cannot be linked from tugtool (tugcast is a binary crate),
//! and it is built to *count* a transcript rather than show one.
//!
//! **Tolerant throughout.** A line that does not parse is skipped, a record
//! whose shape is unfamiliar contributes nothing, and a truncated file
//! renders as the turns it did hold. A transcript is written by another
//! program, concurrently, and refusing to read one because its last line is
//! half-written would be the wrong answer to a file that is simply live.
//!
//! **Read-only, always.** Nothing here opens a file for writing, and that is
//! load-bearing: `show` reads sessions belonging to other instances, and two
//! writers on one transcript is the failure the whole reach design rules out.

use std::path::Path;

/// One turn: the user's words and what the assistant said back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    /// 1-based, counted over the whole transcript before any filtering — so
    /// `--turn 12` means the same thing whatever else is on screen.
    pub number: usize,
    pub user: String,
    /// The assistant's rendered lines: its prose, and one `→ Tool(…)` line
    /// per tool call.
    pub assistant: Vec<String>,
}

impl Turn {
    /// Everything this turn renders as, for a substring search.
    fn searchable(&self) -> String {
        let mut text = self.user.clone();
        for line in &self.assistant {
            text.push('\n');
            text.push_str(line);
        }
        text
    }
}

/// A transcript read back.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Transcript {
    pub turns: Vec<Turn>,
    /// The `timestamp` of the last record that carried one, verbatim.
    pub last_timestamp: Option<String>,
}

/// Markers whose text block is Tug's own machinery rather than the user's
/// words, and is dropped from a rendered user turn.
///
/// Both are blocks the deck writes and the deck's own synthesizer swallows
/// on replay; a reader of the raw JSONL has to know them, which is why they
/// are named here and in `tugplug/session-references.md`.
const SWALLOWED_MARKERS: &[&str] = &["<!-- tug:session-refs -->", "<!-- tug:compact-seed -->"];

/// The keys a tool call's one-line summary is taken from, in order. The
/// first one present wins; a tool whose input has none renders bare.
const TOOL_SUMMARY_KEYS: &[&str] = &["file_path", "command", "pattern", "description", "prompt"];

/// How much of a tool input a summary line shows.
const TOOL_SUMMARY_LEN: usize = 80;

/// Read a transcript's turns. A missing or unreadable file is an empty
/// transcript rather than an error — `show` has already said whether the
/// file is on disk, and a second failure mode here would say it twice.
pub fn read(path: &Path) -> Transcript {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Transcript::default();
    };
    read_str(&text)
}

/// The same, over bytes already in hand. This is what the tests drive.
pub fn read_str(text: &str) -> Transcript {
    let mut out = Transcript::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // A sidechain is a subagent's own conversation. It is not this
        // session's turns, and interleaving it would put another agent's
        // words in the user's mouth.
        if record.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        if let Some(stamp) = record.get("timestamp").and_then(|v| v.as_str()) {
            out.last_timestamp = Some(stamp.to_owned());
        }
        match record.get("type").and_then(|v| v.as_str()) {
            Some("user") => absorb_user(&mut out, &record),
            Some("assistant") => absorb_assistant(&mut out, &record),
            _ => {}
        }
    }
    out
}

/// A user record either **opens** a turn or continues one.
///
/// It opens one when it is a genuine submission: a real `type: "user"`
/// record, not one of claude's own meta or compact-summary records, and
/// carrying actual words. A record whose content is only `tool_result`
/// blocks is the transport for a tool's answer, not a thing the user said,
/// so it continues the turn already open — otherwise a turn with six tool
/// calls would render as seven turns, none of which the user wrote.
fn absorb_user(out: &mut Transcript, record: &serde_json::Value) {
    if record.get("isMeta").and_then(|v| v.as_bool()) == Some(true)
        || record.get("isCompactSummary").and_then(|v| v.as_bool()) == Some(true)
    {
        return;
    }
    let Some(content) = record.get("message").and_then(|m| m.get("content")) else {
        return;
    };
    let text = match content {
        serde_json::Value::String(s) => {
            let kept = keep_user_text(s);
            if kept.is_empty() {
                return;
            }
            kept
        }
        serde_json::Value::Array(blocks) => {
            let mut parts: Vec<String> = Vec::new();
            let mut saw_text_block = false;
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) != Some("text") {
                    continue;
                }
                saw_text_block = true;
                let raw = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let kept = keep_user_text(raw);
                if !kept.is_empty() {
                    parts.push(kept);
                }
            }
            // No text block at all: a tool-result carrier, which continues
            // the open turn rather than starting one.
            if !saw_text_block {
                return;
            }
            parts.join("\n\n")
        }
        _ => return,
    };
    let number = out.turns.len() + 1;
    out.turns.push(Turn {
        number,
        user: text,
        assistant: Vec::new(),
    });
}

/// A user text block, or `""` when it is one of Tug's own swallowed blocks.
fn keep_user_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if SWALLOWED_MARKERS
        .iter()
        .any(|marker| trimmed.starts_with(marker))
    {
        return String::new();
    }
    trimmed.to_owned()
}

/// An assistant record's prose and tool calls, appended to the open turn.
///
/// `thinking` is omitted — it is the model's scratch, not the conversation —
/// and so is a `tool_result`'s content, which is a tool's output and can run
/// to megabytes. An assistant record arriving before any user turn (a
/// transcript whose head was truncated) is dropped: there is nowhere honest
/// to put it.
fn absorb_assistant(out: &mut Transcript, record: &serde_json::Value) {
    let Some(turn) = out.turns.last_mut() else {
        return;
    };
    let Some(blocks) = record
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return;
    };
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .trim();
                if !text.is_empty() {
                    turn.assistant.push(text.to_owned());
                }
            }
            Some("tool_use") => turn.assistant.push(tool_line(block)),
            _ => {}
        }
    }
}

/// One tool call as one line: the tool's name and the most identifying
/// thing in its input. The keys are tried in a fixed order so the same call
/// always summarizes the same way.
fn tool_line(block: &serde_json::Value) -> String {
    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
    let summary = block.get("input").and_then(|input| {
        TOOL_SUMMARY_KEYS
            .iter()
            .find_map(|key| input.get(*key).and_then(|v| v.as_str()))
    });
    match summary {
        Some(raw) => format!("→ {name}({})", truncate(raw.trim(), TOOL_SUMMARY_LEN)),
        None => format!("→ {name}()"),
    }
}

/// Truncate on a char boundary, with an ellipsis when anything was cut. The
/// count is characters rather than bytes, so a summary full of em dashes is
/// not cut to a third of the width.
fn truncate(raw: &str, max: usize) -> String {
    let flattened: String = raw
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if flattened.chars().count() <= max {
        return flattened;
    }
    let kept: String = flattened.chars().take(max).collect();
    format!("{kept}…")
}

/// How many turns an unfiltered `show` prints before it starts abridging.
pub const DEFAULT_TURN_CAP: usize = 40;

/// Apply a filter, returning the kept turns and — when an unfiltered read
/// was abridged — the total it was abridged from.
///
/// The order is **grep, then last**, because the other way round would
/// search only the tail and silently answer "no matches" about a transcript
/// that has them.
pub fn select<'a>(
    turns: &'a [Turn],
    turn: Option<usize>,
    last: Option<usize>,
    grep: Option<&str>,
) -> (Vec<&'a Turn>, Option<usize>) {
    if let Some(k) = turn {
        return (turns.iter().filter(|t| t.number == k).collect(), None);
    }
    let needle = grep.map(|g| g.to_lowercase());
    let matched: Vec<&Turn> = match &needle {
        Some(needle) => turns
            .iter()
            .filter(|t| t.searchable().to_lowercase().contains(needle))
            .collect(),
        None => turns.iter().collect(),
    };
    if let Some(n) = last {
        let start = matched.len().saturating_sub(n);
        return (matched[start..].to_vec(), None);
    }
    // The cap applies only to a read nobody narrowed: a `--grep` that
    // matches sixty turns asked for those sixty.
    if needle.is_none() && matched.len() > DEFAULT_TURN_CAP {
        let total = matched.len();
        let start = total - DEFAULT_TURN_CAP;
        return (matched[start..].to_vec(), Some(total));
    }
    (matched, None)
}

/// Render turns in the shape [Spec S05] prints.
pub fn render(turns: &[&Turn]) -> String {
    let mut out = String::new();
    for turn in turns {
        out.push_str(&format!("## Turn {} — user\n", turn.number));
        out.push_str(&turn.user);
        out.push_str("\n\n");
        if turn.assistant.is_empty() {
            continue;
        }
        out.push_str(&format!("## Turn {} — assistant\n", turn.number));
        for line in &turn.assistant {
            out.push_str(line);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> String {
        serde_json::json!({
            "type": "user",
            "timestamp": "2026-09-21T10:00:00.000Z",
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    fn user_blocks(blocks: serde_json::Value) -> String {
        serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": blocks },
        })
        .to_string()
    }

    fn assistant(blocks: serde_json::Value) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-09-21T10:01:00.000Z",
            "message": { "role": "assistant", "content": blocks },
        })
        .to_string()
    }

    #[test]
    fn a_transcript_reads_back_as_turns() {
        let jsonl = [
            user("first question"),
            assistant(serde_json::json!([
                { "type": "thinking", "thinking": "not the conversation" },
                { "type": "text", "text": "first answer" },
                { "type": "tool_use", "name": "Read", "input": { "file_path": "/u/src/tug/a.rs" } },
            ])),
            user("second question"),
            assistant(serde_json::json!([{ "type": "text", "text": "second answer" }])),
        ]
        .join("\n");

        let t = read_str(&jsonl);
        assert_eq!(t.turns.len(), 2);
        assert_eq!(t.turns[0].number, 1);
        assert_eq!(t.turns[0].user, "first question");
        assert_eq!(
            t.turns[0].assistant,
            vec!["first answer", "→ Read(/u/src/tug/a.rs)"],
            "thinking is omitted and a tool call is one line"
        );
        assert_eq!(t.turns[1].user, "second question");
        assert_eq!(
            t.last_timestamp.as_deref(),
            Some("2026-09-21T10:01:00.000Z")
        );
    }

    #[test]
    fn a_tool_result_carrier_continues_the_turn_rather_than_opening_one() {
        let jsonl = [
            user("do the thing"),
            assistant(serde_json::json!([
                { "type": "tool_use", "name": "Bash", "input": { "command": "ls" } },
            ])),
            user_blocks(serde_json::json!([
                { "type": "tool_result", "content": "a\nb\nc" },
            ])),
            assistant(serde_json::json!([{ "type": "text", "text": "done" }])),
        ]
        .join("\n");

        let t = read_str(&jsonl);
        assert_eq!(t.turns.len(), 1, "one thing the user said, one turn");
        assert_eq!(t.turns[0].assistant, vec!["→ Bash(ls)", "done"]);
    }

    #[test]
    fn tug_own_blocks_and_claudes_meta_records_are_swallowed() {
        let jsonl = [
            serde_json::json!({
                "type": "user",
                "isMeta": true,
                "message": { "role": "user", "content": "a caveat claude wrote" },
            })
            .to_string(),
            serde_json::json!({
                "type": "user",
                "isCompactSummary": true,
                "message": { "role": "user", "content": "the summary" },
            })
            .to_string(),
            user_blocks(serde_json::json!([
                { "type": "text", "text": "what I actually asked" },
                { "type": "text", "text": "<!-- tug:session-refs -->\nSession references in this message:\n- @session:tug/curly-apple" },
            ])),
            serde_json::json!({
                "type": "assistant",
                "isSidechain": true,
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "a subagent" }] },
            })
            .to_string(),
        ]
        .join("\n");

        let t = read_str(&jsonl);
        assert_eq!(t.turns.len(), 1);
        assert_eq!(t.turns[0].user, "what I actually asked");
        assert!(
            t.turns[0].assistant.is_empty(),
            "a sidechain is another agent's conversation"
        );
    }

    #[test]
    fn an_unparseable_line_is_skipped_rather_than_fatal() {
        let jsonl = [
            user("one"),
            "{not json at all".to_string(),
            String::new(),
            user("two"),
        ]
        .join("\n");
        assert_eq!(read_str(&jsonl).turns.len(), 2);
    }

    #[test]
    fn a_tool_summary_takes_the_first_key_it_finds_and_truncates() {
        let long = "x".repeat(200);
        let block = serde_json::json!({
            "type": "tool_use",
            "name": "Grep",
            "input": { "pattern": long, "description": "never reached" },
        });
        let line = tool_line(&block);
        assert!(line.starts_with("→ Grep(x"));
        assert!(line.ends_with("…)"), "{line}");
        assert_eq!(line.chars().count(), "→ Grep(".chars().count() + 80 + 2);

        let bare = serde_json::json!({ "type": "tool_use", "name": "TodoWrite", "input": {} });
        assert_eq!(tool_line(&bare), "→ TodoWrite()");
    }

    fn turns(n: usize) -> Vec<Turn> {
        (1..=n)
            .map(|number| Turn {
                number,
                user: format!("question {number}"),
                assistant: vec![format!("answer {number}")],
            })
            .collect()
    }

    #[test]
    fn a_filter_narrows_and_an_unnarrowed_read_abridges() {
        let all = turns(50);

        let (kept, total) = select(&all, None, None, None);
        assert_eq!(kept.len(), DEFAULT_TURN_CAP);
        assert_eq!(kept[0].number, 11, "the last forty");
        assert_eq!(total, Some(50), "and it says what it abridged from");

        let (kept, total) = select(&all, None, Some(2), None);
        assert_eq!(
            kept.iter().map(|t| t.number).collect::<Vec<_>>(),
            vec![49, 50]
        );
        assert_eq!(total, None);

        let (kept, _) = select(&all, Some(7), None, None);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].number, 7);

        // Grep is case-insensitive, searches the assistant's lines too, and
        // is never capped — a grep that matches sixty turns asked for sixty.
        let (kept, total) = select(&all, None, None, Some("ANSWER 4"));
        assert_eq!(
            kept.iter().map(|t| t.number).collect::<Vec<_>>(),
            vec![4, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]
        );
        assert_eq!(total, None);

        // The filters compose grep-first, so `last` takes the tail of the
        // matches rather than searching only the tail.
        let (kept, _) = select(&all, None, Some(2), Some("question 1"));
        assert_eq!(
            kept.iter().map(|t| t.number).collect::<Vec<_>>(),
            vec![18, 19]
        );
    }

    #[test]
    fn rendering_numbers_turns_over_the_whole_transcript() {
        let all = turns(3);
        let (kept, _) = select(&all, Some(2), None, None);
        assert_eq!(
            render(&kept),
            "## Turn 2 — user\nquestion 2\n\n## Turn 2 — assistant\nanswer 2\n\n"
        );
    }
}

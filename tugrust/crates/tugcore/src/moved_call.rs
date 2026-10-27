//! The sentence Claude Code answers a Bash call with when it moves the call
//! to the background instead of ending it, read for the task it became.
//!
//! A foreground call that outlives its `timeout` is not killed: the harness
//! moves it to a background task and answers the call's `tool_result` with
//! the output so far and a sentence naming the task id and the file its
//! output is going to. The same shape answers a call moved to let a queued
//! message reach the model, one moved by a subagent's cap, and one the user
//! backgrounded by hand. Every reader of that wire that wants to know a
//! call became a job reads it here — tugcast at its fold, and the stream-json
//! drift regression, which hands the live capture's sentence to this reader
//! so a wording change in a future release surfaces as a red rather than as
//! a silent return to the dark card.
//!
//! The match is on shape, not wording: the id in `(ID: <id>)` after the
//! words that say the call moved, and the path after `Output is being
//! written to:`. The prose around them has changed before and may again.
//! What the match does hold to is where the harness puts the sentence: on a
//! line of its own that begins `Command `, with a plain id. A command whose
//! output merely *quotes* the sentence — a grep over a log, a test fixture
//! printed — is not a move, and reading it as one opened a job nothing ends.

/// What a moved call's `tool_result` says the call became.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovedCall {
    /// The background task's id, the key its `task_started`,
    /// `task_updated` and `task_notification` carry.
    pub task_id: String,
    /// The file the command's output is being written to.
    pub output_path: String,
}

/// The id after the words that say a call was moved: the harness's own
/// move, in every reason it gives, ends in `(ID: <id>)`.
const MOVED_ID_MARK: &str = "moved to the background (ID: ";
/// The id after a move the user made by hand, which the harness words
/// differently and ends with a period rather than a parenthesis.
const USER_ID_MARK: &str = "backgrounded by user with ID: ";
const OUTPUT_MARK: &str = "Output is being written to: ";

/// Read a moved call off a `tool_result`'s text, or `None` when the text is
/// an ordinary result — the command's output, an error, a timeout kill.
///
/// The sentence is not anchored at the start of the text: the output the
/// command produced before the move precedes it. It is anchored at the start
/// of its line, which begins `Command `.
pub fn parse_moved_call(text: &str) -> Option<MovedCall> {
    text.lines()
        .rev()
        .filter(|line| line.starts_with(SENTENCE_START))
        .find_map(parse_sentence)
}

/// Every move the harness words begins its line this way.
const SENTENCE_START: &str = "Command ";

fn parse_sentence(text: &str) -> Option<MovedCall> {
    let task_id = id_after(text, MOVED_ID_MARK, |c| c == ')')
        .or_else(|| id_after(text, USER_ID_MARK, |c| c == '.' || c.is_whitespace()))?;
    let output_start = text.find(OUTPUT_MARK)? + OUTPUT_MARK.len();
    let output = text[output_start..]
        .split_whitespace()
        .next()?
        .trim_end_matches('.');
    if output.is_empty() {
        return None;
    }
    Some(MovedCall {
        task_id,
        output_path: output.to_owned(),
    })
}

/// The token after `mark`, up to the first character `ends` admits; `None`
/// when the mark is absent, nothing follows it, or the token is not a plain
/// id (letters, digits, `_`, `-`) — a placeholder like `<id>` is not one.
fn id_after(text: &str, mark: &str, ends: impl Fn(char) -> bool) -> Option<String> {
    let start = text.find(mark)? + mark.len();
    let rest = &text[start..];
    let end = rest.find(|c: char| ends(c) || c.is_whitespace())?;
    let id = &rest[..end];
    let plain = !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    plain.then(|| id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT_MOVE: &str = "MOVE_START\nCommand did not complete within its 3s timeout and was moved to the background (ID: bbr5s08js). Output is being written to: /private/tmp/claude-501/-private-tmp/6204b0e4/tasks/bbr5s08js.output. You will be notified when it completes. If it is still running after 10m in the background, it will be stopped and you will be notified. It is running now: do not start a second copy while it runs. If it is no longer needed, stop it with TaskStop. To check interim output, use Read on that file path.";

    #[test]
    fn the_timeout_move_names_its_task_and_output_file_past_the_output_so_far() {
        assert_eq!(
            parse_moved_call(TIMEOUT_MOVE),
            Some(MovedCall {
                task_id: "bbr5s08js".into(),
                output_path: "/private/tmp/claude-501/-private-tmp/6204b0e4/tasks/bbr5s08js.output"
                    .into(),
            })
        );
    }

    #[test]
    fn every_reason_the_harness_moves_a_call_shares_the_shape() {
        let cap = "Command was moved to the background (ID: b1) after running for 5s. Output is being written to: /t/b1.output. You will be notified when it completes.";
        let message = "Command was moved to the background (ID: b2) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: /t/b2.output.";
        let by_hand = "Command was manually backgrounded by user with ID: b3. Output is being written to: /t/b3.output.";
        for (text, id, path) in [
            (cap, "b1", "/t/b1.output"),
            (message, "b2", "/t/b2.output"),
            (by_hand, "b3", "/t/b3.output"),
        ] {
            let moved =
                parse_moved_call(text).unwrap_or_else(|| panic!("no move read in {text:?}"));
            assert_eq!(
                (moved.task_id.as_str(), moved.output_path.as_str()),
                (id, path)
            );
        }
    }

    #[test]
    fn an_ordinary_result_is_not_a_move() {
        for text in [
            "",
            "hello from bash",
            "Exit code 143\nCommand timed out after 3s",
            "Command running in background with ID: b9. Output is being written to: /t/b9.output.",
            "moved to the background (ID: ) Output is being written to: /t/x",
            "moved to the background (ID: b4) and nothing about where its output goes",
            "Command was moved to the background (ID: <id>). Output is being written to: /t/x.output.",
        ] {
            assert_eq!(parse_moved_call(text), None, "{text:?}");
        }
    }

    #[test]
    fn output_that_quotes_the_sentence_is_not_a_move() {
        for text in [
            // A grep over a log or a source file: the sentence mid-line.
            "log.txt:12: Command was moved to the background (ID: b5). Output is being written to: /t/b5.output.",
            // An indented quote, as a printed fixture or doc carries it.
            "    let cap = \"Command was moved to the background (ID: b6). Output is being written to: /t/b6.output.\";",
            "event=\"call_moved\" task_id=b7 moved to the background (ID: b7). Output is being written to: /t/b7.output.",
        ] {
            assert_eq!(parse_moved_call(text), None, "{text:?}");
        }
    }
}

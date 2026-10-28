//! The AI file-merge rung ([P32]) of the join resolution ladder.
//!
//! `tugarc-core`'s ladder is provider-agnostic — it takes a [`FileMerger`]
//! seam for its last rung. Here tugcast plugs the scribe sidecar into that seam:
//! each conflicted file the algorithmic rungs couldn't resolve gets a headless
//! `claude -p` three-way merge, its text streamed to the card through the run's
//! [`LedgerRecorder`] as live-only beats. The scribe's `started` and its verdict
//! are the ladder's to report, through the same recorder as its observer. The
//! scribe run is async; the ladder is sync (it runs inside `spawn_blocking`), so
//! [`ScribeFileMerger::merge`] blocks on the captured runtime handle.

use std::sync::Arc;

use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tugarc_core::{FileMergeRequest, FileMerger};
use tugcast_core::types::ArcJoinLedgerEventBody;

use crate::feeds::join_ledger::LedgerRecorder;
use crate::scribe::{self, ScribeSpawner};

/// How much of the file being written a stream beat carries: its tail, which
/// is where the scribe is writing ([P03]).
const SCRIBE_TAIL_LINES: usize = 8;

/// The ladder's AI rung ([P32]), backed by the scribe sidecar. Constructed per
/// resolve run with that run's recorder, so its stream lands in the run.
pub struct ScribeFileMerger {
    pub spawner: Arc<dyn ScribeSpawner>,
    pub model: Arc<dyn Fn() -> String + Send + Sync>,
    pub handle: Handle,
    /// Where the stream goes. A merge with no join run to land in — a
    /// crossing settled between two live arcs — streams nowhere.
    pub recorder: Option<Arc<LedgerRecorder>>,
}

impl FileMerger for ScribeFileMerger {
    fn merge(&self, req: &FileMergeRequest) -> Option<Vec<u8>> {
        // The ladder declines a file over the one-shot cap before it asks; a
        // prompt that will not compose is the same decline, said again here.
        let prompt = scribe::compose_file_merge_prompt(
            &req.path,
            req.base.as_deref(),
            req.ours.as_deref().unwrap_or_default(),
            req.theirs.as_deref().unwrap_or_default(),
            &req.intent,
        )?;
        let model = (self.model)();
        let spawner = self.spawner.clone();
        let recorder = self.recorder.clone();
        let path = req.path.clone();

        // The ladder is sync (spawn_blocking); drive the async scribe on the
        // captured handle. A forwarder task relays the tail of the accumulated
        // text as live-only beats: the spawner hands over the whole file so far
        // on every beat, and the card draws only its last lines.
        let result = self.handle.block_on(async move {
            let Some(recorder) = recorder else {
                return spawner.run(model, prompt, None).await;
            };
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            let fwd = tokio::spawn(async move {
                while let Some(acc) = rx.recv().await {
                    recorder.stream(ArcJoinLedgerEventBody::Scribe {
                        path: path.clone(),
                        status: "streaming".to_string(),
                        text: Some(tail_lines(&acc, SCRIBE_TAIL_LINES)),
                        said: None,
                        added: None,
                        removed: None,
                    });
                }
            });
            // Unlike a commit-message draft, a merged file's exact bytes matter
            // (the trailing newline especially) — so run the spawner directly
            // rather than through `summarize_with`, which trims.
            let r = spawner.run(model, prompt, Some(tx)).await;
            let _ = fwd.await;
            r
        });

        match result {
            Ok(text) => {
                let cleaned = strip_code_fence(&text);
                if cleaned.trim().is_empty() {
                    None
                } else {
                    // The ladder validates the reply is marker-free.
                    Some(cleaned.into_bytes())
                }
            }
            Err(_) => None,
        }
    }
}

/// Strip a single wrapping Markdown code fence (```… / ```) if the model added
/// one despite the instruction not to — a common, safe cleanup. Leaves an
/// unfenced body untouched.
fn strip_code_fence(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return text.to_string();
    }
    let mut lines: Vec<&str> = trimmed.lines().collect();
    if lines.last().map(|l| l.trim_end() == "```").unwrap_or(false) {
        lines.pop(); // closing fence
        if !lines.is_empty() {
            lines.remove(0); // opening fence (with any language tag)
        }
        let mut body = lines.join("\n");
        body.push('\n');
        return body;
    }
    text.to_string()
}

/// The last `n` lines of `text`, keeping a trailing newline's empty line out
/// of the count.
fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::{strip_code_fence, tail_lines};

    #[test]
    fn a_stream_beat_carries_only_the_tail() {
        let text: String = (1..=12).map(|i| format!("line {i}\n")).collect();
        assert_eq!(tail_lines(&text, 8).lines().next(), Some("line 5"));
        assert_eq!(tail_lines(&text, 8).lines().count(), 8);
        assert_eq!(tail_lines("short", 8), "short");
    }

    #[test]
    fn strip_code_fence_unwraps_only_a_wrapping_fence() {
        assert_eq!(strip_code_fence("```rust\nfn f() {}\n```"), "fn f() {}\n");
        assert_eq!(strip_code_fence("```\nplain\n```"), "plain\n");
        // Unfenced content is untouched (trailing newline preserved).
        assert_eq!(strip_code_fence("no fence\n"), "no fence\n");
        // A stray leading fence with no close is left alone (not our case).
        assert_eq!(strip_code_fence("```\nopen only"), "```\nopen only");
    }
}

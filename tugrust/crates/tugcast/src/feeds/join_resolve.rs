//! The AI file-merge rung ([P32]) of the join resolution ladder, plus the
//! `changeset_join_resolve` progress deltas (Spec S12).
//!
//! `tugarc-core`'s ladder is provider-agnostic — it takes a [`FileMerger`]
//! seam for its last rung. Here tugcast plugs the scribe sidecar into that seam:
//! each conflicted file the algorithmic rungs couldn't resolve gets a headless
//! `claude -p` three-way merge, streamed to the card as
//! `changeset_join_resolve_delta` frames. The scribe run is async; the ladder is
//! sync (it runs inside `spawn_blocking`), so [`ScribeFileMerger::merge`] blocks
//! on the captured runtime handle.

use std::sync::Arc;

use tokio::runtime::Handle;
use tokio::sync::{broadcast, mpsc};
use tugarc_core::{FileMergeRequest, FileMerger};
use tugcast_core::protocol::{FeedId, Frame};

use crate::scribe::{self, ScribeSpawner};

/// The ladder's AI rung ([P32]), backed by the scribe sidecar. Constructed per
/// `changeset_join_resolve` request with the workspace's control channel so it
/// can stream per-file progress.
pub struct ScribeFileMerger {
    pub spawner: Arc<dyn ScribeSpawner>,
    pub model: Arc<dyn Fn() -> String + Send + Sync>,
    pub handle: Handle,
    pub control_tx: broadcast::Sender<Frame>,
    pub project_dir: String,
    pub dash: String,
}

impl FileMerger for ScribeFileMerger {
    fn merge(&self, req: &FileMergeRequest) -> Option<Vec<u8>> {
        emit_delta(
            &self.control_tx,
            &self.project_dir,
            &self.dash,
            &req.path,
            "ai",
            "trying",
            None,
        );

        let prompt = scribe::compose_file_merge_prompt(
            &req.path,
            req.base.as_deref(),
            req.ours.as_deref().unwrap_or_default(),
            req.theirs.as_deref().unwrap_or_default(),
            &req.intent,
        );
        let model = (self.model)();
        let spawner = self.spawner.clone();
        let control_tx = self.control_tx.clone();
        let project_dir = self.project_dir.clone();
        let dash = self.dash.clone();
        let path = req.path.clone();

        // The ladder is sync (spawn_blocking); drive the async scribe on the
        // captured handle. A forwarder task relays accumulated text as deltas.
        let result = self.handle.block_on(async move {
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            let fwd = {
                let control_tx = control_tx.clone();
                let project_dir = project_dir.clone();
                let dash = dash.clone();
                let path = path.clone();
                tokio::spawn(async move {
                    while let Some(acc) = rx.recv().await {
                        emit_delta(
                            &control_tx,
                            &project_dir,
                            &dash,
                            &path,
                            "ai",
                            "streaming",
                            Some(&acc),
                        );
                    }
                })
            };
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

/// Broadcast one `changeset_join_resolve_delta` progress frame (Spec S12).
pub fn emit_delta(
    control_tx: &broadcast::Sender<Frame>,
    project_dir: &str,
    dash: &str,
    path: &str,
    rung: &str,
    status: &str,
    text: Option<&str>,
) {
    let body = serde_json::json!({
        "action": "changeset_join_resolve_delta",
        "project_dir": project_dir,
        "dash": dash,
        "path": path,
        "rung": rung,
        "status": status,
        "text": text,
    });
    let _ = control_tx.send(Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("changeset_join_resolve_delta serializes"),
    ));
}

#[cfg(test)]
mod tests {
    use super::strip_code_fence;

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

//! Per-session shell word tables: the orchestration around `tuggram::words`.
//!
//! The reading itself — spawning a shell, folding a dump, parsing a printed
//! body — lives in `tuggram`, next to the grader that consumes it, so the eval
//! harness and the app read reality through exactly one expression of it. What
//! lives here is everything asynchronous and stateful about doing that for a
//! live session: which session owns which table, when it is refreshed, and
//! keeping the blocking shell spawns off the dispatcher.
//!
//! A table is per session because it is read from the session's own project
//! directory, and rc files branch on where they are standing.

use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;
use tracing::warn;

/// One session's view of what its shell will resolve.
#[derive(Clone)]
pub struct SessionWords {
    table: Arc<Mutex<tuggram::ShellWords>>,
    /// Whether this table may be read from a shell at all. Off under the
    /// dispatcher's bare test policy, where the table stays empty and nothing
    /// is spawned: reading it means an interactive login shell.
    enabled: bool,
}

impl SessionWords {
    /// An empty table, read from the session's shell only when `enabled`.
    pub fn new(enabled: bool) -> Self {
        Self {
            table: Arc::new(Mutex::new(tuggram::ShellWords::empty())),
            enabled,
        }
    }

    /// Re-read the whole table from a fresh interactive-login shell standing in
    /// `cwd`, returning the member names for the deck.
    ///
    /// A dump that fails leaves the table empty, which is the pre-interrogation
    /// behavior: every word falls through to PATH and the static builtins. A
    /// disabled table spawns nothing and stays empty.
    pub async fn refresh(&self, cwd: Option<&Path>) -> Vec<String> {
        if !self.enabled {
            return Vec::new();
        }
        let cwd = cwd.map(|c| c.to_path_buf());
        let dumped =
            tokio::task::spawn_blocking(move || tuggram::words::dump_shell_words(cwd.as_deref()))
                .await;
        let table = match dumped {
            Ok(Some(table)) => table,
            Ok(None) => {
                // Not an error worth a warning: a fish user has no table and
                // grades exactly as everyone did before this existed.
                tuggram::ShellWords::empty()
            }
            Err(e) => {
                warn!(error = %e, "shell word dump task failed");
                tuggram::ShellWords::empty()
            }
        };
        let names = table.member_names().iter().map(|n| n.to_string()).collect();
        *self.table.lock().await = table;
        names
    }

    /// Read the bodies of every word in `heads` that still needs one, following
    /// each through the chain it expands along.
    ///
    /// One shell spawn per unread word — which is why this is driven by the
    /// heads of a line somebody actually typed, and why it runs behind the
    /// typing debounce rather than at submit.
    pub async fn ensure_bodies(&self, heads: &[String]) {
        if !self.enabled {
            return;
        }
        let mut table = self.table.lock().await;
        if !heads.iter().any(|h| table.needs_body(h)) {
            return;
        }
        // Work on a clone off-thread, then swap it back: the fetches are
        // blocking shell spawns and must not run on the async runtime.
        let mut working = table.clone();
        let heads = heads.to_vec();
        let fetched = tokio::task::spawn_blocking(move || {
            for head in &heads {
                tuggram::words::ensure_body_chain(&mut working, head);
            }
            working
        })
        .await;
        match fetched {
            Ok(working) => *table = working,
            Err(e) => warn!(error = %e, "shell word body fetch task failed"),
        }
    }

    /// A copy of the table for a grading task to hold while it works.
    pub async fn snapshot(&self) -> tuggram::ShellWords {
        self.table.lock().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unusable_shell_leaves_an_empty_table_rather_than_wedging() {
        unsafe {
            std::env::set_var("SHELL", "/usr/bin/false");
        }
        let words = SessionWords::new(true);
        assert!(words.refresh(None).await.is_empty());
        words.ensure_bodies(&["anything".to_string()]).await;
        assert!(words.snapshot().await.is_empty());
    }
}

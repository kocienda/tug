//! Single-shot subscription-usage fetch via `claude -p "/usage"`.
//!
//! The `/usage` panel (limit gauges + reset times + the "what's contributing"
//! breakdown) is owned by the `claude` CLI: it fetches the account-global
//! windows from `GET /api/oauth/usage` and computes the local-session
//! contribution characteristics itself. Rather than duplicate that (and handle
//! the OAuth token ourselves), we ask `claude` for it — exactly as
//! [`super::claude_auth`] shells out to `claude auth status`. `claude -p
//! "/usage"` runs the command headlessly and prints the whole panel as text,
//! which we forward verbatim for the deck to parse.
//!
//! The Anthropic auth env vars are scrubbed (via
//! [`super::claude_auth::claude_command`]) so the figures reflect the user's
//! subscription — the auth path that actually has usage limits — rather than a
//! stray `ANTHROPIC_API_KEY`.

use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::claude_auth::claude_command;

/// Hard ceiling on the `claude -p "/usage"` round-trip. The limit gauges come
/// back in seconds, but the "what's contributing" breakdown walks every local
/// transcript under `~/.claude/projects`, and that cost grows with the store.
/// In October 2026 87 GB of app-test seeds the harness had stranded there
/// (now cleaned up as each run ends, and swept by
/// `tugcore::janitor::sweep_seeded_transcripts`) pushed it to 63s and timed
/// every fetch out; over 2.4 GB of real sessions it takes about 2.5s. The
/// ceiling exists only to bound a pathological hang (an update check, an auth
/// re-prompt) so the sheet surfaces an error rather than spinning forever.
const USAGE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a finished fetch answers a request that queued behind it. Any
/// request that arrives while a fetch is running waits for it and takes its
/// result, rather than starting a second transcript scan of its own.
const COALESCE_WINDOW: Duration = Duration::from_secs(5);

type UsageResult = (bool, String, Option<String>);

/// The one in-flight fetch's lock, and the result it last produced.
static LAST_FETCH: Mutex<Option<(Instant, UsageResult)>> = Mutex::const_new(None);

/// Run `claude -p "/usage"` and return `(ok, stdout_text, error)`.
///
/// `ok` is true only on a zero exit; on failure `error` carries the last stderr
/// line (or a not-found / spawn / timeout message) so the deck can surface a
/// reason instead of a blank sheet. A missing `claude` binary resolves to a
/// friendly "Claude Code isn't installed" rather than a raw OS error. The child
/// is `kill_on_drop`, so a timeout reaps it rather than orphaning a process.
///
/// Fetches are serialized and coalesced: a request that queued behind a
/// running fetch takes that fetch's result instead of shelling out again.
pub async fn fetch_usage_text() -> UsageResult {
    let mut last = LAST_FETCH.lock().await;
    if let Some((at, result)) = last.as_ref()
        && at.elapsed() < COALESCE_WINDOW
    {
        return result.clone();
    }
    let result = run_usage_command().await;
    *last = Some((Instant::now(), result.clone()));
    result
}

async fn run_usage_command() -> UsageResult {
    let mut cmd = claude_command(&["-p", "/usage"]);
    cmd.kill_on_drop(true);
    let result = match tokio::time::timeout(USAGE_TIMEOUT, cmd.output()).await {
        Ok(result) => result,
        Err(_elapsed) => {
            return (
                false,
                String::new(),
                Some("Timed out fetching usage".to_string()),
            );
        }
    };
    match result {
        Ok(out) if out.status.success() => (
            true,
            String::from_utf8_lossy(&out.stdout).into_owned(),
            None,
        ),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr
                .trim()
                .lines()
                .last()
                .filter(|l| !l.is_empty())
                .unwrap_or("`claude /usage` failed")
                .to_string();
            (
                false,
                String::from_utf8_lossy(&out.stdout).into_owned(),
                Some(detail),
            )
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
            false,
            String::new(),
            Some("Claude Code isn't installed".to_string()),
        ),
        Err(e) => (false, String::new(), Some(e.to_string())),
    }
}

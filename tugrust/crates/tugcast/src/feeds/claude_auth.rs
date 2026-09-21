//! Detection of the user's Claude Code login state via `claude auth status`,
//! plus a `login()` helper that drives `claude auth login`, and the version
//! pair the setup wizard's install row reports: the locally installed version
//! (`claude --version`) and the newest release on the stable channel.
//!
//! `claude` owns authentication (the credentials live in the macOS Keychain,
//! not a file we could read), so we ask the CLI rather than inspecting storage
//! directly. The same Anthropic auth env vars that `agent_bridge` scrubs before
//! spawning sessions are scrubbed here, so the reported status reflects the
//! subscription auth path (`~/.claude.json`) that sessions actually use rather
//! than a stray `ANTHROPIC_API_KEY` in the developer's environment.

use tokio::process::Command;

use tugcore::version::parse_leading_version as parse_version;

/// Resolved Claude Code login state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthState {
    /// The `claude` CLI is not on PATH.
    ClaudeMissing,
    /// CLI present but no valid login.
    LoggedOut,
    /// Logged in; carries account details for the sign-in UI.
    LoggedIn(AccountInfo),
    /// The probe did not answer, so the login state is genuinely unknown.
    ///
    /// Distinct from [`AuthState::LoggedOut`] on purpose, and the distinction
    /// is the whole point of this arm. Every non-`NotFound` failure used to
    /// resolve to `LoggedOut`, which is reasonable for a definite answer —
    /// better to offer sign-in than to crash-loop a session — and wrong for
    /// silence: it is exactly what turns a machine whose `claude` is slow or
    /// wedged into a user being told they are signed out and handed a modal
    /// that cannot succeed. "We could not tell" is a different sentence from
    /// "you are signed out", and only the surface reading it can decide what
    /// to do about it.
    Unknown,
}

/// Account details surfaced by `claude auth status --json`, shown in the
/// sign-in sheet (e.g. "Signed in as user@example.com — Max").
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountInfo {
    pub email: Option<String>,
    pub subscription_type: Option<String>,
    pub auth_method: Option<String>,
}

/// Anthropic auth env vars scrubbed so the probe and login authenticate via the
/// user's subscription, matching `agent_bridge` session spawns. Keep in sync
/// with `AUTH_ENV_VARS` in `tests/common/catalog.rs` and the destructure in
/// `tugcode/src/session.ts::spawnClaude`.
const AUTH_ENV_VARS: [&str; 3] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// Resolve the `claude` executable: the user's PATH first, then the native
/// installer's `~/.local/bin/claude` as a fallback. This lets Tug find a
/// `claude` installed by `claude.ai/install.sh` even when the user hasn't added
/// `~/.local/bin` to their shell PATH — we don't edit their shell environment.
/// Resolved fresh on every call so a just-installed `claude` is found without
/// relaunch. Returns the bare name when nothing is found, so the spawn fails
/// with `NotFound` and [`probe`] maps it to [`AuthState::ClaudeMissing`].
pub fn claude_executable() -> std::ffi::OsString {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("claude");
            if candidate.is_file() {
                return candidate.into_os_string();
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let candidate = std::path::Path::new(&home).join(".local/bin/claude");
        if candidate.is_file() {
            return candidate.into_os_string();
        }
    }
    std::ffi::OsString::from("claude")
}

/// A `claude` command with the Anthropic auth env vars scrubbed. Shared with
/// [`super::claude_usage`] so `/usage` authenticates via the same subscription
/// path (`~/.claude.json`) that sessions and the auth probe use.
pub(crate) fn claude_command(args: &[&str]) -> Command {
    let mut cmd = Command::new(claude_executable());
    cmd.args(args);
    for var in AUTH_ENV_VARS {
        cmd.env_remove(var);
    }
    cmd
}

/// How long the auth probe may run before its answer stops being worth
/// waiting for.
///
/// `claude auth status --json` reports stored credentials without a model
/// query, so a healthy run answers in well under a second; five seconds is
/// roughly ten times that. It is short enough that the setup wizard and the
/// session-open gate both stay responsive, and it bounds a `claude` binary
/// that is itself hung — which is the case this exists for, because an
/// unbounded probe is a wait with no exit on the path to opening a card.
const AUTH_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Probe the current login state by running `claude auth status --json`.
///
/// Fast and local — the CLI reports stored auth without a model query. A
/// missing `claude` binary resolves to [`AuthState::ClaudeMissing`]; any other
/// *definite* failure resolves to [`AuthState::LoggedOut`] so the UI offers
/// sign-in rather than silently crash-looping a session. A probe that does not
/// answer inside [`AUTH_PROBE_TIMEOUT`] resolves to [`AuthState::Unknown`]
/// instead — see that arm for why silence is not a signed-out answer.
pub async fn probe() -> AuthState {
    probe_command(
        claude_command(&["auth", "status", "--json"]),
        AUTH_PROBE_TIMEOUT,
    )
    .await
}

/// The bounded probe itself, over a command the caller supplies.
///
/// Split out from [`probe`] so a test can point it at a command that never
/// answers and watch it come back anyway — which is the claim, and which no
/// test could make against a function that resolves its own executable.
async fn probe_command(mut cmd: Command, timeout: std::time::Duration) -> AuthState {
    let started = std::time::Instant::now();
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) => parse_status(&String::from_utf8_lossy(&output.stdout)),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => AuthState::ClaudeMissing,
        Ok(Err(_)) => AuthState::LoggedOut,
        Err(_) => {
            // Logged with the elapsed time so a slow `claude` is a fact in the
            // log rather than something inferred from a UI that went quiet.
            tracing::warn!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                timeout_ms = timeout.as_millis() as u64,
                "claude auth probe timed out; login state is unknown"
            );
            AuthState::Unknown
        }
    }
}

/// Parse `claude auth status --json` stdout into an [`AuthState`]. Output that
/// is unparseable or reports `loggedIn: false` is treated as logged-out.
fn parse_status(stdout: &str) -> AuthState {
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(rename = "loggedIn")]
        logged_in: bool,
        email: Option<String>,
        #[serde(rename = "subscriptionType")]
        subscription_type: Option<String>,
        #[serde(rename = "authMethod")]
        auth_method: Option<String>,
    }
    match serde_json::from_str::<Raw>(stdout.trim()) {
        Ok(raw) if raw.logged_in => AuthState::LoggedIn(AccountInfo {
            email: raw.email,
            subscription_type: raw.subscription_type,
            auth_method: raw.auth_method,
        }),
        _ => AuthState::LoggedOut,
    }
}

/// Drive `claude auth login` and await completion, then return the freshly
/// probed state.
///
/// The CLI opens the browser and blocks on its own localhost OAuth callback,
/// so the child process exiting *is* the completion signal — no polling. We
/// re-probe afterward regardless of exit code because the probe is the
/// authoritative source of truth (the user may have completed or abandoned the
/// browser flow).
pub async fn login() -> AuthState {
    let _ = claude_command(&["auth", "login"]).status().await;
    probe().await
}

/// Drive `claude auth logout` and return `(ok, error_message)`. Unlike
/// [`login`], the command's own success matters: a failed logout must surface
/// as an error rather than a silent no-op, so the caller (`claude_logout`) can
/// tell the user it didn't work instead of pretending they're logged out. The
/// caller re-probes afterward to broadcast the authoritative auth state.
pub async fn logout() -> (bool, Option<String>) {
    match claude_command(&["auth", "logout"]).output().await {
        Ok(out) if out.status.success() => (true, None),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr.trim().lines().last().unwrap_or("logout failed");
            (false, Some(detail.to_string()))
        }
        Err(e) => (false, Some(e.to_string())),
    }
}

/// The release channel `claude install` (and therefore the official installer)
/// resolves by default. Tug reports the same channel the update it offers would
/// land, so "up to date" means up to date with what pressing Update would do.
const STABLE_CHANNEL_URL: &str = "https://downloads.claude.ai/claude-code-releases/stable";

/// How long to wait on the release-channel lookup. The version row is
/// informational — a slow or unreachable network resolves to "latest unknown"
/// and the row still reports the installed version rather than hanging.
const LATEST_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// The version of Claude Code installed locally, from `claude --version`
/// (`"2.1.222 (Claude Code)"`). `None` when the CLI is missing or its output
/// does not lead with a version.
pub async fn installed_version() -> Option<String> {
    let output = claude_command(&["--version"]).output().await.ok()?;
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// The newest Claude Code release on the stable channel, or `None` when the
/// lookup fails (offline, unsupported region, unexpected content).
pub async fn latest_version() -> Option<String> {
    let response = reqwest::Client::new()
        .get(STABLE_CHANNEL_URL)
        .timeout(LATEST_VERSION_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    parse_version(&response.text().await.ok()?)
}

/// Run the official Claude Code installer (`curl -fsSL https://claude.ai/
/// install.sh | bash`) and return `(ok, error_message)`. The native installer
/// drops `claude` in `~/.local/bin` without editing the shell PATH; Tug finds
/// it via [`claude_executable`]'s fallback, so no shell-environment change is
/// needed. Tug manages the install itself rather than asking the user to run
/// commands.
pub async fn install() -> (bool, Option<String>) {
    // `set -o pipefail` is load-bearing: without it the pipeline's exit status
    // is `bash`'s, not `curl`'s, so a failed download (no network, DNS failure,
    // HTTP error) is masked — `curl` emits nothing, `bash` reads empty stdin and
    // exits 0, and the install reports success while nothing was installed. With
    // pipefail, a `curl` failure fails the whole pipeline so it surfaces as an
    // install error.
    match Command::new("bash")
        .arg("-c")
        .arg("set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash")
        .output()
        .await
    {
        Ok(out) if out.status.success() => (true, None),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr.trim().lines().last().unwrap_or("install failed");
            (false, Some(detail.to_string()))
        }
        Err(e) => (false, Some(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_logged_in_max_subscription() {
        // The real shape of `claude auth status --json` for a Max subscription.
        let json = r#"{
            "loggedIn": true,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "email": "user@example.com",
            "orgId": "abc",
            "orgName": "Org",
            "subscriptionType": "max"
        }"#;
        assert_eq!(
            parse_status(json),
            AuthState::LoggedIn(AccountInfo {
                email: Some("user@example.com".to_string()),
                subscription_type: Some("max".to_string()),
                auth_method: Some("claude.ai".to_string()),
            })
        );
    }

    #[test]
    fn logged_out_when_flag_false() {
        assert_eq!(parse_status(r#"{"loggedIn": false}"#), AuthState::LoggedOut);
    }

    #[test]
    fn logged_out_when_unparseable() {
        assert_eq!(parse_status("not json at all"), AuthState::LoggedOut);
    }

    #[tokio::test]
    async fn a_probe_that_never_answers_is_unknown_not_logged_out() {
        // The whole claim of the bound, in one assertion pair: a command that
        // would run for half a minute comes back inside the deadline, and what
        // it comes back with is `Unknown`. An unbounded `output().await` would
        // sit here for thirty seconds, and the arm it used to resolve to would
        // have told the user they were signed out.
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let started = std::time::Instant::now();
        let state = probe_command(cmd, std::time::Duration::from_millis(200)).await;
        assert_eq!(state, AuthState::Unknown);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "probe took {:?}, which is not a bound",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_definite_answer_is_unchanged_by_the_bound() {
        // The bound must not change what a command that *does* answer means.
        // Valid output still reads `LoggedIn`, and malformed output still reads
        // `LoggedOut` — only silence became a third thing.
        let mut ok = Command::new("printf");
        ok.arg(r#"{"loggedIn": true, "email": "user@example.com"}"#);
        assert_eq!(
            probe_command(ok, std::time::Duration::from_secs(20)).await,
            AuthState::LoggedIn(AccountInfo {
                email: Some("user@example.com".to_string()),
                subscription_type: None,
                auth_method: None,
            })
        );

        let mut garbage = Command::new("printf");
        garbage.arg("not json at all");
        assert_eq!(
            probe_command(garbage, std::time::Duration::from_secs(20)).await,
            AuthState::LoggedOut
        );
    }

    #[tokio::test]
    async fn a_missing_binary_is_still_claude_missing() {
        let cmd = Command::new("/nonexistent/tug-test-no-such-claude");
        assert_eq!(
            probe_command(cmd, std::time::Duration::from_secs(20)).await,
            AuthState::ClaudeMissing
        );
    }
}

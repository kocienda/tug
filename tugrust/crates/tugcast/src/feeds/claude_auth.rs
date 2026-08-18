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

/// Resolved Claude Code login state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthState {
    /// The `claude` CLI is not on PATH.
    ClaudeMissing,
    /// CLI present but no valid login.
    LoggedOut,
    /// Logged in; carries account details for the sign-in UI.
    LoggedIn(AccountInfo),
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

/// Probe the current login state by running `claude auth status --json`.
///
/// Fast and local — the CLI reports stored auth without a model query. A
/// missing `claude` binary resolves to [`AuthState::ClaudeMissing`]; any other
/// failure resolves to [`AuthState::LoggedOut`] so the UI offers sign-in rather
/// than silently crash-looping a session.
pub async fn probe() -> AuthState {
    match claude_command(&["auth", "status", "--json"]).output().await {
        Ok(output) => parse_status(&String::from_utf8_lossy(&output.stdout)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AuthState::ClaudeMissing,
        Err(_) => AuthState::LoggedOut,
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

/// Take the leading `MAJOR.MINOR.PATCH[-pre]` token out of a line, so both
/// `claude --version`'s suffixed output and the channel file's bare version parse
/// through one path. Anything else (an HTML error page, a usage message)
/// resolves to `None` rather than being shown to the user as a version.
fn parse_version(text: &str) -> Option<String> {
    let token = text.trim().lines().next()?.split_whitespace().next()?;
    let mut parts = token.splitn(3, '.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let patch_numeric = patch.split(['-', '+']).next().unwrap_or_default();
    if numeric(major) && numeric(minor) && numeric(patch_numeric) {
        Some(token.to_string())
    } else {
        None
    }
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

    #[test]
    fn parses_the_cli_version_line() {
        assert_eq!(
            parse_version("2.1.222 (Claude Code)\n"),
            Some("2.1.222".to_string())
        );
    }

    #[test]
    fn parses_a_bare_channel_version() {
        assert_eq!(parse_version("2.1.226\n"), Some("2.1.226".to_string()));
        assert_eq!(
            parse_version("2.2.0-rc.1\n"),
            Some("2.2.0-rc.1".to_string())
        );
    }

    #[test]
    fn rejects_content_that_is_not_a_version() {
        // An HTML error page from the channel URL, or a CLI that answered with
        // usage text, must read as "unknown" rather than land in the UI.
        assert_eq!(parse_version("<!doctype html>"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("Usage: claude [options]"), None);
        assert_eq!(parse_version("2.1"), None);
    }
}

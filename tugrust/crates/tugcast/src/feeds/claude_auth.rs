//! Detection of the user's Claude Code login state via `claude auth status`,
//! plus a `login()` helper that drives `claude auth login`, and the version
//! pair the setup wizard's install row reports: the locally installed version
//! (`claude --version`) and the newest release on the `latest` channel, the
//! one the download behind the row's Update button resolves.
//!
//! `claude` owns authentication (the credentials live in the macOS Keychain,
//! not a file we could read), so we ask the CLI rather than inspecting storage
//! directly. The same Anthropic auth env vars that `agent_bridge` scrubs before
//! spawning sessions are scrubbed here, so the reported status reflects the
//! subscription auth path (`~/.claude.json`) that sessions actually use rather
//! than a stray `ANTHROPIC_API_KEY` in the developer's environment.
//!
//! Scrubbing does not make the answer a subscription. A Console profile left
//! by Anthropic's `ant` CLI, an `apiKeyHelper`, or an `env` block in Claude
//! Code's settings all survive it, so every logged-in answer is named by its
//! [`LoginSource`]. Where the status is ambiguous the source is resolved from
//! the files Claude Code itself reads ([`LocalFacts`]): configuration only,
//! never a credential, and never by running another CLI.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use tugcore::version::parse_leading_version as parse_version;

use super::secret_filter::scrub_text;

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

impl AuthState {
    /// A one-word account of the state for the log: the login source when
    /// logged in, otherwise which way it is not.
    pub fn source_label(&self) -> &'static str {
        match self {
            Self::LoggedIn(info) => info.source.as_str(),
            Self::LoggedOut => "logged_out",
            Self::ClaudeMissing => "claude_missing",
            Self::Unknown => "probe_failed",
        }
    }
}

/// Account details surfaced by `claude auth status --json`, shown in the
/// sign-in sheet (e.g. "Signed in as user@example.com — Max"), and the
/// source the login comes from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountInfo {
    pub email: Option<String>,
    pub subscription_type: Option<String>,
    pub auth_method: Option<String>,
    /// `apiKeySource` as the CLI reports it: the variable or setting a key
    /// came from (`ANTHROPIC_API_KEY`, `apiKeyHelper`), absent for OAuth.
    pub api_key_source: Option<String>,
    /// The organisation a subscription login belongs to.
    pub org_name: Option<String>,
    /// The subscription's plan tier (`max_20x`), finer than its type.
    pub plan_tier: Option<String>,
    /// Which source Claude Code is signed in through.
    pub source: LoginSource,
    /// A Console profile present on disk, whether it is the active login or
    /// one sitting beneath a subscription that logout would fall back to.
    /// Boxed so a logged-in answer stays near the size of the others.
    pub profile: Option<Box<ConsoleProfile>>,
    /// Whether a subscription login is stored, even when another source
    /// outranks it and `auth status` reports none of its fields.
    pub subscription_stored: bool,
}

/// Where Claude Code's active login comes from. `auth status` alone cannot
/// always say: an `oauth_token` with no `apiKeySource` is an auth token, a
/// long-lived OAuth token, or a Console profile alike, so the mapping reads
/// the facts on disk ([`LocalFacts`]) beside it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LoginSource {
    /// The user's Claude subscription, stored by `claude auth login`.
    Subscription,
    /// The `ant` CLI's Console profile, billed per token to its organisation.
    ConsoleProfile,
    /// An API key from the environment or a settings `env` block.
    EnvironmentKey,
    /// An auth token from the environment or a settings `env` block.
    EnvironmentToken,
    /// An `apiKeyHelper` command in Claude Code's settings.
    SettingsHelper,
    /// Logged in, through something Tug cannot name.
    #[default]
    Unknown,
}

impl LoginSource {
    /// The wire spelling, read by the deck's `authStore`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Subscription => "subscription",
            Self::ConsoleProfile => "console_profile",
            Self::EnvironmentKey => "environment_key",
            Self::EnvironmentToken => "environment_token",
            Self::SettingsHelper => "settings_helper",
            Self::Unknown => "unknown",
        }
    }
}

/// A Console profile found by the `ant` CLI's convention. Carries only what
/// the profile's config says — never anything from its credentials file,
/// which is checked for being non-empty and never opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleProfile {
    /// The active profile's name (`default`).
    pub name: String,
    /// The `ant` config dir the profile was found under.
    pub config_dir: PathBuf,
    /// `authentication.type` (`user_oauth` for a browser login).
    pub auth_type: Option<String>,
    pub organization_id: Option<String>,
    pub workspace_id: Option<String>,
}

/// What the files beside `auth status` say, read without running anything
/// and without opening a secret.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalFacts {
    /// The active Console profile, when its credentials file is non-empty.
    pub profile: Option<ConsoleProfile>,
    /// The user settings' `env` block sets `ANTHROPIC_AUTH_TOKEN`. The probe
    /// scrubs the variable from its own environment, so an `oauth_token`
    /// with a token present can only have come from here.
    pub settings_auth_token: bool,
    /// The Claude config file carries an `oauthAccount`: a subscription
    /// login is stored.
    pub subscription_stored: bool,
}

impl LocalFacts {
    /// Read the facts from this process's environment and home directory —
    /// the environment the probe's `claude` sees, since it inherits it.
    pub fn read() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Self::read_from(&|name| std::env::var_os(name), home.as_deref())
    }

    fn read_from(env: &dyn Fn(&str) -> Option<OsString>, home: Option<&Path>) -> Self {
        let claude_settings =
            tugcore::claude_home::ClaudeHome::resolve(env("CLAUDE_CONFIG_DIR").as_deref(), home)
                .settings_path();
        // With `CLAUDE_CONFIG_DIR` set the config file lives inside it;
        // otherwise it is `~/.claude.json`, beside the directory.
        let claude_json = match set_var(env, "CLAUDE_CONFIG_DIR") {
            Some(dir) => Some(PathBuf::from(dir).join(".claude.json")),
            None => home.map(|h| h.join(".claude.json")),
        };
        let settings_auth_token = read_json(&claude_settings)
            .and_then(|v| {
                v.get("env")?
                    .get("ANTHROPIC_AUTH_TOKEN")?
                    .as_str()
                    .map(|s| !s.is_empty())
            })
            .unwrap_or(false);
        let subscription_stored = claude_json
            .and_then(|p| {
                #[derive(serde::Deserialize)]
                struct Config {
                    #[serde(rename = "oauthAccount")]
                    oauth_account: Option<serde_json::Map<String, serde_json::Value>>,
                }
                let text = std::fs::read_to_string(p).ok()?;
                serde_json::from_str::<Config>(&text).ok()?.oauth_account
            })
            .is_some();
        Self {
            profile: console_profile(env, home),
            settings_auth_token,
            subscription_stored,
        }
    }
}

/// What a Claude Code settings file says about auth, by name only: which of
/// the two auth variables its `env` block sets, and whether it names an
/// `apiKeyHelper`. No value is kept.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SettingsAuth {
    pub api_key: bool,
    pub auth_token: bool,
    pub helper: bool,
}

impl SettingsAuth {
    /// Read the settings files at `paths`, merged: a key set in any of them
    /// is set. A missing or unparseable file sets nothing.
    pub fn read(paths: &[PathBuf]) -> Self {
        let mut out = Self::default();
        for path in paths {
            let Some(v) = read_json(path) else { continue };
            let env_set = |name: &str| {
                v.get("env")
                    .and_then(|e| e.get(name))
                    .and_then(|x| x.as_str())
                    .is_some_and(|s| !s.is_empty())
            };
            out.api_key |= env_set("ANTHROPIC_API_KEY");
            out.auth_token |= env_set("ANTHROPIC_AUTH_TOKEN");
            out.helper |= v
                .get("apiKeyHelper")
                .and_then(|x| x.as_str())
                .is_some_and(|s| !s.is_empty());
        }
        out
    }

    /// A project's own settings, which sessions in it use and `auth status`
    /// run elsewhere cannot see.
    pub fn of_project(project_dir: &Path) -> Self {
        let dir = tugcore::claude_home::project_claude_dir(project_dir);
        Self::read(&[dir.join("settings.json"), dir.join("settings.local.json")])
    }

    fn any(self) -> bool {
        self.api_key || self.auth_token || self.helper
    }
}

/// A login a session would run on that is not the user's subscription: what
/// the session-open gate asks the user to confirm before it bills per token.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidLogin {
    /// The login's identity, which a confirmation is remembered under: the
    /// source, and the profile and org or the variable's name. Two sources
    /// together are one identity, since a request carries both.
    pub identity: String,
    pub login_source: &'static str,
    pub api_key_source: Option<String>,
    pub org_name: Option<String>,
    pub profile_name: Option<String>,
    /// The project's own settings set the variables this login uses, which
    /// is why the probe could not have named them.
    pub from_project: bool,
}

/// The paid login a session in a project would run on, from the probe's
/// answer and the project's own settings, or `None` when the session would
/// run on the subscription — or when Tug cannot tell, which the respawn gate
/// and the instant exit of a logged-out `claude` already answer.
///
/// A project's `env` block outranks the probe: sessions read it, and
/// `auth status` run anywhere else cannot see it ([F10]).
pub fn paid_login_of(state: &AuthState, project: SettingsAuth) -> Option<PaidLogin> {
    if project.api_key || project.auth_token {
        let (source, identity) = match (project.auth_token, project.api_key) {
            (true, true) => (
                "environment_token",
                "environment_token+environment_key:ANTHROPIC_API_KEY",
            ),
            (true, false) => ("environment_token", "environment_token"),
            _ => ("environment_key", "environment_key:ANTHROPIC_API_KEY"),
        };
        return Some(PaidLogin {
            identity: identity.to_string(),
            login_source: source,
            api_key_source: project.api_key.then(|| "ANTHROPIC_API_KEY".to_string()),
            org_name: None,
            profile_name: None,
            from_project: true,
        });
    }
    let AuthState::LoggedIn(info) = state else {
        return None;
    };
    // `apiKeySource` names a key's variable, except under a lone helper,
    // where it names the helper itself and no key rides beside it.
    let key = |head: &str| match info.api_key_source.as_deref() {
        Some("apiKeyHelper") | None => head.to_string(),
        Some(src) if head != "environment_key" => format!("{head}+environment_key:{src}"),
        Some(src) => format!("environment_key:{src}"),
    };
    let identity = match info.source {
        LoginSource::Subscription => return None,
        LoginSource::ConsoleProfile => {
            let p = info.profile.as_deref();
            format!(
                "console_profile:{}:{}",
                p.map_or("", |p| p.name.as_str()),
                p.and_then(|p| p.organization_id.as_deref()).unwrap_or(""),
            )
        }
        LoginSource::EnvironmentKey => key("environment_key"),
        LoginSource::EnvironmentToken => key("environment_token"),
        LoginSource::SettingsHelper => key("settings_helper"),
        LoginSource::Unknown => format!("unknown:{}", info.auth_method.as_deref().unwrap_or("")),
    };
    Some(PaidLogin {
        identity,
        login_source: info.source.as_str(),
        api_key_source: info.api_key_source.clone(),
        org_name: info.org_name.clone(),
        profile_name: info.profile.as_deref().map(|p| p.name.clone()),
        from_project: false,
    })
}

/// Whether the files alone show a session could run on a subscription, so
/// the gate can pass without spending a probe on every session open. True
/// only with a stored subscription and nothing in the user's or project's
/// settings that outranks it; a profile beneath a subscription does not
/// outrank it ([F07]).
fn plainly_subscription(facts: &LocalFacts, user: SettingsAuth, project: SettingsAuth) -> bool {
    facts.subscription_stored && !facts.settings_auth_token && !user.any() && !project.any()
}

/// The user settings file the probe's `claude` reads.
fn user_settings_path() -> Option<PathBuf> {
    Some(tugcore::claude_home::ClaudeHome::from_env().settings_path())
}

/// The paid login a session opened in `project_dir` would run on ([B08]).
///
/// Reads the files first, off the async runtime, and returns without a probe
/// when they show a plain subscription — the ordinary case, which this keeps
/// as cheap as a session open was before the gate. Otherwise runs the probe
/// in the project directory, so a project `apiKeyHelper` is seen, and lets
/// the project's `env` block outrank its answer.
pub async fn session_paid_login(project_dir: PathBuf) -> Option<PaidLogin> {
    let dir = project_dir.clone();
    let (facts, user, project) = tokio::task::spawn_blocking(move || {
        let user = user_settings_path()
            .map(|p| SettingsAuth::read(&[p]))
            .unwrap_or_default();
        (LocalFacts::read(), user, SettingsAuth::of_project(&dir))
    })
    .await
    .ok()?;
    if plainly_subscription(&facts, user, project) {
        return None;
    }
    let mut cmd = claude_command(&["auth", "status", "--json"]);
    cmd.current_dir(&project_dir);
    let state = probe_command(cmd, AUTH_PROBE_TIMEOUT).await;
    paid_login_of(&state, project)
}

/// An environment variable that is set to something; an empty value reads
/// as unset, as it does to the CLIs that consult these.
fn set_var(env: &dyn Fn(&str) -> Option<OsString>, name: &str) -> Option<OsString> {
    env(name).filter(|v| !v.is_empty())
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Resolve the active Console profile by the `ant` CLI's convention, which is
/// the one Claude Code reads: the config dir is `$ANTHROPIC_CONFIG_DIR`, else
/// `$XDG_CONFIG_HOME/anthropic`, else `~/.config/anthropic`; the profile is
/// `$ANTHROPIC_PROFILE`, else the name in `<dir>/active_config`; its config
/// is `<dir>/configs/<name>.json`; and its token lives at
/// `authentication.credentials_path`, else `<dir>/credentials/<name>.json`.
/// A profile counts only when that credentials file is non-empty, as Claude
/// Code counts it — and the file is measured, never read.
fn console_profile(
    env: &dyn Fn(&str) -> Option<OsString>,
    home: Option<&Path>,
) -> Option<ConsoleProfile> {
    let dir = set_var(env, "ANTHROPIC_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| set_var(env, "XDG_CONFIG_HOME").map(|x| PathBuf::from(x).join("anthropic")))
        .or_else(|| home.map(|h| h.join(".config/anthropic")))?;
    let name = match set_var(env, "ANTHROPIC_PROFILE") {
        Some(name) => name.to_string_lossy().into_owned(),
        None => std::fs::read_to_string(dir.join("active_config"))
            .ok()?
            .trim()
            .to_string(),
    };
    // A name is one path component; anything else is not a profile name the
    // convention could have written, and is not followed.
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return None;
    }
    let config = read_json(&dir.join("configs").join(format!("{name}.json")))?;
    let auth = config.get("authentication");
    let text = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_owned);
    let credentials = text(auth.and_then(|a| a.get("credentials_path")))
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.join("credentials").join(format!("{name}.json")));
    let present = std::fs::metadata(&credentials)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false);
    present.then(|| ConsoleProfile {
        auth_type: text(auth.and_then(|a| a.get("type"))),
        organization_id: text(config.get("organization_id")),
        workspace_id: text(config.get("workspace_id")),
        name,
        config_dir: dir,
    })
}

/// Name the source of a login from what `auth status` reported and what the
/// files say. Only `oauth_token` needs the files: with an `apiKeySource`
/// beside it the token came with a key, so it is the auth token; without one
/// it is a settings-borne auth token (which outranks a profile), then the
/// profile, and otherwise nothing Tug can name.
fn source_of(
    auth_method: Option<&str>,
    api_key_source: Option<&str>,
    facts: &LocalFacts,
) -> LoginSource {
    match auth_method {
        Some("claude.ai") => LoginSource::Subscription,
        Some("api_key_helper") => LoginSource::SettingsHelper,
        Some("api_key") => LoginSource::EnvironmentKey,
        Some("oauth_token") if api_key_source.is_some() || facts.settings_auth_token => {
            LoginSource::EnvironmentToken
        }
        Some("oauth_token") if facts.profile.is_some() => LoginSource::ConsoleProfile,
        _ => LoginSource::Unknown,
    }
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

/// How long the shell's auth-variable reading may take before Tug falls back
/// to its own environment. An rc file that hangs must not hold the answer.
const SHELL_AUTH_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The line the shell prints before the names, so whatever an rc file prints
/// on startup is never read as one.
const SHELL_AUTH_MARKER: &str = "__tug_shell_auth_vars__";

/// The script the shell runs: the marker, then the *name* of each auth
/// variable that is set and non-empty. `${VAR:+VAR}` expands to the name and
/// never to the value, so no secret is printed, piped or read.
fn shell_auth_script() -> String {
    let names: Vec<String> = AUTH_ENV_VARS
        .iter()
        .map(|var| format!("${{{var}:+{var}}}"))
        .collect();
    format!("printf '%s\\n' {SHELL_AUTH_MARKER} {}", names.join(" "))
}

/// The names the script printed after its marker, in [`AUTH_ENV_VARS`] order.
/// Anything before the last marker, and any line that is not one of the
/// names, is ignored.
fn parse_shell_auth_vars(stdout: &str) -> Vec<&'static str> {
    let Some(after) = stdout.rsplit_once(SHELL_AUTH_MARKER).map(|(_, rest)| rest) else {
        return Vec::new();
    };
    let seen: Vec<&str> = after.lines().map(str::trim).collect();
    AUTH_ENV_VARS
        .iter()
        .copied()
        .filter(|var| seen.contains(var))
        .collect()
}

/// The auth variables set in this process's own environment, by name.
fn own_auth_vars() -> Vec<&'static str> {
    AUTH_ENV_VARS
        .iter()
        .copied()
        .filter(|var| std::env::var_os(var).is_some_and(|v| !v.is_empty()))
        .collect()
}

/// The auth variables the card's shell would carry, by name only ([B05]).
///
/// Sessions strip these, but `claude` run in the card's shell — or the user's
/// terminal — uses them, so a shell that sets one runs a different login than
/// a session does. The card's shell is the user's `$SHELL` spawned
/// interactive-login, so its rc files are what set them; the reading spawns
/// the same shell the same way and asks it which names are set. Tug never
/// reads a value and never edits the shell. A shell that cannot answer in
/// time falls back to tugcast's own environment, which the shell inherits.
pub async fn shell_auth_vars() -> Vec<&'static str> {
    let Some(shell) = std::env::var_os("SHELL").filter(|s| !s.is_empty()) else {
        return own_auth_vars();
    };
    let mut cmd = Command::new(shell);
    cmd.arg("-ilc")
        .arg(shell_auth_script())
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(SHELL_AUTH_PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) if String::from_utf8_lossy(&output.stdout).contains(SHELL_AUTH_MARKER) => {
            parse_shell_auth_vars(&String::from_utf8_lossy(&output.stdout))
        }
        _ => own_auth_vars(),
    }
}

/// The bounded probe itself, over a command the caller supplies.
///
/// Split out from [`probe`] so a test can point it at a command that never
/// answers and watch it come back anyway — which is the claim, and which no
/// test could make against a function that resolves its own executable.
async fn probe_command(mut cmd: Command, timeout: std::time::Duration) -> AuthState {
    let started = std::time::Instant::now();
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) => {
            // The files beside the status are read off the async runtime: the
            // Claude config file can run to megabytes on a long-used machine.
            let facts = tokio::task::spawn_blocking(LocalFacts::read)
                .await
                .unwrap_or_default();
            parse_status(&String::from_utf8_lossy(&output.stdout), &facts)
        }
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
/// The [`LocalFacts`] name the source where the status alone cannot.
fn parse_status(stdout: &str, facts: &LocalFacts) -> AuthState {
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(rename = "loggedIn")]
        logged_in: bool,
        email: Option<String>,
        #[serde(rename = "subscriptionType")]
        subscription_type: Option<String>,
        #[serde(rename = "authMethod")]
        auth_method: Option<String>,
        #[serde(rename = "apiKeySource")]
        api_key_source: Option<String>,
        #[serde(rename = "orgName")]
        org_name: Option<String>,
        #[serde(rename = "planTier")]
        plan_tier: Option<String>,
    }
    match serde_json::from_str::<Raw>(stdout.trim()) {
        Ok(raw) if raw.logged_in => AuthState::LoggedIn(AccountInfo {
            source: source_of(
                raw.auth_method.as_deref(),
                raw.api_key_source.as_deref(),
                facts,
            ),
            email: raw.email,
            subscription_type: raw.subscription_type,
            auth_method: raw.auth_method,
            api_key_source: raw.api_key_source,
            org_name: raw.org_name,
            plan_tier: raw.plan_tier,
            profile: facts.profile.clone().map(Box::new),
            subscription_stored: facts.subscription_stored,
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

/// What one `claude auth logout` did: its own success, its exit code, and
/// the tail of what it printed, kept so the log can answer "why did it fail"
/// afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogoutOutcome {
    pub ok: bool,
    /// `None` when the command could not be run, or ended on a signal.
    pub exit_code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    /// What the user is told when it failed: the last line of stderr, or of
    /// stdout when stderr is empty.
    pub error: Option<String>,
}

/// How much of each stream the log keeps.
const LOGOUT_TAIL_LINES: usize = 3;

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().lines().collect();
    let start = lines.len().saturating_sub(LOGOUT_TAIL_LINES);
    scrub_text(&lines[start..].join(" | ")).into_owned()
}

fn logout_outcome(
    success: bool,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> LogoutOutcome {
    let last = |s: &str| {
        s.trim()
            .lines()
            .last()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
    };
    LogoutOutcome {
        ok: success,
        exit_code,
        stdout_tail: tail(stdout),
        stderr_tail: tail(stderr),
        error: (!success).then(|| {
            last(stderr)
                .or_else(|| last(stdout))
                .map(|l| scrub_text(&l).into_owned())
                .unwrap_or_else(|| "logout failed".to_string())
        }),
    }
}

/// Drive `claude auth logout` and report what it did. Unlike [`login`], the
/// command's own success matters: a failed logout must surface as an error
/// rather than a silent no-op, so the caller (`claude_logout`) can tell the
/// user it didn't work instead of pretending they're logged out. The caller
/// re-probes afterward to broadcast the authoritative auth state, and logs
/// the outcome beside the source before and after.
pub async fn logout() -> LogoutOutcome {
    match claude_command(&["auth", "logout"]).output().await {
        Ok(out) => logout_outcome(
            out.status.success(),
            out.status.code(),
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
        ),
        Err(e) => LogoutOutcome {
            ok: false,
            exit_code: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            error: Some(e.to_string()),
        },
    }
}

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

/// The newest Claude Code release, or `None` when the lookup fails (offline,
/// unsupported region, unexpected content).
///
/// Asked of the same `latest` channel, through the same function, as the
/// download behind the row's Update button
/// ([`super::claude_download::latest_version`]), so "up to date" means up to
/// date with what pressing Update would install. Only the patience differs:
/// the row is informational and gives up sooner than a download does.
pub async fn latest_version() -> Option<String> {
    super::claude_download::latest_version(
        super::claude_download::DOWNLOAD_BASE_URL,
        LATEST_VERSION_TIMEOUT,
    )
    .await
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

    use std::collections::HashMap;

    fn no_facts() -> LocalFacts {
        LocalFacts::default()
    }

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
            "subscriptionType": "max",
            "storedClaudeAiLogin": true,
            "planTier": "max_20x"
        }"#;
        let facts = LocalFacts {
            subscription_stored: true,
            ..LocalFacts::default()
        };
        assert_eq!(
            parse_status(json, &facts),
            AuthState::LoggedIn(AccountInfo {
                email: Some("user@example.com".to_string()),
                subscription_type: Some("max".to_string()),
                auth_method: Some("claude.ai".to_string()),
                api_key_source: None,
                org_name: Some("Org".to_string()),
                plan_tier: Some("max_20x".to_string()),
                source: LoginSource::Subscription,
                profile: None,
                subscription_stored: true,
            })
        );
    }

    #[test]
    fn logged_out_when_flag_false() {
        assert_eq!(
            parse_status(r#"{"loggedIn": false}"#, &no_facts()),
            AuthState::LoggedOut
        );
    }

    #[test]
    fn logged_out_when_unparseable() {
        assert_eq!(
            parse_status("not json at all", &no_facts()),
            AuthState::LoggedOut
        );
    }

    /// `claude auth status --json` as Claude Code 2.1.325 printed it for each
    /// login source, alone and in the pairs that decide precedence. Recorded
    /// with fake credentials; the live CLI is never run here.
    const STATUS_ROWS: &str = include_str!("../../tests/fixtures/claude-auth-status/rows.json");

    /// One row of the precedence table: its name, whether it is logged in,
    /// the `authMethod`, the `apiKeySource`, whether the subscription's
    /// fields came with it, and the source Tug names.
    type PrecedenceRow = (
        &'static str,
        bool,
        &'static str,
        Option<&'static str>,
        bool,
        Option<LoginSource>,
    );

    /// The precedence table as `auth status` reports it, one entry per
    /// recorded row: whether it is logged in, the `authMethod`, the
    /// `apiKeySource` (absent for every OAuth-style source), whether the
    /// subscription's own fields came with it, and the source Tug names once
    /// the files beside the status are read. Three rows report an identical
    /// `oauth_token` with no `apiKeySource` — an auth token, a long-lived
    /// OAuth token, and a Console profile — which is why the method alone can
    /// never name the source. A subscription overridden by a key reports none
    /// of the subscription's fields, so the status alone cannot say one is
    /// stored underneath. The long-lived OAuth token is named `Unknown`:
    /// the probe scrubs it, and a settings `env` block does not honour it,
    /// so the probe never meets it and nothing on disk could name it.
    #[rustfmt::skip]
    const PRECEDENCE: [PrecedenceRow; 11] = [
        ("helper", true, "api_key_helper", Some("apiKeyHelper"), false, Some(LoginSource::SettingsHelper)),
        ("helper-and-key", true, "api_key_helper", Some("ANTHROPIC_API_KEY"), false, Some(LoginSource::SettingsHelper)),
        ("auth-token", true, "oauth_token", None, false, Some(LoginSource::EnvironmentToken)),
        ("auth-token-and-key", true, "oauth_token", Some("ANTHROPIC_API_KEY"), false, Some(LoginSource::EnvironmentToken)),
        ("api-key", true, "api_key", Some("ANTHROPIC_API_KEY"), false, Some(LoginSource::EnvironmentKey)),
        ("subscription-and-key", true, "api_key", Some("ANTHROPIC_API_KEY"), false, Some(LoginSource::EnvironmentKey)),
        ("oauth-token", true, "oauth_token", None, false, Some(LoginSource::Unknown)),
        ("subscription", true, "claude.ai", None, true, Some(LoginSource::Subscription)),
        ("subscription-and-profile", true, "claude.ai", None, true, Some(LoginSource::Subscription)),
        ("console-profile", true, "oauth_token", None, false, Some(LoginSource::ConsoleProfile)),
        ("none", false, "none", None, false, None),
    ];

    fn logged_in(source: LoginSource, api_key_source: Option<&str>) -> AuthState {
        AuthState::LoggedIn(AccountInfo {
            auth_method: Some("oauth_token".to_string()),
            api_key_source: api_key_source.map(str::to_string),
            org_name: Some("Example Org".to_string()),
            source,
            profile: Some(Box::new(a_profile())),
            ..AccountInfo::default()
        })
    }

    #[test]
    fn a_subscription_or_an_unknown_answer_is_not_a_paid_login() {
        let none = SettingsAuth::default();
        assert_eq!(
            paid_login_of(&logged_in(LoginSource::Subscription, None), none),
            None
        );
        assert_eq!(paid_login_of(&AuthState::Unknown, none), None);
        assert_eq!(paid_login_of(&AuthState::LoggedOut, none), None);
    }

    #[test]
    fn a_paid_login_is_remembered_by_its_source_and_what_names_it() {
        let none = SettingsAuth::default();
        let profile = paid_login_of(&logged_in(LoginSource::ConsoleProfile, None), none).unwrap();
        assert_eq!(profile.identity, "console_profile:default:org");
        assert_eq!(profile.login_source, "console_profile");
        assert_eq!(profile.profile_name.as_deref(), Some("default"));
        assert_eq!(profile.org_name.as_deref(), Some("Example Org"));
        assert!(!profile.from_project);
        let key = paid_login_of(
            &logged_in(LoginSource::EnvironmentKey, Some("ANTHROPIC_API_KEY")),
            none,
        )
        .unwrap();
        assert_eq!(key.identity, "environment_key:ANTHROPIC_API_KEY");
        // Two sources at once are one login, since a request carries both.
        let both = paid_login_of(
            &logged_in(LoginSource::SettingsHelper, Some("ANTHROPIC_API_KEY")),
            none,
        )
        .unwrap();
        assert_eq!(
            both.identity,
            "settings_helper+environment_key:ANTHROPIC_API_KEY"
        );
        assert_ne!(both.identity, key.identity);
        // A lone helper reports itself as the key source; no key rides with it.
        let helper = paid_login_of(
            &logged_in(LoginSource::SettingsHelper, Some("apiKeyHelper")),
            none,
        )
        .unwrap();
        assert_eq!(helper.identity, "settings_helper");
    }

    #[test]
    fn a_project_env_block_outranks_what_the_probe_saw() {
        // `auth status` cannot see a project's `env` block, and sessions use
        // it, so a subscription answer does not stand over one.
        let project = SettingsAuth {
            api_key: true,
            ..SettingsAuth::default()
        };
        let login = paid_login_of(&logged_in(LoginSource::Subscription, None), project).unwrap();
        assert_eq!(login.identity, "environment_key:ANTHROPIC_API_KEY");
        assert!(login.from_project);
        let both = SettingsAuth {
            api_key: true,
            auth_token: true,
            helper: false,
        };
        let login = paid_login_of(&AuthState::LoggedOut, both).unwrap();
        assert_eq!(login.login_source, "environment_token");
        assert_eq!(
            login.identity,
            "environment_token+environment_key:ANTHROPIC_API_KEY"
        );
    }

    #[test]
    fn settings_auth_reads_names_and_only_names() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"env":{"ANTHROPIC_API_KEY":"fake-key","OTHER":"x"}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("settings.local.json"),
            r#"{"apiKeyHelper":"echo fake","env":{"ANTHROPIC_AUTH_TOKEN":""}}"#,
        )
        .unwrap();
        let auth = SettingsAuth::of_project(tmp.path());
        // An empty value reads as unset, as it does to Claude Code.
        assert_eq!(
            auth,
            SettingsAuth {
                api_key: true,
                auth_token: false,
                helper: true
            }
        );
        assert_eq!(
            SettingsAuth::of_project(&tmp.path().join("absent")),
            SettingsAuth::default()
        );
    }

    #[test]
    fn only_files_that_show_a_plain_subscription_skip_the_probe() {
        let stored = LocalFacts {
            subscription_stored: true,
            ..LocalFacts::default()
        };
        let none = SettingsAuth::default();
        assert!(plainly_subscription(&stored, none, none));
        // A profile beneath a stored subscription does not outrank it.
        let with_profile = LocalFacts {
            profile: Some(a_profile()),
            ..stored.clone()
        };
        assert!(plainly_subscription(&with_profile, none, none));
        let helper = SettingsAuth {
            helper: true,
            ..none
        };
        assert!(!plainly_subscription(&stored, helper, none));
        assert!(!plainly_subscription(&stored, none, helper));
        assert!(!plainly_subscription(&LocalFacts::default(), none, none));
        let token = LocalFacts {
            settings_auth_token: true,
            ..stored
        };
        assert!(!plainly_subscription(&token, none, none));
    }

    fn a_profile() -> ConsoleProfile {
        ConsoleProfile {
            name: "default".to_string(),
            config_dir: PathBuf::from("/tmp/anthropic"),
            auth_type: Some("user_oauth".to_string()),
            organization_id: Some("org".to_string()),
            workspace_id: Some("ws".to_string()),
        }
    }

    /// The facts a row's sources put on disk: a profile, a settings-borne
    /// auth token (the only way the probe can meet one), a stored login.
    fn facts_for(sources: &[serde_json::Value]) -> LocalFacts {
        let has = |name: &str| sources.iter().any(|s| s == name);
        LocalFacts {
            profile: has("console-profile").then(a_profile),
            settings_auth_token: has("ANTHROPIC_AUTH_TOKEN"),
            subscription_stored: has("subscription"),
        }
    }

    #[test]
    fn every_recorded_status_row_parses_to_its_precedence_entry() {
        let doc: serde_json::Value = serde_json::from_str(STATUS_ROWS).expect("fixture is JSON");
        let rows = doc["rows"].as_object().expect("rows object");
        assert_eq!(
            rows.len(),
            PRECEDENCE.len(),
            "every recorded row has a precedence entry, and no entry is unrecorded"
        );
        for (name, logged_in, method, key_source, subscription_fields, source) in PRECEDENCE {
            let row = &rows[name];
            assert!(row.is_object(), "{name}: no recorded row");
            let stdout = &row["stdout"];
            assert_eq!(stdout["authMethod"], method, "{name}: authMethod");
            assert_eq!(
                stdout["apiKeySource"].as_str(),
                key_source,
                "{name}: apiKeySource"
            );
            assert_eq!(
                row["exit"].as_i64(),
                Some(if logged_in { 0 } else { 1 }),
                "{name}: a logged-out status exits 1"
            );
            assert_eq!(
                stdout["storedClaudeAiLogin"].as_bool().unwrap_or(false),
                subscription_fields,
                "{name}: storedClaudeAiLogin"
            );
            let facts = facts_for(row["sources"].as_array().expect("sources"));
            match parse_status(&stdout.to_string(), &facts) {
                AuthState::LoggedIn(info) => {
                    assert!(logged_in, "{name}: parsed as logged in");
                    assert_eq!(
                        info.auth_method.as_deref(),
                        Some(method),
                        "{name}: parsed method"
                    );
                    assert_eq!(
                        info.api_key_source.as_deref(),
                        key_source,
                        "{name}: key source"
                    );
                    assert_eq!(info.email.is_some(), subscription_fields, "{name}: email");
                    assert_eq!(info.org_name.is_some(), subscription_fields, "{name}: org");
                    assert_eq!(
                        info.plan_tier.is_some(),
                        subscription_fields,
                        "{name}: tier"
                    );
                    assert_eq!(
                        info.subscription_type.is_some(),
                        subscription_fields,
                        "{name}: subscription type"
                    );
                    assert_eq!(Some(info.source), source, "{name}: source");
                    assert_eq!(info.subscription_stored, facts.subscription_stored);
                    assert_eq!(
                        info.profile.as_deref(),
                        facts.profile.as_ref(),
                        "{name}: profile"
                    );
                }
                AuthState::LoggedOut => {
                    assert!(!logged_in, "{name}: parsed as logged out");
                    assert_eq!(source, None, "{name}: a logged-out row names no source");
                }
                other => panic!("{name}: parsed as {other:?}"),
            }
        }
    }

    #[test]
    fn an_oauth_token_is_a_settings_token_before_a_profile() {
        // A settings-borne auth token outranks a profile, as the variable it
        // sets does; with neither, Tug names nothing rather than guessing.
        let both = LocalFacts {
            profile: Some(a_profile()),
            settings_auth_token: true,
            ..LocalFacts::default()
        };
        assert_eq!(
            source_of(Some("oauth_token"), None, &both),
            LoginSource::EnvironmentToken
        );
        let profile_only = LocalFacts {
            profile: Some(a_profile()),
            ..LocalFacts::default()
        };
        assert_eq!(
            source_of(Some("oauth_token"), None, &profile_only),
            LoginSource::ConsoleProfile
        );
        assert_eq!(
            source_of(Some("oauth_token"), None, &no_facts()),
            LoginSource::Unknown
        );
        // A method the CLI adds later is unknown, not a subscription.
        assert_eq!(
            source_of(Some("bedrock"), None, &no_facts()),
            LoginSource::Unknown
        );
    }

    /// An environment for [`LocalFacts::read_from`] and [`console_profile`].
    fn env_of(pairs: &[(&str, &Path)]) -> impl Fn(&str) -> Option<OsString> + use<> {
        let map: HashMap<String, OsString> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.as_os_str().to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    /// Lay out an `ant` config dir with one profile and, optionally, a
    /// credentials file of the given contents.
    fn ant_dir(root: &Path, active: &str, creds: Option<&str>) -> PathBuf {
        let dir = root.join("anthropic");
        std::fs::create_dir_all(dir.join("configs")).unwrap();
        std::fs::create_dir_all(dir.join("credentials")).unwrap();
        std::fs::write(dir.join("active_config"), format!("{active}\n")).unwrap();
        std::fs::write(
            dir.join("configs").join(format!("{active}.json")),
            r#"{"authentication":{"type":"user_oauth"},"organization_id":"org-1","workspace_id":"ws-1"}"#,
        )
        .unwrap();
        if let Some(creds) = creds {
            std::fs::write(
                dir.join("credentials").join(format!("{active}.json")),
                creds,
            )
            .unwrap();
        }
        dir
    }

    #[test]
    fn a_profile_is_found_by_the_ant_convention() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = ant_dir(tmp.path(), "default", Some("{}"));
        let profile = console_profile(&env_of(&[("ANTHROPIC_CONFIG_DIR", &dir)]), None)
            .expect("a profile with a non-empty credentials file");
        assert_eq!(profile.name, "default");
        assert_eq!(profile.config_dir, dir);
        assert_eq!(profile.auth_type.as_deref(), Some("user_oauth"));
        assert_eq!(profile.organization_id.as_deref(), Some("org-1"));
        assert_eq!(profile.workspace_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn the_config_dir_falls_back_through_xdg_then_home() {
        let tmp = tempfile::tempdir().unwrap();
        ant_dir(tmp.path(), "default", Some("{}"));
        // `$XDG_CONFIG_HOME/anthropic`.
        assert!(console_profile(&env_of(&[("XDG_CONFIG_HOME", tmp.path())]), None).is_some());
        // `~/.config/anthropic`, and an empty `ANTHROPIC_CONFIG_DIR` reads as unset.
        let home = tempfile::tempdir().unwrap();
        ant_dir(&home.path().join(".config"), "default", Some("{}"));
        let empty = PathBuf::new();
        assert!(
            console_profile(
                &env_of(&[("ANTHROPIC_CONFIG_DIR", &empty)]),
                Some(home.path())
            )
            .is_some()
        );
    }

    #[test]
    fn a_profile_with_no_token_is_not_a_login() {
        // `ant auth logout` deletes the credentials file and leaves the rest,
        // and Claude Code counts a profile only when the file has content.
        let tmp = tempfile::tempdir().unwrap();
        let missing = ant_dir(&tmp.path().join("a"), "default", None);
        assert_eq!(
            console_profile(&env_of(&[("ANTHROPIC_CONFIG_DIR", &missing)]), None),
            None
        );
        let empty = ant_dir(&tmp.path().join("b"), "default", Some(""));
        assert_eq!(
            console_profile(&env_of(&[("ANTHROPIC_CONFIG_DIR", &empty)]), None),
            None
        );
    }

    #[test]
    fn the_profile_variable_names_the_profile() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = ant_dir(tmp.path(), "default", Some("{}"));
        let other = PathBuf::from("nosuch");
        let env = env_of(&[
            ("ANTHROPIC_CONFIG_DIR", &dir),
            ("ANTHROPIC_PROFILE", &other),
        ]);
        assert_eq!(
            console_profile(&env, None),
            None,
            "a profile with no config"
        );
        let escape = PathBuf::from("../default");
        let env = env_of(&[
            ("ANTHROPIC_CONFIG_DIR", &dir),
            ("ANTHROPIC_PROFILE", &escape),
        ]);
        assert_eq!(
            console_profile(&env, None),
            None,
            "a name is one path component"
        );
    }

    #[test]
    fn a_credentials_path_in_the_config_is_where_the_token_is() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = ant_dir(tmp.path(), "work", None);
        let elsewhere = tmp.path().join("token.json");
        std::fs::write(&elsewhere, "{}").unwrap();
        std::fs::write(
            dir.join("configs/work.json"),
            serde_json::json!({
                "authentication": {"type": "user_oauth", "credentials_path": elsewhere},
            })
            .to_string(),
        )
        .unwrap();
        let profile = console_profile(&env_of(&[("ANTHROPIC_CONFIG_DIR", &dir)]), None);
        assert_eq!(profile.map(|p| p.name), Some("work".to_string()));
    }

    #[test]
    fn local_facts_read_the_claude_config_and_settings() {
        // With `CLAUDE_CONFIG_DIR` set, both files live inside it.
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().join("claude");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(
            cfg.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"x"}}"#,
        )
        .unwrap();
        std::fs::write(
            cfg.join("settings.json"),
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"t"}}"#,
        )
        .unwrap();
        let none = tmp.path().join("no-ant");
        let facts = LocalFacts::read_from(
            &env_of(&[("CLAUDE_CONFIG_DIR", &cfg), ("ANTHROPIC_CONFIG_DIR", &none)]),
            None,
        );
        assert!(facts.subscription_stored);
        assert!(facts.settings_auth_token);
        assert_eq!(facts.profile, None);

        // Otherwise the config file is `~/.claude.json`, beside `~/.claude/`,
        // and a logged-out config carries no `oauthAccount`.
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(home.path().join(".claude.json"), r#"{"oauthAccount":null}"#).unwrap();
        std::fs::write(home.path().join(".claude/settings.json"), r#"{"env":{}}"#).unwrap();
        let facts = LocalFacts::read_from(&env_of(&[]), Some(home.path()));
        assert_eq!(facts, LocalFacts::default());
    }

    #[test]
    fn a_failed_logout_says_why_from_stderr_then_stdout() {
        let failed = logout_outcome(
            false,
            Some(1),
            "",
            "warming up\nLogout failed: keychain locked\n",
        );
        assert_eq!(
            failed.error.as_deref(),
            Some("Logout failed: keychain locked")
        );
        assert_eq!(failed.exit_code, Some(1));
        // The CLI sometimes says it only on stdout.
        let quiet = logout_outcome(false, Some(1), "Logout failed: no login\n", "  \n");
        assert_eq!(quiet.error.as_deref(), Some("Logout failed: no login"));
        let silent = logout_outcome(false, None, "", "");
        assert_eq!(silent.error.as_deref(), Some("logout failed"));
        let ok = logout_outcome(true, Some(0), "Successfully logged out\n", "");
        assert_eq!(ok.error, None);
        assert_eq!(ok.stdout_tail, "Successfully logged out");
    }

    #[test]
    fn the_logged_tail_is_the_last_lines() {
        let out = logout_outcome(true, Some(0), "one\ntwo\nthree\nfour\n", "");
        assert_eq!(out.stdout_tail, "two | three | four");
    }

    #[test]
    fn the_shell_reading_ignores_what_an_rc_file_prints() {
        // An rc file may print anything on startup, the names included; only
        // what follows the last marker counts, and only the known names.
        let out = format!(
            "Welcome! ANTHROPIC_API_KEY\n{SHELL_AUTH_MARKER}\nCLAUDE_CODE_OAUTH_TOKEN\nANTHROPIC_AUTH_TOKEN\nsomething else\n"
        );
        assert_eq!(
            parse_shell_auth_vars(&out),
            vec!["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
        );
        assert!(parse_shell_auth_vars("ANTHROPIC_API_KEY\n").is_empty());
        assert!(parse_shell_auth_vars(&format!("{SHELL_AUTH_MARKER}\n")).is_empty());
    }

    #[tokio::test]
    async fn the_shell_names_its_auth_variables_and_never_their_values() {
        // The script run by a real shell over a fake environment: a set
        // variable is named, an empty one is not, and no value is printed.
        // The environment is cleared so the shell never reads the developer's.
        let home = tempfile::tempdir().unwrap();
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(shell_auth_script())
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", home.path())
            .env("ANTHROPIC_AUTH_TOKEN", "fake-token-value")
            .env("ANTHROPIC_API_KEY", "")
            .output()
            .await
            .expect("sh runs");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            !stdout.contains("fake-token-value"),
            "a value was printed: {stdout}"
        );
        assert_eq!(parse_shell_auth_vars(&stdout), vec!["ANTHROPIC_AUTH_TOKEN"]);
    }

    #[tokio::test]
    async fn a_probe_that_never_answers_is_unknown_not_logged_out() {
        // The whole claim of the bound: a command that would run for half a
        // minute comes back with `Unknown`. An unbounded `output().await`
        // would sit here for thirty seconds, and the arm it used to resolve to
        // would have told the user they were signed out.
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let state = probe_command(cmd, std::time::Duration::from_millis(200)).await;
        assert_eq!(state, AuthState::Unknown);
    }

    #[tokio::test]
    async fn a_definite_answer_is_unchanged_by_the_bound() {
        // The bound must not change what a command that *does* answer means.
        // Valid output still reads `LoggedIn`, and malformed output still reads
        // `LoggedOut` — only silence became a third thing.
        let mut ok = Command::new("printf");
        ok.arg(r#"{"loggedIn": true, "email": "user@example.com"}"#);
        // Only the parsed fields are compared: the facts the probe reads
        // beside the status are this machine's, not the test's.
        match probe_command(ok, std::time::Duration::from_secs(20)).await {
            AuthState::LoggedIn(info) => {
                assert_eq!(info.email.as_deref(), Some("user@example.com"));
                assert_eq!(info.subscription_type, None);
                assert_eq!(info.auth_method, None);
                assert_eq!(info.source, LoginSource::Unknown);
            }
            other => panic!("a valid answer parsed as {other:?}"),
        }

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

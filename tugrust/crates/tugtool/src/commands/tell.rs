//! Implementation of the tugcode tell command

use crate::output::{JsonIssue, JsonResponse, TellData};
use serde_json::Value;

/// Coerce a string value to an appropriate JSON type
///
/// Rules (first match wins):
/// 1. exact "true" -> Bool(true), exact "false" -> Bool(false)
/// 2. exact "null" -> Null
/// 3. if parses as i64 AND no leading zeros -> Number(i64)
/// 4. if parses as f64 AND finite AND no leading zeros -> Number(f64)
/// 5. everything else -> String
fn coerce_value(s: &str) -> Value {
    // Rule 1: boolean
    if s == "true" {
        return Value::Bool(true);
    }
    if s == "false" {
        return Value::Bool(false);
    }

    // Rule 2: null
    if s == "null" {
        return Value::Null;
    }

    // Rule 3: integer (with leading zero check)
    if let Ok(n) = s.parse::<i64>() {
        // Reject leading zeros (except "-0" itself which is len 2)
        let has_leading_zero =
            (s.len() > 1 && s.starts_with('0')) || (s.len() > 2 && s.starts_with("-0"));
        if !has_leading_zero {
            return Value::Number(n.into());
        }
    }

    // Rule 4: float (with finite check and leading zero check)
    if let Ok(f) = s.parse::<f64>() {
        if f.is_finite() {
            // Check for leading zeros before decimal
            let stripped = s.strip_prefix('-').unwrap_or(s);
            // If first char is '0' and second char is a digit (not '.' or 'e'), reject
            if stripped.len() > 1 {
                let chars: Vec<char> = stripped.chars().collect();
                if chars[0] == '0' && chars[1].is_ascii_digit() {
                    return Value::String(s.to_string());
                }
            }
            // Valid float
            if let Some(num) = serde_json::Number::from_f64(f) {
                return Value::Number(num);
            }
        }
    }

    // Rule 5: string (fallback)
    Value::String(s.to_string())
}

/// Parse parameters from KEY=VALUE strings
fn parse_params(params: &[String]) -> Result<Vec<(String, Value)>, String> {
    let mut result = Vec::new();
    for param in params {
        let parts: Vec<&str> = param.splitn(2, '=').collect();
        if parts.len() != 2 {
            return Err(format!(
                "invalid parameter format: '{}', expected KEY=VALUE",
                param
            ));
        }
        let key = parts[0].to_string();
        let value = coerce_value(parts[1]);
        result.push((key, value));
    }
    Ok(result)
}

/// Why [`resolve_port`] could not name a tugcast.
///
/// Structured rather than pre-formatted because the remedy depends on the
/// calling command: only a command that declares `--instance`/`--port` may
/// tell the user to pass them. Rendering happens at the call site, through
/// [`PortError::describe`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PortError {
    /// The registry holds no live instance at all.
    NoInstances,
    /// A specific instance was named and is not live.
    NotFound(String),
    /// Several instances are live and nothing narrowed the choice.
    Ambiguous(Vec<String>),
    /// The registry itself could not be read.
    Registry(String),
}

/// Which disambiguating flags the calling command actually declares.
///
/// Naming a flag the command does not accept is worse than saying nothing:
/// the user follows the instruction and clap rejects it. `tugtool draft set`
/// did exactly that before it grew `--instance`.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub(crate) enum Remedy {
    /// The command declares both `--instance <id>` and `--port <p>`.
    Flags,
    /// The command declares neither; `TUG_INSTANCE` is the only lever.
    EnvOnly,
}

impl PortError {
    /// Render this failure with a remedy the calling command can honour.
    pub(crate) fn describe(&self, remedy: Remedy) -> String {
        let pass = match remedy {
            Remedy::Flags => "pass --instance <id>, --port <p>, or set TUG_INSTANCE",
            Remedy::EnvOnly => "set TUG_INSTANCE",
        };
        match self {
            PortError::NoInstances => format!("no Tug instances running; start one or {pass}"),
            PortError::NotFound(id) => format!("no live instance '{id}' in registry"),
            PortError::Ambiguous(ids) => {
                format!("multiple instances running ({}); {pass}", ids.join(", "))
            }
            PortError::Registry(e) => format!("registry read failed: {e}"),
        }
    }
}

/// Instance ids no automatic choice should ever land on: an app-test's own
/// throwaway instances. They are registered while a run is in flight, they
/// have no developer watching them, and they run against an isolated
/// `TUG_CHANGES_DB` — a write routed there vanishes with the run's tempdir.
/// An explicitly named one is still honoured; only the guesses skip them.
pub(crate) fn is_apptest_instance(id: &str) -> bool {
    id.starts_with("apptest-")
}

/// What a multi-instance registry means to the caller.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub(crate) enum Ambiguity {
    /// Ambiguity is an error — the command is instance-directed, and
    /// picking wrong is a bug (`tell` raises UI in one specific deck).
    Strict,
    /// Ambiguity is not a decision — the command's effect is identical
    /// whichever live instance serves it, so pick one deterministically.
    PickAny,
}

/// Resolve the tugcast port to talk to, per the [D09] CLI discovery
/// order:
/// 1. `--port <P>` (caller knows the exact port)
/// 2. `--instance <id>` (registry lookup by ID)
/// 3. `TUG_INSTANCE` env var (registry lookup by ID)
/// 4. cwd-derived dev instance (registry's path-prefix match, which
///    reaches through an arc worktree to its main checkout)
/// 5. sole-running instance (registry has exactly one entry)
/// 6. `ambiguity`: error with the list of running instances, or — for a
///    command whose write lands in the same machine-global place either
///    way — the lowest instance id.
pub(crate) fn resolve_port_with(
    explicit_port: Option<u16>,
    explicit_instance: Option<String>,
    ambiguity: Ambiguity,
) -> Result<u16, PortError> {
    if let Some(p) = explicit_port {
        return Ok(p);
    }
    let id_from_arg = explicit_instance.filter(|s| !s.is_empty());
    let id_from_env = std::env::var("TUG_INSTANCE").ok().filter(|s| !s.is_empty());
    let target_id = id_from_arg.or(id_from_env);
    if let Some(id) = target_id {
        return match tugcore::registry::find_by_id(&id) {
            Ok(Some(i)) => Ok(i.tugcast_port),
            Ok(None) => Err(PortError::NotFound(id)),
            Err(e) => Err(PortError::Registry(e.to_string())),
        };
    }
    if let Ok(cwd) = std::env::current_dir()
        && let Ok(Some(i)) = tugcore::registry::find_for_cwd(&cwd)
    {
        return Ok(i.tugcast_port);
    }
    let mut live = match tugcore::registry::list_live() {
        Ok(live) => live,
        Err(e) => return Err(PortError::Registry(e.to_string())),
    };
    if ambiguity == Ambiguity::PickAny && live.len() > 1 {
        live.retain(|i| !is_apptest_instance(&i.instance_id));
    }
    match live.as_slice() {
        [] => Err(PortError::NoInstances),
        [only] => Ok(only.tugcast_port),
        _ if ambiguity == Ambiguity::PickAny => {
            // Deterministic so repeated runs from the same shell keep
            // talking to the same tugcast — arbitrary, but not random.
            live.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
            Ok(live[0].tugcast_port)
        }
        _ => Err(PortError::Ambiguous(
            live.iter().map(|i| i.instance_id.clone()).collect(),
        )),
    }
}

/// [`resolve_port_with`] for instance-directed commands: ambiguity is an
/// error.
pub(crate) fn resolve_port(
    explicit_port: Option<u16>,
    explicit_instance: Option<String>,
) -> Result<u16, PortError> {
    resolve_port_with(explicit_port, explicit_instance, Ambiguity::Strict)
}

/// [`resolve_port_with`] for commands whose outcome does not depend on
/// which live instance serves them — the machine-global ledger writes.
pub(crate) fn resolve_port_any(
    explicit_port: Option<u16>,
    explicit_instance: Option<String>,
) -> Result<u16, PortError> {
    resolve_port_with(explicit_port, explicit_instance, Ambiguity::PickAny)
}

/// Post a tell and report the outcome without writing to any output surface.
///
/// [`run_tell`] is the verb, and a verb owns stdout. A tell sent from *inside*
/// another verb — the `wire trip` nudge — does not: its caller has an envelope
/// to print, and a stray `ok` line ahead of that envelope is not a message, it
/// is a parse error for whoever reads the verb's JSON.
pub(crate) fn tell_quietly(action: &str, params: &[String]) -> Result<(), String> {
    let port = resolve_port(None, None).map_err(|e| e.describe(Remedy::Flags))?;
    let mut body = serde_json::json!({ "action": action });
    for (key, value) in parse_params(params)? {
        body[key] = value;
    }
    let response = ureq::post(&format!("http://127.0.0.1:{port}/api/tell"))
        .send_json(body)
        .map_err(|e| format!("connection failed: {e}"))?;
    let status_code = response.status().as_u16();
    if status_code == 200 {
        Ok(())
    } else {
        Err(format!("server returned status {status_code}"))
    }
}

/// Run the tell command
pub fn run_tell(
    action: String,
    port: Option<u16>,
    instance: Option<String>,
    params: Vec<String>,
    json_output: bool,
) -> Result<i32, String> {
    let port = match resolve_port(port, instance).map_err(|e| e.describe(Remedy::Flags)) {
        Ok(p) => p,
        Err(e) => {
            if json_output {
                let response = JsonResponse::error(
                    "tell",
                    TellData {
                        server_status: "error".to_string(),
                    },
                    vec![JsonIssue {
                        code: "E099".to_string(),
                        severity: "error".to_string(),
                        message: e.clone(),
                        file: None,
                        line: None,
                        anchor: None,
                    }],
                );
                println!("{}", serde_json::to_string_pretty(&response).unwrap());
                return Ok(1);
            } else {
                return Err(e);
            }
        }
    };
    // Parse parameters
    let parsed_params = match parse_params(&params) {
        Ok(p) => p,
        Err(e) => {
            if json_output {
                let response = JsonResponse::error(
                    "tell",
                    TellData {
                        server_status: "error".to_string(),
                    },
                    vec![JsonIssue {
                        code: "E099".to_string(),
                        severity: "error".to_string(),
                        message: e.clone(),
                        file: None,
                        line: None,
                        anchor: None,
                    }],
                );
                println!("{}", serde_json::to_string_pretty(&response).unwrap());
                return Ok(1);
            } else {
                return Err(e);
            }
        }
    };

    // Build JSON body
    let mut body = serde_json::json!({ "action": action });
    for (key, value) in parsed_params {
        body[key] = value;
    }

    // Build URL
    let url = format!("http://127.0.0.1:{}/api/tell", port);

    // POST request (ureq 3.x uses default timeouts)
    let response_result = ureq::post(&url).send_json(body);
    match response_result {
        Ok(response) => {
            let status_code = response.status().as_u16();
            if status_code == 200 {
                // Success
                if json_output {
                    let response = JsonResponse::ok(
                        "tell",
                        TellData {
                            server_status: "ok".to_string(),
                        },
                    );
                    println!("{}", serde_json::to_string_pretty(&response).unwrap());
                } else {
                    println!("ok");
                }
                Ok(0)
            } else {
                // HTTP error
                let msg = format!("server returned status {}", status_code);
                if json_output {
                    let response = JsonResponse::error(
                        "tell",
                        TellData {
                            server_status: "error".to_string(),
                        },
                        vec![JsonIssue {
                            code: "E099".to_string(),
                            severity: "error".to_string(),
                            message: msg,
                            file: None,
                            line: None,
                            anchor: None,
                        }],
                    );
                    println!("{}", serde_json::to_string_pretty(&response).unwrap());
                } else {
                    eprintln!("Error: {}", msg);
                }
                Ok(1)
            }
        }
        Err(e) => {
            // Transport error (connection refused, timeout, etc.)
            let msg = format!("connection failed: {}", e);
            if json_output {
                let response = JsonResponse::error(
                    "tell",
                    TellData {
                        server_status: "error".to_string(),
                    },
                    vec![JsonIssue {
                        code: "E099".to_string(),
                        severity: "error".to_string(),
                        message: msg.clone(),
                        file: None,
                        line: None,
                        anchor: None,
                    }],
                );
                println!("{}", serde_json::to_string_pretty(&response).unwrap());
                Ok(1)
            } else {
                Err(msg)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_coerce_true() {
        assert_eq!(coerce_value("true"), Value::Bool(true));
    }

    #[test]
    fn test_coerce_false() {
        assert_eq!(coerce_value("false"), Value::Bool(false));
    }

    #[test]
    fn test_coerce_null() {
        assert_eq!(coerce_value("null"), Value::Null);
    }

    #[test]
    fn test_coerce_integer() {
        assert_eq!(coerce_value("42"), serde_json::json!(42));
        assert_eq!(coerce_value("-42"), serde_json::json!(-42));
        assert_eq!(coerce_value("0"), serde_json::json!(0));
    }

    #[test]
    fn test_coerce_float() {
        assert_eq!(coerce_value("2.5"), serde_json::json!(2.5));
        assert_eq!(coerce_value("1e5"), serde_json::json!(100000.0));
        assert_eq!(coerce_value("-0.5"), serde_json::json!(-0.5));
    }

    #[test]
    fn test_coerce_string() {
        assert_eq!(coerce_value("hello"), Value::String("hello".to_string()));
        assert_eq!(coerce_value("TRUE"), Value::String("TRUE".to_string()));
    }

    #[test]
    fn test_coerce_leading_zero() {
        assert_eq!(coerce_value("01"), Value::String("01".to_string()));
        assert_eq!(coerce_value("007"), Value::String("007".to_string()));
        assert_eq!(coerce_value("01.5"), Value::String("01.5".to_string()));
    }

    #[test]
    fn test_coerce_empty() {
        assert_eq!(coerce_value(""), Value::String("".to_string()));
    }

    #[test]
    fn test_coerce_no_trim() {
        assert_eq!(coerce_value(" true "), Value::String(" true ".to_string()));
    }

    #[test]
    fn test_coerce_nan() {
        assert_eq!(coerce_value("NaN"), Value::String("NaN".to_string()));
    }

    #[test]
    fn test_coerce_infinity() {
        assert_eq!(
            coerce_value("Infinity"),
            Value::String("Infinity".to_string())
        );
    }

    #[test]
    fn test_coerce_negative_zero() {
        // "-0" has len 2, so the check (s.len() > 2 && s.starts_with("-0")) is false
        // It parses as i64 0
        assert_eq!(coerce_value("-0"), serde_json::json!(0));
    }

    #[test]
    fn test_parse_params_valid() {
        let params = vec!["component=about".to_string(), "enabled=true".to_string()];
        let result = parse_params(&params).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0, "component");
        assert_eq!(result[0].1, Value::String("about".to_string()));
        assert_eq!(result[1].0, "enabled");
        assert_eq!(result[1].1, Value::Bool(true));
    }

    #[test]
    fn test_parse_params_value_with_equals() {
        let params = vec!["path=/foo/bar=baz".to_string()];
        let result = parse_params(&params).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "path");
        assert_eq!(result[0].1, Value::String("/foo/bar=baz".to_string()));
    }

    #[test]
    fn test_parse_params_missing_equals() {
        let params = vec!["noequalssign".to_string()];
        let result = parse_params(&params);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid parameter format"));
    }

    // ── Port resolution tests ───────────────────────────────────────
    //
    // Resolution branches 1+2 are pure-functional (no env/registry
    // access on the explicit-port path; the explicit-instance path
    // does hit the live registry which is shared across tests in this
    // crate). The ambiguity branch is exercised against the real
    // `$TMPDIR` registry under `#[serial]`, snapshotting and restoring
    // the file — the cwd branch it sits behind is covered in `tugcore`.

    #[test]
    fn resolve_port_explicit_port_wins() {
        let r = resolve_port(Some(9999), Some("debug-foo".to_owned()));
        assert_eq!(r, Ok(9999));
    }

    #[test]
    fn resolve_port_explicit_port_wins_even_with_env() {
        let _g = ScopedEnv::set("TUG_INSTANCE", "anything");
        let r = resolve_port(Some(8888), None);
        assert_eq!(r, Ok(8888));
    }

    #[test]
    fn resolve_port_unknown_instance_errors() {
        let r = resolve_port(None, Some("does-not-exist-xyz-zzz".to_owned()));
        assert_eq!(r, Err(PortError::NotFound("does-not-exist-xyz-zzz".into())));
    }

    /// An error may only prescribe what the calling command accepts.
    /// `draft set` used to be told to "pass --instance" by a command
    /// that had no such flag — following the advice earned a clap error.
    #[test]
    fn port_error_names_only_the_remedies_the_command_offers() {
        let ambiguous = PortError::Ambiguous(vec!["release-main".into(), "debug-arc".into()]);
        let flags = ambiguous.describe(Remedy::Flags);
        assert!(flags.contains("release-main, debug-arc"), "{flags}");
        assert!(flags.contains("--instance <id>"), "{flags}");

        let env_only = ambiguous.describe(Remedy::EnvOnly);
        assert!(!env_only.contains("--instance"), "{env_only}");
        assert!(env_only.contains("TUG_INSTANCE"), "{env_only}");
    }

    /// Several live instances: an error for an instance-directed command,
    /// a deterministic choice for one whose write lands in the same
    /// machine-global ledger either way.
    #[test]
    #[serial]
    fn ambiguity_errors_for_tell_and_resolves_for_draft() {
        let _g = ScopedEnv::unset("TUG_INSTANCE");
        let _registry = ScopedRegistry::seed(&[
            ("debug-zulu", 55401),
            ("release-alpha", 55402),
            ("apptest-throwaway", 55403),
        ]);

        match resolve_port(None, None) {
            Err(PortError::Ambiguous(ids)) => {
                assert_eq!(ids.len(), 3, "every live instance is listed: {ids:?}");
            }
            other => panic!("expected ambiguity, got {other:?}"),
        }

        // Lowest id wins — `debug-zulu`, not `apptest-throwaway`, which
        // sorts first and is skipped: its ledger is a tempdir that dies
        // with the run, so a draft routed there would simply vanish.
        assert_eq!(resolve_port_any(None, None), Ok(55401));
    }

    /// The user's real `$TMPDIR` registry, replaced for the duration of
    /// one test and restored on drop. `find_by_id`/`list_live` read the
    /// public path, so there is nowhere else to put this.
    struct ScopedRegistry {
        path: std::path::PathBuf,
        prior: Option<Vec<u8>>,
    }

    impl ScopedRegistry {
        fn seed(instances: &[(&str, u16)]) -> Self {
            let path = tugcore::registry::registry_path();
            let prior = std::fs::read(&path).ok();
            let _ = std::fs::remove_file(&path);
            for (id, port) in instances {
                tugcore::registry::register(tugcore::registry::Instance {
                    instance_id: (*id).to_owned(),
                    profile: "debug".to_owned(),
                    branch: "main".to_owned(),
                    bundle_id: format!("dev.tugtool.app.{id}"),
                    // Nowhere near any cwd, so the cwd branch of
                    // discovery cannot pre-empt the ambiguity branch.
                    bundle_path: std::path::PathBuf::from("/nonexistent/Tug.app"),
                    pid: std::process::id() as i32,
                    host_pid: 0,
                    tugcast_port: *port,
                    vite_port: 0,
                    tmux_session: format!("cc-{id}"),
                    data_dir: std::path::PathBuf::from("/nonexistent/data"),
                    started_at: tugcore::registry::now_rfc3339(),
                })
                .expect("seed registry");
            }
            Self { path, prior }
        }
    }

    impl Drop for ScopedRegistry {
        fn drop(&mut self) {
            match &self.prior {
                Some(bytes) => {
                    let _ = std::fs::write(&self.path, bytes);
                }
                None => {
                    let _ = std::fs::remove_file(&self.path);
                }
            }
        }
    }

    /// Tiny env-restore helper local to these tests.
    struct ScopedEnv {
        key: &'static str,
        prior: Option<std::ffi::OsString>,
    }

    impl ScopedEnv {
        fn set(key: &'static str, value: &str) -> Self {
            let prior = std::env::var_os(key);
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, prior }
        }

        fn unset(key: &'static str) -> Self {
            let prior = std::env::var_os(key);
            unsafe {
                std::env::remove_var(key);
            }
            Self { key, prior }
        }
    }

    impl Drop for ScopedEnv {
        fn drop(&mut self) {
            unsafe {
                match &self.prior {
                    Some(v) => std::env::set_var(self.key, v),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }
}

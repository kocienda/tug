//! `tugutil hook` — the decisions behind the plugin's Claude Code hooks,
//! computed in the binary so the shell wrappers that ship in the app bundle
//! need nothing the bundle does not carry.
//!
//! The wrapper (`tugplug/hooks/pre-tool-use.sh`) locates this binary and
//! pipes the hook's JSON straight through. Everything else — parsing the
//! payload, the auto-approve prefixes, the file-ops gate — lives here, where
//! it is compiled, tested, and versioned with the grammar it answers from.
//!
//! Exit 0 always: the decision is the JSON on stdout, and an empty stdout
//! means "no opinion" — Claude Code falls through to its normal permission
//! flow. A hook that crashed would block work, so nothing here is allowed to.

use std::io::Read;
use std::path::PathBuf;

use clap::Subcommand;
use serde::Serialize;
use serde_json::Value;

use crate::changes::AppError;

use super::file::gate_decision;

#[derive(Subcommand)]
pub enum HookCommands {
    /// Answer a PreToolUse hook: read the hook's JSON payload from stdin and
    /// print the permission decision. Auto-approves the plugin's own skills
    /// and the read-only Bash prefixes; denies a Bash command whose file
    /// operations the change ledger cannot read; says nothing otherwise.
    PreToolUse,
}

pub fn run_hook(command: HookCommands) -> Result<(), AppError> {
    match command {
        HookCommands::PreToolUse => {
            let mut raw = String::new();
            if std::io::stdin().read_to_string(&mut raw).is_err() {
                return Ok(());
            }
            let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
                return Ok(());
            };
            if let Some(decision) = pre_tool_use(&payload) {
                println!("{}", decision.render());
            }
            Ok(())
        }
    }
}

/// Bash commands approved by prefix: read-only lookups, and the CLI whose
/// every verb prints its own receipt.
const APPROVED_BASH: &[&str] = &["grep", "ls", "find", "tugutil"];

/// Skills under this namespace are the plugin's own.
const PLUGIN_SKILL_PREFIX: &str = "tugplug:";

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow(&'static str),
    Deny(String),
}

impl Decision {
    fn render(&self) -> String {
        let (decision, reason) = match self {
            Decision::Allow(reason) => ("allow", reason.to_string()),
            Decision::Deny(reason) => ("deny", reason.clone()),
        };
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Specific<'a> {
            hook_event_name: &'a str,
            permission_decision: &'a str,
            permission_decision_reason: &'a str,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Output<'a> {
            hook_specific_output: Specific<'a>,
        }
        serde_json::to_string(&Output {
            hook_specific_output: Specific {
                hook_event_name: "PreToolUse",
                permission_decision: decision,
                permission_decision_reason: &reason,
            },
        })
        .unwrap_or_default()
    }
}

/// The decision for one PreToolUse payload, or `None` for "no opinion".
pub fn pre_tool_use(payload: &Value) -> Option<Decision> {
    let tool = payload.get("tool_name")?.as_str()?;
    let input = payload.get("tool_input")?;
    match tool {
        "Skill" => {
            let skill = input.get("skill")?.as_str()?;
            skill
                .starts_with(PLUGIN_SKILL_PREFIX)
                .then_some(Decision::Allow("tugplug skill"))
        }
        "Bash" => {
            let command = input.get("command")?.as_str()?;
            let trimmed = command.trim_start();
            let first = trimmed.split_whitespace().next().unwrap_or("");
            if APPROVED_BASH.contains(&first) {
                return Some(Decision::Allow("tugplug auto-approved"));
            }
            let base = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_default();
            let gate = gate_decision(command, &base);
            (gate.decision == "deny").then(|| {
                Decision::Deny(gate.reason.unwrap_or_else(|| {
                    "this command names no file the change ledger can resolve".to_string()
                }))
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bash(command: &str) -> Value {
        bash_in(command, "/tmp")
    }

    fn bash_in(command: &str, cwd: &str) -> Value {
        json!({ "tool_name": "Bash", "tool_input": { "command": command }, "cwd": cwd })
    }

    /// A real checkout, because the steer only fires on a path inside one.
    fn checkout() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp");
        let out = std::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .expect("git init");
        assert!(out.status.success());
        dir
    }

    #[test]
    fn plugin_skills_are_approved_and_foreign_ones_are_not() {
        let mine = json!({ "tool_name": "Skill", "tool_input": { "skill": "tugplug:dash" } });
        assert_eq!(pre_tool_use(&mine), Some(Decision::Allow("tugplug skill")));
        let theirs = json!({ "tool_name": "Skill", "tool_input": { "skill": "other:thing" } });
        assert_eq!(pre_tool_use(&theirs), None);
    }

    #[test]
    fn read_only_prefixes_are_approved_by_first_word_only() {
        assert!(matches!(
            pre_tool_use(&bash("  ls -la")),
            Some(Decision::Allow(_))
        ));
        assert!(matches!(
            pre_tool_use(&bash("tugutil changes --json")),
            Some(Decision::Allow(_))
        ));
        assert_eq!(pre_tool_use(&bash("lsof -i")), None);
        assert_eq!(pre_tool_use(&bash("cargo build")), None);
    }

    #[test]
    fn an_unreadable_write_is_denied_with_the_grammar_reason() {
        let dir = checkout();
        let cmd =
            "python3 - <<'PY'\nimport pathlib\npathlib.Path('src/main.tsx').write_text('x')\nPY";
        match pre_tool_use(&bash_in(cmd, &dir.path().to_string_lossy())) {
            Some(Decision::Deny(reason)) => {
                assert!(reason.contains("tugutil file edit"), "{reason}")
            }
            other => panic!("expected a deny, got {other:?}"),
        }
    }

    #[test]
    fn other_tools_and_malformed_payloads_yield_no_opinion() {
        assert_eq!(
            pre_tool_use(&json!({ "tool_name": "Read", "tool_input": {} })),
            None
        );
        assert_eq!(pre_tool_use(&json!({ "nope": 1 })), None);
    }

    #[test]
    fn the_rendered_json_is_what_claude_code_reads() {
        let out: Value = serde_json::from_str(&Decision::Allow("x").render()).unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(out["hookSpecificOutput"]["permissionDecisionReason"], "x");
    }
}

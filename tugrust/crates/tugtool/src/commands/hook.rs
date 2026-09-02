//! `tugtool hook` — the decisions behind the plugin's Claude Code hooks,
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
use tugchanges_core::shell_ops::{ParseOutcome, parse_shell_ops};

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
const APPROVED_BASH: &[&str] = &["grep", "ls", "find", "tugtool"];

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
    pre_tool_use_with(payload, turn_facts)
}

/// [`pre_tool_use`], with the turn boundary's one I/O call injected.
///
/// The boundary asks a running instance, and a unit test that asked one would
/// be asking the *developer's own card* about the developer's own turn — the
/// ambient-session hazard `common::tugtool` exists to close, met from inside
/// the process instead of from a spawn. So the ask is a parameter: the units
/// hand in an answer, and `tests/turn_boundary_cli.rs` drives the real round
/// trip against a stand-in tugcast, which is where it belongs.
pub(crate) fn pre_tool_use_with(
    payload: &Value,
    facts: impl FnOnce() -> TurnFacts,
) -> Option<Decision> {
    let tool = payload.get("tool_name")?.as_str()?;
    let input = payload.get("tool_input")?;
    // **The turn boundary comes first.** It is the only rule here that denies
    // what every other rule would allow — a repo write, or `dash step start`,
    // from an arc stage whose turn has already closed a step. Everything
    // else a stage may do at any time reaches this and is not a gesture, so
    // the server is not even asked (`gesture_of` answers `None` before any
    // round trip).
    if let Some(deny) = boundary_decision(payload, facts) {
        return Some(deny);
    }
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

// ---------------------------------------------------------------------------
// The turn boundary
// ---------------------------------------------------------------------------

/// What a tool call is about to do, in the only vocabulary the turn boundary
/// cares about: is this the *work* of a step, or something a stage may do at
/// any time?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Gesture {
    /// An `Edit`/`Write`/`MultiEdit`/`NotebookEdit` on a repo file.
    ToolWrite,
    /// A Bash command whose file operations the change grammar reads as writes
    /// — or cannot read at all, which the existing gate denies anyway.
    ShellWrite,
    /// `tugtool file edit|run|rm|mv|cp|probe`, or `tugedit`: a write wearing
    /// the CLI's name, and auto-approved by prefix everywhere else here.
    TugWrite,
    /// `tugtool arc step start` — opening the next step, which is the overrun
    /// in its purest form.
    StepStart,
}

impl Gesture {
    /// How the refusal names what it refused.
    fn named(self) -> &'static str {
        match self {
            Gesture::ToolWrite => "this edit",
            Gesture::ShellWrite => "this command's writes",
            Gesture::TugWrite => "this edit",
            Gesture::StepStart => "opening the next step",
        }
    }
}

/// The sentence a crossed boundary refuses with.
///
/// It names the gesture, the fact, and the one act that unblocks everything —
/// in that order, because a refusal that does not say what to do next is a
/// wall rather than a rail.
pub(crate) fn boundary_refusal(gesture: Gesture, step: u32) -> String {
    format!(
        "The turn boundary: step {step} closed this turn — end the turn; the arc prompts the \
         next step. {} belongs to the next turn. The Wheel acts only *between* turns, so pacing, \
         `/compact`, rotation and the idle clock are all locked out until this one ends. Report \
         the ledger state and stop.",
        capitalize(gesture.named())
    )
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Whether a path a write-shaped tool names is a **repo file** — the only kind
/// the boundary is about.
///
/// Scratch is not work: a stage writing outside its own working directory, or
/// into `target/`, is staging or building rather than walking the next step,
/// and refusing it would make the gate an obstacle rather than a rail.
///
/// Placement is **relative to the call's own `cwd`**, not by absolute prefix.
/// A scratch list of `/tmp`-shaped roots would be both wrong on other
/// platforms and wrong here — macOS puts every temp directory under
/// `/var/folders`, which is also where a fixture's whole checkout lives. What
/// the boundary actually means by "the work" is "inside the tree this call is
/// being made in", and that is one comparison with nothing to keep current.
pub(crate) fn is_repo_path(path: &str, cwd: Option<&str>) -> bool {
    if path.is_empty() {
        return false;
    }
    // A relative path with no cwd cannot be placed, and the boundary declines
    // to guess — which is the open direction, the only one a gate over
    // ordinary editing may fail in.
    let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
        return false;
    };
    let absolute = if path.starts_with('/') {
        PathBuf::from(path)
    } else {
        PathBuf::from(cwd).join(path)
    };
    absolute.starts_with(cwd)
        && absolute
            .components()
            .all(|c| c.as_os_str() != std::ffi::OsStr::new("target"))
}

/// The `tugtool`/`tugedit` invocations that write repo files, and the one that
/// opens a step.
///
/// Read off the argument list rather than the change grammar, because the
/// grammar reads `tugtool` as the CLI whose every verb prints its own receipt
/// — true, and beside the point once a turn has closed a step.
pub(crate) fn tug_gesture(command: &str) -> Option<Gesture> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let first = *words.first()?;
    if first == "tugedit" {
        return (!words.contains(&"--preview")).then_some(Gesture::TugWrite);
    }
    if first != "tugtool" {
        return None;
    }
    // Skip the global flags a verb may be reached through.
    let mut rest = words[1..].iter().copied().filter(|w| !w.starts_with('-'));
    match (rest.next(), rest.next(), rest.next(), rest.next()) {
        (Some("file"), Some("edit" | "run" | "rm" | "mv" | "cp" | "probe"), _, _) => {
            (!words.contains(&"--preview")).then_some(Gesture::TugWrite)
        }
        // `dash step <name> start` — the dash's name is the address, and it
        // sits between the noun and the verb.
        (Some("arc"), Some("step"), Some(_), Some("start")) => Some(Gesture::StepStart),
        _ => None,
    }
}

/// What this tool call would do, or `None` for a call the boundary has no
/// opinion about — every read, every status verb, `dash doctor`, the draft
/// verb, and anything the change grammar reads as touching no files.
pub(crate) fn gesture_of(payload: &Value) -> Option<Gesture> {
    let tool = payload.get("tool_name")?.as_str()?;
    let input = payload.get("tool_input")?;
    let cwd = payload.get("cwd").and_then(Value::as_str);
    match tool {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let path = input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            is_repo_path(path, cwd).then_some(Gesture::ToolWrite)
        }
        "Bash" => {
            let command = input.get("command")?.as_str()?;
            if let Some(gesture) = tug_gesture(command.trim_start()) {
                return Some(gesture);
            }
            let base = cwd
                .map(PathBuf::from)
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_default();
            match parse_shell_ops(command, &base) {
                ParseOutcome::Ops(ops) if !ops.is_empty() => Some(Gesture::ShellWrite),
                // A command the grammar refuses is denied on its own terms
                // anyway; naming the boundary first is the more actionable of
                // the two refusals, because ending the turn settles both.
                ParseOutcome::Unparseable { .. } => Some(Gesture::ShellWrite),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The server's answer about the calling turn, or the reason there is none.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TurnFacts {
    /// An arc stage whose current turn has already closed this step.
    ClosedStep(u32),
    /// Asked and answered: nothing to refuse over. Off an arc, or on one
    /// with the turn's step still open.
    Open,
    /// Nobody to ask — no calling session, no live instance, or an instance
    /// too old to know the op. **Degrades open, always.** A gate that bricked
    /// editing across a mixed install would cost more than the overrun it
    /// prevents (Part IV item 4).
    Unknown { skewed: bool },
}

/// Whether this process was spawned into an arc at all.
///
/// The gate's cheap pre-filter, and the reason it is worth having: without it
/// **every** edit on **every** Session card pays a localhost round trip to
/// find out that nothing is being paced. An arc stage's claude is spawned
/// with `TUG_ARC` (`buildClaudeSpawnEnv`), and a hook is claude's own
/// child, so it inherits.
///
/// It is a filter and not the answer. The variable is frozen at spawn like
/// every spawn-time variable, so it can outlive the arc it names — which is
/// why the server is still asked, and the server's `on_arc` is what
/// decides. What the filter may do wrong is go quiet on a stage whose spawn
/// carried no variable at all, and that direction is the open one, which is
/// the only one this gate may fail in.
fn spawned_into_an_arc() -> bool {
    std::env::var("TUG_ARC").is_ok_and(|value| !value.is_empty())
}

/// Ask the owning instance whether this turn has already closed a step.
fn turn_facts() -> TurnFacts {
    if !spawned_into_an_arc() {
        return TurnFacts::Open;
    }
    let answer = crate::session_identity::ask_about_calling_session(
        "turn_facts",
        "checking the arc's turn boundary",
        serde_json::json!({}),
    );
    match answer {
        None => TurnFacts::Unknown { skewed: false },
        Some(Err(message)) => TurnFacts::Unknown {
            skewed: message.contains("unknown op"),
        },
        Some(Ok(response)) => {
            if response.get("on_arc").and_then(Value::as_bool) != Some(true) {
                return TurnFacts::Open;
            }
            match response
                .get("step_closed_this_turn")
                .and_then(Value::as_u64)
            {
                Some(step) => TurnFacts::ClosedStep(step as u32),
                None => TurnFacts::Open,
            }
        }
    }
}

/// The boundary's verdict on one payload: `Some(deny)` only when an arc
/// stage that has already closed a step this turn reaches for the next one.
fn boundary_decision(payload: &Value, facts: impl FnOnce() -> TurnFacts) -> Option<Decision> {
    let gesture = gesture_of(payload)?;
    match facts() {
        TurnFacts::ClosedStep(step) => Some(Decision::Deny(boundary_refusal(gesture, step))),
        TurnFacts::Open => None,
        TurnFacts::Unknown { skewed } => {
            if skewed {
                warn_about_skew_once();
            }
            None
        }
    }
}

/// Say once, through a `systemMessage`, that the boundary gate is inactive
/// because the running instance predates it.
///
/// Once, because the alternative is a line on every edit for as long as the
/// app goes unrestarted. The stamp lives in this boot's temp directory, so the
/// notice returns after a reboot and after the restart that would fix it.
fn warn_about_skew_once() {
    let stamp = std::env::temp_dir().join("tug-turn-boundary-skew-warned");
    if stamp.exists() {
        return;
    }
    if std::fs::write(&stamp, b"1").is_err() {
        return;
    }
    println!(
        "{}",
        serde_json::json!({
            "systemMessage": "Tug: the running instance predates the arc turn-boundary op, \
                              so the boundary gate is inactive for this session. Restart Tug to \
                              enable it. Nothing is blocked in the meantime."
        })
    );
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The units' own `pre_tool_use`, shadowing the glob-imported one: every
    /// pre-boundary test is about the *other* rules, and none of them may
    /// reach a running instance to find out about a turn.
    fn pre_tool_use(payload: &Value) -> Option<Decision> {
        super::pre_tool_use_with(payload, || TurnFacts::Open)
    }

    /// The same, for a turn that has already closed step `n`.
    fn pre_tool_use_after_closing(payload: &Value, step: u32) -> Option<Decision> {
        super::pre_tool_use_with(payload, || TurnFacts::ClosedStep(step))
    }

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
            pre_tool_use(&bash("tugtool changes --json")),
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
                assert!(reason.contains("tugtool file edit"), "{reason}")
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

    // ── The turn boundary ─────────────────────────────────────────────────
    //
    // The pure halves here; the round trip is driven end to end against a
    // real fake tugcast in `tests/turn_boundary_cli.rs`, which is the only
    // place the degrade-open rules can actually be observed.

    /// **The pre-filter reads one variable, and the retired one is not it.**
    /// `TUG_ARC` is what a stage's spawn carries; a shell holding only the
    /// spelling this campaign retired is a shell from a build that no longer
    /// exists, and the filter going quiet over it is the open direction — the
    /// only one this gate is allowed to fail in.
    #[serial_test::serial]
    #[test]
    fn the_pre_filter_reads_tug_arc_and_nothing_else() {
        // SAFETY: serialized against every other env-reading test in this
        // binary, which is what `serial` is for.
        unsafe {
            std::env::remove_var("TUG_ARC");
            std::env::remove_var("TUG_DASH_COURSE");
        }
        assert!(!spawned_into_an_arc(), "no variable is no arc");

        unsafe { std::env::set_var("TUG_DASH_COURSE", "demo") };
        assert!(
            !spawned_into_an_arc(),
            "the retired spelling is not read, so the gate degrades open"
        );

        unsafe { std::env::set_var("TUG_ARC", "demo") };
        assert!(spawned_into_an_arc(), "TUG_ARC is the one the filter reads");

        unsafe {
            std::env::remove_var("TUG_ARC");
            std::env::remove_var("TUG_DASH_COURSE");
        }
    }

    #[test]
    fn the_refusal_names_the_step_the_gesture_and_the_way_out() {
        let refusal = boundary_refusal(Gesture::ToolWrite, 3);
        assert!(
            refusal
                .contains("step 3 closed this turn — end the turn; the arc prompts the next step"),
            "{refusal}"
        );
        assert!(refusal.contains("This edit"), "{refusal}");
        assert!(
            boundary_refusal(Gesture::StepStart, 1).contains("Opening the next step"),
            "a refused start says what it refused"
        );
    }

    #[test]
    fn a_write_tool_on_a_repo_file_is_a_gesture_and_scratch_is_not() {
        let write = |path: &str| {
            json!({
                "tool_name": "Edit",
                "tool_input": { "file_path": path },
                "cwd": "/proj",
            })
        };
        assert_eq!(gesture_of(&write("src/main.rs")), Some(Gesture::ToolWrite));
        assert_eq!(
            gesture_of(&write("/proj/src/main.rs")),
            Some(Gesture::ToolWrite)
        );
        // Staging and building are not the next step's work.
        assert_eq!(gesture_of(&write("/elsewhere/scratch.txt")), None);
        assert_eq!(gesture_of(&write("target/debug/x")), None);
    }

    #[test]
    fn a_read_is_never_a_gesture() {
        assert_eq!(
            gesture_of(&json!({ "tool_name": "Read", "tool_input": { "file_path": "/proj/a" } })),
            None
        );
        assert_eq!(gesture_of(&bash("grep -rn foo .")), None);
        assert_eq!(gesture_of(&bash("git status")), None);
    }

    #[test]
    fn the_ledger_verbs_a_stage_may_always_run_are_not_gestures() {
        for command in [
            "tugtool arc status demo",
            "tugtool arc doctor demo",
            "tugtool draft set --json",
            "tugtool arc step demo done 1",
            "tugtool arc commit demo -m x",
            "tugtool file edit --preview",
        ] {
            assert_eq!(gesture_of(&bash(command)), None, "{command}");
        }
    }

    #[test]
    fn the_cli_verbs_that_write_are_gestures_despite_the_prefix_approval() {
        assert_eq!(
            gesture_of(&bash("tugtool file edit")),
            Some(Gesture::TugWrite)
        );
        assert_eq!(
            gesture_of(&bash("tugtool file run -- cargo fmt")),
            Some(Gesture::TugWrite)
        );
        assert_eq!(gesture_of(&bash("tugedit")), Some(Gesture::TugWrite));
        assert_eq!(
            gesture_of(&bash("tugtool arc step demo start 2 --through 5")),
            Some(Gesture::StepStart)
        );
        // The retired verb name is not a second spelling of the gesture: the
        // grammar reads one noun, and a command naming the old one is an
        // ordinary `tugtool` invocation the allowlist auto-approves.
        assert_eq!(
            gesture_of(&bash("tugtool dash step demo start 2 --through 5")),
            None
        );
        // The global flags a verb may be reached through do not hide it.
        assert_eq!(
            gesture_of(&bash("tugtool --json arc step demo start 2 --through 5")),
            Some(Gesture::StepStart)
        );
    }

    #[test]
    fn a_shell_write_is_a_gesture_and_so_is_one_the_grammar_cannot_read() {
        let dir = checkout();
        let cwd = dir.path().to_string_lossy().into_owned();
        assert_eq!(
            gesture_of(&bash_in("rm src/main.rs", &cwd)),
            Some(Gesture::ShellWrite)
        );
        let unreadable =
            "python3 - <<'PY'\nimport pathlib\npathlib.Path('src/main.tsx').write_text('x')\nPY";
        assert_eq!(
            gesture_of(&bash_in(unreadable, &cwd)),
            Some(Gesture::ShellWrite)
        );
    }

    #[test]
    fn a_relative_path_with_no_cwd_is_never_placed() {
        // The boundary declines to guess where a path lives, which is the
        // open direction — the only one a gate over ordinary editing may
        // fail in.
        assert!(!is_repo_path("src/main.rs", None));
        assert!(!is_repo_path("/proj/src/main.rs", None));
        assert!(is_repo_path("/proj/src/main.rs", Some("/proj")));
    }

    #[test]
    fn the_boundary_outranks_the_prefix_approval_and_the_grammar_alike() {
        let dir = checkout();
        let cwd = dir.path().to_string_lossy().into_owned();
        // `tugtool` is auto-approved by prefix everywhere else here, and this
        // is the one rule that outranks that.
        let start = bash_in("tugtool arc step demo start 2 --through 5", &cwd);
        match pre_tool_use_after_closing(&start, 1) {
            Some(Decision::Deny(reason)) => assert!(reason.contains("step 1 closed this turn")),
            other => panic!("expected the boundary's deny, got {other:?}"),
        }
        // And a command the change grammar already refuses is refused for the
        // boundary's reason instead, because ending the turn settles both.
        let unreadable =
            "python3 - <<'PY'\nimport pathlib\npathlib.Path('src/main.tsx').write_text('x')\nPY";
        match pre_tool_use_after_closing(&bash_in(unreadable, &cwd), 4) {
            Some(Decision::Deny(reason)) => assert!(reason.contains("end the turn"), "{reason}"),
            other => panic!("expected the boundary's deny, got {other:?}"),
        }
        // A read from the same session is untouched.
        assert!(
            matches!(
                pre_tool_use_after_closing(&bash_in("ls -la", &cwd), 1),
                Some(Decision::Allow(_))
            ),
            "a closed boundary refuses the next step's work, not a look at the last one's"
        );
    }

    #[test]
    fn the_rendered_json_is_what_claude_code_reads() {
        let out: Value = serde_json::from_str(&Decision::Allow("x").render()).unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(out["hookSpecificOutput"]["permissionDecisionReason"], "x");
    }
}

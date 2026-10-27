//! `tugtool hook` — the decisions behind the plugin's Claude Code hooks,
//! computed in the binary so the shell wrappers that ship in the app bundle
//! need nothing the bundle does not carry.
//!
//! The wrapper (`tugplug/hooks/pre-tool-use.sh`) locates this binary and
//! pipes the hook's JSON straight through. Everything else — parsing the
//! payload, the auto-approve prefixes, the file-ops gate, the test-runner
//! wrap — lives here, where it is compiled, tested, and versioned with the
//! grammar it answers from.
//!
//! Exit 0 always: the decision is the JSON on stdout, and an empty stdout
//! means "no opinion" — Claude Code falls through to its normal permission
//! flow. A hook that crashed would block work, so nothing here is allowed to.
//!
//! One answer is not a permission decision at all. Every Bash call this
//! reading can place a command in is rewritten, through the hook's
//! `updatedInput`, to open with a `# tug-call: <id>` line — a comment, which
//! the shell ignores and Claude Code's permission check reads past, and which
//! rides into the argv of the shell Claude Code spawns for the call, where a
//! recipe, a nested `just`, a probe's child and `tugtool report` itself read
//! it back (`tugcore::call_id`) and so report to the block they run under,
//! exactly. It was an `export TUG_TOOL_USE_ID=<id>;` until Claude Code
//! 2.1.311 began judging permission on the rewritten command, which made
//! every tagged call ask; a comment is the one carrier a permission check is
//! transparent to. And a runner the model types — one tugtool knows, or one
//! the project declares in `.tugtool/config.toml` (`tugtool report runners`
//! lists them) — is wrapped where it stands, bare or inside a `tugtool file
//! probe … --`, to run inside `tugtool test run`, so the block gets the
//! report panel without anybody remembering to wire it. The rewrite carries
//! no `permissionDecision` of its own: Claude Code judges the rewritten
//! command exactly as it would have judged the bare one (an approved prefix
//! is allowed and rewritten in one answer), and the deck's Bash block elides
//! the mark, so the header shows what the model typed.

use std::io::Read;
use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde::Serialize;
use serde_json::Value;

use crate::changes::AppError;
use crate::runners::{self, RunnerAction, RunnerSpec, SuiteRule, kind_name};

use super::file::gate_decision;
use tugchanges_core::shell_ops::{ParseOutcome, parse_shell_ops};
use tugcore::call_id::{CALL_MARK, call_mark};

#[derive(Subcommand)]
pub enum HookCommands {
    /// Answer a PreToolUse hook: read the hook's JSON payload from stdin and
    /// print the decision. Auto-approves the plugin's own skills and the
    /// read-only Bash prefixes; denies a Bash command whose file operations
    /// the change ledger cannot read; gives every readable Bash command its
    /// call id (a leading `# tug-call: <id>` line) and rewrites each test runner
    /// in it — wherever it stands as a command of its own, a pipeline's head
    /// and a probe's inner command included — to run inside `tugtool test
    /// run`; says nothing otherwise.
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
            // One ask of the owning instance per call, read twice: by the
            // turn boundary, and by the yield line. Neither is asked off an
            // arc, so an ordinary session pays no round trip.
            let answer = std::cell::OnceCell::new();
            let ask = || answer.get_or_init(ask_turn);
            let decision = pre_tool_use_with(&payload, || turn_facts_of(ask()));
            let context = additional_context().or_else(|| {
                let arc = std::env::var("TUG_ARC")
                    .ok()
                    .filter(|arc| !arc.is_empty())?;
                yield_line(&arc, ask())
            });
            if let Some(answer) = render_answer(decision.as_ref(), context.as_deref()) {
                println!("{answer}");
            }
            Ok(())
        }
    }
}

/// The capture's instrument: text set here rides every answer this hook
/// gives as `hookSpecificOutput.additionalContext`, the channel Claude Code
/// documents for putting a sentence in front of the model on its next
/// inference. The stream-json catalog's `test-47` sets it to settle whether
/// the channel reaches the model under the pinned version, which is the
/// precondition for a hook that tells a seated stage its share of the
/// context window. Unset in production, like `TUGCODE_WIRE_TAP`.
const ADDITIONAL_CONTEXT_ENV: &str = "TUGTOOL_HOOK_ADDITIONAL_CONTEXT";

fn additional_context() -> Option<String> {
    std::env::var(ADDITIONAL_CONTEXT_ENV)
        .ok()
        .filter(|text| !text.trim().is_empty())
}

/// Bash commands approved by prefix: read-only lookups, and the CLI whose
/// every verb prints its own receipt.
const APPROVED_BASH: &[&str] = &["grep", "ls", "find", "tugtool"];

/// Skills under this namespace are the plugin's own.
const PLUGIN_SKILL_PREFIX: &str = "tugplug:";

#[derive(Debug, PartialEq)]
pub enum Decision {
    Allow(&'static str),
    Deny(String),
    /// No permission opinion — the tool's whole input, with its command
    /// rewritten. `updatedInput` replaces the input rather than patching it,
    /// so every other field (`description`, `timeout`, `run_in_background`)
    /// is carried across unchanged.
    Rewrite(Value),
    /// Allowed by prefix, and rewritten: both in one answer, which is how
    /// Claude Code reads `permissionDecision: allow` beside `updatedInput`.
    AllowRewrite(&'static str, Value),
}

#[cfg(test)]
impl Decision {
    /// The answer for this decision alone — the tests' shorthand for
    /// [`render_answer`] with no additional context.
    fn render(&self) -> String {
        render_answer(Some(self), None).unwrap_or_default()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Specific<'a> {
    hook_event_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_decision: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_decision_reason: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_input: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    additional_context: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output<'a> {
    hook_specific_output: Specific<'a>,
}

/// The JSON the hook prints: the decision, if any, and the additional
/// context, if any, in one `hookSpecificOutput`. `None` when there is
/// neither — an empty stdout is "no opinion", and that stays the answer for
/// every call the instrument is not set on.
pub(crate) fn render_answer(decision: Option<&Decision>, context: Option<&str>) -> Option<String> {
    if decision.is_none() && context.is_none() {
        return None;
    }
    let mut specific = Specific {
        hook_event_name: "PreToolUse",
        permission_decision: None,
        permission_decision_reason: None,
        updated_input: None,
        additional_context: context,
    };
    match decision {
        Some(Decision::Allow(reason)) => {
            specific.permission_decision = Some("allow");
            specific.permission_decision_reason = Some(reason);
        }
        Some(Decision::Deny(reason)) => {
            specific.permission_decision = Some("deny");
            specific.permission_decision_reason = Some(reason);
        }
        Some(Decision::Rewrite(input)) => specific.updated_input = Some(input),
        Some(Decision::AllowRewrite(reason, input)) => {
            specific.permission_decision = Some("allow");
            specific.permission_decision_reason = Some(reason);
            specific.updated_input = Some(input);
        }
        None => {}
    }
    Some(
        serde_json::to_string(&Output {
            hook_specific_output: specific,
        })
        .unwrap_or_default(),
    )
}

/// The decision for one PreToolUse payload, or `None` for "no opinion", with
/// the turn boundary's one I/O call injected.
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
    // what every other rule would allow — a repo write, or `arc step start`,
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
                return Some(match bash_rewrite(payload, &hook_binary()) {
                    Some(Decision::Rewrite(input)) => {
                        Decision::AllowRewrite("tugplug auto-approved", input)
                    }
                    // A runner that would run dark is refused whatever the
                    // line's first word: the approval is of the prefix, and
                    // the refusal is of what the line hides behind it.
                    Some(Decision::Deny(reason)) => Decision::Deny(reason),
                    _ => Decision::Allow("tugplug auto-approved"),
                });
            }
            let base = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_default();
            let gate = gate_decision(command, &base);
            if gate.decision == "deny" {
                return Some(Decision::Deny(gate.reason.unwrap_or_else(|| {
                    "this command names no file the change ledger can resolve".to_string()
                })));
            }
            bash_rewrite(payload, &hook_binary())
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Test runners run inside `tugtool test run`
// ---------------------------------------------------------------------------

/// The simple commands in a Bash command line, as byte ranges: the stretches
/// between the shell's control operators (`|`, `||`, `&&`, `;`, `&`, a
/// newline) and its grouping parentheses, read outside quotes. A `&` that is
/// part of a redirection (`2>&1`, `&>`) is not an operator.
///
/// `None` when the line holds syntax this reading cannot place a command in
/// with certainty — a command substitution (`$(…)`, backticks), a
/// here-document, an unclosed quote — and then nothing in it is wrapped.
fn simple_commands(command: &str) -> Option<Vec<(usize, usize)>> {
    let bytes = command.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let (mut single, mut double) = (false, false);
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if single {
            if b == b'\'' {
                single = false;
            }
            i += 1;
            continue;
        }
        match b {
            b'\\' => {
                i += 2;
                continue;
            }
            b'"' => double = !double,
            b'`' => return None,
            b'$' if bytes.get(i + 1) == Some(&b'(') => return None,
            _ if double => {}
            b'\'' => single = true,
            b'<' if bytes.get(i + 1) == Some(&b'<') => return None,
            b'&' if i > 0 && matches!(bytes[i - 1], b'>' | b'<') => {}
            b'&' if bytes.get(i + 1) == Some(&b'>') => {}
            b'|' | b'&' | b';' | b'(' | b')' | b'\n' => {
                out.push((start, i));
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if single || double {
        return None;
    }
    out.push((start, bytes.len()));
    Some(out)
}

/// A simple command's whitespace-separated words, each with its byte offset
/// in the whole command line. Quotes are not read here: only the leading
/// words matter, and an argument's spelling is never touched.
fn words_of(command: &str, (start, end): (usize, usize)) -> Vec<(usize, &str)> {
    let span = &command[start..end];
    let mut out = Vec::new();
    let mut word = None;
    for (i, c) in span.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = word.take() {
                out.push((start + s, &span[s..i]));
            }
        } else if word.is_none() {
            word = Some(i);
        }
    }
    if let Some(s) = word {
        out.push((start + s, &span[s..]));
    }
    out
}

/// `NAME=value` with a plain value — an environment assignment the wrap can
/// leave standing in front of it. A quoted value may hold spaces the word
/// split cut through, so it is not read as one.
fn is_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, value)) => {
            !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !value.contains(['\'', '"'])
        }
        None => false,
    }
}

/// The runner a simple command is, past any environment assignments: the
/// offset of its first word, and its row in the table — the first whose head
/// it starts with, which is the longest, since the table is sorted so.
fn runner_in<'r>(
    words: &[(usize, &str)],
    runners: &'r [RunnerSpec],
) -> Option<(usize, &'r RunnerSpec)> {
    let head = words.iter().position(|(_, w)| !is_assignment(w))?;
    // A probe runs the command after its `--`, so that command is the one
    // the ladder reads, in place, past its own assignments.
    let start = probe_inner(&words[head..]).map_or(head, |i| head + i);
    let first = start + words[start..].iter().position(|(_, w)| !is_assignment(w))?;
    let rest: Vec<&str> = words[first..].iter().map(|(_, w)| *w).collect();
    runners
        .iter()
        .find(|spec| spec.matches(&rest))
        .map(|spec| (words[first].0, spec))
}

/// For `tugtool file probe … -- <command>` — `tugtool` by any path — the
/// index of the inner command's first word, past the `--`; `None` for any
/// other command, or a probe with nothing after its `--`.
fn probe_inner(words: &[(usize, &str)]) -> Option<usize> {
    let [(_, tool), (_, "file"), (_, "probe"), ..] = words else {
        return None;
    };
    if tool.rsplit('/').next() != Some("tugtool") {
        return None;
    }
    let dashes = words.iter().position(|(_, w)| *w == "--")?;
    (dashes + 1 < words.len()).then_some(dashes + 1)
}

/// The command line with every recognised runner wrapped where it stands and
/// the call's id exported at its head, or `None` when neither applies.
///
/// A runner is wrapped wherever it is a simple command of its own — the whole
/// line, after a `cd … &&`, at the head of a pipeline, inside `( … )` — by
/// inserting the call id and this binary's `test run … --` in front of its
/// first word. Nothing else in the line moves, so a pipe, a filter, a
/// redirection and the line's exit status are what they were: `test run`
/// passes the runner's output through byte for byte and exits with its
/// status, and the report panel reads the run's reports, which go to tugcast by
/// call id rather than down the pipe. That is why a `| tail -6` costs the
/// panel nothing.
///
/// Left alone: a line holding syntax [`simple_commands`] will not read, and
/// any command whose head is not a runner — `just test-rust` and an already
/// wrapped `tugtool test run` among them, so nothing is wrapped twice, and
/// `echo cargo test` or a loop's `do cargo test` too.
///
/// A line that will not read and holds a runner all the same is not left
/// alone but refused — see [`dark_runner_refusal`], which [`bash_rewrite`]
/// asks first.
///
/// The suite is the ledger's key for the run, and the row's [`SuiteRule`]
/// names it: a fixed name, or the directory the run is in — the last
/// `cd <dir>` before it, else the call's own.
///
/// Every readable line — a runner in it or not — opens with a
/// `# tug-call: <id>` line when the call has a plain id and the line does not
/// already, so a row that reports itself ([`RunnerAction::ExportId`]) needs
/// nothing more, and the id reaches a probe's child and a recipe's every step
/// through the argv of the shell that runs the call. A line with no id to
/// carry and no runner is left alone.
pub(crate) fn rewrite_command(
    command: &str,
    cwd: Option<&str>,
    tool_use_id: Option<&str>,
    tugtool: &str,
    runners: &[RunnerSpec],
) -> Option<String> {
    let mut inserts: Vec<(usize, String)> = Vec::new();
    let id = tool_use_id.filter(|id| is_plain_word(id));
    for (at, spec, suite) in planned_wraps(command, cwd, runners)? {
        let RunnerAction::Wrap { kind, flags } = &spec.action else {
            continue;
        };
        let head = spec.head_text();
        let mut wrap = String::new();
        wrap.push_str(&format!(
            "{} test run --suite {} --kind {} ",
            shell_word(tugtool),
            shell_word(&suite),
            kind_name(*kind),
        ));
        for (flag, value) in flags.pairs() {
            wrap.push_str(&format!("{flag} {} ", shell_word(value)));
        }
        wrap.push_str(&format!(
            "--label {} --needle {} -- ",
            shell_word(&spec.label_text()),
            shell_word(&head),
        ));
        inserts.push((at, wrap));
    }
    let mark = id
        .filter(|_| !command.trim_start().starts_with(CALL_MARK))
        .map(call_mark);
    if inserts.is_empty() && mark.is_none() {
        return None;
    }
    let mut out = command.to_string();
    for (at, text) in inserts.into_iter().rev() {
        out.insert_str(at, &text);
    }
    if let Some(mark) = mark {
        out.insert_str(0, &mark);
    }
    Some(out)
}

/// Every runner [`rewrite_command`] wraps, in line order: the offset of its
/// first word, its row, and the suite its run records under — a fixed name,
/// or the directory the run is in: the last `cd <dir>` before it, else the
/// call's own. A row that reports itself ([`RunnerAction::ExportId`]) is not
/// among them. `None` when the line cannot be read.
fn planned_wraps<'r>(
    command: &str,
    cwd: Option<&str>,
    runners: &'r [RunnerSpec],
) -> Option<Vec<(usize, &'r RunnerSpec, String)>> {
    let mut out = Vec::new();
    let mut dir: Option<&str> = None;
    for span in simple_commands(command)? {
        let words = words_of(command, span);
        if let [(_, "cd"), (_, d)] = words.as_slice() {
            dir = Some(d);
            continue;
        }
        let Some((at, spec)) = runner_in(&words, runners) else {
            continue;
        };
        if matches!(spec.action, RunnerAction::ExportId) {
            continue;
        }
        let suite = match &spec.suite {
            SuiteRule::Fixed(name) => name.clone(),
            SuiteRule::DirName(fallback) => dir_name(dir.or(cwd)).unwrap_or(fallback).to_string(),
        };
        out.push((at, spec, suite));
    }
    Some(out)
}

/// The first known or declared runner the line runs, however the line reads:
/// at a command position of a readable line, or where [`dark_runner`] finds
/// one in a line that does not read. `None` when the line runs no runner.
fn runner_on_line<'r>(command: &str, runners: &'r [RunnerSpec]) -> Option<&'r RunnerSpec> {
    match simple_commands(command) {
        Some(spans) => spans
            .into_iter()
            .find_map(|span| runner_in(&words_of(command, span), runners).map(|(_, spec)| spec)),
        None => dark_runner(command, runners).map(|(_, spec)| spec),
    }
}

/// What a `run_in_background: true` call holding a runner is refused with: a
/// build or a test run never runs in the background, because a background
/// run reports to no block and leaves its verdict in a file to be recovered.
/// The correction is the foreground `timeout` to pass — the one the hook
/// would supply from the suite's record, or the harness ceiling when there is
/// none — and the one exception is named so it is not read as a ban on
/// servers.
fn background_refusal(spec: &RunnerSpec, supplied_ms: Option<u64>) -> String {
    let head = spec.head_text();
    let known = known_as(spec);
    let timeout = supplied_ms.unwrap_or(HARNESS_MAX_TIMEOUT_MS);
    let basis = if supplied_ms.is_some() {
        "from the suite's recorded median"
    } else {
        "the harness ceiling, since no run of this suite is recorded yet"
    };
    format!(
        "`{head}` never runs in the background: it is {known}, and a background run reports to \
         no block and leaves its verdict in a file to recover. Run it in the foreground with \
         `timeout: {timeout}` ({basis}); the block reports as it goes and ends with the verdict. \
         Only a server, watcher or sampler meant to outlive the call is background work."
    )
}

/// What a runner piped into `grep` or `head` is refused with: a filter before
/// the run's exit guesses at its output, hides any red the guess did not
/// cover, and gives the call the filter's exit status in place of the run's.
/// `None` for a line that pipes no runner into one — a `| tail -N` keeps the
/// verdict line a wrapped run ends with and is left as typed.
pub(crate) fn filtered_runner_refusal(command: &str, runners: &[RunnerSpec]) -> Option<String> {
    const FILTERS: [&str; 4] = ["grep", "egrep", "fgrep", "head"];
    let spans = simple_commands(command)?;
    let bytes = command.as_bytes();
    for pair in spans.windows(2) {
        let [(_, end), next] = pair else { continue };
        // The operator between the two is the byte the first span ended on:
        // a lone `|` is a pipe, `||` is not.
        if bytes.get(*end) != Some(&b'|') || bytes.get(end + 1) == Some(&b'|') {
            continue;
        }
        let words = words_of(command, pair[0]);
        let Some((_, spec)) = runner_in(&words, runners) else {
            continue;
        };
        // A runner piped into anything else — a `tail`, a `tee` — is fine,
        // and the rest of the line is still read.
        let Some(filter) = words_of(command, *next)
            .into_iter()
            .map(|(_, w)| w)
            .find(|w| !is_assignment(w))
            .filter(|w| FILTERS.contains(w))
        else {
            continue;
        };
        let head = spec.head_text();
        return Some(format!(
            "`{head} … | {filter}` guesses at the run's output: a filter before the run's exit \
             hides any red the guess did not cover and gives the call `{filter}`'s exit status in \
             place of the run's. Run it bare, or end it with `2>&1 | tail -3`, which keeps the \
             verdict line a wrapped run ends with; a red's names are in `tugtool test last \
             --failures`, never in a re-run."
        ));
    }
    None
}

/// How a refusal names the runner's provenance.
fn known_as(spec: &RunnerSpec) -> &'static str {
    match spec.source {
        runners::Source::BuiltIn => "a runner tugtool knows",
        runners::Source::Config => "a runner this project declares",
    }
}

/// The Bash tool's own limits, in milliseconds: what a call runs under when
/// it passes no `timeout`, and the most it may ask for. Both are the
/// harness's; the hook works inside them.
pub(crate) const HARNESS_DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub(crate) const HARNESS_MAX_TIMEOUT_MS: u64 = 600_000;

/// How many of a suite's newest runs its median is read over.
const MEDIAN_OVER_RUNS: usize = 10;

/// The foreground timeout a wrapped run is given from its suites' recorded
/// medians, summed: twice the usual time plus half a minute — a run at twice
/// its usual length is slow rather than hung, and the margin keeps a short
/// suite's compile from being the cliff — clamped to the harness ceiling.
pub(crate) fn supplied_timeout_ms(median_secs: f64) -> u64 {
    let ms = ((median_secs * 2.0 + 30.0) * 1000.0).round();
    (ms.max(0.0) as u64).min(HARNESS_MAX_TIMEOUT_MS)
}

/// The recorded medians of the suites a line's wrapped runners record under,
/// summed, in seconds — read from the test ledger for the project the call's
/// `cwd` is in. `None` when no suite among them has a run recorded, or there
/// is no ledger to read: a call then keeps the harness's own timeout.
fn recorded_median_secs(cwd: Option<&str>, suites: &[String]) -> Option<f64> {
    use tugtool_core::test_ledger::{default_path, median_wall_secs, open_ledger, run_root_for};
    if suites.is_empty() {
        return None;
    }
    let path = default_path();
    if !path.exists() {
        return None;
    }
    let dir = cwd
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let base_root = tugtool_core::apptest_ledger::resolve_base_root(&run_root_for(Path::new(&dir)));
    let conn = open_ledger(path).ok()?;
    let mut total = 0.0;
    let mut any = false;
    for suite in suites {
        if let Ok(Some(secs)) = median_wall_secs(&conn, &base_root, suite, MEDIAN_OVER_RUNS) {
            total += secs;
            any = true;
        }
    }
    any.then_some(total)
}

/// Why a line [`simple_commands`] cannot read is refused, when a runner is in
/// it: the refusal the hook denies the call with, naming the runner, the
/// construct that hides it, and the split that fixes it. `None` for a line
/// that reads, and for one that does not read but runs no runner — a heredoc
/// that only edits, a `$(ls)` — which is left as typed.
///
/// The runner is found where a shell would run it: at a command position —
/// the line's start, after an operator, inside a `$(…)` or backticks — past
/// any environment assignments, and never inside a here-document's body,
/// which is data. So an edit program whose body mentions `cargo test` is not
/// refused, and `tugtool file edit <<'EOF' … EOF` followed by `cargo test`
/// on the next line is.
pub(crate) fn dark_runner_refusal(command: &str, runners: &[RunnerSpec]) -> Option<String> {
    if simple_commands(command).is_some() {
        return None;
    }
    let (construct, spec) = dark_runner(command, runners)?;
    let head = spec.head_text();
    let known = match spec.source {
        runners::Source::BuiltIn => "a runner tugtool knows",
        runners::Source::Config => "a runner this project declares",
    };
    Some(format!(
        "`{head}` would run dark here: it is {known}, and this line holds {construct}, which \
         the hook cannot read past, so the run would report nothing to its block for its whole \
         length. Give the run its own Bash call — everything else in one call, `{head} …` alone \
         in the next."
    ))
}

/// What a shell would run in a line [`simple_commands`] cannot read, read
/// loosely: the first runner at a command position outside any here-document
/// body, with the name of the construct that made the line unreadable.
fn dark_runner<'r>(
    command: &str,
    runners: &'r [RunnerSpec],
) -> Option<(&'static str, &'r RunnerSpec)> {
    enum Token<'a> {
        Word(usize, &'a str),
        Break,
        Heredoc,
    }
    let mut construct: Option<&'static str> = None;
    let mut note = |what: &'static str| {
        if construct.is_none() {
            construct = Some(what);
        }
    };
    let mut groups: Vec<Vec<(usize, &str)>> = Vec::new();
    // The delimiters of here-documents whose bodies have not yet been read,
    // in the order their bodies follow.
    let mut bodies: Vec<String> = Vec::new();
    let mut offset = 0;
    for line in command.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        let text = line.strip_suffix('\n').unwrap_or(line);
        if let Some(delimiter) = bodies.first() {
            if text.trim_start_matches('\t') == delimiter {
                bodies.remove(0);
            }
            continue;
        }
        let bytes = text.as_bytes();
        let mut tokens: Vec<Token> = Vec::new();
        let mut word: Option<usize> = None;
        let mut i = 0;
        while i <= bytes.len() {
            let b = bytes.get(i).copied();
            let (token, step) = match b {
                None => (Some(Token::Break), 1),
                Some(b'<') if bytes.get(i + 1) == Some(&b'<') => {
                    if bytes.get(i + 2) == Some(&b'<') {
                        note("a here-string");
                        (None, 3)
                    } else {
                        note("a here-document");
                        let dash = usize::from(bytes.get(i + 2) == Some(&b'-'));
                        (Some(Token::Heredoc), 2 + dash)
                    }
                }
                Some(b'$') if bytes.get(i + 1) == Some(&b'(') => {
                    note("a command substitution (`$(…)`)");
                    (Some(Token::Break), 2)
                }
                Some(b'`') => {
                    note("a backtick substitution");
                    (Some(Token::Break), 1)
                }
                Some(b';' | b'|' | b'&' | b'(' | b')') => (Some(Token::Break), 1),
                Some(c) if c.is_ascii_whitespace() => (None, 1),
                Some(_) => {
                    if word.is_none() {
                        word = Some(i);
                    }
                    i += 1;
                    continue;
                }
            };
            if let Some(s) = word.take() {
                tokens.push(Token::Word(start + s, &text[s..i]));
            }
            if let Some(token) = token {
                tokens.push(token);
            }
            i += step;
        }
        let mut group: Vec<(usize, &str)> = Vec::new();
        let mut delimiter_next = false;
        for token in tokens {
            match token {
                Token::Heredoc => delimiter_next = true,
                Token::Word(_, w) if delimiter_next => {
                    delimiter_next = false;
                    bodies.push(
                        w.trim_matches(['\'', '"'])
                            .trim_start_matches('\\')
                            .to_string(),
                    );
                }
                Token::Word(at, w) => group.push((at, w)),
                Token::Break => {
                    if !group.is_empty() {
                        groups.push(std::mem::take(&mut group));
                    }
                }
            }
        }
    }
    let spec = groups
        .iter()
        .find_map(|words| runner_in(words, runners))
        .map(|(_, spec)| spec)?;
    Some((construct.unwrap_or("an unclosed quote"), spec))
}

/// The last component of a directory as typed — quotes stripped — when it
/// is a plain name; `None` for anything the shell would still have to read.
fn dir_name(path: Option<&str>) -> Option<&str> {
    let path = path?.trim().trim_matches(['\'', '"']);
    let name = path.trim_end_matches('/').rsplit('/').next()?;
    is_plain_word(name).then_some(name)
}

/// Letters, digits, `.`, `_`, `-`: a word every shell reads as itself.
fn is_plain_word(word: &str) -> bool {
    !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A word for the shell: bare when it is plain, single-quoted otherwise.
fn shell_word(word: &str) -> String {
    let bare = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':'));
    if bare {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// The rewrite for a Bash call — its id exported, its runners wrapped — or
/// `None` when the command cannot be read or there is nothing to add. The
/// runner table is the built-ins plus whatever the project the call's `cwd`
/// is in declares ([`runners::for_cwd`]). The other input fields ride the
/// rewritten input untouched. A command that cannot be read and holds a
/// runner is a [`Decision::Deny`] instead ([`dark_runner_refusal`]).
pub(crate) fn bash_rewrite(payload: &Value, tugtool: &str) -> Option<Decision> {
    bash_rewrite_with(payload, tugtool, &recorded_median_secs)
}

/// What answers the summed recorded median, in seconds, of the suites a line
/// records under, given the call's `cwd`: the ledger read, or a test's stand-in.
pub(crate) type MedianReader<'a> = &'a dyn Fn(Option<&str>, &[String]) -> Option<f64>;

/// [`bash_rewrite`], with the ledger read injected: `median` answers the
/// summed recorded median of the suites a line records under, so a unit test
/// hands in a record rather than writing one under the developer's HOME.
///
/// Three refusals come before the rewrite, each naming its correction: a
/// runner the line hides ([`dark_runner_refusal`]), a runner asked to run in
/// the background ([`background_refusal`]), and a runner piped into a
/// guessing filter ([`filtered_runner_refusal`]). Then the rewrite, which
/// also supplies the call's `timeout` from the record when the call passed
/// none or passed less — never shortening one — so the harness's default is
/// not the cliff every runner it knows runs toward.
pub(crate) fn bash_rewrite_with(
    payload: &Value,
    tugtool: &str,
    median: MedianReader<'_>,
) -> Option<Decision> {
    let input = payload.get("tool_input")?.as_object()?;
    let command = input.get("command")?.as_str()?;
    let cwd = payload.get("cwd").and_then(Value::as_str);
    let id = payload.get("tool_use_id").and_then(Value::as_str);
    let runners = runners::for_cwd(cwd);
    if let Some(reason) = dark_runner_refusal(command, &runners) {
        return Some(Decision::Deny(reason));
    }
    let suites: Vec<String> = planned_wraps(command, cwd, &runners)
        .map(|wraps| wraps.into_iter().map(|(_, _, suite)| suite).collect())
        .unwrap_or_default();
    let supplied = median(cwd, &suites).map(supplied_timeout_ms);
    if input.get("run_in_background").and_then(Value::as_bool) == Some(true)
        && let Some(spec) = runner_on_line(command, &runners)
    {
        return Some(Decision::Deny(background_refusal(spec, supplied)));
    }
    if let Some(reason) = filtered_runner_refusal(command, &runners) {
        return Some(Decision::Deny(reason));
    }
    let wrapped = rewrite_command(command, cwd, id, tugtool, &runners)?;
    let mut updated = input.clone();
    updated.insert("command".into(), wrapped.into());
    if let Some(supplied) = supplied {
        let passed = input
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(HARNESS_DEFAULT_TIMEOUT_MS);
        if supplied > passed {
            updated.insert("timeout".into(), supplied.into());
        }
    }
    Some(Decision::Rewrite(Value::Object(updated)))
}

/// This binary, by the path it runs from — the one `tugtool` the rewritten
/// command is sure to find whatever the model's shell has on its PATH.
pub(crate) fn hook_binary() -> String {
    std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tugtool".to_string())
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
        // `arc step <name> start` — the arc's name is the address, and it
        // sits between the noun and the verb.
        (Some("arc"), Some("step"), Some(_), Some("start")) => Some(Gesture::StepStart),
        _ => None,
    }
}

/// What this tool call would do, or `None` for a call the boundary has no
/// opinion about — every read, every status verb, `arc doctor`, the draft
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

/// The owning instance's one answer about the calling turn: whether it has
/// closed a step, and the stage's share of its window.
#[derive(Debug)]
pub(crate) enum TurnAnswer {
    /// Not spawned into an arc, so nothing was asked.
    NotAsked,
    /// Nobody to ask, or an instance that refused — `skewed` when the refusal
    /// was an instance too old to know the op.
    Unanswered {
        skewed: bool,
    },
    Answered(Value),
}

/// Ask the owning instance about this turn, once.
fn ask_turn() -> TurnAnswer {
    if !spawned_into_an_arc() {
        return TurnAnswer::NotAsked;
    }
    match crate::session_identity::ask_about_calling_session(
        "turn_facts",
        "checking the arc's turn boundary",
        serde_json::json!({}),
    ) {
        None => TurnAnswer::Unanswered { skewed: false },
        Some(Err(message)) => TurnAnswer::Unanswered {
            skewed: message.contains("unknown op"),
        },
        Some(Ok(response)) => TurnAnswer::Answered(response),
    }
}

/// The boundary gate's reading of the instance's answer.
fn turn_facts_of(answer: &TurnAnswer) -> TurnFacts {
    match answer {
        TurnAnswer::NotAsked => TurnFacts::Open,
        TurnAnswer::Unanswered { skewed } => TurnFacts::Unknown { skewed: *skewed },
        TurnAnswer::Answered(response) => {
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

/// The one line of context a seated implement stage is handed once its share
/// of the window reaches the yield line ([B03], [B05]): the share, the line,
/// and the instruction to land the round, write the hand-off and end the turn.
///
/// `None` below the line, off an arc, on any other stage (the server sends no
/// `context` for one), and whenever the instance could not answer — so every
/// session the yield is not for sees the hook's output exactly as before. It
/// rides every tool call once over the line, so one more read cannot hide it.
pub(crate) fn yield_line(arc: &str, answer: &TurnAnswer) -> Option<String> {
    let TurnAnswer::Answered(response) = answer else {
        return None;
    };
    if response.get("on_arc").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let context = response.get("context")?;
    let share = context.get("share")?.as_f64()?;
    let line = context.get("yield_share")?.as_f64()?;
    (share >= line).then(|| {
        format!(
            "Context window: this implement stage is at {:.0}% of its window, at or over the {:.0}% yield line. Finish the round you are in so the tree holds only committed work, then commit it and write the hand-off in one call: `tugtool arc commit {arc} --message \"yield: <the round just landed>; files: <the files it touched>; next: <the next task inside this step>\"`. Then end the turn with the step still open. The wheel compacts this session and resumes the step from that line.",
            share * 100.0,
            line * 100.0,
        )
    })
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

    /// The units' `pre_tool_use`, answering the boundary as open: every
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
        let out = tugcore::test_fixtures::git::command()
            .args(["init", "-q", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .expect("git init");
        assert!(out.status.success());
        dir
    }

    #[test]
    fn plugin_skills_are_approved_and_foreign_ones_are_not() {
        let mine = json!({ "tool_name": "Skill", "tool_input": { "skill": "tugplug:arc" } });
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
        assert_eq!(pre_tool_use(&bash("cargo tree")), None);
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

    /// **The pre-filter reads one variable.** `TUG_ARC` is what a stage's
    /// spawn carries, and a shell holding no variable at all is a shell the
    /// filter goes quiet over — the open direction, and the only one this
    /// gate is allowed to fail in.
    #[serial_test::serial]
    #[test]
    fn the_pre_filter_reads_tug_arc_and_nothing_else() {
        // SAFETY: serialized against every other env-reading test in this
        // binary, which is what `serial` is for.
        unsafe {
            std::env::remove_var("TUG_ARC");
        }
        assert!(!spawned_into_an_arc(), "no variable is no arc");

        unsafe { std::env::set_var("TUG_ARC", "demo") };
        assert!(spawned_into_an_arc(), "TUG_ARC is the one the filter reads");

        unsafe {
            std::env::remove_var("TUG_ARC");
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
        let out: Value =
            serde_json::from_str(&render_answer(Some(&Decision::Allow("x")), None).unwrap())
                .unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(out["hookSpecificOutput"]["permissionDecisionReason"], "x");
        assert!(out["hookSpecificOutput"].get("updatedInput").is_none());
        let both = render_answer(
            Some(&Decision::AllowRewrite("x", json!({"command": "c"}))),
            None,
        )
        .unwrap();
        let out: Value = serde_json::from_str(&both).unwrap();
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(out["hookSpecificOutput"]["permissionDecisionReason"], "x");
        assert_eq!(out["hookSpecificOutput"]["updatedInput"]["command"], "c");
        assert!(out["hookSpecificOutput"].get("additionalContext").is_none());
    }

    fn answered(context: Value) -> TurnAnswer {
        TurnAnswer::Answered(serde_json::json!({
            "status": "ok",
            "on_arc": true,
            "step_closed_this_turn": null,
            "context": context,
        }))
    }

    #[test]
    fn the_yield_line_rides_a_stage_at_or_over_the_line() {
        let line = yield_line(
            "demo",
            &answered(serde_json::json!({"share": 0.65, "yield_share": 0.6})),
        )
        .expect("over the line, the stage is told");
        assert!(line.contains("65% of its window"), "{line}");
        assert!(line.contains("the 60% yield line"), "{line}");
        assert!(
            line.contains("`tugtool arc commit demo --message \"yield: "),
            "the hand-off is one arc commit naming the arc: {line}"
        );
        assert!(
            line.contains("end the turn with the step still open"),
            "{line}"
        );

        // Exactly at the line is at it.
        assert!(
            yield_line(
                "demo",
                &answered(serde_json::json!({"share": 0.6, "yield_share": 0.6}))
            )
            .is_some()
        );
    }

    #[test]
    fn below_the_line_or_off_an_arc_the_hook_says_nothing_new() {
        let below = answered(serde_json::json!({"share": 0.59, "yield_share": 0.6}));
        assert_eq!(yield_line("demo", &below), None);
        // Another stage, or a share with a half unmeasured: no `context`.
        assert_eq!(yield_line("demo", &answered(Value::Null)), None);
        let off_arc = TurnAnswer::Answered(serde_json::json!({
            "on_arc": false,
            "context": {"share": 0.9, "yield_share": 0.6},
        }));
        assert_eq!(yield_line("demo", &off_arc), None);
        assert_eq!(yield_line("demo", &TurnAnswer::NotAsked), None);
        assert_eq!(
            yield_line("demo", &TurnAnswer::Unanswered { skewed: true }),
            None
        );
        // And with no line, the answer is exactly what it was.
        assert_eq!(render_answer(None, None), None);
    }

    #[test]
    fn the_boundary_reads_the_same_answer_the_yield_line_does() {
        assert_eq!(turn_facts_of(&TurnAnswer::NotAsked), TurnFacts::Open);
        assert_eq!(
            turn_facts_of(&TurnAnswer::Unanswered { skewed: true }),
            TurnFacts::Unknown { skewed: true }
        );
        let closed = TurnAnswer::Answered(serde_json::json!({
            "on_arc": true,
            "step_closed_this_turn": 3,
            "context": {"share": 0.7, "yield_share": 0.6},
        }));
        assert_eq!(turn_facts_of(&closed), TurnFacts::ClosedStep(3));
        assert!(yield_line("demo", &closed).is_some());
    }

    #[test]
    fn the_additional_context_instrument_rides_any_answer_and_stands_alone() {
        // Beside a decision: one hookSpecificOutput carries both.
        let both = render_answer(Some(&Decision::Allow("x")), Some("the share is 0.62")).unwrap();
        let out: Value = serde_json::from_str(&both).unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(
            out["hookSpecificOutput"]["additionalContext"],
            "the share is 0.62"
        );
        // With no decision: the context is the whole answer, no permission
        // opinion beside it, so Claude Code's own flow still judges the call.
        let alone = render_answer(None, Some("the share is 0.62")).unwrap();
        let out: Value = serde_json::from_str(&alone).unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert!(
            out["hookSpecificOutput"]
                .get("permissionDecision")
                .is_none()
        );
        assert_eq!(
            out["hookSpecificOutput"]["additionalContext"],
            "the share is 0.62"
        );
        // Neither: silence, which is "no opinion".
        assert!(render_answer(None, None).is_none());
    }

    // ── The test-runner wrap ──────────────────────────────────────────────

    const TUGTOOL: &str = "/Applications/Tug.app/Contents/MacOS/tugtool";
    const MARK: &str = "# tug-call: toolu_01A\n";

    fn wrap(command: &str) -> Option<String> {
        rewrite_command(
            command,
            Some("/proj"),
            Some("toolu_01A"),
            TUGTOOL,
            &runners::built_in(),
        )
    }

    #[test]
    fn a_runner_at_the_head_is_wrapped_with_its_arguments_verbatim() {
        assert_eq!(
            wrap("cargo nextest run -p tugtool -- --nocapture").as_deref(),
            Some(
                "# tug-call: toolu_01A\n/Applications/Tug.app/Contents/MacOS/tugtool test run \
                 --suite rust --kind nextest --label 'cargo nextest run' --needle 'cargo nextest run' \
                 -- cargo nextest run -p tugtool -- --nocapture"
            )
        );
        assert_eq!(
            wrap("cargo test").as_deref(),
            Some(
                "# tug-call: toolu_01A\n/Applications/Tug.app/Contents/MacOS/tugtool test run \
                 --suite rust --kind cargo-test --label 'cargo test' --needle 'cargo test' -- cargo test"
            )
        );
    }

    #[test]
    fn every_built_in_head_wraps_to_its_kind() {
        for (command, kind) in [
            ("go test ./... -run TestX", "go"),
            ("pytest -x tests", "pytest"),
            ("python -m pytest", "pytest"),
            ("python3 -m pytest -q", "pytest"),
            ("jest --ci", "jest"),
            ("npx jest", "jest"),
            ("bunx jest", "jest"),
            ("vitest", "vitest"),
            ("vitest run src", "vitest"),
            ("npx vitest run", "vitest"),
            ("bunx vitest", "vitest"),
            ("mocha", "mocha"),
            ("npx mocha test/", "mocha"),
            ("node --test a.test.mjs", "tap"),
            ("swift test --parallel", "swift"),
            ("ctest --output-on-failure", "ctest"),
        ] {
            let wrapped = wrap(command).unwrap_or_else(|| panic!("{command} is a runner"));
            assert!(wrapped.starts_with(MARK), "{command}: {wrapped}");
            assert!(
                wrapped.contains(&format!(" --suite proj --kind {kind} ")),
                "{command}: {wrapped}"
            );
            // The command itself goes through as typed: what a kind adds to
            // it (`-json`, `-v`) is `test run`'s to add.
            assert!(wrapped.ends_with(&format!(" -- {command}")), "{wrapped}");
        }
        // `node` alone, and `swift build`, are not test runs: they carry the
        // id and nothing else.
        assert_eq!(
            wrap("node a.mjs").as_deref(),
            Some("# tug-call: toolu_01A\nnode a.mjs")
        );
        assert_eq!(
            wrap("swift build").as_deref(),
            Some("# tug-call: toolu_01A\nswift build")
        );
    }

    #[test]
    fn a_cd_prefix_is_kept_and_names_a_bun_suite() {
        assert_eq!(
            wrap("cd tugdeck && bun test src/lib").as_deref(),
            Some(
                "# tug-call: toolu_01A\ncd tugdeck && /Applications/Tug.app/Contents/MacOS/tugtool \
                 test run --suite tugdeck --kind bun --label 'bun test' --needle 'bun test' -- bun test src/lib"
            )
        );
        // With no cd, the bun suite is the call's own directory.
        assert!(wrap("bun test").unwrap().contains("--suite proj "));
        // A directory the shell would still have to read names no suite.
        assert!(
            wrap("cd \"$DIR\" && bun test")
                .unwrap()
                .contains("--suite bun ")
        );
    }

    #[test]
    fn a_runner_is_wrapped_where_it_stands_and_the_rest_of_the_line_is_untouched() {
        const W: &str = "/Applications/Tug.app/Contents/MacOS/tugtool test run";
        let nextest = format!(
            "{W} --suite rust --kind nextest --label 'cargo nextest run' --needle 'cargo nextest run' -- "
        );
        let cargo = format!(
            "{W} --suite rust --kind cargo-test --label 'cargo test' --needle 'cargo test' -- "
        );
        for (command, wrapped) in [
            // A filter on the output: the pipe and the filter stand as typed.
            (
                "cargo nextest run 2>&1 | tail -5".to_string(),
                format!("{MARK}{nextest}cargo nextest run 2>&1 | tail -5"),
            ),
            (
                "cargo nextest run && echo ok".into(),
                format!("{MARK}{nextest}cargo nextest run && echo ok"),
            ),
            (
                "cargo test; echo done".into(),
                format!("{MARK}{cargo}cargo test; echo done"),
            ),
            (
                "cargo nextest run > out.txt".into(),
                format!("{MARK}{nextest}cargo nextest run > out.txt"),
            ),
            // An assignment stays in front, so it still reaches the runner.
            (
                "RUST_LOG=debug cargo test".into(),
                format!("{MARK}RUST_LOG=debug {cargo}cargo test"),
            ),
            (
                "cd a && cd b && cargo test".into(),
                format!("{MARK}cd a && cd b && {cargo}cargo test"),
            ),
            (
                "(cd tugrust && cargo test)".into(),
                format!("{MARK}(cd tugrust && {cargo}cargo test)"),
            ),
            // The shapes a session reaches for, verbatim but for the wrap.
            (
                "(grep -c x a && just test-tugdeck || (cd tugdeck && bun test)) | tail -12".into(),
                format!(
                    "{MARK}(grep -c x a && just test-tugdeck || (cd tugdeck && {W} --suite tugdeck --kind bun \
                     --label 'bun test' --needle 'bun test' -- bun test)) | tail -12"
                ),
            ),
            (
                "cargo nextest run -p a 2>&1 | tail -3; cargo test -p b | grep FAILED".into(),
                format!(
                    "{MARK}{nextest}cargo nextest run -p a 2>&1 | tail -3; {cargo}cargo test -p b | grep FAILED"
                ),
            ),
        ] {
            assert_eq!(
                wrap(&command).as_deref(),
                Some(wrapped.as_str()),
                "{command}"
            );
        }
    }

    #[test]
    fn what_cannot_be_read_with_certainty_is_left_alone() {
        // Readable, and no runner in it: the id, and nothing else.
        for command in [
            "cargo fmt --check",
            "bunx eslint .",
            "echo cargo test",
            "echo 'cargo test | x'",
            "for c in a b; do cargo test -p $c; done",
            "FOO=\"a b\" cargo test",
        ] {
            assert_eq!(wrap(command), Some(format!("{MARK}{command}")), "{command}");
        }
        // Unreadable: nothing in the line is placed, so nothing is touched.
        for command in [
            "x=$(cargo test 2>&1)",
            "echo `cargo test`",
            "cat <<EOF | sh\ncargo test\nEOF",
            "cargo test 'unclosed",
        ] {
            assert_eq!(wrap(command), None, "{command}");
        }
        // Idempotent: a rewritten line carries its id and has nothing left to wrap.
        let once = wrap("cargo test | tail -3").unwrap();
        assert_eq!(wrap(&once), None, "{once}");
    }

    #[test]
    fn an_already_wrapped_run_has_a_different_head() {
        assert_eq!(
            wrap("tugtool test run --suite rust --kind nextest -- cargo nextest run").as_deref(),
            Some(
                "# tug-call: toolu_01A\ntugtool test run --suite rust --kind nextest -- cargo nextest run"
            )
        );
        assert_eq!(
            wrap("just test-rust").as_deref(),
            Some("# tug-call: toolu_01A\njust test-rust")
        );
    }

    #[test]
    fn without_a_call_id_the_wrap_still_happens_and_carries_none() {
        let out = rewrite_command("bun test", None, None, TUGTOOL, &runners::built_in()).unwrap();
        assert!(!out.contains("tug-call"), "{out}");
        assert!(out.starts_with(TUGTOOL), "{out}");
        // An id that is not a plain word is not put in a shell's environment.
        let out = rewrite_command(
            "bun test",
            None,
            Some("x; rm -rf /"),
            TUGTOOL,
            &runners::built_in(),
        )
        .unwrap();
        assert!(!out.contains("tug-call"), "{out}");
    }

    #[test]
    fn a_binary_path_with_a_space_is_quoted() {
        let out = rewrite_command(
            "bun test",
            None,
            None,
            "/Applications/Tug 2.app/tugtool",
            &runners::built_in(),
        )
        .unwrap();
        assert!(
            out.starts_with("'/Applications/Tug 2.app/tugtool' test run"),
            "{out}"
        );
    }

    /// A project directory carrying `.tugtool/config.toml` with this text.
    fn project_declaring(config: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp");
        std::fs::create_dir(dir.path().join(".tugtool")).expect("mkdir");
        std::fs::write(dir.path().join(".tugtool/config.toml"), config).expect("write");
        dir
    }

    /// The command the hook would run for `command` typed in `dir`.
    fn rewritten_in(dir: &tempfile::TempDir, command: &str) -> Option<String> {
        let payload = json!({
            "tool_name": "Bash",
            "tool_input": { "command": command },
            "cwd": dir.path().to_string_lossy(),
            "tool_use_id": "toolu_01A",
        });
        match bash_rewrite(&payload, TUGTOOL)? {
            Decision::Rewrite(input) => input["command"].as_str().map(String::from),
            other => panic!("expected a rewrite, got {other:?}"),
        }
    }

    #[test]
    fn a_declared_kind_row_wraps_under_its_declared_suite_and_label() {
        let dir = project_declaring(
            "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"cargo-test\"\nsuite = \"checks\"\nlabel = \"checks\"\n",
        );
        assert_eq!(
            rewritten_in(&dir, "cd sub && make check -j4 | tail -3").as_deref(),
            Some(
                "# tug-call: toolu_01A\ncd sub && /Applications/Tug.app/Contents/MacOS/tugtool \
                 test run --suite checks --kind cargo-test --label checks --needle 'make check' \
                 -- make check -j4 | tail -3"
            )
        );
        // The built-ins still stand beside it.
        assert!(
            rewritten_in(&dir, "cargo test")
                .unwrap()
                .contains("--suite rust --kind cargo-test ")
        );
        // A row with no suite records under its head's last word.
        let dir = project_declaring(
            "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"cargo-test\"\n",
        );
        assert!(
            rewritten_in(&dir, "make check")
                .unwrap()
                .contains("--suite check --kind cargo-test --label 'make check' ")
        );
    }

    #[test]
    fn a_declared_lines_row_carries_its_rule_single_quoted() {
        let dir = project_declaring(
            "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"lines\"\nitem = \"^(?P<status>PASS|FAIL): (?P<name>[^ ']+)\"\ntotal = '^running (?P<total>\\d+) checks'\nstream = \"stdout\"\nunit = \"check\"\n",
        );
        assert_eq!(
            rewritten_in(&dir, "make check").as_deref(),
            Some(
                "# tug-call: toolu_01A\n/Applications/Tug.app/Contents/MacOS/tugtool \
                 test run --suite check --kind lines \
                 --item '^(?P<status>PASS|FAIL): (?P<name>[^ '\\'']+)' \
                 --total '^running (?P<total>\\d+) checks' --stream stdout --unit check \
                 --label 'make check' --needle 'make check' -- make check"
            )
        );
        // A kind with a rule of its own may not declare a regex: the loader
        // refuses the config, and the hook falls back to the built-ins, so
        // the row is not honoured in silence — `tugtool report runners`
        // shows the refusal.
        let dir = project_declaring(
            "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"tap\"\nitem = '^(?P<status>ok) (?P<name>\\S+)'\nunit = \"check\"\n",
        );
        assert_eq!(
            rewritten_in(&dir, "make check").as_deref(),
            Some("# tug-call: toolu_01A\nmake check")
        );
    }

    #[test]
    fn a_declared_unit_row_gets_the_call_id_and_nothing_else() {
        let dir = project_declaring(
            "[[tugtool.report.runner]]\nmatch = \"just app-test\"\nunit = \"file\"\n",
        );
        assert_eq!(
            rewritten_in(&dir, "just app-test at0707.test.ts").as_deref(),
            Some("# tug-call: toolu_01A\njust app-test at0707.test.ts")
        );
        assert_eq!(
            rewritten_in(&dir, "FOO=1 just app-test 2>&1 | tail -20").as_deref(),
            Some("# tug-call: toolu_01A\nFOO=1 just app-test 2>&1 | tail -20")
        );
        // A neighbouring recipe is not the declared one; like every readable
        // call it carries the id, and nothing marks it a runner.
        assert_eq!(
            rewritten_in(&dir, "just app-test-build").as_deref(),
            Some("# tug-call: toolu_01A\njust app-test-build")
        );
        // An id the model set inline stands nearest the command, and wins
        // there; the mark stands in front of it for everything else.
        assert_eq!(
            rewritten_in(&dir, "TUG_TOOL_USE_ID=x just app-test").as_deref(),
            Some("# tug-call: toolu_01A\nTUG_TOOL_USE_ID=x just app-test")
        );

        // Without a plain id there is nothing to mark, so nothing changes.
        let runners = runners::for_cwd(dir.path().to_str());
        for id in [None, Some("x; rm -rf /")] {
            assert_eq!(
                rewrite_command("just app-test", None, id, TUGTOOL, &runners),
                None
            );
        }
    }

    #[test]
    fn a_declared_head_shadows_the_built_in_it_equals() {
        let dir =
            project_declaring("[[tugtool.report.runner]]\nmatch = \"bun test\"\nunit = \"file\"\n");
        assert_eq!(
            rewritten_in(&dir, "bun test src").as_deref(),
            Some("# tug-call: toolu_01A\nbun test src")
        );
    }

    #[test]
    fn a_config_that_does_not_load_leaves_the_built_ins_alone() {
        for config in [
            "[[tugtool.report.runner]]\nmatch = \"make check\"\nkind = \"pyunit\"\n",
            "this is not toml = = =",
        ] {
            let dir = project_declaring(config);
            let out = rewritten_in(&dir, "make check").unwrap();
            assert!(!out.contains(" test run "), "{config}: {out}");
            assert!(
                rewritten_in(&dir, "cargo test")
                    .unwrap()
                    .contains("--kind cargo-test "),
                "{config}"
            );
        }
    }

    #[test]
    fn the_rewrite_replaces_the_command_and_keeps_every_other_field() {
        let payload = json!({
            "tool_name": "Bash",
            "tool_input": { "command": "cargo nextest run", "description": "Run tests", "timeout": 600000 },
            "cwd": "/proj",
            "tool_use_id": "toolu_01A",
        });
        let Some(Decision::Rewrite(input)) = bash_rewrite(&payload, TUGTOOL) else {
            panic!("expected a rewrite");
        };
        assert_eq!(input["description"], "Run tests");
        assert_eq!(input["timeout"], 600000);
        assert!(
            input["command"]
                .as_str()
                .unwrap()
                .starts_with("# tug-call: toolu_01A\n")
        );

        // Rendered, it is `updatedInput` alone: no permission decision.
        let out: Value = serde_json::from_str(&Decision::Rewrite(input).render()).unwrap();
        let specific = &out["hookSpecificOutput"];
        assert_eq!(specific["hookEventName"], "PreToolUse");
        assert!(specific.get("permissionDecision").is_none());
        assert_eq!(specific["updatedInput"]["description"], "Run tests");
    }

    #[test]
    fn the_hook_wraps_a_typed_runner_and_a_deny_outranks_the_wrap() {
        let dir = checkout();
        let cwd = dir.path().to_string_lossy().into_owned();
        match pre_tool_use(&bash_in("cargo nextest run -p tugtool", &cwd)) {
            Some(Decision::Rewrite(input)) => {
                let command = input["command"].as_str().unwrap();
                assert!(
                    command.contains(" test run --suite rust --kind nextest "),
                    "{command}"
                );
                assert!(
                    command.ends_with(" -- cargo nextest run -p tugtool"),
                    "{command}"
                );
            }
            other => panic!("expected a rewrite, got {other:?}"),
        }
        // And after a step closed this turn the wrap still happens: a test
        // run is a read of the last step's work, not the next step's.
        assert!(matches!(
            pre_tool_use_after_closing(&bash_in("bun test", &cwd), 1),
            Some(Decision::Rewrite(_))
        ));
    }

    #[test]
    fn every_readable_call_carries_its_id_once_and_an_unreadable_one_does_not() {
        assert_eq!(
            wrap("cargo fmt --check 2>&1 | tail -3").as_deref(),
            Some("# tug-call: toolu_01A\ncargo fmt --check 2>&1 | tail -3")
        );
        assert_eq!(
            wrap("cd tugdeck && bunx eslint .").as_deref(),
            Some("# tug-call: toolu_01A\ncd tugdeck && bunx eslint .")
        );
        // Already carried: nothing to add.
        assert_eq!(wrap("# tug-call: toolu_01A\ncargo fmt"), None);
        // Unreadable: the ladder cannot place a command, so nothing is touched.
        assert_eq!(wrap("cat <<EOF | sh\ncargo fmt\nEOF"), None);
        assert_eq!(wrap("x=$(cargo fmt)"), None);
    }

    #[test]
    fn a_runner_behind_a_heredoc_is_refused_and_names_the_split() {
        let refusal = |command: &str| dark_runner_refusal(command, &runners::built_in());
        let edit_then_run = "tugtool file edit <<'EOF'\nfile src/a.rs\n  replace \"x\" with \"y\"\nEOF\ncargo nextest run -p x";
        let reason = refusal(edit_then_run).expect("refused");
        assert!(
            reason.starts_with("`cargo nextest run` would run dark here"),
            "{reason}"
        );
        assert!(reason.contains("a runner tugtool knows"), "{reason}");
        assert!(reason.contains("a here-document"), "{reason}");
        assert!(reason.contains("own Bash call"), "{reason}");
        assert!(
            reason.contains("`cargo nextest run …` alone in the next"),
            "{reason}"
        );
        // The construct is named, whichever it is; the runner is found past a
        // `cd`, an assignment, inside the substitution, and in a probe.
        for (command, construct, head) in [
            (
                "x=$(cargo test 2>&1)",
                "a command substitution",
                "cargo test",
            ),
            ("echo `bun test`", "a backtick substitution", "bun test"),
            (
                "cat <<EOF > /tmp/x\nhi\nEOF\ncd web && FOO=1 bun test",
                "a here-document",
                "bun test",
            ),
            (
                "cat <<-'EOF'\n\thi\n\tEOF\npytest -q",
                "a here-document",
                "pytest",
            ),
            ("cargo test 'unclosed", "an unclosed quote", "cargo test"),
            ("tr a b <<< x; go test ./...", "a here-string", "go test"),
            (
                "cat <<EOF\nhi\nEOF\ntugtool file probe --patch p.diff -- cargo test -p x",
                "a here-document",
                "cargo test",
            ),
        ] {
            let reason = refusal(command).unwrap_or_else(|| panic!("{command:?} must be refused"));
            assert!(
                reason.starts_with(&format!("`{head}` would run dark")),
                "{command:?}: {reason}"
            );
            assert!(reason.contains(construct), "{command:?}: {reason}");
        }
        // A runner's head inside a here-document's body is data, not a run:
        // an edit program may mention `cargo test` without being refused.
        for command in [
            "tugtool file edit <<'EOF'\nfile README.md\n  replace \"cargo test\" with \"cargo nextest run\"\nEOF",
            "cat > /tmp/notes.md <<EOF\ncargo test -p x\nbun test\nEOF",
            "cat <<EOF | sh\ncargo test\nEOF",
            "x=$(ls)",
            "echo 'cargo test",
            "echo \"$(date)\" && cargo fmt",
        ] {
            assert_eq!(refusal(command), None, "{command:?}");
        }
        // A line that reads is never this refusal's business.
        assert_eq!(refusal("cargo test"), None);
        assert_eq!(refusal("echo cargo test"), None);
    }

    #[test]
    fn a_declared_runner_behind_a_heredoc_is_refused_as_the_projects() {
        let dir = project_declaring(
            "[[tugtool.report.runner]]\nmatch = \"just app-test\"\nunit = \"file\"\n",
        );
        let runners = runners::for_cwd(Some(&dir.path().to_string_lossy()));
        let reason =
            dark_runner_refusal("cat <<EOF\nhi\nEOF\njust app-test at0707.test.ts", &runners)
                .expect("refused");
        assert!(
            reason.starts_with("`just app-test` would run dark"),
            "{reason}"
        );
        assert!(
            reason.contains("a runner this project declares"),
            "{reason}"
        );
        // On the project that declares nothing, `just app-test` is any command.
        assert_eq!(
            dark_runner_refusal(
                "cat <<EOF\nhi\nEOF\njust app-test at0707.test.ts",
                &runners::built_in()
            ),
            None
        );
    }

    #[test]
    fn the_dark_runner_refusal_outranks_the_prefix_approval_and_rides_the_hook() {
        // `tugtool` is an approved prefix, and the edit program is the one
        // shape that most often hides a run; the call is denied, not allowed.
        let edit_then_run =
            "tugtool file edit <<'EOF'\nfile src/a.rs\n  replace \"x\" with \"y\"\nEOF\ncargo test";
        match pre_tool_use(&bash(edit_then_run)) {
            Some(Decision::Deny(reason)) => assert!(reason.contains("`cargo test`"), "{reason}"),
            other => panic!("expected a deny, got {other:?}"),
        }
        // And through the unapproved path too.
        match pre_tool_use(&bash("x=$(bun test 2>&1); echo $x")) {
            Some(Decision::Deny(reason)) => assert!(reason.contains("`bun test`"), "{reason}"),
            other => panic!("expected a deny, got {other:?}"),
        }
        // A heredoc with no runner in it is left exactly as it was.
        assert!(pre_tool_use(&bash("cat > /tmp/notes.md <<EOF\nhi\nEOF")).is_none());
        let out = Decision::Deny("x".into()).render();
        assert!(out.contains("\"permissionDecision\":\"deny\""), "{out}");
    }

    fn bash_background(command: &str) -> Value {
        json!({
            "tool_name": "Bash",
            "tool_input": { "command": command, "run_in_background": true },
            "cwd": "/proj",
            "tool_use_id": "toolu_01A",
        })
    }

    /// A runner asked to run in the background is refused and told the
    /// foreground timeout to pass, from the record when there is one; a
    /// command that is no runner may still run in the background.
    #[test]
    fn a_background_runner_is_refused_and_named_the_timeout_to_pass() {
        let no_record = |_: Option<&str>, _: &[String]| None;
        match bash_rewrite_with(
            &bash_background("cargo nextest run -p tugtool"),
            TUGTOOL,
            &no_record,
        ) {
            Some(Decision::Deny(reason)) => {
                assert!(
                    reason.starts_with("`cargo nextest run` never runs in the background"),
                    "{reason}"
                );
                assert!(
                    reason.contains("`timeout: 600000`"),
                    "the ceiling when nothing is recorded: {reason}"
                );
                assert!(reason.contains("server, watcher or sampler"), "{reason}");
            }
            other => panic!("expected a deny, got {other:?}"),
        }
        let recorded = |_: Option<&str>, suites: &[String]| {
            assert_eq!(suites, ["rust".to_string()]);
            Some(100.0)
        };
        match bash_rewrite_with(
            &bash_background("cd tugrust && cargo nextest run"),
            TUGTOOL,
            &recorded,
        ) {
            Some(Decision::Deny(reason)) => {
                assert!(
                    reason.contains("`timeout: 230000`"),
                    "twice the median plus 30s: {reason}"
                );
            }
            other => panic!("expected a deny, got {other:?}"),
        }
        // A runner the line hides is refused as a background run too, since
        // the dark-runner refusal reads it first.
        assert!(matches!(
            bash_rewrite_with(
                &bash_background("x=$(bun test); echo $x"),
                TUGTOOL,
                &no_record
            ),
            Some(Decision::Deny(_))
        ));
        // A server is the exception: not refused, only given its call id.
        assert!(!matches!(
            bash_rewrite_with(&bash_background("bun run dev"), TUGTOOL, &no_record),
            Some(Decision::Deny(_))
        ));
        // Through the hook itself, with the field as Claude Code sends it.
        assert!(matches!(
            pre_tool_use(&bash_background("cargo build")),
            Some(Decision::Deny(_))
        ));
    }

    /// A runner piped into `grep` or `head` is refused with the `tail` form;
    /// a `tail` is left as it was, and so is a filter after one.
    #[test]
    fn a_runner_piped_into_grep_or_head_is_refused_with_the_tail_form() {
        let runners = runners::built_in();
        let refusal = |command: &str| filtered_runner_refusal(command, &runners);
        let reason = refusal("cargo build 2>&1 | grep -E '^(error|warning)' -A 6 | head -80")
            .expect("a grep on a build is refused");
        assert!(
            reason.starts_with("`cargo build … | grep` guesses"),
            "{reason}"
        );
        assert!(reason.contains("`2>&1 | tail -3`"), "{reason}");
        let reason = refusal("cd tugdeck && bun test 2>&1 | head -40").unwrap();
        assert!(reason.starts_with("`bun test … | head`"), "{reason}");
        assert!(
            refusal("cargo nextest run 2>&1 | tail -5").is_none(),
            "tail keeps the verdict"
        );
        assert!(
            refusal("cargo nextest run || grep -r x src").is_none(),
            "`||` is not a pipe"
        );
        assert!(refusal("ls | grep rs").is_none(), "no runner, no opinion");
        assert!(
            refusal("cargo nextest run 2>&1 | tail -20 | grep FAIL").is_none(),
            "the filter is on tail"
        );
        assert!(
            refusal("cargo build 2>&1 | tail -3; bun test 2>&1 | grep fail").is_some(),
            "a tailed runner earlier in the line does not hide a filtered one after it"
        );
        // Through the hook: denied, not rewritten.
        match pre_tool_use(&bash("cargo nextest run -p tugtool 2>&1 | grep -c FAIL")) {
            Some(Decision::Deny(reason)) => assert!(reason.contains("tail -3"), "{reason}"),
            other => panic!("expected a deny, got {other:?}"),
        }
    }

    /// The rewrite supplies the call's timeout from the record and never
    /// shortens one; with no record the call keeps whatever it passed.
    #[test]
    fn the_supplied_timeout_comes_from_the_record_and_never_shortens_a_call() {
        let payload = |timeout: Option<u64>| {
            let mut input = json!({ "command": "cargo nextest run -p tugtool" });
            if let Some(t) = timeout {
                input["timeout"] = t.into();
            }
            json!({ "tool_name": "Bash", "tool_input": input, "cwd": "/proj", "tool_use_id": "toolu_01A" })
        };
        let rewritten = |payload: &Value, median: Option<f64>| -> Value {
            let median = move |_: Option<&str>, _: &[String]| median;
            match bash_rewrite_with(payload, TUGTOOL, &median) {
                Some(Decision::Rewrite(input)) => input,
                other => panic!("expected a rewrite, got {other:?}"),
            }
        };
        assert_eq!(supplied_timeout_ms(100.0), 230_000);
        assert_eq!(
            supplied_timeout_ms(400.0),
            HARNESS_MAX_TIMEOUT_MS,
            "clamped to the ceiling"
        );

        let input = rewritten(&payload(None), Some(100.0));
        assert_eq!(
            input["timeout"], 230_000,
            "none passed: the default was less"
        );
        let input = rewritten(&payload(Some(600_000)), Some(100.0));
        assert_eq!(input["timeout"], 600_000, "a longer timeout is kept");
        let input = rewritten(&payload(Some(60_000)), Some(20.0));
        assert_eq!(input["timeout"], 70_000, "a shorter one is raised");
        let input = rewritten(&payload(None), Some(10.0));
        assert!(
            input.get("timeout").is_none(),
            "50s is under the default, which stands"
        );
        let input = rewritten(&payload(None), None);
        assert!(input.get("timeout").is_none(), "no record, no opinion");
        assert!(input["command"].as_str().unwrap().contains("--suite rust"));
    }

    #[test]
    fn a_probe_is_rewritten_at_its_inner_command() {
        assert_eq!(
            wrap("tugtool file probe --patch p.diff -- cargo nextest run -p x").as_deref(),
            Some(
                "# tug-call: toolu_01A\ntugtool file probe --patch p.diff -- \
                 /Applications/Tug.app/Contents/MacOS/tugtool test run --suite rust --kind nextest \
                 --label 'cargo nextest run' --needle 'cargo nextest run' -- cargo nextest run -p x"
            )
        );
        // By any path, with a `--path`, and the inner command's own assignment kept.
        assert_eq!(
            wrap(
                "/Applications/Tug.app/Contents/MacOS/tugtool file probe --path a.ts -- RUST_LOG=x cargo test"
            )
            .as_deref(),
            Some(
                "# tug-call: toolu_01A\n/Applications/Tug.app/Contents/MacOS/tugtool file probe \
                 --path a.ts -- RUST_LOG=x /Applications/Tug.app/Contents/MacOS/tugtool test run --suite rust \
                 --kind cargo-test --label 'cargo test' --needle 'cargo test' -- cargo test"
            )
        );
        // A probe around no runner carries the id and nothing else.
        assert_eq!(
            wrap("tugtool file probe --patch p.diff -- cargo fmt").as_deref(),
            Some("# tug-call: toolu_01A\ntugtool file probe --patch p.diff -- cargo fmt")
        );
        // A declared unit row inside a probe needs nothing more than the mark,
        // which the probe hands on to its child.
        let dir = project_declaring(
            "[[tugtool.report.runner]]\nmatch = \"just app-test\"\nunit = \"file\"\n",
        );
        assert_eq!(
            rewritten_in(
                &dir,
                "tugtool file probe --patch p.diff -- just app-test at0707.test.ts"
            )
            .as_deref(),
            Some(
                "# tug-call: toolu_01A\ntugtool file probe --patch p.diff -- just app-test at0707.test.ts"
            )
        );
    }

    #[test]
    fn an_approved_prefix_is_allowed_and_rewritten_in_one_answer() {
        let payload = json!({
            "tool_name": "Bash",
            "tool_input": { "command": "tugtool file probe --patch p.diff -- cargo test" },
            "cwd": "/proj",
            "tool_use_id": "toolu_01A",
        });
        match pre_tool_use(&payload) {
            Some(Decision::AllowRewrite(reason, input)) => {
                assert_eq!(reason, "tugplug auto-approved");
                let command = input["command"].as_str().unwrap();
                assert!(
                    command.starts_with(
                        "# tug-call: toolu_01A\ntugtool file probe --patch p.diff -- "
                    ),
                    "{command}"
                );
                assert!(
                    command.contains(" test run --suite rust --kind cargo-test "),
                    "{command}"
                );
                assert!(command.ends_with(" -- cargo test"), "{command}");
            }
            other => panic!("expected allow and rewrite, got {other:?}"),
        }
        // With no id to carry and no runner, the approval is as it always was.
        assert_eq!(
            pre_tool_use(&bash("ls -la")),
            Some(Decision::Allow("tugplug auto-approved"))
        );
    }
}

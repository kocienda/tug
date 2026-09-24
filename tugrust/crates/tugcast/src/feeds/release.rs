//! Release verbs — the check, the dispatch, and the one poll in the product.
//!
//! A project declares what a release *is* in three strings under
//! `[tugtool.release]` (`check`, `dispatch`, `workflow`). This module runs the
//! first two through `sh -c` on the login PATH, and watches the run the second
//! one queues. Nothing here knows anything about *this* project's release: the
//! commands are the project's, and a project that declares no table gets a named
//! refusal rather than a guess.
//!
//! **The server re-checks before it dispatches, and that is the point.** A
//! client that has held a passing check on screen for ten minutes is holding a
//! claim about a tree that has moved since. So `release_dispatch` runs the check
//! again itself and refuses with its rows on a failure, unless the caller sent
//! `force` — the landing doctrine's rule that the gate lives at the act rather
//! than only at the affordance.
//!
//! **The run watch is the one poll in this product, and it is not a licence for
//! another.** Everything else Tug watches has a push channel — a file watcher, a
//! git watcher, a process's own output — and [L33] says a wait needs a horizon
//! rather than a timer. GitHub offers no push channel for workflow-run status,
//! so the status has to be asked for; what makes this legal rather than a
//! standing timer is that it has three horizons and every one of them is named:
//!
//! - the run reaching `completed`, which is what the watch is *for*;
//! - a 45-minute ceiling, whose final frame says `abandoned` out loud rather
//!   than going quiet (the workflow's own timeout is 120 minutes, so a run that
//!   legitimately outlives the ceiling reads as abandoned while still running on
//!   GitHub — its URL is on the sheet for exactly that case);
//! - tugcast shutting down, which ends every task it owns.
//!
//! A failed `gh` is not a horizon: it broadcasts `status: "unreachable"` and the
//! watch keeps going, because a dropped network is not a finished run.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::broadcast;
use tugcast_core::{FeedId, Frame};
use tugtool_core::config::ReleaseConfig;

/// How long a configured command may run before it is killed. The check is a
/// full preflight — it talks to origin four times — so the ceiling is generous;
/// what it is for is a command that hangs on a prompt nobody can answer.
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// How long to keep asking for a run id after the dispatch, and how often. The
/// dispatch returns before GitHub has created the run, so the id has to be
/// discovered rather than read.
const RUN_DISCOVERY_CEILING: Duration = Duration::from_secs(60);
const RUN_DISCOVERY_INTERVAL: Duration = Duration::from_secs(2);

/// The watch's own two constants: how often it asks, and when it gives up and
/// says so.
const WATCH_INTERVAL_DEFAULT: Duration = Duration::from_secs(5);
const WATCH_CEILING: Duration = Duration::from_secs(45 * 60);

/// How many lines of a failed run's log ride the final frame. Enough to show
/// the error, few enough that the frame is not the log.
const FAILED_LOG_LINES: usize = 40;

/// One row of the check's output — a mark and the text beside it (Spec S02).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CheckRow {
    pub(crate) mark: &'static str,
    pub(crate) text: String,
}

/// What a `release_check` produced.
#[derive(Debug, Clone)]
pub(crate) struct CheckOutcome {
    pub(crate) rows: Vec<CheckRow>,
    pub(crate) passed: bool,
    pub(crate) exit_code: Option<i32>,
    pub(crate) raw: String,
}

/// Turn a check's merged output into rows, and say whether it passed (Spec
/// S02).
///
/// **The exit code decides `passed`, never the rows.** A transcript with no
/// `FAIL` line is not a pass — a check that died before printing anything would
/// read as blessed — and a `FAIL` line in a `note`'s prose is not a failure. The
/// rows are for the reader; the exit code is the verdict.
///
/// An unmarked line produces no row and is not lost: `raw` carries the whole
/// output, so the closing `NOT blessed` line and a `Blessed:` block stay
/// readable in a fold.
pub(crate) fn parse_check_output(merged: &str, exit_code: Option<i32>) -> (Vec<CheckRow>, bool) {
    let mut rows = Vec::new();
    for line in merged.lines() {
        // `ok` rows are indented in the recipe's own output and the others are
        // not, so the leading trim is taken first and the mark read from what is
        // left. Two spaces after the mark is the recipe's column, but one is
        // enough to be a row — the grammar is "mark, whitespace, text".
        let trimmed = line.trim_start();
        let row = if let Some(rest) = trimmed.strip_prefix("FAIL") {
            mark_row("fail", rest)
        } else if let Some(rest) = trimmed.strip_prefix("ok") {
            mark_row("ok", rest)
        } else if let Some(rest) = trimmed.strip_prefix("note") {
            mark_row("note", rest)
        } else {
            None
        };
        if let Some(row) = row {
            rows.push(row);
        }
    }
    (rows, exit_code == Some(0))
}

/// A mark's row, when whitespace really separates it from its text. Without the
/// whitespace check a line beginning `okay` would read as an `ok` row about
/// `ay`.
fn mark_row(mark: &'static str, rest: &str) -> Option<CheckRow> {
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let text = rest.trim();
    if text.is_empty() {
        return None;
    }
    Some(CheckRow {
        mark,
        text: text.to_string(),
    })
}

/// Run one of the project's configured commands and hand back its merged output
/// and exit status.
///
/// `sh -c` because the strings are the project's own shell commands, written to
/// be read as shell. The environment is the three things that make a command
/// written for a terminal work in a card: the login PATH (a GUI process inherits
/// almost none of it, and `gh` lives in the part it lacks), `GH_PROMPT_DISABLED`
/// so a `gh` that wants to ask something fails instead of hanging, and
/// `NO_COLOR` so the rows are text rather than escape sequences. Stdin is
/// `/dev/null` ([D111]) — there is no TTY here and a command that reads one is a
/// command that hangs.
///
/// stdout and stderr are merged inside the `sh -c` string rather than read from
/// two pipes, so the interleaving is the shell's and the order the reader sees
/// is the order the command printed.
///
/// The merge is `exec 2>&1` on its own first line, not a `2>&1` appended to the
/// command. Appending binds to the *last* command of a list, so
/// `a; b >&2; exit 1` merged that way loses `b` entirely; `exec` with only
/// redirections sets them on the shell itself, before anything runs, so every
/// command in the string inherits the merge however the string is shaped. The
/// shell's stderr is still piped and appended, because a syntax error in the
/// string is raised before `exec` and would otherwise vanish.
pub(crate) async fn run_configured(
    project_dir: &Path,
    command: &str,
    timeout: Duration,
) -> Result<(String, Option<i32>), String> {
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(format!("exec 2>&1\n{command}"))
        .current_dir(project_dir)
        .env("PATH", tuggram::probe_login_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("could not run {command:?}: {err}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let wait = async move {
        let mut merged = String::new();
        if let Some(mut out) = stdout {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf).await;
            merged = String::from_utf8_lossy(&buf).into_owned();
        }
        if let Some(mut err) = stderr {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf).await;
            merged.push_str(&String::from_utf8_lossy(&buf));
        }
        let status = child.wait().await;
        (merged, status)
    };

    match tokio::time::timeout(timeout, wait).await {
        // The timeout-abandoned future drops the child, and `kill_on_drop`
        // makes that a kill rather than an orphan still holding a connection.
        Err(_) => Err(format!(
            "{command} timed out after {}s",
            timeout.as_secs()
        )),
        Ok((merged, Err(err))) => Err(format!("could not wait for {command:?}: {err}\n{merged}")),
        Ok((merged, Ok(status))) => Ok((merged, status.code())),
    }
}

/// Run the project's `check` and read its rows.
pub(crate) async fn do_release_check(
    project_dir: &Path,
    config: &ReleaseConfig,
) -> Result<CheckOutcome, String> {
    let (raw, exit_code) = run_configured(project_dir, &config.check, COMMAND_TIMEOUT).await?;
    let (rows, passed) = parse_check_output(&raw, exit_code);
    Ok(CheckOutcome {
        rows,
        passed,
        exit_code,
        raw,
    })
}

/// A dispatch that landed: the run it queued, and where to read it.
#[derive(Debug, Clone)]
pub(crate) struct Dispatched {
    pub(crate) run_id: String,
    pub(crate) url: String,
}

/// Why a dispatch did not happen. A failed re-check carries its rows, because
/// the sheet's whole answer to "why not" is the check that said no.
#[derive(Debug, Clone)]
pub(crate) struct DispatchRefusal {
    pub(crate) detail: String,
    pub(crate) rows: Option<Vec<CheckRow>>,
}

impl DispatchRefusal {
    fn plain(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            rows: None,
        }
    }
}

/// The newest run id `gh` reports for a workflow, or `None` when it cannot be
/// read. A workflow with no runs yet and an unreachable `gh` are the same answer
/// here on purpose: neither is a run this dispatch made.
pub(crate) async fn gh_newest_run_id(project_dir: &Path, workflow: &str) -> Option<String> {
    let command = format!(
        "gh run list --workflow {} --limit 1 --json databaseId --jq '.[].databaseId'",
        shell_quote(workflow)
    );
    let (out, code) = run_configured(project_dir, &command, COMMAND_TIMEOUT)
        .await
        .ok()?;
    if code != Some(0) {
        return None;
    }
    let id = out.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// The run this dispatch made, if the candidate is one.
///
/// A candidate equal to `prior` is the run that was already there, which is the
/// case the whole discovery loop exists to wait past. `None` in either position
/// is not a new run — with no candidate there is nothing to return, and with no
/// prior a candidate is genuinely new (a workflow's first run).
pub(crate) fn newest_run_after(prior: Option<&str>, candidate: Option<&str>) -> Option<String> {
    let candidate = candidate?;
    match prior {
        Some(prior) if prior == candidate => None,
        _ => Some(candidate.to_string()),
    }
}

/// Re-check, dispatch, and find the run the dispatch queued.
///
/// `force` skips the re-check and nothing else: it is the user's override of a
/// check they have read and decided against, not a way to dispatch without one
/// having run.
pub(crate) async fn do_release_dispatch(
    project_dir: &Path,
    config: &ReleaseConfig,
    force: bool,
) -> Result<Dispatched, DispatchRefusal> {
    if !force {
        let outcome = do_release_check(project_dir, config)
            .await
            .map_err(DispatchRefusal::plain)?;
        if !outcome.passed {
            return Err(DispatchRefusal {
                detail: "the release check did not pass — dispatch anyway to override it"
                    .to_string(),
                rows: Some(outcome.rows),
            });
        }
    }

    // Read the newest run BEFORE dispatching, so the run this dispatch makes can
    // be told from the one that was already there. Without it a re-dispatch
    // would watch the previous run and report it as this one's.
    let prior = gh_newest_run_id(project_dir, &config.workflow).await;

    let (raw, code) = run_configured(project_dir, &config.dispatch, COMMAND_TIMEOUT)
        .await
        .map_err(DispatchRefusal::plain)?;
    if code != Some(0) {
        let detail = raw
            .lines()
            .rfind(|line| !line.trim().is_empty())
            .unwrap_or("the dispatch command failed")
            .trim()
            .to_string();
        return Err(DispatchRefusal::plain(detail));
    }

    let deadline = tokio::time::Instant::now() + RUN_DISCOVERY_CEILING;
    loop {
        let candidate = gh_newest_run_id(project_dir, &config.workflow).await;
        if let Some(run_id) = newest_run_after(prior.as_deref(), candidate.as_deref()) {
            let url = gh_run_url(project_dir, &run_id).await.unwrap_or_default();
            return Ok(Dispatched { run_id, url });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(DispatchRefusal::plain(format!(
                "Dispatched, but no new run appeared within a minute — follow it with: gh run list --workflow {}",
                config.workflow
            )));
        }
        tokio::time::sleep(RUN_DISCOVERY_INTERVAL).await;
    }
}

/// A run's web URL, for the sheet's one escape to GitHub.
async fn gh_run_url(project_dir: &Path, run_id: &str) -> Option<String> {
    let command = format!(
        "gh run view {} --json url --jq .url",
        shell_quote(run_id)
    );
    let (out, code) = run_configured(project_dir, &command, COMMAND_TIMEOUT)
        .await
        .ok()?;
    if code != Some(0) {
        return None;
    }
    let url = out.trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

/// One step of a run's job, as the sheet draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunStep {
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) conclusion: String,
    /// Epoch milliseconds, or `None` when GitHub has not set the field yet — a
    /// queued step has no start and an in-flight one has no completion.
    pub(crate) started_at_ms: Option<i64>,
    pub(crate) completed_at_ms: Option<i64>,
}

/// A run, as one poll saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunSnapshot {
    pub(crate) status: String,
    pub(crate) conclusion: String,
    pub(crate) url: String,
    pub(crate) steps: Vec<RunStep>,
}

/// Read a `gh run view --json status,conclusion,url,jobs` capture.
///
/// Steps are flattened across jobs in the order `gh` prints them, which is the
/// order they ran; the sheet draws one list because the release workflow is one
/// job, and a multi-job workflow reading as one sequence is still the truth
/// about what happened in what order.
///
/// A field GitHub has not set yet is `None` rather than zero: a queued step
/// with `started_at_ms: Some(0)` would draw as having started at the epoch.
pub(crate) fn parse_run_snapshot(json: &str) -> Option<RunSnapshot> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let object = value.as_object()?;
    let text = |key: &str| -> String {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let mut steps = Vec::new();
    if let Some(jobs) = object.get("jobs").and_then(|v| v.as_array()) {
        for job in jobs {
            let Some(job_steps) = job.get("steps").and_then(|v| v.as_array()) else {
                continue;
            };
            for step in job_steps {
                let field = |key: &str| -> String {
                    step.get(key)
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string()
                };
                steps.push(RunStep {
                    name: field("name"),
                    status: field("status"),
                    conclusion: field("conclusion"),
                    started_at_ms: iso8601_to_epoch_ms(step.get("startedAt")),
                    completed_at_ms: iso8601_to_epoch_ms(step.get("completedAt")),
                });
            }
        }
    }
    Some(RunSnapshot {
        status: text("status"),
        conclusion: text("conclusion"),
        url: text("url"),
        steps,
    })
}

/// An ISO-8601 instant as epoch milliseconds.
///
/// GitHub writes an unset timestamp as `null` *or* as the zero instant
/// (`0001-01-01T00:00:00Z`), and both mean "has not happened". Both read as
/// `None`, so a caller never has to know which spelling arrived.
fn iso8601_to_epoch_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    let text = value?.as_str()?;
    if text.is_empty() || text.starts_with("0001-01-01") {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Shell-quote one argument for a `sh -c` string. The workflow name and a run
/// id come from a config file and from `gh`, so neither is hostile — but a
/// composed shell string with an unquoted value in it is a shape that becomes
/// wrong the first time somebody puts a space in a workflow name.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The live-watch registry's type, named so the `OnceLock` reads.
type WatchRegistry = Mutex<HashMap<(String, String), tokio::task::JoinHandle<()>>>;

/// The live watches, keyed by the pair they are about, so a second
/// `release_watch` for a run already being watched is a no-op rather than a
/// second poller asking the same question twice as often.
fn watchers() -> &'static WatchRegistry {
    static WATCHERS: OnceLock<WatchRegistry> = OnceLock::new();
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How often the watch asks. Overridable for tests, which cannot wait 5 seconds
/// per assertion.
fn watch_interval() -> Duration {
    std::env::var("TUG_RELEASE_WATCH_INTERVAL")
        .ok()
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|secs| *secs > 0.0)
        .map(Duration::from_secs_f64)
        .unwrap_or(WATCH_INTERVAL_DEFAULT)
}

/// Start watching a run, unless this pair is already being watched.
///
/// Idempotent per `(project_dir, run_id)`: the dispatch starts one and a
/// `release_watch` from a reloaded deck asks for the same one, and the second ask
/// must not double the polling rate. A handle whose task has finished is
/// replaced, so a re-watch after a completed run starts a fresh one rather than
/// silently doing nothing.
///
/// It takes no `ReleaseConfig`: a watch is addressed by run id and asks `gh` for
/// that id, so the workflow name is not one of its inputs. The caller still
/// resolves the config first, because a project that declares no release has no
/// run to be watching and the refusal belongs at the request.
pub(crate) fn spawn_watch(
    control_tx: broadcast::Sender<Frame>,
    project_dir: &str,
    run_id: &str,
) {
    let key = (project_dir.to_string(), run_id.to_string());
    let mut live = match watchers().lock() {
        Ok(live) => live,
        // A poisoned map means a watch panicked. Losing the registry is better
        // than refusing every watch from here on, and the worst case is one
        // duplicate poller.
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(handle) = live.get(&key) {
        if !handle.is_finished() {
            return;
        }
    }
    let dir = PathBuf::from(project_dir);
    let project = project_dir.to_string();
    let run = run_id.to_string();
    let handle = tokio::spawn(async move {
        watch_run(control_tx, dir, project, run).await;
    });
    live.insert(key, handle);
}

/// The watch itself: ask, broadcast, and stop at one of the three horizons.
async fn watch_run(
    control_tx: broadcast::Sender<Frame>,
    dir: PathBuf,
    project_dir: String,
    run_id: String,
) {
    let watched_since_ms = chrono::Utc::now().timestamp_millis();
    let deadline = tokio::time::Instant::now() + WATCH_CEILING;
    let interval = watch_interval();
    let command = format!(
        "gh run view {} --json status,conclusion,url,jobs",
        shell_quote(&run_id)
    );

    loop {
        let snapshot = match run_configured(&dir, &command, COMMAND_TIMEOUT).await {
            Ok((out, Some(0))) => parse_run_snapshot(&out),
            // A `gh` that failed or printed something unreadable is a dropped
            // network, not a finished run.
            _ => None,
        };

        match snapshot {
            Some(snapshot) => {
                let completed = snapshot.status == "completed";
                let failed_log = if completed && snapshot.conclusion == "failure" {
                    fetch_failed_log(&dir, &run_id).await
                } else {
                    None
                };
                broadcast_run_state(
                    &control_tx,
                    &project_dir,
                    &run_id,
                    &snapshot.url,
                    &snapshot.status,
                    &snapshot.conclusion,
                    &snapshot.steps,
                    watched_since_ms,
                    failed_log.as_deref(),
                );
                if completed {
                    return;
                }
            }
            None => {
                broadcast_run_state(
                    &control_tx,
                    &project_dir,
                    &run_id,
                    "",
                    "unreachable",
                    "",
                    &[],
                    watched_since_ms,
                    None,
                );
            }
        }

        if tokio::time::Instant::now() >= deadline {
            // The ceiling says so out loud. A watch that just stopped would
            // leave the sheet showing an in-flight step forever, which is the
            // one thing worse than saying the watch gave up.
            broadcast_run_state(
                &control_tx,
                &project_dir,
                &run_id,
                "",
                "abandoned",
                "",
                &[],
                watched_since_ms,
                None,
            );
            return;
        }
        tokio::time::sleep(interval).await;
    }
}

/// The tail of a failed run's log — enough to show the error without shipping
/// the log.
async fn fetch_failed_log(dir: &Path, run_id: &str) -> Option<String> {
    let command = format!(
        "gh run view {} --log-failed | tail -{FAILED_LOG_LINES}",
        shell_quote(run_id)
    );
    let (out, _) = run_configured(dir, &command, COMMAND_TIMEOUT).await.ok()?;
    let text = out.trim_end();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Broadcast one `release_run_state` frame (Spec S03).
#[allow(clippy::too_many_arguments)]
fn broadcast_run_state(
    control_tx: &broadcast::Sender<Frame>,
    project_dir: &str,
    run_id: &str,
    url: &str,
    status: &str,
    conclusion: &str,
    steps: &[RunStep],
    watched_since_ms: i64,
    failed_log: Option<&str>,
) {
    let mut body = serde_json::json!({
        "action": "release_run_state",
        "project_dir": project_dir,
        "run_id": run_id,
        "url": url,
        "status": status,
        "conclusion": conclusion,
        "steps": steps
            .iter()
            .map(|step| serde_json::json!({
                "name": step.name,
                "status": step.status,
                "conclusion": step.conclusion,
                "started_at_ms": step.started_at_ms,
                "completed_at_ms": step.completed_at_ms,
            }))
            .collect::<Vec<_>>(),
        "watched_since_ms": watched_since_ms,
    });
    if let Some(log) = failed_log {
        body["failed_log"] = serde_json::Value::String(log.to_string());
    }
    let _ = control_tx.send(Frame::new(
        FeedId::CONTROL,
        serde_json::to_vec(&body).expect("release_run_state serializes"),
    ));
}

/// The rows of a check, as the wire carries them (Spec S03).
pub(crate) fn rows_to_json(rows: &[CheckRow]) -> serde_json::Value {
    serde_json::Value::Array(
        rows.iter()
            .map(|row| serde_json::json!({ "mark": row.mark, "text": row.text }))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `just bless` transcript from this checkout, captured verbatim
    /// rather than composed. A fixture written to match the parser proves the
    /// parser matches itself; this one proves it matches the recipe.
    const BLESS_FAILING: &str = "bless 0.8.10 (CFBundleVersion 810)\n\
\n\
\x20 ok  version 0.8.10 reads the same in all four files\n\
\x20 ok  release-notes/0.8.10.md is written\n\
\x20 ok  the working tree is clean\n\
FAIL  HEAD is on 'tugarc/release-tug', not main\n\
FAIL  HEAD f61ceffa8 is not origin/main ce12d0565 — push before releasing\n\
FAIL  tag v0.8.10 already exists on origin — bump the version first\n\
FAIL  Tug-0.8.10.zip is already on the 'updates' release — bump the version first\n\
note  no ci.yml run recorded for f61ceffa8 (reported, not required)\n\
\n\
NOT blessed — fix the FAIL lines above.\n";

    #[test]
    fn parse_check_output_reads_a_real_failing_bless_transcript() {
        let (rows, passed) = parse_check_output(BLESS_FAILING, Some(1));
        assert!(!passed, "a non-zero exit is never a pass");
        let marks: Vec<&str> = rows.iter().map(|r| r.mark).collect();
        assert_eq!(
            marks,
            vec!["ok", "ok", "ok", "fail", "fail", "fail", "fail", "note"],
            "the rows arrive in the order the recipe printed them"
        );
        assert_eq!(rows[0].text, "version 0.8.10 reads the same in all four files");
        assert_eq!(rows[3].text, "HEAD is on 'tugarc/release-tug', not main");
        assert_eq!(
            rows[7].text,
            "no ci.yml run recorded for f61ceffa8 (reported, not required)"
        );
        // The banner, the blank lines and the closing sentence produce no rows —
        // and none of them is lost, because `raw` is the whole transcript.
        assert_eq!(rows.len(), 8);
    }

    #[test]
    fn a_zero_exit_over_ok_rows_is_a_pass_and_the_exit_code_is_the_verdict() {
        let all_ok = "  ok  one\n  ok  two\n\nBlessed: 0.9.0\n";
        let (rows, passed) = parse_check_output(all_ok, Some(0));
        assert!(passed);
        assert_eq!(rows.len(), 2);

        // The rows never decide. A check that printed nothing and exited 0 is a
        // pass; one that printed only `ok` rows and then died is not — which is
        // the case a row-counting parser gets wrong.
        assert!(parse_check_output("", Some(0)).1);
        assert!(!parse_check_output(all_ok, None).1);
        assert!(!parse_check_output(all_ok, Some(2)).1);
    }

    #[test]
    fn a_mark_needs_whitespace_after_it_to_be_a_row() {
        // `okay`, `notes` and `FAILURE` are words, not marks, and a bare mark
        // with nothing beside it says nothing.
        let (rows, _) = parse_check_output(
            "okay then\nnotes on the release\nFAILURE\nok\nnote\n  ok  real\n",
            Some(1),
        );
        assert_eq!(
            rows,
            vec![CheckRow {
                mark: "ok",
                text: "real".to_string()
            }]
        );
    }

    #[test]
    fn newest_run_after_only_answers_with_a_run_this_dispatch_made() {
        assert_eq!(newest_run_after(None, Some("2")), Some("2".to_string()));
        assert_eq!(newest_run_after(Some("1"), Some("1")), None);
        assert_eq!(newest_run_after(Some("1"), Some("2")), Some("2".to_string()));
        // Nothing to report is not a new run.
        assert_eq!(newest_run_after(None, None), None);
        assert_eq!(newest_run_after(Some("1"), None), None);
    }

    /// A trimmed `gh run view --json status,conclusion,url,jobs` capture: one
    /// completed step, one in flight, one queued.
    const RUN_JSON: &str = r#"{
      "status": "in_progress",
      "conclusion": "",
      "url": "https://github.com/o/r/actions/runs/42",
      "jobs": [
        {
          "name": "release",
          "steps": [
            {
              "name": "Build signed DMG and update archive",
              "status": "completed",
              "conclusion": "success",
              "startedAt": "2026-09-23T10:00:00Z",
              "completedAt": "2026-09-23T10:04:30Z"
            },
            {
              "name": "Generate the appcast",
              "status": "in_progress",
              "conclusion": "",
              "startedAt": "2026-09-23T10:04:30Z",
              "completedAt": null
            },
            {
              "name": "Publish the versioned release",
              "status": "queued",
              "conclusion": "",
              "startedAt": "0001-01-01T00:00:00Z",
              "completedAt": "0001-01-01T00:00:00Z"
            }
          ]
        }
      ]
    }"#;

    #[test]
    fn parse_run_snapshot_reads_the_gh_shape_and_leaves_unset_times_unset() {
        let snapshot = parse_run_snapshot(RUN_JSON).expect("the capture must parse");
        assert_eq!(snapshot.status, "in_progress");
        assert_eq!(snapshot.conclusion, "");
        assert_eq!(snapshot.url, "https://github.com/o/r/actions/runs/42");
        assert_eq!(snapshot.steps.len(), 3);

        let built = &snapshot.steps[0];
        assert_eq!(built.name, "Build signed DMG and update archive");
        assert_eq!(built.status, "completed");
        assert_eq!(built.conclusion, "success");
        assert_eq!(built.started_at_ms, Some(1_790_157_600_000));
        // 4m30s later, which is the duration the sheet draws beside the step.
        assert_eq!(
            built.completed_at_ms.unwrap() - built.started_at_ms.unwrap(),
            270_000
        );

        // In flight: started, not completed. `null` is not zero.
        assert_eq!(snapshot.steps[1].completed_at_ms, None);
        assert!(snapshot.steps[1].started_at_ms.is_some());

        // Queued: GitHub's zero instant is "has not happened", not the epoch.
        assert_eq!(snapshot.steps[2].started_at_ms, None);
        assert_eq!(snapshot.steps[2].completed_at_ms, None);
    }

    #[test]
    fn parse_run_snapshot_refuses_what_is_not_a_run() {
        assert!(parse_run_snapshot("not json").is_none());
        assert!(parse_run_snapshot("[]").is_none());
        // An object with no jobs is a run with no steps yet, not a parse failure.
        let bare = parse_run_snapshot(r#"{"status":"queued"}"#).expect("an object is a run");
        assert_eq!(bare.status, "queued");
        assert!(bare.steps.is_empty());
    }

    #[tokio::test]
    async fn run_configured_merges_both_streams_and_carries_the_exit_code() {
        let tmp = tempfile::tempdir().unwrap();
        let (out, code) = run_configured(
            tmp.path(),
            "printf 'FAIL  x\\n'; printf '  ok  y\\n' >&2; exit 1",
            Duration::from_secs(10),
        )
        .await
        .expect("the command runs");
        assert_eq!(code, Some(1));
        // stderr is in the same text as stdout, which is what makes a recipe
        // that prints its rows to either one readable as one transcript.
        assert!(out.contains("FAIL  x"), "{out:?}");
        assert!(out.contains("ok  y"), "{out:?}");
        let (rows, passed) = parse_check_output(&out, code);
        assert!(!passed);
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn run_configured_kills_a_command_that_outlives_its_timeout() {
        let tmp = tempfile::tempdir().unwrap();
        let err = run_configured(tmp.path(), "sleep 5", Duration::from_millis(300))
            .await
            .expect_err("a hung command must not be waited on forever");
        assert!(err.contains("timed out"), "{err}");
    }

    /// The gate is at the act, not only at the affordance: a failing check stops
    /// the dispatch before the dispatch command runs at all.
    ///
    /// Asserted by a sentinel the dispatch command would write. A test that only
    /// read the refusal could not tell a dispatch that was skipped from one that
    /// ran and was reported as refused.
    #[tokio::test]
    async fn a_failing_check_refuses_before_the_dispatch_command_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let sentinel = tmp.path().join("dispatched");
        let config = ReleaseConfig {
            check: "printf 'FAIL  not ready\\n'; exit 1".to_string(),
            dispatch: format!("touch {}", shell_quote(&sentinel.to_string_lossy())),
            workflow: "release.yml".to_string(),
        };

        let refusal = do_release_dispatch(tmp.path(), &config, false)
            .await
            .expect_err("a failing check must refuse the dispatch");
        assert!(
            !sentinel.exists(),
            "the dispatch command must not have run at all"
        );
        assert!(refusal.detail.contains("did not pass"), "{}", refusal.detail);
        // The sheet's answer to "why not" is the check's own rows.
        let rows = refusal.rows.expect("a refused check carries its rows");
        assert_eq!(
            rows,
            vec![CheckRow {
                mark: "fail",
                text: "not ready".to_string()
            }]
        );
    }

    /// `force` skips the check and nothing else — the dispatch really runs.
    #[tokio::test]
    async fn force_dispatches_over_a_check_that_would_have_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let sentinel = tmp.path().join("dispatched");
        let config = ReleaseConfig {
            check: "printf 'FAIL  not ready\\n'; exit 1".to_string(),
            dispatch: format!("touch {}", shell_quote(&sentinel.to_string_lossy())),
            // A workflow no `gh` can answer for, so discovery finds nothing and
            // the call ends on the named "no run appeared" refusal rather than
            // waiting out the real ceiling.
            workflow: "at-no-such-workflow.yml".to_string(),
        };

        // The dispatch runs first and the run-discovery loop waits a minute
        // after it, so the call is driven only until the sentinel appears and
        // then dropped. Waiting for the whole refusal would buy nothing this
        // test asserts and cost a minute.
        let dir = tmp.path().to_path_buf();
        let call = tokio::spawn(async move { do_release_dispatch(&dir, &config, true).await });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !sentinel.exists() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        call.abort();
        assert!(
            sentinel.exists(),
            "force must dispatch over a check that would have refused"
        );
    }

    /// The frame's shape is Spec S03's, asserted field by field against the
    /// bytes a subscriber receives — the deck's store reads exactly these keys.
    #[tokio::test]
    async fn release_run_state_carries_the_wire_shape_and_omits_an_absent_log() {
        let (tx, mut rx) = broadcast::channel(4);
        let steps = vec![RunStep {
            name: "Generate the appcast".to_string(),
            status: "in_progress".to_string(),
            conclusion: String::new(),
            started_at_ms: Some(1_790_157_870_000),
            completed_at_ms: None,
        }];
        broadcast_run_state(
            &tx,
            "/p",
            "42",
            "https://example/42",
            "in_progress",
            "",
            &steps,
            1_790_157_600_000,
            None,
        );
        let frame = rx.recv().await.expect("a frame goes out");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["action"], "release_run_state");
        assert_eq!(body["project_dir"], "/p");
        assert_eq!(body["run_id"], "42");
        assert_eq!(body["url"], "https://example/42");
        assert_eq!(body["status"], "in_progress");
        assert_eq!(body["watched_since_ms"], 1_790_157_600_000_i64);
        assert_eq!(body["steps"][0]["name"], "Generate the appcast");
        assert_eq!(body["steps"][0]["started_at_ms"], 1_790_157_870_000_i64);
        // An unset time is JSON null rather than 0, so the deck can tell a step
        // that has not finished from one that finished at the epoch.
        assert!(body["steps"][0]["completed_at_ms"].is_null());
        // No log key at all on a run that did not fail.
        assert!(body.get("failed_log").is_none());

        broadcast_run_state(
            &tx,
            "/p",
            "42",
            "https://example/42",
            "completed",
            "failure",
            &steps,
            1_790_157_600_000,
            Some("the last forty lines"),
        );
        let frame = rx.recv().await.expect("the closing frame goes out");
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["conclusion"], "failure");
        assert_eq!(body["failed_log"], "the last forty lines");
    }

    /// A second watch for a run already being watched is a no-op, not a second
    /// poller asking the same question twice as often.
    #[tokio::test]
    async fn spawn_watch_is_idempotent_per_project_and_run() {
        let (tx, _rx) = broadcast::channel(4);
        // A key no other test uses, since the registry is process-global.
        let project = "/at-spawn-watch-idempotent";
        let key = (project.to_string(), "7".to_string());

        spawn_watch(tx.clone(), project, "7");
        spawn_watch(tx.clone(), project, "7");

        let handle = {
            let live = watchers().lock().unwrap();
            assert_eq!(
                live.keys().filter(|k| *k == &key).count(),
                1,
                "one watch per (project, run), however many times it is asked for"
            );
            live.get(&key).map(|h| h.abort_handle())
        };
        // Leave no poller behind: the ceiling is 45 minutes and the registry
        // outlives this test.
        if let Some(handle) = handle {
            handle.abort();
        }
    }

    #[test]
    fn shell_quote_survives_an_apostrophe() {
        assert_eq!(shell_quote("release.yml"), "'release.yml'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}

//! `tugtool host instance quit` — quit a running instance the way the OS
//! quits an app, and say exactly what happened.
//!
//! The quit is the `'aevt'/'quit'` Apple Event, sent by pid from
//! `tugcore::apple_event`, so AppKit runs `applicationShouldTerminate` and the
//! deck's termination pipeline — interrupt live turns, persist every card,
//! flush, tear down tugcast. It **never signals the GUI**: a signal skips the
//! pipeline and loses whatever the deck had not saved. `--force` is the one
//! route to the `stop` ladder, for when losing the pipeline is the choice.
//!
//! What it reports is numbers: the send's status, time to reply, time to exit.
//! And a quit whose reply has not arrived after [`STALL_AFTER`] captures its
//! own evidence into `instances/<id>/stalls/<timestamp>/` — a `sample` of the
//! app, the `/api/host/state` probe, a no-op Apple Event's fate, and the app's
//! recent unified-log lines — so a slow quit is debugged from what it left
//! behind rather than reconstructed afterwards.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tugcore::apple_event::{self, SendOutcome};

/// How long a quit waits for a reply before capturing a stall. A healthy quit
/// replies in well under a second; the termination pipeline itself is bounded
/// at 12 s, but the event reaching dispatch is not.
pub(crate) const STALL_AFTER: Duration = Duration::from_secs(3);

/// How often a waiting quit says so.
const PROGRESS_EVERY: Duration = Duration::from_secs(5);

/// How long the no-op event in a stall capture waits for its reply.
const NOOP_TIMEOUT: Duration = Duration::from_secs(3);

/// `'tugh'/'noop'` — an event Tug has no handler for. Dispatched, it comes
/// back `errAEEventNotHandled`; stuck behind whatever holds the quit, it comes
/// back `errAETimeout`. Which one is the answer to "are all events stuck, or
/// only the quit?".
const NOOP_CLASS: u32 = apple_event::four_cc(b"tugh");
const NOOP_ID: u32 = apple_event::four_cc(b"noop");

/// `connectionInvalid`: the app exited while still holding the event — the
/// ordinary ending of a quit, not a failure.
const CONNECTION_INVALID: i32 = -609;
/// `errAETimeout`: the send's own timeout, which is the deadline.
const AE_TIMEOUT: i32 = -1712;

/// The process a quit addresses.
pub(crate) struct QuitTarget {
    pub instance_id: String,
    pub host_pid: i32,
    pub tugcast_port: u16,
    /// Where stall directories go: `instances/<id>/stalls/`.
    pub stall_root: PathBuf,
}

/// How a quit ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum QuitOutcome {
    /// The app took the event and exited.
    Quit,
    /// The send failed, or the app answered with an error, and it is still
    /// running.
    Refused,
    /// The deadline passed with the app still running.
    Stalled,
}

/// The receipt: what `--json` prints, and what the text lines say.
#[derive(Debug, Serialize)]
pub(crate) struct QuitReport {
    pub instance: String,
    pub host_pid: i32,
    pub outcome: QuitOutcome,
    /// The send's status, once it returned.
    pub send_status: Option<i32>,
    /// The error the reply carried, when it did.
    pub reply_error: Option<i32>,
    /// `name (code): meaning` for the deciding error, if any.
    pub error: Option<String>,
    pub reply_ms: Option<u64>,
    pub exit_ms: Option<u64>,
    pub stall_dir: Option<PathBuf>,
    /// Whether a tugcast that outlived the app had to be reaped.
    pub tugcast_reaped: bool,
}

/// What a returned send means for the quit still in progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReplyReading {
    /// The app replied, or exited holding the event: wait for the exit.
    Delivered,
    /// The send hit the deadline; the deadline loop reports it.
    TimedOut,
    /// A failure the app will not recover from by waiting.
    Failed(i32),
}

pub(crate) fn read_reply(outcome: &SendOutcome) -> ReplyReading {
    match outcome.error_code() {
        None | Some(CONNECTION_INVALID) => ReplyReading::Delivered,
        Some(AE_TIMEOUT) => ReplyReading::TimedOut,
        Some(code) => ReplyReading::Failed(code),
    }
}

/// Send the quit and wait, up to `deadline`, for the app to exit. Never
/// signals anything. `say` receives each progress line.
pub(crate) fn quit_host(
    target: &QuitTarget,
    deadline: Duration,
    say: &mut dyn FnMut(String),
) -> QuitReport {
    let pid = target.host_pid;
    let started = Instant::now();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(apple_event::send(
            pid,
            apple_event::CORE_EVENT_CLASS,
            apple_event::QUIT_APPLICATION,
            deadline,
        ));
    });

    let mut report = QuitReport {
        instance: target.instance_id.clone(),
        host_pid: pid,
        outcome: QuitOutcome::Stalled,
        send_status: None,
        reply_error: None,
        error: None,
        reply_ms: None,
        exit_ms: None,
        stall_dir: None,
        tugcast_reaped: false,
    };
    let mut reply: Option<SendOutcome> = None;
    let mut failed_at: Option<Instant> = None;
    let mut capture: Option<std::thread::JoinHandle<Result<PathBuf, String>>> = None;
    let mut next_progress = PROGRESS_EVERY;

    loop {
        let elapsed = started.elapsed();
        if reply.is_none() {
            if let Ok(outcome) = rx.try_recv() {
                report.send_status = Some(outcome.status);
                report.reply_error = outcome.reply_error;
                report.reply_ms = Some(outcome.elapsed.as_millis() as u64);
                if let ReplyReading::Failed(code) = read_reply(&outcome) {
                    report.error = Some(apple_event::describe(code).to_string());
                    failed_at = Some(Instant::now());
                } else if outcome.error_code().is_none() {
                    say(format!(
                        "quit {}: replied in {:.1}s",
                        target.instance_id,
                        outcome.elapsed.as_secs_f64()
                    ));
                }
                reply = Some(outcome);
            }
        }
        if !super::instance::pid_alive(pid) {
            report.exit_ms = Some(started.elapsed().as_millis() as u64);
            report.outcome = QuitOutcome::Quit;
            break;
        }
        // A failed send leaves the app as it was; a moment's grace covers an
        // app that answered with an error and exited anyway.
        if failed_at.is_some_and(|at| at.elapsed() >= Duration::from_secs(1)) {
            report.outcome = QuitOutcome::Refused;
            break;
        }
        if reply.is_none() && capture.is_none() && elapsed >= STALL_AFTER {
            say(format!(
                "quit {}: no reply after {}s — capturing a stall",
                target.instance_id,
                STALL_AFTER.as_secs()
            ));
            let target = CaptureTarget::from(target);
            let waited = elapsed;
            capture = Some(std::thread::spawn(move || capture_stall(&target, waited)));
        }
        if let Some(handle) = capture.take_if(|h| h.is_finished()) {
            record_capture(handle, &mut report, say);
        }
        if elapsed >= next_progress {
            let state = if reply.is_some() {
                "replied, waiting for exit"
            } else {
                "no reply yet"
            };
            say(format!(
                "quit {}: {}s — {state}",
                target.instance_id,
                elapsed.as_secs()
            ));
            next_progress += PROGRESS_EVERY;
        }
        if elapsed >= deadline {
            report.outcome = QuitOutcome::Stalled;
            report.error.get_or_insert_with(|| {
                format!(
                    "the app did not exit within {}s; nothing was signalled",
                    deadline.as_secs()
                )
            });
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Some(handle) = capture {
        record_capture(handle, &mut report, say);
    }
    report
}

fn record_capture(
    handle: std::thread::JoinHandle<Result<PathBuf, String>>,
    report: &mut QuitReport,
    say: &mut dyn FnMut(String),
) {
    match handle.join() {
        Ok(Ok(dir)) => {
            say(format!("stall evidence: {}", dir.display()));
            report.stall_dir = Some(dir);
        }
        Ok(Err(e)) => say(format!("stall capture failed: {e}")),
        Err(_) => say("stall capture panicked".to_string()),
    }
}

// ── stall capture ───────────────────────────────────────────────────────────

struct CaptureTarget {
    instance_id: String,
    pid: i32,
    port: u16,
    root: PathBuf,
}

impl From<&QuitTarget> for CaptureTarget {
    fn from(target: &QuitTarget) -> Self {
        Self {
            instance_id: target.instance_id.clone(),
            pid: target.host_pid,
            port: target.tugcast_port,
            root: target.stall_root.clone(),
        }
    }
}

/// The stall directory's name: a UTC timestamp that sorts.
pub(crate) fn stall_dir_name(at: chrono::DateTime<chrono::Utc>) -> String {
    at.format("%Y-%m-%dT%H-%M-%SZ").to_string()
}

/// Write the stall directory. The four readings run at once — a sample takes
/// two seconds, the no-op event and the probe wait on the app — so the
/// capture costs the slowest of them, not their sum.
fn capture_stall(target: &CaptureTarget, waited: Duration) -> Result<PathBuf, String> {
    let at = chrono::Utc::now();
    let dir = target.root.join(stall_dir_name(at));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let pid = target.pid;

    let sample_file = dir.join("sample.txt");
    let sample = {
        let file = sample_file.clone();
        std::thread::spawn(move || {
            std::process::Command::new("/usr/bin/sample")
                .arg(pid.to_string())
                .arg("2")
                .arg("-file")
                .arg(&file)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.code())
                .map_err(|e| e.to_string())
        })
    };
    let probe = {
        let port = target.port;
        std::thread::spawn(move || read_host_state(port))
    };
    let noop =
        std::thread::spawn(move || apple_event::send(pid, NOOP_CLASS, NOOP_ID, NOOP_TIMEOUT));
    let log_file = dir.join("unified-log.txt");
    let log = {
        let file = log_file.clone();
        std::thread::spawn(move || unified_log(pid, &file))
    };

    let sample = sample.join().unwrap_or_else(|_| Err("panicked".into()));
    let (probe_status, probe_body) = probe
        .join()
        .unwrap_or_else(|_| (None, serde_json::json!({"error": "panicked"})));
    let noop = noop.join().ok();
    let log = log.join().unwrap_or_else(|_| Err("panicked".into()));

    let state_file = dir.join("host-state.json");
    write_json(&state_file, &probe_body)?;
    let stall = serde_json::json!({
        "instance": target.instance_id,
        "host_pid": pid,
        "tugcast_port": target.port,
        "captured_at": at.to_rfc3339(),
        "waited_for_reply_ms": waited.as_millis() as u64,
        "sample": {
            "file": "sample.txt",
            "exit": sample.as_ref().ok().copied().flatten(),
            "error": sample.err(),
        },
        "host_state": {
            "file": "host-state.json",
            "http_status": probe_status,
        },
        "noop_event": noop.map(|o| {
            let code = o.error_code().unwrap_or(0);
            serde_json::json!({
                "class": "tugh",
                "id": "noop",
                "status": o.status,
                "reply_error": o.reply_error,
                "meaning": apple_event::describe(code).to_string(),
                "elapsed_ms": o.elapsed.as_millis() as u64,
            })
        }),
        "unified_log": {
            "file": "unified-log.txt",
            "exit": log.as_ref().ok().copied().flatten(),
            "error": log.err(),
        },
    });
    write_json(&dir.join("stall.json"), &stall)?;
    Ok(dir)
}

fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| format!("write {}: {e}", path.display()))
}

/// GET `/api/host/state`, bounded. Returns the HTTP status (none when the
/// request itself failed) and the body, or the failure as a body.
fn read_host_state(port: u16) -> (Option<u16>, serde_json::Value) {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(4)))
        .build()
        .into();
    let url = format!("http://127.0.0.1:{port}/api/host/state");
    match agent.get(&url).call() {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let body = response
                .body_mut()
                .read_json::<serde_json::Value>()
                .unwrap_or_else(|e| serde_json::json!({"error": format!("unreadable body: {e}")}));
            (Some(status), body)
        }
        Err(e) => (
            None,
            serde_json::json!({"error": format!("cannot reach {url}: {e}")}),
        ),
    }
}

/// The app's last two minutes of unified-log lines. `/usr/bin/log` by full
/// path: in an interactive shell `log` may be shadowed by a function.
fn unified_log(pid: i32, file: &Path) -> Result<Option<i32>, String> {
    let out = std::fs::File::create(file).map_err(|e| e.to_string())?;
    std::process::Command::new("/usr/bin/log")
        .args([
            "show", "--last", "2m", "--info", "--debug", "--style", "compact",
        ])
        .arg("--predicate")
        .arg(format!("processID == {pid}"))
        .stdout(out)
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.code())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(status: i32, reply_error: Option<i32>) -> SendOutcome {
        SendOutcome {
            status,
            reply_error,
            elapsed: Duration::ZERO,
        }
    }

    #[test]
    fn a_reply_or_an_exit_holding_the_event_is_delivery() {
        assert_eq!(read_reply(&outcome(0, None)), ReplyReading::Delivered);
        assert_eq!(
            read_reply(&outcome(CONNECTION_INVALID, None)),
            ReplyReading::Delivered
        );
    }

    #[test]
    fn the_sends_own_timeout_is_left_to_the_deadline() {
        assert_eq!(
            read_reply(&outcome(AE_TIMEOUT, None)),
            ReplyReading::TimedOut
        );
    }

    #[test]
    fn a_permission_failure_or_a_refusing_handler_fails() {
        assert_eq!(
            read_reply(&outcome(-1743, None)),
            ReplyReading::Failed(-1743)
        );
        assert_eq!(
            read_reply(&outcome(0, Some(-128))),
            ReplyReading::Failed(-128)
        );
    }

    #[test]
    fn stall_directories_are_named_by_sortable_utc_time() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-10-21T06:10:59Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(stall_dir_name(at), "2026-10-21T06-10-59Z");
    }

    /// The stall directory carries every reading and a `stall.json` naming
    /// them, even when the target can answer none of them — which is the
    /// case a real stall is.
    #[test]
    fn a_stall_capture_writes_every_reading_and_ties_them_together() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let stalls = tempfile::tempdir().unwrap();
        let target = CaptureTarget {
            instance_id: "test-instance".into(),
            pid: child.id() as i32,
            // Nothing listens on port 1, so the probe's failure is recorded.
            port: 1,
            root: stalls.path().to_path_buf(),
        };
        let dir = capture_stall(&target, Duration::from_secs(3)).unwrap();
        let _ = child.kill();
        let _ = child.wait();

        assert!(dir.starts_with(stalls.path()));
        for file in [
            "sample.txt",
            "host-state.json",
            "unified-log.txt",
            "stall.json",
        ] {
            assert!(
                dir.join(file).exists(),
                "{file} missing from {}",
                dir.display()
            );
        }
        let stall: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("stall.json")).unwrap())
                .unwrap();
        assert_eq!(stall["instance"], "test-instance");
        assert_eq!(stall["waited_for_reply_ms"], 3000);
        assert_eq!(stall["noop_event"]["status"], -600);
        assert!(stall["host_state"]["http_status"].is_null());
        let state: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("host-state.json")).unwrap())
                .unwrap();
        assert!(state["error"].as_str().unwrap().contains("cannot reach"));
    }

    /// A quit to a process that cannot take Apple Events is refused by name,
    /// at once, captures no stall, and leaves the process running.
    #[test]
    fn a_quit_the_target_cannot_take_is_refused_and_signals_nothing() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let stalls = tempfile::tempdir().unwrap();
        let target = QuitTarget {
            instance_id: "test-instance".into(),
            host_pid: child.id() as i32,
            tugcast_port: 1,
            stall_root: stalls.path().to_path_buf(),
        };
        let mut lines = Vec::new();
        let report = quit_host(&target, Duration::from_secs(10), &mut |l| lines.push(l));
        let alive = child.try_wait().unwrap().is_none();
        let _ = child.kill();
        let _ = child.wait();

        assert_eq!(report.outcome, QuitOutcome::Refused, "lines: {lines:?}");
        assert_eq!(report.send_status, Some(-600));
        assert!(
            report
                .error
                .as_deref()
                .unwrap()
                .starts_with("procNotFound (-600)")
        );
        assert!(report.stall_dir.is_none());
        assert!(std::fs::read_dir(stalls.path()).unwrap().next().is_none());
        assert!(alive, "the target died — something signalled it");
    }
}

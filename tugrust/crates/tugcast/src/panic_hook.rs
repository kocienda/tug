//! Process-wide panic hook that writes through `tracing`.
//!
//! A panic in tugcast otherwise goes to a stderr nobody reads. Inside a
//! spawned tokio task it is quieter still: the runtime catches the unwind,
//! the task ends, and if its `JoinHandle` was dropped nothing anywhere
//! records that it happened — the log for that session simply stops. The
//! hook makes every panic, on any thread or task, one `grep panicked` away
//! in `tugcast.log`.
//!
//! It changes no control flow. It logs and then defers to whichever hook
//! was installed before it, so the default stderr report (and its
//! `RUST_BACKTRACE` handling) still happens, and the unwind proceeds
//! exactly as it would have.

use std::any::Any;
use std::cell::RefCell;
use std::panic::PanicHookInfo;
use std::sync::Once;

use tracing::error;

thread_local! {
    /// The report for the panic most recently hooked on this thread. A
    /// `catch_unwind` runs on the thread that panicked, and the payload it
    /// is handed carries the message but not the location — only the hook
    /// ever sees that. The catcher takes it from here.
    static LAST_REPORT: RefCell<Option<PanicReport>> = const { RefCell::new(None) };
}

/// What the hook knows about one panic, pulled out of `PanicHookInfo` so
/// the rendering can be read and tested without a panic in flight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PanicReport {
    /// The panic payload, when it is a string — which `panic!`, `unwrap`,
    /// `expect`, and every slice/index panic produce.
    pub message: String,
    /// `file:line:column` of the panicking expression.
    pub location: Option<String>,
    /// The OS thread's name. On the multi-thread runtime this is
    /// `tokio-runtime-worker` for every task, which is why `task` exists.
    pub thread: Option<String>,
    /// The tokio task id, when the panic happened inside a task.
    pub task: Option<String>,
}

impl PanicReport {
    pub(crate) fn from_info(info: &PanicHookInfo<'_>) -> Self {
        Self {
            message: payload_message(info.payload()),
            location: info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())),
            thread: std::thread::current().name().map(str::to_string),
            task: tokio::task::try_id().map(|id| id.to_string()),
        }
    }

    /// The log line's message. It leads with `panicked at`, the phrase
    /// the default hook prints, so one search term finds a panic whether
    /// it was read from the log or from stderr.
    pub(crate) fn render(&self) -> String {
        let location = self.location.as_deref().unwrap_or("<unknown location>");
        let thread = self.thread.as_deref().unwrap_or("<unnamed>");
        match self.task.as_deref() {
            Some(task) => format!(
                "panicked at {location}: {} (thread {thread}, task {task})",
                self.message
            ),
            None => format!("panicked at {location}: {} (thread {thread})", self.message),
        }
    }
}

/// Install the hook, after tracing is initialised — a panic before that
/// point has nowhere to be logged, and the previous hook still reports it.
/// Idempotent: a second call installs nothing, so the hook never chains
/// onto itself and logs a panic twice.
pub(crate) fn install() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let report = PanicReport::from_info(info);
            error!(
                location = report.location.as_deref().unwrap_or(""),
                thread = report.thread.as_deref().unwrap_or(""),
                task = report.task.as_deref().unwrap_or(""),
                "{}",
                report.render()
            );
            LAST_REPORT.with(|slot| *slot.borrow_mut() = Some(report));
            previous(info);
        }));
    });
}

/// Describe a panic a `catch_unwind` just caught, for the code that has to
/// say what happened to a session. Takes the hook's report for this thread
/// when there is one — it has the location — and otherwise falls back to
/// what the payload alone can say. Call it straight after the catch, before
/// the task can yield to another thread.
pub(crate) fn describe_caught(payload: &(dyn Any + Send)) -> String {
    if let Some(report) = LAST_REPORT.with(|slot| slot.borrow_mut().take()) {
        return report.render();
    }
    format!(
        "panicked at <unknown location>: {}",
        payload_message(payload)
    )
}

/// A panic payload as text. `panic!`, `unwrap`, `expect`, and every
/// slice/index panic carry a string; anything else is named as such.
fn payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Capture the report for one real panic. The hook is process-global,
    /// so the capture keeps only the panic carrying `marker` — another
    /// test's panic on another thread cannot land in it.
    fn capture(marker: &'static str, panic: impl FnOnce() + std::panic::UnwindSafe) -> PanicReport {
        let seen: Arc<Mutex<Option<PanicReport>>> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&seen);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let report = PanicReport::from_info(info);
            if report.message.contains(marker) {
                *sink.lock().unwrap() = Some(report);
            }
        }));
        let outcome = std::panic::catch_unwind(panic);
        std::panic::set_hook(previous);
        assert!(outcome.is_err(), "the closure was expected to panic");
        seen.lock().unwrap().take().expect("the hook saw the panic")
    }

    #[test]
    fn a_str_panic_reports_its_message_and_location() {
        let line = line!() + 1;
        let report = capture("marker-str", || panic!("marker-str went wrong"));
        assert_eq!(report.message, "marker-str went wrong");
        let location = report.location.clone().expect("a location");
        assert!(
            location.starts_with(&format!("{}:{line}:", file!())),
            "location was {location}"
        );
        let rendered = report.render();
        assert!(rendered.starts_with(&format!("panicked at {location}: ")));
        assert!(rendered.contains("marker-str went wrong"));
    }

    #[test]
    fn a_formatted_panic_reports_its_message() {
        // The 2026-09-20 shape: a `String` payload from a slice at a byte
        // offset inside a multibyte char.
        let report = capture("is not a char boundary", || {
            let text = "Stanisław";
            let cut = text.find('ł').unwrap() + 1;
            let _ = &text[..std::hint::black_box(cut)];
        });
        assert!(report.message.contains("is not a char boundary"));
        assert!(report.location.is_some());
    }

    #[test]
    fn a_non_string_payload_still_reports() {
        let seen: Arc<Mutex<Option<PanicReport>>> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&seen);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let report = PanicReport::from_info(info);
            if report.message.starts_with('<') {
                *sink.lock().unwrap() = Some(report);
            }
        }));
        let outcome = std::panic::catch_unwind(|| std::panic::panic_any(7_u32));
        std::panic::set_hook(previous);
        assert!(outcome.is_err());
        let report = seen.lock().unwrap().take().expect("the hook saw the panic");
        assert_eq!(report.message, "<non-string panic payload>");
    }

    #[tokio::test]
    async fn a_panic_inside_a_task_names_the_task() {
        let seen: Arc<Mutex<Option<PanicReport>>> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&seen);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let report = PanicReport::from_info(info);
            if report.message.contains("marker-task") {
                *sink.lock().unwrap() = Some(report);
            }
        }));
        let handle = tokio::spawn(async { panic!("marker-task died") });
        let id = handle.id().to_string();
        let joined = handle.await;
        std::panic::set_hook(previous);
        assert!(joined.unwrap_err().is_panic());
        let report = seen.lock().unwrap().take().expect("the hook saw the panic");
        assert_eq!(report.task.as_deref(), Some(id.as_str()));
        assert!(report.render().ends_with(&format!("task {id})")));
    }

    #[test]
    fn render_omits_the_task_outside_one() {
        let report = PanicReport {
            message: "boom".to_string(),
            location: Some("src/x.rs:1:2".to_string()),
            thread: Some("main".to_string()),
            task: None,
        };
        assert_eq!(
            report.render(),
            "panicked at src/x.rs:1:2: boom (thread main)"
        );
    }
}

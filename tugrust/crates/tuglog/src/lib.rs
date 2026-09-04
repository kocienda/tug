//! tuglog — shared tracing initialization for Tug binaries.
//!
//! All Tug Rust binaries (tugcast, tugexec, tug, etc.) call [`init`] at
//! startup. Tracing output is written to a rolling log file under:
//!
//! ```text
//! ~/Library/Application Support/Tug/Logs/<name>.log            (legacy, single-instance)
//! ~/Library/Application Support/Tug/instances/<id>/Logs/<name>.log   (multi-instance)
//! ```
//!
//! The directory chosen depends on whether `TUG_INSTANCE_ID` is set in
//! the process environment; resolution is delegated to
//! [`tugcore::instance::log_dir`] so every Tug binary agrees on the
//! location.
//!
//! Logs rotate daily. The `RUST_LOG` environment variable controls the filter
//! level; with it unset the default is [`DEFAULT_FILTER`]. A non-blocking
//! writer is used so logging never blocks the application.
//!
//! # Usage
//!
//! ```no_run
//! let _guard = tuglog::init("tugcast");
//! // _guard must be held for the lifetime of the program.
//! ```
//!
//! The returned [`LogGuard`] flushes buffered output when dropped. Bind it to
//! a variable in `main` — do not discard it.

use std::fs;
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

/// Opaque guard that flushes the non-blocking writer on drop.
/// Must be held for the lifetime of the program.
pub struct LogGuard {
    _inner: WorkerGuard,
}

/// The filter every Tug binary runs under when `RUST_LOG` says nothing.
///
/// `info` everywhere, plus `debug` for `dev::ledger` — the job-edge trace that
/// says when a background job was launched, opened, closed, rejected or
/// reaped. A session that reads busy when it should be quiet, or quiet when it
/// should be busy, is otherwise only diagnosable by reproducing it, and the
/// shapes that produce it arrive from the live wire rather than from tests.
/// Named as a constant so the docstring above and the fallback below cannot
/// disagree about what the default is.
pub const DEFAULT_FILTER: &str = "info,dev::ledger=debug";

/// Resolve the log directory for this process.
///
/// Delegates to [`tugcore::instance::log_dir`] so the directory is
/// per-instance when `TUG_INSTANCE_ID` is set and legacy
/// `~/Library/Application Support/Tug/Logs/` otherwise. Creates the
/// directory if it doesn't exist.
fn log_dir() -> PathBuf {
    let dir = tugcore::instance::log_dir();
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Initialize tracing for a Tug binary.
///
/// - `name`: binary name, used as the log file prefix (e.g. `"tugcast"`
///   produces `tugcast.log.2026-04-07`).
/// - Reads `RUST_LOG` for filter level; defaults to `info,dev::ledger=debug`.
///   The `dev::ledger` target carries the job-edge trace — a job launched,
///   opened, closed, rejected, reaped — and that trace is what makes a
///   session that reads busy (or quiet) when it should not explicable after
///   the fact rather than only reproducible. It is a handful of lines per
///   background call, which is why it can be on by default; `RUST_LOG`
///   overrides the whole thing as always.
/// - Returns a [`LogGuard`] that must be held for the program's lifetime.
///
/// # Panics
///
/// Panics if the tracing subscriber has already been set (i.e., `init` was
/// called twice in the same process).
pub fn init(name: &str) -> LogGuard {
    let dir = log_dir();

    let file_appender = tracing_appender::rolling::daily(&dir, format!("{name}.log"));
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER)))
        .with(fmt::layer().with_writer(non_blocking))
        .init();

    tracing::info!(
        name,
        log_dir = %dir.display(),
        "tuglog initialized"
    );

    LogGuard { _inner: guard }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default filter admits the job-edge trace and nothing else extra.
    ///
    /// Driven through a real subscriber rather than compared as a string: the
    /// string is only correct if the directive parses the way it reads, and a
    /// typo in the target name would still equal itself.
    #[test]
    fn the_default_filter_admits_ledger_debug() {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

        /// Records target and level for every event the filter let through.
        struct Seen(Arc<Mutex<Vec<String>>>);
        impl<S: tracing::Subscriber> Layer<S> for Seen {
            fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
                let meta = event.metadata();
                self.0
                    .lock()
                    .unwrap()
                    .push(format!("{}@{}", meta.target(), meta.level()));
            }
        }

        let seen = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry()
            .with(EnvFilter::new(DEFAULT_FILTER))
            .with(Seen(Arc::clone(&seen)));

        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!(target: "dev::ledger", event = "job_launched", "");
            tracing::debug!(target: "dev::session-lifecycle", event = "arc.tick", "");
            tracing::info!(target: "dev::session-lifecycle", event = "arc.tick", "");
        });

        let seen = seen.lock().unwrap().clone();
        assert!(
            seen.contains(&"dev::ledger@DEBUG".to_string()),
            "the job-edge trace is the whole reason this default is wider than info: {seen:?}",
        );
        assert!(
            !seen.contains(&"dev::session-lifecycle@DEBUG".to_string()),
            "one target wider, not two: {seen:?}",
        );
        assert!(
            seen.contains(&"dev::session-lifecycle@INFO".to_string()),
            "and info everywhere is untouched: {seen:?}",
        );
    }

    #[test]
    fn log_dir_ends_with_logs() {
        // Without TUG_INSTANCE_ID set the legacy path applies; with
        // it set the per-instance path applies. Either way the leaf
        // is `Logs`.
        let dir = log_dir();
        assert_eq!(dir.file_name().and_then(|s| s.to_str()), Some("Logs"));
    }
}

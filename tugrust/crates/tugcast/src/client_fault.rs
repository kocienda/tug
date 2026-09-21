//! HTTP handler for `POST /api/client-fault` — durable capture of a
//! frontend fault.
//!
//! **Why this exists.** On 2026-09-21 the Session card died with WebKit's
//! `NotFoundError: The object can not be found here.` thrown from
//! `removeChild` inside React's deletion walk. Everything the frontend knew
//! about it went to `console.error`, which nothing captures, and the red
//! banner showed a minified `error.stack` — thirty frames of React's own
//! recursion naming no surface at all. Placing the defect took a source
//! read rather than a log read, and every recurrence produced the same
//! screenshot and the same nothing.
//!
//! A frontend fault is exactly the class of event that must outlive the
//! page it happened on: the user's next act is Reload, which destroys every
//! in-memory record of it. So the fault is posted here and appended to
//! `<log-dir>/client-faults.jsonl`, one JSON object per line, where it can
//! be read after the fact with no debugger attached and no repro in hand.
//!
//! Loopback-only, like the `/api/fs` handlers. The record is written
//! verbatim as the frontend composed it — this endpoint adds a receive
//! timestamp and otherwise does not interpret the payload, because the
//! shape of a forensic report is the frontend's business and a schema
//! enforced here would only drop the field that turned out to matter.

use std::io::Write;
use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tracing::{error, warn};

/// The fault log's filename, beside `tugcast.log` in the instance's `Logs/`.
pub(crate) const CLIENT_FAULT_FILENAME: &str = "client-faults.jsonl";

/// Cap on one posted record. A forensic report carries truncated `outerHTML`
/// and a breadcrumb ring, both already bounded by the frontend; this is the
/// backstop that keeps a runaway serializer from filling the disk.
pub(crate) const MAX_FAULT_BYTES: usize = 256 * 1024;

/// Retention: the file is truncated once it passes this, keeping the most
/// recent records. A fault log nobody prunes is a disk leak, and the recent
/// faults are the ones a live investigation wants.
pub(crate) const MAX_FAULT_LOG_BYTES: u64 = 8 * 1024 * 1024;

/// Append one fault record as a JSON line. Returns the line written.
///
/// The append is best-effort in the sense that it never fails the request —
/// a frontend that cannot report its fault must not also see a failed
/// request — but a failure to write is itself logged at error level, so a
/// silently-unwritable log directory is visible in `tugcast.log`.
fn append_fault(log_dir: &std::path::Path, record: Value) -> std::io::Result<()> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join(CLIENT_FAULT_FILENAME);

    // Prune before appending, not on a timer: this path runs rarely (a fault
    // is not a steady stream), so the check costs nothing in the common case
    // and there is no separate sweep to forget to run.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_FAULT_LOG_BYTES {
            prune_fault_log(&path);
        }
    }

    let mut line = serde_json::to_string(&record).unwrap_or_else(|_| {
        // A record that will not serialize is still worth a line saying so.
        r#"{"error":"record failed to serialize"}"#.to_string()
    });
    line.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(line.as_bytes())?;
    file.flush()
}

/// Keep the most recent half of the log. Dropping the oldest records is the
/// right direction: an investigation opens on the fault that just happened.
fn prune_fault_log(path: &std::path::Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let lines: Vec<&str> = text.lines().collect();
    let keep = lines.len() / 2;
    let tail = lines[lines.len().saturating_sub(keep)..].join("\n");
    if let Err(err) = std::fs::write(path, format!("{tail}\n")) {
        warn!("client-fault: could not prune {}: {err}", path.display());
    }
}

/// `POST /api/client-fault` — record one frontend fault.
///
/// The body is the frontend's forensic record. It is stamped with a receive
/// time and appended verbatim; see the module docs for why nothing here
/// validates its shape.
pub(crate) async fn post_client_fault(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: String,
) -> Response {
    if !addr.ip().is_loopback() {
        warn!("post_client_fault: rejected non-loopback connection from {addr}");
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "denied" })),
        )
            .into_response();
    }
    if body.len() > MAX_FAULT_BYTES {
        warn!(
            "post_client_fault: rejected {} byte body (cap {MAX_FAULT_BYTES})",
            body.len()
        );
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(json!({ "error": "too large" })),
        )
            .into_response();
    }

    // A body that is not JSON is still recorded — as a string under `raw`.
    // The one thing this endpoint must never do is discard a fault report
    // because it arrived malformed; malformed IS a finding.
    let payload: Value =
        serde_json::from_str(&body).unwrap_or_else(|_| json!({ "raw": body.clone() }));

    // The one-line summary that lands in `tugcast.log`, so a reader who
    // greps the ordinary log learns a fault happened and where to read it.
    let kind = payload
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("(no message)");
    error!(
        kind = kind,
        message = message,
        "client fault recorded → {CLIENT_FAULT_FILENAME}"
    );

    let record = json!({
        "receivedAt": chrono::Utc::now().to_rfc3339(),
        "fault": payload,
    });

    let log_dir = tugcore::instance::log_dir();
    let write = tokio::task::spawn_blocking(move || append_fault(&log_dir, record)).await;
    match write {
        Ok(Ok(())) => (StatusCode::OK, axum::Json(json!({ "recorded": true }))).into_response(),
        Ok(Err(err)) => {
            error!("client-fault: could not append: {err}");
            // Still 200: the frontend has nothing useful to do with a
            // failure here, and a retry loop on a broken log directory
            // would be worse than a dropped record.
            (
                StatusCode::OK,
                axum::Json(json!({ "recorded": false, "error": err.to_string() })),
            )
                .into_response()
        }
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": "internal" })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_writes_one_line_per_record() {
        let dir = tempfile::tempdir().unwrap();
        append_fault(dir.path(), json!({ "kind": "dom-forensics", "n": 1 })).unwrap();
        append_fault(dir.path(), json!({ "kind": "dom-forensics", "n": 2 })).unwrap();
        let text = std::fs::read_to_string(dir.path().join(CLIENT_FAULT_FILENAME)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        // Each line parses on its own — that is the whole point of JSONL.
        for line in lines {
            serde_json::from_str::<Value>(line).unwrap();
        }
    }

    #[test]
    fn append_creates_a_missing_log_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("Logs");
        append_fault(&nested, json!({ "kind": "boundary" })).unwrap();
        assert!(nested.join(CLIENT_FAULT_FILENAME).exists());
    }

    #[test]
    fn prune_keeps_the_most_recent_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CLIENT_FAULT_FILENAME);
        let body: String = (0..10)
            .map(|i| format!("{{\"n\":{i}}}\n"))
            .collect::<Vec<_>>()
            .join("");
        std::fs::write(&path, body).unwrap();
        prune_fault_log(&path);
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 5);
        // The newest record survived; the oldest did not.
        assert!(lines.last().unwrap().contains("\"n\":9"));
        assert!(!text.contains("\"n\":0"));
    }
}

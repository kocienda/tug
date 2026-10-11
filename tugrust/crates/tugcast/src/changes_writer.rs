//! Single-writer routing for the machine-global changes ledger.
//!
//! Exactly one process on the machine writes `changes.db`. Ownership is a
//! first-come `flock` claim on `changes.db.writer-lock`
//! ([`tugcore::ledger_db::claim_writer`]), held for the owner's lifetime
//! and released by the kernel when it dies — there is no handoff protocol
//! and no stale-lock scanning to get wrong.
//!
//! An instance that loses the claim attaches the shared database
//! **read-only** and routes every would-be mutation through this module
//! to the owner's `POST /api/changes-write`. The wire body is one
//! [`crate::changes_journal::Record`] — the same enum the durable journal
//! serializes and the same enum the replay applier consumes, so the wire
//! format, the durable format, and the recovery format cannot drift apart.
//!
//! Failover is the same path as crash recovery: a forward that fails
//! **to reach anyone** (owner exited, port gone) triggers a re-claim;
//! whoever wins reopens the attach read-write and drains the pending
//! queue. Records that arrive while nobody can be reached are held in a
//! small bounded queue — past its bound the oldest are dropped, loudly,
//! and the ledger is marked degraded. The JSONL side of attribution
//! capture is unaffected either way.
//!
//! A refusal is not a failure to reach. An HTTP answer of any status
//! proves the owner is alive, so a refused write never triggers failover:
//! taking the claim there would mean a healthy owner losing the database
//! over a disagreement. A `4xx` refusal is permanent — the owner
//! understood the request and will not accept it — so nothing is corrupt
//! and nothing is left pending, and it is reported to the caller as that
//! one gesture's failure rather than latching the process-wide degraded
//! flag the deck renders as a damaged ledger.
//!
//! Lock order inside the ledger is `forward_order` → `changes_access` →
//! `db` → `changes_journal`, and a forwarded record's network send runs
//! under none of them: [`ChangesForwarder::ticket`] snapshots what the
//! send needs while `changes_access` is held, the send runs on the
//! forwarder's own runtime with the lock released, and the outcome is
//! settled under the lock again. `forward_order` keeps forwarded records
//! in issue order now that `changes_access` no longer does.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tugcore::ledger_db::{WriterLock, WriterOwner};

use crate::changes_journal::Record;

/// How many forwarded records are held while no owner is reachable.
/// Attribution rows are small; this is minutes of heavy editing.
const PENDING_CAP: usize = 256;

/// Floor between takeover attempts, so a dead owner does not turn every
/// attribution write into a claim storm. Jittered per process.
const RETRY_FLOOR: Duration = Duration::from_millis(500);

/// Loopback request budget for one forwarded record.
const FORWARD_TIMEOUT: Duration = Duration::from_secs(2);

/// How this instance writes the shared changes ledger.
pub enum ChangesAccess {
    /// This process holds the claim: mutations execute locally against a
    /// read-write attach, and it alone journals and checkpoints. The
    /// claim is held by existing — dropping this variant releases it,
    /// which is how ownership passes on exit — and its lockfile identity
    /// is re-published on the maintenance tick.
    Owner(WriterLock),
    /// Another process holds the claim: mutations are forwarded to it.
    Forward(ChangesForwarder),
    /// No claim was attempted — an in-memory or per-test changes database
    /// with no other process to contend with. Writes execute locally.
    Unclaimed,
}

impl ChangesAccess {
    /// Whether mutations must be forwarded rather than executed locally.
    pub fn is_forwarding(&self) -> bool {
        matches!(self, ChangesAccess::Forward(_))
    }
}

/// Why a forwarded write did not land.
#[derive(Debug, Clone)]
pub enum ForwardError {
    /// No reachable owner: no published claim, or its process is gone.
    NoOwner,
    /// The owner answered and refused the write. An answer proves the owner
    /// is alive, so this is never a failover trigger. `permanent` marks a
    /// refusal retrying cannot fix.
    Rejected { detail: String, permanent: bool },
    /// Transport failure talking to the owner.
    Transport(String),
}

impl std::fmt::Display for ForwardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ForwardError::NoOwner => write!(f, "no reachable changes-ledger owner"),
            ForwardError::Rejected { detail, .. } => {
                write!(f, "owner rejected the write: {detail}")
            }
            ForwardError::Transport(m) => write!(f, "cannot reach the owner: {m}"),
        }
    }
}

/// Client half of the single-writer contract: sends one record at a time
/// to the owning instance and holds what it cannot yet deliver.
pub struct ChangesForwarder {
    changes_db: PathBuf,
    /// `None` if the client failed to build; every send then reports
    /// [`ForwardError::NoOwner`], which routes into the takeover path.
    client: Option<reqwest::Client>,
    /// The one runtime every send runs on, so the client's connection pool
    /// is bound to one I/O driver and the sync write path can block on a
    /// send from any thread. `None` if it failed to build; taken in `Drop`.
    rt: Option<tokio::runtime::Runtime>,
    pending: VecDeque<Record>,
    /// Count of records dropped past [`PENDING_CAP`], for the log line.
    dropped: u64,
    last_attempt: Option<Instant>,
}

/// One record on its way to the owner: everything the send needs,
/// snapshotted under `changes_access` so the send itself can run without it.
pub(crate) struct ForwardTicket {
    pub(crate) record: Record,
    /// The ledger's takeover generation when the ticket was cut; settling
    /// against a different one means a takeover landed during the send.
    pub(crate) generation: u64,
    dispatch: Result<Dispatch, ForwardError>,
}

struct Dispatch {
    url: String,
    body: Vec<u8>,
    client: reqwest::Client,
    rt: tokio::runtime::Handle,
}

impl ChangesForwarder {
    pub fn new(changes_db: PathBuf) -> Self {
        // The target is always loopback: a user's HTTP_PROXY must not
        // intercept it. The timeout covers the whole request.
        let client = reqwest::Client::builder()
            .timeout(FORWARD_TIMEOUT)
            .no_proxy()
            .build()
            .inspect_err(|e| tracing::error!(error = %e, "cannot build the changes-forward client"))
            .ok();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("tugcast-forward")
            .enable_all()
            .build()
            .inspect_err(
                |e| tracing::error!(error = %e, "cannot build the changes-forward runtime"),
            )
            .ok();
        Self {
            changes_db,
            client,
            rt,
            pending: VecDeque::new(),
            dropped: 0,
            last_attempt: None,
        }
    }

    /// Resolve the owner now and serialise the body, so the send can run
    /// with `changes_access` released. Blocking filesystem reads (the
    /// claim lockfile, the instance registry); no network.
    pub(crate) fn ticket(&self, record: Record, generation: u64) -> ForwardTicket {
        let dispatch = self.dispatch_for(&record);
        ForwardTicket {
            record,
            generation,
            dispatch,
        }
    }

    fn dispatch_for(&self, record: &Record) -> Result<Dispatch, ForwardError> {
        let (Some(client), Some(rt)) = (&self.client, &self.rt) else {
            return Err(ForwardError::NoOwner);
        };
        let owner = resolve_owner(&self.changes_db).ok_or(ForwardError::NoOwner)?;
        if owner.port == 0 {
            return Err(ForwardError::NoOwner);
        }
        let body =
            serde_json::to_vec(record).map_err(|e| ForwardError::Transport(e.to_string()))?;
        Ok(Dispatch {
            url: format!("http://127.0.0.1:{}/api/changes-write", owner.port),
            body,
            client: client.clone(),
            rt: rt.handle().clone(),
        })
    }

    /// Send one record to the owner and return how many rows it touched.
    /// The ledger sends through [`ForwardTicket`]; this is the classifier's
    /// test seam.
    #[cfg(test)]
    pub fn send(&self, record: &Record) -> Result<usize, ForwardError> {
        self.dispatch_for(record)?.send_blocking()
    }

    /// Hold a record that could not be delivered. Past the bound the
    /// oldest is dropped — recent attribution is the more useful half.
    pub fn queue(&mut self, record: Record) {
        if self.pending.len() >= PENDING_CAP {
            self.pending.pop_front();
            self.dropped += 1;
            tracing::error!(
                dropped = self.dropped,
                cap = PENDING_CAP,
                "changes-ledger forward queue overflowed; oldest pending attribution dropped"
            );
            // Dropped attribution is data loss ([LR8]): the deck must
            // report it, not present a quietly thinner changeset.
            crate::ledger_integrity::health::note_degraded("changes-forward-overflow");
        }
        self.pending.push_back(record);
    }

    /// Take everything held, oldest first — the takeover drain.
    pub fn take_pending(&mut self) -> Vec<Record> {
        self.pending.drain(..).collect()
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Whether enough time has passed to spend another claim attempt.
    /// Jittered by PID so co-launched instances do not retry in lockstep.
    pub fn retry_due(&self) -> bool {
        match self.last_attempt {
            None => true,
            Some(at) => {
                let jitter = Duration::from_millis(u64::from(std::process::id() % 250));
                at.elapsed() >= RETRY_FLOOR + jitter
            }
        }
    }

    pub fn note_attempt(&mut self) {
        self.last_attempt = Some(Instant::now());
    }
}

impl Drop for ChangesForwarder {
    /// A plain drop of a `Runtime` panics inside an async context, and a
    /// takeover drops the forwarder on whatever thread settles it. Shutting
    /// down in the background aborts any send still in flight, which its
    /// settle reads as a transport failure.
    fn drop(&mut self) {
        if let Some(rt) = self.rt.take() {
            rt.shutdown_background();
        }
    }
}

impl ForwardTicket {
    /// Run the send on the forwarder's runtime and wait for it. Callable
    /// from a tokio worker, a blocking-pool thread, or a plain thread: the
    /// future blocked on is a `JoinHandle`, and it is `unconstrained` so a
    /// worker's exhausted coop budget cannot make it spin.
    pub(crate) fn send_blocking(&self) -> Result<usize, ForwardError> {
        match &self.dispatch {
            Ok(dispatch) => dispatch.send_blocking(),
            Err(e) => Err(e.clone()),
        }
    }
}

impl Dispatch {
    fn send_blocking(&self) -> Result<usize, ForwardError> {
        let handle = self.rt.spawn(post(
            self.client.clone(),
            self.url.clone(),
            self.body.clone(),
        ));
        match futures::executor::block_on(tokio::task::coop::unconstrained(handle)) {
            Ok(outcome) => outcome,
            Err(e) => Err(ForwardError::Transport(e.to_string())),
        }
    }
}

async fn post(client: reqwest::Client, url: String, body: Vec<u8>) -> Result<usize, ForwardError> {
    let response = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| ForwardError::Transport(e.to_string()))?;
    // A status code is an answer, not a transport failure — `classify`
    // reads it, so a refusal by a live owner can be told apart from a
    // dead one.
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| ForwardError::Transport(e.to_string()))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| ForwardError::Transport(e.to_string()))?;
    classify(status, value)
}

/// Read the owner's answer: a `4xx` is a permanent refusal, a `5xx` or a
/// body that is not `status: ok` is a retryable one, anything else is the
/// row count the owner applied.
fn classify(status: u16, value: serde_json::Value) -> Result<usize, ForwardError> {
    let detail = || {
        value
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error")
            .to_string()
    };
    // 4xx: the owner understood the request and refused it. Resending an
    // unacceptable record cannot make it acceptable.
    if (400..500).contains(&status) {
        return Err(ForwardError::Rejected {
            detail: detail(),
            permanent: true,
        });
    }
    if status >= 500 || value.get("status").and_then(|s| s.as_str()) != Some("ok") {
        return Err(ForwardError::Rejected {
            detail: detail(),
            permanent: false,
        });
    }
    Ok(value.get("applied").and_then(|a| a.as_u64()).unwrap_or(0) as usize)
}

/// The identity this process publishes when it claims the writer role.
pub fn local_identity(http_port: u16) -> WriterOwner {
    WriterOwner {
        instance_id: tugcore::instance::instance_id().unwrap_or_else(|| "standalone".to_string()),
        pid: std::process::id() as i32,
        port: http_port,
    }
}

/// Resolve the currently reachable owner of `changes_db`: the published
/// claim identity, cross-checked against the instance registry (which
/// knows the port a live instance actually bound). A claim whose process
/// is gone resolves to `None` — the caller's cue to attempt takeover.
fn resolve_owner(changes_db: &Path) -> Option<WriterOwner> {
    let mut owner = tugcore::ledger_db::read_writer_owner(changes_db)?;
    if !pid_is_live(owner.pid) {
        return None;
    }
    // The registry is the authority on ports; a claim written before a
    // rebind would otherwise send us to a stale one.
    if let Ok(Some(entry)) = tugcore::registry::find_by_id(&owner.instance_id)
        && entry.pid == owner.pid
        && entry.tugcast_port != 0
    {
        owner.port = entry.tugcast_port;
    }
    Some(owner)
}

fn pid_is_live(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // `kill(pid, 0)` sends no signal and returns ESRCH iff the PID is
    // gone; EPERM still means the process exists.
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    ret == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_ledger::FileEventRow;

    fn row(id: &str) -> Record {
        Record::FileEvent {
            row: FileEventRow {
                tug_session_id: id.into(),
                tool_use_id: "t1".into(),
                file_path: "src/a.rs".into(),
                tool_name: "Write".into(),
                op: "modified".into(),
                origin: "exact".into(),
                ambiguous: false,
                parent_tool_use_id: None,
                project_dir: "/proj".into(),
                at: 1,
            },
            spans: Vec::new(),
        }
    }

    #[test]
    fn queue_is_bounded_and_drops_the_oldest() {
        let mut fwd = ChangesForwarder::new(PathBuf::from("/nonexistent/changes.db"));
        for i in 0..(PENDING_CAP + 3) {
            fwd.queue(row(&format!("s{i}")));
        }
        assert_eq!(fwd.pending_len(), PENDING_CAP);
        let drained = fwd.take_pending();
        assert!(
            matches!(&drained[0], Record::FileEvent { row, .. } if row.tug_session_id == "s3"),
            "the three oldest records are the ones dropped"
        );
        assert_eq!(fwd.pending_len(), 0);
    }

    /// Publish `port` as the live owner of `changes_db` — our own pid, so the
    /// liveness check passes — and hand back the path the forwarder reads.
    fn publish_owner(changes_db: &Path, port: u16) {
        let lock = changes_db.with_extension("db.writer-lock");
        std::fs::write(
            &lock,
            format!(
                r#"{{"instance_id":"test-owner-{port}","pid":{},"port":{port}}}"#,
                std::process::id()
            ),
        )
        .unwrap();
    }

    /// An owner that answers `400` understood the request and refused it.
    /// That must classify as a permanent rejection: the caller needs to hear
    /// "refused", not "unreachable", or a healthy owner gets its claim taken
    /// and one bad record is reported as a damaged ledger.
    #[tokio::test]
    async fn an_owner_that_refuses_the_record_is_a_permanent_rejection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = axum::Router::new().route(
            "/api/changes-write",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({
                        "status": "error",
                        "message": "invalid record: unknown variant `fe_disclaim`",
                    })),
                )
            }),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("changes.db");
        publish_owner(&db, port);

        let err = tokio::task::spawn_blocking(move || {
            ChangesForwarder::new(db).send(&row("s1")).unwrap_err()
        })
        .await
        .unwrap();

        let ForwardError::Rejected { detail, permanent } = err else {
            panic!("a 400 must be a rejection, not {err:?}");
        };
        assert!(permanent, "a 400 can never be fixed by retrying");
        assert!(detail.contains("fe_disclaim"), "detail carried: {detail}");
    }

    /// An owner whose own ledger erred is still an owner — the write is held
    /// for retry rather than treated as a dead process.
    #[tokio::test]
    async fn an_owner_that_errors_internally_is_a_retryable_rejection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = axum::Router::new().route(
            "/api/changes-write",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({ "status": "error", "message": "disk full" })),
                )
            }),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("changes.db");
        publish_owner(&db, port);

        let err = tokio::task::spawn_blocking(move || {
            ChangesForwarder::new(db).send(&row("s1")).unwrap_err()
        })
        .await
        .unwrap();

        assert!(
            matches!(
                err,
                ForwardError::Rejected {
                    permanent: false,
                    ..
                }
            ),
            "a 5xx is a retryable refusal, not {err:?}"
        );
    }

    #[test]
    fn send_without_a_claim_reports_no_owner() {
        let dir = tempfile::tempdir().unwrap();
        let fwd = ChangesForwarder::new(dir.path().join("changes.db"));
        assert!(matches!(fwd.send(&row("s1")), Err(ForwardError::NoOwner)));
    }

    #[test]
    fn a_claim_from_a_dead_process_is_not_an_owner() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("changes.db");
        // A PID that cannot be live: `kill(0, …)` addresses the process
        // group, so the claim writer uses positive PIDs only.
        let dead = WriterOwner {
            instance_id: "gone".into(),
            pid: i32::MAX,
            port: 1,
        };
        std::fs::write(
            tugcore::ledger_db::writer_lock_path(&db),
            serde_json::to_vec(&dead).unwrap(),
        )
        .unwrap();
        assert!(resolve_owner(&db).is_none());
    }
}

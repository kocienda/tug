//! `boot::ledgers` — open tugbank and the session and prompt ledgers, and
//! bring them up to date before any feed reads them.
//!
//! Two entry points, because the ledger work is not contiguous in startup.
//! [`ledgers`] runs before the DEFAULTS feed; [`ink_ledgers`] opens the shell
//! and refs ledgers and runs the two ink migrations, which today run after
//! the supervisor's feeds are built and before its first restore read.
//! Moving them up to join the first would reorder startup.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tracing::{error, info, warn};
use tugbank_core::TugbankClient;
use tugbank_core::notify as tugbank_notify;
use tugcore::instance as tug_instance;

use crate::ink_backfill;
use crate::ledger_integrity;
use crate::prompt_ledger::{self, PromptLedger};
use crate::prompt_lineage;
use crate::refs_ledger::{self, RefsLedger};
use crate::session_ledger::{self, LedgerError, SessionLedger};
use crate::shell_ledger::{self, ShellLedger};

/// The ledgers the rest of startup reads.
pub(crate) struct Ledgers {
    /// tugbank. `None` when it would not open, which the feeds stage then
    /// refuses to start without.
    pub(crate) bank_client: Option<Arc<TugbankClient>>,
    /// The tugbank change-notification socket, listened on by the feeds
    /// stage and removed at shutdown.
    pub(crate) notify_socket_path: PathBuf,
    /// The session ledger. Opening it is fatal on failure.
    pub(crate) ledger: Arc<SessionLedger>,
    /// The composer's prompt corpus. `None` when it would not open, which
    /// leaves prompt recall disabled rather than taking tugcast down.
    pub(crate) prompt_ledger: Option<Arc<PromptLedger>>,
}

/// Open tugbank, open the session ledger (refusing another instance's),
/// start its checkpoint watchdog, demote stale live rows, seat line
/// bindings, open the prompt ledger, migrate prompt history out of tugbank,
/// start the lineage backfill, and sweep orphaned composer attachments.
pub(crate) fn ledgers(actual_port: u16, bank_path: &Path) -> Ledgers {
    // Open the TugbankClient. On success, wrap in Arc for shared ownership between
    // migration, the defaults feed, and the HTTP server. On failure, log a warning
    // and continue without tugbank -- this preserves graceful degradation when the
    // bank path is inaccessible.
    let bank_client: Option<Arc<TugbankClient>> = match TugbankClient::open(bank_path) {
        Ok(client) => Some(Arc::new(client)),
        Err(e) => {
            warn!(
                path = %bank_path.display(),
                error = %e,
                "failed to open TugbankClient — defaults endpoints and feed disabled"
            );
            None
        }
    };

    // App-test launches suppress the ConfigureTug wizard: the harness marker
    // (TUGAPP_TEST_SOCKET, inherited app → tugexec → tugcast) seeds the
    // tugbank default the deck reads synchronously at mount, so a fresh
    // per-instance bank never opens the blocking first-run wizard under a
    // focus-driven test. TUGAPP_TEST_KEEP_SETUP opts a ConfigureTug-specific
    // test back in — seeded `false` explicitly so a reused bank cannot
    // leak suppression into it. Written before the server accepts
    // connections, so the deck can never load ahead of the seed.
    if std::env::var_os("TUGAPP_TEST_SOCKET").is_some() {
        let keep_setup = std::env::var_os("TUGAPP_TEST_KEEP_SETUP").is_some();
        if let Some(bank) = bank_client.as_ref() {
            if let Err(e) = bank.set(
                "dev.tugapp.app",
                "suppress-setup",
                tugbank_core::Value::Bool(!keep_setup),
            ) {
                warn!(error = %e, "failed to seed app-test suppress-setup default");
            }
        }
    }

    let notify_socket_path = tugbank_notify::socket_path();
    let bank_client_ref = bank_client.as_ref();

    // Open the session ledger BEFORE the DEFAULTS feed. A failure here is
    // fatal: the supervisor depends on the ledger to track session lifecycle,
    // and limping along with no session metadata would make every future
    // picker open misleading. Opening it here (rather than later) lets the
    // orphaned-prompt-history prune below run before the feed builds its
    // initial frame — keeping that frame clean and avoiding a frame rebuild
    // per deleted key.
    let (ledger, ledger_path) = match open_session_ledger(
        tug_instance::foreign_sessions_db_override(),
        SessionLedger::default_path,
        actual_port,
    ) {
        Ok(opened) => opened,
        Err(refused) => {
            eprintln!("tugcast: error: {refused}");
            std::process::exit(1);
        }
    };

    spawn_checkpoint_watchdog(Arc::clone(&ledger), ledger_path);

    // Demote any rows still marked `live` from a previous run that didn't
    // shut down cleanly. The subprocesses they pointed at are gone; their
    // ledger state is stale.
    demote_stale_live_rows(
        &ledger,
        tug_instance::instance_id().as_deref(),
        &tug_instance::session_index_db_path(),
    );

    // A relaunch seats each card on its line's tip, and the tip a rotation
    // minted carries no binding: the bind was written against the segment
    // that was the tug session id at the time. Move it to the seat before any
    // client asks what the card is bound to.
    match ledger.seat_line_bindings() {
        Ok(0) => {}
        Ok(n) => info!(
            count = n,
            "seated line arc bindings on the resumed segments"
        ),
        Err(e) => warn!(error = %e, "failed to seat line arc bindings"),
    }

    // Prompt-history ledger — the composer's durable prompt corpus. Non-fatal:
    // a failure leaves the recall routes unregistered, which the deck reports
    // to the user rather than swallowing, and must not take tugcast down.
    let prompt_ledger: Option<Arc<PromptLedger>> = {
        let path = PromptLedger::default_path();
        if let Some(parent) = path.parent() {
            crate::ensure_data_dir(parent);
        }
        match PromptLedger::open(&path) {
            Ok(l) => Some(Arc::new(l)),
            Err(e) => {
                warn!(error = %e, path = %path.display(), "failed to open prompt-history ledger (prompt recall disabled)");
                None
            }
        }
    };

    // Move whatever prompt history still lives in tugbank into the ledger. This
    // runs before the DEFAULTS feed builds the boot frame out of those domains,
    // and before the attachment sweep below reads the ledger as a root — an
    // entry mid-migration is referenced by neither home, so a sweep between the
    // two would see an attachment nothing claims.
    if let (Some(bank), Some(pl)) = (bank_client_ref, prompt_ledger.as_ref()) {
        // The migration logs its own count; nothing to report here.
        prompt_ledger::migrate_prompt_history(bank, pl);
    }

    // Copy each prompt-owning session's lineage into the corpus while the
    // session ledger can still supply it. This is a race against eviction, not
    // a repair: `sessions.db` is per-instance and drops rows on age and cap,
    // and an ancestry nobody recorded before it goes is not reconstructible
    // afterwards — the prompts stay on disk and become unreachable, which is
    // how a relaunched card came back blank in the first place. Runs after the
    // tugbank migration so imported rows are in the work list, and in the
    // background because a large corpus must never delay serving.
    if let Some(pl) = prompt_ledger.as_ref() {
        let backfill_sessions = Arc::clone(&ledger);
        let backfill_prompts = Arc::clone(pl);
        tokio::task::spawn_blocking(move || {
            prompt_lineage::backfill_at_startup(&backfill_sessions, &backfill_prompts);
        });
    }

    // Startup hygiene: reclaim composer attachments nothing references any
    // more. Runs after the migration above so every history reference lives in
    // a root the sweep can see, and before the DEFAULTS feed registers its
    // change callback so the deletions don't each rebuild the boot frame.
    if let Some(bank) = bank_client_ref {
        crate::draft_gc::sweep_at_startup(bank, prompt_ledger.as_deref());
    }

    Ledgers {
        bank_client,
        notify_socket_path,
        ledger,
        prompt_ledger,
    }
}

/// The ledgers durable ink is written to, beside the session ledger.
pub(crate) struct InkLedgers {
    /// `None` when it would not open: the `$` route then persists nothing.
    pub(crate) shell_ledger: Option<Arc<ShellLedger>>,
    /// `None` when it would not open: `/match` and `/search` then do not
    /// survive a reload.
    pub(crate) refs_ledger: Option<Arc<RefsLedger>>,
}

/// Open the shell and refs ledgers and run the two ink migrations. Called
/// ahead of the supervisor's first restore read.
pub(crate) fn ink_ledgers(ledger: &SessionLedger) -> InkLedgers {
    // Shell-exchange ledger — non-fatal: a failure means the `$` route just
    // won't persist exchanges (the deck degrades to no shell restore), which
    // must not take tugcast down.
    let shell_ledger: Option<Arc<ShellLedger>> = ShellLedger::default_path().and_then(|path| {
        if let Some(parent) = path.parent() {
            crate::ensure_data_dir(parent);
        }
        match shell_ledger::ShellLedger::open(&path) {
            Ok(l) => Some(Arc::new(l)),
            Err(e) => {
                warn!(error = %e, path = %path.display(), "failed to open shell ledger (shell persistence disabled)");
                None
            }
        }
    });

    // Refs ledger — non-fatal on the same grounds: without it `/match` and
    // `/search` still run, they just don't survive a reload.
    let refs_ledger: Option<Arc<RefsLedger>> = RefsLedger::default_path().and_then(|path| {
        if let Some(parent) = path.parent() {
            crate::ensure_data_dir(parent);
        }
        match refs_ledger::RefsLedger::open(&path) {
            Ok(l) => Some(Arc::new(l)),
            Err(e) => {
                warn!(error = %e, path = %path.display(), "failed to open refs ledger (refs restore disabled)");
                None
            }
        }
    });

    // Give every durable-ink row written before lines existed the line it
    // belongs to ([P09]). Ahead of the supervisor's first restore read,
    // because a row still carrying its migration's placeholder key reads as
    // nothing. Once resolved a row never moves again — which is why the three
    // adoption passes that used to run here are gone rather than rewritten.
    ink_backfill::assign_lines(ledger, shell_ledger.as_deref(), refs_ledger.as_deref());
    // And give every row a rotated card wrote under its retired first
    // segment the anchor it would have carried had the gateway read the
    // seated segment's transcript — once, so the join receipts already on
    // disk restore where the join happened rather than under the door.
    ink_backfill::reanchor_rotated_lines(
        ledger,
        shell_ledger.as_deref(),
        refs_ledger.as_deref(),
        session_ledger::now_millis(),
    );

    InkLedgers {
        shell_ledger,
        refs_ledger,
    }
}

/// Why the session ledger was not opened. Each one is fatal at startup.
#[derive(Debug)]
enum OpenRefused {
    /// `TUG_SESSIONS_DB` names a ledger outside this instance's data dir.
    Foreign {
        foreign: PathBuf,
        own: PathBuf,
    },
    /// No user data dir to put the ledger in.
    NoPath,
    CreateDir {
        dir: PathBuf,
        error: std::io::Error,
    },
    Open {
        path: PathBuf,
        error: LedgerError,
    },
}

impl fmt::Display for OpenRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Foreign { foreign, own } => write!(
                f,
                "{} names {}, which is not in this instance's data dir {}; \
                 refusing to open another instance's session ledger",
                tug_instance::ENV_SESSIONS_DB,
                foreign.display(),
                own.display(),
            ),
            Self::NoPath => write!(f, "cannot resolve user data dir for session ledger"),
            Self::CreateDir { dir, error } => write!(
                f,
                "failed to create ledger data dir {}: {}",
                dir.display(),
                error
            ),
            Self::Open { path, error } => write!(
                f,
                "failed to open session ledger at {}: {}",
                path.display(),
                error
            ),
        }
    }
}

/// Open the session ledger at `path`, creating its directory.
///
/// A tugcast opens only the ledger of the instance it *is*. `TUG_SESSIONS_DB`
/// is how a child reads the ledger its parent opened; inherited by a fresh
/// launch it makes this process adopt another instance's file, and the
/// startup demote then lands on rows a live foreign process owns. So a
/// `foreign` override is refused at the door, naming both paths, before the
/// path is even resolved — nothing is opened or created.
fn open_session_ledger(
    foreign: Option<(PathBuf, PathBuf)>,
    path: impl FnOnce() -> Option<PathBuf>,
    http_port: u16,
) -> Result<(Arc<SessionLedger>, PathBuf), OpenRefused> {
    if let Some((foreign, own)) = foreign {
        return Err(OpenRefused::Foreign { foreign, own });
    }
    let path = path().ok_or(OpenRefused::NoPath)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| OpenRefused::CreateDir {
            dir: parent.to_path_buf(),
            error,
        })?;
    }
    match SessionLedger::open(&path, http_port) {
        Ok(l) => Ok((Arc::new(l), path)),
        Err(error) => Err(OpenRefused::Open { path, error }),
    }
}

/// Close the live rows a previous run left behind, and return how many.
///
/// Scoped to rows this instance could have owned: "every live row belongs
/// to the process that died" is true of a ledger nothing else is using and
/// false of one a second process opened, and the unscoped write has
/// already closed a running instance's live rows once. A row the session
/// index files under another instance is left alone; an unrecorded row is
/// demoted, which is the crash debris this exists for.
fn demote_stale_live_rows(
    ledger: &SessionLedger,
    this_instance: Option<&str>,
    session_index_path: &Path,
) -> usize {
    let demote_scope = match this_instance {
        Some(id) => session_ledger::DemoteScope::ThisInstance {
            instance: id,
            index_path: session_index_path,
        },
        // No instance id: nothing recorded this process's rows under a name,
        // so there is no foreign owner to distinguish from.
        None => session_ledger::DemoteScope::EveryLiveRow,
    };
    match ledger.demote_live_to_closed(demote_scope) {
        Ok(0) => 0,
        Ok(n) => {
            info!(count = n, "demoted stale live ledger rows on startup");
            n
        }
        Err(e) => {
            warn!(error = %e, "failed to demote stale live ledger rows");
            0
        }
    }
}

/// Checkpoint-health watchdog. A WAL that keeps growing while
/// checkpoints move nothing is the silent precursor of ledger
/// corruption (sessions.db sat three days un-checkpointed before the
/// 2026-07-27 incident, with nothing logged). Passive-checkpoint both
/// databases periodically and alarm on two consecutive stalls or any
/// pragma failure.
fn spawn_checkpoint_watchdog(ledger: Arc<SessionLedger>, sessions_db_path: PathBuf) {
    let changes_db_path = tugcore::instance::changes_db_path();
    tokio::spawn(async move {
        const WATCHDOG_PERIOD: std::time::Duration = std::time::Duration::from_secs(300);
        // A healthy busy checkpoint leaves a short WAL; alarm only when
        // the backlog is real (~4 MB of 4 KB pages).
        const STALL_FRAMES: i64 = 1000;
        // Snapshot backups (`VACUUM INTO`, retained 5-deep beside each
        // db) on startup and every 6 hours of watchdog ticks.
        const BACKUP_EVERY_TICKS: u64 = 72;
        // Snapshotting the shared database belongs to whoever holds
        // the writer claim; a forwarding instance would duplicate the
        // owner's backups beside the same file.
        let backup_targets = |ledger: &session_ledger::SessionLedger| {
            let mut targets: Vec<(&str, &std::path::Path)> =
                vec![("main", sessions_db_path.as_path())];
            if ledger.owns_changes_writer() {
                targets.push(("changes", changes_db_path.as_path()));
            }
            ledger_integrity::snapshot_backups(ledger, &targets);
        };
        backup_targets(&ledger);
        let mut strikes: std::collections::HashMap<&'static str, u32> =
            std::collections::HashMap::new();
        let mut tick: u64 = 0;
        loop {
            tokio::time::sleep(WATCHDOG_PERIOD).await;
            tick += 1;
            // A forwarding instance whose owner died while nothing was
            // being written takes over here rather than waiting for
            // the next attribution event.
            ledger.retry_changes_takeover();
            // The inverse duty: an owner whose lockfile identity
            // drifted (publish failed at claim time) heals it here so
            // forwarders never route to a stale owner. No-op when the
            // content already matches.
            ledger.republish_writer_identity();
            if tick % BACKUP_EVERY_TICKS == 0 {
                backup_targets(&ledger);
            }
            for health in ledger.checkpoint_health() {
                let count = strikes.entry(health.db).or_insert(0);
                if let Some(err) = &health.error {
                    *count += 1;
                    error!(
                        db = health.db,
                        error = %err,
                        "ledger WAL checkpoint pragma failed — database may be corrupt or locked out"
                    );
                    // Two consecutive failures is the incident's
                    // silent signature; the deck must show it, not
                    // just the log ([LR4]).
                    if *count >= 2 {
                        ledger_integrity::health::note_degraded("checkpoint-error");
                    }
                    continue;
                }
                let stalled = health.log_frames >= STALL_FRAMES
                    && health.checkpointed_frames < health.log_frames;
                if stalled {
                    *count += 1;
                    if *count >= 2 {
                        error!(
                            db = health.db,
                            log_frames = health.log_frames,
                            checkpointed_frames = health.checkpointed_frames,
                            busy = health.busy,
                            "ledger WAL checkpoint stalled — WAL growing without being applied"
                        );
                        ledger_integrity::health::note_degraded("checkpoint-stall");
                    }
                } else {
                    if *count >= 2 {
                        info!(db = health.db, "ledger WAL checkpointing recovered");
                    }
                    *count = 0;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_foreign_override_is_refused_before_anything_is_opened() {
        let dir = tempfile::tempdir().expect("tempdir");
        let foreign = dir.path().join("other-instance/sessions.db");
        let own = dir.path().join("this-instance");
        let refused = open_session_ledger(
            Some((foreign.clone(), own.clone())),
            || panic!("the path must not be resolved once the override is refused"),
            0,
        )
        .err()
        .expect("a foreign override must be refused");

        assert!(matches!(refused, OpenRefused::Foreign { .. }));
        let message = refused.to_string();
        assert!(message.contains(tug_instance::ENV_SESSIONS_DB));
        assert!(message.contains(&foreign.display().to_string()));
        assert!(message.contains(&own.display().to_string()));
        assert!(!foreign.exists());
        assert!(!foreign.parent().unwrap().exists());
    }

    #[test]
    fn no_data_dir_is_refused() {
        let refused = open_session_ledger(None, || None, 0)
            .err()
            .expect("no path must be refused");
        assert!(matches!(refused, OpenRefused::NoPath));
    }

    #[test]
    fn a_fresh_data_dir_is_created_and_the_ledger_opened_in_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("instances/fresh/sessions.db");
        let (_ledger, opened_at) = open_session_ledger(None, || Some(path.clone()), 0)
            .expect("the ledger opens in a fresh data dir");
        assert_eq!(opened_at, path);
        assert!(path.exists());
    }

    #[test]
    fn a_data_dir_that_cannot_be_created_is_refused_naming_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"").unwrap();
        let path = blocker.join("sessions.db");
        let refused = open_session_ledger(None, || Some(path), 0)
            .err()
            .expect("a parent under a file cannot be created");
        assert!(matches!(refused, OpenRefused::CreateDir { .. }));
        assert!(refused.to_string().contains(&blocker.display().to_string()));
    }

    #[test]
    fn a_live_row_left_by_a_previous_run_is_demoted_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sessions.db");
        let (ledger, _) = open_session_ledger(None, || Some(path), 0).expect("open");
        ledger
            .record_spawn(
                "sess-crashed",
                "/ws",
                "/ws",
                "card-1",
                session_ledger::now_millis(),
                "",
                None,
            )
            .expect("record_spawn");

        let index = dir.path().join("session_index.db");
        assert_eq!(demote_stale_live_rows(&ledger, None, &index), 1);
        assert_eq!(demote_stale_live_rows(&ledger, None, &index), 0);
    }
}

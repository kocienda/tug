//! Changes & commits — the git surface of `tugtool` (`changes`, `preflight`,
//! `commit`, `log`, `diff`). A thin shell over [`tugchanges_core`]: parse
//! arguments, call the typed library API, and format the outcome as `--json`
//! (the shared `{schema_version, command, status, data, issues}` envelope) or a
//! plain read-out.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use tugchanges_core::{
    ChangesError, ChangesOptions, CommitError, CommitOptions, DiffOptions, LogOptions,
    PreflightOptions,
};

use crate::output::print_ok;

/// A CLI failure carrying its intended exit code. Exit 2 is the ledger's
/// "can't resolve the session" outcome (`changes`/`preflight`); exit 3 is the
/// `commit` refusal ([P03], unattributed files with no disposition); exit 1 is a
/// real error. Keeping the code with the message lets `main` map cleanly instead
/// of collapsing them the way a bare `String` would.
#[derive(Debug)]
pub enum AppError {
    Exit1(String),
    Exit2(String),
    Exit3(String),
    /// A child process's exit status, propagated verbatim and silently — the
    /// child has already said whatever it had to say.
    ExitStatus(u8),
    /// A failure whose report has already gone to stderr — carry the status,
    /// print nothing more. The edit verb reaches for this because it emits a
    /// `TUG-EDIT-ERROR` marker *after* its report, and only the site that
    /// still holds the program can compose one.
    Reported(u8),
}

impl AppError {
    /// The process exit this error produces. `ExitStatus` and `Reported` carry
    /// theirs; the numbered variants are their own number.
    pub fn exit_code(&self) -> u8 {
        match self {
            AppError::Exit1(_) => 1,
            AppError::Exit2(_) => 2,
            AppError::Exit3(_) => 3,
            AppError::ExitStatus(code) | AppError::Reported(code) => *code,
        }
    }

    /// The report, empty for the two variants that carry none.
    pub fn message(&self) -> &str {
        match self {
            AppError::Exit1(m) | AppError::Exit2(m) | AppError::Exit3(m) => m,
            AppError::ExitStatus(_) | AppError::Reported(_) => "",
        }
    }
}

impl From<ChangesError> for AppError {
    fn from(err: ChangesError) -> Self {
        if err.is_exit_two() {
            AppError::Exit2(err.to_string())
        } else {
            AppError::Exit1(err.to_string())
        }
    }
}

impl From<CommitError> for AppError {
    fn from(err: CommitError) -> Self {
        if err.is_refusal() {
            AppError::Exit3(err.to_string())
        } else {
            AppError::Exit1(err.to_string())
        }
    }
}

impl From<String> for AppError {
    fn from(msg: String) -> Self {
        AppError::Exit1(msg)
    }
}

/// Map a git-verb result to a process exit code, printing the error to stderr.
pub fn finish(result: Result<(), AppError>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(AppError::Exit1(msg)) => {
            eprintln!("error: {msg}");
            ExitCode::from(1)
        }
        Err(AppError::Exit2(msg)) => {
            eprintln!("error: {msg}");
            ExitCode::from(2)
        }
        Err(AppError::Exit3(msg)) => {
            eprintln!("error: {msg}");
            ExitCode::from(3)
        }
        Err(AppError::ExitStatus(code)) => ExitCode::from(code),
        Err(AppError::Reported(code)) => ExitCode::from(code),
    }
}

pub fn run_changes(
    session: Option<String>,
    project: Option<PathBuf>,
    all: bool,
    diff: bool,
    json: bool,
) -> Result<(), AppError> {
    let report = tugchanges_core::changes(ChangesOptions {
        session,
        project,
        all,
        diff,
    })?;
    if json {
        print_ok("changes", &report);
    } else {
        // Plain: one repo-relative path per line, EXCLUDING shared rows (the
        // skill opts into those via --json); the omitted count goes to stderr so
        // it isn't silent.
        for file in report.files.iter().filter(|f| !f.shared) {
            println!("{}", file.path);
        }
        let omitted = report.files.iter().filter(|f| f.shared).count();
        if omitted > 0 {
            eprintln!("{omitted} shared file(s) omitted — use --json to see them");
        }
    }
    Ok(())
}

/// Claim files for a session: promote the listed repo-relative paths from
/// "likely" hints into the session's changeset by asking the running tugcast
/// to write a proof-grade `claim` file event per path (via `/api/tell` →
/// `handle_control`). The intentional counterpart to editing — a file touched
/// through `perl`/`sed` (bracket-only correlation) or by hand can be claimed
/// without re-editing it. Requires a running instance (the ledger writer +
/// aggregate bump live in tugcast).
pub fn run_claim(
    paths: Vec<String>,
    session: Option<String>,
    project: Option<PathBuf>,
    json: bool,
) -> Result<(), AppError> {
    tell_ownership_verb("claim", "changeset_claim", paths, session, project, json)
}

/// Disclaim files for a session: remove the listed repo-relative paths from the
/// session's changeset by asking the running tugcast to delete the session's
/// rows for them. The inverse of [`run_claim`] — the file falls to another
/// session that still holds proof of it (which also resolves a SHARED file in
/// that session's favor), or back to unattributed. Requires a running instance.
pub fn run_disclaim(
    paths: Vec<String>,
    session: Option<String>,
    project: Option<PathBuf>,
    json: bool,
) -> Result<(), AppError> {
    tell_ownership_verb(
        "disclaim",
        "changeset_disclaim",
        paths,
        session,
        project,
        json,
    )
}

/// The shared body of `claim`/`disclaim`: resolve the session and project,
/// then POST the ownership verb to the running instance's `/api/tell`.
fn tell_ownership_verb(
    verb: &str,
    action: &str,
    paths: Vec<String>,
    session: Option<String>,
    project: Option<PathBuf>,
    json: bool,
) -> Result<(), AppError> {
    if paths.is_empty() {
        return Err(AppError::Exit1(format!("no paths to {verb}")));
    }
    // Claiming is a **write** about who owns a file, so it is addressed to
    // the line's live segment rather than to whatever id this process was
    // spawned under ([P01]). The server expands to the line's seat on its own
    // side too, but a stale id still reaches it as a corpse to revive and as
    // the wrong session for the receipt to name.
    let session_id = crate::session_identity::resolve_soft(session.as_deref())
        .map(|r| r.session_id)
        .ok_or_else(|| {
            AppError::Exit1("no session — pass --session or set TUG_SESSION_ID".to_string())
        })?;
    let project_dir = match project {
        Some(p) => p,
        None => std::env::current_dir()
            .map_err(|e| AppError::Exit1(format!("cannot resolve cwd: {e}")))?,
    };
    // Canonicalize so the project_dir matches a WorkspaceRegistry entry (the
    // backend guards on it) regardless of symlinked checkout spellings.
    let project_dir = std::fs::canonicalize(&project_dir)
        .unwrap_or(project_dir)
        .to_string_lossy()
        .into_owned();

    // These verbs declare no instance flags, so the remedy they name must stop
    // at the environment variable.
    let port = crate::commands::tell::resolve_port(None, None)
        .map_err(|e| e.describe(crate::commands::tell::Remedy::EnvOnly))?;
    let body = serde_json::json!({
        "action": action,
        "project_dir": project_dir,
        "session_id": session_id,
        "files": paths,
    });
    let url = format!("http://127.0.0.1:{port}/api/tell");
    match ureq::post(&url).send_json(&body) {
        Ok(mut resp) if resp.status().as_u16() == 200 => {
            // The bridge returns the handler's own reply frame — the same
            // `changeset_claim_ok` / `_err` a deck client sees — so report
            // what actually happened rather than inferring success from a
            // bare 200 (the old behavior, which printed "claimed N" for a
            // batch the server had refused or a claimant it could not hold).
            let reply = resp
                .body_mut()
                .read_json::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("reply").cloned());
            let action_name = reply
                .as_ref()
                .and_then(|r| r.get("action"))
                .and_then(|a| a.as_str())
                .map(str::to_owned);
            if action_name.as_deref() == Some(&format!("changeset_{verb}_err")) {
                let detail = reply
                    .as_ref()
                    .and_then(|r| r.get("detail"))
                    .and_then(|d| d.as_str())
                    .unwrap_or("refused");
                return Err(AppError::Exit1(format!("{verb} refused: {detail}")));
            }
            let count_key = format!("{verb}ed");
            let count = reply
                .as_ref()
                .and_then(|r| r.get(&count_key))
                .and_then(|c| c.as_u64())
                .unwrap_or(paths.len() as u64);
            let warning = reply
                .as_ref()
                .and_then(|r| r.get("warning"))
                .and_then(|w| w.as_str())
                .map(str::to_owned);
            if json {
                let mut data = serde_json::Map::new();
                data.insert(count_key, count.into());
                if let Some(w) = &warning {
                    data.insert("warning".to_string(), w.as_str().into());
                }
                print_ok(verb, serde_json::Value::Object(data));
            } else {
                println!("{verb}ed {count} file(s) for session {session_id}");
                if let Some(w) = &warning {
                    eprintln!("warning: {w}");
                }
            }
            // A shortfall is a failure with a receipt attached, not a
            // success: the caller asked for N and got fewer.
            if (count as usize) < paths.len() {
                return Err(AppError::Exit1(format!(
                    "{verb} shortfall: {count} of {} file(s) landed",
                    paths.len()
                )));
            }
            Ok(())
        }
        Ok(resp) => Err(AppError::Exit1(format!(
            "tugcast returned status {}",
            resp.status().as_u16()
        ))),
        Err(e) => Err(AppError::Exit1(format!("{verb} request failed: {e}"))),
    }
}

pub fn run_preflight(
    session: Option<String>,
    project: Option<PathBuf>,
    log_limit: u32,
    json: bool,
) -> Result<(), AppError> {
    let report = tugchanges_core::preflight(PreflightOptions {
        session,
        project,
        log_limit,
    })?;
    if json {
        print_ok("preflight", &report);
    } else {
        print_preflight_plain(&report);
    }
    Ok(())
}

/// The default (non-`--json`) `preflight` read-out: a complete, directly-readable
/// summary of everything a commit needs — no `jq`/`python`/`grep` reshaping.
/// Each attributed file carries its `op·origin` and, when contended, a
/// `shared` marker naming the other owner(s); `foreign` files name their owner
/// session; an `unattributed` file this session's own bracket saw change is
/// tagged `likely this session's (bash bracket)`; the disposition hint spells
/// out how to clear a non-empty `unattributed` bucket (the exit-3 case). Empty
/// buckets are omitted, so a clean session stays terse.
fn print_preflight_plain(report: &tugchanges_core::PreflightReport) {
    println!(
        "branch {}  head {}  session {}",
        report.branch, report.head, report.session
    );

    println!("attributed ({}):", report.files.len());
    for f in &report.files {
        let shared = if f.shared {
            format!("  shared with {}", f.sessions.join(", "))
        } else {
            String::new()
        };
        println!(
            "  {:<2} {}·{}  {}{}",
            f.git_status, f.op, f.origin, f.path, shared
        );
    }

    if !report.unattributed.is_empty() {
        println!("unattributed ({}):", report.unattributed.len());
        for f in &report.unattributed {
            // A bracket hint: this session's Bash/turn window saw the path
            // change — likely (but not provably) this session's work.
            let hint = if f.origin == "none" {
                String::new()
            } else {
                format!("  likely this session's ({} bracket)", f.origin)
            };
            println!("  {:<2} {}{}", f.git_status, f.path, hint);
        }
        println!(
            "  → dispose explicitly: --include-unattributed (commit them), \
             --leave-unattributed (proceed without), or --paths <p…>"
        );
    }

    if !report.foreign.is_empty() {
        println!(
            "foreign ({}) — other sessions' work, never in a default commit:",
            report.foreign.len()
        );
        for f in &report.foreign {
            println!(
                "  {:<2} {}  owner {}",
                f.git_status,
                f.path,
                f.sessions.join(", ")
            );
        }
    }

    println!("recent commits:");
    for c in &report.recent_commits {
        println!("  {} {}", c.sha, c.subject);
    }
}

#[allow(clippy::too_many_arguments)]
pub fn run_commit(
    message: String,
    session: Option<String>,
    project: Option<PathBuf>,
    paths: Vec<String>,
    all: bool,
    include_unattributed: bool,
    leave_unattributed: bool,
    tree: bool,
    hunks: Option<String>,
    json: bool,
) -> Result<(), AppError> {
    let hunks = match hunks {
        Some(source) => Some(read_hunk_election(&source)?),
        None => None,
    };
    let receipt = tugchanges_core::commit(CommitOptions {
        session,
        project,
        message,
        paths: if paths.is_empty() { None } else { Some(paths) },
        all,
        include_unattributed,
        leave_unattributed,
        tree,
        hunks,
    })
    .map_err(refusal_to_app_error)?;
    if json {
        print_ok("commit", &receipt);
    } else {
        println!("committed {} on {}", receipt.sha, receipt.branch);
        println!(
            "{} file(s), +{} -{}",
            receipt.aggregate.files_changed,
            receipt.aggregate.insertions,
            receipt.aggregate.deletions
        );
        for file in &receipt.files {
            println!("  {} {}", file.status, file.path);
        }
        print_left_behind(&receipt.left_behind);
    }
    Ok(())
}

/// Read the `--hunks` map (Spec S03) from a file, or from stdin when `source`
/// is `-`.
fn read_hunk_election(source: &str) -> Result<BTreeMap<String, Vec<String>>, AppError> {
    let text = if source == "-" {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)
            .map_err(|e| AppError::from(format!("failed to read --hunks from stdin: {e}")))?;
        buf
    } else {
        std::fs::read_to_string(source)
            .map_err(|e| AppError::from(format!("failed to read --hunks file {source}: {e}")))?
    };
    serde_json::from_str(&text)
        .map_err(|e| AppError::from(format!("--hunks is not a {{path: [id…]}} JSON map: {e}")))
}

/// Map a [`CommitError`] to its exit code, expanding the [P03] refusal into a
/// stderr message that lists the offending paths **and** names the disposition
/// flags that resolve it (Spec S03) — so the agent/user always sees the way out.
fn refusal_to_app_error(err: CommitError) -> AppError {
    match err {
        CommitError::UnattributedPresent { paths } => {
            let mut msg = format!(
                "refusing to commit: {} unattributed dirty file(s) have no disposition:",
                paths.len()
            );
            for path in &paths {
                msg.push_str(&format!("\n  {path}"));
            }
            msg.push_str(
                "\nre-run with one of: --include-unattributed (commit them), \
                 --leave-unattributed (proceed without them), --tree (commit the \
                 whole dirty tree), or --paths <p…> (choose explicitly)",
            );
            AppError::Exit3(msg)
        }
        other => AppError::from(other),
    }
}

/// Print the receipt's still-dirty buckets (Spec S04) when any is non-empty, so
/// a partial commit is visible immediately on the plain output.
fn print_left_behind(left_behind: &tugchanges_core::LeftBehind) {
    let sections = [
        ("unattributed", &left_behind.unattributed),
        ("foreign", &left_behind.foreign),
        ("shared", &left_behind.shared),
    ];
    for (label, paths) in sections {
        if !paths.is_empty() {
            println!("left behind ({label}): {}", paths.join(", "));
        }
    }
}

pub fn run_log(limit: Option<u32>, range: Option<String>, json: bool) -> Result<(), AppError> {
    let report = tugchanges_core::log(LogOptions { limit, range })?;
    if json {
        print_ok("log", &report);
    } else {
        for commit in &report.commits {
            println!("{} {}", commit.sha, commit.subject);
        }
    }
    Ok(())
}

pub fn run_diff(
    range: Option<String>,
    staged: bool,
    session: bool,
    project: Option<PathBuf>,
    json: bool,
) -> Result<(), AppError> {
    let report = tugchanges_core::diff(DiffOptions {
        session: None,
        project,
        range,
        staged,
        session_scope: session,
    })?;
    if json {
        print_ok("diff", &report);
    } else {
        for file in &report.files {
            let added = file
                .added
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".into());
            let deleted = file
                .deleted
                .map(|n| n.to_string())
                .unwrap_or_else(|| "-".into());
            println!("{} {} (+{added} -{deleted})", file.status, file.path);
        }
    }
    Ok(())
}

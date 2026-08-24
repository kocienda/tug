//! Integration tests for the `tug` CLI, driving the built binary against a
//! real temp git repo and a seeded two-file ledger (`sessions.db` +
//! `changes.db`).
//!
//! Both ledgers are pointed at seeded temp files via explicit env overrides —
//! `TUG_SESSIONS_DB` for the per-instance `sessions.db` and `TUG_CHANGES_DB`
//! for the machine-global `changes.db`. This keeps the suite fully isolated
//! from the developer's real ledger and platform-independent: `dirs::data_dir()`
//! resolves differently on Linux (`XDG_DATA_HOME`) than macOS, so seeding via
//! `HOME` alone would not survive CI (ubuntu).

use std::path::{Path, PathBuf};
use std::process::Command;

use assert_cmd::cargo::CommandCargoExt;
use rusqlite::Connection;

/// Run a git command in `dir`, asserting success.
fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// A temp git repo with one committed file and an untracked `feature.rs`. The
/// returned root is canonicalized (macOS tempdirs live under a `/private/var`
/// symlink, and `git rev-parse --show-toplevel` reports the canonical form), so
/// the seeded absolute event paths strip against the same root the binary
/// resolves.
fn init_repo() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "t@t.test"]);
    git(&root, &["config", "user.name", "t"]);
    std::fs::write(root.join("base.rs"), "base\n").unwrap();
    git(&root, &["add", "base.rs"]);
    git(&root, &["commit", "-q", "-m", "init"]);
    std::fs::write(root.join("feature.rs"), "one\ntwo\n").unwrap();
    (dir, root)
}

/// A temp dir seeded with the two-file ledger the binary reads: the
/// per-instance `sessions.db` (the `sessions` table) and the machine-global
/// `changes.db` (the `file_events` table, [D112]). Seeds `session` ("work",
/// with a `feature.rs` created event) and an empty `empty` session row. The
/// returned dir is handed to [`tug`], which points `TUG_SESSIONS_DB` and
/// `TUG_CHANGES_DB` at the two files.
fn seed_ledger(repo_root: &Path) -> tempfile::TempDir {
    let db_dir = tempfile::tempdir().unwrap();
    let sessions = Connection::open(db_dir.path().join("sessions.db")).unwrap();
    sessions
        .execute_batch("CREATE TABLE sessions (session_id TEXT PRIMARY KEY);")
        .unwrap();
    sessions
        .execute(
            "INSERT INTO sessions (session_id) VALUES ('work'), ('empty')",
            [],
        )
        .unwrap();
    let changes = Connection::open(db_dir.path().join("changes.db")).unwrap();
    changes
        .execute_batch(
            "CREATE TABLE file_events (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);",
        )
        .unwrap();
    changes
        .execute(
            "INSERT INTO file_events
                (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
             VALUES ('work', 'tu-1', ?1, 'Write', 'created', 'exact', 0, ?2, 1)",
            rusqlite::params![
                repo_root.join("feature.rs").to_string_lossy().to_string(),
                repo_root.to_string_lossy().to_string()
            ],
        )
        .unwrap();
    db_dir
}

/// A `tug` command with both ledgers pointed at the seeded `db_dir` via the
/// `TUG_SESSIONS_DB` / `TUG_CHANGES_DB` overrides, and no instance id.
fn tug(db_dir: &Path) -> Command {
    let mut cmd = Command::cargo_bin("tugutil").unwrap();
    cmd.env_remove("TUG_INSTANCE_ID");
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env("TUG_SESSIONS_DB", db_dir.join("sessions.db"));
    cmd.env("TUG_CHANGES_DB", db_dir.join("changes.db"));
    cmd
}

/// Run to completion and return `(exit_code, stdout, stderr)`.
fn run(mut cmd: Command) -> (i32, String, String) {
    let out = cmd.output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn parse(stdout: &str) -> serde_json::Value {
    serde_json::from_str(stdout).expect("valid JSON envelope")
}

fn project_arg(repo: &Path) -> Vec<String> {
    vec!["--project".to_string(), repo.to_string_lossy().into_owned()]
}

#[test]
fn changes_json_emits_envelope_with_the_changed_file() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args(["changes", "--json", "--session", "work"]);
    cmd.args(project_arg(&root));

    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0);
    let v = parse(&stdout);
    assert_eq!(v["schema_version"], "1");
    assert_eq!(v["command"], "changes");
    assert_eq!(v["status"], "ok");
    let files = v["data"]["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], "feature.rs");
    assert_eq!(files[0]["git_status"], "??");
}

#[test]
fn preflight_plain_is_directly_readable_no_reshaping_needed() {
    // The default (non-JSON) read-out must carry everything a commit agent
    // needs — header, per-file op·origin, buckets — so nothing has to be piped
    // through jq/python/grep.
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args(["preflight", "--session", "work"]);
    cmd.args(project_arg(&root));

    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0);
    assert!(stdout.contains("branch main"), "header line: {stdout}");
    assert!(
        stdout.contains("session work"),
        "names the session: {stdout}"
    );
    assert!(
        stdout.contains("attributed (1):"),
        "labeled bucket: {stdout}"
    );
    // The attributed file carries its op·origin inline (created·exact here).
    assert!(
        stdout.contains("created·exact") && stdout.contains("feature.rs"),
        "per-file op·origin present: {stdout}"
    );
    assert!(
        stdout.contains("recent commits:"),
        "history section: {stdout}"
    );
}

#[test]
fn a_bash_bracket_row_hints_but_never_auto_commits() {
    // Correlation never decides, not even for self: a file this session's own
    // Bash bracket saw change (which could equally be the user's hand-save
    // during the command) surfaces as `unattributed` with a named hint, the
    // default commit refuses (exit 3), and inclusion is the explicit
    // `--include-unattributed` election.
    let (_repo, root) = init_repo();
    std::fs::write(root.join("swept.rs"), "swept\n").unwrap();
    let ledger = seed_ledger(&root);
    let changes = Connection::open(ledger.path().join("changes.db")).unwrap();
    changes
        .execute(
            "INSERT INTO file_events
                (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
             VALUES ('work', 'tu-b', ?1, 'Bash', 'modified', 'bash', 0, ?2, 2)",
            rusqlite::params![
                root.join("swept.rs").to_string_lossy().to_string(),
                root.to_string_lossy().to_string()
            ],
        )
        .unwrap();

    let mut cmd = tug(ledger.path());
    cmd.args(["preflight", "--session", "work"]);
    cmd.args(project_arg(&root));
    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0);
    assert!(stdout.contains("attributed (1):"), "{stdout}");
    assert!(stdout.contains("unattributed (1):"), "{stdout}");
    assert!(
        stdout.contains("swept.rs  likely this session's (bash bracket)"),
        "the hint names the bracket: {stdout}"
    );

    let mut refuse = tug(ledger.path());
    refuse.args(["commit", "--message", "m", "--session", "work"]);
    refuse.args(project_arg(&root));
    let (code, _, stderr) = run(refuse);
    assert_eq!(code, 3, "a hinted file still refuses by default: {stderr}");
    assert!(stderr.contains("swept.rs"), "{stderr}");

    let mut include = tug(ledger.path());
    include.args([
        "commit",
        "--message",
        "take both",
        "--include-unattributed",
        "--session",
        "work",
    ]);
    include.args(project_arg(&root));
    let (code, stdout, stderr) = run(include);
    assert_eq!(code, 0, "explicit election commits: {stderr}");
    assert!(stdout.contains("committed"), "{stdout}");
    assert!(
        status_porcelain(&root).is_empty(),
        "tree clean after commit"
    );
}

#[test]
fn preflight_json_matches_s02_shape() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args(["preflight", "--json", "--session", "work"]);
    cmd.args(project_arg(&root));

    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0);
    let v = parse(&stdout);
    assert_eq!(v["command"], "preflight");
    let data = &v["data"];
    assert_eq!(data["session"], "work");
    assert_eq!(data["branch"], "main");
    assert!(data["repo_root"].is_string());
    assert!(!data["head"].as_str().unwrap().is_empty());
    let files = data["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    // Preflight always carries a diff — a created file gets a real add-diff.
    let diff = files[0]["diff"].as_str().unwrap();
    assert!(diff.contains("feature.rs"), "add-diff present: {diff}");
    let commits = data["recent_commits"].as_array().unwrap();
    assert_eq!(commits[0]["subject"], "init");
}

#[test]
fn commit_json_stages_the_session_file_and_matches_numstat() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args([
        "commit",
        "--json",
        "--session",
        "work",
        "--message",
        "add feature",
    ]);
    cmd.args(project_arg(&root));

    let (code, stdout, stderr) = run(cmd);
    assert_eq!(code, 0, "stderr: {stderr}");
    let v = parse(&stdout);
    assert_eq!(v["command"], "commit");
    let data = &v["data"];
    assert_eq!(data["branch"], "main");
    assert_eq!(data["message"], "add feature");
    let files = data["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], "feature.rs");
    assert_eq!(files[0]["status"], "created");
    assert_eq!(files[0]["added"], 2);
    assert_eq!(data["aggregate"]["files_changed"], 1);
    assert_eq!(data["aggregate"]["insertions"], 2);

    // The commit really landed: feature.rs is now committed (clean tree).
    let status = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty());
}

#[test]
fn log_json_emits_envelope() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.current_dir(&root);
    cmd.args(["log", "--json", "--limit", "5"]);

    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0);
    let v = parse(&stdout);
    assert_eq!(v["command"], "log");
    let commits = v["data"]["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0]["subject"], "init");
}

#[test]
fn diff_json_emits_envelope() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    // Modify a tracked file so the working-tree diff is non-empty.
    std::fs::write(root.join("base.rs"), "base\nmore\n").unwrap();
    let mut cmd = tug(ledger.path());
    cmd.args(["diff", "--json"]);
    cmd.args(project_arg(&root));

    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0);
    let v = parse(&stdout);
    assert_eq!(v["command"], "diff");
    let files = v["data"]["files"].as_array().unwrap();
    assert!(files.iter().any(|f| f["path"] == "base.rs"));
}

#[test]
fn unknown_session_exits_two_valid_empty_exits_zero() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);

    // Unknown session → exit 2.
    let mut cmd = tug(ledger.path());
    cmd.args(["changes", "--session", "ghost"]);
    cmd.args(project_arg(&root));
    let (code, _, stderr) = run(cmd);
    assert_eq!(code, 2, "unknown session exits 2");
    assert!(stderr.contains("unknown"), "stderr: {stderr}");

    // Known-but-empty session → exit 0, no files listed.
    let mut cmd = tug(ledger.path());
    cmd.args(["changes", "--session", "empty"]);
    cmd.args(project_arg(&root));
    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0, "valid empty session exits 0");
    assert!(stdout.trim().is_empty(), "no paths for an empty session");
}

#[test]
fn no_session_id_exits_two() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args(["changes"]);
    cmd.args(project_arg(&root));
    let (code, _, stderr) = run(cmd);
    assert_eq!(code, 2, "no session id exits 2");
    assert!(stderr.contains("no session id"), "stderr: {stderr}");
}

// --- Bucket surfacing + commit disposition (Steps 3–5) --------------------

/// A temp ledger dir seeding a `file_events` row per `(session, repo_relative_path)`
/// (all `project_dir = repo_root`, `created`), registering each distinct session
/// plus an empty `empty` session — the multi-session fixture the bucket tests
/// need (the same path under two sessions makes it `shared` for both).
/// `file_path` is stored repo-relative, the capture-time form the per-path
/// contention query joins on.
fn seed_ledger_events(repo_root: &Path, events: &[(&str, &str)]) -> tempfile::TempDir {
    let db_dir = tempfile::tempdir().unwrap();
    let sessions = Connection::open(db_dir.path().join("sessions.db")).unwrap();
    sessions
        .execute_batch("CREATE TABLE sessions (session_id TEXT PRIMARY KEY);")
        .unwrap();
    sessions
        .execute("INSERT INTO sessions (session_id) VALUES ('empty')", [])
        .unwrap();
    let changes = Connection::open(db_dir.path().join("changes.db")).unwrap();
    changes
        .execute_batch(
            "CREATE TABLE file_events (
                tug_session_id TEXT, tool_use_id TEXT, file_path TEXT,
                tool_name TEXT, op TEXT, origin TEXT, ambiguous INTEGER,
                parent_tool_use_id TEXT, project_dir TEXT, at INTEGER);",
        )
        .unwrap();
    for (i, (session, path)) in events.iter().enumerate() {
        sessions
            .execute(
                "INSERT OR IGNORE INTO sessions (session_id) VALUES (?1)",
                [session],
            )
            .unwrap();
        changes
            .execute(
                "INSERT INTO file_events
                    (tug_session_id, tool_use_id, file_path, tool_name, op, origin, ambiguous, project_dir, at)
                 VALUES (?1, ?2, ?3, 'Write', 'created', 'exact', 0, ?4, ?5)",
                rusqlite::params![
                    session,
                    format!("tu-{i}"),
                    path,
                    repo_root.to_string_lossy().to_string(),
                    i as i64
                ],
            )
            .unwrap();
    }
    db_dir
}

/// `git status --porcelain` output at `root`.
fn status_porcelain(root: &Path) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn preflight_surfaces_an_unattributed_file_with_a_diff() {
    let (_repo, root) = init_repo();
    std::fs::write(root.join("orphan.rs"), "orphan\n").unwrap();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args(["preflight", "--json", "--session", "work"]);
    cmd.args(project_arg(&root));

    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0);
    let v = parse(&stdout);
    // feature.rs is this session's (attributed); orphan.rs has no rows.
    let files = v["data"]["files"].as_array().unwrap();
    assert!(files.iter().any(|f| f["path"] == "feature.rs"));
    let un = v["data"]["unattributed"].as_array().unwrap();
    assert_eq!(un.len(), 1);
    assert_eq!(un[0]["path"], "orphan.rs");
    assert_eq!(un[0]["op"], "unknown");
    assert_eq!(un[0]["origin"], "none");
    assert!(
        un[0]["diff"].as_str().unwrap().contains("orphan.rs"),
        "unattributed carries a diff"
    );
}

#[test]
fn default_commit_refuses_unattributed_with_exit_three() {
    let (_repo, root) = init_repo();
    std::fs::write(root.join("orphan.rs"), "orphan\n").unwrap();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args(["commit", "--session", "work", "--message", "m"]);
    cmd.args(project_arg(&root));

    let (code, _out, err) = run(cmd);
    assert_eq!(code, 3, "refusal is exit 3; stderr: {err}");
    assert!(err.contains("orphan.rs"), "names the file: {err}");
    assert!(
        err.contains("--include-unattributed") && err.contains("--tree"),
        "names the disposition flags: {err}"
    );
    // Nothing committed: both files still dirty, HEAD still at init.
    let status = status_porcelain(&root);
    assert!(
        status.contains("orphan.rs") && status.contains("feature.rs"),
        "tree still dirty: {status}"
    );
}

#[test]
fn include_unattributed_commits_the_orphan_file() {
    let (_repo, root) = init_repo();
    std::fs::write(root.join("orphan.rs"), "orphan\n").unwrap();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args([
        "commit",
        "--json",
        "--session",
        "work",
        "--message",
        "m",
        "--include-unattributed",
    ]);
    cmd.args(project_arg(&root));

    let (code, out, err) = run(cmd);
    assert_eq!(code, 0, "stderr: {err}");
    let v = parse(&out);
    let paths: Vec<&str> = v["data"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(
        paths.contains(&"feature.rs") && paths.contains(&"orphan.rs"),
        "committed both: {paths:?}"
    );
}

#[test]
fn leave_unattributed_proceeds_and_records_left_behind() {
    let (_repo, root) = init_repo();
    std::fs::write(root.join("orphan.rs"), "orphan\n").unwrap();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args([
        "commit",
        "--json",
        "--session",
        "work",
        "--message",
        "m",
        "--leave-unattributed",
    ]);
    cmd.args(project_arg(&root));

    let (code, out, err) = run(cmd);
    assert_eq!(code, 0, "stderr: {err}");
    let v = parse(&out);
    // Committed feature.rs only.
    let files = v["data"]["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], "feature.rs");
    // The held-back orphan is named in left_behind.
    let lb: Vec<&str> = v["data"]["left_behind"]["unattributed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert_eq!(lb, vec!["orphan.rs"]);
}

#[test]
fn tree_commits_attributed_unattributed_and_shared() {
    let (_repo, root) = init_repo();
    std::fs::write(root.join("both.rs"), "both\n").unwrap();
    std::fs::write(root.join("orphan.rs"), "orphan\n").unwrap();
    // work claims feature.rs alone and both.rs jointly with `other` (so both.rs
    // is shared for work); orphan.rs has no rows.
    let ledger = seed_ledger_events(
        &root,
        &[
            ("work", "feature.rs"),
            ("work", "both.rs"),
            ("other", "both.rs"),
        ],
    );

    // Default base excludes the shared file: without --all/--tree, a commit
    // that leaves the orphan behind commits feature.rs only.
    let mut cmd = tug(ledger.path());
    cmd.args([
        "commit",
        "--json",
        "--session",
        "work",
        "--message",
        "m1",
        "--leave-unattributed",
    ]);
    cmd.args(project_arg(&root));
    let (code, out, err) = run(cmd);
    assert_eq!(code, 0, "stderr: {err}");
    let v = parse(&out);
    let files = v["data"]["files"].as_array().unwrap();
    assert_eq!(files.len(), 1, "shared file excluded from the default base");
    assert_eq!(files[0]["path"], "feature.rs");
    let lb_shared: Vec<&str> = v["data"]["left_behind"]["shared"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert_eq!(
        lb_shared,
        vec!["both.rs"],
        "the receipt names the held-back shared file"
    );

    // --tree then sweeps everything but foreign: shared + unattributed included.
    let mut cmd = tug(ledger.path());
    cmd.args([
        "commit",
        "--json",
        "--session",
        "work",
        "--message",
        "m2",
        "--tree",
    ]);
    cmd.args(project_arg(&root));
    let (code, out, err) = run(cmd);
    assert_eq!(code, 0, "stderr: {err}");
    let v = parse(&out);
    let paths: Vec<&str> = v["data"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(
        paths.contains(&"both.rs"),
        "shared included by --tree: {paths:?}"
    );
    assert!(
        paths.contains(&"orphan.rs"),
        "unattributed included by --tree: {paths:?}"
    );
    // Whole tree committed → clean.
    assert!(
        status_porcelain(&root).trim().is_empty(),
        "tree clean after --tree commit"
    );
}

#[test]
fn preflight_hidden_context_alias_still_resolves() {
    // Shipped Tug.app bundles carry skill text that says `tugutil context`;
    // the alias holds for one release ([P16]).
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let mut cmd = tug(ledger.path());
    cmd.args(["context", "--json", "--session", "work"]);
    cmd.args(project_arg(&root));

    let (code, stdout, _) = run(cmd);
    assert_eq!(code, 0);
    let v = parse(&stdout);
    // The alias resolves to the renamed verb — envelope speaks `preflight`.
    assert_eq!(v["command"], "preflight");
}

#[test]
fn draft_set_show_round_trip_with_selection() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);

    let mut set = tug(ledger.path());
    set.args([
        "draft",
        "set",
        "--owner",
        "session:work",
        "--message",
        "Land the feature\n\n- add feature.rs",
        "--include",
        "notes/scratch.md",
        "--exclude",
        "shared.rs",
    ]);
    set.args(project_arg(&root));
    let (code, _, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");

    let mut show = tug(ledger.path());
    show.args(["draft", "show", "--json", "--owner", "session:work"]);
    show.args(project_arg(&root));
    let (code, stdout, _) = run(show);
    assert_eq!(code, 0);
    let v = parse(&stdout);
    assert_eq!(v["command"], "draft show");
    let data = &v["data"];
    assert!(
        data["message"]
            .as_str()
            .unwrap()
            .starts_with("Land the feature"),
        "{data}"
    );
    // A CLI-authored draft is an authored draft — always edited.
    assert_eq!(data["edited"], true);
    assert_eq!(data["selection"]["include"][0], "notes/scratch.md");
    assert_eq!(data["selection"]["exclude"][0], "shared.rs");

    // Plain show prints the message directly (no glue needed).
    let mut plain = tug(ledger.path());
    plain.args(["draft", "show", "--owner", "session:work"]);
    plain.args(project_arg(&root));
    let (code, stdout, _) = run(plain);
    assert_eq!(code, 0);
    assert!(stdout.contains("Land the feature"), "{stdout}");
    assert!(stdout.contains("include: notes/scratch.md"), "{stdout}");

    // Clear deletes; a second show errors.
    let mut clear = tug(ledger.path());
    clear.args(["draft", "clear", "--owner", "session:work"]);
    clear.args(project_arg(&root));
    let (code, _, _) = run(clear);
    assert_eq!(code, 0);
    let mut gone = tug(ledger.path());
    gone.args(["draft", "show", "--owner", "session:work"]);
    gone.args(project_arg(&root));
    let (code, _, stderr) = run(gone);
    assert_eq!(code, 1);
    assert!(stderr.contains("no draft on file"), "{stderr}");
}

#[cfg(unix)]
#[test]
fn draft_set_preserves_the_users_project_spelling() {
    // [L29]: the CLI never canonicalizes — bare `realpath(3)` mints the
    // firmlink-expanded spelling Claude never writes, so the row key is
    // the user's own spelling here (isolation mode) and the tugcast
    // gateway's Claude-form resolution in production. A draft written
    // under a symlink spelling must land under that spelling — and read
    // back through it.
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("linked-repo");
    std::os::unix::fs::symlink(&root, &link).unwrap();

    let mut set = tug(ledger.path());
    set.args([
        "draft",
        "set",
        "--owner",
        "dash:widgets",
        "--message",
        "Join the widgets work",
        "--project",
    ]);
    set.arg(&link);
    let (code, _, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");

    // The stored spelling is the one the user gave, not its realpath.
    let changes = Connection::open(ledger.path().join("changes.db")).unwrap();
    let stored: String = changes
        .query_row(
            "SELECT project_dir FROM changeset_drafts WHERE owner_kind = 'dash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, link.to_string_lossy());

    // The dash owner normalizes to the branch-ref id.
    let owner_id: String = changes
        .query_row(
            "SELECT owner_id FROM changeset_drafts WHERE owner_kind = 'dash'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(owner_id, "tugdash/widgets");

    // Show through the raw symlink spelling still finds it.
    let mut show = tug(ledger.path());
    show.args(["draft", "show", "--owner", "dash:widgets", "--project"]);
    show.arg(&link);
    let (code, stdout, _) = run(show);
    assert_eq!(code, 0);
    assert!(stdout.contains("Join the widgets work"), "{stdout}");
}

/// Read one column off the single draft row on file.
fn draft_column(ledger: &Path, column: &str) -> String {
    Connection::open(ledger.join("changes.db"))
        .unwrap()
        .query_row(&format!("SELECT {column} FROM changeset_drafts"), [], |r| {
            r.get(0)
        })
        .unwrap()
}

#[test]
fn draft_set_defaults_the_owner_to_the_dash_it_runs_in() {
    // Work done on a `tugdash/<name>` branch is the dash's work; naming
    // the owner again on the command line is ceremony the branch already
    // performed.
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let worktree_dir = tempfile::tempdir().unwrap();
    let worktree = worktree_dir.path().join("tugcast-perf");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "tugdash/tugcast-perf",
            worktree.to_str().unwrap(),
        ],
    );

    let mut set = tug(ledger.path());
    set.current_dir(&worktree);
    set.args(["draft", "set", "--message", "tugcast(perf): stop the burn"]);
    let (code, stdout, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");
    assert!(stdout.contains("dash:tugcast-perf"), "{stdout}");

    assert_eq!(draft_column(ledger.path(), "owner_kind"), "dash");
    assert_eq!(
        draft_column(ledger.path(), "owner_id"),
        "tugdash/tugcast-perf"
    );
}

/// A dash with a creation id keys its draft row by the owner key, finds a
/// pre-existing name-keyed row through the fallback, and supersedes it on the
/// write — so a later dash of the same name inherits nothing ([P01], [P03],
/// Spec S02).
#[test]
fn draft_rows_key_by_the_dash_owner_key_and_supersede_the_legacy_row() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    git(
        &root,
        &[
            "config",
            "branch.tugdash/widgets.tugid",
            "1723500000000-a1b2c3",
        ],
    );
    let owner_key = "tugdash/widgets#1723500000000-a1b2c3";

    // A row an older build wrote, under the bare branch ref.
    let changes = Connection::open(ledger.path().join("changes.db")).unwrap();
    changes
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS changeset_drafts (
                owner_kind   TEXT NOT NULL,
                owner_id     TEXT NOT NULL,
                project_dir  TEXT NOT NULL,
                fingerprint  TEXT NOT NULL,
                message      TEXT NOT NULL,
                updated_at   INTEGER NOT NULL,
                edited       INTEGER NOT NULL DEFAULT 0,
                selection    TEXT,
                PRIMARY KEY (owner_kind, owner_id, project_dir)
            );",
        )
        .unwrap();
    changes
        .execute(
            "INSERT INTO changeset_drafts
                (owner_kind, owner_id, project_dir, fingerprint, message, updated_at, edited)
             VALUES ('dash', 'tugdash/widgets', ?1, 'fp', 'Legacy message', 1, 1)",
            [root.to_string_lossy().to_string()],
        )
        .unwrap();

    // `show` reaches it through the legacy-key fallback.
    let mut show = tug(ledger.path());
    show.args(["draft", "show", "--owner", "dash:widgets"]);
    show.args(project_arg(&root));
    let (code, stdout, err) = run(show);
    assert_eq!(code, 0, "stderr: {err}");
    assert!(stdout.contains("Legacy message"), "{stdout}");

    // A write lands on the owner key and supersedes the legacy row.
    let mut set = tug(ledger.path());
    set.args([
        "draft",
        "set",
        "--owner",
        "dash:widgets",
        "--message",
        "Join the widgets work",
    ]);
    set.args(project_arg(&root));
    let (code, _, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");

    assert_eq!(draft_column(ledger.path(), "owner_id"), owner_key);
    let legacy_rows: i64 = changes
        .query_row(
            "SELECT COUNT(*) FROM changeset_drafts WHERE owner_id = 'tugdash/widgets'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(legacy_rows, 0, "the legacy-keyed row is superseded");

    // And the id-keyed row reads back.
    let mut show = tug(ledger.path());
    show.args(["draft", "show", "--owner", "dash:widgets"]);
    show.args(project_arg(&root));
    let (code, stdout, _) = run(show);
    assert_eq!(code, 0);
    assert!(stdout.contains("Join the widgets work"), "{stdout}");
}

/// A repo with a real linked worktree at the conventional dash location, and
/// the dash's creation id recorded — the shape `dash create` leaves behind.
/// Returns the worktree path.
fn add_dash_worktree(root: &Path, name: &str) -> PathBuf {
    let worktree = root.join(".tug/worktrees").join(name);
    std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            &format!("tugdash/{name}"),
            worktree.to_str().unwrap(),
        ],
    );
    git(
        root,
        &[
            "config",
            &format!("branch.tugdash/{name}.tugid"),
            "1723500000000-a1b2c3",
        ],
    );
    worktree
}

/// The defect this contract closes: `dash-implement` runs `tugutil draft set`
/// from inside the dash worktree, so a cwd-derived project key put every
/// planned run's authored draft under the worktree — while the join reads with
/// the base repository root in hand. The row could never match, and the landing
/// committed a message nobody wrote.
#[test]
fn a_dash_draft_written_from_the_worktree_keys_by_the_base_root() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let worktree = add_dash_worktree(&root, "widgets");

    let mut set = tug(ledger.path());
    set.current_dir(&worktree);
    set.args([
        "draft",
        "set",
        "--owner",
        "dash:widgets",
        "--message",
        "Join the widgets work",
    ]);
    let (code, _, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");

    assert_eq!(
        draft_column(ledger.path(), "project_dir"),
        root.to_str().unwrap()
    );
    assert_eq!(
        draft_column(ledger.path(), "owner_id"),
        "tugdash/widgets#1723500000000-a1b2c3"
    );
}

/// The ordering is load-bearing: `resolve_owner`'s derivation reads the
/// checked-out branch of the directory it is handed, and only the worktree has
/// `tugdash/<name>` there. Substituting the base root *before* owner resolution
/// would read `main`, and an ownerless `draft set` from inside a worktree —
/// precisely what `dash-implement` runs — would land on the session instead.
#[test]
fn an_ownerless_set_from_the_worktree_still_resolves_the_dash() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let worktree = add_dash_worktree(&root, "widgets");

    let mut set = tug(ledger.path());
    set.current_dir(&worktree);
    set.env("TUG_SESSION_ID", "work");
    set.args(["draft", "set", "--message", "tugdash(widgets): the round"]);
    let (code, stdout, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");
    assert!(stdout.contains("dash:widgets"), "{stdout}");

    assert_eq!(draft_column(ledger.path(), "owner_kind"), "dash");
    assert_eq!(
        draft_column(ledger.path(), "project_dir"),
        root.to_str().unwrap()
    );
}

/// One authored write retires the dash's pre-fix rows, so the reader's legacy
/// probe decays to nothing instead of accreting another permanent axis.
#[test]
fn a_dash_set_supersedes_the_worktree_keyed_row() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let worktree = add_dash_worktree(&root, "widgets");
    let owner_key = "tugdash/widgets#1723500000000-a1b2c3";

    let changes = Connection::open(ledger.path().join("changes.db")).unwrap();
    changes
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS changeset_drafts (
                owner_kind   TEXT NOT NULL,
                owner_id     TEXT NOT NULL,
                project_dir  TEXT NOT NULL,
                fingerprint  TEXT NOT NULL,
                message      TEXT NOT NULL,
                updated_at   INTEGER NOT NULL,
                edited       INTEGER NOT NULL DEFAULT 0,
                selection    TEXT,
                PRIMARY KEY (owner_kind, owner_id, project_dir)
            );",
        )
        .unwrap();
    changes
        .execute(
            "INSERT INTO changeset_drafts
                (owner_kind, owner_id, project_dir, fingerprint, message, updated_at, edited)
             VALUES ('dash', ?1, ?2, 'fp', 'The invisible draft', 1, 1)",
            rusqlite::params![owner_key, worktree.to_string_lossy()],
        )
        .unwrap();

    let mut set = tug(ledger.path());
    set.current_dir(&worktree);
    set.args([
        "draft",
        "set",
        "--owner",
        "dash:widgets",
        "--message",
        "Join the widgets work",
    ]);
    let (code, _, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");

    let rows: i64 = changes
        .query_row("SELECT COUNT(*) FROM changeset_drafts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "the worktree-keyed row is superseded, not doubled");
    assert_eq!(
        draft_column(ledger.path(), "project_dir"),
        root.to_str().unwrap()
    );
}

#[test]
fn a_dash_draft_reads_back_from_either_side_of_the_worktree_boundary() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let worktree = add_dash_worktree(&root, "widgets");

    let mut set = tug(ledger.path());
    set.current_dir(&worktree);
    set.args([
        "draft",
        "set",
        "--owner",
        "dash:widgets",
        "--message",
        "Join the widgets work",
    ]);
    assert_eq!(run(set).0, 0);

    for dir in [root.as_path(), worktree.as_path()] {
        let mut show = tug(ledger.path());
        show.current_dir(dir);
        show.args(["draft", "show", "--owner", "dash:widgets"]);
        let (code, stdout, err) = run(show);
        assert_eq!(code, 0, "from {dir:?}: {err}");
        assert!(stdout.contains("Join the widgets work"), "{stdout}");
    }
}

/// The substitution is scoped to dash owners. A session's draft describes the
/// working tree it was typed in, so it stays keyed by that directory even when
/// the directory happens to be a linked worktree.
#[test]
fn a_session_draft_from_a_worktree_stays_keyed_by_the_worktree() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);
    let worktree = add_dash_worktree(&root, "widgets");

    let mut set = tug(ledger.path());
    set.current_dir(&worktree);
    set.args([
        "draft",
        "set",
        "--owner",
        "session:work",
        "--message",
        "Land the feature",
    ]);
    let (code, _, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");

    assert_eq!(draft_column(ledger.path(), "owner_kind"), "session");
    assert_eq!(
        draft_column(ledger.path(), "project_dir"),
        worktree.to_str().unwrap()
    );
}

#[test]
fn draft_set_falls_back_to_the_session_then_refuses() {
    let (_repo, root) = init_repo();
    let ledger = seed_ledger(&root);

    // Off a dash branch, the calling session owns the draft.
    let mut set = tug(ledger.path());
    set.current_dir(&root);
    set.env("TUG_SESSION_ID", "work");
    set.args(["draft", "set", "--message", "Land the feature"]);
    let (code, _, err) = run(set);
    assert_eq!(code, 0, "stderr: {err}");
    assert_eq!(draft_column(ledger.path(), "owner_kind"), "session");
    assert_eq!(draft_column(ledger.path(), "owner_id"), "work");

    // With neither, the refusal names every way to say who owns this.
    let mut orphan = tug(ledger.path());
    orphan.current_dir(&root);
    orphan.args(["draft", "set", "--message", "Whose is this?"]);
    let (code, _, stderr) = run(orphan);
    assert_eq!(code, 1);
    assert!(stderr.contains("--owner"), "{stderr}");
    assert!(stderr.contains("dash worktree"), "{stderr}");
    assert!(stderr.contains("TUG_SESSION_ID"), "{stderr}");
}

// --- dash replay -----------------------------------------------------------

/// `dash replay` writes a dash-log line, so every test here redirects
/// `project_state_dir` into a tempdir rather than the developer's real one.
fn tug_dash(db_dir: &Path, state: &Path, repo: &Path) -> Command {
    let mut cmd = tug(db_dir);
    cmd.env("TUG_DATA_DIR", state);
    cmd.current_dir(repo);
    cmd
}

/// A dash on `main` with one round of its own, ready to be replayed.
fn dash_with_a_round(root: &Path, name: &str) -> PathBuf {
    let worktree = add_dash_worktree(root, name);
    git(
        root,
        &["config", &format!("branch.tugdash/{name}.tugbase"), "main"],
    );
    std::fs::write(worktree.join("dash.rs"), "dash\n").unwrap();
    git(&worktree, &["add", "-A"]);
    git(&worktree, &["commit", "-q", "-m", "the dash's own round"]);
    worktree
}

fn advance_main(root: &Path, content: &str) {
    std::fs::write(root.join("base.rs"), content).unwrap();
    git(root, &["add", "base.rs"]);
    git(root, &["commit", "-q", "-m", "the base moves"]);
}

#[test]
fn dash_replay_moves_a_behind_dash_onto_the_new_base_tip() {
    let (_dir, root) = init_repo();
    let db = seed_ledger(&root);
    let state = tempfile::tempdir().unwrap();
    let worktree = dash_with_a_round(&root, "demo");
    advance_main(&root, "moved\n");

    let mut cmd = tug_dash(db.path(), state.path(), &root);
    cmd.args(["dash", "replay", "demo", "--json"]);
    let (code, stdout, stderr) = run(cmd);
    assert_eq!(code, 0, "stderr: {stderr}");
    let v = parse(&stdout);
    assert_eq!(v["data"]["outcome"], "replayed");
    assert_eq!(
        v["data"]["mapping"].as_array().unwrap().len(),
        1,
        "one pair per round"
    );

    // The dash now carries the base's commit under its own round, and the
    // worktree came along.
    let out = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["merge-base", "--is-ancestor", "main", "HEAD"])
        .status()
        .unwrap();
    assert!(out.success(), "the dash descends from the moved base");
    assert_eq!(
        std::fs::read_to_string(worktree.join("base.rs")).unwrap(),
        "moved\n"
    );
}

#[test]
fn dash_replay_records_a_rebase_the_agent_already_made() {
    let (_dir, root) = init_repo();
    let db = seed_ledger(&root);
    let state = tempfile::tempdir().unwrap();
    let worktree = dash_with_a_round(&root, "demo");

    // A plan whose ledger cell names the pre-rebase round.
    let round = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["rev-parse", "--short=9", "HEAD"])
        .output()
        .unwrap();
    let round = String::from_utf8_lossy(&round.stdout).trim().to_string();
    std::fs::create_dir_all(worktree.join("dash")).unwrap();
    std::fs::write(
        worktree.join("dash/p.md"),
        format!(
            "## Fixture {{#fixture}}\n\n### Execution Steps {{#execution-steps}}\n\n\
             #### Step Status Ledger {{#step-status-ledger}}\n\n\
             | Step | Title | Status | Commit |\n|---|---|---|---|\n\
             | #step-1 | The round | done | `{round}` |\n"
        ),
    )
    .unwrap();
    git(&worktree, &["add", "-A"]);
    git(&worktree, &["commit", "-q", "-m", "record the plan"]);
    git(
        &root,
        &["config", "branch.tugdash/demo.tugplan", "dash/p.md"],
    );

    advance_main(&root, "moved\n");
    git(&worktree, &["rebase", "-q", "main"]);

    let mut cmd = tug_dash(db.path(), state.path(), &root);
    cmd.args(["dash", "replay", "demo", "--json"]);
    let (code, stdout, stderr) = run(cmd);
    assert_eq!(code, 0, "stderr: {stderr}");
    let v = parse(&stdout);
    assert_eq!(v["data"]["outcome"], "recorded");
    assert_eq!(v["data"]["remapped"][0], "step-1");

    let plan = std::fs::read_to_string(worktree.join("dash/p.md")).unwrap();
    assert!(
        !plan.contains(&round),
        "the cell no longer names the pre-rebase round: {plan}"
    );
}

#[test]
fn dash_replay_reports_a_conflict_and_exits_one_without_moving_anything() {
    let (_dir, root) = init_repo();
    let db = seed_ledger(&root);
    let state = tempfile::tempdir().unwrap();
    let worktree = add_dash_worktree(&root, "demo");
    git(&root, &["config", "branch.tugdash/demo.tugbase", "main"]);
    // Both sides rewrite base.rs.
    std::fs::write(worktree.join("base.rs"), "dash\n").unwrap();
    git(&worktree, &["add", "-A"]);
    git(&worktree, &["commit", "-q", "-m", "the dash rewrites base"]);
    let before = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    let before = String::from_utf8_lossy(&before.stdout).trim().to_string();
    advance_main(&root, "base-moved\n");

    let mut cmd = tug_dash(db.path(), state.path(), &root);
    cmd.args(["dash", "replay", "demo", "--json"]);
    let (code, stdout, stderr) = run(cmd);
    assert_eq!(code, 1, "a conflict is not success; stderr: {stderr}");
    let v = parse(&stdout);
    assert_eq!(v["data"]["outcome"], "conflicted");
    assert_eq!(v["data"]["round_subject"], "the dash rewrites base");
    assert_eq!(v["data"]["paths"][0], "base.rs");

    let after = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&after.stdout).trim(),
        before,
        "nothing moved"
    );
}

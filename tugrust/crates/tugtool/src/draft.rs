//! The `draft` namespace — `tugtool draft set|show|clear` (Spec S02).
//!
//! Writes go through the running tugcast's `POST /api/draft` (port via the
//! [D09] CLI discovery order), so a short-lived CLI process never opens the
//! machine-global changes ledger read-write — one writer surface, one
//! journal, one pragma set. With `TUG_CHANGES_DB` set (test-harness
//! isolation), writes fall back to the direct local path against that
//! private file. Reads (`show`) open the ledger read-only. A skill-authored
//! draft is an authored draft: every `set` writes `edited=1`, so the draft
//! engine never clobbers it. `--project` travels as the user's own
//! spelling and the **server** canonicalizes it to the persisted row key
//! ([L29] — the CLI never canonicalizes); reads union the as-spelled and
//! legacy-realpath spellings (Spec S05).

use std::path::PathBuf;

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::changes::AppError;
use crate::output::print_ok;

/// One draft row as the CLI reads/writes it — mirrors
/// `changes.changeset_drafts`.
#[derive(Debug, Clone, Serialize)]
pub struct DraftRow {
    pub owner_kind: String,
    pub owner_id: String,
    pub project_dir: String,
    pub fingerprint: String,
    pub message: String,
    pub updated_at: i64,
    pub edited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<serde_json::Value>,
}

/// An owner as the ledger keys it, plus the spelling to echo back.
struct Owner {
    kind: String,
    id: String,
    /// The dash's name when `kind` is `dash` — carried rather than re-parsed
    /// out of `id`, because it is what [`tugdash_core::ops::dash_draft_key`]
    /// takes and the key must come from that resolver ([P07]).
    dash_name: Option<String>,
    /// The pre-id key the same owner's rows were written under before dashes
    /// had creation ids — `Some` only for a dash that has one ([P01], [P03]).
    /// It rides every write so the server reads it as a fallback and
    /// supersedes it, the same way `raw_project_dir` carries the spelling
    /// axis.
    legacy_id: Option<String>,
    /// The other keys this owner's rows may sit under — for a **session**
    /// owner, the earlier segments of its line ([P01]). A draft authored
    /// before a rotation is keyed on the id the card wore then; `id` is the
    /// live segment, and these are what keep the earlier row readable and
    /// sweepable rather than orphaned. Empty for every other owner kind.
    line_ids: Vec<String>,
    /// `--owner`'s own grammar, so messages read the way the user typed
    /// it (or would have typed it, when it was derived).
    display: String,
}

impl Owner {
    /// Every key this owner's rows may sit under, most-current first — the
    /// probe order of Spec S02's owner-key axis.
    fn keys(&self) -> Vec<&str> {
        let mut keys = vec![self.id.as_str()];
        if let Some(legacy) = self.legacy_id.as_deref() {
            keys.push(legacy);
        }
        for id in &self.line_ids {
            if !keys.contains(&id.as_str()) {
                keys.push(id.as_str());
            }
        }
        keys
    }
}

/// The owner key for a dash, read from the project's git config ([P01]).
/// A read path, so it never mints ([P02]): a dash with no `tugid` — one an
/// older build created — resolves to its legacy branch-ref key with no
/// legacy sibling to chase.
fn dash_owner(name: &str, project_dir: &str) -> (String, Option<String>) {
    let key = tugdash_core::ops::dash_owner_key(std::path::Path::new(project_dir), name);
    let legacy = format!("tugdash/{name}");
    let legacy = (key != legacy).then_some(legacy);
    (key, legacy)
}

/// Resolve the owner of a draft: `--owner` when given, else derived.
///
/// The derivation reads the project's checked-out branch: work done in a
/// dash worktree is the dash's, and a `tugdash/<name>` branch says so
/// without anyone having to repeat it on the command line. Off a dash
/// branch the owner is the calling session. Both halves are the same
/// defaults the rest of the CLI already applies — `changes` has defaulted
/// `--session` to `$TUG_SESSION_ID` all along.
fn resolve_owner(owner: Option<String>, project_dir: &str) -> Result<Owner, AppError> {
    if let Some(owner) = owner.filter(|o| !o.is_empty()) {
        return parse_owner(&owner, project_dir);
    }
    if let Some(name) = dash_branch_name(project_dir) {
        let (id, legacy_id) = dash_owner(&name, project_dir);
        return Ok(Owner {
            kind: "dash".to_string(),
            id,
            dash_name: Some(name.clone()),
            legacy_id,
            line_ids: Vec::new(),
            display: format!("dash:{name}"),
        });
    }
    // A session owner is a **line** of work, not the segment this process was
    // spawned under ([P01]). The draft is keyed on the line's live segment —
    // which is what tugcast attaches drafts by, exactly and live-only — and
    // the line's earlier segments ride along so a draft authored before a
    // rotation is still read, superseded, and swept rather than orphaned on a
    // corpse. `resolve_soft`: with no instance to ask (a fixture, an isolated
    // `TUG_CHANGES_DB` run) the posted id is the whole answer, as before.
    let resolved = crate::session_identity::resolve_soft(None).ok_or_else(|| {
        AppError::Exit1(
            "no owner — pass --owner, run inside a dash worktree, or set TUG_SESSION_ID"
                .to_string(),
        )
    })?;
    let mut line_ids = resolved.keys();
    let session = line_ids.remove(0);
    Ok(Owner {
        kind: "session".to_string(),
        id: session.clone(),
        dash_name: None,
        legacy_id: None,
        line_ids,
        display: format!("session:{session}"),
    })
}

/// The dash name when `project_dir` has a `tugdash/<name>` branch checked
/// out, else `None` (a detached HEAD, a non-repo, or any ordinary branch).
fn dash_branch_name(project_dir: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(project_dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8(out.stdout).ok()?;
    let name = branch.trim().strip_prefix("tugdash/")?.to_string();
    (!name.is_empty()).then_some(name)
}

/// Parse `--owner`: `session:<id>`, `dash:<name>`, or `unattributed`. A dash
/// owner normalizes to the owner key the ledger stores
/// (`tugdash/<name>#<tugid>`, or the bare branch ref for an id-less dash),
/// accepting either the bare name or the full ref, and reports the legacy key
/// alongside it ([P01], [P03]).
fn parse_owner(owner: &str, project_dir: &str) -> Result<Owner, AppError> {
    let build = |kind: &str, id: String, dash_name: Option<String>, legacy_id: Option<String>| {
        Ok(Owner {
            kind: kind.to_string(),
            id,
            dash_name,
            legacy_id,
            line_ids: Vec::new(),
            display: owner.to_string(),
        })
    };
    if owner == "unattributed" {
        return build("unattributed", String::new(), None, None);
    }
    // `--owner session` with no id: **the calling session, resolved** — the
    // spelling a skill should write. Naming the id explicitly asks the
    // skill's author to interpolate `$TUG_SESSION_ID`, which is frozen at
    // spawn and names a dead segment after any rotation ([P01]); the bare
    // form says the same thing and cannot go stale.
    if owner == "session" {
        let resolved = crate::session_identity::resolve_soft(None).ok_or_else(|| {
            AppError::Exit1(
                "--owner session names the calling session, so run this from a Session card, \
                 spell the id as session:<id>, or set TUG_SESSION_ID"
                    .to_string(),
            )
        })?;
        let mut keys = resolved.keys();
        let live = keys.remove(0);
        let mut owner = build("session", live, None, None)?;
        owner.line_ids = keys;
        return Ok(owner);
    }
    if let Some(id) = owner.strip_prefix("session:") {
        if id.is_empty() {
            return Err(AppError::Exit1("empty session id in --owner".to_string()));
        }
        // A hand-typed session id goes stale exactly the way an inherited one
        // does, so it is resolved on the same terms.
        let resolved = crate::session_identity::resolve_soft(Some(id));
        let mut keys = resolved
            .map(|r| r.keys())
            .unwrap_or_else(|| vec![id.to_string()]);
        let live = keys.remove(0);
        let mut owner = build("session", live, None, None)?;
        owner.line_ids = keys;
        return Ok(owner);
    }
    if let Some(name) = owner.strip_prefix("dash:") {
        let name = name.strip_prefix("tugdash/").unwrap_or(name);
        if name.is_empty() {
            return Err(AppError::Exit1("empty dash name in --owner".to_string()));
        }
        let (id, legacy) = dash_owner(name, project_dir);
        return build("dash", id, Some(name.to_string()), legacy);
    }
    Err(AppError::Exit1(format!(
        "invalid --owner '{owner}': expected session, session:<id>, dash:<name>, or unattributed"
    )))
}

/// Resolve `--project` (default cwd) to `(project, legacy)` spellings.
///
/// `project` is the path as the user spelled it, absolutized — the CLI
/// never canonicalizes ([L29]): the canonicalization gateway is the
/// tugcast server, which resolves this spelling to Claude form and keys
/// the row on the result. `legacy` is the `realpath(3)` spelling older
/// CLI builds used as their row key; it rides along solely so the server
/// supersedes/sweeps rows written under it.
fn resolve_project(project: Option<PathBuf>) -> Result<Project, AppError> {
    let cwd =
        std::env::current_dir().map_err(|e| AppError::Exit1(format!("cannot resolve cwd: {e}")))?;
    let raw = match project {
        Some(p) if p.is_absolute() => p,
        Some(p) => cwd.join(p),
        None => cwd,
    };
    Ok(Project::at(&raw))
}

/// The directory a draft row is keyed by, in every spelling this write knows
/// about.
///
/// `primary` and `fallback` are two spellings of **one** directory (Spec S05).
/// `superseded` is a different matter: directories this write is migrating
/// *off*, whose rows it retires. A dash draft written from inside the worktree
/// keys on the base root and supersedes the worktree — see [`dash_project`].
struct Project {
    primary: String,
    fallback: String,
    superseded: Vec<String>,
}

impl Project {
    /// Both spellings of one directory: as spelled, and the `realpath(3)` form
    /// older CLI builds keyed by. The CLI still never canonicalizes its answer
    /// ([L29]) — `fallback` rides along solely so the server sweeps rows
    /// written under it.
    fn at(dir: &std::path::Path) -> Self {
        let fallback = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        Project {
            primary: dir.to_string_lossy().into_owned(),
            fallback: fallback.to_string_lossy().into_owned(),
            superseded: Vec::new(),
        }
    }

    /// Every spelling a row of this project may sit under, most-current first
    /// and deduplicated — the probe order of the project axis.
    fn spellings(&self) -> Vec<&str> {
        let mut out = vec![self.primary.as_str()];
        for s in std::iter::once(&self.fallback).chain(self.superseded.iter()) {
            if !out.contains(&s.as_str()) {
                out.push(s.as_str());
            }
        }
        out
    }
}

/// The base repository root, when `project_dir` is a **linked worktree**.
///
/// This is the same resolution every dash verb runs — `find_repo_root_from`,
/// which reads the shared `.git` directory from inside a linked worktree and
/// honors an explicit `TUG_REPO_UNIVERSE` boundary when one is set. Going
/// through the primitive rather than shelling `rev-parse` is what keeps a
/// draft's key in the same universe the server composes entries in; a
/// hand-rolled hop keys the draft on the base checkout while a scoped server
/// looks for it under the worktree, and the entry silently carries no draft.
///
/// `None` for the ordinary case (there is nothing to substitute — the project
/// dir already *is* the root) and for anything that is not a git repository.
///
/// The answer keeps its resolved spelling rather than being canonicalized
/// here: the CLI is not the canonicalization gateway ([L29]), so it names a
/// directory and lets the server resolve how that directory is spelled.
fn dash_base_root(project_dir: &str) -> Option<PathBuf> {
    let start = std::path::Path::new(project_dir);
    let root = tugtool_core::find_repo_root_from(start).ok()?;
    let canon = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    (canon(&root) != canon(start)).then_some(root)
}

/// Re-key a dash's draft onto its base repository root, superseding the
/// directory the command actually ran in ([P01], [P07]).
///
/// A dash draft describes a landing **on the base**, and the join reads it with
/// the base root in hand. `dash-implement` runs `tugtool draft set` from inside
/// the worktree, so keying by cwd put every planned run's authored draft
/// somewhere the join could never look. This is where that ends: the key comes
/// from `tugdash_core::ops::dash_draft_key` verbatim — owner *and* project —
/// and the worktree spellings ride along as superseded so one authored write
/// retires the old rows.
///
/// A no-op for every other owner, and for a dash draft written from the base
/// checkout (where there is no worktree to migrate off).
fn apply_dash_project_key(owner: &mut Owner, project: Project) -> Project {
    let Some(name) = owner.dash_name.as_deref() else {
        return project;
    };
    let Some(base) = dash_base_root(&project.primary) else {
        return project;
    };
    let key = tugdash_core::ops::dash_draft_key(&base, name);
    owner.id = key.owner_id;
    owner.legacy_id = key.legacy_owner_id;
    let mut rekeyed = Project::at(&key.project);
    rekeyed.superseded = [project.primary, project.fallback]
        .into_iter()
        .filter(|s| *s != rekeyed.primary && *s != rekeyed.fallback)
        .collect();
    rekeyed.superseded.dedup();
    rekeyed
}

/// The test-isolation escape: when `TUG_CHANGES_DB` points at a private
/// file, writes stay local instead of routing through tugcast. Production
/// never sets it, so production CLI writes always go through the server.
fn isolated_changes_db() -> bool {
    std::env::var_os(tugcore::instance::ENV_CHANGES_DB).is_some_and(|v| !v.is_empty())
}

/// Read-only open of the changes ledger for `show` and pre-write reads.
/// `None` when the file doesn't exist yet (no drafts on file).
fn open_changes_db_readonly() -> Option<Connection> {
    let path = tugcore::instance::changes_db_path();
    Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// POST one request to the running tugcast's `/api/draft`, discovering the
/// port per [D09]. Errors are actionable: no reachable tugcast means the
/// draft was NOT written.
///
/// Discovery resolves with [`resolve_port_any`], so several live instances
/// are not an error here. The instance is a conduit, not a destination:
/// `/api/draft` writes the **machine-global** `changes.db` and nothing
/// else, and that write is funnelled to the single ledger writer ([LR8])
/// whichever tugcast receives it — so every live instance produces the
/// same row. Refusing to choose would be refusing a decision that does not
/// exist. `--instance`/`--port` remain as an override.
fn post_draft_api(
    body: serde_json::Value,
    port: Option<u16>,
    instance: Option<String>,
) -> Result<serde_json::Value, AppError> {
    use crate::commands::tell::{Remedy, resolve_port_any};
    let port = resolve_port_any(port, instance).map_err(|e| {
        AppError::Exit1(format!(
            "draft writes go through a running Tug instance, but none was found ({})",
            e.describe(Remedy::Flags)
        ))
    })?;
    let url = format!("http://127.0.0.1:{port}/api/draft");
    let response = ureq::post(&url)
        .send_json(body)
        .map_err(|e| AppError::Exit1(format!("cannot reach tugcast at {url}: {e}")))?;
    let value: serde_json::Value = response
        .into_body()
        .read_json()
        .map_err(|e| AppError::Exit1(format!("bad response from tugcast: {e}")))?;
    if value.get("status").and_then(|s| s.as_str()) != Some("ok") {
        let message = value
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(AppError::Exit1(format!("draft request failed: {message}")));
    }
    Ok(value)
}

/// Decode the server's draft row into the CLI's output shape.
fn draft_row_from_api(row: &serde_json::Value) -> Result<DraftRow, AppError> {
    let s = |key: &str| {
        row.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .ok_or_else(|| AppError::Exit1(format!("malformed draft row: missing {key}")))
    };
    Ok(DraftRow {
        owner_kind: s("owner_kind")?,
        owner_id: s("owner_id")?,
        project_dir: s("project_dir")?,
        fingerprint: s("fingerprint")?,
        message: s("message")?,
        updated_at: row.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0),
        edited: row.get("edited").and_then(|v| v.as_bool()).unwrap_or(true),
        selection: row
            .get("selection")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()),
    })
}

/// Open the machine-global changes ledger as a WAL co-writer, creating the
/// `changeset_drafts` table when this CLI is the first writer. Reached only
/// under `TUG_CHANGES_DB` isolation (see [`isolated_changes_db`]).
fn open_changes_db() -> Result<Connection, AppError> {
    let path = tugcore::instance::changes_db_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = tugcore::ledger_db::open(&path)
        .map_err(|e| AppError::Exit1(format!("cannot open changes ledger: {e}")))?;
    conn.execute_batch(
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
    .map_err(|e| AppError::Exit1(format!("cannot bootstrap changes ledger: {e}")))?;
    Ok(conn)
}

/// Read one draft row across both migration axes, first hit wins: the owner
/// key before its legacy form ([P03]), and within each, the project's
/// spellings in `Project::spellings` order (Spec S05, plus any superseded
/// directory this write is migrating off).
fn read_row(conn: &Connection, owner: &Owner, project: &Project) -> Option<DraftRow> {
    owner.keys().into_iter().find_map(|id| {
        project
            .spellings()
            .into_iter()
            .find_map(|dir| read_row_for_key(conn, &owner.kind, id, dir))
    })
}

/// Read one draft row under one owner key and one project spelling.
fn read_row_for_key(
    conn: &Connection,
    owner_kind: &str,
    owner_id: &str,
    project: &str,
) -> Option<DraftRow> {
    let read = |project: &str| -> Option<DraftRow> {
        conn.query_row(
            "SELECT owner_kind, owner_id, project_dir, fingerprint, message, updated_at,
                    edited, selection
             FROM changeset_drafts
             WHERE owner_kind = ?1 AND owner_id = ?2 AND project_dir = ?3",
            params![owner_kind, owner_id, project],
            |row| {
                Ok(DraftRow {
                    owner_kind: row.get(0)?,
                    owner_id: row.get(1)?,
                    project_dir: row.get(2)?,
                    fingerprint: row.get(3)?,
                    message: row.get(4)?,
                    updated_at: row.get(5)?,
                    edited: row.get::<_, i64>(6)? != 0,
                    selection: row
                        .get::<_, Option<String>>(7)?
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
                })
            },
        )
        .ok()
    };
    read(project)
}

/// Every `(kind, id, project_dir)` triple that is a stale sibling of the row
/// keyed `(owner.id, project.primary)` — the same row under the legacy owner
/// key, a legacy project spelling, a superseded directory, or any combination.
/// A `set` deletes these; a `clear` sweeps them.
fn sibling_rows<'a>(owner: &'a Owner, project: &'a Project) -> Vec<(&'a str, &'a str, &'a str)> {
    let spellings = project.spellings();
    owner
        .keys()
        .into_iter()
        .flat_map(|id| {
            spellings
                .iter()
                .map(move |p| (owner.kind.as_str(), id, *p))
                .collect::<Vec<_>>()
        })
        .filter(|(_, id, dir)| !(*id == owner.id && *dir == project.primary))
        .collect()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
pub fn run_set(
    owner: Option<String>,
    project: Option<PathBuf>,
    message: Option<String>,
    include: Vec<String>,
    exclude: Vec<String>,
    port: Option<u16>,
    instance: Option<String>,
    json: bool,
) -> Result<(), AppError> {
    let project = resolve_project(project)?;
    // Resolve the owner against the directory the command ran in, *then*
    // substitute the project — never the other way round. `resolve_owner`'s
    // derivation reads the checked-out branch of what it is handed, and only a
    // dash worktree has a `tugdash/<name>` there; substituting the base root
    // first would read `main` and send an ownerless `draft set` from inside a
    // worktree to the session owner instead.
    let mut owner_resolved = resolve_owner(owner, &project.primary)?;
    let project = apply_dash_project_key(&mut owner_resolved, project);
    let Owner {
        kind: owner_kind,
        id: owner_id,
        legacy_id,
        line_ids,
        display: owner,
        ..
    } = &owner_resolved;
    let project_dir = &project.primary;

    if !isolated_changes_db() {
        let selection = (!include.is_empty() || !exclude.is_empty())
            .then(|| serde_json::json!({"include": include, "exclude": exclude}).to_string());
        let mut body = serde_json::json!({
            "op": "set",
            "owner_kind": owner_kind,
            "owner_id": owner_id,
            "legacy_owner_id": legacy_id,
            "legacy_owner_ids": line_ids,
            "project_dir": project_dir,
            "raw_project_dir": project.fallback,
            "superseded_project_dirs": project.superseded,
        });
        if let Some(m) = &message {
            body["message"] = serde_json::json!(m);
        }
        if let Some(sel) = &selection {
            body["selection"] = serde_json::json!(sel);
        }
        let response = post_draft_api(body, port, instance)?;
        let row = response
            .get("row")
            .ok_or_else(|| AppError::Exit1("malformed response: missing row".to_string()))
            .and_then(draft_row_from_api)?;
        if json {
            print_ok("draft set", &row);
        } else {
            println!("draft set for {owner} ({})", row.project_dir);
        }
        return Ok(());
    }

    let conn = open_changes_db()?;

    let existing = read_row(&conn, &owner_resolved, &project);
    let selection = if include.is_empty() && exclude.is_empty() {
        existing
            .as_ref()
            .and_then(|e| e.selection.as_ref())
            .map(|v| v.to_string())
    } else {
        Some(serde_json::json!({"include": include, "exclude": exclude}).to_string())
    };
    let message = match message {
        Some(m) => m,
        None => existing
            .as_ref()
            .map(|e| e.message.clone())
            .unwrap_or_default(),
    };
    if message.trim().is_empty() {
        return Err(AppError::Exit1(
            "nothing to set: no --message given and no draft on file".to_string(),
        ));
    }
    let fingerprint = existing
        .as_ref()
        .map(|e| e.fingerprint.clone())
        .unwrap_or_default();
    conn.execute(
        "INSERT OR REPLACE INTO changeset_drafts (
            owner_kind, owner_id, project_dir, fingerprint, message, updated_at,
            edited, selection
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
        params![
            owner_kind,
            owner_id,
            project_dir,
            fingerprint,
            message,
            now_millis(),
            selection,
        ],
    )
    .map_err(|e| AppError::Exit1(format!("cannot write draft: {e}")))?;
    // Every sibling of the row just written is now stale and superseded by
    // it: the legacy *spelling* of the project dir, and — for a dash — every
    // row under the legacy *owner key* ([P03]).
    for (kind, id, dir) in sibling_rows(&owner_resolved, &project) {
        let _ = conn.execute(
            "DELETE FROM changeset_drafts
             WHERE owner_kind = ?1 AND owner_id = ?2 AND project_dir = ?3",
            params![kind, id, dir],
        );
    }

    let row = read_row(&conn, &owner_resolved, &project).expect("row just written");
    if json {
        print_ok("draft set", &row);
    } else {
        println!("draft set for {owner} ({})", row.project_dir);
    }
    Ok(())
}

pub fn run_show(
    owner: Option<String>,
    project: Option<PathBuf>,
    json: bool,
) -> Result<(), AppError> {
    let project = resolve_project(project)?;
    let mut owner_resolved = resolve_owner(owner, &project.primary)?;
    let project = apply_dash_project_key(&mut owner_resolved, project);
    let owner = owner_resolved.display.clone();
    // Reads never need a writable ledger open; a missing file just means
    // no drafts exist yet.
    let Some(row) =
        open_changes_db_readonly().and_then(|conn| read_row(&conn, &owner_resolved, &project))
    else {
        return Err(AppError::Exit1(format!("no draft on file for {owner}")));
    };
    if json {
        print_ok("draft show", &row);
    } else {
        println!("{}", row.message);
        if let Some(selection) = &row.selection {
            let paths = |key: &str| -> Vec<String> {
                selection
                    .get(key)
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|p| p.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let include = paths("include");
            let exclude = paths("exclude");
            if !include.is_empty() {
                println!("include: {}", include.join(", "));
            }
            if !exclude.is_empty() {
                println!("exclude: {}", exclude.join(", "));
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct ClearData {
    owner: String,
    deleted: bool,
}

fn print_clear(owner: String, deleted: bool, json: bool) {
    if json {
        print_ok("draft clear", ClearData { owner, deleted });
    } else if deleted {
        println!("draft cleared for {owner}");
    } else {
        println!("no draft on file for {owner}");
    }
}

pub fn run_clear(
    owner: Option<String>,
    project: Option<PathBuf>,
    port: Option<u16>,
    instance: Option<String>,
    json: bool,
) -> Result<(), AppError> {
    let project = resolve_project(project)?;
    let mut owner_resolved = resolve_owner(owner, &project.primary)?;
    let project = apply_dash_project_key(&mut owner_resolved, project);
    let Owner {
        kind: owner_kind,
        id: owner_id,
        legacy_id,
        line_ids,
        display: owner,
        ..
    } = &owner_resolved;
    let project_dir = &project.primary;

    if !isolated_changes_db() {
        let response = post_draft_api(
            serde_json::json!({
                "op": "clear",
                "owner_kind": owner_kind,
                "owner_id": owner_id,
                "legacy_owner_id": legacy_id,
                "legacy_owner_ids": line_ids,
                "project_dir": project_dir,
                "raw_project_dir": project.fallback,
                "superseded_project_dirs": project.superseded,
            }),
            port,
            instance,
        )?;
        let deleted = response
            .get("deleted")
            .and_then(|d| d.as_bool())
            .unwrap_or(false);
        print_clear(owner.clone(), deleted, json);
        return Ok(());
    }

    let conn = open_changes_db()?;
    let mut deleted = conn
        .execute(
            "DELETE FROM changeset_drafts
             WHERE owner_kind = ?1 AND owner_id = ?2 AND project_dir = ?3",
            params![owner_kind, owner_id, project_dir],
        )
        .map_err(|e| AppError::Exit1(format!("cannot clear draft: {e}")))?;
    for (kind, id, dir) in sibling_rows(&owner_resolved, &project) {
        deleted += conn
            .execute(
                "DELETE FROM changeset_drafts
                 WHERE owner_kind = ?1 AND owner_id = ?2 AND project_dir = ?3",
                params![kind, id, dir],
            )
            .unwrap_or(0);
    }
    print_clear(owner.clone(), deleted > 0, json);
    Ok(())
}

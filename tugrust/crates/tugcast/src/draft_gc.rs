//! Startup sweep of the composer's `draft-attachments/` folder.
//!
//! Files land there when an image is dropped on the Session card's prompt
//! entry ([`crate::attachments`]) and are referenced by a UUID-named path held
//! in durable card state or in prompt history. Nothing ever removes one: a
//! draft the user cleared, a chip they deleted, a prompt they sent and forgot
//! all leave their bytes behind. This is the sweep that reclaims them.
//!
//! ## The root-set contract
//!
//! Three producers write references to these files:
//!
//!   - `dev.tugtool.deck.cardstate` — the prompt entry's `attachmentBytes`
//!     entries, each carrying the stored path.
//!   - `prompt_history.db` — the same path on a submitted prompt's image atoms
//!     ([`crate::prompt_ledger`]). An unreadable ledger skips the sweep, on the
//!     same grounds an unreadable root domain does.
//!   - `dev.tugtool.prompt.history` — where the prompt-history references used
//!     to live. Read for as long as an instance somewhere may not yet have run
//!     the import that empties it.
//!
//! The sweep unions them and treats anything unmentioned as garbage. **A future
//! feature that stores one of these references anywhere else must add itself
//! to the root set**, or this sweep will delete bytes it still needs.
//!
//! The prompt ledger is machine-global while `draft-attachments/` is
//! per-instance, so the union holds UUIDs naming files in other instances'
//! directories. That is harmless in the only direction that matters: a UUID
//! with no local file never matches a local filename, and a local file some
//! other instance's history references is retained. No instance sweeps
//! another's directory, so none can delete another's bytes.
//!
//! One asymmetry worth knowing while reading this: the Overview composer
//! uploads into `draft-attachments/` but records its durable references under
//! `overview-attachments/`, so its uploads are reclaimed here once the grace
//! period expires. That is the intended outcome — the bytes it keeps have been
//! copied elsewhere — but it does mean this directory has two writers and only
//! one of them produces reachability.
//!
//! ## Why the predicate is a UUID and not a path
//!
//! The obvious test is "does this file's absolute path appear in the roots'
//! JSON," and it is wrong. One directory has many spellings — `/u/src/…` vs
//! `/Users/…`, firmlinks, the APFS data-volume link — and a path that is
//! persisted *and* compared has to pass the canonicalization gateway first.
//! Here the cost of two spellings failing to match is not an invisible dark
//! row: it is deleting bytes a live draft still references, which is the exact
//! loss this whole feature exists to end.
//!
//! Matching the `<uuid>` stem removes the exposure by construction. A v4 UUID
//! has one spelling, cannot collide, and appears in a root value if and only
//! if some surface still references that file. **This sweep performs no path
//! comparison at all**, which is why it needs no gateway call and cannot
//! drift. A later refactor that "simplifies" it back into a path substring
//! match reintroduces the bug.
//!
//! Everything else about it is conservative in the safe direction. A crude
//! substring hit merely retains a file for another sweep. A mtime younger than
//! the grace period is left alone regardless — never delete eagerly on unlink.
//! Only files *directly* inside the folder are considered, and a filename
//! whose stem does not parse as a UUID is skipped rather than guessed at.

use std::path::Path;
use std::time::{Duration, SystemTime};

use tracing::{info, warn};
use tugbank_core::TugbankClient;

/// How long a file must have gone untouched before the sweep will consider
/// removing it. The git-gc / Joplin lesson: an unreferenced file is very often
/// a file whose reference has not been written yet.
pub(crate) const GRACE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// A file's stem as a v4 UUID, or `None` when it does not look like one.
///
/// Deliberately strict: only names this module's own writer produces are
/// candidates for deletion. Anything else in the folder is somebody else's.
fn uuid_stem(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    uuid::Uuid::parse_str(stem).ok().map(|_| stem.to_owned())
}

/// Delete unreferenced, aged-out files directly inside `dir`.
///
/// `root_json` is the concatenated JSON text of every value in the two root
/// domains; a file survives when its UUID stem appears anywhere in it.
/// Returns how many files were removed. Pure over its inputs (no tugbank, no
/// clock beyond `now`) so it can be tested directly.
pub(crate) fn sweep_draft_attachments(
    dir: &Path,
    root_json: &[String],
    grace: Duration,
    now: SystemTime,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        // No folder yet is the normal case on a fresh instance.
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        // Files only — a subdirectory is not ours to reason about.
        match entry.file_type() {
            Ok(ft) if ft.is_file() => {}
            _ => continue,
        }
        let Some(uuid) = uuid_stem(&path) else {
            continue;
        };
        if root_json.iter().any(|json| json.contains(&uuid)) {
            continue;
        }
        let aged_out = entry
            .metadata()
            .ok()
            .and_then(|md| md.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > grace);
        if !aged_out {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(err) => warn!(error = %err, path = %path.display(), "draft-gc: remove failed"),
        }
    }
    removed
}

/// The newest mtime anywhere in `dir`'s tree, or `None` when nothing is
/// readable.
///
/// A draft home's own mtime says only when its `assets/` child was created, so
/// a home whose files were written yesterday can carry a directory mtime from
/// last month. Taking the newest mtime in the tree errs toward retention,
/// which is the only direction it is safe to err in here.
fn newest_mtime(dir: &Path) -> Option<SystemTime> {
    let mut newest = std::fs::metadata(dir).ok()?.modified().ok();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return newest;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let candidate = match entry.file_type() {
            Ok(ft) if ft.is_dir() => newest_mtime(&path),
            Ok(_) => entry.metadata().ok().and_then(|md| md.modified().ok()),
            Err(_) => None,
        };
        if let Some(candidate) = candidate
            && newest.is_none_or(|current| candidate > current)
        {
            newest = Some(candidate);
        }
    }
    newest
}

/// Delete abandoned draft-document asset homes directly inside `dir`.
///
/// The mirror of `sweep_draft_attachments` for the *document* tier. A Text card
/// editing a not-yet-saved buffer attaches into `draft-docs/<draftId>/assets/`;
/// closing that card without saving (the "Don't Save" path) leaves the tree
/// behind with nothing referencing it. The attachment sweep above cannot
/// reclaim it — it considers files only, and deliberately so — so this pass
/// exists to.
///
/// The predicate is the draft id, which is the Text card's own card id and
/// therefore appears in the card-state JSON for exactly as long as the card
/// does. Same reasoning as the UUID predicate above: a draft id has one
/// spelling, so the match cannot fail the way a path comparison could, and the
/// cost of a false miss here is deleting a live document's attachments.
///
/// Directories only — a stray *file* directly inside `draft-docs/` is not
/// something this module wrote, so it is not this module's to remove.
pub(crate) fn sweep_draft_docs(
    dir: &Path,
    root_json: &[String],
    grace: Duration,
    now: SystemTime,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => {}
            _ => continue,
        }
        let Some(draft_id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if root_json.iter().any(|json| json.contains(draft_id)) {
            continue;
        }
        let aged_out = newest_mtime(&path)
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > grace);
        if !aged_out {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed += 1,
            Err(err) => warn!(error = %err, path = %path.display(), "draft-gc: remove failed"),
        }
    }
    removed
}

/// The union of every root producer's reference-bearing text, or `None` when
/// any of them could not be read.
///
/// `None` means "do not sweep": an incomplete root set cannot tell live from
/// dead, and the failure mode of guessing is deleting bytes a live draft still
/// points at. Retaining everything until the next launch is the only safe
/// answer, and it is why this returns an option rather than a partial set.
fn collect_root_json(
    bank: &TugbankClient,
    prompt_ledger: Option<&crate::prompt_ledger::PromptLedger>,
) -> Option<Vec<String>> {
    let mut root_json: Vec<String> = Vec::new();
    let ledger = match prompt_ledger {
        Some(ledger) => ledger,
        None => {
            warn!("draft-gc: prompt ledger unavailable; sweep skipped");
            return None;
        }
    };
    match ledger.atoms_json_with_refs() {
        Ok(rows) => root_json.extend(rows),
        Err(err) => {
            warn!(error = %err, "draft-gc: prompt ledger unreadable; sweep skipped");
            return None;
        }
    }
    for domain in [
        crate::defaults::CARDSTATE_DOMAIN,
        crate::defaults::PROMPT_HISTORY_DOMAIN,
    ] {
        match bank.read_domain(domain) {
            Ok(snapshot) => {
                for value in snapshot.into_values() {
                    // Only the shapes a reference can actually live in. A
                    // number or a blob cannot mention a UUID.
                    match value {
                        tugbank_core::Value::Json(json) => {
                            if let Ok(text) = serde_json::to_string(&json) {
                                root_json.push(text);
                            }
                        }
                        tugbank_core::Value::String(text) => root_json.push(text),
                        _ => {}
                    }
                }
            }
            Err(err) => {
                warn!(domain = %domain, error = %err, "draft-gc: root domain unreadable; sweep skipped");
                return None;
            }
        }
    }
    Some(root_json)
}

/// Read the root set and run the sweep. Called once at tugcast startup;
/// tugbank is fatal-if-absent there, so the domain roots are always readable.
///
/// `prompt_ledger` is `None` when the ledger failed to open. Since it is now a
/// root producer, a sweep without it would be a sweep with an incomplete root
/// set — so it does not run at all, exactly as an unreadable root domain
/// stops it.
pub(crate) fn sweep_at_startup(
    bank: &TugbankClient,
    prompt_ledger: Option<&crate::prompt_ledger::PromptLedger>,
) {
    let Some(root_json) = collect_root_json(bank, prompt_ledger) else {
        return;
    };
    let now = SystemTime::now();
    let removed = sweep_draft_attachments(
        &crate::attachments::draft_attachments_dir(),
        &root_json,
        GRACE,
        now,
    );
    if removed > 0 {
        info!(count = removed, "swept unreferenced draft attachments");
    }
    let removed = sweep_draft_docs(
        &crate::attachments::draft_docs_dir(),
        &root_json,
        GRACE,
        now,
    );
    if removed > 0 {
        info!(count = removed, "swept abandoned draft document assets");
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A `<uuid>.png` file inside `dir`, written now. Returns its uuid.
    fn make_file(dir: &Path) -> String {
        let uuid = uuid::Uuid::new_v4().to_string();
        std::fs::write(dir.join(format!("{uuid}.png")), b"bytes").unwrap();
        uuid
    }

    /// A sweep running long after everything in the fixture was written, so
    /// every file is past the grace period. Ages the clock rather than the
    /// files: mtime is the fixture's to set, and the wall clock is what the
    /// sweep actually compares against.
    fn long_after() -> SystemTime {
        SystemTime::now() + Duration::from_secs(30 * 24 * 60 * 60)
    }

    #[test]
    fn removes_the_unreferenced_and_aged_out() {
        let dir = tempfile::tempdir().unwrap();
        let referenced = make_file(dir.path());
        let unreferenced = make_file(dir.path());

        let roots = vec![format!(
            r#"{{"attachmentBytes":{{"a":{{"path":"/d/{referenced}.png"}}}}}}"#
        )];
        let removed = sweep_draft_attachments(dir.path(), &roots, GRACE, long_after());

        assert_eq!(removed, 1);
        assert!(dir.path().join(format!("{referenced}.png")).exists());
        assert!(!dir.path().join(format!("{unreferenced}.png")).exists());
    }

    /// The grace period is what keeps a just-dropped attachment alive in the
    /// window before its reference has been written. Same fixture as above
    /// with only the clock changed — nothing goes.
    #[test]
    fn a_young_file_survives_even_unreferenced() {
        let dir = tempfile::tempdir().unwrap();
        let uuid = make_file(dir.path());

        let removed = sweep_draft_attachments(dir.path(), &[], GRACE, SystemTime::now());

        assert_eq!(removed, 0);
        assert!(dir.path().join(format!("{uuid}.png")).exists());
    }

    /// The whole reason the predicate is a UUID. Under a path-substring
    /// predicate this file would not match its own reference — one directory,
    /// two spellings — and the sweep would delete bytes a live draft still
    /// points at. Matching the stem is spelling-invariant, so it survives.
    #[test]
    fn a_reference_under_a_different_path_spelling_still_retains_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let uuid = make_file(dir.path());

        // The root records the file under a completely different spelling of
        // the same directory than the one the sweep is walking.
        let roots = vec![format!(
            r#"{{"path":"/System/Volumes/Data/u/src/tug/draft-attachments/{uuid}.png"}}"#
        )];
        let removed = sweep_draft_attachments(dir.path(), &roots, GRACE, long_after());

        assert_eq!(removed, 0);
        assert!(dir.path().join(format!("{uuid}.png")).exists());
    }

    #[test]
    fn either_root_domain_retains_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let in_cardstate = make_file(dir.path());
        let in_history = make_file(dir.path());

        let roots = vec![
            format!(r#"{{"path":"/d/{in_cardstate}.png"}}"#),
            format!(r#"{{"atoms":[{{"path":"/d/{in_history}.png"}}]}}"#),
        ];
        assert_eq!(
            sweep_draft_attachments(dir.path(), &roots, GRACE, long_after()),
            0,
        );
    }

    #[test]
    fn a_non_uuid_filename_is_never_touched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.png");
        std::fs::write(&path, b"bytes").unwrap();

        assert_eq!(
            sweep_draft_attachments(dir.path(), &[], GRACE, long_after()),
            0,
        );
        assert!(path.exists());
    }

    #[test]
    fn subdirectories_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join(format!("{}.png", uuid::Uuid::new_v4()));
        std::fs::create_dir(&sub).unwrap();
        let nested = sub.join(format!("{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&nested, b"bytes").unwrap();

        assert_eq!(
            sweep_draft_attachments(dir.path(), &[], GRACE, long_after()),
            0,
        );
        assert!(sub.is_dir());
        assert!(nested.exists());
    }

    #[test]
    fn a_missing_directory_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            sweep_draft_attachments(&dir.path().join("never-created"), &[], GRACE, long_after(),),
            0,
        );
        assert_eq!(
            sweep_draft_docs(&dir.path().join("never-created"), &[], GRACE, long_after()),
            0,
        );
    }

    /// A draft home with one attached asset in it. Returns its path.
    fn make_draft_home(root: &Path, draft_id: &str) -> std::path::PathBuf {
        let home = root.join(draft_id);
        std::fs::create_dir_all(home.join("assets")).unwrap();
        std::fs::write(home.join("assets").join("photo.png"), b"bytes").unwrap();
        home
    }

    #[test]
    fn sweep_removes_an_unreferenced_aged_draft_home() {
        let dir = tempfile::tempdir().unwrap();
        let abandoned = make_draft_home(dir.path(), "card-abandoned");

        let removed = sweep_draft_docs(dir.path(), &[], GRACE, long_after());

        assert_eq!(removed, 1);
        assert!(!abandoned.exists());
    }

    /// Two independent reasons a home survives, each on its own fixture: card
    /// state still names it, or it is inside the grace window — which is what
    /// covers the gap between a first drop and the card-state write recording
    /// the card that made it.
    #[test]
    fn sweep_keeps_a_referenced_draft_home() {
        let dir = tempfile::tempdir().unwrap();
        let live = make_draft_home(dir.path(), "card-live");

        let roots = vec![r#"{"card-live":{"kind":"text","draftId":"card-live"}}"#.to_string()];
        assert_eq!(sweep_draft_docs(dir.path(), &roots, GRACE, long_after()), 0);
        assert!(live.join("assets").join("photo.png").exists());
    }

    #[test]
    fn sweep_keeps_a_young_draft_home_even_unreferenced() {
        let dir = tempfile::tempdir().unwrap();
        let young = make_draft_home(dir.path(), "card-young");

        assert_eq!(
            sweep_draft_docs(dir.path(), &[], GRACE, SystemTime::now()),
            0
        );
        assert!(young.join("assets").join("photo.png").exists());
    }

    /// The home directory's own mtime is set when `assets/` is created and
    /// never touched again, so age has to be read from the whole tree — else a
    /// home whose asset was written this morning looks ancient.
    #[test]
    fn a_recently_written_asset_keeps_its_home_alive() {
        let dir = tempfile::tempdir().unwrap();
        let home = make_draft_home(dir.path(), "card-active");

        // `now` sits just past the file's mtime but far past a directory mtime
        // that a grace period would have aged out.
        let just_after = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(sweep_draft_docs(dir.path(), &[], GRACE, just_after), 0);
        assert!(home.exists());
    }

    // ── The root set ────────────────────────────────────────────────────────

    /// A tugbank over a temp file, so the root-domain reads are real.
    fn bank() -> (TugbankClient, tempfile::NamedTempFile) {
        let tmp = tempfile::NamedTempFile::new().expect("temp file");
        let bank = TugbankClient::open(tmp.path()).expect("open bank");
        (bank, tmp)
    }

    fn ledger_with_atom_path(path: &str) -> crate::prompt_ledger::PromptLedger {
        let ledger = crate::prompt_ledger::PromptLedger::open_in_memory().unwrap();
        ledger
            .append(&crate::prompt_ledger::NewPromptEntry {
                session_id: "s1".into(),
                route: "❯".into(),
                text: "look at this".into(),
                atoms_json: serde_json::json!([{"id": "atom-a", "path": path}]).to_string(),
                project_path: String::new(),
                submitted_at_ms: 1,
                client_entry_id: "e1".into(),
            })
            .unwrap();
        ledger
    }

    /// The reason the root-set extension had to land with the migration: once a
    /// reference lives only in the ledger, the ledger is what keeps its bytes.
    #[test]
    fn a_reference_held_only_by_a_ledger_row_retains_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let referenced = make_file(dir.path());
        let unreferenced = make_file(dir.path());

        let (bank, _tmp) = bank();
        let ledger = ledger_with_atom_path(&format!("/d/{referenced}.png"));

        let roots = collect_root_json(&bank, Some(&ledger)).expect("a complete root set");
        let removed = sweep_draft_attachments(dir.path(), &roots, GRACE, long_after());

        assert_eq!(removed, 1, "only the unreferenced file goes");
        assert!(dir.path().join(format!("{referenced}.png")).exists());
        assert!(!dir.path().join(format!("{unreferenced}.png")).exists());
    }

    /// The legacy tugbank domain stays a root for as long as an instance
    /// somewhere may not have run its import yet.
    #[test]
    fn the_legacy_history_domain_still_retains_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let referenced = make_file(dir.path());

        let (bank, _tmp) = bank();
        bank.set(
            crate::defaults::PROMPT_HISTORY_DOMAIN,
            "s-old",
            tugbank_core::Value::Json(
                serde_json::json!([{"atoms": [{"path": format!("/d/{referenced}.png")}]}]),
            ),
        )
        .unwrap();
        let ledger = crate::prompt_ledger::PromptLedger::open_in_memory().unwrap();

        let roots = collect_root_json(&bank, Some(&ledger)).expect("a complete root set");
        assert_eq!(
            sweep_draft_attachments(dir.path(), &roots, GRACE, long_after()),
            0,
        );
        assert!(dir.path().join(format!("{referenced}.png")).exists());
    }

    /// No ledger means an incomplete root set, and an incomplete root set means
    /// no sweep — never a sweep that guesses.
    #[test]
    fn an_absent_ledger_stops_the_sweep_rather_than_narrowing_the_root_set() {
        let (bank, _tmp) = bank();
        assert!(collect_root_json(&bank, None).is_none());
    }

    /// A loose file in `draft-docs/` was not written by this module, so it is
    /// not this module's to delete — the mirror of `subdirectories_are_left_alone`.
    #[test]
    fn a_loose_file_in_the_draft_docs_root_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let stray = dir.path().join("notes.md");
        std::fs::write(&stray, b"bytes").unwrap();

        assert_eq!(sweep_draft_docs(dir.path(), &[], GRACE, long_after()), 0);
        assert!(stray.exists());
    }
}

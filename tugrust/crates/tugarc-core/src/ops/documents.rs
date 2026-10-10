//! The arc's documents home: `.tug/arcs/<name>/`, the brief, plan and task
//! list in it, the ledger read off them, and the `.tug/` exclusion.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::git::git_stdout;
use super::main_repo_root;
use crate::error::ArcError;
use crate::log::validate_arc_name;

// --- the arc's documents home ----------------------------------------------

/// The directory holding an arc's documents: `<repo>/.tug/arcs/<name>`.
///
/// The directory component is the validated raw name, not
/// [`sanitize_branch_name`]'s spelling: nothing constrains a directory name
/// beyond `validate_arc_name`, so the raw name round-trips and enumeration
/// maps a directory back to its arc with no inverse function.
///
/// `repo` is normalized through [`main_repo_root`] here rather than trusted,
/// because both callers outside this crate hold paths that may be linked
/// worktrees (a card's project directory, the CLI's cwd) and `main_repo_root`
/// is crate-private. Without it an arc's worktree would resolve its own empty
/// `.tug/arcs/` and a run would write a second ledger nothing reads.
pub fn documents_dir(repo: &Path, name: &str) -> PathBuf {
    main_repo_root(repo).join(".tug").join("arcs").join(name)
}

/// The arc's brief: `<repo>/.tug/arcs/<name>/brief.md`.
pub fn brief_file(repo: &Path, name: &str) -> PathBuf {
    documents_dir(repo, name).join("brief.md")
}

/// The arc's plan: `<repo>/.tug/arcs/<name>/plan.md`.
pub fn plan_file(repo: &Path, name: &str) -> PathBuf {
    documents_dir(repo, name).join("plan.md")
}

/// The arc's task list: `<repo>/.tug/arcs/<name>/tasks.md`.
///
/// What a `/arc` door writes beside the brief: an `{#execution-steps}`
/// section over a `{#step-status-ledger}` and nothing else. It is a ledger,
/// not a plan — `plan lint` holds it to no skeleton — and its presence is what
/// tells the wheel to open at implement rather than devise.
pub fn tasks_file(repo: &Path, name: &str) -> PathBuf {
    documents_dir(repo, name).join("tasks.md")
}

/// What [`open_arc`] did: which of the two acts it performed, and the record
/// that stands afterwards.
///
/// Both flags false is the third answer and the common one — an arc that was
/// already open and carried no stop is left exactly as it was.
#[derive(Debug, Clone)]
pub struct OpenOutcome {
    /// The arc had no record and one was written.
    pub started: bool,
    /// The arc carried a stop and an `arc-resume` cleared it.
    pub resumed: bool,
    /// The record as it reads after whichever act ran.
    pub record: crate::arc::ArcRecord,
}

/// Open an arc on its own documents, or resume one that stopped.
///
/// The document is the arc's brief, or its plan when only that exists — the
/// arc has no address to be given, because an arc's documents live at one
/// place. An arc that already exists is resumed whatever its document, since
/// the record is the arc's identity and a second `arc-start` would make one arc
/// read as two.
///
/// The kind is derived from the documents by [`kind_from_documents`] and
/// recorded on the opening ([B04] of the one-door brief). A resume derives
/// nothing, for the same reason a second `arc-start` is refused: the arc's
/// kind is part of what the record *is*, and a resume that re-read the
/// documents would let one arc run two progressions when a later stage wrote
/// a plan beside a task list.
///
/// Separated from the verb so the decision is testable over a synthesized log
/// with no session and no instance — and it lives here, in the engine, rather
/// than in the `tugtool` binary crate, because the server opens arcs too
/// ([P05]) and cannot depend on a binary.
pub fn open_arc(root: &Path, arc: &str) -> Result<OpenOutcome, ArcError> {
    validate_arc_name(arc).map_err(ArcError::InvalidName)?;
    if let Some(record) = crate::arc::read_arc(root, arc) {
        return resume_arc(root, arc, record);
    }

    // One sentence for the one refusal, said by whichever of the two reads
    // gets there first.
    let missing = || {
        ArcError::Refused(format!(
            "arc '{arc}' has no brief, plan, or task list at {} — write one first",
            documents_dir(root, arc).display()
        ))
    };
    let file = if brief_file(root, arc).is_file() {
        "brief.md"
    } else if plan_file(root, arc).is_file() {
        "plan.md"
    } else if tasks_file(root, arc).is_file() {
        // A task list with no brief beside it: unusual, since the `/arc`
        // door writes both, but it is a document the wheel can open on and
        // refusing it would be a rule with no reason behind it.
        "tasks.md"
    } else {
        return Err(missing());
    };
    // Unreachable once the ladder found a document — both reads look at the
    // same three addresses — but the kind belongs to the record and is not
    // worth inventing a default for.
    let Some(kind) = kind_from_documents(root, arc) else {
        return Err(missing());
    };
    // Repo-relative in the record, which is what the stage divider shows and
    // what the runner resolves against the main root.
    let relative = format!(".tug/arcs/{arc}/{file}");

    crate::arc::append_arc_start(root, arc, &relative).map_err(|e| ArcError::arc_log(root, e))?;
    // Written after `arc-start`, so a reader that stops at the first marker
    // still finds the document. Both lines are this opening's.
    crate::arc::append_arc_kind(root, arc, kind).map_err(|e| ArcError::arc_log(root, e))?;
    let record = crate::arc::read_arc(root, arc).ok_or_else(|| {
        ArcError::arc_log_said(
            root,
            format!("wrote the arc for '{arc}' but could not read it back"),
        )
    })?;
    Ok(OpenOutcome {
        started: true,
        resumed: false,
        record,
    })
}

/// Pick a stopped arc back up: write `arc-resume` naming the stage it stopped
/// in, which clears the stop and tells the runner which stage to rotate again
/// on the calling session's next idle ([P11]). An arc that is not stopped is
/// left as it is — its record is already what the runner reads.
fn resume_arc(
    root: &Path,
    name: &str,
    record: crate::arc::ArcRecord,
) -> Result<OpenOutcome, ArcError> {
    let Some((stage, _)) = record.stopped else {
        return Ok(OpenOutcome {
            started: false,
            resumed: false,
            record,
        });
    };
    crate::arc::append_arc_resume(root, name, stage).map_err(|e| ArcError::arc_log(root, e))?;
    let record = crate::arc::read_arc(root, name).ok_or_else(|| {
        ArcError::arc_log_said(
            root,
            format!("resumed the arc for '{name}' but could not read it back"),
        )
    })?;
    Ok(OpenOutcome {
        started: false,
        resumed: true,
        record,
    })
}

/// The document whose Step Status Ledger this arc's steps are walked from.
///
/// **`plan.md` outranks `tasks.md`.** An arc with both is a planned arc
/// whose task list is vestigial, and the plan is what the devise and review
/// stages settled. An arc with only a task list walks that. An arc with
/// neither has no ledger and returns `None`, which every caller reports as the
/// refusal it is rather than inventing a path.
///
/// This is the whole of the discrimination between plain and planned: the
/// documents on disk, at their own addresses, read the same way by the runner,
/// the step verb, and the feed.
pub fn ledger_file(repo: &Path, name: &str) -> Option<PathBuf> {
    let plan = plan_file(repo, name);
    if plan.is_file() {
        return Some(plan);
    }
    let tasks = tasks_file(repo, name);
    tasks.is_file().then_some(tasks)
}

/// The kind an arc opens as, read off its documents ([B04]).
///
/// `None` when no document exists. `Plain` when a task list exists and no
/// plan does — the shape the door leaves after settling the steps itself.
/// `Planned` otherwise: a brief alone, a plan alone, a brief with a plan,
/// or a plan beside a vestigial task list, because `plan.md` outranks
/// `tasks.md` exactly as it does for [`ledger_file`].
pub fn kind_from_documents(repo: &Path, name: &str) -> Option<crate::arc::ArcKind> {
    let brief = brief_file(repo, name).is_file();
    let plan = plan_file(repo, name).is_file();
    let tasks = tasks_file(repo, name).is_file();
    if !brief && !plan && !tasks {
        return None;
    }
    if tasks && !plan {
        return Some(crate::arc::ArcKind::Plain);
    }
    Some(crate::arc::ArcKind::Planned)
}

/// Every name under `<repo>/.tug/arcs/` that is an arc with documents.
///
/// Sorted, and filtered twice: the directory name must pass
/// `validate_arc_name`, and the directory must actually hold a brief or a
/// plan or a task list. An absent `.tug/arcs` is an empty list, not an error —
/// a repository with no arcs is the ordinary case.
pub fn document_arcs(repo: &Path) -> Vec<String> {
    document_arc_dirs(repo)
        .into_iter()
        .filter(|name| !ArcDocuments::read(repo, name).is_empty())
        .collect()
}

/// Every arc-named directory under `.tug/arcs/`, whether or not it holds a
/// document yet — the superset [`document_arcs`] filters.
///
/// An empty directory is what a door's first act leaves behind: `arc
/// documents --ensure --bind` makes it and binds the session in the same
/// breath, seconds before the brief is written. A surface that reads the
/// binding needs the directory listed in that gap, and only a caller that
/// knows the bindings can say which empty directories are an arc opening and
/// which are litter — so this scan does not decide, and `document_arcs` keeps
/// deciding the way it always has.
pub fn document_arc_dirs(repo: &Path) -> Vec<String> {
    let root = main_repo_root(repo).join(".tug").join("arcs");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| validate_arc_name(name).is_ok())
        .collect();
    names.sort();
    names
}

/// Which of an arc's documents exist, with the first heading of each.
///
/// Absolute paths, present only when the file is there. The title is a
/// convenience for a surface that cannot open the file itself (the deck has no
/// filesystem); a file whose bytes cannot be read leaves the title `None`
/// rather than failing the read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArcDocuments {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks_title: Option<String>,
}

impl ArcDocuments {
    /// Stat every document of `name` under `repo`.
    pub fn read(repo: &Path, name: &str) -> Self {
        let dir = documents_dir(repo, name);
        let (brief, brief_title) = read_document(&dir.join("brief.md"));
        let (plan, plan_title) = read_document(&dir.join("plan.md"));
        let (tasks, tasks_title) = read_document(&dir.join("tasks.md"));
        Self {
            brief,
            brief_title,
            plan,
            plan_title,
            tasks,
            tasks_title,
        }
    }

    /// True when the arc has no document at all.
    pub fn is_empty(&self) -> bool {
        self.brief.is_none() && self.plan.is_none() && self.tasks.is_none()
    }
}

/// A document's absolute path and its first heading's text, when it exists.
fn read_document(path: &Path) -> (Option<String>, Option<String>) {
    if !path.is_file() {
        return (None, None);
    }
    let abs = path.to_string_lossy().to_string();
    let title = std::fs::read_to_string(path).ok().and_then(|text| {
        text.lines()
            .find(|line| line.starts_with('#'))
            .map(heading_text)
    });
    (Some(abs), title)
}

/// The readable text of a markdown heading line: leading `#`s, a trailing
/// `{#anchor}`, and surrounding `**` removed.
fn heading_text(line: &str) -> String {
    let mut text = line.trim_start_matches('#').trim();
    if let Some(open) = text.rfind("{#")
        && text.ends_with('}')
    {
        text = text[..open].trim();
    }
    text.trim_matches('*').trim().to_string()
}

/// A `plan` verb's argument: the arc's name, or a path to a document.
///
/// The shape decides, and the rule is pure so the CLI and the deck agree: an
/// argument carrying a separator, starting with `.`, or ending in `.md` is a
/// path; anything else is a name. An arc named `foo.md` cannot exist —
/// `validate_arc_name` refuses `.` — so the two forms cannot collide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentArgument {
    Name(String),
    Path(PathBuf),
}

impl DocumentArgument {
    pub fn parse(arg: &str) -> Self {
        if arg.contains('/') || arg.contains('\\') || arg.starts_with('.') || arg.ends_with(".md") {
            DocumentArgument::Path(PathBuf::from(arg))
        } else {
            DocumentArgument::Name(arg.to_string())
        }
    }
}

/// Opens the block `tugarc-core` owns inside `.git/info/exclude`.
const TUG_EXCLUDE_BLOCK_START: &str = "# tug:arcs";
/// Closes it. Everything between the two markers is ours; everything outside
/// is the user's and is never reordered, rewritten, or removed. Its own marker
/// pair rather than the attachments module's: two owners editing one block is
/// the drift the pair exists to prevent.
const TUG_EXCLUDE_BLOCK_END: &str = "# end tug:arcs";

/// The exclude-file contents that carry `line`, or `None` when they already do.
///
/// Pure over its inputs: the block arithmetic is the part that can be wrong,
/// and it is tested without touching a repo.
fn exclude_contents_with(existing: &str, line: &str) -> Option<String> {
    let start = existing
        .lines()
        .position(|l| l.trim() == TUG_EXCLUDE_BLOCK_START);
    let end = start.and_then(|from| {
        existing
            .lines()
            .skip(from + 1)
            .position(|l| l.trim() == TUG_EXCLUDE_BLOCK_END)
            .map(|offset| from + 1 + offset)
    });

    let Some((start, end)) = start.zip(end) else {
        let mut out = existing.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(TUG_EXCLUDE_BLOCK_START);
        out.push('\n');
        out.push_str(line);
        out.push('\n');
        out.push_str(TUG_EXCLUDE_BLOCK_END);
        out.push('\n');
        return Some(out);
    };

    if existing
        .lines()
        .skip(start + 1)
        .take(end - start - 1)
        .any(|l| l.trim() == line)
    {
        return None;
    }

    let mut out = String::new();
    for (i, existing_line) in existing.lines().enumerate() {
        if i == end {
            out.push_str(line);
            out.push('\n');
        }
        out.push_str(existing_line);
        out.push('\n');
    }
    Some(out)
}

/// Whether the project's own ignore rules already cover `.tug/`.
///
/// Spawned through [`tugcore::git_command_for_check_ignore`] rather than the
/// ordinary door, because `check-ignore` is the one subcommand that refuses
/// the literal-pathspec setting every other git run carries [B03]. The
/// argument is a pattern Tug wrote, never a path it read, so there is nothing
/// the setting would have protected here.
///
/// The trailing slash matters: a `.tug/` pattern only matches a directory, and
/// `check-ignore` on a bare `.tug` that does not exist yet reads as a file and
/// answers "not ignored".
pub(crate) fn tug_dir_is_ignored(repo: &Path) -> bool {
    tugcore::git_command_for_check_ignore()
        .arg("-C")
        .arg(repo)
        .args(["check-ignore", "-q", ".tug/"])
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Keep `<repo>/.tug/` out of git, for a project whose `.gitignore` does not.
///
/// Every arc artifact in the tree lives under `.tug/` — the worktrees, and now
/// the documents — and a project that never declared it would show the whole
/// directory as untracked, dirtying the base checkout in the act of starting an
/// arc. Three choices carry the same weight they carry in tugcast's
/// attachments exclusion:
///
/// - **`.git/info/exclude`, not the project's `.gitignore`.** The exclude file
///   needs no commit and produces no working-tree diff, in a file the user owns.
/// - **An anchored exact path (`/.tug/`), never a bare pattern.**
/// - **The file is found through `--git-common-dir`, never `<root>/.git`.** In a
///   linked worktree — which is what every arc is — `.git` is a file.
///
/// Idempotent and quiet: a project that already ignores `.tug` is left alone,
/// and every failure is logged nowhere and propagated nowhere. A document that
/// landed on disk must not be reported as failed because a housekeeping write
/// did.
pub fn ensure_tug_excluded(repo: &Path) {
    let repo = main_repo_root(repo);
    if tug_dir_is_ignored(&repo) {
        return;
    }
    let Ok(common_dir) = git_stdout(
        &repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) else {
        return;
    };
    if common_dir.is_empty() {
        return;
    }
    let info = PathBuf::from(common_dir).join("info");
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let Some(updated) = exclude_contents_with(&existing, "/.tug/") else {
        return;
    };
    if std::fs::create_dir_all(&info).is_err() {
        return;
    }
    let _ = std::fs::write(&exclude, updated);
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn documents_home_is_spelled_from_the_raw_name() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        assert!(
            documents_dir(root, "foo-bar").ends_with(".tug/arcs/foo-bar"),
            "{}",
            documents_dir(root, "foo-bar").display()
        );
        assert!(brief_file(root, "foo-bar").ends_with(".tug/arcs/foo-bar/brief.md"));
        assert!(plan_file(root, "foo-bar").ends_with(".tug/arcs/foo-bar/plan.md"));
        assert!(tasks_file(root, "foo-bar").ends_with(".tug/arcs/foo-bar/tasks.md"));
    }

    /// The whole of the discrimination between plain and planned: which
    /// document is on disk. A plan outranks a task list, so an arc that grew a
    /// plan walks the plan and the vestigial task list is never consulted.
    #[test]
    fn the_ledger_is_the_plan_when_there_is_one_and_the_task_list_otherwise() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let dir = documents_dir(root, "ledgered");
        fs::create_dir_all(&dir).unwrap();

        // Neither document: no ledger, and no invented path.
        assert_eq!(ledger_file(root, "ledgered"), None);

        // A task list alone is an arc's ledger.
        fs::write(dir.join("tasks.md"), "# tasks\n").unwrap();
        assert_eq!(ledger_file(root, "ledgered"), Some(dir.join("tasks.md")));

        // A plan beside it outranks it.
        fs::write(dir.join("plan.md"), "# plan\n").unwrap();
        assert_eq!(ledger_file(root, "ledgered"), Some(dir.join("plan.md")));

        // A plan alone is a planned arc's ledger, as it always was.
        fs::remove_file(dir.join("tasks.md")).unwrap();
        assert_eq!(ledger_file(root, "ledgered"), Some(dir.join("plan.md")));
    }

    /// Table T01 of the one-door plan, every row of it, read straight off the
    /// documents. The `None` row is the one that matters twice over: a
    /// directory with nothing in it and a directory that was never made both
    /// answer "no kind", because the kind is a fact about documents and there
    /// are none.
    #[test]
    fn the_kind_is_read_off_the_documents() {
        use crate::arc::ArcKind::{Plain, Planned};

        let temp = TempDir::new().unwrap();
        let root = temp.path();

        // Never made: no kind, and nothing created by asking.
        assert_eq!(kind_from_documents(root, "absent"), None);
        assert!(!documents_dir(root, "absent").exists());

        for (row, (documents, expected)) in [
            (&[][..], None),
            (&["brief.md"][..], Some(Planned)),
            (&["plan.md"][..], Some(Planned)),
            (&["tasks.md"][..], Some(Plain)),
            (&["brief.md", "tasks.md"][..], Some(Plain)),
            (&["brief.md", "plan.md"][..], Some(Planned)),
            (&["plan.md", "tasks.md"][..], Some(Planned)),
            (&["brief.md", "plan.md", "tasks.md"][..], Some(Planned)),
        ]
        .into_iter()
        .enumerate()
        {
            // One arc per row, so no row inherits the last one's documents.
            let name = format!("kinded-{row}");
            let dir = documents_dir(root, &name);
            fs::create_dir_all(&dir).unwrap();
            for document in documents {
                fs::write(dir.join(document), "# fixture\n").unwrap();
            }
            assert_eq!(
                kind_from_documents(root, &name),
                expected,
                "documents {documents:?}"
            );
        }
    }

    #[test]
    #[serial]
    fn documents_dir_answers_the_main_root_from_a_linked_worktree() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        let outcome = create("wt-arc", None, false, None).unwrap();
        let worktree = Path::new(&outcome.worktree);

        let from_worktree = documents_dir(worktree, "wt-arc");
        let from_main = documents_dir(&fs::canonicalize(&repo).unwrap(), "wt-arc");

        assert_eq!(from_worktree, from_main);
        assert!(
            !from_worktree.starts_with(worktree),
            "a linked worktree must not resolve its own .tug/arcs: {}",
            from_worktree.display()
        );
    }

    #[test]
    fn arc_documents_read_reports_existence_and_titles() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let dir = documents_dir(root, "titles");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("brief.md"), "# The brief {#brief}\n\nbody\n").unwrap();

        let docs = ArcDocuments::read(root, "titles");
        assert_eq!(docs.brief_title.as_deref(), Some("The brief"));
        assert_eq!(
            docs.brief.as_deref(),
            Some(&*dir.join("brief.md").to_string_lossy())
        );
        assert_eq!(docs.plan, None);
        assert_eq!(docs.plan_title, None);
        assert_eq!(docs.tasks, None);
        assert!(!docs.is_empty());

        fs::write(dir.join("plan.md"), "## **A plan** {#plan}\n").unwrap();
        assert_eq!(
            ArcDocuments::read(root, "titles").plan_title.as_deref(),
            Some("A plan")
        );

        fs::write(dir.join("tasks.md"), "# The task list {#tasks}\n").unwrap();
        let docs = ArcDocuments::read(root, "titles");
        assert_eq!(docs.tasks_title.as_deref(), Some("The task list"));
        assert_eq!(
            docs.tasks.as_deref(),
            Some(&*dir.join("tasks.md").to_string_lossy())
        );

        assert!(ArcDocuments::read(root, "nothing").is_empty());
    }

    /// A `/arc` door writes a brief and a task list and no plan. That arc is
    /// an arc with documents like any other — the enumerator that feeds the
    /// Changes shade must not skip it.
    #[test]
    fn a_arc_with_only_a_task_list_has_documents() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let dir = documents_dir(root, "tasks-only");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("tasks.md"), "# tasks {#tasks}\n").unwrap();

        assert!(!ArcDocuments::read(root, "tasks-only").is_empty());
        assert_eq!(document_arcs(root), vec!["tasks-only".to_string()]);
    }

    #[test]
    fn document_arcs_lists_directories_with_documents_only() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let arcs = root.join(".tug").join("arcs");
        fs::create_dir_all(arcs.join("beta")).unwrap();
        fs::write(arcs.join("beta").join("brief.md"), "# b\n").unwrap();
        fs::create_dir_all(arcs.join("alpha")).unwrap();
        fs::write(arcs.join("alpha").join("plan.md"), "# a\n").unwrap();
        // An empty directory, a directory whose name is not an arc name, and a
        // file at the top level are all skipped.
        fs::create_dir_all(arcs.join("empty")).unwrap();
        fs::create_dir_all(arcs.join("Not-A-Name")).unwrap();
        fs::write(arcs.join("Not-A-Name").join("brief.md"), "# n\n").unwrap();
        fs::write(arcs.join("loose.md"), "# l\n").unwrap();

        assert_eq!(document_arcs(root), vec!["alpha", "beta"]);
        assert!(document_arcs(temp.path().join("absent").as_path()).is_empty());
        // The unfiltered scan keeps the empty directory — it is the one a
        // door's first act leaves — and still drops what is not an arc.
        assert_eq!(document_arc_dirs(root), vec!["alpha", "beta", "empty"]);
    }

    #[test]
    fn document_argument_parse_splits_on_shape() {
        assert_eq!(
            DocumentArgument::parse("foo"),
            DocumentArgument::Name("foo".into())
        );
        for path in ["foo.md", "./foo", "a/b", "/abs", "../up", "a\\b"] {
            assert_eq!(
                DocumentArgument::parse(path),
                DocumentArgument::Path(PathBuf::from(path)),
                "{path} should parse as a path"
            );
        }
    }

    #[test]
    fn ensure_tug_excluded_makes_git_status_clean_without_a_gitignore() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("bare-project");
        fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test User"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            tugcore::git_command()
                .arg("-C")
                .arg(&repo)
                .args(&args)
                .output()
                .unwrap();
        }
        fs::write(repo.join("README.md"), "# Test\n").unwrap();
        tugcore::git_command()
            .arg("-C")
            .arg(&repo)
            .args(["add", "-A"])
            .output()
            .unwrap();
        tugcore::git_command()
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-m", "init"])
            .output()
            .unwrap();

        let dir = repo.join(".tug").join("arcs").join("x");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("brief.md"), "# x\n").unwrap();
        assert!(!porcelain_of(&repo).is_empty(), "fixture must start dirty");

        ensure_tug_excluded(&repo);
        assert_eq!(porcelain_of(&repo), "");

        // Idempotent: a second call adds no second line.
        ensure_tug_excluded(&repo);
        let exclude = fs::read_to_string(repo.join(".git").join("info").join("exclude")).unwrap();
        assert_eq!(exclude.matches("/.tug/").count(), 1, "{exclude}");
        assert_eq!(
            exclude.matches(TUG_EXCLUDE_BLOCK_START).count(),
            1,
            "{exclude}"
        );
        assert_eq!(
            exclude.matches(TUG_EXCLUDE_BLOCK_END).count(),
            1,
            "{exclude}"
        );
    }

    /// A project whose `.gitignore` already covers `.tug` is left alone.
    #[test]
    fn ensure_tug_excluded_leaves_a_declared_project_alone() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        init_git_repo(&repo);
        let exclude = repo.join(".git").join("info").join("exclude");
        let before = fs::read_to_string(&exclude).unwrap_or_default();

        ensure_tug_excluded(&repo);

        assert_eq!(fs::read_to_string(&exclude).unwrap_or_default(), before);
    }

    /// The document is the arc's own, and the brief comes first — an arc that
    /// has reached devise opens on what it was briefed with, not on its output.
    #[test]
    #[serial]
    fn open_arc_opens_on_the_brief_then_the_plan() {
        let (_home, repo) = open_arc_fixture();
        write_arc_document(repo.path(), "plan-only", "plan.md");
        let opened = open_arc(repo.path(), "plan-only").expect("opened");
        assert_eq!(
            opened.record.document.as_deref(),
            Some(".tug/arcs/plan-only/plan.md")
        );

        let (_home, repo) = open_arc_fixture();
        write_arc_document(repo.path(), "both", "brief.md");
        write_arc_document(repo.path(), "both", "plan.md");
        let opened = open_arc(repo.path(), "both").expect("opened");
        assert_eq!(
            opened.record.document.as_deref(),
            Some(".tug/arcs/both/brief.md")
        );
    }

    /// The bare door writes a brief and a task list, and the arc opens on the
    /// brief — the task list is the ledger, not the document the stages read
    /// for intent.
    #[test]
    #[serial]
    fn a_plain_arc_opens_on_the_brief() {
        let (_home, repo) = open_arc_fixture();
        write_arc_document(repo.path(), "both-docs", "brief.md");
        write_arc_document(repo.path(), "both-docs", "tasks.md");
        let opened = open_arc(repo.path(), "both-docs").unwrap();
        assert_eq!(
            opened.record.document.as_deref(),
            Some(".tug/arcs/both-docs/brief.md")
        );
        assert_eq!(opened.record.kind, Some(crate::arc::ArcKind::Plain));
    }

    /// **The opening records the kind its documents name ([B04]).** Table T01
    /// in one test: a task list with no plan beside it is the plain shape the
    /// door leaves after settling the steps itself, and every other document
    /// set is planned, because `plan.md` outranks `tasks.md` here exactly as
    /// it does for `ledger_file`.
    #[test]
    #[serial]
    fn opening_an_arc_records_the_kind_its_documents_name() {
        let planned = Some(crate::arc::ArcKind::Planned);
        let plain = Some(crate::arc::ArcKind::Plain);
        for (documents, expected) in [
            (&["brief.md"][..], planned),
            (&["plan.md"][..], planned),
            (&["tasks.md"][..], plain),
            (&["brief.md", "tasks.md"][..], plain),
            (&["brief.md", "plan.md"][..], planned),
            (&["plan.md", "tasks.md"][..], planned),
            (&["brief.md", "plan.md", "tasks.md"][..], planned),
        ] {
            let (_home, repo) = open_arc_fixture();
            for document in documents {
                write_arc_document(repo.path(), "table", document);
            }
            let opened = open_arc(repo.path(), "table").unwrap();
            assert_eq!(opened.record.kind, expected, "documents {documents:?}");
        }
    }

    /// **A resume does not re-derive the kind.** The record is the arc's
    /// identity, and a second `arc run` over an arc already open is a resume
    /// of that arc, not a second one wearing a different progression — so a
    /// task list written after the opening does not turn a planned arc plain.
    #[test]
    #[serial]
    fn a_resume_keeps_the_kind_the_opening_recorded() {
        let (_home, repo) = open_arc_fixture();
        write_arc_document(repo.path(), "settled", "brief.md");
        open_arc(repo.path(), "settled").unwrap();
        write_arc_document(repo.path(), "settled", "tasks.md");
        let reopened = open_arc(repo.path(), "settled").unwrap();
        assert!(!reopened.started);
        assert_eq!(reopened.record.kind, Some(crate::arc::ArcKind::Planned));
    }

    /// A task list alone still opens an arc: the wheel has a document to read
    /// and a ledger to walk, which is all opening requires.
    #[test]
    #[serial]
    fn a_task_list_alone_opens_an_arc() {
        let (_home, repo) = open_arc_fixture();
        write_arc_document(repo.path(), "tasks-only", "tasks.md");
        let opened = open_arc(repo.path(), "tasks-only").unwrap();
        assert_eq!(
            opened.record.document.as_deref(),
            Some(".tug/arcs/tasks-only/tasks.md")
        );
        assert_eq!(opened.record.kind, Some(crate::arc::ArcKind::Plain));
    }

    /// The property [P01] and [P02] both rest on: a validated name is one safe
    /// directory component, and cannot be mistaken for a path. A later
    /// loosening of the validator fails here rather than in a path join.
    #[test]
    fn a_validated_arc_name_is_one_safe_directory_component() {
        for bad in ["a/b", "a\\b", "..", ".hidden", "foo.md", "/abs"] {
            assert!(
                validate_arc_name(bad).is_err(),
                "{bad} must not be a valid arc name"
            );
        }
        for good in ["foo-bar", "at0473-adopter", "arc-documents"] {
            assert!(validate_arc_name(good).is_ok(), "{good} should validate");
        }
    }
}

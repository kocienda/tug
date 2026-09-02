//! Dash helpers — git-derived lightweight worktree work units.
//!
//! A dash *is* a git branch (`tugdash/<name>`) plus a worktree
//! (`.tug/worktrees/<name>`); its lifecycle and status derive from git, not
//! a database. This module holds the small shared helpers the `tugdash`
//! commands build on: name validation, default-branch detection, and the
//! append-only visibility log.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use tugtool_core::error::TugError;
use tugtool_core::paths::project_state_dir;
use tugtool_core::session::now_iso8601;

/// Round metadata passed via stdin to `tugdash commit`.
///
/// Git already records the commit; the one datum it lacks is the verbatim
/// instruction, which lands in the dash-log. `summary` is retained for a richer
/// commit body. (The former `files_created` / `files_modified` fields were
/// dropped — git's own diff is the record.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashRoundMeta {
    pub instruction: Option<String>,
    pub summary: Option<String>,
}

/// Validate a dash name.
///
/// Names must:
/// - Match pattern: `^[a-z][a-z0-9-]*[a-z0-9]$`
/// - Be at least 2 characters
/// - Not be a reserved word: "discard", "release", "join", "status". `release`
///   stays reserved though its subcommand is gone: a dash named `release` would
///   collide with the historical terminal marker still on disk, and with a
///   decade of muscle memory, for no gain.
pub fn validate_dash_name(name: &str) -> Result<(), TugError> {
    // Reserved words check
    if name == "discard" || name == "release" || name == "join" || name == "status" {
        return Err(TugError::DashNameInvalid {
            name: name.to_string(),
            reason: format!("'{}' is a reserved word", name),
        });
    }

    // Minimum length
    if name.len() < 2 {
        return Err(TugError::DashNameInvalid {
            name: name.to_string(),
            reason: "name must be at least 2 characters".to_string(),
        });
    }

    // Pattern validation
    let chars: Vec<char> = name.chars().collect();

    // Must start with lowercase letter
    if !chars[0].is_ascii_lowercase() {
        return Err(TugError::DashNameInvalid {
            name: name.to_string(),
            reason: "name must start with a lowercase letter".to_string(),
        });
    }

    // Must end with lowercase letter or digit
    if !chars[chars.len() - 1].is_ascii_lowercase() && !chars[chars.len() - 1].is_ascii_digit() {
        return Err(TugError::DashNameInvalid {
            name: name.to_string(),
            reason: "name must end with a lowercase letter or digit".to_string(),
        });
    }

    // All characters must be lowercase letter, digit, or hyphen
    for ch in chars.iter() {
        if !ch.is_ascii_lowercase() && !ch.is_ascii_digit() && *ch != '-' {
            return Err(TugError::DashNameInvalid {
                name: name.to_string(),
                reason: "name must contain only lowercase letters, digits, and hyphens".to_string(),
            });
        }
    }

    Ok(())
}

/// Detect the default branch using a four-step fallback chain.
///
/// 1. Try `git symbolic-ref refs/remotes/origin/HEAD` (extract branch name)
/// 2. If that fails: check if `main` exists locally
/// 3. If that fails: check if `master` exists locally
/// 4. If all fail: error with message listing available local branches
pub fn detect_default_branch(repo_root: &Path) -> Result<String, TugError> {
    // Step 1: Try origin/HEAD
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("symbolic-ref")
        .arg("refs/remotes/origin/HEAD")
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let symref = String::from_utf8_lossy(&output.stdout);
            // Format is "refs/remotes/origin/<branch>"
            if let Some(branch) = symref.trim().strip_prefix("refs/remotes/origin/") {
                return Ok(branch.to_string());
            }
        }
    }

    // Step 2: Check if main exists
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("rev-parse")
        .arg("--verify")
        .arg("main")
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            return Ok("main".to_string());
        }
    }

    // Step 3: Check if master exists
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("rev-parse")
        .arg("--verify")
        .arg("master")
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            return Ok("master".to_string());
        }
    }

    // Step 4: Error with available branches
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("branch")
        .arg("--format=%(refname:short)")
        .output()
        .map_err(|e| TugError::WorktreeCreationFailed {
            reason: format!("failed to list branches: {}", e),
        })?;

    let branches = String::from_utf8_lossy(&output.stdout);
    let branch_list: Vec<&str> = branches.lines().collect();

    Err(TugError::BaseBranchNotFound {
        branch: format!(
            "Could not detect default branch. Available local branches: {}",
            branch_list.join(", ")
        ),
    })
}

/// Append one record to the per-project dash-log under [`project_state_dir`].
///
/// The log is a flat, append-only, greppable markdown file — the whole
/// visibility surface for dash activity. Each line is four space-separated
/// fields: `<iso8601>  <dash>  <marker>  <note>`, where `<marker>` is the short
/// commit hash for a commit round (or `discarded` for a discarded dash) and
/// `<note>` is the verbatim instruction (or the terminal action). The directory
/// is created on first write.
pub fn append_dash_log(
    repo_root: &Path,
    dash: &str,
    marker: &str,
    note: &str,
) -> Result<(), TugError> {
    let mut file = open_dash_log(repo_root)?;
    write_dash_log_line(&mut file, dash, marker, note)
}

/// Open the project's dash-log for appending, creating the file and its
/// directory if this is the first write.
///
/// Split out of [`append_dash_log`] so a caller that must move two records
/// together can do the part that fails — creating the directory, opening the
/// file — *before* it commits the other record, and then hold the handle. The
/// append itself, through a handle already open, is a single `write` on a file
/// opened `O_APPEND`: as close to "cannot fail for a reason you could have
/// foreseen" as a filesystem gets. See `ops::step_in`.
pub fn open_dash_log(repo_root: &Path) -> Result<std::fs::File, TugError> {
    refuse_unredirected_temp_repo(repo_root);
    let dir = project_state_dir(repo_root);
    fs::create_dir_all(&dir).map_err(TugError::Io)?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("dash-log.md"))
        .map_err(TugError::Io)
}

/// Append one record through a handle [`open_dash_log`] returned.
///
/// The timestamp is stamped here rather than at open time, so a handle held
/// across some work still dates the line by when the line was written.
pub fn write_dash_log_line(
    file: &mut std::fs::File,
    dash: &str,
    marker: &str,
    note: &str,
) -> Result<(), TugError> {
    let note = note.replace('\n', " ");
    let line = format!("{}  {}  {}  {}\n", now_iso8601(), dash, marker, note.trim());
    file.write_all(line.as_bytes()).map_err(TugError::Io)
}

/// Whether writing project state for `repo_root` would land in the user's live
/// data directory when it should not: the repo sits under the OS temp directory
/// (so it is scratch by construction) and `data_dir` — the value of
/// `TUG_DATA_DIR` — is unset or empty.
///
/// Both paths are canonicalized before the comparison because macOS reports the
/// temp directory as `/var/folders/…` while a canonicalized repo root reads
/// `/private/var/folders/…`; comparing them raw never matches.
#[cfg(debug_assertions)]
fn temp_repo_without_redirect(repo_root: &Path, data_dir: Option<&std::ffi::OsStr>) -> bool {
    if data_dir.is_some_and(|v| !v.is_empty()) {
        return false;
    }
    let resolve = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    resolve(repo_root).starts_with(resolve(&std::env::temp_dir()))
}

/// Panic rather than write dash state for a temp-directory repo into the user's
/// real data directory.
///
/// A test that builds a repo under `$TMPDIR` and runs dash ops against it
/// resolves [`project_state_dir`] from the live data root and leaves one
/// directory behind per run — hundreds accumulated before this check existed.
/// The fix is to redirect `TUG_DATA_DIR`, which `tugrust/.cargo/config.toml`
/// already does for every cargo-driven process, so the message names it.
///
/// Debug builds only: the shipping app never runs this check, and a user whose
/// real project genuinely lives under a temp path is not second-guessed.
#[cfg(debug_assertions)]
pub(crate) fn refuse_unredirected_temp_repo(repo_root: &Path) {
    let data_dir = std::env::var_os(tugcore::instance::ENV_DATA_DIR);
    assert!(
        !temp_repo_without_redirect(repo_root, data_dir.as_deref()),
        "dash state for the temp-directory repo {} would be written to the live data \
         directory. Set {} to a scratch path before running dash ops against a \
         tempdir repo (cargo does this for every test process; a binary invoked \
         directly — from a shell test or an app-test — inherits nothing).",
        repo_root.display(),
        tugcore::instance::ENV_DATA_DIR,
    );
}

#[cfg(not(debug_assertions))]
pub(crate) fn refuse_unredirected_temp_repo(_repo_root: &Path) {}

// --- declarations ----------------------------------------------------------

/// A stage a dash declared for itself in the dash-log (Spec S01).
///
/// Git can see rounds, dirt, and a draft; it cannot see that a step is under
/// way or that a build was vetted. Those are declared, and the declaration
/// lives as one more line in the same append-only log ([P01]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashDeclaration {
    /// Step `current` of `total` is under way.
    Step { current: u32, total: u32 },
    /// The dash built and launched.
    Built,
    /// The dash's work passed an audit.
    Audited,
}

/// Which end of a step a declaration marks.
///
/// `Withdrawn` closes a step the run decided not to walk. It closes as a
/// `Done` does — a withdrawal is a step ending — and records no commit,
/// because none was made.
///
/// `Reset` and `Reopen` are the two ways a closed step comes back. They are
/// not ends at all, which is why the name of this type is now a half-truth
/// worth keeping: every variant is still one entry in the log's step
/// vocabulary, and the vocabulary is what a reader switches on.
///
/// - `Reset` parks a step: the row goes back to `pending`, the run un-advances,
///   and nothing about the step is claimed any more. This is what withdraw was
///   being pressed into meaning, and it is not what withdraw means.
/// - `Reopen` walks a `done` step back to `in progress` — the audit-rejected
///   case. It **un-arms the join** until the step re-closes, and the log line
///   is the whole of how [`read_declarations`] knows that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepPhase {
    Start,
    Done,
    Withdrawn,
    Reset,
    Reopen,
}

impl StepPhase {
    /// The log marker this phase writes.
    pub fn marker(self) -> &'static str {
        match self {
            StepPhase::Start => "step-start",
            StepPhase::Done => "step-done",
            StepPhase::Withdrawn => "step-withdrawn",
            StepPhase::Reset => "step-reset",
            StepPhase::Reopen => "step-reopen",
        }
    }

    /// Whether this phase leaves the step **open** — its work unfinished and
    /// the run not advanced past it.
    ///
    /// `Start` and `Reopen` open; `Done` and `Withdrawn` close; `Reset` does
    /// neither, and is the one phase this predicate cannot answer for, so it
    /// is not asked — see [`read_declarations`], which handles the park as its
    /// own case.
    pub fn opens_the_step(self) -> bool {
        matches!(self, StepPhase::Start | StepPhase::Reopen)
    }
}

/// A stage `dash mark` may declare — the closed vocabulary of [P09].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkStage {
    Built,
    Audited,
}

impl MarkStage {
    /// The log marker, which is also the stage's wire spelling.
    pub fn marker(self) -> &'static str {
        match self {
            MarkStage::Built => "built",
            MarkStage::Audited => "audited",
        }
    }
}

/// What a dash's last green verify said about the tree a join would land.
///
/// Both endpoints, because the fit is the dash *replayed onto the live base*:
/// a base that moved after a green verify leaves the recorded head untouched
/// while making the verified tree no longer the tree a join would land.
/// Recording one sha and deriving staleness from it would say `verified` about
/// a tree that no longer exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FitFact {
    /// The head the fit was verified at, full sha.
    pub head: String,
    /// The base tip that head was verified onto, full sha.
    pub base: String,
    /// Whether both endpoints still stand: `head` is the dash branch's tip and
    /// `base` is the base branch's tip. Derived at read time from one
    /// `rev-parse` each; nothing about the staleness is stored.
    pub current: bool,
}

/// The head/base pair a `verified` note names, if it names one.
///
/// The note leads with the head and carries the base after `onto`. A note that
/// does not parse into that pair is ignored rather than half-believed — the
/// same reading `read_step_fields` takes of a step note it cannot understand.
pub fn parse_verified_note(note: &str) -> Option<(String, String)> {
    let mut tokens = note.split_whitespace();
    let head = tokens.next()?;
    let base = tokens.skip_while(|t| *t != "onto").nth(1)?;
    if head.is_empty() || base.is_empty() {
        return None;
    }
    Some((head.to_string(), base.to_string()))
}
/// What a dash's surviving declarations say about it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DashDeclarations {
    /// The latest declaration of any kind — the one the stage derives from.
    /// A `step-start` after a `built` correctly demotes the dash back to
    /// implementing, because the last thing declared is the current answer.
    pub latest: Option<DashDeclaration>,
    /// The latest step declaration's `i`/`N`, which outlives a later `built`
    /// or `audited` so a display can still say how far the run got.
    pub step: Option<(u32, u32)>,
    /// The latest `step-start` note's title — what step `i` *is*, so a display
    /// can say more than a counter. `None` when the note carried no title.
    pub step_title: Option<String>,
    /// The latest `replayed` line's note — where this dash's rounds went when
    /// its base last moved under it. Deliberately not a `latest` declaration: a
    /// replay rewrites history, it does not move the dash's stage.
    pub last_replay: Option<String>,
    /// The latest `verified` line's note — the head the fit was verified at
    /// and the base it was verified onto. Deliberately not a `latest`
    /// declaration, on the same grounds as `last_replay`: verifying reports on
    /// a tree, it does not move the dash's stage.
    pub last_verified: Option<String>,
    /// The timestamp of the newest surviving line for this dash's current
    /// generation — when the dash was last touched at all, by any writer. Reset
    /// with everything else at a terminal line, so a reused name reports its own
    /// generation's age. `None` when the generation has logged nothing.
    pub last_activity: Option<String>,
    /// The final step of the run's declared selection — the `--through <m>` the
    /// step verb refuses to start without ([P01]). `None` for a generation that
    /// declared no run, which includes every dash whose log predates the flag.
    pub run_through: Option<u32>,
    /// The first step of the run's declared selection, latched from the first
    /// step declaration to follow the `run-through` line that opened the run.
    ///
    /// Derived rather than written, because the writer records only the run's
    /// *end*. The ordering that makes it correct is the writer's: `step_in`
    /// appends `run-through` before the run's opening `step-start`, and only
    /// when the declared value differs from the generation's current one. So a
    /// `run-through` line means "a new selection begins with the next step
    /// declaration", and everything between two of them belongs to one run.
    ///
    /// `None` for a generation that declared no run, and for the window
    /// between a `run-through` line and the step declaration that follows it.
    pub run_first: Option<u32>,
    /// The latest step declaration is a `step-start`: a step is open and its
    /// work is unfinished.
    pub step_in_flight: bool,
    /// The declared selection finished: the latest step declaration is a
    /// `step-done` whose step number reaches [`Self::run_through`]. `false`
    /// when no run was declared, so a legacy generation never arms on
    /// arithmetic it never recorded.
    pub run_complete: bool,
}

/// Split a dash-log line into its timestamp, dash, marker, and note fields.
///
/// [`append_dash_log`] joins the four fields with two spaces and trims the
/// note, so the note is whatever follows the third separator — including
/// nothing at all, which is how a teardown line is written.
///
/// Public because the dash-log grammar has exactly one reader: `tugcast`'s
/// draft engine reads the same file for a different purpose and shares this
/// splitter and [`is_terminal`] rather than re-deriving them. Two independent
/// parsers of one grammar is how a compatibility clause comes to hold in one
/// of them and not the other.
pub fn split_log_line(line: &str) -> Option<(&str, &str, &str, &str)> {
    let mut fields = line.trim_end().splitn(4, "  ");
    let timestamp = fields.next()?;
    let dash = fields.next()?;
    let marker = fields.next()?;
    Some((
        timestamp.trim(),
        dash.trim(),
        marker.trim(),
        fields.next().unwrap_or("").trim(),
    ))
}

/// Whether a log line ends a dash generation.
///
/// "Terminal" is spelled several ways because several writers spell it several
/// ways: the join teardown records the squash's sha as the marker and `joined`
/// as the note, and the discard teardown records a bare marker with no note.
///
/// `released` is the discard teardown's *historical* spelling. Dash-logs are
/// append-only and are never rewritten, so every log written before the verb
/// was renamed still carries it. It is read here forever, is never written
/// from here forward, and is not scheduled for removal — dropping it would
/// silently stop ending generations in every log already on disk, and a dash
/// name reused after a discard would be born carrying the previous
/// generation's declarations.
///
/// The join's note is matched by prefix, not equality, for the same reason:
/// it carries the route that landed it (`joined via card`).
pub fn is_terminal(marker: &str, note: &str) -> bool {
    marker == "discarded" || marker == "released" || note == "joined" || note.starts_with("joined ")
}

/// Read the `i`/`N` a step declaration's note leads with. An unparseable note
/// is skipped rather than guessed at.
///
/// Public on the same grounds as [`split_log_line`]: the dash-log grammar has
/// one set of readers, all in `tugcast`, and a second parser of it is how a
/// clause comes to hold in one reader and not the other. The quiet-line
/// observer (`feeds/dash_notes.rs`) reads the same notes this does.
pub fn read_step_fields(note: &str) -> Option<(u32, u32)> {
    let token = note.split_whitespace().next()?;
    let (current, total) = token.split_once('/')?;
    Some((current.parse().ok()?, total.parse().ok()?))
}

/// The title a `step-start` note carries after its `i/N` token. The tail is
/// written as `Step {i}: {title}`, so that spelled-out prefix is stripped back
/// off; any other tail is kept verbatim. Empty reads as no title.
///
/// Public for the same reason [`read_step_fields`] is. On a `step-done` the
/// tail is the round's sha rather than a title, and this reads it unchanged —
/// which is what the quiet line wants there too.
pub fn read_step_title(note: &str, current: u32) -> Option<String> {
    let (_, tail) = note.split_once(char::is_whitespace)?;
    let tail = tail.trim();
    let title = tail
        .strip_prefix(&format!("Step {current}:"))
        .map(str::trim)
        .unwrap_or(tail);
    (!title.is_empty()).then(|| title.to_owned())
}

/// The declarations a dash's *current generation* has made ([P02]).
///
/// Lines are filtered to the dash by name, then everything at or before its
/// last terminal line is discarded: the log is append-only across generations,
/// so without that reset a name reused after a join would be born `audited`.
/// A missing log, an empty log, and a log with nothing after the terminal line
/// all read as no declarations.
///
/// **Reading a log written by a newer build.** Every marker this match does
/// not know falls through the `_` arm having still dated the dash, so a reader
/// that predates `step-reset` and `step-reopen` degrades rather than refuses:
/// it keeps answering from the markers it does know. The degradation has a
/// direction worth naming — an old reader sees a reopened step's earlier
/// `step-done` as the last word and so still arms the join, which is exactly
/// the behaviour it had before the markers existed. That is the skew rule
/// W1 settled: a new fact an old reader cannot see leaves it where it was.
pub fn read_declarations(repo_root: &Path, dash: &str) -> DashDeclarations {
    let path = project_state_dir(repo_root).join("dash-log.md");
    let Ok(text) = fs::read_to_string(&path) else {
        return DashDeclarations::default();
    };

    let mut found = DashDeclarations::default();
    // The run's **frontier** — the highest step number a close has reached —
    // and the steps still open or parked. Two facts rather than one, because
    // "the run got this far" and "the last step line was about step n" stop
    // being the same sentence the moment a *finished* step is reopened: a
    // completed five-step run whose step 2 is reopened and re-closed ends on
    // `step-done 2`, and a fold that read only the last line would take the
    // run back to step 2 and never arm the join again.
    //
    // Both are kept beside `found` rather than on it because the completion
    // arithmetic is answered once, after the fold.
    //
    // Skew: no new marker — this is arithmetic over lines that already exist,
    // so a reader older than it degrades to the single-number fold. That fold
    // agrees everywhere except a middle step's reopen, where it leaves the
    // join un-armed rather than arming one it should not. The safe direction.
    let mut frontier: Option<u32> = None;
    let mut outstanding: BTreeSet<u32> = BTreeSet::new();
    for line in text.lines() {
        let Some((timestamp, name, marker, note)) = split_log_line(line) else {
            continue;
        };
        if name != dash {
            continue;
        }
        if is_terminal(marker, note) {
            found = DashDeclarations::default();
            frontier = None;
            outstanding.clear();
            continue;
        }
        // Every surviving line dates the dash, whatever it declares — including
        // markers this match ignores, which is what lets a `created` line give a
        // dash an age without giving it a stage.
        found.last_activity = Some(timestamp.to_owned());
        match marker {
            "step-start" | "step-done" | "step-withdrawn" | "step-reset" | "step-reopen" => {
                if let Some((current, total)) = read_step_fields(note) {
                    found.latest = Some(DashDeclaration::Step { current, total });
                    found.step = Some((current, total));
                    // The run's opening step, latched once per selection: the
                    // `run-through` line that began this run cleared it, so
                    // the first declaration after that line is where the run
                    // starts and every later one leaves it alone. Only under a
                    // declared run — a generation that never declared one has
                    // no selection for a first step to be the first *of*.
                    if found.run_through.is_some() {
                        found.run_first.get_or_insert(current);
                    }
                    match marker {
                        // The two markers that leave a step *open*. Both carry
                        // a title in the note's tail, and both put the step
                        // back among the outstanding, which is what un-arms
                        // the join: a reopened step means the run is no longer
                        // finished, and nothing but this line says so. The
                        // frontier is left alone — how far the run once got is
                        // not unlearned by reopening something behind it.
                        "step-start" | "step-reopen" => {
                            found.step_title = read_step_title(note, current);
                            found.step_in_flight = true;
                            outstanding.insert(current);
                        }
                        // A park neither opens nor closes. The step is not in
                        // flight and the run has not advanced past it, so the
                        // step stays outstanding exactly as a reopen leaves it
                        // — a selection with a parked step in it is not
                        // finished, whichever step it is.
                        "step-reset" => {
                            found.step_title = read_step_title(note, current);
                            found.step_in_flight = false;
                            outstanding.insert(current);
                        }
                        // The closes. A done note's tail is the round's sha,
                        // not a title — the start's title stays current until
                        // the next one. A withdrawal ends a step and advances
                        // the run exactly as a completion does, which is what
                        // keeps a dash whose final selected step was withdrawn
                        // joinable rather than wedged. The frontier only ever
                        // rises, so re-closing a reopened middle step settles
                        // its debt without dragging the run back to it.
                        _ => {
                            found.step_in_flight = false;
                            outstanding.remove(&current);
                            frontier = Some(frontier.map_or(current, |far| far.max(current)));
                        }
                    }
                }
            }
            "built" => found.latest = Some(DashDeclaration::Built),
            "audited" => found.latest = Some(DashDeclaration::Audited),
            "replayed" => found.last_replay = Some(note.to_owned()),
            "verified" => found.last_verified = Some(note.to_owned()),
            "run-through" => {
                found.run_through = note.trim().parse().ok();
                // A new selection is being declared: whatever step opened the
                // *previous* run is no longer this run's first.
                found.run_first = None;
            }
            _ => {}
        }
    }
    found.run_complete = match (frontier, found.run_through) {
        // Both halves are load-bearing: the run reached the end of its
        // selection, *and* nothing it passed on the way is open again.
        (Some(reached), Some(through)) => reached >= through && outstanding.is_empty(),
        _ => false,
    };
    found
}

/// Whether a dash has finished the work somebody asked it for, and so may be
/// offered for joining (Spec S02).
///
/// The whole point is that no chore stands between finishing and being offered:
/// the inputs are facts the dash already recorded, so a run that narrates
/// nothing still arms the arc. Three ways to be *armed*, one for each way work
/// is asked for:
///
/// 1. the declared selection finished — `done(m)` against the run's
///    `--through <m>` ([P01]);
/// 2. `built` or `audited` was declared — the hand-driven "I say it's done",
///    and the unblock for any generation whose log predates the declaration
///    ([P03]);
/// 3. the generation declared no steps at all — a plan-less dash, where every
///    committed round is itself the completed unit of asked work ([P02]).
///
/// A dash mid-step satisfies neither 1 nor 3, so an open step is never ready.
///
/// Dirt is measured over *tracked* paths only: the join's preamble commits
/// tracked changes, so an untracked scratch file must not hold the arc hostage
/// — the same distinction the join blockers draw. The dash's own plan is
/// excluded from that count by the callers ([`unfinished_tracked_dirt`]): the
/// step verb rewrites the ledger row *after* the round commits, so a finished
/// run always ends with its plan dirty, and counting that would leave every
/// completed selection permanently unready.
/// Tracked dirt that represents *unfinished work*, which is now all of it.
///
/// This once excluded the plan the dash was driving, because the ledger row a
/// step verb writes lands after the round it describes has already been
/// committed and a finished run would otherwise end with its plan dirty. The
/// plan is no longer in the worktree — it lives at
/// `<repo>/.tug/dashes/<name>/plan.md`, outside every tree git watches — so a
/// tracked edit in the worktree is work in flight and nothing else.
pub fn unfinished_tracked_dirt(dirt: &[String]) -> bool {
    !dirt.is_empty()
}

pub fn join_ready(
    rounds: u32,
    worktree_dirty_tracked: bool,
    joining: bool,
    decls: &DashDeclarations,
    has_plan: bool,
) -> bool {
    if joining || rounds < 1 || worktree_dirty_tracked {
        return false;
    }
    decls.run_complete
        || matches!(
            decls.latest,
            Some(DashDeclaration::Built) | Some(DashDeclaration::Audited)
        )
        // A plan-less dash arms on every round. A dash that adopted a plan
        // and has not yet declared a step is a run that has not started —
        // its one round is the adoption itself — and is not joinable.
        || (!has_plan && decls.step.is_none())
}

/// How far through the *declared run* a stepped dash has got: `(position,
/// length)`, both 1-based, position within the selection rather than within
/// the plan.
///
/// This is the number every glanceable counter shows. A run of steps 5–7 with
/// step 6 open answers `(2, 3)` — the unit the user asked for — while the
/// plan-absolute `6/10` stays available in [`DashDeclarations::step`] for the
/// ring, which draws the whole plan and lights this span across it.
///
/// `None` whenever the arithmetic cannot be trusted, and a display then falls
/// back to the plan's own counters: no declared run (every generation whose
/// log predates `--through`), no step declared yet, or a log whose shape
/// defeats the span — a `through` before the run's first step, which a
/// hand-edited log can produce and which must degrade rather than panic.
///
/// A finished selection pins position to length: the run's last `step-done`
/// leaves `step_current` at `through` already, so the clamp is belt rather
/// than braces, but it means a completed run reads `3/3` under every log shape
/// instead of drifting on an odd one.
pub fn run_fraction(decls: &DashDeclarations) -> Option<(u32, u32)> {
    let through = decls.run_through?;
    let first = decls.run_first?;
    let (current, _) = decls.step?;
    if through < first {
        return None;
    }
    let length = through - first + 1;
    let position = if decls.run_complete {
        length
    } else {
        current
            .saturating_sub(first)
            .saturating_add(1)
            .clamp(1, length)
    };
    Some((position, length))
}

/// Append the run's declared selection — the `--through <m>` of [P01], Spec S01.
///
/// Written by `step start` before the step's own declaration, and only when the
/// value differs from what the generation already declared, so re-entering an
/// interrupted step writes no duplicate.
pub fn append_run_through(repo_root: &Path, dash: &str, through: u32) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "run-through", &through.to_string())
}

/// Append a step declaration (Spec S01). `tail` is the step's title on a start
/// and the round's short sha on a done; the `i/N` prefix is written here so no
/// call site has to spell the note's grammar.
pub fn append_step_declaration(
    repo_root: &Path,
    dash: &str,
    phase: StepPhase,
    current: u32,
    total: u32,
    tail: &str,
) -> Result<(), TugError> {
    append_dash_log(
        repo_root,
        dash,
        phase.marker(),
        step_declaration_note(current, total, tail).trim(),
    )
}

/// The note a step declaration carries: the `i/N` token [`read_step_fields`]
/// reads, then whatever tail the phase wrote.
///
/// One function because there are now two writers — [`append_step_declaration`]
/// and `ops::write_step_pair`, which holds its log handle open across the
/// table's rename — and two spellings of one grammar is how a reader comes to
/// understand one of them and not the other.
pub fn step_declaration_note(current: u32, total: u32, tail: &str) -> String {
    format!("{current}/{total} {}", tail.trim())
}

/// Append a `built` or `audited` declaration (Spec S01, [P09]).
pub fn append_mark_declaration(
    repo_root: &Path,
    dash: &str,
    stage: MarkStage,
    note: &str,
) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, stage.marker(), note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// A scratch data dir plus the repo root whose dash-log it holds. Both
    /// live as long as the fixture; the data dir is redirected off the user's
    /// real one, which is why every test here is `#[serial]`.
    struct LogFixture {
        _home: tempfile::TempDir,
        repo: tempfile::TempDir,
    }

    impl LogFixture {
        fn root(&self) -> &Path {
            self.repo.path()
        }
    }

    /// Redirect the data dir and hand back a repo root whose project state dir
    /// holds `lines` as its dash-log. An empty `lines` writes no log at all.
    fn log_repo(lines: &str) -> LogFixture {
        let home = tempfile::tempdir().expect("tempdir");
        // SAFETY: these tests are #[serial]; no other thread reads the
        // environment concurrently while this runs.
        unsafe {
            std::env::set_var("TUG_DATA_DIR", home.path());
        }
        let repo = tempfile::tempdir().expect("tempdir");
        if !lines.is_empty() {
            let state = project_state_dir(repo.path());
            fs::create_dir_all(&state).expect("state dir");
            fs::write(state.join("dash-log.md"), lines).expect("write log");
        }
        LogFixture { _home: home, repo }
    }

    /// One log line in the shape [`append_dash_log`] writes.
    fn log_line(dash: &str, marker: &str, note: &str) -> String {
        log_line_at("2026-08-14T12:00:00Z", dash, marker, note)
    }

    /// The same, with the timestamp field spelled out — for the reads that are
    /// *about* the timestamp and need the lines to differ.
    fn log_line_at(at: &str, dash: &str, marker: &str, note: &str) -> String {
        format!("{at}  {dash}  {marker}  {note}\n")
    }

    #[test]
    fn a_tempdir_repo_without_a_redirect_is_refused() {
        let repo = tempfile::tempdir().expect("tempdir");
        assert!(temp_repo_without_redirect(repo.path(), None));
        assert!(temp_repo_without_redirect(
            repo.path(),
            Some(std::ffi::OsStr::new(""))
        ));
    }

    #[test]
    fn a_redirected_tempdir_repo_is_allowed() {
        let repo = tempfile::tempdir().expect("tempdir");
        let scratch = tempfile::tempdir().expect("tempdir");
        assert!(!temp_repo_without_redirect(
            repo.path(),
            Some(scratch.path().as_os_str())
        ));
    }

    #[test]
    fn a_repo_outside_the_temp_directory_is_allowed() {
        // The checkout this test is compiled from — a real project root.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(!temp_repo_without_redirect(repo, None));
    }

    #[test]
    #[serial]
    fn declarations_are_empty_without_a_log() {
        let fixture = log_repo("");
        assert_eq!(
            read_declarations(fixture.root(), "some-dash"),
            DashDeclarations::default()
        );
    }

    #[test]
    #[serial]
    fn a_later_step_start_demotes_a_built_dash() {
        let log = format!(
            "{}{}{}",
            log_line("d", "step-start", "1/9 Step 1: First"),
            log_line("d", "built", ""),
            log_line("d", "step-start", "2/9 Step 2: Second"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(
            found.latest,
            Some(DashDeclaration::Step {
                current: 2,
                total: 9
            })
        );
        assert_eq!(found.step, Some((2, 9)));
    }

    #[test]
    #[serial]
    fn a_step_survives_a_later_mark_for_the_step_fields() {
        let log = format!(
            "{}{}",
            log_line("d", "step-done", "3/9 a4477d5"),
            log_line("d", "built", "debug instance up"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.latest, Some(DashDeclaration::Built));
        assert_eq!(found.step, Some((3, 9)));
    }

    #[test]
    #[serial]
    fn a_step_start_carries_its_title_and_a_done_keeps_it() {
        let log = format!(
            "{}{}",
            log_line("d", "step-start", "3/9 Step 3: Wire the feed"),
            log_line("d", "step-done", "3/9 a4477d5"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.step, Some((3, 9)));
        assert_eq!(
            found.step_title.as_deref(),
            Some("Wire the feed"),
            "the start's title survives the done's sha tail"
        );
    }

    #[test]
    #[serial]
    fn a_declared_run_completes_when_its_final_step_is_done() {
        let log = format!(
            "{}{}{}{}{}",
            log_line("d", "run-through", "8"),
            log_line("d", "step-start", "6/15 Step 6: Sixth"),
            log_line("d", "step-done", "6/15 a4477d5"),
            log_line("d", "step-start", "7/15 Step 7: Seventh"),
            log_line("d", "step-done", "7/15 b5588e6"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_through, Some(8));
        assert!(!found.step_in_flight);
        assert!(!found.run_complete, "step 7 of a run through 8 is not done");

        let log = format!(
            "{}{}",
            log,
            log_line("d", "step-start", "8/15 Step 8: Eighth"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert!(found.step_in_flight, "the final step is open, not finished");
        assert!(!found.run_complete);

        let log = format!("{}{}", log, log_line("d", "step-done", "8/15 c6699f7"));
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert!(found.run_complete, "the declared selection finished");

        // A second run on the same dash re-declares and re-opens.
        let log = format!(
            "{}{}{}",
            log,
            log_line("d", "run-through", "12"),
            log_line("d", "step-start", "9/15 Step 9: Ninth"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_through, Some(12));
        assert!(found.step_in_flight);
        assert!(!found.run_complete);
    }

    #[test]
    #[serial]
    fn a_run_without_a_declaration_never_completes() {
        // Every generation whose log predates `--through`: steps done, no run
        // declared, so the completion arithmetic has nothing to compare against.
        let log = format!(
            "{}{}",
            log_line("d", "step-start", "1/2 Step 1: First"),
            log_line("d", "step-done", "1/2 a4477d5"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_through, None);
        assert!(!found.run_complete);

        // And a run-through with no step declaration yet is not complete either.
        let fixture = log_repo(&log_line("d", "run-through", "3"));
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_through, Some(3));
        assert!(!found.run_complete);
    }

    /// A `compact` line dates the dash and says nothing else. The readers are
    /// total by construction — `read_declarations` has a catch-all arm and
    /// `read_arc` reads only `arc-*` markers — so a new marker between two
    /// step declarations moves neither.
    #[test]
    #[serial]
    fn a_compact_marker_moves_no_declaration_and_no_arc_fact() {
        let without = format!(
            "{}{}{}",
            log_line("d", "run-through", "2"),
            log_line("d", "step-start", "1/2 Step 1: First"),
            log_line("d", "step-done", "1/2 a4477d5"),
        );
        let with = format!(
            "{}{}{}{}",
            log_line("d", "run-through", "2"),
            log_line("d", "step-start", "1/2 Step 1: First"),
            log_line("d", "compact", "0.73 > 0.60"),
            log_line("d", "step-done", "1/2 a4477d5"),
        );

        let plain = log_repo(&without);
        let expected = read_declarations(plain.root(), "d");
        let marked = log_repo(&with);
        assert_eq!(read_declarations(marked.root(), "d"), expected);

        let arc_log = format!(
            "{}{}{}",
            log_line("d", "arc-start", "brief.md"),
            log_line("d", "compact", "0.73 > 0.60"),
            log_line("d", "arc-note", "compacted at 0.73 > 0.60"),
        );
        let fixture = log_repo(&arc_log);
        let record = crate::arc::read_arc(fixture.root(), "d").expect("an arc");
        assert_eq!(record.notes, vec!["compacted at 0.73 > 0.60".to_string()]);
        assert!(record.stages.is_empty());
    }

    /// The run's first step is latched from the declaration that opens it, and
    /// re-latched by the next `run-through` — so a second selection on one dash
    /// reports its own span rather than the first one's.
    #[test]
    #[serial]
    fn the_run_latches_the_step_that_opened_it() {
        let first_run = format!(
            "{}{}{}",
            log_line("d", "run-through", "3"),
            log_line("d", "step-start", "1/10 Step 1: First"),
            log_line("d", "step-done", "1/10 a4477d5"),
        );
        let fixture = log_repo(&first_run);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_first, Some(1));
        assert_eq!(found.run_through, Some(3));

        // Later steps of the same run leave the latch alone.
        let first_run = format!(
            "{}{}",
            first_run,
            log_line("d", "step-start", "2/10 Step 2: Second"),
        );
        let fixture = log_repo(&first_run);
        assert_eq!(read_declarations(fixture.root(), "d").run_first, Some(1));

        // A second selection re-declares, and the latch moves to its opener.
        let second_run = format!(
            "{}{}{}{}",
            first_run,
            log_line("d", "step-done", "2/10 b5588e6"),
            log_line("d", "run-through", "7"),
            log_line("d", "step-start", "5/10 Step 5: Fifth"),
        );
        let fixture = log_repo(&second_run);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_first, Some(5));
        assert_eq!(found.run_through, Some(7));

        // A generation that declared no run has nothing to latch onto.
        let fixture = log_repo(&log_line("d", "step-start", "1/2 Step 1: First"));
        assert_eq!(read_declarations(fixture.root(), "d").run_first, None);

        // Nor does the window between a run's declaration and its first step.
        let fixture = log_repo(&log_line("d", "run-through", "3"));
        assert_eq!(read_declarations(fixture.root(), "d").run_first, None);
    }

    /// The number every glanceable counter shows: position within the declared
    /// selection, not within the plan.
    #[test]
    #[serial]
    fn the_run_fraction_counts_the_selection_not_the_plan() {
        // The case that opened this work: `Steps 1-3` of a ten-step plan.
        let log = format!(
            "{}{}",
            log_line("d", "run-through", "3"),
            log_line("d", "step-start", "1/10 Step 1: First"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.step, Some((1, 10)), "the plan pair is still recorded");
        assert_eq!(run_fraction(&found), Some((1, 3)), "but the run counts 1/3");

        // A mid-plan run is run-relative: steps 5-7 with step 6 open is 2 of 3.
        let log = format!(
            "{}{}{}{}",
            log_line("d", "run-through", "7"),
            log_line("d", "step-start", "5/10 Step 5: Fifth"),
            log_line("d", "step-done", "5/10 a4477d5"),
            log_line("d", "step-start", "6/10 Step 6: Sixth"),
        );
        let fixture = log_repo(&log);
        assert_eq!(
            run_fraction(&read_declarations(fixture.root(), "d")),
            Some((2, 3))
        );

        // A finished selection holds its full fraction.
        let log = format!(
            "{}{}{}{}",
            log,
            log_line("d", "step-done", "6/10 b5588e6"),
            log_line("d", "step-start", "7/10 Step 7: Seventh"),
            log_line("d", "step-done", "7/10 c6699f7"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert!(found.run_complete);
        assert_eq!(run_fraction(&found), Some((3, 3)));

        // A one-step run — every dash fixture in the app-tests — is 1 of 1,
        // which is also the shape where run and plan agree.
        let log = format!(
            "{}{}",
            log_line("d", "run-through", "1"),
            log_line("d", "step-start", "1/1 Step 1: Only"),
        );
        let fixture = log_repo(&log);
        assert_eq!(
            run_fraction(&read_declarations(fixture.root(), "d")),
            Some((1, 1))
        );
    }

    /// Every shape the arithmetic cannot be trusted on degrades to `None`, so
    /// the display falls back to the plan's own counters ([P05]).
    #[test]
    #[serial]
    fn an_untrustworthy_span_yields_no_run_fraction() {
        // No declared run at all — every log written before `--through`.
        let log = format!(
            "{}{}",
            log_line("d", "step-start", "1/2 Step 1: First"),
            log_line("d", "step-done", "1/2 a4477d5"),
        );
        let fixture = log_repo(&log);
        assert_eq!(run_fraction(&read_declarations(fixture.root(), "d")), None);

        // A run declared but not yet opened has no first step to measure from.
        let fixture = log_repo(&log_line("d", "run-through", "3"));
        assert_eq!(run_fraction(&read_declarations(fixture.root(), "d")), None);

        // A hand-edited log whose declaration order is reversed latches the
        // step before the run that should have cleared it, leaving `through`
        // behind `first`. Degrade, never panic.
        let log = format!(
            "{}{}",
            log_line("d", "step-start", "9/10 Step 9: Ninth"),
            log_line("d", "run-through", "3"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_first, None, "the declaration cleared the latch");
        assert_eq!(run_fraction(&found), None);

        // And the same collision with the latch intact: `through` < `first`.
        let log = format!(
            "{}{}{}",
            log_line("d", "run-through", "3"),
            log_line("d", "step-start", "9/10 Step 9: Ninth"),
            log_line("d", "step-done", "9/10 a4477d5"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_first, Some(9));
        assert_eq!(run_fraction(&found), None, "through 3 is before first 9");
    }

    #[test]
    #[serial]
    fn a_terminal_line_resets_the_run_facts() {
        let log = format!(
            "{}{}{}{}",
            log_line("d", "run-through", "2"),
            log_line("d", "step-start", "2/2 Step 2: Second"),
            log_line("d", "step-done", "2/2 a4477d5"),
            log_line("d", "a4477d5", "joined via card"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.run_through, None);
        assert_eq!(found.run_first, None);
        assert!(!found.run_complete);
        assert!(!found.step_in_flight);
        assert_eq!(run_fraction(&found), None);
    }

    #[test]
    #[serial]
    fn a_bare_step_start_reads_as_untitled() {
        let fixture = log_repo(&log_line("d", "step-start", "4/9"));
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.step, Some((4, 9)));
        assert_eq!(found.step_title, None);
    }

    #[test]
    #[serial]
    fn a_withdrawal_closes_the_run_as_a_completion_does() {
        let log = format!(
            "{}{}{}{}",
            log_line("d", "run-through", "8"),
            log_line("d", "step-start", "7/8 Step 7: Seventh"),
            log_line("d", "step-done", "7/8 a4477d5"),
            log_line("d", "step-withdrawn", "8/8 Step 8: Eighth"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert!(
            found.run_complete,
            "a dash whose final selected step was withdrawn is joinable, not wedged"
        );
        assert!(!found.step_in_flight);
        assert_eq!(
            found.latest,
            Some(DashDeclaration::Step {
                current: 8,
                total: 8
            })
        );
    }

    #[test]
    #[serial]
    fn a_withdrawal_leaves_the_runs_span_alone() {
        let log = format!(
            "{}{}{}{}",
            log_line("d", "run-through", "8"),
            log_line("d", "step-start", "7/8 Step 7: Seventh"),
            log_line("d", "step-withdrawn", "7/8 Step 7: Seventh"),
            log_line("d", "step-start", "8/8 Step 8: Eighth"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(
            found.run_first,
            Some(7),
            "the withdrawal is still the run's opener"
        );
        assert!(found.step_in_flight, "step 8 is open");
        assert!(!found.run_complete);
    }

    #[test]
    #[serial]
    fn a_withdrawal_after_a_terminal_line_starts_a_fresh_generation() {
        let log = format!(
            "{}{}{}{}{}",
            log_line("d", "run-through", "2"),
            log_line("d", "step-start", "2/2 Step 2: Second"),
            log_line("d", "step-done", "2/2 a4477d5"),
            log_line("d", "a4477d5", "joined via card"),
            log_line("d", "step-withdrawn", "1/4 Step 1: First"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(
            found.run_through, None,
            "the joined run's selection is gone"
        );
        assert_eq!(found.run_first, None);
        assert!(!found.run_complete, "no selection, so nothing to complete");
        assert_eq!(
            found.step,
            Some((1, 4)),
            "the fresh generation's own declaration stands"
        );
    }

    #[test]
    #[serial]
    fn a_reused_name_inherits_nothing_across_a_terminal_line() {
        for terminal in [
            log_line("d", "discarded", ""),
            log_line("d", "discarded", "via cli"),
            // The historical spelling. Every dash-log written before the verb
            // was renamed carries it, and the log is never rewritten, so this
            // arm is read forever.
            log_line("d", "released", ""),
            log_line("d", "released", "via cli"),
            log_line("d", "a4477d5", "joined"),
            // The route-suffixed note. A join recorded this way must still end
            // the generation; matching the note by equality instead of prefix
            // would leave the reused name carrying everything above.
            log_line("d", "a4477d5", "joined via card"),
            log_line("d", "a4477d5", "joined via cli"),
        ] {
            let log = format!(
                "{}{}{}{}",
                log_line("d", "step-done", "9/9 a4477d5"),
                log_line("d", "audited", ""),
                terminal,
                log_line("d", "abc1234", "a fresh round on the reused name"),
            );
            let fixture = log_repo(&log);
            let found = read_declarations(fixture.root(), "d");
            assert_eq!(
                DashDeclarations {
                    last_activity: None,
                    ..found.clone()
                },
                DashDeclarations::default(),
                "a new generation starts undeclared"
            );
            assert!(
                found.last_activity.is_some(),
                "but the round after the terminal line still dates the dash"
            );
        }
    }

    #[test]
    #[serial]
    fn a_logs_newest_line_dates_the_dash() {
        let log = format!(
            "{}{}{}",
            log_line_at("2026-08-10T09:00:00Z", "d", "created", ""),
            log_line_at(
                "2026-08-11T09:00:00Z",
                "d",
                "step-start",
                "1/2 Step 1: First"
            ),
            log_line_at("2026-08-12T09:00:00Z", "d", "built", ""),
        );
        let fixture = log_repo(&log);
        assert_eq!(
            read_declarations(fixture.root(), "d")
                .last_activity
                .as_deref(),
            Some("2026-08-12T09:00:00Z"),
        );
    }

    #[test]
    #[serial]
    fn a_terminal_line_resets_the_date() {
        let log = format!(
            "{}{}{}",
            log_line_at("2026-08-10T09:00:00Z", "d", "step-done", "2/2 a4477d5"),
            log_line_at("2026-08-11T09:00:00Z", "d", "released", ""),
            log_line_at("2026-08-12T09:00:00Z", "d", "created", ""),
        );
        let fixture = log_repo(&log);
        assert_eq!(
            read_declarations(fixture.root(), "d")
                .last_activity
                .as_deref(),
            Some("2026-08-12T09:00:00Z"),
            "the new generation's own age, not the released one's",
        );
    }

    #[test]
    #[serial]
    fn a_dash_with_no_surviving_lines_has_no_date() {
        let log = format!(
            "{}{}",
            log_line("d", "built", ""),
            log_line("d", "released", ""),
        );
        let fixture = log_repo(&log);
        assert_eq!(read_declarations(fixture.root(), "d").last_activity, None);
    }

    #[test]
    #[serial]
    fn a_created_marker_does_not_move_the_stage() {
        let fixture = log_repo(&log_line_at("2026-08-10T09:00:00Z", "d", "created", ""));
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.latest, None, "a birth record is not a declaration");
        assert_eq!(found.step, None);
        assert_eq!(
            found.last_activity.as_deref(),
            Some("2026-08-10T09:00:00Z"),
            "but it does date the dash",
        );
    }

    #[test]
    #[serial]
    fn an_unparseable_step_note_is_skipped() {
        let log = format!(
            "{}{}",
            log_line("d", "step-start", "1/9 Step 1: First"),
            log_line("d", "step-start", "nonsense"),
        );
        let fixture = log_repo(&log);
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.step, Some((1, 9)), "the garbage note is ignored");
    }

    #[test]
    #[serial]
    fn another_dashs_declarations_never_leak_in() {
        let log = format!(
            "{}{}",
            log_line("other", "audited", ""),
            log_line("d", "step-start", "1/2 Step 1: First"),
        );
        let fixture = log_repo(&log);
        assert_eq!(
            read_declarations(fixture.root(), "other").latest,
            Some(DashDeclaration::Audited)
        );
        assert_eq!(
            read_declarations(fixture.root(), "d").latest,
            Some(DashDeclaration::Step {
                current: 1,
                total: 2
            })
        );
    }

    #[test]
    #[serial]
    fn the_writers_round_trip_through_the_reader() {
        let fixture = log_repo("");
        let root = fixture.root();
        append_step_declaration(root, "d", StepPhase::Start, 2, 8, "Step 2: Second").unwrap();
        assert_eq!(
            read_declarations(root, "d").latest,
            Some(DashDeclaration::Step {
                current: 2,
                total: 8
            })
        );
        append_mark_declaration(root, "d", MarkStage::Built, "").unwrap();
        assert_eq!(
            read_declarations(root, "d").latest,
            Some(DashDeclaration::Built)
        );
        append_mark_declaration(root, "d", MarkStage::Audited, "good shape").unwrap();
        assert_eq!(
            read_declarations(root, "d").latest,
            Some(DashDeclaration::Audited)
        );
    }

    #[test]
    fn test_validate_dash_name_valid() {
        assert!(validate_dash_name("ab").is_ok());
        assert!(validate_dash_name("login-page").is_ok());
        assert!(validate_dash_name("fix-bug").is_ok());
        assert!(validate_dash_name("test-123").is_ok());
        assert!(validate_dash_name("a1").is_ok());
    }

    #[test]
    fn test_validate_dash_name_invalid() {
        // Too short
        assert!(validate_dash_name("a").is_err());

        // Reserved words
        assert!(validate_dash_name("discard").is_err());
        assert!(validate_dash_name("release").is_err());
        assert!(validate_dash_name("join").is_err());
        assert!(validate_dash_name("status").is_err());

        // Uppercase
        assert!(validate_dash_name("Login-Page").is_err());

        // Special chars
        assert!(validate_dash_name("login_page").is_err());
        assert!(validate_dash_name("login.page").is_err());

        // Leading hyphen
        assert!(validate_dash_name("-login").is_err());

        // Trailing hyphen
        assert!(validate_dash_name("login-").is_err());

        // Starts with digit
        assert!(validate_dash_name("1login").is_err());
    }
}

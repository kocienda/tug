//! Dash helpers — git-derived lightweight worktree work units.
//!
//! A dash *is* a git branch (`tugdash/<name>`) plus a worktree
//! (`.tug/worktrees/<name>`); its lifecycle and status derive from git, not
//! a database. This module holds the small shared helpers the `tugdash`
//! commands build on: name validation, default-branch detection, and the
//! append-only visibility log.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use tugutil_core::error::TugError;
use tugutil_core::paths::project_state_dir;
use tugutil_core::session::now_iso8601;

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
    refuse_unredirected_temp_repo(repo_root);
    let dir = project_state_dir(repo_root);
    fs::create_dir_all(&dir).map_err(TugError::Io)?;
    let path = dir.join("dash-log.md");

    let note = note.replace('\n', " ");
    let line = format!("{}  {}  {}  {}\n", now_iso8601(), dash, marker, note.trim());

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(TugError::Io)?;
    file.write_all(line.as_bytes()).map_err(TugError::Io)?;
    Ok(())
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
fn refuse_unredirected_temp_repo(repo_root: &Path) {
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
fn refuse_unredirected_temp_repo(_repo_root: &Path) {}

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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepPhase {
    Start,
    Done,
}

impl StepPhase {
    /// The log marker this phase writes.
    pub fn marker(self) -> &'static str {
        match self {
            StepPhase::Start => "step-start",
            StepPhase::Done => "step-done",
        }
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
    /// The timestamp of the newest surviving line for this dash's current
    /// generation — when the dash was last touched at all, by any writer. Reset
    /// with everything else at a terminal line, so a reused name reports its own
    /// generation's age. `None` when the generation has logged nothing.
    pub last_activity: Option<String>,
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
fn read_step_fields(note: &str) -> Option<(u32, u32)> {
    let token = note.split_whitespace().next()?;
    let (current, total) = token.split_once('/')?;
    Some((current.parse().ok()?, total.parse().ok()?))
}

/// The title a `step-start` note carries after its `i/N` token. The tail is
/// written as `Step {i}: {title}`, so that spelled-out prefix is stripped back
/// off; any other tail is kept verbatim. Empty reads as no title.
fn read_step_title(note: &str, current: u32) -> Option<String> {
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
pub fn read_declarations(repo_root: &Path, dash: &str) -> DashDeclarations {
    let path = project_state_dir(repo_root).join("dash-log.md");
    let Ok(text) = fs::read_to_string(&path) else {
        return DashDeclarations::default();
    };

    let mut found = DashDeclarations::default();
    for line in text.lines() {
        let Some((timestamp, name, marker, note)) = split_log_line(line) else {
            continue;
        };
        if name != dash {
            continue;
        }
        if is_terminal(marker, note) {
            found = DashDeclarations::default();
            continue;
        }
        // Every surviving line dates the dash, whatever it declares — including
        // markers this match ignores, which is what lets a `created` line give a
        // dash an age without giving it a stage.
        found.last_activity = Some(timestamp.to_owned());
        match marker {
            "step-start" | "step-done" => {
                if let Some((current, total)) = read_step_fields(note) {
                    found.latest = Some(DashDeclaration::Step { current, total });
                    found.step = Some((current, total));
                    // A done note's tail is the round's sha, not a title — the
                    // start's title stays current until the next start.
                    if marker == "step-start" {
                        found.step_title = read_step_title(note, current);
                    }
                }
            }
            "built" => found.latest = Some(DashDeclaration::Built),
            "audited" => found.latest = Some(DashDeclaration::Audited),
            "replayed" => found.last_replay = Some(note.to_owned()),
            _ => {}
        }
    }
    found
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
    let note = format!("{current}/{total} {}", tail.trim());
    append_dash_log(repo_root, dash, phase.marker(), note.trim())
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
    fn a_bare_step_start_reads_as_untitled() {
        let fixture = log_repo(&log_line("d", "step-start", "4/9"));
        let found = read_declarations(fixture.root(), "d");
        assert_eq!(found.step, Some((4, 9)));
        assert_eq!(found.step_title, None);
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

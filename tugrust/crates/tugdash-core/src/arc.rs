//! The arc record — what a server-driven dash arc is doing, kept as lines in
//! the dash-log.
//!
//! An arc opens on a *document* before any branch exists, so nothing git-scoped
//! can hold its record. The per-project dash-log already is what the arc needs:
//! append-only, keyed by dash name, and reset at every terminal line, so a
//! reused dash name is never born mid-arc. This module adds markers to that one
//! grammar and reads them back through one typed reader ([P01]).
//!
//! The record says what the arc is *doing*. Whose card it runs on is a separate
//! fact with its own home — the session↔dash binding in `sessions.db` — so no
//! line here names a tug session.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tugutil_core::config::DashConfig;
use tugutil_core::error::TugError;
use tugutil_core::paths::project_state_dir;

use crate::dash::{append_dash_log, is_terminal, split_log_line};

/// The three stages an arc rotates through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArcStage {
    Devise,
    Review,
    Implement,
}

impl ArcStage {
    /// How the stage is spelled in a log note and on the wire.
    pub fn as_str(&self) -> &'static str {
        match self {
            ArcStage::Devise => "devise",
            ArcStage::Review => "review",
            ArcStage::Implement => "implement",
        }
    }

    /// Read a stage back from its spelling. An unknown word is `None` rather
    /// than a guess — a line the reader cannot understand is skipped.
    pub fn parse(word: &str) -> Option<ArcStage> {
        match word {
            "devise" => Some(ArcStage::Devise),
            "review" => Some(ArcStage::Review),
            "implement" => Some(ArcStage::Implement),
            _ => None,
        }
    }
}

/// The model the project declared for a stage, or `None` for the account
/// default — which sends no `model_change` frame at all.
///
/// Shared rather than private to the runner because the stage label *is* the
/// role ([P05]): a `tugutil session rotate --stage review` resolves the model
/// the same way an arc's review stage does, and a second table would be the
/// same fact written twice.
pub fn stage_model(config: &DashConfig, stage: ArcStage) -> Option<String> {
    match stage {
        ArcStage::Devise => config.devise_model.clone(),
        ArcStage::Review => config.review_model.clone(),
        ArcStage::Implement => config.implement_model.clone(),
    }
}

/// One rotation: which stage started, on which claude session, under which
/// model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArcStageLine {
    pub stage: ArcStage,
    pub session_id: String,
    /// The model the stage was rotated with. `None` means the account default
    /// — the log spells that `-`, because a note field cannot be empty and
    /// still be read positionally.
    pub model: Option<String>,
    pub at: String,
}

/// What an arc's *current generation* of dash-log lines says about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArcRecord {
    pub dash: String,
    /// The document the arc opened on ([B14], [B16]).
    pub document: Option<String>,
    /// The plan path the runner named in the devise prompt ([P16]) —
    /// base-relative, and superseded by the worktree copy from adoption on.
    pub plan: Option<String>,
    /// Rotations in log order, current generation only.
    pub stages: Vec<ArcStageLine>,
    pub notes: Vec<String>,
    /// The stage the arc stopped in and why ([P11]). Cleared by the next
    /// rotation, because resuming a stopped arc *is* rotating it again.
    pub stopped: Option<(ArcStage, String)>,
    /// The stage a resume asked to rotate again ([P11]). Written by
    /// `tugutil dash run` on a stopped arc, and cleared by the next
    /// `arc-stage` line — the rotation it asked for.
    pub resume: Option<ArcStage>,
    pub done: bool,
    /// The newest surviving arc line's timestamp.
    pub last_activity: Option<String>,
}

impl ArcRecord {
    /// The stage the arc is in — the last one rotated.
    pub fn current_stage(&self) -> Option<ArcStage> {
        self.stages.last().map(|line| line.stage)
    }

    /// How many review rounds the arc has run, counted from the rotations
    /// rather than stored ([P06]). Two is the cap.
    pub fn review_rounds(&self) -> usize {
        self.stages
            .iter()
            .filter(|line| line.stage == ArcStage::Review)
            .count()
    }
}

/// Read the arc record for `dash`, or `None` when this dash has no arc — which
/// is every dash created by hand.
///
/// Applies the same generation reset [`crate::dash::read_declarations`] applies:
/// everything at or before the last terminal line for this dash is discarded.
pub fn read_arc(repo_root: &Path, dash: &str) -> Option<ArcRecord> {
    let path = project_state_dir(repo_root).join("dash-log.md");
    let text = std::fs::read_to_string(&path).ok()?;

    let mut found: Option<ArcRecord> = None;
    for line in text.lines() {
        let Some((timestamp, name, marker, note)) = split_log_line(line) else {
            continue;
        };
        if name != dash {
            continue;
        }
        if is_terminal(marker, note) {
            found = None;
            continue;
        }
        if !marker.starts_with("arc-") {
            continue;
        }
        let record = found.get_or_insert_with(|| ArcRecord {
            dash: dash.to_owned(),
            document: None,
            plan: None,
            stages: Vec::new(),
            notes: Vec::new(),
            stopped: None,
            resume: None,
            done: false,
            last_activity: None,
        });
        record.last_activity = Some(timestamp.to_owned());
        match marker {
            "arc-start" => record.document = Some(note.to_owned()),
            "arc-plan" => record.plan = Some(note.to_owned()),
            "arc-note" => record.notes.push(note.to_owned()),
            "arc-stage" => {
                if let Some(stage) = read_stage_line(note, timestamp) {
                    record.stopped = None;
                    record.resume = None;
                    record.stages.push(stage);
                }
            }
            "arc-stop" => {
                if let Some((stage, reason)) = read_stop_line(note) {
                    record.stopped = Some((stage, reason));
                }
            }
            "arc-resume" => {
                if let Some(stage) = ArcStage::parse(note.trim()) {
                    record.stopped = None;
                    record.resume = Some(stage);
                }
            }
            "arc-done" => record.done = true,
            _ => {}
        }
    }
    found
}

/// Read an `arc-stage` note: `<stage> <claude session id> <model or "->"`.
fn read_stage_line(note: &str, timestamp: &str) -> Option<ArcStageLine> {
    let mut fields = note.split_whitespace();
    let stage = ArcStage::parse(fields.next()?)?;
    let session_id = fields.next()?.to_owned();
    let model = match fields.next() {
        None | Some("-") => None,
        Some(model) => Some(model.to_owned()),
    };
    Some(ArcStageLine {
        stage,
        session_id,
        model,
        at: timestamp.to_owned(),
    })
}

/// Read an `arc-stop` note: `<stage> <reason>`. A stop with no reason reads as
/// an empty one rather than being dropped — the stage is the load-bearing half.
fn read_stop_line(note: &str) -> Option<(ArcStage, String)> {
    let (word, reason) = match note.split_once(char::is_whitespace) {
        Some((word, reason)) => (word, reason.trim()),
        None => (note.trim(), ""),
    };
    Some((ArcStage::parse(word)?, reason.to_owned()))
}

/// Append `arc-start` — the arc opened on this document.
pub fn append_arc_start(repo_root: &Path, dash: &str, document: &str) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-start", document)
}

/// Append `arc-stage` — a stage was rotated onto `session_id`.
pub fn append_arc_stage(
    repo_root: &Path,
    dash: &str,
    stage: ArcStage,
    session_id: &str,
    model: Option<&str>,
) -> Result<(), TugError> {
    let note = format!(
        "{} {} {}",
        stage.as_str(),
        session_id.trim(),
        model.map(str::trim).filter(|m| !m.is_empty()).unwrap_or("-")
    );
    append_dash_log(repo_root, dash, "arc-stage", &note)
}

/// Append `arc-plan` — the plan path the runner named ([P16]).
pub fn append_arc_plan(repo_root: &Path, dash: &str, plan: &str) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-plan", plan)
}

/// Append `arc-note` — a runner note, such as the review cap ([P06]).
pub fn append_arc_note(repo_root: &Path, dash: &str, note: &str) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-note", note)
}

/// Append `arc-stop` — the arc stopped in `stage` for `reason` ([P11]).
pub fn append_arc_stop(
    repo_root: &Path,
    dash: &str,
    stage: ArcStage,
    reason: &str,
) -> Result<(), TugError> {
    let note = format!("{} {}", stage.as_str(), reason.trim());
    append_dash_log(repo_root, dash, "arc-stop", note.trim())
}

/// Append `arc-resume` — a stopped arc was picked back up, and `stage` is the
/// one to rotate again ([P11]). Clears the stop; the rotation it asks for
/// clears it in turn.
pub fn append_arc_resume(repo_root: &Path, dash: &str, stage: ArcStage) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-resume", stage.as_str())
}

/// Append `arc-done` — the arc reached its terminal state ([P12]).
pub fn append_arc_done(repo_root: &Path, dash: &str) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-done", "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dash::{DashDeclarations, read_declarations};
    use serial_test::serial;
    use std::fs;

    #[test]
    fn a_stage_model_comes_from_the_projects_own_declaration() {
        let mut config = DashConfig::default();
        assert_eq!(stage_model(&config, ArcStage::Review), None);
        config.review_model = Some("opus".to_string());
        assert_eq!(
            stage_model(&config, ArcStage::Review),
            Some("opus".to_string())
        );
        assert_eq!(stage_model(&config, ArcStage::Devise), None);
    }

    /// A scratch data dir plus the repo root whose dash-log it holds — the same
    /// shape `dash.rs`'s tests use, and `#[serial]` for the same reason: the
    /// data dir is redirected through the environment.
    struct LogFixture {
        _home: tempfile::TempDir,
        repo: tempfile::TempDir,
    }

    impl LogFixture {
        fn root(&self) -> &Path {
            self.repo.path()
        }
    }

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

    fn log_line(dash: &str, marker: &str, note: &str) -> String {
        log_line_at("2026-08-24T12:00:00Z", dash, marker, note)
    }

    fn log_line_at(at: &str, dash: &str, marker: &str, note: &str) -> String {
        format!("{at}  {dash}  {marker}  {note}\n")
    }

    /// A full arc: opened on a brief, plan named, three stages, done.
    fn full_arc_log() -> String {
        [
            log_line_at("2026-08-24T10:00:00Z", "d", "arc-start", "dash/idea.md"),
            log_line_at("2026-08-24T10:01:00Z", "d", "arc-plan", "dash/d.md"),
            log_line_at("2026-08-24T10:02:00Z", "d", "arc-stage", "devise sess-1 opus"),
            log_line_at("2026-08-24T11:00:00Z", "d", "arc-stage", "review sess-2 fable"),
            log_line_at("2026-08-24T12:00:00Z", "d", "arc-stage", "implement sess-3 -"),
            log_line_at("2026-08-24T13:00:00Z", "d", "arc-done", ""),
        ]
        .concat()
    }

    #[test]
    #[serial]
    fn a_log_with_no_arc_lines_has_no_arc() {
        let fixture = log_repo(&log_line("d", "step-start", "1/3 Step 1: First"));
        assert_eq!(read_arc(fixture.root(), "d"), None);
    }

    #[test]
    #[serial]
    fn a_missing_log_has_no_arc() {
        let fixture = log_repo("");
        assert_eq!(read_arc(fixture.root(), "d"), None);
    }

    #[test]
    #[serial]
    fn a_full_arc_reads_back_document_plan_stages_and_done() {
        let fixture = log_repo(&full_arc_log());
        let arc = read_arc(fixture.root(), "d").expect("arc");
        assert_eq!(arc.dash, "d");
        assert_eq!(arc.document.as_deref(), Some("dash/idea.md"));
        assert_eq!(arc.plan.as_deref(), Some("dash/d.md"));
        assert_eq!(
            arc.stages
                .iter()
                .map(|line| (line.stage, line.session_id.as_str(), line.model.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (ArcStage::Devise, "sess-1", Some("opus")),
                (ArcStage::Review, "sess-2", Some("fable")),
                (ArcStage::Implement, "sess-3", None),
            ]
        );
        assert_eq!(arc.current_stage(), Some(ArcStage::Implement));
        assert_eq!(arc.review_rounds(), 1);
        assert!(arc.done);
        assert_eq!(arc.stopped, None);
        assert_eq!(arc.last_activity.as_deref(), Some("2026-08-24T13:00:00Z"));
    }

    #[test]
    #[serial]
    fn another_dashs_arc_lines_are_not_this_dashs() {
        let fixture = log_repo(&log_line("other", "arc-start", "dash/idea.md"));
        assert_eq!(read_arc(fixture.root(), "d"), None);
    }

    #[test]
    #[serial]
    fn an_arc_before_a_teardown_is_a_previous_generation() {
        let log = format!(
            "{}{}",
            full_arc_log(),
            log_line_at("2026-08-24T14:00:00Z", "d", "abc1234", "joined via card")
        );
        let fixture = log_repo(&log);
        assert_eq!(read_arc(fixture.root(), "d"), None);
    }

    #[test]
    #[serial]
    fn a_reused_name_reads_only_its_own_generation() {
        let log = format!(
            "{}{}{}",
            full_arc_log(),
            log_line_at("2026-08-24T14:00:00Z", "d", "abc1234", "joined via card"),
            log_line_at("2026-08-24T15:00:00Z", "d", "arc-start", "dash/next.md")
        );
        let fixture = log_repo(&log);
        let arc = read_arc(fixture.root(), "d").expect("arc");
        assert_eq!(arc.document.as_deref(), Some("dash/next.md"));
        assert!(arc.stages.is_empty());
        assert!(!arc.done);
    }

    #[test]
    #[serial]
    fn a_stop_reads_as_stopped_and_the_next_rotation_clears_it() {
        let stopped = format!(
            "{}{}",
            log_line_at("2026-08-24T10:00:00Z", "d", "arc-start", "dash/idea.md"),
            log_line_at("2026-08-24T10:05:00Z", "d", "arc-stop", "review lint failed")
        );
        let fixture = log_repo(&stopped);
        let arc = read_arc(fixture.root(), "d").expect("arc");
        assert_eq!(
            arc.stopped,
            Some((ArcStage::Review, "lint failed".to_owned()))
        );

        let resumed = format!(
            "{}{}",
            stopped,
            log_line_at("2026-08-24T10:10:00Z", "d", "arc-stage", "review sess-9 opus")
        );
        let fixture = log_repo(&resumed);
        let arc = read_arc(fixture.root(), "d").expect("arc");
        assert_eq!(arc.stopped, None);
        assert_eq!(arc.current_stage(), Some(ArcStage::Review));
    }

    #[test]
    #[serial]
    fn notes_accumulate_in_order() {
        let log = format!(
            "{}{}{}",
            log_line("d", "arc-start", "dash/idea.md"),
            log_line("d", "arc-note", "review cap reached"),
            log_line("d", "arc-note", "implement ran on the account default")
        );
        let fixture = log_repo(&log);
        let arc = read_arc(fixture.root(), "d").expect("arc");
        assert_eq!(
            arc.notes,
            vec![
                "review cap reached".to_owned(),
                "implement ran on the account default".to_owned()
            ]
        );
    }

    #[test]
    #[serial]
    fn an_unreadable_stage_line_is_skipped_not_guessed_at() {
        let log = format!(
            "{}{}{}",
            log_line("d", "arc-start", "dash/idea.md"),
            log_line("d", "arc-stage", "wander sess-1 opus"),
            log_line("d", "arc-stage", "devise")
        );
        let fixture = log_repo(&log);
        let arc = read_arc(fixture.root(), "d").expect("arc");
        assert!(arc.stages.is_empty());
    }

    #[test]
    #[serial]
    fn arc_lines_are_invisible_to_the_declarations_reader() {
        // The pin [P01] rests on: `read_declarations` matches its markers
        // exhaustively, so arc lines change nothing it reports — except the
        // timestamp every surviving line contributes.
        let bare = format!(
            "{}{}",
            log_line_at("2026-08-24T09:00:00Z", "d", "run-through", "3"),
            log_line_at("2026-08-24T09:01:00Z", "d", "step-start", "1/3 Step 1: First")
        );
        let with_arc = format!("{}{}", bare, full_arc_log());

        let fixture = log_repo(&bare);
        let without = read_declarations(fixture.root(), "d");
        let fixture = log_repo(&with_arc);
        let with = read_declarations(fixture.root(), "d");

        assert_ne!(without, DashDeclarations::default());
        assert_eq!(
            DashDeclarations {
                last_activity: with.last_activity.clone(),
                ..without
            },
            with
        );
        assert_eq!(with.last_activity.as_deref(), Some("2026-08-24T13:00:00Z"));
    }

    #[test]
    #[serial]
    fn a_discarded_dash_has_no_arc() {
        let fixture = log_repo("");
        let root = fixture.root();
        append_arc_start(root, "d", "dash/d-brief.md").unwrap();
        append_arc_stage(root, "d", ArcStage::Devise, "s1", None).unwrap();
        assert!(read_arc(root, "d").is_some());
        // Discard writes the dash's terminal marker; the arc record ends with
        // the dash, so a later `dash run` under the same name opens fresh
        // rather than resuming into a dash that no longer exists.
        append_dash_log(root, "d", "discarded", "").unwrap();
        assert_eq!(read_arc(root, "d"), None);
        append_arc_start(root, "d", "dash/d-brief.md").unwrap();
        let fresh = read_arc(root, "d").unwrap();
        assert!(fresh.stages.is_empty(), "the discarded arc's stages do not carry over");
    }

    #[test]
    fn the_append_helpers_round_trip_through_the_reader() {
        let fixture = log_repo("");
        let root = fixture.root();
        append_arc_start(root, "d", "dash/idea.md").expect("start");
        append_arc_plan(root, "d", "dash/d.md").expect("plan");
        append_arc_stage(root, "d", ArcStage::Devise, "sess-1", Some("opus")).expect("devise");
        append_arc_stage(root, "d", ArcStage::Review, "sess-2", None).expect("review");
        append_arc_note(root, "d", "second review skipped").expect("note");
        append_arc_stop(root, "d", ArcStage::Review, "plan still stale").expect("stop");

        let arc = read_arc(root, "d").expect("arc");
        assert_eq!(arc.document.as_deref(), Some("dash/idea.md"));
        assert_eq!(arc.plan.as_deref(), Some("dash/d.md"));
        assert_eq!(arc.stages.len(), 2);
        assert_eq!(arc.stages[1].model, None);
        assert_eq!(arc.notes, vec!["second review skipped".to_owned()]);
        assert_eq!(
            arc.stopped,
            Some((ArcStage::Review, "plan still stale".to_owned()))
        );
        assert!(!arc.done);

        // A resume clears the stop and names the stage to rotate again; the
        // rotation it asks for clears the resume.
        append_arc_resume(root, "d", ArcStage::Review).expect("resume");
        let arc = read_arc(root, "d").expect("arc");
        assert_eq!(arc.stopped, None);
        assert_eq!(arc.resume, Some(ArcStage::Review));
        append_arc_stage(root, "d", ArcStage::Review, "sess-3", None).expect("review again");
        let arc = read_arc(root, "d").expect("arc");
        assert_eq!(arc.resume, None);
        assert_eq!(arc.stages.len(), 3);

        append_arc_done(root, "d").expect("done");
        assert!(read_arc(root, "d").expect("arc").done);
    }
}

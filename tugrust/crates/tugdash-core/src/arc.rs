//! The arc record — what a server-driven dash arc is doing, kept as lines in
//! the dash-log.
//!
//! An arc opens on a *document* before any branch exists, so nothing git-scoped
//! can hold its record. The per-project dash-log already is what the arc needs:
//! append-only, keyed by dash name, and reset at every terminal line, so a
//! reused dash name is never born mid-arc. This module adds markers to that one
//! grammar and reads them back through one typed reader.
//!
//! The record says what the arc is *doing*. Whose card it runs on is a separate
//! fact with its own home — the session↔dash binding in `sessions.db` — so no
//! line here names a tug session.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tugtool_core::config::DashConfig;
use tugtool_core::error::TugError;
use tugtool_core::paths::project_state_dir;

use crate::dash::{append_dash_log, is_terminal, split_log_line};

/// Which progression a course runs — the *recorded* course kind, written when
/// the arc opens and never derived from what documents happen to be on disk.
///
/// The two kinds differ only in settling time ([B01]): a plan course spends
/// devise and review before any step is walked, a dash course goes straight to
/// implement and gets its cold read from the audit at the end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArcCourse {
    /// implement → audit. The task list is the implement stage's first act.
    Dash,
    /// devise → review → implement → audit.
    Plan,
}

impl ArcCourse {
    /// How the kind is spelled in the log note and on the `--course` flag.
    pub fn as_str(&self) -> &'static str {
        match self {
            ArcCourse::Dash => "dash",
            ArcCourse::Plan => "plan",
        }
    }

    /// Read a kind back from its spelling. An unknown word is `None` rather
    /// than a guess, exactly as [`ArcStage::parse`] is — a record whose kind
    /// cannot be read falls back to the document sniff, which is what every
    /// pre-kind dash already does.
    pub fn parse(word: &str) -> Option<ArcCourse> {
        match word {
            "dash" => Some(ArcCourse::Dash),
            "plan" => Some(ArcCourse::Plan),
            _ => None,
        }
    }
}

/// The stages an arc rotates through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArcStage {
    Devise,
    Review,
    Implement,
    /// Read the implemented code cold against the plan it was written from,
    /// fix what does not match, and mark the dash `audited`.
    ///
    /// It is a stage rather than the implement stage's last step for the same
    /// reason review is one: the session that wrote the code is the weakest
    /// possible reader of it, and a fresh one opening on the plan and the
    /// branch's diff has nothing to defend.
    Audit,
}

impl ArcStage {
    /// How the stage is spelled in a log note and on the wire.
    pub fn as_str(&self) -> &'static str {
        match self {
            ArcStage::Devise => "devise",
            ArcStage::Review => "review",
            ArcStage::Implement => "implement",
            ArcStage::Audit => "audit",
        }
    }

    /// Read a stage back from its spelling. An unknown word is `None` rather
    /// than a guess — a line the reader cannot understand is skipped.
    pub fn parse(word: &str) -> Option<ArcStage> {
        match word {
            "devise" => Some(ArcStage::Devise),
            "review" => Some(ArcStage::Review),
            "implement" => Some(ArcStage::Implement),
            "audit" => Some(ArcStage::Audit),
            _ => None,
        }
    }
}

/// Every reason an arc can stop for.
///
/// Closed on purpose. A stop is written into the dash-log and read back to the
/// user as a sentence on the card, so a reason the receipt cannot explain is a
/// reason the arc must not write — and the only way to make that a fact rather
/// than a hope is to let the compiler check it. Both accessors match
/// exhaustively and neither has a fallback arm.
///
/// The read side stays a `String`: [`ArcRecord::stopped`] holds whatever word
/// the log carries, so a record written by an older build still parses and
/// still prints its own wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArcStopReason {
    Lint,
    ApiError,
    ReviewDidNotStamp,
    /// The audit stage ended its turn without marking the dash `audited`. The
    /// mark is the stage's whole product, exactly as the stamp is the
    /// review's, so a turn that ends without one has answered nothing.
    AuditDidNotMark,
    DocumentMissing,
    PlanMissing,
    SessionGone,
    CardTaken,
    CardClosed,
    StoppedByUser,
    /// The dash was discarded. Never written to the log — the discard's own
    /// terminal line already closed the arc's generation, and a line after it
    /// would open a phantom one. This variant exists for its sentence.
    Discarded,
    /// The dash joined and the work landed. Never written to the log, for the
    /// same reason as [`ArcStopReason::Discarded`].
    Joined,
    PromptUnavailable,
    SessionIdle,
    SessionErrored,
    SessionClosed,
    SpawnQueueFull,
    NoStdin,
    StdinClosed,
    ArcRunning,
    /// A `/compact` turn the arc sent ended in an API error, so the context
    /// was never reduced. Distinct from [`ArcStopReason::ApiError`] because
    /// the fix differs: the compaction is retried, not the work.
    CompactFailed,
    /// The implement stage ended the quiet-turn horizon of turns without
    /// closing a step.
    ///
    /// The stage is alive, its turns are ending, and the Step Status Ledger is
    /// not moving — a wandering stage, or one that finished the work and never
    /// ran `dash step done`. Before this the arc simply decided nothing, tick
    /// after tick, which is the loudest of the silent wedges: an unattended
    /// run that sits with no receipt and no gesture to answer it.
    ///
    /// Resumable, and the receipt names the resume — the stop is a hand-back
    /// with a sentence, deliberately not a re-prompt. Re-prompting a stage
    /// that has twice declined to close a step is asking the same question
    /// louder; handing the card back is what puts a person in front of it.
    ImplementIdle,
    /// The arc's clock ran out: no turn ended, no step closed, and the runner
    /// did nothing, for the whole of the stall deadline.
    ///
    /// The one stop measured against a wall clock. Every other arm is decided
    /// on an edge, and the two shapes this catches produce no edge at all: a
    /// stage hung mid-turn (`session_idle` never becomes true, so nothing
    /// downstream is ever consulted) and a stage that ends one turn without
    /// closing a step and then goes silent (the quiet-turn horizon sits at 1
    /// forever, because it too counts turns that end).
    ///
    /// Resumable, and spoken like every other stop. Skew: an older reader
    /// takes the note as the free-text string it already was, so this word
    /// costs it nothing — `ArcRecord::stopped` has always carried a `String`.
    Stalled,
}

impl ArcStopReason {
    /// Every variant, so a test can walk the vocabulary. A new reason is added
    /// here as well as to the enum; the exhaustive matches below are what the
    /// compiler enforces.
    pub const ALL: &'static [ArcStopReason] = &[
        ArcStopReason::Lint,
        ArcStopReason::ApiError,
        ArcStopReason::ReviewDidNotStamp,
        ArcStopReason::AuditDidNotMark,
        ArcStopReason::DocumentMissing,
        ArcStopReason::PlanMissing,
        ArcStopReason::SessionGone,
        ArcStopReason::CardTaken,
        ArcStopReason::CardClosed,
        ArcStopReason::StoppedByUser,
        ArcStopReason::Discarded,
        ArcStopReason::Joined,
        ArcStopReason::PromptUnavailable,
        ArcStopReason::SessionIdle,
        ArcStopReason::SessionErrored,
        ArcStopReason::SessionClosed,
        ArcStopReason::SpawnQueueFull,
        ArcStopReason::NoStdin,
        ArcStopReason::StdinClosed,
        ArcStopReason::ArcRunning,
        ArcStopReason::CompactFailed,
        ArcStopReason::ImplementIdle,
        ArcStopReason::Stalled,
    ];

    /// The word written into `arc-stop`'s note.
    pub fn as_str(&self) -> &'static str {
        match self {
            ArcStopReason::Lint => "lint",
            ArcStopReason::ApiError => "api error",
            ArcStopReason::ReviewDidNotStamp => "review did not stamp",
            ArcStopReason::AuditDidNotMark => "audit did not mark",
            ArcStopReason::DocumentMissing => "document missing",
            ArcStopReason::PlanMissing => "plan missing",
            ArcStopReason::SessionGone => "session gone",
            ArcStopReason::CardTaken => "card taken",
            ArcStopReason::CardClosed => "card closed",
            ArcStopReason::StoppedByUser => "stopped by user",
            ArcStopReason::Discarded => "discarded",
            ArcStopReason::Joined => "joined",
            ArcStopReason::PromptUnavailable => "prompt unavailable",
            ArcStopReason::SessionIdle => "session idle",
            ArcStopReason::SessionErrored => "session errored",
            ArcStopReason::SessionClosed => "session closed",
            ArcStopReason::SpawnQueueFull => "spawn queue full",
            ArcStopReason::NoStdin => "no stdin",
            ArcStopReason::StdinClosed => "stdin closed",
            ArcStopReason::ArcRunning => "arc running",
            ArcStopReason::CompactFailed => "compact failed",
            ArcStopReason::ImplementIdle => "implement idle",
            ArcStopReason::Stalled => "stalled",
        }
    }

    /// What the receipt says, in the second person, as the tail of
    /// "the arc stopped … because …".
    pub fn sentence(&self) -> &'static str {
        match self {
            ArcStopReason::Lint => "the plan does not lint",
            ArcStopReason::ApiError => "its turn ended in an API error, not a response",
            ArcStopReason::ReviewDidNotStamp => "two review rounds ended without stamping the plan",
            ArcStopReason::AuditDidNotMark => "the audit ended without marking the dash audited",
            ArcStopReason::DocumentMissing => "the document it opened on is gone",
            ArcStopReason::PlanMissing => "the plan is gone",
            ArcStopReason::SessionGone => "its session ended",
            ArcStopReason::CardTaken => "you took the card back",
            ArcStopReason::CardClosed => "the card it ran on closed",
            ArcStopReason::StoppedByUser => "you stopped it",
            ArcStopReason::Discarded => "the dash was discarded",
            ArcStopReason::Joined => "the dash joined and the work landed",
            ArcStopReason::PromptUnavailable => "its opening prompt could not be composed",
            ArcStopReason::SessionIdle => "its session had no claude running to rotate",
            ArcStopReason::SessionErrored => "its session errored out",
            ArcStopReason::SessionClosed => "its session was closed",
            ArcStopReason::SpawnQueueFull => "the card's spawn queue was full",
            ArcStopReason::NoStdin => "the card's session had no input channel",
            ArcStopReason::StdinClosed => "the card's input channel closed",
            ArcStopReason::ArcRunning => "the card was already running another score",
            ArcStopReason::CompactFailed => {
                "its /compact turn ended in an API error, so the context was never reduced"
            }
            ArcStopReason::ImplementIdle => {
                "the implement stage ended two turns without closing a step"
            }
            ArcStopReason::Stalled => {
                "it went silent — no turn ended and no step closed before the arc's clock ran out"
            }
        }
    }

    /// Whether a stop for this reason leaves anything to resume. The two
    /// endings do not: the dash itself is gone, and `read_arc` resets at their
    /// terminal line, so `tugtool dash run` would open a new arc rather than
    /// pick this one up.
    pub fn is_resumable(&self) -> bool {
        !matches!(self, ArcStopReason::Discarded | ArcStopReason::Joined)
    }
}

/// The model the project declared for a stage, or `None` for the account
/// default — which sends no `model_change` frame at all.
///
/// Shared rather than private to the runner because the stage label *is* the
/// role: a `tugtool session rotate --stage review` resolves the model
/// the same way an arc's review stage does, and a second table would be the
/// same fact written twice.
pub fn stage_model(config: &DashConfig, stage: ArcStage) -> Option<String> {
    match stage {
        ArcStage::Devise => config.devise_model.clone(),
        ArcStage::Review => config.review_model.clone(),
        ArcStage::Implement => config.implement_model.clone(),
        ArcStage::Audit => config.audit_model.clone(),
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
    /// The document the arc opened on.
    pub document: Option<String>,
    /// The progression this course runs, recorded when the arc opened.
    ///
    /// `None` is a **pre-kind dash** — an arc opened by a build that had no
    /// `arc-course` marker to write. Its reader falls back to sniffing the
    /// documents, which is what every arc did before this marker existed.
    pub course: Option<ArcCourse>,
    /// The plan path the runner named in the devise prompt —
    /// base-relative, and superseded by the worktree copy from adoption on.
    pub plan: Option<String>,
    /// Rotations in log order, current generation only.
    pub stages: Vec<ArcStageLine>,
    pub notes: Vec<String>,
    /// The stage the arc stopped in and why. Cleared by the next
    /// rotation, because resuming a stopped arc *is* rotating it again.
    pub stopped: Option<(ArcStage, String)>,
    /// The stage a resume asked to rotate again. Written by
    /// `tugtool dash run` on a stopped arc, and cleared by the next
    /// `arc-stage` line — the rotation it asked for.
    pub resume: Option<ArcStage>,
    /// A rotation the runner dispatched whose `arc-stage` line has not landed.
    ///
    /// The wheel's dispatch and the bridge's announcement are two acts with a
    /// gap between them, and only the bridge can write the `arc-stage` line —
    /// it names a claude session id nobody knows until claude announces it.
    /// Within one tugcast the runner's own in-flight guard covers that gap;
    /// across a restart it does not exist, and the restarted seat used to read
    /// as a *taken card*: a session the record does not name, carrying no
    /// stage label, which is exactly what a user's `/new` looks like. A wrong
    /// stop, and a spoken one.
    ///
    /// So the intent is written down before the wheel fires, and cleared by
    /// the `arc-stage` line it was the intent to produce. A record still
    /// carrying one says "re-rotate this stage", not "the card was taken".
    pub dispatched: Option<ArcStage>,
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
    /// rather than stored. Two is the cap.
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
            course: None,
            plan: None,
            stages: Vec::new(),
            notes: Vec::new(),
            stopped: None,
            resume: None,
            dispatched: None,
            done: false,
            last_activity: None,
        });
        record.last_activity = Some(timestamp.to_owned());
        match marker {
            "arc-start" => record.document = Some(note.to_owned()),
            // **Skew.** An older reader falls through the `_` arm below and
            // keeps sniffing the documents for the progression — which is the
            // behavior this marker replaces, so the degradation is exactly
            // today's. A newer reader over a pre-kind log finds no marker and
            // takes the same fallback. Neither direction can invent a course
            // the other did not intend.
            "arc-course" => record.course = ArcCourse::parse(note.trim()),
            "arc-plan" => record.plan = Some(note.to_owned()),
            "arc-note" => record.notes.push(note.to_owned()),
            "arc-stage" => {
                if let Some(stage) = read_stage_line(note, timestamp) {
                    record.stopped = None;
                    record.resume = None;
                    // The announcement this dispatch was the intent to
                    // produce. Cleared here and only here, so the gap the
                    // marker exists to describe is exactly the gap it covers.
                    record.dispatched = None;
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
            // **Skew.** A reader older than this marker falls through the `_`
            // arm below: it dates the dash from the line and declares nothing
            // from it, which is what every older reader has always done with a
            // marker it did not know. `read_declarations` degrades the same
            // way. So the direction is safe — an old reader keeps the false
            // `CardTaken` it already had, and never invents a stop it did not
            // have before.
            "arc-dispatch" => record.dispatched = ArcStage::parse(note.trim()),
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

/// Append `arc-course` — the progression this arc runs.
///
/// A line of its own rather than a second field on `arc-start`, because
/// `arc-start`'s note is a path read whole: appending to it would make an
/// older reader take `dash/idea.md plan` for the document's name. A marker an
/// old reader does not know is skipped; a note it misreads is not.
pub fn append_arc_course(repo_root: &Path, dash: &str, course: ArcCourse) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-course", course.as_str())
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
        model
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or("-")
    );
    append_dash_log(repo_root, dash, "arc-stage", &note)
}

/// Append `arc-dispatch` — a rotation to `stage` is about to be sent.
///
/// Written *before* the wheel fires, because the whole of its worth is in the
/// gap after it: a crash between the dispatch and the bridge's `arc-stage`
/// line leaves a seat the record cannot explain, and this is the line that
/// explains it. The `arc-stage` it anticipates clears it.
pub fn append_arc_dispatch(repo_root: &Path, dash: &str, stage: ArcStage) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-dispatch", stage.as_str())
}

/// Append `arc-plan` — the plan path the runner named.
pub fn append_arc_plan(repo_root: &Path, dash: &str, plan: &str) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-plan", plan)
}

/// Append `arc-note` — a runner note, such as the review cap.
pub fn append_arc_note(repo_root: &Path, dash: &str, note: &str) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-note", note)
}

/// Append `arc-stop` — the arc stopped in `stage` for `reason`.
pub fn append_arc_stop(
    repo_root: &Path,
    dash: &str,
    stage: ArcStage,
    reason: ArcStopReason,
) -> Result<(), TugError> {
    let note = format!("{} {}", stage.as_str(), reason.as_str());
    append_dash_log(repo_root, dash, "arc-stop", note.trim())
}

/// Append `arc-resume` — a stopped arc was picked back up, and `stage` is the
/// one to rotate again. Clears the stop; the rotation it asks for
/// clears it in turn.
pub fn append_arc_resume(repo_root: &Path, dash: &str, stage: ArcStage) -> Result<(), TugError> {
    append_dash_log(repo_root, dash, "arc-resume", stage.as_str())
}

/// Append `arc-done` — the arc reached its terminal state.
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

    /// **`arc-dispatch` marks the gap and the `arc-stage` closes it.**
    ///
    /// The line exists for exactly one window: after the wheel fires and
    /// before the bridge writes the announcement, which is the only writer
    /// that can — the announcement names a claude session id nobody knows
    /// until claude announces it. A record still carrying a dispatch says a
    /// rotation was tried and never landed.
    #[serial]
    #[test]
    fn a_dispatch_stands_until_the_stage_it_anticipates_announces() {
        let fixture = log_repo("");
        let root = fixture.root();

        append_arc_start(root, "d", "dash/idea.md").unwrap();
        append_arc_dispatch(root, "d", ArcStage::Implement).unwrap();

        let record = read_arc(root, "d").unwrap();
        assert_eq!(
            record.dispatched,
            Some(ArcStage::Implement),
            "the intent stands while the gap is open"
        );
        assert!(record.stages.is_empty());

        append_arc_stage(root, "d", ArcStage::Implement, "sess-9", None).unwrap();
        let record = read_arc(root, "d").unwrap();
        assert_eq!(
            record.dispatched, None,
            "and the announcement it anticipated closes it"
        );
        assert_eq!(record.stages.len(), 1);
    }

    /// **The course kind is recorded, and a log without one reads `None`.**
    /// That `None` is the whole of the pre-kind story: the runner falls back
    /// to sniffing the documents for it, which is what it did before.
    #[serial]
    #[test]
    fn a_recorded_course_kind_reads_back_and_its_absence_is_the_pre_kind_dash() {
        let fixture = log_repo("");
        let root = fixture.root();

        append_arc_start(root, "d", "dash/idea.md").unwrap();
        assert_eq!(
            read_arc(root, "d").unwrap().course,
            None,
            "an arc-start alone is a pre-kind dash"
        );

        append_arc_course(root, "d", ArcCourse::Dash).unwrap();
        let record = read_arc(root, "d").unwrap();
        assert_eq!(record.course, Some(ArcCourse::Dash));
        assert_eq!(
            record.document.as_deref(),
            Some("dash/idea.md"),
            "and the kind is a line of its own, so the document is unharmed"
        );
    }

    /// **An unreadable kind degrades to the fallback, never to a guess.** A
    /// record written by a build that spells a third kind reads `None` here,
    /// which is exactly a pre-kind dash — the one behavior every reader in
    /// the tree already knows how to take.
    #[serial]
    #[test]
    fn a_course_kind_this_build_cannot_read_is_a_pre_kind_dash() {
        let fixture = log_repo(
            &[
                log_line("d", "arc-start", "dash/idea.md"),
                log_line("d", "arc-course", "expedition"),
            ]
            .concat(),
        );
        assert_eq!(read_arc(fixture.root(), "d").unwrap().course, None);
    }

    /// **The skew direction.** The marker is new, so every reader older than
    /// it must fall through untroubled. `read_declarations` shares the log and
    /// knows nothing of `arc-*` markers at all: it dates the dash from the
    /// line, exactly as it does for `arc-stage`, and declares nothing from it.
    ///
    /// An old `read_arc` does the same through its own `_` arm — which this
    /// cannot drive from here, so what it pins is the half that shares a file
    /// with everything else.
    #[serial]
    #[test]
    fn a_dispatch_line_moves_no_declaration() {
        let steps = [
            log_line_at("2026-08-24T10:00:00Z", "d", "run-through", "2"),
            log_line_at("2026-08-24T10:01:00Z", "d", "step-start", "1/2 Step 1: One"),
            log_line_at("2026-08-24T10:02:00Z", "d", "step-done", "1/2 abc1234"),
        ]
        .concat();
        let fixture = log_repo(&steps);
        let root = fixture.root();
        let before = read_declarations(root, "d");
        assert_eq!(
            before.last_activity.as_deref(),
            Some("2026-08-24T10:02:00Z")
        );

        let with_dispatch = [
            steps,
            log_line_at("2026-08-24T10:03:00Z", "d", "arc-dispatch", "implement"),
        ]
        .concat();
        let fixture = log_repo(&with_dispatch);
        let root = fixture.root();
        let after = read_declarations(root, "d");

        assert_eq!(after.step, before.step);
        assert_eq!(after.run_through, before.run_through);
        assert_eq!(after.run_complete, before.run_complete);
        assert_eq!(after.step_in_flight, before.step_in_flight);
        assert_eq!(
            after.last_activity.as_deref(),
            Some("2026-08-24T10:03:00Z"),
            "it dates the dash, as every line does, and declares nothing"
        );
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
            log_line_at(
                "2026-08-24T10:02:00Z",
                "d",
                "arc-stage",
                "devise sess-1 opus",
            ),
            log_line_at(
                "2026-08-24T11:00:00Z",
                "d",
                "arc-stage",
                "review sess-2 fable",
            ),
            log_line_at(
                "2026-08-24T12:00:00Z",
                "d",
                "arc-stage",
                "implement sess-3 -",
            ),
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
            log_line_at(
                "2026-08-24T10:05:00Z",
                "d",
                "arc-stop",
                "review lint failed"
            )
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
            log_line_at(
                "2026-08-24T10:10:00Z",
                "d",
                "arc-stage",
                "review sess-9 opus"
            )
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
        // The pin rests on: `read_declarations` matches its markers
        // exhaustively, so arc lines change nothing it reports — except the
        // timestamp every surviving line contributes.
        let bare = format!(
            "{}{}",
            log_line_at("2026-08-24T09:00:00Z", "d", "run-through", "3"),
            log_line_at(
                "2026-08-24T09:01:00Z",
                "d",
                "step-start",
                "1/3 Step 1: First"
            )
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
        assert!(
            fresh.stages.is_empty(),
            "the discarded arc's stages do not carry over"
        );
    }

    #[test]
    fn every_stop_reason_has_a_sentence_and_a_word() {
        let mut words = std::collections::HashSet::new();
        let mut sentences = std::collections::HashSet::new();
        for reason in ArcStopReason::ALL {
            assert!(!reason.as_str().is_empty(), "{reason:?} has no log word");
            assert!(!reason.sentence().is_empty(), "{reason:?} has no sentence");
            assert!(
                words.insert(reason.as_str()),
                "{reason:?} repeats another reason's log word",
            );
            assert!(
                sentences.insert(reason.sentence()),
                "{reason:?} repeats another reason's sentence",
            );
        }
        // The two endings are the only reasons with nothing to resume.
        let unresumable: Vec<_> = ArcStopReason::ALL
            .iter()
            .filter(|reason| !reason.is_resumable())
            .collect();
        assert_eq!(
            unresumable,
            vec![&ArcStopReason::Discarded, &ArcStopReason::Joined],
        );
    }

    #[test]
    fn a_two_word_reason_survives_the_stage_first_split() {
        // `read_stop_line` splits on the first whitespace and keeps the rest
        // verbatim, so a reason spelled in two words reads back whole — the
        // way `api error` already does.
        assert_eq!(
            read_stop_line("implement compact failed"),
            Some((ArcStage::Implement, "compact failed".to_string())),
        );
        assert_eq!(
            ArcStopReason::CompactFailed.as_str(),
            "compact failed",
            "the log word is what a stop line carries",
        );
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
        append_arc_stop(
            root,
            "d",
            ArcStage::Review,
            ArcStopReason::ReviewDidNotStamp,
        )
        .expect("stop");

        let arc = read_arc(root, "d").expect("arc");
        assert_eq!(arc.document.as_deref(), Some("dash/idea.md"));
        assert_eq!(arc.plan.as_deref(), Some("dash/d.md"));
        assert_eq!(arc.stages.len(), 2);
        assert_eq!(arc.stages[1].model, None);
        assert_eq!(arc.notes, vec!["second review skipped".to_owned()]);
        assert_eq!(
            arc.stopped,
            Some((ArcStage::Review, "review did not stamp".to_owned()))
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

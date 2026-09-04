//! The arc record — what a server-driven arc is doing, kept as lines in the
//! arc log.
//!
//! An arc opens on a *document* before any branch exists, so nothing git-scoped
//! can hold its record. The per-project arc log already is what the arc needs:
//! append-only, keyed by arc name, and reset at every terminal line, so a
//! reused arc name is never born mid-arc. This module adds markers to that one
//! grammar and reads them back through one typed reader.
//!
//! The record says what the arc is *doing*. Whose card it runs on is a separate
//! fact with its own home — the session↔arc binding in `sessions.db` — so no
//! line here names a tug session.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tugtool_core::config::ArcConfig;
use tugtool_core::error::TugError;

use crate::log::{append_arc_log, is_terminal, split_log_line};

/// Which kind of arc this is — the *recorded* kind, written when the arc opens
/// and never derived from what documents happen to be on disk.
///
/// The two kinds differ only in settling time ([B01]): a planned arc spends
/// devise and review before any step is walked, a plain arc opens at implement
/// and gets its cold read from the audit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArcKind {
    /// implement → audit. The task list is the implement stage's first act.
    Plain,
    /// devise → review → implement → audit.
    Planned,
}

impl ArcKind {
    /// How the kind is spelled in the log note.
    pub fn as_str(&self) -> &'static str {
        match self {
            ArcKind::Plain => "plain",
            ArcKind::Planned => "planned",
        }
    }

    /// Read a kind back from its spelling. An unknown word is `None` rather
    /// than a guess, exactly as [`ArcStage::parse`] is — a record whose kind
    /// cannot be read falls back to the document sniff, which is what every
    /// pre-kind arc already does.
    pub fn parse(word: &str) -> Option<ArcKind> {
        match word {
            "plain" => Some(ArcKind::Plain),
            "planned" => Some(ArcKind::Planned),
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
    /// fix what does not match, and mark the arc `audited`.
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
/// Closed on purpose. A stop is written into the arc log and read back to the
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
    /// The audit stage ended its turn without marking the arc `audited`. The
    /// mark is the stage's whole product, exactly as the stamp is the
    /// review's, so a turn that ends without one has answered nothing.
    AuditDidNotMark,
    DocumentMissing,
    PlanMissing,
    SessionGone,
    CardTaken,
    CardClosed,
    StoppedByUser,
    /// The arc was discarded. Never written to the log — the discard's own
    /// terminal line already closed the arc's generation, and a line after it
    /// would open a phantom one. This variant exists for its sentence.
    Discarded,
    /// The arc joined and the work landed. Never written to the log, for the
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
    /// The implement stage was asked twice — the wheel's original ask and the
    /// re-ask that answers the first quiet turn — and closed no step either
    /// time.
    ///
    /// The stage is alive, its turns are ending, and the Step Status Ledger is
    /// not moving — a wandering stage, or one that finished the work and never
    /// ran `arc step done`. Before this the arc simply decided nothing, tick
    /// after tick, which is the loudest of the silent wedges: an unattended
    /// run that sits with no receipt and no gesture to answer it.
    ///
    /// Resumable, and the receipt names the resume — the stop is a hand-back
    /// with a sentence, deliberately not a further re-prompt. The one re-ask
    /// the horizon allows has already been spent by the time this is reached,
    /// and asking a third time is asking the same question louder; handing the
    /// card back is what puts a person in front of it.
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
    /// The stage met a decision that is the user's to make and stopped rather
    /// than asking.
    ///
    /// **The one reason a stage writes about itself.** Every other arm here is
    /// something the runner observed; this one is the stage saying it has run
    /// out of authority. A mid-arc `AskUserQuestion` was the alternative,
    /// and it is the wrong shape for an arc: the wheel's whole promise is that
    /// a run walks unattended, and a stage parked on a dialog is a run that has
    /// stopped without saying so — no record, no receipt, no resume, and the
    /// question itself lost the moment the card rotates. Stopping puts the
    /// question in the log, on the card, and in front of a person, and
    /// `tugtool arc run` picks the work back up once they have answered.
    ///
    /// The question rides as an `arc-note` written immediately before the stop
    /// — the vocabulary is closed and a reason cannot carry a payload — and the
    /// receipt reads it back beneath the sentence.
    NeedsDecision,
    /// The arc's four records disagree about where it is, and the runner found
    /// it before seating a stage over them.
    ///
    /// The check is `doctor::doctor` at dispatch time, run against the same
    /// four records `tugtool arc doctor` compares: the ledger table, the arc
    /// log's declarations, the sqlite binding, and the arc record. A stage
    /// seated over a disagreement reads a frontier that is not where the
    /// surfaces say it is, closes a step the log will not credit, and the arc
    /// finishes somewhere nobody can follow — a wedge with no receipt, which
    /// is the shape this whole vocabulary exists to prevent.
    ///
    /// Resumable: the disagreement is a repair (`tugtool arc doctor <name>
    /// --repair` where the finding carries one), and the arc picks back up.
    /// The findings' sentences ride as an `arc-note` written immediately
    /// before the stop — the same carriage [`ArcStopReason::NeedsDecision`]
    /// uses, and for the same reason: the vocabulary is closed and a reason
    /// cannot carry a payload.
    RecordsDisagree,
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
        ArcStopReason::NeedsDecision,
        ArcStopReason::RecordsDisagree,
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
            ArcStopReason::NeedsDecision => "needs a decision",
            ArcStopReason::RecordsDisagree => "records disagree",
        }
    }

    /// The inverse of [`as_str`](ArcStopReason::as_str) — the word off an
    /// `arc-stop` line, back to the reason it names.
    ///
    /// The reversal needs it: a record read back says its stop as a `String`,
    /// and whether that stop may be undone is a question about the *reason*.
    /// Round-tripped over [`ALL`](ArcStopReason::ALL) by a test, which is what
    /// keeps this from drifting away from `as_str` one variant at a time.
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|reason| reason.as_str() == word)
    }

    /// Whether this stop was the runner's own judgement about **silence**, and
    /// so a thing life on the stopped stage may undo ([P05], Table T03).
    ///
    /// The five are the ones the machine inferred from a stage not speaking:
    /// the horizon's `implement idle`, the clock's `stalled`, and the three
    /// read off documents a stage was given a turn to write and did not. Every
    /// one of them is a claim that nothing is happening, and a session that
    /// then moves is that claim being wrong.
    ///
    /// Everything else stands. A stop recording a *person's* act — the card
    /// taken back, a `/arc-stop`, the card closed — is not a judgement to be
    /// corrected, and neither is `records disagree` or `needs a decision`,
    /// which are refusals to guess: reversing one would be guessing.
    pub fn judged_silence(&self) -> bool {
        matches!(
            self,
            ArcStopReason::ImplementIdle
                | ArcStopReason::Stalled
                | ArcStopReason::Lint
                | ArcStopReason::ReviewDidNotStamp
                | ArcStopReason::AuditDidNotMark
        )
    }

    /// What the receipt says, in the second person, as the tail of
    /// "the arc stopped … because …".
    pub fn sentence(&self) -> &'static str {
        match self {
            ArcStopReason::Lint => "the plan does not lint",
            ArcStopReason::ApiError => "its turn ended in an API error, not a response",
            ArcStopReason::ReviewDidNotStamp => "two review rounds ended without stamping the plan",
            ArcStopReason::AuditDidNotMark => "the audit ended without marking the arc audited",
            ArcStopReason::DocumentMissing => "the document it opened on is gone",
            ArcStopReason::PlanMissing => "the plan is gone",
            ArcStopReason::SessionGone => "its session ended",
            ArcStopReason::CardTaken => "you took the card back",
            ArcStopReason::CardClosed => "the card it ran on closed",
            ArcStopReason::StoppedByUser => "you stopped it",
            ArcStopReason::Discarded => "the arc was discarded",
            ArcStopReason::Joined => "the arc joined and the work landed",
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
                "the implement stage was asked twice and closed no step"
            }
            ArcStopReason::Stalled => {
                "it went silent — no turn ended and no step closed before the arc's clock ran out"
            }
            ArcStopReason::NeedsDecision => {
                "it met a decision that is yours to make, so it stopped rather than asking"
            }
            ArcStopReason::RecordsDisagree => {
                "its records disagree about where it is, so it stopped rather than seating a stage over them"
            }
        }
    }

    /// Whether a stop for this reason leaves anything to resume. The two
    /// endings do not: the arc itself is gone, and `read_arc` resets at their
    /// terminal line, so `tugtool arc run` would open a new arc rather than
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
pub fn stage_model(config: &ArcConfig, stage: ArcStage) -> Option<String> {
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

/// What an arc's *current generation* of arc log lines says about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArcRecord {
    // The arc's own name. `name`, not `arc`: this record is nested under an
    // `arc` key by `tugtool arc record`, and `arc.arc` would say nothing.
    #[serde(rename = "name")]
    pub arc: String,
    /// The document the arc opened on.
    pub document: Option<String>,
    /// Which kind of arc this is, recorded when the arc opened.
    ///
    /// `None` is a **pre-kind arc** — an arc opened by a build that had no
    /// `arc-kind` marker to write. Its reader falls back to sniffing the
    /// documents, which is what every arc did before this marker existed.
    pub kind: Option<ArcKind>,
    /// The plan path the runner named in the devise prompt —
    /// base-relative, and superseded by the worktree copy from adoption on.
    pub plan: Option<String>,
    /// Rotations in log order, current generation only.
    pub stages: Vec<ArcStageLine>,
    pub notes: Vec<String>,
    /// The stage the arc stopped in and why. Cleared by the next
    /// rotation, because resuming a stopped arc *is* rotating it again.
    pub stopped: Option<(ArcStage, String)>,
    /// The same pair, kept for the whole generation whatever clears
    /// [`ArcRecord::stopped`].
    ///
    /// `stopped` is a *state* — this arc is stopped right now — and every act
    /// that picks the arc back up clears it, which is correct and is exactly
    /// what makes it useless to the act doing the picking up. A stage being
    /// resumed is owed the fact that it is resuming and what it is resuming
    /// from, and by the time the runner composes that prompt the `arc-resume`
    /// line has already cleared `stopped`.
    ///
    /// So this is the *history*: set by every `arc-stop`, cleared by nothing
    /// short of the generation reset. A record carrying one says the arc
    /// stopped at some point in this generation, never that it is stopped now.
    pub last_stop: Option<(ArcStage, String)>,
    /// The stage a resume asked to rotate again. Written by
    /// `tugtool arc run` on a stopped arc, and cleared by the next
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
    /// The instance whose tugcast seated this arc's stages — the raw
    /// `TUG_INSTANCE_ID` value, an opaque token this crate never parses.
    ///
    /// `None` is an **unowned** arc: a pre-owner log, or a launch with no
    /// instance id to name (a standalone build, a `cargo`-driven test). An
    /// unowned arc is every runner's to judge, which is what preserves
    /// single-instance behavior exactly as it was.
    ///
    /// It exists because the arc log is shared across every instance over one
    /// checkout, so a second tugcast reads a first tugcast's arcs and cannot
    /// get a session snapshot for a seat living in the other process. Without
    /// a name on the seat, "not mine to watch" and "gone silent" are the same
    /// reading — and the second one writes a stop receipt over healthy work.
    pub owner: Option<String>,
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

/// Read the arc record for `arc`, or `None` when this arc has no arc — which
/// is every arc created by hand.
///
/// Applies the same generation reset [`crate::log::read_declarations`] applies:
/// everything at or before the last terminal line for this arc is discarded.
pub fn read_arc(repo_root: &Path, arc: &str) -> Option<ArcRecord> {
    let path = tugtool_core::paths::arc_log_path(repo_root);
    let text = std::fs::read_to_string(&path).ok()?;

    let mut found: Option<ArcRecord> = None;
    for line in text.lines() {
        let Some((timestamp, name, marker, note)) = split_log_line(line) else {
            continue;
        };
        if name != arc {
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
            arc: arc.to_owned(),
            document: None,
            kind: None,
            plan: None,
            stages: Vec::new(),
            notes: Vec::new(),
            stopped: None,
            last_stop: None,
            resume: None,
            dispatched: None,
            owner: None,
            done: false,
            last_activity: None,
        });
        record.last_activity = Some(timestamp.to_owned());
        match marker {
            "arc-start" => record.document = Some(note.to_owned()),
            // **Skew.** An older reader falls through the `_` arm below and
            // keeps sniffing the documents for the kind — which is the
            // behavior this marker replaces, so the degradation is exactly
            // today's. A newer reader over a pre-kind log finds no marker and
            // takes the same fallback. Neither direction can invent a kind
            // the other did not intend.
            "arc-kind" => record.kind = ArcKind::parse(note.trim()),
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
                    record.stopped = Some((stage, reason.clone()));
                    record.last_stop = Some((stage, reason));
                }
            }
            "arc-resume" => {
                if let Some(stage) = ArcStage::parse(note.trim()) {
                    record.stopped = None;
                    record.resume = Some(stage);
                }
            }
            // The stage is already seated and already moving, so the arc is
            // running again and nothing is owed a rotation.
            //
            // **Skew.** Same arm and same reasoning as `arc-dispatch` below: a
            // reader older than this marker falls through to `_`, dating the
            // arc from the line and declaring nothing. It keeps the `resume`
            // the preceding line set and rotates the stage — one redundant
            // rotation of a stage that is running, never a stop invented or a
            // stop lost.
            "arc-continue" => {
                if ArcStage::parse(note.trim()).is_some() {
                    record.stopped = None;
                    record.resume = None;
                }
            }
            // **Skew.** A reader older than this marker falls through the `_`
            // arm below: it dates the arc from the line and declares nothing
            // from it, which is what every older reader has always done with a
            // marker it did not know. `read_declarations` degrades the same
            // way. So the direction is safe — an old reader keeps the false
            // `CardTaken` it already had, and never invents a stop it did not
            // have before.
            "arc-dispatch" => record.dispatched = ArcStage::parse(note.trim()),
            // **Skew.** Same arm, same reasoning: a reader older than this
            // marker dates the arc from the line and declares nothing from
            // it, so its degradation is exactly today's — every arc reads as
            // unowned and every runner owns it, which is what every runner did
            // before ownership existed. A newer reader over a pre-owner log
            // finds no marker and reads `None`, which the verdict defines as
            // unowned. Neither direction can invent an owner the other did not
            // intend.
            "arc-owner" => record.owner = Some(note.trim().to_owned()),
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
pub fn append_arc_start(repo_root: &Path, arc: &str, document: &str) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-start", document)
}

/// Append `arc-kind` — which kind of arc this is.
///
/// A line of its own rather than a second field on `arc-start`, because
/// `arc-start`'s note is a path read whole: appending to it would make an
/// older reader take `arc/idea.md planned` for the document's name. A marker an
/// old reader does not know is skipped; a note it misreads is not.
pub fn append_arc_kind(repo_root: &Path, arc: &str, kind: ArcKind) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-kind", kind.as_str())
}

/// Append `arc-owner` — the instance whose tugcast is seating this arc.
///
/// A marker of its own rather than a field on `arc-stage` or `arc-dispatch`,
/// and the `arc-dispatch` half of that is not a style preference: `read_arc`
/// parses that note with `ArcStage::parse(note.trim())` over the **whole**
/// note, so `"implement release-main"` would fail to parse and the dispatch
/// intent would be silently lost — reintroducing the false `CardTaken` the
/// `arc-dispatch` marker was added to prevent. `arc-stage` would tolerate a
/// fourth field (`read_stage_line` takes three and drops the rest), but it
/// welds an ownership fact onto a positional grammar that already carries an
/// optional field spelled `-`. One line per rotation reads unambiguously.
///
/// `instance_id` is passed in and never resolved here. `arc.rs` is a grammar
/// over the log, and a grammar that reads the process environment stops being
/// one — so the caller resolves `tugcore::instance::instance_id()` and simply
/// does not call this when it is `None`. A record with no owner is unowned;
/// there is no placeholder to write.
pub fn append_arc_owner(repo_root: &Path, arc: &str, instance_id: &str) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-owner", instance_id.trim())
}

/// Append `arc-stage` — a stage was rotated onto `session_id`.
pub fn append_arc_stage(
    repo_root: &Path,
    arc: &str,
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
    append_arc_log(repo_root, arc, "arc-stage", &note)
}

/// Append `arc-dispatch` — a rotation to `stage` is about to be sent.
///
/// Written *before* the wheel fires, because the whole of its worth is in the
/// gap after it: a crash between the dispatch and the bridge's `arc-stage`
/// line leaves a seat the record cannot explain, and this is the line that
/// explains it. The `arc-stage` it anticipates clears it.
pub fn append_arc_dispatch(repo_root: &Path, arc: &str, stage: ArcStage) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-dispatch", stage.as_str())
}

/// Append `arc-plan` — the plan path the runner named.
pub fn append_arc_plan(repo_root: &Path, arc: &str, plan: &str) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-plan", plan)
}

/// Append `arc-note` — a runner note, such as the review cap.
pub fn append_arc_note(repo_root: &Path, arc: &str, note: &str) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-note", note)
}

/// Append `arc-stop` — the arc stopped in `stage` for `reason`.
pub fn append_arc_stop(
    repo_root: &Path,
    arc: &str,
    stage: ArcStage,
    reason: ArcStopReason,
) -> Result<(), TugError> {
    let note = format!("{} {}", stage.as_str(), reason.as_str());
    append_arc_log(repo_root, arc, "arc-stop", note.trim())
}

/// Append `arc-resume` — a stopped arc was picked back up, and `stage` is the
/// one to rotate again. Clears the stop; the rotation it asks for
/// clears it in turn.
pub fn append_arc_resume(repo_root: &Path, arc: &str, stage: ArcStage) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-resume", stage.as_str())
}

/// Append `arc-continue` — a stopped or resumed stage was picked back up on
/// its **own** session, so there is nothing to rotate ([P05], Spec S02).
///
/// The difference from `arc-resume` is the whole of why both exist. A resume
/// names a stage to seat again, and the rotation that answers it clears the
/// naming. A continue says the stage is already seated and already working:
/// the session that was stopped is the one that moved, so seating a fresh one
/// would replace a stage mid-thought with an empty one. Clearing `resume` is
/// therefore the point rather than a side effect.
pub fn append_arc_continue(repo_root: &Path, arc: &str, stage: ArcStage) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-continue", stage.as_str())
}

/// Append `arc-done` — the arc reached its terminal state.
pub fn append_arc_done(repo_root: &Path, arc: &str) -> Result<(), TugError> {
    append_arc_log(repo_root, arc, "arc-done", "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::{ArcDeclarations, read_declarations};
    use serial_test::serial;
    use std::fs;

    #[test]
    fn a_stage_model_comes_from_the_projects_own_declaration() {
        let mut config = ArcConfig::default();
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

        append_arc_start(root, "d", "arc/idea.md").unwrap();
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

    /// **The kind is recorded, and a log without one reads `None`.**
    /// That `None` is the whole of the pre-kind story: the runner falls back
    /// to sniffing the documents for it, which is what it did before.
    #[serial]
    #[test]
    fn a_recorded_kind_reads_back_and_its_absence_is_a_pre_kind_arc() {
        let fixture = log_repo("");
        let root = fixture.root();

        append_arc_start(root, "d", "arc/idea.md").unwrap();
        assert_eq!(
            read_arc(root, "d").unwrap().kind,
            None,
            "an arc-start alone is a pre-kind arc"
        );

        append_arc_kind(root, "d", ArcKind::Plain).unwrap();
        let record = read_arc(root, "d").unwrap();
        assert_eq!(record.kind, Some(ArcKind::Plain));
        assert_eq!(
            record.document.as_deref(),
            Some("arc/idea.md"),
            "and the kind is a line of its own, so the document is unharmed"
        );
    }

    /// **An unreadable kind degrades to the fallback, never to a guess.** A
    /// record written by a build that spells a third kind reads `None` here,
    /// which is exactly a pre-kind arc — the one behavior every reader in
    /// the tree already knows how to take.
    #[serial]
    #[test]
    fn a_kind_this_build_cannot_read_is_a_pre_kind_arc() {
        let fixture = log_repo(
            &[
                log_line("d", "arc-start", "arc/idea.md"),
                log_line("d", "arc-kind", "expedition"),
            ]
            .concat(),
        );
        assert_eq!(read_arc(fixture.root(), "d").unwrap().kind, None);
    }

    /// **The retired kind words are not kinds either.** The two words this
    /// marker's vocabulary opened with are retired; nothing writes them now, and a log that
    /// still carries one reads back as a pre-kind arc, through the same
    /// unknown-word arm any third word takes. No arm here knows the old words:
    /// a pre-kind arc's reader sniffs the documents, which is the right answer
    /// for a record written before the kind was `plain` or `planned`.
    #[serial]
    #[test]
    fn the_retired_kind_words_read_as_a_pre_kind_arc() {
        for word in ["dash", "trek"] {
            let fixture = log_repo(
                &[
                    log_line("d", "arc-start", "arc/idea.md"),
                    log_line("d", "arc-kind", word),
                ]
                .concat(),
            );
            assert_eq!(
                read_arc(fixture.root(), "d").unwrap().kind,
                None,
                "the retired word {word} is not a kind this build reads"
            );
            assert_eq!(ArcKind::parse(word), None);
        }
    }

    /// **The retired marker is not a kind, and is not a compatibility path.**
    /// `arc-course` was the marker's first spelling; nothing writes it now, and
    /// a log that still carries one reads back as a pre-kind arc — the same
    /// `None` any unknown marker earns, through the reader's standing
    /// unknown-marker fall-through rather than an arm that knows the old word.
    #[serial]
    #[test]
    fn the_retired_arc_course_marker_reads_as_a_pre_kind_arc() {
        let fixture = log_repo(
            &[
                log_line("d", "arc-start", "arc/idea.md"),
                log_line("d", "arc-course", "plan"),
            ]
            .concat(),
        );
        assert_eq!(read_arc(fixture.root(), "d").unwrap().kind, None);
    }

    /// **The skew direction.** The marker is new, so every reader older than
    /// it must fall through untroubled. `read_declarations` shares the log and
    /// knows nothing of `arc-*` markers at all: it dates the arc from the
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
            "it dates the arc, as every line does, and declares nothing"
        );
    }

    /// A scratch data dir plus the repo root whose arc log it holds — the same
    /// shape `arc.rs`'s tests use, and `#[serial]` for the same reason: the
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
            let state = tugtool_core::paths::project_state_dir(repo.path());
            fs::create_dir_all(&state).expect("state dir");
            fs::write(state.join(tugtool_core::paths::ARC_LOG), lines).expect("write log");
        }
        LogFixture { _home: home, repo }
    }

    fn log_line(arc: &str, marker: &str, note: &str) -> String {
        log_line_at("2026-08-24T12:00:00Z", arc, marker, note)
    }

    fn log_line_at(at: &str, arc: &str, marker: &str, note: &str) -> String {
        format!("{at}  {arc}  {marker}  {note}\n")
    }

    /// A full arc: opened on a brief, plan named, three stages, done.
    fn full_arc_log() -> String {
        [
            log_line_at("2026-08-24T10:00:00Z", "d", "arc-start", "arc/idea.md"),
            log_line_at("2026-08-24T10:01:00Z", "d", "arc-plan", "arc/d.md"),
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

    /// **The owner is the last one written, within the generation.** A seat
    /// can be re-owned — an instance restarts, or a second one legitimately
    /// takes over an arc the first abandoned — and the record must name the
    /// instance whose tugcast is seating it *now*, not the first one that ever
    /// did.
    #[serial]
    #[test]
    fn an_owner_line_is_read_back_and_the_last_one_wins() {
        let fixture = log_repo(
            &[
                log_line("d", "arc-start", "arc/idea.md"),
                log_line("d", "arc-owner", "release-main"),
                log_line("d", "arc-stage", "implement sess-1 -"),
                log_line("d", "arc-owner", "debug-spike"),
                log_line("d", "arc-stage", "implement sess-2 -"),
            ]
            .concat(),
        );
        assert_eq!(
            read_arc(fixture.root(), "d").unwrap().owner.as_deref(),
            Some("debug-spike")
        );
    }

    /// **The owner does not outlive its generation.** `read_arc` rebuilds the
    /// record from scratch after each terminal line, and ownership is a fact
    /// about a live seat rather than about the arc's name — an arc joined by
    /// one instance and re-opened by another must not read as the first one's.
    #[serial]
    #[test]
    fn an_owner_does_not_survive_the_generation_reset() {
        let fixture = log_repo(
            &[
                log_line_at("2026-08-24T10:00:00Z", "d", "arc-start", "arc/idea.md"),
                log_line_at("2026-08-24T10:01:00Z", "d", "arc-owner", "release-main"),
                log_line_at("2026-08-24T11:00:00Z", "d", "landed", "joined abc1234"),
                log_line_at("2026-08-24T12:00:00Z", "d", "arc-start", "arc/idea.md"),
            ]
            .concat(),
        );
        let record = read_arc(fixture.root(), "d").unwrap();
        assert_eq!(
            record.owner, None,
            "the owner belongs to the generation that recorded it"
        );
    }

    /// **A pre-owner log reads as unowned, which is today's behavior exactly.**
    /// `None` is not a degraded reading to be repaired: the verdict defines an
    /// unowned arc as every runner's to judge, which is what every runner did
    /// before ownership existed. This is what keeps single-instance and
    /// standalone launches unchanged.
    #[serial]
    #[test]
    fn a_pre_owner_log_reads_as_unowned() {
        let fixture = log_repo(
            &[
                log_line("d", "arc-start", "arc/idea.md"),
                log_line("d", "arc-kind", "plain"),
                log_line("d", "arc-stage", "implement sess-1 -"),
            ]
            .concat(),
        );
        let record = read_arc(fixture.root(), "d").unwrap();
        assert_eq!(record.owner, None);
        assert_eq!(
            record.stages.len(),
            1,
            "and the rest reads as it always did"
        );
    }

    /// **The skew claim, made falsifiable.** The marker's whole case is that it
    /// is a line of its own rather than a field on `arc-stage` or
    /// `arc-dispatch` — so an owner line interleaved among both must leave
    /// their readings byte-identical. The `arc-dispatch` half is the sharp one:
    /// `read_arc` parses that note whole with `ArcStage::parse`, so a second
    /// field there would lose the dispatch intent and reintroduce the false
    /// `CardTaken` the marker exists to prevent.
    #[serial]
    #[test]
    fn an_owner_line_does_not_disturb_the_stage_or_dispatch_readers() {
        let without = [
            log_line_at("2026-08-24T10:00:00Z", "d", "arc-start", "arc/idea.md"),
            log_line_at(
                "2026-08-24T10:01:00Z",
                "d",
                "arc-stage",
                "devise sess-1 opus",
            ),
            log_line_at("2026-08-24T10:03:00Z", "d", "arc-dispatch", "implement"),
        ]
        .concat();
        let with = [
            log_line_at("2026-08-24T10:00:00Z", "d", "arc-start", "arc/idea.md"),
            log_line_at("2026-08-24T10:01:00Z", "d", "arc-owner", "release-main"),
            log_line_at(
                "2026-08-24T10:01:00Z",
                "d",
                "arc-stage",
                "devise sess-1 opus",
            ),
            log_line_at("2026-08-24T10:02:00Z", "d", "arc-owner", "release-main"),
            log_line_at("2026-08-24T10:03:00Z", "d", "arc-dispatch", "implement"),
        ]
        .concat();

        let bare = read_arc(log_repo(&without).root(), "d").unwrap();
        let owned = read_arc(log_repo(&with).root(), "d").unwrap();

        assert_eq!(owned.stages, bare.stages);
        assert_eq!(
            owned.dispatched,
            Some(ArcStage::Implement),
            "the dispatch intent survives an owner line beside it"
        );
        assert_eq!(owned.dispatched, bare.dispatched);
        assert_eq!(owned.document, bare.document);
        assert_eq!(owned.owner.as_deref(), Some("release-main"));
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
        assert_eq!(arc.arc, "d");
        assert_eq!(arc.document.as_deref(), Some("arc/idea.md"));
        assert_eq!(arc.plan.as_deref(), Some("arc/d.md"));
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
    fn another_arcs_lines_are_not_this_ones() {
        let fixture = log_repo(&log_line("other", "arc-start", "arc/idea.md"));
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
            log_line_at("2026-08-24T15:00:00Z", "d", "arc-start", "arc/next.md")
        );
        let fixture = log_repo(&log);
        let arc = read_arc(fixture.root(), "d").expect("arc");
        assert_eq!(arc.document.as_deref(), Some("arc/next.md"));
        assert!(arc.stages.is_empty());
        assert!(!arc.done);
    }

    #[test]
    #[serial]
    fn a_stop_reads_as_stopped_and_the_next_rotation_clears_it() {
        let stopped = format!(
            "{}{}",
            log_line_at("2026-08-24T10:00:00Z", "d", "arc-start", "arc/idea.md"),
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
            log_line("d", "arc-start", "arc/idea.md"),
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
            log_line("d", "arc-start", "arc/idea.md"),
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

        assert_ne!(without, ArcDeclarations::default());
        assert_eq!(
            ArcDeclarations {
                last_activity: with.last_activity.clone(),
                ..without
            },
            with
        );
        assert_eq!(with.last_activity.as_deref(), Some("2026-08-24T13:00:00Z"));
    }

    #[test]
    #[serial]
    fn a_discarded_arc_has_no_arc() {
        let fixture = log_repo("");
        let root = fixture.root();
        append_arc_start(root, "d", "arc/d-brief.md").unwrap();
        append_arc_stage(root, "d", ArcStage::Devise, "s1", None).unwrap();
        assert!(read_arc(root, "d").is_some());
        // Discard writes the arc's terminal marker; the arc record ends with
        // the arc, so a later `arc run` under the same name opens fresh
        // rather than resuming into an arc that no longer exists.
        append_arc_log(root, "d", "discarded", "").unwrap();
        assert_eq!(read_arc(root, "d"), None);
        append_arc_start(root, "d", "arc/d-brief.md").unwrap();
        let fresh = read_arc(root, "d").unwrap();
        assert!(
            fresh.stages.is_empty(),
            "the discarded arc's stages do not carry over"
        );
    }

    /// `parse` is `as_str` read backwards, and the round trip over the whole
    /// vocabulary is what keeps the two from drifting apart one variant at a
    /// time — a reason whose word `parse` cannot find would read as
    /// unreversible whatever it is, and silently.
    #[test]
    fn every_stop_reason_round_trips_through_parse() {
        for reason in ArcStopReason::ALL {
            assert_eq!(
                ArcStopReason::parse(reason.as_str()),
                Some(*reason),
                "{reason:?} does not round-trip through its own word",
            );
        }
        assert_eq!(ArcStopReason::parse("a reason nobody wrote"), None);
        assert_eq!(ArcStopReason::parse(""), None);
    }

    /// Table T03. The five the machine *inferred* from a stage not speaking
    /// may be undone by the stage speaking; every other stop stands, and the
    /// ones recording a person's act stand hardest.
    #[test]
    fn only_the_silence_judged_stops_are_reversible() {
        let reversible: Vec<&str> = ArcStopReason::ALL
            .iter()
            .filter(|reason| reason.judged_silence())
            .map(|reason| reason.as_str())
            .collect();
        assert_eq!(
            reversible,
            vec![
                "lint",
                "review did not stamp",
                "audit did not mark",
                "implement idle",
                "stalled",
            ],
        );
        for word in [
            "card taken",
            "stopped by user",
            "card closed",
            "needs a decision",
            "records disagree",
        ] {
            assert!(
                !ArcStopReason::parse(word).unwrap().judged_silence(),
                "{word} records a decision, not a silence",
            );
        }
    }

    /// **`stopped` is a state and `last_stop` is a history**, and the resume
    /// clause needs the second one. Every act that picks a stopped arc back up
    /// clears `stopped` before anything composes a prompt, so a stage being
    /// resumed would be told nothing about what it was resuming from.
    #[test]
    #[serial]
    fn last_stop_survives_the_resume_that_clears_stopped() {
        let fixture = log_repo("");
        let root = fixture.root();
        append_arc_start(root, "d", "arc/d-brief.md").unwrap();
        append_arc_stage(root, "d", ArcStage::Implement, "s1", None).unwrap();
        append_arc_stop(root, "d", ArcStage::Implement, ArcStopReason::ImplementIdle).unwrap();
        let stopped = read_arc(root, "d").unwrap();
        assert_eq!(
            stopped.last_stop,
            Some((ArcStage::Implement, "implement idle".to_string())),
            "both fields are written by the one line",
        );
        assert_eq!(stopped.stopped, stopped.last_stop);

        for pick_up in ["resume", "continue"] {
            match pick_up {
                "resume" => append_arc_resume(root, "d", ArcStage::Implement).unwrap(),
                _ => append_arc_continue(root, "d", ArcStage::Implement).unwrap(),
            }
            let record = read_arc(root, "d").unwrap();
            assert_eq!(record.stopped, None, "{pick_up} clears the state");
            assert_eq!(
                record.last_stop,
                Some((ArcStage::Implement, "implement idle".to_string())),
                "and leaves the history, which is what the resume clause reads",
            );
        }

        // A rotation clears `stopped` too, and the history outlives it as far
        // as the generation goes.
        append_arc_stage(root, "d", ArcStage::Audit, "s2", None).unwrap();
        assert_eq!(
            read_arc(root, "d").unwrap().last_stop,
            Some((ArcStage::Implement, "implement idle".to_string())),
        );
    }

    /// The marker's whole job: the stage is already seated and already moving,
    /// so the arc is running again and nobody is owed a rotation. `arc-resume`
    /// alone would leave one standing.
    #[test]
    #[serial]
    fn arc_continue_clears_the_stop_and_the_resume_and_adds_no_stage() {
        let fixture = log_repo("");
        let root = fixture.root();
        append_arc_start(root, "d", "arc/d-brief.md").unwrap();
        append_arc_stage(root, "d", ArcStage::Implement, "s1", None).unwrap();
        append_arc_stop(root, "d", ArcStage::Implement, ArcStopReason::ImplementIdle).unwrap();
        append_arc_resume(root, "d", ArcStage::Implement).unwrap();
        let resumed = read_arc(root, "d").unwrap();
        assert_eq!(resumed.stopped, None);
        assert_eq!(resumed.resume, Some(ArcStage::Implement));

        append_arc_continue(root, "d", ArcStage::Implement).unwrap();
        let continued = read_arc(root, "d").unwrap();
        assert_eq!(continued.stopped, None);
        assert_eq!(
            continued.resume, None,
            "a stage already seated is owed no rotation",
        );
        assert_eq!(
            continued.stages.len(),
            resumed.stages.len(),
            "and the marker seats nothing itself",
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
        append_arc_start(root, "d", "arc/idea.md").expect("start");
        append_arc_plan(root, "d", "arc/d.md").expect("plan");
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
        assert_eq!(arc.document.as_deref(), Some("arc/idea.md"));
        assert_eq!(arc.plan.as_deref(), Some("arc/d.md"));
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

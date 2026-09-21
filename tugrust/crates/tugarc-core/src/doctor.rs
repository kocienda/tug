//! `arc doctor` — what the records say, and where they disagree.
//!
//! An arc keeps five records of itself, and no two of them are written by the
//! same act:
//!
//! | record | written by | read by |
//! |---|---|---|
//! | the plan's **Step Status Ledger** | `arc step …`, and a person's editor | the arc's resume pointer, the changeset feed's closed count |
//! | the **arc log**'s declarations | `arc step …`, `arc mark` | `arc status`, `run_fraction`, `derive_stage`, `join_ready` |
//! | the **sqlite binding** | tugcast, at bind and at the rotation seat | which card an arc is showing in |
//! | the **arc record** (also the log) | the arc runner | which stage the Wheel rotates next |
//! | the **seat** — branch and worktree | `ops::create_in`, from the dispatch | the stage's `where` line, every round |
//!
//! And a sixth reading beside the five, which is not a record anybody writes
//! but the place a failed join leaves its marks: **the base checkout**. A
//! standing `SQUASH_MSG` naming the arc's rounds, base paths holding the arc's
//! own bytes uncommitted, a join recorded as having stranded the base, an
//! operation that began and never finished — each is a state a person can see
//! in `git status`, so none of them may read as "the records agree".
//!
//! The split in the first two rows is the one that matters, and it is easy to
//! read backwards: **join-arming derives from the log; the resume pointer
//! derives from the table.** So a hand-edited table does not desync "the
//! display" from "the truth" — it desyncs *where the run will resume* from
//! *whether the run may be landed*. Those are the two facts that must agree
//! for the Wheel to walk the right step, and until now nothing compared them.
//!
//! This module is that comparison. It is read-only and cheap enough that
//! `arc status` runs it on every call, so an ordinary status says "the ledger
//! and the log disagree at step 4" instead of answering confidently from one
//! side. Repair is opt-in (`arc doctor <name> --repair`) because detection is
//! always safe and a repair is a judgment about which record was right.
//!
//! **Every log repair is an append.** The arc log is append-only across
//! generations and is never rewritten — that property is load-bearing for
//! `read_declarations`' generation reset — so a reconciling repair adds the
//! declaration the table's own state implies. The table is the authored
//! document a person edits; the log is the derivation surface. When they
//! disagree about a step's status, the table is taken as the intent and the
//! log is caught up to it.
//!
//! The one repair that is not an append is the seat's: a record past devise
//! whose branch or worktree is gone gets them made, through the same
//! idempotent `create_in` the dispatch calls. Nothing else the doctor can do
//! writes anything but the log.

use std::path::Path;

use serde::Serialize;

use crate::log::{ArcDeclarations, StepPhase, read_declarations, step_declaration_note};
use crate::ops;

/// One disagreement between two of an arc's records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArcFinding {
    /// A stable kebab-case code, for a machine that wants to switch on it.
    pub code: String,
    /// The disagreement in one sentence, naming both records and the step.
    /// This is what `arc status` prints and what a person reads.
    pub sentence: String,
    /// The act that reconciles it, when one record can be caught up to the
    /// other without a judgment. `None` when the disagreement needs a person.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair: Option<ArcRepair>,
}

/// The act that would reconcile a finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ArcRepair {
    /// An arc log line to append.
    Append {
        marker: String,
        note: String,
        /// What appending it would achieve, in one clause.
        effect: String,
    },
    /// The arc's branch and worktree, made by `ops::create_in`.
    MakeSeat {
        /// What making it would achieve, in one clause.
        effect: String,
    },
}

impl ArcRepair {
    /// What the repair would achieve, in one clause.
    pub fn effect(&self) -> &str {
        match self {
            ArcRepair::Append { effect, .. } | ArcRepair::MakeSeat { effect } => effect,
        }
    }

    /// The act itself, in the words a CLI line shows before `--repair` takes it.
    pub fn describe(&self) -> String {
        match self {
            ArcRepair::Append { marker, note, .. } => format!("append `{marker}  {note}`"),
            ArcRepair::MakeSeat { .. } => "make the branch and worktree".to_string(),
        }
    }
}

/// Everything the doctor found, and enough context to read it.
#[derive(Debug, Clone, Serialize)]
pub struct ArcDiagnosis {
    #[serde(rename = "arc")]
    pub arc: String,
    /// The ledger document the table was read from, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ledger: Option<String>,
    pub findings: Vec<ArcFinding>,
}

impl ArcDiagnosis {
    /// Whether the five records agree.
    pub fn healthy(&self) -> bool {
        self.findings.is_empty()
    }

    /// Just the sentences — what a status line shows.
    pub fn sentences(&self) -> Vec<String> {
        self.findings.iter().map(|f| f.sentence.clone()).collect()
    }
}

/// One ledger row, reduced to what the doctor compares.
struct Row {
    step: u32,
    title: String,
    status: String,
    has_commit: bool,
}

/// Read the arc's Step Status Ledger, or `None` when it has no parseable one.
fn read_table(repo_root: &Path, name: &str) -> Option<(String, Vec<Row>)> {
    let path = ops::ledger_file(repo_root, name)?;
    let source = std::fs::read_to_string(&path).ok()?;
    let doc = tugtool_core::plan::parse(&source).ok()?;
    let rows = doc
        .ledger_rows
        .iter()
        .filter_map(|r| {
            Some(Row {
                step: r.anchor.strip_prefix("step-")?.parse().ok()?,
                title: r.title.clone(),
                status: r.status.clone(),
                has_commit: r.commit.is_some(),
            })
        })
        .collect();
    Some((path.display().to_string(), rows))
}

/// The declaration a row's status implies — what the log would say if it had
/// been written by the verb that produced this row.
///
/// `None` for `pending`: a row nobody has touched implies no declaration at
/// all, and appending one would be inventing an act.
fn phase_for(status: &str) -> Option<StepPhase> {
    match status {
        "in progress" => Some(StepPhase::Start),
        "done" => Some(StepPhase::Done),
        "withdrawn" => Some(StepPhase::Withdrawn),
        _ => None,
    }
}

/// The repair that catches the log up to one table row.
fn catch_log_up(row: &Row, total: u32) -> Option<ArcRepair> {
    let phase = phase_for(&row.status)?;
    // A `done` row's note tail is its sha; the doctor does not have one to
    // hand and will not invent a commit, so it writes the title instead. The
    // note grammar only requires the leading `i/N`, and a title where a sha
    // would be reads as "reconciled, commit unknown" rather than as a lie
    // about which round closed the step.
    let tail = format!(
        "Step {}: {} (reconciled by arc doctor)",
        row.step, row.title
    );
    Some(ArcRepair::Append {
        marker: phase.marker().to_string(),
        note: step_declaration_note(row.step, total, &tail),
        effect: format!(
            "the log would agree with the table that step {} is '{}'",
            row.step, row.status
        ),
    })
}

/// Compare an arc's five records and name every disagreement.
///
/// Read-only: it opens no writable handle and takes no lock. An arc with no
/// documents, no log, or no branch is not an error here — it is an arc with
/// fewer records to disagree, and the checks that need a record it lacks are
/// simply not run.
pub fn diagnose(repo_root: &Path, name: &str) -> ArcDiagnosis {
    let mut findings = Vec::new();
    let decls = read_declarations(repo_root, name);
    let table = read_table(repo_root, name);
    let arc = crate::arc::read_arc(repo_root, name);

    let ledger = table.as_ref().map(|(path, _)| path.clone());
    let rows: &[Row] = table.as_ref().map(|(_, rows)| &rows[..]).unwrap_or(&[]);

    check_table_against_log(&mut findings, rows, &decls, ledger.is_some(), name);
    check_run_arming(&mut findings, rows, &decls);
    check_commit_cells(&mut findings, rows);
    check_arc(&mut findings, rows, arc.as_ref(), repo_root, name);
    check_seat(&mut findings, arc.as_ref(), repo_root, name);
    check_base_checkout(&mut findings, repo_root, name);

    ArcDiagnosis {
        arc: name.to_string(),
        ledger,
        findings,
    }
}

/// The codes of the three findings that say a step is half-walked: the log
/// declares one open and the table disagrees, the log declares one the table
/// has no row for, or the table reads one open that the log never declared.
///
/// They are grouped because a **resume** treats them as one thing. Every other
/// finding is a record disagreeing with another record; these three describe
/// the interruption a resume exists to pick up from, so a runner that stopped
/// on them would make a resume unable to resume.
pub const OPEN_STEP_CODES: [&str; 3] = [
    "open-step-status",
    "open-step-missing-row",
    "undeclared-open-row",
];

/// The step those findings are about, so a caller that must act on one has a
/// number rather than a sentence.
///
/// An [`ArcFinding`] carries a stable code and a sentence a person reads; the
/// step is inside the prose, which is no place for a machine to read it from.
/// The log's declared-open step comes first because that is what
/// `open-step-status` and `open-step-missing-row` are *about*, and the table's
/// own open row answers `undeclared-open-row`, which is the case where the log
/// declares nothing.
pub fn open_step(repo_root: &Path, name: &str) -> Option<u32> {
    let decls = read_declarations(repo_root, name);
    if decls.step_in_flight
        && let Some((current, _)) = decls.step
    {
        return Some(current);
    }
    let (_, rows) = read_table(repo_root, name)?;
    rows.iter()
        .find(|row| row.status == "in progress")
        .map(|row| row.step)
}

/// The table against the log: the split the doctor exists for.
fn check_table_against_log(
    findings: &mut Vec<ArcFinding>,
    rows: &[Row],
    decls: &ArcDeclarations,
    has_ledger: bool,
    name: &str,
) {
    // A run declared steps and the document they were declared against is
    // gone. Nothing can be reconciled — the table is the missing record.
    if !has_ledger {
        if let Some((current, total)) = decls.step {
            findings.push(ArcFinding {
                code: "ledger-missing".into(),
                sentence: format!(
                    "the arc log says '{name}' reached step {current} of {total}, but there is \
                     no plan or task list to read a Step Status Ledger from — the arc's resume \
                     pointer has nothing to point at."
                ),
                repair: None,
            });
        }
        return;
    }

    let total = rows.len() as u32;
    if let Some((_, declared_total)) = decls.step
        && declared_total != total
    {
        findings.push(ArcFinding {
            code: "step-total".into(),
            sentence: format!(
                "the arc log's step declarations count {declared_total} steps and the table has \
                 {total} rows — the plan gained or lost rows after a run began, so every \
                 declared i/N in this generation is against a different denominator."
            ),
            repair: None,
        });
    }

    // The step the log says is open, against the row it names.
    if decls.step_in_flight
        && let Some((current, _)) = decls.step
    {
        match rows.iter().find(|r| r.step == current) {
            Some(row) if row.status != "in progress" => findings.push(ArcFinding {
                code: "open-step-status".into(),
                sentence: format!(
                    "the arc log says step {current} is open while the table reads it \
                     '{}' — status and join-arming derive from the log, the arc's resume \
                     pointer derives from the table, so the two would send a resumed run to \
                     different steps.",
                    row.status
                ),
                repair: catch_log_up(row, total),
            }),
            None => findings.push(ArcFinding {
                code: "open-step-missing-row".into(),
                sentence: format!(
                    "the arc log says step {current} is open and the table has no row for it."
                ),
                repair: None,
            }),
            Some(_) => {}
        }
    }

    // A row the table says is open that the log does not declare. This is the
    // crash-between-the-two-writes shape, and the one repair that is always
    // safe: the table moved, so the act happened, and the log is behind.
    for row in rows.iter().filter(|r| r.status == "in progress") {
        let declared_open = decls.step_in_flight && decls.step.map(|(c, _)| c) == Some(row.step);
        if declared_open {
            continue;
        }
        findings.push(ArcFinding {
            code: "undeclared-open-row".into(),
            sentence: format!(
                "the table reads step {} 'in progress' and the arc log never declared it \
                 opened — the row moved and the declaration did not, which is what a crash \
                 between the two writes leaves behind.",
                row.step
            ),
            repair: catch_log_up(row, total),
        });
    }
}

/// The audit's headline: the log arms the join while the table still has work
/// inside the declared selection.
fn check_run_arming(findings: &mut Vec<ArcFinding>, rows: &[Row], decls: &ArcDeclarations) {
    if !decls.run_complete {
        return;
    }
    let Some(through) = decls.run_through else {
        return;
    };
    let open: Vec<u32> = rows
        .iter()
        .filter(|r| r.step <= through && r.status != "done" && r.status != "withdrawn")
        .map(|r| r.step)
        .collect();
    if open.is_empty() {
        return;
    }
    let list = open
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    findings.push(ArcFinding {
        code: "armed-over-open-rows".into(),
        sentence: format!(
            "the arc log says the run through step {through} finished — so the join is armed — \
             while the table still reads step(s) {list} as unclosed. Close them with `arc step \
             done` or `arc step withdraw` if the run really finished, or reopen the run's last \
             step with `arc step reopen` if it did not; the doctor will not guess which."
        ),
        repair: None,
    });
}

/// A `done` row whose commit cell is empty claims a round nobody can follow.
fn check_commit_cells(findings: &mut Vec<ArcFinding>, rows: &[Row]) {
    for row in rows.iter().filter(|r| r.status == "done" && !r.has_commit) {
        findings.push(ArcFinding {
            code: "done-without-commit".into(),
            sentence: format!(
                "step {} reads 'done' with an empty commit cell — a later reader following the \
                 cell back to the work finds nothing.",
                row.step
            ),
            repair: None,
        });
    }
}

/// The arc record against the table, the documents, and the binding.
fn check_arc(
    findings: &mut Vec<ArcFinding>,
    rows: &[Row],
    arc: Option<&crate::arc::ArcRecord>,
    repo_root: &Path,
    name: &str,
) {
    let Some(arc) = arc else {
        return;
    };

    // The document the arc is driving.
    if let Some(plan) = arc.plan.as_deref().or(arc.document.as_deref()) {
        let candidate = if Path::new(plan).is_absolute() {
            std::path::PathBuf::from(plan)
        } else {
            repo_root.join(plan)
        };
        if !candidate.exists() && ops::ledger_file(repo_root, name).is_none() {
            findings.push(ArcFinding {
                code: "arc-document-missing".into(),
                sentence: format!(
                    "the arc record names `{plan}` as the document it is driving and no file \
                     stands there, nor does the arc have a plan or task list anywhere else."
                ),
                repair: None,
            });
        }
    }

    if arc.done {
        let open: Vec<String> = rows
            .iter()
            .filter(|r| r.status != "done" && r.status != "withdrawn")
            .map(|r| r.step.to_string())
            .collect();
        if !open.is_empty() {
            findings.push(ArcFinding {
                code: "arc-done-over-open-rows".into(),
                sentence: format!(
                    "the arc record says the arc finished while the table still reads step(s) {} \
                     as unclosed.",
                    open.join(", ")
                ),
                repair: None,
            });
        }
        return;
    }

    // An arc mid-flight with nobody seated is the stranded-arc shape: the
    // runner will rotate a stage onto a card that no session is bound to.
    // Only asked of an arc that is neither done nor stopped — a stopped arc
    // is *supposed* to be sitting there with nothing running.
    if arc.stopped.is_none()
        && arc.current_stage().is_some()
        && ops::bound_session_for(&ops::arc_owner_key(repo_root, name)).is_none()
    {
        findings.push(ArcFinding {
            code: "arc-unbound".into(),
            sentence: format!(
                "the arc is in its {} stage and no live session is bound to this arc — the \
                 next rotation has no card to land on.",
                arc.current_stage()
                    .map(|s| s.as_str().to_owned())
                    .unwrap_or_default()
            ),
            repair: None,
        });
    }
}

/// The seat against the record: an arc past devise has a branch and a
/// worktree, and the worktree is checked out on the branch.
///
/// Devise and review make nothing — they write documents at
/// `.tug/arcs/<name>/`, which is not in the worktree — so a record whose
/// stage is one of those is owed no seat and asked nothing here. The stage
/// read is the dispatched one first: the dispatch writes its intent before
/// the bridge lands the `arc-stage` line, and the seat is owed from the
/// dispatch on. A finished arc is skipped, because a join tears the seat
/// down on purpose.
///
/// The repair is `ops::create_in`, the same idempotent verb the dispatch
/// calls, and it is offered only where it is safe: a branch that is absent,
/// or present with no rounds on it. `create_in` rebuilds a branch whose
/// worktree is gone from the base, so a branch carrying rounds gets a
/// sentence naming them and no repair — which rounds to keep is a person's
/// judgment. A worktree standing on some other branch is the same kind of
/// question.
fn check_seat(
    findings: &mut Vec<ArcFinding>,
    arc: Option<&crate::arc::ArcRecord>,
    repo_root: &Path,
    name: &str,
) {
    use crate::arc::ArcStage;

    let Some(arc) = arc else {
        return;
    };
    if arc.done {
        return;
    }
    let stage = arc.dispatched.or(arc.current_stage());
    if !matches!(stage, Some(ArcStage::Implement | ArcStage::Audit)) {
        return;
    }
    let stage_word = stage.map(|s| s.as_str().to_owned()).unwrap_or_default();

    let root = ops::main_repo_root(repo_root);
    let branch = ops::branch_name(name);
    let worktree = ops::worktree_path(&root, name);
    let have_branch = ops::branch_exists(&root, &branch);
    let have_worktree = worktree.is_dir();

    if have_branch && have_worktree {
        let on =
            ops::git_stdout(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
        if on != branch {
            findings.push(ArcFinding {
                code: "seat-missing".into(),
                sentence: format!(
                    "the arc is in its {stage_word} stage and its worktree at `{}` has `{on}` \
                     checked out rather than `{branch}` — a round made there would land on the \
                     wrong branch.",
                    worktree.display()
                ),
                repair: None,
            });
        }
        return;
    }

    let rounds = if have_branch {
        ops::round_count_in(&root, name)
    } else {
        0
    };
    let missing = match (have_branch, have_worktree) {
        (false, false) => "neither its branch nor its worktree exists".to_string(),
        (true, false) => format!("its worktree at `{}` does not exist", worktree.display()),
        (false, true) => format!("its branch `{branch}` does not exist"),
        (true, true) => unreachable!("handled above"),
    };
    let repair = if rounds == 0 {
        Some(ArcRepair::MakeSeat {
            effect: format!(
                "the branch `{branch}` and the worktree at `{}` would exist for the stage to work in",
                worktree.display()
            ),
        })
    } else {
        None
    };
    let tail = if rounds == 0 {
        String::new()
    } else {
        format!(
            " The branch carries {rounds} round(s), so the doctor will not rebuild it; re-attach \
             the worktree by hand with `git worktree add`."
        )
    };
    findings.push(ArcFinding {
        code: "seat-missing".into(),
        sentence: format!(
            "the arc is in its {stage_word} stage and {missing} — the `where` line would name a \
             seat no stage can sit in.{tail}"
        ),
        repair,
    });
}

/// The one base-checkout finding a running stage is not stopped for.
///
/// Base copies of the arc's own bytes are something the join drops by itself,
/// and they arise innocently — a note written on the base from the arc's work
/// leaves exactly this. The doctor names them because a person reading `git
/// status` should find them explained; a runner that stopped an arc over them
/// would be stopping it for a state the machine already handles.
pub const BASE_ECHO_CODE: &str = "base-echo";

/// The base checkout: what a failed join leaves where the five records cannot
/// see it. Each finding names the state and the verb that clears it; none
/// carries a repair, because every clearing act touches the user's checkout
/// and `resolve-base` is the door that records doing so.
fn check_base_checkout(findings: &mut Vec<ArcFinding>, repo_root: &Path, name: &str) {
    let root = ops::main_repo_root(repo_root);
    let mut push = |code: &str, sentence: String| {
        findings.push(ArcFinding {
            code: code.to_string(),
            sentence,
            repair: None,
        });
    };

    if let Some(op) = crate::oplog::stranded_join(&root, name) {
        push("base-stranded", crate::oplog::stranded_detail(&op));
    }

    // Any other operation that began and never finished. A join between its
    // integrate and its end is not one of these: it carries progress, and
    // `join --continue` is its own door.
    for op in crate::oplog::list_ops(&root).into_iter().filter(|op| {
        op.arc == name && op.after.is_none() && op.join.is_none() && op.stranded.is_none()
    }) {
        push(
            "op-incomplete",
            format!(
                "Operation {} ({} of '{name}') began and never finished, so what it changed on '{}' is unrecorded. Check the base checkout, then clear it with: tugtool arc resolve-base {name}",
                op.seq,
                op.verb.as_str(),
                op.before.base_branch
            ),
        );
    }

    let Some(base) = ops::read_base_checkout(&root, name) else {
        return;
    };
    if base.squash_standing {
        push(
            "base-squash-standing",
            format!(
                "A SQUASH_MSG naming this arc's rounds is standing on the base checkout — a squash of '{name}' was staged there and never committed. Clear it with: tugtool arc resolve-base {name}"
            ),
        );
    }
    if !base.echoed.is_empty() {
        push(
            BASE_ECHO_CODE,
            format!(
                "The base checkout holds, uncommitted, the same bytes arc '{name}' carries for {} ({}). A join drops them itself; to clear them now: tugtool arc resolve-base {name}",
                if base.echoed.len() == 1 { "one path".to_string() } else { format!("{} paths", base.echoed.len()) },
                base.echoed.join(", ")
            ),
        );
    }
}

/// What a `arc doctor` run did.
#[derive(Debug, Clone, Serialize)]
pub struct DoctorOutcome {
    #[serde(flatten)]
    pub diagnosis: ArcDiagnosis,
    /// Whether `--repair` was asked for.
    pub repaired: bool,
    /// The arc log lines actually appended, in order.
    pub appended: Vec<String>,
    /// The seat, when the run made one: the worktree path `create_in`
    /// returned. Empty on every run that did not make the seat.
    pub made: Vec<String>,
    /// Findings that carry no repair, so a `--repair` run still leaves them.
    pub left_for_a_person: usize,
}

/// Diagnose `name`, and — with `repair` — take every reconciling act.
///
/// A repair run re-diagnoses first, so it never appends against a reading
/// taken before something else moved. The appends go through
/// [`crate::log::append_arc_log`], the same door every other declaration
/// uses, because a repair that wrote the log a second way would be the first
/// thing a later reader had to learn about. The seat is made through
/// [`ops::create_in`], the same door the dispatch uses.
///
/// A name with no arc behind it — no arc record in the log and no branch or
/// id in git — is refused rather than pronounced healthy: "the records
/// agree" about an arc that does not exist is the reading that hid the
/// missing seat in the first place.
pub fn doctor(repo_root: &Path, name: &str, repair: bool) -> Result<DoctorOutcome, String> {
    if crate::arc::read_arc(repo_root, name).is_none()
        && !ops::arc_record_exists(&ops::main_repo_root(repo_root), name)
    {
        return Err(format!("no arc named `{name}`"));
    }
    let diagnosis = diagnose(repo_root, name);
    let mut appended = Vec::new();
    let mut made = Vec::new();
    if repair {
        for finding in &diagnosis.findings {
            let Some(fix) = &finding.repair else {
                continue;
            };
            match fix {
                ArcRepair::Append { marker, note, .. } => {
                    crate::log::append_arc_log(repo_root, name, marker, note)
                        .map_err(|e| format!("the reconciling append failed: {e}"))?;
                    appended.push(format!("{marker}  {note}"));
                }
                ArcRepair::MakeSeat { .. } => {
                    let outcome = ops::create_in(repo_root, name, None, false, None)
                        .map_err(|e| format!("the seat could not be made: {e}"))?;
                    made.push(outcome.worktree);
                }
            }
        }
    }
    let left_for_a_person = diagnosis
        .findings
        .iter()
        .filter(|f| f.repair.is_none())
        .count();
    Ok(DoctorOutcome {
        diagnosis,
        repaired: repair,
        appended,
        made,
        left_for_a_person,
    })
}

/// [`doctor`] against the cwd's repo — the CLI's entry point.
pub fn doctor_here(name: &str, repair: bool) -> Result<DoctorOutcome, String> {
    let repo_root = tugtool_core::find_repo_root().map_err(|e| e.to_string())?;
    doctor(&repo_root, name, repair)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ledger table as text, one row per `(step, title, status, commit)`.
    fn plan_with(rows: &[(u32, &str, &str, &str)]) -> String {
        let mut out = String::from(
            "## A Plan {#a-plan}\n\n\
             ### Plan Metadata {#plan-metadata}\n\n\
             | Field | Value |\n|---|---|\n| Owner | Someone |\n\n\
             ### Phase Overview {#phase-overview}\n\nContext.\n\n\
             ### Execution Steps {#execution-steps}\n\n\
             #### Step Status Ledger {#step-status-ledger}\n\n\
             | Step | Title | Status | Commit |\n|---|---|---|---|\n",
        );
        for (step, title, status, commit) in rows {
            out.push_str(&format!(
                "| #step-{step} | {title} | {status} | {commit} |\n"
            ));
        }
        out.push_str("\n##### Step 1 {#step-1}\n\n**Goal:** a thing.\n");
        out
    }

    /// The rows the checks actually compare, without a repo behind them.
    fn table(rows: &[(u32, &str, &str, &str)]) -> Vec<Row> {
        let source = plan_with(rows);
        tugtool_core::plan::parse(&source)
            .expect("the fixture parses")
            .ledger_rows
            .iter()
            .map(|r| Row {
                step: r.anchor.strip_prefix("step-").unwrap().parse().unwrap(),
                title: r.title.clone(),
                status: r.status.clone(),
                has_commit: r.commit.is_some(),
            })
            .collect()
    }

    fn decls(step: Option<(u32, u32)>, in_flight: bool) -> ArcDeclarations {
        ArcDeclarations {
            step,
            step_in_flight: in_flight,
            ..ArcDeclarations::default()
        }
    }

    fn codes(findings: &[ArcFinding]) -> Vec<&str> {
        findings.iter().map(|f| f.code.as_str()).collect()
    }

    /// The crash-between-the-two-writes shape, which is the one disagreement
    /// the doctor can always settle: the row moved, so the act happened.
    #[test]
    fn a_row_the_log_never_declared_is_named_and_repairable() {
        let rows = table(&[
            (1, "First", "in progress", "—"),
            (2, "Second", "pending", "—"),
        ]);
        let mut findings = Vec::new();
        check_table_against_log(&mut findings, &rows, &decls(None, false), true, "d");

        assert_eq!(codes(&findings), ["undeclared-open-row"]);
        assert!(
            findings[0].sentence.contains("step 1") && findings[0].sentence.contains("in progress"),
            "the sentence names the step and both records: {}",
            findings[0].sentence
        );
        let fix = findings[0].repair.as_ref().expect("this one reconciles");
        let ArcRepair::Append { marker, note, .. } = fix else {
            panic!("a log disagreement is repaired by an append: {fix:?}");
        };
        assert_eq!(marker, "step-start");
        assert!(
            note.starts_with("1/2 "),
            "the repair is a real step declaration: {note}"
        );
    }

    /// The log says a step is open and the table has already closed it — the
    /// desync that sends a resumed run to the wrong step.
    #[test]
    fn the_log_and_the_table_disagreeing_about_the_open_step_is_named() {
        let rows = table(&[
            (1, "First", "done", "`abc1234`"),
            (2, "Second", "pending", "—"),
        ]);
        let mut findings = Vec::new();
        check_table_against_log(&mut findings, &rows, &decls(Some((1, 2)), true), true, "d");

        assert_eq!(codes(&findings), ["open-step-status"]);
        let fix = findings[0].repair.as_ref().expect("this one reconciles");
        assert!(
            matches!(fix, ArcRepair::Append { marker, .. } if marker == "step-done"),
            "{fix:?}"
        );
    }

    /// A denominator that moved under a run in flight.
    #[test]
    fn a_plan_that_gained_rows_mid_run_is_named() {
        let rows = table(&[
            (1, "First", "in progress", "—"),
            (2, "Second", "pending", "—"),
            (3, "Third", "pending", "—"),
        ]);
        let mut findings = Vec::new();
        check_table_against_log(&mut findings, &rows, &decls(Some((1, 2)), true), true, "d");
        assert!(codes(&findings).contains(&"step-total"));
    }

    /// The audit's headline, and deliberately *not* repairable: which record
    /// is right is a judgment, and the doctor does not guess.
    #[test]
    fn a_join_armed_over_open_rows_is_named_and_left_for_a_person() {
        let rows = table(&[
            (1, "First", "done", "`abc1234`"),
            (2, "Second", "pending", "—"),
            (3, "Third", "done", "`def5678`"),
        ]);
        let armed = ArcDeclarations {
            run_through: Some(3),
            run_complete: true,
            ..ArcDeclarations::default()
        };
        let mut findings = Vec::new();
        check_run_arming(&mut findings, &rows, &armed);

        assert_eq!(codes(&findings), ["armed-over-open-rows"]);
        assert!(findings[0].repair.is_none(), "this one needs a person");
        assert!(
            findings[0].sentence.contains("step(s) 2"),
            "the sentence names the unclosed row: {}",
            findings[0].sentence
        );
    }

    /// A run whose selection really did finish raises nothing.
    #[test]
    fn a_finished_run_over_a_closed_table_is_quiet() {
        let rows = table(&[
            (1, "First", "done", "`abc1234`"),
            (2, "Second", "withdrawn", "—"),
        ]);
        let armed = ArcDeclarations {
            run_through: Some(2),
            run_complete: true,
            ..ArcDeclarations::default()
        };
        let mut findings = Vec::new();
        check_run_arming(&mut findings, &rows, &armed);
        check_commit_cells(&mut findings, &rows);
        check_table_against_log(&mut findings, &rows, &armed, true, "d");
        assert!(findings.is_empty(), "{:#?}", findings);
    }

    /// A `done` row whose commit cell is empty claims a round nobody can
    /// follow back to the work.
    #[test]
    fn a_done_row_with_no_commit_is_named() {
        let rows = table(&[(1, "First", "done", "—")]);
        let mut findings = Vec::new();
        check_commit_cells(&mut findings, &rows);
        assert_eq!(codes(&findings), ["done-without-commit"]);
    }

    /// A run that declared steps against a document that is gone: nothing to
    /// reconcile, because the missing record *is* the table.
    #[test]
    fn declarations_with_no_ledger_document_are_named() {
        let mut findings = Vec::new();
        check_table_against_log(&mut findings, &[], &decls(Some((2, 5)), true), false, "d");
        assert_eq!(codes(&findings), ["ledger-missing"]);
        assert!(findings[0].repair.is_none());
    }
}

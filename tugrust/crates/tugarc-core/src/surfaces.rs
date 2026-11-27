//! Resolving an arc's touched paths to the surfaces a project declared, and
//! those surfaces to the commands that check them.
//!
//! [`plan_verification`] and everything it calls are pure and total: functions
//! of a surface table, a range, and a list of touched paths. The decisions all
//! happen there, so [`verify_in`] — which reads git and runs commands — has
//! nothing left to work out but the doing.
//!
//! The table itself is already well-formed by the time it arrives: names are
//! unique, paths are relative and glob-free, no two surfaces claim the same
//! path, and every `checked_by` names a declared surface that does not itself
//! borrow. `ArcConfig::validate` refuses everything else at load, so the
//! resolution rules below can be stated without their error cases.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;
use tugcore::instance::Paths;
use tugtool_core::config::{Config, Surface, check_inputs};
use tugtool_core::test_ledger::{self, CheckRun, RecordedCheck, check_status};

use crate::error::ArcError;

/// What a verify run should do, decided before anything runs.
///
/// The four variants are checked in declaration order and the order is
/// load-bearing: an empty range is answered before the table is consulted, so
/// a project with neither a diff nor a table reports the range rather than the
/// table, which is the more specific fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// The range moved no paths. Neither a refusal nor a verification, and it
    /// records no fit: nothing was checked, so nothing is verified.
    NothingTouched,
    /// The project declares no surfaces. Not a refusal — a project that has
    /// not declared yet is in a state, and the ending degrades to the plan's
    /// own checkpoint commands.
    DeclaresNone,
    /// Paths the table claims nowhere. A refusal, before any check runs: a
    /// green report beside an unclaimed path is a report about the wrong
    /// thing.
    Unclaimed(Vec<String>),
    /// The surfaces the range actually touched, in declaration order, each
    /// with its commands already expanded.
    Planned(Vec<SurfacePlan>),
}

/// One surface the range touched, and what checking it comes to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SurfacePlan {
    /// The declared surface name.
    pub name: String,
    /// The touched paths that resolved here, in the order the diff reported
    /// them.
    pub paths: Vec<String>,
    /// The commands to run, own ones first and borrowed ones after, each with
    /// its placeholders already expanded.
    pub commands: Vec<PlannedCommand>,
    /// The surfaces this one borrows its checks from, in declaration order.
    /// Empty when it checks itself.
    pub borrowed_from: Vec<String>,
}

impl SurfacePlan {
    /// True when the surface claims its paths and declares nothing to run —
    /// prose, fixtures, generated artifacts. Counted separately from a checked
    /// surface, so the two can never be conflated in a receipt.
    pub fn is_claimed_unchecked(&self) -> bool {
        self.commands.is_empty()
    }
}

/// One command to run, expanded and attributed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedCommand {
    /// The command as it will be handed to `sh -c`.
    pub command: String,
    /// The surface whose `check` list declared it, which is this plan's own
    /// surface unless it was borrowed.
    pub declared_by: String,
    /// The surface that already ran this exact expanded string earlier in the
    /// run, when one did. The runner skips it and the report says so.
    pub already_run_for: Option<String>,
}

/// Whether a declared path claims a touched path.
///
/// A declaration claims a path it equals, or one it is a directory prefix of.
/// The directory test is what keeps `tugdeck` from claiming `tugdeck-old/x.ts`:
/// the prefix must end at a path boundary, either because the declaration
/// carries the slash itself or because the touched path does.
pub fn claims(declared: &str, touched: &str) -> bool {
    if declared == touched {
        return true;
    }
    let Some(rest) = touched.strip_prefix(declared) else {
        return false;
    };
    declared.ends_with('/') || rest.starts_with('/')
}

/// The surface claiming a touched path with the longest declaration, if any.
///
/// Ties cannot occur: two surfaces declaring the same path are refused at
/// load, so among the claiming declarations exactly one is longest.
pub(crate) fn claiming_surface<'a>(surfaces: &'a [Surface], touched: &str) -> Option<&'a Surface> {
    surfaces
        .iter()
        .filter_map(|surface| {
            surface
                .paths
                .iter()
                .filter(|declared| claims(declared, touched))
                .map(String::len)
                .max()
                .map(|len| (len, surface))
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, surface)| surface)
}

/// Wrap a path so `sh -c` receives it as one word, whatever it contains.
///
/// Single quotes take everything literally, so the only character needing work
/// is the single quote itself: close the quoting, emit an escaped quote,
/// reopen.
pub fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// Substitute the three placeholders into a declared command.
///
/// `{paths}` is the *running* surface's touched paths — for a borrowed
/// command, the borrower's rather than the lender's, because a borrowed
/// command runs as the borrower's own and the paths it is about are the
/// borrower's.
pub(crate) fn expand(command: &str, base: &str, head: &str, paths: &[String]) -> String {
    if !command.contains('{') {
        return command.to_string();
    }
    let quoted = paths
        .iter()
        .map(|p| shell_quote(p))
        .collect::<Vec<_>>()
        .join(" ");
    command
        .replace("{base}", base)
        .replace("{head}", head)
        .replace("{paths}", &quoted)
}

/// Decide what a verify run does, from the table and the range alone.
///
/// `touched` is the paths the range moved, in the order the diff reported
/// them. The four outcomes are checked in [`Resolution`]'s own order.
pub fn plan_verification(
    surfaces: &[Surface],
    base: &str,
    head: &str,
    touched: &[String],
) -> Resolution {
    if touched.is_empty() {
        return Resolution::NothingTouched;
    }
    if surfaces.is_empty() {
        return Resolution::DeclaresNone;
    }

    let mut unclaimed = Vec::new();
    let mut assigned: Vec<(String, Vec<String>)> = surfaces
        .iter()
        .map(|s| (s.name.clone(), Vec::new()))
        .collect();
    for path in touched {
        match claiming_surface(surfaces, path) {
            Some(surface) => {
                if let Some(slot) = assigned.iter_mut().find(|(name, _)| *name == surface.name) {
                    slot.1.push(path.clone());
                }
            }
            None => unclaimed.push(path.clone()),
        }
    }
    if !unclaimed.is_empty() {
        return Resolution::Unclaimed(unclaimed);
    }

    // De-duplication is across the whole run, so the first surface to ask for
    // an expanded string is the one credited with running it.
    let mut ran_by: Vec<(String, String)> = Vec::new();
    let mut plans = Vec::new();
    for surface in surfaces {
        let paths = assigned
            .iter()
            .find(|(name, _)| *name == surface.name)
            .map(|(_, paths)| paths.clone())
            .unwrap_or_default();
        if paths.is_empty() {
            // A surface the range never touched is not in the run at all: it
            // is absent from the report and counted in neither total.
            continue;
        }

        let borrowed = surface.checked_by.iter().filter_map(|lender| {
            surfaces
                .iter()
                .find(|s| s.name == *lender)
                .map(|s| (lender.clone(), s.check.clone()))
        });
        let declared: Vec<(String, String)> =
            surface
                .check
                .iter()
                .map(|c| (surface.name.clone(), c.clone()))
                .chain(borrowed.flat_map(|(lender, checks)| {
                    checks.into_iter().map(move |c| (lender.clone(), c))
                }))
                .collect();

        let mut commands = Vec::new();
        for (declared_by, command) in declared {
            let expanded = expand(&command, base, head, &paths);
            let already_run_for = ran_by
                .iter()
                .find(|(cmd, _)| *cmd == expanded)
                .map(|(_, owner)| owner.clone());
            if already_run_for.is_none() {
                ran_by.push((expanded.clone(), surface.name.clone()));
            }
            commands.push(PlannedCommand {
                command: expanded,
                declared_by,
                already_run_for,
            });
        }

        plans.push(SurfacePlan {
            name: surface.name.clone(),
            paths,
            commands,
            borrowed_from: surface.checked_by.clone(),
        });
    }

    Resolution::Planned(plans)
}

// --- the run ---------------------------------------------------------------

/// A verify run's whole result: the range it covered, what it found, and the
/// one line that says so.
#[derive(Debug, Clone, Serialize)]
pub struct VerifyReport {
    /// The range's base sha, full.
    pub base: String,
    /// The range's head sha, full.
    pub head: String,
    /// What the resolution came to, as a word: `verified`, `red`,
    /// `timed-out`, `unclaimed`, `declares-none`, or `nothing-in-range`.
    pub verdict: String,
    /// The paths no surface claimed. Empty unless the verdict is `unclaimed`.
    pub unclaimed: Vec<String>,
    /// The surfaces the range touched, with each command's outcome.
    pub surfaces: Vec<SurfaceResult>,
    /// How many surfaces ran at least one command.
    pub checked: usize,
    /// How many surfaces claimed their paths and declared nothing to run.
    pub claimed_unchecked: usize,
    /// How many surfaces ran nothing because every one of their checks was
    /// already green on record over the same input bytes. Counted apart from
    /// `checked`, so a receipt never passes a skip off as a run.
    pub relied: usize,
    /// Why the record could not be read or written, when it could not. The
    /// verify then ran every check and recorded what it could; this says so
    /// rather than failing a verify over its memo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_note: Option<String>,
    /// On a red verify, each failing test its checks recorded and what the
    /// records hold of it on the arc's base branch. Advice beside the red: it
    /// turns nothing green and leaves no check out. Empty on any other
    /// verdict, and when neither ledger recorded a failure.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reds: Vec<tugtool_core::red_history::RedTest>,
    /// The arc's base branch the `reds` were read against.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// The closing `TUG-VERIFY-RECEIPT:` line, verbatim, so the text output
    /// and the JSON cannot say different things.
    pub receipt: String,
}

impl VerifyReport {
    /// The process exit status: 0 verified / declared-none / nothing in
    /// range, 1 a red check or a run its deadline stopped, 2 an unclaimed
    /// path.
    pub fn exit_code(&self) -> u8 {
        match self.verdict.as_str() {
            "red" | "timed-out" => 1,
            "unclaimed" => 2,
            _ => 0,
        }
    }
}

/// One surface's outcome.
#[derive(Debug, Clone, Serialize)]
pub struct SurfaceResult {
    pub name: String,
    pub paths: Vec<String>,
    pub commands: Vec<CommandResult>,
    pub borrowed_from: Vec<String>,
    /// True when a command in this surface exited non-zero.
    pub red: bool,
    /// True when the surface ran nothing because every check, own and
    /// borrowed, had a green row on record over the same command and the same
    /// input bytes. Its commands read `recorded`, each naming the row.
    pub relied_on_record: bool,
    /// The tests its checks' children passed, summed over the checks whose
    /// child recorded; `None` when none did.
    pub passed: Option<u64>,
    /// The tests its checks' children ran, summed the same way.
    pub total: Option<u64>,
    /// The first red check's first failure, when its child recorded one.
    pub title: Option<String>,
    pub message: Option<String>,
}

/// One command's outcome.
#[derive(Debug, Clone, Serialize)]
pub struct CommandResult {
    /// The expanded string handed to `sh -c`.
    pub command: String,
    /// The surface whose `check` list declared it.
    pub declared_by: String,
    /// `ran`, `already-run`, `not-reached` — a command after a red one in
    /// the same surface, or any command after a deadline passed —
    /// `timed-out`, a check that was still running at the run's deadline and
    /// was killed, or `not-started`, the check the deadline had already
    /// passed before, which ran nothing — or `recorded`, a check in a surface
    /// the verify relied on the record for, which carries the record's exit.
    pub status: String,
    /// The process exit code, when it ran.
    pub exit_code: Option<i32>,
    /// The surface credited with having already run this exact string.
    pub already_run_for: Option<String>,
    /// What the record keyed to the call says the child did: tests passed of
    /// total, and the first failure's title and message. `None` throughout
    /// when the child recorded nothing — a command no runner wrapped.
    pub passed: Option<u64>,
    pub total: Option<u64>,
    pub title: Option<String>,
    pub message: Option<String>,
    /// The recorded green run this check relied on, when its surface was
    /// skipped: when it ran, at which head, and how long it took.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relied_on: Option<ReliedOn>,
}

/// The recorded check a skipped one relied on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReliedOn {
    /// When the green run was recorded, in seconds since the epoch.
    pub recorded_at: i64,
    /// The head the green run was recorded at.
    pub head: String,
    /// How long the green run took.
    pub wall_secs: f64,
}

/// A check's verdict as its wrapped child recorded it: tests passed of total,
/// and the first red's title and message. The caller's `verdict` reads one
/// after each check exits — from the record keyed to the call, which this
/// crate does not open — and `None` says nothing was recorded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChildVerdict {
    pub passed: Option<u64>,
    pub total: Option<u64>,
    pub title: Option<String>,
    pub message: Option<String>,
}

/// What a caller puts around a verify's checks. `wrap` rewrites each check
/// before it runs; `verdict` is asked, after it exits, what its child
/// recorded; `watch` is told each surface as it starts and lands. This crate
/// knows no runner table and opens no record, so all three are the caller's,
/// and [`verify_in`] supplies the ones that do nothing.
pub struct VerifyHooks<'a> {
    pub wrap: &'a dyn Fn(&str) -> String,
    pub verdict: &'a mut dyn FnMut(&str) -> Option<ChildVerdict>,
    pub watch: &'a mut dyn FnMut(VerifyEvent<'_>),
    /// The record a verify may rely on and writes each check into; `None`
    /// runs every check and records nothing.
    pub memo: Option<&'a VerifyMemo>,
}

/// Where a verify keeps its record of checks, and whether it may rely on it.
///
/// A surface is skipped whole, never in part, and only when every one of its
/// checks, own and borrowed, has a green, completed row in the record with the
/// same expanded command and the same content key over that check's inputs,
/// from within [`test_ledger::CHECK_REUSE_SECS`]. A surface that runs is keyed
/// before and after, and each check is recorded only when the two keys agree,
/// so a check that rewrote its own inputs never vouches for bytes it did not
/// read.
#[derive(Debug, Clone)]
pub struct VerifyMemo {
    /// The test results ledger.
    pub ledger: PathBuf,
    /// Run every check whatever the record says — `--fresh`. What runs is
    /// still recorded.
    pub fresh: bool,
    /// The Bash call the verify runs under, written beside each check.
    pub tool_use_id: Option<String>,
}

/// One verify's use of the record: the open ledger and what it needs to key,
/// read and write a check.
struct MemoRun<'a> {
    worktree: &'a Path,
    surfaces: &'a [Surface],
    conn: rusqlite::Connection,
    head: String,
    fresh: bool,
    tool_use_id: Option<String>,
    note: Option<String>,
}

impl MemoRun<'_> {
    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// The key over the inputs a check declared by `declared_by` reads, or
    /// `None` — a miss that also records nothing — when it cannot be computed.
    fn key(&mut self, declared_by: &str) -> Option<String> {
        let inputs = check_inputs(self.surfaces, declared_by).to_vec();
        match crate::input_key::input_key(self.worktree, &inputs) {
            Ok(key) => Some(key),
            Err(e) => {
                self.note
                    .get_or_insert_with(|| format!("the input key could not be computed: {e}"));
                None
            }
        }
    }

    fn lookup(&mut self, command: &str, key: &str) -> Option<RecordedCheck> {
        match test_ledger::reusable_check(&self.conn, self.worktree, command, key, Self::now()) {
            Ok(found) => found,
            Err(e) => {
                self.note
                    .get_or_insert_with(|| format!("the record could not be read: {e}"));
                None
            }
        }
    }

    fn record(
        &mut self,
        command: &str,
        key: String,
        exit_code: Option<i64>,
        status: &str,
        secs: f64,
    ) {
        let check = CheckRun {
            recorded_at: Self::now(),
            run_root: self.worktree.to_string_lossy().into_owned(),
            head_sha: self.head.clone(),
            command: command.to_string(),
            input_key: key,
            exit_code,
            status: status.to_string(),
            wall_secs: secs,
            tool_use_id: self.tool_use_id.clone(),
        };
        if let Err(e) = test_ledger::record_check(&mut self.conn, &check) {
            self.note
                .get_or_insert_with(|| format!("a check could not be recorded: {e}"));
        }
    }
}

/// What a verify run tells whoever watches it, as it goes: the surfaces it
/// will run, then each one as it starts and as it lands. A watcher sees the
/// run's progress and changes nothing in it.
#[derive(Debug, Clone, Copy)]
pub enum VerifyEvent<'a> {
    /// The surfaces the run will check, in order, each with the number of
    /// checks it carries.
    Planned(&'a [(String, usize)]),
    /// A surface's checks begin.
    Started(&'a str),
    /// A surface has landed.
    Finished(&'a SurfaceResult),
}

/// Run a surface plan and report what happened. Each command is passed
/// through `wrap` before it runs — the caller's chance to put a reporting
/// wrapper in front of a runner it recognises — and is recorded as declared,
/// so the report reads the config's own words. After each command exits,
/// `verdict` is asked what its child recorded, and the answer rides the
/// command's result and, summed, its surface's.
///
/// A red command ends its own surface and nothing else: every surface runs, so
/// one report names every failure rather than the first one.
///
/// A `deadline` ends the whole run: a check still running when it passes is
/// killed and reads `timed-out`, and every command after it, in any surface,
/// is `not-reached`.
///
/// With a `memo`, each surface is keyed as it starts: a surface every one of
/// whose checks is green on record over the same command and key runs nothing
/// and reads `relied_on_record`; any other runs whole, each check seeing its
/// key in [`test_ledger::CHECK_INPUT_KEY_ENV`], and each check is recorded
/// once it ends, when its key after is the key it started from.
#[allow(clippy::too_many_arguments)]
fn run_plans(
    worktree: &Path,
    plans: Vec<SurfacePlan>,
    quiet: bool,
    deadline: Option<Instant>,
    wrap: &dyn Fn(&str) -> String,
    verdict: &mut dyn FnMut(&str) -> Option<ChildVerdict>,
    watch: &mut dyn FnMut(VerifyEvent<'_>),
    mut memo: Option<&mut MemoRun<'_>>,
) -> Vec<SurfaceResult> {
    let planned: Vec<(String, usize)> = plans
        .iter()
        .map(|plan| (plan.name.clone(), plan.commands.len()))
        .collect();
    watch(VerifyEvent::Planned(&planned));
    let mut results = Vec::new();
    let mut expired = false;
    for plan in plans {
        watch(VerifyEvent::Started(&plan.name));

        // Each check's key as the surface starts, over the inputs of the
        // surface that declared it; one computation per declaring surface.
        let keys: Vec<Option<String>> = match memo.as_deref_mut() {
            Some(m) if !expired => {
                let mut by_declarer: HashMap<String, Option<String>> = HashMap::new();
                plan.commands
                    .iter()
                    .map(|c| {
                        by_declarer
                            .entry(c.declared_by.clone())
                            .or_insert_with(|| m.key(&c.declared_by))
                            .clone()
                    })
                    .collect()
            }
            _ => vec![None; plan.commands.len()],
        };

        // Rely on the record only when every check, own and borrowed, hits.
        let relied: Option<Vec<RecordedCheck>> = match memo.as_deref_mut() {
            Some(m) if !m.fresh && !expired && !plan.commands.is_empty() => plan
                .commands
                .iter()
                .zip(&keys)
                .map(|(c, key)| key.as_deref().and_then(|k| m.lookup(&c.command, k)))
                .collect(),
            _ => None,
        };
        if let Some(rows) = relied {
            let commands: Vec<CommandResult> = plan
                .commands
                .into_iter()
                .zip(rows)
                .map(|(planned, row)| CommandResult {
                    command: planned.command,
                    declared_by: planned.declared_by,
                    status: "recorded".to_string(),
                    exit_code: row.exit_code.map(|c| c as i32),
                    already_run_for: planned.already_run_for,
                    passed: None,
                    total: None,
                    title: None,
                    message: None,
                    relied_on: Some(ReliedOn {
                        recorded_at: row.recorded_at,
                        head: row.head_sha,
                        wall_secs: row.wall_secs,
                    }),
                })
                .collect();
            let result = SurfaceResult {
                name: plan.name,
                paths: plan.paths,
                passed: None,
                total: None,
                title: None,
                message: None,
                commands,
                borrowed_from: plan.borrowed_from,
                red: false,
                relied_on_record: true,
            };
            watch(VerifyEvent::Finished(&result));
            results.push(result);
            continue;
        }

        let mut commands = Vec::new();
        let mut red = false;
        for (planned, key) in plan.commands.into_iter().zip(keys) {
            if red || expired {
                commands.push(CommandResult {
                    command: planned.command,
                    declared_by: planned.declared_by,
                    status: "not-reached".to_string(),
                    exit_code: None,
                    already_run_for: planned.already_run_for,
                    passed: None,
                    total: None,
                    title: None,
                    message: None,
                    relied_on: None,
                });
                continue;
            }
            if planned.already_run_for.is_some() {
                commands.push(CommandResult {
                    command: planned.command,
                    declared_by: planned.declared_by,
                    status: "already-run".to_string(),
                    exit_code: None,
                    already_run_for: planned.already_run_for,
                    passed: None,
                    total: None,
                    title: None,
                    message: None,
                    relied_on: None,
                });
                continue;
            }
            let mut cmd = Command::new("sh");
            cmd.arg("-c")
                .arg(wrap(&planned.command))
                .current_dir(worktree);
            // A check this verify did not key carries no key: one inherited
            // from an outer verify (this verify running inside its checks)
            // names bytes this check was never keyed over.
            match &key {
                Some(key) => cmd.env(test_ledger::CHECK_INPUT_KEY_ENV, key),
                None => cmd.env_remove(test_ledger::CHECK_INPUT_KEY_ENV),
            };
            if quiet {
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
            let clock = Instant::now();
            let (exit_code, ended) = run_check(cmd, deadline);
            let secs = clock.elapsed().as_secs_f64();
            let timed_out = ended != CheckEnd::Exited;
            if exit_code != 0 || timed_out {
                red = true;
            }
            expired |= timed_out;
            if let (Some(m), Some(before), true) =
                (memo.as_deref_mut(), key, ended != CheckEnd::NotStarted)
            {
                // A check that moved its own inputs vouches for nothing.
                if m.key(&planned.declared_by).as_deref() == Some(before.as_str()) {
                    let status = match ended {
                        CheckEnd::Killed => check_status::TIMED_OUT,
                        _ if exit_code == 0 => check_status::PASS,
                        _ => check_status::FAIL,
                    };
                    m.record(
                        &planned.command,
                        before,
                        Some(i64::from(exit_code)),
                        status,
                        secs,
                    );
                }
            }
            let child = verdict(&planned.command).unwrap_or_default();
            commands.push(CommandResult {
                command: planned.command,
                declared_by: planned.declared_by,
                status: match ended {
                    CheckEnd::Exited => "ran",
                    CheckEnd::Killed => "timed-out",
                    CheckEnd::NotStarted => "not-started",
                }
                .to_string(),
                exit_code: (ended != CheckEnd::NotStarted).then_some(exit_code),
                already_run_for: None,
                passed: child.passed,
                total: child.total,
                title: child.title,
                message: child.message,
                relied_on: None,
            });
        }
        let recorded = commands.iter().filter(|c| c.total.is_some());
        let total = recorded.clone().map(|c| c.total.unwrap_or(0)).sum::<u64>();
        let passed = recorded.clone().map(|c| c.passed.unwrap_or(0)).sum::<u64>();
        let any_recorded = recorded.count() > 0;
        let first_red = commands
            .iter()
            .find(|c| c.exit_code.is_some_and(|code| code != 0));
        let result = SurfaceResult {
            name: plan.name,
            paths: plan.paths,
            passed: any_recorded.then_some(passed),
            total: any_recorded.then_some(total),
            title: first_red.and_then(|c| c.title.clone()),
            message: first_red.and_then(|c| c.message.clone()),
            commands,
            borrowed_from: plan.borrowed_from,
            red,
            relied_on_record: false,
        };
        watch(VerifyEvent::Finished(&result));
        results.push(result);
    }
    results
}

/// How a check ended: on its own, killed at the deadline, or never started
/// because the deadline had already passed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckEnd {
    Exited,
    Killed,
    NotStarted,
}

/// Run one check to its exit, or to `deadline` if that comes first, and
/// answer its exit code and how it ended.
///
/// With a deadline the check runs in a process group of its own, and a
/// watchdog thread waits out the time left on a channel the exit closes. If
/// the time runs out first it kills the whole group — `sh -c` and everything
/// the check started, which is what a wedged test run is made of — and the
/// wait below it returns. A deadline already past runs nothing.
fn run_check(mut cmd: Command, deadline: Option<Instant>) -> (i32, CheckEnd) {
    let code_of = |status: std::io::Result<std::process::ExitStatus>| match status {
        Ok(s) => s.code().unwrap_or(-1),
        Err(_) => -1,
    };
    let Some(deadline) = deadline else {
        return (code_of(cmd.status()), CheckEnd::Exited);
    };
    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
        return (-1, CheckEnd::NotStarted);
    };
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let Ok(mut child) = cmd.spawn() else {
        return (-1, CheckEnd::Exited);
    };
    let group = child.id() as libc::pid_t;
    let (exited, exit_seen) = std::sync::mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        match exit_seen.recv_timeout(remaining) {
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // SAFETY: `killpg` takes plain integers and touches no memory
                // of ours; the group is the one `process_group(0)` made for
                // this check, whose leader has not been waited on yet.
                unsafe { libc::killpg(group, libc::SIGKILL) };
                true
            }
            _ => false,
        }
    });
    let status = child.wait();
    let _ = exited.send(());
    let timed_out = watchdog.join().unwrap_or(false);
    let ended = if timed_out {
        CheckEnd::Killed
    } else {
        CheckEnd::Exited
    };
    (code_of(status), ended)
}

/// The paths a range moved, in the order git reported them, with a rename
/// reported at its destination.
fn touched_paths(repo: &Path, base: &str, head: &str) -> Result<Vec<String>, ArcError> {
    let range = format!("{base}..{head}");
    // `-c core.quotepath=false` used to sit here: a local discovery that
    // un-quotes a non-ASCII name and leaves a `"`, a `\`, a tab and a newline
    // quoted. The [B01] door supersedes it — `-z` is total where that was
    // partial — so the flag is gone rather than kept beside it.
    let args = ["diff", "--name-status", "-M", &range];
    let records = tugchanges_core::listing(repo, &args).map_err(|e| {
        ArcError::git(
            format!("git diff --name-status {range} failed"),
            &args,
            e.to_string(),
        )
    })?;
    Ok(crate::ops::name_status_paths(&records))
}

/// Verify the fit of an arc: resolve the range it would land, check every
/// surface it touched, and report. Each check runs as declared, unwrapped.
///
/// The range is derived live rather than remembered — `merge-base(base,
/// branch)..branch` is an arc's own contribution, which is what a join lands
/// and therefore what the fit is about. It is answerable for an arc that has
/// never been replayed, which a recorded range could not be.
pub fn verify_in(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    base_override: Option<&str>,
    head_override: Option<&str>,
) -> Result<VerifyReport, ArcError> {
    verify_run(
        paths,
        repo_root,
        name,
        base_override,
        head_override,
        VerifyHooks {
            wrap: &|command| command.to_string(),
            verdict: &mut |_| None,
            watch: &mut |_| {},
            memo: None,
        },
        None,
    )
}

/// [`verify_watched`] over the arc's own range, with a horizon: a check still
/// running at `deadline` is killed, nothing after it runs, and the report's
/// verdict is `timed-out`. This is the verify the base-motion engine's re-audit
/// runs, for which a wedged check would otherwise be a wait with no end; the
/// caller's [`VerifyHooks`] wrap its checks, read what their children
/// recorded, and watch each surface as it goes, exactly as they do for
/// [`verify_watched`].
pub fn verify_by(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    deadline: Instant,
    hooks: VerifyHooks<'_>,
) -> Result<VerifyReport, ArcError> {
    verify_run(paths, repo_root, name, None, None, hooks, Some(deadline))
}

/// [`verify_in`] with the caller's [`VerifyHooks`]: each check passes through
/// `wrap` before it runs, `verdict` is asked what its child recorded once it
/// exits, and `watch` is told each surface as it starts and lands, so a
/// caller can put its own reporting wrapper in front of the runners it knows,
/// read the record those runners write, and show the run while it is still
/// running. A check is recorded as the config declared it whatever `wrap`
/// ran.
pub fn verify_watched(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    base_override: Option<&str>,
    head_override: Option<&str>,
    hooks: VerifyHooks<'_>,
) -> Result<VerifyReport, ArcError> {
    verify_run(
        paths,
        repo_root,
        name,
        base_override,
        head_override,
        hooks,
        None,
    )
}

/// The one body behind [`verify_in`], [`verify_by`] and [`verify_watched`].
fn verify_run(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    base_override: Option<&str>,
    head_override: Option<&str>,
    hooks: VerifyHooks<'_>,
    deadline: Option<Instant>,
) -> Result<VerifyReport, ArcError> {
    let repo = crate::ops::main_repo_root(repo_root);
    let branch = crate::ops::branch_name(name);
    // Runs recorded from here on are this verify's; a red one's failures are
    // read back from the ledgers by this bound.
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if crate::ops::git_stdout(
        &repo,
        &["rev-parse", "--verify", &format!("{branch}^{{commit}}")],
    )
    .is_err()
    {
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }
    let worktree = crate::ops::worktree_path(&repo, name);
    if !worktree.is_dir() {
        return Err(ArcError::Refused(format!(
            "arc '{name}' has no worktree at {} — checks run from the worktree root",
            worktree.display()
        )));
    }

    let head = match head_override {
        Some(h) => crate::ops::git_stdout(&repo, &["rev-parse", h])?,
        None => crate::ops::git_stdout(&repo, &["rev-parse", &branch])?,
    };
    // The base the fit line records is always the arc's fork at the verified
    // head, whatever range the checks were scoped to. The line is a fact
    // about a tree — this head on this base — which the audit's mark is
    // cross-checked against; a `--base` override narrows which paths ran, not
    // which base the head stands on, so recording the override would write a
    // pair no mark could ever match. The scope rides the line's tail instead.
    let base_branch = crate::ops::arc_base(&repo, name)?;
    let fork = crate::ops::git_stdout(&repo, &["merge-base", &base_branch, &head])?;
    let base = match base_override {
        Some(b) => crate::ops::git_stdout(&repo, &["rev-parse", b])?,
        None => fork.clone(),
    };
    let scope = if base == fork {
        String::new()
    } else {
        format!(" · scoped from {}", short(&base))
    };

    let touched = touched_paths(&repo, &base, &head)?;
    let config =
        Config::load_from_project(&worktree).map_err(|e| ArcError::Refused(e.to_string()))?;
    let surfaces = config.tugtool.arc.surfaces;

    let resolution = plan_verification(&surfaces, &base, &head, &touched);
    Ok(match resolution {
        Resolution::NothingTouched => VerifyReport {
            receipt: format!(
                "TUG-VERIFY-RECEIPT: nothing in range {}..{}",
                short(&base),
                short(&head)
            ),
            base,
            head,
            verdict: "nothing-in-range".to_string(),
            unclaimed: Vec::new(),
            surfaces: Vec::new(),
            checked: 0,
            claimed_unchecked: 0,
            relied: 0,
            record_note: None,
            reds: Vec::new(),
            base_branch: None,
        },
        Resolution::DeclaresNone => VerifyReport {
            base,
            head,
            verdict: "declares-none".to_string(),
            unclaimed: Vec::new(),
            surfaces: Vec::new(),
            checked: 0,
            claimed_unchecked: 0,
            relied: 0,
            record_note: None,
            reds: Vec::new(),
            base_branch: None,
            receipt: "TUG-VERIFY-RECEIPT: this project declares no surfaces".to_string(),
        },
        Resolution::Unclaimed(paths) => VerifyReport {
            base,
            head,
            verdict: "unclaimed".to_string(),
            receipt: format!("TUG-VERIFY-RECEIPT: unclaimed {} paths", paths.len()),
            unclaimed: paths,
            surfaces: Vec::new(),
            checked: 0,
            claimed_unchecked: 0,
            relied: 0,
            record_note: None,
            reds: Vec::new(),
            base_branch: None,
        },
        Resolution::Planned(plans) => {
            let mut record_note = None;
            let mut memo_run = match hooks.memo {
                Some(memo) => match test_ledger::open_ledger(&memo.ledger) {
                    Ok(conn) => Some(MemoRun {
                        worktree: &worktree,
                        surfaces: &surfaces,
                        conn,
                        head: head.clone(),
                        fresh: memo.fresh,
                        tool_use_id: memo.tool_use_id.clone(),
                        note: None,
                    }),
                    Err(e) => {
                        record_note = Some(format!("the record could not be opened: {e}"));
                        None
                    }
                },
                None => None,
            };
            let results = run_plans(
                &worktree,
                plans,
                false,
                deadline,
                hooks.wrap,
                hooks.verdict,
                hooks.watch,
                memo_run.as_mut(),
            );
            if let Some(note) = memo_run.and_then(|m| m.note) {
                record_note.get_or_insert(note);
            }
            let relied = results.iter().filter(|r| r.relied_on_record).count();
            let checked = results
                .iter()
                .filter(|r| !r.commands.is_empty() && !r.relied_on_record)
                .count();
            let claimed_unchecked = results.iter().filter(|r| r.commands.is_empty()).count();
            let relied_tail = if relied > 0 {
                format!(" · {relied} relied on the record")
            } else {
                String::new()
            };
            let reds: Vec<&SurfaceResult> = results.iter().filter(|r| r.red).collect();
            let expired = results
                .iter()
                .flat_map(|r| r.commands.iter().map(move |c| (r, c)))
                .find(|(_, c)| c.status == "timed-out" || c.status == "not-started");
            let receipt = if let Some((surface, command)) = expired {
                if command.status == "not-started" {
                    format!(
                        "TUG-VERIFY-RECEIPT: timed out · {}: the deadline passed before `{}` could start",
                        surface.name, command.command
                    )
                } else {
                    format!(
                        "TUG-VERIFY-RECEIPT: timed out · {}: `{}` was still running at the deadline and was stopped",
                        surface.name, command.command
                    )
                }
            } else if reds.is_empty() {
                format!(
                    "TUG-VERIFY-RECEIPT: verified {} · {} surfaces checked · {} claimed unchecked{}",
                    short(&head),
                    checked,
                    claimed_unchecked,
                    relied_tail
                )
            } else {
                format!(
                    "TUG-VERIFY-RECEIPT: red {} surfaces · {}",
                    reds.len(),
                    first_reds(&reds).join(" · ")
                )
            };
            if reds.is_empty() {
                // Only a green run records. A red or refused run writing "not
                // verified at <head>" would leave a durable fact about a state
                // the next fix erases; the absence of a line is the honest
                // record of not-verified.
                crate::log::append_arc_log(
                    paths,
                    &repo,
                    name,
                    "verified",
                    &format!(
                        "{head} onto {fork} · {checked} surfaces checked · {claimed_unchecked} claimed unchecked{relied_tail}{scope}"
                    ),
                )
                .map_err(|e| ArcError::arc_log(paths, &repo, e))?;
            }
            let red_tests = if reds.is_empty() {
                Vec::new()
            } else {
                let ledger = hooks
                    .memo
                    .map(|memo| memo.ledger.clone())
                    .unwrap_or_else(|| paths.test_results_db.clone());
                red_history_of(
                    &ledger,
                    &paths.apptest_results_db,
                    &worktree,
                    &base_branch,
                    &head,
                    since,
                )
            };
            VerifyReport {
                base,
                head,
                verdict: if expired.is_some() {
                    "timed-out"
                } else if reds.is_empty() {
                    "verified"
                } else {
                    "red"
                }
                .to_string(),
                unclaimed: Vec::new(),
                surfaces: results,
                checked,
                claimed_unchecked,
                relied,
                record_note,
                base_branch: (!red_tests.is_empty()).then(|| base_branch.clone()),
                reds: red_tests,
                receipt,
            }
        }
    })
}

/// What the records hold, on the base branch, of each test a red verify's
/// checks failed — read from the test ledger at `test_ledger` and the app-test
/// ledger at `apptest_ledger`. A ledger file that does not exist is not
/// created, and one that cannot be opened answers nothing: this is advice
/// beside a red, never a reason for the verify to fail.
fn red_history_of(
    test_ledger: &Path,
    apptest_ledger: &Path,
    worktree: &Path,
    base_branch: &str,
    head: &str,
    since: i64,
) -> Vec<tugtool_core::red_history::RedTest> {
    let tests = test_ledger
        .is_file()
        .then(|| test_ledger::open_ledger(test_ledger).ok())
        .flatten();
    let apptests = apptest_ledger
        .is_file()
        .then(|| tugtool_core::apptest_ledger::open_ledger(apptest_ledger).ok())
        .flatten();
    let base_root =
        tugtool_core::apptest_ledger::resolve_base_root(&test_ledger::run_root_for(worktree));
    tugtool_core::red_history::attribute(
        tests.as_ref(),
        apptests.as_ref(),
        tugtool_core::red_history::Scope {
            base_root: &base_root,
            base_branch,
            head,
            since,
        },
    )
}

/// Each red surface's first failing check, as a report names it.
fn first_reds(reds: &[&SurfaceResult]) -> Vec<String> {
    reds.iter()
        .filter_map(|surface| {
            surface
                .commands
                .iter()
                .find(|c| c.exit_code.is_some_and(|code| code != 0))
                .map(|c| {
                    format!(
                        "{}: `{}` (exit {}){}",
                        surface.name,
                        c.command,
                        c.exit_code.unwrap_or(-1),
                        c.title
                            .as_deref()
                            .map(|t| format!(" · first red {t}"))
                            .unwrap_or_default()
                    )
                })
        })
        .collect()
}

/// A sha as a report shows it.
fn short(sha: &str) -> String {
    sha.chars().take(10).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(name: &str, paths: &[&str], check: &[&str], checked_by: &[&str]) -> Surface {
        Surface {
            name: name.to_string(),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            check: check.iter().map(|c| c.to_string()).collect(),
            checked_by: checked_by.iter().map(|c| c.to_string()).collect(),
            commit_check: Vec::new(),
            commit_check_only: Vec::new(),
            inputs: Vec::new(),
        }
    }

    fn touched(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    fn planned(resolution: Resolution) -> Vec<SurfacePlan> {
        match resolution {
            Resolution::Planned(plans) => plans,
            other => panic!("expected a plan, got {other:?}"),
        }
    }

    #[test]
    fn the_longest_declaration_wins() {
        let table = [
            surface("deck", &["tugdeck/"], &["tsc"], &[]),
            surface("wasm", &["tugdeck/crates/"], &["just wasm"], &[]),
        ];
        let plans = planned(plan_verification(
            &table,
            "b",
            "h",
            &touched(&["tugdeck/crates/x/Cargo.toml", "tugdeck/src/main.tsx"]),
        ));
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].name, "deck");
        assert_eq!(plans[0].paths, vec!["tugdeck/src/main.tsx".to_string()]);
        assert_eq!(plans[1].name, "wasm");
        assert_eq!(
            plans[1].paths,
            vec!["tugdeck/crates/x/Cargo.toml".to_string()]
        );
    }

    #[test]
    fn an_exact_path_claims_itself_and_nothing_that_merely_starts_with_it() {
        let table = [
            surface("prose", &["CLAUDE.md"], &[], &[]),
            surface("rest", &["src/"], &["true"], &[]),
        ];
        let plans = planned(plan_verification(
            &table,
            "b",
            "h",
            &touched(&["CLAUDE.md"]),
        ));
        assert_eq!(plans[0].name, "prose");

        assert_eq!(
            plan_verification(&table, "b", "h", &touched(&["CLAUDE.md.bak"])),
            Resolution::Unclaimed(vec!["CLAUDE.md.bak".to_string()])
        );
    }

    #[test]
    fn a_prefix_without_a_slash_does_not_claim_a_sibling_directory() {
        let table = [surface("deck", &["tugdeck"], &["tsc"], &[])];
        assert_eq!(
            plan_verification(&table, "b", "h", &touched(&["tugdeck-old/x.ts"])),
            Resolution::Unclaimed(vec!["tugdeck-old/x.ts".to_string()])
        );
        // The same declaration still claims the directory it names.
        let plans = planned(plan_verification(
            &table,
            "b",
            "h",
            &touched(&["tugdeck/x.ts"]),
        ));
        assert_eq!(plans[0].paths, vec!["tugdeck/x.ts".to_string()]);
    }

    #[test]
    fn an_unclaimed_path_refuses_and_plans_nothing() {
        let table = [surface("deck", &["tugdeck/"], &["tsc"], &[])];
        let resolution = plan_verification(
            &table,
            "b",
            "h",
            &touched(&["tugdeck/x.ts", "tugcode/y.ts", "tests/z.ts"]),
        );
        assert_eq!(
            resolution,
            Resolution::Unclaimed(vec!["tugcode/y.ts".to_string(), "tests/z.ts".to_string()])
        );
    }

    #[test]
    fn an_empty_table_declares_none_even_with_paths_in_range() {
        assert_eq!(
            plan_verification(&[], "b", "h", &touched(&["anything.ts"])),
            Resolution::DeclaresNone
        );
    }

    #[test]
    fn an_empty_range_is_answered_before_the_table_is_consulted() {
        let table = [surface("deck", &["tugdeck/"], &["tsc"], &[])];
        assert_eq!(
            plan_verification(&table, "b", "h", &[]),
            Resolution::NothingTouched
        );
        // And with no table either — the range is the more specific fact, so
        // this must not report DeclaresNone.
        assert_eq!(
            plan_verification(&[], "b", "h", &[]),
            Resolution::NothingTouched
        );
    }

    #[test]
    fn an_empty_check_list_is_a_surface_in_the_run_with_nothing_to_do() {
        let table = [
            surface("prose", &["docs/"], &[], &[]),
            surface("code", &["src/"], &["true"], &[]),
        ];
        // Only `prose` is touched, so `code` is absent from the run entirely —
        // which is a different thing from `prose`'s claimed-and-unchecked.
        let plans = planned(plan_verification(
            &table,
            "b",
            "h",
            &touched(&["docs/a.md"]),
        ));
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].name, "prose");
        assert!(plans[0].commands.is_empty());
        assert!(plans[0].is_claimed_unchecked());
    }

    #[test]
    fn a_borrowed_check_runs_as_its_own_and_names_its_lender() {
        let table = [
            surface("a", &["a/"], &["check-a"], &[]),
            surface("b", &["b/"], &["check-b"], &[]),
            surface("proto", &["proto/"], &[], &["a", "b"]),
        ];
        let plans = planned(plan_verification(
            &table,
            "base",
            "head",
            &touched(&["proto/x.ts"]),
        ));
        assert_eq!(plans.len(), 1);
        let commands = &plans[0].commands;
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].command, "check-a");
        assert_eq!(commands[0].declared_by, "a");
        assert_eq!(commands[1].command, "check-b");
        assert_eq!(commands[1].declared_by, "b");
        assert_eq!(
            plans[0].borrowed_from,
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(!plans[0].is_claimed_unchecked());
    }

    #[test]
    fn a_surface_declaring_both_runs_its_own_commands_first() {
        let table = [
            surface("lender", &["l/"], &["borrowed"], &[]),
            surface("own", &["o/"], &["mine"], &["lender"]),
        ];
        let plans = planned(plan_verification(&table, "b", "h", &touched(&["o/x"])));
        let commands: Vec<&str> = plans[0]
            .commands
            .iter()
            .map(|c| c.command.as_str())
            .collect();
        assert_eq!(commands, vec!["mine", "borrowed"]);
    }

    #[test]
    fn paths_expand_to_the_borrowing_surfaces_own_paths_shell_quoted() {
        let table = [
            surface("lender", &["l/"], &["run {paths}"], &[]),
            surface("borrower", &["b/"], &[], &["lender"]),
        ];
        let plans = planned(plan_verification(
            &table,
            "base",
            "head",
            &touched(&["b/plain.ts", "b/with space.ts", "b/it's.ts"]),
        ));
        assert_eq!(
            plans[0].commands[0].command,
            "run 'b/plain.ts' 'b/with space.ts' 'b/it'\\''s.ts'"
        );
    }

    #[test]
    fn base_and_head_expand_verbatim_and_a_bare_command_is_untouched() {
        let table = [surface(
            "a",
            &["a/"],
            &["diff {base}..{head}", "cargo check --workspace"],
            &[],
        )];
        let plans = planned(plan_verification(
            &table,
            "91c4de70",
            "3f0a1c9e",
            &touched(&["a/x"]),
        ));
        assert_eq!(plans[0].commands[0].command, "diff 91c4de70..3f0a1c9e");
        assert_eq!(plans[0].commands[1].command, "cargo check --workspace");
    }

    #[test]
    fn an_identical_expanded_command_runs_once_and_differing_ones_do_not() {
        let table = [
            surface("first", &["f/"], &["shared"], &[]),
            surface("second", &["s/"], &["shared"], &[]),
        ];
        let plans = planned(plan_verification(
            &table,
            "b",
            "h",
            &touched(&["f/x", "s/y"]),
        ));
        assert_eq!(plans[0].commands[0].already_run_for, None);
        assert_eq!(
            plans[1].commands[0].already_run_for,
            Some("first".to_string())
        );

        // The de-dup key is the expanded string, so two surfaces scoping the
        // same declaration to their own paths both run.
        let scoped = [
            surface("first", &["f/"], &["shared {paths}"], &[]),
            surface("second", &["s/"], &["shared {paths}"], &[]),
        ];
        let plans = planned(plan_verification(
            &scoped,
            "b",
            "h",
            &touched(&["f/x", "s/y"]),
        ));
        assert_eq!(plans[0].commands[0].already_run_for, None);
        assert_eq!(plans[1].commands[0].already_run_for, None);
    }

    #[test]
    fn shell_quoting_survives_a_round_trip_through_sh() {
        assert_eq!(shell_quote("plain.ts"), "'plain.ts'");
        assert_eq!(shell_quote("with space.ts"), "'with space.ts'");
        assert_eq!(shell_quote("it's.ts"), "'it'\\''s.ts'");
    }
}

/// The fit fact: what a green verify records, what the other outcomes do not,
/// and how staleness is derived from both endpoints rather than one.
#[cfg(test)]
mod fit_tests {
    use super::*;
    use std::path::Path;
    use tugcore::test_fixtures::git::{GitFixture, git};

    /// A repo with an arc whose worktree declares `config` and whose one round
    /// touches `files`.
    fn project(root: &Path, config: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        GitFixture::init(root);
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::write(root.join(".tugtool/config.toml"), config).unwrap();
        std::fs::write(root.join("seed.txt"), "base\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-m", "base"]);

        let worktree = root.join(".tug/worktrees/demo");
        git(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "tugarc/demo",
                worktree.to_str().unwrap(),
            ],
        );
        git(root, &["config", "branch.tugarc/demo.tugbase", "main"]);
        for (path, body) in files {
            let full = worktree.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
        }
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "round"]);
        worktree
    }

    const GREEN: &str =
        "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"true\"]\n";
    const RED: &str =
        "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"false\"]\n";

    /// The wrapper runs in place of the declared text and the report still
    /// reads the declaration: a `false` wrapped to `true` is a green surface
    /// whose command is `false`.
    #[test]
    fn a_check_runs_through_the_wrapper_and_is_recorded_as_declared() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, RED, &[("src/a.rs", "a\n")]);

        let seen = std::cell::RefCell::new(Vec::new());
        let wrap = |command: &str| {
            seen.borrow_mut().push(command.to_string());
            command.replace("false", "true")
        };
        let hooks = VerifyHooks {
            wrap: &wrap,
            verdict: &mut |_| None,
            watch: &mut |_| {},
            memo: None,
        };
        let report = verify_watched(&paths, &root, "demo", None, None, hooks).unwrap();
        assert_eq!(
            *seen.borrow(),
            vec!["false".to_string()],
            "every check is offered"
        );
        assert_eq!(
            report.verdict, "verified",
            "the wrapped command is what ran"
        );
        let command = &report.surfaces[0].commands[0];
        assert_eq!(command.command, "false", "the report reads the declaration");
        assert_eq!(command.exit_code, Some(0));

        let report = verify_in(&paths, &root, "demo", None, None).unwrap();
        assert_eq!(
            report.verdict, "red",
            "unwrapped, the check runs as declared"
        );
    }

    /// A red check whose child recorded carries the child's verdict: its
    /// tests passed of total on the command and the surface, and the first
    /// failure's name where the receipt and the table read it.
    #[test]
    fn a_red_surface_carries_the_test_its_child_recorded_as_the_red() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, RED, &[("src/a.rs", "a\n")]);

        let mut asked = Vec::new();
        let mut verdict = |command: &str| {
            asked.push(command.to_string());
            Some(ChildVerdict {
                passed: Some(3),
                total: Some(4),
                title: Some("b".into()),
                message: Some("expected 2, got 3".into()),
            })
        };
        let unwrapped = |command: &str| command.to_string();
        let hooks = VerifyHooks {
            wrap: &unwrapped,
            verdict: &mut verdict,
            watch: &mut |_| {},
            memo: None,
        };
        let report = verify_watched(&paths, &root, "demo", None, None, hooks).unwrap();
        assert_eq!(
            asked,
            vec!["false".to_string()],
            "asked once, after the check exits"
        );
        assert_eq!(report.verdict, "red");
        let surface = &report.surfaces[0];
        let command = &surface.commands[0];
        assert_eq!((command.passed, command.total), (Some(3), Some(4)));
        assert_eq!(command.title.as_deref(), Some("b"));
        assert_eq!((surface.passed, surface.total), (Some(3), Some(4)));
        assert_eq!(surface.title.as_deref(), Some("b"));
        assert_eq!(surface.message.as_deref(), Some("expected 2, got 3"));
        assert!(
            report
                .receipt
                .ends_with("src: `false` (exit 1) · first red b"),
            "the receipt names the test: {}",
            report.receipt
        );

        let report = verify_in(&paths, &root, "demo", None, None).unwrap();
        let surface = &report.surfaces[0];
        assert_eq!(
            (surface.passed, surface.total, surface.title.as_deref()),
            (None, None, None)
        );
        assert!(
            report.receipt.ends_with("src: `false` (exit 1)"),
            "{}",
            report.receipt
        );
    }

    fn verified_lines(paths: &Paths, root: &Path) -> Vec<String> {
        let log = tugtool_core::paths::project_state_dir_at(paths, root)
            .join(tugtool_core::paths::ARC_LOG);
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter(|l| l.contains("  verified  "))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn a_green_verify_records_both_endpoints_in_full() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let worktree = project(&root, GREEN, &[("src/a.rs", "a\n")]);

        let report = verify_in(&paths, &root, "demo", None, None).expect("the verify runs");
        assert_eq!(report.verdict, "verified");

        let head = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
        let base = git(&root, &["rev-parse", "main"]).trim().to_string();
        let lines = verified_lines(&paths, &root);
        assert_eq!(lines.len(), 1, "exactly one line: {lines:?}");
        assert!(
            lines[0].contains(&format!("{head} onto {base}")),
            "the note must lead with the full head and name the full base: {}",
            lines[0]
        );
        assert!(lines[0].contains("1 surfaces checked · 0 claimed unchecked"));
    }

    #[test]
    fn a_watched_verify_names_each_surface_as_it_starts_and_lands() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let config = "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"true\", \"true -n\"]\n\
                      [[tugtool.arc.surface]]\nname = \"docs\"\npaths = [\"docs/\"]\ncheck = [\"false\"]\n";
        project(&root, config, &[("src/a.rs", "a\n"), ("docs/a.md", "a\n")]);

        let mut seen = Vec::new();
        let unwrapped = |command: &str| command.to_string();
        let mut watch = |event: VerifyEvent<'_>| {
            seen.push(match event {
                VerifyEvent::Planned(surfaces) => format!("planned {surfaces:?}"),
                VerifyEvent::Started(name) => format!("started {name}"),
                VerifyEvent::Finished(result) => {
                    format!("finished {} red={}", result.name, result.red)
                }
            })
        };
        let hooks = VerifyHooks {
            wrap: &unwrapped,
            verdict: &mut |_| None,
            watch: &mut watch,
            memo: None,
        };
        let report = verify_watched(&paths, &root, "demo", None, None, hooks).unwrap();
        assert_eq!(report.verdict, "red");
        assert_eq!(
            seen,
            vec![
                r#"planned [("src", 2), ("docs", 1)]"#.to_string(),
                "started src".into(),
                "finished src red=false".into(),
                "started docs".into(),
                "finished docs red=true".into(),
            ]
        );
    }

    #[test]
    fn a_red_a_refused_and_an_empty_range_each_record_nothing() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let worktree = project(&root, RED, &[("src/a.rs", "a\n")]);

        assert_eq!(
            verify_in(&paths, &root, "demo", None, None)
                .unwrap()
                .verdict,
            "red"
        );
        assert!(
            verified_lines(&paths, &root).is_empty(),
            "a red run records nothing"
        );

        // An empty range, on the same arc.
        let head = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(
            verify_in(&paths, &root, "demo", Some(&head), Some(&head))
                .unwrap()
                .verdict,
            "nothing-in-range"
        );
        assert!(
            verified_lines(&paths, &root).is_empty(),
            "an empty range records nothing"
        );

        // And a refusal, from a table that claims nothing this round touched.
        std::fs::write(
            worktree.join(".tugtool/config.toml"),
            "[[tugtool.arc.surface]]\nname = \"other\"\npaths = [\"other/\"]\ncheck = [\"true\"]\n",
        )
        .unwrap();
        assert_eq!(
            verify_in(&paths, &root, "demo", None, None)
                .unwrap()
                .verdict,
            "unclaimed"
        );
        assert!(
            verified_lines(&paths, &root).is_empty(),
            "a refused run records nothing"
        );
    }

    /// **A hung check ends at the deadline.** The quiet re-stamp runs its
    /// verify with nobody watching, so a check that never exits must not be
    /// a wait that never ends: at the deadline the check's whole process
    /// group is killed, nothing after it runs — in its surface or any other —
    /// and the report says it timed out, records no fit, and exits red.
    #[test]
    fn a_check_still_running_at_the_deadline_is_killed_and_nothing_after_it_runs() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let config = "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"sleep 30 & wait\", \"touch after-in-src\"]\n\n\
                      [[tugtool.arc.surface]]\nname = \"docs\"\npaths = [\"docs/\"]\ncheck = [\"touch after-in-docs\"]\n";
        let worktree = project(&root, config, &[("src/a.rs", "a\n"), ("docs/a.md", "a\n")]);

        let started = Instant::now();
        let report = verify_by(
            &paths,
            &root,
            "demo",
            started + std::time::Duration::from_millis(300),
            VerifyHooks {
                wrap: &|command| command.to_string(),
                verdict: &mut |_| None,
                watch: &mut |_| {},
                memo: None,
            },
        )
        .expect("the verify runs");
        // The verdict is the deadline's, not the check's: a check that ran to
        // its own end would have been read as passed or failed.
        assert_eq!(report.verdict, "timed-out");
        assert_eq!(report.exit_code(), 1);
        assert!(
            report
                .receipt
                .contains("src: `sleep 30 & wait` was still running at the deadline"),
            "{}",
            report.receipt
        );
        let statuses = |name: &str| -> Vec<String> {
            report
                .surfaces
                .iter()
                .find(|s| s.name == name)
                .map(|s| s.commands.iter().map(|c| c.status.clone()).collect())
                .unwrap_or_default()
        };
        assert_eq!(statuses("src"), ["timed-out", "not-reached"]);
        assert_eq!(statuses("docs"), ["not-reached"]);
        assert!(!worktree.join("after-in-src").exists());
        assert!(!worktree.join("after-in-docs").exists());
        assert!(
            verified_lines(&paths, &root).is_empty(),
            "a timed-out run records nothing"
        );
    }

    #[test]
    fn the_fact_is_collected_without_moving_the_stage() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, GREEN, &[("src/a.rs", "a\n")]);

        let before = crate::log::read_declarations(&paths, &root, "demo");
        verify_in(&paths, &root, "demo", None, None).unwrap();
        let after = crate::log::read_declarations(&paths, &root, "demo");

        assert!(after.last_verified.is_some(), "the note is collected");
        assert_eq!(
            after.latest, before.latest,
            "verifying does not move the stage, exactly as replaying does not"
        );
        assert!(
            after.last_activity.is_some(),
            "a verify is still activity, and dates the arc"
        );
    }

    /// A scoped verify — the re-audit's fold rung, `--base <audited head>` —
    /// records the arc's fork as its base, not the scope, so the audit's mark
    /// can be cross-checked against it and goes through.
    #[test]
    fn a_scoped_verify_records_the_fork_and_the_mark_goes_through() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let worktree = project(&root, GREEN, &[("src/a.rs", "a\n")]);
        let audited_head = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
        std::fs::write(worktree.join("src/b.rs"), "b\n").unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "a round after the audit"]);
        let fork = git(&root, &["rev-parse", "main"]).trim().to_string();

        verify_in(&paths, &root, "demo", Some(&audited_head), None).unwrap();
        let note = crate::log::read_declarations(&paths, &root, "demo")
            .last_verified
            .expect("a green scoped verify records");
        let (_, base) = crate::log::parse_verified_note(&note).unwrap();
        assert_eq!(base, fork, "the line names the fork, not the scope: {note}");
        assert!(note.contains("scoped from"), "{note}");

        crate::ops::mark_in(&paths, &root, "demo", crate::log::MarkStage::Audited, None)
            .expect("the fold rung's mark is not refused by its own verify");
    }

    #[test]
    fn a_terminal_line_resets_the_fact_with_everything_else() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, GREEN, &[("src/a.rs", "a\n")]);
        verify_in(&paths, &root, "demo", None, None).unwrap();
        assert!(
            crate::log::read_declarations(&paths, &root, "demo")
                .last_verified
                .is_some()
        );

        crate::log::append_arc_log(&paths, &root, "demo", "join", "joined into main").unwrap();
        assert!(
            crate::log::read_declarations(&paths, &root, "demo")
                .last_verified
                .is_none(),
            "a reused arc name must not be born verified"
        );
    }

    #[test]
    fn currency_needs_both_endpoints_to_still_stand() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let worktree = project(&root, GREEN, &[("src/a.rs", "a\n")]);
        verify_in(&paths, &root, "demo", None, None).unwrap();

        let fit = crate::ops::status_in(&paths, &root, "demo").unwrap().fit;
        assert!(
            fit.as_ref().is_some_and(|f| f.current),
            "green at the recorded pair"
        );

        // The base alone gains a commit, with the arc untouched — the case a
        // head-only derivation could not see.
        std::fs::write(root.join("base-move.txt"), "moved\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "base moves"]);
        let after_base = crate::ops::status_in(&paths, &root, "demo")
            .unwrap()
            .fit
            .unwrap();
        assert!(
            !after_base.current,
            "a base that moved makes the verified tree no longer the tree a join would land"
        );
        // And it says which endpoint moved, so a face can name it.
        assert!(after_base.base_moved && !after_base.head_moved);

        // And a round on the arc, with the recorded base back in place.
        git(&root, &["reset", "--hard", "HEAD~1"]);
        assert!(
            crate::ops::status_in(&paths, &root, "demo")
                .unwrap()
                .fit
                .unwrap()
                .current
        );
        std::fs::write(worktree.join("src/b.rs"), "b\n").unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "another round"]);
        let after_round = crate::ops::status_in(&paths, &root, "demo")
            .unwrap()
            .fit
            .unwrap();
        assert!(!after_round.current);
        assert!(after_round.head_moved && !after_round.base_moved);
    }

    #[test]
    fn a_note_that_names_no_pair_is_ignored_rather_than_half_believed() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        assert_eq!(
            crate::log::parse_verified_note("abc onto def · 1 surfaces checked"),
            Some(("abc".to_string(), "def".to_string()))
        );
        assert_eq!(crate::log::parse_verified_note("abc"), None);
        assert_eq!(crate::log::parse_verified_note("abc onto"), None);
        assert_eq!(crate::log::parse_verified_note(""), None);

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, GREEN, &[("src/a.rs", "a\n")]);
        crate::log::append_arc_log(&paths, &root, "demo", "verified", "nonsense-with-no-base")
            .unwrap();

        assert!(
            crate::ops::status_in(&paths, &root, "demo")
                .unwrap()
                .fit
                .is_none(),
            "an unparseable note yields no fact, not a fact with an empty base"
        );
    }

    // --- the record a verify relies on ---------------------------------------

    /// A verify that may rely on the record kept in `ledger`.
    fn memo_verify(paths: &Paths, root: &Path, ledger: &Path, fresh: bool) -> VerifyReport {
        let memo = VerifyMemo {
            ledger: ledger.to_path_buf(),
            fresh,
            tool_use_id: None,
        };
        verify_watched(
            paths,
            root,
            "demo",
            None,
            None,
            VerifyHooks {
                wrap: &|command| command.to_string(),
                verdict: &mut |_| None,
                watch: &mut |_| {},
                memo: Some(&memo),
            },
        )
        .expect("the verify runs")
    }

    /// How many times a counting check ran: one line per run, in a file
    /// outside the worktree so the count never moves a key.
    fn runs(counter: &Path) -> usize {
        std::fs::read_to_string(counter)
            .map(|t| t.lines().count())
            .unwrap_or(0)
    }

    fn counting(counter: &Path) -> String {
        format!("echo ran >> {}", shell_quote(&counter.to_string_lossy()))
    }

    fn surface_of<'a>(report: &'a VerifyReport, name: &str) -> &'a SurfaceResult {
        report
            .surfaces
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("no surface {name}"))
    }

    /// An unchanged second verify runs nothing, names the record it relied
    /// on, still writes the verified line, and the audit's mark goes through.
    #[test]
    fn an_unchanged_second_verify_relies_on_the_record_and_the_mark_goes_through() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(state.path());
        let ledger = state.path().join("test_results.db");
        let counter = state.path().join("src.count");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        // No `inputs`: keyed by the whole tree.
        let config = format!(
            "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [{:?}]\n",
            counting(&counter)
        );
        let worktree = project(&root, &config, &[("src/a.rs", "a\n")]);

        let first = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(first.verdict, "verified");
        assert_eq!((first.checked, first.relied), (1, 0));
        assert_eq!(runs(&counter), 1);

        let second = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(second.verdict, "verified");
        assert_eq!(runs(&counter), 1, "the relied-on check did not run");
        assert_eq!((second.checked, second.relied), (0, 1));
        let src = surface_of(&second, "src");
        assert!(src.relied_on_record && !src.red);
        let command = &src.commands[0];
        assert_eq!(command.status, "recorded");
        assert_eq!(command.exit_code, Some(0));
        let head = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(
            command.relied_on.as_ref().map(|r| r.head.as_str()),
            Some(head.as_str()),
            "the row it relied on names its head"
        );
        assert!(
            second
                .receipt
                .ends_with("0 surfaces checked · 0 claimed unchecked · 1 relied on the record"),
            "{}",
            second.receipt
        );
        let lines = verified_lines(&paths, &root);
        assert_eq!(lines.len(), 2, "both verifies record the head: {lines:?}");
        assert!(lines[1].contains("1 relied on the record"), "{}", lines[1]);
        crate::ops::mark_in(&paths, &root, "demo", crate::log::MarkStage::Audited, None)
            .expect("a verify that relied on the record still lets the audit mark");

        // Without the memo, nothing is relied on and the check runs.
        verify_in(&paths, &root, "demo", None, None).unwrap();
        assert_eq!(runs(&counter), 2);
    }

    /// A change under one surface's declared inputs runs that surface again
    /// and relies on the record for the other.
    #[test]
    fn a_change_under_one_surfaces_inputs_runs_that_surface_only() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(state.path());
        let ledger = state.path().join("test_results.db");
        let src_count = state.path().join("src.count");
        let docs_count = state.path().join("docs.count");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let config = format!(
            "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [{:?}]\ninputs = [\"src/\"]\n\n\
             [[tugtool.arc.surface]]\nname = \"docs\"\npaths = [\"docs/\"]\ncheck = [{:?}]\ninputs = [\"docs/\"]\n",
            counting(&src_count),
            counting(&docs_count)
        );
        let worktree = project(&root, &config, &[("src/a.rs", "a\n"), ("docs/a.md", "a\n")]);
        assert_eq!(
            memo_verify(&paths, &root, &ledger, false).verdict,
            "verified"
        );

        std::fs::write(worktree.join("docs/a.md"), "a, revised\n").unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "a docs round"]);
        let second = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(second.verdict, "verified");
        assert_eq!((runs(&src_count), runs(&docs_count)), (1, 2));
        assert!(surface_of(&second, "src").relied_on_record);
        assert!(!surface_of(&second, "docs").relied_on_record);
        assert_eq!((second.checked, second.relied), (1, 1));
    }

    /// A red verify, then a fix: the fixed surface runs again, the one that
    /// was already green relies on the record, and the verified line lands.
    #[test]
    fn a_fix_after_a_red_verify_reruns_only_what_moved() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(state.path());
        let ledger = state.path().join("test_results.db");
        let docs_count = state.path().join("docs.count");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let config = format!(
            "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"grep -q good src/a.rs\"]\ninputs = [\"src/\"]\n\n\
             [[tugtool.arc.surface]]\nname = \"docs\"\npaths = [\"docs/\"]\ncheck = [{:?}]\ninputs = [\"docs/\"]\n",
            counting(&docs_count)
        );
        let worktree = project(
            &root,
            &config,
            &[("src/a.rs", "bad\n"), ("docs/a.md", "a\n")],
        );

        let red = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(red.verdict, "red");
        assert!(verified_lines(&paths, &root).is_empty());

        std::fs::write(worktree.join("src/a.rs"), "good\n").unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "the fix"]);
        let fixed = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(fixed.verdict, "verified");
        assert_eq!(
            runs(&docs_count),
            1,
            "the green surface relied on the record"
        );
        assert!(surface_of(&fixed, "docs").relied_on_record);
        let src = surface_of(&fixed, "src");
        assert!(!src.relied_on_record);
        assert_eq!(src.commands[0].status, "ran");
        assert_eq!(verified_lines(&paths, &root).len(), 1);

        // And the red row never answers: break it again, the check runs.
        std::fs::write(worktree.join("src/a.rs"), "bad\n").unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "broken again"]);
        let again = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(again.verdict, "red", "a red key is never relied on");
    }

    /// A red verify says, of each failing test its checks recorded, what the
    /// base branch's record holds; a green one says nothing of the kind.
    #[test]
    fn a_red_verify_says_whose_red_each_failure_is() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(state.path());
        let ledger = state.path().join("test_results.db");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let config = "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"grep -q good src/a.rs\"]\n";
        let worktree = project(&root, config, &[("src/a.rs", "bad\n")]);
        let head = git(&worktree, &["rev-parse", "HEAD"]).trim().to_string();
        let base_branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string();

        // What the check's runner would have recorded: the base failed the
        // test two runs ago and still does, and this verify's run failed it.
        // The verify's run is stamped after the verify begins, as a real
        // child's is.
        let mut conn = test_ledger::open_ledger(&ledger).unwrap();
        let record = |conn: &mut rusqlite::Connection, branch: &str, sha: &str, at: i64| {
            let run = test_ledger::TestRun {
                started_at: at,
                ended_at: at,
                run_root: worktree.to_string_lossy().into_owned(),
                branch: branch.to_string(),
                head_sha: sha.to_string(),
                dirty: false,
                suite: "rust".to_string(),
                session_id: None,
                tool_use_id: None,
                input_key: None,
                command: "cargo nextest run".to_string(),
                exit_code: 1,
                wall_secs: 1.0,
            };
            let doc = test_ledger::JunitRun {
                tests: 1,
                failed: 1,
                skipped: 0,
                files: Vec::new(),
                failures: vec![test_ledger::JunitFailure {
                    file: "crate".to_string(),
                    name: "t::typed_keys".to_string(),
                    classname: String::new(),
                    message: "noResponder".to_string(),
                    detail: String::new(),
                }],
            };
            test_ledger::record_run(conn, &run, Some(&doc)).unwrap();
        };
        record(&mut conn, &base_branch, "base1", 1_000);
        record(&mut conn, &base_branch, "base2", 2_000);
        record(&mut conn, "tugarc/demo", &head, i64::MAX / 2);
        drop(conn);

        let red = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(red.verdict, "red");
        assert_eq!(red.base_branch.as_deref(), Some(base_branch.as_str()));
        assert_eq!(red.reds.len(), 1);
        assert_eq!(red.reds[0].name, "t::typed_keys");
        assert_eq!(
            red.reds[0].base,
            tugtool_core::red_history::BaseRecord::Red {
                since_sha: "base1".to_string(),
                since_date: "1970-01-01".to_string(),
                runs: 2,
            }
        );
        let json = serde_json::to_value(&red).unwrap();
        assert_eq!(json["reds"][0]["onBase"], "red");

        std::fs::write(worktree.join("src/a.rs"), "good\n").unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "the fix"]);
        let green = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(green.verdict, "verified");
        assert!(green.reds.is_empty() && green.base_branch.is_none());
    }

    /// `--fresh` runs every check whatever the record says, and still
    /// records what it ran.
    #[test]
    fn a_fresh_verify_runs_every_check() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(state.path());
        let ledger = state.path().join("test_results.db");
        let counter = state.path().join("src.count");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let config = format!(
            "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [{:?}]\n",
            counting(&counter)
        );
        project(&root, &config, &[("src/a.rs", "a\n")]);

        memo_verify(&paths, &root, &ledger, false);
        let fresh = memo_verify(&paths, &root, &ledger, true);
        assert_eq!(runs(&counter), 2);
        assert_eq!((fresh.checked, fresh.relied), (1, 0));
        assert!(!fresh.receipt.contains("relied"), "{}", fresh.receipt);
        // What the fresh run recorded is relied on next.
        let after = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(runs(&counter), 2);
        assert_eq!(after.relied, 1);
    }

    /// A check that moves its own inputs while it runs is recorded nowhere,
    /// so it is never relied on: its key after is not the key it read.
    #[test]
    fn a_check_whose_key_moved_while_it_ran_records_nothing() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(state.path());
        let ledger = state.path().join("test_results.db");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let config = "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"echo more >> src/generated.txt\", \"true\"]\ninputs = [\"src/\"]\n";
        project(&root, config, &[("src/a.rs", "a\n")]);

        let report = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(report.verdict, "verified");
        let conn = test_ledger::open_ledger(&ledger).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM checks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            rows, 0,
            "neither check is recorded: the first moved the key the surface started from"
        );
        let second = memo_verify(&paths, &root, &ledger, false);
        assert_eq!(second.relied, 0);
    }

    /// The checks a verify runs see their key, which a wrapped runner records
    /// on its run.
    #[test]
    fn a_check_runs_with_its_input_key_in_the_environment() {
        let state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(state.path());
        let ledger = state.path().join("test_results.db");
        let seen = state.path().join("seen-key");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let check = format!(
            "printf %s \"${}\" > {}",
            test_ledger::CHECK_INPUT_KEY_ENV,
            shell_quote(&seen.to_string_lossy())
        );
        let config = format!(
            "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [{check:?}]\ninputs = [\"src/\"]\n"
        );
        let worktree = project(&root, &config, &[("src/a.rs", "a\n")]);
        memo_verify(&paths, &root, &ledger, false);
        let expected = crate::input_key::input_key(&worktree, &["src/".to_string()]).unwrap();
        assert_eq!(std::fs::read_to_string(&seen).unwrap(), expected);
    }

    #[test]
    fn status_json_carries_the_fit_and_omits_it_when_there_is_none() {
        let _state = tempfile::TempDir::new().unwrap();
        let paths = Paths::under(_state.path());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, GREEN, &[("src/a.rs", "a\n")]);

        let unverified =
            serde_json::to_value(crate::ops::status_in(&paths, &root, "demo").unwrap()).unwrap();
        assert!(
            unverified.get("fit").is_none(),
            "an arc nobody verified says nothing about the fit"
        );

        verify_in(&paths, &root, "demo", None, None).unwrap();
        let verified =
            serde_json::to_value(crate::ops::status_in(&paths, &root, "demo").unwrap()).unwrap();
        assert_eq!(verified["fit"]["current"], true);
        assert!(
            verified["fit"]["head"]
                .as_str()
                .is_some_and(|h| h.len() == 40)
        );
        assert!(
            verified["fit"]["base"]
                .as_str()
                .is_some_and(|b| b.len() == 40)
        );
    }
}

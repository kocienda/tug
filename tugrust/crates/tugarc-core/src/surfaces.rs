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
use std::path::Path;
use std::process::{Command, Stdio};
use tugcore::instance::Paths;
use tugtool_core::config::{Config, Surface};

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
    /// `unclaimed`, `declares-none`, or `nothing-in-range`.
    pub verdict: String,
    /// The paths no surface claimed. Empty unless the verdict is `unclaimed`.
    pub unclaimed: Vec<String>,
    /// The surfaces the range touched, with each command's outcome.
    pub surfaces: Vec<SurfaceResult>,
    /// How many surfaces ran at least one command.
    pub checked: usize,
    /// How many surfaces claimed their paths and declared nothing to run.
    pub claimed_unchecked: usize,
    /// The closing `TUG-VERIFY-RECEIPT:` line, verbatim, so the text output
    /// and the JSON cannot say different things.
    pub receipt: String,
}

impl VerifyReport {
    /// The process exit status: 0 verified / declared-none / nothing in
    /// range, 1 a red check, 2 an unclaimed path.
    pub fn exit_code(&self) -> u8 {
        match self.verdict.as_str() {
            "red" => 1,
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
    /// `ran`, `already-run`, or `not-reached` — a command after a red one in
    /// the same surface.
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
fn run_plans(
    worktree: &Path,
    plans: Vec<SurfacePlan>,
    quiet: bool,
    wrap: &dyn Fn(&str) -> String,
    verdict: &mut dyn FnMut(&str) -> Option<ChildVerdict>,
    watch: &mut dyn FnMut(VerifyEvent<'_>),
) -> Vec<SurfaceResult> {
    let planned: Vec<(String, usize)> = plans
        .iter()
        .map(|plan| (plan.name.clone(), plan.commands.len()))
        .collect();
    watch(VerifyEvent::Planned(&planned));
    let mut results = Vec::new();
    for plan in plans {
        watch(VerifyEvent::Started(&plan.name));
        let mut commands = Vec::new();
        let mut red = false;
        for planned in plan.commands {
            if red {
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
                });
                continue;
            }
            let mut cmd = Command::new("sh");
            cmd.arg("-c")
                .arg(wrap(&planned.command))
                .current_dir(worktree);
            if quiet {
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
            let status = cmd.status();
            let exit_code = match status {
                Ok(s) => s.code().unwrap_or(-1),
                Err(_) => -1,
            };
            if exit_code != 0 {
                red = true;
            }
            let child = verdict(&planned.command).unwrap_or_default();
            commands.push(CommandResult {
                command: planned.command,
                declared_by: planned.declared_by,
                status: "ran".to_string(),
                exit_code: Some(exit_code),
                already_run_for: None,
                passed: child.passed,
                total: child.total,
                title: child.title,
                message: child.message,
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
        };
        watch(VerifyEvent::Finished(&result));
        results.push(result);
    }
    results
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
    verify_watched(
        paths,
        repo_root,
        name,
        base_override,
        head_override,
        VerifyHooks {
            wrap: &|command| command.to_string(),
            verdict: &mut |_| None,
            watch: &mut |_| {},
        },
    )
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
    let repo = crate::ops::main_repo_root(repo_root);
    let branch = crate::ops::branch_name(name);
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
    let base = match base_override {
        Some(b) => crate::ops::git_stdout(&repo, &["rev-parse", b])?,
        None => {
            let base_branch = crate::ops::arc_base(&repo, name)?;
            crate::ops::git_stdout(&repo, &["merge-base", &base_branch, &branch])?
        }
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
        },
        Resolution::DeclaresNone => VerifyReport {
            base,
            head,
            verdict: "declares-none".to_string(),
            unclaimed: Vec::new(),
            surfaces: Vec::new(),
            checked: 0,
            claimed_unchecked: 0,
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
        },
        Resolution::Planned(plans) => {
            let results = run_plans(
                &worktree,
                plans,
                false,
                hooks.wrap,
                hooks.verdict,
                hooks.watch,
            );
            let checked = results.iter().filter(|r| !r.commands.is_empty()).count();
            let claimed_unchecked = results.iter().filter(|r| r.commands.is_empty()).count();
            let reds: Vec<&SurfaceResult> = results.iter().filter(|r| r.red).collect();
            let receipt = if reds.is_empty() {
                format!(
                    "TUG-VERIFY-RECEIPT: verified {} · {} surfaces checked · {} claimed unchecked",
                    short(&head),
                    checked,
                    claimed_unchecked
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
                        "{head} onto {base} · {checked} surfaces checked · {claimed_unchecked} claimed unchecked"
                    ),
                )
                .map_err(|e| ArcError::arc_log(paths, &repo, e))?;
            }
            VerifyReport {
                base,
                head,
                verdict: if reds.is_empty() { "verified" } else { "red" }.to_string(),
                unclaimed: Vec::new(),
                surfaces: results,
                checked,
                claimed_unchecked,
                receipt,
            }
        }
    })
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

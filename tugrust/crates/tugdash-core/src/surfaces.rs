//! Resolving a dash's touched paths to the surfaces a project declared, and
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
//! borrow. `DashConfig::validate` refuses everything else at load, so the
//! resolution rules below can be stated without their error cases.

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use tugutil_core::config::{Config, Surface};

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
fn claiming_surface<'a>(surfaces: &'a [Surface], touched: &str) -> Option<&'a Surface> {
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
fn expand(command: &str, base: &str, head: &str, paths: &[String]) -> String {
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
}

/// Run a surface plan and report what happened.
///
/// A red command ends its own surface and nothing else: every surface runs, so
/// one report names every failure rather than the first one.
fn run_plans(worktree: &Path, plans: Vec<SurfacePlan>) -> Vec<SurfaceResult> {
    let mut results = Vec::new();
    for plan in plans {
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
                });
                continue;
            }
            let status = Command::new("sh")
                .arg("-c")
                .arg(&planned.command)
                .current_dir(worktree)
                .status();
            let exit_code = match status {
                Ok(s) => s.code().unwrap_or(-1),
                Err(_) => -1,
            };
            if exit_code != 0 {
                red = true;
            }
            commands.push(CommandResult {
                command: planned.command,
                declared_by: planned.declared_by,
                status: "ran".to_string(),
                exit_code: Some(exit_code),
                already_run_for: None,
            });
        }
        results.push(SurfaceResult {
            name: plan.name,
            paths: plan.paths,
            commands,
            borrowed_from: plan.borrowed_from,
            red,
        });
    }
    results
}

/// The paths a range moved, in the order git reported them, with a rename
/// reported at its destination.
fn touched_paths(repo: &Path, base: &str, head: &str) -> Result<Vec<String>, String> {
    let range = format!("{base}..{head}");
    let out = crate::ops::git_stdout(
        repo,
        &[
            "-c",
            "core.quotepath=false",
            "diff",
            "--name-status",
            "-M",
            &range,
        ],
    )?;
    Ok(crate::ops::name_status_paths(&out))
}

/// Verify the fit of a dash: resolve the range it would land, check every
/// surface it touched, and report.
///
/// The range is derived live rather than remembered — `merge-base(base,
/// branch)..branch` is a dash's own contribution, which is what a join lands
/// and therefore what the fit is about. It is answerable for a dash that has
/// never been replayed, which a recorded range could not be.
pub fn verify_in(
    repo_root: &Path,
    name: &str,
    base_override: Option<&str>,
    head_override: Option<&str>,
) -> Result<VerifyReport, String> {
    let repo = crate::ops::main_repo_root(repo_root);
    let branch = crate::ops::branch_name(name);
    if crate::ops::git_stdout(
        &repo,
        &["rev-parse", "--verify", &format!("{branch}^{{commit}}")],
    )
    .is_err()
    {
        return Err(format!("Dash not found: {name}"));
    }
    let worktree = crate::ops::worktree_path(&repo, name);
    if !worktree.is_dir() {
        return Err(format!(
            "dash '{name}' has no worktree at {} — checks run from the worktree root",
            worktree.display()
        ));
    }

    let head = match head_override {
        Some(h) => crate::ops::git_stdout(&repo, &["rev-parse", h])?,
        None => crate::ops::git_stdout(&repo, &["rev-parse", &branch])?,
    };
    let base = match base_override {
        Some(b) => crate::ops::git_stdout(&repo, &["rev-parse", b])?,
        None => {
            let base_branch = crate::ops::dash_base(&repo, name)?;
            crate::ops::git_stdout(&repo, &["merge-base", &base_branch, &branch])?
        }
    };

    let touched = touched_paths(&repo, &base, &head)?;
    let config = Config::load_from_project(&worktree).map_err(|e| e.to_string())?;
    let surfaces = config.tugtool.dash.surfaces;

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
            let results = run_plans(&worktree, plans);
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
                let first: Vec<String> = reds
                    .iter()
                    .filter_map(|surface| {
                        surface
                            .commands
                            .iter()
                            .find(|c| c.exit_code.is_some_and(|code| code != 0))
                            .map(|c| {
                                format!(
                                    "{}: `{}` (exit {})",
                                    surface.name,
                                    c.command,
                                    c.exit_code.unwrap_or(-1)
                                )
                            })
                    })
                    .collect();
                format!(
                    "TUG-VERIFY-RECEIPT: red {} surfaces · {}",
                    reds.len(),
                    first.join(" · ")
                )
            };
            if reds.is_empty() {
                // Only a green run records. A red or refused run writing "not
                // verified at <head>" would leave a durable fact about a state
                // the next fix erases; the absence of a line is the honest
                // record of not-verified.
                crate::dash::append_dash_log(
                    &repo,
                    name,
                    "verified",
                    &format!(
                        "{head} onto {base} · {checked} surfaces checked · {claimed_unchecked} claimed unchecked"
                    ),
                )
                .map_err(|e| e.to_string())?;
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
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn git_stdout(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A repo with a dash whose worktree declares `config` and whose one round
    /// touches `files`.
    fn project(root: &Path, config: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "t"]);
        git(root, &["config", "user.email", "t@t"]);
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
                "tugdash/demo",
                worktree.to_str().unwrap(),
            ],
        );
        git(root, &["config", "branch.tugdash/demo.tugbase", "main"]);
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
        "[[tugtool.dash.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"true\"]\n";
    const RED: &str =
        "[[tugtool.dash.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = [\"false\"]\n";

    fn verified_lines(root: &Path) -> Vec<String> {
        let log = tugutil_core::paths::project_state_dir(root).join("dash-log.md");
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter(|l| l.contains("  verified  "))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn a_green_verify_records_both_endpoints_in_full() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let worktree = project(&root, GREEN, &[("src/a.rs", "a\n")]);

        let report = verify_in(&root, "demo", None, None).expect("the verify runs");
        assert_eq!(report.verdict, "verified");

        let head = git_stdout(&worktree, &["rev-parse", "HEAD"]);
        let base = git_stdout(&root, &["rev-parse", "main"]);
        let lines = verified_lines(&root);
        assert_eq!(lines.len(), 1, "exactly one line: {lines:?}");
        assert!(
            lines[0].contains(&format!("{head} onto {base}")),
            "the note must lead with the full head and name the full base: {}",
            lines[0]
        );
        assert!(lines[0].contains("1 surfaces checked · 0 claimed unchecked"));
    }

    #[test]
    fn a_red_a_refused_and_an_empty_range_each_record_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let worktree = project(&root, RED, &[("src/a.rs", "a\n")]);

        assert_eq!(verify_in(&root, "demo", None, None).unwrap().verdict, "red");
        assert!(
            verified_lines(&root).is_empty(),
            "a red run records nothing"
        );

        // An empty range, on the same dash.
        let head = git_stdout(&worktree, &["rev-parse", "HEAD"]);
        assert_eq!(
            verify_in(&root, "demo", Some(&head), Some(&head))
                .unwrap()
                .verdict,
            "nothing-in-range"
        );
        assert!(
            verified_lines(&root).is_empty(),
            "an empty range records nothing"
        );

        // And a refusal, from a table that claims nothing this round touched.
        std::fs::write(
            worktree.join(".tugtool/config.toml"),
            "[[tugtool.dash.surface]]\nname = \"other\"\npaths = [\"other/\"]\ncheck = [\"true\"]\n",
        )
        .unwrap();
        assert_eq!(
            verify_in(&root, "demo", None, None).unwrap().verdict,
            "unclaimed"
        );
        assert!(
            verified_lines(&root).is_empty(),
            "a refused run records nothing"
        );
    }

    #[test]
    fn the_fact_is_collected_without_moving_the_stage() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, GREEN, &[("src/a.rs", "a\n")]);

        let before = crate::dash::read_declarations(&root, "demo");
        verify_in(&root, "demo", None, None).unwrap();
        let after = crate::dash::read_declarations(&root, "demo");

        assert!(after.last_verified.is_some(), "the note is collected");
        assert_eq!(
            after.latest, before.latest,
            "verifying does not move the stage, exactly as replaying does not"
        );
        assert!(
            after.last_activity.is_some(),
            "a verify is still activity, and dates the dash"
        );
    }

    #[test]
    fn a_terminal_line_resets_the_fact_with_everything_else() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, GREEN, &[("src/a.rs", "a\n")]);
        verify_in(&root, "demo", None, None).unwrap();
        assert!(
            crate::dash::read_declarations(&root, "demo")
                .last_verified
                .is_some()
        );

        crate::dash::append_dash_log(&root, "demo", "join", "joined into main").unwrap();
        assert!(
            crate::dash::read_declarations(&root, "demo")
                .last_verified
                .is_none(),
            "a reused dash name must not be born verified"
        );
    }

    #[test]
    fn currency_needs_both_endpoints_to_still_stand() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let worktree = project(&root, GREEN, &[("src/a.rs", "a\n")]);
        verify_in(&root, "demo", None, None).unwrap();

        let fit = crate::ops::status_in(&root, "demo").unwrap().fit;
        assert!(
            fit.as_ref().is_some_and(|f| f.current),
            "green at the recorded pair"
        );

        // The base alone gains a commit, with the dash untouched — the case a
        // head-only derivation could not see.
        std::fs::write(root.join("base-move.txt"), "moved\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "base moves"]);
        let after_base = crate::ops::status_in(&root, "demo").unwrap().fit.unwrap();
        assert!(
            !after_base.current,
            "a base that moved makes the verified tree no longer the tree a join would land"
        );

        // And a round on the dash, with the recorded base back in place.
        git(&root, &["reset", "--hard", "HEAD~1"]);
        assert!(
            crate::ops::status_in(&root, "demo")
                .unwrap()
                .fit
                .unwrap()
                .current
        );
        std::fs::write(worktree.join("src/b.rs"), "b\n").unwrap();
        git(&worktree, &["add", "-A"]);
        git(&worktree, &["commit", "-m", "another round"]);
        assert!(
            !crate::ops::status_in(&root, "demo")
                .unwrap()
                .fit
                .unwrap()
                .current
        );
    }

    #[test]
    fn a_note_that_names_no_pair_is_ignored_rather_than_half_believed() {
        assert_eq!(
            crate::dash::parse_verified_note("abc onto def · 1 surfaces checked"),
            Some(("abc".to_string(), "def".to_string()))
        );
        assert_eq!(crate::dash::parse_verified_note("abc"), None);
        assert_eq!(crate::dash::parse_verified_note("abc onto"), None);
        assert_eq!(crate::dash::parse_verified_note(""), None);

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, GREEN, &[("src/a.rs", "a\n")]);
        crate::dash::append_dash_log(&root, "demo", "verified", "nonsense-with-no-base").unwrap();

        assert!(
            crate::ops::status_in(&root, "demo").unwrap().fit.is_none(),
            "an unparseable note yields no fact, not a fact with an empty base"
        );
    }

    #[test]
    fn status_json_carries_the_fit_and_omits_it_when_there_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        project(&root, GREEN, &[("src/a.rs", "a\n")]);

        let unverified =
            serde_json::to_value(crate::ops::status_in(&root, "demo").unwrap()).unwrap();
        assert!(
            unverified.get("fit").is_none(),
            "a dash nobody verified says nothing about the fit"
        );

        verify_in(&root, "demo", None, None).unwrap();
        let verified = serde_json::to_value(crate::ops::status_in(&root, "demo").unwrap()).unwrap();
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

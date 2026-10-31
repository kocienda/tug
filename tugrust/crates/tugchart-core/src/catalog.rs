//! The one list of recipes. The command line, `chart list` and the routes are
//! all built from [`RECIPES`], so none of them can name a recipe or a flag the
//! others do not.

use clap::{ArgAction, ArgMatches, Command, value_parser};
use serde_json::{Value, json};

use crate::context::{RecipeArgs, RecipeContext, RecipeError, RecipeOutcome};
use crate::tests as test_recipes;
use crate::{arcs, commits, gaps, models};

/// How one argument is spelled and what it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgKind {
    Flag,
    U32,
    Usize,
    Str,
    /// Text that must be one of these.
    Choice(&'static [&'static str]),
    Positional,
    PositionalMany,
}

/// One argument a recipe accepts. `flag` is its long name, or the name its
/// value is shown under when it is positional.
#[derive(Debug, Clone, Copy)]
pub struct Arg {
    pub flag: &'static str,
    pub kind: ArgKind,
    pub help: &'static str,
}

/// One well-known chart. `tells` is one sentence on what its data tells the
/// reader. `group` names the section it sits in, and sections read in the order
/// the catalog first names them. `sample` is a small spec to draw when a project
/// has no data for the recipe yet, so it shows what the recipe produces.
pub struct Recipe {
    pub name: &'static str,
    pub question: &'static str,
    pub tells: &'static str,
    pub group: &'static str,
    pub form: &'static str,
    pub data: &'static str,
    pub args: &'static [Arg],
    pub sample: fn() -> Value,
    run: fn(&RecipeContext, &RecipeArgs) -> Result<RecipeOutcome, RecipeError>,
}

impl Recipe {
    pub fn run(
        &self,
        ctx: &RecipeContext,
        args: &RecipeArgs,
    ) -> Result<RecipeOutcome, RecipeError> {
        (self.run)(ctx, args)
    }
}

const DAYS: Arg = Arg {
    flag: "days",
    kind: ArgKind::U32,
    help: "Days of history to read, ending now (default 30)",
};
const PATH: Arg = Arg {
    flag: "path",
    kind: ArgKind::Str,
    help: "Only commits touching this path, relative to the repository root",
};
const TITLE: Arg = Arg {
    flag: "title",
    kind: ArgKind::Str,
    help: "The chart's title, in place of the recipe's own",
};

/// The categories of a sample that covers days.
const WEEK: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

pub static RECIPES: [Recipe; 18] = [
    Recipe {
        name: "commits",
        question: "How active has this been?",
        tells: "Commits per day.",
        group: "Activity",
        form: "bar",
        data: "git log",
        args: &[
            DAYS,
            PATH,
            Arg {
                flag: "by",
                kind: ArgKind::Choice(&["day", "week"]),
                help: "Count commits per day or per week (default day)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar",
                "title": "Commits per day", "unit": "commits", "format": "int",
                "categories": WEEK,
                "series": [{ "name": "commits", "values": [6, 9, 4, 12, 7, 1, 0] }],
            })
        },
        run: commits::commits,
    },
    Recipe {
        name: "churn",
        question: "How much changed here, over time?",
        tells: "Lines added and removed per day.",
        group: "Activity",
        form: "stacked area",
        data: "git log --numstat, per day",
        args: &[DAYS, PATH, TITLE],
        sample: || {
            json!({
                "tugchart": 1, "form": "area", "layout": "stacked",
                "title": "Lines added and removed per day", "unit": "lines", "format": "count",
                "x": WEEK,
                "series": [
                    { "name": "added", "values": [420, 910, 260, 1340, 700, 40, 0], "role": "good" },
                    { "name": "removed", "values": [150, 380, 90, 720, 310, 10, 0], "role": "bad" },
                ],
            })
        },
        run: commits::churn,
    },
    Recipe {
        name: "commit-kinds",
        question: "What kind of work was it, by day?",
        tells: "Commits per day, split by the prefix of each subject.",
        group: "Activity",
        form: "stacked area",
        data: "git log subjects",
        args: &[DAYS, PATH, TITLE],
        sample: || {
            json!({
                "tugchart": 1, "form": "area", "layout": "stacked",
                "title": "Commits by kind per day", "unit": "commits", "format": "int",
                "x": WEEK,
                "series": [
                    { "name": "feat", "values": [3, 5, 2, 7, 4, 1, 0] },
                    { "name": "fix", "values": [2, 3, 1, 4, 2, 0, 0] },
                    { "name": "docs", "values": [1, 1, 1, 1, 1, 0, 0] },
                ],
            })
        },
        run: commits::commit_kinds,
    },
    Recipe {
        name: "commit-hours",
        question: "When does work land?",
        tells: "Commits by hour of day.",
        group: "Activity",
        form: "heat",
        data: "git log committer times",
        args: &[DAYS, PATH, TITLE],
        sample: || {
            json!({
                "tugchart": 1, "form": "heat",
                "title": "Commits by hour of day", "unit": "commits", "format": "int",
                "categories": [
                    "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11",
                    "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23",
                ],
                "values": [
                    1, 0, 0, 0, 0, 0, 0, 1, 3, 6, 9, 11,
                    7, 8, 12, 14, 10, 8, 4, 3, 5, 6, 3, 2,
                ],
            })
        },
        run: commits::commit_hours,
    },
    Recipe {
        name: "commit-size",
        question: "Does work land small or big?",
        tells: "How many lines each commit changed, leaving out the largest tenth.",
        group: "Activity",
        form: "histogram",
        data: "git log --numstat, per commit",
        args: &[DAYS, PATH, TITLE],
        sample: || {
            json!({
                "tugchart": 1, "form": "histogram",
                "title": "Lines changed per commit", "unit": "lines changed", "format": "count",
                "values": [
                    4, 8, 12, 12, 18, 20, 25, 30, 34, 40,
                    46, 55, 60, 75, 90, 120, 160, 240, 380, 640,
                ],
            })
        },
        run: commits::commit_size,
    },
    Recipe {
        name: "commit-days",
        question: "Which days does work land on?",
        tells: "Commits by day of the week.",
        group: "Activity",
        form: "heat",
        data: "git log committer times",
        args: &[DAYS, PATH, TITLE],
        sample: || {
            json!({
                "tugchart": 1, "form": "heat",
                "title": "Commits by day of week", "unit": "commits", "format": "int",
                "categories": WEEK,
                "values": [18, 22, 25, 30, 21, 4, 2],
            })
        },
        run: commits::commit_days,
    },
    Recipe {
        name: "hotspots",
        question: "Which files or directories change most?",
        tells: "The paths with the most lines changed.",
        group: "Changes",
        form: "horizontal bar",
        data: "git log --numstat, per path",
        args: &[
            DAYS,
            PATH,
            Arg {
                flag: "depth",
                kind: ArgKind::U32,
                help: "Path components to group by (default 2)",
            },
            Arg {
                flag: "limit",
                kind: ArgKind::Usize,
                help: "Most rows to draw (default 10)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar", "orient": "horizontal",
                "title": "Most changed paths, last 30 days", "unit": "lines changed", "format": "count",
                "categories": ["src/render", "tests/app", "src/parser", "src/cli", "docs/guide"],
                "series": [{ "name": "lines", "values": [4200, 2600, 1800, 640, 210] }],
            })
        },
        run: commits::hotspots,
    },
    Recipe {
        name: "landed",
        question: "Where did this change land?",
        tells: "Lines changed per directory in the working tree or a range.",
        group: "Changes",
        form: "horizontal stacked bar",
        data: "git diff --numstat",
        args: &[
            Arg {
                flag: "range",
                kind: ArgKind::Str,
                help: "A two-dot range a..b, in place of the working tree",
            },
            Arg {
                flag: "staged",
                kind: ArgKind::Flag,
                help: "The index, in place of the working tree",
            },
            Arg {
                flag: "session",
                kind: ArgKind::Flag,
                help: "Only this session's changed files",
            },
            Arg {
                flag: "depth",
                kind: ArgKind::U32,
                help: "Path components to group by (default 1)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar", "orient": "horizontal", "layout": "stacked",
                "title": "Lines changed by directory", "unit": "lines changed", "format": "count",
                "categories": ["src", "tests", "docs"],
                "series": [
                    { "name": "added", "values": [320, 180, 40], "role": "good" },
                    { "name": "removed", "values": [140, 30, 5], "role": "bad" },
                ],
            })
        },
        run: commits::landed,
    },
    Recipe {
        name: "velocity",
        question: "Is throughput rising or falling?",
        tells: "Lines changed per week, against the median week.",
        group: "Changes",
        form: "area",
        data: "git log --numstat, per week",
        args: &[
            Arg {
                flag: "days",
                kind: ArgKind::U32,
                help: "Days of history to read, ending now (default 90)",
            },
            PATH,
            Arg {
                flag: "net",
                kind: ArgKind::Flag,
                help: "Lines added minus removed, in place of added plus removed",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "area",
                "title": "Lines changed per week", "unit": "lines changed", "format": "count",
                "x": ["09-07", "09-14", "09-21", "09-28", "10-05", "10-12", "10-19"],
                "series": [{ "name": "lines changed", "values": [3200, 4100, 2800, 5200, 6100, 4700, 7300] }],
                "annotations": [{ "kind": "rule", "value": 4700, "label": "median" }],
            })
        },
        run: commits::velocity,
    },
    Recipe {
        name: "arc-timeline",
        question: "Where did this arc's time go?",
        tells: "Time spent in each stage and step of an arc.",
        group: "Arcs",
        form: "spans",
        data: "the arc log",
        args: &[
            Arg {
                flag: "name",
                kind: ArgKind::Positional,
                help: "The arc (default: the one started most recently)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "spans",
                "title": "Arc sample: 2 steps, 55m00s", "unit": "seconds", "format": "secs",
                "items": [
                    { "label": "Devise", "start": 0, "end": 420 },
                    { "label": "Review", "start": 420, "end": 660 },
                    { "label": "1/2 Cut the old recipes", "start": 660, "end": 1500, "status": "good" },
                    { "label": "2/2 Add the new ones", "start": 1500, "end": 2700, "status": "good" },
                    { "label": "Audit", "start": 2700, "end": 3300 },
                ],
            })
        },
        run: arcs::arc_timeline,
    },
    Recipe {
        name: "arcs",
        question: "How many arcs have run recently?",
        tells: "Arcs started, joined and discarded per week.",
        group: "Arcs",
        form: "stacked bar",
        data: "the arc log",
        args: &[
            Arg {
                flag: "days",
                kind: ArgKind::U32,
                help: "Days of history to read, ending now (default 90)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar", "layout": "stacked",
                "title": "Arcs per week", "unit": "arcs", "format": "int",
                "categories": ["09-07", "09-14", "09-21", "09-28", "10-05", "10-12"],
                "series": [
                    { "name": "started", "values": [6, 9, 7, 12, 10, 14] },
                    { "name": "joined", "values": [5, 8, 7, 10, 9, 13], "role": "good" },
                    { "name": "discarded", "values": [1, 0, 1, 1, 0, 1], "role": "bad" },
                ],
            })
        },
        run: arcs::arcs,
    },
    Recipe {
        name: "arc-stages",
        question: "How do recent arcs compare?",
        tells: "Time each recent arc spent in each stage.",
        group: "Arcs",
        form: "horizontal stacked bar",
        data: "the arc log",
        args: &[
            Arg {
                flag: "limit",
                kind: ArgKind::Usize,
                help: "Newest arcs to draw (default 8)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar", "orient": "horizontal", "layout": "stacked",
                "title": "Time in each stage, newest 3 arc(s)", "unit": "wall time", "format": "secs",
                "categories": ["recipe-sheet", "one-chart-door", "chart-engine"],
                "series": [
                    { "name": "Devise", "values": [0, 0, 420] },
                    { "name": "Review", "values": [0, 0, 240] },
                    { "name": "Implement", "values": [1520, 880, 3100] },
                    { "name": "Audit", "values": [570, 310, 640] },
                ],
            })
        },
        run: arcs::arc_stages,
    },
    Recipe {
        name: "test-history",
        question: "What has been red, and when?",
        tells: "Which files passed or failed, run by run.",
        group: "Tests",
        form: "dots",
        data: "the app-test ledger",
        args: &[
            Arg {
                flag: "files",
                kind: ArgKind::PositionalMany,
                help: "App-test files (default: the 20 most recently red)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "dots",
                "title": "App-test history", "subtitle": "newest 7 runs per file, oldest left",
                "rows": [
                    { "label": "resume.test.ts", "items": ["good", "good", "good", "bad", "bad", "bad", "bad"] },
                    { "label": "settle.test.ts", "items": ["good", "good", "bad", "good", "good", "good", "good"] },
                    { "label": "find.test.ts", "items": ["good", "good", "good", "good", "good", "good", "good"] },
                ],
            })
        },
        run: test_recipes::test_history,
    },
    Recipe {
        name: "gaps",
        question: "Which long commands report nothing?",
        tells: "Long commands that reported no progress.",
        group: "Telemetry",
        form: "horizontal bar",
        data: "the report-gaps record",
        args: &[
            Arg {
                flag: "limit",
                kind: ArgKind::Usize,
                help: "Most rows to draw (default 12)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar", "orient": "horizontal",
                "title": "Long calls that reported nothing", "unit": "wall time", "format": "secs",
                "categories": ["make build", "npm run", "cargo build"],
                "series": [{ "name": "wall time", "values": [1860, 940, 420] }],
            })
        },
        run: gaps::gaps,
    },
    Recipe {
        name: "calls",
        question: "How long do commands take?",
        tells: "How long Bash calls run, leaving out the longest tenth.",
        group: "Telemetry",
        form: "histogram",
        data: "the report-gaps record's call times",
        args: &[TITLE],
        sample: || {
            json!({
                "tugchart": 1, "form": "histogram",
                "title": "Wall time of Bash calls", "unit": "wall time", "format": "secs",
                "values": [
                    0.1, 0.2, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.1, 1.4,
                    1.8, 2.3, 2.9, 3.6, 4.5, 5.8, 7.2, 9.1, 11.5, 13.0,
                ],
            })
        },
        run: gaps::calls,
    },
    Recipe {
        name: "tokens",
        question: "How many tokens does the work use?",
        tells: "Tokens per day by model, one kind at a time, from each turn's last API call.",
        group: "Models",
        form: "stacked bar",
        data: "the session ledger's turns",
        args: &[
            DAYS,
            Arg {
                flag: "kind",
                kind: ArgKind::Choice(&models::TOKEN_KINDS),
                help: "Which tokens to draw (default output)",
            },
            TITLE,
        ],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar", "layout": "stacked",
                "title": "Output tokens per day", "unit": "tokens", "format": "count",
                "categories": WEEK,
                "series": [
                    { "name": "fable", "values": [12000, 18000, 9000, 22000, 16000, 3000, 0] },
                    { "name": "opus", "values": [41000, 52000, 38000, 61000, 47000, 8000, 2000] },
                ],
            })
        },
        run: models::tokens,
    },
    Recipe {
        name: "cost",
        question: "What does the work cost?",
        tells: "Dollars per day by model.",
        group: "Models",
        form: "stacked bar",
        data: "the session ledger's turns",
        args: &[DAYS, TITLE],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar", "layout": "stacked",
                "title": "Cost per day", "unit": "dollars", "format": "auto",
                "categories": WEEK,
                "series": [
                    { "name": "fable", "values": [18.5, 26.0, 12.25, 31.0, 22.5, 4.0, 0] },
                    { "name": "opus", "values": [52.0, 66.5, 48.0, 78.25, 59.0, 11.0, 2.5] },
                ],
            })
        },
        run: models::cost,
    },
    Recipe {
        name: "turns",
        question: "How many turns run each day?",
        tells: "Turns per day by model.",
        group: "Models",
        form: "stacked bar",
        data: "the session ledger's turns",
        args: &[DAYS, TITLE],
        sample: || {
            json!({
                "tugchart": 1, "form": "bar", "layout": "stacked",
                "title": "Turns per day", "unit": "turns", "format": "int",
                "categories": WEEK,
                "series": [
                    { "name": "fable", "values": [14, 21, 9, 25, 18, 3, 0] },
                    { "name": "opus", "values": [38, 47, 33, 55, 42, 8, 2] },
                ],
            })
        },
        run: models::turns,
    },
];

/// The recipe of this name.
pub fn find(name: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|r| r.name == name)
}

/// The parser for one recipe: its arguments, and `--json`.
pub fn clap_command(recipe: &Recipe) -> Command {
    let mut command = Command::new(recipe.name).about(recipe.question).arg(
        clap::Arg::new("json")
            .long("json")
            .action(ArgAction::SetTrue)
            .help("Print the summary and the spec as JSON, and draw nothing"),
    );
    for arg in recipe.args {
        let built = clap::Arg::new(arg.flag).help(arg.help);
        command = command.arg(match arg.kind {
            ArgKind::Flag => built.long(arg.flag).action(ArgAction::SetTrue),
            ArgKind::U32 => built.long(arg.flag).value_parser(value_parser!(u32)),
            ArgKind::Usize => built.long(arg.flag).value_parser(value_parser!(usize)),
            ArgKind::Str => built.long(arg.flag),
            ArgKind::Choice(values) => {
                built
                    .long(arg.flag)
                    .value_parser(clap::builder::PossibleValuesParser::new(
                        values.iter().copied(),
                    ))
            }
            ArgKind::Positional => built,
            ArgKind::PositionalMany => built.num_args(0..).action(ArgAction::Append),
        });
    }
    command
}

fn strings(arg: &Arg, m: &ArgMatches) -> Vec<String> {
    m.get_many::<String>(arg.flag)
        .map(|values| values.cloned().collect())
        .unwrap_or_default()
}

/// What the parser built by [`clap_command`] read.
pub fn args_from_matches(recipe: &Recipe, m: &ArgMatches) -> RecipeArgs {
    let mut out = RecipeArgs::default();
    for arg in recipe.args {
        match arg.flag {
            "days" => out.days = m.get_one::<u32>(arg.flag).copied(),
            "path" => out.path = m.get_one::<String>(arg.flag).cloned(),
            "range" => out.range = m.get_one::<String>(arg.flag).cloned(),
            "staged" => out.staged = m.get_flag(arg.flag),
            "session" => out.session = m.get_flag(arg.flag),
            "title" => out.title = m.get_one::<String>(arg.flag).cloned(),
            "by" => out.by = m.get_one::<String>(arg.flag).cloned(),
            "net" => out.net = m.get_flag(arg.flag),
            "depth" => out.depth = m.get_one::<u32>(arg.flag).copied(),
            "limit" => out.limit = m.get_one::<usize>(arg.flag).copied(),
            "kind" => out.kind = m.get_one::<String>(arg.flag).cloned(),
            "name" | "files" => out.subjects = strings(arg, m),
            other => unreachable!("no RecipeArgs field reads --{other}"),
        }
    }
    out
}

/// The catalog as `chart list --json` and the list route print it.
pub fn catalog_json() -> Value {
    let recipes: Vec<Value> = RECIPES
        .iter()
        .map(|recipe| {
            let args: Vec<Value> = recipe
                .args
                .iter()
                .map(|arg| {
                    let takes = match arg.kind {
                        ArgKind::Flag => "nothing".to_string(),
                        ArgKind::U32 | ArgKind::Usize => "number".to_string(),
                        ArgKind::Str => "text".to_string(),
                        ArgKind::Choice(values) => values.join(" or "),
                        ArgKind::Positional => "positional".to_string(),
                        ArgKind::PositionalMany => "positional, repeatable".to_string(),
                    };
                    json!({ "flag": arg.flag, "help": arg.help, "takes": takes })
                })
                .collect();
            json!({
                "name": recipe.name,
                "question": recipe.question,
                "tells": recipe.tells,
                "group": recipe.group,
                "form": recipe.form,
                "data": recipe.data,
                "args": args,
                "sample": (recipe.sample)(),
            })
        })
        .collect();
    Value::Array(recipes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::test_support::assert_valid;

    /// An argv naming every argument `recipe` takes.
    fn argv(recipe: &Recipe) -> Vec<String> {
        let mut out = vec![recipe.name.to_string()];
        for arg in recipe.args {
            let long = format!("--{}", arg.flag);
            match arg.kind {
                ArgKind::Flag => out.push(long),
                ArgKind::U32 | ArgKind::Usize => out.extend([long, "7".to_string()]),
                ArgKind::Str => out.extend([long, "v".to_string()]),
                ArgKind::Choice(values) => out.extend([long, values[0].to_string()]),
                ArgKind::Positional => out.push("v".to_string()),
                ArgKind::PositionalMany => out.extend(["v".to_string(), "w".to_string()]),
            }
        }
        out
    }

    fn landed_in(flag: &str, kind: ArgKind, args: &RecipeArgs) -> bool {
        let many = vec!["v".to_string(), "w".to_string()];
        let one = vec!["v".to_string()];
        let strings = if matches!(kind, ArgKind::PositionalMany) {
            &many
        } else {
            &one
        };
        match flag {
            "days" => args.days == Some(7),
            "path" => args.path.as_deref() == Some("v"),
            "range" => args.range.as_deref() == Some("v"),
            "staged" => args.staged,
            "session" => args.session,
            "title" => args.title.as_deref() == Some("v"),
            "by" => args.by.as_deref() == Some("day"),
            "net" => args.net,
            "depth" => args.depth == Some(7),
            "limit" => args.limit == Some(7),
            "kind" => args.kind.as_deref() == Some("output"),
            "name" | "files" => &args.subjects == strings,
            _ => false,
        }
    }

    #[test]
    fn every_argument_of_every_recipe_round_trips() {
        for recipe in &RECIPES {
            let command = clap_command(recipe);
            command.clone().debug_assert();
            let m = command
                .try_get_matches_from(argv(recipe))
                .unwrap_or_else(|e| panic!("{}: {e}", recipe.name));
            let args = args_from_matches(recipe, &m);
            for arg in recipe.args {
                assert!(
                    landed_in(arg.flag, arg.kind, &args),
                    "{} --{}",
                    recipe.name,
                    arg.flag
                );
            }
        }
    }

    #[test]
    fn a_flag_the_recipe_does_not_list_is_a_usage_error() {
        let commits = find("commits").unwrap();
        assert!(
            clap_command(commits)
                .try_get_matches_from(["commits", "--staged"])
                .is_err()
        );
    }

    #[test]
    fn names_are_unique_kebab_case_and_shadow_no_subcommand() {
        let mut names: Vec<&str> = RECIPES.iter().map(|r| r.name).collect();
        for name in &names {
            assert!(
                name.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{name}"
            );
            assert!(!name.starts_with('-') && !name.ends_with('-'), "{name}");
            assert!(*name != "render" && *name != "list", "{name}");
        }
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), RECIPES.len());
    }

    #[test]
    fn every_recipe_says_what_it_tells_and_draws_a_sample_of_its_own_form() {
        for recipe in &RECIPES {
            assert!(recipe.tells.ends_with('.'), "{}", recipe.name);
            assert!(!recipe.group.is_empty(), "{}", recipe.name);
            let sample = (recipe.sample)();
            assert_valid(&sample);
            let form = sample["form"].as_str().unwrap();
            assert!(recipe.form.contains(form), "{}: {form}", recipe.name);
        }
    }

    #[test]
    fn a_group_sits_together_and_sections_read_in_catalog_order() {
        let mut sections: Vec<&str> = RECIPES.iter().map(|r| r.group).collect();
        sections.dedup();
        assert_eq!(
            sections,
            vec![
                "Activity",
                "Changes",
                "Arcs",
                "Tests",
                "Telemetry",
                "Models"
            ]
        );
    }

    /// The deck's sample test reads this dump, so a new recipe changes no deck
    /// source. `TUGCHART_BLESS=1` rewrites it.
    #[test]
    fn the_catalog_dump_is_the_catalog() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("catalog.json");
        let want = serde_json::to_string_pretty(&catalog_json()).unwrap() + "\n";
        if std::env::var_os("TUGCHART_BLESS").is_some() {
            std::fs::write(&path, &want).unwrap();
        }
        assert!(
            std::fs::read_to_string(&path).unwrap_or_default() == want,
            "`{}` is stale: rewrite it with `TUGCHART_BLESS=1 cargo nextest run -p tugchart-core the_catalog_dump`",
            path.display()
        );
    }

    #[test]
    fn the_catalog_lists_every_recipe_with_its_arguments() {
        let catalog = catalog_json();
        let recipes = catalog.as_array().unwrap();
        assert_eq!(recipes.len(), 18);
        assert_eq!(recipes[0]["name"], "commits");
        assert_eq!(recipes[0]["args"][0]["flag"], "days");
        assert_eq!(recipes[0]["args"][0]["takes"], "number");
        assert_eq!(recipes[0]["group"], "Activity");
        assert_eq!(recipes[0]["tells"], RECIPES[0].tells);
        assert_eq!(recipes[0]["sample"]["form"], "bar");
        assert_eq!(recipes[14]["name"], "calls");
        assert_eq!(recipes[17]["name"], "turns");
        assert!(find("commits").is_some());
        assert!(find("nothing").is_none());
    }
}

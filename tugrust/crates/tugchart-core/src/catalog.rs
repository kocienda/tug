//! The one list of recipes. The command line, `chart list` and the routes are
//! all built from [`RECIPES`], so none of them can name a recipe or a flag the
//! others do not.

use clap::{ArgAction, ArgMatches, Command, value_parser};
use serde_json::{Value, json};

use crate::context::{RecipeArgs, RecipeContext, RecipeError, RecipeOutcome};
use crate::tests as test_recipes;
use crate::{arcs, commits, gaps};

/// How one argument is spelled and what it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgKind {
    Flag,
    U32,
    Usize,
    Str,
    StrMany,
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

/// One well-known chart.
pub struct Recipe {
    pub name: &'static str,
    pub question: &'static str,
    pub form: &'static str,
    pub data: &'static str,
    pub args: &'static [Arg],
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

pub static RECIPES: [Recipe; 12] = [
    Recipe {
        name: "commits",
        question: "How active has this been?",
        form: "bar",
        data: "git log",
        args: &[DAYS, PATH, TITLE],
        run: commits::commits,
    },
    Recipe {
        name: "churn",
        question: "How much changed here, over time?",
        form: "stacked area",
        data: "git log --numstat, per day",
        args: &[DAYS, PATH, TITLE],
        run: commits::churn,
    },
    Recipe {
        name: "hotspots",
        question: "Which files or directories change most?",
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
                help: "Most rows to draw (default 20)",
            },
            TITLE,
        ],
        run: commits::hotspots,
    },
    Recipe {
        name: "landed",
        question: "Where did this change land?",
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
        run: commits::landed,
    },
    Recipe {
        name: "commit-kinds",
        question: "What kind of work was it, by day?",
        form: "stacked area",
        data: "git log subjects",
        args: &[DAYS, PATH, TITLE],
        run: commits::commit_kinds,
    },
    Recipe {
        name: "commit-hours",
        question: "When does work land?",
        form: "heat",
        data: "git log committer times",
        args: &[DAYS, PATH, TITLE],
        run: commits::commit_hours,
    },
    Recipe {
        name: "arc-timeline",
        question: "Where did this arc's time go?",
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
        run: arcs::arc_timeline,
    },
    Recipe {
        name: "suite-times",
        question: "Are the suites getting slower?",
        form: "line",
        data: "the test ledger",
        args: &[
            Arg {
                flag: "suite",
                kind: ArgKind::StrMany,
                help: "Plot exactly this suite; repeatable",
            },
            Arg {
                flag: "all",
                kind: ArgKind::Flag,
                help: "Plot every suite, however small beside the slowest",
            },
            Arg {
                flag: "runs",
                kind: ArgKind::Usize,
                help: "Newest runs per suite (default 30)",
            },
            TITLE,
        ],
        run: test_recipes::suite_times,
    },
    Recipe {
        name: "test-distribution",
        question: "How are test times spread?",
        form: "histogram",
        data: "the test ledger's latest runs",
        args: &[
            Arg {
                flag: "suite",
                kind: ArgKind::Str,
                help: "Only this suite",
            },
            TITLE,
        ],
        run: test_recipes::test_distribution,
    },
    Recipe {
        name: "test-budget",
        question: "Which tests are near their budget?",
        form: "bullet",
        data: "the app-test ledger",
        args: &[
            Arg {
                flag: "limit",
                kind: ArgKind::Usize,
                help: "Most files to draw (default 12)",
            },
            TITLE,
        ],
        run: test_recipes::test_budget,
    },
    Recipe {
        name: "test-history",
        question: "What has been red, and when?",
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
        run: test_recipes::test_history,
    },
    Recipe {
        name: "gaps",
        question: "Which long commands report nothing?",
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
        run: gaps::gaps,
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
            ArgKind::StrMany => built.long(arg.flag).action(ArgAction::Append),
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
            "suite" => out.suites = strings(arg, m),
            "all" => out.all = m.get_flag(arg.flag),
            "runs" => out.runs = m.get_one::<usize>(arg.flag).copied(),
            "depth" => out.depth = m.get_one::<u32>(arg.flag).copied(),
            "limit" => out.limit = m.get_one::<usize>(arg.flag).copied(),
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
                        ArgKind::Flag => "nothing",
                        ArgKind::U32 | ArgKind::Usize => "number",
                        ArgKind::Str => "text",
                        ArgKind::StrMany => "text, repeatable",
                        ArgKind::Positional => "positional",
                        ArgKind::PositionalMany => "positional, repeatable",
                    };
                    json!({ "flag": arg.flag, "help": arg.help, "takes": takes })
                })
                .collect();
            json!({
                "name": recipe.name,
                "question": recipe.question,
                "form": recipe.form,
                "data": recipe.data,
                "args": args,
            })
        })
        .collect();
    Value::Array(recipes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An argv naming every argument `recipe` takes.
    fn argv(recipe: &Recipe) -> Vec<String> {
        let mut out = vec![recipe.name.to_string()];
        for arg in recipe.args {
            let long = format!("--{}", arg.flag);
            match arg.kind {
                ArgKind::Flag => out.push(long),
                ArgKind::U32 | ArgKind::Usize => out.extend([long, "7".to_string()]),
                ArgKind::Str => out.extend([long, "v".to_string()]),
                ArgKind::StrMany => {
                    out.extend([long.clone(), "v".to_string(), long, "w".to_string()])
                }
                ArgKind::Positional => out.push("v".to_string()),
                ArgKind::PositionalMany => out.extend(["v".to_string(), "w".to_string()]),
            }
        }
        out
    }

    fn landed_in(flag: &str, kind: ArgKind, args: &RecipeArgs) -> bool {
        let many = vec!["v".to_string(), "w".to_string()];
        let one = vec!["v".to_string()];
        let strings = if matches!(kind, ArgKind::StrMany | ArgKind::PositionalMany) {
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
            "suite" => &args.suites == strings,
            "all" => args.all,
            "runs" => args.runs == Some(7),
            "depth" => args.depth == Some(7),
            "limit" => args.limit == Some(7),
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
    fn the_catalog_lists_every_recipe_with_its_arguments() {
        let catalog = catalog_json();
        let recipes = catalog.as_array().unwrap();
        assert_eq!(recipes.len(), 12);
        assert_eq!(recipes[0]["name"], "commits");
        assert_eq!(recipes[0]["args"][0]["flag"], "days");
        assert_eq!(recipes[0]["args"][0]["takes"], "number");
        assert_eq!(recipes[11]["name"], "gaps");
        assert!(find("commits").is_some());
        assert!(find("nothing").is_none());
    }
}

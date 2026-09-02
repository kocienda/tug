//! Configuration handling for tug

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::TugError;

/// Tug configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    /// Tugtool-specific settings
    #[serde(default, alias = "tug")]
    pub tugtool: TugConfig,
}

/// Core tug settings
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TugConfig {
    /// Arc settings.
    #[serde(default)]
    pub dash: ArcConfig,
}

/// Arc configuration.
///
/// The TOML table it deserializes from stays `[tugtool.dash]` — a key every
/// project's own `.tugtool/config.toml` has already written down, so renaming
/// it would be a migration rather than a rename ([P05]).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ArcConfig {
    /// Shell commands run from the new worktree root immediately after
    /// `dash create` adds it — e.g. `bun install --cwd tugdeck`. A git
    /// worktree never inherits gitignored files, so deps are always absent in
    /// a fresh worktree; this hydrates it. A non-zero exit rolls the new
    /// worktree+branch back and fails `create`.
    #[serde(default)]
    pub post_create: Vec<String>,

    /// The retired `verify` key, bound only so the loader can see it and
    /// refuse. Nothing reads its value: a project declares the surfaces it is
    /// made of, and the fit check runs what those surfaces declare. A config
    /// still carrying this key would look like coverage while providing none,
    /// so it is a refusal rather than a silently ignored field.
    #[serde(default, rename = "verify")]
    pub retired_verify: Option<String>,

    /// The surfaces this project is made of: what each claims, and what
    /// checking it means. `tugtool arc verify` resolves every path a dash
    /// would land to exactly one of these, refuses when a path resolves to
    /// none, and runs what the matched surfaces declare. An empty table is the
    /// declared-none state, not an error.
    #[serde(default, rename = "surface")]
    pub surfaces: Vec<Surface>,

    /// The command that produces an inspectable instance from the worktree.
    /// Absent means no build is offered.
    #[serde(default)]
    pub build: Option<String>,

    /// The model the arc's devise stage runs on ([P13]). Absent means the
    /// account default — a project declares a stage model, it never inherits
    /// one, and the arc's receipt says which stages ran unspecified rather
    /// than implying a choice nobody made ([D151]).
    #[serde(default)]
    pub devise_model: Option<String>,

    /// The model the arc's review stage runs on. Absent means the account
    /// default.
    #[serde(default)]
    pub review_model: Option<String>,

    /// The model the arc's implement stage runs on. Absent means the account
    /// default.
    #[serde(default)]
    pub implement_model: Option<String>,

    /// The model the arc's audit stage runs on. Absent means the account
    /// default.
    #[serde(default)]
    pub audit_model: Option<String>,

    /// The context size, in tokens, above which a seated implement stage is
    /// compacted at a step boundary. Absent means
    /// [`IMPLEMENT_COMPACT_TOKENS_DEFAULT`], which
    /// [`ArcConfig::compact_tokens`] applies.
    #[serde(default)]
    pub implement_compact_tokens: Option<u64>,

    /// How long an arc may go without motion of any kind before it stops and
    /// hands the card back — the arc's clock, in seconds. Absent means
    /// [`ARC_STALL_SECS_DEFAULT`], which [`ArcConfig::stall_timeout`]
    /// applies; `0` turns the clock off.
    ///
    /// Every other thing the arc decides is decided on an edge: a turn
    /// ending, a document changing. A stage that hangs mid-turn produces no
    /// edge at all, and one that ends a single turn and then goes silent
    /// leaves the quiet-turn horizon at 1 forever, because the horizon also
    /// counts turns that end. This is the only fact in the machine measured
    /// against a wall clock rather than against an edge.
    #[serde(default)]
    pub arc_stall_secs: Option<u64>,
}

/// One surface of a project: the paths it claims, and what checking it means.
///
/// Declared as `[[tugtool.dash.surface]]` in `.tugtool/config.toml`. A surface
/// either declares its own `check` commands, borrows another surface's with
/// `checked_by`, or declares neither — `check = []` being the claim that these
/// paths are accounted for and there is nothing to run.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Surface {
    /// A short identifier a human reads on a report line. Unique across the
    /// table; not a path, and carrying no meaning beyond naming this surface.
    pub name: String,

    /// The repo-relative prefixes and exact paths this surface claims. A
    /// touched path goes to the surface declaring the longest claiming path.
    pub paths: Vec<String>,

    /// The shell commands that check this surface, run in declaration order
    /// from the worktree root. Empty means claimed with nothing to run.
    #[serde(default)]
    pub check: Vec<String>,

    /// Other surfaces whose own `check` commands run as this surface's. One
    /// level deep: a borrowed surface may not itself borrow.
    #[serde(default)]
    pub checked_by: Vec<String>,
}

/// The context size, in tokens, a seated implement stage is compacted above
/// when a project declares none ([P07]).
///
/// A token count rather than a share of the model's window, because what makes
/// a stage work badly is a long context, and long is a number of tokens. The
/// share it happens to be of whatever model the stage is running on is not the
/// same judgement, and on a very large window it is not even close to it.
pub const IMPLEMENT_COMPACT_TOKENS_DEFAULT: u64 = 300_000;

/// How long an arc may go without motion before the clock stops it, when a
/// project declares nothing ([P07]).
///
/// Half an hour, and it can be that short because motion is not only a turn
/// *ending*: the seated session's context growing counts, and a turn that is
/// genuinely working — a stage running a full test sweep, a long build, a
/// wide read — reports usage as it goes. So a slow turn keeps the clock
/// reset and a hung one does not, which is the distinction the deadline
/// alone could never draw. Were the count the only signal, this would have to
/// outlast the longest legitimate turn, and the wedge would sit most of a
/// working day before anyone was told.
///
/// The clock is still the last resort under every other arm rather than a
/// pacing device: it exists so an arc that has genuinely gone silent says so.
pub const ARC_STALL_SECS_DEFAULT: u64 = 1_800;

impl ArcConfig {
    /// The compaction threshold to actually use: the declaration, or the
    /// default. The default lives at the consumer rather than in the parse so
    /// `dash config` can still report honestly that nothing was declared.
    pub fn compact_tokens(&self) -> u64 {
        self.implement_compact_tokens
            .unwrap_or(IMPLEMENT_COMPACT_TOKENS_DEFAULT)
    }

    /// The clock's deadline to actually use: the declaration, or the default.
    /// `None` is the clock turned off — a declared `0`, which is the one way
    /// a project can ask for the old behaviour of waiting forever.
    pub fn stall_timeout(&self) -> Option<std::time::Duration> {
        let secs = self.arc_stall_secs.unwrap_or(ARC_STALL_SECS_DEFAULT);
        (secs > 0).then(|| std::time::Duration::from_secs(secs))
    }
}

/// The config file a project starts with: an empty hydration list and a
/// commented example for every optional declaration.
///
/// It lives here rather than beside `tugtool init` so the template has one
/// home; two copies would be two contracts free to drift.
pub const DEFAULT_CONFIG: &str = r#"[tugtool.dash]
# Commands run from a new dash worktree to hydrate it (deps, etc.).
# A git worktree never inherits gitignored files, so these install what a
# fresh checkout lacks. A non-zero exit rolls the worktree back.
post_create = []
# post_create = ["npm install"]

# The surfaces this project is made of. `tugtool arc verify <dash>` resolves
# every path the dash would land to the surface declaring the longest matching
# path, and refuses — naming the paths — when one resolves to no surface. An
# empty table declares none: the ending falls back to the plan's own checkpoint
# commands over what the replay moved.
#
# `check` runs from the worktree root, in declaration order. `{base}`, `{head}`,
# and `{paths}` expand to the range's endpoints and to this surface's own
# touched paths, shell-quoted. `check = []` claims the paths and runs nothing.
# `checked_by` borrows another surface's commands, one level deep.
#
# [[tugtool.dash.surface]]
# name  = "src"
# paths = ["src/"]
# check = ["make check"]
#
# [[tugtool.dash.surface]]
# name  = "docs"
# paths = ["README.md", "doc/"]
# check = []

# The command that produces an inspectable instance from this worktree.
# Declare none and no build is offered.
# build = "make app"

# The models the server-driven arc runs each stage on. Declare none and a stage
# runs on the account default, which the arc's receipt says out loud.
# devise_model = "sonnet"
# review_model = "opus"
# implement_model = "sonnet"
# audit_model = "opus"

# The context size, in tokens, above which a seated implement stage is
# compacted at a step boundary. A stage a compaction cannot bring back under
# this line rotates to a fresh session instead. Declare none and it is 300000.
# implement_compact_tokens = 300000
"#;

/// Why a config file was refused. Every variant carries the offending value,
/// because a refusal a reader cannot act on is a refusal that gets worked
/// around rather than fixed.
///
/// Raised only by what a config *declares*: a missing file is validated not at
/// all, and an absent surface table is the declared-none state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigRefusal {
    /// The retired `verify` key, which a surface table replaces.
    RetiredVerify(String),
    /// A surface with an empty `name`.
    EmptyName,
    /// Two surfaces sharing a `name`.
    DuplicateName(String),
    /// A surface declaring no paths, or an empty path string.
    EmptyPaths(String),
    /// A path that cannot be resolved against a repo root as written.
    IllegalPath { surface: String, path: String },
    /// Two surfaces claiming the same path, which no longest-prefix rule can
    /// disambiguate.
    DuplicatePath {
        first: String,
        second: String,
        path: String,
    },
    /// A `checked_by` naming a surface the table does not declare.
    UnknownLender { surface: String, lender: String },
    /// A `checked_by` naming a surface that itself borrows.
    LenderBorrows { surface: String, lender: String },
    /// A `checked_by` naming its own surface.
    SelfBorrow(String),
}

impl std::fmt::Display for ConfigRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RetiredVerify(value) => write!(
                f,
                "[tugtool.dash].verify is retired (declared as {value:?}) — declare \
                 [[tugtool.dash.surface]] entries instead, and run `tugtool arc verify <dash>`"
            ),
            Self::EmptyName => f.write_str("a [[tugtool.dash.surface]] declares an empty name"),
            Self::DuplicateName(name) => {
                write!(f, "two surfaces are both named {name:?}")
            }
            Self::EmptyPaths(surface) => write!(
                f,
                "surface {surface:?} declares no paths — a surface claims at least one path"
            ),
            Self::IllegalPath { surface, path } => write!(
                f,
                "surface {surface:?} declares the path {path:?} — paths are repo-relative, \
                 without `..`, and match by prefix rather than by glob"
            ),
            Self::DuplicatePath {
                first,
                second,
                path,
            } => write!(
                f,
                "surfaces {first:?} and {second:?} both claim {path:?} — a path belongs to \
                 exactly one surface"
            ),
            Self::UnknownLender { surface, lender } => write!(
                f,
                "surface {surface:?} is checked_by {lender:?}, which no surface declares"
            ),
            Self::LenderBorrows { surface, lender } => write!(
                f,
                "surface {surface:?} is checked_by {lender:?}, which itself declares \
                 checked_by — borrowing is one level deep"
            ),
            Self::SelfBorrow(name) => {
                write!(f, "surface {name:?} declares itself in its own checked_by")
            }
        }
    }
}

impl ArcConfig {
    /// Check everything this table declares, before anything believes it.
    ///
    /// Runs after the parse, on a config that was actually read from a file.
    /// A project declaring no surfaces passes trivially — absence is a state,
    /// and the only thing refused here is a declaration that cannot mean what
    /// it says.
    pub fn validate(&self) -> Result<(), ConfigRefusal> {
        if let Some(value) = &self.retired_verify {
            return Err(ConfigRefusal::RetiredVerify(value.clone()));
        }

        for (index, surface) in self.surfaces.iter().enumerate() {
            if surface.name.trim().is_empty() {
                return Err(ConfigRefusal::EmptyName);
            }
            if self.surfaces[..index]
                .iter()
                .any(|s| s.name == surface.name)
            {
                return Err(ConfigRefusal::DuplicateName(surface.name.clone()));
            }
            if surface.paths.is_empty() || surface.paths.iter().any(|p| p.trim().is_empty()) {
                return Err(ConfigRefusal::EmptyPaths(surface.name.clone()));
            }
            for path in &surface.paths {
                if Path::new(path).is_absolute()
                    || path.split('/').any(|c| c == "..")
                    || path.contains(['*', '?', '['])
                {
                    return Err(ConfigRefusal::IllegalPath {
                        surface: surface.name.clone(),
                        path: path.clone(),
                    });
                }
                if let Some(other) = self.surfaces[..index]
                    .iter()
                    .find(|s| s.paths.iter().any(|p| p == path))
                {
                    return Err(ConfigRefusal::DuplicatePath {
                        first: other.name.clone(),
                        second: surface.name.clone(),
                        path: path.clone(),
                    });
                }
            }
        }

        // Borrowing is checked against the whole table, so a surface may
        // legally borrow one declared after it.
        for surface in &self.surfaces {
            for lender in &surface.checked_by {
                if *lender == surface.name {
                    return Err(ConfigRefusal::SelfBorrow(surface.name.clone()));
                }
                match self.surfaces.iter().find(|s| s.name == *lender) {
                    None => {
                        return Err(ConfigRefusal::UnknownLender {
                            surface: surface.name.clone(),
                            lender: lender.clone(),
                        });
                    }
                    Some(found) if !found.checked_by.is_empty() => {
                        return Err(ConfigRefusal::LenderBorrows {
                            surface: surface.name.clone(),
                            lender: lender.clone(),
                        });
                    }
                    Some(_) => {}
                }
            }
        }

        Ok(())
    }
}
impl Config {
    /// Load configuration from a file
    pub fn load(path: &Path) -> Result<Self, TugError> {
        let content = fs::read_to_string(path)
            .map_err(|e| TugError::Config(format!("failed to read config file: {}", e)))?;
        let config: Self = toml::from_str(&content)
            .map_err(|e| TugError::Config(format!("failed to parse config file: {}", e)))?;
        config
            .tugtool
            .dash
            .validate()
            .map_err(|e| TugError::Config(format!("{}: {}", path.display(), e)))?;
        Ok(config)
    }

    /// Load configuration from .tug/config.toml in the given project root
    pub fn load_from_project(project_root: &Path) -> Result<Self, TugError> {
        let config_path = project_root.join(".tugtool").join("config.toml");
        if config_path.exists() {
            Self::load(&config_path)
        } else {
            Ok(Config::default())
        }
    }
}

/// Find the project root by searching upward for `.tug/` directory
///
/// Per [D07], commands search upward from current working directory to find
/// `.tug/` directory, stopping at filesystem root.
pub fn find_project_root() -> Result<PathBuf, TugError> {
    find_project_root_from(
        std::env::current_dir()
            .map_err(|e| TugError::Config(format!("failed to get current directory: {}", e)))?,
    )
}

/// Find the project root starting from a specific directory
///
/// A `.tugtool/` directory marks the root outright. Without one, the nearest
/// enclosing git checkout is the project: a project that declares nothing has
/// no `.tugtool/` at all, and `load_from_project` already answers for it with
/// the defaults. Only a directory inside neither is uninitialized.
pub(crate) fn find_project_root_from(start: PathBuf) -> Result<PathBuf, TugError> {
    let mut current = start;
    let mut checkout: Option<PathBuf> = None;
    loop {
        if current.join(".tugtool").is_dir() {
            return Ok(current);
        }
        if checkout.is_none() && current.join(".git").exists() {
            checkout = Some(current.clone());
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return checkout.ok_or(TugError::NotInitialized),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A table's refusals, each with the offending value named — and, beside
    /// each, a neighbouring config that differs only in being legal, so a
    /// refusal that fired too broadly is caught here rather than by a project
    /// whose config stopped loading.
    #[test]
    fn surface_table_refusals_each_name_the_offending_value() {
        let cases: &[(&str, &str, &[&str])] = &[
            (
                "the retired verify key",
                "[tugtool.dash]\nverify = \"sh scripts/check.sh {base} {head}\"\n",
                &["verify", "[[tugtool.dash.surface]]"],
            ),
            (
                "an empty name",
                "[[tugtool.dash.surface]]\nname = \"\"\npaths = [\"src/\"]\n",
                &["empty name"],
            ),
            (
                "two surfaces sharing a name",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"x/\"]\n\n[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"y/\"]\n",
                &["\"a\""],
            ),
            (
                "no paths at all",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = []\n",
                &["\"a\"", "no paths"],
            ),
            (
                "an empty path string",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"\"]\n",
                &["\"a\""],
            ),
            (
                "an absolute path",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"/etc/\"]\n",
                &["\"a\"", "/etc/"],
            ),
            (
                "a path escaping the root",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"../elsewhere/\"]\n",
                &["\"a\"", "../elsewhere/"],
            ),
            (
                "a glob",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"src/*.rs\"]\n",
                &["\"a\"", "src/*.rs"],
            ),
            (
                "two surfaces claiming the same path",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"src/\"]\n\n[[tugtool.dash.surface]]\nname = \"b\"\npaths = [\"src/\"]\n",
                &["\"a\"", "\"b\"", "src/"],
            ),
            (
                "a checked_by naming nothing",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"x/\"]\nchecked_by = [\"ghost\"]\n",
                &["\"a\"", "ghost"],
            ),
            (
                "a checked_by naming a borrower",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"x/\"]\nchecked_by = [\"b\"]\n\n[[tugtool.dash.surface]]\nname = \"b\"\npaths = [\"y/\"]\nchecked_by = [\"c\"]\n\n[[tugtool.dash.surface]]\nname = \"c\"\npaths = [\"z/\"]\ncheck = [\"true\"]\n",
                &["\"a\"", "\"b\"", "one level"],
            ),
            (
                "a surface borrowing itself",
                "[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"x/\"]\nchecked_by = [\"a\"]\n",
                &["\"a\""],
            ),
        ];

        for (label, toml_text, fragments) in cases {
            let config: Config =
                toml::from_str(toml_text).unwrap_or_else(|e| panic!("{label} should parse: {e}"));
            let refusal = config
                .tugtool
                .dash
                .validate()
                .expect_err(&format!("{label} must be refused"));
            let message = refusal.to_string();
            for fragment in *fragments {
                assert!(
                    message.contains(fragment),
                    "{label}: the refusal must name {fragment:?}, said: {message}"
                );
            }
        }

        // The neighbour: everything the cases above got wrong, done right.
        let legal: Config = toml::from_str(
            "[tugtool.dash]\npost_create = []\n\n[[tugtool.dash.surface]]\nname = \"a\"\npaths = [\"src/\", \"README.md\"]\ncheck = [\"make check\"]\n\n[[tugtool.dash.surface]]\nname = \"b\"\npaths = [\"proto/\"]\nchecked_by = [\"a\"]\n",
        )
        .expect("the legal neighbour should parse");
        legal
            .tugtool
            .dash
            .validate()
            .expect("the legal neighbour must still load");
    }

    /// Overlap is not ambiguity: a longer prefix shadowing a shorter one is
    /// the resolution rule working, and only an *identical* claim is refused.
    #[test]
    fn overlapping_prefixes_are_legal_and_identical_ones_are_not() {
        let overlapping: Config = toml::from_str(
            "[[tugtool.dash.surface]]\nname = \"deck\"\npaths = [\"tugdeck/\"]\ncheck = [\"tsc\"]\n\n[[tugtool.dash.surface]]\nname = \"wasm\"\npaths = [\"tugdeck/crates/\"]\ncheck = [\"just wasm\"]\n",
        )
        .unwrap();
        overlapping
            .tugtool
            .dash
            .validate()
            .expect("a longer prefix shadowing a shorter one is legal");

        let identical: Config = toml::from_str(
            "[[tugtool.dash.surface]]\nname = \"deck\"\npaths = [\"tugdeck/\"]\n\n[[tugtool.dash.surface]]\nname = \"other\"\npaths = [\"tugdeck/\"]\n",
        )
        .unwrap();
        assert!(identical.tugtool.dash.validate().is_err());
    }

    /// A config file that declares the retired key does not merely fail an
    /// assertion — it stops loading, which is what makes the retirement real.
    #[test]
    fn a_config_declaring_the_retired_key_fails_to_load() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".tugtool")).unwrap();
        fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\nverify = \"sh scripts/check.sh {base} {head}\"\n",
        )
        .unwrap();

        let err = Config::load_from_project(root).expect_err("the retired key must refuse");
        let message = err.to_string();
        assert!(
            message.contains("[[tugtool.dash.surface]]"),
            "the refusal must point at the replacement: {message}"
        );
    }

    /// The refusals fire on what a config declares, so a project with no
    /// config file is not validated at all.
    #[test]
    fn a_missing_config_file_is_the_empty_table_and_no_error() {
        let tmp = tempfile::tempdir().unwrap();
        let config = Config::load_from_project(tmp.path()).expect("a missing file is not an error");
        assert!(config.tugtool.dash.surfaces.is_empty());
        assert!(config.tugtool.dash.retired_verify.is_none());
    }

    /// The template a fresh project starts from must itself survive the
    /// loader, and must document the table rather than the key it replaced.
    #[test]
    fn the_default_config_template_declares_a_legal_empty_table() {
        let config: Config =
            toml::from_str(DEFAULT_CONFIG).expect("the template must be valid TOML");
        config
            .tugtool
            .dash
            .validate()
            .expect("the template must validate clean");
        assert!(config.tugtool.dash.surfaces.is_empty());
        assert!(
            DEFAULT_CONFIG.contains("[[tugtool.dash.surface]]"),
            "the template must document the surface table"
        );
        for placeholder in ["{base}", "{head}", "{paths}"] {
            assert!(
                DEFAULT_CONFIG.contains(placeholder),
                "the template must document {placeholder}"
            );
        }
        assert!(
            !DEFAULT_CONFIG.contains("verify ="),
            "the template must not document the retired key"
        );
    }
    /// This repository's own committed config, through the real loader.
    ///
    /// Cheap, and it catches a hand-edit typo at commit time rather than at the
    /// next dash's ending — which is the moment a config that will not load is
    /// most expensive and least expected.
    #[test]
    fn this_repositorys_own_config_loads_and_validates() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .expect("the crate sits three levels under the repo root")
            .to_path_buf();
        let config_path = root.join(".tugtool/config.toml");
        if !config_path.exists() {
            // A checkout without one is not this repository; nothing to assert.
            return;
        }
        let config = Config::load(&config_path)
            .expect("this repository's committed config must load through the real loader");
        assert!(
            !config.tugtool.dash.surfaces.is_empty(),
            "this repository declares its surfaces"
        );
        assert!(
            config.tugtool.dash.retired_verify.is_none(),
            "the retired key would make this config unloadable"
        );
    }

    /// A checkout still carrying the retired `docs` declaration loads: serde
    /// ignores unknown keys, so nobody has to edit a config file to upgrade.
    #[test]
    fn a_stale_docs_key_is_ignored() {
        let config: Config = toml::from_str("[tugtool.dash]\ndocs = \"dash\"\n")
            .expect("a config carrying a retired key still parses");
        assert!(config.tugtool.dash.build.is_none());
    }

    #[test]
    fn test_default_config() {
        let config = Config::default();
        assert!(config.tugtool.dash.post_create.is_empty());
    }

    #[test]
    fn dash_declarations_parse() {
        let toml = "[tugtool.dash]\npost_create = [\"bun install\"]\nbuild = \"just app-debug\"\n\n[[tugtool.dash.surface]]\nname = \"deck\"\npaths = [\"tugdeck/\"]\ncheck = [\"bunx tsc --noEmit\"]\n";
        let config: Config = toml::from_str(toml).expect("declaring config should parse");
        assert_eq!(config.tugtool.dash.build.as_deref(), Some("just app-debug"));
        let surfaces = &config.tugtool.dash.surfaces;
        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].name, "deck");
        assert_eq!(surfaces[0].paths, vec!["tugdeck/".to_string()]);
        assert_eq!(surfaces[0].check, vec!["bunx tsc --noEmit".to_string()]);
        assert!(surfaces[0].checked_by.is_empty());
        config.tugtool.dash.validate().expect("a legal table loads");
    }

    #[test]
    fn dash_declarations_default_to_none() {
        // A project that declares only hydration leaves the ending undeclared.
        let toml = "[tugtool.dash]\npost_create = [\"echo hi\"]\n";
        let config: Config = toml::from_str(toml).expect("partial config should parse");
        assert!(config.tugtool.dash.surfaces.is_empty());
        assert!(config.tugtool.dash.build.is_none());

        // So does a project with no dash table at all.
        let empty: Config = toml::from_str("").expect("empty config should parse");
        assert!(empty.tugtool.dash.surfaces.is_empty());
        assert!(empty.tugtool.dash.build.is_none());
    }

    #[test]
    fn stage_declarations_parse() {
        let toml = "[tugtool.dash]\ndevise_model = \"sonnet\"\nreview_model = \"opus\"\nimplement_model = \"fable\"\nimplement_compact_tokens = 120000\n";
        let config: Config = toml::from_str(toml).expect("declaring stage models should parse");
        let dash = &config.tugtool.dash;
        assert_eq!(dash.devise_model.as_deref(), Some("sonnet"));
        assert_eq!(dash.review_model.as_deref(), Some("opus"));
        assert_eq!(dash.implement_model.as_deref(), Some("fable"));
        assert_eq!(dash.implement_compact_tokens, Some(120_000));
        assert_eq!(dash.compact_tokens(), 120_000);
    }

    #[test]
    fn stage_declarations_default_to_none_and_the_threshold_to_the_consumer() {
        // Undeclared stays `None` in the parse — that is what lets `dash
        // config` report honestly that the project chose nothing — and the
        // default is applied where the value is used.
        let silent: Config = toml::from_str("[tugtool.dash]\npost_create = []\n").unwrap();
        let dash = &silent.tugtool.dash;
        assert!(dash.devise_model.is_none());
        assert!(dash.review_model.is_none());
        assert!(dash.implement_model.is_none());
        assert!(dash.implement_compact_tokens.is_none());
        assert_eq!(dash.compact_tokens(), IMPLEMENT_COMPACT_TOKENS_DEFAULT);
        assert_eq!(IMPLEMENT_COMPACT_TOKENS_DEFAULT, 300_000);

        // So does a project with no dash table at all.
        let empty: Config = toml::from_str("").unwrap();
        assert_eq!(
            empty.tugtool.dash.compact_tokens(),
            IMPLEMENT_COMPACT_TOKENS_DEFAULT
        );
    }

    #[test]
    fn the_default_config_template_documents_every_stage_key() {
        let config: Config =
            toml::from_str(DEFAULT_CONFIG).expect("the template must be valid TOML");
        // The template documents the keys as comments, so a project starting
        // from it declares none of them.
        assert!(config.tugtool.dash.devise_model.is_none());
        for key in [
            "devise_model",
            "review_model",
            "implement_model",
            "implement_compact_tokens",
        ] {
            assert!(
                DEFAULT_CONFIG.contains(key),
                "the template must document {key}"
            );
        }
    }

    #[test]
    fn test_unknown_keys_are_ignored() {
        // Stale checkouts carry the old validation fields; they must still parse.
        let toml = "[tugtool]\nvalidation_level = \"strict\"\nshow_info = true\n\n[tugtool.dash]\npost_create = [\"echo hi\"]\n";
        let config: Config = toml::from_str(toml).expect("legacy config should still parse");
        assert_eq!(config.tugtool.dash.post_create, vec!["echo hi".to_string()]);
    }

    /// A project that declares nothing has no `.tugtool/`; its git root is
    /// still its root, and its config is the defaults.
    #[test]
    fn a_checkout_without_tugtool_is_a_project_with_default_config() {
        let dir = tempfile::tempdir().expect("temp");
        let root = dir.path().canonicalize().expect("canonical");
        fs::create_dir_all(root.join(".git")).expect(".git");
        fs::create_dir_all(root.join("src/deep")).expect("src");

        let found = find_project_root_from(root.join("src/deep")).expect("a root");
        assert_eq!(found, root);
        let config = Config::load_from_project(&found).expect("defaults");
        assert!(config.tugtool.dash.build.is_none());

        fs::create_dir_all(root.join("src/.tugtool")).expect(".tugtool");
        let found = find_project_root_from(root.join("src/deep")).expect("a root");
        assert_eq!(found, root.join("src"), ".tugtool outranks the checkout");
    }

    #[test]
    fn a_directory_inside_no_checkout_is_uninitialized() {
        let dir = tempfile::tempdir().expect("temp");
        let err = find_project_root_from(dir.path().to_path_buf()).expect_err("no root");
        assert!(matches!(err, TugError::NotInitialized));
    }
}

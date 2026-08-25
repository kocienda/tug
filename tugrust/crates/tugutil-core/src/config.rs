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
    /// Dash settings
    #[serde(default)]
    pub dash: DashConfig,
}

/// Dash configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DashConfig {
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
    /// checking it means. `tugutil dash verify` resolves every path a dash
    /// would land to exactly one of these, refuses when a path resolves to
    /// none, and runs what the matched surfaces declare. An empty table is the
    /// declared-none state, not an error.
    #[serde(default, rename = "surface")]
    pub surfaces: Vec<Surface>,

    /// The command that produces an inspectable instance from the worktree.
    /// Absent means no build is offered.
    #[serde(default)]
    pub build: Option<String>,

    /// The project's dash paperwork directory (briefs + plans), relative to
    /// the project root. Read by plan search and reported by `dash docs-dir` /
    /// `dash config`. Absent means undeclared: search runs on `.tugtool/`
    /// alone, and the authoring skills ask the user once and record the answer
    /// here.
    #[serde(default)]
    pub docs: Option<String>,

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

    /// The context fraction above which the implement stage rotates to a fresh
    /// session at a step boundary. Absent means
    /// [`IMPLEMENT_ROTATE_AT_DEFAULT`], which [`DashConfig::rotate_at`]
    /// applies.
    #[serde(default)]
    pub implement_rotate_at: Option<f32>,
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

/// The context fraction the implement stage rotates above when a project
/// declares none ([P07]).
pub const IMPLEMENT_ROTATE_AT_DEFAULT: f32 = 0.6;

impl DashConfig {
    /// The rotation threshold to actually use: the declaration, or the
    /// default. The default lives at the consumer rather than in the parse so
    /// `dash config` can still report honestly that nothing was declared.
    pub fn rotate_at(&self) -> f32 {
        self.implement_rotate_at
            .unwrap_or(IMPLEMENT_ROTATE_AT_DEFAULT)
    }
}

/// The config file a project starts with: an empty hydration list and a
/// commented example for every optional declaration.
///
/// It lives here rather than beside `tugutil init` because two writers need
/// it — the init verb, and [`set_docs_dir`] seeding a file that does not exist
/// yet. Two templates would be two contracts free to drift.
pub const DEFAULT_CONFIG: &str = r#"[tugtool.dash]
# Commands run from a new dash worktree to hydrate it (deps, etc.).
# A git worktree never inherits gitignored files, so these install what a
# fresh checkout lacks. A non-zero exit rolls the worktree back.
post_create = []
# post_create = ["npm install"]

# The surfaces this project is made of. `tugutil dash verify <dash>` resolves
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

# Where dash paperwork (briefs, plans) lives, relative to the project root.
# Consumed by plan search and by the authoring skills. Declare none and search
# runs on .tugtool/ alone; the skills ask once and record the answer here.
# docs = "dash"

# The models the server-driven arc runs each stage on. Declare none and a stage
# runs on the account default, which the arc's receipt says out loud.
# devise_model = "sonnet"
# review_model = "opus"
# implement_model = "sonnet"

# The context fraction above which the implement stage rotates to a fresh
# session at a step boundary — never mid-step. Declare none and it is 0.6.
# implement_rotate_at = 0.6
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
                 [[tugtool.dash.surface]] entries instead, and run `tugutil dash verify <dash>`"
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

impl DashConfig {
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
            if self.surfaces[..index].iter().any(|s| s.name == surface.name) {
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
                        })
                    }
                    Some(found) if !found.checked_by.is_empty() => {
                        return Err(ConfigRefusal::LenderBorrows {
                            surface: surface.name.clone(),
                            lender: lender.clone(),
                        })
                    }
                    Some(_) => {}
                }
            }
        }

        Ok(())
    }
}/// Why a proposed docs directory was refused. The value is written into a
/// committed config file and then joined onto the project root, so it is
/// checked before it is believed rather than after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocsDirRejection {
    /// An empty or whitespace-only value.
    Empty,
    /// An absolute path. The declaration is project-root-relative, always.
    Absolute,
    /// A path escaping the project root via `..`.
    Escapes,
    /// `.tug` or `.tugtool` — machine and canonical areas, not paperwork homes.
    Reserved,
}

impl std::fmt::Display for DocsDirRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            Self::Empty => "the docs directory cannot be empty",
            Self::Absolute => "the docs directory is relative to the project root, not absolute",
            Self::Escapes => "the docs directory cannot escape the project root",
            Self::Reserved => {
                ".tug and .tugtool are machine areas — paperwork needs its own directory"
            }
        };
        f.write_str(msg)
    }
}

/// Check a proposed docs directory before anything writes or joins it.
///
/// Returns the normalized value (trimmed, trailing slash removed) on success.
pub fn validate_docs_dir(value: &str) -> Result<String, DocsDirRejection> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Err(DocsDirRejection::Empty);
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(DocsDirRejection::Absolute);
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(DocsDirRejection::Escapes);
    }
    if matches!(trimmed, ".tug" | ".tugtool") {
        return Err(DocsDirRejection::Reserved);
    }
    Ok(trimmed.to_string())
}

/// What [`set_docs_dir`] did, so the verb can print a receipt rather than a
/// claim.
#[derive(Debug, Clone)]
pub struct DocsDirWrite {
    /// The config file written.
    pub config_path: PathBuf,
    /// The normalized value recorded.
    pub docs: String,
    /// The absolute directory the declaration names.
    pub path: PathBuf,
    /// True when the directory did not exist and was created.
    pub created_dir: bool,
}

/// Record the docs directory in the project's `.tugtool/config.toml`, creating
/// the directory it names.
///
/// The write goes through `toml_edit` because the file is mostly comments — a
/// serde round-trip would silently delete the documentation the project wrote
/// for itself. A file that does not exist yet is seeded from
/// [`DEFAULT_CONFIG`], so a bare `--set` still leaves a well-commented config.
pub fn set_docs_dir(project_root: &Path, value: &str) -> Result<DocsDirWrite, TugError> {
    let docs = validate_docs_dir(value).map_err(|e| TugError::Config(e.to_string()))?;

    let tugtool_dir = project_root.join(".tugtool");
    let config_path = tugtool_dir.join("config.toml");
    let existing = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|e| TugError::Config(format!("failed to read config file: {}", e)))?
    } else {
        DEFAULT_CONFIG.to_string()
    };

    let mut doc = existing
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| TugError::Config(format!("failed to parse config file: {}", e)))?;
    doc["tugtool"]["dash"]["docs"] = toml_edit::value(docs.as_str());

    fs::create_dir_all(&tugtool_dir).map_err(TugError::Io)?;
    write_atomic(&config_path, &doc.to_string())?;

    let path = project_root.join(&docs);
    let created_dir = !path.exists();
    if created_dir {
        fs::create_dir_all(&path).map_err(TugError::Io)?;
    }

    Ok(DocsDirWrite {
        config_path,
        docs,
        path,
        created_dir,
    })
}

/// Write `contents` over `path` via a sibling temp file and a rename, so a
/// failure never leaves a half-written config behind.
fn write_atomic(path: &Path, contents: &str) -> Result<(), TugError> {
    let dir = path
        .parent()
        .ok_or_else(|| TugError::Config(format!("{} has no parent directory", path.display())))?;
    fs::create_dir_all(dir).map_err(TugError::Io)?;
    let tmp = dir.join(".config.toml.tugtmp");
    fs::write(&tmp, contents).map_err(TugError::Io)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        TugError::Io(e)
    })
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

    /// The project's declared docs directory as an absolute path, when it
    /// declares one and the value is legal.
    pub fn docs_dir(&self, project_root: &Path) -> Option<PathBuf> {
        self.tugtool
            .dash
            .docs
            .as_deref()
            .and_then(|d| validate_docs_dir(d).ok())
            .map(|d| project_root.join(d))
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

/// Reserved file names that are not treated as plan files
pub(crate) const RESERVED_FILES: &[&str] = &["tugplan-implementation-log.md"];

/// Directories searched for plan files, in priority order.
///
/// `.tugtool/` is always first: it marks the project root and holds
/// engine-adjacent plans, so an entry there shadows one of the same name
/// elsewhere. The second entry is whatever the project declared as its
/// paperwork home — there is no blessed name, and a project that declares
/// none is searched in `.tugtool/` alone.
pub(crate) fn plan_search_dirs(project_root: &Path) -> Vec<String> {
    let mut dirs = vec![".tugtool".to_string()];
    if let Some(docs) = Config::load_from_project(project_root)
        .ok()
        .and_then(|c| c.tugtool.dash.docs)
        .and_then(|d| validate_docs_dir(&d).ok())
    {
        if docs != ".tugtool" {
            dirs.push(docs);
        }
    }
    dirs
}

/// Check if a filename is reserved (not a plan file)
pub(crate) fn is_reserved_file(filename: &str) -> bool {
    RESERVED_FILES.contains(&filename)
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
pub(crate) fn find_project_root_from(start: PathBuf) -> Result<PathBuf, TugError> {
    let mut current = start;
    loop {
        let tugtool_dir = current.join(".tugtool");
        if tugtool_dir.is_dir() {
            return Ok(current);
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return Err(TugError::NotInitialized),
        }
    }
}

/// Find all plan files in the project plan directories
///
/// Per [D03], plan files match the configured prefix (e.g. plan-*.md) except reserved files.
/// Searches every directory [`plan_search_dirs`] derives. `.tugtool/` must exist (it
/// defines the project root); the project's declared paperwork directory is scanned
/// only if present.
pub fn find_tugplans(project_root: &Path) -> Result<Vec<PathBuf>, TugError> {
    let search_dirs = plan_search_dirs(project_root);
    let primary_dir = project_root.join(&search_dirs[0]);
    if !primary_dir.is_dir() {
        return Err(TugError::NotInitialized);
    }

    let mut tugplans = Vec::new();
    for search_dir in &search_dirs {
        let dir = project_root.join(search_dir);
        if !dir.is_dir() {
            continue;
        }
        tugplans.extend(find_tugplans_in_dir(&dir)?);
    }

    // Sort by full path for consistent ordering
    tugplans.sort();
    Ok(tugplans)
}

/// Enumerate plan files in a single directory. Returns only files matching
/// `tugplan-*.md` and not in [`RESERVED_FILES`].
fn find_tugplans_in_dir(dir: &Path) -> Result<Vec<PathBuf>, TugError> {
    let mut tugplans = Vec::new();
    let entries = fs::read_dir(dir).map_err(TugError::Io)?;

    for entry in entries {
        let entry = entry.map_err(TugError::Io)?;
        let path = entry.path();
        if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
            if filename.starts_with("tugplan-")
                && filename.ends_with(".md")
                && !is_reserved_file(filename)
            {
                tugplans.push(path);
            }
        }
    }

    Ok(tugplans)
}

/// Extract plan name from filename (remove prefix and extension)
///
/// e.g., "tugplan-1.md" -> "1", "plan-feature-x.md" -> "feature-x"
pub fn tugplan_name_from_path(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .and_then(|filename| {
            if filename.starts_with("tugplan-") && filename.ends_with(".md") {
                let name = &filename[8..filename.len() - 3]; // Remove "tugplan-" and ".md"
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
            None
        })
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
    }    /// This repository's own committed config, through the real loader.
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
    }    #[test]
    fn test_is_reserved_file() {
        assert!(is_reserved_file("tugplan-implementation-log.md"));
        assert!(!is_reserved_file("tugplan-1.md"));
        assert!(!is_reserved_file("tugplan-feature.md"));
    }

    #[test]
    fn test_tugplan_name_from_path() {
        assert_eq!(
            tugplan_name_from_path(Path::new("tugplan-1.md")),
            Some("1".to_string())
        );
        assert_eq!(
            tugplan_name_from_path(Path::new("tugplan-feature-x.md")),
            Some("feature-x".to_string())
        );
        assert_eq!(
            tugplan_name_from_path(Path::new(".tugtool/tugplan-refactor.md")),
            Some("refactor".to_string())
        );
        assert_eq!(tugplan_name_from_path(Path::new("other.md")), None);
        assert_eq!(tugplan_name_from_path(Path::new("tugplan-.md")), None);
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
        let toml = "[tugtool.dash]\ndevise_model = \"sonnet\"\nreview_model = \"opus\"\nimplement_model = \"fable\"\nimplement_rotate_at = 0.75\n";
        let config: Config = toml::from_str(toml).expect("declaring stage models should parse");
        let dash = &config.tugtool.dash;
        assert_eq!(dash.devise_model.as_deref(), Some("sonnet"));
        assert_eq!(dash.review_model.as_deref(), Some("opus"));
        assert_eq!(dash.implement_model.as_deref(), Some("fable"));
        assert_eq!(dash.implement_rotate_at, Some(0.75));
        assert_eq!(dash.rotate_at(), 0.75);
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
        assert!(dash.implement_rotate_at.is_none());
        assert_eq!(dash.rotate_at(), IMPLEMENT_ROTATE_AT_DEFAULT);
        assert_eq!(IMPLEMENT_ROTATE_AT_DEFAULT, 0.6);

        // So does a project with no dash table at all.
        let empty: Config = toml::from_str("").unwrap();
        assert_eq!(empty.tugtool.dash.rotate_at(), IMPLEMENT_ROTATE_AT_DEFAULT);
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
            "implement_rotate_at",
        ] {
            assert!(
                DEFAULT_CONFIG.contains(key),
                "the template must document {key}"
            );
        }
    }

    #[test]
    fn docs_declaration_parses_and_defaults_to_none() {
        let declared: Config = toml::from_str("[tugtool.dash]\ndocs = \"paperwork\"\n")
            .expect("declaring docs should parse");
        assert_eq!(declared.tugtool.dash.docs.as_deref(), Some("paperwork"));

        let silent: Config = toml::from_str("[tugtool.dash]\npost_create = []\n").unwrap();
        assert!(silent.tugtool.dash.docs.is_none());
    }

    #[test]
    fn docs_dir_resolves_against_the_project_root() {
        let root = Path::new("/tmp/project");
        let declared: Config = toml::from_str("[tugtool.dash]\ndocs = \"paperwork\"\n").unwrap();
        assert_eq!(
            declared.docs_dir(root),
            Some(PathBuf::from("/tmp/project/paperwork"))
        );

        // An undeclared project has no docs directory, and an illegal
        // declaration is treated as none rather than joined blindly.
        let silent = Config::default();
        assert_eq!(silent.docs_dir(root), None);
        let escaping: Config = toml::from_str("[tugtool.dash]\ndocs = \"../elsewhere\"\n").unwrap();
        assert_eq!(escaping.docs_dir(root), None);
    }

    #[test]
    fn validate_docs_dir_refuses_what_cannot_be_joined() {
        assert_eq!(validate_docs_dir("dash").unwrap(), "dash");
        assert_eq!(validate_docs_dir("  docs/plans/  ").unwrap(), "docs/plans");

        assert_eq!(validate_docs_dir(""), Err(DocsDirRejection::Empty));
        assert_eq!(validate_docs_dir("."), Err(DocsDirRejection::Empty));
        assert_eq!(validate_docs_dir("/etc"), Err(DocsDirRejection::Absolute));
        assert_eq!(
            validate_docs_dir("../elsewhere"),
            Err(DocsDirRejection::Escapes)
        );
        assert_eq!(validate_docs_dir(".tug"), Err(DocsDirRejection::Reserved));
        assert_eq!(
            validate_docs_dir(".tugtool"),
            Err(DocsDirRejection::Reserved)
        );
    }

    #[test]
    fn set_docs_dir_preserves_comments_and_creates_the_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".tugtool")).unwrap();
        fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\n# hydration, explained at length\npost_create = [\"echo hi\"]\n",
        )
        .unwrap();

        let write = set_docs_dir(root, "paperwork").expect("a legal value should be recorded");
        assert_eq!(write.docs, "paperwork");
        assert!(write.created_dir);
        assert!(root.join("paperwork").is_dir());

        let body = fs::read_to_string(root.join(".tugtool/config.toml")).unwrap();
        assert!(
            body.contains("# hydration, explained at length"),
            "the project's own comments must survive the write: {body}"
        );
        assert!(body.contains("echo hi"));

        let reloaded = Config::load_from_project(root).unwrap();
        assert_eq!(reloaded.tugtool.dash.docs.as_deref(), Some("paperwork"));
        assert_eq!(
            reloaded.tugtool.dash.post_create,
            vec!["echo hi".to_string()]
        );
    }

    #[test]
    fn set_docs_dir_seeds_a_config_that_does_not_exist_yet() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        set_docs_dir(root, "dash").expect("a project with no config should still record");

        let body = fs::read_to_string(root.join(".tugtool/config.toml")).unwrap();
        assert!(body.contains("docs = \"dash\""));
        assert!(
            body.contains("post_create"),
            "the seeded file should carry the standard template: {body}"
        );
    }

    #[test]
    fn set_docs_dir_refuses_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        assert!(set_docs_dir(root, "/absolute").is_err());
        assert!(set_docs_dir(root, "../escape").is_err());
        assert!(set_docs_dir(root, ".tugtool").is_err());
        assert!(
            !root.join(".tugtool/config.toml").exists(),
            "a refused value must leave no config behind"
        );
    }

    #[test]
    fn test_unknown_keys_are_ignored() {
        // Stale checkouts carry the old validation fields; they must still parse.
        let toml = "[tugtool]\nvalidation_level = \"strict\"\nshow_info = true\n\n[tugtool.dash]\npost_create = [\"echo hi\"]\n";
        let config: Config = toml::from_str(toml).expect("legacy config should still parse");
        assert_eq!(config.tugtool.dash.post_create, vec!["echo hi".to_string()]);
    }
}

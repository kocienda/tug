//! Where Claude Code keeps things — the one answer every Tug reader uses.
//!
//! Claude Code keeps its user-scope state under one directory: transcripts in
//! `projects/<encoded-cwd>/`, its live-session registry in `sessions/`,
//! `settings.json`, `skills/`, `agents/`, `CLAUDE.md`. That directory is
//! `$CLAUDE_CONFIG_DIR` when the variable is set and `$HOME/.claude`
//! otherwise, and [`ClaudeHome`] resolves it by exactly that rule, so a
//! `claude` Tug spawns with the variable set writes where Tug reads.
//!
//! Project scope is a different thing: `<cwd>/.claude/settings.json` does not
//! move with the variable, so it is [`project_claude_dir`], not a method.
//!
//! The TypeScript half is `tugcode/src/claude-home.ts`. Both run the cases in
//! `claude_home_cases.json`, which is what keeps the two from drifting, and
//! `no_hand_built_claude_paths` below keeps a hand-built path from coming back.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// The directory name Claude Code uses, under `$HOME` and under a project.
const DIR_NAME: &str = ".claude";

/// Claude Code's user-scope config directory, resolved once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeHome {
    root: PathBuf,
}

impl ClaudeHome {
    /// The directory this process's environment points Claude Code at.
    pub fn from_env() -> Self {
        Self::resolve(
            std::env::var_os("CLAUDE_CONFIG_DIR").as_deref(),
            dirs::home_dir().as_deref(),
        )
    }

    /// A home rooted at `root` — the config directory itself, not `$HOME`.
    /// What a test hands a seam to point it at a temp dir.
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The resolution rule, with its inputs named rather than read.
    ///
    /// An empty `CLAUDE_CONFIG_DIR` counts as unset. With no home either, the
    /// root is `/.claude`: Claude Code cannot run without a home, so nothing
    /// it wrote is there, and a reader pointed at it finds nothing — which is
    /// the true answer.
    pub fn resolve(config_dir: Option<&OsStr>, home: Option<&Path>) -> Self {
        if let Some(dir) = config_dir.filter(|d| !d.is_empty()) {
            return Self::at(dir);
        }
        let home = home
            .filter(|h| !h.as_os_str().is_empty())
            .unwrap_or(Path::new("/"));
        Self::at(home.join(DIR_NAME))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `projects/`, one transcript directory per project.
    pub fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }

    /// `projects/<encoded project>/`. The path is encoded as given: Claude
    /// names the directory after its canonical cwd, so a caller holding a
    /// user-typed spelling resolves it to the Claude form first
    /// (`pathform::resolve_to_claude_form`).
    pub fn project_dir(&self, project: impl AsRef<Path>) -> PathBuf {
        self.projects_dir()
            .join(encode_project_dir(&project.as_ref().to_string_lossy()))
    }

    /// `sessions/`, Claude Code's registry of live sessions.
    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    /// User-scope `settings.json`.
    pub fn settings_path(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.root.join("skills")
    }

    pub fn agents_dir(&self) -> PathBuf {
        self.root.join("agents")
    }

    /// User-scope `CLAUDE.md`.
    pub fn memory_path(&self) -> PathBuf {
        self.root.join("CLAUDE.md")
    }

    /// A project's auto-memory folder, `projects/<encoded project>/memory/`.
    pub fn auto_memory_dir(&self, project: impl AsRef<Path>) -> PathBuf {
        self.project_dir(project).join("memory")
    }
}

/// A project's own `.claude/` — where its `settings.json` and
/// `settings.local.json` live. It does not move with `CLAUDE_CONFIG_DIR`.
pub fn project_claude_dir(cwd: impl AsRef<Path>) -> PathBuf {
    cwd.as_ref().join(DIR_NAME)
}

/// Claude Code's project-directory name for an absolute path: every character
/// outside `[A-Za-z0-9-]` becomes `-`, so `/repo/.tugtree/a__b` is
/// `-repo--tugtree-a--b`.
///
/// Claude Code does this with a JavaScript regex over UTF-16 code units, so a
/// character outside the Basic Multilingual Plane becomes two dashes. The
/// count follows the code units here too, or an emoji in a path would name a
/// directory Claude never made.
pub fn encode_project_dir(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        config_dir: Option<String>,
        home: Option<String>,
        call: String,
        #[serde(default)]
        arg: Option<String>,
        expected: String,
    }

    #[derive(Deserialize)]
    struct Cases {
        cases: Vec<Case>,
    }

    #[test]
    fn shared_cases() {
        let cases: Cases = serde_json::from_str(include_str!("claude_home_cases.json"))
            .expect("claude_home_cases.json parses");
        assert!(!cases.cases.is_empty());
        for case in &cases.cases {
            let home = ClaudeHome::resolve(
                case.config_dir.as_deref().map(OsStr::new),
                case.home.as_deref().map(Path::new),
            );
            let arg = || case.arg.as_deref().expect("case names an arg");
            let got = match case.call.as_str() {
                "root" => home.root().to_string_lossy().into_owned(),
                "projects_dir" => home.projects_dir().to_string_lossy().into_owned(),
                "project_dir" => home.project_dir(arg()).to_string_lossy().into_owned(),
                "sessions_dir" => home.sessions_dir().to_string_lossy().into_owned(),
                "settings_path" => home.settings_path().to_string_lossy().into_owned(),
                "skills_dir" => home.skills_dir().to_string_lossy().into_owned(),
                "agents_dir" => home.agents_dir().to_string_lossy().into_owned(),
                "memory_path" => home.memory_path().to_string_lossy().into_owned(),
                "auto_memory_dir" => home.auto_memory_dir(arg()).to_string_lossy().into_owned(),
                "project_claude_dir" => project_claude_dir(arg()).to_string_lossy().into_owned(),
                "encode_project_dir" => encode_project_dir(arg()),
                other => panic!("case {:?}: unknown call {other:?}", case.name),
            };
            assert_eq!(got, case.expected, "case {:?}", case.name);
        }
    }

    /// The `.claude` path component, written as a string literal anywhere in
    /// production source but here. A hand-built path is how sixteen readers
    /// came to disagree about where Claude Code keeps things, and how they all
    /// came to ignore `CLAUDE_CONFIG_DIR`; this is what keeps the next one
    /// from being added by hand. Comments are skipped — they describe the
    /// default and stay as written.
    #[test]
    fn no_hand_built_claude_paths() {
        let crates_root = crate::source_scan::crates_root();
        let me = crates_root.join("tugcore/src/claude_home.rs");
        let mut offenders = Vec::new();
        for (path, production) in crate::source_scan::production_sources() {
            if path == me {
                continue;
            }
            for (n, line) in production.lines().enumerate() {
                if names_claude_dir(code_part(line)) {
                    offenders.push(format!("{}:{}: {}", path.display(), n + 1, line.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "a hand-built Claude Code path — use tugcore::claude_home::ClaudeHome \
             (or project_claude_dir for a project's own .claude): {offenders:#?}"
        );
    }

    /// The line with any `//` comment removed. A `//` inside a string (a URL)
    /// is kept, by counting the quotes before it.
    fn code_part(line: &str) -> &str {
        let mut search = 0;
        while let Some(rel) = line[search..].find("//") {
            let at = search + rel;
            if line[..at].matches('"').count() % 2 == 0 {
                return &line[..at];
            }
            search = at + 2;
        }
        line
    }

    /// True when `code` holds `.claude` as a whole path component inside a
    /// string — bounded by a quote or a `/` on each side.
    fn names_claude_dir(code: &str) -> bool {
        code.match_indices(DIR_NAME).any(|(at, _)| {
            let before = code[..at].chars().next_back();
            let after = code[at + DIR_NAME.len()..].chars().next();
            matches!(before, Some('"' | '/')) && matches!(after, Some('"' | '/'))
        })
    }

    #[test]
    fn the_ban_sees_the_shapes_it_exists_for() {
        let q = '"';
        assert!(names_claude_dir(&format!("home.join({q}.claude{q})")));
        assert!(names_claude_dir(&format!(
            "home.join({q}.claude/projects{q})"
        )));
        assert!(names_claude_dir(&format!(
            "format!({q}{{h}}/.claude/sessions{q})"
        )));
        assert!(!names_claude_dir(&format!(
            "{q}https://downloads.claude.ai{q}"
        )));
        assert!(!names_claude_dir("entry.claude_session_id"));
        assert!(code_part("let x = 1; // ~/.claude/projects").ends_with("1; "));
        assert_eq!(
            code_part(&format!("{q}https://a/b{q}")),
            format!("{q}https://a/b{q}")
        );
    }
}

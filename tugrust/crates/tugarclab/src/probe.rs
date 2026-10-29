//! Named probes over structured records — never a log grep by timestamp.
//!
//! Each probe reads one record: a `git config` key in the lab repository
//! (the pair's standing crossing, the candidate's base), a line of the arc
//! log, the `rr-cache`, the session's transcript through `tugtool session
//! show --grep`, or the resolve ledger. A probe is spelled as **one shell
//! command that exits 0 when the condition holds**, which is what lets every
//! wait be one `tugtool report wait`: the block shows what is waited on and
//! how long, and a wait that times out names the probe.

use std::path::{Path, PathBuf};

/// One reading, and what it must say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// `git config --get <key>` in the lab repository contains `contains`.
    ConfigKey { key: String, contains: String },
    /// The arc log has a line for `arc` whose marker is `marker`.
    ArcLogMarker { arc: String, marker: String },
    /// The arc log has a line for `arc` containing `contains` anywhere.
    ArcLog { arc: String, contains: String },
    /// The repository's `rr-cache` holds at least `min` recorded resolutions —
    /// counted by `postimage` files, not cache directories. A directory with
    /// only a `preimage` is a conflict the settle has *seen*, not one it has
    /// recorded, and recall needs the recorded answer; counting directories
    /// let the lab land into a half-finished settle. The count matches
    /// `postimage*`, not the bare name alone: git records a second variant of
    /// the same conflict id under a numbered `postimage.N`, so a pair resettled
    /// over a discarded one lands its resolution there, and a `-name postimage`
    /// find would miss it.
    Rerere { min: usize },
    /// The arc's session transcript has a turn containing `grep`.
    Transcript { arc: String, grep: String },
    /// The base branch's recent subjects contain `contains` — what a landing
    /// leaves.
    BaseLog { contains: String },
    /// `tugtool arc status <arc> --json` reads `stage` — `audited` while the
    /// audit's pair still stands on the live tips, `audit-stale` once either
    /// moved. Readiness to join is relative to the audit, so this is the
    /// reading the offer follows.
    Stage { arc: String, stage: String },
    /// `inner` still does not hold after `after_secs` — the negative reading,
    /// for "no conflict turn was injected".
    Absent { inner: Box<Probe>, after_secs: u64 },
}

/// What a probe's shell needs to know about the run.
pub struct ProbeEnv<'a> {
    /// The lab repository's root.
    pub repo: &'a Path,
    /// The arc log the instance's watcher appends to.
    pub arc_log: &'a Path,
    /// The `tugtool` the lab drives.
    pub tugtool: &'a Path,
    /// Each arc's session id, once spawned.
    pub session_of: &'a dyn Fn(&str) -> Option<String>,
}

impl Probe {
    pub fn config_key(key: &str, contains: &str) -> Self {
        Probe::ConfigKey {
            key: key.to_string(),
            contains: contains.to_string(),
        }
    }

    pub fn arc_log_marker(arc: &str, marker: &str) -> Self {
        Probe::ArcLogMarker {
            arc: arc.to_string(),
            marker: marker.to_string(),
        }
    }

    pub fn arc_log(arc: &str, contains: &str) -> Self {
        Probe::ArcLog {
            arc: arc.to_string(),
            contains: contains.to_string(),
        }
    }

    pub fn rerere(min: usize) -> Self {
        Probe::Rerere { min }
    }

    pub fn transcript(arc: &str, grep: &str) -> Self {
        Probe::Transcript {
            arc: arc.to_string(),
            grep: grep.to_string(),
        }
    }

    pub fn base_log(contains: &str) -> Self {
        Probe::BaseLog {
            contains: contains.to_string(),
        }
    }

    pub fn stage(arc: &str, stage: &str) -> Self {
        Probe::Stage {
            arc: arc.to_string(),
            stage: stage.to_string(),
        }
    }

    /// The arc log carries `arc-resume audit` for `arc` — the line that
    /// reopens a finished arc whose audit went stale and seats its audit.
    pub fn reaudit(arc: &str) -> Self {
        Probe::arc_log(arc, "arc-resume  audit")
    }

    pub fn absent(inner: Probe, after_secs: u64) -> Self {
        Probe::Absent {
            inner: Box::new(inner),
            after_secs,
        }
    }

    /// The probe's short name — the wait's label and the timeline's event.
    pub fn label(&self) -> String {
        match self {
            Probe::ConfigKey { key, contains } => format!("config {key} ∋ {contains}"),
            Probe::ArcLogMarker { arc, marker } => format!("arc-log {arc} {marker}"),
            Probe::ArcLog { arc, contains } => format!("arc-log {arc} ∋ {contains}"),
            Probe::Rerere { min } => format!("rr-cache ≥ {min}"),
            Probe::Transcript { arc, grep } => format!("transcript {arc} ∋ {grep}"),
            Probe::BaseLog { contains } => format!("base log ∋ {contains}"),
            Probe::Stage { arc, stage } => format!("stage {arc} = {stage}"),
            Probe::Absent { inner, after_secs } => {
                format!("absent after {after_secs}s: {}", inner.label())
            }
        }
    }

    /// The shell command that exits 0 when the condition holds. `Absent` has
    /// no shell of its own: the executor sleeps its window and runs the inner
    /// probe once, expecting it to fail.
    pub fn shell(&self, env: &ProbeEnv<'_>) -> Result<String, String> {
        Ok(match self {
            Probe::ConfigKey { key, contains } => format!(
                "git -C {repo} config --get {key} | grep -F -q -- {needle}",
                repo = sh(env.repo),
                key = sh_str(key),
                needle = sh_str(contains),
            ),
            Probe::ArcLogMarker { arc, marker } => format!(
                "grep -F -q -- {needle} {log}",
                needle = sh_str(&format!("  {arc}  {marker}  ")),
                log = sh(env.arc_log),
            ),
            Probe::ArcLog { arc, contains } => format!(
                "grep -F -- {arc_field} {log} | grep -F -q -- {needle}",
                arc_field = sh_str(&format!("  {arc}  ")),
                log = sh(env.arc_log),
                needle = sh_str(contains),
            ),
            Probe::Rerere { min } => format!(
                // A recorded resolution is a `postimage`; `--git-path` answers
                // relative to the repo, so the `find` must root at the absolute
                // git dir (`--absolute-git-dir`) or it searches the wrong place.
                "test \"$(find \"$(git -C {repo} rev-parse --absolute-git-dir)/rr-cache\" -name 'postimage*' 2>/dev/null | wc -l | tr -d ' ')\" -ge {min}",
                repo = sh(env.repo),
            ),
            Probe::Transcript { arc, grep } => {
                let session = (env.session_of)(arc)
                    .ok_or_else(|| format!("no session spawned for arc {arc}"))?;
                format!(
                    "{tugtool} session show {session} --grep {needle} --json | grep -F -q -- {needle}",
                    tugtool = sh(env.tugtool),
                    session = sh_str(&session),
                    needle = sh_str(grep),
                )
            }
            Probe::BaseLog { contains } => format!(
                "git -C {repo} log --format=%s -n 20 main | grep -F -q -- {needle}",
                repo = sh(env.repo),
                needle = sh_str(contains),
            ),
            Probe::Stage { arc, stage } => format!(
                "cd {repo} && {tugtool} arc status {arc} --json | grep -F -q -- {needle}",
                repo = sh(env.repo),
                tugtool = sh(env.tugtool),
                arc = sh_str(arc),
                needle = sh_str(&format!("\"stage\": \"{stage}\"")),
            ),
            Probe::Absent { inner, .. } => inner.shell(env)?,
        })
    }
}

/// A path, single-quoted for `sh`.
fn sh(path: &Path) -> String {
    sh_str(&path.to_string_lossy())
}

/// A string, single-quoted for `sh`, with embedded quotes closed around.
fn sh_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The arc log the instance's watcher appends to for `repo` — the shared
/// data root's, not an instance's, so every instance with the project open
/// reads and writes the one file.
pub fn arc_log_path(repo: &Path) -> PathBuf {
    tugtool_core::paths::arc_log_path_at(&tugcore::instance::Paths::from_env(), repo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(session_of: &'a dyn Fn(&str) -> Option<String>) -> ProbeEnv<'a> {
        ProbeEnv {
            repo: Path::new("/tmp/arc-lab/run/repo"),
            arc_log: Path::new("/data/projects/slug/arc.log"),
            tugtool: Path::new("/bin/tugtool"),
            session_of,
        }
    }

    fn no_sessions(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn a_marker_probe_greps_the_exact_field_shape() {
        let p = Probe::arc_log_marker("b", "crossing");
        let shell = p.shell(&env(&no_sessions)).unwrap();
        assert_eq!(
            shell,
            "grep -F -q -- '  b  crossing  ' '/data/projects/slug/arc.log'"
        );
        assert_eq!(p.label(), "arc-log b crossing");
    }

    #[test]
    fn a_config_probe_reads_the_pair_key_through_git() {
        let p = Probe::config_key("tugcrossing.a b.state", "\"conflicts\":[]");
        let shell = p.shell(&env(&no_sessions)).unwrap();
        assert!(
            shell
                .starts_with("git -C '/tmp/arc-lab/run/repo' config --get 'tugcrossing.a b.state'")
        );
        assert!(shell.ends_with("grep -F -q -- '\"conflicts\":[]'"));
    }

    #[test]
    fn a_rerere_probe_resolves_the_cache_against_the_absolute_git_dir() {
        // A recorded resolution is a postimage, and the cache roots at the
        // absolute git dir — `--git-path` would answer relative to the repo
        // and the find would search the probe's own cwd instead.
        let p = Probe::rerere(1);
        let shell = p.shell(&env(&no_sessions)).unwrap();
        assert!(
            shell.contains("rev-parse --absolute-git-dir)/rr-cache\" -name 'postimage*'"),
            "{shell}"
        );
        assert!(!shell.contains("--git-path"), "{shell}");
        assert_eq!(p.label(), "rr-cache ≥ 1");
    }

    #[test]
    fn a_transcript_probe_needs_the_arcs_session() {
        let p = Probe::transcript("a", "[arc-lab]");
        assert_eq!(
            p.shell(&env(&no_sessions)).unwrap_err(),
            "no session spawned for arc a"
        );
        let with = |arc: &str| (arc == "a").then(|| "sess-1".to_string());
        let shell = p.shell(&env(&with)).unwrap();
        assert!(shell.starts_with("'/bin/tugtool' session show 'sess-1' --grep '[arc-lab]'"));
    }

    #[test]
    fn a_quote_in_a_needle_is_closed_around() {
        assert_eq!(sh_str("it's"), "'it'\\''s'");
    }

    #[test]
    fn a_stage_probe_reads_the_quoted_stage_word_from_status() {
        // The quotes are the needle's edges, so `audited` never matches the
        // `audit-stale` that names the same mark gone stale.
        let p = Probe::stage("b", "audited");
        let shell = p.shell(&env(&no_sessions)).unwrap();
        assert_eq!(
            shell,
            "cd '/tmp/arc-lab/run/repo' && '/bin/tugtool' arc status 'b' --json | grep -F -q -- '\"stage\": \"audited\"'"
        );
        assert_eq!(p.label(), "stage b = audited");
        assert_eq!(
            Probe::reaudit("b"),
            Probe::arc_log("b", "arc-resume  audit")
        );
    }

    #[test]
    fn an_absent_probe_wraps_its_inner_shell_and_names_the_window() {
        let p = Probe::absent(Probe::arc_log_marker("b", "crossing"), 15);
        assert_eq!(p.label(), "absent after 15s: arc-log b crossing");
        assert_eq!(
            p.shell(&env(&no_sessions)).unwrap(),
            Probe::arc_log_marker("b", "crossing")
                .shell(&env(&no_sessions))
                .unwrap()
        );
    }
}

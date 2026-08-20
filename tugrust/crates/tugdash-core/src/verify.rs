//! Verification — asking the project whether the joined tree actually works.
//!
//! A textually clean merge is not a working one. `join_in` runs no build and no
//! test, so a semantically broken merge has always been able to join behind a
//! green readiness line. This module is the question that was never asked, in
//! two tiers:
//!
//! - **Tier 0** — the build. Cheap, seconds, and run after every resolver pass,
//!   because a red a machine can repair should cost a machine iteration rather
//!   than the user's attention.
//! - **Tier 1** — the tests. Expensive, and run once against the candidate the
//!   resolver claims is done ([P09]); its runner lives in tugcast, which owns
//!   the scheduling, but it executes through the same [`run_declared`] here.
//!
//! # What runs is the project's business, not this crate's
//!
//! The commands come from `[tugtool.dash].verify_tier0` / `verify_tier1` in the
//! project's `.tugtool/config.toml`, following `post_create`'s precedent
//! exactly. Tug is a general tool: `cargo`, `bunx vite build`, and an app-test
//! selector exist in *this* repository and in no necessary other, so a built-in
//! verifier would be red on every project that is not tugtool — including this
//! feature's own scratch-repo fixtures. **A project that declares no tier is
//! green with a note saying so**: the derivation answering "nothing bears on
//! this" is an answer, not a failure.
//!
//! # The fact is anchored to two commits
//!
//! Verification is a pure function of `(base_sha, candidate_sha)`, so its
//! verdict caches soundly against that pair and self-demotes the moment either
//! moves — the same cacheability split the join board already runs on. It
//! persists in branch config so it survives a restart.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tugutil_core::config::Config;

use crate::ops::{config_get, git_output};
use crate::workshop::Workshop;

/// How much of a failing command's output is kept as the failure sentence.
/// Enough to name the failing file or test; not a whole build log on the wire.
const FAILURE_TAIL_LINES: usize = 12;

/// How often a bounded command is checked for exit. Short enough that a fast
/// command is not padded, long enough that the poll costs nothing.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The wall-clock ceiling on a Tier 1 run.
///
/// Tier 1 drives real app launches behind a machine-wide gate, so "slow" and
/// "wedged" look identical from here. Twenty minutes is past any honest
/// selection and well short of a join the user has given up on.
pub const TIER1_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// The wall-clock ceiling on a Tier 0 run.
///
/// A build tier is cheaper than an exam tier, but it is not bounded by its own
/// nature: a `cargo build` waiting on a package lock, or a bundler on a network
/// fetch, hangs exactly as long as a wedged app-test does. The same twenty
/// minutes applies, for the same reason — past any honest build, short of a
/// join nobody is still watching.
pub const TIER0_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// One tier's standing verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TierStatus {
    /// Never asked for this candidate.
    Unrun,
    /// In flight right now.
    Running,
    /// Every declared command exited zero — or the project declared none.
    Green,
    /// A declared command exited non-zero.
    Red,
}

impl TierStatus {
    /// The stored spelling, matching the wire's.
    pub fn as_str(self) -> &'static str {
        match self {
            TierStatus::Unrun => "unrun",
            TierStatus::Running => "running",
            TierStatus::Green => "green",
            TierStatus::Red => "red",
        }
    }

    /// Read a stored spelling back. An unrecognized one is `Unrun`, never a
    /// panic: an older or newer writer must not be able to break a recompute.
    pub fn parse(s: &str) -> Self {
        match s {
            "running" => TierStatus::Running,
            "green" => TierStatus::Green,
            "red" => TierStatus::Red,
            _ => TierStatus::Unrun,
        }
    }
}

/// A candidate's verification verdict, anchored to the two commits it describes.
#[derive(Debug, Clone, PartialEq)]
pub struct Verification {
    pub base_sha: String,
    pub candidate_sha: String,
    pub tier0: TierStatus,
    /// Durable branch state that **nothing gates on**.
    ///
    /// Tier 1 no longer runs at join time: the dash step checkpoints ran
    /// the tests during the run, and the join-time question is the narrower one
    /// the checkpoints could not have asked — does the *merged* tree build.
    /// The field stays because removing it is a schema change for no gain, and
    /// a non-UI caller may still ask for the tier; no verdict derivation reads
    /// it.
    pub tier1: TierStatus,
    /// The failing commands, as sentences a face can show. Empty on green.
    pub failures: Vec<String>,
    /// What qualifies the verdict — "project declares no verification", the
    /// selector exit that forced a fallback, tests skipped as `@foreground`.
    pub notes: Vec<String>,
}

/// What one tier's run produced.
#[derive(Debug, Clone, PartialEq)]
pub struct TierOutcome {
    pub status: TierStatus,
    pub failures: Vec<String>,
    pub notes: Vec<String>,
}

/// The branch-config key holding a candidate's verdict, in the same family as
/// the candidate ref's own marks — so it dies with the branch.
pub fn verification_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinverified", name)
}

/// Multi-valued companion holding the failure and note sentences.
///
/// The verdict itself is one `<base>:<candidate>:<tier0>:<tier1>` line, which
/// cannot carry prose. Keeping the sentences beside it rather than dropping
/// them is what makes a red survive a restart as a *reason* instead of a bare
/// color — a face that says "red" and cannot say why is the silence [L31]
/// exists to forbid.
fn verification_detail_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinverifydetail", name)
}

/// Persist a candidate's verdict.
pub fn write_verification(repo: &Path, name: &str, v: &Verification) -> Result<(), String> {
    let value = format!(
        "{}:{}:{}:{}",
        v.base_sha,
        v.candidate_sha,
        v.tier0.as_str(),
        v.tier1.as_str()
    );
    let out = git_output(
        repo,
        &["config", "--replace-all", &verification_config_key(name), &value],
    )?;
    if !out.status.success() {
        return Err(format!(
            "failed to record verification for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let detail_key = verification_detail_key(name);
    let _ = git_output(repo, &["config", "--unset-all", &detail_key]);
    for (kind, line) in v
        .failures
        .iter()
        .map(|f| ("failure", f))
        .chain(v.notes.iter().map(|n| ("note", n)))
    {
        // One line per value: a newline inside a config value is legal but
        // unreadable, so the sentence is flattened where it is written.
        let flat = line.replace('\n', " ⏎ ");
        let _ = git_output(
            repo,
            &["config", "--add", &detail_key, &format!("{kind}\t{flat}")],
        );
    }
    Ok(())
}

/// The candidate's standing verdict, if one was ever recorded.
///
/// Says nothing about whether it still applies — that is
/// [`Verification::describes`]'s question, asked by the board on every
/// recompute.
pub fn read_verification(repo: &Path, name: &str) -> Option<Verification> {
    let raw = config_get(repo, &verification_config_key(name))?;
    let parts: Vec<&str> = raw.split(':').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut failures = Vec::new();
    let mut notes = Vec::new();
    if let Ok(out) = git_output(
        repo,
        &["config", "--get-all", &verification_detail_key(name)],
    ) {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                match line.split_once('\t') {
                    Some(("failure", body)) => failures.push(body.to_string()),
                    Some(("note", body)) => notes.push(body.to_string()),
                    _ => {}
                }
            }
        }
    }
    Some(Verification {
        base_sha: parts[0].to_string(),
        candidate_sha: parts[1].to_string(),
        tier0: TierStatus::parse(parts[2]),
        tier1: TierStatus::parse(parts[3]),
        failures,
        notes,
    })
}

/// Where a "join it anyway" decision is kept: the candidate sha it was made
/// about (Spec S02).
///
/// Anchored to the candidate rather than to the dash, because the decision was
/// about **this tree** — the user looked at a red verdict over a specific
/// resolution and said land it. A re-resolve produces a different tree, and a
/// standing override that survived into it would be answering a question
/// nobody asked. `clear_candidate` collects it with the other marks, so the
/// self-demotion is the same one every candidate fact already gets.
pub fn override_config_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinoverride", name)
}

/// Record that the user chose to join `candidate` despite its verdict.
pub fn write_override(repo: &Path, name: &str, candidate: &str) -> Result<(), String> {
    let out = git_output(
        repo,
        &["config", "--replace-all", &override_config_key(name), candidate],
    )?;
    if !out.status.success() {
        return Err(format!(
            "failed to record the join override for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// The candidate a standing override names, if any.
pub fn read_override(repo: &Path, name: &str) -> Option<String> {
    config_get(repo, &override_config_key(name))
}

/// Drop the standing override.
pub fn clear_override(repo: &Path, name: &str) {
    let _ = git_output(repo, &["config", "--unset-all", &override_config_key(name)]);
}

/// Drop a candidate's verdict — on demotion, and with the candidate itself.
pub fn clear_verification(repo: &Path, name: &str) {
    let _ = git_output(
        repo,
        &["config", "--unset-all", &verification_config_key(name)],
    );
    let _ = git_output(
        repo,
        &["config", "--unset-all", &verification_detail_key(name)],
    );
}

/// The branch-config key holding the pilot's last attempt, as
/// `<base_sha>:<dash_head>`.
///
/// The pilot runs off the changeset recompute, which fires again the moment its
/// own run bumps the aggregate. Without a mark, a ladder pass that produces no
/// candidate and writes no stuck line re-qualifies immediately and runs
/// forever. The mark is written *before* the run so a crash mid-pass does not
/// license a retry loop on restart.
pub fn pilot_mark_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinpilot", name)
}

/// The head pair the pilot last acted on, if it ever acted.
pub fn read_pilot_mark(repo: &Path, name: &str) -> Option<String> {
    config_get(repo, &pilot_mark_key(name))
}

/// Record the head pair the pilot is about to act on.
pub fn write_pilot_mark(repo: &Path, name: &str, head_pair: &str) -> Result<(), String> {
    let out = git_output(
        repo,
        &["config", "--replace-all", &pilot_mark_key(name), head_pair],
    )?;
    if !out.status.success() {
        return Err(format!(
            "failed to record the pilot attempt for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// The branch-config key holding a declined decision — `clean` or `red`.
///
/// Deliberately keyed on the **decision** rather than on the head pair that
/// produced it, which is the opposite of [`pilot_mark_key`]. The two marks
/// answer different questions and merging them breaks both: keyed on the pair,
/// a dismissal would expire on any base move and the same question would be
/// asked again on every push to `main`; keyed on the decision, the pilot would
/// never re-run once the base moved. A base move that reconciles to the same
/// decision must re-reconcile *silently* — and only a green going red, or a red
/// going green, is a genuinely new question.
pub fn prompt_mark_key(name: &str) -> String {
    format!("branch.tugdash/{}.tugjoinprompted", name)
}

/// The decision the user last declined, if any.
pub fn read_prompt_mark(repo: &Path, name: &str) -> Option<String> {
    config_get(repo, &prompt_mark_key(name))
}

/// Record that the user declined this decision.
pub fn write_prompt_mark(repo: &Path, name: &str, decision: &str) -> Result<(), String> {
    let out = git_output(
        repo,
        &["config", "--replace-all", &prompt_mark_key(name), decision],
    )?;
    if !out.status.success() {
        return Err(format!(
            "failed to record the declined prompt for {}: {}",
            name,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Drop the declined-decision mark — the user engaged, so the next decision is
/// a fresh question.
pub fn clear_prompt_mark(repo: &Path, name: &str) {
    let _ = git_output(repo, &["config", "--unset-all", &prompt_mark_key(name)]);
}

impl Verification {
    /// Whether this verdict still describes the heads it was recorded against.
    ///
    /// A verdict that outlives either head is not stale data to be tolerated:
    /// it is a green about a tree nobody built.
    pub fn describes(&self, base_sha: &str, candidate_sha: &str) -> bool {
        self.base_sha == base_sha && self.candidate_sha == candidate_sha
    }

    /// Turn every tier this verdict claims is in flight into a red naming
    /// `reason`, and report whether anything moved.
    ///
    /// A runner that dies between writing `running` and writing its answer
    /// leaves a fact describing an activity nobody is performing: the face
    /// renders a permanent wait, and its refusal reaches for a control that
    /// does not exist. A failure sentence is the only honest terminal state a
    /// dead run can leave behind.
    pub fn fail_running(&mut self, reason: &str) -> bool {
        let mut moved = false;
        for tier in [&mut self.tier0, &mut self.tier1] {
            if *tier == TierStatus::Running {
                *tier = TierStatus::Red;
                moved = true;
            }
        }
        if moved {
            self.failures.push(reason.to_string());
        }
        moved
    }
}

/// Run a project's Tier 0 commands against a candidate, in the dash's workshop.
///
/// Returns green-with-note when the project declares nothing — see the module
/// docblock for why that is an answer rather than a gap.
pub fn run_tier0(repo: &Path, name: &str, candidate_sha: &str) -> Result<TierOutcome, String> {
    let config = Config::load_from_project(repo).map_err(|e| e.to_string())?;
    let commands = config.tugtool.dash.verify_tier0.clone();
    if commands.is_empty() {
        return Ok(undeclared());
    }
    let workshop = Workshop::open_candidate(repo, name, candidate_sha)?;
    Ok(run_declared(
        workshop.path(),
        &commands,
        &verify_env(workshop.base_head(), candidate_sha),
        Some(TIER0_TIMEOUT),
    ))
}

/// Run a project's Tier 1 commands against a candidate, in the dash's workshop.
///
/// Three things the build tier does not need:
///
/// - **`TUG_REPO_UNIVERSE` is set to the workshop explicitly**, never trusted
///   from the cwd. Round 1's universe seam is what lets a test corpus run from
///   a checkout that is not the developer's, and a tier that relied on cwd
///   would be one `cd` away from examining the wrong tree.
/// - **`TUG_APPTEST_ASSUME=background`** so a verification cannot seize the
///   user's screen mid-join. It narrows the exam — `@foreground` tests are
///   *skipped*, not passed — which is why the declared command is expected to
///   say so with a [`NOTE_MARKER`] line rather than let a green overstate.
/// - **A hard deadline** ([`TIER1_TIMEOUT`]), because an app-test can park on a
///   dialog or queue on a gate, and a join held open forever renders as nothing
///   at all.
pub fn run_tier1(repo: &Path, name: &str, candidate_sha: &str) -> Result<TierOutcome, String> {
    let config = Config::load_from_project(repo).map_err(|e| e.to_string())?;
    let commands = config.tugtool.dash.verify_tier1.clone();
    if commands.is_empty() {
        return Ok(undeclared());
    }
    let workshop = Workshop::open_candidate(repo, name, candidate_sha)?;
    let mut env = verify_env(workshop.base_head(), candidate_sha);
    env.insert(
        "TUG_REPO_UNIVERSE".to_string(),
        workshop.path().to_string_lossy().into_owned(),
    );
    env.insert("TUG_APPTEST_ASSUME".to_string(), "background".to_string());
    Ok(run_declared(
        workshop.path(),
        &commands,
        &env,
        Some(TIER1_TIMEOUT),
    ))
}

/// The two commits a declared command needs to scope itself.
///
/// A project's tier is rarely "check everything": tugtool's own scopes its
/// `cargo check` and its bundle to the surfaces the candidate actually touched.
/// That scoping needs the head pair, and a command that had to re-derive it
/// would be guessing at what the runner already knows.
pub fn verify_env(base_sha: &str, candidate_sha: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("TUG_VERIFY_BASE_SHA".to_string(), base_sha.to_string()),
        (
            "TUG_VERIFY_CANDIDATE_SHA".to_string(),
            candidate_sha.to_string(),
        ),
    ])
}

/// The verdict for a project that declares no commands for a tier.
pub fn undeclared() -> TierOutcome {
    TierOutcome {
        status: TierStatus::Green,
        failures: Vec::new(),
        notes: vec!["project declares no verification".to_string()],
    }
}

/// The marker a declared command prints on stdout to qualify its own verdict.
///
/// A tier that can only say green or red cannot say *green with exclusions*,
/// and that distinction is load-bearing: a Tier 1 run that skipped every
/// `@foreground` test, or fell back to the core tier because the selector went
/// over budget, has not covered what an unqualified green would claim. The
/// runner cannot know any of that — only the project's own command can — so the
/// command says it, in one line, and the runner carries it to the face.
pub const NOTE_MARKER: &str = "TUG-VERIFY-NOTE:";

/// Run declared commands in `dir`, stopping at the first non-zero exit.
///
/// Stopping is right for a tier: the commands are a sequence (typecheck, then
/// bundle), and running a bundle over a tree that failed to typecheck produces
/// a second failure that says nothing the first did not.
///
/// The environment carries the user's **login** `PATH`, because a GUI-launched
/// tugcast inherits a minimal one and `just`, `bunx`, and `cargo` all live in
/// the login set — a verification that cannot find its own toolchain would
/// report red about the project rather than about itself.
///
/// `timeout` bounds each command. A Tier 1 command drives real app launches and
/// can park on a dialog or a machine-wide gate; without a deadline it would
/// hold the join open forever, which is the one failure mode a face cannot
/// render. Expiry is red with the reason named, never silence.
pub fn run_declared(
    dir: &Path,
    commands: &[String],
    extra_env: &BTreeMap<String, String>,
    timeout: Option<Duration>,
) -> TierOutcome {
    let mut notes = Vec::new();
    for cmd in commands {
        let mut child = Command::new("sh");
        child.arg("-c").arg(cmd).current_dir(dir);
        child.env("PATH", login_path());
        for (k, v) in extra_env {
            child.env(k, v);
        }
        let out = match run_bounded(child, timeout) {
            Ok(o) => o,
            Err(e) => {
                return TierOutcome {
                    status: TierStatus::Red,
                    failures: vec![format!("{cmd}: {e}")],
                    notes,
                };
            }
        };
        notes.extend(harvest_notes(&out.stdout));
        if !out.status.success() {
            return TierOutcome {
                status: TierStatus::Red,
                failures: vec![format!("{cmd}: {}", failure_tail(&out))],
                notes,
            };
        }
    }
    TierOutcome {
        status: TierStatus::Green,
        failures: Vec::new(),
        notes,
    }
}

/// The `TUG-VERIFY-NOTE:` lines a command printed, in order.
fn harvest_notes(stdout: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|l| l.trim().strip_prefix(NOTE_MARKER))
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

/// Run a command with an optional deadline, killing it on expiry.
///
/// Output goes to temp files rather than pipes: polling for the deadline means
/// nothing is draining a pipe meanwhile, and a command that fills the pipe
/// buffer would block forever — a deadlock inside the very mechanism added to
/// prevent one.
fn run_bounded(
    mut cmd: Command,
    timeout: Option<Duration>,
) -> Result<std::process::Output, String> {
    let Some(timeout) = timeout else {
        return cmd.output().map_err(|e| format!("failed to run: {e}"));
    };

    let dir = tempfile::tempdir().map_err(|e| format!("verify tempdir: {e}"))?;
    let out_path = dir.path().join("stdout");
    let err_path = dir.path().join("stderr");
    let out_file = std::fs::File::create(&out_path).map_err(|e| format!("verify stdout: {e}"))?;
    let err_file = std::fs::File::create(&err_path).map_err(|e| format!("verify stderr: {e}"))?;
    // Null stdin, as `Command::output` does on the unbounded branch. A declared
    // command that reads stdin would otherwise inherit tugcast's and block on a
    // terminal nobody is typing into — a hang the deadline would eventually
    // convert to a red, but only after twenty silent minutes.
    cmd.stdout(out_file)
        .stderr(err_file)
        .stdin(std::process::Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("failed to run: {e}"))?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(format!("failed to wait: {e}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("timed out after {}s", timeout.as_secs()));
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    Ok(std::process::Output {
        status,
        stdout: std::fs::read(&out_path).unwrap_or_default(),
        stderr: std::fs::read(&err_path).unwrap_or_default(),
    })
}

/// The tail of a failing command's output — stderr when it said anything,
/// stdout otherwise, since plenty of build tools report failure on stdout.
fn failure_tail(out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let body = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        stderr.into_owned()
    };
    let lines: Vec<&str> = body.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = lines
        .iter()
        .rev()
        .take(FAILURE_TAIL_LINES)
        .rev()
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    if tail.trim().is_empty() {
        format!("exited {}", out.status.code().unwrap_or(-1))
    } else {
        tail
    }
}

/// The user's login `PATH`, probed once per process.
fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(tuggram::probe_login_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Cmd;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Cmd::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn set(dir: &Path, rel: &str, content: &str) {
        if let Some(parent) = Path::new(rel).parent() {
            std::fs::create_dir_all(dir.join(parent)).unwrap();
        }
        std::fs::write(dir.join(rel), content).unwrap();
    }

    /// A repo with a dash whose merge is clean, so a candidate can be built and
    /// verified. `tier0` is written into `.tugtool/config.toml` verbatim.
    fn init(tier0: &[&str]) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        set(repo, ".gitignore", ".tug/\n");
        set(repo, "f.txt", "A\n");
        let declared = tier0
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        set(
            repo,
            ".tugtool/config.toml",
            &format!("[tugtool.dash]\nverify_tier0 = [{declared}]\n"),
        );
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugdash/demo"]);
        git(repo, &["config", "branch.tugdash/demo.tugbase", "main"]);
        git(repo, &["switch", "-q", "tugdash/demo"]);
        set(repo, "merged.txt", "SENTINEL\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "dash round"]);
        git(repo, &["switch", "-q", "main"]);
        temp
    }

    /// Build a candidate from the workshop's clean merge, the way the resolve
    /// flow will: open the merge, commit the tree.
    fn candidate(repo: &Path) -> String {
        let ws = Workshop::open_merge(repo, "demo").unwrap();
        ws.commit("candidate").unwrap()
    }

    /// The fact round-trips through branch config, sentences included.
    #[test]
    fn the_verdict_round_trips_with_its_sentences() {
        let temp = init(&[]);
        let repo = temp.path();
        let v = Verification {
            base_sha: "aaa".to_string(),
            candidate_sha: "bbb".to_string(),
            tier0: TierStatus::Red,
            tier1: TierStatus::Unrun,
            failures: vec!["cargo check: error[E0308]".to_string()],
            notes: vec!["2 tests skipped as @foreground".to_string()],
        };
        write_verification(repo, "demo", &v).unwrap();
        assert_eq!(read_verification(repo, "demo").unwrap(), v);

        clear_verification(repo, "demo");
        assert!(read_verification(repo, "demo").is_none());
    }

    /// A verdict describes exactly one head pair — the demotion the board
    /// applies when either side moves.
    #[test]
    fn a_verdict_describes_only_the_heads_it_was_recorded_against() {
        let v = Verification {
            base_sha: "base1".to_string(),
            candidate_sha: "cand1".to_string(),
            tier0: TierStatus::Green,
            tier1: TierStatus::Green,
            failures: Vec::new(),
            notes: Vec::new(),
        };
        assert!(v.describes("base1", "cand1"));
        assert!(!v.describes("base2", "cand1"));
        assert!(!v.describes("base1", "cand2"));
    }

    /// A project declaring no commands is green **with a note**, never `unrun`
    /// and never red: an unanswerable question is an answer.
    #[test]
    fn a_project_that_declares_nothing_is_green_with_a_note() {
        let temp = init(&[]);
        let repo = temp.path();
        let sha = candidate(repo);

        let outcome = run_tier0(repo, "demo", &sha).unwrap();
        assert_eq!(outcome.status, TierStatus::Green);
        assert!(outcome.failures.is_empty());
        assert_eq!(outcome.notes, vec!["project declares no verification"]);
    }

    /// A declared command runs against the **merged** tree, in the workshop —
    /// the sentinel it greps for exists only on the dash side.
    #[test]
    fn a_declared_command_runs_against_the_joined_tree() {
        let temp = init(&["grep -q SENTINEL merged.txt"]);
        let repo = temp.path();
        let sha = candidate(repo);

        let outcome = run_tier0(repo, "demo", &sha).unwrap();
        assert_eq!(outcome.status, TierStatus::Green, "{outcome:?}");
    }

    /// A broken merged build is red, and the verdict names the command that
    /// failed plus what it said — the sentence the face must be able to show.
    #[test]
    fn a_broken_merged_build_is_red_and_names_the_failing_command() {
        let temp = init(&["grep -q NOT_THERE merged.txt", "true"]);
        let repo = temp.path();
        let sha = candidate(repo);

        let outcome = run_tier0(repo, "demo", &sha).unwrap();
        assert_eq!(outcome.status, TierStatus::Red);
        assert_eq!(outcome.failures.len(), 1);
        assert!(
            outcome.failures[0].starts_with("grep -q NOT_THERE merged.txt:"),
            "{:?}",
            outcome.failures
        );
    }

    /// The sequence stops at the first failure: a bundle run over a tree that
    /// failed to typecheck reports nothing the typecheck did not.
    #[test]
    fn the_command_sequence_stops_at_the_first_failure() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let outcome = run_declared(
            dir,
            &["exit 3".to_string(), "touch second-ran".to_string()],
            &BTreeMap::new(),
            None,
        );
        assert_eq!(outcome.status, TierStatus::Red);
        assert!(!dir.join("second-ran").exists());
    }

    /// Extra environment reaches the command — the seam Tier 1 hands
    /// `TUG_REPO_UNIVERSE` and `TUG_APPTEST_ASSUME` through.
    #[test]
    fn extra_environment_reaches_the_declared_command() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let mut env = BTreeMap::new();
        env.insert("TUG_VERIFY_PROBE".to_string(), "yes".to_string());
        let outcome = run_declared(
            dir,
            &["test \"$TUG_VERIFY_PROBE\" = yes".to_string()],
            &env,
            None,
        );
        assert_eq!(outcome.status, TierStatus::Green);
    }

    /// A command that prints note lines has them carried to the verdict, which
    /// is how a green becomes a green *with exclusions* instead of a claim
    /// nobody checked.
    #[test]
    fn note_lines_ride_the_verdict() {
        let temp = tempfile::tempdir().unwrap();
        let outcome = run_declared(
            temp.path(),
            &[format!(
                "echo '{NOTE_MARKER} 2 tests skipped as @foreground'; echo ordinary output"
            )],
            &BTreeMap::new(),
            None,
        );
        assert_eq!(outcome.status, TierStatus::Green);
        assert_eq!(outcome.notes, vec!["2 tests skipped as @foreground"]);
    }

    /// A command that never exits is red with the deadline named — a join held
    /// open forever is the one failure a face cannot render.
    #[test]
    fn a_command_that_hangs_is_red_with_the_deadline_named() {
        let temp = tempfile::tempdir().unwrap();
        let outcome = run_declared(
            temp.path(),
            &["sleep 30".to_string()],
            &BTreeMap::new(),
            Some(Duration::from_millis(300)),
        );
        assert_eq!(outcome.status, TierStatus::Red);
        assert!(outcome.failures[0].contains("timed out"), "{outcome:?}");
    }

    /// Notes printed before a failure survive it: what the run managed to say
    /// about itself is not erased by how it ended.
    #[test]
    fn notes_printed_before_a_failure_survive_it() {
        let temp = tempfile::tempdir().unwrap();
        let outcome = run_declared(
            temp.path(),
            &[format!(
                "echo '{NOTE_MARKER} core tier forced: selector exit 3'; exit 1"
            )],
            &BTreeMap::new(),
            None,
        );
        assert_eq!(outcome.status, TierStatus::Red);
        assert_eq!(outcome.notes, vec!["core tier forced: selector exit 3"]);
    }

    /// A declared command that reads stdin sees EOF and exits, on both the
    /// bounded and the unbounded branch.
    ///
    /// The bounded branch spawns its own child rather than going through
    /// `Command::output`, which nulls stdin for free — so without an explicit
    /// null it inherits tugcast's. A verification launched from a terminal then
    /// blocks on a prompt nobody is answering, and the only thing that ends it
    /// is the twenty-minute deadline reporting a timeout about the wrong thing.
    #[test]
    fn a_command_that_reads_stdin_exits_on_both_branches() {
        let temp = tempfile::tempdir().unwrap();
        let read_stdin = ["cat > /dev/null".to_string()];

        let unbounded = run_declared(temp.path(), &read_stdin, &BTreeMap::new(), None);
        assert_eq!(unbounded.status, TierStatus::Green, "{unbounded:?}");

        let bounded = run_declared(
            temp.path(),
            &read_stdin,
            &BTreeMap::new(),
            Some(Duration::from_secs(20)),
        );
        assert_eq!(bounded.status, TierStatus::Green, "{bounded:?}");
    }

    /// A verdict left claiming a tier is in flight becomes red naming why.
    ///
    /// The runner writes `running` before it starts and its answer after; every
    /// way out in between used to leave the first write standing forever. A
    /// face reading that shows a wait with no control to press.
    #[test]
    fn a_dead_run_turns_its_running_tiers_red() {
        let mut fact = Verification {
            base_sha: "base".to_string(),
            candidate_sha: "cand".to_string(),
            tier0: TierStatus::Green,
            tier1: TierStatus::Running,
            failures: Vec::new(),
            notes: Vec::new(),
        };
        assert!(fact.fail_running("the workshop went missing"));
        assert_eq!(fact.tier0, TierStatus::Green, "a settled tier is untouched");
        assert_eq!(fact.tier1, TierStatus::Red);
        assert_eq!(fact.failures, vec!["the workshop went missing"]);

        // A verdict with nothing in flight is left exactly as it stands —
        // no phantom failure sentence on an honest red.
        let before = fact.clone();
        assert!(!fact.fail_running("something else"));
        assert_eq!(fact, before);
    }

    /// An unreadable stored value is `None` rather than a panic — an older or
    /// newer writer must not be able to break a recompute.
    #[test]
    fn a_malformed_stored_verdict_reads_as_absent() {
        let temp = init(&[]);
        let repo = temp.path();
        git(
            repo,
            &["config", &verification_config_key("demo"), "nonsense"],
        );
        assert!(read_verification(repo, "demo").is_none());
    }

    /// The pilot's attempt mark round-trips, and a rewrite replaces rather than
    /// appends — `--get` on a multi-valued key errors, which would read as
    /// "never ran" and re-license the loop the mark exists to stop.
    #[test]
    fn the_pilot_mark_round_trips_and_replaces() {
        let temp = init(&[]);
        let repo = temp.path();
        assert!(read_pilot_mark(repo, "demo").is_none(), "absent reads None");

        write_pilot_mark(repo, "demo", "base1:head1").unwrap();
        assert_eq!(read_pilot_mark(repo, "demo").as_deref(), Some("base1:head1"));

        write_pilot_mark(repo, "demo", "base2:head1").unwrap();
        assert_eq!(
            read_pilot_mark(repo, "demo").as_deref(),
            Some("base2:head1"),
            "a rewritten mark replaces the old pair"
        );
    }

    /// The declined-decision mark round-trips and clears.
    #[test]
    fn the_prompt_mark_round_trips_and_clears() {
        let temp = init(&[]);
        let repo = temp.path();
        assert!(read_prompt_mark(repo, "demo").is_none());

        write_prompt_mark(repo, "demo", "clean").unwrap();
        assert_eq!(read_prompt_mark(repo, "demo").as_deref(), Some("clean"));

        write_prompt_mark(repo, "demo", "red").unwrap();
        assert_eq!(read_prompt_mark(repo, "demo").as_deref(), Some("red"));

        clear_prompt_mark(repo, "demo");
        assert!(read_prompt_mark(repo, "demo").is_none());
    }

    /// The two marks live on different keys and cannot shadow one another —
    /// they answer different questions and are keyed deliberately differently.
    #[test]
    fn the_two_marks_are_independent() {
        let temp = init(&[]);
        let repo = temp.path();
        assert_ne!(pilot_mark_key("demo"), prompt_mark_key("demo"));

        write_pilot_mark(repo, "demo", "b:h").unwrap();
        write_prompt_mark(repo, "demo", "clean").unwrap();
        clear_prompt_mark(repo, "demo");

        assert_eq!(
            read_pilot_mark(repo, "demo").as_deref(),
            Some("b:h"),
            "clearing a declined decision does not license a re-run"
        );
    }
}

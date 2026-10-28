//! The lab's executor: one scenario, driven against one running instance.
//!
//! An arc is cut with `tugtool arc create`, seated with a headless session
//! the instance spawns, and bound with `tugtool arc bind --session`. A
//! scripted round is made by the lab in the arc's worktree and committed
//! through `tugtool arc commit`, so the instance's watcher sees the round
//! line a stage's round would leave and does what it does — probe, notice,
//! settle. A modelled act is a `say`: the arc's own session is handed the
//! turn. A landing is `tugtool arc join`. Every expectation is a probe
//! waited on with one `tugtool report wait`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::instance::{SessionApi, Swept};
use crate::probe::{Probe, ProbeEnv, arc_log_path};
use crate::project::{LabProject, run_capturing};
use crate::scenario::{Act, Edit, LabScenario};
use crate::timeline::Timeline;

/// An arc the lab cut: its worktree and the session seated on it.
pub struct ArcSeat {
    pub worktree: PathBuf,
    pub session: String,
}

/// The run: everything an act needs in hand.
pub struct Lab {
    pub api: SessionApi,
    pub project: LabProject,
    pub tugtool: PathBuf,
    /// `arc-lab:<run-id>` — the headless owner, and the key the sweep uses.
    pub owner: String,
    pub run_dir: PathBuf,
    pub wait_secs: u64,
    pub arcs: HashMap<String, ArcSeat>,
    pub timeline: Timeline,
}

impl Lab {
    /// The headless owner for a run.
    pub fn owner_for(run_id: &str) -> String {
        format!("arc-lab:{run_id}")
    }

    fn tugtool(&self, cwd: &Path) -> Command {
        let mut cmd = Command::new(&self.tugtool);
        cmd.current_dir(cwd);
        cmd.stdin(Stdio::null());
        cmd
    }

    /// `tugtool arc create <name> --json`, answering the worktree.
    fn create_arc(&mut self, name: &str) -> Result<PathBuf, String> {
        let mut cmd = self.tugtool(&self.project.root);
        cmd.args(["arc", "create", name, "--json"]);
        let out = run_capturing(&mut cmd)?;
        let value: serde_json::Value =
            serde_json::from_str(&out).map_err(|e| format!("arc create answered non-JSON: {e}"))?;
        value["data"]["worktree"]
            .as_str()
            .map(PathBuf::from)
            .ok_or_else(|| format!("arc create answered with no worktree: {out}"))
    }

    /// `tugtool arc bind <name> --project <root> --session <id> --json`.
    fn bind_arc(&mut self, name: &str, session: &str) -> Result<(), String> {
        let root = self.project.root.to_string_lossy().into_owned();
        let mut cmd = self.tugtool(&self.project.root);
        cmd.args([
            "arc",
            "bind",
            name,
            "--project",
            &root,
            "--session",
            session,
            "--json",
        ]);
        run_capturing(&mut cmd).map(|_| ())
    }

    /// Cut, seat, bind.
    pub fn arc(&mut self, name: &str) -> Result<(), String> {
        let worktree = self.create_arc(name)?;
        self.timeline
            .act("lab", format!("arc {name} cut at {}", worktree.display()));
        let session = self
            .api
            .spawn_headless(&self.owner, &self.project.root, "auto")?;
        self.timeline
            .act("instance", format!("session {session} spawned for {name}"));
        self.wait_for_session(&session)?;
        self.bind_arc(name, &session)?;
        self.timeline
            .act("lab", format!("arc {name} bound to {session}"));
        self.arcs
            .insert(name.to_string(), ArcSeat { worktree, session });
        Ok(())
    }

    fn seat(&self, name: &str) -> Result<&ArcSeat, String> {
        self.arcs
            .get(name)
            .ok_or_else(|| format!("arc {name} was never cut"))
    }

    /// Wait for the instance's ledger to hold the session — the bridge writes
    /// the row when it reports in, seconds after the spawn answers.
    fn wait_for_session(&mut self, session: &str) -> Result<(), String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(self.wait_secs);
        loop {
            if self.api.knows(session)? {
                self.timeline
                    .act("instance", format!("session {session} reported in"));
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "session {session} never reported in within {}s",
                    self.wait_secs
                ));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// A scripted round: the edits in the worktree, then `tugtool arc commit`.
    pub fn round(
        &mut self,
        name: &str,
        subject: &str,
        edits: &[(&str, Edit)],
    ) -> Result<(), String> {
        let worktree = self.seat(name)?.worktree.clone();
        for (path, edit) in edits {
            let full = worktree.join(path);
            match edit {
                Edit::Write(body) => std::fs::write(&full, body)
                    .map_err(|e| format!("writing {}: {e}", full.display()))?,
                Edit::WriteBytes(bytes) => std::fs::write(&full, bytes)
                    .map_err(|e| format!("writing {}: {e}", full.display()))?,
                Edit::Delete => {
                    crate::project::git(&worktree, &["rm", "-q", path])?;
                }
                Edit::Rename(to) => {
                    crate::project::git(&worktree, &["mv", path, to])?;
                }
                Edit::Executable => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&full, std::fs::Permissions::from_mode(0o755))
                            .map_err(|e| format!("chmod {}: {e}", full.display()))?;
                    }
                }
            }
        }
        crate::project::git(&worktree, &["add", "-A"])?;
        let metadata = serde_json::json!({
            "instruction": subject,
            "summary": format!("scripted by the arc lab: {subject}"),
        });
        let mut cmd = self.tugtool(&worktree);
        cmd.args(["arc", "commit", name, "--message", subject, "--json"]);
        cmd.stdin(Stdio::piped());
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawning tugtool arc commit: {e}"))?;
        {
            use std::io::Write as _;
            let mut stdin = child.stdin.take().expect("piped stdin");
            stdin
                .write_all(metadata.to_string().as_bytes())
                .map_err(|e| format!("writing round metadata: {e}"))?;
        }
        let out = child
            .wait_with_output()
            .map_err(|e| format!("waiting on tugtool arc commit: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "tugtool arc commit {name} failed ({}): {}{}",
                out.status,
                String::from_utf8_lossy(&out.stdout).trim(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
        let sha = value["data"]["commit_hash"]
            .as_str()
            .unwrap_or("-")
            .to_string();
        self.timeline.act(name, format!("round {sha}: {subject}"));
        Ok(())
    }

    /// Hand the arc's session a turn.
    pub fn say(&mut self, name: &str, text: &str) -> Result<(), String> {
        let session = self.seat(name)?.session.clone();
        self.api.say(&session, text)?;
        self.timeline.act("lab", format!("say {name}: {text}"));
        Ok(())
    }

    /// Land the arc on its base.
    pub fn land(&mut self, name: &str) -> Result<(), String> {
        self.seat(name)?;
        let mut cmd = self.tugtool(&self.project.root);
        cmd.args([
            "arc",
            "join",
            name,
            "--message",
            &format!("lab lands {name}"),
            "--json",
        ]);
        let out = run_capturing(&mut cmd)?;
        let value: serde_json::Value = serde_json::from_str(&out).unwrap_or_default();
        let sha = value["data"]["commit_hash"]
            .as_str()
            .or_else(|| value["data"]["landed"].as_str())
            .unwrap_or("-")
            .to_string();
        self.timeline.act(name, format!("landed {sha}"));
        Ok(())
    }

    /// Discard the arc: `tugtool arc discard --break-lease`, deleting its
    /// worktree and branch without merging, and drop it from the run's seats
    /// so a later act may cut an arc of the same name afresh. `--break-lease`
    /// lets the discard proceed even while a settle holds the pair's lease.
    pub fn discard(&mut self, name: &str) -> Result<(), String> {
        self.seat(name)?;
        let mut cmd = self.tugtool(&self.project.root);
        cmd.args(["arc", "discard", name, "--break-lease", "--json"]);
        run_capturing(&mut cmd)?;
        self.arcs.remove(name);
        self.timeline.act(name, "discarded".to_string());
        Ok(())
    }

    fn probe_shell(&self, probe: &Probe) -> Result<String, String> {
        let arc_log = arc_log_path(&self.project.root);
        let session_of = |arc: &str| self.arcs.get(arc).map(|s| s.session.clone());
        probe.shell(&ProbeEnv {
            repo: &self.project.root,
            arc_log: &arc_log,
            tugtool: &self.tugtool,
            session_of: &session_of,
        })
    }

    /// Wait on a probe with one `tugtool report wait`; record the verdict.
    pub fn expect(&mut self, probe: &Probe) -> Result<bool, String> {
        let label = probe.label();
        let shell = self.probe_shell(probe)?;
        let held = match probe {
            Probe::Absent { after_secs, .. } => {
                std::thread::sleep(Duration::from_secs(*after_secs));
                !Command::new("sh")
                    .args(["-c", &shell])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map_err(|e| format!("running probe: {e}"))?
                    .success()
            }
            _ => {
                let mut cmd = Command::new(&self.tugtool);
                cmd.args([
                    "report",
                    "wait",
                    "--label",
                    &label,
                    "--until",
                    &shell,
                    "--every",
                    "1",
                    "--for",
                    &self.wait_secs.to_string(),
                ]);
                cmd.stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                cmd.status()
                    .map_err(|e| format!("running tugtool report wait: {e}"))?
                    .success()
            }
        };
        self.timeline.verdict("probe", label, held);
        Ok(held)
    }

    /// Walk the scenario's acts in order. An act that cannot be performed
    /// ends the walk as a red; a probe that misses is a red and the walk goes
    /// on, so one run reports every expectation it could reach.
    pub fn run(&mut self, scenario: &LabScenario) -> Result<(), String> {
        for act in &scenario.acts {
            match act {
                Act::Arc(name) => self.arc(name)?,
                Act::Round {
                    arc,
                    subject,
                    edits,
                } => self.round(arc, subject, edits)?,
                Act::Say { arc, text } => self.say(arc, text)?,
                Act::Land(arc) => self.land(arc)?,
                Act::Discard(arc) => self.discard(arc)?,
                Act::Expect(probe) => {
                    self.expect(probe)?;
                }
            }
        }
        Ok(())
    }

    /// Trash every session this run spawned, unless the run is kept.
    pub fn cleanup(&mut self, keep: bool) -> Result<Option<Swept>, String> {
        if keep {
            self.timeline.act(
                "lab",
                format!("kept: sessions under {} stay in the ledger", self.owner),
            );
            return Ok(None);
        }
        let swept = self.api.trash_headless(&self.owner)?;
        self.timeline.act(
            "instance",
            format!(
                "trashed {} session(s); kept {}",
                swept.trashed.len(),
                swept.kept.len()
            ),
        );
        for (id, reason) in &swept.kept {
            self.timeline
                .act("instance", format!("kept {id}: {reason}"));
        }
        Ok(Some(swept))
    }

    /// Write the timeline under the run directory and answer its path.
    pub fn write_timeline(&self) -> Result<PathBuf, String> {
        let path = self.run_dir.join("timeline.txt");
        std::fs::write(&path, self.timeline.render())
            .map_err(|e| format!("writing {}: {e}", path.display()))?;
        Ok(path)
    }
}

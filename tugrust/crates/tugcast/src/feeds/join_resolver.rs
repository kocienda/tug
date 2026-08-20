//! The resolver: the agent that finishes a join ([P02], Specs S01/S02/S04).
//!
//! The resolution ladder ([`tugdash_core::resolve`]) works a conflict three
//! blobs at a time and stops where blob arithmetic stops. The resolver picks up
//! there, in the workshop ([`tugdash_core::workshop`]) where the merge is a
//! real tree: it finishes what the rungs left, **audits what the rungs
//! decided** ([P10]), asks at most one intent question when the two sides
//! genuinely disagree, and ends with a report that accounts for every path in
//! the candidate's resolution set.
//!
//! Three seams live here and nothing else does — the orchestration that drives
//! them is the agent supervisor's:
//!
//! - [`JoinResolverSpawner`], the substrate seam. Production spawns a
//!   multi-turn headless `claude` under the Spec S04 turn protocol; tests
//!   configure a command in `tugdash.joinresolver` speaking the same two
//!   terminal shapes over plain stdio, exactly as the merge-driver rung already
//!   takes a `tugdash.mergedriver` stub one rung down.
//! - [`compose_charter`], the instruction contract (Spec S01). It is a `const`
//!   body plus derived facts; no caller-supplied prose is ever appended, which
//!   is [D127]'s discipline carried over intact.
//! - [`parse_turn`] and [`validate_report`], the output contract (Spec S02).
//!   A turn that is not one of the two defined shapes is a protocol violation,
//!   never a guess; a report that omits a resolved path fails the same way a
//!   marker-bearing file does, because silence about a file the machines
//!   resolved is exactly the failure [P10] exists to catch.
//!
//! **Why multi-turn.** The scribe's one-shot `claude -p` cannot ask and wait —
//! it answers once and dies. A resolver that must escalate mid-run needs a
//! spawn that stays alive across the question, which is the shape
//! [`crate::shared_agent`]'s worker already runs; its `drive_worker` is the
//! working reference this module copies rather than reinvents.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tugdash_core::ResolvedBy;

/// The tools the resolver may use: read the tree, edit the tree. **No Bash** —
/// verification is the orchestrator's job ([P05]), and a resolver that could
/// run commands could also run git and move refs, which its charter forbids in
/// prose and this list forbids in fact.
const RESOLVER_TOOLS: &str = "Read,Edit,MultiEdit,Write,Glob,Grep";

/// How many options an ask may carry — the `AskUserQuestion` shape the join
/// face renders it with.
const ASK_OPTIONS: std::ops::RangeInclusive<usize> = 2..=4;

// ---------------------------------------------------------------------------
// The two terminal turn shapes (Spec S04)
// ---------------------------------------------------------------------------

/// One option on an escalation question — a concrete resolution, never a diff.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolverOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

/// The resolver's ask: what each side was trying to do, and 2–4 ways to settle
/// it. Raised to the user as a question frame ([P06]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolverAsk {
    pub question: String,
    pub options: Vec<ResolverOption>,
}

/// The resolver's terminal report (Spec S02) — **the wire type itself**, not a
/// parallel one. The report the resolver writes is the report the face renders;
/// a second shape here would be a translation layer whose only product is
/// drift.
pub use tugcast_core::types::DashJoinReport as ResolverReport;

/// What a resolver turn may terminate as. There is no third shape: prose, a
/// fenced block, and a half-object are all protocol violations.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolverTurn {
    Ask(ResolverAsk),
    Report(ResolverReport),
}

/// Parse one terminal turn's whole text as Spec S04 defines it.
///
/// The whole trimmed text must be one JSON object — which is what rejects a
/// fenced block and a prose preamble without a special case for either — and
/// the object must be one of the two defined shapes. The error text quotes a
/// bounded tail so a `stuck` report can say what arrived instead of a guess.
pub fn parse_turn(text: &str) -> Result<ResolverTurn, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("the resolver ended a turn with nothing".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|_| {
        format!(
            "the resolver's turn was not one JSON object: {}",
            tail(trimmed)
        )
    })?;
    let Some(obj) = value.as_object() else {
        return Err(format!(
            "the resolver's turn was not one JSON object: {}",
            tail(trimmed)
        ));
    };

    if let Some(ask) = obj.get("ask") {
        let ask: ResolverAsk = serde_json::from_value(ask.clone())
            .map_err(|e| format!("the resolver's question did not parse: {e}"))?;
        if ask.question.trim().is_empty() {
            return Err("the resolver asked with no question".to_string());
        }
        if !ASK_OPTIONS.contains(&ask.options.len()) {
            return Err(format!(
                "the resolver's question carried {} options; 2 to 4 are allowed",
                ask.options.len()
            ));
        }
        return Ok(ResolverTurn::Ask(ask));
    }

    if obj.contains_key("files") {
        let report: ResolverReport = serde_json::from_value(value)
            .map_err(|e| format!("the resolver's report did not parse: {e}"))?;
        return Ok(ResolverTurn::Report(report));
    }

    Err(format!(
        "the resolver's turn was neither a question nor a report: {}",
        tail(trimmed)
    ))
}

/// Every path the candidate's resolution set holds must be accounted for
/// ([P10]) — the ones the resolver finished and the ones it audited and kept.
///
/// This is the whole weight the retired human review gate used to carry. A
/// rerere replay that keeps one side wholesale and discards the other builds
/// green and tests green (the 2026-08-15 incident); the only thing that catches
/// it is somebody reading the resolution against the intent. The resolver is
/// that reader now, and a report that skips a file is a reader who did not
/// look.
pub fn validate_report(
    report: &ResolverReport,
    resolution_set: &[String],
    resolver_touched: &[String],
) -> Result<(), String> {
    let accounted: std::collections::BTreeSet<&str> =
        report.files.iter().map(|f| f.path.as_str()).collect();
    let missing = |set: &[String]| -> Vec<String> {
        set.iter()
            .filter(|p| !accounted.contains(p.as_str()))
            .cloned()
            .collect()
    };

    // The machine's decisions come first: they are what the retired review gate
    // covered, and a report that skips one is the 2026-08-15 failure class.
    let unaudited = missing(resolution_set);
    if !unaudited.is_empty() {
        return Err(format!(
            "the resolver's report does not account for {}",
            unaudited.join(", ")
        ));
    }

    // Then what the resolver did on its own initiative. A path here is one the
    // machine never decided and the resolver changed anyway — the report has to
    // say why.
    let unexplained: Vec<String> = missing(resolver_touched)
        .into_iter()
        .filter(|p| !resolution_set.contains(p))
        .collect();
    if !unexplained.is_empty() {
        return Err(format!(
            "the resolver changed {} without accounting for it",
            unexplained.join(", ")
        ));
    }
    Ok(())
}

/// A bounded tail of whatever arrived, for a refusal that quotes rather than
/// guesses.
fn tail(text: &str) -> String {
    const CAP: usize = 240;
    if text.len() <= CAP {
        return text.to_string();
    }
    let mut cut = text.len() - CAP;
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…{}", &text[cut..])
}

// ---------------------------------------------------------------------------
// The charter (Spec S01)
// ---------------------------------------------------------------------------

/// The fixed half of the charter: the job, the duties, the boundary, and the
/// output contract. Reviewed like a contract ([D127]) — the derived facts below
/// are appended to it, and nothing else ever is.
pub const RESOLVER_CHARTER: &str = r#"You are finishing a merge.

A dash branch and its base branch have diverged, and an algorithmic ladder has
already done what blob arithmetic can do. You are working in a real checkout of
that merge — the whole project is around you, with conflict markers in the files
the ladder could not settle. Your job is to make the merged tree one in which
*both* sides' intents hold.

# What you must do

1. **Finish the unresolved files.** Every conflict marker must be gone, and the
   result must serve what each side was trying to do — not one side picked
   wholesale because it was easier to read.

2. **Audit the files the machines already resolved.** Each one is listed below
   with the rung that decided it. A replayed `rerere` resolution can keep one
   side entirely and discard the other while still building and passing every
   test; a structured-merge driver can drop a hunk it did not understand. Read
   each resolution against the stated intent. If it does not serve both sides,
   redo it. This audit is not optional and it is not conditional on there being
   unresolved files left.

3. **Ask when the intents genuinely conflict.** If the two sides want
   incompatible things and no reconciliation serves both, ask — once — and phrase
   the question as *what each side was trying to do*, with 2 to 4 concrete
   resolutions as options. Never show a diff as a question. Never guess your way
   past a true conflict of intent.

# Your boundary

- Edit only files inside this checkout. Never touch anything outside it.
- Never run git commands, and never move a ref. The merge is committed for you.
- You have no shell. Verification is run for you after each pass, and its
  failures come back to you as another turn.

# How you answer

Every turn you end must be **one JSON object and nothing else** — no prose
around it, no code fence, no explanation before or after.

To ask, end a turn with exactly:

    {"ask": {"question": "…", "options": [{"label": "…", "description": "…"}]}}

with 2 to 4 options. You may ask at most once.

To finish, end a turn with your report:

    {"files": [{"path": "…", "resolved_by": "…", "what_each_side_did": "…",
                "reconciliation": "…", "audit": "kept"}],
     "iterations": [{"tier0": "green"}],
     "notes": "…"}

**Every path listed below — the ones you finished and the ones you audited —
must appear in `files`.** A report that omits one is rejected. Use `"audit":
"kept"` for a machine resolution you reviewed and accepted, `"audit": "redone"`
for one you replaced."#;

/// The turn an answered escalation comes back as — the user's words, verbatim.
///
/// Verbatim is the point: the answer may be an option label or free text the
/// user typed, and paraphrasing either would be the orchestrator deciding what
/// the user meant.
pub fn compose_answer_turn(answer: &str) -> String {
    format!(
        "The answer to your question is:\n\n{}\n\nCarry on and answer with your report.",
        answer.trim()
    )
}

/// The case-specific facts appended to the charter.
pub struct CharterInputs<'a> {
    /// The intent corpus ([P08]) — draft, round subjects, plan, base motion,
    /// both sides' touched files.
    pub intent: &'a str,
    /// The base branch the dash is joining into.
    pub base_branch: &'a str,
    /// Files the ladder left with markers in them.
    pub unresolved: &'a [String],
    /// Files an algorithmic rung resolved, and which rung decided each — the
    /// audit list ([P10]).
    pub rung_resolved: &'a [(String, ResolvedBy)],
}

/// Compose the charter for one resolve: the fixed contract, then the facts.
pub fn compose_charter(inputs: &CharterInputs) -> String {
    let mut out = String::from(RESOLVER_CHARTER);

    out.push_str("\n\n# What this dash is for\n\n");
    if inputs.intent.trim().is_empty() {
        out.push_str("(the dash recorded no intent beyond its commits)\n");
    } else {
        out.push_str(inputs.intent.trim());
        out.push('\n');
    }
    out.push_str(&format!(
        "\nIt is being joined into `{}`.\n",
        inputs.base_branch
    ));

    out.push_str("\n# Files left unresolved (finish these)\n\n");
    if inputs.unresolved.is_empty() {
        out.push_str("(none — the ladder resolved every conflict)\n");
    } else {
        for path in inputs.unresolved {
            out.push_str(&format!("- `{}`\n", path));
        }
    }

    out.push_str("\n# Files the machines resolved (audit these)\n\n");
    if inputs.rung_resolved.is_empty() {
        out.push_str("(none)\n");
    } else {
        for (path, rung) in inputs.rung_resolved {
            out.push_str(&format!(
                "- `{}` — resolved by the {} rung\n",
                path,
                rung.as_str()
            ));
        }
    }

    out.push_str("\nAccount for every file named above in your report.\n");
    out
}

/// The turn a Tier 0 failure comes back as ([P05]) — the same charter-defined
/// message kind whether the spawn is still live or was re-charted, so the
/// resolver cannot tell the difference and the orchestrator need not care.
pub fn compose_tier0_failure_turn(failures: &[String]) -> String {
    let mut out = String::from(
        "Verification failed on the tree you produced. Fix it and answer with your report.\n\n",
    );
    if failures.is_empty() {
        out.push_str("(the failure produced no detail)\n");
    } else {
        for failure in failures {
            out.push_str(failure.trim_end());
            out.push_str("\n\n");
        }
    }
    out
}

// ---------------------------------------------------------------------------
// The substrate seam ([P02], Spec S04)
// ---------------------------------------------------------------------------

/// One turn of a resolver conversation: a user message in, that turn's terminal
/// shape out.
pub struct ResolverTurnRequest {
    pub message: String,
    pub reply: oneshot::Sender<Result<ResolverTurn, String>>,
}

/// What runs a resolver. Production spawns `claude`; tests configure a command.
///
/// The channel shape is [`crate::shared_agent::AgentWorkerSpawner`]'s, and for
/// its reason: one stdio pipe means turns are answered strictly in order, which
/// makes "one turn at a time" true by construction rather than by a lock.
/// Dropping the sender ends the spawn.
pub trait JoinResolverSpawner: Send + Sync + 'static {
    fn spawn(
        &self,
        workshop: &Path,
        model: String,
    ) -> Result<mpsc::Sender<ResolverTurnRequest>, String>;
}

/// One resolver conversation, and the charter rule that holds across its turns.
pub struct ResolverRun {
    tx: mpsc::Sender<ResolverTurnRequest>,
    asked: bool,
}

impl ResolverRun {
    /// Start a resolver over a workshop. The spawn is live but silent until the
    /// first [`ResolverRun::send`] — which the orchestrator makes with the
    /// charter.
    pub fn open(
        spawner: &dyn JoinResolverSpawner,
        workshop: &Path,
        model: String,
    ) -> Result<Self, String> {
        Ok(Self {
            tx: spawner.spawn(workshop, model)?,
            asked: false,
        })
    }

    /// Send one user message and read the turn it terminates with.
    ///
    /// A second ask in one resolve is a charter violation, refused here rather
    /// than in the orchestrator: the rule is the charter's, so it is enforced
    /// where the charter is.
    pub async fn send(&mut self, message: String) -> Result<ResolverTurn, String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(ResolverTurnRequest { message, reply })
            .await
            .map_err(|_| "the resolver exited".to_string())?;
        let turn = rx.await.map_err(|_| "the resolver exited".to_string())??;
        if let ResolverTurn::Ask(_) = &turn {
            if self.asked {
                return Err("the resolver asked twice in one resolve".to_string());
            }
            self.asked = true;
        }
        Ok(turn)
    }
}

/// Which spawner runs this repo's resolver: the `tugdash.joinresolver` stub
/// when one is configured, else the production spawn the build supplied.
///
/// **The production spawn is injected, never defaulted to.** A seam that falls
/// back to spawning `claude` would mean every test that reaches this line runs a
/// live model — which is not a hypothetical: the first version of this function
/// did exactly that, and a supervisor test spent forty seconds having a real
/// model answer a fixture's merge conflict. A build with no resolver wired
/// refuses in a sentence instead, which is also the right answer for a host that
/// genuinely has none.
pub fn spawner_for(
    repo: &Path,
    production: Option<Arc<dyn JoinResolverSpawner>>,
) -> Result<Arc<dyn JoinResolverSpawner>, String> {
    if let Some(command) = tugdash_core::resolver_program(repo) {
        return Ok(Arc::new(StubJoinResolverSpawner {
            command,
            turn_timeout: RESOLVER_TURN_TIMEOUT,
        }));
    }
    production.ok_or_else(|| "no join resolver is configured for this host".to_string())
}

/// The production spawn (Spec S04): a persistent streaming-input `claude` in
/// the workshop, with tools enough to read and edit and nothing else.
pub struct ClaudeJoinResolverSpawner;

impl JoinResolverSpawner for ClaudeJoinResolverSpawner {
    fn spawn(
        &self,
        workshop: &Path,
        model: String,
    ) -> Result<mpsc::Sender<ResolverTurnRequest>, String> {
        // `claude_command` rather than `Command::new("claude")`: it is what
        // supplies the resolved binary and the auth environment a GUI-launched
        // tugcast does not inherit. `--verbose` is mandatory alongside
        // `--output-format stream-json` under `-p`; `--strict-mcp-config` with
        // no `--mcp-config` leaves the resolver no project-scoped MCP servers,
        // which is strictly outside its charter.
        let mut cmd = crate::feeds::claude_auth::claude_command(&[
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            &model,
            "--strict-mcp-config",
            "--permission-mode",
            "acceptEdits",
            "--allowedTools",
            RESOLVER_TOOLS,
        ]);
        cmd.current_dir(workshop)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Claude Code isn't installed".to_string()
            } else {
                e.to_string()
            }
        })?;
        let stdin = child.stdin.take().ok_or("join resolver: no stdin")?;
        let stdout = child.stdout.take().ok_or("join resolver: no stdout")?;

        let (tx, rx) = mpsc::channel::<ResolverTurnRequest>(4);
        tokio::spawn(drive_claude(child, stdin, stdout, rx));
        Ok(tx)
    }
}

/// One production resolver's whole life: write each turn as a user message,
/// read stdout to that turn's `result` frame, parse it as one of the two
/// terminal shapes.
async fn drive_claude(
    mut child: tokio::process::Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    mut rx: mpsc::Receiver<ResolverTurnRequest>,
) {
    let mut lines = BufReader::new(stdout).lines();

    while let Some(ResolverTurnRequest { message, reply }) = rx.recv().await {
        let frame = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": message }] },
        });
        let line = serde_json::to_string(&frame).expect("resolver turn serializes");
        if stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .is_err()
            || stdin.flush().await.is_err()
        {
            let _ = child.start_kill();
            let _ = reply.send(Err("the resolver exited".to_string()));
            return;
        }

        let answer = loop {
            let read = match tokio::time::timeout(RESOLVER_TURN_TIMEOUT, lines.next_line()).await {
                Ok(read) => read,
                Err(_) => {
                    let _ = child.start_kill();
                    let _ = reply.send(Err(silent_turn(RESOLVER_TURN_TIMEOUT)));
                    return;
                }
            };
            match read {
                Ok(Some(out)) => {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&out) else {
                        continue;
                    };
                    if value.get("type").and_then(|t| t.as_str()) != Some("result") {
                        continue;
                    }
                    if value.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
                        break Err(value
                            .get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("the resolver's turn failed")
                            .to_string());
                    }
                    break parse_turn(value.get("result").and_then(|r| r.as_str()).unwrap_or(""));
                }
                _ => {
                    let _ = child.start_kill();
                    let _ = reply.send(Err("the resolver exited".to_string()));
                    return;
                }
            }
        };
        let _ = reply.send(answer);
    }
}

/// The stub spawn: the configured command, with the workshop path as `$1`.
///
/// It speaks the same two terminal shapes over plain stdio — one JSON line per
/// user message in, one JSON line per terminal turn out — so the orchestrator's
/// parse-and-wait path is byte-for-byte the one production takes. Only the
/// transport differs.
pub struct StubJoinResolverSpawner {
    pub command: String,
    /// The silence bound for one turn. Production reads
    /// [`RESOLVER_TURN_TIMEOUT`]; a test that drives the bound itself sets it
    /// to something it can wait out.
    pub turn_timeout: Duration,
}

impl JoinResolverSpawner for StubJoinResolverSpawner {
    fn spawn(
        &self,
        workshop: &Path,
        _model: String,
    ) -> Result<mpsc::Sender<ResolverTurnRequest>, String> {
        let mut parts = self.command.split_whitespace();
        let bin = parts.next().ok_or("tugdash.joinresolver is empty")?;
        let mut cmd = tokio::process::Command::new(bin);
        for arg in parts {
            cmd.arg(arg);
        }
        cmd.arg(workshop)
            .current_dir(workshop)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("tugdash.joinresolver would not start: {e}"))?;
        let stdin = child.stdin.take().ok_or("join resolver stub: no stdin")?;
        let stdout = child.stdout.take().ok_or("join resolver stub: no stdout")?;
        let stderr = child.stderr.take();

        let (tx, rx) = mpsc::channel::<ResolverTurnRequest>(4);
        tokio::spawn(drive_stub(
            child,
            stdin,
            stdout,
            stderr,
            rx,
            self.turn_timeout,
        ));
        Ok(tx)
    }
}

/// One stub resolver's whole life — the same loop as [`drive_claude`] over a
/// line protocol instead of a stream-json one.
async fn drive_stub(
    mut child: tokio::process::Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    mut stderr: Option<tokio::process::ChildStderr>,
    mut rx: mpsc::Receiver<ResolverTurnRequest>,
    turn_timeout: Duration,
) {
    let mut lines = BufReader::new(stdout).lines();

    while let Some(ResolverTurnRequest { message, reply }) = rx.recv().await {
        let line = serde_json::to_string(&serde_json::json!({ "text": message }))
            .expect("resolver turn serializes");
        if stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .is_err()
            || stdin.flush().await.is_err()
        {
            let _ = child.start_kill();
            let _ = reply.send(Err(died(stderr.take()).await));
            return;
        }
        let read = match tokio::time::timeout(turn_timeout, lines.next_line()).await {
            Ok(read) => read,
            Err(_) => {
                let _ = child.start_kill();
                let _ = reply.send(Err(silent_turn(turn_timeout)));
                return;
            }
        };
        match read {
            Ok(Some(out)) => {
                let _ = reply.send(parse_turn(&out));
            }
            _ => {
                let _ = child.start_kill();
                let _ = reply.send(Err(died(stderr.take()).await));
                return;
            }
        }
    }
}

/// What a dead resolver is reported as: its own last words when it left any.
///
/// A bare "the resolver exited" is the least actionable sentence a stuck join
/// could carry — for the stub seam it usually means a shell error nobody would
/// otherwise see. The read is bounded because the caller has already killed the
/// child, and a process holding stderr open must not hold this task with it.
async fn died(stderr: Option<tokio::process::ChildStderr>) -> String {
    let Some(mut stderr) = stderr else {
        return "the resolver exited".to_string();
    };
    let mut buf = String::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut buf),
    )
    .await;
    match buf.trim().lines().last().filter(|l| !l.is_empty()) {
        Some(last) => format!("the resolver exited: {last}"),
        None => "the resolver exited".to_string(),
    }
}

// ---------------------------------------------------------------------------
// The resolve flow (#resolve-flow)
// ---------------------------------------------------------------------------

/// How many times a red Tier 0 may send the resolver back to work before the
/// join sticks ([P05]).
///
/// A budget, not a knob: three passes is enough for a real repair and few
/// enough that a resolver looping on a failure it cannot fix costs minutes
/// rather than the afternoon. Tests drive it by scripting a resolver that never
/// repairs, never by shrinking it.
pub const TIER0_ITERATIONS: usize = 3;

/// How long one resolver turn may produce no bytes at all before the child is
/// killed and the turn fails.
///
/// This is the only liveness check anything applies to the resolver, and it is
/// deliberately blunt: a healthy turn reads files, edits them, and thinks, so
/// its *statuses* are minutes apart and say nothing about whether it is alive.
/// Bytes on the wire do. Twenty minutes of complete silence is past any turn a
/// resolver is still working through and short of a wedge nobody would notice.
pub const RESOLVER_TURN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// The ceiling on one whole resolve, from opening the workshop to the last
/// tier's verdict.
///
/// Every inner bound can be paid in full and still add up to a finite number:
/// three iterations of (a resolver turn + Tier 0) plus one expired question is
/// a little under two hours. This catches whatever the inner bounds cannot —
/// and names, in the stuck fact, what the resolve was doing when it expired.
pub const RESOLVE_DEADLINE: Duration = Duration::from_secs(2 * 60 * 60);

/// What a turn that went silent is reported as.
fn silent_turn(bound: Duration) -> String {
    format!(
        "the resolver went silent for {}s and was stopped",
        bound.as_secs()
    )
}

/// How long an escalation waits for its answer before the join sticks.
///
/// Long, because the question is the user's to answer on their own schedule,
/// and short of forever, because a resolver blocked on a question nobody will
/// ever see holds a workshop and a spawn open indefinitely.
///
/// Expiry is not a failure of the resolver. The resolve sticks with a sentence
/// quoting what was asked, and the question itself is written to the last-ask
/// fact — so the next resolve's charter carries it and a resolver that reaches
/// the same ambiguity can raise it again, against a user who is present. The
/// conversation cannot resume; the question survives.
pub const QUESTION_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// The escalations currently waiting for an answer, keyed by request id.
///
/// Process-global because the answer arrives on a different CONTROL request
/// than the resolve that is blocked: the handler that receives it has no route
/// back to the awaiting task except through a rendezvous both can name.
static PENDING_ASKS: OnceLock<Mutex<HashMap<String, oneshot::Sender<String>>>> = OnceLock::new();

fn pending_asks() -> &'static Mutex<HashMap<String, oneshot::Sender<String>>> {
    PENDING_ASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Deliver an answer to whichever resolve is blocked on `request_id`.
///
/// Returns whether anybody was waiting. A `false` is a real answer to give the
/// card — the question expired, or the resolve died — and not a shrug: a
/// control the user pressed that reaches nothing must say so ([L31]).
pub fn answer_question(request_id: &str, answer: String) -> bool {
    let waiting = pending_asks()
        .lock()
        .expect("pending asks mutex")
        .remove(request_id);
    match waiting {
        Some(tx) => tx.send(answer).is_ok(),
        None => false,
    }
}

/// A request id for one escalation: the dash, and when it was raised.
///
/// Uniqueness only has to hold among the asks alive at one moment, and one
/// dash has at most one — the charter allows a single ask per resolve.
fn mint_request_id(dash: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("join-{dash}-{now}")
}

/// What the resolve flow needs from its caller to run one join to a verdict.
pub struct ResolverContext {
    pub repo: std::path::PathBuf,
    pub dash: String,
    pub project_dir: String,
    pub model: Arc<dyn Fn() -> String + Send + Sync>,
    pub control_tx: tokio::sync::broadcast::Sender<tugcast_core::protocol::Frame>,
    /// Fired whenever a fact the face reads has moved, so the board recomputes
    /// mid-flight rather than only at the end. A resolve is minutes long; a
    /// surface that updates once at the close is indistinguishable from a
    /// broken one.
    pub bump: Arc<tokio::sync::Notify>,
    /// The real spawn, when this build has one. Absent in any build with no
    /// model wired — including every test that does not script a stub.
    pub production: Option<Arc<dyn JoinResolverSpawner>>,
}

/// What the workshop looks like once the ladder's work has been carried into
/// it — the facts the charter is composed from.
struct WorkshopState {
    path: std::path::PathBuf,
    /// Still marker-bearing: what the resolver must finish.
    unresolved: Vec<String>,
    /// Resolved by a machine rung, and by which — what the resolver must audit
    /// ([P10]).
    rung_resolved: Vec<(String, ResolvedBy)>,
    /// Every path the report must account for: the union of the two above.
    resolution_set: Vec<String>,
    /// The candidate the workshop was opened *at*, when the ladder already
    /// built one this pass is only auditing (the replay exit).
    ///
    /// An audit that changes nothing must leave that candidate standing rather
    /// than re-committing its tree: the replay candidate is a chain of the
    /// dash's own rounds, and re-committing would collapse it into a squash —
    /// silently converting the join's shape as a side effect of reading it.
    inherited_candidate: Option<String>,
    /// The tree the resolver was handed — the ladder's own work, or the
    /// candidate it is auditing. Diffing the workshop against this is what says
    /// which paths the *resolver* changed, as opposed to the machine.
    ladder_tree: String,
    intent: String,
    base_branch: String,
}

/// Finish a conflicted join with the resolver, and verify what it produced.
///
/// The sequence is #resolve-flow's: materialize the merge in the workshop,
/// carry the ladder's resolutions in, charter the resolver, validate what comes
/// back, commit the candidate, and loop Tier 0 against it until it is green or
/// the budget is spent. Every failure arm returns `Err` with a sentence — there
/// is no arm that ends quietly, because a join that stops without saying why is
/// the one state the face cannot render.
pub async fn finish_join(
    ctx: &ResolverContext,
    outcome: &tugdash_core::ResolveOutcome,
) -> Result<(), String> {
    let phase: Phase = Arc::new(Mutex::new("opening the workshop"));
    let result =
        match tokio::time::timeout(RESOLVE_DEADLINE, finish_join_inner(ctx, outcome, &phase)).await
        {
            Ok(result) => result,
            Err(_) => Err(format!(
                "the resolve passed its {}-hour deadline while {}",
                RESOLVE_DEADLINE.as_secs() / 3600,
                read_phase(&phase),
            )),
        };

    // A failed resolve gives the tree back ([P07]). The account of what went
    // wrong is the durable stuck fact, which is where somebody will read it;
    // what the workshop would otherwise hold is a half-merged checkout with
    // conflict markers in it and a live `MERGE_HEAD`, which reads as wreckage
    // to anyone who opens the directory and blocks nothing that would help.
    //
    // Only on failure. A resolve that succeeded leaves a tree its candidate was
    // built from, and the next verification resets it anyway.
    if result.is_err() {
        let repo = ctx.repo.clone();
        let dash = ctx.dash.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(ws) = tugdash_core::workshop::Workshop::open_existing(&repo, &dash) {
                ws.release();
            }
        })
        .await;
    }
    result
}

/// What a resolve is doing right now, so an expired deadline can say so.
///
/// The stuck fact is the only channel a dead resolve has, and "it took too
/// long" without naming the activity leaves the user with nothing to act on —
/// a wedged Tier 1 and a resolver waiting on an answer nobody saw are the same
/// sentence otherwise.
type Phase = Arc<Mutex<&'static str>>;

fn set_phase(phase: &Phase, what: &'static str) {
    *phase.lock().expect("resolve phase mutex") = what;
}

fn read_phase(phase: &Phase) -> &'static str {
    *phase.lock().expect("resolve phase mutex")
}

async fn finish_join_inner(
    ctx: &ResolverContext,
    outcome: &tugdash_core::ResolveOutcome,
    phase: &Phase,
) -> Result<(), String> {
    let state = open_workshop(ctx, outcome).await?;
    emit_resolver_delta(ctx, "working", None);

    set_phase(phase, "starting the resolver");
    let spawner = {
        let repo = ctx.repo.clone();
        let production = ctx.production.clone();
        tokio::task::spawn_blocking(move || spawner_for(&repo, production))
            .await
            .map_err(|e| format!("resolver spawner: {e}"))??
    };
    let mut run = ResolverRun::open(spawner.as_ref(), &state.path, (ctx.model)())?;

    let charter = compose_charter(&CharterInputs {
        intent: &state.intent,
        base_branch: &state.base_branch,
        unresolved: &state.unresolved,
        rung_resolved: &state.rung_resolved,
    });
    // The charter has the expired ask in it now, so the fact has done its job:
    // it is offered forward exactly once, not to every resolve from here on.
    {
        let repo = ctx.repo.clone();
        let dash = ctx.dash.clone();
        let _ = tokio::task::spawn_blocking(move || {
            tugdash_core::resolve::clear_lastask(&repo, &dash);
        })
        .await;
    }

    set_phase(phase, "waiting on the resolver");
    let mut turn = run.send(charter).await?;
    let mut asked: Option<tugcast_core::types::DashJoinReportQuestion> = None;

    let mut iterations: Vec<tugcast_core::types::DashJoinReportIteration> = Vec::new();
    // What the resolver's edits are measured against: the ladder's tree on the
    // first pass, and the previous pass's candidate after that — so each pass's
    // report answers for what *that* pass changed.
    let mut baseline = state.ladder_tree.clone();
    for _ in 0..TIER0_ITERATIONS {
        // An escalation is answered before anything else can happen — the
        // charter allows one per resolve, so this resolves at most once.
        if let ResolverTurn::Ask(ask) = &turn {
            set_phase(phase, "waiting on your answer");
            let answer = escalate(ctx, ask).await?;
            asked = Some(tugcast_core::types::DashJoinReportQuestion {
                question: ask.question.clone(),
                answer: answer.clone(),
            });
            set_phase(phase, "waiting on the resolver");
            turn = run.send(compose_answer_turn(&answer)).await?;
        }

        let report = match turn {
            ResolverTurn::Report(report) => report,
            // Two asks in one resolve: `ResolverRun` refuses the second, so
            // reaching here means the charter was violated in a way the run
            // could not name.
            ResolverTurn::Ask(ask) => {
                return Err(format!(
                    "the resolver asked again instead of finishing: {}",
                    ask.question
                ));
            }
        };
        let report = ResolverReport {
            question: report.question.or_else(|| asked.clone()),
            ..report
        };

        set_phase(phase, "committing the candidate");
        let candidate = commit_candidate(ctx, &state, &report, &iterations, &baseline).await?;
        baseline = candidate.clone();
        emit_resolver_delta(ctx, "verifying", Some(&candidate));
        ctx.bump.notify_one();

        set_phase(phase, "running the build tier");
        let verdict = run_tier0(ctx, &candidate).await?;
        iterations.push(tugcast_core::types::DashJoinReportIteration {
            tier0: if verdict.is_empty() { "green" } else { "red" }.to_string(),
            detail: verdict.first().cloned(),
        });
        if verdict.is_empty() {
            record_report(ctx, &candidate, &report, &iterations).await?;
            ctx.bump.notify_one();
            set_phase(phase, "running the exam tier");
            return run_tier1(ctx, &candidate).await;
        }

        // Red, and there is budget left: the failure text is the resolver's
        // next turn ([P05]). A machine-repairable red costs a machine
        // iteration, not the user's attention.
        record_report(ctx, &candidate, &report, &iterations).await?;
        emit_resolver_delta(ctx, "iterating", Some(&candidate));
        ctx.bump.notify_one();
        set_phase(phase, "waiting on the resolver");
        turn = run.send(compose_tier0_failure_turn(&verdict)).await?;
    }

    Err(format!(
        "the resolver could not make the joined tree build in {} passes",
        TIER0_ITERATIONS
    ))
}

/// Raise the resolver's question to the user and wait for the answer.
///
/// Both halves are written: the durable fact on the dash, which is what a
/// reload re-renders, and the CONTROL frame, which is what makes the face
/// paint now. The frame alone would lose the question on a dropped frame or a
/// reload; the fact alone would leave it invisible until the next recompute.
async fn escalate(ctx: &ResolverContext, ask: &ResolverAsk) -> Result<String, String> {
    let request_id = mint_request_id(&ctx.dash);
    let question = tugcast_core::types::DashJoinQuestion {
        request_id: request_id.clone(),
        question: ask.question.clone(),
        options: ask
            .options
            .iter()
            .map(|o| tugcast_core::types::DashJoinQuestionOption {
                label: o.label.clone(),
                description: o.description.clone(),
            })
            .collect(),
    };

    let (tx, rx) = oneshot::channel::<String>();
    pending_asks()
        .lock()
        .expect("pending asks mutex")
        .insert(request_id.clone(), tx);

    {
        let repo = ctx.repo.clone();
        let dash = ctx.dash.clone();
        let json = serde_json::to_string(&question).map_err(|e| e.to_string())?;
        tokio::task::spawn_blocking(move || {
            let branch = format!("tugdash/{dash}");
            if let Ok(head) = tugdash_core::ops::rev_parse(&repo, &branch) {
                tugdash_core::resolve::write_question(&repo, &dash, &head, &json);
            }
        })
        .await
        .map_err(|e| format!("question task failed: {e}"))?;
    }

    let body = serde_json::json!({
        "action": "changeset_join_question",
        "project_dir": ctx.project_dir,
        "dash": ctx.dash,
        "request_id": question.request_id,
        "question": question.question,
        "options": question.options,
    });
    let _ = ctx.control_tx.send(tugcast_core::protocol::Frame::new(
        tugcast_core::protocol::FeedId::CONTROL,
        serde_json::to_vec(&body).expect("changeset_join_question serializes"),
    ));
    emit_resolver_delta(ctx, "asking", None);
    ctx.bump.notify_one();

    let answer = tokio::time::timeout(QUESTION_DEADLINE, rx).await;

    // However it ended, the question is no longer live.
    pending_asks()
        .lock()
        .expect("pending asks mutex")
        .remove(&request_id);
    let answered = matches!(answer, Ok(Ok(_)));
    {
        let repo = ctx.repo.clone();
        let dash = ctx.dash.clone();
        let asked = ask.question.clone();
        let _ = tokio::task::spawn_blocking(move || {
            // The live question is cleared either way — nothing is waiting on
            // it any more, and leaving it standing renders a wizard whose
            // answer would reach nobody.
            //
            // An *unanswered* one is not simply dropped, though: it is kept as
            // the last ask, so the next resolve's charter carries it. That is
            // what makes "the answer arrives on the next resolve" true rather
            // than aspirational — the conversation cannot resume, but the
            // question can be asked again by a resolver that knows to.
            if !answered {
                if let Ok(head) = tugdash_core::ops::rev_parse(&repo, &format!("tugdash/{dash}")) {
                    tugdash_core::resolve::write_lastask(&repo, &dash, &head, &asked);
                }
            }
            tugdash_core::resolve::clear_question(&repo, &dash);
        })
        .await;
    }
    ctx.bump.notify_one();

    match answer {
        Ok(Ok(answer)) => Ok(answer),
        // The question outlived its deadline, or the answer path died. Either
        // way the resolve sticks *carrying the question* — the user's answer
        // is still the thing that unblocks it, so the sentence says what was
        // asked rather than that something timed out.
        _ => Err(format!(
            "the resolver is waiting on an unanswered question: {}",
            ask.question
        )),
    }
}

/// Every path this resolve owes an account of (Spec S04).
///
/// The union of what the one-shot squash would have conflicted over, what the
/// ladder resolved, and what it left — **not** the ladder's exit shape. The two
/// exits that report neither resolutions nor leftovers (the replay probe and
/// the clean one-shot squash) are exactly the ones that used to slip the audit,
/// and the first of them is the shape of a wholesale machine decision that
/// builds green.
///
/// Empty means nothing was decided, which is the honest no-audit case.
pub fn audit_set(outcome: &tugdash_core::ResolveOutcome) -> Vec<String> {
    let mut set: Vec<String> = outcome
        .preview_conflicts
        .iter()
        .cloned()
        .chain(outcome.resolved.iter().map(|r| r.path.clone()))
        .chain(outcome.unresolved.iter().cloned())
        .collect();
    set.sort();
    set.dedup();
    set
}

/// Materialize the merge and carry the ladder's resolutions into it.
async fn open_workshop(
    ctx: &ResolverContext,
    outcome: &tugdash_core::ResolveOutcome,
) -> Result<WorkshopState, String> {
    let repo = ctx.repo.clone();
    let dash = ctx.dash.clone();
    let base_branch = outcome.base_branch.clone();
    let staged_tree = outcome.staged_tree.clone();
    let ladder_resolved: Vec<(String, ResolvedBy)> = outcome
        .resolved
        .iter()
        .map(|r| (r.path.clone(), r.resolved_by))
        .collect();
    // The replay exit already produced the tree the join would land, so this
    // pass audits it rather than re-deriving it: the workshop opens *at* the
    // candidate. Re-merging instead would hand the resolver a conflicted tree
    // and ask it to redo, by hand, work the machine already did — and throw
    // away the replay's per-round history in the process.
    let inherited_candidate = match outcome.shape {
        tugdash_core::JoinShape::Replay => outcome.candidate_commit.clone(),
        tugdash_core::JoinShape::Squash => None,
    };

    tokio::task::spawn_blocking(move || {
        let workshop = match &inherited_candidate {
            Some(sha) => tugdash_core::Workshop::open_candidate(&repo, &dash, sha)?,
            None => {
                let workshop = tugdash_core::Workshop::open_merge(&repo, &dash)?;
                if let Some(tree) = &staged_tree {
                    let paths: Vec<String> =
                        ladder_resolved.iter().map(|(p, _)| p.clone()).collect();
                    workshop.apply_staged(tree, &paths)?;
                }
                workshop
            }
        };
        let unresolved = workshop.unresolved()?;
        let mut resolution_set: Vec<String> = ladder_resolved
            .iter()
            .map(|(p, _)| p.clone())
            .chain(unresolved.iter().cloned())
            .collect();
        resolution_set.sort();
        resolution_set.dedup();

        let branch = format!("tugdash/{}", dash);
        let ladder_tree = inherited_candidate
            .clone()
            .or_else(|| staged_tree.clone())
            .unwrap_or_else(|| workshop.base_head().to_string());
        Ok(WorkshopState {
            path: workshop.path().to_path_buf(),
            unresolved,
            rung_resolved: ladder_resolved,
            resolution_set,
            intent: tugdash_core::resolve_intent(&repo, &base_branch, &branch),
            base_branch,
            inherited_candidate,
            ladder_tree,
        })
    })
    .await
    .map_err(|e| format!("workshop task failed: {e}"))?
}

/// Validate what the resolver produced and commit it as the candidate.
///
/// Three refusals, and each is a different lie the flow must not let past: a
/// file still carrying markers, an index still holding stages, and a report
/// that does not account for every path in the resolution set ([P10]).
async fn commit_candidate(
    ctx: &ResolverContext,
    state: &WorkshopState,
    report: &ResolverReport,
    iterations: &[tugcast_core::types::DashJoinReportIteration],
    baseline: &str,
) -> Result<String, String> {
    let repo = ctx.repo.clone();
    let dash = ctx.dash.clone();
    let resolution_set = state.resolution_set.clone();
    let baseline = baseline.to_string();
    let audits: Vec<(String, Option<String>)> = report
        .files
        .iter()
        .map(|f| (f.path.clone(), f.audit.clone()))
        .collect();
    let rung_resolved = state.rung_resolved.clone();
    let inherited = state.inherited_candidate.clone();
    let report_for_validation = report.clone();
    let pass = iterations.len();

    tokio::task::spawn_blocking(move || {
        let workshop = tugdash_core::Workshop::open_existing(&repo, &dash)?;
        // What the resolver changed can only be read from the tree it left, so
        // the report is validated here rather than before the task — against
        // the machine's decisions *and* the resolver's own edits.
        let touched = workshop.touched_since(&baseline)?;
        validate_report(&report_for_validation, &resolution_set, &touched)?;
        let branch = format!("tugdash/{}", dash);
        let message = tugdash_core::ops::integrate_message(&repo, &dash, &branch, None);
        // An audit that changed nothing keeps the candidate it audited.
        // Committing an identical tree anyway would reparent it onto the base
        // head, turning a replay join into a squash without anybody asking.
        let candidate = match &inherited {
            Some(sha) if workshop.matches(sha)? => sha.clone(),
            _ => workshop.commit(&format!("{message}\n\nResolve pass {}.", pass + 1))?,
        };
        let dash_head = tugdash_core::ops::rev_parse(&repo, &branch)?;
        tugdash_core::resolve::anchor_candidate(&repo, &dash, &candidate, &dash_head)?;

        // Which rung a path ends up credited to: the resolver for anything it
        // finished or redid, the original machine rung for a resolution it
        // audited and kept.
        for path in &resolution_set {
            let audit = audits
                .iter()
                .find(|(p, _)| p == path)
                .and_then(|(_, a)| a.clone());
            let rung = match audit.as_deref() {
                Some("kept") => rung_resolved
                    .iter()
                    .find(|(p, _)| p == path)
                    .map(|(_, r)| *r)
                    .unwrap_or(ResolvedBy::Resolver),
                _ => ResolvedBy::Resolver,
            };
            tugdash_core::resolve::record_resolved_rung(&repo, &dash, path, rung);
        }
        Ok(candidate)
    })
    .await
    .map_err(|e| format!("candidate task failed: {e}"))?
}

/// Persist the report against the candidate it describes, with the loop's
/// verdicts folded in so the account is honest about retries ([P05]).
async fn record_report(
    ctx: &ResolverContext,
    candidate: &str,
    report: &ResolverReport,
    iterations: &[tugcast_core::types::DashJoinReportIteration],
) -> Result<(), String> {
    let mut stored = report.clone();
    stored.iterations = iterations.to_vec();
    let json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
    let repo = ctx.repo.clone();
    let dash = ctx.dash.clone();
    let candidate = candidate.to_string();
    tokio::task::spawn_blocking(move || {
        tugdash_core::resolve::write_report(&repo, &dash, &candidate, &json)
    })
    .await
    .map_err(|e| format!("report task failed: {e}"))?
}

/// Run the build tier against a candidate; the returned failures are empty on
/// green.
async fn run_tier0(ctx: &ResolverContext, candidate: &str) -> Result<Vec<String>, String> {
    let repo = ctx.repo.clone();
    let dash = ctx.dash.clone();
    let candidate = candidate.to_string();
    tokio::task::spawn_blocking(move || {
        use tugdash_core::verify::{self, TierStatus, Verification};
        let base_sha = {
            let detail = tugdash_core::ops::dash_detail_entry_in(&repo, &dash)
                .ok_or_else(|| format!("no dash named {dash}"))?;
            tugdash_core::ops::rev_parse(&repo, &detail.base)?
        };
        let mut fact = Verification {
            base_sha,
            candidate_sha: candidate.clone(),
            tier0: TierStatus::Running,
            tier1: TierStatus::Unrun,
            failures: Vec::new(),
            notes: Vec::new(),
        };
        verify::write_verification(&repo, &dash, &fact)?;

        let out = match verify::run_tier0(&repo, &dash, &candidate) {
            Ok(out) => out,
            Err(e) => {
                fact.fail_running(&e);
                let _ = verify::write_verification(&repo, &dash, &fact);
                return Err(e);
            }
        };
        fact.tier0 = out.status;
        fact.failures = out.failures.clone();
        fact.notes = out.notes;
        if out.status == TierStatus::Red {
            fact.notes
                .push("tests not run: the joined tree does not build".to_string());
        }
        verify::write_verification(&repo, &dash, &fact)?;
        Ok(if out.status == TierStatus::Red {
            if out.failures.is_empty() {
                vec!["the build tier failed without saying why".to_string()]
            } else {
                out.failures
            }
        } else {
            Vec::new()
        })
    })
    .await
    .map_err(|e| format!("tier 0 task failed: {e}"))?
}

/// Run the exam tier once, on the claimed-done candidate ([P09]).
async fn run_tier1(ctx: &ResolverContext, candidate: &str) -> Result<(), String> {
    emit_resolver_delta(ctx, "verifying", Some(candidate));
    let repo = ctx.repo.clone();
    let dash = ctx.dash.clone();
    let candidate = candidate.to_string();
    let bump = ctx.bump.clone();
    let result = tokio::task::spawn_blocking(move || {
        use tugdash_core::verify::{self, TierStatus};
        let mut fact = verify::read_verification(&repo, &dash)
            .filter(|f| f.candidate_sha == candidate)
            .ok_or_else(|| "the build verdict went missing before the exam".to_string())?;
        fact.tier1 = TierStatus::Running;
        verify::write_verification(&repo, &dash, &fact)?;
        bump.notify_one();

        let out = match verify::run_tier1(&repo, &dash, &candidate) {
            Ok(out) => out,
            Err(e) => {
                fact.fail_running(&e);
                let _ = verify::write_verification(&repo, &dash, &fact);
                return Err(e);
            }
        };
        fact.tier1 = out.status;
        fact.failures.extend(out.failures);
        fact.notes.extend(out.notes);
        verify::write_verification(&repo, &dash, &fact)
    })
    .await
    .map_err(|e| format!("tier 1 task failed: {e}"))?;
    ctx.bump.notify_one();
    result
}

/// One `changeset_join_resolve_delta` for the resolver rung.
/// The resolver rung's progress frame ([P08]).
///
/// It names a **candidate**, not a path, and says so in the field name. The
/// resolver works over the whole tree rather than one file at a time, so it has
/// no path to report; passing the candidate sha through the `path` slot made
/// the face render a commit hash in its filename column, and made every status
/// of one run look like a different file to a store that keys progress by path.
fn emit_resolver_delta(ctx: &ResolverContext, status: &str, candidate: Option<&str>) {
    let body = serde_json::json!({
        "action": "changeset_join_resolve_delta",
        "project_dir": ctx.project_dir,
        "dash": ctx.dash,
        "path": "",
        "candidate": candidate,
        "rung": "resolver",
        "status": status,
        "text": Option::<&str>::None,
    });
    let _ = ctx.control_tx.send(tugcast_core::protocol::Frame::new(
        tugcast_core::protocol::FeedId::CONTROL,
        serde_json::to_vec(&body).expect("changeset_join_resolve_delta serializes"),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub(body: &str) -> (tempfile::TempDir, StubJoinResolverSpawner) {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("stub-resolver.sh");
        std::fs::write(&script, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let spawner = StubJoinResolverSpawner {
            command: script.to_string_lossy().to_string(),
            turn_timeout: RESOLVER_TURN_TIMEOUT,
        };
        (temp, spawner)
    }

    #[test]
    fn the_charter_names_every_rung_resolved_file_with_its_rung() {
        let rung_resolved = vec![
            ("src/a.rs".to_string(), ResolvedBy::Rerere),
            ("src/b.rs".to_string(), ResolvedBy::Driver),
        ];
        let charter = compose_charter(&CharterInputs {
            intent: "Round subjects:\nteach the parser about tabs",
            base_branch: "main",
            unresolved: &["src/c.rs".to_string()],
            rung_resolved: &rung_resolved,
        });

        // The intent corpus rides along whole.
        assert!(charter.contains("teach the parser about tabs"));
        assert!(charter.contains("joined into `main`"));
        // Unresolved and audited files are named, and the audit list says which
        // rung decided each — the [P10] pass cannot run without that.
        assert!(charter.contains("`src/c.rs`"));
        assert!(charter.contains("`src/a.rs` — resolved by the rerere rung"));
        assert!(charter.contains("`src/b.rs` — resolved by the driver rung"));
        // The fixed contract is present and unmodified.
        assert!(charter.starts_with(RESOLVER_CHARTER));
    }

    #[test]
    fn a_charter_with_nothing_left_unresolved_still_orders_the_audit() {
        let charter = compose_charter(&CharterInputs {
            intent: "",
            base_branch: "main",
            unresolved: &[],
            rung_resolved: &[("src/a.rs".to_string(), ResolvedBy::Rerere)],
        });
        assert!(charter.contains("the ladder resolved every conflict"));
        assert!(charter.contains("`src/a.rs` — resolved by the rerere rung"));
        assert!(charter.contains("not conditional on there being"));
    }

    #[test]
    fn parse_turn_accepts_the_two_terminal_shapes() {
        let ask = parse_turn(
            r#"{"ask":{"question":"Which name wins?","options":[{"label":"join","description":"the dash's"},{"label":"land","description":"the base's"}]}}"#,
        )
        .unwrap();
        match ask {
            ResolverTurn::Ask(ask) => {
                assert_eq!(ask.question, "Which name wins?");
                assert_eq!(ask.options.len(), 2);
            }
            other => panic!("expected an ask, got {other:?}"),
        }

        let report = parse_turn(
            r#"{"files":[{"path":"a.txt","resolved_by":"resolver","what_each_side_did":"x","reconciliation":"y","audit":"kept"}],"iterations":[{"tier0":"green"}],"notes":"done"}"#,
        )
        .unwrap();
        match report {
            ResolverTurn::Report(report) => {
                assert_eq!(report.files.len(), 1);
                assert_eq!(report.files[0].audit.as_deref(), Some("kept"));
                assert_eq!(report.iterations[0].tier0, "green");
            }
            other => panic!("expected a report, got {other:?}"),
        }
    }

    #[test]
    fn parse_turn_refuses_prose_a_fence_and_a_half_object() {
        // Prose, with or without JSON buried in it.
        assert!(parse_turn("I fixed the conflict in a.txt.").is_err());
        assert!(parse_turn("Here you go:\n{\"files\":[]}").is_err());
        // A fenced block is not one JSON object, and needs no special case.
        assert!(parse_turn("```json\n{\"files\":[]}\n```").is_err());
        // A truncated tail.
        assert!(parse_turn(r#"{"files":[{"path":"a.txt""#).is_err());
        // An object of the wrong shape.
        assert!(parse_turn(r#"{"status":"done"}"#).is_err());
        // Nothing at all.
        assert!(parse_turn("   ").is_err());
        // An ask outside the option bounds is a violation, not a repair.
        assert!(parse_turn(r#"{"ask":{"question":"q","options":[{"label":"one"}]}}"#).is_err());
    }

    #[test]
    fn validate_report_refuses_a_report_that_skips_a_resolved_path() {
        let report = match parse_turn(
            r#"{"files":[{"path":"a.txt","resolved_by":"resolver","what_each_side_did":"x","reconciliation":"y"}],"notes":""}"#,
        )
        .unwrap()
        {
            ResolverTurn::Report(report) => report,
            other => panic!("expected a report, got {other:?}"),
        };

        assert!(validate_report(&report, &["a.txt".to_string()], &[]).is_ok());

        // The rung-resolved file the resolver was told to audit is missing —
        // the 2026-08-15 failure class, caught at the report contract.
        let err = validate_report(&report, &["a.txt".to_string(), "b.txt".to_string()], &[])
            .expect_err("a skipped path must be refused");
        assert!(err.contains("b.txt"), "{err}");

        // A path the machine never decided, changed by the resolver anyway, is
        // refused in its own words: an invented file the report need not
        // mention is a file that can be smuggled in.
        let err = validate_report(&report, &["a.txt".to_string()], &["new.rs".to_string()])
            .expect_err("an unexplained edit must be refused");
        assert!(err.contains("new.rs"), "{err}");
        assert!(err.contains("without accounting for it"), "{err}");

        // A touched path that was already in the machine's set is not reported
        // twice, and the resolver's own resolutions are the ordinary case.
        assert!(
            validate_report(&report, &["a.txt".to_string()], &["a.txt".to_string()]).is_ok()
        );
    }

    #[tokio::test]
    async fn the_stub_spawner_round_trips_a_scripted_resolve() {
        let (_temp, spawner) = stub(
            "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"files\":[{\"path\":\"a.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"both renamed\",\"reconciliation\":\"kept both\"}],\"notes\":\"ok\"}'\n",
        );
        let workshop = tempfile::tempdir().unwrap();
        let mut run = ResolverRun::open(&spawner, workshop.path(), "model".into()).unwrap();

        let turn = run.send("charter".to_string()).await.unwrap();
        match turn {
            ResolverTurn::Report(report) => {
                assert_eq!(report.files[0].path, "a.txt");
                assert_eq!(report.notes, "ok");
            }
            other => panic!("expected a report, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_stub_spawner_asks_then_resolves_on_the_same_live_spawn() {
        let (_temp, spawner) = stub(
            "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"ask\":{\"question\":\"which?\",\"options\":[{\"label\":\"a\"},{\"label\":\"b\"}]}}'\nread -r answer\nprintf '%s\\n' '{\"files\":[{\"path\":\"a.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"x\",\"reconciliation\":\"y\"}],\"notes\":\"asked\"}'\n",
        );
        let workshop = tempfile::tempdir().unwrap();
        let mut run = ResolverRun::open(&spawner, workshop.path(), "model".into()).unwrap();

        match run.send("charter".to_string()).await.unwrap() {
            ResolverTurn::Ask(ask) => assert_eq!(ask.question, "which?"),
            other => panic!("expected an ask, got {other:?}"),
        }
        match run.send("pick a".to_string()).await.unwrap() {
            ResolverTurn::Report(report) => assert_eq!(report.notes, "asked"),
            other => panic!("expected a report, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_second_ask_in_one_resolve_is_refused() {
        let (_temp, spawner) = stub(
            "#!/bin/sh\nwhile read -r _line; do printf '%s\\n' '{\"ask\":{\"question\":\"again?\",\"options\":[{\"label\":\"a\"},{\"label\":\"b\"}]}}'; done\n",
        );
        let workshop = tempfile::tempdir().unwrap();
        let mut run = ResolverRun::open(&spawner, workshop.path(), "model".into()).unwrap();

        assert!(matches!(
            run.send("charter".to_string()).await.unwrap(),
            ResolverTurn::Ask(_)
        ));
        let err = run
            .send("pick a".to_string())
            .await
            .expect_err("a second ask is a charter violation");
        assert!(err.contains("asked twice"), "{err}");
    }

    #[tokio::test]
    async fn a_stub_that_speaks_prose_is_a_protocol_violation() {
        let (_temp, spawner) =
            stub("#!/bin/sh\nread -r _charter\nprintf '%s\\n' 'I resolved everything, boss.'\n");
        let workshop = tempfile::tempdir().unwrap();
        let mut run = ResolverRun::open(&spawner, workshop.path(), "model".into()).unwrap();

        let err = run
            .send("charter".to_string())
            .await
            .expect_err("prose is not a terminal shape");
        assert!(err.contains("not one JSON object"), "{err}");
    }

    #[tokio::test]
    async fn a_stub_that_dies_reports_rather_than_hangs() {
        let (_temp, spawner) = stub("#!/bin/sh\nexit 3\n");
        let workshop = tempfile::tempdir().unwrap();
        let mut run = ResolverRun::open(&spawner, workshop.path(), "model".into()).unwrap();

        let err = run
            .send("charter".to_string())
            .await
            .expect_err("a dead resolver is a failure, never a wait");
        assert!(err.contains("exited"), "{err}");
    }

    // -- the resolve flow, over a real conflicted repo -----------------------

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn write_exec(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// A repo whose base and dash both rewrote `f.txt` — a real conflict — with
    /// a sentinel-grep Tier 0 and no Tier 1.
    ///
    /// A fixture declares no `verify_tier1` on purpose ([P11]): a real tier-1
    /// command spawns app-tests behind a machine-wide gate, and a fixture join
    /// running *inside* an app-test would queue on the gate its own run holds.
    fn conflicted_repo(resolver: &str) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        std::fs::write(repo.join(".gitignore"), ".tug/\n").unwrap();
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        std::fs::create_dir_all(repo.join(".tugtool")).unwrap();
        std::fs::write(
            repo.join(".tugtool/config.toml"),
            "[tugtool.dash]\nverify_tier0 = [\"grep -q SENTINEL f.txt\"]\n",
        )
        .unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugdash/demo"]);
        git(repo, &["config", "branch.tugdash/demo.tugbase", "main"]);

        // The dash's side.
        git(repo, &["switch", "-q", "tugdash/demo"]);
        std::fs::write(repo.join("f.txt"), "DASH\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "the dash rewrites f"]);
        git(repo, &["switch", "-q", "main"]);

        // The base's side — the same lines, differently.
        std::fs::write(repo.join("f.txt"), "BASE\n").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "the base rewrites f"]);

        let script = repo.join("stub-resolver.sh");
        write_exec(&script, resolver);
        git(
            repo,
            &["config", "tugdash.joinresolver", &script.to_string_lossy()],
        );
        temp
    }

    fn context(repo: &Path) -> ResolverContext {
        let (control_tx, _rx) = tokio::sync::broadcast::channel(64);
        ResolverContext {
            repo: repo.to_path_buf(),
            dash: "demo".to_string(),
            project_dir: repo.to_string_lossy().to_string(),
            model: Arc::new(|| "model".to_string()),
            control_tx,
            bump: Arc::new(tokio::sync::Notify::new()),
            production: None,
        }
    }

    /// A stub that writes `body` into the workshop's `f.txt` and reports the
    /// paths it was given, one report per turn.
    fn resolving_stub(body: &str) -> String {
        format!(
            "#!/bin/sh\nws=\"$1\"\nwhile read -r _line; do\n  printf '%s' '{body}' > \"$ws/f.txt\"\n  printf '%s\\n' '{{\"files\":[{{\"path\":\"f.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"both rewrote it\",\"reconciliation\":\"kept both\"}}],\"notes\":\"done\"}}'\ndone\n"
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_resolver_finishes_a_conflict_and_the_candidate_verifies_green() {
        let temp = conflicted_repo(&resolving_stub("SENTINEL\n"));
        let repo = temp.path();
        let before_base = std::fs::read_to_string(repo.join("f.txt")).unwrap();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        assert!(
            outcome.candidate_commit.is_none(),
            "the ladder alone cannot settle this conflict"
        );

        let ctx = context(repo);
        finish_join(&ctx, &outcome).await.expect("the resolve runs");

        // A candidate stands, and it is the resolver's tree.
        let candidate = match tugdash_core::resolve::candidate_status(repo, "demo", "main") {
            tugdash_core::resolve::CandidateStatus::Valid(sha) => sha,
            other => panic!("expected a valid candidate, got {other:?}"),
        };
        let merged = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["show", &format!("{candidate}:f.txt")])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&merged.stdout), "SENTINEL\n");

        // The build tier ran against it and said green.
        let fact = tugdash_core::verify::read_verification(repo, "demo").expect("a verdict");
        assert_eq!(
            fact.tier0,
            tugdash_core::verify::TierStatus::Green,
            "{:?}",
            fact.failures
        );

        // The report is stored against the candidate and accounts for the path.
        let report =
            tugdash_core::resolve::read_report(repo, "demo", &candidate).expect("a report");
        assert!(report.contains("f.txt"), "{report}");

        // Risk R01: the base checkout was never a party to any of this.
        assert_eq!(
            std::fs::read_to_string(repo.join("f.txt")).unwrap(),
            before_base,
            "the base checkout is untouched by a resolve"
        );
    }

    /// [P10]: a conflict the ladder settles on its own **still** gets the
    /// resolver, because the audit is the point — a machine resolution nobody
    /// read is exactly the failure class the retired review gate covered.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_ladder_clean_conflict_still_runs_the_audit_pass() {
        let auditing_stub = "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"driver\",\"what_each_side_did\":\"both rewrote it\",\"reconciliation\":\"the driver kept both\",\"audit\":\"kept\"}],\"notes\":\"audited\"}'\n";
        let temp = conflicted_repo(auditing_stub);
        let repo = temp.path();

        // A driver stub settles the conflict, so the ladder reaches a candidate.
        let driver = repo.join("stub-driver.sh");
        write_exec(&driver, "#!/bin/sh\nprintf 'SENTINEL\\n' > \"$4\"\n");
        git(
            repo,
            &["config", "tugdash.mergedriver", &driver.to_string_lossy()],
        );

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        assert!(
            outcome.candidate_commit.is_some(),
            "the driver rung settles it"
        );

        let ctx = context(repo);
        finish_join(&ctx, &outcome).await.expect("the audit runs");

        let candidate = match tugdash_core::resolve::candidate_status(repo, "demo", "main") {
            tugdash_core::resolve::CandidateStatus::Valid(sha) => sha,
            other => panic!("expected a valid candidate, got {other:?}"),
        };
        let report = tugdash_core::resolve::read_report(repo, "demo", &candidate)
            .expect("the audit pass leaves a report even with nothing left to finish");
        assert!(report.contains("\"audit\":\"kept\""), "{report}");
    }

    /// A repo whose one-shot squash conflicts but whose rounds replay cleanly.
    ///
    /// The dash's first round makes the same change the base later made, and
    /// its second round moves on from there. Squashing sees base `A`, ours `M`,
    /// theirs `X` and conflicts; replaying applies round 1 as a no-op onto a
    /// head that already has `M` and round 2 cleanly on top. That is the
    /// wholesale-machine-decision shape: a conflict silently settled by which
    /// rung ran, with nothing in `resolved` or `unresolved` to say so.
    fn replay_shaped_repo(resolver: &str) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        std::fs::write(repo.join(".gitignore"), ".tug/\n").unwrap();
        std::fs::write(repo.join("f.txt"), "A\n").unwrap();
        std::fs::create_dir_all(repo.join(".tugtool")).unwrap();
        std::fs::write(
            repo.join(".tugtool/config.toml"),
            "[tugtool.dash]\nverify_tier0 = [\"grep -q X f.txt\"]\n",
        )
        .unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugdash/demo"]);
        git(repo, &["config", "branch.tugdash/demo.tugbase", "main"]);

        git(repo, &["switch", "-q", "tugdash/demo"]);
        std::fs::write(repo.join("f.txt"), "M\n").unwrap();
        git(repo, &["commit", "-am", "r1: the change the base also makes"]);
        std::fs::write(repo.join("f.txt"), "X\n").unwrap();
        git(repo, &["commit", "-am", "r2: move on from there"]);
        git(repo, &["switch", "-q", "main"]);

        std::fs::write(repo.join("f.txt"), "M\n").unwrap();
        git(repo, &["commit", "-am", "the base makes the same change"]);

        let script = repo.join("stub-resolver.sh");
        write_exec(&script, resolver);
        git(
            repo,
            &["config", "tugdash.joinresolver", &script.to_string_lossy()],
        );
        temp
    }

    /// A dash the replay probe settles is audited, and its candidate survives.
    ///
    /// The replay exit reports neither resolutions nor leftovers, so a trigger
    /// reading those two lists skipped the audit entirely — over the one shape
    /// where a machine decided a real conflict wholesale. The audit set is the
    /// preview's conflict list instead, so it fires; and because the audit
    /// changed nothing, the replayed candidate is left standing rather than
    /// re-committed as a squash.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_replay_that_settled_a_conflict_is_audited() {
        let auditing_stub = "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"replay\",\"what_each_side_did\":\"both reached M; the dash went on to X\",\"reconciliation\":\"the replay applied the rounds in order\",\"audit\":\"kept\"}],\"notes\":\"audited\"}'\n";
        let temp = replay_shaped_repo(auditing_stub);
        let repo = temp.path();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        assert_eq!(
            outcome.shape,
            tugdash_core::JoinShape::Replay,
            "precondition: the rounds replay clean"
        );
        assert_eq!(
            outcome.preview_conflicts,
            vec!["f.txt".to_string()],
            "precondition: the squash would have conflicted"
        );
        assert_eq!(audit_set(&outcome), vec!["f.txt".to_string()]);
        let replayed = outcome.candidate_commit.clone().expect("a candidate");

        let ctx = context(repo);
        finish_join(&ctx, &outcome).await.expect("the audit runs");

        let candidate = match tugdash_core::resolve::candidate_status(repo, "demo", "main") {
            tugdash_core::resolve::CandidateStatus::Valid(sha) => sha,
            other => panic!("expected a valid candidate, got {other:?}"),
        };
        assert_eq!(
            candidate, replayed,
            "an audit that changed nothing keeps the replayed candidate"
        );
        let report = tugdash_core::resolve::read_report(repo, "demo", &candidate)
            .expect("the replay pass leaves a report");
        assert!(report.contains("f.txt"), "{report}");
        assert!(report.contains("\"audit\":\"kept\""), "{report}");
    }

    /// …and a report that ignores what the replay decided is refused by name.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_replay_report_that_omits_the_conflict_is_refused() {
        let silent_stub = "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"files\":[],\"notes\":\"nothing to do\"}'\n";
        let temp = replay_shaped_repo(silent_stub);
        let repo = temp.path();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let ctx = context(repo);
        let err = finish_join(&ctx, &outcome)
            .await
            .expect_err("a report accounting for nothing cannot pass");
        assert!(err.contains("f.txt"), "{err}");
    }

    /// A dash with no conflict at all has an empty audit set, and the resolver
    /// never runs — the no-audit case by construction, not by exit shape.
    #[test]
    fn a_clean_dash_has_an_empty_audit_set() {
        let temp = replay_shaped_repo("#!/bin/sh\nexit 1\n");
        let repo = temp.path();
        // Take the base's conflicting change back out, leaving a dash that
        // merges cleanly.
        git(repo, &["revert", "--no-edit", "HEAD"]);

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        assert!(outcome.candidate_commit.is_some());
        assert!(
            audit_set(&outcome).is_empty(),
            "nothing was decided: {:?}",
            audit_set(&outcome)
        );
    }

    /// A file the resolver invented and did not mention is refused by name.
    ///
    /// The report contract used to require only the paths the *machine*
    /// decided, so anything the resolver created on its own initiative landed
    /// in the candidate with nothing obliged to say it existed. Naming it is
    /// the whole defense: a report that need not mention an invented file
    /// cannot catch one being smuggled in.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_the_resolver_invented_must_be_accounted_for() {
        // Resolves the conflict *and* drops an unrelated file, reporting only
        // the conflict.
        let smuggler = "#!/bin/sh\nws=\"$1\"\nread -r _charter\nprintf 'SENTINEL\\n' > \"$ws/f.txt\"\nprintf 'x\\n' > \"$ws/invented.txt\"\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"both rewrote it\",\"reconciliation\":\"kept both\"}],\"notes\":\"done\"}'\n";
        let temp = conflicted_repo(smuggler);
        let repo = temp.path();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let ctx = context(repo);
        let err = finish_join(&ctx, &outcome)
            .await
            .expect_err("an unexplained file cannot pass");
        assert!(err.contains("invented.txt"), "{err}");

        // …and the same run passes once the report owns up to it.
        let honest = "#!/bin/sh\nws=\"$1\"\nread -r _charter\nprintf 'SENTINEL\\n' > \"$ws/f.txt\"\nprintf 'x\\n' > \"$ws/invented.txt\"\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"both rewrote it\",\"reconciliation\":\"kept both\"},{\"path\":\"invented.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"neither had it\",\"reconciliation\":\"added, the merged code needs it\"}],\"notes\":\"done\"}'\n";
        let temp = conflicted_repo(honest);
        let repo = temp.path();
        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let ctx = context(repo);
        finish_join(&ctx, &outcome)
            .await
            .expect("an accounted-for file is fine");
    }

    /// An expired ask reaches the next resolver's charter, once.
    ///
    /// `QUESTION_DEADLINE`'s contract said the answer arrives on the next
    /// resolve; nothing implemented it, and every exit cleared the question.
    /// The conversation genuinely cannot resume, so the honest version is that
    /// the *question* is carried forward — and then consumed, so it is offered
    /// forward exactly once rather than to every resolve from here on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_expired_ask_reaches_the_next_charter_and_is_consumed() {
        let temp = conflicted_repo("#!/bin/sh\nexit 1\n");
        let repo = temp.path();
        let head = tugdash_core::ops::rev_parse(repo, "tugdash/demo").unwrap();

        tugdash_core::resolve::write_lastask(
            repo,
            "demo",
            &head,
            "Which side owns the retry budget?",
        );

        let intent = tugdash_core::resolve_intent(repo, "main", "tugdash/demo");
        assert!(
            intent.contains("Which side owns the retry budget?"),
            "the expired ask rides the next charter's corpus: {intent}"
        );
        assert!(intent.contains("got no answer"), "{intent}");

        // A resolve consumes it, so the one after does not re-ask on its behalf.
        let auditing = "#!/bin/sh\nws=\"$1\"\nread -r _charter\nprintf 'SENTINEL\\n' > \"$ws/f.txt\"\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"x\",\"reconciliation\":\"y\"}],\"notes\":\"\"}'\n";
        write_exec(&repo.join("stub-resolver.sh"), auditing);
        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        finish_join(&context(repo), &outcome)
            .await
            .expect("the resolve runs");

        assert!(
            tugdash_core::resolve::read_lastask(repo, "demo", &head).is_none(),
            "the ask was consumed by the charter that carried it"
        );
    }

    /// A resolver that reports without touching the tree is refused by marker
    /// validation, not believed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_resolver_that_touches_nothing_is_refused() {
        let touch_nothing = "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"x\",\"reconciliation\":\"y\"}],\"notes\":\"\"}'\n";
        let temp = conflicted_repo(touch_nothing);
        let repo = temp.path();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let ctx = context(repo);
        let err = finish_join(&ctx, &outcome)
            .await
            .expect_err("markers left behind are a refusal");
        assert!(err.contains("conflict markers remain"), "{err}");
        assert!(
            matches!(
                tugdash_core::resolve::candidate_status(repo, "demo", "main"),
                tugdash_core::resolve::CandidateStatus::None
            ),
            "a refused resolve anchors no candidate"
        );
    }

    /// A failed resolve gives the workshop back ([P07]).
    ///
    /// The failure leaves a stuck fact behind, which is where the account of it
    /// belongs. What it must not leave behind is the tree: a half-merged
    /// checkout with conflict markers in the files and a live `MERGE_HEAD`,
    /// sitting in `.tug/workshops/` until somebody happens to open it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_resolve_leaves_the_workshop_clean_at_base() {
        let touch_nothing = "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"x\",\"reconciliation\":\"y\"}],\"notes\":\"\"}'\n";
        let temp = conflicted_repo(touch_nothing);
        let repo = temp.path();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let ctx = context(repo);
        finish_join(&ctx, &outcome)
            .await
            .expect_err("the resolver touched nothing");

        let workshop = tugdash_core::workshop::workshop_path(repo, "demo");
        assert!(workshop.exists(), "the workshop itself survives its warmth");
        assert!(
            !workshop.join(".git/MERGE_HEAD").exists()
                && !workshop.join("../../.git/worktrees/demo/MERGE_HEAD").exists(),
            "no merge is still in flight"
        );
        let contents = std::fs::read_to_string(workshop.join("f.txt")).unwrap();
        assert!(
            !contents.contains("<<<<<<<"),
            "the tree is back at base, markers and all: {contents}"
        );
        let status = std::process::Command::new("git")
            .current_dir(&workshop)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&status.stdout).trim(),
            "",
            "and nothing is left modified"
        );
    }

    /// A workshop belongs to a dash, so a dash that is gone cannot grow one.
    ///
    /// The straggler this closes: a join tears the workshop down while a
    /// verification that started before it is still running, and the
    /// verification's next open re-creates the worktree and its branch as an
    /// orphan nothing will ever collect.
    #[test]
    fn a_torn_down_dash_cannot_have_its_workshop_reopened() {
        let temp = conflicted_repo("#!/bin/sh\nexit 0\n");
        let repo = temp.path();

        tugdash_core::workshop::Workshop::open_merge(repo, "demo")
            .expect("a live dash has a workshop");

        let mut warnings = Vec::new();
        tugdash_core::workshop::remove(repo, "demo", &mut warnings);
        git(repo, &["branch", "-D", "tugdash/demo"]);

        let err = match tugdash_core::workshop::Workshop::open_merge(repo, "demo") {
            Err(e) => e,
            Ok(_) => panic!("a gone dash refuses"),
        };
        assert!(err.contains("is gone"), "{err}");
        assert!(
            !tugdash_core::workshop::workshop_path(repo, "demo").exists(),
            "and nothing was created on the way to refusing"
        );
    }

    /// A report that skips a path in the resolution set is refused — the [P10]
    /// contract, enforced before anything is committed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_report_that_omits_a_resolved_path_is_refused() {
        let omitting = "#!/bin/sh\nws=\"$1\"\nread -r _charter\nprintf 'SENTINEL\\n' > \"$ws/f.txt\"\nprintf '%s\\n' '{\"files\":[],\"notes\":\"nothing to say\"}'\n";
        let temp = conflicted_repo(omitting);
        let repo = temp.path();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let ctx = context(repo);
        let err = finish_join(&ctx, &outcome)
            .await
            .expect_err("an unaccounted path is a refusal");
        assert!(err.contains("does not account for"), "{err}");
        assert!(err.contains("f.txt"), "{err}");
    }

    /// The escalation round trip: the resolver asks, the question reaches the
    /// card *and* the dash, the answer comes back verbatim, and the resolve
    /// finishes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_escalation_round_trips_and_the_resolve_finishes() {
        let asking = "#!/bin/sh\nws=\"$1\"\nread -r _charter\nprintf '%s\\n' '{\"ask\":{\"question\":\"Which name wins?\",\"options\":[{\"label\":\"the dash\"},{\"label\":\"the base\"}]}}'\nread -r answer\nprintf 'SENTINEL\\n' > \"$ws/f.txt\"\nprintf '%s\\n' '{\"files\":[{\"path\":\"f.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"both named it\",\"reconciliation\":\"took the answer\"}],\"notes\":\"asked first\"}'\n";
        let temp = conflicted_repo(asking);
        let repo = temp.path();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let ctx = context(repo);
        let mut frames = ctx.control_tx.subscribe();
        let resolve = tokio::spawn(async move { finish_join(&ctx, &outcome).await });

        // The question reaches the card as a CONTROL frame…
        let request_id = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let frame = frames.recv().await.expect("frames flow");
                let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                if body["action"] == "changeset_join_question" {
                    assert_eq!(body["question"], "Which name wins?");
                    assert_eq!(body["options"].as_array().unwrap().len(), 2);
                    return body["request_id"].as_str().unwrap().to_string();
                }
            }
        })
        .await
        .expect("the escalation is broadcast");

        // …and as a durable fact, so a reload re-renders it rather than losing
        // it and leaving the resolver waiting on nobody.
        let head = tugdash_core::ops::rev_parse(repo, "tugdash/demo").unwrap();
        let stored =
            tugdash_core::resolve::read_question(repo, "demo", &head).expect("a durable question");
        assert!(stored.contains("Which name wins?"), "{stored}");

        assert!(
            answer_question(&request_id, "the dash".to_string()),
            "the answer reaches the waiting resolve"
        );

        tokio::time::timeout(Duration::from_secs(30), resolve)
            .await
            .expect("the resolve finishes")
            .expect("the task lives")
            .expect("the resolve succeeds");

        // Answered, so the question stops standing.
        assert!(
            tugdash_core::resolve::read_question(repo, "demo", &head).is_none(),
            "an answered question does not keep standing"
        );

        // The report keeps the escalation — the question survives the dialog.
        let candidate = match tugdash_core::resolve::candidate_status(repo, "demo", "main") {
            tugdash_core::resolve::CandidateStatus::Valid(sha) => sha,
            other => panic!("expected a valid candidate, got {other:?}"),
        };
        let report =
            tugdash_core::resolve::read_report(repo, "demo", &candidate).expect("a report");
        assert!(report.contains("Which name wins?"), "{report}");
        assert!(report.contains("the dash"), "{report}");
    }

    /// An answer nobody is waiting for is refused, not swallowed — the control
    /// the user pressed has to produce an act or a reason ([L31]).
    #[test]
    fn an_answer_to_a_question_nobody_awaits_is_refused() {
        assert!(!answer_question("join-nobody-0", "anything".to_string()));
    }

    /// A resolver that cannot make the tree build spends its budget and sticks
    /// — with the failing command named, never silently.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_red_the_resolver_cannot_repair_sticks_after_the_budget() {
        let temp = conflicted_repo(&resolving_stub("NOTHING\n"));
        let repo = temp.path();

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let ctx = context(repo);
        let err = finish_join(&ctx, &outcome)
            .await
            .expect_err("an unrepairable red sticks");
        assert!(err.contains(&TIER0_ITERATIONS.to_string()), "{err}");

        // The verdict still stands, and still names the failing command — the
        // face's red has something to say.
        let fact = tugdash_core::verify::read_verification(repo, "demo").expect("a verdict");
        assert_eq!(fact.tier0, tugdash_core::verify::TierStatus::Red);
        assert!(
            fact.failures.iter().any(|f| f.contains("grep")),
            "{:?}",
            fact.failures
        );
    }

    /// A tier runner that dies between writing `running` and writing its
    /// answer leaves the verdict red naming the failure — never `running`.
    ///
    /// Driven by asking for a candidate that does not exist, so
    /// `Workshop::open_candidate` refuses after the `running` fact is already
    /// standing. A verdict stuck at `running` renders as a wait the face has no
    /// control for.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_tier_run_that_dies_leaves_the_verdict_red() {
        let temp = conflicted_repo(&resolving_stub("SENTINEL\n"));
        let repo = temp.path();
        let ctx = context(repo);

        let err = run_tier0(&ctx, "0000000000000000000000000000000000000000")
            .await
            .expect_err("a candidate that does not exist cannot be verified");

        let fact = tugdash_core::verify::read_verification(repo, "demo").expect("a verdict stands");
        assert_eq!(fact.tier0, tugdash_core::verify::TierStatus::Red);
        assert_eq!(
            fact.failures,
            vec![err],
            "the verdict carries the sentence the run failed with"
        );
    }

    /// A resolver that writes nothing at all is killed at its silence bound,
    /// and the resolve fails with a sentence naming it.
    ///
    /// The bound is the only liveness check anything applies to a resolver, so
    /// this drives the real driver loop with a short one rather than asserting
    /// against the constant.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_resolver_that_never_answers_is_stopped_at_its_silence_bound() {
        let temp = conflicted_repo("#!/bin/sh\nsleep 120\n");
        let repo = temp.path();
        // Take the config seam out so the injected spawner — the one carrying
        // the short bound — is what `spawner_for` picks.
        git(repo, &["config", "--unset", "tugdash.joinresolver"]);

        let mut ctx = context(repo);
        ctx.production = Some(Arc::new(StubJoinResolverSpawner {
            command: repo.join("stub-resolver.sh").to_string_lossy().to_string(),
            turn_timeout: Duration::from_millis(400),
        }));

        let outcome = tugdash_core::resolve_conflicts(repo, "demo", None).unwrap();
        let err = finish_join(&ctx, &outcome)
            .await
            .expect_err("a silent resolver cannot finish the join");
        assert!(err.contains("went silent"), "{err}");
    }

    #[test]
    fn the_tier0_failure_turn_carries_the_failing_detail() {
        let turn = compose_tier0_failure_turn(&["cargo check failed:\nerror[E0308]".to_string()]);
        assert!(turn.contains("Verification failed"));
        assert!(turn.contains("error[E0308]"));
        // An empty failure list still says something rather than nothing.
        assert!(compose_tier0_failure_turn(&[]).contains("no detail"));
    }
}

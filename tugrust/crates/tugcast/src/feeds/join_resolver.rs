//! The resolver: the agent that finishes a join ([P02], Specs S01/S02/S04).
//!
//! The resolution ladder ([`tugarc_core::resolve`]) works a conflict three
//! blobs at a time and stops where blob arithmetic stops. The resolver picks up
//! there, in the workshop ([`tugarc_core::workshop`]) where the merge is a
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
//!   configure a command in `tugarc.joinresolver` speaking the same two
//!   terminal shapes over plain stdio, exactly as the merge-driver rung already
//!   takes a `tugarc.mergedriver` stub one rung down.
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

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tugarc_core::ResolvedBy;

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
pub use tugcast_core::types::ArcJoinReport as ResolverReport;

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

An arc branch and its base branch have diverged, and an algorithmic ladder has
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
- You have no shell, and you get one pass. Resolve everything, then report.

# How you answer

Every turn you end must be **one JSON object and nothing else** — no prose
around it, no code fence, no explanation before or after.

To ask, end a turn with exactly:

    {"ask": {"question": "…", "options": [{"label": "…", "description": "…"}]}}

with 2 to 4 options. You may ask at most once.

To finish, end a turn with your report:

    {"files": [{"path": "…", "resolved_by": "…", "what_each_side_did": "…",
                "reconciliation": "…", "audit": "kept"}],
     "notes": "…"}

**Every path listed below — the ones you finished and the ones you audited —
must appear in `files`.** A report that omits one is rejected. Use `"audit":
"kept"` for a machine resolution you reviewed and accepted, `"audit": "redone"`
for one you replaced."#;

/// The case-specific facts appended to the charter.
pub struct CharterInputs<'a> {
    /// The intent corpus ([P08]) — draft, round subjects, plan, base motion,
    /// both sides' touched files.
    pub intent: &'a str,
    /// The base branch the arc is joining into.
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

    out.push_str("\n\n# What this arc is for\n\n");
    if inputs.intent.trim().is_empty() {
        out.push_str("(the arc recorded no intent beyond its commits)\n");
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

// ---------------------------------------------------------------------------
// The substrate seam ([P02], Spec S04)
// ---------------------------------------------------------------------------

/// One turn of a resolver conversation: a user message in, that turn's terminal
/// shape out.
pub struct ResolverTurnRequest {
    pub message: String,
    pub reply: oneshot::Sender<Result<ResolverTurn, String>>,
    /// Where the turn's own words and tool calls go while it works, when
    /// somebody is listening. A transport that has none to give ignores it.
    pub events: Option<mpsc::UnboundedSender<ResolverStreamEvent>>,
}

/// One thing the resolver said or did mid-turn, read off its stream.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolverStreamEvent {
    /// Assistant prose.
    Text(String),
    /// A tool call, with the file or pattern it names when it names one.
    Tool {
        name: String,
        target: Option<String>,
    },
}

/// What one stream-json frame says the resolver is doing.
///
/// Only `assistant` frames carry it: each `text` item is prose, each
/// `tool_use` item a call, named with the basename of the file or pattern it
/// targets. Every other frame, and any shape this does not recognise, says
/// nothing — the stream is a view of the work, never a contract on it.
pub fn resolver_stream_events(value: &serde_json::Value) -> Vec<ResolverStreamEvent> {
    if value.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return Vec::new();
    }
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|item| match item.get("type").and_then(|t| t.as_str()) {
            Some("text") => item
                .get("text")
                .and_then(|t| t.as_str())
                .filter(|t| !t.trim().is_empty())
                .map(|t| ResolverStreamEvent::Text(t.to_string())),
            Some("tool_use") => {
                let name = item.get("name").and_then(|n| n.as_str())?;
                let input = item.get("input");
                let target = ["file_path", "path", "pattern"]
                    .iter()
                    .find_map(|k| input.and_then(|i| i.get(*k)).and_then(|v| v.as_str()))
                    .map(|t| {
                        Path::new(t)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| t.to_string())
                    });
                Some(ResolverStreamEvent::Tool {
                    name: name.to_string(),
                    target,
                })
            }
            _ => None,
        })
        .collect()
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
    pub async fn send(
        &mut self,
        message: String,
        events: Option<mpsc::UnboundedSender<ResolverStreamEvent>>,
    ) -> Result<ResolverTurn, String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(ResolverTurnRequest {
                message,
                reply,
                events,
            })
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

/// Which spawner runs this repo's resolver: the `tugarc.joinresolver` stub
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
    if let Some(command) = tugarc_core::resolver_program(repo) {
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

    while let Some(ResolverTurnRequest {
        message,
        reply,
        events,
    }) = rx.recv().await
    {
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
                        // Not the turn's end, but possibly what the resolver
                        // is doing on the way to it: relayed, never waited on.
                        if let Some(sink) = &events {
                            for event in resolver_stream_events(&value) {
                                let _ = sink.send(event);
                            }
                        }
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
        let bin = parts.next().ok_or("tugarc.joinresolver is empty")?;
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
            .map_err(|e| format!("tugarc.joinresolver would not start: {e}"))?;
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

    // The stub's protocol is one line per terminal turn, so it has nothing to
    // relay mid-turn: the sink is dropped unused.
    while let Some(ResolverTurnRequest { message, reply, .. }) = rx.recv().await {
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

/// How long one resolver turn may produce no bytes at all before the child is
/// killed and the turn fails.
///
/// This is the only liveness check anything applies to the resolver, and it is
/// deliberately blunt: a healthy turn reads files, edits them, and thinks, so
/// its *statuses* are minutes apart and say nothing about whether it is alive.
/// Bytes on the wire do. Twenty minutes of complete silence is past any turn a
/// resolver is still working through and short of a wedge nobody would notice.
pub const RESOLVER_TURN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// The ceiling on one whole resolve, from opening the workshop to the anchored
/// candidate.
///
/// Every inner bound can be paid in full and still add up to a finite number:
/// one resolver turn plus one expired question is well inside it. This catches
/// whatever the inner bounds cannot — and names, in the stuck fact, what the
/// resolve was doing when it expired.
pub const RESOLVE_DEADLINE: Duration = Duration::from_secs(2 * 60 * 60);

/// What a turn that went silent is reported as.
fn silent_turn(bound: Duration) -> String {
    format!(
        "the resolver went silent for {}s and was stopped",
        bound.as_secs()
    )
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
            ("src/d.rs".to_string(), ResolvedBy::Ai),
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
        // A new rung reaches the charter with no edit here: the line is
        // rendered from `ResolvedBy::as_str`, so there is no rung-to-prose map
        // to keep in step and no way for one to fall behind.
        assert!(charter.contains("`src/d.rs` — resolved by the ai rung"));
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
            r#"{"ask":{"question":"Which name wins?","options":[{"label":"join","description":"the arc's"},{"label":"land","description":"the base's"}]}}"#,
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
            r#"{"files":[{"path":"a.txt","resolved_by":"resolver","what_each_side_did":"x","reconciliation":"y","audit":"kept"}],"notes":"done"}"#,
        )
        .unwrap();
        match report {
            ResolverTurn::Report(report) => {
                assert_eq!(report.files.len(), 1);
                assert_eq!(report.files[0].audit.as_deref(), Some("kept"));
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
        assert!(validate_report(&report, &["a.txt".to_string()], &["a.txt".to_string()]).is_ok());
    }

    /// Frames as `claude -p --output-format stream-json --verbose` writes them.
    fn frame(json: &str) -> serde_json::Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_text_frame_is_the_resolver_speaking() {
        let v = frame(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Reading Justfile at the candidate."}]}}"#,
        );
        assert_eq!(
            resolver_stream_events(&v),
            vec![ResolverStreamEvent::Text(
                "Reading Justfile at the candidate.".to_string()
            )]
        );
    }

    #[test]
    fn a_read_names_the_file_it_reads() {
        let v = frame(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/w/ws/Justfile"}}]}}"#,
        );
        assert_eq!(
            resolver_stream_events(&v),
            vec![ResolverStreamEvent::Tool {
                name: "Read".to_string(),
                target: Some("Justfile".to_string())
            }]
        );
    }

    #[test]
    fn mixed_content_keeps_its_order() {
        let v = frame(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Both sides edit the recipe."},{"type":"tool_use","name":"Grep","input":{"pattern":"capture"}},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
        );
        assert_eq!(
            resolver_stream_events(&v),
            vec![
                ResolverStreamEvent::Text("Both sides edit the recipe.".to_string()),
                ResolverStreamEvent::Tool {
                    name: "Grep".to_string(),
                    target: Some("capture".to_string())
                },
                ResolverStreamEvent::Tool {
                    name: "Bash".to_string(),
                    target: None
                },
            ]
        );
    }

    #[test]
    fn system_result_and_malformed_frames_say_nothing() {
        for json in [
            r#"{"type":"system","subtype":"init","session_id":"s"}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"{}"}"#,
            r#"{"type":"assistant","message":"not an object"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","input":{}}]}}"#,
        ] {
            assert!(resolver_stream_events(&frame(json)).is_empty(), "{json}");
        }
    }

    #[tokio::test]
    async fn the_stub_spawner_round_trips_a_scripted_resolve() {
        let (_temp, spawner) = stub(
            "#!/bin/sh\nread -r _charter\nprintf '%s\\n' '{\"files\":[{\"path\":\"a.txt\",\"resolved_by\":\"resolver\",\"what_each_side_did\":\"both renamed\",\"reconciliation\":\"kept both\"}],\"notes\":\"ok\"}'\n",
        );
        let workshop = tempfile::tempdir().unwrap();
        let mut run = ResolverRun::open(&spawner, workshop.path(), "model".into()).unwrap();

        let turn = run.send("charter".to_string(), None).await.unwrap();
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

        match run.send("charter".to_string(), None).await.unwrap() {
            ResolverTurn::Ask(ask) => assert_eq!(ask.question, "which?"),
            other => panic!("expected an ask, got {other:?}"),
        }
        match run.send("pick a".to_string(), None).await.unwrap() {
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
            run.send("charter".to_string(), None).await.unwrap(),
            ResolverTurn::Ask(_)
        ));
        let err = run
            .send("pick a".to_string(), None)
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
            .send("charter".to_string(), None)
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
            .send("charter".to_string(), None)
            .await
            .expect_err("a dead resolver is a failure, never a wait");
        assert!(err.contains("exited"), "{err}");
    }
}

//! `tugcast operator-ask` — the Operator, asked one question from a terminal.
//!
//! The Overview's answers are only as good as what the ledger lets the Operator
//! find, and until now the only way to test that was to type into the card and
//! read prose. This runs the same pipeline against a ledger you name, prints
//! every verb it chose and what came back, and exits on whether it answered —
//! so "does this question work now?" is a command rather than an impression.
//!
//! It is deliberately the *same* pipeline: `operator::run_question` is shared
//! with the feed, because an instrument that ran a reimplementation would
//! verify the reimplementation. What differs is only the ends — no post is
//! written, nothing is broadcast, and the rounds print instead of being logged
//! alone.
//!
//! **Point `--db` at a copy.** `just db-inspect` makes one. Opening a ledger
//! also runs any pending schema migration on it, which is worth knowing before
//! the file is one somebody is still using.

use std::path::Path;
use std::sync::Arc;

use crate::cli::OperatorAskArgs;
use crate::feeds::{operator, overview_agent};
use crate::session_ledger::SessionLedger;
use crate::shared_agent;
use crate::shell_ledger::ShellLedger;

/// One worker: a single question is one job at a time, so a pool wider than
/// this would only reserve capacity nothing asks for.
const MAX_WORKERS: usize = 1;

pub async fn run(args: &OperatorAskArgs) -> i32 {
    // Deliberately NOT `SessionLedger::open`: that attaches the machine-global
    // `changes.db`, which on a developer's machine is the live one a running
    // instance holds the writer claim on. This constructor attaches a
    // `<db>.changes` sibling instead, so the whole run reads files you named
    // and nothing else. Copy the real `changes.db` to that sibling path if you
    // want the `changes.*` verbs to have anything to say.
    let ledger = match SessionLedger::open_with_claude_root(&args.db, claude_projects_root()) {
        Ok(ledger) => Arc::new(ledger),
        Err(error) => {
            eprintln!("operator-ask: cannot open {}: {error}", args.db.display());
            return 1;
        }
    };

    let shell_ledger = match args.shell_db.as_deref() {
        Some(path) => match ShellLedger::open(path) {
            Ok(ledger) => Some(Arc::new(ledger)),
            Err(error) => {
                eprintln!("operator-ask: cannot open {}: {error}", path.display());
                return 1;
            }
        },
        None => None,
    };

    let ctx = operator::OperatorContext {
        ledger,
        shell_ledger,
        bootstrap_project_dir: args.project_dir.clone(),
        // Nothing here attaches an image, so this directory is never created.
        // It is beside the ledger anyway, where a running instance keeps it.
        attachments_dir: parent_of(&args.db).join("overview-attachments"),
        // The instrument carries the expansion pool for the same reason it
        // runs the real pipeline: a question that only the [P09] rung can
        // answer is exactly the kind this command exists to try. Building the
        // pool spawns nothing — the first job of a class spawns its worker, so
        // a run where no search comes back empty never pays for one.
        haiku: Some(shared_agent::SharedAgentPool::new(
            shared_agent::AgentSpec {
                name: "haiku",
                model: Arc::new(|| shared_agent::HAIKU_MODEL.to_string()),
                jobs: shared_agent::HAIKU_AGENT_JOBS,
                max_workers: MAX_WORKERS,
            },
            Arc::new(shared_agent::ClaudeAgentWorkerSpawner),
        )),
    };

    let model = args
        .model
        .clone()
        .unwrap_or_else(|| overview_agent::DEFAULT_MODEL.to_string());
    println!("model: {model}");
    println!("question: {}\n", args.question);
    let pool = overview_agent::build_pool(Arc::new(move || model.clone()), MAX_WORKERS);

    let show_rounds = args.show_rounds;
    let observer = move |round: usize,
                         request: &operator::VerbRequest,
                         outcome: &Result<serde_json::Value, String>| {
        match outcome {
            Ok(value) => {
                let size = match value.get("count").and_then(serde_json::Value::as_u64) {
                    Some(count) => format!("{count} row(s)"),
                    None => format!("{} bytes", value.to_string().len()),
                };
                println!(
                    "  round {round}: {} {} → {size}",
                    request.verb, request.args
                );
                // `query_used` is the one field worth surfacing without
                // `--show-rounds`: it is how you see the recovery ladder fire.
                if let Some(used) = value.get("query_used").and_then(serde_json::Value::as_str) {
                    println!("             query_used: {used}");
                }
                if let Some(note) = value.get("note").and_then(serde_json::Value::as_str) {
                    println!("             note: {note}");
                }
                if show_rounds {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
                    );
                }
            }
            Err(error) => println!(
                "  round {round}: {} {} → error: {error}",
                request.verb, request.args
            ),
        }
    };

    // The pointing gesture, through the same verifier the feed uses — a ref
    // that does not resolve is dropped here exactly as it would be in the app,
    // and saying which survived is what keeps a replay honest about whether it
    // measured the seeded path or the bare one.
    let mentions = operator::verify_question_refs(
        &ctx.bootstrap_project_dir,
        &args
            .refs
            .iter()
            .map(|target| operator::QuestionRef {
                kind: "file".to_string(),
                target: target.clone(),
            })
            .collect::<Vec<_>>(),
    )
    .await;
    if !args.refs.is_empty() {
        println!(
            "NAMED FILES: {}",
            if mentions.is_empty() {
                "none verified".to_string()
            } else {
                mentions
                    .iter()
                    .map(|m| m.path.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        );
    }

    match operator::run_question(&ctx, &pool, &args.question, &[], &mentions, Some(&observer)).await
    {
        Ok((post, _context)) => {
            println!("\nANSWER:\n{}", post.body);
            if !post.refs.is_empty() {
                println!("\nREFS:");
                for r in &post.refs {
                    println!("  {} {}", r.kind.as_str(), r.target);
                }
            }
            0
        }
        Err(error) => {
            eprintln!("\noperator-ask: {error}");
            1
        }
    }
}

/// Where the ledger resolves session transcripts. Nothing this command runs
/// reads one, but the constructor that keeps the changes attachment local is
/// also the one that wants this named explicitly.
fn claude_projects_root() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
        .join(".claude/projects")
}

/// Where the ledger sits — the copy's own directory, never the instance's.
fn parent_of(db: &Path) -> std::path::PathBuf {
    db.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

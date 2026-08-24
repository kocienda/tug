//! operator — the Overview's read-only verb executor.
//!
//! The Operator model never touches the machine. It emits verb *requests*
//! (Spec S02) and this module runs them: ledger reads over the session ledger,
//! and `git` subprocesses in a project dir resolved from the ledger. Every
//! verb is read-only, output-capped, and bounded by a wall-clock timeout, so
//! the worst a confused model can do is ask for something that comes back
//! empty.
//!
//! Three properties are structural rather than conventional, and each has a
//! test standing on it:
//!
//! - **Nothing the model writes reaches a shell.** Arguments are pushed onto
//!   an argv one at a time — there is no string interpolation anywhere in this
//!   file, so there is no quoting to get wrong. Beyond that, model-supplied
//!   strings that reach a git argv must not be flag-shaped: `-S`, `--upload-
//!   pack=…` and their relatives are rejected at the argument gate rather than
//!   handed to git to interpret.
//! - **Every result is capped before it is returned**, because the results are
//!   about to become the answering model's input and an uncapped `git show` of
//!   a vendored-dependency bump would displace the question itself.
//! - **A verb never fails the pipeline.** An unknown name, a missing argument,
//!   a malformed FTS query: all come back as `Err(String)`, which the caller
//!   packs into the results so the model reads its own mistake and tries
//!   something else.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::TimeZone;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::process::Command;
use tracing::{info, warn};

use crate::feeds::facts_library;
use crate::feeds::repo_files;
use crate::search_tokens::{expand_subwords, relax_or, sanitize_fts_query};
use crate::session_ledger::{
    FactRow, FactSearchFilter, FactSearchHit, OverviewSearchFilter, SessionLedger, SessionRow,
};
use crate::shared_agent::TurnImage;
use crate::shell_ledger::ShellLedger;
use tugcast_core::types::{
    OverviewAttachment, OverviewAuthor, OverviewPost, OverviewRef, OverviewRefKind,
};

// MARK: - Caps

/// Per-verb wall clock. A ledger read that takes ten seconds is a wedged
/// database, and a `git log` that takes ten seconds is a repository the
/// Operator cannot help with in the time someone will wait.
pub const VERB_TIMEOUT: Duration = Duration::from_secs(10);

const SEARCH_LIMIT: usize = 20;
const WINDOW_MAX_N: usize = 10;
const SESSIONS_LIMIT: usize = 50;
const PROMPTS_LIMIT: usize = 50;
const CHANGES_LIMIT: usize = 200;
const GIT_LOG_MAX_N: usize = 30;
const GIT_LOG_DEFAULT_N: usize = 20;
const GIT_SHOW_MAX_LINES: usize = 400;
const GIT_SHOW_MAX_BYTES: usize = 16 * 1024;
const GREP_MAX_MATCHES: usize = 100;
/// `repo.read`'s caps. Deliberately the same numbers `git.show` uses: both
/// results land in the same answering turn, so a second cap vocabulary for the
/// same consumer would be two ways to say one thing.
const READ_MAX_LINES: usize = GIT_SHOW_MAX_LINES;
const READ_MAX_BYTES: usize = GIT_SHOW_MAX_BYTES;
/// Lines either side of `around_line` when the model names no width. Forty is
/// a screenful of context around a grep hit — enough to read a decision and
/// the drawing under it, well inside the line cap.
const READ_CONTEXT_DEFAULT: i64 = 40;
/// `repo.outline`'s entry cap. Two hundred rows is a map of the largest file
/// in this repository; past that the map costs more context than the read it
/// was meant to save.
const OUTLINE_MAX_ENTRIES: usize = 200;
const FACTS_SEARCH_LIMIT: usize = 30;
const FACTS_LIST_LIMIT: usize = 30;
const FACTS_WINDOW_MAX_N: usize = 20;
const FACTS_PROMPT_LIMIT: usize = 200;
const SHELL_HISTORY_LIMIT: usize = 50;
const SHELL_OUTPUT_MAX_CHARS: usize = 240;

/// Incipit length for a session's title/last-prompt in `sessions.list`. Long
/// enough to recognize the session, short enough that fifty of them are a
/// list rather than a wall.
const INCIPIT_CHARS: usize = 120;

// MARK: - Context

/// What a verb needs to run: the ledger it reads, and the project dir to use
/// when a question names no session ([Q03]).
pub struct OperatorContext {
    pub ledger: Arc<SessionLedger>,
    /// The `$`-route command history, from the same handle the shell dispatcher
    /// holds. Absent in a build with no shell ledger, which reads as "no
    /// command history to search".
    pub shell_ledger: Option<Arc<ShellLedger>>,
    /// The `--source-tree` dir `main.rs` resolves at startup — the repo a
    /// question means when it doesn't say.
    pub bootstrap_project_dir: PathBuf,
    /// Where an attached image's bytes come to rest — one file per image,
    /// beside the ledger rather than inside it. Created on first write.
    pub attachments_dir: PathBuf,
    /// The Haiku pool, for the search ladder's last rung ([P09]).
    ///
    /// `Option` because most construction sites have no pool and want none:
    /// the verb fixtures, and `operator-ask`, which builds only the Overview's
    /// own pool. `None` means the rung is skipped and an unanswerable search
    /// returns empty exactly as it did before — the degradation is the
    /// default, not the exception.
    pub haiku: Option<Arc<crate::shared_agent::SharedAgentPool>>,
}

/// Every verb the Operator may name. The retrieval instructions list the same
/// thirteen; a test pins the two lists against each other so a verb can never
/// be offered to the model without an executor behind it.
pub const VERB_NAMES: &[&str] = &[
    "overview.search",
    "overview.window",
    "facts.search",
    "facts.list",
    "facts.window",
    "shell.history",
    "sessions.list",
    "session.prompts",
    "changes.for_session",
    "changes.for_path",
    "git.log",
    "git.show",
    "repo.grep",
    "repo.ls",
    "repo.read",
    "repo.outline",
];

// MARK: - Entry point

/// Run one verb and return its results as JSON.
///
/// The error side is a message written for the model, not for a log: it says
/// what was wrong with the request so the next round can fix it.
pub async fn run_verb(ctx: &OperatorContext, name: &str, args: &Value) -> Result<Value, String> {
    if !args.is_object() && !args.is_null() {
        return Err(format!("{name}: args must be a JSON object"));
    }
    match tokio::time::timeout(VERB_TIMEOUT, dispatch(ctx, name, args)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "{name}: timed out after {}s",
            VERB_TIMEOUT.as_secs()
        )),
    }
}

async fn dispatch(ctx: &OperatorContext, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "overview.search" => overview_search(ctx, args).await,
        "overview.window" => overview_window(ctx, args),
        "facts.search" => facts_search(ctx, args).await,
        "facts.list" => facts_list(ctx, args),
        "facts.window" => facts_window(ctx, args),
        "shell.history" => shell_history(ctx, args),
        "sessions.list" => sessions_list(ctx, args),
        "session.prompts" => session_prompts(ctx, args),
        "changes.for_session" => changes_for_session(ctx, args),
        "changes.for_path" => changes_for_path(ctx, args),
        "git.log" => git_log(ctx, args).await,
        "git.show" => git_show(ctx, args).await,
        "repo.grep" => repo_grep(ctx, args).await,
        "repo.ls" => repo_ls(ctx, args).await,
        "repo.read" => repo_read(ctx, args).await,
        "repo.outline" => repo_outline(ctx, args).await,
        other => Err(format!(
            "unknown verb {other:?}; the verbs are: {}",
            VERB_NAMES.join(", ")
        )),
    }
}

// MARK: - Argument reading

fn opt_str<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(format!("argument {key:?} must be a string")),
    }
}

fn req_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    opt_str(args, key)?.ok_or_else(|| format!("argument {key:?} is required"))
}

fn opt_i64(args: &Value, key: &str) -> Result<Option<i64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("argument {key:?} must be a whole number")),
        Some(_) => Err(format!("argument {key:?} must be a number")),
    }
}

fn opt_bool(args: &Value, key: &str) -> Result<Option<bool>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("argument {key:?} must be true or false")),
    }
}

// MARK: - The argument gate

/// Reject a model-supplied string that would reach a git argv as a flag.
///
/// git has no shortage of arguments that run code or reach the network —
/// `--upload-pack`, `--output`, `-S` in the wrong position — and the only
/// robust defense is that a value which *looks* like an option never becomes
/// one. Control characters go too: a newline in an argv is not an injection
/// here, but it is always a mistake, and rejecting it keeps the results
/// parseable.
fn plain_arg(value: &str, what: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!(
            "{what} may not begin with '-'; option-shaped values are refused"
        ));
    }
    if value.contains(['\0', '\n', '\r']) {
        return Err(format!("{what} may not contain control characters"));
    }
    Ok(())
}

/// A repo-relative path from the model. Not canonicalized — per the plan's
/// [L29] boundary it is an immediate operand, never a key — but confined:
/// absolute paths and `..` traversal are refused so a path argument cannot
/// address anything outside the resolved project dir.
fn path_arg(value: &str, what: &str) -> Result<(), String> {
    plain_arg(value, what)?;
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(format!("{what} must be repo-relative"));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("{what} may not contain '..'"));
    }
    Ok(())
}

/// A commit-ish. Hex only: it is what a sha is, and it happens to be the
/// tightest possible refusal of everything a sha is not.
fn sha_arg(value: &str) -> Result<(), String> {
    let ok = (4..=64).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(format!(
            "sha {value:?} is not a hex object name (4-64 hex digits)"
        ))
    }
}

// MARK: - Project dir resolution ([Q03])

/// The repo a verb runs in: the named session's project dir, or the bootstrap
/// workspace's when the question named no session.
fn project_dir(ctx: &OperatorContext, args: &Value) -> Result<PathBuf, String> {
    let Some(session_id) = opt_str(args, "session_id")? else {
        return Ok(ctx.bootstrap_project_dir.clone());
    };
    match ctx.ledger.get(session_id) {
        Ok(Some(row)) => Ok(PathBuf::from(row.project_dir)),
        Ok(None) => Err(format!("no session {session_id:?} in the ledger")),
        Err(err) => Err(format!("session lookup failed: {err}")),
    }
}

// MARK: - Ledger verbs

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

fn post_json(post: &tugcast_core::types::OverviewPost) -> Value {
    json!({
        "id": post.id,
        "at_ms": post.at_ms,
        "author": post.author.as_str(),
        "session_id": post.session_id,
        "wake_reason": post.wake_reason,
        "body": post.body,
        "refs": post.refs.iter().map(|r| json!({"kind": r.kind.as_str(), "target": r.target}))
            .collect::<Vec<_>>(),
    })
}

/// Run a search, and when it comes back empty, retry with progressively looser
/// queries before handing the caller nothing.
///
/// A model round is the scarcest thing in the pipeline — there are two, by
/// design — and an empty page spends one on nothing. A Rust retry costs
/// microseconds, so the system tries the obvious relaxations itself: the terms
/// OR-ed instead of AND-ed, then each term OR-ed with its own sub-words.
/// Whatever produced the rows is reported back as `query_used`, and a rung that
/// fired says so, because a loose match presented as an exact one is worse than
/// no match at all.
fn search_with_recovery<T>(
    raw: &str,
    noun: &str,
    mut run: impl FnMut(&str) -> Result<Vec<T>, String>,
) -> Result<(Vec<T>, String, Option<String>), String> {
    let Some(sanitized) = sanitize_fts_query(raw) else {
        // Nothing searchable in the query at all; there is no expression to run
        // and nothing to relax.
        return Ok((Vec::new(), raw.trim().to_string(), None));
    };
    let rows = run(&sanitized)?;
    if !rows.is_empty() {
        return Ok((rows, sanitized, None));
    }
    let ladder = [
        (
            relax_or(raw),
            format!("no {noun} matched the full query; showing matches for any term"),
        ),
        (
            expand_subwords(raw),
            format!("no {noun} matched those words; showing matches for their sub-words"),
        ),
    ];
    for (query, note) in ladder {
        let Some(query) = query else { continue };
        let rows = run(&query)?;
        if !rows.is_empty() {
            return Ok((rows, query, Some(note)));
        }
    }
    Ok((Vec::new(), sanitized, None))
}

/// What a search says when the terms it matched on came from a model rather
/// than from the question ([P09]).
const MODEL_TERMS_NOTE: &str =
    "nothing matched the question's own words; showing matches for model-suggested terms";

/// At most this many expansion terms reach SQL. The instructions ask for 3–8;
/// this is the cap that holds when a model ignores them.
const EXPANSION_TERM_CAP: usize = 8;

#[derive(Debug, Deserialize)]
struct TermsEnvelope {
    terms: Vec<String>,
}

/// Ladder rung 3: ask Haiku for words the record would actually contain, and
/// build one more OR query out of them ([P09], Spec S06).
///
/// This is the first place the verb executor touches a model, and every bound
/// on it is deliberate: it fires only after two lexical rungs have already
/// returned nothing, at most once per verb call, on a pool whose own job
/// ceiling (6 s) sits inside [`VERB_TIMEOUT`] (10 s). Every failure — no pool,
/// a pool error, a timeout, prose where JSON was asked for, an empty list — is
/// the same `None`, which puts the caller back on the honest empty result it
/// already had.
///
/// The terms are model-written strings on their way to an FTS5 MATCH, so they
/// go through `sanitize_fts_query` exactly like a model-written query does.
/// Nothing here is interpolated raw.
async fn expand_via_model(ctx: &OperatorContext, question: &str) -> Option<String> {
    let pool = ctx.haiku.as_ref()?;
    let raw = match pool.run("expand_query", question.to_string()).await {
        Ok(raw) => raw,
        Err(err) => {
            warn!(error = %err, "overview operator: query expansion unavailable");
            return None;
        }
    };
    let terms = crate::feeds::observer_wake::json_object_spans(raw.trim())
        .into_iter()
        .rev()
        .find_map(|span| serde_json::from_str::<TermsEnvelope>(span).ok())
        .map(|envelope| envelope.terms)
        // An unreadable turn is the same answer as an empty list: nothing to
        // suggest. There is no round to spend on asking again.
        .unwrap_or_default();
    let expressions: Vec<String> = terms
        .iter()
        .take(EXPANSION_TERM_CAP)
        .filter_map(|term| {
            // Reduce a term to words before sanitizing. Punctuation carries no
            // search value, and lowercasing puts the result out of reach of the
            // pass-through path — a term is never allowed to be FTS5 syntax the
            // way a model-written *query* is, because nobody is reading the
            // error it could cause.
            let words: String = term
                .chars()
                .map(|c| if c.is_alphanumeric() { c } else { ' ' })
                .collect::<String>()
                .to_lowercase();
            sanitize_fts_query(&words)
        })
        .collect();
    if expressions.is_empty() {
        return None;
    }
    Some(expressions.join(" OR "))
}

async fn overview_search(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let query = req_str(args, "query")?;
    let author = match opt_str(args, "author")? {
        Some(raw) => Some(
            OverviewAuthor::parse(raw)
                .ok_or_else(|| format!("author {raw:?} is not observer, operator, or user"))?,
        ),
        None => None,
    };
    let filter = OverviewSearchFilter {
        author,
        session_id: opt_str(args, "session_id")?.map(str::to_string),
        since_ms: opt_i64(args, "since_ms")?,
        until_ms: opt_i64(args, "until_ms")?,
    };
    let search = |expr: &str| {
        ctx.ledger
            .search_overview_posts(expr, &filter, SEARCH_LIMIT)
            // An unbalanced quote or a bare `AND` is the model's error to see,
            // not a failure to hide: FTS5 says exactly what it disliked. Only a
            // query the model wrote in FTS5 can reach here — a sanitized one
            // cannot syntax-error.
            .map_err(|err| format!("overview.search: {err}"))
    };
    let (mut hits, mut query_used, mut note) = search_with_recovery(query, "posts", search)?;
    if hits.is_empty()
        && let Some(expanded) = expand_via_model(ctx, query).await
    {
        let expanded_hits = search(&expanded)?;
        if !expanded_hits.is_empty() {
            hits = expanded_hits;
            query_used = expanded;
            note = Some(MODEL_TERMS_NOTE.to_string());
        }
    }
    let rows: Vec<Value> = hits
        .iter()
        .map(|hit| {
            let mut row = post_json(&hit.post);
            row["excerpt"] = json!(truncate(&hit.excerpt, 240));
            row
        })
        .collect();
    let mut out = json!({ "posts": rows, "count": rows.len(), "query_used": query_used });
    if let Some(note) = note {
        out["note"] = json!(note);
    }
    Ok(out)
}

fn overview_window(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let post_id = opt_i64(args, "post_id")?.ok_or("argument \"post_id\" is required")?;
    let n = opt_i64(args, "n")?
        .unwrap_or(3)
        .clamp(0, WINDOW_MAX_N as i64) as usize;
    let posts = ctx
        .ledger
        .overview_posts_window(post_id, n)
        .map_err(|err| format!("overview.window: {err}"))?;
    let rows: Vec<Value> = posts.iter().map(post_json).collect();
    Ok(json!({ "posts": rows, "count": rows.len() }))
}

/// A named session the Operator may not read ([P05]).
///
/// The verbs that take a `session_id` and read through it answer as if the
/// session were not in the ledger, which is what "excluded from the channel"
/// means from the desk's side: `sessions.list` does not show it, so a question
/// that names it anyway gets the same answer as one naming a stranger. The
/// reads that scan across sessions need no gate here — their SQL carries the
/// `NOT EXISTS` exclusion.
fn refuse_if_private(ctx: &OperatorContext, verb: &str, session_id: &str) -> Result<(), String> {
    match ctx.ledger.is_session_private(session_id) {
        Ok(true) => Err(format!("no session {session_id:?} in the ledger")),
        Ok(false) => Ok(()),
        Err(err) => Err(format!("{verb}: {err}")),
    }
}

// MARK: - The library desk

/// One fact as the model reads it: the stored rendering, the handles a
/// follow-up question would name, and the depth behind the line.
///
/// `text` remains the one canonical rendering — the string FTS indexes and the
/// Observer prints, so every surface describes a fact the same way ([P02]).
/// The raw payload is still absent, and deliberately: it is the recorder's
/// structured form, and a prompt's runs to kilobytes. What crosses instead is
/// `detail`, the curated per-kind projection composed beside `render_text`
/// ([P04]) — a commit's file list, a test run's totals — capped, named, and
/// omitted entirely when there is nothing to project.
fn fact_json(fact: &FactRow) -> Value {
    let mut out = json!({
        "id": fact.id,
        "at_ms": fact.at_ms,
        "kind": fact.kind,
        "session_id": fact.session_id,
        "subject": fact.subject,
        "text": fact.text,
    });
    let detail = facts_library::FactKind::parse(&fact.kind).and_then(|kind| {
        serde_json::from_str::<Value>(&fact.payload)
            .ok()
            .and_then(|payload| facts_library::render_detail(kind, &payload))
    });
    if let Some(detail) = detail {
        out["detail"] = detail;
    }
    out
}

async fn facts_search(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let query = req_str(args, "query")?;
    let kind = opt_str(args, "kind")?.map(str::to_string);
    let aimed_at_a_kind = kind.is_some();
    let filter = FactSearchFilter {
        kind,
        session_id: opt_str(args, "session_id")?.map(str::to_string),
        since_ms: opt_i64(args, "since_ms")?,
        until_ms: opt_i64(args, "until_ms")?,
    };
    // Overfetch so the budgeter has minority-kind rows to FIND. Without the
    // wider read there is nothing to balance: a page already spent on one kind
    // is spent.
    let fetch = if aimed_at_a_kind {
        FACTS_SEARCH_LIMIT
    } else {
        FACTS_SEARCH_LIMIT * KIND_BUDGET_OVERFETCH
    };
    let search = |expr: &str| {
        ctx.ledger
            .search_facts(expr, &filter, fetch)
            // Same posture as `overview.search`: FTS5 says what it disliked
            // about the query, and the model reads its own mistake.
            .map_err(|err| format!("facts.search: {err}"))
    };
    let (mut hits, mut query_used, mut rung_note) = search_with_recovery(query, "facts", search)?;
    // Rung 3, and only here: the lexical ladder has already come back empty,
    // so the alternative to asking a model is returning nothing.
    if hits.is_empty()
        && let Some(expanded) = expand_via_model(ctx, query).await
    {
        let expanded_hits = search(&expanded)?;
        if !expanded_hits.is_empty() {
            hits = expanded_hits;
            query_used = expanded;
            rung_note = Some(MODEL_TERMS_NOTE.to_string());
        }
    }

    // An explicit `kind` is the caller having already made the choice the
    // budgeter exists to avoid making for them.
    let (hits, budget_note) = if aimed_at_a_kind {
        (hits, None)
    } else {
        budget_by_kind(hits, FACTS_SEARCH_LIMIT)
    };

    let rows: Vec<Value> = hits
        .iter()
        .map(|hit| {
            let mut row = fact_json(&hit.fact);
            row["excerpt"] = json!(truncate(&hit.excerpt, 240));
            row
        })
        .collect();
    let mut out = json!({ "facts": rows, "count": rows.len(), "query_used": query_used });
    // Both notes can be true at once — a relaxed query that then matched more
    // than one kind — and the caller needs each of them.
    let notes: Vec<String> = [rung_note, budget_note].into_iter().flatten().collect();
    if !notes.is_empty() {
        out["note"] = json!(notes.join(" "));
    }
    Ok(out)
}

/// Spend a result page across the fact kinds that matched, so one loud kind
/// cannot take all of it.
///
/// The failure this answers is concrete: "what was the recent commit where we
/// tried to regularize tooltip colors" matched 39 facts, and the top 30 by
/// bm25 were 28 `shell` facts — the greps that session itself ran — because a
/// shell command that literally contains the query word outranks a commit
/// subject that merely describes it. No static column weight fixes that
/// without breaking the symmetric question ("which command did we run"), since
/// which kind matters is the *question's* knowledge, not the ledger's.
///
/// Budgeting sidesteps the guess. It guarantees representation, never
/// precedence: rank order is preserved throughout, a kind is capped only while
/// some other kind still has unpicked matches, and any leftover room is
/// refilled from the skipped rows in rank order. A single-kind result set
/// therefore passes through untouched.
fn budget_by_kind(hits: Vec<FactSearchHit>, limit: usize) -> (Vec<FactSearchHit>, Option<String>) {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for hit in &hits {
        *counts.entry(hit.fact.kind.as_str()).or_default() += 1;
    }
    if counts.len() < 2 {
        let mut hits = hits;
        hits.truncate(limit);
        return (hits, None);
    }

    let mut page: Vec<FactSearchHit> = Vec::with_capacity(limit.min(hits.len()));
    let mut skipped: Vec<FactSearchHit> = Vec::new();
    let mut taken: HashMap<String, usize> = HashMap::new();
    for hit in hits {
        let seen = taken.entry(hit.fact.kind.clone()).or_default();
        if *seen >= KIND_PAGE_CAP {
            skipped.push(hit);
            continue;
        }
        *seen += 1;
        page.push(hit);
    }
    // Rows past the page fall in with the capped ones rather than vanishing,
    // so the note below accounts for every row the caller does not get.
    if page.len() > limit {
        let tail = page.split_off(limit);
        skipped.extend(tail);
    }

    // Room left over goes back to the capped kinds rather than being wasted —
    // the cap is a floor for the minority, not a ceiling on the answer.
    let mut refilled = 0usize;
    for hit in &skipped {
        if page.len() >= limit {
            break;
        }
        page.push(hit.clone());
        refilled += 1;
    }

    let dropped = &skipped[refilled..];
    let mut by_kind: HashMap<&str, usize> = HashMap::new();
    for hit in dropped {
        *by_kind.entry(hit.fact.kind.as_str()).or_default() += 1;
    }
    // Name the kind the caller is missing the most of — that is the one worth
    // spending a `kind:` follow-up on.
    let note = by_kind
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(kind, n)| {
            format!(
                "results capped for balance: {n} more {kind} fact(s) matched; pass kind: \"{kind}\" to see them"
            )
        });
    (page, note)
}

/// Browse the fact base by kind, session, and time — the verb for "what
/// happened", where `facts.search` is the verb for "find facts about X".
///
/// Every argument is optional, so a bare call is legal and returns the newest
/// [`FACTS_LIST_LIMIT`] facts of every kind. That is a real answer to a real
/// question, and it is also mostly shell commands, which is why the
/// instructions teach aiming the verb rather than only reaching for it.
fn facts_list(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let facts = ctx
        .ledger
        .list_facts(
            opt_str(args, "kind")?,
            opt_str(args, "session_id")?,
            opt_i64(args, "since_ms")?,
            opt_i64(args, "until_ms")?,
            FACTS_LIST_LIMIT,
        )
        .map_err(|err| format!("facts.list: {err}"))?;
    let rows: Vec<Value> = facts.iter().map(fact_json).collect();
    Ok(json!({ "facts": rows, "count": rows.len() }))
}

fn facts_window(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let fact_id = opt_i64(args, "fact_id")?.ok_or("argument \"fact_id\" is required")?;
    let n = opt_i64(args, "n")?
        .unwrap_or(5)
        .clamp(0, FACTS_WINDOW_MAX_N as i64) as usize;
    let facts = ctx
        .ledger
        .facts_window(fact_id, n)
        .map_err(|err| format!("facts.window: {err}"))?;
    let rows: Vec<Value> = facts.iter().map(fact_json).collect();
    Ok(json!({ "facts": rows, "count": rows.len() }))
}

/// The `$`-route command history, verbatim.
///
/// The one verb that reads output as well as command: a `$` exchange's output
/// is already stored whole, and the excerpt is what makes "did that command
/// work" answerable without re-running it.
fn shell_history(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let Some(shell) = ctx.shell_ledger.as_deref() else {
        return Err("shell.history: this instance keeps no shell command history".to_string());
    };
    if let Some(session_id) = opt_str(args, "session_id")? {
        refuse_if_private(ctx, "shell.history", session_id)?;
    }
    let query = opt_str(args, "query")?;
    if let Some(query) = query {
        plain_arg(query, "query")?;
    }
    // The command history lives in its own database, so the privacy exclusion
    // cannot be written into the query the way it is for every session-ledger
    // read — the sessions table is not there to test against. The private ids
    // are carried over instead so the exclusion still happens *inside* the
    // query: filtering the returned page would let a private session's commands
    // spend the row cap and push public ones off the end of the answer. An
    // unreadable flag fails the verb rather than answering without it — the
    // wake-time posture, for the same reason.
    let excluded = ctx
        .ledger
        .private_session_ids()
        .map_err(|err| format!("shell.history: {err}"))?;
    let rows = shell
        .search_exchanges(
            opt_str(args, "session_id")?,
            query,
            opt_i64(args, "since_ms")?,
            opt_i64(args, "until_ms")?,
            &excluded,
            SHELL_HISTORY_LIMIT,
        )
        .map_err(|err| format!("shell.history: {err}"))?;
    let commands: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "command": row.command,
                "output_excerpt": truncate(&row.output, SHELL_OUTPUT_MAX_CHARS),
                "exit_code": row.exit_code,
                "cwd": row.cwd,
                "at_ms": row.settled_at_ms,
                "session_id": row.tug_session_id,
            })
        })
        .collect();
    Ok(json!({ "commands": commands, "count": commands.len() }))
}

fn sessions_list(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let rows = ctx
        .ledger
        .list_sessions_recent(
            opt_i64(args, "since_ms")?,
            opt_i64(args, "until_ms")?,
            opt_bool(args, "active")?.unwrap_or(false),
            SESSIONS_LIMIT,
        )
        .map_err(|err| format!("sessions.list: {err}"))?;
    let sessions: Vec<Value> = rows
        .iter()
        .map(|row| {
            // The title if it has one, otherwise the last thing the person
            // asked — either way, what makes the row recognizable.
            let incipit = row
                .name
                .as_deref()
                .or(row.last_user_prompt.as_deref())
                .map(|text| truncate(text, INCIPIT_CHARS));
            json!({
                "session_id": row.session_id,
                "incipit": incipit,
                // The callsign the answer's voice rule asks a session to be
                // named by, and the standing line saying what it is about —
                // which is what "which session was the one about X" wants.
                "tag": row.tag,
                "synopsis": row.synopsis.as_deref().map(|s| truncate(s, INCIPIT_CHARS)),
                "project_dir": row.project_dir,
                "created_at_ms": row.created_at,
                "last_used_at_ms": row.last_used_at,
                "turn_count": row.turn_count,
                "state": row.state.as_str(),
            })
        })
        .collect();
    Ok(json!({ "sessions": sessions, "count": sessions.len() }))
}

/// What the person asked in one session.
///
/// The prompt history comes from the facts library — every prompt, in full,
/// permanently — merged with the `turns` journal's still-pending submissions.
/// A session that predates the library has no `prompt` facts, and for it the
/// verb falls back to what the ledger alone can say (the session row's single
/// `last_user_prompt` snippet) and carries a note saying so, so an answer
/// built on one remembered prompt does not read as the whole history.
fn session_prompts(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let session_id = req_str(args, "session_id")?;
    refuse_if_private(ctx, "session.prompts", session_id)?;
    let query = opt_str(args, "query")?.map(str::to_lowercase);
    let row = ctx
        .ledger
        .get(session_id)
        .map_err(|err| format!("session.prompts: {err}"))?
        .ok_or_else(|| format!("no session {session_id:?} in the ledger"))?;
    let facts = ctx
        .ledger
        .list_facts_for_session_since(session_id, Some("prompt"), None, FACTS_PROMPT_LIMIT)
        .map_err(|err| format!("session.prompts: {err}"))?;
    let pending = ctx
        .ledger
        .list_pending_turns_for_session(session_id)
        .map_err(|err| format!("session.prompts: {err}"))?;

    let mut prompts: Vec<Value> = Vec::new();
    let mut push = |text: &str, at_ms: i64, pending: bool| {
        if let Some(needle) = query.as_deref()
            && !text.to_lowercase().contains(needle)
        {
            return;
        }
        if prompts.len() < PROMPTS_LIMIT {
            prompts.push(json!({
                "text": truncate(text, facts_library::PROMPT_TEXT_CAP),
                "at_ms": at_ms,
                "pending": pending,
            }));
        }
    };
    if facts.is_empty() {
        if let Some(last) = row.last_user_prompt.as_deref() {
            push(last, row.last_used_at, false);
        }
    } else {
        for fact in &facts {
            // The full prompt lives in the payload; `text` is the one-line
            // rendering, which is the wrong thing to answer this question with.
            let text = serde_json::from_str::<Value>(&fact.payload)
                .ok()
                .and_then(|p| p.get("text").and_then(Value::as_str).map(str::to_string));
            if let Some(text) = text {
                push(&text, fact.at_ms, false);
            }
        }
    }
    for turn in &pending {
        push(&turn.user_text, turn.created_at, true);
    }
    let mut out = json!({
        "session_id": session_id,
        "prompts": prompts,
        "turn_count": row.turn_count,
    });
    if facts.is_empty() {
        out["note"] = json!(
            "this session predates the facts library: only the last prompt \
             plus anything still in flight is stored"
        );
    }
    Ok(out)
}

fn changes_for_session(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let session_id = req_str(args, "session_id")?;
    refuse_if_private(ctx, "changes.for_session", session_id)?;
    let events = ctx
        .ledger
        .list_file_events_for_session(session_id, CHANGES_LIMIT)
        .map_err(|err| format!("changes.for_session: {err}"))?;
    let changes: Vec<Value> = events
        .iter()
        .map(|e| {
            json!({
                "path": e.file_path,
                "op": e.op,
                "origin": e.origin,
                "at_ms": e.at,
            })
        })
        .collect();
    Ok(json!({ "session_id": session_id, "changes": changes, "count": changes.len() }))
}

fn changes_for_path(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let pattern = req_str(args, "pattern")?;
    let events = ctx
        .ledger
        .list_file_events_for_path_pattern(
            pattern,
            opt_i64(args, "since_ms")?,
            opt_i64(args, "until_ms")?,
            CHANGES_LIMIT,
        )
        .map_err(|err| format!("changes.for_path: {err}"))?;
    let changes: Vec<Value> = events
        .iter()
        .map(|e| {
            json!({
                "path": e.file_path,
                "op": e.op,
                "origin": e.origin,
                "at_ms": e.at,
                "session_id": e.tug_session_id,
            })
        })
        .collect();
    Ok(json!({ "pattern": pattern, "changes": changes, "count": changes.len() }))
}

// MARK: - Git verbs

/// Run `git` in `dir` and return its stdout, or a message naming what failed.
///
/// `kill_on_drop` matters: the caller's timeout drops this future, and without
/// it a wedged `git grep` over a huge tree would keep running after nobody is
/// listening.
pub(crate) async fn run_git(dir: &Path, args: &[String]) -> Result<String, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args).kill_on_drop(true);
    let output = cmd
        .output()
        .await
        .map_err(|err| format!("git could not be run: {err}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    // `git grep` exits 1 with empty output when it simply matched nothing;
    // that is an answer, not a failure.
    if output.stdout.is_empty() && output.stderr.is_empty() {
        return Ok(String::new());
    }
    Err(format!(
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// Field and record separators. ASCII unit/record separators cannot appear in
/// a commit subject the way a `|` or a tab can, so parsing is exact rather
/// than heuristic.
const GIT_FIELD: char = '\x1f';
const GIT_RECORD: char = '\x1e';

async fn git_log(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let dir = project_dir(ctx, args)?;
    let n = opt_i64(args, "n")?
        .unwrap_or(GIT_LOG_DEFAULT_N as i64)
        .clamp(1, GIT_LOG_MAX_N as i64);

    let mut argv: Vec<String> = vec![
        "log".into(),
        "--no-color".into(),
        "--date=short".into(),
        format!("--pretty=format:{GIT_RECORD}%H{GIT_FIELD}%ad{GIT_FIELD}%s"),
        "--name-only".into(),
        format!("-n{n}"),
    ];
    if let Some(grep) = opt_str(args, "grep")? {
        plain_arg(grep, "grep")?;
        argv.push(format!("--grep={grep}"));
    }
    if let Some(pickaxe) = opt_str(args, "pickaxe")? {
        plain_arg(pickaxe, "pickaxe")?;
        argv.push(format!("-S{pickaxe}"));
    }
    if let Some(since) = opt_str(args, "since")? {
        plain_arg(since, "since")?;
        argv.push(format!("--since={since}"));
    }
    if let Some(until) = opt_str(args, "until")? {
        plain_arg(until, "until")?;
        argv.push(format!("--until={until}"));
    }
    if let Some(path) = opt_str(args, "path")? {
        path_arg(path, "path")?;
        argv.push("--".into());
        argv.push(path.to_string());
    }

    let stdout = run_git(&dir, &argv).await?;
    let commits: Vec<Value> = stdout
        .split(GIT_RECORD)
        .filter(|chunk| !chunk.trim().is_empty())
        .filter_map(|chunk| {
            let mut lines = chunk.lines();
            let header = lines.next()?;
            let mut fields = header.split(GIT_FIELD);
            let sha = fields.next()?.to_string();
            let date = fields.next().unwrap_or_default().to_string();
            let subject = fields.next().unwrap_or_default().to_string();
            let files: Vec<&str> = lines.filter(|l| !l.trim().is_empty()).collect();
            Some(json!({
                "sha": sha,
                "date": date,
                "subject": subject,
                "files": files,
            }))
        })
        .collect();
    Ok(json!({ "commits": commits, "count": commits.len() }))
}

/// Cap a diff at both a line count and a byte count, and say so in the text
/// when it bites — a silently truncated diff reads as a complete one.
fn cap_text(text: &str, max_lines: usize, max_bytes: usize) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = false;
    for (lines, line) in text.lines().enumerate() {
        if lines >= max_lines || out.len() + line.len() + 1 > max_bytes {
            truncated = true;
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    if truncated {
        out.push_str("… output capped\n");
    }
    (out, truncated)
}

async fn git_show(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let dir = project_dir(ctx, args)?;
    let sha = req_str(args, "sha")?;
    sha_arg(sha)?;

    let mut argv: Vec<String> = vec![
        "show".into(),
        "--no-color".into(),
        "--date=short".into(),
        sha.to_string(),
    ];
    if let Some(path) = opt_str(args, "path")? {
        path_arg(path, "path")?;
        argv.push("--".into());
        argv.push(path.to_string());
    }

    let stdout = run_git(&dir, &argv).await?;
    let (text, truncated) = cap_text(&stdout, GIT_SHOW_MAX_LINES, GIT_SHOW_MAX_BYTES);
    Ok(json!({ "sha": sha, "text": text, "truncated": truncated }))
}

/// The alphanumeric pieces of a grep pattern worth searching on their own:
/// three characters or longer, deduplicated case-insensitively, in order.
/// "Z-zone" decomposes to `zone`; "TugTooltip.*hover" to `tugtooltip`,
/// `hover`. Capped like the model-expansion terms, and for the same reason.
fn grep_fragments(pattern: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in pattern.split(|c: char| !c.is_alphanumeric()) {
        if piece.chars().count() < 3 {
            continue;
        }
        let lowered = piece.to_lowercase();
        if !out.contains(&lowered) {
            out.push(lowered);
        }
    }
    out.truncate(EXPANSION_TERM_CAP);
    out
}

/// One `git grep` run for the ladder below: every pattern OR-ed, scoped to the
/// pathspecs resolution settled on, matches parsed into rows. Returns the rows
/// plus whether the cap cut them off.
///
/// `scopes` is empty for a whole-tree grep and holds one pathspec in the
/// ordinary scoped case; it holds several only when [P03]'s repair guessed at
/// a scope that matched nothing as written.
async fn grep_once(
    dir: &std::path::Path,
    patterns: &[String],
    insensitive: bool,
    scopes: &[String],
) -> Result<(Vec<Value>, bool), String> {
    let mut argv: Vec<String> = vec!["grep".into(), "-n".into(), "-I".into(), "--no-color".into()];
    if insensitive {
        argv.push("-i".into());
    }
    for pattern in patterns {
        argv.push("-e".into());
        argv.push(pattern.clone());
    }
    if !scopes.is_empty() {
        argv.push("--".into());
        argv.extend(scopes.iter().cloned());
    }
    let stdout = run_git(dir, &argv).await?;
    let all: Vec<&str> = stdout.lines().filter(|l| !l.is_empty()).collect();
    let truncated = all.len() > GREP_MAX_MATCHES;
    let matches: Vec<Value> = all
        .iter()
        .take(GREP_MAX_MATCHES)
        .map(|line| {
            let mut parts = line.splitn(3, ':');
            let path = parts.next().unwrap_or_default();
            let line_no = parts.next().and_then(|n| n.parse::<i64>().ok());
            let text = parts.next().unwrap_or_default();
            json!({ "path": path, "line": line_no, "text": truncate(text.trim_end(), 240) })
        })
        .collect();
    Ok((matches, truncated))
}

/// `repo.grep`, with the search verbs' own recovery discipline ([P04]): a
/// zero-match pattern retries case-insensitively, then decomposed into its
/// alphanumeric pieces. A user coinage — "Z-zone" for a drawing the document
/// labels `Z0`–`Z5` — rarely appears verbatim in the text it names, and a
/// model round is too scarce to spend on a retry Rust can run in
/// milliseconds. `pattern_used` reports what actually produced the rows, and
/// a rung that fired says so in `note`, because a loose match presented as an
/// exact one is worse than no match at all.
///
/// The **scope** is resolved before any of that runs ([P03]). The ladder here
/// relaxes the pattern and never the scope, so a `path_scope` matching no file
/// used to send all three rungs against an empty scope and return `rows=0` —
/// a scan that never happened, indistinguishable from a clean one. Resolution
/// makes that case an error instead, which is what gives `rows=0` its single
/// meaning: this scope was searched and the pattern is not in it.
async fn repo_grep(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let dir = project_dir(ctx, args)?;
    let pattern = req_str(args, "pattern")?;
    plain_arg(pattern, "pattern")?;

    let mut scopes: Vec<String> = Vec::new();
    let mut scope_note: Option<String> = None;
    let mut scope_used: Option<String> = None;
    if let Some(scope) = opt_str(args, "path_scope")? {
        path_arg(scope, "path_scope")?;
        let resolved = repo_files::resolve_grep_scope(&dir, scope).await?;
        scope_used = Some(resolved.used.join(", "));
        scope_note = resolved.note;
        scopes = resolved.used;
    }

    let exact = [pattern.to_string()];
    let (mut matches, mut truncated) = grep_once(&dir, &exact, false, &scopes).await?;
    let mut pattern_used = pattern.to_string();
    let mut pattern_note: Option<String> = None;
    if matches.is_empty() {
        let (rows, cut) = grep_once(&dir, &exact, true, &scopes).await?;
        if !rows.is_empty() {
            (matches, truncated) = (rows, cut);
            pattern_note =
                Some("no case-sensitive match; showing case-insensitive matches".to_string());
        }
    }
    if matches.is_empty() {
        let fragments = grep_fragments(pattern);
        // A pattern that IS its own single fragment has nothing left to try:
        // the case-insensitive rung already ran exactly this search.
        let worth_trying = match fragments.as_slice() {
            [] => false,
            [only] => !only.eq_ignore_ascii_case(pattern),
            _ => true,
        };
        if worth_trying {
            let (rows, cut) = grep_once(&dir, &fragments, true, &scopes).await?;
            if !rows.is_empty() {
                (matches, truncated) = (rows, cut);
                pattern_used = fragments.join("|");
                pattern_note = Some(
                    "no literal match; showing case-insensitive matches for the pattern's pieces"
                        .to_string(),
                );
            }
        }
    }

    let mut out = json!({
        "pattern": pattern,
        "pattern_used": pattern_used,
        "matches": matches,
        "count": matches.len(),
        "truncated": truncated,
    });
    if let Some(used) = scope_used {
        out["path_scope_used"] = json!(used);
    }
    let note = [scope_note, pattern_note]
        .into_iter()
        .flatten()
        .collect::<Vec<String>>();
    if !note.is_empty() {
        out["note"] = json!(note.join("; "));
    }
    Ok(out)
}

/// `repo.read` — a file's content, numbered, capped, and contained.
///
/// The verb the Operator did not have. Thirteen verbs could locate a line and
/// none could read one, so a question about what a file *says* was
/// unanswerable by construction and the model had to answer it anyway.
///
/// Numbering is what makes the result compose: an answer can say "the drawing
/// starts at line 271" without counting, and `repo.grep`'s `line` field feeds
/// `around_line` directly. `total_lines` is what makes a capped read honest —
/// the model can tell there is more file and where it stands in it, instead of
/// reading the cap as the end.
async fn repo_read(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let dir = project_dir(ctx, args)?;
    let path = req_str(args, "path")?;
    path_arg(path, "path")?;
    let resolved = repo_files::resolve_readable_path(&dir, path).await?;

    if resolved.absolute.is_dir() {
        return Err(format!(
            "path {:?} is a directory, not a file; repo.ls lists what is in it",
            resolved.used
        ));
    }
    let bytes = std::fs::read(&resolved.absolute)
        .map_err(|err| format!("path {:?} could not be read: {err}", resolved.used))?;
    if repo_files::is_binary(&bytes) {
        return Err(format!(
            "path {:?} is a binary file and will not be read as text",
            resolved.used
        ));
    }
    let contents = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = contents.lines().collect();
    let total = lines.len() as i64;

    let (mut start, mut end) = match opt_i64(args, "around_line")? {
        Some(around) => {
            let context = opt_i64(args, "context")?
                .unwrap_or(READ_CONTEXT_DEFAULT)
                .clamp(0, READ_MAX_LINES as i64);
            (around - context, around + context)
        }
        None => {
            // No window named means "the file", which the caps then cut — so
            // the cut is reported as `truncated` rather than hidden behind a
            // default `end` that happens to equal the cap.
            let start = opt_i64(args, "start")?.unwrap_or(1);
            let end = opt_i64(args, "end")?.unwrap_or(total.max(1));
            (start, end)
        }
    };
    start = start.clamp(1, total.max(1));
    end = end.clamp(start, total.max(1));

    let mut out_lines: Vec<Value> = Vec::new();
    let mut bytes_held = 0usize;
    let mut truncated = false;
    for offset in 0..(end - start + 1) {
        let Some(text) = lines.get((start + offset - 1) as usize) else {
            break;
        };
        if out_lines.len() >= READ_MAX_LINES || bytes_held + text.len() + 1 > READ_MAX_BYTES {
            truncated = true;
            break;
        }
        bytes_held += text.len() + 1;
        out_lines.push(json!({ "line": start + offset, "text": text }));
    }
    let returned_end = start + out_lines.len() as i64 - 1;

    let mut out = json!({
        "path": path,
        "path_used": resolved.used,
        "lines": out_lines,
        "start": start,
        "end": returned_end.max(0),
        "total_lines": total,
        "truncated": truncated,
    });
    if let Some(note) = resolved.note {
        out["note"] = json!(note);
    }
    Ok(out)
}

/// `repo.outline` — a file's structural lines, with their line numbers.
///
/// "Where in this document is X" is a question about structure, not content,
/// and answering it with a read spends four hundred lines of the answer's
/// context to deliver one. An outline answers it in a handful of rows whose
/// line numbers feed `repo.read`'s `around_line` directly.
///
/// An outline with no entries says so explicitly and points at `repo.read`,
/// because a model that reads "no structure" as "no file" will go on to make
/// exactly the absence claim this whole line of work exists to prevent.
async fn repo_outline(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let dir = project_dir(ctx, args)?;
    let path = req_str(args, "path")?;
    path_arg(path, "path")?;
    let resolved = repo_files::resolve_readable_path(&dir, path).await?;

    if resolved.absolute.is_dir() {
        return Err(format!(
            "path {:?} is a directory, not a file; repo.ls lists what is in it",
            resolved.used
        ));
    }
    let bytes = std::fs::read(&resolved.absolute)
        .map_err(|err| format!("path {:?} could not be read: {err}", resolved.used))?;
    if repo_files::is_binary(&bytes) {
        return Err(format!(
            "path {:?} is a binary file and has no outline",
            resolved.used
        ));
    }
    let contents = String::from_utf8_lossy(&bytes);
    let extension = std::path::Path::new(&resolved.used)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();

    let all = repo_files::outline_entries(&contents, extension);
    let truncated = all.len() > OUTLINE_MAX_ENTRIES;
    let entries: Vec<Value> = all
        .iter()
        .take(OUTLINE_MAX_ENTRIES)
        .map(|entry| json!({ "line": entry.line, "kind": entry.kind, "text": entry.text }))
        .collect();

    let mut notes: Vec<String> = resolved.note.into_iter().collect();
    if entries.is_empty() {
        notes.push(
            "no structural lines recognized in this file; read it with repo.read".to_string(),
        );
    }
    let count = entries.len();
    let mut out = json!({
        "path": path,
        "path_used": resolved.used,
        "entries": entries,
        "count": count,
        "total_lines": contents.lines().count(),
        "truncated": truncated,
    });
    if !notes.is_empty() {
        out["note"] = json!(notes.join("; "));
    }
    Ok(out)
}

/// `repo.ls` — resolve a name fragment, basename, or git glob to real paths.
///
/// The repair ladder [P03] already needed, exposed to the model directly, so
/// "which file did you mean" is a question it can settle itself in one cheap
/// verb rather than by guessing at a path and reading an error. Its result is
/// paths only, so it cannot crowd an answer's context.
///
/// An empty result is **not** an error here, unlike an unmatched scope on a
/// scan: "no file by that name" is a real and complete answer to a naming
/// question, and it carries no claim about any file's contents.
async fn repo_ls(ctx: &OperatorContext, args: &Value) -> Result<Value, String> {
    let dir = project_dir(ctx, args)?;
    let pattern = req_str(args, "pattern")?;
    path_arg(pattern, "pattern")?;

    let candidates = repo_files::path_candidates(&dir, pattern).await?;
    let count = candidates.paths.len();
    Ok(json!({
        "pattern": pattern,
        "paths": candidates.paths,
        "count": count,
        "truncated": count >= repo_files::LS_MAX_PATHS,
    }))
}

// MARK: - The pipeline

/// How much of the channel rides every Operator turn. Server-side scrollback:
/// the question arrives bare, and the last twenty posts are what make "that
/// theme thing yesterday" resolvable.
pub const SCROLLBACK_POSTS: usize = 20;

/// Per round. A model that wants more than six lookups has not narrowed the
/// question, and running them would spend the answer's context on breadth.
pub const MAX_VERBS_PER_ROUND: usize = 6;

/// How much of an unreadable model turn rides the warning. Enough to see what
/// shape it took; not so much that one bad turn floods the log.
/// The most rows one fact kind may hold on a `facts.search` page before the
/// budgeter starts skipping it. Twelve of a thirty-row page lets a genuinely
/// shell-heavy question stay shell-heavy while guaranteeing eighteen rows of
/// room for every other kind that matched.
const KIND_PAGE_CAP: usize = 12;

/// How much wider than the page `facts.search` reads when it is going to
/// budget. Three is enough because the budgeter only needs to FIND the
/// minority-kind rows, and bm25's subject weighting already pulls the
/// handle-hits toward the front.
const KIND_BUDGET_OVERFETCH: usize = 3;

const RAW_LOG_CHARS: usize = 400;

/// How much of a verb's arguments its log line carries. Enough to see the
/// query the model wrote; short enough that a pasted wall of text cannot flood
/// the log.
const VERB_LOG_ARGS_CHARS: usize = 300;

/// One retrieval round, then at most one follow-up, then the answer is forced.
/// The cap lives here rather than in the wording because the wording is a
/// request and this is a guarantee ([P07]).
pub const MAX_RETRIEVAL_ROUNDS: usize = 2;

/// One verb the model asked for.
///
/// **Not `deny_unknown_fields`, unlike the Observer's envelope.** There the
/// strictness is the contract: a drifted field means a post nobody wrote on
/// purpose, and silence is the safe failure. Here the failure mode is the
/// opposite — somebody is waiting, and refusing a whole exchange because the
/// model annotated a verb with its reasoning spends their answer to enforce a
/// tidiness nothing depends on. Extra keys are ignored; an unknown verb *name*
/// is still an error the model reads, which is where the real checking is.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct VerbRequest {
    pub verb: String,
    #[serde(default)]
    pub args: Value,
    /// Arguments the model wrote flat on the verb object instead of nested
    /// under `args` — `{"verb": "facts.search", "query": "contrast"}`.
    ///
    /// Observed against the real model, twice, on a question it otherwise
    /// answered: every verb in the round came back argument-less, each one
    /// erroring with "argument \"query\" is required", and the whole first
    /// round was spent on the slip. Rounds are capped at two, so that is half
    /// the lookups a question gets. Reading the arguments where the model
    /// actually put them costs nothing and is the same posture as the
    /// relaxation ladder: recover in Rust rather than spend a round.
    #[serde(flatten)]
    flat: serde_json::Map<String, Value>,
}

impl VerbRequest {
    /// Move flat arguments into `args` when `args` is absent. A request that
    /// nested them properly is untouched, and a stray annotation ("why": …)
    /// on a properly-formed request stays ignored where it always was.
    /// A well-formed request, for tests that compose one directly rather than
    /// parsing a model's envelope.
    #[cfg(test)]
    fn new(verb: &str, args: Value) -> Self {
        Self {
            verb: verb.to_string(),
            args,
            flat: serde_json::Map::new(),
        }
    }

    fn absorb_flat_args(mut self) -> Self {
        if !self.args.is_object() && !self.flat.is_empty() {
            self.args = Value::Object(std::mem::take(&mut self.flat));
        }
        self
    }
}

#[derive(Debug, Deserialize)]
struct VerbsEnvelope {
    verbs: Vec<VerbRequest>,
}

#[derive(Debug, Deserialize)]
struct AnswerEnvelope {
    answer: AnswerPost,
}

#[derive(Debug, Deserialize)]
pub struct AnswerPost {
    pub body: String,
    #[serde(default)]
    pub refs: Vec<tugcast_core::types::OverviewRef>,
}

/// What `operator-answer` said: the answer, or a request for one more round.
enum AnswerTurn {
    Answer(AnswerPost),
    More(Vec<VerbRequest>),
}

/// Read a `{"verbs": […]}` envelope out of a model turn.
///
/// The same newest-first span scan the Observer uses ([P06] as amended): the
/// models preface, double-wrap, and correct themselves the same way whichever
/// job they are answering, so there is one scanner rather than two.
fn parse_verbs(raw: &str) -> Option<Vec<VerbRequest>> {
    for span in crate::feeds::observer_wake::json_object_spans(raw.trim())
        .into_iter()
        .rev()
    {
        if let Ok(envelope) = serde_json::from_str::<VerbsEnvelope>(span) {
            return Some(
                envelope
                    .verbs
                    .into_iter()
                    .map(VerbRequest::absorb_flat_args)
                    .collect(),
            );
        }
    }
    None
}

/// Read either half of what `operator-answer` may say. An answer wins over a
/// request for more when both somehow appear: the model has said the thing
/// someone is waiting for.
fn parse_answer_turn(raw: &str) -> Option<AnswerTurn> {
    let spans = crate::feeds::observer_wake::json_object_spans(raw.trim());
    for span in spans.iter().rev() {
        if let Ok(envelope) = serde_json::from_str::<AnswerEnvelope>(span) {
            return Some(AnswerTurn::Answer(envelope.answer));
        }
    }
    for span in spans.iter().rev() {
        if let Ok(envelope) = serde_json::from_str::<VerbsEnvelope>(span) {
            return Some(AnswerTurn::More(envelope.verbs));
        }
    }
    None
}

fn render_scrollback(posts: &[tugcast_core::types::OverviewPost]) -> String {
    if posts.is_empty() {
        return "(the channel is empty)\n".to_string();
    }
    let mut out = String::new();
    for post in posts {
        out.push_str("- [");
        out.push_str(&post.at_ms.to_string());
        out.push_str("] ");
        out.push_str(post.author.as_str());
        if let Some(id) = post.id {
            out.push_str(" (post_id ");
            out.push_str(&id.to_string());
            out.push(')');
        }
        out.push_str(": ");
        out.push_str(&post.body);
        out.push('\n');
    }
    out
}

/// One verb's outcome, rendered for the answering model. Errors ride the same
/// channel as results on purpose — the model that asked has to see what its
/// request did.
fn render_results(results: &[(VerbRequest, Result<Value, String>)]) -> String {
    let mut out = String::new();
    for (request, outcome) in results {
        out.push_str("\n--- VERB ");
        out.push_str(&request.verb);
        out.push(' ');
        out.push_str(&request.args.to_string());
        out.push('\n');
        match outcome {
            Ok(value) => {
                out.push_str(
                    &serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
                );
                out.push('\n');
            }
            Err(err) => {
                out.push_str("ERROR: ");
                out.push_str(err);
                out.push('\n');
            }
        }
    }
    out
}

/// The label the clock line opens with. Both composers print it and the job
/// table's contract tests assert the model was told about it by this name.
pub const NOW_HEADER: &str = "NOW: ";

/// What time it is, for a model whose every time argument is epoch
/// milliseconds and whose every answer must read as a date and a clock.
///
/// Both units, in that order: the epoch number is what a `since_ms` is
/// computed from, and the human rendering is what prose converts to. The zone
/// is a numeric offset rather than a name because that is what chrono's
/// `Local` can actually supply ([Q01]) — a promise of `PDT` is one it cannot
/// keep. A timestamp local time cannot resolve degrades to the bare epoch
/// number, which is still the half the verbs need.
fn render_now_line(now_ms: i64) -> String {
    match chrono::Local.timestamp_millis_opt(now_ms).single() {
        Some(local) => format!(
            "{NOW_HEADER}{now_ms} — {} (UTC{})",
            local.format("%A, %B %-d, %Y, %-I:%M %P"),
            local.format("%:z"),
        ),
        None => format!("{NOW_HEADER}{now_ms}"),
    }
}

/// The label the roster section opens with, printed by [`render_session_roster`]
/// and — when the read fails — by the pipeline itself, so the model is never
/// shown a section under a header it was not told about ([P07]).
pub const SESSIONS_HEADER: &str = "SESSIONS (newest first):";

/// How many sessions ride the roster ([Q02]). Enough that the questions people
/// actually ask are about a session already on the page; few enough that a
/// dozen long lines are a preamble rather than the turn.
const SESSIONS_ROSTER_LIMIT: usize = 12;

/// The sessions a question is usually about, one to a line.
///
/// Pure over rows already fetched, so it is testable without a ledger — and a
/// read failure is the caller's case, not this function's. The uuid is spelled
/// whole ([P05]): it is what a `session_id` argument takes and what the
/// answer's session stamp demands, and a prefix here would make the model
/// reconstruct the rest.
fn render_session_roster(rows: &[SessionRow]) -> String {
    let mut out = String::new();
    out.push_str(SESSIONS_HEADER);
    out.push('\n');
    if rows.is_empty() {
        out.push_str("(no sessions)\n");
        return out;
    }
    for row in rows {
        out.push_str("- ");
        out.push_str(row.tag.as_deref().unwrap_or("untagged"));
        out.push(' ');
        out.push_str(&row.session_id);
        out.push_str(" [");
        out.push_str(row.state.as_str());
        out.push_str("] ");
        out.push_str(&row.project_dir);
        let title = row
            .name
            .as_deref()
            .or(row.last_user_prompt.as_deref())
            .unwrap_or_default();
        out.push_str(" — \"");
        out.push_str(&truncate(title, INCIPIT_CHARS));
        out.push('"');
        if let Some(synopsis) = row.synopsis.as_deref() {
            out.push_str(" — ");
            out.push_str(&truncate(synopsis, INCIPIT_CHARS));
        }
        out.push_str(" — last used ");
        out.push_str(&render_short_local(row.last_used_at));
        out.push('\n');
    }
    out
}

/// A timestamp as a roster line spells it — short, local, and never the whole
/// date when the whole date is not what makes a row recognizable.
fn render_short_local(at_ms: i64) -> String {
    match chrono::Local.timestamp_millis_opt(at_ms).single() {
        Some(local) => local.format("%b %-d, %-I:%M %P").to_string(),
        None => at_ms.to_string(),
    }
}

/// The line that tells the model the pictures it can see belong to the
/// question — empty when none were attached.
///
/// The images ride the turn as content blocks, which is what makes them
/// visible; this is what makes them ATTRIBUTED. Without it a screenshot is
/// just something in the context, and the model has been seen to answer about
/// the channel while a picture of the thing asked about sat unmentioned
/// beside it.
fn render_attached_line(count: usize) -> String {
    match count {
        0 => String::new(),
        1 => "\nATTACHED: 1 image, shown with this turn. It is part of the question.\n".to_string(),
        n => format!(
            "\nATTACHED: {n} images, shown with this turn, in order. They are part of the question.\n"
        ),
    }
}

/// The label the verified-mention section opens with ([S05]), pinned in the
/// job table the way [`NOW_HEADER`] and [`SESSIONS_HEADER`] are — a section the
/// model was never told about is a section it has to guess the meaning of.
pub const QUESTION_FILES_HEADER: &str = "FILES NAMED BY THE QUESTION (verified to exist):";

/// How many of the named files get their outline included.
///
/// Two, so a question that points at a directory's worth of atoms cannot
/// displace itself ([P07]). The rest are still named — an unoutlined file is
/// one `repo.outline` away, and the model has been told it exists.
const SEEDED_OUTLINES: usize = 2;

/// The files the asker pointed at, as the retrieval turn is shown them:
/// verified to exist, with their line counts, and — for the first
/// [`SEEDED_OUTLINES`] — their structure ([S05]).
///
/// This is where the pointing gesture converts into a head start. Without it
/// the model's opening move on "where in this document is X" is a search for a
/// file it has already been handed; with it, the first round can be a
/// `repo.read` at the right line.
///
/// Empty when nothing verified, which is what keeps the common question's
/// retrieve input byte-identical to what it was before any of this existed. A
/// file that will not read contributes its name alone and a warning — the
/// mention is still true, and losing the outline is not worth losing the
/// statement that the file is there.
fn render_question_files(mentions: &[VerifiedMention]) -> String {
    if mentions.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n");
    out.push_str(QUESTION_FILES_HEADER);
    out.push('\n');
    for (index, mention) in mentions.iter().enumerate() {
        let contents = match std::fs::read(&mention.absolute) {
            Ok(bytes) if !repo_files::is_binary(&bytes) => {
                Some(String::from_utf8_lossy(&bytes).into_owned())
            }
            Ok(_) => None,
            Err(err) => {
                warn!(path = %mention.path, error = %err, "overview operator: named file would not read; seeded by name only");
                None
            }
        };
        match &contents {
            Some(text) => {
                let _ = writeln!(out, "- {} ({} lines)", mention.path, text.lines().count());
            }
            None => {
                let _ = writeln!(out, "- {}", mention.path);
                continue;
            }
        }
        if index >= SEEDED_OUTLINES {
            continue;
        }
        let extension = std::path::Path::new(&mention.path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default();
        let entries = contents
            .as_deref()
            .map(|text| repo_files::outline_entries(text, extension))
            .unwrap_or_default();
        if entries.is_empty() {
            continue;
        }
        out.push_str("  OUTLINE:\n");
        for entry in entries.iter().take(OUTLINE_MAX_ENTRIES) {
            // The kind column is padded to its widest spelling, so a long
            // outline reads as three columns rather than as ragged prose.
            let _ = writeln!(out, "    {}  {:<7}  {}", entry.line, entry.kind, entry.text);
        }
    }
    out
}

fn compose_retrieve_input(
    now_ms: i64,
    question: &str,
    roster: &str,
    scrollback: &str,
    attached: usize,
    question_files: &str,
) -> String {
    format!(
        "{}\n\n{roster}\nQUESTION:\n{question}\n{}{question_files}\nRECENT OVERVIEW POSTS:\n{scrollback}",
        render_now_line(now_ms),
        render_attached_line(attached),
    )
}

fn compose_answer_input(
    now_ms: i64,
    question: &str,
    roster: &str,
    scrollback: &str,
    results: &str,
    forced: bool,
    attached: usize,
) -> String {
    let mut out = String::new();
    if forced {
        // The instructions say one follow-up; this is where that promise is
        // kept, and saying so is what makes the model answer with what it has
        // rather than ask for a round it will never receive.
        out.push_str(
            "THIS IS YOUR LAST ROUND. You must answer now with what is below; \
             say plainly what you could not confirm. Do not ask for more verbs.\n\n",
        );
    }
    out.push_str(&render_now_line(now_ms));
    out.push_str("\n\n");
    out.push_str(roster);
    out.push_str("\nQUESTION:\n");
    out.push_str(question);
    out.push('\n');
    out.push_str(&render_attached_line(attached));
    out.push_str("\nRECENT OVERVIEW POSTS:\n");
    out.push_str(scrollback);
    out.push_str("\nVERB RESULTS:\n");
    out.push_str(results);
    out
}

/// The session an answer is *about*, when its refs name exactly one and the
/// ledger holds it — otherwise `None`.
///
/// Two gates, and both are load-bearing:
///
///  - **Shape.** A full session uuid, nothing else. This rejects the
///    `project/callsign` spelling a model might write into a ref target,
///    which is not a session key anywhere: the ledger resolves a uuid, a
///    unique 8-char prefix, or a bare callsign, and a pair matches none of
///    them.
///  - **The ledger.** `get` answers whether the session exists at all. This
///    is the gate that makes the header honest, because nothing upstream
///    checked: `validate_refs` exempts Session refs from its corpus check.
///
/// Zero session refs, two or more, or one the ledger cannot answer for all
/// leave the post unattributed. A ref that fails these gates is still KEPT —
/// it renders in the provenance strip, inert if it resolves to nothing. This
/// governs only what is promoted to the row's identity.
fn sole_ledger_session(ctx: &OperatorContext, refs: &[OverviewRef]) -> Option<String> {
    let mut sessions = refs
        .iter()
        .filter(|r| matches!(r.kind, OverviewRefKind::Session));
    let only = sessions.next()?;
    if sessions.next().is_some() {
        return None;
    }
    if !is_session_uuid(&only.target) {
        return None;
    }
    match ctx.ledger.get(&only.target) {
        Ok(Some(_)) => Some(only.target.clone()),
        Ok(None) => None,
        Err(err) => {
            tracing::warn!(error = %err, "overview operator: session lookup failed; not stamping");
            None
        }
    }
}

/// True when `id` is a full session uuid — 8-4-4-4-12 lowercase hex.
fn is_session_uuid(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        })
}

/// One image as it arrives on `OVERVIEW_INPUT` — the deck's downsampled bytes,
/// base64, plus the media type it decoded them as. The same pair an Anthropic
/// image block takes, which is why nothing re-encodes on the way to the model.
#[derive(Debug, Clone, Deserialize)]
pub struct QuestionAttachment {
    #[serde(rename = "mediaType", alias = "media_type")]
    pub media_type: String,
    /// Base64, no `data:` prefix.
    pub data: String,
}

/// One file the asker pointed at with an `@` atom, as it arrives on
/// `OVERVIEW_INPUT` beside the flattened body.
///
/// `kind` is a plain string rather than a [`OverviewRefKind`] deliberately: an
/// unrecognized spelling from a drifted deck must cost that one ref, not the
/// deserialization of the whole question. Only `file` is acted on today, which
/// is the only kind the composer's single completion source can produce.
#[derive(Debug, Clone, Deserialize)]
pub struct QuestionRef {
    pub kind: String,
    pub target: String,
}

/// A question ref that resolved to a real file under the project dir.
///
/// `path` is what the **resolver** spelled, not necessarily what the asker
/// typed — a repaired ref names the file that exists, because that is the
/// argument a verb can be given and the target a chip can act on.
#[derive(Debug, Clone)]
pub struct VerifiedMention {
    pub path: String,
    /// Where the file actually is — resolved and containment-checked once, so
    /// the preamble that reads it does not resolve it a second time.
    pub absolute: std::path::PathBuf,
}

/// Resolve each question ref against the project dir, keeping the ones that
/// name a real file.
///
/// A ref that does not verify is dropped with a warning rather than published:
/// a chip nobody can act on is worse than no chip, which is the card's existing
/// rule for a malformed ref. The discard is safe against [L23] for one specific
/// reason — the atom already flattened into the body, so the path stays visible
/// in the sentence and only the structured claim is lost. Were refs ever to
/// become the sole carrier of the path, this would have to become an error.
///
/// Duplicates collapse: the same file named twice is one mention, since what
/// rides downstream is the file, not the gesture count.
pub(crate) async fn verify_question_refs(dir: &Path, refs: &[QuestionRef]) -> Vec<VerifiedMention> {
    let mut verified: Vec<VerifiedMention> = Vec::new();
    for raw in refs {
        if raw.kind != OverviewRefKind::File.as_str() {
            warn!(kind = %raw.kind, "overview operator: question ref of an unhandled kind; dropped");
            continue;
        }
        if path_arg(&raw.target, "ref").is_err() {
            warn!(target = %raw.target, "overview operator: question ref is not a repo-relative path; dropped");
            continue;
        }
        match repo_files::resolve_readable_path(dir, &raw.target).await {
            Ok(resolved) if resolved.absolute.is_file() => {
                if verified.iter().any(|m| m.path == resolved.used) {
                    continue;
                }
                verified.push(VerifiedMention {
                    path: resolved.used,
                    absolute: resolved.absolute,
                });
            }
            Ok(resolved) => {
                warn!(target = %resolved.used, "overview operator: question ref is not a file; dropped");
            }
            Err(err) => {
                warn!(target = %raw.target, error = %err, "overview operator: question ref did not resolve; dropped");
            }
        }
    }
    verified
}

/// Write each attachment's bytes into `dir` and describe where they landed.
///
/// Every failure — an undecodable base64 payload, a directory that will not
/// create, a write that fails — costs that one image and nothing else. The
/// question was still asked and the rest of it is still history, so a dropped
/// image is a warning in the log, not an exception on the way out.
fn store_attachments(dir: &Path, attachments: &[QuestionAttachment]) -> Vec<OverviewAttachment> {
    use base64::Engine as _;
    if attachments.is_empty() {
        return Vec::new();
    }
    if let Err(err) = std::fs::create_dir_all(dir) {
        warn!(error = %err, "overview operator: attachments dir unavailable; images dropped");
        return Vec::new();
    }
    let mut stored = Vec::new();
    for attachment in attachments {
        let bytes = match base64::engine::general_purpose::STANDARD.decode(&attachment.data) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!(error = %err, "overview operator: attachment was not base64; dropped");
                continue;
            }
        };
        let path = dir.join(format!(
            "{}.{}",
            uuid::Uuid::new_v4(),
            // Overview keeps its long-standing `.img` fallback for a media
            // type outside the servable set. Such a file cannot be read back
            // through `/api/fs/blob` — a pre-existing gap on this path, left
            // exactly as it was rather than changed under a passing refactor.
            crate::attachments::attachment_extension(&attachment.media_type).unwrap_or("img"),
        ));
        if let Err(err) = std::fs::write(&path, &bytes) {
            warn!(error = %err, "overview operator: attachment write failed; dropped");
            continue;
        }
        stored.push(OverviewAttachment {
            path: path.to_string_lossy().into_owned(),
            media_type: attachment.media_type.clone(),
        });
    }
    stored
}

/// The Operator side of the Overview: a question in, a post out.
pub struct OperatorPipeline {
    pub ctx: Arc<OperatorContext>,
    pub pool: Arc<crate::shared_agent::SharedAgentPool>,
    pub overview_tx: tokio::sync::broadcast::Sender<tugcast_core::protocol::Frame>,
}

impl OperatorPipeline {
    /// Handle one `OVERVIEW_INPUT` submission end to end.
    ///
    /// The user's post is persisted and broadcast **first** ([P08]): the
    /// question is history whatever happens next, and the Operator's own
    /// scrollback read has to be able to see it. A failure anywhere after
    /// that becomes a transient post — broadcast so the card stops waiting,
    /// never written, because an infrastructure hiccup is not history.
    ///
    /// An attached image is part of the question in both directions: its
    /// bytes come to rest on disk so the post can show it forever, and the
    /// same bytes are shown to the model, because an answer about a
    /// screenshot has to be written by something that saw the screenshot.
    /// A question with an image and no words is a question — "what is this?"
    /// is what the picture is for — so emptiness is judged on the pair.
    ///
    /// The `@` atoms the asker placed ride in as `refs` and are verified
    /// against the tree before the post is written. They are **not** run
    /// through `validate_refs`, which vets a model's recall against verb
    /// results that do not exist yet and would therefore drop every one of
    /// them; nor through `sole_ledger_session`, which promotes an answer's
    /// session to the row's identity and has nothing to say about a question.
    pub async fn handle(
        &self,
        question: String,
        request_id: Option<String>,
        attachments: Vec<QuestionAttachment>,
        refs: Vec<QuestionRef>,
    ) {
        let question = question.trim().to_string();
        if question.is_empty() && attachments.is_empty() {
            return;
        }
        let mentions = verify_question_refs(&self.ctx.bootstrap_project_dir, &refs).await;
        // Stored before the post is published, because the post carries where
        // they landed. An image that cannot be written is dropped with a
        // warning rather than failing the question: the words still deserve
        // an answer, and the model is still shown the bytes.
        let stored = store_attachments(&self.ctx.attachments_dir, &attachments);
        let images: Vec<TurnImage> = attachments
            .into_iter()
            .map(|a| TurnImage {
                media_type: a.media_type,
                data: a.data,
            })
            .collect();
        self.publish(
            OverviewPost {
                id: None,
                at_ms: now_ms(),
                author: OverviewAuthor::User,
                session_id: None,
                wake_reason: None,
                body: question.clone(),
                // The asker's own pointing gesture, verified — the one ref
                // channel whose targets came from a person rather than a model.
                refs: mentions
                    .iter()
                    .map(|m| OverviewRef {
                        kind: OverviewRefKind::File,
                        target: m.path.clone(),
                    })
                    .collect(),
                // A question costs no agent turn; it is typed, not run.
                elapsed_ms: None,
                // The card's annotator needs a root for PROSE mentions, refs
                // or not — a typed `@` file atom flattens to its path on the
                // wire, and without a root that path can never be confirmed
                // and renders dead. The verbs' own default repo ([Q03]), the
                // same root the answer post carries.
                project_dir: Some(
                    self.ctx
                        .bootstrap_project_dir
                        .to_string_lossy()
                        .into_owned(),
                ),
                attachments: stored,
                request_id: request_id.clone(),
                transient: false,
            },
            true,
        );

        // The answer's own cost, clocked around the whole round — every verb
        // round trip the Operator needed, not just the last turn's tokens.
        let started = std::time::Instant::now();
        match self.answer(&question, &images, &mentions).await {
            Ok((post, context)) => {
                let validated = crate::feeds::observer_wake::validate_refs(post.refs, &[&context]);
                if !validated.dropped.is_empty() {
                    tracing::warn!(
                        dropped = validated.dropped.len(),
                        "overview operator: refs dropped — target not in the results verbatim",
                    );
                }
                // An answer that rests on exactly one session IS about that
                // session, and the row says so: the id becomes the post's
                // identity, which the card renders as the header-trailing
                // citation and filters out of the provenance strip.
                //
                // Gated, because `validate_refs` vets nothing here.  It
                // exempts Session refs from its verbatim-corpus check
                // outright — sound where it was written, since the
                // Observer's session id is stamped by the bridge from the
                // wake and legitimately appears in no frame's text, but the
                // Operator's session refs are model-recalled from verb
                // results and reach this point entirely unchecked. Promoting
                // one to the row's identity unchecked would make a
                // hallucinated id a header citation and a raise target.
                let session_id = sole_ledger_session(&self.ctx, &validated.kept);
                self.publish(
                    OverviewPost {
                        id: None,
                        at_ms: now_ms(),
                        author: OverviewAuthor::Operator,
                        session_id,
                        wake_reason: None,
                        body: post.body,
                        refs: validated.kept,
                        elapsed_ms: Some(started.elapsed().as_millis() as i64),
                        // The verbs' own default repo ([Q03]): the root an
                        // answer's refs are most likely spelled under.
                        project_dir: Some(
                            self.ctx
                                .bootstrap_project_dir
                                .to_string_lossy()
                                .into_owned(),
                        ),
                        // The Operator answers in words.
                        attachments: Vec::new(),
                        request_id: request_id.clone(),
                        transient: false,
                    },
                    true,
                );
            }
            Err(err) => {
                tracing::warn!(error = %err, "overview operator: question went unanswered");
                self.publish(
                    OverviewPost {
                        id: None,
                        at_ms: now_ms(),
                        author: OverviewAuthor::Operator,
                        session_id: None,
                        wake_reason: None,
                        body: format!("Couldn't answer that: {err}"),
                        refs: Vec::new(),
                        elapsed_ms: Some(started.elapsed().as_millis() as i64),
                        project_dir: None,
                        // The Operator answers in words.
                        attachments: Vec::new(),
                        request_id,
                        transient: true,
                    },
                    false,
                );
            }
        }
    }

    /// Persist (unless transient) and broadcast one post.
    fn publish(&self, mut post: OverviewPost, persist: bool) {
        if persist {
            match self.ctx.ledger.record_overview_post(&post) {
                Ok(id) => post.id = Some(id),
                Err(err) => tracing::warn!(error = %err, "overview operator: ledger write failed"),
            }
        }
        match serde_json::to_vec(&post) {
            Ok(bytes) => {
                let _ = self.overview_tx.send(tugcast_core::protocol::Frame::new(
                    tugcast_core::protocol::FeedId::OVERVIEW,
                    bytes,
                ));
            }
            Err(err) => tracing::warn!(error = %err, "overview operator: post did not serialize"),
        }
    }

    /// Retrieve, execute, answer — bounded at [`MAX_RETRIEVAL_ROUNDS`].
    async fn answer(
        &self,
        question: &str,
        images: &[TurnImage],
        mentions: &[VerifiedMention],
    ) -> Result<(AnswerPost, String), String> {
        run_question(&self.ctx, &self.pool, question, images, mentions, None).await
    }
}

/// Watch each verb as it is executed. The feed passes `None`; `operator-ask`
/// passes a printer, which is the whole reason the pipeline takes one.
pub type RoundObserver<'a> =
    &'a (dyn Fn(usize, &VerbRequest, &Result<Value, String>) + Send + Sync);

/// Retrieve, execute, answer — bounded at [`MAX_RETRIEVAL_ROUNDS`].
///
/// Returns the answer alongside the text it was allowed to draw on, which is
/// what its refs are then validated against.
///
/// This is a free function rather than a method because the pipeline has two
/// callers with nothing else in common: the Overview feed, which broadcasts and
/// persists what comes back, and `tugcast operator-ask`, which prints it. A
/// verification instrument that ran a *reimplementation* of the pipeline would
/// verify nothing, so both callers enter here.
pub async fn run_question(
    ctx: &OperatorContext,
    pool: &Arc<crate::shared_agent::SharedAgentPool>,
    question: &str,
    images: &[TurnImage],
    mentions: &[VerifiedMention],
    observer: Option<RoundObserver<'_>>,
) -> Result<(AnswerPost, String), String> {
    let scrollback = render_scrollback(
        &ctx.ledger
            .list_overview_posts_tail(SCROLLBACK_POSTS)
            .unwrap_or_default(),
    );

    // Composed once and reused by both turns, the way the scrollback is.
    // A roster read that fails costs the question a convenience, never the
    // answer — the wake's "a facts read must never cost a wake" posture
    // ([P02]) — and the degraded line still rides the header the model was
    // told about.
    let roster = match ctx
        .ledger
        .list_sessions_recent(None, None, false, SESSIONS_ROSTER_LIMIT)
    {
        Ok(rows) => render_session_roster(&rows),
        Err(err) => {
            warn!(error = %err, "overview operator: session roster unavailable");
            format!("{SESSIONS_HEADER}\n(sessions unavailable)\n")
        }
    };

    // Read once, before the turn that spends it: the outlines are the same
    // for both, and only the retrieve turn is shown them ([P07]) — by the
    // answering turn the model has real verb results and the seed would only
    // compete with them.
    let question_files = render_question_files(mentions);
    let raw = pool
        .run_seeing(
            "operator-retrieve",
            compose_retrieve_input(
                now_ms(),
                question,
                &roster,
                &scrollback,
                images.len(),
                &question_files,
            ),
            images.to_vec(),
        )
        .await?;
    // An unreadable retrieval is not a failed exchange. Retrieval is an
    // optimization — it decides what to *add* to the material the answering
    // step already has, and the scrollback rides that turn either way. Some
    // questions ("how many physics questions today?") are answerable from
    // the channel alone, and killing the exchange because the model wrote
    // prose where a verb list was asked for spends a real answer to punish
    // a formatting slip. So: log it, and answer with what we have.
    let mut requests = match parse_verbs(&raw) {
        Some(requests) => requests,
        None => {
            warn!(
                raw = %raw.chars().take(RAW_LOG_CHARS).collect::<String>(),
                "overview operator: retrieval named no verbs; answering from the channel alone",
            );
            Vec::new()
        }
    };

    let mut results: Vec<(VerbRequest, Result<Value, String>)> = Vec::new();
    let mut rendered = String::new();
    for round in 1..=MAX_RETRIEVAL_ROUNDS {
        requests.truncate(MAX_VERBS_PER_ROUND);
        for request in requests {
            let started = std::time::Instant::now();
            let outcome = run_verb(ctx, &request.verb, &request.args).await;
            log_verb(round, &request, &outcome, started.elapsed());
            if let Some(observe) = observer {
                observe(round, &request, &outcome);
            }
            results.push((request, outcome));
        }
        rendered = render_results(&results);
        let forced = round == MAX_RETRIEVAL_ROUNDS;
        let raw = pool
            .run_seeing(
                "operator-answer",
                // Read again rather than reusing the retrieve turn's: a
                // retrieval round plus its verbs is real elapsed time, and
                // the clock the answer converts its prose times from
                // should be the one on the wall when it writes them.
                compose_answer_input(
                    now_ms(),
                    question,
                    &roster,
                    &scrollback,
                    &rendered,
                    forced,
                    images.len(),
                ),
                // Shown to every round, not just the first: the model that
                // writes the answer is the one that has to have looked.
                images.to_vec(),
            )
            .await?;
        match parse_answer_turn(&raw) {
            Some(AnswerTurn::Answer(post)) => {
                let context = format!("{scrollback}{rendered}");
                return Ok((post, context));
            }
            Some(AnswerTurn::More(more)) if !forced => requests = more,
            Some(AnswerTurn::More(_)) => {
                return Err(
                    "the answering step asked for more lookups after its last round".to_string(),
                );
            }
            None => {
                // A turn with no JSON in it at all is the model answering in
                // prose — the words are the answer, in the wrong clothes.
                // Post them rather than converting a readable answer into
                // "did not produce a readable answer"; the refs are lost, but
                // refs are best-effort everywhere (validate_refs drops what
                // it cannot verify) and the body is the product. The warning
                // stays so the slips remain countable in the log. A turn
                // that DOES contain JSON but parses as neither envelope is a
                // different animal — a malformed attempt at the contract —
                // and posting it would print braces at the reader, so that
                // one still errors.
                let trimmed = raw.trim();
                if !trimmed.is_empty()
                    && crate::feeds::observer_wake::json_object_spans(trimmed).is_empty()
                {
                    warn!(
                        raw = %trimmed.chars().take(RAW_LOG_CHARS).collect::<String>(),
                        "overview operator: prose answer salvaged — the model skipped the envelope",
                    );
                    let context = format!("{scrollback}{rendered}");
                    return Ok((
                        AnswerPost {
                            body: trimmed.to_string(),
                            refs: Vec::new(),
                        },
                        context,
                    ));
                }
                // Here the raw text IS the diagnosis: a silence cannot be
                // read off the post that was not written.
                warn!(
                    raw = %raw.chars().take(RAW_LOG_CHARS).collect::<String>(),
                    "overview operator: unreadable answer envelope",
                );
                return Err("the answering step did not produce a readable answer".to_string());
            }
        }
    }
    // Unreachable while MAX_RETRIEVAL_ROUNDS ≥ 1: the final round either
    // answers or errors above. Kept as a value rather than an unwrap so a
    // future knob of 0 degrades to a transient post instead of a panic.
    let _ = rendered;
    Err("the Operator ran out of rounds without answering".to_string())
}

/// One INFO line per executed verb — what was asked, whether it answered, how
/// long it took, and how much came back.
///
/// Without this the only trace a question leaves is `shared agent call
/// task=operator-retrieve outcome=ok`, which says nothing about what the model
/// looked for or what it got; a miss can then only be reconstructed by
/// inference. The volume is bounded by construction at `MAX_VERBS_PER_ROUND ×
/// MAX_RETRIEVAL_ROUNDS` lines per question, and questions are user-initiated,
/// so this belongs at INFO rather than DEBUG.
fn log_verb(
    round: usize,
    request: &VerbRequest,
    outcome: &Result<Value, String>,
    elapsed: std::time::Duration,
) {
    let args = request.args.to_string();
    let args: String = args.chars().take(VERB_LOG_ARGS_CHARS).collect();
    let elapsed_ms = elapsed.as_millis() as u64;
    match outcome {
        Ok(value) => {
            // `count` is what the row-returning verbs report; everything else
            // gets a size the reader can still compare across runs.
            let size = match value.get("count").and_then(Value::as_u64) {
                Some(count) => format!("rows={count}"),
                None => format!("bytes={}", value.to_string().len()),
            };
            info!(
                round,
                verb = %request.verb,
                args = %args,
                outcome = "ok",
                elapsed_ms,
                size = %size,
                "overview operator verb",
            );
        }
        Err(err) => info!(
            round,
            verb = %request.verb,
            args = %args,
            outcome = "err",
            elapsed_ms,
            error = %err,
            "overview operator verb",
        ),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds::facts_library;
    use crate::session_ledger::SessionLedger;
    use tugcast_core::types::{OverviewPost, OverviewRef, OverviewRefKind};

    struct Fixture {
        ctx: OperatorContext,
        _dir: tempfile::TempDir,
        repo: tempfile::TempDir,
    }

    fn ledger() -> Arc<SessionLedger> {
        Arc::new(SessionLedger::open_in_memory().expect("in-memory ledger"))
    }

    /// A real git repo with two commits — the crate's git-feed tests' pattern.
    fn git_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .env("GIT_AUTHOR_NAME", "Test")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "Test")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .output()
                .expect("git");
            assert!(
                status.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&status.stderr)
            );
        };
        run(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.path().join("alpha.txt"), "hello overview\n").unwrap();
        // The incident's shape, reproduced: a document in a subdirectory whose
        // text contains `zone`, so `%design-notes.md` — the LIKE-contaminated
        // scope that made a scan silently search nothing — has a real file to
        // be repaired to. It rides the FIRST commit deliberately: several
        // tests read the last two commits and assert `add beta` is the newest,
        // so a third commit would move ground they stand on.
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(
            dir.path().join("docs/design-notes.md"),
            "## Placement\n\nThe card is partitioned into zones.\n",
        )
        .unwrap();
        run(&["add", "alpha.txt", "docs/design-notes.md"]);
        run(&["commit", "-q", "-m", "add alpha"]);
        std::fs::write(dir.path().join("beta.txt"), "second file\n").unwrap();
        run(&["add", "beta.txt"]);
        run(&["commit", "-q", "-m", "add beta"]);
        dir
    }

    fn fixture() -> Fixture {
        fixture_with_haiku(None)
    }

    /// The same fixture, carrying a pool for the expansion rung. Every verb
    /// test but the [P09] ones runs with `None`, which is also what the
    /// degradation contract says production does when no pool is present.
    fn fixture_with_haiku(haiku: Option<Arc<crate::shared_agent::SharedAgentPool>>) -> Fixture {
        let repo = git_repo();
        let dir = tempfile::tempdir().expect("tempdir");
        Fixture {
            ctx: OperatorContext {
                ledger: ledger(),
                shell_ledger: Some(Arc::new(
                    ShellLedger::open_in_memory().expect("in-memory shell ledger"),
                )),
                bootstrap_project_dir: repo.path().to_path_buf(),
                attachments_dir: dir.path().join("overview-attachments"),
                haiku,
            },
            _dir: dir,
            repo,
        }
    }

    fn seed_post(ctx: &OperatorContext, body: &str, session_id: Option<&str>) -> i64 {
        ctx.ledger
            .record_overview_post(&OverviewPost {
                id: None,
                at_ms: 1_700_000_000_000,
                author: OverviewAuthor::Observer,
                session_id: session_id.map(str::to_string),
                wake_reason: Some("turn-end".to_string()),
                body: body.to_string(),
                refs: vec![OverviewRef {
                    kind: OverviewRefKind::File,
                    target: "tugdeck/styles/themes/brio.css".to_string(),
                }],
                elapsed_ms: None,
                project_dir: None,
                attachments: Vec::new(),
                request_id: None,
                transient: false,
            })
            .expect("post recorded")
    }

    #[tokio::test]
    async fn an_unknown_verb_is_an_error_the_model_can_read() {
        let f = fixture();
        let err = run_verb(&f.ctx, "git.blame", &json!({}))
            .await
            .expect_err("unknown verb");
        assert!(err.contains("unknown verb"));
        assert!(err.contains("repo.grep"), "the error lists the real verbs");
    }

    #[tokio::test]
    async fn a_missing_required_argument_is_an_error_not_a_panic() {
        let f = fixture();
        let err = run_verb(&f.ctx, "overview.search", &json!({}))
            .await
            .expect_err("missing query");
        assert!(err.contains("query"));
    }

    #[tokio::test]
    async fn overview_search_caps_at_twenty_posts() {
        let f = fixture();
        for i in 0..30 {
            seed_post(&f.ctx, &format!("theme token work number {i}"), None);
        }
        let out = run_verb(&f.ctx, "overview.search", &json!({"query": "token"}))
            .await
            .expect("search ran");
        assert_eq!(out["posts"].as_array().unwrap().len(), SEARCH_LIMIT);
        assert!(out["posts"][0]["excerpt"].is_string());
    }

    #[tokio::test]
    async fn overview_window_clamps_n_to_ten_each_side() {
        let f = fixture();
        let mut ids = Vec::new();
        for i in 0..40 {
            ids.push(seed_post(&f.ctx, &format!("post {i}"), None));
        }
        let middle = ids[20];
        let out = run_verb(
            &f.ctx,
            "overview.window",
            &json!({"post_id": middle, "n": 500}),
        )
        .await
        .expect("window ran");
        // Ten either side plus the hit itself.
        assert_eq!(out["posts"].as_array().unwrap().len(), WINDOW_MAX_N * 2 + 1);
    }

    #[tokio::test]
    async fn sessions_list_returns_an_incipit_and_honors_active() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn("sess-a", "ws", "/proj", "card-1", 1_000, None)
            .expect("spawn");
        f.ctx
            .ledger
            .record_user_prompt("sess-a", "why is the brio wash so pale")
            .expect("prompt");
        f.ctx
            .ledger
            .record_spawn("sess-b", "ws", "/proj", "card-2", 2_000, None)
            .expect("spawn");
        f.ctx.ledger.mark_closed("sess-b").expect("closed");

        let all = run_verb(&f.ctx, "sessions.list", &json!({}))
            .await
            .expect("list ran");
        assert_eq!(all["sessions"].as_array().unwrap().len(), 2);

        let live = run_verb(&f.ctx, "sessions.list", &json!({"active": true}))
            .await
            .expect("list ran");
        let rows = live["sessions"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["session_id"], "sess-a");
        assert_eq!(rows[0]["incipit"], "why is the brio wash so pale");
    }

    #[tokio::test]
    async fn sessions_list_serves_the_callsign_and_synopsis_the_answer_voice_asks_for() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn("sess-a", "ws", "/proj", "card-1", 1_000, Some("kind-floor"))
            .expect("spawn");
        f.ctx
            .ledger
            .record_synopsis("sess-a", "tuning the brio theme's wash")
            .expect("synopsis");
        // A row from before either field existed serves nulls, not omissions —
        // the shape is the same whatever the ledger happens to hold.
        f.ctx
            .ledger
            .record_spawn("sess-b", "ws", "/proj", "card-2", 2_000, None)
            .expect("spawn");

        let out = run_verb(&f.ctx, "sessions.list", &json!({}))
            .await
            .expect("list ran");
        let rows = out["sessions"].as_array().unwrap();
        let tagged = rows
            .iter()
            .find(|r| r["session_id"] == "sess-a")
            .expect("its row");
        assert_eq!(tagged["tag"], "kind-floor");
        assert_eq!(tagged["synopsis"], "tuning the brio theme's wash");

        let bare = rows
            .iter()
            .find(|r| r["session_id"] == "sess-b")
            .expect("its row");
        assert!(bare["tag"].is_null());
        assert!(bare["synopsis"].is_null());
    }

    #[tokio::test]
    async fn a_long_synopsis_is_cut_so_fifty_sessions_stay_a_list() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn("sess-a", "ws", "/proj", "card-1", 1_000, None)
            .expect("spawn");
        f.ctx
            .ledger
            .record_synopsis("sess-a", &"x".repeat(INCIPIT_CHARS * 3))
            .expect("synopsis");
        let out = run_verb(&f.ctx, "sessions.list", &json!({}))
            .await
            .expect("list ran");
        let synopsis = out["sessions"][0]["synopsis"].as_str().unwrap();
        assert_eq!(
            synopsis.chars().count(),
            INCIPIT_CHARS + 1,
            "capped plus '…'"
        );
    }

    #[tokio::test]
    async fn session_prompts_truncates_each_prompt() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn("sess-a", "ws", "/proj", "card-1", 1_000, None)
            .expect("spawn");
        let long = "x".repeat(facts_library::PROMPT_TEXT_CAP * 2);
        f.ctx
            .ledger
            .record_user_prompt("sess-a", &long)
            .expect("prompt");
        let out = run_verb(&f.ctx, "session.prompts", &json!({"session_id": "sess-a"}))
            .await
            .expect("prompts ran");
        let text = out["prompts"][0]["text"].as_str().unwrap();
        assert_eq!(
            text.chars().count(),
            facts_library::PROMPT_TEXT_CAP + 1,
            "capped plus '…'"
        );
    }

    /// Record a fact through the same builders the live recorders use, so a
    /// verb test reads exactly the rows production writes.
    fn seed_fact(ctx: &OperatorContext, fact: &crate::session_ledger::NewFact) -> i64 {
        ctx.ledger
            .record_fact(fact)
            .expect("fact recorded")
            .expect("a new row")
    }

    fn seed_exchange(ctx: &OperatorContext, session: &str, command: &str, at_ms: i64) {
        ctx.shell_ledger
            .as_deref()
            .expect("the fixture has a shell ledger")
            .record_exchange(&crate::shell_ledger::NewShellExchange {
                tug_session_id: session.to_string(),
                command: command.to_string(),
                output: "o".repeat(SHELL_OUTPUT_MAX_CHARS * 3),
                exit_code: Some(0),
                cwd: "/proj".to_string(),
                cwd_after: None,
                started_at_ms: at_ms - 10,
                settled_at_ms: at_ms,
                anchor_msg_id: None,
            })
            .expect("exchange recorded");
    }

    #[tokio::test]
    async fn facts_search_narrows_by_kind_and_caps_its_results() {
        let f = fixture();
        for i in 0..40 {
            seed_fact(
                &f.ctx,
                &facts_library::shell_fact(
                    1_000 + i,
                    Some("sess-a"),
                    &facts_library::ShellFact {
                        command: &format!("cargo nextest run -p tugcast case{i}"),
                        route: facts_library::ShellRoute::Claude,
                        ok: true,
                        exit_code: None,
                        cwd: None,
                    },
                    None,
                ),
            );
        }
        seed_fact(
            &f.ctx,
            &facts_library::prompt_fact(2_000, "sess-a", "run the nextest suite please"),
        );

        let all = run_verb(&f.ctx, "facts.search", &json!({"query": "nextest"}))
            .await
            .expect("search ran");
        assert_eq!(
            all["facts"].as_array().unwrap().len(),
            FACTS_SEARCH_LIMIT,
            "capped at the verb's limit"
        );
        assert!(all["facts"][0]["excerpt"].is_string());

        let prompts = run_verb(
            &f.ctx,
            "facts.search",
            &json!({"query": "nextest", "kind": "prompt"}),
        )
        .await
        .expect("search ran");
        let rows = prompts["facts"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "the kind filter narrows to the prompt fact");
        assert_eq!(rows[0]["kind"], "prompt");
    }

    fn hit(id: i64, kind: &str) -> FactSearchHit {
        FactSearchHit {
            fact: FactRow {
                id,
                at_ms: 1_000 + id,
                kind: kind.to_string(),
                session_id: None,
                subject: Some(format!("subject-{id}")),
                text: format!("text-{id}"),
                payload: "{}".to_string(),
            },
            excerpt: format!("excerpt-{id}"),
        }
    }

    fn kinds_of(hits: &[FactSearchHit]) -> Vec<&str> {
        hits.iter().map(|h| h.fact.kind.as_str()).collect()
    }

    #[test]
    fn budgeting_puts_the_minority_kind_on_a_page_a_loud_kind_would_have_taken() {
        // The 2026-08-15 shape: dozens of shell facts matching the query word
        // literally, and the two commit facts that actually answer the
        // question, which raw bm25 order buries past the page.
        let mut hits: Vec<FactSearchHit> = (0..35).map(|i| hit(i, "shell")).collect();
        hits.push(hit(100, "commit"));
        hits.push(hit(101, "commit"));

        let (page, note) = budget_by_kind(hits, 30);
        assert_eq!(page.len(), 30);
        assert_eq!(
            page.iter().filter(|h| h.fact.kind == "commit").count(),
            2,
            "both commit facts made the page"
        );
        // Rank order survives: the cap skips rows, it never reorders them. The
        // seeded ids ascend with rank, so the shell rows must too.
        let shell_ids: Vec<i64> = page
            .iter()
            .filter(|h| h.fact.kind == "shell")
            .map(|h| h.fact.id)
            .collect();
        assert!(
            shell_ids.windows(2).all(|w| w[0] < w[1]),
            "rank order disturbed: {shell_ids:?}"
        );
        // The first twelve rows are the capped kind, then the minority lands.
        assert_eq!(&kinds_of(&page)[..KIND_PAGE_CAP], &["shell"; KIND_PAGE_CAP]);
        assert_eq!(kinds_of(&page)[KIND_PAGE_CAP], "commit");

        // Leftover room refilled the capped kind rather than being wasted, and
        // what still did not fit is reported rather than silently dropped:
        // 35 shell + 2 commit = 37 matched, 30 fit, so 7 shell are missing.
        let note = note.expect("a capped page says so");
        assert!(
            note.contains("7 more shell fact(s)"),
            "note counts what the caller is missing: {note}"
        );
        assert!(
            note.contains("kind: \"shell\""),
            "note names the escape: {note}"
        );
    }

    #[test]
    fn a_single_kind_result_set_passes_through_untouched() {
        let hits: Vec<FactSearchHit> = (0..20).map(|i| hit(i, "shell")).collect();
        let (page, note) = budget_by_kind(hits, 30);
        assert_eq!(page.len(), 20, "nothing to balance, nothing capped");
        assert_eq!(kinds_of(&page), vec!["shell"; 20]);
        assert!(note.is_none(), "no cap fired, so no note");
    }

    #[test]
    fn a_page_that_fits_is_never_capped_however_many_kinds_matched() {
        let hits = vec![hit(1, "shell"), hit(2, "commit"), hit(3, "prompt")];
        let (page, note) = budget_by_kind(hits, 30);
        assert_eq!(kinds_of(&page), vec!["shell", "commit", "prompt"]);
        assert!(note.is_none());
    }

    #[tokio::test]
    async fn a_commit_fact_survives_a_page_of_shell_facts_that_match_the_same_word() {
        let f = fixture();
        for i in 0..35 {
            seed_fact(
                &f.ctx,
                &facts_library::shell_fact(
                    1_000 + i,
                    Some("sess-a"),
                    &facts_library::ShellFact {
                        command: &format!("rg tooltip tugdeck/src/case{i}"),
                        route: facts_library::ShellRoute::Claude,
                        ok: true,
                        exit_code: None,
                        cwd: None,
                    },
                    None,
                ),
            );
        }
        for (i, sha) in ["ac462ba3a1ae", "beefcafe1234"].iter().enumerate() {
            seed_fact(
                &f.ctx,
                &facts_library::commit_fact(
                    2_000 + i as i64,
                    Some("sess-a"),
                    sha,
                    "tugways: regularize tooltip presentation",
                    &["tugdeck/src/tooltip.tsx".to_string()],
                    None,
                ),
            );
        }

        let found = run_verb(&f.ctx, "facts.search", &json!({"query": "tooltip"}))
            .await
            .expect("search ran");
        let rows = found["facts"].as_array().unwrap();
        let commits: Vec<&Value> = rows.iter().filter(|r| r["kind"] == "commit").collect();
        assert_eq!(commits.len(), 2, "both commit facts are on the page");
        assert!(found["note"].is_string(), "the capped page says so");

        // An explicit kind is the caller having made the choice themselves, so
        // the budgeter stands down entirely.
        let aimed = run_verb(
            &f.ctx,
            "facts.search",
            &json!({"query": "tooltip", "kind": "commit"}),
        )
        .await
        .expect("search ran");
        assert_eq!(aimed["count"], 2);
        assert!(aimed["note"].is_null(), "an aimed search is never capped");
    }

    #[tokio::test]
    async fn facts_list_browses_newest_first_and_caps_its_results() {
        let f = fixture();
        for i in 0..40 {
            seed_fact(
                &f.ctx,
                &facts_library::shell_fact(
                    1_000 + i,
                    Some("sess-a"),
                    &facts_library::ShellFact {
                        command: &format!("cargo build case{i}"),
                        route: facts_library::ShellRoute::Claude,
                        ok: true,
                        exit_code: None,
                        cwd: None,
                    },
                    None,
                ),
            );
        }
        // No arguments at all is a legal call — this is the browse verb.
        let out = run_verb(&f.ctx, "facts.list", &json!({}))
            .await
            .expect("list ran");
        let rows = out["facts"].as_array().unwrap();
        assert_eq!(rows.len(), FACTS_LIST_LIMIT);
        assert_eq!(out["count"], FACTS_LIST_LIMIT);
        assert_eq!(rows[0]["at_ms"], 1_039, "newest first");
        assert!(rows[0]["text"].as_str().unwrap().starts_with("$ "));
    }

    #[tokio::test]
    async fn facts_list_narrows_by_kind_and_time_and_shrugs_at_an_unknown_kind() {
        let f = fixture();
        seed_fact(
            &f.ctx,
            &facts_library::prompt_fact(1_000, "sess-a", "why is the wash so pale"),
        );
        seed_fact(
            &f.ctx,
            &facts_library::prompt_fact(9_000, "sess-a", "and why is it still pale"),
        );
        seed_fact(
            &f.ctx,
            &facts_library::shell_fact(
                5_000,
                Some("sess-a"),
                &facts_library::ShellFact {
                    command: "cargo build",
                    route: facts_library::ShellRoute::Claude,
                    ok: true,
                    exit_code: None,
                    cwd: None,
                },
                None,
            ),
        );

        let prompts = run_verb(&f.ctx, "facts.list", &json!({"kind": "prompt"}))
            .await
            .expect("list ran");
        assert_eq!(prompts["count"], 2);

        let recent = run_verb(
            &f.ctx,
            "facts.list",
            &json!({"kind": "prompt", "since_ms": 2_000}),
        )
        .await
        .expect("list ran");
        assert_eq!(recent["count"], 1);
        assert_eq!(recent["facts"][0]["at_ms"], 9_000);

        // A kind is a filter value, not a schema key: an unrecognized one is an
        // empty answer the model can read, never an error it has to recover
        // from.
        let nothing = run_verb(&f.ctx, "facts.list", &json!({"kind": "no.such.kind"}))
            .await
            .expect("list ran");
        assert_eq!(nothing["count"], 0);
    }

    #[tokio::test]
    async fn every_fact_verb_serves_the_same_row_shape_with_its_detail() {
        let f = fixture();
        let files: Vec<String> = (0..4).map(|i| format!("tugdeck/src/f{i}.tsx")).collect();
        let id = seed_fact(
            &f.ctx,
            &facts_library::commit_fact(
                1_000,
                Some("sess-a"),
                "3f16971ba0dea1b2",
                "tugways(transcript-copy): route native ⌘C through onCopy substitution",
                &files,
                None,
            ),
        );

        for (verb, args) in [
            ("facts.list", json!({"kind": "commit"})),
            ("facts.search", json!({"query": "transcript"})),
            ("facts.window", json!({"fact_id": id, "n": 0})),
        ] {
            let out = run_verb(&f.ctx, verb, &args).await.expect("verb ran");
            let row = &out["facts"][0];
            assert_eq!(row["kind"], "commit", "{verb}");
            // The whole point of the projection: the file list the one-line
            // rendering could only count is now readable without a git.show
            // round re-fetching it.
            assert_eq!(
                row["detail"]["files"].as_array().unwrap().len(),
                4,
                "{verb}"
            );
            assert_eq!(row["detail"]["files"][0], "tugdeck/src/f0.tsx", "{verb}");
            assert_eq!(row["detail"]["sha"], "3f16971ba0dea1b2", "{verb}");
            assert!(
                row["text"].as_str().unwrap().ends_with("— 4 file(s)"),
                "{verb}"
            );
        }
    }

    #[tokio::test]
    async fn a_fact_whose_payload_will_not_parse_serves_no_detail_and_no_error() {
        let f = fixture();
        let mut broken = facts_library::prompt_fact(1_000, "sess-a", "what happened");
        broken.payload = "{not json at all".to_string();
        seed_fact(&f.ctx, &broken);

        let out = run_verb(&f.ctx, "facts.list", &json!({}))
            .await
            .expect("list ran");
        let row = &out["facts"][0];
        assert_eq!(
            row["text"], "prompt: \"what happened\"",
            "the row still reads"
        );
        assert!(
            row.get("detail").is_none(),
            "the key is omitted entirely rather than served empty"
        );
    }

    #[tokio::test]
    async fn facts_search_reports_a_malformed_query_to_the_model() {
        let f = fixture();
        let err = run_verb(&f.ctx, "facts.search", &json!({"query": "\"unbalanced"}))
            .await
            .expect_err("FTS5 rejects the query");
        assert!(err.starts_with("facts.search:"));
    }

    /// The commit the 2026-08-15 question was asking about, as a fact.
    fn seed_tooltip_commit(f: &Fixture) {
        seed_fact(
            &f.ctx,
            &facts_library::commit_fact(
                3_000,
                Some("sess-a"),
                "ac462ba3a1ae",
                "tugways(entity-tips): unify commit hover into a real TugTooltip",
                &["tugdeck/src/chrome/entity-tips.tsx".to_string()],
                None,
            ),
        );
    }

    #[tokio::test]
    async fn a_query_that_matched_says_which_expression_found_the_rows() {
        let f = fixture();
        seed_tooltip_commit(&f);
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "tooltip"}))
            .await
            .expect("search ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["query_used"], "\"tooltip\"");
        assert!(out["note"].is_null(), "nothing was relaxed");
    }

    #[tokio::test]
    async fn a_phrase_no_fact_contains_relaxes_to_its_terms() {
        let f = fixture();
        seed_tooltip_commit(&f);
        // FTS5 AND-s terms implicitly, so the natural phrase matches nothing —
        // the failure that cost the original question its first round.
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "tooltip colors"}))
            .await
            .expect("search ran");
        assert_eq!(out["count"], 1, "the ladder recovered the commit fact");
        assert_eq!(out["query_used"], "\"tooltip\" OR \"colors\"");
        assert!(
            out["note"].as_str().unwrap().contains("any term"),
            "note was {:?}",
            out["note"]
        );
    }

    #[tokio::test]
    async fn a_camel_case_query_reaches_prose_through_its_sub_words() {
        let f = fixture();
        // Prose only: nothing here is spelled `TugTooltip`, so an exact query
        // for the identifier matches neither the text nor the tokens column.
        seed_fact(
            &f.ctx,
            &facts_library::prompt_fact(4_000, "sess-a", "make the tooltip colors consistent"),
        );
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "TugTooltip"}))
            .await
            .expect("search ran");
        assert_eq!(out["count"], 1, "rung 2 split the identifier");
        assert_eq!(
            out["query_used"],
            "(\"TugTooltip\" OR \"tug\" OR \"tooltip\")"
        );
        assert!(
            out["note"].as_str().unwrap().contains("sub-words"),
            "note was {:?}",
            out["note"]
        );
    }

    #[tokio::test]
    async fn a_query_nothing_answers_comes_back_empty_and_honest() {
        let f = fixture();
        seed_tooltip_commit(&f);
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "quokka"}))
            .await
            .expect("search ran");
        assert_eq!(out["count"], 0);
        assert!(out["facts"].as_array().unwrap().is_empty());
        assert_eq!(out["query_used"], "\"quokka\"");
        assert!(out["note"].is_null(), "no rung fired, so nothing to say");
    }

    #[tokio::test]
    async fn a_query_of_pure_punctuation_is_an_empty_result_not_an_error() {
        let f = fixture();
        seed_tooltip_commit(&f);
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "--- ((("}))
            .await
            .expect("search ran");
        assert_eq!(out["count"], 0);
    }

    #[tokio::test]
    async fn the_overview_search_walks_the_same_ladder() {
        let f = fixture();
        seed_post(
            &f.ctx,
            "Unified the commit hover into a real TugTooltip.",
            None,
        );
        let out = run_verb(
            &f.ctx,
            "overview.search",
            &json!({"query": "tooltip presentation"}),
        )
        .await
        .expect("search ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["query_used"], "\"tooltip\" OR \"presentation\"");
        assert!(out["note"].as_str().unwrap().contains("posts"));
    }

    /// A pool over the real Haiku job table that answers `answer` to every
    /// turn — the project's seam for agent-dependent logic.
    fn scripted(
        answer: Result<String, String>,
    ) -> Option<Arc<crate::shared_agent::SharedAgentPool>> {
        Some(crate::shared_agent::test_support::scripted_haiku_pool(
            answer,
        ))
    }

    /// A record of work whose vocabulary shares nothing with how someone would
    /// describe the symptom — the concept-mismatch case [P09] exists for.
    fn seed_flicker_commit(f: &Fixture) {
        seed_fact(
            &f.ctx,
            &facts_library::commit_fact(
                5_000,
                Some("sess-a"),
                "b17c9f2d0011",
                "tugdeck(transcript): stop repaint flicker on theme switch",
                &["tugdeck/src/transcript.tsx".to_string()],
                None,
            ),
        );
    }

    #[tokio::test]
    async fn a_question_sharing_no_words_with_the_record_is_reached_by_expansion() {
        let f = fixture_with_haiku(scripted(Ok(
            r#"{"terms": ["flicker", "repaint"]}"#.to_string()
        )));
        seed_flicker_commit(&f);
        // Neither word is anywhere in the record, and neither decomposes, so
        // both lexical rungs come back empty.
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "cards blinking"}))
            .await
            .expect("search ran");
        assert_eq!(out["count"], 1, "the expansion rung found the commit");
        assert_eq!(out["query_used"], "\"flicker\" OR \"repaint\"");
        assert_eq!(out["note"], MODEL_TERMS_NOTE);
    }

    #[tokio::test]
    async fn without_a_pool_that_question_returns_the_honest_empty_result() {
        let f = fixture();
        assert!(f.ctx.haiku.is_none());
        seed_flicker_commit(&f);
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "cards blinking"}))
            .await
            .expect("search ran");
        assert_eq!(out["count"], 0);
        assert!(out["note"].is_null());
    }

    /// Every way the rung can fail is the same answer: the empty result the
    /// caller already had. None of them may fail the verb.
    #[tokio::test]
    async fn a_failed_expansion_degrades_rather_than_failing_the_verb() {
        for answer in [
            Err("worker died".to_string()),
            Ok("I'd try searching for flicker".to_string()),
            Ok(r#"{"terms": []}"#.to_string()),
            Ok(String::new()),
        ] {
            let f = fixture_with_haiku(scripted(answer.clone()));
            seed_flicker_commit(&f);
            let out = run_verb(&f.ctx, "facts.search", &json!({"query": "cards blinking"}))
                .await
                .unwrap_or_else(|err| panic!("verb failed on {answer:?}: {err}"));
            assert_eq!(out["count"], 0, "on {answer:?}");
            assert!(out["note"].is_null(), "on {answer:?}");
        }
    }

    #[tokio::test]
    async fn expansion_never_fires_when_a_lexical_rung_already_found_rows() {
        // The scripted terms would match a fact the question does not mean, so
        // that fact's absence is the proof the rung never ran.
        let f = fixture_with_haiku(scripted(Ok(r#"{"terms": ["flicker"]}"#.to_string())));
        seed_flicker_commit(&f);
        seed_tooltip_commit(&f);
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "tooltip colors"}))
            .await
            .expect("search ran");
        let subjects: Vec<&str> = out["facts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["text"].as_str().unwrap())
            .collect();
        assert_eq!(subjects.len(), 1, "{subjects:?}");
        assert!(subjects[0].contains("TugTooltip"), "{subjects:?}");
        assert_ne!(out["note"], MODEL_TERMS_NOTE);
    }

    #[tokio::test]
    async fn expansion_terms_are_sanitized_not_interpolated() {
        // A term carrying FTS5 syntax would syntax-error the query it lands
        // in, which would turn a graceful degradation into a failed verb.
        let f = fixture_with_haiku(scripted(Ok(
            r#"{"terms": ["\"unbalanced", "NEAR(x", "repaint*", "flicker"]}"#.to_string(),
        )));
        seed_flicker_commit(&f);
        let out = run_verb(&f.ctx, "facts.search", &json!({"query": "cards blinking"}))
            .await
            .expect("a term full of syntax must not fail the verb");
        assert_eq!(out["count"], 1);
        assert_eq!(out["note"], MODEL_TERMS_NOTE);
    }

    #[tokio::test]
    async fn the_overview_search_gets_the_same_rung() {
        let f = fixture_with_haiku(scripted(Ok(r#"{"terms": ["flicker"]}"#.to_string())));
        seed_post(&f.ctx, "Stopped the repaint flicker on theme switch.", None);
        let out = run_verb(
            &f.ctx,
            "overview.search",
            &json!({"query": "cards blinking"}),
        )
        .await
        .expect("search ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["query_used"], "\"flicker\"");
        assert_eq!(out["note"], MODEL_TERMS_NOTE);
    }

    #[tokio::test]
    async fn facts_window_clamps_n_to_twenty_each_side() {
        let f = fixture();
        let mut ids = Vec::new();
        for i in 0..60 {
            ids.push(seed_fact(
                &f.ctx,
                &facts_library::prompt_fact(1_000 + i, "sess-a", &format!("prompt {i}")),
            ));
        }
        let out = run_verb(
            &f.ctx,
            "facts.window",
            &json!({"fact_id": ids[30], "n": 500}),
        )
        .await
        .expect("window ran");
        assert_eq!(
            out["facts"].as_array().unwrap().len(),
            FACTS_WINDOW_MAX_N * 2 + 1,
            "twenty either side plus the hit"
        );
    }

    #[tokio::test]
    async fn shell_history_filters_by_session_and_substring_and_excerpts_output() {
        let f = fixture();
        seed_exchange(&f.ctx, "sess-a", "just app-test at0287.test.ts", 5_000);
        seed_exchange(&f.ctx, "sess-a", "git status", 6_000);
        seed_exchange(&f.ctx, "sess-b", "just build-app", 7_000);

        let mine = run_verb(&f.ctx, "shell.history", &json!({"session_id": "sess-a"}))
            .await
            .expect("history ran");
        let rows = mine["commands"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "only this session's commands");
        assert_eq!(rows[0]["command"], "git status", "newest first");
        assert_eq!(
            rows[0]["output_excerpt"].as_str().unwrap().chars().count(),
            SHELL_OUTPUT_MAX_CHARS + 1,
            "output is excerpted, not returned whole"
        );

        let just = run_verb(&f.ctx, "shell.history", &json!({"query": "just "}))
            .await
            .expect("history ran");
        let rows = just["commands"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "the substring matches across sessions");
    }

    #[tokio::test]
    async fn shell_history_without_a_shell_ledger_says_so() {
        let mut f = fixture();
        f.ctx.shell_ledger = None;
        let err = run_verb(&f.ctx, "shell.history", &json!({}))
            .await
            .expect_err("no history to read");
        assert!(err.contains("no shell command history"));
    }

    #[tokio::test]
    async fn session_prompts_reads_the_whole_history_from_facts() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn("sess-a", "ws", "/proj", "card-1", 1_000, None)
            .expect("spawn");
        // Three prompts recorded as facts; the session row remembers only the
        // last of them, which is exactly the gap the library closes.
        for (i, text) in ["first question", "second question", "third question"]
            .iter()
            .enumerate()
        {
            seed_fact(
                &f.ctx,
                &facts_library::prompt_fact(2_000 + i as i64, "sess-a", text),
            );
        }
        f.ctx
            .ledger
            .record_user_prompt("sess-a", "third question")
            .expect("prompt");

        let out = run_verb(&f.ctx, "session.prompts", &json!({"session_id": "sess-a"}))
            .await
            .expect("prompts ran");
        let rows = out["prompts"].as_array().unwrap();
        assert_eq!(rows.len(), 3, "every prompt, oldest first");
        assert_eq!(rows[0]["text"], "first question");
        assert_eq!(rows[2]["text"], "third question");
        assert!(
            out.get("note").is_none(),
            "there is nothing to apologize for once the facts are there"
        );

        let filtered = run_verb(
            &f.ctx,
            "session.prompts",
            &json!({"session_id": "sess-a", "query": "second"}),
        )
        .await
        .expect("prompts ran");
        assert_eq!(filtered["prompts"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn session_prompts_keeps_its_note_for_a_session_predating_the_library() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn("sess-a", "ws", "/proj", "card-1", 1_000, None)
            .expect("spawn");
        f.ctx
            .ledger
            .record_user_prompt("sess-a", "the only prompt the row remembers")
            .expect("prompt");
        let out = run_verb(&f.ctx, "session.prompts", &json!({"session_id": "sess-a"}))
            .await
            .expect("prompts ran");
        assert_eq!(out["prompts"].as_array().unwrap().len(), 1);
        assert!(
            out["note"]
                .as_str()
                .expect("the note is present")
                .contains("predates the facts library")
        );
    }

    #[tokio::test]
    async fn session_prompts_on_an_unknown_session_is_an_error() {
        let f = fixture();
        let err = run_verb(&f.ctx, "session.prompts", &json!({"session_id": "nope"}))
            .await
            .expect_err("unknown session");
        assert!(err.contains("no session"));
    }

    #[tokio::test]
    async fn git_log_reads_the_bootstrap_repo_and_names_files() {
        let f = fixture();
        let out = run_verb(&f.ctx, "git.log", &json!({}))
            .await
            .expect("log ran");
        let commits = out["commits"].as_array().unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0]["subject"], "add beta");
        assert_eq!(commits[0]["files"][0], "beta.txt");
    }

    #[tokio::test]
    async fn git_log_clamps_n_to_thirty() {
        let f = fixture();
        let out = run_verb(&f.ctx, "git.log", &json!({"n": 9_000}))
            .await
            .expect("log ran");
        // The fixture has two commits; the point is that the clamp made a
        // bounded request rather than that git had thirty to give.
        assert!(out["commits"].as_array().unwrap().len() <= GIT_LOG_MAX_N);
    }

    #[tokio::test]
    async fn a_pickaxe_payload_shaped_like_a_flag_is_refused() {
        let f = fixture();
        let err = run_verb(&f.ctx, "git.log", &json!({"pickaxe": "-S--output=/tmp/x"}))
            .await
            .expect_err("flag-shaped pickaxe");
        assert!(err.contains("may not begin with '-'"));
    }

    #[tokio::test]
    async fn an_upload_pack_path_is_refused() {
        let f = fixture();
        let err = run_verb(
            &f.ctx,
            "git.log",
            &json!({"path": "--upload-pack=touch /tmp/x"}),
        )
        .await
        .expect_err("flag-shaped path");
        assert!(err.contains("may not begin with '-'"));

        let err = run_verb(
            &f.ctx,
            "repo.grep",
            &json!({"pattern": "hello", "path_scope": "--upload-pack=x"}),
        )
        .await
        .expect_err("flag-shaped scope");
        assert!(err.contains("may not begin with '-'"));
    }

    #[tokio::test]
    async fn a_path_may_not_escape_the_project_dir() {
        let f = fixture();
        let err = run_verb(&f.ctx, "git.log", &json!({"path": "../../etc/passwd"}))
            .await
            .expect_err("traversal");
        assert!(err.contains(".."));

        let err = run_verb(&f.ctx, "git.log", &json!({"path": "/etc/passwd"}))
            .await
            .expect_err("absolute");
        assert!(err.contains("repo-relative"));
    }

    #[tokio::test]
    async fn git_show_refuses_anything_that_is_not_a_hex_object_name() {
        let f = fixture();
        for bad in ["--upload-pack=x", "HEAD; rm -rf /", "zzzz"] {
            let err = run_verb(&f.ctx, "git.show", &json!({"sha": bad}))
                .await
                .expect_err("non-sha");
            assert!(err.contains("hex object name"), "{bad}: {err}");
        }
    }

    #[tokio::test]
    async fn git_show_caps_its_diff() {
        let f = fixture();
        // A commit whose diff comfortably exceeds the line cap.
        let big: String = (0..GIT_SHOW_MAX_LINES * 2)
            .map(|i| format!("line {i}\n"))
            .collect();
        std::fs::write(f.repo.path().join("big.txt"), big).unwrap();
        for args in [
            vec!["add", "big.txt"],
            vec![
                "-c",
                "user.email=t@e.com",
                "-c",
                "user.name=T",
                "commit",
                "-q",
                "-m",
                "big",
            ],
        ] {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(f.repo.path())
                .args(&args)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let head = String::from_utf8(
            std::process::Command::new("git")
                .arg("-C")
                .arg(f.repo.path())
                .args(["rev-parse", "HEAD"])
                .output()
                .expect("git")
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        let out = run_verb(&f.ctx, "git.show", &json!({"sha": head}))
            .await
            .expect("show ran");
        assert_eq!(out["truncated"], true);
        let text = out["text"].as_str().unwrap();
        assert!(text.lines().count() <= GIT_SHOW_MAX_LINES + 1);
        assert!(text.len() <= GIT_SHOW_MAX_BYTES + 64);
    }

    #[tokio::test]
    async fn repo_grep_finds_a_match_and_reports_its_line() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.grep", &json!({"pattern": "overview"}))
            .await
            .expect("grep ran");
        let matches = out["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["path"], "alpha.txt");
        assert_eq!(matches[0]["line"], 1);
    }

    #[tokio::test]
    async fn repo_grep_with_no_match_is_an_empty_result_not_an_error() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.grep", &json!({"pattern": "nothinghere"}))
            .await
            .expect("grep ran");
        assert_eq!(out["count"], 0);
        assert!(
            out.get("note").is_none(),
            "an honest empty carries no recovery note"
        );
    }

    /// Rung 1: the pattern is in the repo, spelled differently. The rows come
    /// back, and the note says how they were found.
    #[tokio::test]
    async fn repo_grep_recovers_a_case_mismatch_and_says_so() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.grep", &json!({"pattern": "OVERVIEW"}))
            .await
            .expect("grep ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"][0]["path"], "alpha.txt");
        assert_eq!(out["pattern_used"], "OVERVIEW");
        assert_eq!(
            out["note"],
            "no case-sensitive match; showing case-insensitive matches"
        );
    }

    /// Rung 2, the "Z-zone" shape: a coinage whose pieces are in the text
    /// even though the coinage is not. The pieces are what get searched, and
    /// `pattern_used` reports them rather than presenting a loose match as an
    /// exact one.
    #[tokio::test]
    async fn repo_grep_decomposes_a_coinage_into_its_pieces() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.grep", &json!({"pattern": "Z-overview"}))
            .await
            .expect("grep ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"][0]["path"], "alpha.txt");
        assert_eq!(out["pattern_used"], "overview");
        assert_eq!(
            out["note"],
            "no literal match; showing case-insensitive matches for the pattern's pieces"
        );
    }

    /// An exact hit reports itself as exactly that: the pattern, no note.
    #[tokio::test]
    async fn repo_grep_exact_hit_carries_no_note() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.grep", &json!({"pattern": "overview"}))
            .await
            .expect("grep ran");
        assert_eq!(out["pattern_used"], "overview");
        assert!(out.get("note").is_none());
    }

    // MARK: - Path resolution ([P03])

    /// The four rungs, each reached only when the one above it found nothing.
    #[tokio::test]
    async fn path_candidates_walks_the_ladder_rung_by_rung() {
        let repo = git_repo();
        let dir = repo.path();

        let literal = repo_files::path_candidates(dir, "docs/design-notes.md")
            .await
            .expect("resolved");
        assert_eq!(literal.rung, Some(repo_files::Rung::Literal));
        assert_eq!(literal.paths, vec!["docs/design-notes.md".to_string()]);

        // The incident's own argument: SQL LIKE grammar in a git pathspec.
        let stripped = repo_files::path_candidates(dir, "%design-notes.md")
            .await
            .expect("resolved");
        assert_eq!(stripped.rung, Some(repo_files::Rung::BasenameGlob));
        assert_eq!(stripped.paths, vec!["docs/design-notes.md".to_string()]);

        let glob = repo_files::path_candidates(dir, "design-notes.md")
            .await
            .expect("resolved");
        assert_eq!(glob.rung, Some(repo_files::Rung::BasenameGlob));
        assert_eq!(glob.paths, vec!["docs/design-notes.md".to_string()]);

        let insensitive = repo_files::path_candidates(dir, "DESIGN-NOTES.MD")
            .await
            .expect("resolved");
        assert_eq!(insensitive.rung, Some(repo_files::Rung::CaseInsensitive));
        assert_eq!(insensitive.paths, vec!["docs/design-notes.md".to_string()]);

        let nothing = repo_files::path_candidates(dir, "no-such-file.md")
            .await
            .expect("resolved");
        assert_eq!(nothing.rung, None);
        assert!(nothing.paths.is_empty());
    }

    /// A directory scope resolves literally however many files it names —
    /// multiplicity is not ambiguity ([P03]).
    #[tokio::test]
    async fn a_directory_pathspec_resolves_literally() {
        let repo = git_repo();
        let resolved = repo_files::resolve_grep_scope(repo.path(), "docs/")
            .await
            .expect("resolved");
        assert_eq!(resolved.used, vec!["docs/".to_string()]);
        assert!(resolved.note.is_none(), "an exact scope carries no note");
    }

    /// Incident B, end to end: the LIKE-contaminated scope now finds the file
    /// it meant, searches it, and says the scope was repaired.
    #[tokio::test]
    async fn repo_grep_repairs_a_like_contaminated_scope_and_says_so() {
        let f = fixture();
        let out = run_verb(
            &f.ctx,
            "repo.grep",
            &json!({"pattern": "zone", "path_scope": "%design-notes.md"}),
        )
        .await
        .expect("grep ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["matches"][0]["path"], "docs/design-notes.md");
        assert_eq!(out["path_scope_used"], "docs/design-notes.md");
        assert!(
            out["note"]
                .as_str()
                .expect("a repair note")
                .contains("%design-notes.md"),
            "the note names what the model wrote: {}",
            out["note"]
        );
    }

    /// The test that would have caught incident B. A scope matching nothing is
    /// an error — never `Ok` with `count: 0`, which the answering model reads
    /// as proof of absence.
    #[tokio::test]
    async fn a_scope_that_matches_nothing_is_an_error_not_an_empty_result() {
        let f = fixture();
        let result = run_verb(
            &f.ctx,
            "repo.grep",
            &json!({"pattern": "zone", "path_scope": "no-such-file.md"}),
        )
        .await;
        let err = match result {
            Err(err) => err,
            Ok(out) => panic!("an unsearched scope must not come back as a result: {out}"),
        };
        assert!(err.contains("no-such-file.md"), "names the argument: {err}");
        assert!(
            err.contains("nothing was read or searched"),
            "says the scan never ran: {err}"
        );
    }

    /// The near-miss list is what lets the next round name a real file.
    #[tokio::test]
    async fn an_unmatched_scope_offers_the_names_it_did_find() {
        let f = fixture();
        let err = run_verb(
            &f.ctx,
            "repo.grep",
            &json!({"pattern": "zone", "path_scope": "docs/design-notes.markdown"}),
        )
        .await
        .expect_err("unmatched scope");
        assert!(
            err.contains("docs/design-notes.md"),
            "offers the real neighbour: {err}"
        );
    }

    /// An exact scope passes through untouched, note-free.
    #[tokio::test]
    async fn repo_grep_with_an_exact_scope_reports_it_unchanged() {
        let f = fixture();
        let out = run_verb(
            &f.ctx,
            "repo.grep",
            &json!({"pattern": "zone", "path_scope": "docs/design-notes.md"}),
        )
        .await
        .expect("grep ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["path_scope_used"], "docs/design-notes.md");
        assert!(out.get("note").is_none());
    }

    /// A scope that exists and simply does not contain the pattern is the one
    /// case that may return zero rows — and now it is the only one.
    #[tokio::test]
    async fn a_real_scope_with_no_match_is_still_an_honest_empty() {
        let f = fixture();
        let out = run_verb(
            &f.ctx,
            "repo.grep",
            &json!({"pattern": "nothinghere", "path_scope": "docs/design-notes.md"}),
        )
        .await
        .expect("grep ran");
        assert_eq!(out["count"], 0);
        assert_eq!(out["path_scope_used"], "docs/design-notes.md");
        assert!(out.get("note").is_none());
    }

    // MARK: - repo.ls ([S03])

    #[tokio::test]
    async fn repo_ls_resolves_a_name_fragment_to_real_paths() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.ls", &json!({"pattern": "design-notes"}))
            .await
            .expect("ls ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["paths"][0], "docs/design-notes.md");
    }

    /// Unlike a scan, a naming question's empty answer is a real answer.
    #[tokio::test]
    async fn repo_ls_finding_nothing_is_a_result_not_an_error() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.ls", &json!({"pattern": "no-such-file"}))
            .await
            .expect("ls ran");
        assert_eq!(out["count"], 0);
        assert!(out["paths"].as_array().expect("paths").is_empty());
    }

    // MARK: - repo.read ([S01])

    /// A file long enough to make the windows and the caps mean something.
    fn write_long_file(repo: &tempfile::TempDir, name: &str, lines: usize) {
        let body: String = (1..=lines).map(|n| format!("line {n}\n")).collect();
        std::fs::write(repo.path().join(name), body).expect("wrote fixture file");
    }

    #[tokio::test]
    async fn repo_read_returns_numbered_lines_and_the_real_total() {
        let f = fixture();
        write_long_file(&f.repo, "long.txt", 10);
        let out = run_verb(&f.ctx, "repo.read", &json!({"path": "long.txt"}))
            .await
            .expect("read ran");
        assert_eq!(out["total_lines"], 10);
        assert_eq!(out["start"], 1);
        assert_eq!(out["end"], 10);
        assert_eq!(out["lines"][0], json!({"line": 1, "text": "line 1"}));
        assert_eq!(out["lines"][9], json!({"line": 10, "text": "line 10"}));
        assert_eq!(out["truncated"], false);
        assert!(out.get("note").is_none());
    }

    #[tokio::test]
    async fn repo_read_honors_an_explicit_range() {
        let f = fixture();
        write_long_file(&f.repo, "long.txt", 50);
        let out = run_verb(
            &f.ctx,
            "repo.read",
            &json!({"path": "long.txt", "start": 20, "end": 22}),
        )
        .await
        .expect("read ran");
        assert_eq!(out["start"], 20);
        assert_eq!(out["end"], 22);
        assert_eq!(out["lines"].as_array().expect("lines").len(), 3);
        assert_eq!(out["lines"][0], json!({"line": 20, "text": "line 20"}));
        assert_eq!(out["total_lines"], 50);
    }

    /// The grep-hit → read pairing: a line number becomes a window, and the
    /// window clamps rather than running off either end of the file.
    #[tokio::test]
    async fn repo_read_centers_on_a_line_and_clamps_at_both_ends() {
        let f = fixture();
        write_long_file(&f.repo, "long.txt", 30);
        let centered = run_verb(
            &f.ctx,
            "repo.read",
            &json!({"path": "long.txt", "around_line": 15, "context": 2}),
        )
        .await
        .expect("read ran");
        assert_eq!(centered["start"], 13);
        assert_eq!(centered["end"], 17);

        let head = run_verb(
            &f.ctx,
            "repo.read",
            &json!({"path": "long.txt", "around_line": 2, "context": 10}),
        )
        .await
        .expect("read ran");
        assert_eq!(head["start"], 1);

        let tail = run_verb(
            &f.ctx,
            "repo.read",
            &json!({"path": "long.txt", "around_line": 29, "context": 10}),
        )
        .await
        .expect("read ran");
        assert_eq!(tail["end"], 30);
    }

    /// A capped read says it was capped, and still says how long the file is —
    /// which is what stops a model reading the cap as the end of the file.
    #[tokio::test]
    async fn a_read_wider_than_the_cap_is_marked_truncated() {
        let f = fixture();
        write_long_file(&f.repo, "huge.txt", READ_MAX_LINES + 40);
        let out = run_verb(&f.ctx, "repo.read", &json!({"path": "huge.txt"}))
            .await
            .expect("read ran");
        assert_eq!(out["truncated"], true);
        assert_eq!(out["total_lines"], (READ_MAX_LINES + 40) as i64);
        assert_eq!(
            out["lines"].as_array().expect("lines").len(),
            READ_MAX_LINES
        );
    }

    #[tokio::test]
    async fn reading_a_directory_points_at_repo_ls() {
        let f = fixture();
        let err = run_verb(&f.ctx, "repo.read", &json!({"path": "docs"}))
            .await
            .expect_err("a directory is not a file");
        assert!(err.contains("directory"), "{err}");
        assert!(
            err.contains("repo.ls"),
            "the error names the way out: {err}"
        );
    }

    #[tokio::test]
    async fn a_binary_file_is_refused_rather_than_returned_as_mojibake() {
        let f = fixture();
        std::fs::write(f.repo.path().join("blob.bin"), b"PNG\x00\x01\x02rest").unwrap();
        let err = run_verb(&f.ctx, "repo.read", &json!({"path": "blob.bin"}))
            .await
            .expect_err("binary refused");
        assert!(err.contains("binary"), "{err}");
        assert!(err.contains("blob.bin"), "the error names the file: {err}");
    }

    /// `path_arg` reads the argument's text; a symlink is a fact about the
    /// filesystem. Containment is what catches this one ([P02]).
    #[tokio::test]
    async fn a_symlink_pointing_out_of_the_repo_is_refused() {
        let f = fixture();
        let outside = tempfile::tempdir().expect("tempdir");
        std::fs::write(outside.path().join("secret.txt"), "not yours\n").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            f.repo.path().join("escape.txt"),
        )
        .expect("symlink");

        let err = run_verb(&f.ctx, "repo.read", &json!({"path": "escape.txt"}))
            .await
            .expect_err("containment refuses the escape");
        assert!(err.contains("outside the project dir"), "{err}");
    }

    #[tokio::test]
    async fn a_read_may_not_address_outside_the_repo_by_text_either() {
        let f = fixture();
        for path in ["/etc/passwd", "../outside.txt"] {
            let err = run_verb(&f.ctx, "repo.read", &json!({"path": path}))
                .await
                .expect_err("path gate refuses");
            assert!(
                err.contains("repo-relative") || err.contains(".."),
                "{path}: {err}"
            );
        }
    }

    /// [P02]: the interesting file is often the one written minutes ago and
    /// never committed.
    #[tokio::test]
    async fn an_untracked_file_reads_normally() {
        let f = fixture();
        std::fs::write(f.repo.path().join("scratch.txt"), "brand new\n").unwrap();
        let out = run_verb(&f.ctx, "repo.read", &json!({"path": "scratch.txt"}))
            .await
            .expect("read ran");
        assert_eq!(out["lines"][0]["text"], "brand new");
    }

    #[tokio::test]
    async fn a_read_of_a_path_that_matches_nothing_is_an_error() {
        let f = fixture();
        let err = run_verb(&f.ctx, "repo.read", &json!({"path": "no-such-file.md"}))
            .await
            .expect_err("unmatched path");
        assert!(err.contains("no-such-file.md"), "{err}");
    }

    /// A misspelled path with exactly one plausible owner is repaired, and the
    /// result says which file was actually read.
    #[tokio::test]
    async fn a_repaired_read_names_the_file_it_actually_opened() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.read", &json!({"path": "design-notes.md"}))
            .await
            .expect("read ran");
        assert_eq!(out["path"], "design-notes.md");
        assert_eq!(out["path_used"], "docs/design-notes.md");
        assert!(
            out["note"]
                .as_str()
                .expect("a repair note")
                .contains("docs/design-notes.md"),
            "{}",
            out["note"]
        );
    }

    // MARK: - repo.outline ([S02])

    #[tokio::test]
    async fn repo_outline_maps_a_document_to_line_numbers() {
        let f = fixture();
        let out = run_verb(
            &f.ctx,
            "repo.outline",
            &json!({"path": "docs/design-notes.md"}),
        )
        .await
        .expect("outline ran");
        assert_eq!(out["count"], 1);
        assert_eq!(out["entries"][0]["line"], 1);
        assert_eq!(out["entries"][0]["kind"], "heading");
        assert_eq!(out["entries"][0]["text"], "## Placement");
        assert!(out.get("note").is_none());
    }

    /// An empty outline must not read as an empty file.
    #[tokio::test]
    async fn an_outline_with_nothing_in_it_points_at_repo_read() {
        let f = fixture();
        let out = run_verb(&f.ctx, "repo.outline", &json!({"path": "alpha.txt"}))
            .await
            .expect("outline ran");
        assert_eq!(out["count"], 0);
        assert!(
            out["note"]
                .as_str()
                .expect("an explicit-empty note")
                .contains("repo.read"),
            "{}",
            out["note"]
        );
    }

    #[tokio::test]
    async fn an_outline_longer_than_the_cap_is_marked_truncated() {
        let f = fixture();
        let body: String = (1..=OUTLINE_MAX_ENTRIES + 10)
            .map(|n| format!("## Section {n}\n\ntext\n\n"))
            .collect();
        std::fs::write(f.repo.path().join("big.md"), body).unwrap();
        let out = run_verb(&f.ctx, "repo.outline", &json!({"path": "big.md"}))
            .await
            .expect("outline ran");
        assert_eq!(out["truncated"], true);
        assert_eq!(out["count"], OUTLINE_MAX_ENTRIES as i64);
    }

    /// Outline resolves through the same ladder a read does — one shared-path
    /// check, not a second copy of [#step-2]'s whole matrix.
    #[tokio::test]
    async fn an_outline_of_a_path_that_matches_nothing_is_an_error() {
        let f = fixture();
        let err = run_verb(&f.ctx, "repo.outline", &json!({"path": "no-such-file.md"}))
            .await
            .expect_err("unmatched path");
        assert!(err.contains("no-such-file.md"), "{err}");
    }

    #[test]
    fn grep_fragments_keeps_word_sized_pieces_in_order() {
        assert_eq!(grep_fragments("Z-zone"), vec!["zone"]);
        assert_eq!(
            grep_fragments("TugTooltip.*hover"),
            vec!["tugtooltip", "hover"]
        );
        assert_eq!(grep_fragments("a-b"), Vec::<String>::new());
        assert_eq!(grep_fragments("zone Zone ZONE"), vec!["zone"]);
    }

    #[tokio::test]
    async fn a_session_id_argument_moves_the_repo_a_git_verb_runs_in() {
        let f = fixture();
        // A session whose project dir is a directory with no repo in it: the
        // verb must run *there* and fail, proving it did not silently fall
        // back to the bootstrap repo.
        let elsewhere = tempfile::tempdir().expect("tempdir");
        f.ctx
            .ledger
            .record_spawn(
                "sess-a",
                "ws",
                elsewhere.path().to_str().unwrap(),
                "card-1",
                1_000,
                None,
            )
            .expect("spawn");
        let err = run_verb(&f.ctx, "git.log", &json!({"session_id": "sess-a"}))
            .await
            .expect_err("not a repo");
        assert!(err.contains("git failed"), "{err}");
    }

    #[tokio::test]
    async fn changes_verbs_read_the_file_event_ledger() {
        let f = fixture();
        let out = run_verb(
            &f.ctx,
            "changes.for_session",
            &json!({"session_id": "sess-a"}),
        )
        .await
        .expect("changes ran");
        assert_eq!(out["count"], 0);

        let out = run_verb(&f.ctx, "changes.for_path", &json!({"pattern": "%.css"}))
            .await
            .expect("changes ran");
        assert_eq!(out["count"], 0);
    }

    // MARK: - Privacy ([P05])

    fn seed_file_event(ctx: &OperatorContext, session: &str, path: &str) {
        ctx.ledger
            .record_file_event(&crate::session_ledger::FileEventRow {
                tug_session_id: session.to_string(),
                tool_use_id: format!("tu-{path}"),
                file_path: path.to_string(),
                tool_name: "Write".to_string(),
                op: "write".to_string(),
                origin: "exact".to_string(),
                ambiguous: false,
                parent_tool_use_id: None,
                project_dir: "/proj".to_string(),
                at: 4_000,
            })
            .expect("file event recorded");
    }

    #[tokio::test]
    async fn a_private_session_disappears_from_every_verb_that_could_expose_it() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn("sess-priv", "ws", "/proj", "card-1", 1_000, None)
            .expect("spawn");
        seed_fact(
            &f.ctx,
            &facts_library::prompt_fact(2_000, "sess-priv", "a question about the theme tokens"),
        );
        seed_file_event(&f.ctx, "sess-priv", "tugdeck/styles/themes/brio.css");
        seed_exchange(&f.ctx, "sess-priv", "just app-test", 3_000);
        f.ctx
            .ledger
            .set_session_private("sess-priv", true)
            .expect("marked private");

        let listed = run_verb(&f.ctx, "sessions.list", &json!({}))
            .await
            .expect("list ran");
        assert_eq!(listed["count"], 0, "sessions.list drops it");

        let found = run_verb(&f.ctx, "facts.search", &json!({"query": "theme"}))
            .await
            .expect("search ran");
        assert_eq!(found["count"], 0, "facts.search drops its facts");

        let path = run_verb(&f.ctx, "changes.for_path", &json!({"pattern": "%.css"}))
            .await
            .expect("changes ran");
        assert_eq!(path["count"], 0, "changes.for_path drops its file events");

        let history = run_verb(&f.ctx, "shell.history", &json!({}))
            .await
            .expect("history ran");
        assert_eq!(history["count"], 0, "shell.history drops its commands");

        for verb in ["session.prompts", "changes.for_session"] {
            let err = run_verb(&f.ctx, verb, &json!({"session_id": "sess-priv"}))
                .await
                .unwrap_or_else(|err| json!({ "err": err }));
            assert!(
                err["err"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("no session"),
                "{verb} answers as if the session were not there: {err}"
            );
        }

        // Public again: the same rows are readable, from that moment on.
        f.ctx
            .ledger
            .set_session_private("sess-priv", false)
            .expect("marked public");
        let found = run_verb(&f.ctx, "facts.search", &json!({"query": "theme"}))
            .await
            .expect("search ran");
        assert_eq!(found["count"], 1);
    }

    /// The `NOT EXISTS` formulation's reason to exist ([P05]): `changes.db` is
    /// machine-global, so a file event can name a session with no row in *this*
    /// instance's ledger. An `INNER JOIN sessions` would silently drop it.
    #[tokio::test]
    async fn changes_for_path_keeps_an_event_whose_session_has_no_local_row() {
        let f = fixture();
        seed_file_event(&f.ctx, "sess-from-another-instance", "tugdeck/x.css");
        let out = run_verb(&f.ctx, "changes.for_path", &json!({"pattern": "%.css"}))
            .await
            .expect("changes ran");
        assert_eq!(
            out["count"], 1,
            "an absent session row reads as not-private"
        );
        assert_eq!(
            out["changes"][0]["session_id"],
            "sess-from-another-instance"
        );
    }

    // MARK: - The pipeline

    use crate::shared_agent::test_support::FakeSpawner;
    use crate::shared_agent::{AgentSpec, AgentWorkerSpawner, SharedAgentPool};
    use base64::Engine as _;
    use tokio::sync::broadcast;
    use tugcast_core::protocol::{FeedId, Frame};

    /// A pool on the **real** overview job table, answering a script — so the
    /// timeouts and instructions under test are the shipped ones.
    fn scripted_pool(answers: Vec<Result<String, String>>) -> Arc<SharedAgentPool> {
        SharedAgentPool::new(
            AgentSpec {
                name: "overview",
                model: Arc::new(|| "sonnet".to_string()),
                jobs: super::super::overview_agent::OVERVIEW_AGENT_JOBS,
                max_workers: 3,
            },
            FakeSpawner::new(answers) as Arc<dyn AgentWorkerSpawner>,
        )
    }

    fn dead_pool() -> Arc<SharedAgentPool> {
        SharedAgentPool::new(
            AgentSpec {
                name: "overview",
                model: Arc::new(|| "sonnet".to_string()),
                jobs: super::super::overview_agent::OVERVIEW_AGENT_JOBS,
                max_workers: 3,
            },
            FakeSpawner::failing() as Arc<dyn AgentWorkerSpawner>,
        )
    }

    struct PipelineHarness {
        pipeline: OperatorPipeline,
        rx: broadcast::Receiver<Frame>,
        ledger: Arc<SessionLedger>,
        _repo: tempfile::TempDir,
    }

    fn pipeline(pool: Arc<SharedAgentPool>) -> PipelineHarness {
        let repo = git_repo();
        let ledger = ledger();
        let (tx, rx) = broadcast::channel(64);
        PipelineHarness {
            pipeline: OperatorPipeline {
                ctx: Arc::new(OperatorContext {
                    ledger: Arc::clone(&ledger),
                    shell_ledger: None,
                    bootstrap_project_dir: repo.path().to_path_buf(),
                    attachments_dir: repo.path().join("overview-attachments"),
                    haiku: None,
                }),
                pool,
                overview_tx: tx,
            },
            rx,
            ledger,
            _repo: repo,
        }
    }

    fn next_post(rx: &mut broadcast::Receiver<Frame>) -> OverviewPost {
        let frame = rx.try_recv().expect("a OVERVIEW frame was broadcast");
        assert_eq!(frame.feed_id, FeedId::OVERVIEW);
        serde_json::from_slice(&frame.payload).expect("a OverviewPost on the wire")
    }

    fn verbs_turn() -> Result<String, String> {
        Ok(json!({"verbs": [{"verb": "git.log", "args": {"n": 2}}]}).to_string())
    }

    fn answer_turn(body: &str) -> Result<String, String> {
        Ok(json!({"answer": {"body": body}}).to_string())
    }

    /// One 1×1 PNG, base64, exactly as the composer would hand it up.
    fn a_png() -> QuestionAttachment {
        QuestionAttachment {
            media_type: "image/png".to_string(),
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".to_string(),
        }
    }

    /// An attached image is part of the question in both directions: it comes
    /// to rest on disk so the post can show it forever, and the same bytes are
    /// shown to the model that answers.
    #[tokio::test]
    async fn an_attached_image_is_stored_and_shown_to_the_model() {
        let fake = FakeSpawner::new(vec![
            verbs_turn(),
            answer_turn("A single transparent pixel."),
        ]);
        let pool = SharedAgentPool::new(
            AgentSpec {
                name: "overview",
                model: Arc::new(|| "sonnet".to_string()),
                jobs: super::super::overview_agent::OVERVIEW_AGENT_JOBS,
                max_workers: 3,
            },
            Arc::clone(&fake) as Arc<dyn AgentWorkerSpawner>,
        );
        let mut h = pipeline(pool);
        h.pipeline
            .handle(
                "what is this".to_string(),
                Some("req-img".into()),
                vec![a_png()],
                Vec::new(),
            )
            .await;

        let question = next_post(&mut h.rx);
        assert_eq!(question.attachments.len(), 1, "the picture is on the post");
        let stored = &question.attachments[0];
        assert_eq!(stored.media_type, "image/png");
        assert!(
            stored.path.ends_with(".png"),
            "stored under its own type: {}",
            stored.path,
        );
        let on_disk = std::fs::read(&stored.path).expect("the bytes were written");
        assert_eq!(
            on_disk.len(),
            base64::engine::general_purpose::STANDARD
                .decode(a_png().data)
                .unwrap()
                .len(),
            "the file holds the decoded image, not the base64",
        );

        // Both model turns saw it — the one that decides what to look up and
        // the one that writes the answer.
        let images = fake.images_seen();
        assert_eq!(images.len(), 2, "retrieve and answer");
        for shown in &images {
            assert_eq!(shown.len(), 1);
            assert_eq!(shown[0].media_type, "image/png");
            assert_eq!(shown[0].data, a_png().data);
        }
        // And both were TOLD the picture belongs to the question, rather than
        // left to infer it from something in their context.
        for turn in fake.turns_seen() {
            assert!(turn.contains("ATTACHED: 1 image"), "{turn}");
        }
    }

    /// A picture with no words is a question. Nothing here may treat an empty
    /// body as nothing to ask when an image came with it.
    #[tokio::test]
    async fn an_image_alone_is_a_question() {
        let mut h = pipeline(scripted_pool(vec![verbs_turn(), answer_turn("A pixel.")]));
        h.pipeline
            .handle(
                String::new(),
                Some("req-only-img".into()),
                vec![a_png()],
                Vec::new(),
            )
            .await;

        let question = next_post(&mut h.rx);
        assert_eq!(question.author, OverviewAuthor::User);
        assert_eq!(question.body, "");
        assert_eq!(question.attachments.len(), 1);
        let answer = next_post(&mut h.rx);
        assert_eq!(answer.author, OverviewAuthor::Operator);
        assert_eq!(answer.body, "A pixel.");
    }

    /// A question typed without a picture says nothing about pictures — the
    /// attached line is absent, not "ATTACHED: 0".
    #[tokio::test]
    async fn a_question_with_no_image_says_nothing_about_images() {
        let fake = FakeSpawner::new(vec![verbs_turn(), answer_turn("Nothing to see.")]);
        let pool = SharedAgentPool::new(
            AgentSpec {
                name: "overview",
                model: Arc::new(|| "sonnet".to_string()),
                jobs: super::super::overview_agent::OVERVIEW_AGENT_JOBS,
                max_workers: 3,
            },
            Arc::clone(&fake) as Arc<dyn AgentWorkerSpawner>,
        );
        let mut h = pipeline(pool);
        h.pipeline
            .handle("what landed".to_string(), None, Vec::new(), Vec::new())
            .await;

        let question = next_post(&mut h.rx);
        assert!(question.attachments.is_empty());
        for turn in fake.turns_seen() {
            assert!(!turn.contains("ATTACHED"), "{turn}");
        }
        for shown in fake.images_seen() {
            assert!(shown.is_empty());
        }
    }

    #[tokio::test]
    async fn the_happy_path_echoes_the_question_then_answers_it() {
        let mut h = pipeline(scripted_pool(vec![
            verbs_turn(),
            answer_turn("The last two commits added alpha.txt and beta.txt."),
        ]));
        h.pipeline
            .handle(
                "what landed recently".to_string(),
                Some("req-1".into()),
                Vec::new(),
                Vec::new(),
            )
            .await;

        let question = next_post(&mut h.rx);
        assert_eq!(question.author, OverviewAuthor::User);
        assert_eq!(question.body, "what landed recently");
        assert_eq!(question.request_id.as_deref(), Some("req-1"));
        assert!(question.id.is_some(), "the question is history");

        let answer = next_post(&mut h.rx);
        assert_eq!(answer.author, OverviewAuthor::Operator);
        assert!(answer.body.contains("alpha.txt"));
        assert_eq!(answer.request_id.as_deref(), Some("req-1"));
        assert!(!answer.transient);
        assert_eq!(
            h.ledger.list_overview_posts_tail(10).unwrap().len(),
            2,
            "both the question and the answer are persisted",
        );
    }

    #[tokio::test]
    async fn a_follow_up_round_runs_more_verbs_and_then_answers() {
        let mut h = pipeline(scripted_pool(vec![
            verbs_turn(),
            // The answering model asks for one more lookup…
            verbs_turn(),
            // …and answers on the round it gets.
            answer_turn("Confirmed in the second round."),
        ]));
        h.pipeline
            .handle(
                "when did beta land".to_string(),
                None,
                Vec::new(),
                Vec::new(),
            )
            .await;

        let _question = next_post(&mut h.rx);
        let answer = next_post(&mut h.rx);
        assert_eq!(answer.body, "Confirmed in the second round.");
        assert!(!answer.transient);
    }

    /// A model that never stops asking still owes an answer, and the round cap
    /// is what collects it. Without the cap this is an infinite loop wearing a
    /// pending spinner.
    #[tokio::test]
    async fn a_model_that_only_ever_asks_for_more_still_ends_the_exchange() {
        let mut h = pipeline(scripted_pool(vec![
            verbs_turn(),
            verbs_turn(),
            verbs_turn(),
            verbs_turn(),
        ]));
        h.pipeline
            .handle(
                "an unanswerable one".to_string(),
                Some("req-9".into()),
                Vec::new(),
                Vec::new(),
            )
            .await;

        let _question = next_post(&mut h.rx);
        let post = next_post(&mut h.rx);
        assert!(post.transient, "the exchange ended, and not with an answer");
        assert_eq!(post.request_id.as_deref(), Some("req-9"));
        assert_eq!(
            h.ledger.list_overview_posts_tail(10).unwrap().len(),
            1,
            "only the question is history",
        );
    }

    #[tokio::test]
    async fn an_unavailable_pool_yields_a_transient_post_that_is_never_written() {
        let mut h = pipeline(dead_pool());
        h.pipeline
            .handle(
                "anything at all".to_string(),
                Some("req-2".into()),
                Vec::new(),
                Vec::new(),
            )
            .await;

        let question = next_post(&mut h.rx);
        assert_eq!(question.author, OverviewAuthor::User);
        assert!(
            question.id.is_some(),
            "the question is persisted before any model call — it is history whatever happens next",
        );
        assert_eq!(
            question.project_dir.as_deref(),
            Some(h._repo.path().to_string_lossy().as_ref()),
            "the question carries the annotation root — a typed path renders dead without one",
        );

        let failure = next_post(&mut h.rx);
        assert_eq!(failure.author, OverviewAuthor::Operator);
        assert!(failure.transient);
        assert!(failure.id.is_none());
        assert_eq!(failure.request_id.as_deref(), Some("req-2"));

        let persisted = h.ledger.list_overview_posts_tail(10).unwrap();
        assert_eq!(persisted.len(), 1, "the hiccup did not enter the history");
        assert_eq!(persisted[0].author, OverviewAuthor::User);
    }

    /// Salvage holds after a real verb round too, not only when retrieval
    /// asked for nothing: the model looked things up, then answered in
    /// prose. The hedge is the answer.
    #[tokio::test]
    async fn a_prose_answer_after_a_verb_round_is_still_salvaged() {
        let mut h = pipeline(scripted_pool(vec![
            verbs_turn(),
            Ok("I had a look and honestly it's hard to say.".to_string()),
        ]));
        h.pipeline
            .handle("what happened".to_string(), None, Vec::new(), Vec::new())
            .await;
        let _question = next_post(&mut h.rx);
        let post = next_post(&mut h.rx);
        assert!(!post.transient, "the hedge is the answer, delivered");
        assert_eq!(post.body, "I had a look and honestly it's hard to say.");
    }

    #[tokio::test]
    async fn an_answers_refs_must_appear_in_what_it_was_shown() {
        let mut h = pipeline(scripted_pool(vec![
            verbs_turn(),
            Ok(json!({"answer": {
                "body": "alpha.txt is where it is.",
                "refs": [
                    {"kind": "file", "target": "alpha.txt"},
                    {"kind": "file", "target": "invented/nowhere.rs"},
                ],
            }})
            .to_string()),
        ]));
        h.pipeline
            .handle("where is alpha".to_string(), None, Vec::new(), Vec::new())
            .await;
        let _question = next_post(&mut h.rx);
        let answer = next_post(&mut h.rx);
        assert_eq!(answer.refs.len(), 1);
        assert_eq!(answer.refs[0].target, "alpha.txt");
    }

    // MARK: - Question refs

    /// The asker's pointing gesture survives the wire: an `@` atom naming a
    /// real file comes back on the question post as a ref, without ever
    /// meeting `validate_refs` — which vets a model's recall against verb
    /// results that have not run yet and would drop every one of them.
    #[tokio::test]
    async fn a_question_ref_naming_a_real_file_rides_the_post() {
        let mut h = pipeline(scripted_pool(vec![verbs_turn(), answer_turn("Read it.")]));
        h.pipeline
            .handle(
                "what does docs/design-notes.md say".to_string(),
                Some("req-ref".into()),
                Vec::new(),
                vec![QuestionRef {
                    kind: "file".to_string(),
                    target: "docs/design-notes.md".to_string(),
                }],
            )
            .await;

        let question = next_post(&mut h.rx);
        assert_eq!(question.author, OverviewAuthor::User);
        assert_eq!(question.refs.len(), 1);
        assert_eq!(question.refs[0].kind, OverviewRefKind::File);
        assert_eq!(question.refs[0].target, "docs/design-notes.md");
    }

    /// A ref that names nothing costs itself and nothing else — the question
    /// is still asked and still answered, because the path is also in the
    /// words ([L23] holds only for that reason).
    #[tokio::test]
    async fn a_question_ref_naming_nothing_is_dropped_and_the_question_stands() {
        let mut h = pipeline(scripted_pool(vec![verbs_turn(), answer_turn("No idea.")]));
        h.pipeline
            .handle(
                "what does docs/invented.md say".to_string(),
                Some("req-ghost".into()),
                Vec::new(),
                vec![QuestionRef {
                    kind: "file".to_string(),
                    target: "docs/invented.md".to_string(),
                }],
            )
            .await;

        let question = next_post(&mut h.rx);
        assert!(
            question.refs.is_empty(),
            "unverifiable refs are not published"
        );
        assert_eq!(question.body, "what does docs/invented.md say");
        let answer = next_post(&mut h.rx);
        assert_eq!(answer.body, "No idea.");
    }

    /// The repair ladder reaches the question side too: a bare basename names
    /// the file that exists, and the ref published is the path a verb could
    /// be given rather than the fragment that was typed.
    #[tokio::test]
    async fn a_question_ref_is_repaired_to_the_path_that_exists() {
        let mut h = pipeline(scripted_pool(vec![verbs_turn(), answer_turn("Zones.")]));
        h.pipeline
            .handle(
                "design-notes.md please".to_string(),
                Some("req-repair".into()),
                Vec::new(),
                vec![QuestionRef {
                    kind: "file".to_string(),
                    target: "design-notes.md".to_string(),
                }],
            )
            .await;

        let question = next_post(&mut h.rx);
        assert_eq!(question.refs.len(), 1);
        assert_eq!(question.refs[0].target, "docs/design-notes.md");
    }

    /// A payload from a deck that never heard of refs — the overwhelmingly
    /// common case — behaves exactly as it did, field absent and all.
    #[test]
    fn a_overview_input_payload_without_refs_still_deserializes() {
        #[derive(serde::Deserialize)]
        struct Raw {
            #[serde(default)]
            refs: Vec<QuestionRef>,
        }
        let raw: Raw = serde_json::from_str(r#"{"body":"hi","requestId":"r1"}"#).expect("parses");
        assert!(raw.refs.is_empty());
        let with: Raw =
            serde_json::from_str(r#"{"body":"hi","refs":[{"kind":"file","target":"a.txt"}]}"#)
                .expect("parses");
        assert_eq!(with.refs.len(), 1);
        assert_eq!(with.refs[0].target, "a.txt");
    }

    #[tokio::test]
    async fn an_empty_question_is_not_an_exchange() {
        let mut h = pipeline(scripted_pool(vec![verbs_turn(), answer_turn("hi")]));
        h.pipeline
            .handle("   ".to_string(), None, Vec::new(), Vec::new())
            .await;
        assert!(h.rx.try_recv().is_err(), "nothing was broadcast");
    }

    #[test]
    fn a_verb_round_is_capped_at_six() {
        let many: Vec<VerbRequest> = (0..20)
            .map(|_| VerbRequest::new("git.log", json!({})))
            .collect();
        let mut requests = many;
        requests.truncate(MAX_VERBS_PER_ROUND);
        assert_eq!(requests.len(), 6);
    }

    #[test]
    fn a_self_corrected_envelope_is_read_at_its_last_word() {
        let raw = "{\"verbs\": [{\"verb\": \"nope\"}]}\nLet me fix that:\n\
                   {\"verbs\": [{\"verb\": \"git.log\", \"args\": {}}]}";
        let verbs = parse_verbs(raw).expect("verbs parsed");
        assert_eq!(verbs.len(), 1);
        assert_eq!(verbs[0].verb, "git.log");
    }

    /// A model that annotates its verbs still gets them run. The Observer's
    /// `deny_unknown_fields` is a contract about what may enter the channel;
    /// applying it here would have spent a user's answer on tidiness.
    #[test]
    fn an_annotated_verb_list_is_still_a_verb_list() {
        let raw = json!({
            "reasoning": "the channel probably has it",
            "verbs": [{
                "verb": "overview.search",
                "args": {"query": "physics"},
                "why": "the posts mention it",
            }],
        })
        .to_string();
        let verbs = parse_verbs(&raw).expect("verbs parsed");
        assert_eq!(verbs.len(), 1);
        assert_eq!(verbs[0].verb, "overview.search");
    }

    /// Observed against the real model: it wrote the arguments flat on the
    /// verb object, every verb in the round errored with "argument … is
    /// required", and the question lost the first of its two rounds to it.
    #[test]
    fn arguments_written_flat_on_the_verb_are_still_arguments() {
        let raw = r#"{"verbs": [
            {"verb": "overview.search", "query": "contrast"},
            {"verb": "facts.search", "query": "contrast", "kind": "shell"}
        ]}"#;
        let verbs = parse_verbs(raw).expect("verbs parsed");
        assert_eq!(verbs[0].args, json!({"query": "contrast"}));
        assert_eq!(verbs[1].args, json!({"query": "contrast", "kind": "shell"}));
    }

    /// …but a request that nested them properly keeps exactly what it wrote.
    /// The annotation a model hangs off a well-formed verb stays ignored,
    /// which is what the neighbouring test above is about.
    #[test]
    fn a_well_formed_request_is_not_rewritten_by_its_annotations() {
        let raw = json!({
            "verbs": [{
                "verb": "overview.search",
                "args": {"query": "physics"},
                "why": "the posts mention it",
            }],
        })
        .to_string();
        let verbs = parse_verbs(&raw).expect("verbs parsed");
        assert_eq!(verbs[0].args, json!({"query": "physics"}));
    }

    #[test]
    fn an_annotated_answer_is_still_an_answer() {
        let raw = json!({
            "answer": {"body": "Three.", "refs": [], "confidence": "high"},
            "note": "read off the channel",
        })
        .to_string();
        match parse_answer_turn(&raw) {
            Some(AnswerTurn::Answer(post)) => assert_eq!(post.body, "Three."),
            _ => panic!("the annotation should not have cost the answer"),
        }
    }

    /// Retrieval is an optimization, not a gate. The scrollback rides the
    /// answering turn either way, and some questions are answerable from the
    /// channel alone — so a retrieval step that writes prose costs a lookup,
    /// never the exchange.
    #[tokio::test]
    async fn an_unreadable_retrieval_still_answers_from_the_channel() {
        let mut h = pipeline(scripted_pool(vec![
            Ok("I don't think I need to look anything up for this one.".to_string()),
            answer_turn("Three physics questions, all this afternoon."),
        ]));
        h.pipeline
            .handle(
                "how many physics questions today".to_string(),
                Some("req-3".into()),
                Vec::new(),
                Vec::new(),
            )
            .await;

        let _question = next_post(&mut h.rx);
        let answer = next_post(&mut h.rx);
        assert!(
            !answer.transient,
            "a formatting slip is not a failed exchange"
        );
        assert_eq!(answer.body, "Three physics questions, all this afternoon.");
        assert_eq!(answer.request_id.as_deref(), Some("req-3"));
    }

    /// Observed against the real model, three times in two days: the
    /// answering turn arrives as plain prose — a complete, correct answer
    /// with no envelope around it. The words are the answer; the exchange
    /// must deliver them rather than report "did not produce a readable
    /// answer" about an answer it is holding.
    #[tokio::test]
    async fn a_prose_answer_is_salvaged_not_discarded() {
        let mut h = pipeline(scripted_pool(vec![
            Ok(json!({"verbs": []}).to_string()),
            Ok("No match for \"Z-zone\" in the file — that exact term doesn't appear.".to_string()),
        ]));
        h.pipeline
            .handle(
                "where is the Z-zone drawing".to_string(),
                Some("req-11".into()),
                Vec::new(),
                Vec::new(),
            )
            .await;

        let _question = next_post(&mut h.rx);
        let answer = next_post(&mut h.rx);
        assert!(!answer.transient, "a prose answer is still an answer");
        assert_eq!(
            answer.body,
            "No match for \"Z-zone\" in the file — that exact term doesn't appear.",
        );
        assert!(answer.refs.is_empty(), "salvage carries no refs to verify");
        assert_eq!(answer.request_id.as_deref(), Some("req-11"));
    }

    /// …but a turn that contains JSON parsing as neither envelope is a
    /// malformed attempt at the contract, not prose — posting it would print
    /// braces at the reader, so it stays the transient failure.
    #[tokio::test]
    async fn a_malformed_envelope_is_not_mistaken_for_prose() {
        let mut h = pipeline(scripted_pool(vec![
            Ok(json!({"verbs": []}).to_string()),
            Ok(json!({"summary": {"body": "close but wrong key"}}).to_string()),
        ]));
        h.pipeline
            .handle(
                "anything".to_string(),
                Some("req-12".into()),
                Vec::new(),
                Vec::new(),
            )
            .await;

        let _question = next_post(&mut h.rx);
        let post = next_post(&mut h.rx);
        assert!(post.transient, "broken JSON is a defect, not an answer");
        assert!(post.body.starts_with("Couldn't answer that"));
    }

    /// The same shape the model actually chose: an empty verb list, meaning
    /// "the channel already says it".
    #[tokio::test]
    async fn an_empty_verb_list_goes_straight_to_the_answer() {
        let mut h = pipeline(scripted_pool(vec![
            Ok(json!({"verbs": []}).to_string()),
            answer_turn("Read straight off the channel."),
        ]));
        h.pipeline
            .handle(
                "what have I been up to".to_string(),
                None,
                Vec::new(),
                Vec::new(),
            )
            .await;
        let _question = next_post(&mut h.rx);
        let answer = next_post(&mut h.rx);
        assert!(!answer.transient);
        assert_eq!(answer.body, "Read straight off the channel.");
    }

    #[test]
    fn an_answer_wins_over_a_request_for_more() {
        let raw = "{\"verbs\": [{\"verb\": \"git.log\"}]}\n{\"answer\": {\"body\": \"done\"}}";
        match parse_answer_turn(raw) {
            Some(AnswerTurn::Answer(post)) => assert_eq!(post.body, "done"),
            _ => panic!("the answer should have won"),
        }
    }

    /// Every verb the model is offered has an executor behind it, and every
    /// executor is offered. A verb that drifts out of one list is a model
    /// asking for something that always errors, or a capability nobody can
    /// reach.
    #[test]
    fn the_verb_table_matches_the_instructions() {
        let instructions = super::super::overview_agent::OVERVIEW_AGENT_JOBS
            .iter()
            .find(|j| j.name == "operator-retrieve")
            .expect("operator-retrieve in the job table")
            .instructions;
        for verb in VERB_NAMES {
            assert!(
                instructions.contains(verb),
                "verb {verb} has an executor but is never offered to the model"
            );
        }
    }

    // MARK: - The clock

    /// A fixed instant, so the assertions are about our formatting and never
    /// about the machine's timezone database.
    const FIXED_NOW: i64 = 1_786_572_090_962;

    #[test]
    fn the_now_line_carries_both_the_epoch_and_a_clock_a_person_reads() {
        let line = render_now_line(FIXED_NOW);
        assert!(line.starts_with(NOW_HEADER));
        assert!(
            line.contains(&FIXED_NOW.to_string()),
            "the epoch number is what every since_ms is computed from: {line}"
        );
        // The offset, not a zone name — chrono's Local cannot supply one ([Q01]).
        assert!(line.contains("(UTC"), "{line}");
        assert!(line.ends_with(')'), "{line}");
    }

    // MARK: - The verified-mention preamble

    /// A mention whose file is real, written to the fixture repo so the
    /// preamble's own read has something to read.
    fn mention(repo: &tempfile::TempDir, relative: &str, contents: &str) -> VerifiedMention {
        let absolute = repo.path().join(relative);
        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        std::fs::write(&absolute, contents).expect("write");
        VerifiedMention {
            path: relative.to_string(),
            absolute,
        }
    }

    /// The overwhelmingly common question names no file, and its retrieve
    /// input must not have moved by so much as a newline.
    #[test]
    fn a_question_naming_no_file_composes_exactly_what_it_always_did() {
        let roster = render_session_roster(&[]);
        let composed = compose_retrieve_input(
            FIXED_NOW,
            "what landed",
            &roster,
            "(the channel is empty)\n",
            0,
            &render_question_files(&[]),
        );
        assert_eq!(
            composed,
            format!(
                "{}\n\n{roster}\nQUESTION:\nwhat landed\n\nRECENT OVERVIEW POSTS:\n(the channel is empty)\n",
                render_now_line(FIXED_NOW),
            ),
        );
        assert!(!composed.contains(QUESTION_FILES_HEADER));
    }

    /// A named file arrives as a fact with a map: the header, the path, its
    /// line count, and the structure the model would otherwise spend a round
    /// asking for.
    #[test]
    fn a_named_file_arrives_with_its_line_count_and_its_outline() {
        let repo = tempfile::tempdir().expect("tempdir");
        let named = mention(
            &repo,
            "docs/zones.md",
            "# Zones\n\nsome prose\n\n**D97.** The card is partitioned into six zones.\n",
        );
        let rendered = render_question_files(&[named]);
        assert!(rendered.contains(QUESTION_FILES_HEADER));
        assert!(rendered.contains("- docs/zones.md (5 lines)"), "{rendered}");
        assert!(rendered.contains("  OUTLINE:"), "{rendered}");
        assert!(rendered.contains("1  heading  # Zones"), "{rendered}");
        assert!(rendered.contains("5  label    **D97.**"), "{rendered}");
    }

    /// Bounded at two outlines ([P07]) so a question pointing at a directory's
    /// worth of atoms cannot displace itself. The third file is still NAMED —
    /// losing its outline is not losing the statement that it exists.
    #[test]
    fn only_the_first_two_named_files_are_outlined() {
        let repo = tempfile::tempdir().expect("tempdir");
        let mentions: Vec<VerifiedMention> = ["one.md", "two.md", "three.md"]
            .iter()
            .map(|name| mention(&repo, name, "# Heading\n\nbody\n"))
            .collect();
        let rendered = render_question_files(&mentions);
        assert_eq!(rendered.matches("  OUTLINE:").count(), SEEDED_OUTLINES);
        assert!(rendered.contains("- three.md (3 lines)"), "{rendered}");
    }

    /// A file that will not read costs its outline and nothing else: the
    /// mention is still true, and the model is still told the file is there.
    #[test]
    fn a_named_file_that_will_not_read_is_still_named() {
        let repo = tempfile::tempdir().expect("tempdir");
        let ghost = VerifiedMention {
            path: "gone.md".to_string(),
            absolute: repo.path().join("gone.md"),
        };
        let rendered = render_question_files(&[ghost]);
        assert!(rendered.contains("- gone.md"), "{rendered}");
        assert!(!rendered.contains("lines)"), "{rendered}");
        assert!(!rendered.contains("OUTLINE:"), "{rendered}");
    }

    /// The whole point, through the real pipeline: the retrieve turn the model
    /// actually receives carries the section, and the answering turn does not
    /// — by then it has verb results, and the seed would only compete.
    #[tokio::test]
    async fn a_question_carrying_a_ref_seeds_the_retrieve_turn() {
        let fake = FakeSpawner::new(vec![verbs_turn(), answer_turn("Zones, line 3.")]);
        let pool = SharedAgentPool::new(
            AgentSpec {
                name: "overview",
                model: Arc::new(|| "sonnet".to_string()),
                jobs: super::super::overview_agent::OVERVIEW_AGENT_JOBS,
                max_workers: 3,
            },
            Arc::clone(&fake) as Arc<dyn AgentWorkerSpawner>,
        );
        let mut h = pipeline(pool);
        h.pipeline
            .handle(
                "where are the zones described".to_string(),
                Some("req-seed".into()),
                Vec::new(),
                vec![QuestionRef {
                    kind: "file".to_string(),
                    target: "docs/design-notes.md".to_string(),
                }],
            )
            .await;
        let _question = next_post(&mut h.rx);

        let turns = fake.turns_seen();
        assert_eq!(turns.len(), 2, "retrieve and answer");
        assert!(turns[0].contains(QUESTION_FILES_HEADER), "{}", turns[0]);
        assert!(
            turns[0].contains("- docs/design-notes.md (3 lines)"),
            "{}",
            turns[0],
        );
        assert!(
            turns[0].contains("1  heading  ## Placement"),
            "{}",
            turns[0]
        );
        assert!(!turns[1].contains(QUESTION_FILES_HEADER), "{}", turns[1]);
    }

    #[test]
    fn both_composed_turns_open_with_the_clock() {
        let roster = render_session_roster(&[]);
        let retrieve = compose_retrieve_input(
            FIXED_NOW,
            "what landed",
            &roster,
            "(the channel is empty)\n",
            0,
            "",
        );
        assert!(retrieve.starts_with(NOW_HEADER), "{retrieve}");
        assert!(retrieve.find(NOW_HEADER) < retrieve.find("QUESTION:"));

        let answer = compose_answer_input(
            FIXED_NOW,
            "what landed",
            &roster,
            "(the channel is empty)\n",
            "",
            false,
            0,
        );
        assert!(answer.starts_with(NOW_HEADER), "{answer}");

        // Forced: the LAST-ROUND warning stays first — it is the one thing the
        // model must read before anything else — and the clock follows it.
        let forced = compose_answer_input(
            FIXED_NOW,
            "what landed",
            &roster,
            "(the channel is empty)\n",
            "",
            true,
            0,
        );
        assert!(forced.starts_with("THIS IS YOUR LAST ROUND"), "{forced}");
        assert!(forced.find(NOW_HEADER) < forced.find("QUESTION:"));
    }

    // MARK: - The session roster

    /// The roster as the pipeline composes it: rows read back through the same
    /// privacy-excluding ledger call, then rendered.
    fn roster_of(ctx: &OperatorContext) -> String {
        let rows = ctx
            .ledger
            .list_sessions_recent(None, None, false, SESSIONS_ROSTER_LIMIT)
            .expect("roster read");
        render_session_roster(&rows)
    }

    #[test]
    fn an_empty_roster_still_says_so_under_its_header() {
        let rendered = render_session_roster(&[]);
        assert!(rendered.starts_with(SESSIONS_HEADER));
        assert!(rendered.contains("(no sessions)"));
    }

    #[tokio::test]
    async fn a_roster_line_carries_the_full_uuid_the_callsign_and_what_the_session_is() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn(
                HELD,
                "ws",
                "/proj/tugtool",
                "card-1",
                1_000,
                Some("kind-floor"),
            )
            .expect("spawn");
        f.ctx
            .ledger
            .record_synopsis(HELD, "tuning the brio theme's wash")
            .expect("synopsis");
        f.ctx
            .ledger
            .record_user_prompt(HELD, "why is the brio wash so pale")
            .expect("prompt");
        // A second session with neither callsign nor synopsis — the fallbacks.
        f.ctx
            .ledger
            .record_spawn(UNHELD, "ws", "/proj/other", "card-2", 2_000, None)
            .expect("spawn");

        let rendered = roster_of(&f.ctx);
        assert!(rendered.starts_with(SESSIONS_HEADER));
        let lines: Vec<&str> = rendered.lines().skip(1).collect();
        assert_eq!(lines.len(), 2, "one line per session: {rendered}");
        assert!(
            lines[0].contains(UNHELD),
            "newest last_used_at first: {rendered}"
        );
        let held = lines.iter().find(|l| l.contains(HELD)).expect("its line");
        assert!(held.contains(HELD), "the FULL uuid, never a prefix: {held}");
        assert!(held.contains("kind-floor"));
        assert!(held.contains("[live]"));
        assert!(held.contains("/proj/tugtool"));
        assert!(held.contains("\"why is the brio wash so pale\""));
        assert!(held.contains("tuning the brio theme's wash"));
        assert!(held.contains("last used "));

        let bare = lines.iter().find(|l| l.contains(UNHELD)).expect("its line");
        assert!(bare.contains("untagged"), "{bare}");
        assert!(
            !bare.contains(" —  — "),
            "an absent synopsis takes its separator with it: {bare}"
        );
    }

    #[tokio::test]
    async fn a_roster_line_truncates_a_long_title_to_one_line() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn(HELD, "ws", "/proj", "card-1", 1_000, None)
            .expect("spawn");
        f.ctx
            .ledger
            .record_user_prompt(HELD, &"x".repeat(INCIPIT_CHARS * 2))
            .expect("prompt");
        let rendered = roster_of(&f.ctx);
        let line = rendered.lines().nth(1).expect("one session");
        let title = line
            .split_once(" — \"")
            .and_then(|(_, rest)| rest.split_once('"'))
            .expect("a quoted title")
            .0;
        assert_eq!(title.chars().count(), INCIPIT_CHARS + 1, "capped plus '…'");
    }

    #[tokio::test]
    async fn a_private_session_never_reaches_the_roster() {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn(HELD, "ws", "/proj/public", "card-1", 1_000, None)
            .expect("spawn");
        f.ctx
            .ledger
            .record_spawn(UNHELD, "ws", "/proj/secret", "card-2", 2_000, None)
            .expect("spawn");
        f.ctx
            .ledger
            .set_session_private(UNHELD, true)
            .expect("marked private");

        let rendered = roster_of(&f.ctx);
        assert!(rendered.contains(HELD));
        assert!(
            !rendered.contains(UNHELD) && !rendered.contains("/proj/secret"),
            "the roster is a new path to the session list and carries the same exclusion: {rendered}"
        );
    }

    #[test]
    fn the_roster_rides_both_turns_between_the_clock_and_the_question() {
        let roster = render_session_roster(&[]);
        for composed in [
            compose_retrieve_input(FIXED_NOW, "q", &roster, "(the channel is empty)\n", 0, ""),
            compose_answer_input(
                FIXED_NOW,
                "q",
                &roster,
                "(the channel is empty)\n",
                "",
                false,
                0,
            ),
        ] {
            let now = composed.find(NOW_HEADER).expect("the clock");
            let sessions = composed.find(SESSIONS_HEADER).expect("the roster");
            let question = composed.find("QUESTION:").expect("the question");
            assert!(now < sessions && sessions < question, "{composed}");
        }
    }

    // MARK: - The assembled turns

    /// Every section of both composed turns, in the order the model reads
    /// them. A section that moves above the one it depends on — the roster
    /// before the clock, the question after the results — is a turn that
    /// reads differently even though every piece is still present.
    #[tokio::test]
    async fn the_assembled_turns_carry_their_sections_in_order() {
        let f = fixture();
        for i in 0..12 {
            f.ctx
                .ledger
                .record_spawn(
                    &format!("sess-{i:02}"),
                    "ws",
                    "/proj/tugtool",
                    &format!("card-{i}"),
                    1_000 + i,
                    Some(&format!("kind-floor-{i}")),
                )
                .expect("spawn");
        }
        let roster = roster_of(&f.ctx);
        assert_eq!(
            roster.lines().count(),
            SESSIONS_ROSTER_LIMIT + 1,
            "the header plus its capped dozen"
        );

        let retrieve = compose_retrieve_input(
            FIXED_NOW,
            "what did I ask yesterday",
            &roster,
            "(the channel is empty)\n",
            0,
            "",
        );
        let order = |text: &str, marks: &[&str]| {
            let found: Vec<usize> = marks
                .iter()
                .map(|m| text.find(m).unwrap_or_else(|| panic!("{m} missing")))
                .collect();
            assert!(
                found.windows(2).all(|w| w[0] < w[1]),
                "sections out of order: {found:?}\n{text}"
            );
        };
        order(
            &retrieve,
            &[
                NOW_HEADER,
                SESSIONS_HEADER,
                "QUESTION:",
                "RECENT OVERVIEW POSTS:",
            ],
        );

        let answer = compose_answer_input(
            FIXED_NOW,
            "what did I ask yesterday",
            &roster,
            "(the channel is empty)\n",
            "\n--- VERB facts.list {}\n",
            false,
            0,
        );
        order(
            &answer,
            &[
                NOW_HEADER,
                SESSIONS_HEADER,
                "QUESTION:",
                "RECENT OVERVIEW POSTS:",
                "VERB RESULTS:",
            ],
        );

        // Forced, the last-round warning stays ahead of everything — including
        // the clock. It is the one instruction that changes what the model
        // does with the rest.
        let forced = compose_answer_input(
            FIXED_NOW,
            "what did I ask yesterday",
            &roster,
            "(the channel is empty)\n",
            "",
            true,
            0,
        );
        order(
            &forced,
            &[
                "THIS IS YOUR LAST ROUND",
                NOW_HEADER,
                SESSIONS_HEADER,
                "QUESTION:",
            ],
        );

        // Risk R01's measurement: what the clock and a full roster actually
        // cost the turn that pays for them on every question.
        println!(
            "retrieve turn with a full roster: {} bytes ({} of them roster)",
            retrieve.len(),
            roster.len()
        );
        assert!(
            roster.len() < 4_096,
            "the roster is a dozen truncated lines, not a section: {} bytes",
            roster.len()
        );
    }

    /// The ceiling on the turn `detail` actually rides ([Q03], Risk R02).
    ///
    /// `answer` accumulates into ONE results vec across both rounds and
    /// re-renders the whole vec each time, so the worst case is not one
    /// 41-row window — it is `MAX_VERBS_PER_ROUND × MAX_RETRIEVAL_ROUNDS`
    /// fact verbs' results in a single input, round one's rows included and
    /// now fattened with `detail`. The retrieve turn cannot stand in for this
    /// measurement: `detail` never appears there.
    ///
    /// Asserted rather than only printed, so a later cap change that blows it
    /// up fails here instead of in a live read.
    #[tokio::test]
    async fn the_accumulated_second_round_answer_input_stays_bounded() {
        let f = fixture();
        // Commits are the fattest kind: a file list per row, plus a message.
        for i in 0..60 {
            let files: Vec<String> = (0..12)
                .map(|n| format!("tugdeck/src/components/tugways/surface-{i}-{n}.tsx"))
                .collect();
            seed_fact(
                &f.ctx,
                &facts_library::commit_fact(
                    1_000 + i,
                    Some("sess-a"),
                    &format!("{i:040x}"),
                    "tugways(transcript-copy): route native ⌘C through onCopy substitution",
                    &files,
                    None,
                ),
            );
        }
        let hit = run_verb(&f.ctx, "facts.list", &json!({}))
            .await
            .expect("list ran")["facts"][15]["id"]
            .as_i64()
            .expect("a fact id");

        // The worst case a round can ask for, twice: six fact verbs per round,
        // accumulated the way `answer` accumulates them.
        let mut results: Vec<(VerbRequest, Result<Value, String>)> = Vec::new();
        let mut rendered = String::new();
        for _round in 0..MAX_RETRIEVAL_ROUNDS {
            for slot in 0..MAX_VERBS_PER_ROUND {
                let request = if slot % 2 == 0 {
                    VerbRequest::new(
                        "facts.window",
                        json!({"fact_id": hit, "n": FACTS_WINDOW_MAX_N}),
                    )
                } else {
                    VerbRequest::new("facts.list", json!({}))
                };
                let outcome = run_verb(&f.ctx, &request.verb, &request.args).await;
                results.push((request, outcome));
            }
            rendered = render_results(&results);
        }
        assert_eq!(results.len(), MAX_VERBS_PER_ROUND * MAX_RETRIEVAL_ROUNDS);

        let input = compose_answer_input(
            FIXED_NOW,
            "which files did that commit touch",
            &render_session_roster(&[]),
            "(the channel is empty)\n",
            &rendered,
            true,
            0,
        );
        // A dozen fact verbs' worth of rows, every row carrying detail. This
        // measures ~494 KB — large, but it is the pathological corner: six
        // maximum-width fact verbs per round, on commits carrying twelve paths
        // each, with round one's rows re-rendered underneath round two's. A
        // real question asks two or three narrower verbs. The ceiling below
        // leaves headroom for ordinary growth and fails on a cap regression.
        println!(
            "accumulated two-round answer input: {} bytes across {} verb results",
            input.len(),
            results.len()
        );
        assert!(
            input.len() < 600_000,
            "the accumulated worst case grew past its ceiling: {} bytes",
            input.len()
        );
        // And the depth is really in there — this is what the ceiling is
        // bounding, not an empty envelope.
        assert!(input.contains("\"files\":"));
        assert!(input.contains("\"message_first_line\":"));
    }

    // MARK: - The answer's session stamp

    const HELD: &str = "123e4567-e89b-42d3-a456-426614174000";
    const UNHELD: &str = "99999999-9999-4999-a999-999999999999";

    fn session_ref(target: &str) -> OverviewRef {
        OverviewRef {
            kind: OverviewRefKind::Session,
            target: target.to_string(),
        }
    }

    fn file_ref() -> OverviewRef {
        OverviewRef {
            kind: OverviewRefKind::File,
            target: "tugdeck/src/main.tsx".to_string(),
        }
    }

    /// A fixture whose ledger holds exactly one session, `HELD`.
    fn fixture_with_session() -> Fixture {
        let f = fixture();
        f.ctx
            .ledger
            .record_spawn(HELD, "ws", "/proj", "card-1", 1_000, None)
            .expect("spawn");
        f
    }

    #[test]
    fn a_sole_session_ref_the_ledger_holds_becomes_the_answers_session() {
        let f = fixture_with_session();
        assert_eq!(
            sole_ledger_session(&f.ctx, &[file_ref(), session_ref(HELD)]),
            Some(HELD.to_string()),
        );
    }

    #[test]
    fn a_session_ref_the_ledger_cannot_answer_for_stamps_nothing() {
        let f = fixture_with_session();
        // Well-shaped and entirely unchecked upstream — this is the case the
        // ledger gate exists for, since a model can recall an id that never
        // existed.
        assert_eq!(sole_ledger_session(&f.ctx, &[session_ref(UNHELD)]), None);
    }

    #[test]
    fn a_project_callsign_spelling_stamps_nothing() {
        let f = fixture_with_session();
        // Not a session key anywhere: the ledger resolves a uuid, a unique
        // 8-char prefix, or a bare callsign, and a pair matches none.
        assert_eq!(
            sole_ledger_session(&f.ctx, &[session_ref("tugtool/kind-floor")]),
            None,
        );
    }

    #[test]
    fn two_session_refs_or_none_stamp_nothing() {
        let f = fixture_with_session();
        f.ctx
            .ledger
            .record_spawn(UNHELD, "ws", "/proj", "card-2", 2_000, None)
            .expect("spawn");
        // Two the ledger holds is still ambiguous — the row has one identity.
        assert_eq!(
            sole_ledger_session(&f.ctx, &[session_ref(HELD), session_ref(UNHELD)]),
            None,
        );
        assert_eq!(sole_ledger_session(&f.ctx, &[file_ref()]), None);
        assert_eq!(sole_ledger_session(&f.ctx, &[]), None);
    }

    #[test]
    fn an_unstampable_session_ref_is_still_kept_as_a_ref() {
        // The gate governs the row's IDENTITY, not its provenance strip: a
        // session ref the ledger cannot answer for still rides the post and
        // renders inert. `validate_refs` is what decides that, and it exempts
        // Session refs from the corpus check outright — which is exactly why
        // the stamp needs its own gate.
        let validated = crate::feeds::observer_wake::validate_refs(
            vec![session_ref(UNHELD)],
            &["no mention of any session here"],
        );
        assert_eq!(validated.kept.len(), 1);
        assert_eq!(validated.kept[0].target, UNHELD);
        assert!(validated.dropped.is_empty());
    }

    #[test]
    fn the_uuid_shape_check_takes_only_full_lowercase_uuids() {
        assert!(is_session_uuid(HELD));
        assert!(!is_session_uuid(&HELD.to_uppercase()));
        // A unique 8-char prefix IS a ledger key, but it is not what a
        // citation can carry: the chip needs the full id.
        assert!(!is_session_uuid(&HELD[..8]));
        assert!(!is_session_uuid(""));
        assert!(!is_session_uuid("123e4567-e89b-42d3-a456-42661417400z"));
    }
}

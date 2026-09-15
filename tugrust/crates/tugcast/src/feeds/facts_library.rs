//! The facts-library's pure core: what a fact *is*, how one reads, and how a
//! command's settled output becomes a test result.
//!
//! Three rules govern everything here, and all three exist to keep two
//! surfaces from describing the same event two ways.
//!
//! **One rendering per fact.** [`render_text`] is the only place a fact
//! becomes a sentence. Its output is stored in `facts.text`, which is what the
//! FTS index covers *and* what the Observer's SETTLED FACTS wake section
//! prints. Search and narration cannot disagree about what a fact says,
//! because there is nothing for them to disagree with.
//!
//! **Timid classifiers.** [`classify_test_run`] recognizes three runners and
//! refuses everything else. A recognized runner whose output tail cannot be
//! parsed records `unknown` with no counts. A guessed pass count reads exactly
//! like a real one and is worse than an honest refusal — the `shell_ops`
//! posture, applied to test output.
//!
//! **Harness parity.** The live recorders and `overview_replay`'s harness both
//! compose their facts here. A calibration read is only meaningful if the
//! facts the harness synthesizes are the facts production records, and the way
//! to guarantee that is to have one implementation rather than two that agree
//! today.
//!
//! Nothing in this module touches IO, a clock, or a database.

use serde_json::json;

use crate::session_ledger::NewFact;

// MARK: - Caps

/// Longest stored `subject` — a headline handle, not a body.
pub const SUBJECT_CAP: usize = 80;

/// Longest stored `text`. The rendering is one line in a wake section that
/// caps at 20 facts, so a runaway line would crowd out real ones.
pub const TEXT_CAP: usize = 240;

/// Longest prompt kept in a fact payload. A pasted stack trace is still worth
/// recording; a pasted file is not worth recording whole.
pub const PROMPT_PAYLOAD_CAP: usize = 16 * 1024;

/// Marks where a cap cut, so a truncated value never reads as a complete one.
pub const ELISION: &str = "…";

/// How much of a prompt is enough to recognize it.
///
/// Two callers by deliberate agreement, not by accident: the Operator's
/// `session.prompts` verb, whose whole product is prompt text, and the
/// `prompt` fact's `detail.text`, where the prompt is one field on a row. They
/// share a number and a subject, not a purpose — so the constant is named for
/// the subject. If the two ever want different numbers, that is a split to
/// make on purpose, never a drift to discover ([Q04]).
pub const PROMPT_TEXT_CAP: usize = 500;

/// How many of a commit's paths ride its `detail`. Past this the projection
/// says how many it dropped rather than dropping them quietly.
pub const DETAIL_FILES_CAP: usize = 40;

/// How much of a sha a fact's sentence spells.
///
/// The agents that read these sentences copy a sha verbatim into their prose
/// and into their refs, so this number is not an internal formatting choice —
/// it is the length a sha appears at in the Overview. It matches the deck's
/// `COMMIT_LABEL_LENGTH`, which every placed commit atom is labelled with, so
/// a sha reads the same width whether a model wrote it in a sentence or a
/// record placed it in a field. Eight is git's own abbreviation.
pub const SHA_TEXT_LEN: usize = 8;

/// Longest command echoed into a `shell` fact's rendering.
const COMMAND_RENDER_CAP: usize = 200;

/// Longest prompt echoed into a `prompt` fact's rendering.
const PROMPT_RENDER_CAP: usize = 200;

/// How much of a failed edit's refusal report rides its `detail`. The whole
/// report is in the payload, which is where a wire diagnosing the failure
/// reads it; this is the share a question about the fact gets back.
const EDIT_MESSAGE_DETAIL_CAP: usize = 500;

// MARK: - Kinds

/// The kinds the ledger records live in `tugcore` so the tripwire verbs can
/// refuse a kind nothing writes; this is the same enum under its old address.
pub use tugcore::facts::FactKind;

// MARK: - Rendering

/// The one rendering of a fact ([P02]).
///
/// `payload` is the same JSON the fact stores, and it is the whole input: the
/// `subject` a fact is filed under is a handle for finding it, and every kind
/// already says whatever of it belongs in the sentence. A field the payload
/// does not carry is rendered as absent rather than as a stand-in default: an
/// omitted token count prints nothing, never `0`, because a zero that means
/// "claude didn't say" is a lie with a number on it.
pub fn render_text(kind: FactKind, payload: &serde_json::Value) -> String {
    let str_field = |name: &str| payload.get(name).and_then(|v| v.as_str());
    let int_field = |name: &str| payload.get(name).and_then(serde_json::Value::as_i64);

    let rendered = match kind {
        FactKind::Prompt => {
            let text = str_field("text").unwrap_or_default();
            format!(
                "prompt: \"{}\"",
                truncate(collapse(text).as_str(), PROMPT_RENDER_CAP)
            )
        }
        FactKind::SessionSpawned | FactKind::SessionResumed => {
            let verb = if kind == FactKind::SessionSpawned {
                "spawned"
            } else {
                "resumed"
            };
            match str_field("project_dir") {
                Some(dir) => format!("session {verb} in {dir}"),
                None => format!("session {verb}"),
            }
        }
        FactKind::SessionClosed | FactKind::SessionErrored => {
            let verb = if kind == FactKind::SessionClosed {
                "closed"
            } else {
                "errored"
            };
            match str_field("detail") {
                Some(detail) => format!("session {verb} ({detail})"),
                None => format!("session {verb}"),
            }
        }
        FactKind::SessionReset => "session cleared".to_string(),
        FactKind::SessionRenamed => match (str_field("old"), str_field("new")) {
            (Some(old), Some(new)) => format!("session renamed \"{old}\" → \"{new}\""),
            (None, Some(new)) => format!("session named \"{new}\""),
            (Some(old), None) => format!("session name \"{old}\" cleared"),
            (None, None) => "session name cleared".to_string(),
        },
        FactKind::SessionCompacted => {
            let trigger = str_field("trigger").unwrap_or("unknown");
            // Both counts are optional: tugcode emits `post_tokens` only when
            // claude supplied it, and a boundary with a pre count and no post
            // count is ordinary rather than exceptional.
            match (int_field("pre_tokens"), int_field("post_tokens")) {
                (Some(pre), Some(post)) => {
                    format!("context compacted ({trigger}): {pre} → {post} tokens")
                }
                (Some(pre), None) => format!("context compacted ({trigger}): from {pre} tokens"),
                (None, Some(post)) => format!("context compacted ({trigger}): to {post} tokens"),
                (None, None) => format!("context compacted ({trigger})"),
            }
        }
        FactKind::Commit => {
            let sha = str_field("sha").unwrap_or_default();
            let short: String = sha.chars().take(SHA_TEXT_LEN).collect();
            let subject_line = str_field("message")
                .map(|m| collapse(m.lines().next().unwrap_or_default()))
                .unwrap_or_default();
            let files = payload
                .get("files")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            format!("commit {short} \"{subject_line}\" — {files} file(s)")
        }
        FactKind::Shell => {
            let command = collapse(str_field("command").unwrap_or_default());
            let outcome = if payload
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true)
            {
                "ok"
            } else {
                "err"
            };
            format!(
                "$ {} → {outcome}",
                truncate(command.as_str(), COMMAND_RENDER_CAP)
            )
        }
        FactKind::TestRun => {
            let runner = str_field("runner").unwrap_or("tests");
            let verdict = str_field("verdict").unwrap_or("unknown");
            match (int_field("passed"), int_field("failed")) {
                (Some(passed), Some(failed)) => {
                    format!("tests: {runner} — {verdict} ({passed} passed, {failed} failed)")
                }
                (Some(passed), None) => format!("tests: {runner} — {verdict} ({passed} passed)"),
                _ => format!("tests: {runner} — {verdict}"),
            }
        }
        FactKind::EditFailed => {
            let class = str_field("class").unwrap_or("run");
            let where_clause = match edit_files_phrase(payload) {
                Some(files) => format!(" in {files}"),
                None => String::new(),
            };
            // The counts are the reading that says *how* stale a program went:
            // one address out of five is a slip, five out of five is a program
            // written against a tree that has moved on. Classes that never
            // parsed have no counts, and say what the report said instead.
            match (int_field("ops_resolved"), int_field("ops_total")) {
                (Some(resolved), Some(total)) if total > 0 => format!(
                    "edit program failed to {class}: {} of {total} ops stale{where_clause}",
                    total - resolved
                ),
                _ => {
                    let report = str_field("message").unwrap_or_default();
                    let first = collapse(report.lines().next().unwrap_or_default());
                    format!("edit program failed to {class}: {first}")
                }
            }
        }
    };
    truncate(rendered.as_str(), TEXT_CAP)
}

/// The depth behind a fact's one-line rendering — a curated per-kind
/// projection of the payload, never the payload itself.
///
/// [`render_text`] stays the one canonical rendering; this is a handful of
/// named, capped fields beside it, so a question like "which files were in
/// that commit" is answered by the fact that recorded them rather than by a
/// `git.show` round re-fetching what was already on disk. The payload is not
/// passed through: it is the recorder's structured form, a prompt's runs to
/// kilobytes, and only what a question would actually ask for crosses the
/// wire.
///
/// A field the payload does not carry is absent here too — the `render_text`
/// rule, for the same reason: a stand-in default is a lie with a number on it.
/// A kind with nothing worth projecting, or a payload that carries none of the
/// fields, yields `None` rather than an empty object.
pub fn render_detail(kind: FactKind, payload: &serde_json::Value) -> Option<serde_json::Value> {
    let mut out = serde_json::Map::new();
    let mut copy = |name: &str| {
        if let Some(value) = payload.get(name)
            && !value.is_null()
        {
            out.insert(name.to_string(), value.clone());
        }
    };
    match kind {
        FactKind::Commit => {
            copy("sha");
            copy("branch");
            // The subject line whole. `text` already carries it collapsed and
            // inside TEXT_CAP alongside everything else on the line; this is
            // the field a citation quotes.
            if let Some(message) = payload.get("message").and_then(|v| v.as_str())
                && let Some(first) = message.lines().next()
            {
                out.insert("message_first_line".to_string(), json!(first));
            }
            if let Some(files) = payload.get("files").and_then(|v| v.as_array()) {
                let kept: Vec<&serde_json::Value> = files.iter().take(DETAIL_FILES_CAP).collect();
                out.insert("files".to_string(), json!(kept));
                if files.len() > kept.len() {
                    // Visible, never silent: a shortened list that does not say
                    // it was shortened reads as the whole commit.
                    out.insert("files_elided".to_string(), json!(files.len() - kept.len()));
                }
            }
        }
        FactKind::TestRun => {
            copy("runner");
            copy("verdict");
            copy("passed");
            copy("failed");
            copy("skipped");
            // No `command`: a `test_run` payload has never carried one. The
            // command lives on the paired `shell` fact, which is where a
            // question about it should go.
        }
        FactKind::Shell => {
            copy("command");
            copy("route");
            copy("ok");
            copy("exit_code");
            copy("cwd");
        }
        FactKind::Prompt => {
            if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                out.insert("text".to_string(), json!(truncate(text, PROMPT_TEXT_CAP)));
            }
        }
        FactKind::SessionCompacted => {
            copy("trigger");
            copy("pre_tokens");
            copy("post_tokens");
        }
        FactKind::SessionSpawned | FactKind::SessionResumed => copy("project_dir"),
        FactKind::SessionClosed | FactKind::SessionErrored => copy("detail"),
        FactKind::SessionRenamed => {
            copy("old");
            copy("new");
        }
        // Nothing to add: the rendering already says the whole fact.
        FactKind::SessionReset => {}
        FactKind::EditFailed => {
            copy("class");
            copy("exit");
            copy("ops_resolved");
            copy("ops_total");
            copy("files");
            if let Some(message) = payload.get("message").and_then(|v| v.as_str()) {
                out.insert(
                    "message".to_string(),
                    json!(truncate(message, EDIT_MESSAGE_DETAIL_CAP)),
                );
            }
            // No `program`: it runs to 16 KiB, and a detail projection is a
            // handful of named fields. The program is in the payload, which is
            // where the reader that wants it looks.
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(serde_json::Value::Object(out))
}

/// Cut to `cap` characters, marking the cut. Counts characters rather than
/// bytes so a cap never lands mid-codepoint.
fn truncate(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let kept: String = s.chars().take(cap).collect();
    format!("{kept}{ELISION}")
}

/// Fold every run of whitespace to one space. A rendering is one line, and a
/// pasted prompt or a heredoc command carries newlines that would otherwise
/// break the wake section's `- [at_ms] <text>` shape.
fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The `subject` for a fact: a trimmed, single-line, capped handle.
fn subject_of(s: &str) -> Option<String> {
    let collapsed = collapse(s);
    if collapsed.is_empty() {
        return None;
    }
    Some(truncate(collapsed.as_str(), SUBJECT_CAP))
}

// MARK: - Dedupe keys ([P03])

/// The key for a Claude-route shell fact. The relay re-streams replayed frames
/// on every resume, and a `tool_use_id` is stable across those replays.
pub fn shell_key(session_id: &str, tool_use_id: &str) -> String {
    format!("shell:{session_id}:{tool_use_id}")
}

/// The key for the `test_run` fact paired with a shell fact — the same suffix,
/// so the pair lands or dedupes together.
pub fn test_run_key(shell_key: &str) -> String {
    match shell_key.strip_prefix("shell:") {
        Some(suffix) => format!("test:{suffix}"),
        None => format!("test:{shell_key}"),
    }
}

/// The key for the `edit_failed` fact a Bash call's output carried. One per
/// call, on the same replay-stable `tool_use_id` the shell key uses.
pub fn edit_failed_key(session_id: &str, tool_use_id: &str) -> String {
    format!("edit_failed:{session_id}:{tool_use_id}")
}

/// The key for a compaction fact, from the boundary frame's timestamp.
pub fn compact_key(session_id: &str, at_ms: i64) -> String {
    format!("compact:{session_id}:{at_ms}")
}

/// The key for a commit fact. A sha names one commit forever.
pub fn commit_key(sha: &str) -> String {
    format!("commit:{sha}")
}

// MARK: - Builders

/// Compose a fact from its already-built payload. Every builder below funnels
/// through here so `text` is always [`render_text`]'s output and never a
/// caller's paraphrase.
fn compose(
    at_ms: i64,
    kind: FactKind,
    session_id: Option<&str>,
    subject: Option<String>,
    payload: serde_json::Value,
    dedupe_key: Option<String>,
) -> NewFact {
    let text = render_text(kind, &payload);
    NewFact {
        at_ms,
        kind: kind.as_str().to_string(),
        session_id: session_id.map(str::to_owned),
        subject,
        text,
        payload: payload.to_string(),
        dedupe_key,
    }
}

/// Whether a user-message text is Claude Code's own bookkeeping rather than
/// something a person asked.
///
/// Claude Code spells a local slash command as a user message wrapped in
/// `<command-name>` / `<command-message>` / `<command-args>` tags, and echoes
/// its result back as `<local-command-stdout>`. Neither is a prompt: recording
/// them makes `session.prompts` answer "what did I ask" with `/model` and its
/// own confirmation, and puts two lines of machinery into every wake's facts
/// section — which is exactly what the [Q02] calibration read turned up.
///
/// Refused rather than unwrapped. The tags carry no question, so there is
/// nothing inside one to keep, and a fact base whose `prompt` rows are only ever
/// human sentences is the one worth searching.
pub fn is_local_command_bookkeeping(text: &str) -> bool {
    let head = text.trim_start();
    head.starts_with("<command-name>")
        || head.starts_with("<command-message>")
        || head.starts_with("<command-args>")
        || head.starts_with("<local-command-stdout>")
        || head.starts_with("<local-command-stderr>")
}

/// A user prompt, in full — the thing `sessions.last_user_prompt` could only
/// keep 256 characters of, and only for the most recent one.
///
/// Callers gate on [`is_local_command_bookkeeping`] first; the builder itself
/// composes whatever it is handed, so the refusal is one predicate both the live
/// recorder and the harness read rather than two spellings of one rule.
pub fn prompt_fact(at_ms: i64, session_id: &str, text: &str) -> NewFact {
    let capped = truncate(text, PROMPT_PAYLOAD_CAP);
    compose(
        at_ms,
        FactKind::Prompt,
        Some(session_id),
        subject_of(text),
        json!({ "text": capped }),
        None,
    )
}

/// A session appearing in this ledger, or coming back to it.
///
/// `spawned` means first appearance *in this ledger* — including a session the
/// external scan discovered and this instance is adopting. An adopted session's
/// pre-Tug history belongs to its transcript, not to the fact base, and a
/// `resumed` fact with no prior `spawned` fact beside it would be the more
/// confusing record ([P11]).
pub fn session_start_fact(
    at_ms: i64,
    session_id: &str,
    resumed: bool,
    handle: &str,
    workspace_key: &str,
    project_dir: &str,
    name: Option<&str>,
) -> NewFact {
    let kind = if resumed {
        FactKind::SessionResumed
    } else {
        FactKind::SessionSpawned
    };
    compose(
        at_ms,
        kind,
        Some(session_id),
        subject_of(handle),
        json!({
            "workspace_key": workspace_key,
            "project_dir": project_dir,
            "name": name,
        }),
        None,
    )
}

/// A session ending, cleanly or otherwise. `detail` says which way when there
/// is something to say — a crash reason, or `startup-demote` for a row the
/// crash-recovery sweep found still marked live.
pub fn session_end_fact(
    at_ms: i64,
    session_id: &str,
    errored: bool,
    handle: &str,
    detail: Option<&str>,
) -> NewFact {
    let kind = if errored {
        FactKind::SessionErrored
    } else {
        FactKind::SessionClosed
    };
    compose(
        at_ms,
        kind,
        Some(session_id),
        subject_of(handle),
        json!({ "detail": detail }),
        None,
    )
}

/// A session cleared back to empty. One fact for the reset — its internal
/// closed→pending pair is machinery, not two more events.
pub fn session_reset_fact(at_ms: i64, session_id: &str, handle: &str) -> NewFact {
    compose(
        at_ms,
        FactKind::SessionReset,
        Some(session_id),
        subject_of(handle),
        json!({}),
        None,
    )
}

/// A session retitled. The subject is the new name, which is what a question
/// about it would say.
pub fn session_renamed_fact(
    at_ms: i64,
    session_id: &str,
    old: Option<&str>,
    new: Option<&str>,
) -> NewFact {
    compose(
        at_ms,
        FactKind::SessionRenamed,
        Some(session_id),
        new.and_then(subject_of),
        json!({ "old": old, "new": new }),
        None,
    )
}

/// A compaction boundary. Both token counts are optional at the source.
pub fn compact_fact(
    at_ms: i64,
    session_id: &str,
    trigger: Option<&str>,
    pre_tokens: Option<i64>,
    post_tokens: Option<i64>,
) -> NewFact {
    let trigger = trigger.unwrap_or("unknown");
    compose(
        at_ms,
        FactKind::SessionCompacted,
        Some(session_id),
        subject_of(trigger),
        json!({
            "trigger": trigger,
            "pre_tokens": pre_tokens,
            "post_tokens": post_tokens,
        }),
        Some(compact_key(session_id, at_ms)),
    )
}

/// A commit landed through a Tug gesture, from the receipt that knows its sha,
/// message, and file list all at once.
///
/// The branch is a payload field rather than a column on the tripwire ([P02]):
/// a tripwire that wants to watch one branch writes
/// `--on fact:commit --where branch=main`, which is the same grammar every
/// other narrowing uses, and a `shell` fact has no branch for a column to gate
/// on at all.
pub fn commit_fact(
    at_ms: i64,
    session_id: Option<&str>,
    sha: &str,
    message: &str,
    files: &[String],
    numstat: Option<&str>,
    branch: Option<&str>,
) -> NewFact {
    compose(
        at_ms,
        FactKind::Commit,
        session_id,
        subject_of(sha),
        json!({
            "sha": sha,
            "message": message,
            "files": files,
            "numstat": numstat,
            "branch": branch,
        }),
        Some(commit_key(sha)),
    )
}

/// Which route a shell command came in on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellRoute {
    /// A Bash tool call claude made.
    Claude,
    /// A `$` command the user ran in the Session card.
    User,
}

impl ShellRoute {
    fn as_str(self) -> &'static str {
        match self {
            ShellRoute::Claude => "claude",
            ShellRoute::User => "user",
        }
    }
}

/// One shell command and how it went.
pub struct ShellFact<'a> {
    pub command: &'a str,
    pub route: ShellRoute,
    pub ok: bool,
    pub exit_code: Option<i64>,
    pub cwd: Option<&'a str>,
}

/// Whether a Bash `tool_result` is telling us about a command that ran.
///
/// Claude Code wraps the result of a tool call that never ran in
/// `<tool_use_error>…</tool_use_error>` — a PreToolUse gate's refusal, an
/// `InputValidationError` — and opens the result of a command that ran and
/// exited non-zero with a bare `Exit code N`. A scan of the whole transcript
/// corpus under `~/.claude/projects` split cleanly on that prefix: 15 wrapped
/// results, none of which ran, and some 250 `Exit code N` results, every one
/// of which did. There is no overlap and no third shape.
///
/// It is a **Claude Code output convention, not a published contract**, which
/// is exactly why it is one named function with one test naming both shapes
/// rather than a `starts_with` spelled inline at each recorder. If the
/// convention ever moves, it moves here.
///
/// `is_error` cannot answer this: it is true for a refusal and for a non-zero
/// exit alike, and `exit_code` is always `None` on the Claude route.
pub fn shell_call_ran(output: &str) -> bool {
    !output.trim_start().starts_with("<tool_use_error>")
}

/// One shell command and how it went. Never its output — `shell_exchanges.db`
/// and the transcript own that, and a fact is about the work, not its bytes.
pub fn shell_fact(
    at_ms: i64,
    session_id: Option<&str>,
    shell: &ShellFact<'_>,
    dedupe_key: Option<String>,
) -> NewFact {
    compose(
        at_ms,
        FactKind::Shell,
        session_id,
        subject_of(shell.command),
        json!({
            "command": shell.command,
            "route": shell.route.as_str(),
            "ok": shell.ok,
            "exit_code": shell.exit_code,
            "cwd": shell.cwd,
        }),
        dedupe_key,
    )
}

/// One edit program that refused, from the `TUG-EDIT-ERROR` marker its verb
/// printed.
///
/// The marker's JSON *is* the payload, unprojected: it was composed as an
/// evidence bundle for exactly this reader, and a second shaping here would
/// only give the two ends of one wire two opinions about what a failed edit
/// is. Everything the sentence and the detail show is read back off it.
pub fn edit_failed_fact(
    at_ms: i64,
    session_id: Option<&str>,
    marker: &serde_json::Value,
    dedupe_key: Option<String>,
) -> NewFact {
    let subject = edit_files_phrase(marker).or_else(|| {
        marker
            .get("class")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    });
    compose(
        at_ms,
        FactKind::EditFailed,
        session_id,
        subject.as_deref().and_then(subject_of),
        marker.clone(),
        dedupe_key,
    )
}

/// The files a failed edit named, as a sentence says them: one path, or the
/// first and a count of the rest. `None` when the marker named none — the
/// classes that never parsed a program name none, and a phrase invented for
/// them would be a file list with no files in it.
fn edit_files_phrase(payload: &serde_json::Value) -> Option<String> {
    let files: Vec<&str> = payload
        .get("files")?
        .as_array()?
        .iter()
        .filter_map(|f| f.as_str())
        .collect();
    let (first, rest) = files.split_first()?;
    Some(match rest.len() {
        0 => (*first).to_string(),
        1 => format!("{first} and 1 other"),
        n => format!("{first} and {n} others"),
    })
}

/// A test run derived from a shell command's settled output.
pub fn test_run_fact(
    at_ms: i64,
    session_id: Option<&str>,
    run: &TestRunFact,
    dedupe_key: Option<String>,
) -> NewFact {
    compose(
        at_ms,
        FactKind::TestRun,
        session_id,
        subject_of(&run.runner),
        json!({
            "runner": run.runner,
            "verdict": run.verdict,
            "passed": run.passed,
            "failed": run.failed,
            "skipped": run.skipped,
        }),
        dedupe_key,
    )
}

// MARK: - The test-run classifier ([P07])

/// What a recognized runner's output said. `verdict` is one of `passed`,
/// `failed`, or `unknown`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestRunFact {
    pub runner: String,
    pub verdict: String,
    pub passed: Option<i64>,
    pub failed: Option<i64>,
    pub skipped: Option<i64>,
}

impl TestRunFact {
    /// A recognized runner whose output could not be read. Honest about what
    /// it does not know rather than guessing a count.
    fn unknown(runner: &str) -> Self {
        TestRunFact {
            runner: runner.to_string(),
            verdict: "unknown".to_string(),
            passed: None,
            failed: None,
            skipped: None,
        }
    }

    fn from_counts(runner: &str, passed: i64, failed: i64, skipped: Option<i64>) -> Self {
        TestRunFact {
            runner: runner.to_string(),
            verdict: if failed == 0 { "passed" } else { "failed" }.to_string(),
            passed: Some(passed),
            failed: Some(failed),
            skipped,
        }
    }
}

/// Read a settled command's output as a test result, or refuse.
///
/// Three runners are recognized, by the summary line each one prints. Anything
/// else is `None` — not a coverage gap but the contract: a command this
/// function does not know is a `shell` fact and nothing more.
///
/// **The verdict comes from the summary, never from the call's success.** A red
/// suite is a perfectly successful Bash invocation, so `is_error` and
/// `exit_code` inform the `shell` fact alone; what lands here is whatever the
/// runner said about itself, or `unknown` when it said nothing readable.
pub fn classify_test_run(command: &str, output_tail: &str) -> Option<TestRunFact> {
    let runner = recognize_runner(command)?;
    let parsed = match runner {
        "cargo nextest" => parse_nextest(output_tail),
        "bun test" => parse_bun_test(output_tail),
        "just app-test" => parse_app_test(output_tail),
        _ => None,
    };
    Some(parsed.unwrap_or_else(|| TestRunFact::unknown(runner)))
}

/// Which runner a command invokes, if it is one we read.
///
/// Deliberately narrow: `cargo build` is not a test run, and neither is
/// `cargo nextest list`. A command that merely mentions a runner's name in a
/// grep pattern will match, which is the acceptable direction of error — it
/// then fails to parse and records `unknown`.
fn recognize_runner(command: &str) -> Option<&'static str> {
    if command.contains("cargo nextest run") {
        return Some("cargo nextest");
    }
    if command.contains("bun test") {
        return Some("bun test");
    }
    if command.contains("just app-test") {
        return Some("just app-test");
    }
    None
}

/// `Summary [   1.2s] 1539 tests run: 1538 passed, 1 failed, 5 skipped`
fn parse_nextest(tail: &str) -> Option<TestRunFact> {
    let line = tail
        .lines()
        .rev()
        .find(|l| l.contains("Summary [") && l.contains("tests run:"))?;
    let after = line.split("tests run:").nth(1)?;
    let mut passed = None;
    let mut failed = 0_i64;
    let mut skipped = None;
    for part in after.split(',') {
        let mut words = part.split_whitespace();
        let Some(count) = words.next().and_then(|w| w.parse::<i64>().ok()) else {
            continue;
        };
        match words.next() {
            Some("passed") => passed = Some(count),
            Some("failed") => failed = count,
            Some("skipped") => skipped = Some(count),
            _ => {}
        }
    }
    Some(TestRunFact::from_counts(
        "cargo nextest",
        passed?,
        failed,
        skipped,
    ))
}

/// bun's own summary block:
/// ```text
///  5 pass
///  1 fail
/// ```
fn parse_bun_test(tail: &str) -> Option<TestRunFact> {
    let mut passed = None;
    let mut failed = None;
    let mut skipped = None;
    for line in tail.lines() {
        let mut words = line.split_whitespace();
        let Some(count) = words.next().and_then(|w| w.parse::<i64>().ok()) else {
            continue;
        };
        match words.next() {
            Some("pass") => passed = Some(count),
            Some("fail") => failed = Some(count),
            Some("skip") => skipped = Some(count),
            _ => {}
        }
    }
    Some(TestRunFact::from_counts(
        "bun test", passed?, failed?, skipped,
    ))
}

/// `VERDICT: PASS  (20/20 files green; 137/137 tests passed)` — the recipe's
/// last line, which carries the totals the result table sums to.
fn parse_app_test(tail: &str) -> Option<TestRunFact> {
    let line = tail.lines().rev().find(|l| l.contains("VERDICT:"))?;
    let verdict = if line.contains("VERDICT: PASS") {
        "passed"
    } else if line.contains("VERDICT: FAIL") {
        "failed"
    } else {
        return None;
    };
    // `137/137 tests passed` — passed over total, from which failed follows.
    let counts = line
        .split_whitespace()
        .zip(line.split_whitespace().skip(1))
        .find(|(_, next)| next.starts_with("tests"))
        .and_then(|(ratio, _)| ratio.split_once('/'))
        .and_then(|(p, t)| {
            let passed = p.trim_start_matches('(').parse::<i64>().ok()?;
            let total = t.parse::<i64>().ok()?;
            Some((passed, total))
        });
    Some(match counts {
        Some((passed, total)) => TestRunFact {
            runner: "just app-test".to_string(),
            verdict: verdict.to_string(),
            passed: Some(passed),
            failed: Some(total - passed),
            skipped: None,
        },
        // A verdict with no readable totals is still a verdict.
        None => TestRunFact {
            runner: "just app-test".to_string(),
            verdict: verdict.to_string(),
            passed: None,
            failed: None,
            skipped: None,
        },
    })
}

// MARK: - Harness synthesis ([P09])

/// One frame as the synthesis walk sees it — the wire's own shape, which is
/// also what `overview_replay`'s translator emits. Borrowed rather than owned
/// so the harness hands over its existing frames without copying them.
#[derive(Debug, Clone, Copy)]
pub struct SynthFrame<'a> {
    pub at_ms: i64,
    pub msg_type: &'a str,
    pub payload: &'a str,
}

/// What a synthesis pass produced, and which kinds it was able to produce.
///
/// The kind list is printed rather than assumed: a transcript carries prompts,
/// tool calls, and compaction boundaries, but it has never seen a commit or a
/// session lifecycle transition. Saying so is the difference between a harness
/// that is honestly partial and one that quietly looks complete.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SynthesizedFacts {
    pub facts: Vec<NewFact>,
    pub kinds: Vec<&'static str>,
}

/// The kinds no transcript can carry, so a report can name what it is missing.
pub const LIVE_ONLY_KINDS: &[&str] = &[
    FactKind::SessionSpawned.as_str(),
    FactKind::SessionResumed.as_str(),
    FactKind::SessionClosed.as_str(),
    FactKind::SessionErrored.as_str(),
    FactKind::SessionReset.as_str(),
    FactKind::SessionRenamed.as_str(),
    FactKind::Commit.as_str(),
];

/// Derive the facts a transcript can account for, exactly as the live
/// recorders would have written them.
///
/// The Bash pairing is the relay's own: a `tool_use` is remembered by its
/// `tool_use_id` and settled by the matching `tool_result`, with no filtering
/// on what the command parses as — which is the whole point, since a test run
/// is never a file-operation command ([P06]).
pub fn synthesize_facts_from_frames(frames: &[SynthFrame<'_>]) -> SynthesizedFacts {
    let mut facts: Vec<NewFact> = Vec::new();
    let mut kinds: Vec<&'static str> = Vec::new();
    fn note(kind: &'static str, kinds: &mut Vec<&'static str>) {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    // tool_use_id → (command, at_ms), awaiting its result.
    let mut pending: Vec<(String, String, i64)> = Vec::new();

    for frame in frames {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(frame.payload) else {
            continue;
        };
        let session_id = payload
            .get("tug_session_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        match frame.msg_type {
            "user_message" => {
                let Some(text) = payload.get("text").and_then(|v| v.as_str()) else {
                    continue;
                };
                if is_local_command_bookkeeping(text) {
                    continue;
                }
                facts.push(prompt_fact(frame.at_ms, session_id, text));
                note(FactKind::Prompt.as_str(), &mut kinds);
            }
            "tool_use" => {
                if payload.get("tool_name").and_then(|v| v.as_str()) != Some("Bash") {
                    continue;
                }
                let Some(id) = payload.get("tool_use_id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(command) = payload
                    .get("input")
                    .and_then(|v| v.get("command"))
                    .and_then(|v| v.as_str())
                else {
                    continue;
                };
                pending.push((id.to_string(), command.to_string(), frame.at_ms));
            }
            "tool_result" => {
                let Some(id) = payload.get("tool_use_id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(index) = pending.iter().position(|(pid, _, _)| pid == id) else {
                    continue;
                };
                let (_, command, at_ms) = pending.remove(index);
                let is_error = payload
                    .get("is_error")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let output = payload
                    .get("output")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                // After `pending.remove(index)` above, never before it: a
                // guard that returned early with the call still pending
                // would leave the map holding a settled call forever.
                if !shell_call_ran(output) {
                    continue;
                }
                let key = shell_key(session_id, id);
                facts.push(shell_fact(
                    at_ms,
                    Some(session_id),
                    &ShellFact {
                        command: &command,
                        route: ShellRoute::Claude,
                        ok: !is_error,
                        exit_code: None,
                        cwd: None,
                    },
                    Some(key.clone()),
                ));
                note(FactKind::Shell.as_str(), &mut kinds);
                if let Some(run) = classify_test_run(&command, output) {
                    facts.push(test_run_fact(
                        at_ms,
                        Some(session_id),
                        &run,
                        Some(test_run_key(&key)),
                    ));
                    note(FactKind::TestRun.as_str(), &mut kinds);
                }
                if let Some(marker) = crate::feeds::attribution::parse_edit_error_line(output) {
                    facts.push(edit_failed_fact(
                        at_ms,
                        Some(session_id),
                        &marker,
                        Some(edit_failed_key(session_id, id)),
                    ));
                    note(FactKind::EditFailed.as_str(), &mut kinds);
                }
            }
            "compact_boundary" => {
                facts.push(compact_fact(
                    frame.at_ms,
                    session_id,
                    payload.get("trigger").and_then(|v| v.as_str()),
                    payload
                        .get("pre_tokens")
                        .and_then(serde_json::Value::as_i64),
                    payload
                        .get("post_tokens")
                        .and_then(serde_json::Value::as_i64),
                ));
                note(FactKind::SessionCompacted.as_str(), &mut kinds);
            }
            _ => {}
        }
    }
    facts.sort_by_key(|f| f.at_ms);
    SynthesizedFacts { facts, kinds }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload_of(fact: &NewFact) -> serde_json::Value {
        serde_json::from_str(&fact.payload).expect("payload is json")
    }

    #[test]
    fn every_kind_renders_its_own_sentence() {
        let cases: Vec<(NewFact, &str)> = vec![
            (
                prompt_fact(1, "s1", "make the private chip legible"),
                "prompt: \"make the private chip legible\"",
            ),
            (
                session_start_fact(1, "s1", false, "brisk-otter", "ws", "/proj", None),
                "session spawned in /proj",
            ),
            (
                session_start_fact(1, "s1", true, "brisk-otter", "ws", "/proj", None),
                "session resumed in /proj",
            ),
            (
                session_end_fact(1, "s1", false, "brisk-otter", None),
                "session closed",
            ),
            (
                session_end_fact(1, "s1", false, "brisk-otter", Some("startup-demote")),
                "session closed (startup-demote)",
            ),
            (
                session_end_fact(1, "s1", true, "brisk-otter", Some("bridge exited")),
                "session errored (bridge exited)",
            ),
            (
                session_reset_fact(1, "s1", "brisk-otter"),
                "session cleared",
            ),
            (
                session_renamed_fact(1, "s1", Some("old name"), Some("new name")),
                "session renamed \"old name\" → \"new name\"",
            ),
            (
                compact_fact(1, "s1", Some("auto"), Some(140_000), Some(22_000)),
                "context compacted (auto): 140000 → 22000 tokens",
            ),
            (
                commit_fact(
                    1,
                    Some("s1"),
                    "a1b2c3d4e5f6a7b8",
                    "tugcast(facts): land it\n\nbody",
                    &["a.rs".to_string(), "b.rs".to_string()],
                    None,
                    None,
                ),
                // Eight characters of sha, git's own abbreviation and the
                // length every Tug surface shows — the agents copy this
                // sentence verbatim, so this IS the sha's display length.
                "commit a1b2c3d4 \"tugcast(facts): land it\" — 2 file(s)",
            ),
            (
                shell_fact(
                    1,
                    Some("s1"),
                    &ShellFact {
                        command: "cargo nextest run",
                        route: ShellRoute::Claude,
                        ok: true,
                        exit_code: None,
                        cwd: None,
                    },
                    None,
                ),
                "$ cargo nextest run → ok",
            ),
            (
                shell_fact(
                    1,
                    Some("s1"),
                    &ShellFact {
                        command: "git push",
                        route: ShellRoute::User,
                        ok: false,
                        exit_code: Some(1),
                        cwd: Some("/proj"),
                    },
                    None,
                ),
                "$ git push → err",
            ),
            (
                test_run_fact(
                    1,
                    Some("s1"),
                    &TestRunFact::from_counts("cargo nextest", 1538, 1, Some(5)),
                    None,
                ),
                "tests: cargo nextest — failed (1538 passed, 1 failed)",
            ),
        ];
        for (fact, expected) in cases {
            assert_eq!(fact.text, expected, "rendering of {}", fact.kind);
        }
    }

    /// The projection of a fact built by the production builder — the shape
    /// `fact_json` will serve.
    fn detail_of(fact: &NewFact) -> serde_json::Value {
        let kind = FactKind::parse(&fact.kind).expect("a kind we wrote ourselves");
        render_detail(kind, &payload_of(fact)).expect("a projection")
    }

    #[test]
    fn parse_round_trips_every_kind_and_refuses_everything_else() {
        for kind in [
            FactKind::Prompt,
            FactKind::SessionSpawned,
            FactKind::SessionResumed,
            FactKind::SessionClosed,
            FactKind::SessionErrored,
            FactKind::SessionReset,
            FactKind::SessionRenamed,
            FactKind::SessionCompacted,
            FactKind::Commit,
            FactKind::Shell,
            FactKind::TestRun,
        ] {
            assert_eq!(FactKind::parse(kind.as_str()), Some(kind));
        }
        // A row a newer build wrote is a row without depth, never an error.
        assert_eq!(FactKind::parse("session.teleported"), None);
        assert_eq!(FactKind::parse(""), None);
    }

    #[test]
    fn a_commits_detail_carries_the_files_the_rendering_could_only_count() {
        let files: Vec<String> = (0..5).map(|i| format!("crates/x/src/f{i}.rs")).collect();
        let fact = commit_fact(
            1,
            Some("s1"),
            "a1b2c3d4e5f6a7b8",
            "tugcast(facts): land it\n\nthe body, which is not the subject line",
            &files,
            None,
            None,
        );
        let detail = detail_of(&fact);
        assert_eq!(detail["sha"], "a1b2c3d4e5f6a7b8");
        assert_eq!(detail["message_first_line"], "tugcast(facts): land it");
        assert_eq!(detail["files"].as_array().unwrap().len(), 5);
        assert_eq!(detail["files"][0], "crates/x/src/f0.rs");
        assert!(
            detail.get("files_elided").is_none(),
            "nothing was elided, so nothing says it was"
        );
        // The one-line rendering still only counts them — `text` is unchanged
        // by any of this.
        assert!(fact.text.ends_with("— 5 file(s)"));
    }

    #[test]
    fn an_elided_file_list_says_how_many_it_dropped() {
        let files: Vec<String> = (0..DETAIL_FILES_CAP + 7)
            .map(|i| format!("f{i}.rs"))
            .collect();
        let fact = commit_fact(1, Some("s1"), "abc123", "big one", &files, None, None);
        let detail = detail_of(&fact);
        assert_eq!(detail["files"].as_array().unwrap().len(), DETAIL_FILES_CAP);
        assert_eq!(detail["files_elided"], 7);
    }

    #[test]
    fn each_kinds_detail_projects_what_a_question_would_ask_for() {
        let run = test_run_fact(
            1,
            Some("s1"),
            &TestRunFact::from_counts("cargo nextest", 1538, 1, Some(5)),
            None,
        );
        let detail = detail_of(&run);
        assert_eq!(detail["runner"], "cargo nextest");
        assert_eq!(detail["verdict"], "failed");
        assert_eq!(detail["passed"], 1538);
        assert_eq!(detail["failed"], 1);
        assert_eq!(detail["skipped"], 5);
        assert!(
            detail.get("command").is_none(),
            "a test_run payload has never carried one; it lives on the paired shell fact"
        );

        let shell = shell_fact(
            1,
            Some("s1"),
            &ShellFact {
                command: "just app-test at0365-overview-card.test.ts",
                route: ShellRoute::User,
                ok: false,
                exit_code: Some(2),
                cwd: Some("/proj"),
            },
            None,
        );
        let detail = detail_of(&shell);
        assert_eq!(
            detail["command"],
            "just app-test at0365-overview-card.test.ts"
        );
        assert_eq!(detail["route"], "user");
        assert_eq!(detail["ok"], false);
        assert_eq!(detail["exit_code"], 2);
        assert_eq!(detail["cwd"], "/proj");

        let compacted = compact_fact(1, "s1", Some("auto"), Some(140_000), Some(22_000));
        let detail = detail_of(&compacted);
        assert_eq!(detail["trigger"], "auto");
        assert_eq!(detail["pre_tokens"], 140_000);
        assert_eq!(detail["post_tokens"], 22_000);

        let spawned = session_start_fact(1, "s1", false, "brisk-otter", "ws", "/proj", None);
        assert_eq!(detail_of(&spawned)["project_dir"], "/proj");

        let renamed = session_renamed_fact(1, "s1", Some("old name"), Some("new name"));
        let detail = detail_of(&renamed);
        assert_eq!(detail["old"], "old name");
        assert_eq!(detail["new"], "new name");

        let errored = session_end_fact(1, "s1", true, "brisk-otter", Some("bridge exited"));
        assert_eq!(detail_of(&errored)["detail"], "bridge exited");
    }

    #[test]
    fn a_prompts_detail_is_capped_at_the_shared_prompt_cap() {
        let long = "x".repeat(PROMPT_TEXT_CAP * 3);
        let fact = prompt_fact(1, "s1", &long);
        let text = detail_of(&fact)["text"].as_str().unwrap().to_string();
        assert_eq!(text.chars().count(), PROMPT_TEXT_CAP + 1, "capped plus '…'");
        assert!(text.ends_with(ELISION));

        // A short one crosses whole — the cap is a ceiling, not a shape.
        let short = prompt_fact(1, "s1", "why is the brio wash so pale");
        assert_eq!(detail_of(&short)["text"], "why is the brio wash so pale");
    }

    #[test]
    fn an_absent_field_is_absent_and_a_bare_kind_has_no_detail_at_all() {
        // tugcode omits `post_tokens` when claude did not supply it, and the
        // projection follows `render_text`'s rule: no stand-in zero.
        let fact = compact_fact(1, "s1", Some("manual"), Some(140_000), None);
        let detail = detail_of(&fact);
        assert_eq!(detail["pre_tokens"], 140_000);
        assert!(detail.get("post_tokens").is_none());

        // A close with nothing to say about it projects nothing rather than an
        // object with a null in it.
        let bare = session_end_fact(1, "s1", false, "brisk-otter", None);
        assert_eq!(
            render_detail(FactKind::SessionClosed, &payload_of(&bare)),
            None
        );

        // And a reset says its whole self in one line.
        let reset = session_reset_fact(1, "s1", "brisk-otter");
        assert_eq!(
            render_detail(FactKind::SessionReset, &payload_of(&reset)),
            None
        );
    }

    #[test]
    fn a_compaction_with_no_post_count_renders_what_it_has() {
        // tugcode emits `post_tokens` only when claude supplied it, and a `0`
        // standing in for an absent number would read as a total collapse.
        let fact = compact_fact(1, "s1", Some("manual"), Some(140_000), None);
        assert_eq!(fact.text, "context compacted (manual): from 140000 tokens");
        assert!(!fact.text.contains("→ 0 tokens"));
        assert_eq!(payload_of(&fact)["post_tokens"], serde_json::Value::Null);

        let neither = compact_fact(1, "s1", None, None, None);
        assert_eq!(neither.text, "context compacted (unknown)");
    }

    #[test]
    fn a_long_prompt_is_capped_in_both_the_payload_and_the_rendering() {
        let long = "x".repeat(PROMPT_PAYLOAD_CAP * 2);
        let fact = prompt_fact(1, "s1", &long);
        let stored = payload_of(&fact)["text"].as_str().unwrap().to_string();
        assert_eq!(stored.chars().count(), PROMPT_PAYLOAD_CAP + 1);
        assert!(stored.ends_with(ELISION), "the cut is marked");
        assert!(fact.text.chars().count() <= TEXT_CAP);
        assert_eq!(fact.subject.unwrap().chars().count(), SUBJECT_CAP + 1);
    }

    /// Claude Code spells a local slash command as a user message and echoes
    /// its result back as another. Neither is a prompt, and the [Q02]
    /// calibration read found both sitting in the facts section — `/model` and
    /// its own confirmation, in place of what the person actually asked.
    #[test]
    fn a_local_commands_wrapper_and_echo_are_not_prompts() {
        for bookkeeping in [
            "<command-name>/model</command-name> <command-message>model</command-message>",
            "<command-args>claude-fable-5[1m]</command-args>",
            "<local-command-stdout>Set model to claude-fable-5</local-command-stdout>",
            "  <local-command-stderr>no such command</local-command-stderr>",
        ] {
            assert!(
                is_local_command_bookkeeping(bookkeeping),
                "refused: {bookkeeping}"
            );
        }
        // A real prompt that merely mentions a command, or one that opens with
        // some other angle bracket, is still a prompt.
        for prompt in [
            "use /model to switch to fable",
            "<div> should not be in this file",
            "why did <command-name> show up in the facts?",
        ] {
            assert!(!is_local_command_bookkeeping(prompt), "kept: {prompt}");
        }
    }

    #[test]
    fn synthesis_records_no_prompt_fact_for_a_local_command() {
        let wrapper = r#"{"tug_session_id":"s1","type":"user_message","text":"<command-name>/model</command-name>"}"#;
        let echo = r#"{"tug_session_id":"s1","type":"user_message","text":"<local-command-stdout>Set model to sonnet</local-command-stdout>"}"#;
        let real = r#"{"tug_session_id":"s1","type":"user_message","text":"now make it faster"}"#;
        let out = synthesize_facts_from_frames(&[
            frame(1_000, "user_message", wrapper),
            frame(1_100, "user_message", echo),
            frame(1_200, "user_message", real),
        ]);
        assert_eq!(
            out.facts,
            vec![prompt_fact(1_200, "s1", "now make it faster")]
        );
    }

    #[test]
    fn a_multiline_command_renders_as_one_line() {
        let fact = shell_fact(
            1,
            Some("s1"),
            &ShellFact {
                command: "cd tugrust &&\n  cargo nextest run",
                route: ShellRoute::Claude,
                ok: true,
                exit_code: None,
                cwd: None,
            },
            None,
        );
        assert_eq!(fact.text, "$ cd tugrust && cargo nextest run → ok");
        // The payload keeps the command verbatim; only the rendering is a line.
        assert!(
            payload_of(&fact)["command"]
                .as_str()
                .unwrap()
                .contains('\n')
        );
    }

    #[test]
    fn the_classifier_reads_the_three_runners_it_knows() {
        let nextest_green = "\
   Compiling tugcast v0.8.0
    Finished `test` profile [unoptimized + debuginfo] target(s) in 29.99s
────────────
 Nextest run ID 31a032c2 with nextest profile: default
    Starting 1539 tests across 7 binaries (5 tests skipped)
────────────
     Summary [  12.538s] 1539 tests run: 1539 passed, 5 skipped";
        assert_eq!(
            classify_test_run("cd tugrust && cargo nextest run", nextest_green),
            Some(TestRunFact {
                runner: "cargo nextest".to_string(),
                verdict: "passed".to_string(),
                passed: Some(1539),
                failed: Some(0),
                skipped: Some(5),
            })
        );

        let nextest_red = "\
        FAIL [   0.011s] tugcast session_ledger::tests::facts_round_trip
     Summary [   0.312s] 1539 tests run: 1538 passed, 1 failed, 5 skipped";
        let red = classify_test_run("cargo nextest run -p tugcast", nextest_red).unwrap();
        assert_eq!(red.verdict, "failed");
        assert_eq!(red.failed, Some(1));

        let bun = "\
bun test v1.2.0

src/lib/slash-commands.test.ts:
✓ matches /private

 12 pass
 1 fail
 30 expect() calls
Ran 13 tests across 1 files.";
        assert_eq!(
            classify_test_run("cd tugdeck && bun test slash-commands", bun),
            Some(TestRunFact {
                runner: "bun test".to_string(),
                verdict: "failed".to_string(),
                passed: Some(12),
                failed: Some(1),
                skipped: None,
            })
        );

        let app_test = "\
FILE                                     RESULT   TESTS
at0287-session-chip.test.ts              PASS      7/7

VERDICT: PASS  (20/20 files green; 137/137 tests passed)";
        assert_eq!(
            classify_test_run("just app-test at0287-session-chip.test.ts", app_test),
            Some(TestRunFact {
                runner: "just app-test".to_string(),
                verdict: "passed".to_string(),
                passed: Some(137),
                failed: Some(0),
                skipped: None,
            })
        );
    }

    #[test]
    fn a_recognized_runner_with_an_unreadable_tail_is_unknown_never_a_guess() {
        // The settled output was truncated before its summary line — which is
        // ordinary, since a tool result can be cut at a length cap.
        let truncated = "running 1539 tests\n... [output truncated]";
        assert_eq!(
            classify_test_run("cargo nextest run", truncated),
            Some(TestRunFact::unknown("cargo nextest"))
        );
        let fact = test_run_fact(
            1,
            Some("s1"),
            &classify_test_run("cargo nextest run", truncated).unwrap(),
            None,
        );
        assert_eq!(fact.text, "tests: cargo nextest — unknown");
    }

    #[test]
    fn a_command_that_is_not_a_test_run_is_refused() {
        // The [P06] hole this feature exists to close runs the other way too:
        // every Bash command becomes a `shell` fact, and only the ones that
        // are really test runs become a second one.
        for command in [
            "cargo build",
            "cargo build --release && ls",
            "git log --oneline",
            "just build-app",
            "bun run check",
        ] {
            assert_eq!(
                classify_test_run(command, "Finished in 3s"),
                None,
                "{command} is not a test run"
            );
        }
    }

    #[test]
    fn the_verdict_comes_from_the_summary_not_from_the_calls_success() {
        // A red suite is a perfectly successful Bash invocation; nothing about
        // the tool call reaches the verdict.
        let red = "     Summary [   0.3s] 10 tests run: 8 passed, 2 failed, 0 skipped";
        let run = classify_test_run("cargo nextest run", red).unwrap();
        assert_eq!(run.verdict, "failed");
        // And the shell fact beside it says the call itself went fine.
        let shell = shell_fact(
            1,
            Some("s1"),
            &ShellFact {
                command: "cargo nextest run",
                route: ShellRoute::Claude,
                ok: true,
                exit_code: None,
                cwd: None,
            },
            None,
        );
        assert!(shell.text.ends_with("→ ok"));
    }

    #[test]
    fn dedupe_keys_pair_a_test_run_with_its_shell_fact() {
        let key = shell_key("s1", "toolu_01");
        assert_eq!(key, "shell:s1:toolu_01");
        assert_eq!(test_run_key(&key), "test:s1:toolu_01");
        assert_eq!(compact_key("s1", 1_700_000), "compact:s1:1700000");
        assert_eq!(commit_key("a1b2c3"), "commit:a1b2c3");
    }

    fn frame<'a>(at_ms: i64, msg_type: &'a str, payload: &'a str) -> SynthFrame<'a> {
        SynthFrame {
            at_ms,
            msg_type,
            payload,
        }
    }

    #[test]
    fn synthesis_derives_the_same_facts_the_live_recorders_would_write() {
        let prompt = r#"{"tug_session_id":"s1","type":"user_message","text":"run the suite"}"#;
        let use_frame = r#"{"tug_session_id":"s1","type":"tool_use","tool_name":"Bash","tool_use_id":"toolu_01","input":{"command":"cargo nextest run"}}"#;
        let result = r#"{"tug_session_id":"s1","type":"tool_result","tool_use_id":"toolu_01","output":"     Summary [ 1.0s] 3 tests run: 3 passed, 0 skipped","is_error":false}"#;
        let boundary = r#"{"tug_session_id":"s1","type":"compact_boundary","trigger":"auto","pre_tokens":140000}"#;

        let out = synthesize_facts_from_frames(&[
            frame(1_000, "user_message", prompt),
            frame(1_100, "tool_use", use_frame),
            frame(1_200, "tool_result", result),
            frame(1_300, "compact_boundary", boundary),
        ]);

        assert_eq!(
            out.kinds,
            vec!["prompt", "shell", "test_run", "session.compacted"]
        );
        assert_eq!(
            out.facts,
            vec![
                prompt_fact(1_000, "s1", "run the suite"),
                // The shell fact is stamped with the `tool_use`'s time, not
                // the result's — when the command ran is the interesting fact.
                shell_fact(
                    1_100,
                    Some("s1"),
                    &ShellFact {
                        command: "cargo nextest run",
                        route: ShellRoute::Claude,
                        ok: true,
                        exit_code: None,
                        cwd: None,
                    },
                    Some(shell_key("s1", "toolu_01")),
                ),
                test_run_fact(
                    1_100,
                    Some("s1"),
                    &TestRunFact::from_counts("cargo nextest", 3, 0, Some(0)),
                    Some(test_run_key(&shell_key("s1", "toolu_01"))),
                ),
                compact_fact(1_300, "s1", Some("auto"), Some(140_000), None),
            ]
        );
    }

    #[test]
    fn synthesis_ignores_a_non_bash_tool_call_and_an_unpaired_result() {
        let read = r#"{"tug_session_id":"s1","type":"tool_use","tool_name":"Read","tool_use_id":"toolu_02","input":{"file_path":"/a.rs"}}"#;
        let orphan = r#"{"tug_session_id":"s1","type":"tool_result","tool_use_id":"toolu_99","output":"x","is_error":false}"#;
        let out = synthesize_facts_from_frames(&[
            frame(1_000, "tool_use", read),
            frame(1_100, "tool_result", orphan),
        ]);
        assert!(out.facts.is_empty());
        assert!(out.kinds.is_empty());
    }

    /// Both shapes, verbatim from the corpus the discriminator was read off.
    #[test]
    fn a_wrapped_tool_use_error_did_not_run_and_an_exit_code_did() {
        assert!(!shell_call_ran(
            "<tool_use_error>Blocked: sleep 45 followed by: read the log</tool_use_error>"
        ));
        assert!(!shell_call_ran(
            "<tool_use_error>InputValidationError: Bash failed due to the following issue:\nThe required parameter `command` is missing</tool_use_error>"
        ));
        // Leading whitespace is the wire's, not a different shape.
        assert!(!shell_call_ran(
            "\n  <tool_use_error>Blocked</tool_use_error>"
        ));
        assert!(shell_call_ran(
            "Exit code 1\n(eval):cd:1: no such file or directory: /nope"
        ));
        assert!(shell_call_ran(""));
        // The words appearing in a command's own output are not the wrapper:
        // only the prefix is the discriminator.
        assert!(shell_call_ran(
            "Exit code 1\ngrep: no match for <tool_use_error>"
        ));
    }

    /// A batch carrying one refused call and one that genuinely failed leaves
    /// exactly the second one behind. `is_error` is true for both, which is
    /// why it could never have answered this.
    #[test]
    fn a_denied_call_beside_a_failing_one_synthesizes_one_shell_fact() {
        let denied_use = r#"{"tug_session_id":"s1","type":"tool_use","tool_name":"Bash","tool_use_id":"toolu_01","input":{"command":"sleep 45"}}"#;
        let denied = r#"{"tug_session_id":"s1","type":"tool_result","tool_use_id":"toolu_01","output":"<tool_use_error>Blocked: sleep 45 followed by: read the log</tool_use_error>","is_error":true}"#;
        let ran_use = r#"{"tug_session_id":"s1","type":"tool_use","tool_name":"Bash","tool_use_id":"toolu_02","input":{"command":"cd /nope"}}"#;
        let ran = r#"{"tug_session_id":"s1","type":"tool_result","tool_use_id":"toolu_02","output":"Exit code 1\n(eval):cd:1: no such file or directory: /nope","is_error":true}"#;

        let out = synthesize_facts_from_frames(&[
            frame(1_000, "tool_use", denied_use),
            frame(1_100, "tool_result", denied),
            frame(1_200, "tool_use", ran_use),
            frame(1_300, "tool_result", ran),
        ]);

        assert_eq!(out.kinds, vec!["shell"]);
        assert_eq!(out.facts.len(), 1);
        assert_eq!(out.facts[0].text, "$ cd /nope → err");
    }

    #[test]
    fn a_stale_edit_program_reads_as_its_counts_and_its_file() {
        let marker = json!({
            "class": "resolve",
            "exit": 3,
            "message": "a.rs: line 3: no match\nnothing was written",
            "ops_resolved": 3,
            "ops_total": 5,
            "files": ["tugdeck/src/deck-manager.ts"],
            "program": "file tugdeck/src/deck-manager.ts\n",
        });
        let fact = edit_failed_fact(1_700_000_000_000, Some("s1"), &marker, None);
        assert_eq!(fact.kind, "edit_failed");
        assert_eq!(
            fact.text,
            "edit program failed to resolve: 2 of 5 ops stale in tugdeck/src/deck-manager.ts"
        );
        assert_eq!(fact.subject.as_deref(), Some("tugdeck/src/deck-manager.ts"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&fact.payload).unwrap(),
            marker,
            "the marker rides whole, program and all"
        );
    }

    #[test]
    fn several_files_read_as_the_first_and_a_count() {
        let marker = json!({
            "class": "resolve",
            "ops_resolved": 0,
            "ops_total": 2,
            "files": ["a.rs", "b.rs", "c.rs"],
        });
        let fact = edit_failed_fact(1, Some("s1"), &marker, None);
        assert_eq!(
            fact.text,
            "edit program failed to resolve: 2 of 2 ops stale in a.rs and 2 others"
        );
    }

    /// A class that never parsed a program has no counts and names no files,
    /// so the sentence says what the refusal said rather than inventing a
    /// tally of zero.
    #[test]
    fn a_parse_failure_reads_as_its_report() {
        let marker = json!({
            "class": "parse",
            "exit": 2,
            "message": "2:3: unknown op `frobnicate`\nnothing was written",
            "ops_resolved": 0,
            "ops_total": 0,
            "files": [],
        });
        let fact = edit_failed_fact(1, Some("s1"), &marker, None);
        assert_eq!(
            fact.text,
            "edit program failed to parse: 2:3: unknown op `frobnicate`"
        );
        assert_eq!(fact.subject.as_deref(), Some("parse"));
    }

    #[test]
    fn an_edit_failed_detail_projects_the_counts_and_withholds_the_program() {
        let marker = json!({
            "class": "resolve",
            "exit": 3,
            "message": "stale",
            "ops_resolved": 1,
            "ops_total": 3,
            "files": ["a.rs"],
            "program": "x".repeat(20_000),
        });
        let detail = render_detail(FactKind::EditFailed, &marker).expect("a detail");
        assert_eq!(detail["class"], "resolve");
        assert_eq!(detail["ops_total"], 3);
        assert_eq!(detail["files"], json!(["a.rs"]));
        assert!(
            detail.get("program").is_none(),
            "the program is payload depth, not a projected field"
        );
    }

    #[test]
    fn the_edit_failed_key_is_stable_per_call() {
        assert_eq!(edit_failed_key("s1", "tu-1"), "edit_failed:s1:tu-1");
        assert_ne!(edit_failed_key("s1", "tu-1"), edit_failed_key("s1", "tu-2"));
    }

    /// Harness parity: a transcript carries tool results, so the replay
    /// harness derives the same `edit_failed` fact the live recorder does.
    #[test]
    fn synthesis_derives_an_edit_failed_fact_from_a_marker_in_the_output() {
        let use_frame = r#"{"tug_session_id":"s1","type":"tool_use","tool_name":"Bash","tool_use_id":"toolu_01","input":{"command":"tugedit"}}"#;
        let result = r#"{"tug_session_id":"s1","type":"tool_result","tool_use_id":"toolu_01","output":"error: stale\nTUG-EDIT-ERROR: {\"class\":\"resolve\",\"ops_resolved\":0,\"ops_total\":1,\"files\":[\"a.rs\"]}","is_error":true}"#;
        let out = synthesize_facts_from_frames(&[
            frame(1_000, "tool_use", use_frame),
            frame(1_100, "tool_result", result),
        ]);
        assert!(out.kinds.contains(&"edit_failed"), "{:?}", out.kinds);
        let fact = out
            .facts
            .iter()
            .find(|f| f.kind == "edit_failed")
            .expect("an edit_failed fact");
        assert_eq!(
            fact.text,
            "edit program failed to resolve: 1 of 1 ops stale in a.rs"
        );
        assert_eq!(fact.dedupe_key.as_deref(), Some("edit_failed:s1:toolu_01"));
    }

    #[test]
    fn the_live_only_kinds_are_the_ones_no_transcript_carries() {
        // A transcript has never seen a commit or a lifecycle transition, and
        // the harness says so rather than looking complete.
        assert!(LIVE_ONLY_KINDS.contains(&"commit"));
        assert!(LIVE_ONLY_KINDS.contains(&"session.spawned"));
        assert!(!LIVE_ONLY_KINDS.contains(&"prompt"));
        assert!(!LIVE_ONLY_KINDS.contains(&"shell"));
        assert!(!LIVE_ONLY_KINDS.contains(&"session.compacted"));
    }
}

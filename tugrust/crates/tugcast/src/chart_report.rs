//! `POST /api/chart/report` — one page of row records for what a chart mark
//! stands for.
//!
//! A chart draws a count; a report says what was counted. The request asks in
//! one of three modes, and every mode answers the same row records, so a row
//! reads the same however it was reached:
//!
//! - **members**: `source` and `address`. The recipe that drew the chart is
//!   run again with the arguments its `source` stamped, and the address is
//!   resolved in what it draws now. The answer is the mark's whole list,
//!   paged by `offset` and `limit`, with the set's `total` and, where the
//!   recipe measures, its `sum`.
//! - **describe**: `refs`. Exactly these are described, in order, which is
//!   how a hand-written fence's set is read: it has no recipe to ask.
//! - **path**: `of`, a `file:` or `dir:` ref, for the commits touching it.
//!
//! A row always carries `kind`, `ref`, `found`, `measure`, `measure_text`
//! and `group`; a found row carries its record under its kind's key. A ref
//! nothing answers for is `found: false`, which the reader draws as plain
//! text.
//!
//! `measure_text` is the measure in the table's format, except for a member
//! of a line recipe, which carries its added and removed lines apart: its
//! text is the pair, `+<added> −<removed>`, while `measure` stays the one
//! number its mark drew. A set whose every member carries the pair writes
//! its `sum_text` the same way, over the summed parts.
//!
//! Two kinds are not refs at all. A member a recipe sent with facts of its
//! own is a `run` (one recorded test run) or a `span` (one stage or step of
//! an arc): its record is those facts, with the record of the ref it stands
//! on beside them when that ref resolves. Only a members read meets them.
//!
//! A commit's record is read from git, a session's from the machine-wide
//! session index, and an arc's from the project's arc log. A file or a
//! directory is checked on disk and its commits counted, a command is looked
//! up among the long calls that reported nothing, and a url is only parsed:
//! nothing here reads the network.
//!
//! The project directory is resolved through
//! `path_resolver::resolve_to_claude_form` on arrival ([L29]). Read-only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tugarc_core::log::{ArcFate, arc_fates, is_terminal, split_log_line};
use tugarc_core::timeline::timeline_for;
use tugcast_core::types::GitLogCommit;
use tugchanges_core::Window;
use tugchart_core::context::RecipeContext;
use tugchart_core::members::{self, Address, FactKind, Member, Resolved};
use tugcore::report_gaps;
use tugcore::session_index::{self, IndexEntry};

use crate::feeds::git::{read_git_log, resolve_commit_prefix, run_git_line};

/// The page size when the request names none.
const DEFAULT_LIMIT: usize = 25;
/// The most rows one page carries, whatever the request asks.
const MAX_LIMIT: usize = 50;
/// The most refs one describe read describes; the rest are not read.
const MAX_REFS: usize = 100;

/// The prefixes a ref is spelled with, which are also the row kinds a ref
/// can be.
const REF_KINDS: [&str; 7] = ["commit", "file", "dir", "session", "arc", "url", "command"];

/// The body of a report read. Which of `source` + `address`, `refs` and `of`
/// are present selects the mode.
#[derive(Debug, Deserialize)]
pub(crate) struct ReportRequest {
    pub project: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub source: Option<SourceRef>,
    #[serde(default)]
    pub address: Option<Address>,
    #[serde(default)]
    pub refs: Option<Vec<String>>,
    #[serde(default)]
    pub of: Option<String>,
}

/// A chart's `source`, as the spec carries it.
#[derive(Debug, Deserialize)]
pub(crate) struct SourceRef {
    pub recipe: String,
    #[serde(default)]
    pub args: Map<String, Value>,
}

/// One page of a report.
#[derive(Debug, Serialize)]
pub(crate) struct ReportResponse {
    pub status: &'static str,
    /// How many members the whole set holds, not the page.
    pub total: usize,
    /// The mark is no longer where the chart drew it.
    pub moved: bool,
    /// The whole set's measure, when the recipe measures.
    pub sum: Option<f64>,
    pub sum_text: Option<String>,
    pub measure: Option<Measure>,
    pub rows: Vec<Row>,
}

/// What a measuring recipe's numbers are, and how the engine writes them.
#[derive(Debug, Serialize)]
pub(crate) struct Measure {
    pub unit: String,
    pub format: String,
}

/// One row record.
#[derive(Debug, Serialize)]
pub(crate) struct Row {
    pub kind: &'static str,
    pub r#ref: Option<String>,
    pub found: bool,
    pub measure: Option<f64>,
    pub measure_text: Option<String>,
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<GitLogCommit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arc: Option<ArcRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<CommandRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<UrlRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<RunRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<SpanRecord>,
}

impl Row {
    /// A row with no record: what a ref nothing answers for is.
    fn bare(kind: &'static str, r#ref: Option<String>) -> Row {
        Row {
            kind,
            r#ref,
            found: false,
            measure: None,
            measure_text: None,
            group: None,
            commit: None,
            session: None,
            arc: None,
            path: None,
            command: None,
            url: None,
            run: None,
            span: None,
        }
    }
}

/// What the session index holds of one session.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct SessionRecord {
    pub id: String,
    pub callsign: Option<String>,
    pub project_dir: String,
    pub project_leaf: String,
    pub title: Option<String>,
    pub updated_at_ms: i64,
}

/// What the arc log holds of one arc's newest generation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct ArcRecord {
    pub name: String,
    /// `live`, `joined` or `discarded`.
    pub fate: &'static str,
    /// The commit the arc landed as, when it joined.
    pub join_sha: Option<String>,
    pub started_at_ms: Option<u64>,
    pub ended_at_ms: Option<u64>,
    /// How many of its steps the log closed with a commit.
    pub step_commits: usize,
}

/// What the disk and the history hold of one file or directory.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct PathRecord {
    /// The path as the ref wrote it.
    pub path: String,
    pub exists: bool,
    /// How many commits touch it, within the source's window or range when
    /// the read came with one. `None` when git could not count, as for a
    /// path outside the repository.
    pub commits: Option<u64>,
}

/// What the record of long silent calls holds of one command.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct CommandRecord {
    pub head: String,
    /// How many such calls ran, and their total time; both `None` when the
    /// record names no such head.
    pub count: Option<i64>,
    pub total_ms: Option<i64>,
}

/// A url's two halves, as its ref spells them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct UrlRecord {
    /// The host, without a leading `www.`.
    pub host: String,
    /// The path with its query, or empty.
    pub path: String,
}

/// What the app-test ledger holds of one run of one file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RunRecord {
    pub status: String,
    /// When the run ended, in Unix seconds.
    pub ended_at: i64,
    pub secs: i64,
    pub passed: i64,
    pub total: i64,
    /// The tree the run stood on, as the run recorded it.
    pub head_sha: String,
    /// That tree's commit, when the recorded sha names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<GitLogCommit>,
}

/// What the arc log holds of one stage or step span. The record of the
/// span's own ref, a session or a commit, rides the row beside it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SpanRecord {
    pub label: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub status: Option<String>,
}

/// Where a page's records are read from, for one project.
#[derive(Debug, Clone)]
struct Sources {
    repo_root: PathBuf,
    arc_log: PathBuf,
    session_index: PathBuf,
    report_gaps: PathBuf,
}

impl Sources {
    fn of(ctx: &RecipeContext) -> Sources {
        Sources {
            repo_root: ctx.repo_root.clone(),
            arc_log: tugtool_core::paths::arc_log_path_at(&ctx.paths, &ctx.repo_root),
            session_index: tugcore::instance::session_index_db_path(),
            report_gaps: tugcore::instance::report_gaps_db_path(),
        }
    }
}

/// Why a read was not answered.
#[derive(Debug)]
pub(crate) enum ReportError {
    /// The request is not one of the three modes, or its arguments are not
    /// the recipe's.
    BadRequest(String),
    /// The source names no recipe.
    NotFound(String),
    /// A read that should have worked.
    Internal(String),
}

impl ReportError {
    pub(crate) fn status(&self) -> StatusCode {
        match self {
            ReportError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ReportError::NotFound(_) => StatusCode::NOT_FOUND,
            ReportError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl std::fmt::Display for ReportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReportError::BadRequest(message)
            | ReportError::NotFound(message)
            | ReportError::Internal(message) => f.write_str(message),
        }
    }
}

/// Answer one report read.
pub(crate) async fn report(req: ReportRequest) -> Result<ReportResponse, ReportError> {
    if req.project.is_empty() {
        return Err(ReportError::BadRequest("no project".to_string()));
    }
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let dir = crate::path_resolver::resolve_to_claude_form(Path::new(&req.project));
    match (req.source, req.address, req.refs, req.of) {
        (Some(source), Some(address), None, None) => {
            members_page(dir, source, address, req.offset, limit).await
        }
        (None, None, Some(refs), None) => describe_refs(dir, refs).await,
        (source, None, None, Some(of)) => {
            let selection = match &source {
                Some(source) => Selection::of_source(&source.args)?,
                None => Selection::Head,
            };
            path_page(dir, selection, of, req.offset, limit).await
        }
        _ => Err(ReportError::BadRequest(
            "send exactly one of source with address, refs, or of".to_string(),
        )),
    }
}

/// Members mode: run the source's recipe again, resolve the address, and
/// describe one page of what it holds.
async fn members_page(
    dir: PathBuf,
    source: SourceRef,
    address: Address,
    offset: usize,
    limit: usize,
) -> Result<ReportResponse, ReportError> {
    let Some(recipe) = tugchart_core::catalog::find(&source.recipe) else {
        return Err(ReportError::NotFound("unknown recipe".to_string()));
    };
    let args = members::args_from_source(recipe, &source.args).map_err(ReportError::BadRequest)?;
    let selection = Selection::of(
        args.since.as_deref(),
        args.until.as_deref(),
        args.range.as_deref(),
    )?;
    // The run reads git and the ledgers, so it goes on the blocking pool.
    let (sources, read) = tokio::task::spawn_blocking(move || {
        let ctx = RecipeContext::for_project(&dir);
        let read = members::members_of(recipe, &ctx, &args, &address);
        (Sources::of(&ctx), read)
    })
    .await
    .map_err(|e| ReportError::Internal(e.to_string()))?;
    let (resolved, measure) = read.map_err(|e| ReportError::Internal(e.to_string()))?;
    let Resolved::Members(all) = resolved else {
        return Ok(ReportResponse {
            status: "ok",
            total: 0,
            moved: true,
            sum: None,
            sum_text: None,
            measure: None,
            rows: Vec::new(),
        });
    };
    let measure = measure.map(|(unit, format)| Measure { unit, format });
    let format = measure.as_ref().map(|m| m.format.as_str());
    let sum = format.map(|_| all.iter().filter_map(|m| m.measure).sum::<f64>());
    let parts: Option<Vec<(f64, f64)>> = if all.is_empty() {
        None
    } else {
        all.iter().map(|m| m.parts).collect()
    };
    let sum_text = format.and_then(|format| match &parts {
        Some(parts) => {
            let (added, removed) = parts
                .iter()
                .fold((0.0, 0.0), |(a, r), (pa, pr)| (a + pa, r + pr));
            Some(pair_text(format, added, removed))
        }
        None => sum.map(|sum| members::format_measure(format, sum)),
    });
    let page: Vec<Member> = all.iter().skip(offset).take(limit).cloned().collect();
    let rows = describe(&sources, &page, format, &selection).await;
    Ok(ReportResponse {
        status: "ok",
        total: all.len(),
        moved: false,
        sum,
        sum_text,
        measure,
        rows,
    })
}

/// A line recipe's pair, `+<added> −<removed>`, each in `format`.
fn pair_text(format: &str, added: f64, removed: f64) -> String {
    format!(
        "+{} −{}",
        members::format_measure(format, added),
        members::format_measure(format, removed)
    )
}

/// A row's text in the table's format: the pair for a member with parts,
/// else its measure, and nothing where no format is in force.
fn measure_text(member: &Member, format: Option<&str>) -> Option<String> {
    let format = format?;
    match member.parts {
        Some((added, removed)) => Some(pair_text(format, added, removed)),
        None => member
            .measure
            .map(|value| members::format_measure(format, value)),
    }
}

/// Describe mode: the refs sent are the page.
async fn describe_refs(dir: PathBuf, refs: Vec<String>) -> Result<ReportResponse, ReportError> {
    if refs.is_empty() {
        return Err(ReportError::BadRequest("no refs".to_string()));
    }
    let page: Vec<Member> = refs.into_iter().take(MAX_REFS).map(Member::of).collect();
    // Finding the repository root runs git.
    let sources =
        tokio::task::spawn_blocking(move || Sources::of(&RecipeContext::for_project(&dir)))
            .await
            .map_err(|e| ReportError::Internal(e.to_string()))?;
    let rows = describe(&sources, &page, None, &Selection::Head).await;
    Ok(ReportResponse {
        status: "ok",
        total: rows.len(),
        moved: false,
        sum: None,
        sum_text: None,
        measure: None,
        rows,
    })
}

/// Which of the history a path's commits are read from: a source's range,
/// its window, or, with neither, everything HEAD reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Selection {
    Head,
    Window(Window),
    /// `a..b`, each end a sha [`is_sha`] passed.
    Range(String),
}

impl Selection {
    /// The selection a source's arguments name. A `range` names the commits
    /// of a `landed` read; a `since` the window of any other.
    fn of_source(args: &Map<String, Value>) -> Result<Selection, ReportError> {
        let text = |key: &str| args.get(key).and_then(Value::as_str);
        Selection::of(text("since"), text("until"), text("range"))
    }

    /// The selection of `range`, else of `since` and `until`. A range whose
    /// ends are not both shas is refused, so nothing else reaches git.
    fn of(
        since: Option<&str>,
        until: Option<&str>,
        range: Option<&str>,
    ) -> Result<Selection, ReportError> {
        if let Some(range) = range {
            return match range.split_once("..") {
                Some((from, to)) if is_sha(from) && is_sha(to) => {
                    Ok(Selection::Range(format!("{from}..{to}")))
                }
                _ => Err(ReportError::BadRequest(
                    "a range is two shas joined by ..".to_string(),
                )),
            };
        }
        Ok(since.map_or(Selection::Head, |since| {
            Selection::Window(Window {
                since: since.to_string(),
                until: until.map(str::to_string),
            })
        }))
    }

    /// The arguments that select these commits, the revision last, where
    /// `HEAD` stands when there is no range.
    fn git_args(&self) -> Vec<String> {
        match self {
            Selection::Head => vec!["HEAD".to_string()],
            Selection::Window(window) => {
                let mut args = window.git_args();
                args.push("HEAD".to_string());
                args
            }
            Selection::Range(range) => vec![range.clone()],
        }
    }
}

/// Path mode: one page of the commits touching the path `of` names, newest
/// first, within `selection`.
async fn path_page(
    dir: PathBuf,
    selection: Selection,
    of: String,
    offset: usize,
    limit: usize,
) -> Result<ReportResponse, ReportError> {
    let Some(path) = ref_path(&of) else {
        return Err(ReportError::BadRequest(
            "of names a file: or dir: ref".to_string(),
        ));
    };
    let sources =
        tokio::task::spawn_blocking(move || Sources::of(&RecipeContext::for_project(&dir)))
            .await
            .map_err(|e| ReportError::Internal(e.to_string()))?;
    let total = count_commits(&sources.repo_root, &selection, path)
        .await
        .unwrap_or(0);
    let mut args = vec![format!("--skip={offset}"), format!("-n{limit}")];
    args.extend(selection.git_args());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let commits = read_git_log(&sources.repo_root, &args, &[path]).await;
    let rows = commits
        .into_iter()
        .map(|commit| Row {
            found: true,
            commit: Some(commit.clone()),
            ..Row::bare("commit", Some(format!("commit:{}", commit.sha)))
        })
        .collect();
    Ok(ReportResponse {
        status: "ok",
        total: usize::try_from(total).unwrap_or(usize::MAX),
        moved: false,
        sum: None,
        sum_text: None,
        measure: None,
        rows,
    })
}

/// The kind a ref's prefix names, or `unknown` for a ref with none of them.
fn ref_kind(r#ref: &str) -> &'static str {
    let prefix = r#ref.split_once(':').map_or("", |(prefix, _)| prefix);
    REF_KINDS
        .iter()
        .find(|kind| **kind == prefix)
        .copied()
        .unwrap_or("unknown")
}

/// The sha a `commit:` ref names, lowercased, when it is one git may be
/// handed: 4 to 40 hex characters. Anything else never reaches a git
/// argument list.
fn commit_sha(r#ref: &str) -> Option<String> {
    let sha = r#ref.strip_prefix("commit:")?;
    is_sha(sha).then(|| sha.to_ascii_lowercase())
}

/// Whether `text` is 4 to 40 hex characters, the one shape of revision a
/// report hands git.
fn is_sha(text: &str) -> bool {
    (4..=40).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// The path a `file:` or `dir:` ref names, when it is one git may be handed:
/// not empty, and with no newline or NUL in it.
fn ref_path(r#ref: &str) -> Option<&str> {
    let path = r#ref
        .strip_prefix("file:")
        .or_else(|| r#ref.strip_prefix("dir:"))?;
    (!path.is_empty() && !path.contains(['\n', '\0'])).then_some(path)
}

/// How many of `selection`'s commits touch `path`. The path goes after
/// `--`, so it is never read as an option.
async fn count_commits(repo_root: &Path, selection: &Selection, path: &str) -> Option<u64> {
    let mut args = vec!["rev-list".to_string(), "--count".to_string()];
    args.extend(selection.git_args());
    args.extend(["--".to_string(), path.to_string()]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_line(repo_root, &args).await?.parse().ok()
}

/// The path records of `members`, one slot per member. A relative path is
/// read under the repository root and an absolute one as given. The counts
/// are separate reads of the history, taken together.
async fn read_paths(
    repo_root: &Path,
    members: &[Member],
    selection: &Selection,
) -> Vec<Option<PathRecord>> {
    futures::future::join_all(members.iter().map(|member| async move {
        let path = ref_path(member.r#ref.as_deref()?)?;
        Some(PathRecord {
            path: path.to_string(),
            exists: tokio::fs::try_exists(repo_root.join(path))
                .await
                .unwrap_or(false),
            commits: count_commits(repo_root, selection, path).await,
        })
    }))
    .await
}

/// The command records of `members`, one slot per member. The record of
/// silent calls is summarized once for the page, and not at all for a page
/// that names no command. A command exists by being written, so every
/// `command:` ref has a record, with its numbers when a head matches it.
async fn read_commands(gaps: &Path, members: &[Member]) -> Vec<Option<CommandRecord>> {
    let heads: Vec<Option<String>> = members
        .iter()
        .map(|m| {
            let head = m.r#ref.as_deref()?.strip_prefix("command:")?;
            (!head.is_empty()).then(|| head.to_string())
        })
        .collect();
    if heads.iter().all(Option::is_none) {
        return Vec::new();
    }
    let gaps = gaps.to_path_buf();
    let summaries = tokio::task::spawn_blocking(move || report_gaps::summarize(&gaps))
        .await
        .unwrap_or_default();
    heads
        .into_iter()
        .map(|head| {
            let head = head?;
            let gap = summaries.iter().find(|gap| gap.head == head);
            Some(CommandRecord {
                count: gap.map(|gap| gap.count),
                total_ms: gap.map(|gap| gap.total_ms),
                head,
            })
        })
        .collect()
}

/// The record of the url a `url:` ref names: its host without `www.`, and
/// its path with the query. Nothing is fetched.
fn url_record(r#ref: &str) -> Option<UrlRecord> {
    let url = r#ref.strip_prefix("url:")?;
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let cut = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, path) = rest.split_at(cut);
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty()).then(|| UrlRecord {
        host: host.to_string(),
        path: if path == "/" { "" } else { path }.to_string(),
    })
}

/// The row record of each member, in the members' order. Members are read a
/// kind at a time, one read per kind for the whole page, and each row then
/// takes its record from its kind's answer. `format` is the measure's format
/// name when the set measures, and `selection` the source's window or range,
/// which a path's commit count is taken within.
async fn describe(
    sources: &Sources,
    members: &[Member],
    format: Option<&str>,
    selection: &Selection,
) -> Vec<Row> {
    let shas: Vec<String> = members
        .iter()
        .filter_map(|m| commit_sha(m.r#ref.as_deref()?))
        .collect();
    let commits = read_commits(&sources.repo_root, &shas).await;
    let (sessions, arcs) = read_ledgers(sources, members).await;
    let paths = read_paths(&sources.repo_root, members, selection).await;
    let commands = read_commands(&sources.report_gaps, members).await;
    members
        .iter()
        .enumerate()
        .map(|(i, member)| {
            let r#ref = member.r#ref.as_deref();
            // A ref's sha is a prefix of the record it names.
            let commit = r#ref.and_then(commit_sha).and_then(|sha| {
                commits
                    .iter()
                    .find(|commit| commit.sha.starts_with(&sha))
                    .cloned()
            });
            let session = sessions.get(i).cloned().flatten();
            let arc = arcs.get(i).cloned().flatten();
            let path = paths.get(i).cloned().flatten();
            let command = commands.get(i).cloned().flatten();
            let url = r#ref.and_then(url_record);
            // A member with facts is a row of what the facts describe, and
            // its ref's record is what it stands on.
            let facts = member.facts.clone();
            let run: Option<RunRecord> = match member.fact_kind {
                Some(FactKind::Run) => facts
                    .clone()
                    .and_then(|facts| serde_json::from_value(facts).ok())
                    .map(|run| RunRecord {
                        commit: commit.clone(),
                        ..run
                    }),
                _ => None,
            };
            let span: Option<SpanRecord> = match member.fact_kind {
                Some(FactKind::Span) => facts.and_then(|facts| serde_json::from_value(facts).ok()),
                _ => None,
            };
            let kind = match (&run, &span) {
                (Some(_), _) => "run",
                (_, Some(_)) => "span",
                _ => r#ref.map_or("unknown", ref_kind),
            };
            // A run's commit is inside its record, not beside it.
            let commit = if run.is_some() { None } else { commit };
            Row {
                found: commit.is_some()
                    || session.is_some()
                    || arc.is_some()
                    || path.is_some()
                    || command.is_some()
                    || url.is_some()
                    || run.is_some()
                    || span.is_some(),
                measure: member.measure,
                measure_text: measure_text(member, format),
                group: member.group.clone(),
                commit,
                session,
                arc,
                path,
                command,
                url,
                run,
                span,
                ..Row::bare(kind, member.r#ref.clone())
            }
        })
        .collect()
}

/// The session and arc records of `members`, one slot per member in order,
/// `None` where the member is neither or nothing answers for it. The index
/// and the log are files, so the read goes on the blocking pool; the log is
/// read once however many arcs the page names, and not at all when it names
/// none.
async fn read_ledgers(
    sources: &Sources,
    members: &[Member],
) -> (Vec<Option<SessionRecord>>, Vec<Option<ArcRecord>>) {
    let refs: Vec<Option<String>> = members.iter().map(|m| m.r#ref.clone()).collect();
    let wanted = |prefix: &str| refs.iter().flatten().any(|r| r.starts_with(prefix));
    if !wanted("session:") && !wanted("arc:") {
        return (Vec::new(), Vec::new());
    }
    let sources = sources.clone();
    tokio::task::spawn_blocking(move || {
        let sessions = refs
            .iter()
            .map(|r| session_record(&sources.session_index, r.as_deref()?))
            .collect();
        let log = if refs.iter().flatten().any(|r| r.starts_with("arc:")) {
            std::fs::read_to_string(&sources.arc_log).unwrap_or_default()
        } else {
            String::new()
        };
        let fates = arc_fates(&log);
        let arcs = refs
            .iter()
            .map(|r| arc_record(&log, &fates, r.as_deref()?.strip_prefix("arc:")?))
            .collect();
        (sessions, arcs)
    })
    .await
    .unwrap_or_default()
}

/// The record of the session a `session:` ref names, from the index at
/// `index`. A full uuid is looked up as it is; an eight-character short id
/// is found only when exactly one session starts with it. Any other
/// spelling, and a ref nothing answers for, is `None`.
fn session_record(index: &Path, r#ref: &str) -> Option<SessionRecord> {
    let id = r#ref.strip_prefix("session:")?;
    let hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    let mut found: Vec<IndexEntry> = if id.len() == 36 && hex(id) {
        session_index::lookup_uuid(index, &id.to_ascii_lowercase())
    } else if id.len() == 8 && hex(id) && !id.contains('-') {
        session_index::lookup_prefix(index, &id.to_ascii_lowercase())
    } else {
        return None;
    };
    if found.len() != 1 {
        return None;
    }
    let entry = found.pop()?;
    Some(SessionRecord {
        id: entry.session_id,
        callsign: entry.callsign,
        project_dir: entry.project_dir,
        project_leaf: entry.project_leaf,
        title: entry.title,
        updated_at_ms: entry.updated_at_ms,
    })
}

fn log_ms(timestamp: &str) -> Option<u64> {
    let at = chrono::DateTime::parse_from_rfc3339(timestamp).ok()?;
    u64::try_from(at.timestamp_millis()).ok()
}

/// The record of the arc `name` in the log `log`, whose fates are `fates`,
/// or `None` for a name the log never held. The record is of the name's
/// newest generation. An arc the log names and `arc_fates` leaves out was
/// discarded.
fn arc_record(log: &str, fates: &BTreeMap<String, ArcFate>, name: &str) -> Option<ArcRecord> {
    // The newest generation's first line and its terminal line. After a
    // terminal line only `arc-start` opens another generation.
    let mut seen = false;
    let mut closed = false;
    let mut first: Option<u64> = None;
    let mut terminal: Option<u64> = None;
    for (timestamp, arc, marker, note) in log.lines().filter_map(split_log_line) {
        if arc != name {
            continue;
        }
        seen = true;
        if closed {
            if marker != "arc-start" || is_terminal(marker, note) {
                continue;
            }
            closed = false;
            first = None;
            terminal = None;
        }
        let at = log_ms(timestamp);
        first = first.or(at);
        if is_terminal(marker, note) {
            closed = true;
            terminal = at;
        }
    }
    if !seen {
        return None;
    }
    let (fate, join_sha) = match fates.get(name) {
        Some(ArcFate::Live) => ("live", None),
        Some(ArcFate::Joined { sha }) => ("joined", Some(sha.clone())),
        None => ("discarded", None),
    };
    let timeline = timeline_for(log, name);
    Some(ArcRecord {
        name: name.to_string(),
        fate,
        join_sha,
        started_at_ms: timeline
            .as_ref()
            .and_then(|t| t.stages.first())
            .map(|stage| stage.at_ms)
            .or(first),
        ended_at_ms: timeline.as_ref().and_then(|t| t.done_at_ms).or(terminal),
        step_commits: timeline.map_or(0, |t| {
            t.steps.iter().filter(|step| step.commit.is_some()).count()
        }),
    })
}

/// The commit records of `shas`, read in one `git log`.
///
/// `--no-walk` refuses the whole list when one sha names no commit, so a read
/// that answers nothing is taken again over only the shas that resolve, each
/// asked for on its own.
async fn read_commits(repo_root: &Path, shas: &[String]) -> Vec<GitLogCommit> {
    let mut unique: Vec<String> = Vec::with_capacity(shas.len());
    for sha in shas {
        if !unique.contains(sha) {
            unique.push(sha.clone());
        }
    }
    if unique.is_empty() {
        return Vec::new();
    }
    let commits = log_no_walk(repo_root, &unique).await;
    if !commits.is_empty() {
        return commits;
    }
    let mut known: Vec<String> = Vec::new();
    for sha in &unique {
        if let Some(full) = resolve_commit_prefix(repo_root, sha).await {
            if !known.contains(&full) {
                known.push(full);
            }
        }
    }
    if known.is_empty() {
        return Vec::new();
    }
    log_no_walk(repo_root, &known).await
}

/// Exactly the commits named, in the order named.
async fn log_no_walk(repo_root: &Path, shas: &[String]) -> Vec<GitLogCommit> {
    let mut selection: Vec<&str> = vec!["--no-walk=unsorted"];
    selection.extend(shas.iter().map(String::as_str));
    read_git_log(repo_root, &selection, &[]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;
    use tugchart_core::context::{RecipeArgs, RecipeOutcome};
    use tugchart_core::members::{MemberKey, MemberTable};
    use tugcore::report_gaps::{GapRow, ReportGaps};
    use tugcore::test_fixtures::git::{GitFixture, git};

    fn repo() -> TempDir {
        let temp = TempDir::new().unwrap();
        GitFixture::init(temp.path());
        temp
    }

    /// Commit `message`, changing `lines` lines of a file of its own when
    /// any are asked for, and answer the new sha.
    fn commit(repo: &Path, message: &str, lines: usize) -> String {
        if lines == 0 {
            git(repo, &["commit", "--allow-empty", "-m", message]);
        } else {
            let name = format!("{}.txt", message.split_whitespace().next().unwrap());
            std::fs::write(repo.join(name), "x\n".repeat(lines)).unwrap();
            git(repo, &["add", "-A"]);
            git(repo, &["commit", "-m", message]);
        }
        git(repo, &["rev-parse", "HEAD"]).trim().to_string()
    }

    fn request(repo: &Path, mut body: Value) -> ReportRequest {
        body["project"] = json!(repo.to_string_lossy());
        serde_json::from_value(body).unwrap()
    }

    /// `recipe` drawn over `repo` with its defaults: the spec, whose `source`
    /// a members read sends back, and the member table it came with.
    fn drawn(repo: &Path, recipe: &str) -> (Value, MemberTable) {
        let ctx = RecipeContext::for_project(repo);
        let outcome = tugchart_core::catalog::find(recipe)
            .unwrap()
            .run(&ctx, &RecipeArgs::default())
            .unwrap();
        match outcome {
            RecipeOutcome::Chart { spec, members, .. } => (spec, members),
            RecipeOutcome::NoData { summary } => panic!("{recipe} drew nothing: {summary}"),
        }
    }

    /// The address of the spec's last row, which is today's.
    fn last_row(spec: &Value) -> (usize, String) {
        let labels = spec["categories"]
            .as_array()
            .or_else(|| spec["x"].as_array())
            .expect("a row axis");
        let row = labels.len() - 1;
        (row, labels[row].as_str().unwrap().to_string())
    }

    fn members_body(spec: &Value, row: usize, label: &str) -> Value {
        json!({
            "source": spec["source"],
            "address": {"row": row, "label": label},
        })
    }

    #[tokio::test]
    async fn a_describe_read_answers_each_ref_in_order_found_or_not() {
        let temp = repo();
        let first = commit(temp.path(), "first\n\nThe body of the first.", 1);
        let second = commit(temp.path(), "second", 1);
        let unknown = "0123456789abcdef0123456789abcdef01234567";
        let page = report(request(
            temp.path(),
            json!({"refs": [
                format!("commit:{second}"),
                format!("commit:{unknown}"),
                format!("commit:{first}"),
            ]}),
        ))
        .await
        .unwrap();

        assert_eq!(page.total, 3);
        assert!(!page.moved);
        let found: Vec<bool> = page.rows.iter().map(|r| r.found).collect();
        assert_eq!(found, [true, false, true]);
        assert!(page.rows.iter().all(|r| r.kind == "commit"));
        let second_row = page.rows[0].commit.as_ref().unwrap();
        assert_eq!(second_row.subject, "second");
        assert_eq!(second_row.sha, second);
        let first_row = page.rows[2].commit.as_ref().unwrap();
        assert_eq!(first_row.subject, "first");
        assert_eq!(first_row.body, "The body of the first.");
        assert_eq!(first_row.files, ["first.txt"]);
        assert!(page.rows[1].commit.is_none());
        assert_eq!(
            page.rows[1].r#ref.as_deref(),
            Some(format!("commit:{unknown}").as_str()),
            "an unfound row still names what was asked for"
        );
        assert!(page.sum.is_none() && page.measure.is_none());
    }

    #[tokio::test]
    async fn a_describe_read_finds_a_short_sha_and_never_hands_git_a_stranger() {
        let temp = repo();
        let sha = commit(temp.path(), "only", 1);
        let page = report(request(
            temp.path(),
            json!({"refs": [
                format!("commit:{}", &sha[..8]),
                "commit:--all",
                "commit:HEAD",
                "file:only.txt",
                "nothing",
            ]}),
        ))
        .await
        .unwrap();

        assert_eq!(page.rows[0].commit.as_ref().unwrap().sha, sha);
        let found: Vec<bool> = page.rows.iter().map(|r| r.found).collect();
        assert_eq!(found, [true, false, false, true, false]);
        let kinds: Vec<&str> = page.rows.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, ["commit", "commit", "commit", "file", "unknown"]);
    }

    #[tokio::test]
    async fn a_trailer_is_a_field_of_the_record_and_not_ink_in_its_body() {
        let temp = repo();
        let sha = commit(
            temp.path(),
            "joined\n\nWhat landed.\n\nTug-Arc: tugarc/demo onto main",
            1,
        );
        let page = report(request(
            temp.path(),
            json!({"refs": [format!("commit:{sha}")]}),
        ))
        .await
        .unwrap();
        let record = page.rows[0].commit.as_ref().unwrap();
        assert_eq!(record.tug_arc.as_deref(), Some("tugarc/demo onto main"));
        assert_eq!(record.body, "What landed.");
    }

    #[tokio::test]
    async fn a_members_read_pages_the_days_commits_in_the_tables_order() {
        let temp = repo();
        for n in 0..30 {
            commit(temp.path(), &format!("commit {n}"), 0);
        }
        let (spec, table) = drawn(temp.path(), "commits");
        let (row, label) = last_row(&spec);
        let expected: Vec<Option<String>> = table
            .get(MemberKey::Row(row))
            .iter()
            .map(|m| m.r#ref.clone())
            .collect();
        assert_eq!(expected.len(), 30);

        let first = report(request(temp.path(), members_body(&spec, row, &label)))
            .await
            .unwrap();
        assert_eq!(first.total, 30);
        assert!(!first.moved);
        assert_eq!(first.rows.len(), 25, "the default page");
        let refs: Vec<Option<String>> = first.rows.iter().map(|r| r.r#ref.clone()).collect();
        assert_eq!(refs, expected[..25]);
        assert!(first.rows.iter().all(|r| r.found && r.commit.is_some()));
        assert!(first.sum.is_none() && first.measure.is_none());

        let mut body = members_body(&spec, row, &label);
        body["offset"] = json!(25);
        let second = report(request(temp.path(), body)).await.unwrap();
        assert_eq!(second.total, 30);
        let refs: Vec<Option<String>> = second.rows.iter().map(|r| r.r#ref.clone()).collect();
        assert_eq!(refs, expected[25..]);
    }

    #[tokio::test]
    async fn a_limit_is_clamped_and_a_moved_label_says_so() {
        let temp = repo();
        for n in 0..55 {
            commit(temp.path(), &format!("commit {n}"), 0);
        }
        let (spec, _) = drawn(temp.path(), "commits");
        let (row, label) = last_row(&spec);

        let mut body = members_body(&spec, row, &label);
        body["limit"] = json!(500);
        let page = report(request(temp.path(), body)).await.unwrap();
        assert_eq!(page.total, 55);
        assert_eq!(page.rows.len(), 50);

        let gone = report(request(
            temp.path(),
            members_body(&spec, row, "no such day"),
        ))
        .await
        .unwrap();
        assert!(gone.moved);
        assert_eq!(gone.total, 0);
        assert!(gone.rows.is_empty());
    }

    #[tokio::test]
    async fn a_request_that_is_no_one_mode_is_refused() {
        let temp = repo();
        commit(temp.path(), "only", 1);
        let (spec, _) = drawn(temp.path(), "commits");
        let (row, label) = last_row(&spec);

        let mut both = members_body(&spec, row, &label);
        both["refs"] = json!(["commit:abcd"]);
        let refused = report(request(temp.path(), both)).await.unwrap_err();
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);

        let none = report(request(temp.path(), json!({}))).await.unwrap_err();
        assert_eq!(none.status(), StatusCode::BAD_REQUEST);

        let empty = report(request(temp.path(), json!({"refs": []})))
            .await
            .unwrap_err();
        assert_eq!(empty.status(), StatusCode::BAD_REQUEST);

        let path = report(request(temp.path(), json!({"of": "commit:abcd"})))
            .await
            .unwrap_err();
        assert_eq!(path.status(), StatusCode::BAD_REQUEST);

        let both = report(request(
            temp.path(),
            json!({"of": "file:only.txt", "refs": ["commit:abcd"]}),
        ))
        .await
        .unwrap_err();
        assert_eq!(both.status(), StatusCode::BAD_REQUEST);

        let stranger = report(request(
            temp.path(),
            json!({
                "source": {"recipe": "no-such-recipe"},
                "address": {"row": 0, "label": "x"},
            }),
        ))
        .await
        .unwrap_err();
        assert_eq!(stranger.status(), StatusCode::NOT_FOUND);

        let foreign = report(request(
            temp.path(),
            json!({
                "source": {"recipe": "commits", "args": {"kind": "input"}},
                "address": {"row": 0, "label": "x"},
            }),
        ))
        .await
        .unwrap_err();
        assert_eq!(
            foreign.status(),
            StatusCode::BAD_REQUEST,
            "an argument the recipe's source never carries"
        );
    }

    #[tokio::test]
    async fn a_measuring_recipe_reports_each_rows_measure_and_the_sets_sum() {
        let temp = repo();
        commit(temp.path(), "small change", 3);
        commit(temp.path(), "large change", 1200);
        let (spec, _) = drawn(temp.path(), "churn");
        let (row, label) = last_row(&spec);

        let mut body = members_body(&spec, row, &label);
        body["limit"] = json!(1);
        let page = report(request(temp.path(), body)).await.unwrap();

        let measure = page.measure.as_ref().expect("churn measures");
        assert_eq!(
            (measure.unit.as_str(), measure.format.as_str()),
            ("lines", "count")
        );
        assert_eq!(page.total, 2);
        assert_eq!(
            page.sum,
            Some(1203.0),
            "the sum is the set's, not the page's"
        );
        assert_eq!(
            page.sum_text.as_deref(),
            Some("+1.2k −0"),
            "the pair of the set's summed parts"
        );
        assert_eq!(page.rows.len(), 1);

        let all = report(request(temp.path(), members_body(&spec, row, &label)))
            .await
            .unwrap();
        let mut texts: Vec<(f64, String)> = all
            .rows
            .iter()
            .map(|r| (r.measure.unwrap(), r.measure_text.clone().unwrap()))
            .collect();
        texts.sort_by(|a, b| a.0.total_cmp(&b.0));
        assert_eq!(
            texts,
            [(3.0, "+3 −0".to_string()), (1200.0, "+1.2k −0".to_string())]
        );
    }

    #[test]
    fn a_member_without_parts_keeps_its_measure_text() {
        let plain = Member::of("commit:abc").measured(1500.0);
        assert_eq!(measure_text(&plain, Some("count")).as_deref(), Some("1.5k"));
        assert_eq!(measure_text(&plain, None), None);
        let parted = plain.parted(1200.0, 300.0);
        assert_eq!(
            measure_text(&parted, Some("count")).as_deref(),
            Some("+1.2k −300")
        );
        assert_eq!(pair_text("count", 0.0, 7.0), "+0 −7");
    }

    fn log_line(at: &str, arc: &str, marker: &str, note: &str) -> String {
        format!("{at}  {arc}  {marker}  {note}\n")
    }

    fn ms(at: &str) -> u64 {
        log_ms(at).unwrap()
    }

    #[test]
    fn an_arc_record_says_what_the_log_holds_of_each_fate() {
        let log = [
            log_line("2026-10-07T12:00:00.000Z", "open", "arc-start", "brief.md"),
            log_line(
                "2026-10-07T12:05:00.000Z",
                "open",
                "arc-stage",
                "implement s1 -",
            ),
            log_line(
                "2026-10-07T12:10:00.000Z",
                "open",
                "step-start",
                "1/2 First",
            ),
            log_line(
                "2026-10-07T12:20:00.000Z",
                "open",
                "step-done",
                "1/2 abc1234",
            ),
            log_line(
                "2026-10-08T09:00:00.000Z",
                "landed",
                "arc-start",
                "brief.md",
            ),
            log_line(
                "2026-10-08T09:01:00.000Z",
                "landed",
                "arc-stage",
                "implement s2 -",
            ),
            log_line(
                "2026-10-08T10:00:00.000Z",
                "landed",
                "7d16f2ac6",
                "joined via card",
            ),
            // A note after the join belongs to the generation that ended.
            log_line("2026-10-08T11:00:00.000Z", "landed", "note", "afterwards"),
            log_line(
                "2026-10-09T09:00:00.000Z",
                "dropped",
                "arc-start",
                "brief.md",
            ),
            log_line("2026-10-09T09:30:00.000Z", "dropped", "discarded", ""),
            // A name begun again after a discard is read by its newest life.
            log_line("2026-10-10T08:00:00.000Z", "again", "arc-start", "brief.md"),
            log_line("2026-10-10T08:30:00.000Z", "again", "discarded", ""),
            log_line("2026-10-11T08:00:00.000Z", "again", "arc-start", "brief.md"),
        ]
        .concat();
        let fates = arc_fates(&log);
        let read = |name: &str| arc_record(&log, &fates, name);

        let open = read("open").unwrap();
        assert_eq!((open.fate, open.join_sha.as_deref()), ("live", None));
        assert_eq!(open.started_at_ms, Some(ms("2026-10-07T12:05:00.000Z")));
        assert_eq!(open.ended_at_ms, None);
        assert_eq!(open.step_commits, 1);

        let landed = read("landed").unwrap();
        assert_eq!(
            (landed.fate, landed.join_sha.as_deref()),
            ("joined", Some("7d16f2ac6"))
        );
        assert_eq!(landed.ended_at_ms, Some(ms("2026-10-08T10:00:00.000Z")));
        assert_eq!(landed.step_commits, 0);

        let dropped = read("dropped").unwrap();
        assert_eq!(
            (dropped.fate, dropped.join_sha.as_deref()),
            ("discarded", None)
        );
        // No stage was ever seated, so the generation's first line stands in.
        assert_eq!(dropped.started_at_ms, Some(ms("2026-10-09T09:00:00.000Z")));
        assert_eq!(dropped.ended_at_ms, Some(ms("2026-10-09T09:30:00.000Z")));

        let again = read("again").unwrap();
        assert_eq!(again.fate, "live");
        assert_eq!(again.started_at_ms, Some(ms("2026-10-11T08:00:00.000Z")));
        assert_eq!(again.ended_at_ms, None);

        assert!(read("never").is_none(), "a name the log never held");
    }

    fn index_entry(id: &str, callsign: &str, title: Option<&str>) -> IndexEntry {
        IndexEntry {
            session_id: id.to_string(),
            line_id: format!("line-{callsign}"),
            callsign: Some(callsign.to_string()),
            project_dir: "/u/src/demo".to_string(),
            project_leaf: String::new(),
            instance: String::new(),
            title: title.map(str::to_string),
            created_at_ms: 1_000,
            updated_at_ms: 2_000,
        }
    }

    #[test]
    fn a_session_record_is_found_by_uuid_or_by_a_short_id_only_one_session_has() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("session_index.db");
        let index = session_index::SessionIndex::open(&path).unwrap();
        let one = "048e4155-f644-46f7-a839-d22ac02a564f";
        let twin_a = "63bcd0c2-5d98-4e84-b88f-cdac1ed0f66f";
        let twin_b = "63bcd0c2-0000-4000-8000-000000000002";
        index
            .upsert(&index_entry(one, "mighty-cabin", Some("The cabin")))
            .unwrap();
        index
            .upsert(&index_entry(twin_a, "odd-kiln", None))
            .unwrap();
        index
            .upsert(&index_entry(twin_b, "curly-apple", None))
            .unwrap();
        drop(index);

        let by_uuid = session_record(&path, &format!("session:{one}")).unwrap();
        assert_eq!(by_uuid.id, one);
        assert_eq!(by_uuid.callsign.as_deref(), Some("mighty-cabin"));
        assert_eq!(by_uuid.title.as_deref(), Some("The cabin"));
        assert_eq!(by_uuid.project_leaf, "demo");
        assert_eq!(by_uuid.updated_at_ms, 2_000);

        let by_short = session_record(&path, "session:048e4155").unwrap();
        assert_eq!(by_short, by_uuid);

        // Two sessions begin `63bcd0c2`, so the short id names neither.
        assert!(session_record(&path, "session:63bcd0c2").is_none());
        // Each is still found whole.
        assert_eq!(
            session_record(&path, &format!("session:{twin_b}"))
                .unwrap()
                .callsign
                .as_deref(),
            Some("curly-apple")
        );
        // Nothing answers for a stranger, another spelling, or another kind.
        assert!(session_record(&path, "session:ffffffff").is_none());
        assert!(session_record(&path, "session:demo/mighty-cabin").is_none());
        assert!(session_record(&path, "session:048e4155%").is_none());
        assert!(session_record(&path, &format!("commit:{one}")).is_none());
        // And a missing index is an empty answer.
        assert!(session_record(&temp.path().join("none.db"), "session:048e4155").is_none());
    }

    #[tokio::test]
    async fn a_describe_read_answers_arcs_from_the_projects_log() {
        let temp = repo();
        commit(temp.path(), "only", 1);
        let ctx = RecipeContext::for_project(temp.path());
        let sources = Sources {
            session_index: temp.path().join("none.db"),
            arc_log: temp.path().join("arc.log"),
            report_gaps: temp.path().join("none-gaps.db"),
            ..Sources::of(&ctx)
        };
        std::fs::write(
            &sources.arc_log,
            [
                log_line(
                    "2026-10-08T09:00:00.000Z",
                    "landed",
                    "arc-start",
                    "brief.md",
                ),
                log_line(
                    "2026-10-08T10:00:00.000Z",
                    "landed",
                    "7d16f2ac6",
                    "joined via card",
                ),
            ]
            .concat(),
        )
        .unwrap();
        let page: Vec<Member> = ["arc:landed", "arc:never", "session:048e4155"]
            .into_iter()
            .map(Member::of)
            .collect();
        let rows = describe(&sources, &page, None, &Selection::Head).await;
        let kinds: Vec<&str> = rows.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, ["arc", "arc", "session"]);
        let found: Vec<bool> = rows.iter().map(|r| r.found).collect();
        assert_eq!(found, [true, false, false]);
        let arc = rows[0].arc.as_ref().unwrap();
        assert_eq!((arc.name.as_str(), arc.fate), ("landed", "joined"));
        assert_eq!(arc.join_sha.as_deref(), Some("7d16f2ac6"));
        let wire = serde_json::to_value(&rows[1]).unwrap();
        assert!(wire.get("arc").is_none() && wire.get("session").is_none());
    }

    #[tokio::test]
    async fn a_member_with_facts_is_a_run_or_a_span_with_what_its_ref_names() {
        let temp = repo();
        let sha = commit(temp.path(), "stood on", 1);
        let ctx = RecipeContext::for_project(temp.path());
        let sources = Sources {
            session_index: temp.path().join("index.db"),
            report_gaps: temp.path().join("none-gaps.db"),
            ..Sources::of(&ctx)
        };
        let index = session_index::SessionIndex::open(&sources.session_index).unwrap();
        let session = "048e4155-f644-46f7-a839-d22ac02a564f";
        index
            .upsert(&index_entry(session, "mighty-cabin", Some("The cabin")))
            .unwrap();
        drop(index);

        let run = |head: &str, r#ref: Option<String>| {
            Member::fact(
                FactKind::Run,
                r#ref,
                json!({"status": "FAIL", "ended_at": 1_700_000_000, "secs": 7, "passed": 2,
                       "total": 3, "head_sha": head}),
            )
        };
        let span = |label: &str, r#ref: Option<String>| {
            Member::fact(
                FactKind::Span,
                r#ref,
                json!({"label": label, "start_ms": 1_000, "end_ms": 4_000, "status": "good"}),
            )
        };
        let page = [
            run(&sha, Some(format!("commit:{}", &sha[..8]))),
            run("unknown", None),
            span("Implement", Some("session:048e4155".to_string())),
            span("1/3 First", Some(format!("commit:{}", &sha[..8]))),
            span("Audit", None),
        ];
        let rows = describe(&sources, &page, None, &Selection::Head).await;
        let kinds: Vec<&str> = rows.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, ["run", "run", "span", "span", "span"]);
        assert!(rows.iter().all(|r| r.found));

        let on_a_commit = rows[0].run.as_ref().unwrap();
        assert_eq!(
            (
                on_a_commit.status.as_str(),
                on_a_commit.passed,
                on_a_commit.total
            ),
            ("FAIL", 2, 3)
        );
        assert_eq!(on_a_commit.commit.as_ref().unwrap().sha, sha);
        assert!(
            rows[0].commit.is_none(),
            "the commit is the run's, not the row's"
        );
        let on_nothing = rows[1].run.as_ref().unwrap();
        assert_eq!(on_nothing.head_sha, "unknown");
        assert!(on_nothing.commit.is_none());
        assert_eq!(rows[1].r#ref, None);

        let stage = &rows[2];
        assert_eq!(stage.span.as_ref().unwrap().label, "Implement");
        assert_eq!(stage.session.as_ref().unwrap().id, session);
        let step = &rows[3];
        assert_eq!(
            (
                step.span.as_ref().unwrap().start_ms,
                step.span.as_ref().unwrap().end_ms
            ),
            (1_000, 4_000)
        );
        assert_eq!(step.commit.as_ref().unwrap().sha, sha);
        assert!(rows[4].session.is_none() && rows[4].commit.is_none());
        assert_eq!(
            rows[4].span.as_ref().unwrap().status.as_deref(),
            Some("good")
        );
    }

    #[tokio::test]
    async fn a_path_read_pages_a_files_commits_newest_first_and_honours_a_window() {
        let temp = repo();
        for n in 0..3 {
            std::fs::write(temp.path().join("kept.txt"), format!("{n}\n")).unwrap();
            git(temp.path(), &["add", "-A"]);
            git(temp.path(), &["commit", "-m", &format!("kept {n}")]);
            commit(temp.path(), &format!("other{n} change"), 1);
        }

        let mut body = json!({"of": "file:kept.txt", "limit": 2});
        let first = report(request(temp.path(), body.clone())).await.unwrap();
        assert_eq!(first.total, 3, "the total is the path's, not the page's");
        let subjects: Vec<&str> = first
            .rows
            .iter()
            .map(|r| r.commit.as_ref().unwrap().subject.as_str())
            .collect();
        assert_eq!(subjects, ["kept 2", "kept 1"]);
        assert!(first.rows.iter().all(|r| r.kind == "commit" && r.found));
        assert_eq!(
            first.rows[0].r#ref.as_deref(),
            Some(format!("commit:{}", first.rows[0].commit.as_ref().unwrap().sha).as_str())
        );

        body["offset"] = json!(2);
        let second = report(request(temp.path(), body)).await.unwrap();
        assert_eq!(second.total, 3);
        assert_eq!(second.rows.len(), 1);
        assert_eq!(second.rows[0].commit.as_ref().unwrap().subject, "kept 0");

        // A source rides along only for its window.
        let within = report(request(
            temp.path(),
            json!({"of": "file:kept.txt", "source": {"recipe": "hot", "args": {"since": "2000-01-01"}}}),
        ))
        .await
        .unwrap();
        assert_eq!((within.total, within.rows.len()), (3, 3));
        let outside = report(request(
            temp.path(),
            json!({"of": "file:kept.txt", "source": {"recipe": "hot", "args": {"since": "2000-01-01", "until": "2000-01-02T00:00:00Z"}}}),
        ))
        .await
        .unwrap();
        assert_eq!((outside.total, outside.rows.len()), (0, 0));

        let never = report(request(temp.path(), json!({"of": "file:never.txt"})))
            .await
            .unwrap();
        assert_eq!((never.total, never.rows.len()), (0, 0));
    }

    /// Commit `files`, each written with `lines` lines, under `message`, and
    /// answer the new sha.
    fn commit_files(repo: &Path, message: &str, files: &[(&str, usize)]) -> String {
        for (path, lines) in files {
            let path = repo.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x\n".repeat(*lines)).unwrap();
        }
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", message]);
        git(repo, &["rev-parse", "HEAD"]).trim().to_string()
    }

    #[tokio::test]
    async fn a_hotspots_row_opens_its_files_with_their_pairs_and_commit_counts() {
        let temp = repo();
        commit_files(temp.path(), "one", &[("src/a.rs", 4), ("src/b.rs", 1)]);
        commit_files(temp.path(), "two", &[("src/a.rs", 6)]);
        let ctx = RecipeContext::for_project(temp.path());
        let args = RecipeArgs {
            depth: Some(1),
            ..Default::default()
        };
        let RecipeOutcome::Chart { spec, .. } = tugchart_core::catalog::find("hotspots")
            .unwrap()
            .run(&ctx, &args)
            .unwrap()
        else {
            panic!("hotspots drew nothing");
        };
        let labels: Vec<&str> = spec["categories"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let row = labels.iter().position(|l| *l == "src").unwrap();
        let page = report(request(temp.path(), members_body(&spec, row, "src")))
            .await
            .unwrap();
        let read: Vec<(&str, bool, Option<&str>, Option<u64>)> = page
            .rows
            .iter()
            .map(|r| {
                (
                    r.kind,
                    r.found,
                    r.measure_text.as_deref(),
                    r.path.as_ref().and_then(|p| p.commits),
                )
            })
            .collect();
        // Each file's commits are counted within the chart's window.
        assert_eq!(
            read,
            [
                ("file", true, Some("+6 −0"), Some(2)),
                ("file", true, Some("+1 −0"), Some(1)),
            ]
        );
        assert_eq!(page.sum_text.as_deref(), Some("+7 −0"));
    }

    #[tokio::test]
    async fn a_landed_range_reads_its_own_commits_and_refuses_a_range_not_of_shas() {
        let temp = repo();
        let base = commit_files(temp.path(), "base", &[("src/a.rs", 1)]);
        commit_files(temp.path(), "one", &[("src/a.rs", 2), ("src/b.rs", 1)]);
        let tip = commit_files(temp.path(), "two", &[("src/a.rs", 3)]);
        let ctx = RecipeContext::for_project(temp.path());
        let args = RecipeArgs {
            range: Some(format!("{base}..{tip}")),
            ..Default::default()
        };
        let RecipeOutcome::Chart { spec, .. } = tugchart_core::catalog::find("landed")
            .unwrap()
            .run(&ctx, &args)
            .unwrap()
        else {
            panic!("landed drew nothing");
        };
        let page = report(request(temp.path(), members_body(&spec, 0, "src")))
            .await
            .unwrap();
        // `src/a.rs` has three commits in all and two in the range.
        let counts: Vec<(Option<&str>, Option<u64>)> = page
            .rows
            .iter()
            .map(|r| (r.r#ref.as_deref(), r.path.as_ref().and_then(|p| p.commits)))
            .collect();
        assert_eq!(
            counts,
            [(Some("file:src/a.rs"), Some(2)), (Some("file:src/b.rs"), Some(1))]
        );

        // A path read under the range's source pages only its commits.
        let source = spec["source"].clone();
        let path = report(request(
            temp.path(),
            json!({"of": "file:src/a.rs", "source": source}),
        ))
        .await
        .unwrap();
        let subjects: Vec<&str> = path
            .rows
            .iter()
            .map(|r| r.commit.as_ref().unwrap().subject.as_str())
            .collect();
        assert_eq!((path.total, subjects), (2, vec!["two", "one"]));

        // A range whose end is not hex never reaches git.
        let refused = report(request(
            temp.path(),
            json!({"of": "file:src/a.rs", "source": {"recipe": "landed", "args": {"range": "HEAD~1..--output=x"}}}),
        ))
        .await;
        assert!(matches!(refused, Err(ReportError::BadRequest(_))));
    }

    #[tokio::test]
    async fn a_describe_read_answers_paths_urls_and_commands() {
        let temp = repo();
        commit(temp.path(), "kept change", 1);
        std::fs::create_dir(temp.path().join("sub")).unwrap();
        std::fs::write(temp.path().join("sub/inner.txt"), "x\n").unwrap();
        git(temp.path(), &["add", "-A"]);
        git(temp.path(), &["commit", "-m", "inner"]);
        git(temp.path(), &["commit", "--allow-empty", "-m", "nothing"]);

        let ctx = RecipeContext::for_project(temp.path());
        let sources = Sources {
            session_index: temp.path().join("none.db"),
            report_gaps: temp.path().join("gaps.db"),
            ..Sources::of(&ctx)
        };
        let gaps = ReportGaps::open(&sources.report_gaps).unwrap();
        for wall_ms in [30_000, 45_000] {
            gaps.record(&GapRow {
                head: "cargo build".to_string(),
                command: "cargo build --release".to_string(),
                project_dir: "/u/src/demo".to_string(),
                session_id: "s".to_string(),
                wall_ms,
                ended_at_ms: 1_000,
            })
            .unwrap();
        }
        drop(gaps);

        let page: Vec<Member> = [
            "file:kept.txt",
            "file:missing.txt",
            "dir:sub",
            "file:bad\npath",
            "url:https://www.example.com/a/b?q=1",
            "url:https://example.com/",
            "command:cargo build",
            "command:never ran",
        ]
        .into_iter()
        .map(Member::of)
        .collect();
        let rows = describe(&sources, &page, None, &Selection::Head).await;
        let found: Vec<bool> = rows.iter().map(|r| r.found).collect();
        assert_eq!(found, [true, true, true, false, true, true, true, true]);
        let kinds: Vec<&str> = rows.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            [
                "file", "file", "dir", "file", "url", "url", "command", "command"
            ]
        );

        let path = |i: usize| rows[i].path.clone().unwrap();
        assert_eq!(
            path(0),
            PathRecord {
                path: "kept.txt".to_string(),
                exists: true,
                commits: Some(1)
            }
        );
        assert_eq!((path(1).exists, path(1).commits), (false, Some(0)));
        assert_eq!((path(2).exists, path(2).commits), (true, Some(1)));
        // An absolute path is checked as given.
        let absolute = temp.path().join("kept.txt");
        let given = describe(
            &sources,
            &[Member::of(format!("file:{}", absolute.display()))],
            None,
            &Selection::Head,
        )
        .await;
        assert!(given[0].path.as_ref().unwrap().exists);
        // A window narrows the count and leaves the disk's answer alone.
        let earlier = Window {
            since: "2000-01-01".to_string(),
            until: Some("2000-01-02T00:00:00Z".to_string()),
        };
        let windowed = describe(&sources, &page[..1], None, &Selection::Window(earlier)).await;
        let record = windowed[0].path.as_ref().unwrap();
        assert_eq!((record.exists, record.commits), (true, Some(0)));

        let url = |i: usize| rows[i].url.clone().unwrap();
        assert_eq!(
            (url(4).host.as_str(), url(4).path.as_str()),
            ("example.com", "/a/b?q=1")
        );
        assert_eq!(
            (url(5).host.as_str(), url(5).path.as_str()),
            ("example.com", "")
        );

        assert_eq!(
            rows[6].command,
            Some(CommandRecord {
                head: "cargo build".to_string(),
                count: Some(2),
                total_ms: Some(75_000)
            })
        );
        assert_eq!(
            rows[7].command,
            Some(CommandRecord {
                head: "never ran".to_string(),
                count: None,
                total_ms: None
            })
        );
    }
}

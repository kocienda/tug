//! Reading a transcript into the blocks the index holds: each user text block,
//! assistant text block and tool result is its own source, because blocks are
//! append-only, so a growing turn adds sources and re-embeds nothing it already holds.
//!
//! The reader follows `turn_engine::segment_str`'s recipe rather than having one of
//! its own: the effective records are the chain walk's, and the turn count is the
//! engine's. Beside it the reader counts the number `session.transcript` gives the
//! same record, because a hit exists to be followed, and that verb's number is the one
//! that finds it. The two differ: the verb reads dead branches and opens no turn on an
//! orphan.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::watch;
use tokio::task::{JoinError, JoinHandle, spawn_blocking};
use tracing::{info, warn};
use tugcore::session_transcript::{keep_user_text, user_record_opens_turn, without_landings_block};
use tugsem_core::reduce_tool_result;

use super::coverage::SemanticCoverage;
use super::index::{SemanticError, SemanticIndex, TranscriptCursor};
use super::ingest::{EMBED_BATCH, Indexer, Ingested, Source, TRANSCRIPT_KIND};
use crate::dead_branch::{effective_indices, parse_chain_record, parse_chain_records};
use crate::external_sessions::{
    ChainWatch, Observed, decode_uuid_set, encode_uuid_set, fnv1a64, is_command_envelope,
    is_non_submission_user_string, parse_timestamp_millis, push_tail,
    scan_external_sessions_cached, try_resume, user_submission_opens_turn, uuid_key,
};
use crate::feeds::operator::is_tug_noise_project;
use crate::session_ledger::{SessionLedger, claude_project_dir};
use crate::turn_engine::{Frontier, parse_significant, step_record};

/// How much of a command labels its result.
const COMMAND_LABEL_BYTES: usize = 200;

/// What labels a result whose call lies before the read's start.
const UNKNOWN_TOOL_LABEL: &str = "tool";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BlockRole {
    User,
    Assistant,
    Tool,
}

impl BlockRole {
    fn name(self) -> &'static str {
        match self {
            BlockRole::User => "user",
            BlockRole::Assistant => "assistant",
            BlockRole::Tool => "tool",
        }
    }
}

/// One source's worth of a transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Block {
    pub uuid: String,
    /// Its place in its record's content.
    pub index: usize,
    pub role: BlockRole,
    /// The number `session.transcript` gives its turn. 0 ahead of any user turn, which
    /// that verb cannot show.
    pub turn: usize,
    pub at_ms: Option<i64>,
    pub text: String,
    /// What a tool result came from.
    pub label: Option<String>,
}

impl Block {
    fn source_id(&self, session: &str) -> String {
        format!("{session}/{}.{}", self.uuid, self.index)
    }

    fn context(&self, callsign: &str) -> String {
        format!("{callsign} turn {} {}", self.turn, self.role.name())
    }

    fn meta(&self) -> String {
        serde_json::json!({
            "turn": self.turn,
            "role": self.role.name(),
            "at_ms": self.at_ms,
        })
        .to_string()
    }
}

/// A transcript read whole.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct TranscriptBlocks {
    pub blocks: Vec<Block>,
    /// The engine's canonical count, which is `segment_str`'s.
    pub turn_count: usize,
    /// The number of the last turn `session.transcript` shows.
    pub shown_turn: usize,
    pub frontier: Frontier,
    /// The effective chain uuids, as a cursor holds them.
    pub effective_uuids: Vec<u8>,
}

/// Turns records into blocks, keeping the two things a block needs from the records
/// before it.
#[derive(Default)]
struct RecordReader {
    blocks: Vec<Block>,
    shown_turn: usize,
    labels: HashMap<String, String>,
}

impl RecordReader {
    /// Take in what any record says, effective or not: `session.transcript` numbers
    /// its turns over the raw file, and a call may label a result later on.
    fn note(&mut self, record: &Value) {
        if is_sidechain(record) {
            return;
        }
        match record.get("type").and_then(Value::as_str) {
            Some("user") if user_record_opens_turn(record) => self.shown_turn += 1,
            Some("assistant") => note_tool_labels(record, &mut self.labels),
            _ => {}
        }
    }

    /// Yield an effective record's blocks.
    fn take(&mut self, record: &Value) {
        if is_sidechain(record) {
            return;
        }
        let Some(uuid) = record
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|uuid| !uuid.is_empty())
        else {
            return;
        };
        let at_ms = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_millis);
        let found = match record.get("type").and_then(Value::as_str) {
            Some("user") => user_blocks(record, &self.labels),
            Some("assistant") => assistant_blocks(record),
            _ => Vec::new(),
        };
        for (index, role, text, label) in found {
            let text = text.trim().to_string();
            if !text.is_empty() {
                self.blocks.push(Block {
                    uuid: uuid.to_string(),
                    index,
                    role,
                    turn: self.shown_turn,
                    at_ms,
                    text,
                    label,
                });
            }
        }
    }
}

fn is_sidechain(record: &Value) -> bool {
    record.get("isSidechain").and_then(Value::as_bool) == Some(true)
}

/// Read a whole transcript. Thinking is never read, and a tool call is not a block: it
/// only says what its result is from.
pub(super) fn read_blocks(jsonl: &str) -> TranscriptBlocks {
    let chain = parse_chain_records(jsonl);
    let in_order = effective_indices(&chain);
    let effective: HashSet<usize> = in_order.iter().copied().collect();
    let mut reader = RecordReader::default();
    let mut frontier = Frontier::default();
    let mut turn_count = 0;

    for (at, line) in jsonl.lines().enumerate() {
        // A line that is not JSON is nothing to the chain walk or to the engine either.
        let Ok(record) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        reader.note(&record);
        if !effective.contains(&at) {
            continue;
        }
        if let Some(significant) = parse_significant(line)
            && step_record(&mut frontier, &significant).is_some()
        {
            turn_count += 1;
        }
        reader.take(&record);
    }

    frontier.leaf_uuid = chain
        .iter()
        .rev()
        .flatten()
        .filter(|record| !record.is_sidechain)
        .find_map(|record| record.uuid.clone());
    let uuids: HashSet<[u8; 16]> = in_order
        .iter()
        .filter_map(|at| chain[*at].as_ref())
        .filter(|record| !record.is_sidechain)
        .filter_map(|record| record.uuid.as_deref())
        .map(uuid_key)
        .collect();
    TranscriptBlocks {
        blocks: reader.blocks,
        turn_count,
        shown_turn: reader.shown_turn,
        frontier,
        effective_uuids: encode_uuid_set(&uuids),
    }
}

/// A read of a file: its new blocks, and where the next read starts.
pub(super) struct ReadPass {
    pub blocks: Vec<Block>,
    pub cursor: TranscriptCursor,
    /// Whether `blocks` is everything the file now holds, so that a source outside it
    /// is one a rewind left behind.
    pub whole: bool,
}

/// Read a whole file up to its last terminated line. An unterminated line is a write
/// in progress, and the next read picks it up.
pub(super) fn read_full(session: &str, path: &Path) -> std::io::Result<ReadPass> {
    let bytes = std::fs::read(path)?;
    let end = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |at| at + 1);
    let terminated = &bytes[..end];
    let read = read_blocks(&String::from_utf8_lossy(terminated));
    let mut window = Vec::new();
    push_tail(&mut window, terminated);
    Ok(ReadPass {
        blocks: read.blocks,
        cursor: TranscriptCursor {
            session_id: session.to_string(),
            path: path.to_string_lossy().into_owned(),
            offset: end as i64,
            tail_hash: fnv1a64(&window) as i64,
            turn_count: read.turn_count as i64,
            shown_turn: read.shown_turn as i64,
            open: read.frontier.open,
            pending_close: read.frontier.pending_close,
            pending_close_msg_id: read.frontier.pending_close_msg_id,
            leaf_uuid: read.frontier.leaf_uuid,
            effective_uuids: Some(read.effective_uuids),
        },
        whole: true,
    })
}

/// Read what was appended since `cursor`, or `None` when only a full pass can say what
/// the file now holds: its prefix was rewritten, or what was appended can change which
/// earlier records are effective.
pub(super) fn read_appended(
    path: &Path,
    cursor: &TranscriptCursor,
) -> std::io::Result<Option<ReadPass>> {
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len() as i64;
    let Some(mut window) = try_resume(&mut file, cursor.offset, cursor.tail_hash, size)? else {
        return Ok(None);
    };
    let Some(effective) = cursor.effective_uuids.as_deref().and_then(decode_uuid_set) else {
        return Ok(None);
    };
    let mut watch = ChainWatch::resumed(effective, cursor.leaf_uuid.as_deref());
    let mut frontier = Frontier {
        open: cursor.open,
        pending_close: cursor.pending_close,
        pending_close_msg_id: cursor.pending_close_msg_id.clone(),
        leaf_uuid: cursor.leaf_uuid.clone(),
    };
    let mut reader = RecordReader {
        shown_turn: cursor.shown_turn as usize,
        ..RecordReader::default()
    };
    let mut offset = cursor.offset;
    let mut turn_count = cursor.turn_count;
    let mut stream = BufReader::new(file);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        if stream.read_until(b'\n', &mut bytes)? == 0 || bytes.last() != Some(&b'\n') {
            break;
        }
        offset += bytes.len() as i64;
        push_tail(&mut window, &bytes);
        let line = String::from_utf8_lossy(&bytes);
        let line = line.trim();
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let observed =
            parse_chain_record(line).map(|chain| watch.observe(&chain, &mut frontier.leaf_uuid));
        if observed == Some(Observed::NeedsFullRecount) {
            return Ok(None);
        }
        reader.note(&record);
        if observed == Some(Observed::Absorbed) {
            if let Some(significant) = parse_significant(line)
                && step_record(&mut frontier, &significant).is_some()
            {
                turn_count += 1;
            }
            reader.take(&record);
        }
    }
    Ok(Some(ReadPass {
        blocks: reader.blocks,
        cursor: TranscriptCursor {
            session_id: cursor.session_id.clone(),
            path: path.to_string_lossy().into_owned(),
            offset,
            tail_hash: fnv1a64(&window) as i64,
            turn_count,
            shown_turn: reader.shown_turn as i64,
            open: frontier.open,
            pending_close: frontier.pending_close,
            pending_close_msg_id: frontier.pending_close_msg_id,
            leaf_uuid: frontier.leaf_uuid,
            effective_uuids: Some(encode_uuid_set(&watch.effective_seen)),
        },
        whole: false,
    }))
}

fn assistant_blocks(record: &Value) -> Vec<(usize, BlockRole, String, Option<String>)> {
    let content = record.get("message").and_then(|m| m.get("content"));
    content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter(|(_, block)| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|(index, block)| {
            let text = block.get("text").and_then(Value::as_str)?;
            Some((index, BlockRole::Assistant, text.to_string(), None))
        })
        .collect()
}

/// What a user record contributes. Claude's meta and summary records, wakes, slash
/// command envelopes and Tug's own plumbing contribute no words, though a record of any
/// of those may still carry a tool's answer.
fn user_blocks(
    record: &Value,
    labels: &HashMap<String, String>,
) -> Vec<(usize, BlockRole, String, Option<String>)> {
    let flag = |name: &str| record.get(name).and_then(Value::as_bool) == Some(true);
    let Some(content) = record.get("message").and_then(|m| m.get("content")) else {
        return Vec::new();
    };
    let (opens, _) = user_submission_opens_turn(
        flag("isMeta"),
        flag("isCompactSummary"),
        record.get("permissionMode").is_some(),
        content,
    );
    let speaks = opens && !flag("isCompactSummary");
    let words = |raw: &str| {
        let trimmed = raw.trim_start();
        if !speaks || is_command_envelope(trimmed) || is_non_submission_user_string(false, raw) {
            return None;
        }
        Some(keep_user_text(without_landings_block(raw)))
    };
    let mut out = Vec::new();
    match content {
        Value::String(raw) => {
            if let Some(text) = words(raw) {
                out.push((0, BlockRole::User, text, None));
            }
        }
        Value::Array(blocks) => {
            for (index, block) in blocks.iter().enumerate() {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let raw = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if let Some(text) = words(raw) {
                            out.push((index, BlockRole::User, text, None));
                        }
                    }
                    Some("tool_result") => {
                        let label = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .and_then(|id| labels.get(id))
                            .map_or(UNKNOWN_TOOL_LABEL, String::as_str);
                        out.push((
                            index,
                            BlockRole::Tool,
                            tool_result_text(block),
                            Some(label.to_string()),
                        ));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    out
}

/// Remember what each of a record's tool calls will label its result with.
fn note_tool_labels(record: &Value, labels: &mut HashMap<String, String>) {
    let content = record.get("message").and_then(|m| m.get("content"));
    for block in content.and_then(Value::as_array).into_iter().flatten() {
        if block.get("type").and_then(Value::as_str) == Some("tool_use")
            && let Some(id) = block.get("id").and_then(Value::as_str)
        {
            labels.insert(id.to_string(), tool_label(block));
        }
    }
}

/// The command of a `Bash` call, the path of a file tool, otherwise the tool's name.
fn tool_label(block: &Value) -> String {
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(UNKNOWN_TOOL_LABEL);
    let input = block.get("input");
    let of = |key: &str| {
        input
            .and_then(|input| input.get(key))
            .and_then(Value::as_str)
    };
    if name == "Bash"
        && let Some(command) = of("command")
    {
        let flat = command.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut end = flat.len().min(COMMAND_LABEL_BYTES);
        while !flat.is_char_boundary(end) {
            end -= 1;
        }
        return flat[..end].to_string();
    }
    of("file_path").unwrap_or(name).to_string()
}

/// A result's content is its text, or a list of blocks some of which are text.
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Put one block into the index, answering what became of it and how many passages
/// that made.
pub(super) async fn ingest_block(
    indexer: &Indexer,
    session: &str,
    callsign: &str,
    block: &Block,
) -> Result<(Ingested, usize), SemanticError> {
    let reduced = block
        .label
        .as_deref()
        .map(|label| reduce_tool_result(label, &block.text));
    indexer
        .ingest_counted(&Source {
            kind: TRANSCRIPT_KIND,
            id: &block.source_id(session),
            context: &block.context(callsign),
            text: reduced
                .as_ref()
                .map_or(block.text.as_str(), |reduced| reduced.embedded.as_str()),
            session: Some(session),
            meta: Some(&block.meta()),
            lexical: reduced.as_ref().and_then(|reduced| reduced.lexical),
        })
        .await
}

/// Take a session's transcript out of the index. Its facts and posts stay: those rows
/// outlive a transcript.
fn forget_transcript(index: &SemanticIndex, session: &str) -> Result<(), SemanticError> {
    let ids = index.session_source_ids(TRANSCRIPT_KIND, session)?;
    index.remove_sources(TRANSCRIPT_KIND, &ids)?;
    index.delete_cursor(session)
}

/// A session waiting in the queue, and what is left of its one read of the file.
struct SessionJob {
    session: String,
    path: PathBuf,
    callsign: String,
    pass: Option<JobPass>,
}

struct JobPass {
    blocks: VecDeque<Block>,
    /// With a whole read, what the session's sources should be when the job is done.
    keep: Option<HashSet<String>>,
    cursor: TranscriptCursor,
}

/// A session a scan listed.
struct ListedSession {
    session: String,
    path: PathBuf,
    callsign: String,
    /// Whether a cursor already says all of it has been read.
    done: bool,
}

/// What a scan walked and what it found there, oldest session first.
#[derive(Default)]
pub(super) struct Listing {
    sessions: Vec<(ListedSession, i64)>,
    /// The projects read, which the next listing reads too: a scan can prune the last
    /// trace of a project whose transcripts have gone.
    projects: Vec<String>,
    /// The Claude project dirs that exist.
    walked: HashSet<PathBuf>,
}

fn session_file(sessions: &SessionLedger, project: &str, session: &str) -> PathBuf {
    claude_project_dir(sessions.claude_home(), project)
        .0
        .join(format!("{session}.jsonl"))
}

fn short_callsign(session: &str) -> String {
    session.chars().take(8).collect()
}

/// List the sessions of every project of the ledger and of `also`, oldest first, once
/// each: the ledger can hold two spellings of one directory, and the scan resolves them
/// to the same files.
fn list_sessions(sessions: &SessionLedger, also: &[String]) -> Listing {
    let mut projects = sessions.project_dirs().unwrap_or_else(|err| {
        warn!("semantic index: could not list projects: {err}");
        Vec::new()
    });
    for project in also {
        if !projects.contains(project) {
            projects.push(project.clone());
        }
    }
    projects.retain(|project| !is_tug_noise_project(project));

    let mut listing = Listing::default();
    let mut seen = HashSet::new();
    for project in &projects {
        let outcome = scan_external_sessions_cached(sessions, project);
        let canonical = outcome.canonical_project_dir;
        let dir = claude_project_dir(sessions.claude_home(), &canonical).0;
        if dir.is_dir() {
            listing.walked.insert(dir);
        }
        for meta in outcome.metas {
            if seen.insert(meta.session_id.clone()) {
                let callsign = meta.tag.unwrap_or_else(|| short_callsign(&meta.session_id));
                listing.sessions.push((
                    ListedSession {
                        path: session_file(sessions, &canonical, &meta.session_id),
                        session: meta.session_id,
                        callsign,
                        done: false,
                    },
                    meta.file_mtime,
                ));
            }
        }
    }
    listing.sessions.sort_by_key(|(_, mtime)| *mtime);
    listing.projects = projects;
    listing
}

/// Remove what the listing no longer holds. The listing is the authority rather than
/// the file: the scan drops a rotated ancestor whose file is still on disk, because its
/// records live on under its descendant's id, and keeping it would hold each block
/// twice. Only a project dir that exists can say a session is gone, so that an
/// unreadable home removes nothing.
fn reconcile(sessions: &SessionLedger, index: &SemanticIndex, also: &[String]) -> Vec<String> {
    let listing = list_sessions(sessions, also);
    let listed: HashSet<&str> = listing
        .sessions
        .iter()
        .map(|(listed, _)| listed.session.as_str())
        .collect();
    let mut removed = Vec::new();
    let cursors = index.cursor_paths().unwrap_or_else(|err| {
        warn!("semantic index: could not list cursors: {err}");
        Vec::new()
    });
    for (session, path) in cursors {
        let walked = Path::new(&path)
            .parent()
            .is_some_and(|dir| listing.walked.contains(dir));
        if walked && !listed.contains(session.as_str()) {
            match forget_transcript(index, &session) {
                Ok(()) => removed.push(session),
                Err(err) => warn!("semantic index: {err}"),
            }
        }
    }
    removed
}

/// What came back from work done off the worker's thread.
pub(super) enum Loaded {
    Listing(Listing),
    Reconciled(Vec<String>),
    Read {
        session: String,
        read: std::io::Result<ReadPass>,
    },
}

/// The transcripts the worker has yet to read: a queue of sessions, live ones at the
/// front, each advanced a batch at a time. The slow reads, of the scan and of a whole
/// file, happen off the worker's thread, so a turn that ends meanwhile is not kept
/// waiting by them.
pub(super) struct CatchUp {
    queue: VecDeque<SessionJob>,
    loading: Option<JoinHandle<Loaded>>,
    scan_owed: bool,
    scanning: bool,
    reconcile_owed: bool,
    projects: Vec<String>,
    counted: HashSet<String>,
    coverage: watch::Sender<SemanticCoverage>,
    logged_percent: Option<usize>,
    /// Projects to list beside the ledger's own.
    also: Vec<String>,
}

impl CatchUp {
    /// `walk_history` is whether to read what is already on disk. Live sessions pass
    /// through the queue either way.
    pub(super) fn new(walk_history: bool, coverage: watch::Sender<SemanticCoverage>) -> Self {
        Self {
            queue: VecDeque::new(),
            loading: None,
            scan_owed: walk_history,
            scanning: walk_history,
            reconcile_owed: false,
            projects: Vec::new(),
            counted: HashSet::new(),
            coverage,
            logged_percent: None,
            also: Vec::new(),
        }
    }

    /// List `project` too, for a ledger that does not know it yet.
    pub(super) fn also_listing(&mut self, project: &str) {
        self.also.push(project.to_string());
    }

    /// Whether a unit is owed. While a read is out, nothing else here can move.
    pub(super) fn owed(&self) -> bool {
        self.loading.is_none() && (self.scan_owed || self.reconcile_owed || !self.queue.is_empty())
    }

    pub(super) fn is_loading(&self) -> bool {
        self.loading.is_some()
    }

    /// Wait for what is off the worker's thread. Dropped and called again, it waits on.
    pub(super) async fn loaded(&mut self) -> Result<Loaded, JoinError> {
        match self.loading.as_mut() {
            Some(handle) => handle.await,
            None => std::future::pending().await,
        }
    }

    /// Say how far the catch-up has come.
    pub(super) fn publish(&mut self, indexer: &Indexer) {
        let total = self.counted.len();
        let coverage = SemanticCoverage {
            transcripts_done: total.saturating_sub(self.queue.len()),
            transcripts_total: total,
            catching_up: self.scanning || !self.queue.is_empty(),
            model_live: indexer.embedder.live_model().is_some(),
        };
        let percent = coverage.percent();
        if total > 0 && self.logged_percent != Some(percent) {
            self.logged_percent = Some(percent);
            info!("{}", coverage.sentence());
        }
        self.coverage.send_replace(coverage);
    }

    fn enqueue_front(&mut self, session: &str, path: PathBuf, callsign: String) {
        self.counted.insert(session.to_string());
        let job = match self.queue.iter().position(|job| job.session == session) {
            Some(at) => self.queue.remove(at),
            None => None,
        };
        self.queue.push_front(job.unwrap_or(SessionJob {
            session: session.to_string(),
            path,
            callsign,
            pass: None,
        }));
    }

    /// Bring in what came back from off the worker's thread.
    pub(super) fn apply(&mut self, indexer: &Indexer, loaded: Result<Loaded, JoinError>) {
        self.loading = None;
        match loaded {
            Ok(Loaded::Listing(listing)) => {
                for (listed, _) in listing.sessions {
                    self.counted.insert(listed.session.clone());
                    if !listed.done && !self.queue.iter().any(|job| job.session == listed.session) {
                        self.queue.push_back(SessionJob {
                            session: listed.session,
                            path: listed.path,
                            callsign: listed.callsign,
                            pass: None,
                        });
                    }
                }
                self.projects = listing.projects;
                self.scanning = false;
                self.reconcile_owed = true;
            }
            Ok(Loaded::Reconciled(removed)) => {
                for session in removed {
                    self.counted.remove(&session);
                }
            }
            Ok(Loaded::Read { session, read }) => {
                let at = self.queue.iter().position(|job| job.session == session);
                match (read, at) {
                    (Ok(pass), Some(at)) => {
                        let keep = pass.whole.then(|| {
                            pass.blocks
                                .iter()
                                .map(|block| block.source_id(&session))
                                .collect()
                        });
                        self.queue[at].pass = Some(JobPass {
                            blocks: pass.blocks.into(),
                            keep,
                            cursor: pass.cursor,
                        });
                    }
                    (Err(err), Some(at)) => {
                        warn!("semantic index: could not read {session}: {err}");
                        self.queue.remove(at);
                    }
                    (_, None) => {}
                }
            }
            Err(err) => warn!("semantic index: {err}"),
        }
        self.publish(indexer);
    }

    /// Do the next thing owed, as one unit.
    pub(super) async fn run_unit(&mut self, indexer: &Indexer) {
        let Some(sessions) = indexer.sessions.clone() else {
            self.scan_owed = false;
            self.scanning = false;
            self.reconcile_owed = false;
            self.queue.clear();
            self.publish(indexer);
            return;
        };
        if self.scan_owed {
            self.scan_owed = false;
            let index = Arc::clone(&indexer.index);
            let also = self.also.clone();
            self.loading = Some(spawn_blocking(move || {
                let mut listing = list_sessions(&sessions, &also);
                for (listed, _) in &mut listing.sessions {
                    let size = std::fs::metadata(&listed.path).map(|file| file.len() as i64);
                    let cursor = index.cursor(&listed.session).ok().flatten();
                    listed.done = cursor
                        .zip(size.ok())
                        .is_some_and(|(c, size)| c.offset == size);
                }
                Loaded::Listing(listing)
            }));
            return;
        }
        if self.queue.is_empty() {
            if self.reconcile_owed {
                self.reconcile_owed = false;
                let index = Arc::clone(&indexer.index);
                let projects = self.projects.clone();
                self.loading = Some(spawn_blocking(move || {
                    Loaded::Reconciled(reconcile(&sessions, &index, &projects))
                }));
            }
            return;
        }
        if self.queue[0].pass.is_none() {
            self.begin_front(indexer);
            return;
        }
        let finished = self.advance_front(indexer).await.unwrap_or_else(|err| {
            warn!("semantic index: {err}");
            true
        });
        if finished {
            self.queue.pop_front();
            self.publish(indexer);
        }
    }

    /// Start the job at the front. A private session's file is not read at all.
    fn begin_front(&mut self, indexer: &Indexer) {
        let job = &self.queue[0];
        let session = job.session.clone();
        let path = job.path.clone();
        if !indexer.may_index(&session) {
            self.queue.pop_front();
            self.publish(indexer);
            return;
        }
        if !path.exists() {
            if let Err(err) = forget_transcript(&indexer.index, &session) {
                warn!("semantic index: {err}");
            }
            self.queue.pop_front();
            self.publish(indexer);
            return;
        }
        let cursor = indexer.index.cursor(&session).unwrap_or_else(|err| {
            warn!("semantic index: {err}");
            None
        });
        self.loading = Some(spawn_blocking(move || {
            let read = match cursor.map(|cursor| read_appended(&path, &cursor)) {
                Some(Ok(Some(pass))) => Ok(pass),
                Some(Err(err)) => Err(err),
                Some(Ok(None)) | None => read_full(&session, &path),
            };
            Loaded::Read { session, read }
        }));
    }

    /// Embed one batch of the job at the front, answering whether the job is over. A
    /// file gone mid-job is a session trashed, and a trashed session reads as public
    /// because its row is gone, so a job that carried on would put back what the trash
    /// just took out.
    async fn advance_front(&mut self, indexer: &Indexer) -> Result<bool, SemanticError> {
        let job = &mut self.queue[0];
        if !job.path.exists() {
            forget_transcript(&indexer.index, &job.session)?;
            return Ok(true);
        }
        let Some(pass) = job.pass.as_mut() else {
            return Ok(true);
        };
        let mut embedded = 0;
        while embedded < EMBED_BATCH {
            let Some(block) = pass.blocks.pop_front() else {
                break;
            };
            let (outcome, passages) =
                ingest_block(indexer, &job.session, &job.callsign, &block).await?;
            if outcome == Ingested::Refused {
                return Ok(true);
            }
            embedded += passages;
        }
        if !pass.blocks.is_empty() {
            return Ok(false);
        }
        if let Some(keep) = pass.keep.as_ref() {
            let held = indexer
                .index
                .session_source_ids(TRANSCRIPT_KIND, &job.session)?;
            let gone: Vec<String> = held.into_iter().filter(|id| !keep.contains(id)).collect();
            indexer.index.remove_sources(TRANSCRIPT_KIND, &gone)?;
        }
        indexer.index.set_cursor(&pass.cursor)?;
        Ok(true)
    }

    /// A turn ended somewhere. Read what the live sessions have added since the last
    /// look, and send one with no cursor, or that needs a full pass, to the front of the
    /// queue, so that a long session's first tick or a rewind does not run whole here.
    pub(super) async fn live_pass(&mut self, indexer: &Indexer) {
        let Some(sessions) = indexer.sessions.clone() else {
            return;
        };
        let rows = sessions.live_session_rows().unwrap_or_else(|err| {
            warn!("semantic index: could not list live sessions: {err}");
            Vec::new()
        });
        for (session, project, tag) in rows {
            if is_tug_noise_project(&project) || !indexer.may_index(&session) {
                continue;
            }
            let path = session_file(&sessions, &project, &session);
            let Ok(size) = std::fs::metadata(&path).map(|file| file.len() as i64) else {
                continue;
            };
            let callsign = tag.unwrap_or_else(|| short_callsign(&session));
            if self.queue.iter().any(|job| job.session == session) {
                self.enqueue_front(&session, path, callsign);
                continue;
            }
            let cursor = indexer.index.cursor(&session).unwrap_or_else(|err| {
                warn!("semantic index: {err}");
                None
            });
            let Some(cursor) = cursor else {
                self.enqueue_front(&session, path, callsign);
                continue;
            };
            if cursor.offset == size {
                continue;
            }
            let read = {
                let path = path.clone();
                spawn_blocking(move || read_appended(&path, &cursor)).await
            };
            match read {
                Ok(Ok(Some(pass))) => {
                    if let Err(err) = ingest_appended(indexer, &session, &callsign, pass).await {
                        warn!("semantic index: {err}");
                    }
                }
                Ok(Ok(None)) => self.enqueue_front(&session, path, callsign),
                Ok(Err(err)) => warn!("semantic index: could not read {session}: {err}"),
                Err(err) => warn!("semantic index: {err}"),
            }
        }
        self.publish(indexer);
    }
}

/// Put what was appended to a session into the index, and only then move its cursor.
async fn ingest_appended(
    indexer: &Indexer,
    session: &str,
    callsign: &str,
    pass: ReadPass,
) -> Result<(), SemanticError> {
    for block in &pass.blocks {
        let (outcome, _) = ingest_block(indexer, session, callsign, block).await?;
        if outcome == Ingested::Refused {
            return Ok(());
        }
    }
    indexer.index.set_cursor(&pass.cursor)
}

#[cfg(test)]
mod tests {
    use super::super::coverage::coverage_channel;
    use super::super::embedder::compiled;
    use super::super::embedder::fake::{FakeState, client};
    use super::super::index::SemanticIndex;
    use super::super::ingest::{IndexStreams, run_index};
    use super::super::search::SemanticSearch;
    use super::*;
    use crate::turn_engine::segment_str;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;
    use tugcore::claude_home::ClaudeHome;
    use tugcore::session_transcript::{LANDINGS_HEADING, LANDINGS_MARKER, read_str};

    fn user(uuid: &str, parent: Option<&str>, text: &str) -> String {
        json!({
            "type": "user", "uuid": uuid, "parentUuid": parent, "permissionMode": "default",
            "timestamp": "2026-10-01T10:00:00.000Z",
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    fn user_content(uuid: &str, parent: Option<&str>, content: Value) -> String {
        json!({
            "type": "user", "uuid": uuid, "parentUuid": parent, "permissionMode": "default",
            "message": { "role": "user", "content": content },
        })
        .to_string()
    }

    fn assistant(uuid: &str, parent: Option<&str>, content: Value) -> String {
        json!({
            "type": "assistant", "uuid": uuid, "parentUuid": parent,
            "timestamp": "2026-10-01T10:00:01.000Z",
            "message": {
                "id": format!("msg-{uuid}"), "role": "assistant", "content": content,
                "stop_reason": "end_turn",
            },
        })
        .to_string()
    }

    fn says(text: &str) -> Value {
        json!([{ "type": "text", "text": text }])
    }

    fn texts(read: &TranscriptBlocks) -> Vec<&str> {
        read.blocks
            .iter()
            .map(|block| block.text.as_str())
            .collect()
    }

    fn linear() -> String {
        [
            user("u1", None, "first question"),
            assistant("a1", Some("u1"), says("first answer")),
            user("u2", Some("a1"), "second question"),
            assistant("a2", Some("u2"), says("second answer")),
        ]
        .join("\n")
    }

    fn wake() -> String {
        [
            user("u1", None, "first question"),
            assistant("a1", Some("u1"), says("first answer")),
            user(
                "w1",
                Some("a1"),
                "<task-notification>job ended</task-notification>",
            ),
            assistant("a2", Some("w1"), says("the job ended")),
        ]
        .join("\n")
    }

    fn orphan() -> String {
        [
            assistant("a0", None, says("ahead of any user")),
            user("u1", Some("a0"), "a question"),
            assistant("a1", Some("u1"), says("an answer")),
        ]
        .join("\n")
    }

    fn rewind() -> String {
        [
            user("u1", None, "keep this question"),
            assistant("a1", Some("u1"), says("keep this answer")),
            user("u2", Some("a1"), "abandoned question"),
            assistant("a2", Some("u2"), says("abandoned answer")),
            user("u3", Some("a1"), "the question instead"),
            assistant("a3", Some("u3"), says("the answer instead")),
        ]
        .join("\n")
    }

    fn compaction() -> String {
        [
            user("u1", None, "before the compaction"),
            assistant("a1", Some("u1"), says("old answer")),
            json!({ "type": "system", "subtype": "compact_boundary", "uuid": "b1", "parentUuid": null })
                .to_string(),
            json!({
                "type": "user", "uuid": "s1", "parentUuid": "b1", "isCompactSummary": true,
                "message": { "role": "user", "content": "the summary of it all" },
            })
            .to_string(),
            // Re-appended preserved content, which is a duplicate and no new block.
            user("u1", Some("s1"), "before the compaction"),
            assistant("a1", Some("u1"), says("old answer")),
            user("u2", Some("a1"), "after the compaction"),
            assistant("a2", Some("u2"), says("new answer")),
        ]
        .join("\n")
    }

    fn fixture_dir() -> PathBuf {
        compiled::checkout_root().join("tests/operator-eval/history")
    }

    fn fixture_transcripts() -> Vec<(String, String)> {
        let dir = fixture_dir().join("transcripts");
        let mut all: Vec<(String, String)> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                let session = path.file_stem().unwrap().to_str().unwrap().to_string();
                let text = std::fs::read_to_string(&path)
                    .unwrap()
                    .replace("{{PROJECT}}", "/tmp/harbor");
                (session, text)
            })
            .collect();
        all.sort();
        assert_eq!(all.len(), 4);
        all
    }

    fn every_shape() -> Vec<String> {
        let mut shapes = vec![linear(), wake(), orphan(), rewind(), compaction()];
        shapes.extend(fixture_transcripts().into_iter().map(|(_, text)| text));
        shapes
    }

    #[test]
    fn the_turn_count_is_the_engines() {
        for shape in every_shape() {
            assert_eq!(
                read_blocks(&shape).turn_count,
                segment_str(&shape).turns.len(),
                "{shape}"
            );
        }
    }

    #[test]
    fn a_blocks_turn_in_session_transcript_holds_its_text() {
        for shape in every_shape() {
            let turns = read_str(&shape).turns;
            for block in read_blocks(&shape).blocks {
                if block.role == BlockRole::Tool || block.turn == 0 {
                    continue;
                }
                let turn = turns
                    .iter()
                    .find(|turn| turn.number == block.turn)
                    .unwrap_or_else(|| panic!("no turn {}", block.turn));
                assert!(
                    turn.user.contains(&block.text)
                        || turn.assistant.iter().any(|line| line.contains(&block.text)),
                    "turn {} does not hold {:?}",
                    block.turn,
                    block.text
                );
            }
        }
    }

    #[test]
    fn an_assistant_block_ahead_of_any_user_is_turn_zero() {
        let read = read_blocks(&orphan());
        assert_eq!(read.blocks[0].text, "ahead of any user");
        assert_eq!(read.blocks[0].turn, 0);
        assert_eq!(read.blocks[1].turn, 1);
    }

    #[test]
    fn a_dead_branch_has_no_blocks_and_still_counts_in_the_shown_number() {
        let read = read_blocks(&rewind());
        assert_eq!(
            texts(&read),
            [
                "keep this question",
                "keep this answer",
                "the question instead",
                "the answer instead"
            ]
        );
        // `session.transcript` reads the dead branch, so what follows it is its turn 3.
        assert_eq!(read.blocks[2].turn, 3);
        assert_eq!(read.shown_turn, 3);
    }

    #[test]
    fn a_compaction_holds_one_copy_and_no_summary() {
        let read = read_blocks(&compaction());
        assert_eq!(
            texts(&read),
            [
                "before the compaction",
                "old answer",
                "after the compaction",
                "new answer"
            ]
        );
    }

    #[test]
    fn what_is_not_a_conversation_makes_no_block() {
        let landings = format!("{LANDINGS_MARKER}\n{LANDINGS_HEADING}\n- committed abc");
        let jsonl = [
            user(
                "w1",
                None,
                "<task-notification>job ended</task-notification>",
            ),
            json!({
                "type": "user", "uuid": "m1", "parentUuid": "w1", "isMeta": true,
                "message": { "role": "user", "content": "a caveat claude wrote" },
            })
            .to_string(),
            user(
                "c1",
                Some("m1"),
                "<command-name>/clear</command-name><command-args></command-args>",
            ),
            user(
                "l1",
                Some("c1"),
                "<local-command-stdout>done</local-command-stdout>",
            ),
            user_content(
                "u1",
                Some("l1"),
                json!([
                    { "type": "text", "text": "what I asked" },
                    { "type": "text", "text": "<!-- tug:session-refs -->\nSession references" },
                    { "type": "text", "text": landings },
                ]),
            ),
            assistant(
                "a1",
                Some("u1"),
                json!([
                    { "type": "thinking", "thinking": "private reasoning" },
                    { "type": "text", "text": "what I said" },
                ]),
            ),
            json!({
                "type": "assistant", "uuid": "side", "parentUuid": "a1", "isSidechain": true,
                "message": { "role": "assistant", "content": says("a subagent") },
            })
            .to_string(),
        ]
        .join("\n");
        let read = read_blocks(&jsonl);
        assert_eq!(texts(&read), ["what I asked", "what I said"]);
        assert_eq!(read.blocks[0].index, 0);
        assert_eq!(read.blocks[1].index, 1);
    }

    #[test]
    fn a_tool_result_names_what_it_came_from() {
        let result = |uuid: &str, parent: &str, id: &str, text: &str| {
            user_content(
                uuid,
                Some(parent),
                json!([{ "type": "tool_result", "tool_use_id": id, "content": text }]),
            )
        };
        let jsonl = [
            user("u1", None, "go"),
            assistant(
                "a1",
                Some("u1"),
                json!([
                    { "type": "tool_use", "id": "t1", "name": "Bash",
                      "input": { "command": "cargo test\n  --all" } },
                    { "type": "tool_use", "id": "t2", "name": "Read",
                      "input": { "file_path": "/p/a.rs" } },
                    { "type": "tool_use", "id": "t3", "name": "WebSearch", "input": {} },
                ]),
            ),
            result("r1", "a1", "t1", "test result: ok"),
            result("r2", "r1", "t2", "fn main() {}"),
            result("r3", "r2", "t3", "nothing found"),
            result("r4", "r3", "gone", "from before the read"),
        ]
        .join("\n");
        let read = read_blocks(&jsonl);
        let labels: Vec<_> = read
            .blocks
            .iter()
            .filter(|block| block.role == BlockRole::Tool)
            .map(|block| (block.label.as_deref().unwrap(), block.turn))
            .collect();
        assert_eq!(
            labels,
            [
                ("cargo test --all", 1),
                ("/p/a.rs", 1),
                ("WebSearch", 1),
                ("tool", 1)
            ],
            "a call is not a block, and its result stays in the turn that made it"
        );
    }

    #[test]
    fn a_block_is_a_source_of_the_shape_the_table_gives() {
        let read = read_blocks(&linear());
        let block = &read.blocks[1];
        assert_eq!(block.source_id("s1"), "s1/a1.0");
        assert_eq!(block.context("curly-apple"), "curly-apple turn 1 assistant");
        let meta: Value = serde_json::from_str(&block.meta()).unwrap();
        assert_eq!(meta["turn"], 1);
        assert_eq!(meta["role"], "assistant");
        assert_eq!(
            meta["at_ms"],
            parse_timestamp_millis("2026-10-01T10:00:01.000Z").unwrap()
        );
    }

    /// Every block a read at each record boundary holds, as `(source id, turn)`, with
    /// what a full pass leaves behind taken out as it would be.
    fn read_line_by_line(shape: &str) -> BTreeMap<String, usize> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut held = BTreeMap::new();
        let mut cursor: Option<TranscriptCursor> = None;
        let mut text = String::new();
        for line in shape.lines() {
            text.push_str(line);
            text.push('\n');
            std::fs::write(&path, &text).unwrap();
            let appended = cursor
                .as_ref()
                .and_then(|cursor| read_appended(&path, cursor).unwrap());
            let pass = appended.unwrap_or_else(|| {
                let pass = read_full("s", &path).unwrap();
                held.clear();
                pass
            });
            for block in &pass.blocks {
                held.insert(block.source_id("s"), block.turn);
            }
            cursor = Some(pass.cursor);
        }
        held
    }

    #[test]
    fn reading_at_every_record_boundary_equals_one_full_pass() {
        for shape in [linear(), wake(), orphan(), rewind(), compaction()] {
            let full: BTreeMap<String, usize> = read_blocks(&shape)
                .blocks
                .iter()
                .map(|block| (block.source_id("s"), block.turn))
                .collect();
            assert_eq!(read_line_by_line(&shape), full, "{shape}");
        }
    }

    #[test]
    fn an_unterminated_last_line_waits_until_it_is_terminated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let first = user("u1", None, "first question");
        let second = assistant("a1", Some("u1"), says("first answer"));
        let cut = second.len() / 2;
        std::fs::write(&path, format!("{first}\n{}", &second[..cut])).unwrap();

        let pass = read_full("s", &path).unwrap();
        assert_eq!(pass.blocks.len(), 1);
        assert_eq!(pass.cursor.offset, first.len() as i64 + 1);
        let still = read_appended(&path, &pass.cursor).unwrap().unwrap();
        assert!(still.blocks.is_empty());
        assert_eq!(still.cursor.offset, pass.cursor.offset);

        std::fs::write(&path, format!("{first}\n{second}\n")).unwrap();
        let later = read_appended(&path, &still.cursor).unwrap().unwrap();
        assert_eq!(later.blocks[0].text, "first answer");
    }

    #[test]
    fn a_rewritten_prefix_asks_for_a_full_pass() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, format!("{}\n", user("u1", None, "first"))).unwrap();
        let pass = read_full("s", &path).unwrap();
        std::fs::write(&path, format!("{}\n", user("u1", None, "other"))).unwrap();
        assert!(read_appended(&path, &pass.cursor).unwrap().is_none());
    }

    struct Home {
        _root: tempfile::TempDir,
        project: String,
        dir: PathBuf,
        sessions: Arc<SessionLedger>,
        index: Arc<SemanticIndex>,
        state: Arc<FakeState>,
        indexer: Indexer,
    }

    fn sid(n: u32) -> String {
        format!("00000000-0000-4000-8000-{n:012}")
    }

    impl Home {
        async fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let project = root.path().join("proj");
            std::fs::create_dir_all(&project).unwrap();
            let project = project.canonicalize().unwrap().display().to_string();
            let home = ClaudeHome::at(root.path().join("claude"));
            let (dir, project) = claude_project_dir(&home, &project);
            std::fs::create_dir_all(&dir).unwrap();
            let sessions = Arc::new(SessionLedger::open_in_memory_with_home(home).unwrap());
            // What makes the project one the ledger knows, with no file of its own.
            sessions
                .record_spawn("anchor", "ws", &project, "card", 1, "anchor", None)
                .unwrap();
            let index = Arc::new(SemanticIndex::open(root.path().join("semantic.db")).unwrap());
            let state = FakeState::new(Some("nl-a"));
            let embedder = client(&state);
            embedder.start().await;
            let indexer = Indexer::new(Arc::clone(&index), embedder, Some(Arc::clone(&sessions)));
            Self {
                _root: root,
                project,
                dir,
                sessions,
                index,
                state,
                indexer,
            }
        }

        fn write(&self, session: &str, text: &str) -> PathBuf {
            let path = self.dir.join(format!("{session}.jsonl"));
            std::fs::write(&path, text).unwrap();
            path
        }

        fn spawn_live(&self, session: &str) {
            self.sessions
                .record_spawn(session, "ws", &self.project, session, 1, session, None)
                .unwrap();
        }

        fn held(&self, session: &str) -> Vec<String> {
            let mut ids = self
                .index
                .session_source_ids(TRANSCRIPT_KIND, session)
                .unwrap();
            ids.sort();
            ids
        }

        fn embedded(&self) -> usize {
            self.state.batches.lock().iter().sum()
        }

        /// Work the catch-up until nothing is owed.
        async fn drain(&self, catch_up: &mut CatchUp) {
            loop {
                if catch_up.is_loading() {
                    let loaded = catch_up.loaded().await;
                    catch_up.apply(&self.indexer, loaded);
                } else if catch_up.owed() {
                    catch_up.run_unit(&self.indexer).await;
                } else {
                    return;
                }
            }
        }

        /// Work it up to the listing's jobs being queued, and start none of them.
        async fn scan(&self, catch_up: &mut CatchUp) {
            catch_up.run_unit(&self.indexer).await;
            let loaded = catch_up.loaded().await;
            catch_up.apply(&self.indexer, loaded);
        }

        fn catch_up(&self, walk_history: bool) -> CatchUp {
            CatchUp::new(walk_history, coverage_channel(walk_history).0)
        }
    }

    /// A hit's `turn` is what the verb that reads a transcript takes, so following one
    /// lands on a turn holding the passage's text, or for a tool result on the turn
    /// holding its call's line.
    #[tokio::test]
    async fn a_hits_turn_passed_to_session_transcript_lands_on_what_it_found() {
        use crate::feeds::operator::{OperatorContext, run_verb};
        use serde_json::json;

        let home = Home::new().await;
        let session = "a1b2c3d4-0000-4000-8000-000000000004";
        let fixture = super::super::embedder::compiled::checkout_root()
            .join("tests/operator-eval/history/transcripts")
            .join(format!("{session}.jsonl"));
        let text = std::fs::read_to_string(fixture)
            .unwrap()
            .replace("{{PROJECT}}", &home.project);
        home.write(session, &text);
        home.spawn_live(session);
        let mut catch_up = home.catch_up(true);
        home.drain(&mut catch_up).await;

        let ctx = OperatorContext {
            ledger: Arc::clone(&home.sessions),
            shell_ledger: None,
            bootstrap_project_dir: PathBuf::from(&home.project),
            attachments_dir: home.dir.join("attachments"),
            query_expansion: None,
            prompt_ledger: None,
            session_index_path: home.dir.join("session_index.db"),
            docs_dir: None,
            semantic: Some(Arc::new(crate::semantic::SemanticSearch::new(
                Arc::clone(&home.index),
                Arc::clone(&home.indexer.embedder),
                coverage_channel(false).1,
            ))),
        };
        for (query, role, turn, found, in_turn) in [
            (
                "logged out constantly",
                "user",
                1,
                "logged out",
                "logged out",
            ),
            (
                "Rotate it on every use",
                "assistant",
                2,
                "Rotate it",
                "Rotate it",
            ),
            (
                "Keychain this-device-only",
                "assistant",
                3,
                "Keychain",
                "Keychain",
            ),
            (
                "tokens.rs has been updated",
                "tool",
                3,
                "has been updated",
                "Edit",
            ),
        ] {
            let out = run_verb(
                &ctx,
                "search.semantic",
                &json!({ "query": query, "kind": "transcript", "session": session, "limit": 20 }),
            )
            .await
            .unwrap();
            let hit = out["hits"]
                .as_array()
                .unwrap()
                .iter()
                .find(|hit| hit["role"] == role && hit["text"].as_str().unwrap().contains(found))
                .unwrap_or_else(|| panic!("no {role} hit holding {found:?}: {out}"));
            assert_eq!(hit["turn"], turn, "{hit}");
            assert_eq!(hit["session_id"], session);
            assert_eq!(hit["ref"], json!({ "kind": "session", "target": session }));
            let read = run_verb(
                &ctx,
                "session.transcript",
                &json!({ "session_id": session, "turn": hit["turn"] }),
            )
            .await
            .unwrap();
            let shown = read["text"].as_str().unwrap();
            assert!(shown.contains(in_turn), "{query}: {shown}");
        }
    }

    /// A transcript of `count` one-passage exchanges.
    fn long_transcript(tag: &str, count: usize) -> String {
        let mut lines = Vec::new();
        let mut parent: Option<String> = None;
        for at in 0..count {
            let uuid = format!("{tag}-{at}");
            let text = format!("{tag} says thing number {at}");
            let line = if at % 2 == 0 {
                user(&uuid, parent.as_deref(), &text)
            } else {
                assistant(&uuid, parent.as_deref(), says(&text))
            };
            lines.push(line);
            parent = Some(uuid);
        }
        lines.join("\n") + "\n"
    }

    #[tokio::test]
    async fn a_catch_up_indexes_listed_sessions_oldest_first_and_writes_their_cursors() {
        let home = Home::new().await;
        let (one, two) = (sid(1), sid(2));
        home.write(&one, &(linear() + "\n"));
        home.write(&two, &(wake() + "\n"));
        let mut catch_up = home.catch_up(true);
        home.drain(&mut catch_up).await;

        assert_eq!(home.held(&one).len(), 4);
        assert_eq!(home.held(&two).len(), 3);
        let cursor = home.index.cursor(&one).unwrap().unwrap();
        assert_eq!(cursor.offset as usize, linear().len() + 1);
    }

    #[tokio::test]
    async fn a_second_catch_up_over_what_is_done_reads_and_embeds_nothing() {
        let home = Home::new().await;
        let one = sid(1);
        home.write(&one, &(linear() + "\n"));
        home.drain(&mut home.catch_up(true)).await;
        let embedded = home.embedded();

        let mut again = home.catch_up(true);
        home.scan(&mut again).await;
        assert!(
            again.queue.is_empty(),
            "a cursor at the file's size is done"
        );
        assert_eq!(home.embedded(), embedded);
    }

    #[tokio::test]
    async fn a_rewind_removes_the_abandoned_branch_and_embeds_only_what_is_new() {
        let home = Home::new().await;
        let session = sid(1);
        home.spawn_live(&session);
        let text = rewind();
        let lines: Vec<&str> = text.lines().collect();
        home.write(&session, &(lines[..4].join("\n") + "\n"));
        let mut catch_up = home.catch_up(false);
        catch_up.live_pass(&home.indexer).await;
        home.drain(&mut catch_up).await;
        assert_eq!(home.held(&session).len(), 4);
        let embedded = home.embedded();

        home.write(&session, &(lines.join("\n") + "\n"));
        catch_up.live_pass(&home.indexer).await;
        assert_eq!(catch_up.queue.len(), 1, "a rewind goes through the queue");
        home.drain(&mut catch_up).await;

        let held = home.held(&session);
        assert_eq!(
            held,
            [
                format!("{session}/a1.0"),
                format!("{session}/a3.0"),
                format!("{session}/u1.0"),
                format!("{session}/u3.0"),
            ]
        );
        assert_eq!(home.embedded(), embedded + 2);
    }

    #[tokio::test]
    async fn a_catch_up_stopped_part_way_embeds_only_what_it_had_not() {
        let home = Home::new().await;
        let session = sid(1);
        let count = EMBED_BATCH * 3;
        home.write(&session, &long_transcript("long", count));
        let mut first = home.catch_up(true);
        home.scan(&mut first).await;
        first.run_unit(&home.indexer).await;
        let loaded = first.loaded().await;
        first.apply(&home.indexer, loaded);
        first.run_unit(&home.indexer).await;
        assert_eq!(home.embedded(), EMBED_BATCH);
        drop(first);

        home.drain(&mut home.catch_up(true)).await;
        assert_eq!(home.embedded(), count);
        assert_eq!(home.held(&session).len(), count);
    }

    #[tokio::test]
    async fn a_turn_tick_reads_a_live_session_ahead_of_a_pending_batch() {
        let home = Home::new().await;
        let (old, live) = (sid(1), sid(2));
        home.write(&old, &long_transcript("old", EMBED_BATCH * 2));
        home.spawn_live(&live);
        let first = user("u1", None, "first");
        home.write(&live, &format!("{first}\n"));
        let mut catch_up = home.catch_up(false);
        catch_up.live_pass(&home.indexer).await;
        home.drain(&mut catch_up).await;

        let mut walking = home.catch_up(true);
        home.scan(&mut walking).await;
        assert_eq!(walking.queue.len(), 1);
        let next = assistant("a1", Some("u1"), says("new words"));
        home.write(&live, &format!("{first}\n{next}\n"));

        walking.live_pass(&home.indexer).await;
        assert_eq!(home.held(&live).len(), 2, "read inline");
        assert!(home.held(&old).is_empty(), "before any of the old session");
    }

    #[tokio::test]
    async fn a_live_session_with_no_cursor_goes_ahead_of_older_ones() {
        let home = Home::new().await;
        let (old, live) = (sid(1), sid(2));
        home.write(&old, &long_transcript("old", 2));
        home.spawn_live(&live);
        home.write(&live, &long_transcript("live", 2));
        let mut walking = home.catch_up(true);
        home.scan(&mut walking).await;

        walking.live_pass(&home.indexer).await;
        assert_eq!(walking.queue[0].session, live);
        assert_eq!(walking.queue.len(), 2);
        let total = walking.counted.len();
        assert_eq!(total, 2, "one session is counted once");
        walking.run_unit(&home.indexer).await;
        let loaded = walking.loaded().await;
        walking.apply(&home.indexer, loaded);
        walking.run_unit(&home.indexer).await;
        assert_eq!(home.held(&live).len(), 2);
        assert!(home.held(&old).is_empty());
    }

    #[tokio::test]
    async fn with_no_catch_up_a_live_session_still_passes_through_the_queue() {
        let home = Home::new().await;
        let (old, live) = (sid(1), sid(2));
        home.write(&old, &long_transcript("old", 2));
        home.spawn_live(&live);
        home.write(&live, &long_transcript("live", 2));
        let mut catch_up = home.catch_up(false);
        assert!(!catch_up.owed());

        catch_up.live_pass(&home.indexer).await;
        home.drain(&mut catch_up).await;
        assert_eq!(home.held(&live).len(), 2);
        assert!(home.held(&old).is_empty());
    }

    #[tokio::test]
    async fn a_swept_file_leaves_at_reconcile_and_a_missing_project_removes_nothing() {
        let home = Home::new().await;
        let (one, two) = (sid(1), sid(2));
        let swept = home.write(&one, &(linear() + "\n"));
        home.write(&two, &(wake() + "\n"));
        home.drain(&mut home.catch_up(true)).await;

        std::fs::remove_file(&swept).unwrap();
        home.drain(&mut home.catch_up(true)).await;
        assert!(home.held(&one).is_empty());
        assert!(home.index.cursor(&one).unwrap().is_none());
        assert_eq!(home.held(&two).len(), 3);

        std::fs::remove_dir_all(&home.dir).unwrap();
        home.drain(&mut home.catch_up(true)).await;
        assert_eq!(home.held(&two).len(), 3);
        assert!(home.index.cursor(&two).unwrap().is_some());
    }

    #[tokio::test]
    async fn a_rotated_ancestor_leaves_while_its_file_is_still_on_disk() {
        let home = Home::new().await;
        let (ancestor, descendant) = (sid(1), sid(2));
        let stamped = |session: &str, uuid: &str, parent: Option<&str>, text: &str| {
            json!({
                "type": "user", "uuid": uuid, "parentUuid": parent, "sessionId": session,
                "permissionMode": "default",
                "message": { "role": "user", "content": text },
            })
            .to_string()
        };
        let first = stamped(&ancestor, "u1", None, "before the rotation");
        let path = home.write(&ancestor, &format!("{first}\n"));
        home.drain(&mut home.catch_up(true)).await;
        assert_eq!(home.held(&ancestor).len(), 1);

        let second = stamped(&descendant, "u2", Some("u1"), "after the rotation");
        home.write(&descendant, &format!("{first}\n{second}\n"));
        home.drain(&mut home.catch_up(true)).await;

        assert!(path.exists());
        assert!(home.held(&ancestor).is_empty());
        assert!(home.index.cursor(&ancestor).unwrap().is_none());
        assert_eq!(
            home.held(&descendant),
            [format!("{descendant}/u1.0"), format!("{descendant}/u2.0")]
        );
    }

    #[tokio::test]
    async fn a_session_trashed_mid_job_keeps_nothing_and_gets_no_cursor() {
        let home = Home::new().await;
        let session = sid(1);
        let path = home.write(&session, &long_transcript("long", EMBED_BATCH * 2));
        let mut catch_up = home.catch_up(true);
        home.scan(&mut catch_up).await;
        catch_up.run_unit(&home.indexer).await;
        let loaded = catch_up.loaded().await;
        catch_up.apply(&home.indexer, loaded);
        catch_up.run_unit(&home.indexer).await;
        assert!(!home.held(&session).is_empty());

        std::fs::remove_file(&path).unwrap();
        catch_up.run_unit(&home.indexer).await;
        assert!(catch_up.queue.is_empty());
        assert!(home.held(&session).is_empty());
        assert!(home.index.cursor(&session).unwrap().is_none());
    }

    #[tokio::test]
    async fn a_private_sessions_file_is_not_read_and_gets_no_cursor() {
        let home = Home::new().await;
        let session = sid(1);
        home.spawn_live(&session);
        home.sessions.set_session_private(&session, true).unwrap();
        home.write(&session, &(linear() + "\n"));
        let mut catch_up = home.catch_up(true);
        home.scan(&mut catch_up).await;
        catch_up.run_unit(&home.indexer).await;
        assert!(!catch_up.is_loading(), "nothing went off to read the file");
        home.drain(&mut catch_up).await;
        assert!(home.held(&session).is_empty());
        assert!(home.index.cursor(&session).unwrap().is_none());
    }

    #[tokio::test]
    async fn a_file_ending_mid_line_finishes_and_coverage_reaches_complete() {
        let home = Home::new().await;
        let (one, two) = (sid(1), sid(2));
        home.write(&one, &(linear() + "\n{\"type\":\"user\",\"uuid\":\"cut"));
        home.write(&two, &(wake() + "\n"));
        let (coverage, read) = coverage_channel(true);
        let search = SemanticSearch::new(
            Arc::clone(&home.index),
            Arc::clone(&home.indexer.embedder),
            read,
        );
        let mut catch_up = CatchUp::new(true, coverage);
        assert!(search.coverage().catching_up);

        home.scan(&mut catch_up).await;
        let partway = search.coverage();
        assert!(partway.catching_up);
        assert_eq!(
            (partway.transcripts_done, partway.transcripts_total),
            (0, 2)
        );

        home.drain(&mut catch_up).await;
        assert_eq!(
            search.coverage(),
            SemanticCoverage {
                transcripts_done: 2,
                transcripts_total: 2,
                catching_up: false,
                model_live: true,
            }
        );
        assert_eq!(home.held(&one).len(), 4);
    }

    #[tokio::test]
    async fn a_tick_during_a_long_transcript_runs_between_its_batches() {
        let home = Home::new().await;
        let (long, live) = (sid(1), sid(2));
        home.spawn_live(&live);
        let first = user("u1", None, "first");
        home.write(&live, &format!("{first}\n"));
        let mut catch_up = home.catch_up(false);
        catch_up.live_pass(&home.indexer).await;
        home.drain(&mut catch_up).await;
        let count = 3000;
        home.write(&long, &long_transcript("long", count));

        let (ticks_tx, ticks) = tokio::sync::mpsc::channel(4);
        let cancel = CancellationToken::new();
        let run = tokio::spawn(run_index(
            Indexer::new(
                Arc::clone(&home.index),
                Arc::clone(&home.indexer.embedder),
                Some(Arc::clone(&home.sessions)),
            ),
            IndexStreams {
                docs_dir: None,
                observer: Arc::new(tokio::sync::Notify::new()),
                catch_up: true,
                ticks,
                coverage: coverage_channel(true).0,
                documents: None,
            },
            Duration::ZERO,
            cancel.clone(),
        ));
        while home.held(&long).is_empty() {
            tokio::task::yield_now().await;
        }
        let next = assistant("a1", Some("u1"), says("new words"));
        home.write(&live, &format!("{first}\n{next}\n"));
        ticks_tx.send("card".to_string()).await.unwrap();
        while home.held(&live).len() < 2 {
            tokio::task::yield_now().await;
        }
        assert!(
            home.held(&long).len() < count,
            "the live turn did not wait for the whole transcript"
        );
        cancel.cancel();
        run.await.unwrap();
    }

    /// What three of the real project's transcripts cost: run by hand to check the size
    /// and time estimates against something real. It reads them and writes nothing near
    /// them, and it passes when there are none.
    #[tokio::test]
    #[ignore = "compiles the real helper and reads real transcripts"]
    async fn catch_up_reading_on_real_transcripts() {
        const MOST_BYTES: u64 = 8 * 1024 * 1024;
        // Every project under the Claude home: a worktree's own has none of its own.
        let corpus = crate::live_corpus::reference_corpus_dir();
        let projects = corpus.parent().map(std::fs::read_dir);
        let Some(Ok(projects)) = projects else {
            println!("no projects beside {}", corpus.display());
            return;
        };
        let mut files: Vec<(u64, PathBuf)> = projects
            .flatten()
            .filter_map(|project| std::fs::read_dir(project.path()).ok())
            .flat_map(|entries| entries.flatten().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .filter_map(|path| Some((std::fs::metadata(&path).ok()?.len(), path)))
            .filter(|(size, _)| *size <= MOST_BYTES)
            .collect();
        files.sort();
        let chosen: Vec<(u64, PathBuf)> = files.into_iter().rev().take(3).collect();
        if chosen.is_empty() {
            println!("no transcripts small enough at {}", corpus.display());
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let ledger = SessionLedger::open(dir.path().join("sessions.db"), 0).unwrap();
        let db = dir.path().join("semantic.db");
        let index = Arc::new(SemanticIndex::open(&db).unwrap());
        let embedder = compiled::client(dir.path());
        let model = embedder.start().await.expect("a live model");
        let indexer = Indexer::new(Arc::clone(&index), embedder, Some(Arc::new(ledger)));
        let mut catch_up = CatchUp::new(false, coverage_channel(false).0);
        let mut input = 0;
        for (size, path) in &chosen {
            input += size;
            let copy = dir.path().join(path.file_name().unwrap());
            std::fs::copy(path, &copy).unwrap();
            let session = copy.file_stem().unwrap().to_str().unwrap().to_string();
            let callsign = short_callsign(&session);
            catch_up.enqueue_front(&session, copy, callsign);
        }

        let started = std::time::Instant::now();
        loop {
            if catch_up.is_loading() {
                let loaded = catch_up.loaded().await;
                catch_up.apply(&indexer, loaded);
            } else if catch_up.owed() {
                catch_up.run_unit(&indexer).await;
            } else {
                break;
            }
        }
        let seconds = started.elapsed().as_secs_f64();
        let chunks = index.chunks();
        let embedded = chunks.iter().filter(|chunk| chunk.vector.is_some()).count();
        let on_disk: u64 = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("semantic.db")
            })
            .map(|entry| entry.metadata().unwrap().len())
            .sum();
        println!(
            "{} files, {input} bytes in, on {model}: {} chunks, {embedded} embedded, {seconds:.1} s, \
             {:.0} passages/s, semantic.db {on_disk} bytes, {:.2} bytes per input byte",
            chosen.len(),
            chunks.len(),
            embedded as f64 / seconds,
            on_disk as f64 / input as f64,
        );
        assert!(!chunks.is_empty());
    }

    /// Where each question with a session target lands, under one way of reading the
    /// assistant's text, as `(question, place)` from 1.
    async fn places(rendered: bool, questions: &[Value]) -> Vec<(String, Option<usize>)> {
        let dir = tempfile::tempdir().unwrap();
        let index = Arc::new(SemanticIndex::open(dir.path().join("semantic.db")).unwrap());
        let client = compiled::client(dir.path());
        client.start().await.expect("a live model");
        // With no ledger every session reads as private. One that knows none of these
        // reads them as public.
        let ledger = crate::session_ledger::SessionLedger::open(dir.path().join("sessions.db"), 0);
        let indexer = Indexer::new(
            Arc::clone(&index),
            Arc::clone(&client),
            Some(Arc::new(ledger.unwrap())),
        );

        for (session, text) in fixture_transcripts() {
            for mut block in read_blocks(&text).blocks {
                if rendered && block.role == BlockRole::Assistant {
                    block.text = tugmark::rendered_text(&tugmark::render_blocks(
                        &block.text,
                        tugmark::Highlight::Off,
                    ));
                }
                assert_eq!(
                    ingest_block(&indexer, &session, &session[..8], &block)
                        .await
                        .unwrap()
                        .0,
                    Ingested::Stored
                );
            }
        }

        let search = SemanticSearch::new(
            Arc::clone(&index),
            Arc::clone(&client),
            coverage_channel(false).1,
        );
        let mut answers = Vec::new();
        for item in questions {
            let question = item["question"].as_str().unwrap();
            let target = format!("{}/", item["expect"]["target"].as_str().unwrap());
            let terms = crate::help_docs::search_terms(question);
            let ranked = search
                .rank(TRANSCRIPT_KIND, None, question, &terms)
                .await
                .expect("the helper answers");
            let place = ranked
                .sources
                .iter()
                .position(|source| source.starts_with(&target))
                .map(|place| place + 1);
            answers.push((question.to_string(), place));
        }
        answers
    }

    #[tokio::test]
    #[ignore = "compiles and runs the real helper"]
    async fn rendered_or_raw_on_the_history_fixture() {
        let questions: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(fixture_dir().join("../history-questions.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(questions.len(), 12);
        let session_questions: Vec<Value> = questions
            .into_iter()
            .filter(|item| item["expect"]["kind"] == "session")
            .collect();
        assert!(session_questions.len() >= 7);

        let raw = places(false, &session_questions).await;
        let rendered = places(true, &session_questions).await;
        let in_six = |answers: &[(String, Option<usize>)]| {
            answers
                .iter()
                .filter(|(_, place)| place.is_some_and(|place| place <= 6))
                .count()
        };
        for ((question, raw), (_, rendered)) in raw.iter().zip(&rendered) {
            println!("raw {raw:?}  rendered {rendered:?}  {question}");
        }
        println!(
            "within six of {}: raw {}, rendered {}",
            session_questions.len(),
            in_six(&raw),
            in_six(&rendered)
        );
    }
}

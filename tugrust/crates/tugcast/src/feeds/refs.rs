//! The refs feed — filename matching and content search over the workspace.
//!
//! Two operations share one walk, one result shape, and one numbering
//! scheme. `run_match` tests filenames; the content search op joins it in
//! the same module, since the two differ only in what they read.
//!
//! Numbering is emission order: a ref's index is fixed the moment its row
//! is produced and never reassigned, so a number the user sees on screen
//! stays bound to the same file for the life of the run.
//!
//! Results stream: the dispatcher emits `refs_started`, then a
//! `refs_rows` frame per batch as scans complete, then `refs_complete`.
//! One run at a time per session — a new command cancels and replaces the
//! one in flight, because the ledger keeps only the latest run anyway.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use glob::Pattern;
use rayon::prelude::*;
use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::warn;
use tugcast_core::{FeedId, Frame};

use crate::feeds::session_scoped::SessionScopedFeed;
use crate::feeds::text_ref::{ColumnSpan, LinePreview, PreviewSegment, TextRef};
use crate::feeds::walk::{WalkOptions, walk_workspace};
use crate::fs_read::MAX_READ_BYTES;
use crate::refs_ledger::{NewRefsRun, RefsLedger};
use crate::session_ledger::SessionLedger;

/// Broadcast capacity for `REFS_OUTPUT`. Matches the shell feed's — a
/// streaming run is bursty and a slow client must not stall the producer.
pub const REFS_BROADCAST_CAPACITY: usize = 256;

/// Rows per `refs_rows` frame. A file with thousands of hits arrives as
/// several frames rather than one the client has to parse in one go.
const MAX_ROWS_PER_FRAME: usize = 200;

/// Filename-match options. The defaults are the bare command's behavior:
/// case-insensitive substring matching, every needle required.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct MatchFlags {
    /// Match a file that satisfies *any* needle rather than all of them.
    pub any: bool,
    /// The needle must be the whole basename, not a part of it.
    pub exact: bool,
    /// Directories are candidates too.
    pub dirs: bool,
    /// Distinguish case. Off by default — a filename lookup is a quick
    /// recall gesture, and recalling capitalisation is beside the point.
    pub case_sensitive: bool,
    /// Stop as soon as one file matches.
    pub first_only: bool,
}

/// How one needle is tested against a basename.
enum Needle {
    /// A glob pattern (the needle carried `*`, `?`, or `[`).
    Glob(Pattern),
    /// A literal, already case-folded when the match is case-insensitive.
    Literal(String),
}

impl Needle {
    fn compile(raw: &str, case_sensitive: bool) -> Self {
        let folded = if case_sensitive {
            raw.to_string()
        } else {
            raw.to_lowercase()
        };
        if raw.contains(['*', '?', '[']) {
            // An unparseable pattern falls back to a literal test rather
            // than dropping the needle — a needle nobody can satisfy would
            // silently empty an AND search.
            if let Ok(pattern) = Pattern::new(&folded) {
                return Needle::Glob(pattern);
            }
        }
        Needle::Literal(folded)
    }

    fn matches(&self, basename: &str, exact: bool) -> bool {
        match self {
            Needle::Glob(pattern) => pattern.matches(basename),
            Needle::Literal(literal) => {
                if exact {
                    basename == literal
                } else {
                    basename.contains(literal.as_str())
                }
            }
        }
    }
}

/// Walk `root` and return a numbered ref for every file whose **filename**
/// matches, per `flags`.
///
/// Paths are relative to `root`. Rows are numbered 1..N in walk order.
pub fn run_match(root: &Path, needles: &[String], flags: MatchFlags) -> Vec<TextRef> {
    let needles: Vec<Needle> = needles
        .iter()
        .filter(|needle| !needle.is_empty())
        .map(|needle| Needle::compile(needle, flags.case_sensitive))
        .collect();
    if needles.is_empty() {
        return Vec::new();
    }

    let entries = walk_workspace(
        root,
        WalkOptions {
            include_gitignored: false,
            include_dirs: flags.dirs,
        },
    );

    let mut refs: Vec<TextRef> = Vec::new();
    for entry in entries {
        let basename = match Path::new(&entry.relative).file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => continue,
        };
        let candidate = if flags.case_sensitive {
            basename
        } else {
            basename.to_lowercase()
        };

        let hit = if flags.any {
            needles.iter().any(|n| n.matches(&candidate, flags.exact))
        } else {
            needles.iter().all(|n| n.matches(&candidate, flags.exact))
        };
        if !hit {
            continue;
        }

        refs.push(TextRef::filename(refs.len() as u32 + 1, entry.relative));
        if flags.first_only {
            break;
        }
    }

    refs
}

// ── Content search ───────────────────────────────────────────────────────────

/// Content-search options. The defaults are the bare command's behavior:
/// case-sensitive literal search, every needle required on the line, one
/// row per matching line.
///
/// Case sensitivity differs from the filename op on purpose. Recalling a
/// filename is a fuzzy gesture; grepping code is a precise one.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct SearchFlags {
    /// A line satisfying *any* needle is a hit, rather than all of them.
    pub any: bool,
    /// Needles are regular expressions rather than literal text.
    pub regex: bool,
    /// Fold case.
    pub case_insensitive: bool,
    /// Descend into gitignored paths. `SecretFilter` still applies — no
    /// flag reaches past it.
    pub all_files: bool,
    /// Emit one row per match instead of merging a line's matches into a
    /// single row carrying every span.
    pub per_line: bool,
    /// Chars of context to keep on each side of a match when excerpting a
    /// matched line. `None` takes [`DEFAULT_CONTEXT_CHARS`]; `Some(0)` turns
    /// excerpting off and shows the line whole.
    pub context_chars: Option<u32>,
}

/// Chars kept on each side of a match when a matched line is excerpted.
///
/// Wide enough to carry the identifier a match sits inside plus its
/// neighbours, narrow enough that a minified line reads as a row rather
/// than a wall.
pub const DEFAULT_CONTEXT_CHARS: u32 = 32;

/// The most excerpt text one row may carry, in chars.
///
/// Windowing bounds a line by its *match count*, not by its length, so a
/// query that hits thousands of times on one line (`/search ,` over
/// `.jsonl`) reproduces the wall it was meant to prevent. Past this budget
/// a row stops emitting windows and reports what it dropped, which is the
/// one place the "every match is shown" property yields — and it says so on
/// the row rather than silently.
const MAX_EXCERPT_CHARS: u32 = 2_000;

/// One matched line, before it takes its place in a run's numbering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefRow {
    /// 1-based line number.
    pub line: u32,
    /// 0-based half-open char spans, in whole-line coordinates.
    pub columns: Vec<ColumnSpan>,
    /// What to show of the line.
    pub preview: LinePreview,
}

/// Compile the run's needles into matchers.
///
/// Literal needles are escaped, so every search runs through one engine
/// and byte offsets always index the line as the user wrote it — case
/// folding a haystack by hand would shift offsets on text where the
/// lowercase form is a different length.
///
/// An unparseable pattern is an error the caller reports, never a panic.
pub fn compile_needles(needles: &[String], flags: SearchFlags) -> Result<Vec<Regex>, String> {
    needles
        .iter()
        .filter(|needle| !needle.is_empty())
        .map(|needle| {
            let source = if flags.regex {
                needle.clone()
            } else {
                regex::escape(needle)
            };
            RegexBuilder::new(&source)
                .case_insensitive(flags.case_insensitive)
                .build()
                .map_err(|err| err.to_string())
        })
        .collect()
}

/// Char offset of a byte offset within `line`.
fn char_offset(line: &str, byte_offset: usize) -> u32 {
    line[..byte_offset].chars().count() as u32
}

/// Merge overlapping or touching spans, in place of the many small runs a
/// multi-needle line produces.
fn merge_spans(mut spans: Vec<ColumnSpan>) -> Vec<ColumnSpan> {
    spans.sort_unstable();
    let mut merged: Vec<ColumnSpan> = Vec::with_capacity(spans.len());
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// Byte offsets of the given char offsets within `line`.
///
/// `marks` must be ascending, which lets one walk of the line answer them
/// all — the alternative, `chars().nth()` per mark, is quadratic on exactly
/// the multi-megabyte lines this whole path exists to handle. A mark past
/// the end of the line answers with the line's length.
fn byte_offsets(line: &str, marks: &[u32]) -> Vec<usize> {
    let mut offsets = Vec::with_capacity(marks.len());
    let mut chars = line.chars();
    let mut seen = 0u32;
    let mut cursor = 0usize;
    for &mark in marks {
        while seen < mark {
            match chars.next() {
                Some(ch) => {
                    cursor += ch.len_utf8();
                    seen += 1;
                }
                None => break,
            }
        }
        offsets.push(cursor);
    }
    offsets
}

/// Excerpt a matched line down to the windows worth showing, and report
/// which of its spans those windows cover.
///
/// One window per span, `context` chars on each side, merged where they
/// touch. Two refinements make the common case read naturally:
///
///  - A run shorter than `context` at either end is *not* elided — showing
///    the eight remaining chars of a line costs less than the mark that
///    would stand in for them, so a normal source line comes back whole.
///  - Windows stop at [`MAX_EXCERPT_CHARS`]; spans past that are counted,
///    not carried, so the row can say how many matches it is not showing.
///
/// Spans arrive sorted and non-overlapping (`merge_spans`), and the spans
/// returned keep whole-line coordinates — nothing here shifts an offset.
fn excerpt_line(line: &str, spans: &[ColumnSpan], context: u32) -> (LinePreview, Vec<ColumnSpan>) {
    if context == 0 || spans.is_empty() {
        return (LinePreview::whole(line), spans.to_vec());
    }
    let line_len = line.chars().count() as u32;

    let mut windows: Vec<(u32, u32)> = Vec::new();
    for &(start, end) in spans {
        let window = (
            start.saturating_sub(context),
            end.saturating_add(context).min(line_len),
        );
        match windows.last_mut() {
            Some(last) if window.0 <= last.1 => last.1 = last.1.max(window.1),
            _ => windows.push(window),
        }
    }
    if let Some(first) = windows.first_mut() {
        if first.0 <= context {
            first.0 = 0;
        }
    }
    if let Some(last) = windows.last_mut() {
        if line_len - last.1 <= context {
            last.1 = line_len;
        }
    }

    let mut kept: Vec<(u32, u32)> = Vec::new();
    let mut budget = MAX_EXCERPT_CHARS;
    for window in windows {
        if budget == 0 {
            break;
        }
        let width = window.1 - window.0;
        if width <= budget {
            budget -= width;
            kept.push(window);
        } else {
            kept.push((window.0, window.0 + budget));
            budget = 0;
        }
    }

    // Which spans survive: those a kept window still touches. Both lists are
    // ascending, so one cursor walks them together.
    let mut kept_spans: Vec<ColumnSpan> = Vec::with_capacity(spans.len());
    let mut elided_matches = 0u32;
    let mut cursor = 0usize;
    for &(start, end) in spans {
        while cursor < kept.len() && kept[cursor].1 <= start {
            cursor += 1;
        }
        if cursor < kept.len() && kept[cursor].0 < end {
            kept_spans.push((start, end));
        } else {
            elided_matches += 1;
        }
    }

    let marks: Vec<u32> = kept.iter().flat_map(|&(start, end)| [start, end]).collect();
    let bytes = byte_offsets(line, &marks);
    let segments = kept
        .iter()
        .enumerate()
        .map(|(index, &(start, _))| PreviewSegment {
            col: start,
            text: line[bytes[index * 2]..bytes[index * 2 + 1]].to_string(),
        })
        .collect();

    (
        LinePreview {
            line_len,
            segments,
            elided_matches,
        },
        kept_spans,
    )
}

/// Scan one file's text and return a row per hit.
///
/// Zero-width matches are dropped before anything else — a pattern that
/// can match the empty string would otherwise mark every line in the file
/// as a hit and paint nothing on any of them.
pub fn scan_text(text: &str, needles: &[Regex], flags: SearchFlags) -> Vec<RefRow> {
    if needles.is_empty() {
        return Vec::new();
    }

    let mut rows: Vec<RefRow> = Vec::new();

    for (line_index, line) in text.lines().enumerate() {
        // (needle index, char span) for every hit on this line.
        let mut hits: Vec<(usize, ColumnSpan)> = Vec::new();
        for (needle_index, needle) in needles.iter().enumerate() {
            for hit in needle.find_iter(line) {
                if hit.start() == hit.end() {
                    continue;
                }
                hits.push((
                    needle_index,
                    (char_offset(line, hit.start()), char_offset(line, hit.end())),
                ));
            }
        }
        if hits.is_empty() {
            continue;
        }
        if !flags.any {
            let satisfied = (0..needles.len())
                .all(|needle_index| hits.iter().any(|(index, _)| *index == needle_index));
            if !satisfied {
                continue;
            }
        }

        let line_number = line_index as u32 + 1;
        let context = flags.context_chars.unwrap_or(DEFAULT_CONTEXT_CHARS);
        if flags.per_line {
            let mut spans: Vec<ColumnSpan> = hits.into_iter().map(|(_, span)| span).collect();
            spans.sort_unstable();
            for span in spans {
                let (preview, columns) = excerpt_line(line, &[span], context);
                rows.push(RefRow {
                    line: line_number,
                    columns,
                    preview,
                });
            }
        } else {
            let spans = merge_spans(hits.into_iter().map(|(_, span)| span).collect());
            let (preview, columns) = excerpt_line(line, &spans, context);
            rows.push(RefRow {
                line: line_number,
                columns,
                preview,
            });
        }
    }

    rows
}

/// Read `path` and scan it, or return nothing when it is not searchable
/// text: oversized, unreadable, or not UTF-8.
pub fn scan_file(path: &Path, needles: &[Regex], flags: SearchFlags) -> Vec<RefRow> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.len() <= MAX_READ_BYTES => {}
        _ => return Vec::new(),
    }
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return Vec::new();
    };
    scan_text(&text, needles, flags)
}

/// Walk `root` and scan every candidate file in parallel, handing each
/// file's rows to `on_batch` as that file's scan completes.
///
/// Batches arrive in scan-completion order, not walk order — the caller
/// numbers them as they arrive, which is what makes a ref number stable
/// while results are still streaming in. Files with no hits produce no
/// call.
pub fn run_search<F>(root: &Path, needles: &[Regex], flags: SearchFlags, on_batch: F)
where
    F: Fn(String, Vec<RefRow>) + Sync + Send,
{
    if needles.is_empty() {
        return;
    }

    let entries = walk_workspace(
        root,
        WalkOptions {
            include_gitignored: flags.all_files,
            include_dirs: false,
        },
    );

    entries.par_iter().for_each(|entry| {
        let rows = scan_file(&entry.absolute, needles, flags);
        if !rows.is_empty() {
            on_batch(entry.relative.clone(), rows);
        }
    });
}

/// Number a file's rows into `TextRef`s, continuing from `next_index`.
///
/// The one place a ref number is minted, so the streaming feed and any
/// batch caller cannot disagree about what `#r3` means.
pub fn number_rows(path: &str, rows: Vec<RefRow>, next_index: &mut u32) -> Vec<TextRef> {
    rows.into_iter()
        .map(|row| {
            let index = *next_index;
            *next_index += 1;
            TextRef::content(index, path, row.line, row.columns, row.preview)
        })
        .collect()
}

// ── Feed: wire types ─────────────────────────────────────────────────────────

/// Inbound `REFS_INPUT` frame.
///
/// `command` is the line the user typed, echoed back on `refs_started` so
/// the result block's header reads as what was asked rather than as a
/// rendering of what was parsed. Optional: a caller that omits it gets a
/// canonical rendering composed from the needles.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RefsInput {
    Match {
        tug_session_id: String,
        run_id: String,
        root: String,
        needles: Vec<String>,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        flags: MatchFlags,
    },
    Search {
        tug_session_id: String,
        run_id: String,
        root: String,
        needles: Vec<String>,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        flags: SearchFlags,
    },
    Cancel {
        tug_session_id: String,
        #[serde(default)]
        run_id: Option<String>,
    },
}

/// Which operation a run performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    Match,
    Search,
}

impl OpKind {
    fn as_str(self) -> &'static str {
        match self {
            OpKind::Match => "match",
            OpKind::Search => "search",
        }
    }
}

/// Everything one run needs, resolved from its input frame.
pub struct RunRequest {
    pub tug_session_id: String,
    pub run_id: String,
    pub kind: OpKind,
    pub command: String,
    pub root: PathBuf,
    pub needles: Vec<String>,
    pub match_flags: MatchFlags,
    pub search_flags: SearchFlags,
}

/// Milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit(output: &SessionScopedFeed, tug_session_id: &str, payload: serde_json::Value) {
    output.publish(tug_session_id, payload.to_string().as_bytes());
}

// ── Feed: run execution ──────────────────────────────────────────────────────

/// Run one request to completion, streaming frames as results arrive.
///
/// Blocking: the walk and the scans are CPU work, so callers spawn this on
/// a blocking thread rather than the reactor.
///
/// `cancel` stops the run between batches. `superseded` distinguishes the
/// two reasons a run stops early: an explicit cancel settles the block
/// with what it found (`refs_complete{cancelled:true}`), while a run
/// replaced by a newer command for the same session emits nothing at all
/// — its rows are about to be clobbered, and a late completion frame would
/// settle the block the *new* run is filling.
pub fn execute_run(
    request: RunRequest,
    output: SessionScopedFeed,
    cancel: CancellationToken,
    superseded: Arc<AtomicBool>,
    ledger: Option<Arc<RefsLedger>>,
    sessions: Option<Arc<SessionLedger>>,
) {
    let session = request.tug_session_id.as_str();
    emit(
        &output,
        session,
        json!({
            "type": "refs_started",
            "run_id": request.run_id,
            "kind": request.kind.as_str(),
            "command": request.command,
            "root": request.root.to_string_lossy(),
            "started_at": now_ms(),
        }),
    );

    // Every row the run emitted, in the order it emitted them — the list
    // the ledger stores, so a restored block is numbered exactly as the
    // live one was.
    let emitted: Mutex<Vec<TextRef>> = Mutex::new(Vec::new());
    let next_index = Mutex::new(1u32);

    let send_batch = |rows: Vec<TextRef>| {
        if rows.is_empty() {
            return;
        }
        emitted.lock().unwrap().extend(rows.iter().cloned());
        emit(
            &output,
            session,
            json!({
                "type": "refs_rows",
                "run_id": request.run_id,
                "rows": rows,
            }),
        );
    };

    match request.kind {
        OpKind::Match => {
            let refs = run_match(&request.root, &request.needles, request.match_flags);
            for chunk in refs.chunks(MAX_ROWS_PER_FRAME) {
                if cancel.is_cancelled() {
                    break;
                }
                send_batch(chunk.to_vec());
            }
        }
        OpKind::Search => {
            match compile_needles(&request.needles, request.search_flags) {
                Ok(needles) => {
                    run_search(
                        &request.root,
                        &needles,
                        request.search_flags,
                        |path, rows| {
                            if cancel.is_cancelled() {
                                return;
                            }
                            // One lock spans numbering and emission so a ref's
                            // number and its position in the stream cannot
                            // disagree when two files finish at once.
                            let mut next = next_index.lock().unwrap();
                            let numbered = number_rows(&path, rows, &mut next);
                            for chunk in numbered.chunks(MAX_ROWS_PER_FRAME) {
                                send_batch(chunk.to_vec());
                            }
                        },
                    );
                }
                Err(error) => {
                    // A pattern the user mistyped is a result, not a fault:
                    // the run settles empty with the reason attached.
                    emit(
                        &output,
                        session,
                        json!({
                            "type": "refs_notice",
                            "run_id": request.run_id,
                            "notice": "invalid_pattern",
                            "detail": error,
                        }),
                    );
                }
            }
        }
    }

    if superseded.load(Ordering::SeqCst) {
        return;
    }

    let cancelled = cancel.is_cancelled();
    let refs = emitted.into_inner().unwrap();

    // A partial list is not the session's refs — restoring one would make
    // `/ref N` resolve against a list the user never saw finish.
    if !cancelled && let Some(ledger) = ledger {
        // Key the run to the **line of work** ([P09]); a line-less session
        // keys under its own id.
        let ink_line = sessions
            .as_ref()
            .and_then(|sessions| sessions.line_of(&request.tug_session_id))
            .unwrap_or_else(|| request.tug_session_id.clone());
        let ink_session = request.tug_session_id.clone();
        // The turn this run follows, read from the **segment's** transcript —
        // the file the deck will replay. The anchor is a transcript fact, so
        // it belongs to the id that wrote it rather than to the line. The
        // run's root is the card's project dir, which locates that file.
        let anchor_msg_id = sessions.as_ref().and_then(|sessions| {
            sessions.latest_assistant_msg_id(
                &ink_session,
                Some(request.root.to_string_lossy().as_ref()),
            )
        });
        let record = NewRefsRun {
            tug_session_id: ink_session,
            line_id: ink_line,
            run_id: request.run_id.clone(),
            op_kind: request.kind.as_str().to_string(),
            command: request.command.clone(),
            refs: refs.clone(),
            settled_at_ms: now_ms() as i64,
            anchor_msg_id,
        };
        if let Err(err) = ledger.record_run(&record) {
            warn!(error = %err, session, "refs ledger: could not record run");
        }
    }

    emit(
        &output,
        session,
        json!({
            "type": "refs_complete",
            "run_id": request.run_id,
            "total": refs.len(),
            "cancelled": cancelled,
            "settled_at": now_ms(),
        }),
    );
}

/// Compose the header line for a request that arrived without one.
fn compose_command(kind: OpKind, needles: &[String]) -> String {
    format!("/{} {}", kind.as_str(), needles.join(" "))
}

// ── Feed: dispatcher ─────────────────────────────────────────────────────────

/// The run in flight for one session.
struct RunHandle {
    run_id: String,
    cancel: CancellationToken,
    superseded: Arc<AtomicBool>,
}

/// Consume `REFS_INPUT` frames and run one match-or-search per session.
///
/// A session may have exactly one run in flight. Starting a second one
/// cancels the first and drops its completion frame, which is the honest
/// model given the ledger keeps only the latest run.
pub async fn refs_dispatcher_task(
    mut input_rx: mpsc::Receiver<Frame>,
    output: SessionScopedFeed,
    ledger: Option<Arc<RefsLedger>>,
    sessions: Option<Arc<SessionLedger>>,
    cancel: CancellationToken,
) {
    let mut runs: HashMap<String, RunHandle> = HashMap::new();

    loop {
        let frame = tokio::select! {
            _ = cancel.cancelled() => break,
            frame = input_rx.recv() => match frame {
                Some(frame) => frame,
                None => break,
            },
        };
        if frame.feed_id != FeedId::REFS_INPUT {
            continue;
        }
        let Ok(input) = serde_json::from_slice::<RefsInput>(&frame.payload) else {
            warn!("refs dispatcher: unparseable REFS_INPUT frame");
            continue;
        };

        let request = match input {
            RefsInput::Cancel {
                tug_session_id,
                run_id,
            } => {
                if let Some(handle) = runs.get(&tug_session_id) {
                    // A cancel naming a run that has already been replaced
                    // must not reap its successor.
                    if run_id.is_none() || run_id.as_deref() == Some(handle.run_id.as_str()) {
                        handle.cancel.cancel();
                    }
                }
                continue;
            }
            RefsInput::Match {
                tug_session_id,
                run_id,
                root,
                needles,
                command,
                flags,
            } => RunRequest {
                command: command.unwrap_or_else(|| compose_command(OpKind::Match, &needles)),
                tug_session_id,
                run_id,
                kind: OpKind::Match,
                root: PathBuf::from(root),
                needles,
                match_flags: flags,
                search_flags: SearchFlags::default(),
            },
            RefsInput::Search {
                tug_session_id,
                run_id,
                root,
                needles,
                command,
                flags,
            } => RunRequest {
                command: command.unwrap_or_else(|| compose_command(OpKind::Search, &needles)),
                tug_session_id,
                run_id,
                kind: OpKind::Search,
                root: PathBuf::from(root),
                needles,
                match_flags: MatchFlags::default(),
                search_flags: flags,
            },
        };

        if let Some(previous) = runs.remove(&request.tug_session_id) {
            previous.superseded.store(true, Ordering::SeqCst);
            previous.cancel.cancel();
        }

        let run_cancel = cancel.child_token();
        let superseded = Arc::new(AtomicBool::new(false));
        runs.insert(
            request.tug_session_id.clone(),
            RunHandle {
                run_id: request.run_id.clone(),
                cancel: run_cancel.clone(),
                superseded: Arc::clone(&superseded),
            },
        );

        let run_output = output.clone();
        let run_ledger = ledger.clone();
        let run_sessions = sessions.clone();
        tokio::task::spawn_blocking(move || {
            execute_run(
                request,
                run_output,
                run_cancel,
                superseded,
                run_ledger,
                run_sessions,
            );
        });
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A small workspace with a gitignored directory, a secret, and a
    /// spread of names the flags can discriminate between.
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::create_dir(root.join("build")).unwrap();
        std::fs::create_dir(root.join("Search")).unwrap();
        std::fs::write(root.join("src/search.rs"), "").unwrap();
        std::fs::write(root.join("src/search_test.rs"), "").unwrap();
        std::fs::write(root.join("src/match.rs"), "").unwrap();
        std::fs::write(root.join("build/search.rs"), "").unwrap();
        std::fs::write(root.join("Search/README.md"), "").unwrap();
        std::fs::write(root.join(".env"), "SEARCH_TOKEN=x").unwrap();
        dir
    }

    fn paths(refs: &[TextRef]) -> Vec<&str> {
        let mut out: Vec<&str> = refs.iter().map(|r| r.path.as_str()).collect();
        out.sort_unstable();
        out
    }

    fn needles(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn default_is_case_insensitive_substring() {
        let dir = fixture();
        let refs = run_match(dir.path(), &needles(&["SEARCH"]), MatchFlags::default());
        assert_eq!(paths(&refs), vec!["src/search.rs", "src/search_test.rs"]);
    }

    #[test]
    fn case_sensitive_flag_distinguishes_case() {
        let dir = fixture();
        let refs = run_match(
            dir.path(),
            &needles(&["SEARCH"]),
            MatchFlags {
                case_sensitive: true,
                ..MatchFlags::default()
            },
        );
        assert!(refs.is_empty());
    }

    #[test]
    fn all_needles_required_by_default_any_flag_relaxes_it() {
        let dir = fixture();
        let all = run_match(
            dir.path(),
            &needles(&["search", "test"]),
            MatchFlags::default(),
        );
        assert_eq!(paths(&all), vec!["src/search_test.rs"]);

        let any = run_match(
            dir.path(),
            &needles(&["match", "test"]),
            MatchFlags {
                any: true,
                ..MatchFlags::default()
            },
        );
        assert_eq!(paths(&any), vec!["src/match.rs", "src/search_test.rs"]);
    }

    #[test]
    fn exact_flag_requires_the_whole_basename() {
        let dir = fixture();
        let refs = run_match(
            dir.path(),
            &needles(&["search.rs"]),
            MatchFlags {
                exact: true,
                ..MatchFlags::default()
            },
        );
        assert_eq!(paths(&refs), vec!["src/search.rs"]);
    }

    #[test]
    fn glob_needles_match_the_basename() {
        let dir = fixture();
        let refs = run_match(dir.path(), &needles(&["search*.rs"]), MatchFlags::default());
        assert_eq!(paths(&refs), vec!["src/search.rs", "src/search_test.rs"]);
    }

    #[test]
    fn dirs_flag_admits_directory_entries() {
        let dir = fixture();
        let without = run_match(dir.path(), &needles(&["Search"]), MatchFlags::default());
        assert_eq!(
            paths(&without),
            vec!["src/search.rs", "src/search_test.rs"],
            "a directory is not a candidate by default",
        );

        let with = run_match(
            dir.path(),
            &needles(&["Search"]),
            MatchFlags {
                dirs: true,
                ..MatchFlags::default()
            },
        );
        assert!(paths(&with).contains(&"Search"));
    }

    #[test]
    fn first_only_stops_at_one_result() {
        let dir = fixture();
        let refs = run_match(
            dir.path(),
            &needles(&["search"]),
            MatchFlags {
                first_only: true,
                ..MatchFlags::default()
            },
        );
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].index, 1);
    }

    #[test]
    fn gitignored_matches_are_skipped() {
        let dir = fixture();
        let refs = run_match(dir.path(), &needles(&["search.rs"]), MatchFlags::default());
        assert!(
            !paths(&refs).contains(&"build/search.rs"),
            "gitignored path leaked into results",
        );
    }

    #[test]
    fn secret_paths_never_match() {
        let dir = fixture();
        let refs = run_match(dir.path(), &needles(&["env"]), MatchFlags::default());
        assert!(
            !paths(&refs).contains(&".env"),
            "SecretFilter path leaked into results",
        );
    }

    #[test]
    fn indices_are_assigned_in_emission_order_from_one() {
        let dir = fixture();
        let refs = run_match(dir.path(), &needles(&["search"]), MatchFlags::default());
        let indices: Vec<u32> = refs.iter().map(|r| r.index).collect();
        assert_eq!(indices, (1..=refs.len() as u32).collect::<Vec<u32>>());
    }

    #[test]
    fn empty_needles_match_nothing() {
        let dir = fixture();
        assert!(run_match(dir.path(), &[], MatchFlags::default()).is_empty());
        assert!(
            run_match(dir.path(), &needles(&[""]), MatchFlags::default()).is_empty(),
            "an empty needle must not match every file",
        );
    }

    // ── Content search ───────────────────────────────────────────────────

    fn scan(text: &str, raw: &[&str], flags: SearchFlags) -> Vec<RefRow> {
        let compiled = compile_needles(&needles(raw), flags).unwrap();
        scan_text(text, &compiled, flags)
    }

    /// A preview's kept windows, joined at their elisions — the shape of
    /// what a reader sees, in one string an assertion can name.
    fn preview_text(preview: &LinePreview) -> String {
        preview
            .segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<&str>>()
            .join("…")
    }

    /// A row whose line is short enough to show whole.
    fn whole_row(line: u32, columns: Vec<ColumnSpan>, text: &str) -> RefRow {
        RefRow {
            line,
            columns,
            preview: LinePreview::whole(text),
        }
    }

    #[test]
    fn default_search_is_case_sensitive_literal() {
        let text = "let Foo = 1;\nlet foo = 2;\n";
        let rows = scan(text, &["foo"], SearchFlags::default());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].line, 2);
        assert_eq!(rows[0].columns, vec![(4, 7)]);
        assert_eq!(preview_text(&rows[0].preview), "let foo = 2;");
    }

    #[test]
    fn case_insensitive_flag_folds_case() {
        let text = "let Foo = 1;\nlet foo = 2;\n";
        let rows = scan(
            text,
            &["foo"],
            SearchFlags {
                case_insensitive: true,
                ..SearchFlags::default()
            },
        );
        assert_eq!(
            rows.iter().map(|r| r.line).collect::<Vec<u32>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn regex_flag_treats_needles_as_patterns() {
        let text = "value = 42;\nvalue = x;\n";
        let literal = scan(text, &[r"\d+"], SearchFlags::default());
        assert!(
            literal.is_empty(),
            "a literal search must not interpret regex syntax",
        );

        let rows = scan(
            text,
            &[r"\d+"],
            SearchFlags {
                regex: true,
                ..SearchFlags::default()
            },
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].columns, vec![(8, 10)]);
    }

    #[test]
    fn all_needles_must_hit_the_same_line_unless_any_is_set() {
        let text = "alpha only\nbeta only\nalpha and beta\n";
        let all = scan(text, &["alpha", "beta"], SearchFlags::default());
        assert_eq!(all.iter().map(|r| r.line).collect::<Vec<u32>>(), vec![3]);

        let any = scan(
            text,
            &["alpha", "beta"],
            SearchFlags {
                any: true,
                ..SearchFlags::default()
            },
        );
        assert_eq!(
            any.iter().map(|r| r.line).collect::<Vec<u32>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn a_lines_matches_merge_into_one_row_until_per_line_splits_them() {
        let text = "foo bar foo\n";
        let merged = scan(text, &["foo"], SearchFlags::default());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].columns, vec![(0, 3), (8, 11)]);

        let split = scan(
            text,
            &["foo"],
            SearchFlags {
                per_line: true,
                ..SearchFlags::default()
            },
        );
        assert_eq!(split.len(), 2);
        assert_eq!(split[0].columns, vec![(0, 3)]);
        assert_eq!(split[1].columns, vec![(8, 11)]);
        assert_eq!(split[1].line, 1);
    }

    #[test]
    fn overlapping_spans_from_two_needles_merge() {
        let rows = scan(
            "search_tool",
            &["search", "arch_to"],
            SearchFlags {
                any: true,
                ..SearchFlags::default()
            },
        );
        assert_eq!(rows[0].columns, vec![(0, 9)]);
    }

    #[test]
    fn spans_are_char_offsets_on_a_multibyte_line() {
        // Six chars of accented text and an em-dash precede the hit, but
        // many more bytes do. Byte offsets would paint the wrong run.
        let line = "héllo wörld — needle here";
        let rows = scan(line, &["needle"], SearchFlags::default());
        assert_eq!(rows.len(), 1);
        let (start, end) = rows[0].columns[0];
        let chars: String = line
            .chars()
            .skip(start as usize)
            .take((end - start) as usize)
            .collect();
        assert_eq!(chars, "needle");
        assert_eq!((start, end), (14, 20));
    }

    // ── Excerpting a long line ───────────────────────────────────────────

    /// A line long enough to be excerpted, with `needle` at `at`.
    fn long_line(at: usize, filler: char) -> String {
        let mut line = String::new();
        line.extend(std::iter::repeat_n(filler, at));
        line.push_str("needle");
        line.extend(std::iter::repeat_n(filler, 500));
        line
    }

    #[test]
    fn a_short_line_is_shown_whole_rather_than_excerpted() {
        // The default context is wider than this line, so nothing is cut and
        // the row reads exactly as it did before excerpting existed.
        let rows = scan("let foo = 2;", &["foo"], SearchFlags::default());
        assert_eq!(rows[0].preview.segments.len(), 1);
        assert_eq!(rows[0].preview.segments[0].col, 0);
        assert_eq!(preview_text(&rows[0].preview), "let foo = 2;");
    }

    #[test]
    fn a_long_line_keeps_a_window_around_the_match_and_nothing_else() {
        let line = long_line(400, 'x');
        let rows = scan(&line, &["needle"], SearchFlags::default());
        let preview = &rows[0].preview;
        assert_eq!(preview.line_len, 906);
        assert_eq!(preview.segments.len(), 1);
        // 32 chars of context on each side of a 6-char match.
        assert_eq!(preview.segments[0].col, 368);
        assert_eq!(preview.segments[0].text.chars().count(), 70);
        assert!(preview.segments[0].text.contains("needle"));
    }

    #[test]
    fn a_matchs_columns_stay_in_whole_line_coordinates() {
        // The load-bearing property: the span the row highlights is the same
        // span the editor reveals, so it has to name the line, not the window.
        let line = long_line(400, 'x');
        let rows = scan(&line, &["needle"], SearchFlags::default());
        assert_eq!(rows[0].columns, vec![(400, 406)]);
        // And the window contains it, which is what makes the two reconcile.
        let segment = &rows[0].preview.segments[0];
        let offset = (400 - segment.col) as usize;
        assert_eq!(&segment.text[offset..offset + 6], "needle");
    }

    #[test]
    fn every_match_on_a_line_gets_a_window() {
        // The whole point: a line with hits at both ends shows both, not the
        // first one and a promise.
        let line = format!("needle{}needle", "x".repeat(400));
        let rows = scan(&line, &["needle"], SearchFlags::default());
        let preview = &rows[0].preview;
        assert_eq!(preview.segments.len(), 2);
        assert_eq!(preview.segments[0].col, 0);
        assert_eq!(preview.segments[1].col, 374);
        assert!(preview.segments.iter().all(|s| s.text.contains("needle")));
        assert_eq!(preview.elided_matches, 0);
    }

    #[test]
    fn windows_that_touch_merge_into_one() {
        // Two hits 40 chars apart are within each other's context, so the
        // reader gets one continuous run rather than a spurious elision.
        let line = format!(
            "{}needle{}needle{}",
            "x".repeat(200),
            "y".repeat(40),
            "z".repeat(200)
        );
        let rows = scan(&line, &["needle"], SearchFlags::default());
        assert_eq!(rows[0].preview.segments.len(), 1);
        assert!(!preview_text(&rows[0].preview).contains('…'));
    }

    #[test]
    fn a_remainder_shorter_than_the_context_is_kept_rather_than_elided() {
        // Twenty chars of tail cost less than the mark that would replace
        // them, so the line comes back whole.
        let line = format!("{}needle{}", "x".repeat(20), "y".repeat(20));
        let rows = scan(&line, &["needle"], SearchFlags::default());
        assert_eq!(rows[0].preview.segments.len(), 1);
        assert_eq!(preview_text(&rows[0].preview), line);
    }

    #[test]
    fn the_context_width_is_configurable_and_zero_means_the_whole_line() {
        let line = long_line(400, 'x');
        let narrow = scan(
            &line,
            &["needle"],
            SearchFlags {
                context_chars: Some(4),
                ..SearchFlags::default()
            },
        );
        assert_eq!(narrow[0].preview.segments[0].col, 396);
        assert_eq!(narrow[0].preview.segments[0].text.chars().count(), 14);

        let off = scan(
            &line,
            &["needle"],
            SearchFlags {
                context_chars: Some(0),
                ..SearchFlags::default()
            },
        );
        assert_eq!(off[0].preview.segments[0].text, line);
    }

    #[test]
    fn a_row_stops_at_its_excerpt_budget_and_says_how_many_it_dropped() {
        // The pathological line: a hit every 100 chars for 4,000 chars. The
        // windows are real and disjoint, so only the budget bounds the row.
        let line = "needle".to_string() + &"x".repeat(94);
        let line = line.repeat(40);
        let rows = scan(&line, &["needle"], SearchFlags::default());
        let preview = &rows[0].preview;
        let kept: usize = preview
            .segments
            .iter()
            .map(|s| s.text.chars().count())
            .sum();
        assert!(kept <= MAX_EXCERPT_CHARS as usize, "kept {kept} chars");
        assert!(preview.elided_matches > 0);
        // What it kept and what it counted account for every match on the line.
        assert_eq!(rows[0].columns.len() as u32 + preview.elided_matches, 40);
    }

    #[test]
    fn excerpting_cuts_on_char_boundaries_not_byte_boundaries() {
        // Accented filler makes every byte offset wrong by a growing amount;
        // a byte-sliced window would panic or mangle the text.
        let line = long_line(400, 'é');
        let rows = scan(&line, &["needle"], SearchFlags::default());
        let segment = &rows[0].preview.segments[0];
        assert_eq!(segment.col, 368);
        assert_eq!(segment.text.chars().count(), 70);
        assert!(segment.text.starts_with('é'));
    }

    #[test]
    fn per_line_rows_each_carry_their_own_window() {
        let line = format!("needle{}needle", "x".repeat(400));
        let rows = scan(
            &line,
            &["needle"],
            SearchFlags {
                per_line: true,
                ..SearchFlags::default()
            },
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].columns, vec![(0, 6)]);
        assert_eq!(rows[1].columns, vec![(406, 412)]);
        // Each row shows only its own match — a per-match row that carried
        // the other match's window would be showing someone else's result.
        assert_eq!(rows[0].preview.segments.len(), 1);
        assert_eq!(rows[1].preview.segments.len(), 1);
        assert_eq!(rows[1].preview.segments[0].col, 374);
    }

    #[test]
    fn the_context_flag_arrives_from_the_client_as_a_number() {
        // The typed line's `-c 64` reaches the feed as a number in the flags
        // object; absent, the default stands rather than zero.
        let set: SearchFlags = serde_json::from_value(serde_json::json!({
            "case_insensitive": true,
            "context_chars": 64,
        }))
        .unwrap();
        assert_eq!(set.context_chars, Some(64));
        assert!(set.case_insensitive);

        let absent: SearchFlags = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(absent.context_chars, None);

        let off: SearchFlags =
            serde_json::from_value(serde_json::json!({ "context_chars": 0 })).unwrap();
        assert_eq!(off.context_chars, Some(0));
    }

    #[test]
    fn invalid_regex_is_reported_not_panicked() {
        let err = compile_needles(
            &needles(&["("]),
            SearchFlags {
                regex: true,
                ..SearchFlags::default()
            },
        )
        .unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn zero_width_matches_never_produce_rows() {
        let rows = scan(
            "alpha\nbeta\n",
            &["x*"],
            SearchFlags {
                regex: true,
                ..SearchFlags::default()
            },
        );
        assert!(rows.is_empty(), "an empty match must not mark a line");
    }

    #[test]
    fn binary_and_oversized_files_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let flags = SearchFlags::default();
        let compiled = compile_needles(&needles(&["needle"]), flags).unwrap();

        let binary = dir.path().join("blob.bin");
        std::fs::write(&binary, [b'n', b'e', b'e', b'd', b'l', b'e', 0xff, 0xfe]).unwrap();
        assert!(scan_file(&binary, &compiled, flags).is_empty());

        let big = dir.path().join("big.txt");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_READ_BYTES + 1).unwrap();
        drop(file);
        assert!(scan_file(&big, &compiled, flags).is_empty());

        let text = dir.path().join("ok.txt");
        std::fs::write(&text, "a needle here\n").unwrap();
        assert_eq!(scan_file(&text, &compiled, flags).len(), 1);
    }

    #[test]
    fn run_search_batches_per_file_and_honors_the_skip_model() {
        use std::sync::Mutex;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "vendor/\n").unwrap();
        std::fs::create_dir(root.join("vendor")).unwrap();
        std::fs::write(root.join("vendor/dep.ts"), "needle\n").unwrap();
        std::fs::write(root.join(".env"), "needle\n").unwrap();
        std::fs::write(root.join("a.ts"), "needle one\nnothing\nneedle two\n").unwrap();
        std::fs::write(root.join("b.ts"), "nothing here\n").unwrap();

        let collect = |flags: SearchFlags| {
            let batches: Mutex<Vec<(String, usize)>> = Mutex::new(Vec::new());
            let compiled = compile_needles(&needles(&["needle"]), flags).unwrap();
            run_search(root, &compiled, flags, |path, rows| {
                batches.lock().unwrap().push((path, rows.len()));
            });
            let mut out = batches.into_inner().unwrap();
            out.sort();
            out
        };

        assert_eq!(
            collect(SearchFlags::default()),
            vec![("a.ts".to_string(), 2)],
            "gitignored and secret files must not be scanned",
        );

        assert_eq!(
            collect(SearchFlags {
                all_files: true,
                ..SearchFlags::default()
            }),
            vec![("a.ts".to_string(), 2), ("vendor/dep.ts".to_string(), 1)],
            "all-files descends into gitignored paths but never past SecretFilter",
        );
    }

    #[test]
    fn numbering_continues_across_file_batches() {
        let mut next = 1;
        let first = number_rows(
            "a.ts",
            vec![
                whole_row(1, vec![(0, 6)], "needle"),
                whole_row(3, vec![(0, 6)], "needle"),
            ],
            &mut next,
        );
        let second = number_rows(
            "b.ts",
            vec![whole_row(9, vec![(4, 10)], "    needle")],
            &mut next,
        );

        assert_eq!(
            first.iter().map(|r| r.index).collect::<Vec<u32>>(),
            vec![1, 2]
        );
        assert_eq!(second[0].index, 3);
        assert_eq!(second[0].path, "b.ts");
        assert_eq!(second[0].line, Some(9));
        assert_eq!(next, 4);
    }

    // ── Feed ─────────────────────────────────────────────────────────────

    use tugcast_core::lag::LagPolicy;

    /// A tree with hits spread over two files, so a search produces more
    /// than one batch.
    fn search_fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "needle one\nplain\nneedle two\n").unwrap();
        std::fs::write(dir.path().join("b.ts"), "needle three\n").unwrap();
        dir
    }

    fn request(kind: OpKind, root: &Path, run_id: &str) -> RunRequest {
        RunRequest {
            tug_session_id: "session-a".into(),
            run_id: run_id.into(),
            kind,
            command: "/search needle".into(),
            root: root.to_path_buf(),
            needles: vec!["needle".into()],
            match_flags: MatchFlags::default(),
            search_flags: SearchFlags::default(),
        }
    }

    fn drain(rx: &mut tokio::sync::broadcast::Receiver<Frame>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            out.push(serde_json::from_slice(&frame.payload).unwrap());
        }
        out
    }

    #[test]
    fn a_run_streams_started_rows_then_complete() {
        let dir = search_fixture();
        let feed = SessionScopedFeed::new(FeedId::REFS_OUTPUT, 64, LagPolicy::Warn);
        let mut rx = feed.subscribe();

        execute_run(
            request(OpKind::Search, dir.path(), "run-1"),
            feed,
            CancellationToken::new(),
            Arc::new(AtomicBool::new(false)),
            None,
            None,
        );

        let frames = drain(&mut rx);
        assert_eq!(frames.first().unwrap()["type"], "refs_started");
        assert_eq!(frames.first().unwrap()["kind"], "search");
        assert_eq!(frames.first().unwrap()["tug_session_id"], "session-a");

        let last = frames.last().unwrap();
        assert_eq!(last["type"], "refs_complete");
        assert_eq!(last["total"], 3);
        assert_eq!(last["cancelled"], false);

        let indices: Vec<u64> = frames
            .iter()
            .filter(|f| f["type"] == "refs_rows")
            .flat_map(|f| f["rows"].as_array().unwrap().clone())
            .map(|row| row["index"].as_u64().unwrap())
            .collect();
        assert_eq!(indices, vec![1, 2, 3], "numbers run 1..N across batches");
        assert!(
            frames.iter().all(|f| f["run_id"] == "run-1"),
            "every frame of a run carries its run id",
        );
    }

    #[test]
    fn a_cancelled_run_settles_with_what_it_found() {
        let dir = search_fixture();
        let feed = SessionScopedFeed::new(FeedId::REFS_OUTPUT, 64, LagPolicy::Warn);
        let mut rx = feed.subscribe();

        let cancel = CancellationToken::new();
        cancel.cancel();
        execute_run(
            request(OpKind::Search, dir.path(), "run-1"),
            feed,
            cancel,
            Arc::new(AtomicBool::new(false)),
            None,
            None,
        );

        let frames = drain(&mut rx);
        let last = frames.last().unwrap();
        assert_eq!(last["type"], "refs_complete");
        assert_eq!(last["cancelled"], true);
        assert_eq!(last["total"], 0);
    }

    #[test]
    fn a_superseded_run_emits_no_completion() {
        let dir = search_fixture();
        let feed = SessionScopedFeed::new(FeedId::REFS_OUTPUT, 64, LagPolicy::Warn);
        let mut rx = feed.subscribe();

        let cancel = CancellationToken::new();
        cancel.cancel();
        execute_run(
            request(OpKind::Search, dir.path(), "run-1"),
            feed,
            cancel,
            Arc::new(AtomicBool::new(true)),
            None,
            None,
        );

        let frames = drain(&mut rx);
        assert!(
            !frames.iter().any(|f| f["type"] == "refs_complete"),
            "a replaced run must not settle the block its successor is filling",
        );
    }

    #[test]
    fn an_invalid_pattern_settles_empty_with_a_notice() {
        let dir = search_fixture();
        let feed = SessionScopedFeed::new(FeedId::REFS_OUTPUT, 64, LagPolicy::Warn);
        let mut rx = feed.subscribe();

        let mut req = request(OpKind::Search, dir.path(), "run-1");
        req.needles = vec!["(".into()];
        req.search_flags = SearchFlags {
            regex: true,
            ..SearchFlags::default()
        };
        execute_run(
            req,
            feed,
            CancellationToken::new(),
            Arc::new(AtomicBool::new(false)),
            None,
            None,
        );

        let frames = drain(&mut rx);
        assert!(frames.iter().any(|f| f["notice"] == "invalid_pattern"));
        let last = frames.last().unwrap();
        assert_eq!(last["type"], "refs_complete");
        assert_eq!(last["total"], 0);
        assert_eq!(last["cancelled"], false);
    }

    #[test]
    fn a_completed_run_records_to_the_ledger_and_a_cancelled_one_does_not() {
        let dir = search_fixture();
        let feed = SessionScopedFeed::new(FeedId::REFS_OUTPUT, 64, LagPolicy::Warn);
        let ledger = Arc::new(RefsLedger::open_in_memory().unwrap());

        execute_run(
            request(OpKind::Search, dir.path(), "run-1"),
            feed.clone(),
            CancellationToken::new(),
            Arc::new(AtomicBool::new(false)),
            Some(Arc::clone(&ledger)),
            None,
        );
        let stored = ledger.list_refs("session-a").unwrap().unwrap();
        assert_eq!(stored.run_id, "run-1");
        assert_eq!(stored.op_kind, "search");
        assert_eq!(stored.refs.len(), 3);
        assert_eq!(
            stored.refs.iter().map(|r| r.index).collect::<Vec<u32>>(),
            vec![1, 2, 3],
            "the stored list is numbered exactly as the streamed one was",
        );

        let cancel = CancellationToken::new();
        cancel.cancel();
        execute_run(
            request(OpKind::Search, dir.path(), "run-2"),
            feed,
            cancel,
            Arc::new(AtomicBool::new(false)),
            Some(Arc::clone(&ledger)),
            None,
        );
        assert_eq!(
            ledger.list_refs("session-a").unwrap().unwrap().run_id,
            "run-1",
            "a cancelled run holds a partial list and must not clobber the last full one",
        );
    }

    #[tokio::test]
    async fn the_dispatcher_runs_a_match_request_end_to_end() {
        let dir = search_fixture();
        let feed = SessionScopedFeed::new(FeedId::REFS_OUTPUT, 64, LagPolicy::Warn);
        let mut rx = feed.subscribe();
        let (tx, input_rx) = mpsc::channel(8);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(refs_dispatcher_task(
            input_rx,
            feed,
            None,
            None,
            cancel.clone(),
        ));

        let payload = json!({
            "type": "match",
            "tug_session_id": "session-a",
            "run_id": "run-7",
            "root": dir.path().to_string_lossy(),
            "needles": ["a.ts"],
            "command": "/match a.ts",
        });
        tx.send(Frame::new(
            FeedId::REFS_INPUT,
            payload.to_string().into_bytes(),
        ))
        .await
        .unwrap();

        let mut frames: Vec<serde_json::Value> = Vec::new();
        while frames.last().map(|f| f["type"] != "refs_complete") != Some(false) {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
                .await
                .expect("refs feed went quiet")
                .unwrap();
            frames.push(serde_json::from_slice(&frame.payload).unwrap());
        }

        assert_eq!(frames[0]["type"], "refs_started");
        assert_eq!(frames[0]["kind"], "match");
        assert_eq!(frames[0]["command"], "/match a.ts");
        let rows = frames
            .iter()
            .find(|f| f["type"] == "refs_rows")
            .expect("no rows frame");
        assert_eq!(rows["rows"][0]["path"], "a.ts");
        assert!(rows["rows"][0]["line"].is_null());
        assert_eq!(frames.last().unwrap()["total"], 1);

        cancel.cancel();
        task.await.unwrap();
    }
}

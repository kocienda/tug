//! `tugtool deck motion slide` — the flow slide, driven and read in one command.
//!
//! The gesture is a click on a session row in the Cards card, which focuses
//! that row's card and slides the flow strip to it. This verb clicks between
//! two named rows `--count` times in each direction and reports, per click and
//! in aggregate, what the deck delivered: frames in the first 200 ms, the
//! first frame's offset, the early gaps, every long frame with its time, how
//! long the main thread was blocked in the click's lead, and when the settle
//! mark went on and off.
//!
//! It exists because every earlier reading of this gesture was JavaScript
//! posted by hand to `/api/eval` and reduced by hand (`briefs/flow-slide-loose-threads-brief.md`,
//! `[F09]`), so no reading could be repeated. The page half is
//! `deck_motion_slide.js`, embedded here; it returns raw times relative to the
//! click and this module reduces them, so the reduction is what the unit tests
//! pin.
//!
//! Every report carries the deck's census beside its numbers. A reading on a
//! half-size deck once passed for a reading on the user's deck (`[F03]` of the
//! same brief); a census is what makes two readings comparable.
//!
//! The window is keyed to a timestamp the page half writes at the click, not to
//! the gesture stamp `deck motion gesture` waits for, which a dispatched click
//! never reaches (`[F08]`).

use crate::commands::deck_motion::{EVAL_GATED_REMEDY, EXIT_GATED, EvalOutcome, post_eval};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

/// The page half: one function expression, applied to a JSON argument object.
const PAGE: &str = include_str!("deck_motion_slide.js");

/// How long each click is recorded for. The settle runs to about 450 ms on the
/// deck as it stands; the rest of the window is where late frames land.
pub const WINDOW_MS: u32 = 1600;

/// The lead the heartbeat reads blocking over — the click's first 260 ms, the
/// window `[F13]` of the remaining-costs brief measured.
pub const LEAD_MS: u32 = 260;

/// "The first 200 ms" every frame count is taken over.
const EARLY_MS: f64 = 200.0;

/// A frame gap over this is a long frame: one and a half periods at 60 Hz, the
/// bar the hand-rolled readings used, kept so the numbers stay comparable.
const LONG_FRAME_MS: f64 = 25.0;

/// The floor under the heartbeat's cadence: a nested zero timer is clamped to
/// at least 4 ms. On the release deck it free-runs slower than that — 7–9 ms
/// gaps at rest — which is why the cadence is measured, not assumed.
const TIMER_CLAMP_MS: f64 = 4.0;

/// How long the heartbeat runs before the click, to measure its cadence.
const PREROLL_MS: u32 = 150;

/// How many early gaps a click's line shows.
const EARLY_GAPS_SHOWN: usize = 6;

/// Quiet time between one click's window and the next click.
const REST_BETWEEN_MS: u64 = 400;

/// What a click costs beyond its window and rest: the two warm-up frames and
/// the eval round trip. Generous, so the samplers outlast the last click.
const CLICK_OVERHEAD_MS: u64 = 400;

/// How long `sample` is given to attach before the first click.
const SAMPLER_ATTACH_MS: u64 = 1500;

/// The eval call for one page op.
#[cfg(test)]
pub fn page_call(args: &Value) -> String {
    script_call(PAGE, args)
}

/// The eval call for one op of any embedded page script: the function
/// expression applied to its JSON argument object. `walk` posts its own
/// script through the same shape (`deck_motion_walk.rs`).
pub(crate) fn script_call(script: &str, args: &Value) -> String {
    format!("({})({})", script.trim_end(), args)
}

/// One long frame: when it started, relative to the click, and how long it was.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LongFrame {
    pub at_ms: f64,
    pub gap_ms: f64,
}

/// One click, reduced.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ClickReading {
    /// The row clicked — the card the slide went to.
    pub to: String,
    pub frames_in_early: usize,
    pub first_frame_ms: Option<f64>,
    pub early_gaps_ms: Vec<f64>,
    pub long_frames: Vec<LongFrame>,
    pub lead_block_ms: f64,
    /// The heartbeat's free-running gap before the click; `lead_block_ms` is
    /// the time beyond it.
    pub heartbeat_cadence_ms: f64,
    pub settle_on_ms: Option<f64>,
    pub settle_off_ms: Option<f64>,
    /// Whether focus moved to another pane. A click that moved nothing slid
    /// nothing, and its numbers describe an idle deck.
    pub moved: bool,
}

fn numbers(raw: &Value, key: &str) -> Vec<f64> {
    raw.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|n| n.as_f64()).collect())
        .unwrap_or_default()
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// The heartbeat's free-running gap: the median gap before the click, never
/// under the timer clamp, or the clamp when there are too few beats to say.
fn cadence(pre: &[f64]) -> f64 {
    let mut gaps: Vec<f64> = pre.windows(2).map(|w| w[1] - w[0]).collect();
    if gaps.len() < 3 {
        return TIMER_CLAMP_MS;
    }
    gaps.sort_by(f64::total_cmp);
    gaps[gaps.len() / 2].max(TIMER_CLAMP_MS)
}

/// Main-thread blocking over `[0, LEAD_MS]` from heartbeat times relative to
/// the click: every gap's excess over the heartbeat's own cadence.
///
/// Counting whole gaps over a fixed bar — 4 ms, as the hand-rolled readings
/// did — counts the heartbeat's own free-running cadence as blocking when that
/// cadence is slower than the bar, and on the release deck it is 7–9 ms: every
/// earlier lead figure read high for that reason. The click itself is the
/// first beat, so the click's own task is counted; a gap straddling the
/// window's end counts its part inside, and a heartbeat that never beat again
/// was blocked to the window's end.
fn lead_block(beats: &[f64], cadence: f64) -> f64 {
    let lead = f64::from(LEAD_MS);
    let mut points = vec![0.0];
    points.extend(beats.iter().copied().filter(|t| *t > 0.0));
    let mut blocked = 0.0;
    for w in points.windows(2) {
        if w[0] >= lead {
            break;
        }
        blocked += (w[1].min(lead) - w[0] - cadence).max(0.0);
    }
    if let Some(last) = points.last()
        && *last < lead
    {
        blocked += (lead - last - cadence).max(0.0);
    }
    blocked.round()
}

/// Reduce the page half's raw times for one click.
///
/// `frames` and `beats` are times relative to the click, ascending; `settle`
/// is a list of `[time, present]` flips of the settle mark.
pub fn reduce(raw: &Value) -> ClickReading {
    let frames = numbers(raw, "frames");
    let beats = numbers(raw, "beats");

    let gaps: Vec<(f64, f64)> = frames
        .windows(2)
        .map(|w| (w[0], round1(w[1] - w[0])))
        .collect();

    let heartbeat_cadence_ms = round1(cadence(&numbers(raw, "preBeats")));
    let lead_block_ms = lead_block(&beats, heartbeat_cadence_ms);

    let flips: Vec<(f64, bool)> = raw
        .get("settle")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| Some((m.get(0)?.as_f64()?, m.get(1)?.as_bool()?)))
                .collect()
        })
        .unwrap_or_default();
    let settle_on_ms = flips.iter().find(|(_, on)| *on).map(|(t, _)| *t);
    let settle_off_ms = settle_on_ms.and_then(|on| {
        flips
            .iter()
            .rev()
            .find(|(t, present)| !*present && *t >= on)
            .map(|(t, _)| *t)
    });

    ClickReading {
        to: raw
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        frames_in_early: frames.iter().filter(|t| **t <= EARLY_MS).count(),
        first_frame_ms: frames.first().copied(),
        early_gaps_ms: gaps.iter().take(EARLY_GAPS_SHOWN).map(|g| g.1).collect(),
        long_frames: gaps
            .iter()
            .filter(|(_, gap)| *gap > LONG_FRAME_MS)
            .map(|(at, gap)| LongFrame {
                at_ms: at.round(),
                gap_ms: *gap,
            })
            .collect(),
        lead_block_ms,
        heartbeat_cadence_ms,
        settle_on_ms,
        settle_off_ms,
        moved: raw.get("moved").and_then(|m| m.as_bool()).unwrap_or(false),
    }
}

/// A min–max range over the clicks that have the value.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Span {
    pub min: f64,
    pub max: f64,
}

fn span(values: impl Iterator<Item = f64>) -> Option<Span> {
    values.fold(None, |acc, v| match acc {
        None => Some(Span { min: v, max: v }),
        Some(s) => Some(Span {
            min: s.min.min(v),
            max: s.max.max(v),
        }),
    })
}

/// Every click, summarized.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Summary {
    pub clicks: usize,
    pub moved: usize,
    pub frames_in_early: Option<Span>,
    pub first_frame_ms: Option<Span>,
    pub lead_block_ms: Option<Span>,
    pub heartbeat_cadence_ms: Option<Span>,
    pub settle_on_ms: Option<Span>,
    pub settle_off_ms: Option<Span>,
    /// How many clicks had at least one long frame.
    pub clicks_with_long_frames: usize,
    pub long_frame_gap_ms: Option<Span>,
    pub long_frame_at_ms: Option<Span>,
}

pub fn summarize(readings: &[ClickReading]) -> Summary {
    let longs = || readings.iter().flat_map(|r| r.long_frames.iter());
    Summary {
        clicks: readings.len(),
        moved: readings.iter().filter(|r| r.moved).count(),
        frames_in_early: span(readings.iter().map(|r| r.frames_in_early as f64)),
        first_frame_ms: span(readings.iter().filter_map(|r| r.first_frame_ms)),
        lead_block_ms: span(readings.iter().map(|r| r.lead_block_ms)),
        heartbeat_cadence_ms: span(readings.iter().map(|r| r.heartbeat_cadence_ms)),
        settle_on_ms: span(readings.iter().filter_map(|r| r.settle_on_ms)),
        settle_off_ms: span(readings.iter().filter_map(|r| r.settle_off_ms)),
        clicks_with_long_frames: readings
            .iter()
            .filter(|r| !r.long_frames.is_empty())
            .count(),
        long_frame_gap_ms: span(longs().map(|l| l.gap_ms)),
        long_frame_at_ms: span(longs().map(|l| l.at_ms)),
    }
}

/// Post one page op. `None` when the eval door is shut.
fn page(port: u16, args: Value) -> Result<Option<Value>, String> {
    script_page(port, PAGE, args)
}

/// Post one op of an embedded page script. `None` when the eval door is shut;
/// a page `{error}` comes back as `Err`, carrying the row titles when the page
/// sent them.
pub(crate) fn script_page(port: u16, script: &str, args: Value) -> Result<Option<Value>, String> {
    match post_eval(port, &script_call(script, &args))? {
        EvalOutcome::Gated => Ok(None),
        EvalOutcome::Ok(value) => {
            if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
                return Err(match value.get("titles") {
                    Some(titles) => format!("{error}; the session rows are {titles}"),
                    None => error.to_string(),
                });
            }
            Ok(Some(value))
        }
    }
}

/// Resolve a name to exactly one row title, or say why it does not.
fn resolve(port: u16, name: &str) -> Result<Option<String>, String> {
    let Some(found) = page(port, json!({"op": "resolve", "name": name}))? else {
        return Ok(None);
    };
    let matches: Vec<&str> = found
        .get("matches")
        .and_then(|m| m.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str()).collect())
        .unwrap_or_default();
    match matches.as_slice() {
        [one] => Ok(Some(one.to_string())),
        _ => Err(format!(
            "'{name}' matches {} session rows in the Cards card; the rows are {}",
            matches.len(),
            found.get("titles").cloned().unwrap_or(Value::Null)
        )),
    }
}

/// One click as recorded: the reading, and whatever the optional recorders saw.
struct Recorded {
    reading: ClickReading,
    queries: Vec<QueryRow>,
    tasks: Vec<TaskRow>,
    commits: Vec<CommitRow>,
    long_frames: Vec<LongFrameTag>,
    press_task: ClickTask,
    click_task: ClickTask,
}

fn record(port: u16, title: &str, queries: bool, tasks: bool) -> Result<Option<Recorded>, String> {
    let raw = page(
        port,
        json!({
            "op": "record",
            "name": title,
            "windowMs": WINDOW_MS,
            "leadMs": LEAD_MS,
            "prerollMs": PREROLL_MS,
            "queries": queries,
            "tasks": tasks,
        }),
    )?;
    Ok(raw.map(|raw| {
        fn list<T: serde::de::DeserializeOwned>(raw: &Value, key: &str) -> Vec<T> {
            raw.get(key)
                .filter(|v| !v.is_null())
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default()
        }
        let raw_tasks: Vec<RawTask> = list(&raw, "tasks");
        let raw_commits: Vec<RawCommit> = list(&raw, "commits");
        let raw_tells: Vec<RawTell> = list(&raw, "tells");
        let query_calls: Vec<QueryCall> = list(&raw, "queryCalls");
        let reading = reduce(&raw);
        Recorded {
            long_frames: tag_long_frames(&reading, &raw_tasks, &raw_commits, &query_calls),
            reading,
            queries: list(&raw, "queries"),
            tasks: task_rows(&raw_tasks),
            commits: commit_rows(&raw_commits, &raw_tasks, &raw_tells),
            press_task: task_commits(&raw_commits, &raw_tasks, &raw_tells, "press"),
            click_task: task_commits(&raw_commits, &raw_tasks, &raw_tells, "click"),
        }
    }))
}

/// One selector, as the page half's query recorder saw it in one click, or
/// summed across clicks.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueryRow {
    pub method: String,
    pub selector: String,
    pub count: u64,
    pub ms: f64,
    pub lead_count: u64,
    pub lead_ms: f64,
    pub max_ms: f64,
    /// The caller's stack at the first call seen.
    pub stack: String,
}

/// Sum each (method, selector) across clicks, most expensive first.
pub fn aggregate_queries(rows: Vec<QueryRow>) -> Vec<QueryRow> {
    let mut by_key: Vec<QueryRow> = Vec::new();
    for row in rows {
        match by_key
            .iter_mut()
            .find(|r| r.method == row.method && r.selector == row.selector)
        {
            Some(sum) => {
                sum.count += row.count;
                sum.ms += row.ms;
                sum.lead_count += row.lead_count;
                sum.lead_ms += row.lead_ms;
                sum.max_ms = sum.max_ms.max(row.max_ms);
            }
            None => by_key.push(row),
        }
    }
    by_key.sort_by(|a, b| b.ms.total_cmp(&a.ms));
    by_key
}

/// How many selectors the text report lists.
const QUERIES_SHOWN: usize = 15;

/// One callback the lead recorder saw run, with times relative to the click.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct RawTask {
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub stack: String,
    /// The callback that was running when this one was queued, as an index
    /// into the click's list; negative when none was, or it is not known.
    #[serde(default = "no_index")]
    pub parent: i64,
    pub start: f64,
    pub end: f64,
}

fn no_index() -> i64 {
    -1
}

/// One React commit the census walked while the recorder was armed.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct RawCommit {
    pub t: f64,
    /// What the census walk itself cost — the instrument's time, not the deck's.
    #[serde(default)]
    pub ms: f64,
    /// The recorded callback the commit ran inside, as an index.
    #[serde(default = "no_index")]
    pub task: i64,
    #[serde(default)]
    pub performed: u64,
    /// The components that rendered on their own state, a store or a context
    /// rather than because a parent did, with how many of each.
    #[serde(default)]
    pub origins: Vec<(String, u64)>,
    #[serde(default)]
    pub hooks: Vec<String>,
    /// The first store snapshot read since the previous commit — the
    /// earliest the render is known to have been running. A lower bound:
    /// production React exposes no render start of its own.
    #[serde(default, rename = "renderStart")]
    pub render_start: Option<f64>,
    /// When the commit's passive effects finished.
    #[serde(default)]
    pub post: Option<f64>,
}

/// One store change React was told of, or one `flushSync`, as
/// `lib/gesture-scope.ts` reported it to the lead recorder.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct RawTell {
    pub t: f64,
    /// `store` or `flushSync`.
    pub kind: String,
    #[serde(default)]
    pub stack: String,
    /// The recorded callback the tell came from, as an index.
    #[serde(default = "no_index")]
    pub task: i64,
}

/// One commit's durations and what caused it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct CommitTiming {
    /// From the render's first store read to the commit hook.
    pub react_ms: Option<f64>,
    /// From the previous React boundary — the previous commit's passive
    /// end, else its hook plus the census walk, else the click.
    pub span_ms: f64,
    /// From the commit hook (less the census walk) to the passive end.
    pub passive_ms: Option<f64>,
    /// The tells between the previous render start and this one, condensed.
    pub causes: String,
}

impl CommitTiming {
    /// The React time, or the span when the render read no store.
    pub fn react_or_span(&self) -> f64 {
        self.react_ms.unwrap_or(self.span_ms)
    }
}

/// How many named frames a cause keeps.
const CAUSE_FRAMES: usize = 3;

/// A tell's stack as function names: each frame's `name@file:line:col` (or a
/// bare `file:line:col`) cut to its name, the door's own frame and anonymous
/// frames dropped, the first three kept.
///
/// The first frame is always the door's — `tugTellReact` for a store, the
/// wrapped `flushSync` for a flush — so it is dropped by position: the release
/// bundle's stacks carry minified identifiers (`keepNames` sets `.name`, which
/// JavaScriptCore's stack does not read), and only method names survive.
pub fn cause_label(kind: &str, stack: &str) -> String {
    let names: Vec<&str> = stack
        .split(" < ")
        .skip(1)
        .map(|frame| match frame.split_once('@') {
            Some((name, _)) => name.trim(),
            None => "",
        })
        .filter(|name| !name.is_empty() && *name != "tugTellReact")
        .collect();
    let label = if names.is_empty() {
        "(no named frame)".to_string()
    } else {
        names
            .iter()
            .take(CAUSE_FRAMES)
            .copied()
            .collect::<Vec<_>>()
            .join(" < ")
    };
    if kind == "flushSync" {
        format!("flushSync: {label}")
    } else {
        label
    }
}

/// The label for a commit no tell preceded.
const LOCAL_STATE: &str = "(local state)";

/// Each commit's durations and causes, in commit order.
///
/// Tells partition on render start, not on the commit: a store change made in
/// commit N's layout effects lands after N's render began and before N+1's,
/// and it is N+1 it caused.
pub fn commit_timings(commits: &[RawCommit], tells: &[RawTell]) -> Vec<CommitTiming> {
    let mut lower = f64::NEG_INFINITY;
    let mut boundary = 0.0;
    commits
        .iter()
        .map(|c| {
            let upper = c.render_start.unwrap_or(c.t);
            let mut labels: Vec<(String, u32)> = Vec::new();
            for tell in tells.iter().filter(|t| t.t >= lower && t.t < upper) {
                let label = cause_label(&tell.kind, &tell.stack);
                match labels.iter_mut().find(|(l, _)| *l == label) {
                    Some((_, n)) => *n += 1,
                    None => labels.push((label, 1)),
                }
            }
            let causes = if labels.is_empty() {
                LOCAL_STATE.to_string()
            } else {
                labels
                    .into_iter()
                    .map(|(l, n)| if n > 1 { format!("{l} ×{n}") } else { l })
                    .collect::<Vec<_>>()
                    .join("; ")
            };
            let hook_end = c.t + c.ms;
            let timing = CommitTiming {
                react_ms: c.render_start.map(|s| round1(c.t - s)),
                span_ms: round1(c.t - boundary),
                passive_ms: c.post.map(|p| round1(p - hook_end)),
                causes,
            };
            lower = upper;
            boundary = c.post.unwrap_or(hook_end);
            timing
        })
        .collect()
}

/// The click's own task — the release's dispatch — and every microtask or
/// promise callback descended from it, which run before the task yields.
pub fn click_task(tasks: &[RawTask]) -> HashSet<usize> {
    gesture_task(tasks, "click")
}

/// One of the gesture's own tasks — `press` or `click` — and every microtask
/// or promise callback descended from it.
pub fn gesture_task(tasks: &[RawTask], kind: &str) -> HashSet<usize> {
    let mut set: HashSet<usize> = tasks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.kind == kind)
        .map(|(i, _)| i)
        .collect();
    loop {
        let before = set.len();
        for (i, t) in tasks.iter().enumerate() {
            if (t.kind == "microtask" || t.kind == "promise")
                && usize::try_from(t.parent).is_ok_and(|p| set.contains(&p))
            {
                set.insert(i);
            }
        }
        if set.len() == before {
            return set;
        }
    }
}

/// The commits in one of a click's own tasks, summed.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Default)]
pub struct ClickTask {
    pub commits: u64,
    pub react_ms: f64,
    pub span_ms: f64,
}

pub fn task_commits(
    commits: &[RawCommit],
    tasks: &[RawTask],
    tells: &[RawTell],
    kind: &str,
) -> ClickTask {
    let set = gesture_task(tasks, kind);
    let mut sum = ClickTask::default();
    for (c, timing) in commits.iter().zip(commit_timings(commits, tells)) {
        if usize::try_from(c.task).is_ok_and(|i| set.contains(&i)) {
            sum.commits += 1;
            sum.react_ms += timing.react_or_span();
            sum.span_ms += timing.span_ms;
        }
    }
    sum
}

/// One kind of callback — the same kind, function and queueing site — in one
/// click, or summed across clicks.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TaskRow {
    pub kind: String,
    pub name: String,
    /// Where it was queued from.
    pub stack: String,
    /// The callback that queued it, from the first run seen.
    pub queued_by: String,
    pub count: u64,
    pub ms: f64,
    pub lead_count: u64,
    pub lead_ms: f64,
    pub max_ms: f64,
}

fn task_label(tasks: &[RawTask], index: i64) -> String {
    match usize::try_from(index).ok().and_then(|i| tasks.get(i)) {
        Some(t) if t.name.is_empty() => t.kind.clone(),
        Some(t) => format!("{} {}", t.kind, t.name),
        None => String::new(),
    }
}

/// The part of `[start, end]` inside the lead.
fn in_lead(start: f64, end: f64) -> f64 {
    (end.min(f64::from(LEAD_MS)) - start.max(0.0)).max(0.0)
}

/// Group one click's callbacks by kind, function and queueing site.
pub fn task_rows(tasks: &[RawTask]) -> Vec<TaskRow> {
    let lead = f64::from(LEAD_MS);
    let mut rows: Vec<TaskRow> = Vec::new();
    for t in tasks {
        let ms = (t.end - t.start).max(0.0);
        let in_lead_ms = in_lead(t.start, t.end);
        let starts_in_lead = u64::from(t.start < lead);
        match rows
            .iter_mut()
            .find(|r| r.kind == t.kind && r.name == t.name && r.stack == t.stack)
        {
            Some(r) => {
                r.count += 1;
                r.ms += ms;
                r.lead_count += starts_in_lead;
                r.lead_ms += in_lead_ms;
                r.max_ms = r.max_ms.max(ms);
            }
            None => rows.push(TaskRow {
                kind: t.kind.clone(),
                name: t.name.clone(),
                stack: t.stack.clone(),
                queued_by: task_label(tasks, t.parent),
                count: 1,
                ms,
                lead_count: starts_in_lead,
                lead_ms: in_lead_ms,
                max_ms: ms,
            }),
        }
    }
    rows
}

/// Sum each kind of callback across clicks, the lead's most expensive first.
pub fn aggregate_tasks(rows: Vec<TaskRow>) -> Vec<TaskRow> {
    let mut by_key: Vec<TaskRow> = Vec::new();
    for row in rows {
        match by_key
            .iter_mut()
            .find(|r| r.kind == row.kind && r.name == row.name && r.stack == row.stack)
        {
            Some(sum) => {
                sum.count += row.count;
                sum.ms += row.ms;
                sum.lead_count += row.lead_count;
                sum.lead_ms += row.lead_ms;
                sum.max_ms = sum.max_ms.max(row.max_ms);
            }
            None => by_key.push(row),
        }
    }
    by_key.sort_by(|a, b| b.lead_ms.total_cmp(&a.lead_ms).then(b.ms.total_cmp(&a.ms)));
    by_key
}

/// React commits with the same origins and causes, run from the same kind of
/// callback.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct CommitRow {
    /// The components that asked for the commit, most renders first.
    pub origins: String,
    /// The recorded callback the commit ran inside.
    pub ran_in: String,
    /// The store changes and flushSyncs that preceded the render, condensed.
    pub causes: String,
    pub count: u64,
    pub lead_count: u64,
    /// How many ran in the click's own task.
    pub click_task_count: u64,
    /// Fibers that performed work, summed.
    pub performed: u64,
    /// The census walk's own time, summed.
    pub walk_ms: f64,
    /// React time, summed; a commit whose render read no store counts its
    /// span instead.
    pub react_ms: f64,
    /// Time from the previous React boundary, summed.
    pub span_ms: f64,
    /// Passive-effect time, summed over the commits that reported it.
    pub passive_ms: f64,
    /// Which hooks moved in the origins, from the first commit seen.
    pub hooks: String,
}

/// How many origins name a commit.
const ORIGINS_NAMED: usize = 4;

fn origins_label(origins: &[(String, u64)]) -> String {
    if origins.is_empty() {
        return "(no origin: a root render or a parent's props)".to_string();
    }
    let mut names: Vec<String> = origins
        .iter()
        .take(ORIGINS_NAMED)
        .map(|(name, n)| {
            if *n > 1 {
                format!("{name}×{n}")
            } else {
                name.clone()
            }
        })
        .collect();
    if origins.len() > ORIGINS_NAMED {
        names.push(format!("+{} more", origins.len() - ORIGINS_NAMED));
    }
    names.join(", ")
}

/// Group one click's commits by who asked, where they ran, and what caused them.
pub fn commit_rows(commits: &[RawCommit], tasks: &[RawTask], tells: &[RawTell]) -> Vec<CommitRow> {
    let lead = f64::from(LEAD_MS);
    let in_click = click_task(tasks);
    let mut rows: Vec<CommitRow> = Vec::new();
    for (c, timing) in commits.iter().zip(commit_timings(commits, tells)) {
        let origins = origins_label(&c.origins);
        let ran_in = match task_label(tasks, c.task) {
            label if label.is_empty() => "(outside any recorded callback)".to_string(),
            label => label,
        };
        let in_lead = u64::from(c.t < lead);
        let in_click_task = u64::from(usize::try_from(c.task).is_ok_and(|i| in_click.contains(&i)));
        let react_ms = timing.react_or_span();
        let passive_ms = timing.passive_ms.unwrap_or(0.0);
        match rows
            .iter_mut()
            .find(|r| r.origins == origins && r.ran_in == ran_in && r.causes == timing.causes)
        {
            Some(r) => {
                r.count += 1;
                r.lead_count += in_lead;
                r.click_task_count += in_click_task;
                r.performed += c.performed;
                r.walk_ms += c.ms;
                r.react_ms += react_ms;
                r.span_ms += timing.span_ms;
                r.passive_ms += passive_ms;
            }
            None => rows.push(CommitRow {
                origins,
                ran_in,
                causes: timing.causes,
                count: 1,
                lead_count: in_lead,
                click_task_count: in_click_task,
                performed: c.performed,
                walk_ms: c.ms,
                react_ms,
                span_ms: timing.span_ms,
                passive_ms,
                hooks: c.hooks.join("; "),
            }),
        }
    }
    rows
}

/// Sum each kind of commit across clicks, the most fibers first.
pub fn aggregate_commits(rows: Vec<CommitRow>) -> Vec<CommitRow> {
    let mut by_key: Vec<CommitRow> = Vec::new();
    for row in rows {
        match by_key
            .iter_mut()
            .find(|r| r.origins == row.origins && r.ran_in == row.ran_in && r.causes == row.causes)
        {
            Some(sum) => {
                sum.count += row.count;
                sum.lead_count += row.lead_count;
                sum.click_task_count += row.click_task_count;
                sum.performed += row.performed;
                sum.walk_ms += row.walk_ms;
                sum.react_ms += row.react_ms;
                sum.span_ms += row.span_ms;
                sum.passive_ms += row.passive_ms;
            }
            None => by_key.push(row),
        }
    }
    by_key.sort_by(|a, b| b.performed.cmp(&a.performed));
    by_key
}

/// How many callbacks and commits the text report lists.
const TASKS_SHOWN: usize = 20;
const COMMITS_SHOWN: usize = 15;

/// How long a reloaded deck is given to come back with the recorder in it.
const RELOAD_WAIT_S: u64 = 90;

/// How long a reloaded deck is left to finish mounting before the first click.
const RELOAD_SETTLE_MS: u64 = 8000;

/// Make sure the page carries the lead recorder, reloading the deck to install
/// it when it does not. `Ok(false)` when the eval door is shut.
fn ensure_recorder(port: u16, quiet: bool) -> Result<bool, String> {
    let installed = |value: &Value| value.get("installed").and_then(|v| v.as_bool()) == Some(true);
    match page(port, json!({"op": "recorder"}))? {
        None => return Ok(false),
        Some(value) if installed(&value) => return Ok(true),
        Some(_) => {}
    }
    if !quiet {
        eprintln!(
            "the lead recorder is not in this page — reloading the deck to install it (a relaunch sheds it)"
        );
    }
    // The reload can take the reply with it; what matters is what comes back.
    let _ = page(port, json!({"op": "install"}));
    for _ in 0..RELOAD_WAIT_S {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if let Ok(Some(value)) = page(port, json!({"op": "recorder"}))
            && installed(&value)
            && let Ok(Some(census)) = page(port, json!({"op": "census"}))
            && census
                .get("panes")
                .and_then(|p| p.as_array())
                .is_some_and(|p| !p.is_empty())
        {
            std::thread::sleep(std::time::Duration::from_millis(RELOAD_SETTLE_MS));
            return Ok(true);
        }
    }
    Err(format!(
        "the deck did not come back with the lead recorder within {RELOAD_WAIT_S} s"
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn run_slide(
    port: u16,
    from: &str,
    to: &str,
    count: u32,
    sample: bool,
    queries: bool,
    tasks: bool,
    json_output: bool,
) -> Result<i32, String> {
    let gated = || {
        eprintln!("{EVAL_GATED_REMEDY}");
        Ok(EXIT_GATED)
    };

    if tasks && !ensure_recorder(port, json_output)? {
        return gated();
    }
    let Some(census) = page(port, json!({"op": "census"}))? else {
        return gated();
    };
    let (Some(from), Some(to)) = (resolve(port, from)?, resolve(port, to)?) else {
        return gated();
    };
    if from == to {
        return Err(format!(
            "--from and --to both name '{from}'; a slide needs two cards"
        ));
    }
    if census.get("visibility").and_then(|v| v.as_str()) != Some("visible") {
        eprintln!(
            "warning: the deck reports itself hidden — a covered window stalls requestAnimationFrame, so these frames are not the user's"
        );
    }

    if !json_output {
        print_census(&census);
        if sample {
            println!(
                "note: the samplers stop WebContent to read its stacks, so the frame numbers below are perturbed — take frames from a run without --sample"
            );
        }
        if tasks {
            println!(
                "note: the lead recorder takes a stack at every queueing and walks every React commit, so the frame and lead numbers below are perturbed — take them from a run without --tasks"
            );
        }
        println!(
            "slide '{from}' ⇄ '{to}', {count} click(s) each way, {WINDOW_MS} ms window per click"
        );
        println!();
        println!(
            " #  to                   early  first  early gaps (ms)               lead  settle on→off  long frames (at:gap)"
        );
    }

    // One unrecorded click onto the starting card, so the first recorded click
    // is a real slide rather than a click on the card already focused.
    if record(port, &from, false, false)?.is_none() {
        return gated();
    }
    std::thread::sleep(std::time::Duration::from_millis(REST_BETWEEN_MS));

    // The samplers start after the warm-up click, so it is not in their
    // reports, and run long enough to cover every recorded click.
    let samplers = if sample {
        let targets = crate::commands::deck_motion_sample::targets(port)?;
        let per_click_ms = u64::from(WINDOW_MS) + REST_BETWEEN_MS + CLICK_OVERHEAD_MS;
        let total_ms = u64::from(count) * 2 * per_click_ms + SAMPLER_ATTACH_MS + 1000;
        let seconds = total_ms.div_ceil(1000) as u32;
        let samplers = crate::commands::deck_motion_sample::start(&targets, seconds)?;
        if !json_output {
            let names: Vec<String> = targets.iter().map(|(l, p)| format!("{l} {p}")).collect();
            eprintln!("sampling {} for {seconds} s", names.join(", "));
        }
        std::thread::sleep(std::time::Duration::from_millis(SAMPLER_ATTACH_MS));
        Some(samplers)
    } else {
        None
    };

    let mut readings = Vec::new();
    let mut query_rows = Vec::new();
    let mut task_rows = Vec::new();
    let mut commit_rows = Vec::new();
    let mut long_frames = Vec::new();
    let mut press_task = ClickTask::default();
    let mut click_task = ClickTask::default();
    for _ in 0..count {
        for title in [&to, &from] {
            let Some(recorded) = record(port, title, queries, tasks)? else {
                return gated();
            };
            if !json_output {
                print_click(readings.len() + 1, &recorded.reading);
            }
            readings.push(recorded.reading);
            query_rows.extend(recorded.queries);
            task_rows.extend(recorded.tasks);
            commit_rows.extend(recorded.commits);
            long_frames.extend(recorded.long_frames);
            press_task.commits += recorded.press_task.commits;
            press_task.react_ms += recorded.press_task.react_ms;
            press_task.span_ms += recorded.press_task.span_ms;
            click_task.commits += recorded.click_task.commits;
            click_task.react_ms += recorded.click_task.react_ms;
            click_task.span_ms += recorded.click_task.span_ms;
            std::thread::sleep(std::time::Duration::from_millis(REST_BETWEEN_MS));
        }
    }

    let summary = summarize(&readings);
    let query_rows = queries.then(|| aggregate_queries(query_rows));
    let task_rows = tasks.then(|| aggregate_tasks(task_rows));
    let commit_rows = tasks.then(|| aggregate_commits(commit_rows));
    let per_click = |x: f64| {
        if readings.is_empty() {
            0.0
        } else {
            round1(x / readings.len() as f64)
        }
    };
    let per_task = |t: ClickTask| {
        json!({
            "commits_per_click": per_click(t.commits as f64),
            "react_ms_per_click": per_click(t.react_ms),
            "span_ms_per_click": per_click(t.span_ms),
        })
    };
    let press_task = tasks.then(|| per_task(press_task));
    let click_task = tasks.then(|| per_task(click_task));
    let processes = match samplers {
        Some(samplers) => {
            if !json_output {
                eprintln!("waiting for the samplers to finish");
            }
            Some(samplers.finish()?)
        }
        None => None,
    };
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "census": census,
                "from": from,
                "to": to,
                "count": count,
                "windowMs": WINDOW_MS,
                "leadMs": LEAD_MS,
                "earlyMs": EARLY_MS,
                "longFrameMs": LONG_FRAME_MS,
                "clicks": readings,
                "summary": summary,
                "samples": processes,
                "framesPerturbedBySampling": sample,
                "queries": query_rows,
                "framesPerturbedByTasks": tasks,
                "tasks": task_rows,
                "commits": commit_rows,
                "press_task": press_task,
                "click_task": click_task,
                "longFrames": (queries || tasks).then_some(&long_frames),
            }))
            .unwrap()
        );
    } else {
        println!();
        print_summary(&summary);
        if queries || tasks {
            print_long_frames(&long_frames, queries, tasks);
        }
        if let Some(rows) = &query_rows {
            print_queries(rows, readings.len());
        }
        if let (Some(tasks), Some(commits)) = (&task_rows, &commit_rows) {
            print_tasks(tasks, commits, press_task.as_ref(), click_task.as_ref(), readings.len());
        }
        if let Some(processes) = &processes {
            crate::commands::deck_motion_sample::print(processes, readings.len());
        }
    }
    Ok(0)
}

fn print_census(census: &Value) {
    let n = |k: &str| census.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
    println!(
        "deck: {} elements, {} stacking contexts, {} render-layer candidates",
        n("elements"),
        n("stackingContexts"),
        n("renderLayerCandidates")
    );
    if let Some(panes) = census.get("panes").and_then(|p| p.as_array()) {
        let largest: Vec<String> = panes
            .iter()
            .take(5)
            .map(|p| {
                format!(
                    "{} {}{}",
                    p.get("title").and_then(|t| t.as_str()).unwrap_or("?"),
                    p.get("elements").and_then(|e| e.as_i64()).unwrap_or(0),
                    if p.get("parked").and_then(|v| v.as_bool()) == Some(true) {
                        " (parked)"
                    } else {
                        ""
                    }
                )
            })
            .collect();
        println!(
            "      {} pane(s); largest: {}",
            panes.len(),
            largest.join(", ")
        );
    }
}

fn print_queries(rows: &[QueryRow], clicks: usize) {
    let total: f64 = rows.iter().map(|r| r.ms).sum();
    let lead: f64 = rows.iter().map(|r| r.lead_ms).sum();
    let per = |x: f64| if clicks > 0 { x / clicks as f64 } else { 0.0 };
    println!();
    println!(
        "selector queries: {} distinct, {:.1} ms per click ({:.1} ms in the first {LEAD_MS} ms) — timed by a wrapper, which adds a little of its own",
        rows.len(),
        per(total),
        per(lead)
    );
    println!("  ms/click  lead  calls/click  max ms  query");
    for r in rows.iter().take(QUERIES_SHOWN) {
        let selector: String = r.selector.chars().take(70).collect();
        println!(
            "  {:>8.2}  {:>4.1}  {:>11.1}  {:>6.2}  {}({})",
            per(r.ms),
            per(r.lead_ms),
            per(r.count as f64),
            r.max_ms,
            r.method,
            selector
        );
        let stack: String = r.stack.chars().take(150).collect();
        if !stack.is_empty() {
            println!("            from {stack}");
        }
    }
}

fn ms(value: Option<f64>) -> String {
    value.map_or("—".to_string(), |v| format!("{v:.0}"))
}

/// One selector query as the page half timed it: start relative to the click,
/// duration, method, selector.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct QueryCall(pub f64, pub f64, pub String, pub String);

/// A callback's share of one long frame.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FrameShare {
    pub label: String,
    pub ms: f64,
}

/// One long frame with what the recorders saw run inside it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct LongFrameTag {
    /// The row clicked.
    pub to: String,
    pub at_ms: f64,
    pub gap_ms: f64,
    /// Where the frame falls against the settle mark.
    pub phase: String,
    /// The recorded callbacks that overlapped the frame, the longest first.
    pub callbacks: Vec<FrameShare>,
    pub callback_ms: f64,
    /// The React commits inside it, by origin and fibers.
    pub commits: Vec<String>,
    pub query_calls: usize,
    pub query_ms: f64,
    /// The selector with the most calls inside it.
    pub top_query: Option<String>,
}

/// How many callbacks a long frame names.
const FRAME_CALLBACKS_NAMED: usize = 4;

fn settle_phase(at: f64, on: Option<f64>, off: Option<f64>) -> String {
    match (on, off) {
        (None, _) => "no settle".to_string(),
        (Some(on), _) if at < on => format!("{:.0} ms before the settle", on - at),
        (Some(_), Some(off)) if at >= off => format!("{:.0} ms after the settle ended", at - off),
        (Some(on), Some(off)) => format!(
            "{:.0} ms into the settle, {:.0} ms before its end",
            at - on,
            off - at
        ),
        (Some(on), None) => format!("{:.0} ms into a settle that did not end", at - on),
    }
}

/// Tag each of a click's long frames with what ran between it and the next
/// frame: the settle's phase, the recorded callbacks, the React commits and
/// the selector queries. What the recorders were not asked for is empty.
pub fn tag_long_frames(
    reading: &ClickReading,
    tasks: &[RawTask],
    commits: &[RawCommit],
    queries: &[QueryCall],
) -> Vec<LongFrameTag> {
    reading
        .long_frames
        .iter()
        .map(|frame| {
            let (start, end) = (frame.at_ms, frame.at_ms + frame.gap_ms);
            let mut callbacks: Vec<FrameShare> = tasks
                .iter()
                .enumerate()
                .filter_map(|(i, t)| {
                    let ms = t.end.min(end) - t.start.max(start);
                    // A zero-length callback inside the frame still ran in it.
                    let inside = t.start >= start && t.start < end;
                    (ms > 0.0 || inside).then(|| {
                        let site = t.stack.split(" < ").next().unwrap_or("");
                        let mut label = task_label(tasks, i as i64);
                        let by = task_label(tasks, t.parent);
                        if !by.is_empty() {
                            label.push_str(&format!(", queued by {by}"));
                        }
                        if !site.is_empty() {
                            label.push_str(&format!(", from {site}"));
                        }
                        FrameShare {
                            label,
                            ms: ms.max(0.0),
                        }
                    })
                })
                .collect();
            // Plus zero: an empty sum of floats is negative zero.
            let callback_ms = callbacks.iter().map(|c| c.ms).sum::<f64>() + 0.0;
            callbacks.sort_by(|a, b| b.ms.total_cmp(&a.ms));
            callbacks.truncate(FRAME_CALLBACKS_NAMED);

            let inside: Vec<&QueryCall> = queries
                .iter()
                .filter(|q| q.0 >= start && q.0 < end)
                .collect();
            let mut by_selector: Vec<(String, usize)> = Vec::new();
            for q in &inside {
                let key = format!("{}({})", q.2, q.3);
                match by_selector.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, n)) => *n += 1,
                    None => by_selector.push((key, 1)),
                }
            }
            by_selector.sort_by(|a, b| b.1.cmp(&a.1));

            LongFrameTag {
                to: reading.to.clone(),
                at_ms: frame.at_ms,
                gap_ms: frame.gap_ms,
                phase: settle_phase(frame.at_ms, reading.settle_on_ms, reading.settle_off_ms),
                callbacks,
                callback_ms,
                commits: commits
                    .iter()
                    .filter(|c| c.t >= start && c.t < end)
                    .map(|c| format!("{} ({} fibers)", origins_label(&c.origins), c.performed))
                    .collect(),
                query_calls: inside.len(),
                query_ms: inside.iter().map(|q| q.1).sum::<f64>() + 0.0,
                top_query: by_selector.first().map(|(key, n)| format!("{key} ×{n}")),
            }
        })
        .collect()
}

fn print_long_frames(frames: &[LongFrameTag], queries: bool, tasks: bool) {
    if frames.is_empty() {
        return;
    }
    println!();
    println!("long frames, by what ran between each and the next frame:");
    for f in frames {
        let to: String = f.to.chars().take(20).collect();
        println!("  {:.0}:{:.0} → {to} — {}", f.at_ms, f.gap_ms, f.phase);
        if tasks {
            println!(
                "      callbacks {:.1} ms of the {:.0}; {} commit(s){}",
                f.callback_ms,
                f.gap_ms,
                f.commits.len(),
                if f.commits.is_empty() {
                    String::new()
                } else {
                    format!(": {}", f.commits.join("; "))
                }
            );
            for c in &f.callbacks {
                let label: String = c.label.chars().take(170).collect();
                println!("      {:>5.1} ms  {label}", c.ms);
            }
        }
        if queries {
            println!(
                "      queries {:.1} ms across {} call(s){}",
                f.query_ms,
                f.query_calls,
                f.top_query
                    .as_ref()
                    .map(|q| format!(", most often {}", q.chars().take(110).collect::<String>()))
                    .unwrap_or_default()
            );
        }
    }
}

fn print_tasks(
    tasks: &[TaskRow],
    commits: &[CommitRow],
    press_task: Option<&Value>,
    click_task: Option<&Value>,
    clicks: usize,
) {
    let per = |x: f64| if clicks > 0 { x / clicks as f64 } else { 0.0 };
    let lead: f64 = tasks.iter().map(|r| r.lead_ms).sum();
    let lead_runs: u64 = tasks.iter().map(|r| r.lead_count).sum();
    let walk: f64 = commits.iter().map(|r| r.walk_ms).sum();
    println!();
    println!(
        "lead callbacks: {:.1} ms per click across {:.0} run(s) in the first {LEAD_MS} ms, of which {:.1} ms is the commit census's own walk — what is blocked beyond this is not a callback the recorder can see",
        per(lead),
        per(lead_runs as f64),
        per(walk)
    );
    println!("  lead ms  runs  all ms  max ms  callback");
    for r in tasks.iter().take(TASKS_SHOWN) {
        println!(
            "  {:>7.2}  {:>4.1}  {:>6.2}  {:>6.1}  {}{}{}",
            per(r.lead_ms),
            per(r.lead_count as f64),
            per(r.ms),
            r.max_ms,
            r.kind,
            if r.name.is_empty() { "" } else { " " },
            r.name
        );
        let stack: String = r.stack.chars().take(150).collect();
        match (r.queued_by.is_empty(), stack.is_empty()) {
            (true, true) => {}
            (true, false) => println!("            queued from {stack}"),
            (false, true) => println!("            queued by {}", r.queued_by),
            (false, false) => println!("            queued by {}, from {stack}", r.queued_by),
        }
    }

    let total: u64 = commits.iter().map(|r| r.count).sum();
    let in_lead: u64 = commits.iter().map(|r| r.lead_count).sum();
    println!();
    for (name, task, what) in [
        ("press task", press_task, "pointerdown and mousedown"),
        ("click task", click_task, "pointerup, mouseup and click, a task after the press"),
    ] {
        let Some(ct) = task else { continue };
        let n = |k: &str| ct.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
        println!(
            "{name}: {:.1} commit(s) per click, {:.1} ms React, {:.1} ms span — the {what}, and the microtasks descended from it, which run before the task yields",
            n("commits_per_click"),
            n("react_ms_per_click"),
            n("span_ms_per_click")
        );
    }
    println!(
        "react commits: {:.1} per click ({:.1} in the first {LEAD_MS} ms), by the components that asked",
        per(total as f64),
        per(in_lead as f64)
    );
    println!("  /click  lead  task  fibers/click  ran in → origins");
    for r in commits.iter().take(COMMITS_SHOWN) {
        let n = r.count.max(1) as f64;
        println!(
            "  {:>6.1}  {:>4.1}  {:>4.1}  {:>12.1}  {} → {}",
            per(r.count as f64),
            per(r.lead_count as f64),
            per(r.click_task_count as f64),
            per(r.performed as f64),
            r.ran_in,
            r.origins
        );
        let causes: String = r.causes.chars().take(150).collect();
        println!(
            "            react {:.1} ms, span {:.1} ms, passive {:.1} ms ← {causes}",
            r.react_ms / n,
            r.span_ms / n,
            r.passive_ms / n
        );
        let hooks: String = r.hooks.chars().take(150).collect();
        if !hooks.is_empty() {
            println!("            {hooks}");
        }
    }
}

fn print_click(index: usize, r: &ClickReading) {
    let gaps: Vec<String> = r.early_gaps_ms.iter().map(|g| format!("{g:.0}")).collect();
    let longs: Vec<String> = r
        .long_frames
        .iter()
        .map(|l| format!("{:.0}:{:.0}", l.at_ms, l.gap_ms))
        .collect();
    let title: String = r.to.chars().take(20).collect();
    println!(
        "{index:>2}  {title:<20} {:>5}  {:>5}  {:<29} {:>5}  {:>5}→{:<6} {}{}",
        r.frames_in_early,
        ms(r.first_frame_ms),
        gaps.join(" "),
        format!("{:.0}", r.lead_block_ms),
        ms(r.settle_on_ms),
        ms(r.settle_off_ms),
        if longs.is_empty() {
            "none".to_string()
        } else {
            longs.join(" ")
        },
        match (r.moved, r.settle_on_ms.is_some()) {
            (true, true) => "",
            (true, false) => "  (no settle: focus moved but nothing slid)",
            (false, true) => "  (focus did not move)",
            (false, false) => "  (focus did not move and nothing slid)",
        }
    );
}

fn range(s: Option<Span>) -> String {
    match s {
        None => "—".to_string(),
        Some(s) if s.min == s.max => format!("{:.0}", s.min),
        Some(s) => format!("{:.0}–{:.0}", s.min, s.max),
    }
}

fn print_summary(s: &Summary) {
    println!("{} click(s), {} moved focus", s.clicks, s.moved);
    println!(
        "  frames in the first {EARLY_MS:.0} ms  {}",
        range(s.frames_in_early)
    );
    println!("  first frame              {} ms", range(s.first_frame_ms));
    println!(
        "  lead blocked (first {LEAD_MS} ms)  {} ms, beyond a heartbeat that free-runs at {} ms",
        range(s.lead_block_ms),
        range(s.heartbeat_cadence_ms)
    );
    println!(
        "  settle on / off          {} / {} ms",
        range(s.settle_on_ms),
        range(s.settle_off_ms)
    );
    if s.clicks_with_long_frames == 0 {
        println!("  long frames (> {LONG_FRAME_MS:.0} ms)    none");
    } else {
        println!(
            "  long frames (> {LONG_FRAME_MS:.0} ms)    in {} of {} click(s), {} ms long, at {} ms",
            s.clicks_with_long_frames,
            s.clicks,
            range(s.long_frame_gap_ms),
            range(s.long_frame_at_ms)
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_call_applies_the_function_to_json_arguments() {
        let args = json!({"op": "resolve", "name": "a \"quoted\" name"});
        let call = page_call(&args);
        assert!(call.starts_with("(// The page half"));
        assert!(call.contains("(function (args) {"));
        // The name is JSON-encoded, never interpolated raw.
        assert!(call.ends_with(&format!("}}))({args})")));
        assert!(call.contains(r#""a \"quoted\" name""#));
    }

    #[test]
    fn a_click_reduces_to_the_numbers_the_hand_rolled_reading_took() {
        let raw = json!({
            "title": "beta",
            "frames": [36.0, 50.0, 66.5, 83.0, 100.0, 140.0, 156.0, 190.0, 210.0],
            "preBeats": [-30.0, -22.0, -14.0, -6.0],
            "beats": [0.5, 5.0, 9.0, 120.0, 124.0, 128.0, 240.0, 244.0],
            "settle": [[33.0, true], [33.0, true], [450.0, false], [452.0, false]],
            "moved": true,
        });
        let r = reduce(&raw);
        assert_eq!(r.to, "beta");
        assert_eq!(r.frames_in_early, 8);
        assert_eq!(r.first_frame_ms, Some(36.0));
        assert_eq!(r.early_gaps_ms, vec![14.0, 16.5, 16.5, 17.0, 40.0, 16.0]);
        assert_eq!(
            r.long_frames,
            vec![
                LongFrame {
                    at_ms: 100.0,
                    gap_ms: 40.0
                },
                LongFrame {
                    at_ms: 156.0,
                    gap_ms: 34.0
                },
            ]
        );
        // An 8 ms cadence before the click; then 111 and 112 less the
        // cadence, and the 16 after the last beat less it. The short gaps
        // are the heartbeat running freely.
        assert_eq!(r.heartbeat_cadence_ms, 8.0);
        assert_eq!(r.lead_block_ms, 215.0);
        assert_eq!(r.settle_on_ms, Some(33.0));
        assert_eq!(r.settle_off_ms, Some(452.0));
        assert!(r.moved);
    }

    #[test]
    fn a_click_with_no_settle_and_no_frames_says_so() {
        let r =
            reduce(&json!({"title": "x", "frames": [], "beats": [], "settle": [], "moved": false}));
        assert_eq!(r.frames_in_early, 0);
        assert_eq!(r.first_frame_ms, None);
        assert_eq!(r.settle_on_ms, None);
        assert_eq!(r.settle_off_ms, None);
        assert!(!r.moved);
    }

    /// An off flip before any on belongs to a settle that was already running
    /// when the click landed, and is not this click's end.
    #[test]
    fn an_off_before_the_on_is_not_the_settle_end() {
        let r = reduce(&json!({"frames": [], "beats": [], "settle": [[2.0, false]]}));
        assert_eq!(r.settle_on_ms, None);
        assert_eq!(r.settle_off_ms, None);
    }

    fn row(selector: &str, count: u64, ms: f64, max_ms: f64) -> QueryRow {
        QueryRow {
            method: "Document.querySelector".to_string(),
            selector: selector.to_string(),
            count,
            ms,
            lead_count: count,
            lead_ms: ms,
            max_ms,
            stack: "first".to_string(),
        }
    }

    #[test]
    fn queries_sum_across_clicks_and_sort_by_time() {
        let mut second = row("[data-a]", 2, 1.5, 1.0);
        second.stack = "second".to_string();
        let agg = aggregate_queries(vec![
            row("[data-a]", 3, 2.0, 0.5),
            row("[data-b]", 1, 9.0, 9.0),
            second,
        ]);
        assert_eq!(agg.len(), 2);
        assert_eq!(agg[0].selector, "[data-b]");
        assert_eq!(agg[1].count, 5);
        assert_eq!(agg[1].ms, 3.5);
        assert_eq!(agg[1].max_ms, 1.0);
        // The first stack seen is the one kept.
        assert_eq!(agg[1].stack, "first");
    }

    fn task(kind: &str, name: &str, stack: &str, parent: i64, start: f64, end: f64) -> RawTask {
        RawTask {
            kind: kind.to_string(),
            name: name.to_string(),
            stack: stack.to_string(),
            parent,
            start,
            end,
        }
    }

    #[test]
    fn callbacks_group_by_kind_function_and_queueing_site() {
        let tasks = vec![
            task("click", "dispatch", "", -1, 0.0, 12.0),
            task("microtask", "flush", "a.js:1", 0, 12.0, 30.0),
            task("microtask", "flush", "a.js:1", 0, 250.0, 270.0),
            task("microtask", "flush", "b.js:9", 1, 300.0, 301.0),
        ];
        let rows = task_rows(&tasks);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1].queued_by, "click dispatch");
        assert_eq!(rows[1].count, 2);
        assert_eq!(rows[1].ms, 38.0);
        // The second run starts in the lead and straddles its end: counted,
        // and only its ten milliseconds inside are the lead's.
        assert_eq!(rows[1].lead_count, 2);
        assert_eq!(rows[1].lead_ms, 28.0);
        assert_eq!(rows[1].max_ms, 20.0);
        // Past the lead entirely.
        assert_eq!(rows[2].queued_by, "microtask flush");
        assert_eq!(rows[2].lead_count, 0);
        assert_eq!(rows[2].lead_ms, 0.0);
    }

    #[test]
    fn callbacks_sum_across_clicks_and_sort_by_lead_time() {
        let a = task_rows(&[
            task("timeout", "tick", "t.js:1", -1, 0.0, 2.0),
            task("message", "work", "s.js:4", -1, 5.0, 45.0),
        ]);
        let b = task_rows(&[task("timeout", "tick", "t.js:1", -1, 1.0, 4.0)]);
        let agg = aggregate_tasks(a.into_iter().chain(b).collect());
        assert_eq!(agg.len(), 2);
        assert_eq!(agg[0].name, "work");
        assert_eq!(agg[1].count, 2);
        assert_eq!(agg[1].lead_ms, 5.0);
        assert_eq!(agg[1].max_ms, 3.0);
    }

    #[test]
    fn a_long_frame_is_tagged_with_what_ran_inside_it() {
        let reading = reduce(&json!({
            "title": "beta",
            "frames": [300.0, 316.0, 346.0, 376.0, 392.0],
            "beats": [],
            "settle": [[40.0, true], [450.0, false]],
            "moved": true,
        }));
        // Two long frames: 316→346 and 346→376.
        let tasks = vec![
            task("click", "", "", -1, 0.0, 40.0),
            task("frame", "measure", "cm.js:1 < x.js:2", 0, 320.0, 338.0),
            task("timeout", "tick", "", -1, 330.0, 330.0),
            task("frame", "late", "", -1, 340.0, 350.0),
        ];
        let commits: Vec<RawCommit> = serde_json::from_value(json!([
            {"t": 325.0, "performed": 12, "origins": [["Pane", 2]]},
            {"t": 500.0, "performed": 1, "origins": []},
        ]))
        .unwrap();
        let queries = vec![
            QueryCall(321.0, 1.0, "Element.closest".into(), ".a".into()),
            QueryCall(322.0, 0.0, "Element.closest".into(), ".a".into()),
            QueryCall(323.0, 2.0, "Document.querySelector".into(), ".b".into()),
            QueryCall(400.0, 9.0, "Document.querySelector".into(), ".b".into()),
        ];
        let tags = tag_long_frames(&reading, &tasks, &commits, &queries);
        assert_eq!(tags.len(), 2);
        let first = &tags[0];
        assert_eq!((first.at_ms, first.gap_ms), (316.0, 30.0));
        assert_eq!(first.phase, "276 ms into the settle, 134 ms before its end");
        // 18 ms of `measure`, the zero-length timer, and the six
        // milliseconds of `late` that fall before the next frame.
        assert_eq!(first.callback_ms, 24.0);
        assert_eq!(
            first.callbacks[0].label,
            "frame measure, queued by click, from cm.js:1"
        );
        assert_eq!(first.callbacks[0].ms, 18.0);
        assert_eq!(first.callbacks.len(), 3);
        assert_eq!(first.commits, vec!["Pane×2 (12 fibers)".to_string()]);
        assert_eq!(first.query_calls, 3);
        assert_eq!(first.query_ms, 3.0);
        assert_eq!(first.top_query.as_deref(), Some("Element.closest(.a) ×2"));
        // The second frame holds only the rest of `late`.
        assert_eq!(tags[1].callback_ms, 4.0);
        assert!(tags[1].commits.is_empty());
        assert_eq!(tags[1].query_calls, 0);
    }

    #[test]
    fn commits_group_by_who_asked_and_where_they_ran() {
        let tasks = vec![task("message", "work", "s.js:4", -1, 5.0, 45.0)];
        let raw: Vec<RawCommit> = serde_json::from_value(json!([
            {"t": 10.0, "ms": 2.0, "task": 0, "performed": 40,
             "origins": [["Pane", 3], ["Badge", 1]], "hooks": ["Pane hooks[2:true]"]},
            {"t": 300.0, "ms": 1.0, "task": 0, "performed": 10,
             "origins": [["Pane", 3], ["Badge", 1]], "hooks": []},
            {"t": 20.0, "task": -1, "performed": 5, "origins": []},
        ]))
        .unwrap();
        let rows = aggregate_commits(commit_rows(&raw, &tasks, &[]));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].origins, "Pane×3, Badge");
        assert_eq!(rows[0].ran_in, "message work");
        assert_eq!(rows[0].count, 2);
        assert_eq!(rows[0].lead_count, 1);
        assert_eq!(rows[0].performed, 50);
        assert_eq!(rows[0].walk_ms, 3.0);
        assert_eq!(rows[0].hooks, "Pane hooks[2:true]");
        assert_eq!(rows[1].ran_in, "(outside any recorded callback)");
        assert!(rows[1].origins.starts_with("(no origin"));

        // The same origins from the same callback, caused by different
        // stores, stay apart.
        let raw: Vec<RawCommit> = serde_json::from_value(json!([
            {"t": 10.0, "task": 0, "renderStart": 8.0, "origins": [["Pane", 1]]},
            {"t": 30.0, "task": 0, "renderStart": 28.0, "origins": [["Pane", 1]]},
        ]))
        .unwrap();
        let tells = vec![
            tell(2.0, "store", "tugTellReact@d.js:1:1 < setA@a.js:1:1"),
            tell(20.0, "store", "tugTellReact@d.js:1:1 < setB@b.js:1:1"),
        ];
        let rows = aggregate_commits(commit_rows(&raw, &tasks, &tells));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].causes, "setA");
        assert_eq!(rows[1].causes, "setB");
    }

    fn tell(t: f64, kind: &str, stack: &str) -> RawTell {
        RawTell {
            t,
            kind: kind.to_string(),
            stack: stack.to_string(),
            task: -1,
        }
    }

    #[test]
    fn commit_timings_partition_tells_on_render_start() {
        // Commit 0 renders from 5 and hooks at 9; a store change at 7, inside
        // its render, made in its layout effects or after its first read, is
        // a cause of commit 1.
        let commits: Vec<RawCommit> = serde_json::from_value(json!([
            {"t": 9.0, "ms": 1.0, "renderStart": 5.0},
            {"t": 20.0, "ms": 1.0, "renderStart": 15.0},
        ]))
        .unwrap();
        let tells = vec![
            tell(1.0, "store", "tugTellReact@d.js:1:1 < setFirst@a.js:1:1"),
            tell(7.0, "store", "tugTellReact@d.js:1:1 < setLate@b.js:2:2"),
        ];
        let timings = commit_timings(&commits, &tells);
        assert_eq!(timings[0].causes, "setFirst");
        assert_eq!(timings[1].causes, "setLate");
        assert_eq!(timings[0].react_ms, Some(4.0));
        assert_eq!(timings[1].react_ms, Some(5.0));
    }

    #[test]
    fn a_commit_with_no_render_start_spans_from_the_previous_boundary() {
        let commits: Vec<RawCommit> = serde_json::from_value(json!([
            // From the click: no previous boundary.
            {"t": 6.0, "ms": 1.0, "post": 10.0},
            // From the previous commit's passive end.
            {"t": 14.0, "ms": 2.0},
            // From the previous commit's hook plus its walk: 14 + 2.
            {"t": 25.0, "ms": 1.0},
        ]))
        .unwrap();
        let timings = commit_timings(&commits, &[]);
        assert_eq!(
            timings.iter().map(|t| t.span_ms).collect::<Vec<_>>(),
            vec![6.0, 4.0, 9.0]
        );
        assert!(timings.iter().all(|t| t.react_ms.is_none()));
        assert_eq!(timings[0].react_or_span(), 6.0);
        assert_eq!(timings[0].passive_ms, Some(3.0));
        assert_eq!(timings[1].passive_ms, None);
    }

    #[test]
    fn click_task_takes_microtasks_descended_from_the_click() {
        let tasks = vec![
            task("click", "", "", -1, 0.0, 30.0),
            task("microtask", "flush", "", 0, 30.0, 40.0),
            task("promise", "then", "", 1, 40.0, 41.0),
            task("frame", "measure", "", 0, 50.0, 52.0),
            // Queued by a frame callback: a later task's microtask.
            task("microtask", "flush", "", 3, 52.0, 53.0),
            task("timeout", "tick", "", 0, 60.0, 61.0),
        ];
        let set = click_task(&tasks);
        let mut members: Vec<usize> = set.into_iter().collect();
        members.sort_unstable();
        assert_eq!(members, vec![0, 1, 2]);

        let commits: Vec<RawCommit> = serde_json::from_value(json!([
            {"t": 35.0, "task": 1, "renderStart": 31.0},
            {"t": 51.0, "task": 3, "renderStart": 50.0},
        ]))
        .unwrap();
        let sum = task_commits(&commits, &tasks, &[], "click");
        assert_eq!(sum.commits, 1);
        assert_eq!(sum.react_ms, 4.0);
        assert_eq!(sum.span_ms, 35.0);
    }

    #[test]
    fn the_press_and_the_click_are_counted_apart() {
        // The press runs first; the release is a task later.
        let tasks = vec![
            task("press", "press", "", -1, 0.0, 20.0),
            task("microtask", "flush", "", 0, 20.0, 24.0),
            task("click", "release", "", -1, 25.0, 30.0),
            task("microtask", "flush", "", 2, 30.0, 31.0),
        ];
        let mut press: Vec<usize> = gesture_task(&tasks, "press").into_iter().collect();
        press.sort_unstable();
        assert_eq!(press, vec![0, 1]);
        let mut click: Vec<usize> = click_task(&tasks).into_iter().collect();
        click.sort_unstable();
        assert_eq!(click, vec![2, 3]);

        let commits: Vec<RawCommit> = serde_json::from_value(json!([
            {"t": 22.0, "task": 1, "renderStart": 21.0},
        ]))
        .unwrap();
        assert_eq!(task_commits(&commits, &tasks, &[], "press").commits, 1);
        assert_eq!(task_commits(&commits, &tasks, &[], "click").commits, 0);
    }

    #[test]
    fn causes_condense_to_function_names() {
        assert_eq!(
            cause_label(
                "store",
                "tugTellReact@index-abc.js:1:200 < notify@index-abc.js:2:10 < setKeyCard@index-abc.js:3:4 < activateCard@x.js:9:9 < raiseCard@y.js:1:1"
            ),
            "notify < setKeyCard < activateCard"
        );
        assert_eq!(
            cause_label(
                "flushSync",
                "flushSync@a.js:1:1 < transferFocusForActivation@b.js:2:2 < raiseCard@c.js:3:3"
            ),
            "flushSync: transferFocusForActivation < raiseCard"
        );
        // The release bundle: the door's frame is anonymous or minified, and
        // so is every top-level function; only methods keep their names.
        assert_eq!(
            cause_label(
                "store",
                "@index-x.js:2:17528 < touch@index-x.js:3:70894 < setKeyCard@index-x.js:3:55610 < @index-x.js:78:1 < notify@index-x.js:327:3"
            ),
            "touch < setKeyCard < notify"
        );
        assert_eq!(
            cause_label(
                "flushSync",
                "Wm@index-x.js:2:1 < Gs@index-x.js:3:1 < @index-x.js:323:2 < i@index-x.js:4:3"
            ),
            "flushSync: Gs < i"
        );
        let commits: Vec<RawCommit> =
            serde_json::from_value(json!([{"t": 5.0, "renderStart": 3.0}])).unwrap();
        assert_eq!(commit_timings(&commits, &[])[0].causes, "(local state)");
        let tells = vec![
            tell(1.0, "store", "tugTellReact@d.js:1:1 < notify@a.js:1:1"),
            tell(2.0, "store", "tugTellReact@d.js:1:1 < notify@a.js:1:1"),
        ];
        assert_eq!(commit_timings(&commits, &tells)[0].causes, "notify ×2");
    }

    #[test]
    fn the_summary_spans_every_click() {
        let a = reduce(&json!({
            "frames": [34.0, 50.0], "beats": [4.0, 216.0, 260.0, 264.0],
            "settle": [[31.0, true], [444.0, false]], "moved": true
        }));
        let b = reduce(&json!({
            "frames": [41.0, 57.0, 400.0], "beats": [4.0, 230.0, 234.0, 260.0, 263.0],
            "settle": [[35.0, true], [458.0, false]], "moved": false
        }));
        let s = summarize(&[a, b]);
        assert_eq!(s.clicks, 2);
        assert_eq!(s.moved, 1);
        assert_eq!(
            s.first_frame_ms,
            Some(Span {
                min: 34.0,
                max: 41.0
            })
        );
        assert_eq!(
            s.lead_block_ms,
            Some(Span {
                // No pre-roll, so the clamp: 208 + 40 straddling the end;
                // 222 + 22.
                min: 244.0,
                max: 248.0
            })
        );
        assert_eq!(
            s.settle_on_ms,
            Some(Span {
                min: 31.0,
                max: 35.0
            })
        );
        assert_eq!(
            s.settle_off_ms,
            Some(Span {
                min: 444.0,
                max: 458.0
            })
        );
        assert_eq!(s.clicks_with_long_frames, 1);
        assert_eq!(
            s.long_frame_gap_ms,
            Some(Span {
                min: 343.0,
                max: 343.0
            })
        );
    }
}

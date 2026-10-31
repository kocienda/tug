//! The recipes over the arc record.
//!
//! The branch is gone at a join and the log is what remains, so this reads the
//! log and keeps a joined arc's newest generation.

use std::collections::BTreeMap;

use chrono::{DateTime, Days, Local, NaiveDate};
use serde_json::{Map, Value, json};
use tugarc_core::log::{is_terminal, split_log_line};
use tugarc_core::timeline::{ArcTimeline, StepEnd, arcs_newest_first, newest_arc, timeline_for};
use tuggraphics::chart::format::Format;
use tuggraphics::chart::spec::{MAX_LABEL, MAX_ROWS, MAX_SERIES};
use tugtool_core::paths::arc_log_path_at;

use crate::commits::{labels, week_axis};
use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, clip_back, clip_front,
};

/// A weekly bucket needs weeks to show, so its chart reads a quarter.
const DEFAULT_ARCS_DAYS: u32 = 90;
const DEFAULT_STAGE_ARCS: usize = 8;
/// Stages in the order an arc walks them; any other sits after these.
const STAGE_ORDER: [&str; 4] = ["Devise", "Review", "Implement", "Audit"];

/// One row of the chart, on a timeline in milliseconds.
#[derive(Debug)]
struct SpanRow {
    label: String,
    start_ms: u64,
    end_ms: u64,
    status: Option<&'static str>,
}

/// A stage as the chart names it: the log's `devise` reads `Devise`.
fn stage_label(stage: &str) -> String {
    let mut chars = stage.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The rows of `timeline` with `now_ms` closing whatever is still open: a stage
/// runs to the next one, a step's status comes from how it ended.
fn stage_rows(timeline: &ArcTimeline, now_ms: u64) -> Vec<SpanRow> {
    timeline
        .stages
        .iter()
        .enumerate()
        .map(|(i, stage)| SpanRow {
            label: stage_label(&stage.stage),
            start_ms: stage.at_ms,
            end_ms: timeline
                .stages
                .get(i + 1)
                .map(|next| next.at_ms)
                .or(timeline.done_at_ms)
                .unwrap_or(now_ms),
            status: None,
        })
        .collect()
}

fn step_rows(timeline: &ArcTimeline, now_ms: u64) -> Vec<SpanRow> {
    let mut rows: Vec<SpanRow> = timeline
        .steps
        .iter()
        .flat_map(|step| {
            // A step's title is the plan's heading, and a chart label draws
            // its markup as the characters they are.
            let number = format!("{}/{}", step.n, step.total);
            let label = step
                .title
                .as_deref()
                .map(|title| format!("{number} {}", title.replace('`', "")))
                .unwrap_or(number);
            step.spans.iter().map(move |span| SpanRow {
                label: label.clone(),
                start_ms: span.start_ms,
                end_ms: span.end_ms.unwrap_or(now_ms),
                status: match (span.end_ms, step.end) {
                    (None, _) => Some("accent"),
                    (Some(_), Some(StepEnd::Done)) => Some("good"),
                    (Some(_), Some(StepEnd::Withdrawn | StepEnd::Reset)) => Some("bad"),
                    // An earlier span of a step reopened and still open.
                    (Some(_), None) => None,
                },
            })
        })
        .collect();
    rows.sort_by_key(|row| row.start_ms);
    rows
}

/// A built chart, and what the summary line reports of it.
struct ArcChart {
    spec: Value,
    stages: usize,
    spans: usize,
    /// The plan's step count, and how many of its steps are done.
    total: u32,
    finished: usize,
    left_out: usize,
}

/// One span per stage and per step span, relative to the arc's first moment
/// and in time order, so an audit reads after the steps it followed. Past the
/// row limit every stage stays and the newest step spans fill the rest. `None`
/// when the arc has no span at all.
fn arc_chart(name: &str, timeline: &ArcTimeline, now_ms: u64) -> Option<ArcChart> {
    let mut stages = stage_rows(timeline, now_ms);
    let mut steps = step_rows(timeline, now_ms);
    let origin = stages.iter().chain(&steps).map(|row| row.start_ms).min()?;
    let last = stages.iter().chain(&steps).map(|row| row.end_ms).max()?;
    let before = stages.len() + steps.len();
    if stages.len() > MAX_ROWS {
        stages.drain(..stages.len() - MAX_ROWS);
    }
    let room = MAX_ROWS - stages.len();
    if steps.len() > room {
        steps.drain(..steps.len() - room);
    }
    let left_out = before - stages.len() - steps.len();

    let secs = |ms: u64| ms.saturating_sub(origin) as f64 / 1000.0;
    // A stable sort, so a step opened the moment its stage began reads under it.
    let mut rows: Vec<&SpanRow> = stages.iter().chain(&steps).collect();
    rows.sort_by_key(|row| row.start_ms);
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let start = secs(row.start_ms);
            let mut item = Map::new();
            item.insert("label".to_string(), json!(clip_back(&row.label, MAX_LABEL)));
            item.insert("start".to_string(), json!(start));
            item.insert("end".to_string(), json!(secs(row.end_ms).max(start)));
            if let Some(status) = row.status {
                item.insert("status".to_string(), json!(status));
            }
            Value::Object(item)
        })
        .collect();
    let total = timeline
        .steps
        .iter()
        .map(|step| step.total)
        .max()
        .unwrap_or(0);
    let finished = timeline
        .steps
        .iter()
        .filter(|step| step.end == Some(StepEnd::Done))
        .count();
    let duration = Format::Secs.apply(secs(last));
    let noun = if total == 1 { "step" } else { "steps" };
    let title = clip_front(
        &format!("Arc {name}: {total} {noun}, {duration}"),
        MAX_LABEL,
    );
    Some(ArcChart {
        stages: stages.len(),
        spans: steps.len(),
        total,
        finished,
        left_out,
        spec: json!({
            "tugchart": 1,
            "form": "spans",
            "title": title,
            "unit": "seconds",
            "format": "secs",
            "items": items,
        }),
    })
}

pub(crate) fn arc_timeline(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    let no_data = |summary: String| Ok(RecipeOutcome::NoData { summary });
    let log = match read_log(ctx) {
        Ok(log) => log,
        Err(answer) => return Ok(answer),
    };
    let Some(name) = args.subjects.first().cloned().or_else(|| newest_arc(&log)) else {
        return no_data(format!(
            "no arcs in the log for {}",
            ctx.repo_root.display()
        ));
    };
    let Some(timeline) = timeline_for(&log, &name) else {
        return no_data(format!("no arc named {name} in the log"));
    };
    let now_ms = u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0);
    let Some(chart) = arc_chart(&name, &timeline, now_ms) else {
        return no_data(format!("arc {name} has no stages or steps recorded"));
    };
    let mut spec = chart.spec;
    apply_title(&mut spec, args);
    let left_out = if chart.left_out == 0 {
        String::new()
    } else {
        format!("; left out: {} older step span(s)", chart.left_out)
    };
    let summary = format!(
        "arc {name}: {} of {} step(s) finished, {} stage(s), {} step span(s){left_out}",
        chart.finished, chart.total, chart.stages, chart.spans
    );
    Ok(RecipeOutcome::Chart { summary, spec })
}

/// The project's arc log, or the answer to give when it has no such thing.
fn read_log(ctx: &RecipeContext) -> Result<String, RecipeOutcome> {
    std::fs::read_to_string(arc_log_path_at(&ctx.paths, &ctx.repo_root)).map_err(|_| {
        RecipeOutcome::NoData {
            summary: format!("no arc log for {}", ctx.repo_root.display()),
        }
    })
}

/// Arcs started, joined and discarded in one week.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct WeekCounts {
    started: u32,
    joined: u32,
    discarded: u32,
}

/// What the log says happened on each local day from `since`, which is what
/// a weekly bucket is then read from.
fn arc_events(log: &str, since: NaiveDate) -> BTreeMap<NaiveDate, WeekCounts> {
    let mut days: BTreeMap<NaiveDate, WeekCounts> = BTreeMap::new();
    for (timestamp, _, marker, note) in log.lines().filter_map(split_log_line) {
        let started = marker == "arc-start";
        if !started && !is_terminal(marker, note) {
            continue;
        }
        let Ok(at) = DateTime::parse_from_rfc3339(timestamp) else {
            continue;
        };
        let day = at.with_timezone(&Local).date_naive();
        if day < since {
            continue;
        }
        let counts = days.entry(day).or_default();
        if started {
            counts.started += 1;
        } else if marker == "discarded" || marker == "released" {
            counts.discarded += 1;
        } else {
            counts.joined += 1;
        }
    }
    days
}

/// A built count of arcs, and what the summary line reports of it.
struct ArcsChart {
    spec: Value,
    weeks: usize,
    totals: WeekCounts,
}

/// Arcs per week as a stacked bar, empty weeks included. `None` when nothing
/// happened in the window.
fn arcs_chart(days: &BTreeMap<NaiveDate, WeekCounts>, subtitle: &str) -> Option<ArcsChart> {
    let (axis, _) = week_axis(days.keys().copied());
    if axis.is_empty() {
        return None;
    }
    let mut weeks = vec![WeekCounts::default(); axis.len()];
    let mut totals = WeekCounts::default();
    for (day, counts) in days {
        let Some(week) = axis.iter().rposition(|start| start <= day) else {
            continue;
        };
        for slot in [&mut weeks[week], &mut totals] {
            slot.started += counts.started;
            slot.joined += counts.joined;
            slot.discarded += counts.discarded;
        }
    }
    let read = |pick: fn(&WeekCounts) -> u32| -> Vec<u32> { weeks.iter().map(pick).collect() };
    Some(ArcsChart {
        weeks: axis.len(),
        totals,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "layout": "stacked",
            "title": "Arcs per week",
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": "arcs",
            "format": "int",
            "categories": labels(&axis),
            "series": [
                { "name": "started", "values": read(|w| w.started) },
                { "name": "joined", "values": read(|w| w.joined), "role": "good" },
                { "name": "discarded", "values": read(|w| w.discarded), "role": "bad" },
            ],
        }),
    })
}

pub(crate) fn arcs(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    let log = match read_log(ctx) {
        Ok(log) => log,
        Err(answer) => return Ok(answer),
    };
    let days = args.days.unwrap_or(DEFAULT_ARCS_DAYS);
    let range = format!("last {days} days");
    let today = Local::now().date_naive();
    let since = today
        .checked_sub_days(Days::new(u64::from(days.saturating_sub(1))))
        .unwrap_or(NaiveDate::MIN);
    let Some(chart) = arcs_chart(&arc_events(&log, since), &range) else {
        return Ok(RecipeOutcome::NoData {
            summary: format!("no arcs started, joined or discarded, {range}"),
        });
    };
    let mut spec = chart.spec;
    apply_title(&mut spec, args);
    let summary = format!(
        "{} started, {} joined, {} discarded over {} week(s), {range}",
        chart.totals.started, chart.totals.joined, chart.totals.discarded, chart.weeks
    );
    Ok(RecipeOutcome::Chart { summary, spec })
}

/// The last moment the log recorded of `timeline`. An arc nobody finished has
/// no end to read, and running its last stage up to now would let one abandoned
/// arc flatten every other row.
fn last_moment(timeline: &ArcTimeline) -> u64 {
    if let Some(done) = timeline.done_at_ms {
        return done;
    }
    let stages = timeline.stages.iter().map(|stage| stage.at_ms);
    let marks = timeline.marks.iter().map(|mark| mark.at_ms);
    let spans = timeline.steps.iter().flat_map(|step| &step.spans);
    let span_ends = spans.flat_map(|span| [Some(span.start_ms), span.end_ms].into_iter().flatten());
    stages.chain(marks).chain(span_ends).max().unwrap_or(0)
}

/// One row per arc, of the milliseconds it spent in each stage.
fn stage_totals(timeline: &ArcTimeline) -> BTreeMap<String, u64> {
    let mut totals: BTreeMap<String, u64> = BTreeMap::new();
    for row in stage_rows(timeline, last_moment(timeline)) {
        *totals.entry(row.label).or_insert(0) += row.end_ms.saturating_sub(row.start_ms);
    }
    totals
}

/// A horizontal stacked bar, one row per arc in the order given and one series
/// per stage in the order an arc walks them. `None` with no arc to draw.
fn arc_stages_chart(arcs: &[(String, ArcTimeline)]) -> Option<Value> {
    if arcs.is_empty() {
        return None;
    }
    let rows: Vec<BTreeMap<String, u64>> = arcs.iter().map(|(_, t)| stage_totals(t)).collect();
    let mut stages: Vec<String> = STAGE_ORDER.iter().map(|stage| stage.to_string()).collect();
    stages.retain(|stage| rows.iter().any(|row| row.contains_key(stage)));
    for name in rows.iter().flat_map(|row| row.keys()) {
        if !stages.contains(name) {
            stages.push(name.clone());
        }
    }
    stages.truncate(MAX_SERIES);
    let series: Vec<Value> = stages
        .iter()
        .map(|stage| {
            let secs: Vec<f64> = rows
                .iter()
                .map(|row| row.get(stage).copied().unwrap_or(0) as f64 / 1000.0)
                .collect();
            json!({ "name": stage, "values": secs })
        })
        .collect();
    let categories: Vec<String> = arcs
        .iter()
        .map(|(name, _)| clip_back(name, MAX_LABEL))
        .collect();
    Some(json!({
        "tugchart": 1,
        "form": "bar",
        "orient": "horizontal",
        "layout": "stacked",
        "title": format!("Time in each stage, newest {} arc(s)", arcs.len()),
        "unit": "wall time",
        "format": "secs",
        "categories": categories,
        "series": series,
    }))
}

pub(crate) fn arc_stages(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    let log = match read_log(ctx) {
        Ok(log) => log,
        Err(answer) => return Ok(answer),
    };
    let limit = args.limit.unwrap_or(DEFAULT_STAGE_ARCS).clamp(1, MAX_ROWS);
    // An arc with no stage recorded has nothing to compare, and does not take
    // a row from one that has.
    let arcs: Vec<(String, ArcTimeline)> = arcs_newest_first(&log)
        .into_iter()
        .filter_map(|name| {
            let timeline = timeline_for(&log, &name)?;
            (!timeline.stages.is_empty()).then_some((name, timeline))
        })
        .take(limit)
        .collect();
    let Some(mut spec) = arc_stages_chart(&arcs) else {
        return Ok(RecipeOutcome::NoData {
            summary: format!("no arc stages in the log for {}", ctx.repo_root.display()),
        });
    };
    apply_title(&mut spec, args);
    let total: u64 = arcs
        .iter()
        .flat_map(|(_, timeline)| stage_totals(timeline).into_values())
        .sum();
    let summary = format!(
        "{} newest arc(s), {} of wall time in their stages",
        arcs.len(),
        Format::Secs.apply(total as f64 / 1000.0)
    );
    Ok(RecipeOutcome::Chart { summary, spec })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::test_support::{assert_valid, context_at};

    fn line(at_secs: u32, arc: &str, marker: &str, note: &str) -> String {
        format!(
            "2026-10-27T16:{:02}:{:02}.000Z  {arc}  {marker}  {note}\n",
            at_secs / 60,
            at_secs % 60
        )
    }

    fn ms(at_secs: u64) -> u64 {
        let base = chrono::DateTime::parse_from_rfc3339("2026-10-27T16:00:00.000Z").unwrap();
        base.timestamp_millis() as u64 + at_secs * 1000
    }

    #[test]
    fn spans_run_from_the_first_stage_and_steps_read_by_how_they_ended() {
        let log = [
            line(0, "a", "arc-start", "brief.md"),
            line(10, "a", "arc-stage", "devise s1 opus"),
            line(70, "a", "arc-stage", "implement s2 -"),
            line(80, "a", "step-start", "1/3 Step 1: First"),
            line(100, "a", "step-done", "1/3 aaa"),
            line(110, "a", "step-start", "2/3 Step 2: Second"),
            line(120, "a", "step-withdrawn", "2/3"),
            line(130, "a", "step-start", "3/3"),
            line(150, "a", "arc-stage", "audit s3 opus"),
            line(200, "a", "abc", "joined via card"),
        ]
        .concat();
        let timeline = timeline_for(&log, "a").unwrap();
        let chart = arc_chart("a", &timeline, ms(9999)).unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.stages, 3);
        assert_eq!(chart.spans, 3);
        assert_eq!(chart.total, 3);
        assert_eq!(chart.finished, 1);
        assert_eq!(chart.spec["title"], "Arc a: 3 steps, 2h46m");
        assert_eq!(
            chart.spec["items"],
            json!([
                { "label": "Devise", "start": 0.0, "end": 60.0 },
                { "label": "Implement", "start": 60.0, "end": 140.0 },
                { "label": "1/3 First", "start": 70.0, "end": 90.0, "status": "good" },
                { "label": "2/3 Second", "start": 100.0, "end": 110.0, "status": "bad" },
                { "label": "3/3", "start": 120.0, "end": 9989.0, "status": "accent" },
                { "label": "Audit", "start": 140.0, "end": 190.0 },
            ])
        );
    }

    #[test]
    fn past_the_row_limit_every_stage_stays_and_the_oldest_steps_go() {
        let mut log = line(0, "a", "arc-stage", "implement s1 -");
        for k in 0..MAX_ROWS as u32 {
            log.push_str(&line(
                10 + k,
                "a",
                "step-start",
                &format!("{}/99 Step {}: T{}", k + 1, k + 1, k),
            ));
        }
        let timeline = timeline_for(&log, "a").unwrap();
        let chart = arc_chart("a", &timeline, ms(3000)).unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.stages, 1);
        assert_eq!(chart.spans, MAX_ROWS - 1);
        assert_eq!(chart.left_out, 1);
        assert_eq!(chart.spec["items"][0]["label"], "Implement");
        assert_eq!(chart.spec["items"][1]["label"], "2/99 T1");
    }

    #[test]
    fn a_step_title_loses_the_plans_markup() {
        let log = [
            line(0, "a", "arc-stage", "implement s1 -"),
            line(10, "a", "step-start", "1/1 Step 1: The `viz` skill"),
        ]
        .concat();
        let timeline = timeline_for(&log, "a").unwrap();
        let chart = arc_chart("a", &timeline, ms(60)).unwrap();
        assert_eq!(chart.spec["items"][1]["label"], "1/1 The viz skill");
    }

    #[test]
    fn a_long_step_title_keeps_its_number_and_a_lone_step_is_singular() {
        let long = "x".repeat(MAX_LABEL + 10);
        let log = [
            line(0, "a", "arc-stage", "implement s1 -"),
            line(10, "a", "step-start", &format!("1/1 Step 1: {long}")),
            line(70, "a", "step-done", "1/1 aaa"),
        ]
        .concat();
        let timeline = timeline_for(&log, "a").unwrap();
        let chart = arc_chart("a", &timeline, ms(90)).unwrap();
        assert_valid(&chart.spec);
        let label = chart.spec["items"][1]["label"].as_str().unwrap();
        assert!(label.starts_with("1/1 x"), "{label}");
        assert!(label.ends_with('…'), "{label}");
        assert_eq!(chart.spec["title"], "Arc a: 1 step, 1m30s");
        assert_eq!(chart.finished, 1);
    }

    #[test]
    fn an_arc_with_nothing_recorded_has_no_chart() {
        let log = line(0, "a", "arc-start", "brief.md");
        let timeline = timeline_for(&log, "a").unwrap();
        assert!(arc_chart("a", &timeline, ms(1)).is_none());
    }

    #[test]
    fn a_project_with_no_log_has_no_data() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        for name in ["arc-timeline", "arcs", "arc-stages"] {
            let outcome = crate::find(name)
                .unwrap()
                .run(&ctx, &RecipeArgs::default())
                .unwrap();
            assert!(matches!(outcome, RecipeOutcome::NoData { .. }), "{name}");
        }
    }

    fn at(day: &str, arc: &str, marker: &str, note: &str) -> String {
        format!("{day}T12:00:00.000Z  {arc}  {marker}  {note}\n")
    }

    fn date(day: &str) -> NaiveDate {
        NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn arcs_count_by_week_and_every_terminal_spelling_counts() {
        // Wednesdays, three weeks apart at the ends, so the zero week is filled.
        let log = [
            at("2026-09-30", "too-old", "arc-start", "brief.md"),
            at("2026-10-07", "a", "arc-start", "brief.md"),
            at("2026-10-07", "b", "arc-start", "brief.md"),
            at("2026-10-07", "a", "arc-stage", "implement s1 -"),
            at("2026-10-07", "a", "7d16f2ac6", "joined via card"),
            at("2026-10-21", "b", "discarded", ""),
            at("2026-10-21", "c", "arc-start", "brief.md"),
            at("2026-10-21", "c", "released", ""),
            at("2026-10-21", "d", "abc", "joined"),
        ]
        .concat();
        let days = arc_events(&log, date("2026-10-01"));
        let chart = arcs_chart(&days, "last 30 days").unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.weeks, 3);
        assert_eq!(
            chart.totals,
            WeekCounts {
                started: 3,
                joined: 2,
                discarded: 2
            }
        );
        assert_eq!(chart.spec["layout"], "stacked");
        assert_eq!(
            chart.spec["categories"],
            json!(["2026-10-05", "2026-10-12", "2026-10-19"])
        );
        let series = &chart.spec["series"];
        assert_eq!(series[0]["name"], "started");
        assert_eq!(series[0]["values"], json!([2, 0, 1]));
        assert_eq!(series[1]["name"], "joined");
        assert_eq!(series[1]["role"], "good");
        assert_eq!(series[1]["values"], json!([1, 0, 1]));
        assert_eq!(series[2]["name"], "discarded");
        assert_eq!(series[2]["role"], "bad");
        assert_eq!(series[2]["values"], json!([0, 0, 2]));
        assert!(arcs_chart(&BTreeMap::new(), "s").is_none());
    }

    #[test]
    fn arc_stages_sums_each_stage_in_walking_order_and_an_abandoned_arc_stops_at_its_last_line() {
        let log = [
            line(0, "done", "arc-start", "brief.md"),
            line(0, "done", "arc-stage", "audit s3 opus"),
            line(10, "done", "arc-stage", "implement s1 -"),
            line(70, "done", "arc-stage", "implement s2 -"),
            line(130, "done", "abc", "joined via card"),
            line(200, "left", "arc-start", "brief.md"),
            line(200, "left", "arc-stage", "implement s4 -"),
            line(230, "left", "step-start", "1/2 Step 1: First"),
        ]
        .concat();
        let arcs: Vec<(String, ArcTimeline)> = arcs_newest_first(&log)
            .into_iter()
            .map(|name| {
                let timeline = timeline_for(&log, &name).unwrap();
                (name, timeline)
            })
            .collect();
        let spec = arc_stages_chart(&arcs).unwrap();
        assert_valid(&spec);
        assert_eq!(spec["orient"], "horizontal");
        assert_eq!(spec["layout"], "stacked");
        assert_eq!(spec["categories"], json!(["left", "done"]));
        assert_eq!(spec["series"][0]["name"], "Implement");
        assert_eq!(spec["series"][0]["values"], json!([30.0, 120.0]));
        assert_eq!(spec["series"][1]["name"], "Audit");
        assert_eq!(spec["series"][1]["values"], json!([0.0, 10.0]));
        assert!(arc_stages_chart(&[]).is_none());
    }

    #[test]
    fn arc_stages_gives_no_row_to_an_arc_with_no_stage() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let mut ctx = context_at(dir.path());
        ctx.paths = tugcore::instance::Paths::under(&data);
        let path = arc_log_path_at(&ctx.paths, &ctx.repo_root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            [
                line(0, "real", "arc-start", "brief.md"),
                line(0, "real", "arc-stage", "implement s1 -"),
                line(60, "real", "abc", "joined via card"),
                line(70, "bare", "arc-start", "brief.md"),
            ]
            .concat(),
        )
        .unwrap();
        let args = RecipeArgs {
            limit: Some(1),
            ..Default::default()
        };
        let outcome = crate::find("arc-stages").unwrap().run(&ctx, &args).unwrap();
        let RecipeOutcome::Chart { spec, summary } = outcome else {
            panic!("expected a chart");
        };
        assert_eq!(spec["categories"], json!(["real"]));
        assert_eq!(
            summary,
            "1 newest arc(s), 1m00s of wall time in their stages"
        );
    }
}

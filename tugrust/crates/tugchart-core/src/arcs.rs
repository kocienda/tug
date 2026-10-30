//! The recipe over the arc record.
//!
//! The branch is gone at a join and the log is what remains, so this reads the
//! log and keeps a joined arc's newest generation.

use serde_json::{Map, Value, json};
use tugarc_core::timeline::{ArcTimeline, StepEnd, newest_arc, timeline_for};
use tuggraphics::chart::spec::{MAX_LABEL, MAX_ROWS};
use tugtool_core::paths::arc_log_path_at;

use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, clip_front,
};

/// One row of the chart, on a timeline in milliseconds.
#[derive(Debug)]
struct SpanRow {
    label: String,
    start_ms: u64,
    end_ms: u64,
    status: Option<&'static str>,
}

/// The rows of `timeline` with `now_ms` closing whatever is still open: a stage
/// runs to the next one, a step's status comes from how it ended.
fn stage_rows(timeline: &ArcTimeline, now_ms: u64) -> Vec<SpanRow> {
    timeline
        .stages
        .iter()
        .enumerate()
        .map(|(i, stage)| SpanRow {
            label: stage.stage.clone(),
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
            let label = step
                .title
                .as_deref()
                .map(|title| title.replace('`', ""))
                .unwrap_or_else(|| format!("step {}", step.n));
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
    steps: usize,
    left_out: usize,
}

/// One span per stage and per step span, relative to the arc's first moment.
/// Past the row limit every stage stays and the newest step spans fill the
/// rest. `None` when the arc has no span at all.
fn arc_chart(name: &str, timeline: &ArcTimeline, now_ms: u64) -> Option<ArcChart> {
    let mut stages = stage_rows(timeline, now_ms);
    let mut steps = step_rows(timeline, now_ms);
    let origin = stages.first().or(steps.first()).map(|row| row.start_ms)?;
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
    let items: Vec<Value> = stages
        .iter()
        .chain(&steps)
        .map(|row| {
            let start = secs(row.start_ms);
            let mut item = Map::new();
            item.insert(
                "label".to_string(),
                json!(clip_front(&row.label, MAX_LABEL)),
            );
            item.insert("start".to_string(), json!(start));
            item.insert("end".to_string(), json!(secs(row.end_ms).max(start)));
            if let Some(status) = row.status {
                item.insert("status".to_string(), json!(status));
            }
            Value::Object(item)
        })
        .collect();
    let title = clip_front(&format!("Arc {name}: stages and steps"), MAX_LABEL);
    Some(ArcChart {
        stages: stages.len(),
        steps: steps.len(),
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
    let Ok(log) = std::fs::read_to_string(arc_log_path_at(&ctx.paths, &ctx.repo_root)) else {
        return no_data(format!("no arc log for {}", ctx.repo_root.display()));
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
        "arc {name}: {} stage(s), {} step span(s){left_out}",
        chart.stages, chart.steps
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
            line(200, "a", "abc", "joined via card"),
        ]
        .concat();
        let timeline = timeline_for(&log, "a").unwrap();
        let chart = arc_chart("a", &timeline, ms(9999)).unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.stages, 2);
        assert_eq!(chart.steps, 3);
        assert_eq!(chart.spec["title"], "Arc a: stages and steps");
        assert_eq!(
            chart.spec["items"],
            json!([
                { "label": "devise", "start": 0.0, "end": 60.0 },
                { "label": "implement", "start": 60.0, "end": 190.0 },
                { "label": "First", "start": 70.0, "end": 90.0, "status": "good" },
                { "label": "Second", "start": 100.0, "end": 110.0, "status": "bad" },
                { "label": "step 3", "start": 120.0, "end": 9989.0, "status": "accent" },
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
        assert_eq!(chart.steps, MAX_ROWS - 1);
        assert_eq!(chart.left_out, 1);
        assert_eq!(chart.spec["items"][0]["label"], "implement");
        assert_eq!(chart.spec["items"][1]["label"], "T1");
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
        assert_eq!(chart.spec["items"][1]["label"], "The viz skill");
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
        let outcome = crate::find("arc-timeline")
            .unwrap()
            .run(&ctx, &RecipeArgs::default())
            .unwrap();
        assert!(matches!(outcome, RecipeOutcome::NoData { .. }));
    }
}

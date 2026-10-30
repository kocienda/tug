//! The recipe over the report-gaps record.

use serde_json::{Value, json};
use tugcore::report_gaps::{GapSummary, summarize};
use tuggraphics::chart::spec::{MAX_LABEL, MAX_ROWS};

use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, clip_front,
};

const DEFAULT_LIMIT: usize = 12;

/// The heads worth a report, largest total first. A stalled call is a hang
/// rather than a report that is due, so it is not among them.
fn ranked(summaries: Vec<GapSummary>) -> Vec<GapSummary> {
    let mut gaps: Vec<GapSummary> = summaries.into_iter().filter(|s| !s.stalled()).collect();
    gaps.sort_by_key(|s| std::cmp::Reverse(s.total_ms));
    gaps
}

fn gaps_chart(gaps: &[GapSummary]) -> Value {
    let categories: Vec<String> = gaps
        .iter()
        .map(|gap| clip_front(&gap.head, MAX_LABEL))
        .collect();
    let values: Vec<f64> = gaps
        .iter()
        .map(|gap| gap.total_ms as f64 / 1000.0)
        .collect();
    json!({
        "tugchart": 1,
        "form": "bar",
        "orient": "horizontal",
        "title": "Long calls that reported nothing",
        "unit": "wall time",
        "format": "secs",
        "categories": categories,
        "series": [{ "name": "wall time", "values": values }],
    })
}

pub(crate) fn gaps(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    let gaps = ranked(summarize(&ctx.report_gaps));
    if gaps.is_empty() {
        return Ok(RecipeOutcome::NoData {
            summary: "no long calls recorded that reported nothing".to_string(),
        });
    }
    let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_ROWS);
    let kept = &gaps[..gaps.len().min(limit)];
    let mut spec = gaps_chart(kept);
    apply_title(&mut spec, args);
    let calls: i64 = kept.iter().map(|gap| gap.count).sum();
    let left_out = gaps.len() - kept.len();
    let left_out = if left_out == 0 {
        String::new()
    } else {
        format!("; left out: {left_out} smaller head(s)")
    };
    let summary = format!(
        "{} command head(s), {calls} long call(s) that reported nothing{left_out}",
        kept.len()
    );
    Ok(RecipeOutcome::Chart { summary, spec })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::test_support::{assert_valid, context_at};

    fn summary(head: &str, total_ms: i64, median_ms: i64, max_ms: i64) -> GapSummary {
        GapSummary {
            head: head.to_string(),
            count: 2,
            total_ms,
            last_ended_at_ms: 0,
            max_ms,
            median_ms,
            calls: 2,
            last_command: head.to_string(),
            last_project_dir: "/p".to_string(),
        }
    }

    #[test]
    fn stalled_heads_are_left_out_and_the_rest_read_by_total() {
        let rows = ranked(vec![
            summary("cargo build", 40_000, 25_000, 30_000),
            // Quick at the median and one call that hung.
            summary("git status", 900_000, 100, 899_000),
            summary("just ci", 90_000, 45_000, 60_000),
        ]);
        let heads: Vec<&str> = rows.iter().map(|r| r.head.as_str()).collect();
        assert_eq!(heads, ["just ci", "cargo build"]);

        let spec = gaps_chart(&rows);
        assert_valid(&spec);
        assert_eq!(spec["orient"], "horizontal");
        assert_eq!(spec["format"], "secs");
        assert_eq!(spec["series"][0]["values"], json!([90.0, 40.0]));
    }

    #[test]
    fn a_missing_record_has_no_data_and_stays_missing() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        let outcome = crate::find("gaps")
            .unwrap()
            .run(&ctx, &RecipeArgs::default())
            .unwrap();
        assert!(matches!(outcome, RecipeOutcome::NoData { .. }));
        assert!(!ctx.report_gaps.exists());
    }
}

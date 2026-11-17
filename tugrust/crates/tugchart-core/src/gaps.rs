//! The recipes over the report-gaps record.

use serde_json::{Value, json};
use tugcore::report_gaps::{GapRow, GapSummary, call_rows, gap_rows, summarize};
use tuggraphics::chart::format::Format;
use tuggraphics::chart::spec::{MAX_LABEL, MAX_ROWS, MAX_VALUES};

use crate::commits::{left_out_older, median, without_the_largest_tenth};
use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, binned, clip_front,
};
use crate::members::{Member, MemberKey, MemberTable, SourceArgs, stamp_source, until_for};
use crate::refs::{command_ref, one_line};

const DEFAULT_LIMIT: usize = 12;

/// The heads worth a report, largest total first. A stalled call is a hang
/// rather than a report that is due, so it is not among them.
fn ranked(summaries: Vec<GapSummary>) -> Vec<GapSummary> {
    let mut gaps: Vec<GapSummary> = summaries.into_iter().filter(|s| !s.stalled()).collect();
    gaps.sort_by_key(|s| std::cmp::Reverse(s.total_ms));
    gaps
}

/// A row's slot when a press should open its `n` commands: a count form,
/// since the spec is sourced and the commands are many and long; `null` for
/// a row with none.
fn command_count(n: usize) -> Value {
    if n == 0 {
        Value::Null
    } else {
        json!({ "kind": "command", "count": n })
    }
}

/// The heads as a horizontal bar. Each row's members are its gaps, newest
/// first, each the command as it ran and measured by its wall time, so a
/// press opens the calls the bar sums.
fn gaps_chart(gaps: &[GapSummary], rows: &[GapRow]) -> (Value, MemberTable) {
    let categories: Vec<String> = gaps
        .iter()
        .map(|gap| clip_front(&gap.head, MAX_LABEL))
        .collect();
    let values: Vec<f64> = gaps
        .iter()
        .map(|gap| gap.total_ms as f64 / 1000.0)
        .collect();
    let mut members = MemberTable::measured("wall time", "secs");
    let mut refs = Vec::with_capacity(gaps.len());
    for (i, gap) in gaps.iter().enumerate() {
        let set: Vec<Member> = rows
            .iter()
            .filter(|row| row.head == gap.head)
            .map(|row| Member::of(command_ref(&one_line(&row.command))).measured(secs(row.wall_ms)))
            .collect();
        refs.push(command_count(set.len()));
        members.set(MemberKey::Row(i), set);
    }
    let spec = json!({
        "tugchart": 1,
        "form": "bar",
        "orient": "horizontal",
        "title": "Long calls that reported nothing",
        "unit": "wall time",
        "format": "secs",
        "categories": categories,
        "series": [{ "name": "wall time", "values": values }],
        "refs": refs,
    });
    (spec, members)
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
    let (mut spec, members) = gaps_chart(kept, &gap_rows(&ctx.report_gaps));
    apply_title(&mut spec, args);
    stamp_source(
        &mut spec,
        "gaps",
        SourceArgs::until(&until_for(args)).with("limit", limit),
    );
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
    Ok(RecipeOutcome::Chart {
        summary,
        spec,
        members,
    })
}

fn secs(wall_ms: i64) -> f64 {
    wall_ms as f64 / 1000.0
}

/// Call times as a bar over the engine's own histogram bins, with its
/// summary and members, from `(head, wall_ms)` rows newest first. Calls run
/// from milliseconds to hours, so the longest tenth is named and not drawn:
/// at full range every other call would stand in one bin. Each bin's
/// members are its calls, quickest first, so a press opens them.
fn calls_chart(rows: &[(String, i64)]) -> Option<(String, Value, MemberTable)> {
    let kept: Vec<(&str, i64)> = rows
        .iter()
        .take(MAX_VALUES)
        .map(|(head, wall_ms)| (head.as_str(), (*wall_ms).max(0)))
        .collect();
    let times: Vec<u64> = kept.iter().map(|(_, wall_ms)| *wall_ms as u64).collect();
    let (_, cap) = without_the_largest_tenth(&times);
    let drawn: Vec<(&str, i64)> = kept
        .iter()
        .copied()
        .filter(|(_, wall_ms)| *wall_ms as u64 <= cap)
        .collect();
    let not_drawn = kept.len() - drawn.len();
    let tail = if not_drawn == 0 {
        String::new()
    } else {
        format!(
            "; {not_drawn} over {} not drawn",
            Format::Secs.apply(secs(cap as i64))
        )
    };
    let all: Vec<f64> = kept.iter().map(|(_, wall_ms)| secs(*wall_ms)).collect();
    let middle = Format::Secs.apply(median(&all).unwrap_or(0.0));
    let summary = format!(
        "{} call(s), median {middle}{tail}{}",
        kept.len(),
        left_out_older(rows.len() - kept.len(), "call")
    );
    let values: Vec<f64> = drawn.iter().map(|(_, wall_ms)| secs(*wall_ms)).collect();
    let (labels, bins) = binned(&values, "secs")?;
    let mut members = MemberTable::measured("wall time", "secs");
    let mut counts = Vec::with_capacity(bins.len());
    let mut refs = Vec::with_capacity(bins.len());
    for (row, bin) in bins.iter().enumerate() {
        let mut calls: Vec<(&str, i64)> = bin.iter().map(|&i| drawn[i]).collect();
        calls.sort_by_key(|(_, wall_ms)| *wall_ms);
        counts.push(calls.len());
        refs.push(command_count(calls.len()));
        let set = calls
            .into_iter()
            .map(|(head, wall_ms)| Member::of(command_ref(head)).measured(secs(wall_ms)))
            .collect();
        members.set(MemberKey::Row(row), set);
    }
    let spec = json!({
        "tugchart": 1,
        "form": "bar",
        "title": "Wall time of Bash calls",
        "subtitle": clip_front(&format!("newest {} calls{tail}", kept.len()), MAX_LABEL),
        "unit": "calls",
        "format": "int",
        "categories": labels,
        "series": [{ "name": "calls", "values": counts }],
        "refs": refs,
    });
    Some((summary, spec, members))
}

pub(crate) fn calls(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    // A source's `until` (whole seconds) re-reads the calls the chart drew:
    // every call appends to the record, so a fresh read would re-cut the
    // bins and a bin's label would answer other calls.
    let before_ms = args.until.as_deref().and_then(|until| {
        chrono::DateTime::parse_from_rfc3339(until)
            .ok()
            .map(|at| (at.timestamp() + 1) * 1000)
    });
    let Some((summary, mut spec, members)) = calls_chart(&call_rows(&ctx.report_gaps, before_ms))
    else {
        return Ok(RecipeOutcome::NoData {
            summary: "no call times recorded".to_string(),
        });
    };
    apply_title(&mut spec, args);
    stamp_source(&mut spec, "calls", SourceArgs::until(&until_for(args)));
    Ok(RecipeOutcome::Chart {
        summary,
        spec,
        members,
    })
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

        let gap = |head: &str, command: &str, wall_ms| GapRow {
            head: head.to_string(),
            command: command.to_string(),
            project_dir: "/p".to_string(),
            session_id: "s".to_string(),
            wall_ms,
            ended_at_ms: 0,
        };
        let record = [
            gap("just ci", "just ci", 30_000),
            gap("cargo build", "cargo build\n  --release", 40_000),
            gap("just ci", "just  ci --fast", 20_000),
            gap("just ci", "just ci", 40_000),
        ];
        let (spec, members) = gaps_chart(&rows, &record);
        assert_valid(&spec);
        assert_eq!(spec["orient"], "horizontal");
        assert_eq!(spec["format"], "secs");
        assert_eq!(spec["series"][0]["values"], json!([90.0, 40.0]));
        // Each row opens its gaps: a count form, since the spec is sourced.
        assert_eq!(
            spec["refs"],
            json!([
                { "kind": "command", "count": 3 },
                { "kind": "command", "count": 1 }
            ])
        );
        let ci = members.get(MemberKey::Row(0));
        assert_eq!(ci.len(), 3);
        assert_eq!(ci[1].r#ref.as_deref(), Some("command:just ci --fast"));
        assert_eq!(ci.iter().map(|m| m.measure.unwrap()).sum::<f64>(), 90.0);
        // A command with a newline is one line in its ref.
        assert_eq!(
            members.get(MemberKey::Row(1))[0].r#ref.as_deref(),
            Some("command:cargo build --release")
        );
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

    #[test]
    fn the_longest_tenth_of_calls_is_named_and_not_drawn() {
        let mut times: Vec<(String, i64)> =
            (1..=9).map(|n| (format!("cmd {n}"), n * 1000)).collect();
        times.push(("sleep 9999".to_string(), 8_000_000));
        let (summary, spec, members) = calls_chart(&times).unwrap();
        assert_valid(&spec);
        assert_eq!(summary, "10 call(s), median 5.5s; 1 over 9s not drawn");
        assert_eq!(spec["form"], "bar");
        assert_eq!(
            (spec["unit"].as_str(), spec["format"].as_str()),
            (Some("calls"), Some("int"))
        );
        let counts: Vec<u64> = spec["series"][0]["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        assert_eq!(counts.iter().sum::<u64>(), 9);
        assert_eq!(spec["subtitle"], "newest 10 calls; 1 over 9s not drawn");
        let refs = spec["refs"].as_array().unwrap();
        for (bin, count) in counts.iter().enumerate() {
            // A bin's slot counts its calls; an empty one is null.
            let expected = if *count == 0 {
                Value::Null
            } else {
                json!({ "kind": "command", "count": count })
            };
            assert_eq!(refs[bin], expected);
            // Its members are those calls, quickest first.
            let times: Vec<f64> = members
                .get(MemberKey::Row(bin))
                .iter()
                .map(|m| m.measure.unwrap())
                .collect();
            assert_eq!(times.len() as u64, *count);
            assert!(times.windows(2).all(|w| w[0] <= w[1]));
        }
        let all: Vec<&Member> = (0..counts.len())
            .flat_map(|bin| members.get(MemberKey::Row(bin)))
            .collect();
        assert!(
            all.iter()
                .all(|m| m.r#ref.as_deref() != Some("command:sleep 9999"))
        );
    }

    #[test]
    fn only_the_newest_calls_a_chart_can_hold_are_read() {
        // Newest first, so what passes the limit is the oldest.
        let mut times = vec![("ls".to_string(), 1000_i64); MAX_VALUES];
        times.extend([
            ("old".to_string(), 9_000_000),
            ("old".to_string(), 9_000_000),
        ]);
        let (summary, spec, _) = calls_chart(&times).unwrap();
        assert_valid(&spec);
        assert_eq!(
            summary,
            format!("{MAX_VALUES} call(s), median 1s; left out: 2 older call(s)")
        );
        let drawn: u64 = spec["series"][0]["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .sum();
        assert_eq!(drawn, MAX_VALUES as u64);
    }

    #[test]
    fn calls_over_a_missing_record_has_no_data_and_stays_missing() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        let outcome = crate::find("calls")
            .unwrap()
            .run(&ctx, &RecipeArgs::default())
            .unwrap();
        assert!(matches!(outcome, RecipeOutcome::NoData { .. }));
        assert!(!ctx.report_gaps.exists());
    }

    #[test]
    fn a_calls_source_re_reads_the_calls_it_drew() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        let at = |rfc: &str| {
            chrono::DateTime::parse_from_rfc3339(rfc)
                .unwrap()
                .timestamp_millis()
        };
        let record = tugcore::report_gaps::ReportGaps::open(&ctx.report_gaps).unwrap();
        record
            .time("cargo build", 4_000, at("2026-11-17T10:00:00.400+00:00"))
            .unwrap();
        record
            .time("git status", 2_000, at("2026-11-17T10:00:05+00:00"))
            .unwrap();
        drop(record);
        let run = |until: Option<&str>| {
            let args = RecipeArgs {
                until: until.map(str::to_string),
                ..RecipeArgs::default()
            };
            let RecipeOutcome::Chart { summary, .. } =
                crate::find("calls").unwrap().run(&ctx, &args).unwrap()
            else {
                panic!("no chart");
            };
            summary
        };
        assert!(run(None).starts_with("2 call(s)"), "{}", run(None));
        // A call that ended within the stamped second was drawn, and one
        // recorded after it was not.
        let then = run(Some("2026-11-17T10:00:00+00:00"));
        assert!(then.starts_with("1 call(s)"), "{then}");
    }
}

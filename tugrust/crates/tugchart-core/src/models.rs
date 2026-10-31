//! The recipes over the session ledger: what each model family did per day,
//! for the project they run in.

use std::collections::BTreeMap;

use chrono::{Days, Local, NaiveDate};
use serde_json::{Value, json};
use tugcore::session_usage::{DayUsage, usage_by_day};
use tuggraphics::chart::format::Format;
use tuggraphics::chart::spec::{MAX_LABEL, MAX_SERIES};

use crate::commits::{day_axis, labels, left_out_older};
use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, clip_front,
};

const DEFAULT_DAYS: u32 = 30;

/// What `tokens --kind` draws, one at a time: cache reads outnumber output by
/// three orders of magnitude, and on one axis would flatten everything else.
pub(crate) const TOKEN_KINDS: [&str; 4] = ["output", "input", "cache-read", "cache-creation"];

/// The series the families past [`MAX_SERIES`] fold into.
const OTHER_FAMILY: &str = "other";

/// One thing to draw per day, and how to write its total.
struct Measure {
    title: &'static str,
    unit: &'static str,
    format: &'static str,
    read: fn(&DayUsage) -> f64,
    total: fn(f64) -> String,
}

fn tokens_measure(kind: &str) -> Measure {
    let total: fn(f64) -> String = match kind {
        "input" => |n| format!("{} input tokens", Format::Count.apply(n)),
        "cache-read" => |n| format!("{} cache-read tokens", Format::Count.apply(n)),
        "cache-creation" => |n| format!("{} cache-creation tokens", Format::Count.apply(n)),
        _ => |n| format!("{} output tokens", Format::Count.apply(n)),
    };
    let (title, read): (&'static str, fn(&DayUsage) -> f64) = match kind {
        "input" => ("Input tokens per day", |u| u.input_tokens as f64),
        "cache-read" => ("Cache-read tokens per day", |u| u.cache_read_tokens as f64),
        "cache-creation" => ("Cache-creation tokens per day", |u| {
            u.cache_creation_tokens as f64
        }),
        _ => ("Output tokens per day", |u| u.output_tokens as f64),
    };
    Measure {
        title,
        unit: "tokens",
        format: "count",
        read,
        total,
    }
}

const COST: Measure = Measure {
    title: "Cost per day",
    unit: "dollars",
    format: "auto",
    read: |u| u.cost_usd,
    total: |n| format!("${n:.2}"),
};

const TURNS: Measure = Measure {
    title: "Turns per day",
    unit: "turns",
    format: "int",
    read: |u| u.turns as f64,
    total: |n| format!("{n} turn(s)"),
};

/// Per family, one value per axis day. Past [`MAX_SERIES`] families, the
/// smallest fold into one series.
fn fold_the_tail(mut series: BTreeMap<String, Vec<f64>>) -> Vec<(String, Vec<f64>)> {
    if series.len() > MAX_SERIES {
        let mut by_total: Vec<(String, f64)> = series
            .iter()
            .map(|(family, values)| (family.clone(), values.iter().sum()))
            .collect();
        by_total.sort_by(|a, b| b.1.total_cmp(&a.1));
        let days = series.values().next().map_or(0, Vec::len);
        let mut other = vec![0.0; days];
        for (family, _) in &by_total[MAX_SERIES - 1..] {
            let Some(values) = series.remove(family) else {
                continue;
            };
            for (sum, value) in other.iter_mut().zip(values) {
                *sum += value;
            }
        }
        let mut kept: Vec<(String, Vec<f64>)> = series.into_iter().collect();
        kept.push((OTHER_FAMILY.to_string(), other));
        return kept;
    }
    series.into_iter().collect()
}

struct ModelChart {
    days: usize,
    left_out: usize,
    total: f64,
    families: usize,
    spec: Value,
}

/// The stacked bars for the `days` ending on `today`, or `None` when the
/// window holds nothing of this measure.
fn model_chart(
    usage: &[DayUsage],
    today: NaiveDate,
    days: u32,
    measure: &Measure,
    subtitle: &str,
) -> Option<ModelChart> {
    let back = u64::from(days.max(1)) - 1;
    let first = today
        .checked_sub_days(Days::new(back))
        .unwrap_or(NaiveDate::MIN);
    let kept: Vec<&DayUsage> = usage
        .iter()
        .filter(|u| u.day >= first && (measure.read)(u) > 0.0)
        .collect();
    let (axis, left_out) = day_axis(kept.iter().map(|u| u.day));
    if axis.is_empty() {
        return None;
    }
    let mut series: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut total = 0.0;
    for u in &kept {
        let Ok(at) = axis.binary_search(&u.day) else {
            continue;
        };
        let value = (measure.read)(u);
        series
            .entry(u.family.clone())
            .or_insert_with(|| vec![0.0; axis.len()])[at] += value;
        total += value;
    }
    let series = fold_the_tail(series);
    let families = series.len();
    let drawn: Vec<Value> = series
        .into_iter()
        .map(|(name, values)| {
            let cents: Vec<f64> = values
                .into_iter()
                .map(|value| (value * 100.0).round() / 100.0)
                .collect();
            json!({ "name": name, "values": cents })
        })
        .collect();
    Some(ModelChart {
        days: axis.len(),
        left_out,
        total,
        families,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "layout": "stacked",
            "title": measure.title,
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": measure.unit,
            "format": measure.format,
            "categories": labels(&axis),
            "series": drawn,
        }),
    })
}

fn answer(
    ctx: &RecipeContext,
    args: &RecipeArgs,
    measure: &Measure,
    note: &str,
) -> Result<RecipeOutcome, RecipeError> {
    let days = args.days.unwrap_or(DEFAULT_DAYS);
    let range = format!("last {days} days");
    let usage = usage_by_day(&ctx.paths.sessions_db, &ctx.repo_root);
    let today = Local::now().date_naive();
    let subtitle = format!("{range}{note}");
    let Some(mut chart) = model_chart(&usage, today, days, measure, &subtitle) else {
        return Ok(RecipeOutcome::NoData {
            summary: format!(
                "no model usage in the {range} for {}",
                ctx.repo_root.display()
            ),
        });
    };
    apply_title(&mut chart.spec, args);
    let summary = format!(
        "{} over {} day(s), {} model(s), {range}{note}{}",
        (measure.total)(chart.total),
        chart.days,
        chart.families,
        left_out_older(chart.left_out, "day"),
    );
    Ok(RecipeOutcome::Chart {
        summary,
        spec: chart.spec,
    })
}

pub(crate) fn tokens(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    let kind = args.kind.as_deref().unwrap_or(TOKEN_KINDS[0]);
    // The ledger's token columns are the usage of each turn's last API call,
    // which is what the context meter needs, not the turn's sum.
    answer(
        ctx,
        args,
        &tokens_measure(kind),
        ", each turn's last API call",
    )
}

pub(crate) fn cost(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    answer(ctx, args, &COST, "")
}

pub(crate) fn turns(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    answer(ctx, args, &TURNS, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::test_support::{assert_valid, context_at};

    fn date(day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, day).unwrap()
    }

    fn usage(day: u32, family: &str, turns: i64) -> DayUsage {
        DayUsage {
            day: date(day),
            family: family.to_string(),
            turns,
            input_tokens: turns * 2,
            output_tokens: turns * 3,
            cache_read_tokens: turns * 4,
            cache_creation_tokens: 0,
            cost_usd: turns as f64 * 0.125,
        }
    }

    #[test]
    fn days_stack_by_family_and_a_quiet_day_stays_on_the_axis() {
        let rows = [
            usage(20, "fable", 1),
            usage(20, "opus", 2),
            usage(22, "opus", 3),
        ];
        let chart = model_chart(&rows, date(22), 30, &TURNS, "last 30 days").unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.spec["form"], "bar");
        assert_eq!(chart.spec["layout"], "stacked");
        assert_eq!(
            chart.spec["categories"],
            json!(["2026-10-20", "2026-10-21", "2026-10-22"])
        );
        assert_eq!(chart.spec["series"][0]["name"], "fable");
        assert_eq!(chart.spec["series"][0]["values"], json!([1.0, 0.0, 0.0]));
        assert_eq!(chart.spec["series"][1]["name"], "opus");
        assert_eq!(chart.spec["series"][1]["values"], json!([2.0, 0.0, 3.0]));
        assert_eq!(chart.total, 6.0);
        assert_eq!(chart.days, 3);
        assert_eq!(chart.families, 2);
    }

    #[test]
    fn the_window_ends_today_and_holds_the_days_it_names() {
        let rows = [usage(20, "opus", 1), usage(21, "opus", 2)];
        let chart = model_chart(&rows, date(22), 2, &TURNS, "last 2 days").unwrap();
        assert_eq!(chart.spec["categories"], json!(["2026-10-21"]));
        assert!(model_chart(&rows, date(23), 2, &TURNS, "last 2 days").is_none());
    }

    #[test]
    fn every_kind_of_token_draws_its_own_column() {
        let rows = [usage(20, "opus", 1)];
        let read = |kind: &str| {
            let chart = model_chart(&rows, date(20), 30, &tokens_measure(kind), "").unwrap();
            assert_valid(&chart.spec);
            (
                chart.spec["title"].as_str().unwrap().to_string(),
                chart.total,
            )
        };
        assert_eq!(read("output"), ("Output tokens per day".to_string(), 3.0));
        assert_eq!(read("input"), ("Input tokens per day".to_string(), 2.0));
        assert_eq!(
            read("cache-read"),
            ("Cache-read tokens per day".to_string(), 4.0)
        );
        // No day has any, so there is nothing to draw.
        assert!(model_chart(&rows, date(20), 30, &tokens_measure("cache-creation"), "").is_none());
    }

    #[test]
    fn cost_keeps_cents_and_writes_dollars() {
        let rows = [usage(20, "opus", 1), usage(20, "fable", 2)];
        let chart = model_chart(&rows, date(20), 30, &COST, "").unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.spec["series"][0]["values"], json!([0.25]));
        assert_eq!(chart.spec["series"][1]["values"], json!([0.13]));
        assert_eq!((COST.total)(chart.total), "$0.38");
    }

    #[test]
    fn families_past_what_a_chart_holds_fold_into_other() {
        let rows: Vec<DayUsage> = (0..=MAX_SERIES as i64)
            .map(|n| usage(20, &format!("family-{n}"), n + 1))
            .collect();
        let chart = model_chart(&rows, date(20), 30, &TURNS, "").unwrap();
        assert_valid(&chart.spec);
        let series = chart.spec["series"].as_array().unwrap();
        assert_eq!(series.len(), MAX_SERIES);
        let last = series.last().unwrap();
        assert_eq!(last["name"], OTHER_FAMILY);
        // The two smallest: one turn and two.
        assert_eq!(last["values"], json!([3.0]));
    }

    #[test]
    fn a_missing_ledger_has_no_data_and_stays_missing() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        for name in ["tokens", "cost", "turns"] {
            let outcome = crate::find(name)
                .unwrap()
                .run(&ctx, &RecipeArgs::default())
                .unwrap();
            assert!(matches!(outcome, RecipeOutcome::NoData { .. }), "{name}");
        }
        assert!(!ctx.paths.sessions_db.exists());
    }
}

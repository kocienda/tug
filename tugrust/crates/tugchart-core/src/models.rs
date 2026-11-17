//! The recipes over the session ledger: what each model family did per day,
//! for the project they run in.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Days, Local, NaiveDate};
use serde_json::{Value, json};
use tugchanges_core::Window;
use tugcore::session_usage::{DayUsage, SessionShare, usage_by_day};
use tuggraphics::chart::format::Format;
use tuggraphics::chart::spec::{MAX_LABEL, MAX_SERIES};

use crate::commits::{day_axis, labels, left_out_older};
use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, clip_front,
};
use crate::members::{
    Member, MemberKey, MemberTable, SourceArgs, stamp_source, window_for, window_label,
};
use crate::refs::{RefBudget, session_slot, set_slots};

const DEFAULT_DAYS: u32 = 30;

/// What `tokens --kind` draws, one at a time: cache reads outnumber output by
/// three orders of magnitude, and on one axis would flatten everything else.
pub(crate) const TOKEN_KINDS: [&str; 4] = ["output", "input", "cache-read", "cache-creation"];

/// The series the families past [`MAX_SERIES`] fold into.
const OTHER_FAMILY: &str = "other";

/// The counts a day and one session's share of it both carry, so one reader
/// measures either.
trait Usage {
    fn turns(&self) -> i64;
    fn input_tokens(&self) -> i64;
    fn output_tokens(&self) -> i64;
    fn cache_read_tokens(&self) -> i64;
    fn cache_creation_tokens(&self) -> i64;
    fn cost_usd(&self) -> f64;
}

macro_rules! usage_of {
    ($ty:ty) => {
        impl Usage for $ty {
            fn turns(&self) -> i64 {
                self.turns
            }
            fn input_tokens(&self) -> i64 {
                self.input_tokens
            }
            fn output_tokens(&self) -> i64 {
                self.output_tokens
            }
            fn cache_read_tokens(&self) -> i64 {
                self.cache_read_tokens
            }
            fn cache_creation_tokens(&self) -> i64 {
                self.cache_creation_tokens
            }
            fn cost_usd(&self) -> f64 {
                self.cost_usd
            }
        }
    };
}

usage_of!(DayUsage);
usage_of!(SessionShare);

/// One thing to draw per day, and how to write its total.
struct Measure {
    title: &'static str,
    unit: &'static str,
    format: &'static str,
    read: fn(&dyn Usage) -> f64,
    total: fn(f64) -> String,
}

fn tokens_measure(kind: &str) -> Measure {
    let total: fn(f64) -> String = match kind {
        "input" => |n| format!("{} input tokens", Format::Count.apply(n)),
        "cache-read" => |n| format!("{} cache-read tokens", Format::Count.apply(n)),
        "cache-creation" => |n| format!("{} cache-creation tokens", Format::Count.apply(n)),
        _ => |n| format!("{} output tokens", Format::Count.apply(n)),
    };
    let (title, read): (&'static str, fn(&dyn Usage) -> f64) = match kind {
        "input" => ("Input tokens per day", |u| u.input_tokens() as f64),
        "cache-read" => ("Cache-read tokens per day", |u| {
            u.cache_read_tokens() as f64
        }),
        "cache-creation" => ("Cache-creation tokens per day", |u| {
            u.cache_creation_tokens() as f64
        }),
        _ => ("Output tokens per day", |u| u.output_tokens() as f64),
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
    read: |u| u.cost_usd(),
    total: |n| format!("${n:.2}"),
};

const TURNS: Measure = Measure {
    title: "Turns per day",
    unit: "turns",
    format: "int",
    read: |u| u.turns() as f64,
    total: |n| format!("{n} turn(s)"),
};

/// One family's days: a value per axis day, the session refs behind it, and
/// what each of those sessions took of the value.
#[derive(Debug, Clone, Default, PartialEq)]
struct FamilyDays {
    values: Vec<f64>,
    sessions: Vec<Vec<String>>,
    /// Per day, each session's ref and its share, in the order of `sessions`.
    shares: Vec<Vec<(String, f64)>>,
}

impl FamilyDays {
    fn empty(days: usize) -> Self {
        Self {
            values: vec![0.0; days],
            sessions: vec![Vec::new(); days],
            shares: vec![Vec::new(); days],
        }
    }
}

/// Per family, one value per axis day. Past [`MAX_SERIES`] families, the
/// smallest fold into one series, their sessions with them.
fn fold_the_tail(mut series: BTreeMap<String, FamilyDays>) -> Vec<(String, FamilyDays)> {
    if series.len() > MAX_SERIES {
        let mut by_total: Vec<(String, f64)> = series
            .iter()
            .map(|(family, days)| (family.clone(), days.values.iter().sum()))
            .collect();
        by_total.sort_by(|a, b| b.1.total_cmp(&a.1));
        let days = series.values().next().map_or(0, |d| d.values.len());
        let mut other = FamilyDays::empty(days);
        for (family, _) in &by_total[MAX_SERIES - 1..] {
            let Some(folded) = series.remove(family) else {
                continue;
            };
            for (sum, value) in other.values.iter_mut().zip(folded.values) {
                *sum += value;
            }
            for (set, sessions) in other.sessions.iter_mut().zip(folded.sessions) {
                set.extend(sessions);
            }
            for (set, shares) in other.shares.iter_mut().zip(folded.shares) {
                set.extend(shares);
            }
        }
        let mut kept: Vec<(String, FamilyDays)> = series.into_iter().collect();
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
    members: MemberTable,
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
    let first = first_day(today, days);
    let kept: Vec<&DayUsage> = usage
        .iter()
        .filter(|u| u.day >= first && (measure.read)(*u) > 0.0)
        .collect();
    let (axis, left_out) = day_axis(kept.iter().map(|u| u.day));
    if axis.is_empty() {
        return None;
    }
    let mut series: BTreeMap<String, FamilyDays> = BTreeMap::new();
    let mut total = 0.0;
    for u in &kept {
        let Ok(at) = axis.binary_search(&u.day) else {
            continue;
        };
        let value = (measure.read)(*u);
        let days = series
            .entry(u.family.clone())
            .or_insert_with(|| FamilyDays::empty(axis.len()));
        days.values[at] += value;
        days.sessions[at].extend(u.sessions.iter().filter_map(|id| session_slot(id)));
        // A session the spec cannot name gets no member, as it gets no ref.
        days.shares[at].extend(
            u.by_session.iter().filter_map(|share| {
                session_slot(&share.session).map(|r| (r, (measure.read)(share)))
            }),
        );
        total += value;
    }
    let series = fold_the_tail(series);
    let families = series.len();
    // Each cell's sessions with what they took, before the budget folds any.
    // Two shares under one ref are one member, summed, as the spec lists the
    // ref once.
    let mut members = MemberTable::measured(measure.unit, measure.format);
    for (col, (_, days)) in series.iter().enumerate() {
        for (row, shares) in days.shares.iter().enumerate() {
            let mut cell: Vec<Member> = Vec::with_capacity(shares.len());
            for (r, value) in shares {
                match cell
                    .iter_mut()
                    .find(|m| m.r#ref.as_deref() == Some(r.as_str()))
                {
                    Some(member) => {
                        member.measure = Some(member.measure.unwrap_or(0.0) + value);
                    }
                    None => cell.push(Member::of(r.clone()).measured(*value)),
                }
            }
            members.set(MemberKey::Cell { row, col }, cell);
        }
    }
    let mut budget = RefBudget::new();
    let drawn: Vec<Value> = series
        .into_iter()
        .map(|(name, days)| {
            let cents: Vec<f64> = days
                .values
                .into_iter()
                .map(|value| (value * 100.0).round() / 100.0)
                .collect();
            let refs = set_slots("session", days.sessions, &mut budget);
            json!({ "name": name, "values": cents, "refs": refs })
        })
        .collect();
    Some(ModelChart {
        days: axis.len(),
        left_out,
        total,
        families,
        members,
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

/// The recipe's window, its label, and the days it covers as `days` ending
/// on `today`. The window is read as a day ending on `until`'s local date
/// and the days back to `since`, so a re-run from a source covers the days
/// the first run drew.
fn window_days(args: &RecipeArgs) -> (Window, String, NaiveDate, u32) {
    let window = window_for(args, DEFAULT_DAYS);
    let range = window_label(args, &window, DEFAULT_DAYS);
    let today = window
        .until
        .as_deref()
        .and_then(|until| DateTime::parse_from_rfc3339(until).ok())
        .map_or_else(
            || Local::now().date_naive(),
            |at| at.with_timezone(&Local).date_naive(),
        );
    let since = NaiveDate::parse_from_str(&window.since, "%Y-%m-%d").unwrap_or(today);
    let days = u32::try_from((today - since).num_days() + 1)
        .unwrap_or(1)
        .max(1);
    (window, range, today, days)
}

/// The first day of the `days` ending on `today`.
fn first_day(today: NaiveDate, days: u32) -> NaiveDate {
    let back = u64::from(days.max(1)) - 1;
    today
        .checked_sub_days(Days::new(back))
        .unwrap_or(NaiveDate::MIN)
}

fn answer(
    ctx: &RecipeContext,
    args: &RecipeArgs,
    measure: &Measure,
    note: &str,
    recipe: &str,
    kind: Option<&str>,
) -> Result<RecipeOutcome, RecipeError> {
    let (window, range, today, days) = window_days(args);
    let usage = usage_by_day(&ctx.paths.sessions_db, &ctx.repo_root);
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
    stamp_source(
        &mut chart.spec,
        recipe,
        SourceArgs::window(&window).maybe("kind", kind),
    );
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
        members: chart.members,
    })
}

/// A drawn sessions chart, and what its summary line reports.
struct SessionsChart {
    spec: Value,
    members: MemberTable,
    days: usize,
    left_out: usize,
    /// Distinct sessions across the window.
    sessions: usize,
}

/// The distinct sessions that took a turn each day of the `days` ending on
/// `today`, across every model family, as a bar per day. A session that
/// worked under two families on one day is one session that day. Each
/// bar's members are its sessions, measured by the turns they took that
/// day; an id the spec cannot name is counted and has no ref or member.
/// `None` when no day of the window has a session.
fn sessions_chart(
    usage: &[DayUsage],
    today: NaiveDate,
    days: u32,
    subtitle: &str,
) -> Option<SessionsChart> {
    let first = first_day(today, days);
    let mut by_day: BTreeMap<NaiveDate, BTreeMap<String, i64>> = BTreeMap::new();
    for u in usage.iter().filter(|u| u.day >= first && u.day <= today) {
        let day = by_day.entry(u.day).or_default();
        for id in &u.sessions {
            day.entry(id.clone()).or_default();
        }
        for share in &u.by_session {
            *day.entry(share.session.clone()).or_default() += share.turns;
        }
    }
    by_day.retain(|_, sessions| !sessions.is_empty());
    let (axis, left_out) = day_axis(by_day.keys().copied());
    if axis.is_empty() {
        return None;
    }
    let mut members = MemberTable::measured("turns", "int");
    let mut buckets: Vec<Vec<String>> = Vec::with_capacity(axis.len());
    let mut values: Vec<usize> = Vec::with_capacity(axis.len());
    let mut distinct: BTreeSet<&str> = BTreeSet::new();
    for (row, day) in axis.iter().enumerate() {
        let Some(sessions) = by_day.get(day) else {
            values.push(0);
            buckets.push(Vec::new());
            members.set(MemberKey::Row(row), Vec::new());
            continue;
        };
        distinct.extend(sessions.keys().map(String::as_str));
        values.push(sessions.len());
        let mut named: Vec<(String, i64)> = sessions
            .iter()
            .filter_map(|(id, turns)| session_slot(id).map(|r| (r, *turns)))
            .collect();
        named.sort_by_key(|(_, turns)| std::cmp::Reverse(*turns));
        buckets.push(named.iter().map(|(r, _)| r.clone()).collect());
        members.set(
            MemberKey::Row(row),
            named
                .into_iter()
                .map(|(r, turns)| Member::of(r).measured(turns as f64))
                .collect(),
        );
    }
    let refs = set_slots("session", buckets, &mut RefBudget::new());
    Some(SessionsChart {
        days: axis.len(),
        left_out,
        sessions: distinct.len(),
        members,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "title": "Sessions per day",
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": "sessions",
            "format": "int",
            "categories": labels(&axis),
            "series": [{ "name": "sessions", "values": values }],
            "refs": refs,
        }),
    })
}

pub(crate) fn sessions(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    let (window, range, today, days) = window_days(args);
    let usage = usage_by_day(&ctx.paths.sessions_db, &ctx.repo_root);
    let Some(mut chart) = sessions_chart(&usage, today, days, &range) else {
        return Ok(RecipeOutcome::NoData {
            summary: format!(
                "no sessions in the {range} for {}",
                ctx.repo_root.display()
            ),
        });
    };
    apply_title(&mut chart.spec, args);
    stamp_source(&mut chart.spec, "sessions", SourceArgs::window(&window));
    let summary = format!(
        "{} session(s) over {} day(s), {range}{}",
        chart.sessions,
        chart.days,
        left_out_older(chart.left_out, "day"),
    );
    Ok(RecipeOutcome::Chart {
        summary,
        spec: chart.spec,
        members: chart.members,
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
        "tokens",
        Some(kind),
    )
}

pub(crate) fn cost(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    answer(ctx, args, &COST, "", "cost", None)
}

pub(crate) fn turns(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    answer(ctx, args, &TURNS, "", "turns", None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::test_support::{assert_source, assert_valid, context_at};

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
            // One session, whose short id is the day and the turns in hex.
            sessions: vec![format!("{day:04x}{turns:04x}-{family}")],
            by_session: vec![SessionShare {
                session: format!("{day:04x}{turns:04x}-{family}"),
                turns,
                input_tokens: turns * 2,
                output_tokens: turns * 3,
                cache_read_tokens: turns * 4,
                cache_creation_tokens: 0,
                cost_usd: turns as f64 * 0.125,
            }],
        }
    }

    /// `row` with its usage split between `sessions`, evenly but for the
    /// remainder, which the first takes.
    fn shared(mut row: DayUsage, sessions: &[&str]) -> DayUsage {
        let n = sessions.len() as i64;
        let part = |total: i64, i: usize| total / n + if i == 0 { total % n } else { 0 };
        row.sessions = sessions.iter().map(|s| s.to_string()).collect();
        row.by_session = sessions
            .iter()
            .enumerate()
            .map(|(i, session)| SessionShare {
                session: session.to_string(),
                turns: part(row.turns, i),
                input_tokens: part(row.input_tokens, i),
                output_tokens: part(row.output_tokens, i),
                cache_read_tokens: part(row.cache_read_tokens, i),
                cache_creation_tokens: part(row.cache_creation_tokens, i),
                cost_usd: row.cost_usd / n as f64,
            })
            .collect();
        row
    }

    #[test]
    fn sessions_count_each_session_once_a_day_and_measure_it_in_turns() {
        let a = "048e4155-f644-46f7-a839-d22ac02a564f";
        let b = "63bcd0c2-5d98-4e84-b88f-cdac1ed0f66f";
        let rows = [
            // `a` worked under two families on the 20th: one session.
            shared(usage(20, "fable", 4), &[a]),
            shared(usage(20, "opus", 6), &[a, b]),
            // Nothing on the 21st; a scratch id on the 22nd is counted
            // and named nowhere.
            shared(usage(22, "opus", 2), &[b, "s1"]),
        ];
        let chart = sessions_chart(&rows, date(22), 30, "last 30 days").unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.spec["categories"], json!(["2026-10-20", "2026-10-21", "2026-10-22"]));
        assert_eq!(chart.spec["series"][0]["values"], json!([2, 0, 2]));
        assert_eq!(chart.sessions, 3);
        let turns = |row: usize| -> Vec<(Option<String>, f64)> {
            chart
                .members
                .get(MemberKey::Row(row))
                .iter()
                .map(|m| (m.r#ref.clone(), m.measure.unwrap()))
                .collect()
        };
        // 4 + 3 turns for `a`, 3 for `b`: the day's 10 turns.
        assert_eq!(
            turns(0),
            [
                (Some("session:048e4155".to_string()), 7.0),
                (Some("session:63bcd0c2".to_string()), 3.0),
            ]
        );
        assert!(turns(1).is_empty());
        assert_eq!(turns(2), [(Some("session:63bcd0c2".to_string()), 1.0)]);
        assert_eq!(
            chart.spec["refs"],
            json!([["session:048e4155", "session:63bcd0c2"], null, "session:63bcd0c2"])
        );
        assert!(sessions_chart(&rows, date(10), 5, "").is_none());
    }

    #[test]
    fn sessions_over_an_empty_ledger_has_no_data() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_at(dir.path());
        let outcome = crate::find("sessions")
            .unwrap()
            .run(&ctx, &RecipeArgs::default())
            .unwrap();
        let RecipeOutcome::NoData { summary } = outcome else {
            panic!("an empty ledger drew a chart");
        };
        assert!(summary.starts_with("no sessions in the"), "{summary}");
    }

    #[test]
    fn a_sessions_chart_stamps_its_window() {
        let rows = [shared(usage(20, "opus", 2), &["048e4155-f644-46f7-a839-d22ac02a564f"])];
        let mut chart = sessions_chart(&rows, date(20), 30, "r").unwrap();
        stamp_source(
            &mut chart.spec,
            "sessions",
            SourceArgs::new().with("since", "2026-09-21").with("until", "2026-10-20T23:00:00Z"),
        );
        assert_source(&chart.spec, "sessions");
    }

    #[test]
    fn a_cells_members_sum_to_what_the_cell_drew() {
        let a = "048e4155-f644-46f7-a839-d22ac02a564f";
        let b = "63bcd0c2-5d98-4e84-b88f-cdac1ed0f66f";
        let c = "7a1f0c33-0000-4000-8000-000000000001";
        let rows = [
            shared(usage(20, "fable", 5), &[a, b]),
            shared(usage(20, "opus", 7), &[b, c, a]),
            shared(usage(22, "opus", 3), &[c]),
        ];
        for measure in [
            tokens_measure("output"),
            tokens_measure("input"),
            tokens_measure("cache-read"),
            COST,
            TURNS,
        ] {
            let chart = model_chart(&rows, date(22), 30, &measure, "").unwrap();
            assert_eq!(
                chart.members.measure,
                Some((measure.unit.to_string(), measure.format.to_string()))
            );
            let series = chart.spec["series"].as_array().unwrap();
            for (col, drawn) in series.iter().enumerate() {
                for (row, value) in drawn["values"].as_array().unwrap().iter().enumerate() {
                    let cell = chart.members.get(MemberKey::Cell { row, col });
                    let sum: f64 = cell.iter().filter_map(|m| m.measure).sum();
                    // The chart rounds to the cent.
                    assert!(
                        (sum - value.as_f64().unwrap()).abs() < 0.005 + 1e-9,
                        "{} {col}/{row}: {sum} against {value}",
                        measure.title
                    );
                }
            }
            // The members are the refs the spec lists, in its order.
            let cell = chart.members.get(MemberKey::Cell { row: 0, col: 1 });
            let refs: Vec<&str> = cell.iter().filter_map(|m| m.r#ref.as_deref()).collect();
            assert_eq!(
                refs,
                ["session:63bcd0c2", "session:7a1f0c33", "session:048e4155"]
            );
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
        // Each cell links the sessions that took its turns.
        assert_eq!(
            chart.spec["series"][0]["refs"],
            json!(["session:00140001", null, null])
        );
        assert_eq!(
            chart.spec["series"][1]["refs"],
            json!(["session:00140002", null, "session:00160003"])
        );
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
        // Their sessions fold with them, the larger first.
        assert_eq!(
            last["refs"],
            json!([["session:00140002", "session:00140001"]])
        );
    }

    #[test]
    fn a_day_with_two_sessions_links_both_and_an_unnameable_one_is_left_out() {
        let row = shared(
            usage(20, "opus", 5),
            &[
                "048e4155-f644-46f7-a839-d22ac02a564f",
                "scratch",
                "63bcd0c2-5d98-4e84-b88f-cdac1ed0f66f",
            ],
        );
        let chart = model_chart(&[row], date(20), 30, &TURNS, "").unwrap();
        assert_valid(&chart.spec);
        assert_eq!(
            chart.spec["series"][0]["refs"],
            json!([["session:048e4155", "session:63bcd0c2"]])
        );
        // The unnameable session has no member either.
        let cell = chart.members.get(MemberKey::Cell { row: 0, col: 0 });
        assert_eq!(cell.len(), 2);
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

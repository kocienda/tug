//! The recipes over a project's commits.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Datelike, Days, NaiveDate, Timelike};
use serde_json::{Value, json};
use tugchanges_core::{
    DayStat, DiffOptions, FileStat, LogEntry, LogOptions, LogReport, PathStat, diff, log,
    numstat_by_commit, numstat_by_day, numstat_by_path, path_prefix,
};
use tuggraphics::chart::spec::{MAX_LABEL, MAX_ROWS, MAX_SERIES, MAX_VALUES};

use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, clip_front, git_gate,
};

const DEFAULT_DAYS: u32 = 30;
/// A weekly bucket needs weeks to show, so its chart reads a quarter.
const DEFAULT_VELOCITY_DAYS: u32 = 90;
const DEFAULT_HOTSPOT_DEPTH: u32 = 2;
const DEFAULT_LANDED_DEPTH: u32 = 1;
const DEFAULT_HOTSPOT_LIMIT: usize = 10;
const OTHER_KIND: &str = "other";
/// The longest subject prefix that still reads as a kind.
const MAX_KIND_CHARS: usize = 20;

/// `base`, and the path it is narrowed to, within a spec's limit on a title.
fn titled(base: &str, path: Option<&str>) -> String {
    match path {
        Some(path) => {
            let head = format!("{base} under ");
            let room = MAX_LABEL.saturating_sub(head.chars().count());
            format!("{head}{}", clip_front(path, room))
        }
        None => base.to_string(),
    }
}

/// The window a numstat read covered, spelled as `log` spells its range.
fn window(days: u32, path: Option<&str>) -> String {
    match path {
        Some(path) => format!("last {days} days under {path}"),
        None => format!("last {days} days"),
    }
}

fn no_commits(range: &str) -> RecipeOutcome {
    RecipeOutcome::NoData {
        summary: format!("no commits, {range}"),
    }
}

fn charted(summary: String, mut spec: Value, args: &RecipeArgs) -> RecipeOutcome {
    apply_title(&mut spec, args);
    RecipeOutcome::Chart { summary, spec }
}

fn left_out_days(left_out: usize) -> String {
    left_out_older(left_out, "day")
}

pub(crate) fn left_out_older(left_out: usize, noun: &str) -> String {
    if left_out == 0 {
        String::new()
    } else {
        format!("; left out: {left_out} older {noun}(s)")
    }
}

fn left_out_rows(left_out: usize) -> String {
    if left_out == 0 {
        String::new()
    } else {
        format!("; left out: {left_out} smaller row(s)")
    }
}

/// Every day from the first to the last of `days`, oldest first, keeping the
/// newest `MAX_VALUES`, and how many older ones that cut.
pub(crate) fn day_axis(days: impl IntoIterator<Item = NaiveDate>) -> (Vec<NaiveDate>, usize) {
    let known: BTreeSet<NaiveDate> = days.into_iter().collect();
    let (Some(&first), Some(&last)) = (known.first(), known.last()) else {
        return (Vec::new(), 0);
    };
    let mut axis: Vec<NaiveDate> = first.iter_days().take_while(|day| *day <= last).collect();
    let left_out = axis.len().saturating_sub(MAX_VALUES);
    axis.drain(..left_out);
    (axis, left_out)
}

/// The Monday of `day`'s week.
fn week_start(day: NaiveDate) -> NaiveDate {
    day - Days::new(u64::from(day.weekday().num_days_from_monday()))
}

/// Every week from the first to the last of `days`, by its Monday, oldest
/// first, keeping the newest `MAX_VALUES`, and how many older ones that cut.
pub(crate) fn week_axis(days: impl IntoIterator<Item = NaiveDate>) -> (Vec<NaiveDate>, usize) {
    let known: BTreeSet<NaiveDate> = days.into_iter().map(week_start).collect();
    let (Some(&first), Some(&last)) = (known.first(), known.last()) else {
        return (Vec::new(), 0);
    };
    let mut axis: Vec<NaiveDate> = first
        .iter_days()
        .step_by(7)
        .take_while(|week| *week <= last)
        .collect();
    let left_out = axis.len().saturating_sub(MAX_VALUES);
    axis.drain(..left_out);
    (axis, left_out)
}

/// The bucket a commit count is drawn in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Bucket {
    Day,
    Week,
}

impl Bucket {
    fn from_args(args: &RecipeArgs) -> Bucket {
        match args.by.as_deref() {
            Some("week") => Bucket::Week,
            _ => Bucket::Day,
        }
    }

    fn start(self, day: NaiveDate) -> NaiveDate {
        match self {
            Bucket::Day => day,
            Bucket::Week => week_start(day),
        }
    }

    fn axis(self, days: impl IntoIterator<Item = NaiveDate>) -> (Vec<NaiveDate>, usize) {
        match self {
            Bucket::Day => day_axis(days),
            Bucket::Week => week_axis(days),
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Bucket::Day => "day",
            Bucket::Week => "week",
        }
    }
}

pub(crate) fn median(values: &[f64]) -> Option<f64> {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    match sorted.len() {
        0 => None,
        n if n % 2 == 1 => Some(sorted[mid]),
        _ => Some((sorted[mid - 1] + sorted[mid]) / 2.0),
    }
}

pub(crate) fn labels(axis: &[NaiveDate]) -> Vec<String> {
    axis.iter()
        .map(|day| day.format("%Y-%m-%d").to_string())
        .collect()
}

fn entry_day(entry: &LogEntry) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(&entry.date, "%Y-%m-%d").ok()
}

fn read_log(ctx: &RecipeContext, args: &RecipeArgs) -> Result<LogReport, RecipeError> {
    log(LogOptions {
        project: Some(ctx.repo_root.clone()),
        limit: None,
        range: None,
        days: Some(args.days.unwrap_or(DEFAULT_DAYS)),
        path: args.path.clone(),
    })
    .map_err(RecipeError::Git)
}

/// A built spec, and what the summary line reports of it.
struct DayChart {
    spec: Value,
    days: usize,
    left_out: usize,
}

/// Commits per committer day or week as a bar chart: one category per bucket
/// from the first to the last dated commit, empty ones included, oldest left.
fn commits_chart(
    entries: &[LogEntry],
    bucket: Bucket,
    title: &str,
    subtitle: &str,
) -> Option<DayChart> {
    let mut by_day: HashMap<NaiveDate, u32> = HashMap::new();
    for day in entries.iter().filter_map(entry_day) {
        *by_day.entry(bucket.start(day)).or_insert(0) += 1;
    }
    let (axis, left_out) = bucket.axis(by_day.keys().copied());
    if axis.is_empty() {
        return None;
    }
    let values: Vec<u32> = axis
        .iter()
        .map(|day| by_day.get(day).copied().unwrap_or(0))
        .collect();
    Some(DayChart {
        days: axis.len(),
        left_out,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "title": title,
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": "commits",
            "format": "int",
            "categories": labels(&axis),
            "series": [{ "name": "commits", "values": values }],
        }),
    })
}

/// Commits per committer day, as a bar chart. `None` when no commit carries a
/// date the chart can place.
pub fn commits_per_day(commits: &[LogEntry], title: &str, subtitle: &str) -> Option<Value> {
    commits_chart(commits, Bucket::Day, title, subtitle).map(|chart| chart.spec)
}

pub(crate) fn commits(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let report = read_log(ctx, args)?;
    let bucket = Bucket::from_args(args);
    let base = format!("Commits per {}", bucket.noun());
    let title = titled(&base, args.path.as_deref());
    let Some(chart) = commits_chart(&report.commits, bucket, &title, &report.range) else {
        return Ok(no_commits(&report.range));
    };
    let summary = format!(
        "{} commit(s) over {} {}(s), {}{}",
        report.commits.len(),
        chart.days,
        bucket.noun(),
        report.range,
        left_out_older(chart.left_out, bucket.noun())
    );
    Ok(charted(summary, chart.spec, args))
}

/// Lines added and removed per day as a stacked area, zero days included.
fn churn_chart(stats: &[DayStat], title: &str, subtitle: &str) -> Option<DayChart> {
    let by_day: HashMap<NaiveDate, &DayStat> = stats
        .iter()
        .filter_map(|stat| {
            let day = NaiveDate::parse_from_str(&stat.day, "%Y-%m-%d").ok()?;
            Some((day, stat))
        })
        .collect();
    let (axis, left_out) = day_axis(by_day.keys().copied());
    if axis.is_empty() {
        return None;
    }
    let read = |pick: fn(&DayStat) -> u64| -> Vec<u64> {
        axis.iter()
            .map(|day| by_day.get(day).map_or(0, |stat| pick(stat)))
            .collect()
    };
    Some(DayChart {
        days: axis.len(),
        left_out,
        spec: json!({
            "tugchart": 1,
            "form": "area",
            "layout": "stacked",
            "title": title,
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": "lines",
            "format": "count",
            "x": labels(&axis),
            "series": [
                { "name": "added", "values": read(|s| s.added), "role": "good" },
                { "name": "removed", "values": read(|s| s.deleted), "role": "bad" },
            ],
        }),
    })
}

pub(crate) fn churn(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let days = args.days.unwrap_or(DEFAULT_DAYS);
    let path = args.path.as_deref();
    let range = window(days, path);
    let stats = numstat_by_day(&ctx.repo_root, days, path).map_err(RecipeError::Git)?;
    let title = titled("Lines added and removed per day", path);
    let Some(chart) = churn_chart(&stats, &title, &range) else {
        return Ok(no_commits(&range));
    };
    let added: u64 = stats.iter().map(|s| s.added).sum();
    let removed: u64 = stats.iter().map(|s| s.deleted).sum();
    let commits: u32 = stats.iter().map(|s| s.commits).sum();
    let summary = format!(
        "+{added} −{removed} line(s) in {commits} commit(s) over {} day(s), {range}{}",
        chart.days,
        left_out_days(chart.left_out)
    );
    Ok(charted(summary, chart.spec, args))
}

fn hotspots_chart(stats: &[PathStat], title: &str, subtitle: &str) -> Value {
    let categories: Vec<String> = stats
        .iter()
        .map(|stat| clip_front(&stat.path, MAX_LABEL))
        .collect();
    let values: Vec<u64> = stats.iter().map(|stat| stat.added + stat.deleted).collect();
    json!({
        "tugchart": 1,
        "form": "bar",
        "orient": "horizontal",
        "title": title,
        "subtitle": clip_front(subtitle, MAX_LABEL),
        "unit": "lines changed",
        "format": "count",
        "categories": categories,
        "series": [{ "name": "lines", "values": values }],
    })
}

pub(crate) fn hotspots(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let days = args.days.unwrap_or(DEFAULT_DAYS);
    let path = args.path.as_deref();
    let depth = args.depth.unwrap_or(DEFAULT_HOTSPOT_DEPTH).max(1) as usize;
    let limit = args
        .limit
        .unwrap_or(DEFAULT_HOTSPOT_LIMIT)
        .clamp(1, MAX_ROWS);
    let range = window(days, path);
    let stats = numstat_by_path(&ctx.repo_root, days, path, depth).map_err(RecipeError::Git)?;
    if stats.is_empty() {
        return Ok(no_commits(&range));
    }
    let kept = &stats[..stats.len().min(limit)];
    let title = titled(&format!("Most changed paths, last {days} days"), path);
    let summary = format!(
        "{} of {} path(s) at depth {depth}, {range}{}",
        kept.len(),
        stats.len(),
        left_out_rows(stats.len() - kept.len())
    );
    Ok(charted(summary, hotspots_chart(kept, &title, &range), args))
}

/// One row of `landed`.
#[derive(Debug, PartialEq, Eq)]
struct LandedRow {
    path: String,
    added: u64,
    removed: u64,
}

/// `files` summed by the first `depth` components of their paths, largest
/// first, ties by path.
fn landed_rows(files: &[FileStat], depth: usize) -> Vec<LandedRow> {
    let mut groups: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for file in files {
        let group = groups.entry(path_prefix(&file.path, depth)).or_default();
        group.0 += u64::from(file.added.unwrap_or(0));
        group.1 += u64::from(file.deleted.unwrap_or(0));
    }
    let mut rows: Vec<LandedRow> = groups
        .into_iter()
        .map(|(path, (added, removed))| LandedRow {
            path,
            added,
            removed,
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.added + row.removed));
    rows
}

fn landed_chart(rows: &[LandedRow], title: &str, subtitle: &str) -> Value {
    let categories: Vec<String> = rows
        .iter()
        .map(|row| clip_front(&row.path, MAX_LABEL))
        .collect();
    let added: Vec<u64> = rows.iter().map(|row| row.added).collect();
    let removed: Vec<u64> = rows.iter().map(|row| row.removed).collect();
    json!({
        "tugchart": 1,
        "form": "bar",
        "orient": "horizontal",
        "layout": "stacked",
        "title": title,
        "subtitle": clip_front(subtitle, MAX_LABEL),
        "unit": "lines changed",
        "format": "count",
        "categories": categories,
        "series": [
            { "name": "added", "values": added, "role": "good" },
            { "name": "removed", "values": removed, "role": "bad" },
        ],
    })
}

pub(crate) fn landed(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let scope = match (&args.range, args.staged, args.session) {
        (Some(range), _, _) => range.clone(),
        (None, true, _) => "the index".to_string(),
        (None, false, true) => "this session's files".to_string(),
        (None, false, false) => "the working tree".to_string(),
    };
    let report = diff(DiffOptions {
        session: None,
        project: Some(ctx.repo_root.clone()),
        range: args.range.clone(),
        staged: args.staged,
        session_scope: args.session,
    })
    .map_err(RecipeError::Git)?;
    if report.files.is_empty() {
        return Ok(RecipeOutcome::NoData {
            summary: format!("no changes, {scope}"),
        });
    }
    let depth = args.depth.unwrap_or(DEFAULT_LANDED_DEPTH).max(1) as usize;
    let rows = landed_rows(&report.files, depth);
    let kept = &rows[..rows.len().min(MAX_ROWS)];
    let summary = format!(
        "{} file(s) under {} path(s), {scope}{}",
        report.files.len(),
        rows.len(),
        left_out_rows(rows.len() - kept.len())
    );
    let spec = landed_chart(kept, "Lines changed by directory", &scope);
    Ok(charted(summary, spec, args))
}

/// A commit's kind: the lowercase text before the first `(` or `:` in its
/// subject, when that is a single short token, and otherwise `other`.
fn commit_kind(subject: &str) -> String {
    let Some(end) = subject.find(['(', ':']) else {
        return OTHER_KIND.to_string();
    };
    let head = &subject[..end];
    if head.is_empty()
        || head.chars().count() > MAX_KIND_CHARS
        || head.contains(char::is_whitespace)
    {
        return OTHER_KIND.to_string();
    }
    head.to_lowercase()
}

/// A stacked-area chart of commits per kind per day.
struct KindChart {
    chart: DayChart,
    /// The kinds folded into `other`, by name.
    folded: Vec<String>,
}

/// The most common kinds become series, the rest fold into `other`.
fn kinds_chart(entries: &[LogEntry], title: &str, subtitle: &str) -> Option<KindChart> {
    let dated: Vec<(NaiveDate, String)> = entries
        .iter()
        .filter_map(|entry| Some((entry_day(entry)?, commit_kind(&entry.subject))))
        .collect();
    let (axis, left_out) = day_axis(dated.iter().map(|(day, _)| *day));
    if axis.is_empty() {
        return None;
    }

    let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
    for (_, kind) in &dated {
        *counts.entry(kind.as_str()).or_insert(0) += 1;
    }
    let mut ranked: Vec<(&str, u32)> = counts
        .iter()
        .filter(|(kind, _)| **kind != OTHER_KIND)
        .map(|(kind, count)| (*kind, *count))
        .collect();
    ranked.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    let cut = ranked.len().min(MAX_SERIES - 1);
    let folded: Vec<String> = ranked[cut..].iter().map(|(k, _)| k.to_string()).collect();
    let mut names: Vec<&str> = ranked[..cut].iter().map(|(kind, _)| *kind).collect();
    if !folded.is_empty() || counts.contains_key(OTHER_KIND) {
        names.push(OTHER_KIND);
    }

    let day_index: HashMap<NaiveDate, usize> =
        axis.iter().enumerate().map(|(i, day)| (*day, i)).collect();
    let mut rows = vec![vec![0u32; axis.len()]; names.len()];
    for (day, kind) in &dated {
        let Some(&at) = day_index.get(day) else {
            continue;
        };
        let series = names
            .iter()
            .position(|name| *name == kind.as_str())
            .unwrap_or(names.len() - 1);
        rows[series][at] += 1;
    }
    let series: Vec<Value> = names
        .iter()
        .zip(&rows)
        .map(|(name, values)| json!({ "name": name, "values": values }))
        .collect();
    Some(KindChart {
        folded,
        chart: DayChart {
            days: axis.len(),
            left_out,
            spec: json!({
                "tugchart": 1,
                "form": "area",
                "layout": "stacked",
                "title": title,
                "subtitle": clip_front(subtitle, MAX_LABEL),
                "unit": "commits",
                "format": "int",
                "x": labels(&axis),
                "series": series,
            }),
        },
    })
}

pub(crate) fn commit_kinds(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let report = read_log(ctx, args)?;
    let title = titled("Commits by kind per day", args.path.as_deref());
    let Some(KindChart { chart, folded }) = kinds_chart(&report.commits, &title, &report.range)
    else {
        return Ok(no_commits(&report.range));
    };
    let folded = if folded.is_empty() {
        String::new()
    } else {
        format!("; folded into other: {}", folded.join(", "))
    };
    let summary = format!(
        "{} commit(s) over {} day(s), {}{}{folded}",
        report.commits.len(),
        chart.days,
        report.range,
        left_out_days(chart.left_out)
    );
    Ok(charted(summary, chart.spec, args))
}

/// Commits per hour of the day, in the committer's own offset. `None` when no
/// commit carries a time that parses.
fn hours(entries: &[LogEntry]) -> Option<[u32; 24]> {
    let mut counts = [0u32; 24];
    let mut any = false;
    for entry in entries {
        if let Ok(at) = DateTime::parse_from_rfc3339(&entry.at) {
            counts[at.hour() as usize] += 1;
            any = true;
        }
    }
    any.then_some(counts)
}

fn heat_chart(categories: &[String], counts: &[u32], title: &str, subtitle: &str) -> Value {
    json!({
        "tugchart": 1,
        "form": "heat",
        "title": title,
        "subtitle": clip_front(subtitle, MAX_LABEL),
        "unit": "commits",
        "format": "int",
        "categories": categories,
        "values": counts,
    })
}

fn hours_chart(counts: &[u32; 24], title: &str, subtitle: &str) -> Value {
    let categories: Vec<String> = (0..24).map(|hour| format!("{hour:02}")).collect();
    heat_chart(&categories, counts, title, subtitle)
}

pub(crate) fn commit_hours(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let report = read_log(ctx, args)?;
    let Some(counts) = hours(&report.commits) else {
        return Ok(no_commits(&report.range));
    };
    let title = titled("Commits by hour of day", args.path.as_deref());
    let summary = format!(
        "{} commit(s) by committer's local hour, {}",
        report.commits.len(),
        report.range
    );
    let spec = hours_chart(&counts, &title, &report.range);
    Ok(charted(summary, spec, args))
}

/// Commits per weekday, Monday first, in the committer's own offset. `None`
/// when no commit carries a time that parses.
fn weekdays(entries: &[LogEntry]) -> Option<[u32; 7]> {
    let mut counts = [0u32; 7];
    let mut any = false;
    for entry in entries {
        if let Ok(at) = DateTime::parse_from_rfc3339(&entry.at) {
            counts[at.weekday().num_days_from_monday() as usize] += 1;
            any = true;
        }
    }
    any.then_some(counts)
}

pub(crate) fn commit_days(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let report = read_log(ctx, args)?;
    let Some(counts) = weekdays(&report.commits) else {
        return Ok(no_commits(&report.range));
    };
    let title = titled("Commits by day of week", args.path.as_deref());
    let summary = format!(
        "{} commit(s) by committer's local weekday, {}",
        report.commits.len(),
        report.range
    );
    let categories: Vec<String> = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        .map(String::from)
        .to_vec();
    let spec = heat_chart(&categories, &counts, &title, &report.range);
    Ok(charted(summary, spec, args))
}

/// `sizes` up to their 90th percentile, in the order given, and that size. One
/// generated file changes more lines than a month of ordinary commits, and on a
/// linear axis it would press every other commit into the first bin.
pub(crate) fn without_the_largest_tenth(sizes: &[u64]) -> (Vec<u64>, u64) {
    let mut sorted = sizes.to_vec();
    sorted.sort_unstable();
    let cap = match sorted.len() {
        0 => 0,
        n => sorted[(n * 9).div_ceil(10) - 1],
    };
    let drawn = sizes
        .iter()
        .copied()
        .filter(|lines| *lines <= cap)
        .collect();
    (drawn, cap)
}

pub(crate) fn commit_size(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let days = args.days.unwrap_or(DEFAULT_DAYS);
    let path = args.path.as_deref();
    let range = window(days, path);
    let sizes = numstat_by_commit(&ctx.repo_root, days, path).map_err(RecipeError::Git)?;
    if sizes.is_empty() {
        return Ok(no_commits(&range));
    }
    // Newest first from the read, so the commits past the limit are the oldest.
    let kept = &sizes[..sizes.len().min(MAX_VALUES)];
    let as_f64: Vec<f64> = kept.iter().map(|lines| *lines as f64).collect();
    let middle = median(&as_f64).unwrap_or(0.0);
    let (drawn, cap) = without_the_largest_tenth(kept);
    let not_drawn = kept.len() - drawn.len();
    let tail = if not_drawn == 0 {
        String::new()
    } else {
        format!("; {not_drawn} over {cap} line(s) not drawn")
    };
    let summary = format!(
        "{} commit(s), median {middle} line(s) changed, {range}{tail}{}",
        kept.len(),
        left_out_older(sizes.len() - kept.len(), "commit")
    );
    let spec = json!({
        "tugchart": 1,
        "form": "histogram",
        "title": titled("Lines changed per commit", path),
        "subtitle": clip_front(&format!("{range}{tail}"), MAX_LABEL),
        "unit": "lines changed",
        "format": "count",
        "values": drawn,
    });
    Ok(charted(summary, spec, args))
}

/// A built velocity chart, and what the summary line reports of it.
struct VelocityChart {
    spec: Value,
    weeks: usize,
    left_out: usize,
    total: i64,
    median: f64,
}

/// Lines per week as an area, empty weeks included, with a rule at the median
/// week. `net` draws added minus removed in place of added plus removed.
fn velocity_chart(
    stats: &[DayStat],
    net: bool,
    title: &str,
    subtitle: &str,
) -> Option<VelocityChart> {
    let mut by_week: HashMap<NaiveDate, i64> = HashMap::new();
    for stat in stats {
        let Ok(day) = NaiveDate::parse_from_str(&stat.day, "%Y-%m-%d") else {
            continue;
        };
        let (added, deleted) = (stat.added as i64, stat.deleted as i64);
        let lines = if net {
            added - deleted
        } else {
            added + deleted
        };
        *by_week.entry(week_start(day)).or_insert(0) += lines;
    }
    let (axis, left_out) = week_axis(by_week.keys().copied());
    if axis.is_empty() {
        return None;
    }
    let values: Vec<i64> = axis
        .iter()
        .map(|week| by_week.get(week).copied().unwrap_or(0))
        .collect();
    let as_f64: Vec<f64> = values.iter().map(|lines| *lines as f64).collect();
    let middle = median(&as_f64)?;
    let name = if net { "net lines" } else { "lines changed" };
    Some(VelocityChart {
        weeks: axis.len(),
        left_out,
        total: values.iter().sum(),
        median: middle,
        spec: json!({
            "tugchart": 1,
            "form": "area",
            "title": title,
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": name,
            "format": "count",
            "x": labels(&axis),
            "series": [{ "name": name, "values": values }],
            "annotations": [{ "kind": "rule", "value": middle, "label": "median" }],
        }),
    })
}

pub(crate) fn velocity(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let days = args.days.unwrap_or(DEFAULT_VELOCITY_DAYS);
    let path = args.path.as_deref();
    let range = window(days, path);
    let stats = numstat_by_day(&ctx.repo_root, days, path).map_err(RecipeError::Git)?;
    let base = if args.net {
        "Net lines per week"
    } else {
        "Lines changed per week"
    };
    let title = titled(base, path);
    let Some(chart) = velocity_chart(&stats, args.net, &title, &range) else {
        return Ok(no_commits(&range));
    };
    let noun = if args.net {
        "net line(s)"
    } else {
        "line(s) changed"
    };
    let summary = format!(
        "{} {noun} over {} week(s), median {} a week, {range}{}",
        chart.total,
        chart.weeks,
        chart.median,
        left_out_older(chart.left_out, "week")
    );
    Ok(charted(summary, chart.spec, args))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::test_support::assert_valid;
    use tugcore::test_fixtures::git::{GitFixture, git};

    #[test]
    fn commits_per_day_fills_the_zero_days_and_validates() {
        let spec = commits_per_day(
            &[
                entry("s", "2026-10-27"),
                entry("s", "2026-10-29"),
                entry("s", "2026-10-29"),
            ],
            "Commits",
            "last 30 days",
        )
        .unwrap();
        assert_eq!(
            spec["categories"],
            json!(["2026-10-27", "2026-10-28", "2026-10-29"])
        );
        assert_eq!(spec["series"][0]["values"], json!([1, 0, 2]));
        assert_valid(&spec);
    }

    #[test]
    fn commits_per_day_is_none_without_a_dated_commit() {
        assert!(commits_per_day(&[], "t", "s").is_none());
        assert!(commits_per_day(&[entry("s", "")], "t", "s").is_none());
    }

    fn entry(subject: &str, date: &str) -> LogEntry {
        LogEntry {
            sha: "abc1234".to_string(),
            subject: subject.to_string(),
            date: date.to_string(),
            at: format!("{date}T12:00:00+00:00"),
        }
    }

    fn at(at: &str) -> LogEntry {
        LogEntry {
            at: at.to_string(),
            ..entry("s", "2026-10-29")
        }
    }

    #[test]
    fn a_commit_chart_fills_its_zero_days() {
        let entries = [
            entry("a", "2026-10-28"),
            entry("b", "2026-10-28"),
            entry("c", "2026-10-31"),
        ];
        let chart = commits_chart(&entries, Bucket::Day, "t", "s").unwrap();
        assert_eq!(chart.days, 4);
        assert_eq!(chart.left_out, 0);
        assert_eq!(
            chart.spec["categories"],
            json!(["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"])
        );
        assert_eq!(chart.spec["series"][0]["values"], json!([2, 0, 0, 1]));
        assert_valid(&chart.spec);
        assert!(commits_chart(&[], Bucket::Day, "t", "s").is_none());
    }

    #[test]
    fn a_weekly_commit_chart_buckets_by_monday_and_fills_its_empty_weeks() {
        let entries = [
            entry("a", "2026-10-05"),
            entry("b", "2026-10-11"),
            entry("c", "2026-10-19"),
        ];
        let chart = commits_chart(&entries, Bucket::Week, "t", "s").unwrap();
        assert_eq!(chart.days, 3);
        assert_eq!(
            chart.spec["categories"],
            json!(["2026-10-05", "2026-10-12", "2026-10-19"])
        );
        assert_eq!(chart.spec["series"][0]["values"], json!([2, 0, 1]));
        assert_valid(&chart.spec);
    }

    fn stat(day: &str, added: u64, deleted: u64) -> DayStat {
        DayStat {
            day: day.to_string(),
            added,
            deleted,
            commits: 1,
        }
    }

    #[test]
    fn velocity_sums_each_week_and_rules_the_median_week() {
        let stats = [
            stat("2026-10-05", 10, 2),
            stat("2026-10-07", 3, 1),
            stat("2026-10-19", 100, 50),
        ];
        let chart = velocity_chart(&stats, false, "t", "s").unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.weeks, 3);
        assert_eq!(chart.total, 166);
        assert_eq!(chart.median, 16.0);
        assert_eq!(chart.spec["form"], "area");
        assert_eq!(
            chart.spec["x"],
            json!(["2026-10-05", "2026-10-12", "2026-10-19"])
        );
        assert_eq!(chart.spec["series"][0]["values"], json!([16, 0, 150]));
        assert_eq!(chart.spec["annotations"][0]["value"], 16.0);
        assert_eq!(chart.spec["annotations"][0]["label"], "median");
        assert!(velocity_chart(&[], false, "t", "s").is_none());
    }

    #[test]
    fn net_velocity_goes_below_zero_when_a_week_removes_more_than_it_adds() {
        let stats = [stat("2026-10-05", 10, 2), stat("2026-10-12", 1, 9)];
        let chart = velocity_chart(&stats, true, "t", "s").unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.spec["series"][0]["name"], "net lines");
        assert_eq!(chart.spec["series"][0]["values"], json!([8, -8]));
        assert_eq!(chart.total, 0);
        assert_eq!(chart.median, 0.0);
    }

    #[test]
    fn a_commit_size_chart_leaves_out_the_largest_tenth() {
        let mut sizes: Vec<u64> = (1..=9).collect();
        sizes.insert(0, 60_000);
        assert_eq!(
            without_the_largest_tenth(&sizes),
            ((1..=9).collect::<Vec<u64>>(), 9)
        );
        // Too few commits to have a tenth keep every one of them.
        assert_eq!(without_the_largest_tenth(&[3, 5, 3]), (vec![3, 5, 3], 5));
        assert_eq!(without_the_largest_tenth(&[]), (Vec::new(), 0));
    }

    #[test]
    fn a_weekday_is_read_in_the_committers_own_offset() {
        // 23:30 on a Thursday in its own offset is already Friday in UTC.
        let counts = weekdays(&[at("2026-10-29T23:30:00-07:00"), at("not a time")]).unwrap();
        assert_eq!(counts, [0, 0, 0, 1, 0, 0, 0]);
        assert!(weekdays(&[at("not a time")]).is_none());
    }

    #[test]
    fn a_day_axis_keeps_the_newest_days_it_can_draw() {
        let first = NaiveDate::from_ymd_opt(2000, 1, 1).unwrap();
        let last = first + chrono::Days::new(MAX_VALUES as u64 + 9);
        let (axis, left_out) = day_axis([first, last]);
        assert_eq!(axis.len(), MAX_VALUES);
        assert_eq!(left_out, 10);
        assert_eq!(axis.last(), Some(&last));
    }

    #[test]
    fn a_churn_chart_stacks_added_and_removed_over_filled_days() {
        let stats = [
            DayStat {
                day: "2026-10-28".to_string(),
                added: 5,
                deleted: 1,
                commits: 2,
            },
            DayStat {
                day: "2026-10-30".to_string(),
                added: 0,
                deleted: 7,
                commits: 1,
            },
        ];
        let chart = churn_chart(&stats, "t", "s").unwrap();
        assert_eq!(chart.days, 3);
        assert_eq!(chart.spec["layout"], "stacked");
        assert_eq!(chart.spec["series"][0]["name"], "added");
        assert_eq!(chart.spec["series"][0]["role"], "good");
        assert_eq!(chart.spec["series"][0]["values"], json!([5, 0, 0]));
        assert_eq!(chart.spec["series"][1]["role"], "bad");
        assert_eq!(chart.spec["series"][1]["values"], json!([1, 0, 7]));
        assert_valid(&chart.spec);
    }

    #[test]
    fn a_hotspot_row_is_lines_changed() {
        let stats = [PathStat {
            path: "a/b".to_string(),
            added: 3,
            deleted: 4,
            commits: 1,
        }];
        let spec = hotspots_chart(&stats, "t", "s");
        assert_eq!(spec["orient"], "horizontal");
        assert_eq!(spec["series"][0]["values"], json!([7]));
        assert_valid(&spec);
    }

    #[test]
    fn landed_groups_by_depth_and_counts_a_binary_as_nothing() {
        let file = |path: &str, added, deleted| FileStat {
            path: path.to_string(),
            status: "M".to_string(),
            added,
            deleted,
        };
        let files = [
            file("a/one.rs", Some(1), Some(2)),
            file("a/b/two.rs", Some(3), Some(0)),
            file("c/logo.png", None, None),
            file("README.md", Some(9), Some(9)),
        ];
        let rows = landed_rows(&files, 1);
        let read: Vec<(&str, u64, u64)> = rows
            .iter()
            .map(|r| (r.path.as_str(), r.added, r.removed))
            .collect();
        assert_eq!(read, vec![("README.md", 9, 9), ("a", 4, 2), ("c", 0, 0)]);
        let spec = landed_chart(&rows, "t", "s");
        assert_eq!(spec["layout"], "stacked");
        assert_valid(&spec);

        let deeper = landed_rows(&files, 2);
        assert!(deeper.iter().any(|r| r.path == "a/b"));
        assert!(deeper.iter().any(|r| r.path == "README.md"));
    }

    #[test]
    fn a_kind_is_the_token_before_the_first_paren_or_colon() {
        assert_eq!(commit_kind("tugarc(x): Do it"), "tugarc");
        assert_eq!(commit_kind("Feat: Do it"), "feat");
        assert_eq!(commit_kind("Fix thing"), "other");
        assert_eq!(commit_kind("Fix the thing: properly"), "other");
        assert_eq!(commit_kind(": nothing"), "other");
        assert_eq!(commit_kind("averyveryveryverylongtoken: x"), "other");
    }

    #[test]
    fn the_rarest_kinds_fold_into_other() {
        let mut entries = Vec::new();
        for (k, kind) in ["a", "b", "c", "d", "e", "f", "g", "h", "i"]
            .iter()
            .enumerate()
        {
            for _ in 0..(9 - k) {
                entries.push(entry(&format!("{kind}: x"), "2026-10-29"));
            }
        }
        entries.push(entry("no kind here", "2026-10-30"));
        let KindChart { chart, folded } = kinds_chart(&entries, "t", "s").unwrap();
        let series = chart.spec["series"].as_array().unwrap();
        assert_eq!(series.len(), MAX_SERIES);
        assert_eq!(series[0]["name"], "a");
        assert_eq!(series[0]["values"], json!([9, 0]));
        assert_eq!(series[MAX_SERIES - 1]["name"], "other");
        // `h` (2), `i` (1), and the commit that had no kind.
        assert_eq!(series[MAX_SERIES - 1]["values"], json!([3, 1]));
        assert_eq!(folded, vec!["h", "i"]);
        assert_valid(&chart.spec);
    }

    #[test]
    fn an_hour_is_read_in_the_committers_own_offset() {
        let counts = hours(&[
            at("2026-10-29T23:30:00-07:00"),
            at("2026-10-30T06:30:00+00:00"),
            at("not a time"),
        ])
        .unwrap();
        assert_eq!(counts[23], 1);
        assert_eq!(counts[6], 1);
        assert_eq!(counts.iter().sum::<u32>(), 2);
        assert_valid(&hours_chart(&counts, "t", "s"));
        assert!(hours(&[at("not a time")]).is_none());
    }

    #[test]
    fn a_long_path_stays_within_a_title_and_keeps_its_end() {
        let long = format!("{}/end", "x".repeat(200));
        let title = titled("Commits per day", Some(&long));
        assert_eq!(title.chars().count(), MAX_LABEL);
        assert!(title.starts_with("Commits per day under …"));
        assert!(title.ends_with("/end"));
        assert_eq!(titled("Churn", Some("a")), "Churn under a");
        assert_eq!(titled("Churn", None), "Churn");
    }

    /// Every commit recipe over a real history, by way of the catalog: a chart
    /// the validator accepts, and a summary naming the window.
    #[test]
    fn every_commit_recipe_draws_a_real_history_and_a_path_narrows_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        GitFixture::init(&root);
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/one.txt"), "one\ntwo\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "feat(a): Add one"]);
        std::fs::write(root.join("two.txt"), "x\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "Add two"]);
        std::fs::write(root.join("two.txt"), "x\ny\n").unwrap();

        let ctx = RecipeContext::for_project(&root);
        for name in [
            "commits",
            "churn",
            "hotspots",
            "landed",
            "commit-kinds",
            "commit-hours",
            "commit-size",
            "commit-days",
            "velocity",
        ] {
            let outcome = crate::find(name)
                .unwrap()
                .run(&ctx, &RecipeArgs::default())
                .unwrap();
            let RecipeOutcome::Chart { spec, summary } = outcome else {
                panic!("{name} found nothing to draw");
            };
            assert_valid(&spec);
            assert!(!summary.is_empty());
        }

        let args = RecipeArgs {
            path: Some("a".to_string()),
            title: Some("Named".to_string()),
            ..Default::default()
        };
        let outcome = crate::find("churn").unwrap().run(&ctx, &args).unwrap();
        let RecipeOutcome::Chart { spec, summary } = outcome else {
            panic!("churn under a found nothing to draw");
        };
        assert_eq!(spec["title"], "Named");
        assert_eq!(spec["series"][0]["values"].as_array().unwrap().len(), 1);
        assert!(
            summary.starts_with("+2 −0 line(s) in 1 commit(s)"),
            "{summary}"
        );
        assert!(summary.ends_with("under a"), "{summary}");
    }

    #[test]
    fn a_window_with_no_commits_has_no_data_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        GitFixture::init(&root);
        std::fs::write(root.join("a.txt"), "x\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "only"]);
        let ctx = RecipeContext::for_project(&root);
        let args = RecipeArgs {
            path: Some("nowhere".to_string()),
            ..Default::default()
        };
        for name in [
            "commits",
            "churn",
            "hotspots",
            "commit-kinds",
            "commit-hours",
            "commit-size",
            "commit-days",
        ] {
            assert_eq!(
                crate::find(name).unwrap().run(&ctx, &args).unwrap(),
                RecipeOutcome::NoData {
                    summary: "no commits, last 30 days under nowhere".to_string()
                },
                "{name}"
            );
        }
        assert_eq!(
            crate::find("velocity").unwrap().run(&ctx, &args).unwrap(),
            RecipeOutcome::NoData {
                summary: "no commits, last 90 days under nowhere".to_string()
            }
        );
        // Nothing dirty in the tree.
        assert!(matches!(
            crate::find("landed")
                .unwrap()
                .run(&ctx, &RecipeArgs::default())
                .unwrap(),
            RecipeOutcome::NoData { .. }
        ));
    }

    /// A commit made on `when`, a local date and time.
    fn commit_at(root: &std::path::Path, when: &str) {
        std::fs::write(root.join("f.txt"), when).unwrap();
        git(root, &["add", "-A"]);
        let out = std::process::Command::new("git")
            .current_dir(root)
            .args(["commit", "-q", "-m", when])
            .env("GIT_COMMITTER_DATE", when)
            .env("GIT_AUTHOR_DATE", when)
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
    }

    /// The window is calendar days: the last moment of the day before it is
    /// out, the first of its oldest day is in, and the summary and the figure
    /// both say how many days that is.
    #[test]
    fn a_window_of_n_days_draws_n_days_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        GitFixture::init(&root);
        let today = chrono::Local::now().date_naive();
        let back = |days: u64| (today - chrono::Days::new(days)).format("%Y-%m-%d");
        commit_at(&root, &format!("{} 23:59:00", back(3)));
        commit_at(&root, &format!("{} 00:01:00", back(2)));
        commit_at(&root, &format!("{} 00:01:00", back(0)));

        let ctx = RecipeContext::for_project(&root);
        let args = RecipeArgs {
            days: Some(3),
            ..Default::default()
        };
        for (name, axis) in [
            ("commits", "categories"),
            ("churn", "x"),
            ("commit-kinds", "x"),
        ] {
            let outcome = crate::find(name).unwrap().run(&ctx, &args).unwrap();
            let RecipeOutcome::Chart { spec, summary } = outcome else {
                panic!("{name} found nothing to draw");
            };
            assert_eq!(spec[axis].as_array().unwrap().len(), 3, "{name}");
            assert!(
                summary.contains("in 2 commit(s) over 3 day(s), last 3 days")
                    || summary.starts_with("2 commit(s) over 3 day(s), last 3 days"),
                "{summary}"
            );
        }
    }

    #[test]
    fn a_range_naming_no_commit_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        GitFixture::init(&root);
        std::fs::write(root.join("a.txt"), "x\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "only"]);
        let ctx = RecipeContext::for_project(&root);
        let args = RecipeArgs {
            range: Some("nosuch..neither".to_string()),
            ..Default::default()
        };
        assert!(matches!(
            crate::find("landed").unwrap().run(&ctx, &args),
            Err(RecipeError::Git(_))
        ));
    }
}

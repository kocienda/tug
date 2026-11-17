//! The recipes over a project's commits.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Datelike, Days, NaiveDate, Timelike};
use serde_json::{Value, json};
use tugchanges_core::{
    CommitFiles, CommitLines, DayStat, DiffOptions, FileStat, KindSet, LineKind, LineKinds,
    LogEntry, LogOptions, LogReport, PathStat, Window, commit_lines, day_stats, diff, git_output,
    group_paths, left_out, log, numstat_files_in, path_prefix,
};
use tuggraphics::chart::spec::{MAX_LABEL, MAX_ROWS, MAX_SERIES, MAX_VALUES};

use crate::context::{
    RecipeArgs, RecipeContext, RecipeError, RecipeOutcome, apply_title, binned, clip_front,
    git_gate,
};
use crate::members::{
    Member, MemberKey, MemberTable, SourceArgs, format_measure, plain, stamp_source, window_for,
    window_label,
};
use crate::refs::{RefBudget, commit_ref, path_ref, report_slots, set_slots};

const DEFAULT_DAYS: u32 = 30;
/// A weekly bucket needs weeks to show, so its chart reads a quarter.
const DEFAULT_VELOCITY_DAYS: u32 = 90;
/// The deepest grouping `hotspots` chooses on its own.
const MAX_CHOSEN_DEPTH: usize = 6;
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

/// The window a read covered, spelled as `log` spells its range.
fn window(label: &str, path: Option<&str>) -> String {
    match path {
        Some(path) => format!("{label} under {path}"),
        None => label.to_string(),
    }
}

/// The window a recipe reads by, resolved once, and the range it names: the
/// last `default_days` (or `--days`) ending now, or the source's own.
fn span(args: &RecipeArgs, default_days: u32) -> (Window, String) {
    let window = window_for(args, default_days);
    let label = window_label(args, &window, default_days);
    let range = self::window(&label, args.path.as_deref());
    (window, range)
}

fn no_commits(range: &str) -> RecipeOutcome {
    RecipeOutcome::NoData {
        summary: format!("no commits, {range}"),
    }
}

/// The chart, titled and stamped with the source a reader hands back to ask
/// `recipe` again (`None` for a read with no absolute spelling), beside the
/// members behind its marks.
fn charted(
    summary: String,
    mut spec: Value,
    args: &RecipeArgs,
    recipe: &str,
    source: Option<SourceArgs>,
    members: MemberTable,
) -> RecipeOutcome {
    apply_title(&mut spec, args);
    if let Some(source) = source {
        stamp_source(&mut spec, recipe, source);
    }
    RecipeOutcome::Chart {
        summary,
        spec,
        members,
    }
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

/// `n` with its sign always written, `+` or the minus sign `−`, and its
/// magnitude in the `count` format; zero is `+0`.
pub(crate) fn signed(n: i64) -> String {
    let sign = if n < 0 { '−' } else { '+' };
    format!("{sign}{}", format_measure("count", n.unsigned_abs() as f64))
}

/// What a line recipe counts: the project's classifier, the kinds the
/// `--lines` choice holds, and that choice's name as the source stamps it.
struct LineScope {
    kinds: LineKinds,
    set: KindSet,
    name: String,
}

impl LineScope {
    /// The scope `args` asks for, `code` (source and tests) by default. A
    /// project config the classifier cannot be built from is the error.
    fn of(ctx: &RecipeContext, args: &RecipeArgs) -> Result<LineScope, RecipeError> {
        let kinds = ctx.line_kinds.clone().map_err(RecipeError::Config)?;
        let name = args.lines.clone().unwrap_or_else(|| "code".to_string());
        let set = KindSet::parse(&name)
            .ok_or_else(|| RecipeError::Config(format!("no such kind of lines: {name}")))?;
        Ok(LineScope { kinds, set, name })
    }

    /// The window's commits with each file classified.
    fn read(
        &self,
        ctx: &RecipeContext,
        window: &Window,
        path: Option<&str>,
    ) -> Result<Vec<CommitFiles>, RecipeError> {
        numstat_files_in(&ctx.repo_root, window, path, &self.kinds).map_err(RecipeError::Git)
    }

    /// What a read with no counted line says: no commits at all, or none of
    /// the kinds counted, with the lines it left out.
    fn nothing(&self, range: &str, left_out: &str) -> RecipeOutcome {
        if left_out.is_empty() {
            no_commits(range)
        } else {
            RecipeOutcome::NoData {
                summary: format!("no {} lines, {range}{left_out}", self.name),
            }
        }
    }
}

/// `; left out: <n> <kinds> line(s)` for the lines of each kind a chart did
/// not count, or nothing when it counted every line it read.
pub(crate) fn left_out_lines(left_out: &[(LineKind, u64)]) -> String {
    if left_out.is_empty() {
        return String::new();
    }
    let total: u64 = left_out.iter().map(|(_, lines)| lines).sum();
    let mut names: Vec<&str> = LineKind::ALL
        .into_iter()
        .filter(|kind| left_out.iter().any(|(k, _)| k == kind))
        .map(LineKind::name)
        .collect();
    let named = match names.pop() {
        Some(last) if !names.is_empty() => format!("{} and {last}", names.join(", ")),
        Some(last) => last.to_string(),
        None => String::new(),
    };
    format!(
        "; left out: {} {named} line(s)",
        format_measure("count", total as f64)
    )
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

fn commit_day(commit: &CommitLines) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(&commit.day, "%Y-%m-%d").ok()
}

/// `Row(i)` per bucket of `axis`: the commits whose day `key` places there,
/// in the order read and deduplicated, each measured by `measure`, the
/// table measuring `unit` as a count. It is built from the same commits the
/// chart summed, so a row's members sum to the row's value.
fn measured_rows(
    axis: &[NaiveDate],
    commits: &[CommitLines],
    key: impl Fn(NaiveDate) -> NaiveDate,
    measure: impl Fn(&CommitLines) -> f64,
    unit: &str,
) -> MemberTable {
    let mut table = MemberTable::measured(unit, "count");
    for (i, row) in member_rows(axis, commits, key, measure)
        .into_iter()
        .enumerate()
    {
        table.set(MemberKey::Row(i), row);
    }
    table
}

/// Per bucket of `axis`, the commits whose day `key` places there, in the
/// order read and deduplicated, each measured by `measure`.
fn member_rows(
    axis: &[NaiveDate],
    commits: &[CommitLines],
    key: impl Fn(NaiveDate) -> NaiveDate,
    measure: impl Fn(&CommitLines) -> f64,
) -> Vec<Vec<Member>> {
    let index: HashMap<NaiveDate, usize> =
        axis.iter().enumerate().map(|(i, day)| (*day, i)).collect();
    let mut rows: Vec<Vec<Member>> = vec![Vec::new(); axis.len()];
    for commit in commits {
        let Some(day) = commit_day(commit) else {
            continue;
        };
        let Some(&at) = index.get(&key(day)) else {
            continue;
        };
        let r = commit_ref(&commit.sha);
        if rows[at]
            .iter()
            .any(|m| m.r#ref.as_deref() == Some(r.as_str()))
        {
            continue;
        }
        rows[at].push(
            Member::of(r)
                .measured(measure(commit))
                .parted(commit.added as f64, commit.deleted as f64),
        );
    }
    rows
}

/// The log over the recipe's window, its `range` spelled as the subtitle
/// reads it, and the source args the window gives.
fn read_log(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<(LogReport, SourceArgs), RecipeError> {
    let (window, range) = span(args, DEFAULT_DAYS);
    let mut report = log(LogOptions {
        project: Some(ctx.repo_root.clone()),
        limit: None,
        range: None,
        days: None,
        window: Some(window.clone()),
        path: args.path.clone(),
    })
    .map_err(RecipeError::Git)?;
    report.range = range;
    Ok((
        report,
        SourceArgs::window(&window).maybe("path", args.path.as_deref()),
    ))
}

/// A built spec, and what the summary line reports of it.
struct DayChart {
    spec: Value,
    days: usize,
    left_out: usize,
    members: MemberTable,
}

/// Commits per committer day or week as a bar chart: one category per bucket
/// from the first to the last dated commit, empty ones included, oldest left.
/// Each bar carries the commits behind it in `refs`, parallel to
/// `categories`, newest buckets first under the spec's budget ([B10]).
fn commits_chart(
    entries: &[LogEntry],
    bucket: Bucket,
    title: &str,
    subtitle: &str,
) -> Option<DayChart> {
    let mut by_day: HashMap<NaiveDate, Vec<String>> = HashMap::new();
    for entry in entries {
        let Some(day) = entry_day(entry) else {
            continue;
        };
        by_day
            .entry(bucket.start(day))
            .or_default()
            .push(commit_ref(&entry.sha));
    }
    let (axis, left_out) = bucket.axis(by_day.keys().copied());
    if axis.is_empty() {
        return None;
    }
    let values: Vec<usize> = axis
        .iter()
        .map(|day| by_day.get(day).map_or(0, Vec::len))
        .collect();
    let buckets: Vec<Vec<String>> = axis
        .iter()
        .map(|day| by_day.remove(day).unwrap_or_default())
        .collect();
    let members = MemberTable::rows(&buckets);
    let refs = set_slots("commit", buckets, &mut RefBudget::new());
    Some(DayChart {
        days: axis.len(),
        left_out,
        members,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "title": title,
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": "commits",
            "format": "int",
            "categories": labels(&axis),
            "series": [{ "name": "commits", "values": values }],
            "refs": refs,
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
    let (report, source) = read_log(ctx, args)?;
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
    let source = source.with("by", bucket.noun());
    Ok(charted(
        summary,
        chart.spec,
        args,
        "commits",
        Some(source),
        chart.members,
    ))
}

/// Lines added and removed per day as a stacked bar either side of zero,
/// added above and removed below, zero days included. Added and removed are
/// never summed into one band: a day's height above the line is what it
/// added and its depth below is what it removed. Each day carries its
/// commits in `refs`, parallel to `categories`, and in the member table,
/// each measured by the lines it changed.
fn churn_chart(commits: &[CommitLines], title: &str, subtitle: &str) -> Option<DayChart> {
    let stats = day_stats(commits);
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
    let read = |pick: fn(&DayStat) -> i64| -> Vec<i64> {
        axis.iter()
            .map(|day| by_day.get(day).map_or(0, |stat| pick(stat)))
            .collect()
    };
    let buckets: Vec<Vec<String>> = axis
        .iter()
        .map(|day| {
            by_day.get(day).map_or_else(Vec::new, |stat| {
                stat.shas.iter().map(|sha| commit_ref(sha)).collect()
            })
        })
        .collect();
    let members = measured_rows(&axis, commits, |day| day, |c| c.lines() as f64, "lines");
    let refs = set_slots("commit", buckets, &mut RefBudget::new());
    Some(DayChart {
        days: axis.len(),
        left_out,
        members,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "layout": "stacked",
            "title": title,
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": "lines",
            "format": "count",
            "categories": labels(&axis),
            "series": [
                { "name": "added", "values": read(|s| s.added as i64), "role": "good" },
                { "name": "removed", "values": read(|s| -(s.deleted as i64)), "role": "bad" },
            ],
            "refs": refs,
        }),
    })
}

/// One kind of file and the window's commits counted for it alone.
type KindView = (LineKind, Vec<CommitLines>);

/// What a member of a line chart is measured by.
type Measure = fn(&CommitLines) -> f64;

/// Each counted kind's view of the read, in [`LineKind::ALL`] order: its
/// commits, each summing only that kind's files. A kind with no counted line
/// in the window has no view, and so no series.
fn kind_views(files: &[CommitFiles], set: KindSet) -> Vec<KindView> {
    set.kinds()
        .into_iter()
        .filter_map(|kind| {
            let only = KindSet::parse(kind.name())?;
            let view = commit_lines(files, only);
            (!view.is_empty()).then_some((kind, view))
        })
        .collect()
}

/// The days `commits` were made on, as the unsplit chart's axis reads them.
fn dated_days(commits: &[CommitLines]) -> Vec<NaiveDate> {
    commits.iter().filter_map(commit_day).collect()
}

/// One view's lines and commits per bucket of `axis`, a day placed by `key`.
struct Bucketed {
    added: Vec<i64>,
    deleted: Vec<i64>,
    refs: Vec<Vec<String>>,
}

fn bucketed(
    axis: &[NaiveDate],
    view: &[CommitLines],
    key: impl Fn(NaiveDate) -> NaiveDate,
) -> Bucketed {
    let index: HashMap<NaiveDate, usize> =
        axis.iter().enumerate().map(|(i, day)| (*day, i)).collect();
    let mut out = Bucketed {
        added: vec![0; axis.len()],
        deleted: vec![0; axis.len()],
        refs: vec![Vec::new(); axis.len()],
    };
    for stat in day_stats(view) {
        let Ok(day) = NaiveDate::parse_from_str(&stat.day, "%Y-%m-%d") else {
            continue;
        };
        let Some(&at) = index.get(&key(day)) else {
            continue;
        };
        out.added[at] += stat.added as i64;
        out.deleted[at] += stat.deleted as i64;
        out.refs[at].extend(stat.shas.iter().map(|sha| commit_ref(sha)));
    }
    out
}

/// `churn` split by kind: a series `<kind> added` per kind above zero, then
/// a series `<kind> removed` per kind below it, in one stacked bar over the
/// unsplit chart's days. The series carry no role, since eight series cannot
/// share two colours. Each series carries its commits per day in `refs`, all
/// spending one budget, and each cell's commits are its members, measured by
/// the lines of that kind they added or removed.
fn churn_split_chart(
    commits: &[CommitLines],
    views: &[KindView],
    title: &str,
    subtitle: &str,
) -> Option<DayChart> {
    let (axis, left_out) = day_axis(dated_days(commits));
    if axis.is_empty() {
        return None;
    }
    let kinds = views.len();
    let mut members = MemberTable::measured("lines", "count");
    let mut budget = RefBudget::new();
    let mut added_series = Vec::with_capacity(kinds);
    let mut removed_series = Vec::with_capacity(kinds);
    for (i, (kind, view)) in views.iter().enumerate() {
        let lines = bucketed(&axis, view, |day| day);
        let sides: [(usize, Measure); 2] =
            [(i, |c| c.added as f64), (kinds + i, |c| c.deleted as f64)];
        for (col, measure) in sides {
            for (row, cell) in member_rows(&axis, view, |day| day, measure)
                .into_iter()
                .enumerate()
            {
                members.set(MemberKey::Cell { row, col }, cell);
            }
        }
        let added_refs = set_slots("commit", lines.refs.clone(), &mut budget);
        let removed_refs = set_slots("commit", lines.refs, &mut budget);
        let removed: Vec<i64> = lines.deleted.iter().map(|n| -n).collect();
        added_series.push(json!({
            "name": format!("{} added", kind.name()),
            "values": lines.added,
            "refs": added_refs,
        }));
        removed_series.push(json!({
            "name": format!("{} removed", kind.name()),
            "values": removed,
            "refs": removed_refs,
        }));
    }
    added_series.extend(removed_series);
    Some(DayChart {
        days: axis.len(),
        left_out,
        members,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "layout": "stacked",
            "title": title,
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": "lines",
            "format": "count",
            "categories": labels(&axis),
            "series": added_series,
        }),
    })
}

pub(crate) fn churn(ctx: &RecipeContext, args: &RecipeArgs) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let path = args.path.as_deref();
    let (window, range) = span(args, DEFAULT_DAYS);
    let scope = LineScope::of(ctx, args)?;
    let files = scope.read(ctx, &window, path)?;
    let commits = commit_lines(&files, scope.set);
    let dropped = left_out_lines(&left_out(&files, scope.set));
    let title = titled("Lines added and removed per day", path);
    let added: u64 = commits.iter().map(|c| c.added).sum();
    let removed: u64 = commits.iter().map(|c| c.deleted).sum();
    let net = signed(added as i64 - removed as i64);
    let subtitle = format!("{range}; net {net}{dropped}");
    let chart = if args.split {
        churn_split_chart(&commits, &kind_views(&files, scope.set), &title, &subtitle)
    } else {
        churn_chart(&commits, &title, &subtitle)
    };
    let Some(chart) = chart else {
        return Ok(scope.nothing(&range, &dropped));
    };
    let summary = format!(
        "+{added} −{removed} line(s), net {net}, in {} commit(s) over {} day(s), {range}{dropped}{}",
        commits.len(),
        chart.days,
        left_out_days(chart.left_out)
    );
    let source = SourceArgs::window(&window)
        .with("lines", &scope.name)
        .with("split", args.split)
        .maybe("path", path);
    Ok(charted(
        summary,
        chart.spec,
        args,
        "churn",
        Some(source),
        chart.members,
    ))
}

/// Per row path, the files under it at `depth` with their lines summed over
/// the read, largest first and ties by path, each a `file:` member measured
/// in lines and parted into added and removed. A file with no line counted
/// (a binary) is no member, as it adds nothing to its row's bar.
fn path_members<'a>(
    files: impl IntoIterator<Item = (&'a str, u64, u64)>,
    depth: usize,
    rows: &[&str],
) -> Vec<Vec<Member>> {
    let index: HashMap<&str, usize> = rows.iter().enumerate().map(|(i, p)| (*p, i)).collect();
    let mut sums: Vec<BTreeMap<String, (u64, u64)>> = vec![BTreeMap::new(); rows.len()];
    for (path, added, deleted) in files {
        if added + deleted == 0 {
            continue;
        }
        let Some(&at) = index.get(path_prefix(path, depth).as_str()) else {
            continue;
        };
        let sum = sums[at].entry(path.to_string()).or_default();
        sum.0 += added;
        sum.1 += deleted;
    }
    sums.into_iter()
        .map(|files| {
            let mut files: Vec<(String, (u64, u64))> = files.into_iter().collect();
            files.sort_by_key(|(_, (added, deleted))| std::cmp::Reverse(added + deleted));
            files
                .into_iter()
                .map(|(path, (added, deleted))| {
                    Member::of(path_ref(&path, true))
                        .measured((added + deleted) as f64)
                        .parted(added as f64, deleted as f64)
                })
                .collect()
        })
        .collect()
}

/// The report slots and member table of a path chart's rows: each row's
/// files, written by [`report_slots`].
fn path_reports(rows: Vec<Vec<Member>>, sourced: bool) -> (Vec<Value>, MemberTable) {
    let buckets: Vec<Vec<String>> = rows
        .iter()
        .map(|row| row.iter().filter_map(|m| m.r#ref.clone()).collect())
        .collect();
    let slots = report_slots("file", buckets, &mut RefBudget::new(), sourced);
    let mut table = MemberTable::measured("lines changed", "count");
    for (i, row) in rows.into_iter().enumerate() {
        table.set(MemberKey::Row(i), row);
    }
    (slots, table)
}

/// `hotspots`' rows' files from the classified read: every counted file of
/// every commit, summed per file under its kept row. The spec is always
/// sourced, so a one-file row is a count of one.
fn hotspot_reports(
    files: &[CommitFiles],
    set: KindSet,
    depth: usize,
    kept: &[PathStat],
) -> (Vec<Value>, MemberTable) {
    let rows: Vec<&str> = kept.iter().map(|stat| stat.path.as_str()).collect();
    let counted = files.iter().flat_map(|commit| {
        commit
            .files
            .iter()
            .filter(move |file| set.holds(file.kind))
            .map(|file| (file.path.as_str(), file.added, file.deleted))
    });
    path_reports(path_members(counted, depth, &rows), true)
}

/// `landed`'s rows' files from the counted files of the diff. Only a
/// resolved range is `sourced`; without one a set lists its own members and
/// a one-file row stays a link.
fn landed_reports(
    counted: &[FileStat],
    depth: usize,
    kept: &[LandedRow],
    sourced: bool,
) -> (Vec<Value>, MemberTable) {
    let rows: Vec<&str> = kept.iter().map(|row| row.path.as_str()).collect();
    let files = counted.iter().map(|file| {
        (
            file.path.as_str(),
            u64::from(file.added.unwrap_or(0)),
            u64::from(file.deleted.unwrap_or(0)),
        )
    });
    path_reports(path_members(files, depth, &rows), sourced)
}

/// The most changed paths as a horizontal bar, each row carrying the files
/// under it so a press opens them.
fn hotspots_chart(stats: &[PathStat], refs: Vec<Value>, title: &str, subtitle: &str) -> Value {
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
        "refs": refs,
    })
}

/// The shallowest grouping depth at which no directory row holds more than
/// a third of the lines counted, or [`MAX_CHOSEN_DEPTH`]. A row that is one
/// file cannot be descended into, so it never forces another level.
pub(crate) fn choose_depth(commits: &[CommitFiles], set: KindSet) -> usize {
    (1..=MAX_CHOSEN_DEPTH)
        .find(|&depth| {
            let rows = group_paths(commits, set, depth);
            let total: u64 = rows.iter().map(|row| row.added + row.deleted).sum();
            !rows
                .iter()
                .any(|row| !row.is_file && (row.added + row.deleted) * 3 > total)
        })
        .unwrap_or(MAX_CHOSEN_DEPTH)
}

pub(crate) fn hotspots(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let path = args.path.as_deref();
    let limit = args
        .limit
        .unwrap_or(DEFAULT_HOTSPOT_LIMIT)
        .clamp(1, MAX_ROWS);
    let (window, range) = span(args, DEFAULT_DAYS);
    let scope = LineScope::of(ctx, args)?;
    let files = scope.read(ctx, &window, path)?;
    let (depth, chosen) = match args.depth {
        Some(depth) => (depth.max(1) as usize, ""),
        None => (choose_depth(&files, scope.set), " (chosen)"),
    };
    let stats = group_paths(&files, scope.set, depth);
    let dropped = left_out_lines(&left_out(&files, scope.set));
    if stats.is_empty() {
        return Ok(scope.nothing(&range, &dropped));
    }
    let kept = &stats[..stats.len().min(limit)];
    let title = titled(
        &format!(
            "Most changed paths, {}",
            window_label(args, &window, DEFAULT_DAYS)
        ),
        path,
    );
    let summary = format!(
        "{} of {} path(s) at depth {depth}{chosen}, {range}{dropped}{}",
        kept.len(),
        stats.len(),
        left_out_rows(stats.len() - kept.len())
    );
    let source = SourceArgs::window(&window)
        .with("depth", depth)
        .with("limit", limit)
        .with("lines", &scope.name)
        .maybe("path", path);
    let (refs, members) = hotspot_reports(&files, scope.set, depth, kept);
    Ok(charted(
        summary,
        hotspots_chart(kept, refs, &title, &format!("{range}{dropped}")),
        args,
        "hotspots",
        Some(source),
        members,
    ))
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

fn landed_chart(rows: &[LandedRow], refs: Vec<Value>, title: &str, subtitle: &str) -> Value {
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
        "refs": refs,
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
    let lines = LineScope::of(ctx, args)?;
    let (counted, uncounted): (Vec<FileStat>, Vec<FileStat>) = report
        .files
        .into_iter()
        .partition(|file| lines.set.holds(lines.kinds.classify(&file.path)));
    let dropped = left_out_lines(&landed_left_out(&uncounted, &lines.kinds));
    if counted.is_empty() && uncounted.is_empty() {
        return Ok(RecipeOutcome::NoData {
            summary: format!("no changes, {scope}"),
        });
    }
    if counted.is_empty() {
        return Ok(RecipeOutcome::NoData {
            summary: format!("no {} changes, {scope}{dropped}", lines.name),
        });
    }
    let depth = args.depth.unwrap_or(DEFAULT_LANDED_DEPTH).max(1) as usize;
    let rows = landed_rows(&counted, depth);
    let kept = &rows[..rows.len().min(MAX_ROWS)];
    let summary = format!(
        "{} file(s) under {} path(s), {scope}{dropped}{}",
        counted.len(),
        rows.len(),
        left_out_rows(rows.len() - kept.len())
    );
    // Only a range has an absolute spelling: the working tree, the index and
    // a session's files move under a reader, so those stamp nothing.
    let source = args
        .range
        .as_deref()
        .and_then(|range| resolved_range(&ctx.repo_root, range))
        .map(|range| {
            SourceArgs::new()
                .with("range", range)
                .with("depth", depth)
                .with("lines", &lines.name)
        });
    let (refs, members) = landed_reports(&counted, depth, kept, source.is_some());
    let spec = landed_chart(
        kept,
        refs,
        "Lines changed by directory",
        &format!("{scope}{dropped}"),
    );
    Ok(charted(summary, spec, args, "landed", source, members))
}

/// The lines of `files` summed per kind, in [`LineKind::ALL`] order; a kind
/// with no line is absent.
fn landed_left_out(files: &[FileStat], kinds: &LineKinds) -> Vec<(LineKind, u64)> {
    let mut sums: BTreeMap<LineKind, u64> = BTreeMap::new();
    for file in files {
        let lines = u64::from(file.added.unwrap_or(0)) + u64::from(file.deleted.unwrap_or(0));
        *sums.entry(kinds.classify(&file.path)).or_default() += lines;
    }
    sums.into_iter().filter(|(_, lines)| *lines > 0).collect()
}

/// `a..b` with each end resolved to the sha it named, so the stamp survives a
/// branch moving; `None` when git cannot resolve one.
fn resolved_range(repo_root: &std::path::Path, range: &str) -> Option<String> {
    let (from, to) = range.split_once("..")?;
    let to = if to.is_empty() { "HEAD" } else { to };
    // `--short` takes one revision at a time.
    let sha = |rev: &str| -> Option<String> {
        let out = git_output(repo_root, &["rev-parse", "--short", rev]).ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    Some(format!("{}..{}", sha(from)?, sha(to)?))
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

/// The most common kinds become series, the rest fold into `other`. Each
/// series carries that kind's commits per day in its `refs`, all the series
/// spending one budget.
fn kinds_chart(entries: &[LogEntry], title: &str, subtitle: &str) -> Option<KindChart> {
    let dated: Vec<(NaiveDate, String, &str)> = entries
        .iter()
        .filter_map(|entry| {
            Some((
                entry_day(entry)?,
                commit_kind(&entry.subject),
                entry.sha.as_str(),
            ))
        })
        .collect();
    let (axis, left_out) = day_axis(dated.iter().map(|(day, _, _)| *day));
    if axis.is_empty() {
        return None;
    }

    let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
    for (_, kind, _) in &dated {
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
    let mut rows: Vec<Vec<Vec<String>>> = vec![vec![Vec::new(); axis.len()]; names.len()];
    for (day, kind, sha) in &dated {
        let Some(&at) = day_index.get(day) else {
            continue;
        };
        let series = names
            .iter()
            .position(|name| *name == kind.as_str())
            .unwrap_or(names.len() - 1);
        rows[series][at].push(commit_ref(sha));
    }
    // Each cell's commits, before the budget folds any of them.
    let mut members = MemberTable::default();
    for (col, buckets) in rows.iter().enumerate() {
        for (row, refs) in buckets.iter().enumerate() {
            members.set(MemberKey::Cell { row, col }, plain(refs));
        }
    }
    let mut budget = RefBudget::new();
    let series: Vec<Value> = names
        .iter()
        .zip(rows)
        .map(|(name, buckets)| {
            let values: Vec<usize> = buckets.iter().map(Vec::len).collect();
            let refs = set_slots("commit", buckets, &mut budget);
            json!({ "name": name, "values": values, "refs": refs })
        })
        .collect();
    Some(KindChart {
        folded,
        chart: DayChart {
            days: axis.len(),
            left_out,
            members,
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
    let (report, source) = read_log(ctx, args)?;
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
    Ok(charted(
        summary,
        chart.spec,
        args,
        "commit-kinds",
        Some(source),
        chart.members,
    ))
}

/// A commit's ref and its committer day, which is what a heat bucket's
/// members are grouped by.
type Dated = (String, String);

fn dated(entry: &LogEntry) -> Dated {
    (commit_ref(&entry.sha), entry.date.clone())
}

/// The commits of each hour of the day, in the committer's own offset. `None`
/// when no commit carries a time that parses.
fn hours(entries: &[LogEntry]) -> Option<Vec<Vec<Dated>>> {
    let mut buckets = vec![Vec::new(); 24];
    let mut any = false;
    for entry in entries {
        if let Ok(at) = DateTime::parse_from_rfc3339(&entry.at) {
            buckets[at.hour() as usize].push(dated(entry));
            any = true;
        }
    }
    any.then_some(buckets)
}

/// `Row(i)` per bucket: its commits deduplicated, each grouped under its
/// day, newest day first.
fn dated_rows(buckets: &[Vec<Dated>]) -> MemberTable {
    let mut table = MemberTable::default();
    for (i, bucket) in buckets.iter().enumerate() {
        let mut seen: Vec<&Dated> = Vec::with_capacity(bucket.len());
        for d in bucket {
            if !seen.iter().any(|s| s.0 == d.0) {
                seen.push(d);
            }
        }
        seen.sort_by(|a, b| b.1.cmp(&a.1));
        let members = seen
            .into_iter()
            .map(|(r, day)| Member::of(r.clone()).grouped(day.clone()))
            .collect();
        table.set(MemberKey::Row(i), members);
    }
    table
}

/// A heat strip of one bucket per category: the count drawn, the bucket's
/// commits in `refs`, and the same commits in the member table under their
/// days.
fn heat_chart(
    categories: &[String],
    buckets: Vec<Vec<Dated>>,
    title: &str,
    subtitle: &str,
) -> (Value, MemberTable) {
    let members = dated_rows(&buckets);
    let buckets: Vec<Vec<String>> = buckets
        .into_iter()
        .map(|bucket| bucket.into_iter().map(|(r, _)| r).collect())
        .collect();
    let counts: Vec<usize> = buckets.iter().map(Vec::len).collect();
    let refs = set_slots("commit", buckets, &mut RefBudget::new());
    let spec = json!({
        "tugchart": 1,
        "form": "heat",
        "title": title,
        "subtitle": clip_front(subtitle, MAX_LABEL),
        "unit": "commits",
        "format": "int",
        "categories": categories,
        "values": counts,
        "refs": refs,
    });
    (spec, members)
}

fn hours_chart(buckets: Vec<Vec<Dated>>, title: &str, subtitle: &str) -> (Value, MemberTable) {
    let categories: Vec<String> = (0..24).map(|hour| format!("{hour:02}")).collect();
    heat_chart(&categories, buckets, title, subtitle)
}

pub(crate) fn commit_hours(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let (report, source) = read_log(ctx, args)?;
    let Some(buckets) = hours(&report.commits) else {
        return Ok(no_commits(&report.range));
    };
    let title = titled("Commits by hour of day", args.path.as_deref());
    let summary = format!(
        "{} commit(s) by committer's local hour, {}",
        report.commits.len(),
        report.range
    );
    let (spec, members) = hours_chart(buckets, &title, &report.range);
    Ok(charted(
        summary,
        spec,
        args,
        "commit-hours",
        Some(source),
        members,
    ))
}

/// The commits of each weekday, Monday first, in the committer's own offset.
/// `None` when no commit carries a time that parses.
fn weekdays(entries: &[LogEntry]) -> Option<Vec<Vec<Dated>>> {
    let mut buckets = vec![Vec::new(); 7];
    let mut any = false;
    for entry in entries {
        if let Ok(at) = DateTime::parse_from_rfc3339(&entry.at) {
            buckets[at.weekday().num_days_from_monday() as usize].push(dated(entry));
            any = true;
        }
    }
    any.then_some(buckets)
}

pub(crate) fn commit_days(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let (report, source) = read_log(ctx, args)?;
    let Some(buckets) = weekdays(&report.commits) else {
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
    let (spec, members) = heat_chart(&categories, buckets, &title, &report.range);
    Ok(charted(
        summary,
        spec,
        args,
        "commit-days",
        Some(source),
        members,
    ))
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

/// A built commit-size chart, and what the summary line reports of it.
struct SizeChart {
    spec: Value,
    members: MemberTable,
    median: f64,
    /// The largest size drawn in a range bin.
    cap: u64,
    /// How many commits are past the cap, in the last bin.
    over: usize,
}

/// Lines changed per commit as a bar over the engine's own histogram bins
/// of the commits up to the 90th-percentile size, and one last bar, `over
/// <cap>`, for the commits past it. A histogram cannot draw that last bin,
/// since every bin of one is a range, and on a linear range one generated
/// file presses every ordinary commit into the first bin. Each bin's
/// commits are its members, smallest first, measured by the lines they
/// changed and carrying their added and removed lines.
fn commit_size_chart(
    commits: &[CommitLines],
    title: &str,
    range: &str,
    dropped: &str,
) -> Option<SizeChart> {
    let lines: Vec<u64> = commits.iter().map(CommitLines::lines).collect();
    let as_f64: Vec<f64> = lines.iter().map(|lines| *lines as f64).collect();
    let middle = median(&as_f64)?;
    let (_, cap) = without_the_largest_tenth(&lines);
    let (drawn, over): (Vec<&CommitLines>, Vec<&CommitLines>) =
        commits.iter().partition(|c| c.lines() <= cap);
    let sizes: Vec<f64> = drawn.iter().map(|c| c.lines() as f64).collect();
    let (mut labels, bins) = binned(&sizes, "count")?;
    let mut buckets: Vec<Vec<&CommitLines>> = bins
        .iter()
        .map(|bin| bin.iter().map(|&i| drawn[i]).collect())
        .collect();
    if !over.is_empty() {
        labels.push(format!("over {}", format_measure("count", cap as f64)));
        buckets.push(over.clone());
    }
    let mut members = MemberTable::measured("lines changed", "count");
    for (row, bucket) in buckets.iter_mut().enumerate() {
        bucket.sort_by_key(|c| c.lines());
        let set = bucket
            .iter()
            .map(|c| {
                Member::of(commit_ref(&c.sha))
                    .measured(c.lines() as f64)
                    .parted(c.added as f64, c.deleted as f64)
            })
            .collect();
        members.set(MemberKey::Row(row), set);
    }
    let counts: Vec<usize> = buckets.iter().map(Vec::len).collect();
    let refs = set_slots(
        "commit",
        buckets
            .iter()
            .map(|bucket| bucket.iter().map(|c| commit_ref(&c.sha)).collect())
            .collect(),
        &mut RefBudget::new(),
    );
    let subtitle = format!("{range}; median {middle} line(s){dropped}");
    Some(SizeChart {
        median: middle,
        cap,
        over: over.len(),
        members,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "title": title,
            "subtitle": clip_front(&subtitle, MAX_LABEL),
            "unit": "commits",
            "format": "int",
            "categories": labels,
            "series": [{ "name": "commits", "values": counts }],
            "refs": refs,
        }),
    })
}

pub(crate) fn commit_size(
    ctx: &RecipeContext,
    args: &RecipeArgs,
) -> Result<RecipeOutcome, RecipeError> {
    if let Some(answer) = git_gate(ctx) {
        return Ok(answer);
    }
    let path = args.path.as_deref();
    let (window, range) = span(args, DEFAULT_DAYS);
    let scope = LineScope::of(ctx, args)?;
    let files = scope.read(ctx, &window, path)?;
    let sizes: Vec<CommitLines> = commit_lines(&files, scope.set);
    let dropped = left_out_lines(&left_out(&files, scope.set));
    if sizes.is_empty() {
        return Ok(scope.nothing(&range, &dropped));
    }
    // Newest first from the read, so the commits past the limit are the oldest.
    let kept = &sizes[..sizes.len().min(MAX_VALUES)];
    let title = titled("Lines changed per commit", path);
    let Some(chart) = commit_size_chart(kept, &title, &range, &dropped) else {
        return Ok(scope.nothing(&range, &dropped));
    };
    let tail = if chart.over == 0 {
        String::new()
    } else {
        format!(
            "; {} over {} line(s) in the last bin",
            chart.over, chart.cap
        )
    };
    let summary = format!(
        "{} commit(s), median {} line(s) changed, {range}{dropped}{tail}{}",
        kept.len(),
        chart.median,
        left_out_older(sizes.len() - kept.len(), "commit")
    );
    let (spec, members) = (chart.spec, chart.members);
    let source = SourceArgs::window(&window)
        .with("lines", &scope.name)
        .maybe("path", path);
    Ok(charted(
        summary,
        spec,
        args,
        "commit-size",
        Some(source),
        members,
    ))
}

/// A built velocity chart, and what the summary line reports of it.
struct VelocityChart {
    spec: Value,
    weeks: usize,
    left_out: usize,
    total: i64,
    median: f64,
    members: MemberTable,
}

/// Lines per week as an area, empty weeks included, with a rule at the median
/// week. `net` draws added minus removed in place of added plus removed.
/// Each week carries its days' commits in `refs`, parallel to `x`, and in
/// the member table, each measured as the week is.
fn velocity_chart(
    commits: &[CommitLines],
    net: bool,
    title: &str,
    subtitle: &str,
) -> Option<VelocityChart> {
    let stats = day_stats(commits);
    let mut by_week: HashMap<NaiveDate, (i64, Vec<String>)> = HashMap::new();
    for stat in &stats {
        let Ok(day) = NaiveDate::parse_from_str(&stat.day, "%Y-%m-%d") else {
            continue;
        };
        let (added, deleted) = (stat.added as i64, stat.deleted as i64);
        let lines = if net {
            added - deleted
        } else {
            added + deleted
        };
        let week = by_week.entry(week_start(day)).or_default();
        week.0 += lines;
        week.1.extend(stat.shas.iter().map(|sha| commit_ref(sha)));
    }
    let (axis, left_out) = week_axis(by_week.keys().copied());
    if axis.is_empty() {
        return None;
    }
    let values: Vec<i64> = axis
        .iter()
        .map(|week| by_week.get(week).map_or(0, |(lines, _)| *lines))
        .collect();
    let buckets: Vec<Vec<String>> = axis
        .iter()
        .map(|week| by_week.remove(week).map_or_else(Vec::new, |(_, shas)| shas))
        .collect();
    let refs = set_slots("commit", buckets, &mut RefBudget::new());
    let as_f64: Vec<f64> = values.iter().map(|lines| *lines as f64).collect();
    let middle = median(&as_f64)?;
    let name = if net { "net lines" } else { "lines changed" };
    let lines = |c: &CommitLines| {
        if net {
            c.added as f64 - c.deleted as f64
        } else {
            c.lines() as f64
        }
    };
    let members = measured_rows(&axis, commits, week_start, lines, name);
    Some(VelocityChart {
        weeks: axis.len(),
        left_out,
        total: values.iter().sum(),
        median: middle,
        members,
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
            "refs": refs,
        }),
    })
}

/// `velocity` split by kind: a stacked bar with one series per counted kind
/// of the measure in force, over the unsplit chart's weeks, and the rule at
/// the median of the weekly totals, which are the unsplit chart's values.
/// Each series carries its commits per week in `refs`, all spending one
/// budget, and each cell's commits are its members, measured as the series
/// is.
fn velocity_split_chart(
    commits: &[CommitLines],
    views: &[KindView],
    net: bool,
    title: &str,
    subtitle: &str,
) -> Option<VelocityChart> {
    let (axis, left_out) = week_axis(dated_days(commits));
    if axis.is_empty() {
        return None;
    }
    let name = if net { "net lines" } else { "lines changed" };
    let measure: Measure = if net {
        |c| c.added as f64 - c.deleted as f64
    } else {
        |c| c.lines() as f64
    };
    let mut totals = vec![0i64; axis.len()];
    let mut members = MemberTable::measured(name, "count");
    let mut budget = RefBudget::new();
    let mut series = Vec::with_capacity(views.len());
    for (col, (kind, view)) in views.iter().enumerate() {
        let lines = bucketed(&axis, view, week_start);
        let values: Vec<i64> = lines
            .added
            .iter()
            .zip(&lines.deleted)
            .map(|(a, d)| if net { a - d } else { a + d })
            .collect();
        for (total, value) in totals.iter_mut().zip(&values) {
            *total += value;
        }
        for (row, cell) in member_rows(&axis, view, week_start, measure)
            .into_iter()
            .enumerate()
        {
            members.set(MemberKey::Cell { row, col }, cell);
        }
        let refs = set_slots("commit", lines.refs, &mut budget);
        series.push(json!({ "name": kind.name(), "values": values, "refs": refs }));
    }
    let as_f64: Vec<f64> = totals.iter().map(|lines| *lines as f64).collect();
    let middle = median(&as_f64)?;
    Some(VelocityChart {
        weeks: axis.len(),
        left_out,
        total: totals.iter().sum(),
        median: middle,
        members,
        spec: json!({
            "tugchart": 1,
            "form": "bar",
            "layout": "stacked",
            "title": title,
            "subtitle": clip_front(subtitle, MAX_LABEL),
            "unit": name,
            "format": "count",
            "categories": labels(&axis),
            "series": series,
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
    let path = args.path.as_deref();
    let (window, range) = span(args, DEFAULT_VELOCITY_DAYS);
    let scope = LineScope::of(ctx, args)?;
    let files = scope.read(ctx, &window, path)?;
    let commits = commit_lines(&files, scope.set);
    let dropped = left_out_lines(&left_out(&files, scope.set));
    let base = if args.net {
        "Net lines per week"
    } else {
        "Lines changed per week"
    };
    let title = titled(base, path);
    let subtitle = format!("{range}{dropped}");
    let chart = if args.split {
        let views = kind_views(&files, scope.set);
        velocity_split_chart(&commits, &views, args.net, &title, &subtitle)
    } else {
        velocity_chart(&commits, args.net, &title, &subtitle)
    };
    let Some(chart) = chart else {
        return Ok(scope.nothing(&range, &dropped));
    };
    let noun = if args.net {
        "net line(s)"
    } else {
        "line(s) changed"
    };
    let summary = format!(
        "{} {noun} over {} week(s), median {} a week, {range}{dropped}{}",
        chart.total,
        chart.weeks,
        chart.median,
        left_out_older(chart.left_out, "week")
    );
    let source = SourceArgs::window(&window)
        .with("net", args.net)
        .with("lines", &scope.name)
        .with("split", args.split)
        .maybe("path", path);
    Ok(charted(
        summary,
        chart.spec,
        args,
        "velocity",
        Some(source),
        chart.members,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::test_support::{assert_source, assert_valid};
    use crate::members::{Address, Resolved, args_from_source, resolve};
    use tugchanges_core::FileLines;
    use tugcore::test_fixtures::git::{GitFixture, git};

    #[test]
    fn commits_per_day_fills_the_zero_days_and_validates() {
        let spec = commits_per_day(
            &[
                sha_entry("aaa1111", "2026-10-27"),
                sha_entry("bbb2222", "2026-10-29"),
                sha_entry("ccc3333", "2026-10-29"),
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
        // Each bar carries its commits: one ref, nothing, a set — parallel to
        // the categories, in log order within a day.
        assert_eq!(
            spec["refs"],
            json!(["commit:aaa1111", null, ["commit:bbb2222", "commit:ccc3333"]])
        );
        assert_valid(&spec);
    }

    #[test]
    fn ninety_days_of_commits_stay_under_the_bash_result_limit() {
        // 90 days × 22 commits: the budget folds the oldest days into counts
        // and the spec serializes well under the 30,000-character line a
        // Bash result is cut at (Risk R01).
        let start = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let mut entries = Vec::new();
        for d in 0..90u64 {
            let day = start
                .checked_add_days(Days::new(d))
                .unwrap()
                .format("%Y-%m-%d")
                .to_string();
            for c in 0..22u32 {
                entries.push(sha_entry(&format!("{d:03}{c:04x}"), &day));
            }
        }
        let spec = commits_per_day(&entries, "Commits per day", "last 90 days").unwrap();
        assert_valid(&spec);
        let refs = spec["refs"].as_array().unwrap();
        assert_eq!(refs.len(), 90);
        assert!(refs[89].is_array(), "the newest day keeps its commits");
        assert!(refs[0].is_object(), "the oldest day is a count");
        let bytes = serde_json::to_string(&spec).unwrap().len();
        assert!(bytes < 24_000, "{bytes} bytes");
    }

    fn sha_entry(sha: &str, date: &str) -> LogEntry {
        LogEntry {
            sha: sha.to_string(),
            ..entry("s", date)
        }
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

    /// One commit on `day`, its sha the day's digits.
    fn stat(day: &str, added: u64, deleted: u64) -> CommitLines {
        CommitLines {
            sha: day.replace('-', ""),
            day: day.to_string(),
            added,
            deleted,
        }
    }

    /// The sum of a row's measures, which is what the row's bar draws.
    fn row_sum(table: &MemberTable, row: usize) -> f64 {
        table
            .get(MemberKey::Row(row))
            .iter()
            .map(|m| m.measure.unwrap())
            .sum()
    }

    fn file(path: &str, added: u64, deleted: u64) -> FileLines {
        FileLines {
            path: path.to_string(),
            kind: LineKinds::defaults().classify(path),
            added,
            deleted,
        }
    }

    fn files(sha: &str, day: &str, files: Vec<FileLines>) -> CommitFiles {
        CommitFiles {
            sha: sha.to_string(),
            day: day.to_string(),
            files,
        }
    }

    /// Source and tests lines on two days of one week and one day two weeks
    /// on, with a docs file the `code` set leaves out.
    fn mixed() -> Vec<CommitFiles> {
        vec![
            files(
                "aaa0001",
                "2026-10-05",
                vec![file("src/a.rs", 10, 2), file("tests/a.rs", 4, 1)],
            ),
            files("aaa0002", "2026-10-05", vec![file("src/b.rs", 1, 0)]),
            files("aaa0003", "2026-10-07", vec![file("tests/b.rs", 1, 6)]),
            files("aaa0004", "2026-10-07", vec![file("README.md", 5, 0)]),
            files("aaa0005", "2026-10-19", vec![file("src/c.rs", 100, 50)]),
        ]
    }

    fn cell_refs(table: &MemberTable, row: usize, col: usize) -> Vec<(String, f64)> {
        table
            .get(MemberKey::Cell { row, col })
            .iter()
            .map(|m| (m.r#ref.clone().unwrap(), m.measure.unwrap()))
            .collect()
    }

    fn values(spec: &Value, series: usize) -> Vec<i64> {
        spec["series"][series]["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect()
    }

    /// One commit touching each `(path, lines)`, every line an addition.
    fn tree(paths: &[(&str, u64)]) -> Vec<CommitFiles> {
        let touched = paths
            .iter()
            .map(|(path, lines)| file(path, *lines, 0))
            .collect();
        vec![files("aaa0001", "2026-10-05", touched)]
    }

    #[test]
    fn choose_depth_descends_until_no_directory_holds_over_a_third() {
        let code = KindSet::parse("code").unwrap();
        // One directory holding everything descends until its children split it.
        let one = tree(&[("a/x/1.rs", 10), ("a/y/2.rs", 10), ("a/z/3.rs", 10)]);
        assert_eq!(choose_depth(&one, code), 2);
        // A tree already balanced at depth 1 stays there.
        let balanced = tree(&[("a/1.rs", 10), ("b/2.rs", 10), ("c/3.rs", 10)]);
        assert_eq!(choose_depth(&balanced, code), 1);
        // A dominant file stops the descent where it becomes a file row.
        let dominant = tree(&[("src/big.rs", 100), ("src/x/1.rs", 10), ("lib/2.rs", 10)]);
        assert_eq!(choose_depth(&dominant, code), 2);
        // A chain deeper than the cap stops at the cap.
        let chain = tree(&[("a/b/c/d/e/f/g/h.rs", 10), ("a/b/c/d/e/f/g/i.rs", 10)]);
        assert_eq!(choose_depth(&chain, code), 6);
    }

    #[test]
    fn a_split_churn_draws_each_kind_added_above_and_removed_below() {
        let read = mixed();
        let code = KindSet::parse("code").unwrap();
        let commits = commit_lines(&read, code);
        let split = churn_split_chart(&commits, &kind_views(&read, code), "t", "s").unwrap();
        let whole = churn_chart(&commits, "t", "s").unwrap();
        assert_valid(&split.spec);
        assert_eq!(split.spec["form"], "bar");
        assert_eq!(split.spec["layout"], "stacked");
        assert_eq!(split.spec["categories"], whole.spec["categories"]);
        assert!(split.spec.get("refs").is_none());
        let names: Vec<&str> = split.spec["series"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "source added",
                "tests added",
                "source removed",
                "tests removed"
            ]
        );
        assert!(
            split.spec["series"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s.get("role").is_none())
        );
        // Each day's parts sum, by magnitude, to the unsplit day.
        let (added, removed) = (values(&whole.spec, 0), values(&whole.spec, 1));
        for day in 0..added.len() {
            assert_eq!(
                values(&split.spec, 0)[day] + values(&split.spec, 1)[day],
                added[day]
            );
            assert!(values(&split.spec, 2)[day] <= 0 && values(&split.spec, 3)[day] <= 0);
            assert_eq!(
                values(&split.spec, 2)[day] + values(&split.spec, 3)[day],
                removed[day]
            );
        }
        assert_eq!(values(&split.spec, 0)[..3], [11, 0, 0]);
        assert_eq!(values(&split.spec, 3)[..3], [-1, 0, -6]);
        // A cell's members are that kind's commits that day, measured as drawn.
        let commit = |sha: &str| commit_ref(sha);
        assert_eq!(
            cell_refs(&split.members, 0, 0),
            [(commit("aaa0001"), 10.0), (commit("aaa0002"), 1.0)]
        );
        assert_eq!(cell_refs(&split.members, 2, 3), [(commit("aaa0003"), 6.0)]);
        assert_eq!(cell_refs(&split.members, 2, 0), []);
        // Each series carries its commits, parallel to the days.
        assert_eq!(split.spec["series"][1]["refs"][2], json!(commit("aaa0003")));
    }

    #[test]
    fn a_split_velocity_stacks_each_kind_and_rules_the_unsplit_median() {
        let read = mixed();
        let code = KindSet::parse("code").unwrap();
        let commits = commit_lines(&read, code);
        let views = kind_views(&read, code);
        for net in [false, true] {
            let split = velocity_split_chart(&commits, &views, net, "t", "s").unwrap();
            let whole = velocity_chart(&commits, net, "t", "s").unwrap();
            assert_valid(&split.spec);
            assert_eq!(split.spec["form"], "bar");
            assert_eq!(split.spec["layout"], "stacked");
            assert_eq!(split.spec["categories"], whole.spec["x"]);
            assert_eq!(split.spec["series"][0]["name"], "source");
            assert_eq!(split.spec["series"][1]["name"], "tests");
            let unsplit = values(&whole.spec, 0);
            let (source, tests) = (values(&split.spec, 0), values(&split.spec, 1));
            for (week, total) in unsplit.iter().enumerate() {
                assert_eq!(source[week] + tests[week], *total);
            }
            assert_eq!(split.median, whole.median);
            assert_eq!(split.total, whole.total);
            assert_eq!(split.spec["annotations"], whole.spec["annotations"]);
            if net {
                // The first week removed more tests than it added.
                assert_eq!(values(&split.spec, 1)[0], -2);
                assert_eq!(
                    cell_refs(&split.members, 0, 1),
                    [(commit_ref("aaa0001"), 3.0), (commit_ref("aaa0003"), -5.0)]
                );
            }
        }
    }

    #[test]
    fn a_kind_with_no_line_in_the_window_has_no_series() {
        let read = mixed();
        let all = KindSet::parse("all").unwrap();
        let kinds: Vec<LineKind> = kind_views(&read, all).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kinds, [LineKind::Source, LineKind::Tests, LineKind::Docs]);
        let commits = commit_lines(&read, all);
        let split = churn_split_chart(&commits, &kind_views(&read, all), "t", "s").unwrap();
        assert_valid(&split.spec);
        let names: Vec<&str> = split.spec["series"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "source added",
                "tests added",
                "docs added",
                "source removed",
                "tests removed",
                "docs removed"
            ]
        );
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
        // Each week carries its days' commits, parallel to the weeks.
        assert_eq!(
            chart.spec["refs"],
            json!([
                ["commit:20261005", "commit:20261007"],
                null,
                "commit:20261019"
            ])
        );
        // And the table's members, each measured as the week is, sum to it.
        assert_eq!(
            chart.members.measure,
            Some(("lines changed".to_string(), "count".to_string()))
        );
        for (row, value) in [16.0, 0.0, 150.0].into_iter().enumerate() {
            assert_eq!(row_sum(&chart.members, row), value, "week {row}");
        }
        assert_eq!(chart.members.get(MemberKey::Row(0)).len(), 2);
        assert!(chart.members.get(MemberKey::Row(1)).is_empty());
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
        assert_eq!(
            chart.members.measure,
            Some(("net lines".to_string(), "count".to_string()))
        );
        assert_eq!(row_sum(&chart.members, 0), 8.0);
        assert_eq!(row_sum(&chart.members, 1), -8.0);
    }

    #[test]
    fn the_left_out_clause_names_each_kind_it_left_out() {
        use LineKind::*;
        assert_eq!(left_out_lines(&[]), "");
        assert_eq!(left_out_lines(&[(Docs, 40)]), "; left out: 40 docs line(s)");
        assert_eq!(
            left_out_lines(&[(Data, 37_000), (Docs, 300)]),
            "; left out: 37.3k data and docs line(s)"
        );
        assert_eq!(
            left_out_lines(&[(Tests, 1), (Data, 2), (Docs, 3)]),
            "; left out: 6 tests, data and docs line(s)"
        );
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
    fn a_commit_size_bar_keeps_the_largest_tenth_in_a_last_bin() {
        let mut commits: Vec<CommitLines> = (1..=9u64)
            .map(|n| CommitLines {
                sha: format!("aaa000{n}"),
                day: "2026-10-05".to_string(),
                added: n,
                deleted: 0,
            })
            .collect();
        commits.insert(
            0,
            CommitLines {
                sha: "bbb0000".to_string(),
                day: "2026-10-06".to_string(),
                added: 50_000,
                deleted: 10_000,
            },
        );
        let chart = commit_size_chart(&commits, "t", "r", "").unwrap();
        assert_valid(&chart.spec);
        assert_eq!(chart.spec["form"], "bar");
        assert_eq!(chart.spec["unit"], "commits");
        assert_eq!((chart.cap, chart.over), (9, 1));
        // The nine are the engine's bins; the outlier is one last bar.
        let (labels, bins) = binned(&(1..=9).map(f64::from).collect::<Vec<_>>(), "count").unwrap();
        let mut categories = labels.clone();
        categories.push("over 9".to_string());
        assert_eq!(chart.spec["categories"], json!(categories));
        let mut counts: Vec<usize> = bins.iter().map(Vec::len).collect();
        counts.push(1);
        assert_eq!(chart.spec["series"][0]["values"], json!(counts));
        let last = chart.members.get(MemberKey::Row(labels.len()));
        assert_eq!(
            last,
            [Member::of("commit:bbb0000")
                .measured(60_000.0)
                .parted(50_000.0, 10_000.0)]
        );
        // Pressed by its label, the last bin answers the outlier, and a bin
        // its range commits, smallest first.
        let over = Address {
            row: labels.len(),
            label: "over 9".to_string(),
            ..Default::default()
        };
        assert_eq!(
            resolve(&chart.spec, &chart.members, &over),
            Resolved::Members(last.to_vec())
        );
        let first = Address {
            row: 0,
            label: labels[0].clone(),
            ..Default::default()
        };
        let Resolved::Members(found) = resolve(&chart.spec, &chart.members, &first) else {
            panic!("the first bin moved");
        };
        let sizes: Vec<f64> = found.iter().map(|m| m.measure.unwrap()).collect();
        assert_eq!(sizes.len(), bins[0].len());
        assert!(sizes.windows(2).all(|w| w[0] <= w[1]), "{sizes:?}");
        assert_eq!(subtitle_of(&chart.spec), "r; median 5.5 line(s)");

        // No commit past the cap, no last bin.
        let even = &commits[1..4];
        let chart = commit_size_chart(even, "t", "r", "").unwrap();
        assert_eq!(chart.over, 0);
        assert!(
            !chart.spec["categories"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c.as_str().unwrap().starts_with("over")),
            "{}",
            chart.spec
        );
    }

    fn subtitle_of(spec: &Value) -> &str {
        spec["subtitle"].as_str().unwrap()
    }

    #[test]
    fn a_weekday_is_read_in_the_committers_own_offset() {
        // 23:30 on a Thursday in its own offset is already Friday in UTC.
        let buckets = weekdays(&[at("2026-10-29T23:30:00-07:00"), at("not a time")]).unwrap();
        let counts: Vec<usize> = buckets.iter().map(Vec::len).collect();
        assert_eq!(counts, [0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(
            buckets[3],
            vec![("commit:abc1234".to_string(), "2026-10-29".to_string())]
        );
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
    fn a_churn_chart_draws_added_above_zero_and_removed_below_over_filled_days() {
        let commit = |sha: &str, day: &str, added, deleted| CommitLines {
            sha: sha.to_string(),
            day: day.to_string(),
            added,
            deleted,
        };
        let commits = [
            commit("aaa1111", "2026-10-28", 5, 0),
            commit("bbb2222", "2026-10-28", 0, 1),
            commit("ccc3333", "2026-10-30", 0, 7),
        ];
        let chart = churn_chart(&commits, "t", "s").unwrap();
        assert_eq!(chart.days, 3);
        assert_eq!(chart.spec["form"], "bar");
        assert_eq!(chart.spec["layout"], "stacked");
        assert_eq!(
            chart.spec["categories"],
            json!(["2026-10-28", "2026-10-29", "2026-10-30"])
        );
        assert!(chart.spec.get("x").is_none());
        assert_eq!(chart.spec["series"][0]["name"], "added");
        assert_eq!(chart.spec["series"][0]["role"], "good");
        assert_eq!(chart.spec["series"][0]["values"], json!([5, 0, 0]));
        assert_eq!(chart.spec["series"][1]["role"], "bad");
        assert_eq!(chart.spec["series"][1]["values"], json!([-1, 0, -7]));
        // Each day carries its commits, the filled day none.
        assert_eq!(
            chart.spec["refs"],
            json!([["commit:aaa1111", "commit:bbb2222"], null, "commit:ccc3333"])
        );
        assert_valid(&chart.spec);
        // The table measures each commit's lines, and a row's members sum to
        // the day's added plus removed.
        assert_eq!(
            chart.members.measure,
            Some(("lines".to_string(), "count".to_string()))
        );
        let day = chart.members.get(MemberKey::Row(0));
        assert_eq!(day.len(), 2);
        assert_eq!(
            day[0],
            Member::of("commit:aaa1111").measured(5.0).parted(5.0, 0.0)
        );
        assert_eq!(
            day[1],
            Member::of("commit:bbb2222").measured(1.0).parted(0.0, 1.0)
        );
        for (row, (added, removed)) in [(5.0, 1.0), (0.0, 0.0), (0.0, 7.0)].into_iter().enumerate()
        {
            assert_eq!(row_sum(&chart.members, row), added + removed, "day {row}");
            // The parts sum to the day's two bars.
            let parts = chart
                .members
                .get(MemberKey::Row(row))
                .iter()
                .map(|m| m.parts.unwrap())
                .fold((0.0, 0.0), |(a, r), (pa, pr)| (a + pa, r + pr));
            assert_eq!(parts, (added, removed), "day {row}");
        }
        // Pressed with a column: a per-row set answers for either series.
        let address = Address {
            row: 0,
            label: "2026-10-28".to_string(),
            col: Some(1),
            series: Some("removed".to_string()),
            ..Default::default()
        };
        assert_eq!(
            resolve(&chart.spec, &chart.members, &address),
            Resolved::Members(day.to_vec())
        );
    }

    #[test]
    fn a_tall_day_is_drawn_at_its_full_value() {
        let commit = |sha: &str, day: &str, added| CommitLines {
            sha: sha.to_string(),
            day: day.to_string(),
            added,
            deleted: 0,
        };
        let commits = [
            commit("aaa1111", "2026-10-28", 10),
            commit("bbb2222", "2026-10-29", 10),
            commit("ccc3333", "2026-10-29", 60_000),
            commit("ddd4444", "2026-10-30", 10),
        ];
        let chart = churn_chart(&commits, "t", "s").unwrap();
        assert_eq!(chart.spec["series"][0]["values"], json!([10, 60_010, 10]));
        assert_valid(&chart.spec);
    }

    #[test]
    fn a_signed_count_always_writes_its_sign() {
        assert_eq!(signed(0), "+0");
        assert_eq!(signed(42), "+42");
        assert_eq!(signed(-1500), "−1.5k");
    }

    #[test]
    fn a_hotspot_row_opens_the_files_under_it_largest_first() {
        let commits = vec![
            files(
                "aaa1111",
                "2026-10-28",
                vec![
                    file("a/b/one.rs", 3, 1),
                    file("a/b/two.rs", 1, 0),
                    file("main.rs", 1, 0),
                    file("a/b/data.json", 50, 0),
                ],
            ),
            files(
                "bbb2222",
                "2026-10-29",
                vec![file("a/b/one.rs", 0, 2), file("a/b/three.rs", 2, 2)],
            ),
        ];
        let set = KindSet::parse("code").unwrap();
        let stats = group_paths(&commits, set, 2);
        let (refs, members) = hotspot_reports(&commits, set, 2, &stats);
        let spec = hotspots_chart(&stats, refs, "t", "s");
        assert_eq!(spec["orient"], "horizontal");
        assert_eq!(spec["series"][0]["values"], json!([11, 1]));
        // Three files under `a/b`, the data file left out with its kind; a
        // lone file is a count of one, so a press still opens its report.
        assert_eq!(
            spec["refs"],
            json!([
                ["file:a/b/one.rs", "file:a/b/three.rs", "file:a/b/two.rs"],
                { "kind": "file", "count": 1 }
            ])
        );
        let row = members.get(MemberKey::Row(0));
        let read: Vec<_> = row.iter().map(|m| (m.r#ref.as_deref(), m.parts)).collect();
        assert_eq!(
            read,
            vec![
                (Some("file:a/b/one.rs"), Some((3.0, 3.0))),
                (Some("file:a/b/three.rs"), Some((2.0, 2.0))),
                (Some("file:a/b/two.rs"), Some((1.0, 0.0))),
            ]
        );
        assert_eq!(row_sum(&members, 0), 11.0);
        assert_eq!(row_sum(&members, 1), 1.0);
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

        // Without a source a set lists its own members: one file is a link.
        let (refs, members) = landed_reports(&files, 1, &rows, false);
        let spec = landed_chart(&rows, refs, "t", "s");
        assert_eq!(spec["layout"], "stacked");
        assert_eq!(
            spec["refs"],
            json!(["file:README.md", ["file:a/b/two.rs", "file:a/one.rs"], null])
        );
        assert_eq!(row_sum(&members, 1), 6.0);
        assert_eq!(members.get(MemberKey::Row(1))[0].parts, Some((3.0, 0.0)));
        assert_valid(&spec);

        // With one, a lone file is a count of one.
        let (sourced, _) = landed_reports(&files, 1, &rows, true);
        assert_eq!(sourced[0], json!({ "kind": "file", "count": 1 }));
        assert_eq!(sourced[1].as_array().map(Vec::len), Some(2));

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
    fn each_kind_series_carries_its_own_commits_per_day() {
        let entries = [
            LogEntry {
                sha: "aaa1111".to_string(),
                ..entry("feat: x", "2026-10-29")
            },
            LogEntry {
                sha: "bbb2222".to_string(),
                ..entry("fix: y", "2026-10-29")
            },
            LogEntry {
                sha: "ccc3333".to_string(),
                ..entry("feat: z", "2026-10-30")
            },
        ];
        let KindChart { chart, .. } = kinds_chart(&entries, "t", "s").unwrap();
        let series = chart.spec["series"].as_array().unwrap();
        assert_eq!(series.len(), 2);
        assert_eq!(series[0]["name"], "feat");
        assert_eq!(series[0]["values"], json!([1, 1]));
        assert_eq!(
            series[0]["refs"],
            json!(["commit:aaa1111", "commit:ccc3333"])
        );
        assert_eq!(series[1]["name"], "fix");
        assert_eq!(series[1]["values"], json!([1, 0]));
        assert_eq!(series[1]["refs"], json!(["commit:bbb2222", null]));
        assert_valid(&chart.spec);
    }

    #[test]
    fn an_hour_is_read_in_the_committers_own_offset() {
        let buckets = hours(&[
            LogEntry {
                sha: "aaa1111".to_string(),
                ..at("2026-10-29T23:30:00-07:00")
            },
            LogEntry {
                sha: "bbb2222".to_string(),
                ..at("2026-10-30T06:30:00+00:00")
            },
            LogEntry {
                sha: "ccc3333".to_string(),
                date: "2026-10-27".to_string(),
                ..at("2026-10-27T23:45:00-07:00")
            },
            LogEntry {
                sha: "ddd4444".to_string(),
                date: "2026-10-31".to_string(),
                ..at("2026-10-31T23:05:00-07:00")
            },
            at("not a time"),
        ])
        .unwrap();
        assert_eq!(buckets[23].len(), 3);
        assert_eq!(
            buckets[6],
            vec![("commit:bbb2222".to_string(), "2026-10-29".to_string())]
        );
        assert_eq!(buckets.iter().map(Vec::len).sum::<usize>(), 4);
        let (spec, members) = hours_chart(buckets, "t", "s");
        assert_eq!(spec["values"][23], 3);
        assert_eq!(spec["values"][0], 0);
        // The strip's refs are parallel to its hours.
        assert_eq!(spec["refs"].as_array().unwrap().len(), 24);
        assert_eq!(
            spec["refs"][23],
            json!(["commit:aaa1111", "commit:ccc3333", "commit:ddd4444"])
        );
        assert_eq!(spec["refs"][6], "commit:bbb2222");
        assert_eq!(spec["refs"][0], Value::Null);
        assert_valid(&spec);
        // The hour's members carry their day as a group, newest day first.
        assert_eq!(
            members.get(MemberKey::Row(23)),
            [
                Member::of("commit:ddd4444").grouped("2026-10-31"),
                Member::of("commit:aaa1111").grouped("2026-10-29"),
                Member::of("commit:ccc3333").grouped("2026-10-27"),
            ]
        );
        assert!(members.get(MemberKey::Row(0)).is_empty());
        assert!(hours(&[at("not a time")]).is_none());
    }

    #[test]
    fn a_bucket_past_the_set_limit_is_a_count_in_the_spec_and_a_list_in_the_table() {
        let entries: Vec<LogEntry> = (0..101)
            .map(|i| sha_entry(&format!("{i:07x}"), "2026-10-29"))
            .collect();
        let chart = commits_chart(&entries, Bucket::Day, "t", "s").unwrap();
        assert_eq!(
            chart.spec["refs"][0],
            json!({ "kind": "commit", "count": 101 })
        );
        let members = chart.members.get(MemberKey::Row(0));
        assert_eq!(members.len(), 101);
        assert_eq!(members[0].r#ref.as_deref(), Some("commit:0000000"));
        assert_eq!(members[100].r#ref.as_deref(), Some("commit:0000064"));
        assert!(members.iter().all(|m| m.measure.is_none()));
    }

    #[test]
    fn a_kind_cell_is_the_days_commits_of_that_kind_and_a_whole_row_names_each_series() {
        let entries = [
            LogEntry {
                sha: "aaa1111".to_string(),
                ..entry("feat: x", "2026-10-29")
            },
            LogEntry {
                sha: "bbb2222".to_string(),
                ..entry("fix: y", "2026-10-29")
            },
            LogEntry {
                sha: "ccc3333".to_string(),
                ..entry("feat: z", "2026-10-30")
            },
        ];
        let KindChart { chart, .. } = kinds_chart(&entries, "t", "s").unwrap();
        let cell = |row, col| chart.members.get(MemberKey::Cell { row, col }).to_vec();
        assert_eq!(cell(0, 0), vec![Member::of("commit:aaa1111")]);
        assert_eq!(cell(0, 1), vec![Member::of("commit:bbb2222")]);
        assert_eq!(cell(1, 0), vec![Member::of("commit:ccc3333")]);
        assert!(cell(1, 1).is_empty());
        assert!(chart.members.get(MemberKey::Row(0)).is_empty());
        // A column press is its cell; a whole-row press is every cell with
        // the series it came from.
        let address = Address {
            row: 0,
            label: "2026-10-29".to_string(),
            series: Some("fix".to_string()),
            col: Some(1),
            ..Default::default()
        };
        assert_eq!(
            resolve(&chart.spec, &chart.members, &address),
            Resolved::Members(vec![Member::of("commit:bbb2222")])
        );
        let whole = Address {
            whole_row: true,
            series: None,
            col: None,
            ..address
        };
        assert_eq!(
            resolve(&chart.spec, &chart.members, &whole),
            Resolved::Members(vec![
                Member::of("commit:aaa1111").grouped("feat"),
                Member::of("commit:bbb2222").grouped("fix"),
            ])
        );
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
        let head = git(&root, &["rev-parse", "--short", "HEAD"]);
        let head_ref = commit_ref(head.trim());
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
            // `hotspots` is held at depth 2, where its rows are one directory
            // and one file; left to choose, it descends to two file rows.
            let args = if name == "hotspots" {
                RecipeArgs {
                    depth: Some(2),
                    ..RecipeArgs::default()
                }
            } else {
                RecipeArgs::default()
            };
            let outcome = crate::find(name).unwrap().run(&ctx, &args).unwrap();
            let RecipeOutcome::Chart {
                spec,
                summary,
                members,
            } = outcome
            else {
                panic!("{name} found nothing to draw");
            };
            assert_valid(&spec);
            assert!(!summary.is_empty());
            // A commit-set recipe's table holds HEAD where it counted it; a
            // path recipe's sets are the files under each row.
            let in_table = members
                .sets
                .values()
                .flatten()
                .any(|m| m.r#ref.as_deref() == Some(head_ref.as_str()));
            if matches!(name, "hotspots" | "landed") {
                let files: Vec<&Member> = members.sets.values().flatten().collect();
                assert!(!files.is_empty(), "{name}");
                assert!(
                    files
                        .iter()
                        .all(|m| m.r#ref.as_deref().is_some_and(|r| r.starts_with("file:"))),
                    "{name}: {members:?}"
                );
            } else {
                assert!(in_table, "{name}: {members:?}");
            }
            // Every commit recipe stamps its source; `landed` over the
            // working tree alone has no absolute spelling and stamps none.
            if name == "landed" {
                assert!(spec.get("source").is_none(), "{spec}");
            } else {
                assert_source(&spec, name);
            }
            // A commit-set recipe puts HEAD's own sha where it counted it.
            if !matches!(name, "hotspots" | "landed") {
                let text = serde_json::to_string(&spec).unwrap();
                assert!(
                    text.contains(&head_ref),
                    "{name} carries no {head_ref}: {text}"
                );
            }
            // A path recipe's row opens its files: `a/b/one.txt` groups under
            // `a/b` at depth 2 and `two.txt` is its own group, a count of one
            // on a sourced spec and a link on an unsourced one.
            if name == "hotspots" {
                let refs = spec["refs"].as_array().unwrap();
                assert!(
                    refs.iter()
                        .all(|r| *r == json!({ "kind": "file", "count": 1 })),
                    "{refs:?}"
                );
                let rows: Vec<&str> = spec["categories"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                let at = rows.iter().position(|r| *r == "a/b").unwrap();
                assert_eq!(
                    members.get(MemberKey::Row(at))[0].r#ref.as_deref(),
                    Some("file:a/b/one.txt")
                );
                assert!(rows.contains(&"two.txt"), "{rows:?}");
            }
            if name == "landed" {
                assert_eq!(spec["refs"], json!(["file:two.txt"]));
            }
        }

        let args = RecipeArgs {
            path: Some("a".to_string()),
            title: Some("Named".to_string()),
            ..Default::default()
        };
        let outcome = crate::find("churn").unwrap().run(&ctx, &args).unwrap();
        let RecipeOutcome::Chart { spec, summary, .. } = outcome else {
            panic!("churn under a found nothing to draw");
        };
        assert_eq!(spec["title"], "Named");
        assert_eq!(spec["series"][0]["values"].as_array().unwrap().len(), 1);
        assert!(
            summary.starts_with("+2 −0 line(s), net +2, in 1 commit(s)"),
            "{summary}"
        );
        assert!(summary.ends_with("under a"), "{summary}");
        assert_eq!(spec["source"]["args"]["path"], "a");

        // `landed` over a range stamps the range with both ends resolved.
        let args = RecipeArgs {
            range: Some("HEAD~1..HEAD".to_string()),
            ..Default::default()
        };
        let outcome = crate::find("landed").unwrap().run(&ctx, &args).unwrap();
        let RecipeOutcome::Chart { spec, .. } = outcome else {
            panic!("landed over a range found nothing to draw");
        };
        assert_source(&spec, "landed");
        let range = spec["source"]["args"]["range"].as_str().unwrap();
        let (from, to) = range.split_once("..").unwrap();
        assert_eq!(to, head.trim());
        assert_eq!(from, git(&root, &["rev-parse", "--short", "HEAD~1"]).trim());
        assert_eq!(spec["source"]["args"]["depth"], 1);
    }

    #[test]
    fn a_source_re_runs_the_same_read() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        GitFixture::init(&root);
        for (n, name) in ["one", "two", "three"].iter().enumerate() {
            std::fs::write(root.join(format!("{name}.txt")), "x\n".repeat(n + 1)).unwrap();
            git(&root, &["add", "-A"]);
            git(&root, &["commit", "-q", "-m", &format!("feat: {name}")]);
        }
        let ctx = RecipeContext::for_project(&root);
        let recipe = crate::find("commits").unwrap();
        let args = RecipeArgs {
            days: Some(30),
            ..Default::default()
        };
        let RecipeOutcome::Chart {
            spec: first,
            members,
            ..
        } = recipe.run(&ctx, &args).unwrap()
        else {
            panic!("commits found nothing to draw");
        };
        assert_eq!(first["subtitle"], "last 30 days");
        // One day of three commits: the bar's slot and the table's row hold
        // the same three, in the same order.
        assert_eq!(first["categories"].as_array().unwrap().len(), 1);
        let slot: Vec<String> = first["refs"][0]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap().to_string())
            .collect();
        assert_eq!(slot.len(), 3);
        let row: Vec<String> = members
            .get(MemberKey::Row(0))
            .iter()
            .map(|m| m.r#ref.clone().unwrap())
            .collect();
        assert_eq!(row, slot);
        let address = Address {
            row: 0,
            label: first["categories"][0].as_str().unwrap().to_string(),
            ..Default::default()
        };
        assert_eq!(
            resolve(&first, &members, &address),
            Resolved::Members(members.get(MemberKey::Row(0)).to_vec())
        );
        let stamped = first["source"]["args"].as_object().unwrap();
        let again = args_from_source(recipe, stamped).unwrap();
        assert_eq!(
            again.since.as_deref(),
            Some(stamped["since"].as_str().unwrap())
        );
        assert_eq!(again.by.as_deref(), Some("day"));
        let RecipeOutcome::Chart { spec: second, .. } = recipe.run(&ctx, &again).unwrap() else {
            panic!("the re-run found nothing to draw");
        };
        // The subtitle names the window by its dates on a re-run, by design;
        // everything else, the source included, is the same.
        assert!(
            second["subtitle"].as_str().unwrap().contains(" to "),
            "{}",
            second["subtitle"]
        );
        let mut first = first;
        let mut second = second;
        first.as_object_mut().unwrap().remove("subtitle");
        second.as_object_mut().unwrap().remove("subtitle");
        assert_eq!(first, second);
    }

    /// A pressed bin names its commits, binned as the engine bins them,
    /// smallest first.
    #[test]
    fn a_commit_size_bin_resolves_to_its_commits_sorted_by_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        GitFixture::init(&root);
        for (n, lines) in [1usize, 2, 3, 10, 11, 12].into_iter().enumerate() {
            std::fs::write(root.join(format!("f{n}.txt")), "x\n".repeat(lines)).unwrap();
            git(&root, &["add", "-A"]);
            git(&root, &["commit", "-q", "-m", &format!("size {lines}")]);
        }
        let ctx = RecipeContext::for_project(&root);
        let recipe = crate::find("commit-size").unwrap();
        let RecipeOutcome::Chart { spec, members, .. } =
            recipe.run(&ctx, &RecipeArgs::default()).unwrap()
        else {
            panic!("commit-size found nothing to draw");
        };
        assert_eq!(
            members.measure,
            Some(("lines changed".to_string(), "count".to_string()))
        );
        assert_eq!(spec["form"], "bar");
        // The bars are the engine's own bins of the six sizes.
        let (labels, bins) = binned(&[12.0, 11.0, 10.0, 3.0, 2.0, 1.0], "count").unwrap();
        assert_eq!(spec["categories"], json!(labels));
        let counts: Vec<usize> = bins.iter().map(Vec::len).collect();
        assert_eq!(spec["series"][0]["values"], json!(counts));
        let mut seen = 0;
        for (row, label) in labels.iter().enumerate() {
            let address = Address {
                row,
                label: label.clone(),
                ..Default::default()
            };
            let Resolved::Members(found) = resolve(&spec, &members, &address) else {
                panic!("bin {label} moved");
            };
            assert_eq!(found.len(), bins[row].len(), "bin {label}");
            let sizes: Vec<f64> = found.iter().map(|m| m.measure.unwrap()).collect();
            assert!(
                sizes.windows(2).all(|w| w[0] <= w[1]),
                "bin {label}: {sizes:?}"
            );
            seen += found.len();
        }
        assert_eq!(seen, 6);
        // A bin the chart no longer has is a move, not an empty list.
        let gone = Address {
            row: 0,
            label: "nowhere".to_string(),
            ..Default::default()
        };
        assert_eq!(resolve(&spec, &members, &gone), Resolved::Moved);
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
            ("churn", "categories"),
            ("commit-kinds", "x"),
        ] {
            let outcome = crate::find(name).unwrap().run(&ctx, &args).unwrap();
            let RecipeOutcome::Chart { spec, summary, .. } = outcome else {
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

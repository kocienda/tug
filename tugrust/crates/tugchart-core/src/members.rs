//! A chart's `source`: the recipe that drew it and the absolute arguments it
//! was drawn with, so a reader can ask that recipe again for a mark's
//! members; and the member table a recipe hands back beside its spec, the
//! full list behind every mark, which is what that asking reads.
//!
//! A recipe run from the command line resolves its window once, reads by it,
//! and stamps it; a recipe run again from a `source` reads by the same
//! window, so the two runs execute the same read. Which arguments each recipe
//! stamps is [`SOURCE_KEYS`], one row per recipe, and [`args_from_source`]
//! refuses any key outside the recipe's row.

use std::collections::BTreeMap;

use chrono::{Local, SecondsFormat};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tugchanges_core::Window;
use tuggraphics::chart::format::Format;

use crate::catalog::Recipe;
use crate::context::{RecipeArgs, RecipeContext, RecipeError, RecipeOutcome};

/// The keys each recipe's `source.args` carries, and the only ones a
/// re-run accepts. `since`/`until` are the window; the rest are the
/// arguments that change membership, with their defaults resolved.
pub const SOURCE_KEYS: [(&str, &[&str]); 20] = [
    ("commits", &["since", "until", "by", "path"]),
    ("churn", &["since", "until", "lines", "split", "path"]),
    (
        "velocity",
        &["since", "until", "net", "lines", "split", "path"],
    ),
    (
        "hotspots",
        &["since", "until", "depth", "limit", "lines", "path"],
    ),
    ("landed", &["range", "depth", "lines"]),
    ("commit-kinds", &["since", "until", "path"]),
    ("commit-hours", &["since", "until", "path"]),
    ("commit-days", &["since", "until", "path"]),
    ("sessions", &["since", "until"]),
    ("commit-size", &["since", "until", "lines", "path"]),
    ("arcs", &["since", "until"]),
    ("arc-timeline", &["name", "until"]),
    ("arc-stages", &["limit", "until"]),
    ("test-history", &["until", "files"]),
    ("suite-history", &["until"]),
    ("gaps", &["limit", "until"]),
    ("calls", &["until"]),
    ("tokens", &["since", "until", "kind"]),
    ("cost", &["since", "until"]),
    ("turns", &["since", "until"]),
];

/// The keys `recipe` stamps, or none for a name the table does not know.
pub fn source_keys(recipe: &str) -> &'static [&'static str] {
    SOURCE_KEYS
        .iter()
        .find(|(name, _)| *name == recipe)
        .map_or(&[], |(_, keys)| keys)
}

/// This instant, as a source spells `until`.
pub fn now_rfc3339() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)
}

/// The window a recipe reads by: the args' own `since`/`until` when a source
/// set them, else the last `days` (or `default_days`) ending now.
pub fn window_for(args: &RecipeArgs, default_days: u32) -> Window {
    match &args.since {
        Some(since) => Window {
            since: since.clone(),
            until: args.until.clone(),
        },
        None => Window::last_days(args.days.unwrap_or(default_days)),
    }
}

/// The `until` a recipe with no lower bound reads by: the args' own when a
/// source set it, else now.
pub fn until_for(args: &RecipeArgs) -> String {
    args.until.clone().unwrap_or_else(now_rfc3339)
}

/// How a recipe's subtitle names its window: `last N days` when the run came
/// from `--days`, the window's own dates when it came from a source.
pub fn window_label(args: &RecipeArgs, window: &Window, default_days: u32) -> String {
    match args.since {
        Some(_) => window.label(),
        None => format!("last {} days", args.days.unwrap_or(default_days)),
    }
}

/// The `args` of a source, built key by key.
#[derive(Debug, Clone, Default)]
pub struct SourceArgs(Map<String, Value>);

impl SourceArgs {
    pub fn new() -> SourceArgs {
        SourceArgs::default()
    }

    /// `since` and `until` from a window; `until` only when the window has one.
    pub fn window(window: &Window) -> SourceArgs {
        let mut out = SourceArgs::new().with("since", &window.since);
        if let Some(until) = &window.until {
            out = out.with("until", until);
        }
        out
    }

    /// `until` alone, for a recipe with no lower bound.
    pub fn until(until: &str) -> SourceArgs {
        SourceArgs::new().with("until", until)
    }

    pub fn with(mut self, key: &str, value: impl serde::Serialize) -> SourceArgs {
        self.0.insert(key.to_string(), json!(value));
        self
    }

    /// `key` only when the argument was given.
    pub fn maybe(self, key: &str, value: Option<&str>) -> SourceArgs {
        match value {
            Some(value) => self.with(key, value),
            None => self,
        }
    }

    pub fn into_map(self) -> Map<String, Value> {
        self.0
    }
}

/// Write `recipe` and `args` as the spec's `source`.
pub fn stamp_source(spec: &mut Value, recipe: &str, args: SourceArgs) {
    spec["source"] = json!({ "recipe": recipe, "args": Value::Object(args.into_map()) });
}

/// One member of a mark: what the recipe counted there.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Member {
    /// The member's ref, as the spec would spell it. `None` for a run whose
    /// sha is not one.
    pub r#ref: Option<String>,
    /// What this member contributed to the mark, when the chart counted
    /// something other than 1.
    pub measure: Option<f64>,
    /// A heading the report groups under: a series name, or a date.
    pub group: Option<String>,
    /// Facts only the recipe holds: a run's status and times, a span's bounds.
    pub facts: Option<Value>,
    /// What `facts` describes, set with it: a test run or an arc span.
    pub fact_kind: Option<FactKind>,
    /// The lines a member of a line recipe added and removed, beside the one
    /// `measure` its mark drew, so a report can write both.
    pub parts: Option<(f64, f64)>,
}

impl Member {
    /// A member that is its ref and nothing more.
    pub fn of(r#ref: impl Into<String>) -> Member {
        Member {
            r#ref: Some(r#ref.into()),
            ..Member::default()
        }
    }

    pub fn measured(mut self, measure: f64) -> Member {
        self.measure = Some(measure);
        self
    }

    /// The lines this member added and removed. `measure` is left alone.
    pub fn parted(mut self, added: f64, removed: f64) -> Member {
        self.parts = Some((added, removed));
        self
    }

    pub fn grouped(mut self, group: impl Into<String>) -> Member {
        self.group = Some(group.into());
        self
    }

    /// A member that is `facts` of `kind`, with the ref it stands on when it
    /// has one.
    pub fn fact(kind: FactKind, r#ref: Option<String>, facts: Value) -> Member {
        Member {
            r#ref,
            facts: Some(facts),
            fact_kind: Some(kind),
            ..Member::default()
        }
    }
}

/// What a member's `facts` describe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactKind {
    Run,
    Span,
}

/// An addressable place in a chart, as the recipe that drew it counts
/// places: a row of the axis, a cell of a series, or a dot in a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MemberKey {
    /// Parallel to `categories`, `x`, `rows` or `items`.
    Row(usize),
    /// `col` counts series from 0.
    Cell { row: usize, col: usize },
    /// A dot.
    Item { row: usize, item: usize },
}

/// Every mark's members: full, uncapped, deduplicated, in the order the
/// spec would list them. Built from the same buckets the chart was, so it
/// cannot disagree with the chart; where the spec folded a bucket into a
/// count, the table still holds the list.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MemberTable {
    pub sets: BTreeMap<MemberKey, Vec<Member>>,
    /// The unit and format name of `Member::measure`, when the recipe
    /// measures.
    pub measure: Option<(String, String)>,
}

impl MemberTable {
    /// A table whose members measure `unit`, written in `format`.
    pub fn measured(unit: &str, format: &str) -> MemberTable {
        MemberTable {
            sets: BTreeMap::new(),
            measure: Some((unit.to_string(), format.to_string())),
        }
    }

    /// `Row(i)` for each bucket, each bucket's refs deduplicated in order,
    /// no measure.
    pub fn rows(buckets: &[Vec<String>]) -> MemberTable {
        let mut table = MemberTable::default();
        for (i, bucket) in buckets.iter().enumerate() {
            table.set(MemberKey::Row(i), plain(bucket));
        }
        table
    }

    /// Record `members` at `key`; an empty list records nothing, which
    /// resolves the same way.
    pub fn set(&mut self, key: MemberKey, members: Vec<Member>) {
        if !members.is_empty() {
            self.sets.insert(key, members);
        }
    }

    pub fn get(&self, key: MemberKey) -> &[Member] {
        self.sets.get(&key).map_or(&[], Vec::as_slice)
    }
}

/// `refs` as plain members, deduplicated in order.
pub fn plain(refs: &[String]) -> Vec<Member> {
    let mut out: Vec<Member> = Vec::with_capacity(refs.len());
    for r in refs {
        if !out.iter().any(|m| m.r#ref.as_deref() == Some(r)) {
            out.push(Member::of(r.clone()));
        }
    }
    out
}

/// `value` written as the engine writes a value of `format`; a name the
/// engine does not know reads as `auto`.
pub fn format_measure(format: &str, value: f64) -> String {
    Format::parse(format).unwrap_or(Format::Auto).apply(value)
}

/// Where a reader pressed: the row by label and index, the column by
/// series name and index, a dot within the row, or the whole row across
/// every series. The index says where the row was when the chart was
/// drawn; the label is what decides when the axis has moved since.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct Address {
    pub row: usize,
    pub label: String,
    #[serde(default)]
    pub col: Option<usize>,
    #[serde(default)]
    pub series: Option<String>,
    #[serde(default)]
    pub item: Option<usize>,
    #[serde(default)]
    pub whole_row: bool,
}

/// What an address resolves to: the members at it, or that the mark is no
/// longer where the chart drew it.
#[derive(Debug, Clone, PartialEq)]
pub enum Resolved {
    Members(Vec<Member>),
    Moved,
}

/// The index `label` is at in `labels`: `at` when the label there is it,
/// else the first with that label.
fn find(labels: &[String], at: usize, label: &str) -> Option<usize> {
    if labels.get(at).is_some_and(|l| l == label) {
        return Some(at);
    }
    labels.iter().position(|l| l == label)
}

/// A JSON array as labels: strings as they are, numbers as they print.
fn label_list(value: &Value) -> Option<Vec<String>> {
    let list = value.as_array()?;
    Some(
        list.iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect(),
    )
}

/// The labels a spec's rows carry, in order: `categories`, else `x`, else
/// each of `rows` or `items` by its `label`.
fn row_labels(spec: &Value) -> Option<Vec<String>> {
    if let Some(labels) = label_list(&spec["categories"]).or_else(|| label_list(&spec["x"])) {
        return Some(labels);
    }
    let rows = spec["rows"]
        .as_array()
        .or_else(|| spec["items"].as_array())?;
    Some(
        rows.iter()
            .map(|row| row["label"].as_str().unwrap_or_default().to_string())
            .collect(),
    )
}

fn series_names(spec: &Value) -> Vec<String> {
    spec["series"]
        .as_array()
        .map(|series| {
            series
                .iter()
                .map(|s| s["name"].as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// The members `address` names in `spec`'s `table`. The row is found by
/// its label ([P05]); then a dot is `Item`, a whole row is every `Cell`
/// of it in series order with each member's `group` set to its series
/// name (or `Row` when the table has no cells there), a column is its
/// `Cell` falling back to `Row`, and anything else is `Row`. A binned bar's
/// row is a bin, so its members are the bin's own, held at `Row` in the
/// order the recipe put them. A key the table does not hold is an empty
/// list, not a move.
pub fn resolve(spec: &Value, table: &MemberTable, address: &Address) -> Resolved {
    let Some(labels) = row_labels(spec) else {
        return Resolved::Moved;
    };
    let Some(row) = find(&labels, address.row, &address.label) else {
        return Resolved::Moved;
    };
    let names = series_names(spec);
    if let Some(item) = address.item {
        return Resolved::Members(table.get(MemberKey::Item { row, item }).to_vec());
    }
    if address.whole_row {
        let cells: Vec<Member> = names
            .iter()
            .enumerate()
            .flat_map(|(col, name)| {
                table
                    .get(MemberKey::Cell { row, col })
                    .iter()
                    .map(move |m| m.clone().grouped(name.clone()))
            })
            .collect();
        if !cells.is_empty() {
            return Resolved::Members(cells);
        }
        return Resolved::Members(table.get(MemberKey::Row(row)).to_vec());
    }
    let col = match (&address.series, address.col) {
        (Some(series), col) => match find(&names, col.unwrap_or(usize::MAX), series) {
            Some(col) => Some(col),
            None => return Resolved::Moved,
        },
        (None, col) => col,
    };
    if let Some(col) = col {
        let cell = table.get(MemberKey::Cell { row, col });
        if !cell.is_empty() {
            return Resolved::Members(cell.to_vec());
        }
    }
    Resolved::Members(table.get(MemberKey::Row(row)).to_vec())
}

/// Run `recipe` again with `args` and resolve `address` in what it drew,
/// with the table's measure. A recipe that now has nothing to draw has
/// moved from under the mark.
pub fn members_of(
    recipe: &Recipe,
    ctx: &RecipeContext,
    args: &RecipeArgs,
    address: &Address,
) -> Result<(Resolved, Option<(String, String)>), RecipeError> {
    match recipe.run(ctx, args)? {
        RecipeOutcome::Chart { spec, members, .. } => {
            let found = resolve(&spec, &members, address);
            Ok((found, members.measure))
        }
        RecipeOutcome::NoData { .. } => Ok((Resolved::Moved, None)),
    }
}

/// The `RecipeArgs` a source's `args` spell for `recipe`, which is how a
/// re-run reads what the first run read. A key outside the recipe's row of
/// [`SOURCE_KEYS`], or a value of the wrong shape, is refused by name.
pub fn args_from_source(recipe: &Recipe, args: &Map<String, Value>) -> Result<RecipeArgs, String> {
    let allowed = source_keys(recipe.name);
    let mut out = RecipeArgs::default();
    let string = |key: &str, value: &Value| -> Result<String, String> {
        value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("{}: {key} is a string", recipe.name))
    };
    for (key, value) in args {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "{}: a source of this recipe carries no {key}",
                recipe.name
            ));
        }
        match key.as_str() {
            "since" => out.since = Some(string(key, value)?),
            "until" => out.until = Some(string(key, value)?),
            "path" => out.path = Some(string(key, value)?),
            "by" => out.by = Some(string(key, value)?),
            "kind" => out.kind = Some(string(key, value)?),
            "range" => out.range = Some(string(key, value)?),
            "lines" => out.lines = Some(string(key, value)?),
            "name" => out.subjects = vec![string(key, value)?],
            "net" => {
                out.net = value
                    .as_bool()
                    .ok_or_else(|| format!("{}: net is a boolean", recipe.name))?;
            }
            "split" => {
                out.split = value
                    .as_bool()
                    .ok_or_else(|| format!("{}: split is a boolean", recipe.name))?;
            }
            "depth" => {
                let depth = value
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| format!("{}: depth is a whole number", recipe.name))?;
                out.depth = Some(depth);
            }
            "limit" => {
                let limit = value
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| format!("{}: limit is a whole number", recipe.name))?;
                out.limit = Some(limit);
            }
            "files" => {
                let files = value
                    .as_array()
                    .ok_or_else(|| format!("{}: files is a list", recipe.name))?;
                out.subjects = files
                    .iter()
                    .map(|file| string(key, file))
                    .collect::<Result<_, _>>()?;
            }
            other => return Err(format!("{}: {other} is not a source argument", recipe.name)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RECIPES;

    #[test]
    fn parted_sets_the_parts_and_leaves_the_measure() {
        let member = Member::of("commit:abc").measured(9.0).parted(7.0, 2.0);
        assert_eq!(member.measure, Some(9.0));
        assert_eq!(member.parts, Some((7.0, 2.0)));
        assert_eq!(Member::of("commit:abc").parts, None);
    }

    #[test]
    fn every_recipe_has_a_row_of_source_keys_and_no_row_names_a_stranger() {
        for recipe in &RECIPES {
            assert!(
                SOURCE_KEYS.iter().any(|(name, _)| *name == recipe.name),
                "{} has no source keys",
                recipe.name
            );
        }
        for (name, _) in &SOURCE_KEYS {
            assert!(crate::find(name).is_some(), "{name} is not a recipe");
        }
    }

    #[test]
    fn a_window_from_a_source_is_the_source_window() {
        let args = RecipeArgs {
            since: Some("2026-10-01".to_string()),
            until: Some("2026-10-30T09:14:02-08:00".to_string()),
            days: Some(7),
            ..Default::default()
        };
        let window = window_for(&args, 30);
        assert_eq!(window.since, "2026-10-01");
        assert_eq!(window.until.as_deref(), Some("2026-10-30T09:14:02-08:00"));
        assert_eq!(window_label(&args, &window, 30), "2026-10-01 to 2026-10-30");
        assert_eq!(until_for(&args), "2026-10-30T09:14:02-08:00");

        let plain = RecipeArgs {
            days: Some(7),
            ..Default::default()
        };
        let window = window_for(&plain, 30);
        assert_eq!(window, Window::last_days(7));
        assert_eq!(window_label(&plain, &window, 30), "last 7 days");
        assert_eq!(
            window_label(&RecipeArgs::default(), &window, 30),
            "last 30 days"
        );
    }

    #[test]
    fn a_source_reads_back_as_the_arguments_it_stamped() {
        let recipe = crate::find("hotspots").unwrap();
        let args = SourceArgs::window(&Window {
            since: "2026-10-01".to_string(),
            until: Some("2026-10-30T09:14:02-08:00".to_string()),
        })
        .with("depth", 2)
        .with("limit", 10)
        .maybe("path", Some("tugdeck"))
        .into_map();
        let read = args_from_source(recipe, &args).unwrap();
        assert_eq!(read.since.as_deref(), Some("2026-10-01"));
        assert_eq!(read.until.as_deref(), Some("2026-10-30T09:14:02-08:00"));
        assert_eq!(read.depth, Some(2));
        assert_eq!(read.limit, Some(10));
        assert_eq!(read.path.as_deref(), Some("tugdeck"));

        let tests = crate::find("test-history").unwrap();
        let args = SourceArgs::until("2026-10-30T09:14:02-08:00")
            .with("files", ["a.test.ts", "b.test.ts"])
            .into_map();
        let read = args_from_source(tests, &args).unwrap();
        assert_eq!(read.subjects, ["a.test.ts", "b.test.ts"]);
        assert!(read.since.is_none());

        let velocity = crate::find("velocity").unwrap();
        let read = args_from_source(velocity, &SourceArgs::new().with("net", true).into_map());
        assert!(read.unwrap().net);
    }

    #[test]
    fn a_source_key_outside_the_recipes_row_is_refused_by_name() {
        let commits = crate::find("commits").unwrap();
        let err = args_from_source(commits, &SourceArgs::new().with("net", true).into_map());
        assert_eq!(
            err.unwrap_err(),
            "commits: a source of this recipe carries no net"
        );
        let err = args_from_source(commits, &SourceArgs::new().with("by", 7).into_map());
        assert_eq!(err.unwrap_err(), "commits: by is a string");
    }

    #[test]
    fn a_stamp_writes_recipe_and_args() {
        let mut spec = json!({ "tugchart": 1 });
        stamp_source(
            &mut spec,
            "calls",
            SourceArgs::until("2026-10-30T09:14:02-08:00"),
        );
        assert_eq!(
            spec["source"],
            json!({ "recipe": "calls", "args": { "until": "2026-10-30T09:14:02-08:00" } })
        );
    }

    fn bar_spec() -> Value {
        json!({
            "tugchart": 1, "form": "bar", "title": "t",
            "categories": ["a", "b", "b", "c"],
            "series": [
                { "name": "one", "values": [1, 2, 3, 4] },
                { "name": "two", "values": [1, 2, 3, 4] }
            ]
        })
    }

    fn table_with(rows: &[(MemberKey, &[&str])]) -> MemberTable {
        let mut table = MemberTable::default();
        for (key, refs) in rows {
            table.set(*key, refs.iter().map(|r| Member::of(*r)).collect());
        }
        table
    }

    #[test]
    fn a_row_is_found_by_its_label_when_its_index_has_moved() {
        let spec = bar_spec();
        let table = table_with(&[
            (MemberKey::Row(0), &["commit:a1"]),
            (MemberKey::Row(3), &["commit:c1", "commit:c2"]),
        ]);
        // The axis gained a day: `c` was at 2 and is now at 3.
        let moved = Address {
            row: 2,
            label: "c".to_string(),
            ..Default::default()
        };
        assert_eq!(
            resolve(&spec, &table, &moved),
            Resolved::Members(vec![Member::of("commit:c1"), Member::of("commit:c2")])
        );
        // The index is trusted when its label still matches, even with a
        // twin earlier in the axis.
        let twin = Address {
            row: 2,
            label: "b".to_string(),
            ..Default::default()
        };
        assert_eq!(resolve(&spec, &table, &twin), Resolved::Members(vec![]));
        // A label the spec no longer has is a move.
        let gone = Address {
            row: 0,
            label: "z".to_string(),
            ..Default::default()
        };
        assert_eq!(resolve(&spec, &table, &gone), Resolved::Moved);
        // A row with no members is an empty list.
        let empty = Address {
            row: 1,
            label: "b".to_string(),
            ..Default::default()
        };
        assert_eq!(resolve(&spec, &table, &empty), Resolved::Members(vec![]));
    }

    #[test]
    fn a_column_is_its_cell_or_falls_back_to_the_row_and_a_whole_row_groups_by_series() {
        let spec = bar_spec();
        let table = table_with(&[
            (MemberKey::Row(0), &["commit:a1"]),
            (MemberKey::Cell { row: 3, col: 0 }, &["commit:c1"]),
            (MemberKey::Cell { row: 3, col: 1 }, &["commit:c2"]),
        ]);
        // A series found by name at a moved column index.
        let cell = Address {
            row: 3,
            label: "c".to_string(),
            col: Some(0),
            series: Some("two".to_string()),
            ..Default::default()
        };
        assert_eq!(
            resolve(&spec, &table, &cell),
            Resolved::Members(vec![Member::of("commit:c2")])
        );
        // A series the spec lacks is a move.
        let no_series = Address {
            series: Some("three".to_string()),
            ..cell.clone()
        };
        assert_eq!(resolve(&spec, &table, &no_series), Resolved::Moved);
        // A row whose refs are per row answers for any of its columns.
        let per_row = Address {
            row: 0,
            label: "a".to_string(),
            col: Some(1),
            series: Some("two".to_string()),
            ..Default::default()
        };
        assert_eq!(
            resolve(&spec, &table, &per_row),
            Resolved::Members(vec![Member::of("commit:a1")])
        );
        // The whole row, each member under its series.
        let whole = Address {
            row: 3,
            label: "c".to_string(),
            whole_row: true,
            ..Default::default()
        };
        assert_eq!(
            resolve(&spec, &table, &whole),
            Resolved::Members(vec![
                Member::of("commit:c1").grouped("one"),
                Member::of("commit:c2").grouped("two"),
            ])
        );
        // A whole row with no cells is the row's own set.
        let whole_a = Address {
            row: 0,
            label: "a".to_string(),
            whole_row: true,
            ..Default::default()
        };
        assert_eq!(
            resolve(&spec, &table, &whole_a),
            Resolved::Members(vec![Member::of("commit:a1")])
        );
    }

    #[test]
    fn a_dot_and_a_span_resolve_by_their_rows_label() {
        let dots = json!({
            "tugchart": 1, "form": "dots", "title": "t",
            "rows": [{ "label": "resume", "items": ["good", "bad"] }]
        });
        let table = table_with(&[
            (MemberKey::Item { row: 0, item: 1 }, &["commit:r2"]),
            (MemberKey::Row(0), &["file:resume.test.ts"]),
        ]);
        let dot = Address {
            row: 0,
            label: "resume".to_string(),
            item: Some(1),
            ..Default::default()
        };
        assert_eq!(
            resolve(&dots, &table, &dot),
            Resolved::Members(vec![Member::of("commit:r2")])
        );
        let row = Address { item: None, ..dot };
        assert_eq!(
            resolve(&dots, &table, &row),
            Resolved::Members(vec![Member::of("file:resume.test.ts")])
        );
        let spans = json!({
            "tugchart": 1, "form": "spans", "title": "t",
            "items": [{ "label": "devise", "start": 0, "end": 4 }]
        });
        let table = table_with(&[(MemberKey::Row(0), &["session:0f3c1e5a"])]);
        let span = Address {
            row: 0,
            label: "devise".to_string(),
            ..Default::default()
        };
        assert_eq!(
            resolve(&spans, &table, &span),
            Resolved::Members(vec![Member::of("session:0f3c1e5a")])
        );
    }

    #[test]
    fn a_measure_is_written_as_the_engine_writes_its_format() {
        assert_eq!(format_measure("count", 1840.0), "1.8k");
        assert_eq!(format_measure("int", 1204.0), "1,204");
        assert_eq!(format_measure("secs", 12.3), "12.3s");
        assert_eq!(
            format_measure("nonsense", 0.42),
            format_measure("auto", 0.42)
        );
    }

    #[test]
    fn an_address_reads_from_json_with_its_optional_parts_absent() {
        let address: Address =
            serde_json::from_value(json!({ "row": 5, "label": "2026-10-23" })).unwrap();
        assert_eq!(
            address,
            Address {
                row: 5,
                label: "2026-10-23".to_string(),
                ..Default::default()
            }
        );
        let full: Address = serde_json::from_value(json!({
            "row": 1, "label": "x", "col": 2, "series": "s", "item": null, "whole_row": true
        }))
        .unwrap();
        assert_eq!(full.col, Some(2));
        assert_eq!(full.series.as_deref(), Some("s"));
        assert!(full.whole_row);
    }
}

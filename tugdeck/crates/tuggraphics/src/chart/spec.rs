//! The layer 1 chart spec: its types, and the validator that reads one
//! from JSON and reports every error, each addressed by a JSON pointer
//! into the spec.

use serde::Serialize;
use serde_json::{Map, Value};
use unicode_segmentation::UnicodeSegmentation;

use super::format::Format;
use super::forms::heat::CELL_H;
use super::forms::{GAP, LABEL_ROW, TITLE_ROW};
use crate::draw::{self, ColourRole, Program, SERIES_COUNT};

/// At most this many series in one chart, one per categorical colour the
/// themes carry.
pub const MAX_SERIES: usize = SERIES_COUNT as usize;
/// The roles a series `role` or a span `status` may name: the outcomes, the
/// place beyond the system, and the accent.
pub const SEMANTIC_ROLES: [&str; 5] = ["good", "bad", "caution", "outside", "accent"];
/// At most this many values in one series.
pub const MAX_VALUES: usize = 2000;
/// At most this many annotations.
pub const MAX_ANNOTATIONS: usize = 8;
/// The longest label, in graphemes.
pub const MAX_LABEL: usize = 120;
/// The largest magnitude a value may carry; every format stays exact
/// below it.
pub const MAX_VALUE: f64 = 1e15;
pub const MIN_W: f64 = 80.0;
pub const MAX_W: f64 = 1600.0;
pub const MIN_H: f64 = 16.0;
pub const MAX_H: f64 = 1200.0;
/// The shortest an axis chart may be and still hold its header, plot and
/// category row.
pub const MIN_AXIS_H: f64 = 120.0;
/// At most this many rows in a row form (`dots`, `spans`, `bullet`, a
/// horizontal `bar`): the tallest default frame stays inside [`MAX_H`].
pub const MAX_ROWS: usize = 40;
/// The histogram's bin count range.
pub const MIN_BINS: usize = 4;
pub const MAX_BINS: usize = 40;
/// At most this many refs in one set slot; past it a recipe writes the
/// count form.
pub const MAX_SET: usize = 100;
/// At most this many refs across a spec: a single ref counts one, a set its
/// members, a count form none.
pub const MAX_REFS: usize = 800;
/// The longest `file:`, `dir:` or `command:` value, in characters.
const MAX_REF_TEXT: usize = 512;
/// The longest `arc:` name, the arc log's own limit.
const MAX_ARC_NAME: usize = 120;
const REF_KINDS: &str = "commit, file, dir, session, arc, url or command";

/// What a ref names: the prefix before its colon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefKind {
    Commit,
    File,
    Dir,
    Session,
    Arc,
    Url,
    Command,
}

impl RefKind {
    pub fn parse(s: &str) -> Option<RefKind> {
        match s {
            "commit" => Some(RefKind::Commit),
            "file" => Some(RefKind::File),
            "dir" => Some(RefKind::Dir),
            "session" => Some(RefKind::Session),
            "arc" => Some(RefKind::Arc),
            "url" => Some(RefKind::Url),
            "command" => Some(RefKind::Command),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            RefKind::Commit => "commit",
            RefKind::File => "file",
            RefKind::Dir => "dir",
            RefKind::Session => "session",
            RefKind::Arc => "arc",
            RefKind::Url => "url",
            RefKind::Command => "command",
        }
    }

    /// Whether `value` is one this kind can name; the message says what one
    /// is when it is not.
    fn check(self, value: &str) -> Result<(), &'static str> {
        let ok = match self {
            RefKind::Commit => {
                (4..=40).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
            }
            RefKind::File | RefKind::Dir | RefKind::Command => {
                !value.is_empty()
                    && !value.contains(['\n', '\r', '\0'])
                    && value.chars().count() <= MAX_REF_TEXT
            }
            RefKind::Session => is_session_value(value),
            RefKind::Arc => {
                value.len() <= MAX_ARC_NAME
                    && value.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
                    && value
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            }
            RefKind::Url => is_url_value(value),
        };
        if ok {
            return Ok(());
        }
        Err(match self {
            RefKind::Commit => "a commit ref is 4 to 40 hex characters",
            RefKind::File => "a file ref is a path of 1 to 512 characters on one line",
            RefKind::Dir => "a dir ref is a path of 1 to 512 characters on one line",
            RefKind::Session => {
                "a session ref is a project/callsign pair, an 8-character short id or a full uuid"
            }
            RefKind::Arc => {
                "an arc ref is a name of lowercase letters, digits and hyphens, at most 120 characters"
            }
            RefKind::Url => "a url ref begins http:// or https:// and holds no space",
            RefKind::Command => "a command ref is one line of 1 to 512 characters",
        })
    }
}

/// A `project/callsign` pair, an 8-hex short id, or a 36-character uuid.
fn is_session_value(v: &str) -> bool {
    let hex = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit());
    if v.len() == 8 && hex(v) {
        return true;
    }
    if v.len() == 36 {
        let parts: Vec<&str> = v.split('-').collect();
        if parts.iter().map(|p| p.len()).eq([8, 4, 4, 4, 12]) && parts.iter().all(|p| hex(p)) {
            return true;
        }
    }
    match v.split_once('/') {
        Some((project, callsign)) => {
            !project.is_empty()
                && !callsign.is_empty()
                && !callsign.contains('/')
                && !v.chars().any(char::is_whitespace)
        }
        None => false,
    }
}

fn is_url_value(v: &str) -> bool {
    let rest = v
        .strip_prefix("https://")
        .or_else(|| v.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty()) && !v.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// What a ref slot holds: one ref, a set of refs of one kind, or — past
/// [`MAX_SET`] — how many there were. Serialized as the spec spells it, so
/// the table hands the deck the same shapes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RefSlot {
    /// `"commit:63de5762a"`.
    One(String),
    /// `{"kind": "commit", "members": […]}`.
    Set { kind: String, members: Vec<String> },
    /// `{"kind": "commit", "count": 312}`.
    Count { kind: String, count: u32 },
}

impl RefSlot {
    /// How many refs the slot counts toward [`MAX_REFS`].
    pub fn members(&self) -> usize {
        match self {
            RefSlot::One(_) => 1,
            RefSlot::Set { members, .. } => members.len(),
            RefSlot::Count { .. } => 0,
        }
    }

    /// The slot's kind, as its prefix spells it.
    pub fn kind(&self) -> &str {
        match self {
            RefSlot::One(r) => r.split_once(':').map_or(r.as_str(), |(k, _)| k),
            RefSlot::Set { kind, .. } | RefSlot::Count { kind, .. } => kind,
        }
    }
}

/// How many members a parallel array of slots counts.
fn slot_members(slots: &[Option<RefSlot>]) -> usize {
    slots.iter().flatten().map(RefSlot::members).sum()
}

/// A spec error, addressed by JSON pointer: `""` is the spec itself,
/// `/series/0/values/3` one value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChartError {
    pub path: String,
    pub message: String,
}

/// Which layers a door accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layers {
    /// Chart specs only: what a `tugchart` fence takes.
    Chart,
    /// Diagram specs only: what a `tugdiagram` fence takes.
    Diagram,
    /// A chart spec, a diagram spec or a layer 0 program: what a tool's
    /// stdout and a standalone render take.
    Any,
}

impl Layers {
    pub fn parse(s: &str) -> Option<Layers> {
        match s {
            "chart" => Some(Layers::Chart),
            "diagram" => Some(Layers::Diagram),
            "any" => Some(Layers::Any),
            _ => None,
        }
    }
}

pub const LAYER0_IN_FENCE: &str = "a tugchart fence takes a chart spec, not a tugdraw program";
pub const DIAGRAM_IN_CHART_FENCE: &str =
    "a tugchart fence takes a chart spec, not a tugdiagram spec; put it in a tugdiagram fence";
pub const NOT_A_DIAGRAM: &str =
    "a tugdiagram fence takes a diagram spec, which starts with \"tugdiagram\": 1";

/// A validated source: a chart spec, a diagram spec, or a layer 0 program
/// where the door takes one.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Chart(Spec),
    Diagram(crate::diagram::Spec),
    Draw(Program),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub name: String,
    pub values: Vec<Option<f64>>,
    pub role: ColourRole,
    /// The series' own ref: its column's.
    pub ref_slot: Option<RefSlot>,
    /// A ref per value, or empty: the cells'.
    pub refs: Vec<Option<RefSlot>>,
}

/// One series of a `scatter`: its `(x, y)` points in the order given.
#[derive(Clone, Debug, PartialEq)]
pub struct ScatterSeries {
    pub name: String,
    pub points: Vec<(f64, f64)>,
    pub role: ColourRole,
    /// A ref per point, or empty: each point's table row.
    pub refs: Vec<Option<RefSlot>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Highlight {
    Last,
    MinMax,
    None,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Annotation {
    /// A level across the plot.
    Rule { value: f64, label: Option<String> },
    /// A category or point, by index, and what it names.
    Mark {
        at: usize,
        label: Option<String>,
        ref_slot: Option<RefSlot>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orient {
    Vertical,
    Horizontal,
}

/// One dot of a `dots` row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dot {
    Good,
    Bad,
    Neutral,
}

impl Dot {
    pub fn parse(s: &str) -> Option<Dot> {
        match s {
            "good" => Some(Dot::Good),
            "bad" => Some(Dot::Bad),
            "neutral" => Some(Dot::Neutral),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Dot::Good => "good",
            Dot::Bad => "bad",
            Dot::Neutral => "neutral",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DotRow {
    pub label: String,
    pub items: Vec<Dot>,
    pub ref_slot: Option<RefSlot>,
    /// A ref per dot, or empty.
    pub refs: Vec<Option<RefSlot>>,
}

/// One bar of a `spans` chart, from `start` to `end` on the shared axis.
/// `status` is the word the spec gave (one of [`SEMANTIC_ROLES`]), kept
/// for the table; the layout maps it to a role.
#[derive(Clone, Debug, PartialEq)]
pub struct SpanItem {
    pub label: String,
    pub start: f64,
    pub end: f64,
    pub status: Option<String>,
    pub ref_slot: Option<RefSlot>,
}

impl SpanItem {
    pub fn role(&self) -> ColourRole {
        self.status
            .as_deref()
            .and_then(ColourRole::parse)
            .unwrap_or(ColourRole::Series(1))
    }
}

/// One row of a `bullet` chart.
#[derive(Clone, Debug, PartialEq)]
pub struct BulletItem {
    pub label: String,
    pub value: f64,
    pub range: Option<(f64, f64)>,
    pub target: Option<f64>,
    pub history: Vec<Option<f64>>,
    pub ref_slot: Option<RefSlot>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Data {
    Bar {
        categories: Vec<String>,
        series: Vec<Series>,
        orient: Orient,
        stacked: bool,
        /// A ref per category, or empty: the rows'.
        refs: Vec<Option<RefSlot>>,
    },
    Line {
        x: Vec<String>,
        series: Vec<Series>,
        refs: Vec<Option<RefSlot>>,
    },
    /// As `line`, filled to the baseline: translucent overlapping fills,
    /// or stacked ones.
    Area {
        x: Vec<String>,
        series: Vec<Series>,
        stacked: bool,
        refs: Vec<Option<RefSlot>>,
    },
    Sparkline {
        values: Vec<Option<f64>>,
        highlight: Highlight,
    },
    Dots {
        rows: Vec<DotRow>,
    },
    /// Samples, binned at layout; `bins` overrides the Freedman–Diaconis
    /// count.
    Histogram {
        values: Vec<f64>,
        bins: Option<usize>,
        /// A single ref per sample (gaps dropped with their values), or
        /// empty. A bin's row takes the union of its samples'.
        refs: Vec<Option<String>>,
    },
    Spans {
        items: Vec<SpanItem>,
    },
    Heat {
        categories: Vec<String>,
        values: Vec<Option<f64>>,
        refs: Vec<Option<RefSlot>>,
    },
    Bullet {
        items: Vec<BulletItem>,
    },
    /// One measure against another. The spec's `unit` and `format` are the
    /// vertical axis's; these two are the horizontal's.
    Scatter {
        series: Vec<ScatterSeries>,
        x_unit: Option<String>,
        x_format: Format,
    },
}

impl Data {
    /// The form's name, as the spec spells it.
    pub fn form(&self) -> &'static str {
        match self {
            Data::Bar { .. } => "bar",
            Data::Line { .. } => "line",
            Data::Area { .. } => "area",
            Data::Sparkline { .. } => "sparkline",
            Data::Dots { .. } => "dots",
            Data::Histogram { .. } => "histogram",
            Data::Spans { .. } => "spans",
            Data::Heat { .. } => "heat",
            Data::Bullet { .. } => "bullet",
            Data::Scatter { .. } => "scatter",
        }
    }

    /// Whether the form has a vertical value axis over a category row,
    /// which is what the taller minimum height is for.
    pub fn is_axis(&self) -> bool {
        match self {
            Data::Bar { orient, .. } => *orient == Orient::Vertical,
            Data::Line { .. }
            | Data::Area { .. }
            | Data::Histogram { .. }
            | Data::Scatter { .. } => true,
            _ => false,
        }
    }

    /// How many categories or points a mark annotation may index.
    fn points(&self) -> usize {
        match self {
            Data::Bar { categories, .. } => categories.len(),
            Data::Line { x, .. } | Data::Area { x, .. } => x.len(),
            _ => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub unit: Option<String>,
    pub format: Format,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub motion: bool,
    pub annotations: Vec<Annotation>,
    pub data: Data,
}

impl Spec {
    /// The form's default frame.
    pub fn default_size(&self) -> (f64, f64) {
        let rows =
            |n: usize, pitch: f64, chrome: f64| (560.0, (n as f64 * pitch + chrome).min(MAX_H));
        match &self.data {
            Data::Bar {
                orient: Orient::Horizontal,
                categories,
                ..
            } => rows(categories.len(), 24.0, 56.0),
            Data::Bar { .. } | Data::Line { .. } | Data::Area { .. } => (560.0, 240.0),
            Data::Sparkline { .. } => (120.0, 24.0),
            Data::Dots { rows: r } => rows(r.len(), 18.0, 40.0),
            Data::Histogram { .. } => (560.0, 200.0),
            Data::Spans { items } => rows(items.len(), 20.0, 48.0),
            Data::Heat { .. } => {
                let rows = if self.title.is_some() { TITLE_ROW } else { 0.0 }
                    + if self.subtitle.is_some() || self.unit.is_some() {
                        LABEL_ROW
                    } else {
                        0.0
                    };
                let header = if rows > 0.0 { rows + GAP } else { 0.0 };
                (560.0, header + CELL_H + 4.0 + LABEL_ROW)
            }
            Data::Bullet { items } => rows(items.len(), 28.0, 40.0),
            Data::Scatter { .. } => (560.0, 280.0),
        }
    }

    /// Per table row, whether the row carries a ref of its own: the rows
    /// whose drawn label gets the hidden rule the deck reveals.
    pub fn ruled_rows(&self) -> Vec<bool> {
        let rows = |slots: &[Option<RefSlot>]| slots.iter().map(Option::is_some).collect();
        match &self.data {
            Data::Bar { refs, .. }
            | Data::Line { refs, .. }
            | Data::Area { refs, .. }
            | Data::Heat { refs, .. } => rows(refs),
            Data::Dots { rows } => rows.iter().map(|r| r.ref_slot.is_some()).collect(),
            Data::Spans { items } => items.iter().map(|i| i.ref_slot.is_some()).collect(),
            Data::Bullet { items } => items.iter().map(|i| i.ref_slot.is_some()).collect(),
            Data::Sparkline { .. } | Data::Histogram { .. } | Data::Scatter { .. } => Vec::new(),
        }
    }

    /// How many refs the spec carries, counted as [`MAX_REFS`] counts them.
    pub fn ref_members(&self) -> usize {
        let series = |series: &[Series]| -> usize {
            series
                .iter()
                .map(|s| s.ref_slot.as_ref().map_or(0, RefSlot::members) + slot_members(&s.refs))
                .sum()
        };
        let data = match &self.data {
            Data::Bar {
                refs, series: s, ..
            }
            | Data::Line {
                refs, series: s, ..
            }
            | Data::Area {
                refs, series: s, ..
            } => slot_members(refs) + series(s),
            Data::Heat { refs, .. } => slot_members(refs),
            Data::Histogram { refs, .. } => refs.iter().flatten().count(),
            Data::Dots { rows } => rows
                .iter()
                .map(|r| r.ref_slot.as_ref().map_or(0, RefSlot::members) + slot_members(&r.refs))
                .sum(),
            Data::Spans { items } => items
                .iter()
                .filter_map(|i| i.ref_slot.as_ref())
                .map(RefSlot::members)
                .sum(),
            Data::Bullet { items } => items
                .iter()
                .filter_map(|i| i.ref_slot.as_ref())
                .map(RefSlot::members)
                .sum(),
            Data::Scatter { series, .. } => series.iter().map(|s| slot_members(&s.refs)).sum(),
            Data::Sparkline { .. } => 0,
        };
        let marks: usize = self
            .annotations
            .iter()
            .map(|a| match a {
                Annotation::Mark {
                    ref_slot: Some(slot),
                    ..
                } => slot.members(),
                _ => 0,
            })
            .sum();
        data + marks
    }
}

const FORM_NAMES: [&str; 10] = [
    "bar",
    "line",
    "area",
    "sparkline",
    "dots",
    "histogram",
    "spans",
    "heat",
    "bullet",
    "scatter",
];
const FORMS: &str = "bar, line, area, sparkline, dots, histogram, spans, heat, bullet or scatter";
const COMMON: [&str; 9] = [
    "tugchart",
    "form",
    "title",
    "subtitle",
    "unit",
    "format",
    "size",
    "motion",
    "annotations",
];

/// Reads and validates `source` for a door taking `layers`, returning
/// every error.
pub fn validate(source: &str, layers: Layers) -> Result<Source, Vec<ChartError>> {
    let value: Value =
        serde_json::from_str(source).map_err(|e| vec![err("", format!("not JSON: {e}"))])?;
    let Value::Object(obj) = &value else {
        let what = if layers == Layers::Diagram {
            "a diagram spec is a JSON object"
        } else {
            "a chart spec is a JSON object"
        };
        return Err(vec![err("", what)]);
    };
    if crate::diagram::is_diagram(obj) {
        if layers == Layers::Chart {
            return Err(vec![err("", DIAGRAM_IN_CHART_FENCE)]);
        }
        return crate::diagram::validate_object(obj).map(Source::Diagram);
    }
    if layers == Layers::Diagram {
        return Err(vec![err("", NOT_A_DIAGRAM)]);
    }
    if obj.contains_key("tugdraw") {
        if layers == Layers::Chart {
            return Err(vec![err("", LAYER0_IN_FENCE)]);
        }
        return draw::parse_value(&value)
            .map(Source::Draw)
            .map_err(|errors| {
                errors
                    .into_iter()
                    .map(|e| ChartError {
                        path: e.op.map(|i| format!("/ops/{i}")).unwrap_or_default(),
                        message: e.message,
                    })
                    .collect()
            });
    }
    let mut v = Validator::default();
    let spec = v.spec(obj);
    match spec {
        Some(spec) if v.errors.is_empty() => Ok(Source::Chart(spec)),
        _ => Err(v.errors),
    }
}

fn err(path: impl Into<String>, message: impl Into<String>) -> ChartError {
    ChartError {
        path: path.into(),
        message: message.into(),
    }
}

/// Escapes a key for a JSON pointer.
fn key_path(base: &str, key: &str) -> String {
    format!("{base}/{}", key.replace('~', "~0").replace('/', "~1"))
}

#[derive(Default)]
struct Validator {
    errors: Vec<ChartError>,
}

impl Validator {
    fn err(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.errors.push(err(path, message));
    }

    fn known_keys(&mut self, obj: &Map<String, Value>, base: &str, allowed: &[&str]) {
        for key in obj.keys() {
            if !allowed.contains(&key.as_str()) {
                self.err(key_path(base, key), format!("unknown field \"{key}\""));
            }
        }
    }

    /// A label: a string of at most [`MAX_LABEL`] graphemes.
    fn label(&mut self, value: &Value, path: &str, what: &str) -> Option<String> {
        match value {
            Value::String(s) if s.graphemes(true).count() > MAX_LABEL => {
                self.err(path, format!("{what} is at most {MAX_LABEL} characters"));
                None
            }
            Value::String(s) => Some(s.clone()),
            _ => {
                self.err(path, format!("{what} is a string"));
                None
            }
        }
    }

    fn opt_label(&mut self, obj: &Map<String, Value>, base: &str, key: &str) -> Option<String> {
        obj.get(key)
            .and_then(|v| self.label(v, &key_path(base, key), key))
    }

    fn number(&mut self, value: &Value, path: &str, what: &str) -> Option<f64> {
        match value.as_f64() {
            Some(n) if n.abs() <= MAX_VALUE => Some(n),
            Some(_) => {
                self.err(
                    path,
                    format!("{what} is out of range: magnitude above 1e15"),
                );
                None
            }
            None => {
                self.err(path, format!("{what} is a number"));
                None
            }
        }
    }

    /// An array of numbers or nulls, 1 to [`MAX_VALUES`] long.
    fn values(&mut self, value: Option<&Value>, path: &str) -> Option<Vec<Option<f64>>> {
        let Some(value) = value else {
            self.err(path, "values is required");
            return None;
        };
        let Value::Array(items) = value else {
            self.err(path, "values is an array of numbers or nulls");
            return None;
        };
        if items.is_empty() || items.len() > MAX_VALUES {
            self.err(path, format!("values holds 1 to {MAX_VALUES} entries"));
            return None;
        }
        let before = self.errors.len();
        let out: Vec<Option<f64>> = items
            .iter()
            .enumerate()
            .map(|(i, item)| match item {
                Value::Null => None,
                item => self.number(item, &format!("{path}/{i}"), "a value"),
            })
            .collect();
        (self.errors.len() == before).then_some(out)
    }

    fn labels(
        &mut self,
        value: Option<&Value>,
        path: &str,
        what: &str,
        numbers: bool,
    ) -> Option<Vec<String>> {
        let Some(value) = value else {
            self.err(path, format!("{what} is required"));
            return None;
        };
        let Value::Array(items) = value else {
            self.err(path, format!("{what} is an array"));
            return None;
        };
        if items.is_empty() || items.len() > MAX_VALUES {
            self.err(path, format!("{what} holds 1 to {MAX_VALUES} entries"));
            return None;
        }
        let before = self.errors.len();
        let out: Vec<String> = items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let p = format!("{path}/{i}");
                match item {
                    Value::Number(_) if numbers => self
                        .number(item, &p, "an x value")
                        .map(|n| Format::Auto.apply(n)),
                    _ => self.label(item, &p, if numbers { "an x value" } else { "a category" }),
                }
                .unwrap_or_default()
            })
            .collect();
        (self.errors.len() == before).then_some(out)
    }

    fn series_role(&mut self, s: &Map<String, Value>, base: &str, i: usize) -> ColourRole {
        match s.get("role") {
            None => ColourRole::Series(i as u8 + 1),
            Some(Value::String(r)) if SEMANTIC_ROLES.contains(&r.as_str()) => {
                ColourRole::parse(r).unwrap_or(ColourRole::Accent)
            }
            Some(_) => {
                self.err(
                    format!("{base}/role"),
                    "a series role is good, bad, caution, outside or accent",
                );
                ColourRole::Accent
            }
        }
    }

    fn series(&mut self, obj: &Map<String, Value>) -> Option<Vec<Series>> {
        let Some(value) = obj.get("series") else {
            self.err("/series", "series is required");
            return None;
        };
        let Value::Array(items) = value else {
            self.err("/series", "series is an array of {\"name\", \"values\"}");
            return None;
        };
        if items.is_empty() || items.len() > MAX_SERIES {
            self.err("/series", format!("a chart has 1 to {MAX_SERIES} series"));
            return None;
        }
        let before = self.errors.len();
        let mut out = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let base = format!("/series/{i}");
            let Value::Object(s) = item else {
                self.err(&base, "a series is an object {\"name\", \"values\"}");
                continue;
            };
            self.known_keys(s, &base, &["name", "values", "role", "ref", "refs"]);
            let name = self
                .opt_label(s, &base, "name")
                .unwrap_or_else(|| format!("series {}", i + 1));
            let role = self.series_role(s, &base, i);
            let ref_slot = self.opt_slot(s, &base, "ref");
            if let Some(values) = self.values(s.get("values"), &format!("{base}/values")) {
                let refs = self.ref_array(
                    s.get("refs"),
                    values.len(),
                    &format!("{base}/refs"),
                    "values",
                );
                out.push(Series {
                    name,
                    values,
                    role,
                    ref_slot,
                    refs,
                });
            }
        }
        (self.errors.len() == before).then_some(out)
    }

    /// A scatter's series: as [`Self::series`], with `points` for `values`.
    fn scatter_series(&mut self, obj: &Map<String, Value>) -> Option<Vec<ScatterSeries>> {
        let Some(value) = obj.get("series") else {
            self.err("/series", "series is required");
            return None;
        };
        let Value::Array(items) = value else {
            self.err("/series", "series is an array of {\"name\", \"points\"}");
            return None;
        };
        if items.is_empty() || items.len() > MAX_SERIES {
            self.err("/series", format!("a chart has 1 to {MAX_SERIES} series"));
            return None;
        }
        let before = self.errors.len();
        let mut out = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let base = format!("/series/{i}");
            let Value::Object(s) = item else {
                self.err(&base, "a series is an object {\"name\", \"points\"}");
                continue;
            };
            self.known_keys(s, &base, &["name", "points", "role"]);
            let name = self
                .opt_label(s, &base, "name")
                .unwrap_or_else(|| format!("series {}", i + 1));
            let role = self.series_role(s, &base, i);
            if let Some((points, refs)) = self.points(s.get("points"), &format!("{base}/points")) {
                out.push(ScatterSeries {
                    name,
                    points,
                    role,
                    refs,
                });
            }
        }
        (self.errors.len() == before).then_some(out)
    }

    /// An array of `{x, y}` objects, 1 to [`MAX_VALUES`] long. A point has
    /// both numbers or it is not a point, so there is no gap to hold. The
    /// points' refs come beside them, empty when no point carries one.
    #[allow(clippy::type_complexity)]
    fn points(
        &mut self,
        value: Option<&Value>,
        path: &str,
    ) -> Option<(Vec<(f64, f64)>, Vec<Option<RefSlot>>)> {
        let Some(value) = value else {
            self.err(path, "points is required");
            return None;
        };
        let Value::Array(items) = value else {
            self.err(path, "points is an array of {\"x\", \"y\"}");
            return None;
        };
        if items.is_empty() || items.len() > MAX_VALUES {
            self.err(path, format!("points holds 1 to {MAX_VALUES} entries"));
            return None;
        }
        let before = self.errors.len();
        let mut out = Vec::with_capacity(items.len());
        let mut refs = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            let base = format!("{path}/{i}");
            let Value::Object(p) = item else {
                self.err(&base, "a point is an object {\"x\", \"y\"}");
                continue;
            };
            self.known_keys(p, &base, &["x", "y", "ref"]);
            refs.push(self.opt_slot(p, &base, "ref"));
            let mut axis = |key: &str| match p.get(key) {
                Some(n) => self.number(n, &format!("{base}/{key}"), key),
                None => {
                    self.err(format!("{base}/{key}"), format!("{key} is required"));
                    None
                }
            };
            let x = axis("x");
            let y = axis("y");
            if let (Some(x), Some(y)) = (x, y) {
                out.push((x, y));
            }
        }
        if refs.iter().all(Option::is_none) {
            refs.clear();
        }
        (self.errors.len() == before).then_some((out, refs))
    }

    /// Every series has `n` values.
    fn same_length(&mut self, series: &[Series], n: usize, of: &str) {
        for (i, s) in series.iter().enumerate() {
            if s.values.len() != n {
                self.err(
                    format!("/series/{i}/values"),
                    format!("series has {} values for {n} {of}", s.values.len()),
                );
            }
        }
    }

    fn one_of(&mut self, obj: &Map<String, Value>, key: &str, allowed: &[&str]) -> Option<String> {
        match obj.get(key) {
            None => None,
            Some(Value::String(s)) if allowed.contains(&s.as_str()) => Some(s.clone()),
            Some(_) => {
                self.err(
                    key_path("", key),
                    format!("{key} is one of {}", allowed.join(", ")),
                );
                None
            }
        }
    }

    /// One ref, `<kind>:<value>`.
    fn one_ref(&mut self, value: &Value, path: &str) -> Option<(RefKind, String)> {
        let Value::String(s) = value else {
            self.err(path, "a ref is a string \"<kind>:<value>\"");
            return None;
        };
        let Some((prefix, rest)) = s.split_once(':') else {
            self.err(
                path,
                format!("a ref is \"<kind>:<value>\", with kind one of {REF_KINDS}"),
            );
            return None;
        };
        let Some(kind) = RefKind::parse(prefix) else {
            self.err(
                path,
                format!("unknown ref kind \"{prefix}\": expected {REF_KINDS}"),
            );
            return None;
        };
        if let Err(message) = kind.check(rest) {
            self.err(path, message);
            return None;
        }
        Some((kind, s.clone()))
    }

    /// A slot: a ref, an array of 1 to [`MAX_SET`] refs of one kind (one
    /// member reads as its ref), or `{"kind", "count"}`.
    fn ref_slot(&mut self, value: &Value, path: &str) -> Option<RefSlot> {
        match value {
            Value::String(_) => self.one_ref(value, path).map(|(_, r)| RefSlot::One(r)),
            Value::Array(items) => {
                if items.is_empty() || items.len() > MAX_SET {
                    self.err(path, format!("a set holds 1 to {MAX_SET} refs"));
                    return None;
                }
                let before = self.errors.len();
                let mut kind: Option<RefKind> = None;
                let mut members = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    let p = format!("{path}/{i}");
                    let Some((k, r)) = self.one_ref(item, &p) else {
                        continue;
                    };
                    match kind {
                        Some(first) if first != k => self.err(
                            &p,
                            format!(
                                "a set holds refs of one kind: \"{}\" among \"{}\"",
                                k.name(),
                                first.name()
                            ),
                        ),
                        _ => kind = Some(k),
                    }
                    members.push(r);
                }
                if self.errors.len() != before {
                    return None;
                }
                let kind = kind?;
                if members.len() == 1 {
                    return members.pop().map(RefSlot::One);
                }
                Some(RefSlot::Set {
                    kind: kind.name().to_string(),
                    members,
                })
            }
            Value::Object(o) => {
                self.known_keys(o, path, &["kind", "count"]);
                let kind = match o.get("kind") {
                    Some(Value::String(k)) => match RefKind::parse(k) {
                        Some(kind) => Some(kind),
                        None => {
                            self.err(
                                format!("{path}/kind"),
                                format!("unknown ref kind \"{k}\": expected {REF_KINDS}"),
                            );
                            None
                        }
                    },
                    _ => {
                        self.err(
                            format!("{path}/kind"),
                            format!("a count's kind is one of {REF_KINDS}"),
                        );
                        None
                    }
                };
                let count = match o.get("count").and_then(Value::as_u64) {
                    Some(n) if n >= 1 && n <= u64::from(u32::MAX) => Some(n as u32),
                    _ => {
                        self.err(
                            format!("{path}/count"),
                            "a count is an integer of at least 1",
                        );
                        None
                    }
                };
                Some(RefSlot::Count {
                    kind: kind?.name().to_string(),
                    count: count?,
                })
            }
            _ => {
                self.err(
                    path,
                    "a ref slot is a ref, an array of refs of one kind, or {\"kind\", \"count\"}",
                );
                None
            }
        }
    }

    /// An optional slot under `key`.
    fn opt_slot(&mut self, obj: &Map<String, Value>, base: &str, key: &str) -> Option<RefSlot> {
        obj.get(key)
            .and_then(|v| self.ref_slot(v, &key_path(base, key)))
    }

    /// A parallel array of slots or nulls, `len` long, beside the `len`
    /// entries of `of`. Absent, it is empty.
    fn ref_array(
        &mut self,
        value: Option<&Value>,
        len: usize,
        path: &str,
        of: &str,
    ) -> Vec<Option<RefSlot>> {
        let Some(value) = value else {
            return Vec::new();
        };
        let Value::Array(items) = value else {
            self.err(path, "refs is an array of ref slots or nulls");
            return Vec::new();
        };
        if items.len() != len {
            self.err(
                path,
                format!("refs has {} entries for {len} {of}", items.len()),
            );
            return Vec::new();
        }
        items
            .iter()
            .enumerate()
            .map(|(i, item)| match item {
                Value::Null => None,
                item => self.ref_slot(item, &format!("{path}/{i}")),
            })
            .collect()
    }

    /// A histogram's refs: a single ref or null per sample, all one kind. A
    /// sample is one thing, so a set or a count is not a sample's.
    fn sample_refs(&mut self, value: Option<&Value>, len: usize) -> Vec<Option<String>> {
        let Some(value) = value else {
            return Vec::new();
        };
        let Value::Array(items) = value else {
            self.err("/refs", "refs is an array of refs or nulls");
            return Vec::new();
        };
        if items.len() != len {
            self.err(
                "/refs",
                format!("refs has {} entries for {len} values", items.len()),
            );
            return Vec::new();
        }
        let mut kind: Option<RefKind> = None;
        let mut out = Vec::with_capacity(len);
        for (i, item) in items.iter().enumerate() {
            let p = format!("/refs/{i}");
            match item {
                Value::Null => out.push(None),
                Value::String(_) => match self.one_ref(item, &p) {
                    Some((k, r)) => {
                        match kind {
                            Some(first) if first != k => self.err(
                                &p,
                                format!(
                                    "a histogram's refs are of one kind: \"{}\" among \"{}\"",
                                    k.name(),
                                    first.name()
                                ),
                            ),
                            _ => kind = Some(k),
                        }
                        out.push(Some(r));
                    }
                    None => out.push(None),
                },
                _ => {
                    self.err(&p, "a histogram sample's ref is a single ref");
                    out.push(None);
                }
            }
        }
        out
    }

    fn spec(&mut self, obj: &Map<String, Value>) -> Option<Spec> {
        if obj.get("tugchart").and_then(Value::as_u64) != Some(1) {
            self.err("/tugchart", "a chart spec starts with \"tugchart\": 1");
        }
        let form = match obj.get("form") {
            Some(Value::String(f)) if FORM_NAMES.contains(&f.as_str()) => f.clone(),
            Some(Value::String(f)) => {
                self.err("/form", format!("unknown form \"{f}\": expected {FORMS}"));
                return None;
            }
            Some(_) => {
                self.err("/form", format!("form is a string: {FORMS}"));
                return None;
            }
            None => {
                self.err("/form", format!("form is required: {FORMS}"));
                return None;
            }
        };
        let data_keys: &[&str] = match form.as_str() {
            "bar" => &["categories", "series", "orient", "layout", "refs"],
            "line" => &["x", "series", "refs"],
            "area" => &["x", "series", "layout", "refs"],
            "sparkline" => &["values", "highlight"],
            "dots" => &["rows"],
            "histogram" => &["values", "bins", "refs"],
            "spans" => &["items"],
            "heat" => &["categories", "values", "refs"],
            "scatter" => &["series", "xunit", "xformat"],
            _ => &["items"],
        };
        let allowed: Vec<&str> = COMMON.iter().chain(data_keys).copied().collect();
        self.known_keys(obj, "", &allowed);

        let title = self.opt_label(obj, "", "title");
        if title.is_none() && form != "sparkline" && !obj.contains_key("title") {
            self.err("/title", "title is required");
        }
        let subtitle = self.opt_label(obj, "", "subtitle");
        let unit = self.opt_label(obj, "", "unit");
        let format = self.format_field(obj, "format");
        let motion = self.one_of(obj, "motion", &["enter", "none"]).as_deref() != Some("none");
        // Read before the data, so a bad size is reported beside bad data;
        // the axis forms' taller floor is checked once the form is known.
        let (w, h) = self.size(obj);

        let data = match form.as_str() {
            "bar" => {
                let orient = match self
                    .one_of(obj, "orient", &["vertical", "horizontal"])
                    .as_deref()
                {
                    Some("horizontal") => Orient::Horizontal,
                    _ => Orient::Vertical,
                };
                let stacked = self
                    .one_of(obj, "layout", &["grouped", "stacked"])
                    .as_deref()
                    == Some("stacked");
                let categories =
                    self.labels(obj.get("categories"), "/categories", "categories", false);
                let series = self.series(obj);
                if let (Some(c), Some(s)) = (&categories, &series) {
                    self.same_length(s, c.len(), "categories");
                    if orient == Orient::Horizontal && c.len() > MAX_ROWS {
                        self.err(
                            "/categories",
                            format!("a horizontal bar chart has at most {MAX_ROWS} categories"),
                        );
                    }
                }
                let refs = match &categories {
                    Some(c) => self.ref_array(obj.get("refs"), c.len(), "/refs", "categories"),
                    None => Vec::new(),
                };
                Data::Bar {
                    categories: categories?,
                    series: series?,
                    orient,
                    stacked,
                    refs,
                }
            }
            "line" | "area" => {
                let stacked = form == "area"
                    && self
                        .one_of(obj, "layout", &["overlap", "stacked"])
                        .as_deref()
                        == Some("stacked");
                let series = self.series(obj)?;
                let x = match obj.get("x") {
                    Some(x) => self.labels(Some(x), "/x", "x", true)?,
                    None => (1..=series[0].values.len())
                        .map(|i| i.to_string())
                        .collect(),
                };
                self.same_length(&series, x.len(), "x values");
                let refs = self.ref_array(obj.get("refs"), x.len(), "/refs", "x values");
                if form == "line" {
                    Data::Line { x, series, refs }
                } else {
                    Data::Area {
                        x,
                        series,
                        stacked,
                        refs,
                    }
                }
            }
            "sparkline" => {
                let values = self.values(obj.get("values"), "/values")?;
                if values.iter().all(Option::is_none) {
                    self.err("/values", "a sparkline needs at least one number");
                }
                let highlight = match self
                    .one_of(obj, "highlight", &["last", "min-max", "none"])
                    .as_deref()
                {
                    Some("min-max") => Highlight::MinMax,
                    Some("none") => Highlight::None,
                    _ => Highlight::Last,
                };
                Data::Sparkline { values, highlight }
            }
            "dots" => Data::Dots {
                rows: self.dot_rows(obj)?,
            },
            "histogram" => {
                let raw = self.values(obj.get("values"), "/values")?;
                let sample_refs = self.sample_refs(obj.get("refs"), raw.len());
                // A gap is no sample, so its ref goes with it.
                let refs: Vec<Option<String>> = if sample_refs.is_empty() {
                    Vec::new()
                } else {
                    raw.iter()
                        .zip(sample_refs)
                        .filter(|(v, _)| v.is_some())
                        .map(|(_, r)| r)
                        .collect()
                };
                let values: Vec<f64> = raw.into_iter().flatten().collect();
                if values.is_empty() {
                    self.err("/values", "a histogram needs at least one number");
                }
                let bins = match obj.get("bins") {
                    None => None,
                    Some(b) => match b.as_u64() {
                        Some(n) if (MIN_BINS as u64..=MAX_BINS as u64).contains(&n) => {
                            Some(n as usize)
                        }
                        _ => {
                            self.err(
                                "/bins",
                                format!("bins is an integer from {MIN_BINS} to {MAX_BINS}"),
                            );
                            None
                        }
                    },
                };
                Data::Histogram { values, bins, refs }
            }
            "spans" => Data::Spans {
                items: self.span_items(obj)?,
            },
            "heat" => {
                let categories =
                    self.labels(obj.get("categories"), "/categories", "categories", false);
                let values = self.values(obj.get("values"), "/values");
                if let (Some(c), Some(v)) = (&categories, &values) {
                    if v.len() != c.len() {
                        self.err(
                            "/values",
                            format!("values has {} entries for {} categories", v.len(), c.len()),
                        );
                    }
                }
                let refs = match &categories {
                    Some(c) => self.ref_array(obj.get("refs"), c.len(), "/refs", "categories"),
                    None => Vec::new(),
                };
                Data::Heat {
                    categories: categories?,
                    values: values?,
                    refs,
                }
            }
            "scatter" => {
                let x_unit = self.opt_label(obj, "", "xunit");
                let x_format = self.format_field(obj, "xformat");
                Data::Scatter {
                    series: self.scatter_series(obj)?,
                    x_unit,
                    x_format,
                }
            }
            _ => Data::Bullet {
                items: self.bullet_items(obj)?,
            },
        };
        if h.is_some_and(|h| data.is_axis() && h < MIN_AXIS_H) {
            self.err(
                "/size/h",
                format!(
                    "size.h is a number from {MIN_AXIS_H} to {MAX_H} for a {}",
                    data.form()
                ),
            );
        }
        let annotated = matches!(
            data,
            Data::Bar { .. } | Data::Line { .. } | Data::Area { .. }
        );
        let annotations = self.annotations(obj, annotated.then_some(data.points()), data.form());
        let spec = Spec {
            title,
            subtitle,
            unit,
            format,
            w,
            h,
            motion,
            annotations,
            data,
        };
        let members = spec.ref_members();
        if members > MAX_REFS {
            self.err(
                "",
                format!("a chart carries at most {MAX_REFS} refs; this one carries {members}"),
            );
        }
        Some(spec)
    }

    fn format_field(&mut self, obj: &Map<String, Value>, key: &str) -> Format {
        match obj.get(key) {
            None => Format::Auto,
            Some(Value::String(f)) if Format::parse(f).is_some() => {
                Format::parse(f).unwrap_or(Format::Auto)
            }
            Some(_) => {
                self.err(
                    key_path("", key),
                    format!("{key} is one of {}", Format::NAMES.join(", ")),
                );
                Format::Auto
            }
        }
    }

    fn size(&mut self, obj: &Map<String, Value>) -> (Option<f64>, Option<f64>) {
        let Some(size) = obj.get("size") else {
            return (None, None);
        };
        let Value::Object(size) = size else {
            self.err("/size", "size is an object {\"w\", \"h\"}");
            return (None, None);
        };
        self.known_keys(size, "/size", &["w", "h"]);
        let mut side = |key: &str, lo: f64, hi: f64| {
            let v = size.get(key)?;
            match v.as_f64() {
                Some(n) if (lo..=hi).contains(&n) => Some(n),
                _ => {
                    self.err(
                        format!("/size/{key}"),
                        format!("size.{key} is a number from {lo} to {hi}"),
                    );
                    None
                }
            }
        };
        (side("w", MIN_W, MAX_W), side("h", MIN_H, MAX_H))
    }

    /// A row form's list of `{label, …}` objects, 1 to [`MAX_ROWS`] long,
    /// each with `keys` and nothing else; `each` reads one.
    fn rows<T>(
        &mut self,
        obj: &Map<String, Value>,
        key: &str,
        keys: &[&str],
        mut each: impl FnMut(&mut Self, &Map<String, Value>, &str, String) -> Option<T>,
    ) -> Option<Vec<T>> {
        let path = key_path("", key);
        let Some(value) = obj.get(key) else {
            self.err(&path, format!("{key} is required"));
            return None;
        };
        let Value::Array(items) = value else {
            self.err(&path, format!("{key} is an array of objects"));
            return None;
        };
        if items.is_empty() || items.len() > MAX_ROWS {
            self.err(&path, format!("{key} holds 1 to {MAX_ROWS} entries"));
            return None;
        }
        let before = self.errors.len();
        let mut out = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let base = format!("{path}/{i}");
            let Value::Object(row) = item else {
                self.err(&base, "an entry is an object with a label");
                continue;
            };
            self.known_keys(row, &base, keys);
            let label = match row.get("label") {
                Some(l) => self.label(l, &format!("{base}/label"), "label"),
                None => {
                    self.err(format!("{base}/label"), "label is required");
                    None
                }
            };
            if let Some(label) = label {
                out.extend(each(self, row, &base, label));
            }
        }
        (self.errors.len() == before).then_some(out)
    }

    fn dot_rows(&mut self, obj: &Map<String, Value>) -> Option<Vec<DotRow>> {
        self.rows(
            obj,
            "rows",
            &["label", "items", "ref", "refs"],
            |v, row, base, label| {
                let path = format!("{base}/items");
                let Some(Value::Array(items)) = row.get("items") else {
                    v.err(&path, "items is an array of good, bad or neutral");
                    return None;
                };
                if items.is_empty() || items.len() > MAX_VALUES {
                    v.err(&path, format!("items holds 1 to {MAX_VALUES} entries"));
                    return None;
                }
                let mut dots = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    match item.as_str().and_then(Dot::parse) {
                        Some(d) => dots.push(d),
                        None => v.err(format!("{path}/{i}"), "an item is good, bad or neutral"),
                    }
                }
                let ref_slot = v.opt_slot(row, base, "ref");
                let refs = v.ref_array(
                    row.get("refs"),
                    items.len(),
                    &format!("{base}/refs"),
                    "items",
                );
                Some(DotRow {
                    label,
                    items: dots,
                    ref_slot,
                    refs,
                })
            },
        )
    }

    fn span_items(&mut self, obj: &Map<String, Value>) -> Option<Vec<SpanItem>> {
        self.rows(
            obj,
            "items",
            &["label", "start", "end", "status", "ref"],
            |v, row, base, label| {
                let mut end_of = |key: &str| match row.get(key) {
                    Some(n) => v.number(n, &format!("{base}/{key}"), key),
                    None => {
                        v.err(format!("{base}/{key}"), format!("{key} is required"));
                        None
                    }
                };
                let start = end_of("start");
                let end = end_of("end");
                let status = match row.get("status") {
                    None => None,
                    Some(Value::String(s)) if SEMANTIC_ROLES.contains(&s.as_str()) => {
                        Some(s.clone())
                    }
                    Some(_) => {
                        v.err(
                            format!("{base}/status"),
                            "a status is good, bad, caution, outside or accent",
                        );
                        None
                    }
                };
                let (start, end) = (start?, end?);
                if end < start {
                    v.err(format!("{base}/end"), "end is at least start");
                    return None;
                }
                let ref_slot = v.opt_slot(row, base, "ref");
                Some(SpanItem {
                    label,
                    start,
                    end,
                    status,
                    ref_slot,
                })
            },
        )
    }

    fn bullet_items(&mut self, obj: &Map<String, Value>) -> Option<Vec<BulletItem>> {
        self.rows(
            obj,
            "items",
            &["label", "value", "range", "target", "history", "ref"],
            |v, row, base, label| {
                let value = match row.get("value") {
                    Some(n) => v.number(n, &format!("{base}/value"), "value"),
                    None => {
                        v.err(format!("{base}/value"), "value is required");
                        None
                    }
                };
                let range = match row.get("range") {
                    None => None,
                    Some(Value::Array(pair)) if pair.len() == 2 => {
                        let lo = v.number(&pair[0], &format!("{base}/range/0"), "a range end");
                        let hi = v.number(&pair[1], &format!("{base}/range/1"), "a range end");
                        match (lo, hi) {
                            (Some(lo), Some(hi)) if lo <= hi => Some((lo, hi)),
                            (Some(_), Some(_)) => {
                                v.err(
                                    format!("{base}/range"),
                                    "a range is [lo, hi] with lo at most hi",
                                );
                                None
                            }
                            _ => None,
                        }
                    }
                    Some(_) => {
                        v.err(format!("{base}/range"), "a range is [lo, hi]");
                        None
                    }
                };
                let target = row
                    .get("target")
                    .and_then(|t| v.number(t, &format!("{base}/target"), "target"));
                let history = match row.get("history") {
                    None => Vec::new(),
                    Some(h) => v
                        .values(Some(h), &format!("{base}/history"))
                        .unwrap_or_default(),
                };
                let ref_slot = v.opt_slot(row, base, "ref");
                Some(BulletItem {
                    label,
                    value: value?,
                    range,
                    target,
                    history,
                    ref_slot,
                })
            },
        )
    }

    /// `points` is how many a mark may index, or `None` for a form that
    /// takes no annotations at all.
    fn annotations(
        &mut self,
        obj: &Map<String, Value>,
        points: Option<usize>,
        form: &str,
    ) -> Vec<Annotation> {
        let Some(value) = obj.get("annotations") else {
            return Vec::new();
        };
        let Some(points) = points else {
            self.err("/annotations", format!("a {form} takes no annotations"));
            return Vec::new();
        };
        let Value::Array(items) = value else {
            self.err("/annotations", "annotations is an array");
            return Vec::new();
        };
        if items.len() > MAX_ANNOTATIONS {
            self.err(
                "/annotations",
                format!("a chart has at most {MAX_ANNOTATIONS} annotations"),
            );
            return Vec::new();
        }
        let mut out = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let base = format!("/annotations/{i}");
            let Value::Object(a) = item else {
                self.err(&base, "an annotation is an object");
                continue;
            };
            let label = self.opt_label(a, &base, "label");
            match a.get("kind").and_then(Value::as_str) {
                Some("rule") => {
                    self.known_keys(a, &base, &["kind", "value", "label"]);
                    match a.get("value") {
                        Some(v) => {
                            if let Some(value) =
                                self.number(v, &format!("{base}/value"), "a rule value")
                            {
                                out.push(Annotation::Rule { value, label });
                            }
                        }
                        None => self.err(format!("{base}/value"), "a rule needs a value"),
                    }
                }
                Some("mark") => {
                    self.known_keys(a, &base, &["kind", "at", "label", "ref"]);
                    let ref_slot = self.opt_slot(a, &base, "ref");
                    match a.get("at").and_then(Value::as_u64) {
                        Some(at) if (at as usize) < points => out.push(Annotation::Mark {
                            at: at as usize,
                            label,
                            ref_slot,
                        }),
                        _ => self.err(
                            format!("{base}/at"),
                            format!(
                                "a mark's at is an index from 0 to {}",
                                points.saturating_sub(1)
                            ),
                        ),
                    }
                }
                _ => self.err(format!("{base}/kind"), "an annotation kind is rule or mark"),
            }
        }
        out
    }
}

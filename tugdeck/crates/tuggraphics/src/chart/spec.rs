//! The layer 1 chart spec: its types, and the validator that reads one
//! from JSON and reports every error, each addressed by a JSON pointer
//! into the spec.

use serde::Serialize;
use serde_json::{Map, Value};
use unicode_segmentation::UnicodeSegmentation;

use super::format::Format;
use crate::draw::{self, ColourRole, Program, SERIES_COUNT};

/// At most this many series in one chart, one per categorical colour the
/// themes carry.
pub const MAX_SERIES: usize = SERIES_COUNT as usize;
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
    /// A chart spec or a layer 0 program: what a tool's stdout takes.
    Any,
}

impl Layers {
    pub fn parse(s: &str) -> Option<Layers> {
        match s {
            "chart" => Some(Layers::Chart),
            "any" => Some(Layers::Any),
            _ => None,
        }
    }
}

pub const LAYER0_IN_FENCE: &str = "a tugchart fence takes a chart spec, not a tugdraw program";

/// A validated source: a chart spec, or a layer 0 program where the door
/// takes one.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Chart(Spec),
    Draw(Program),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub name: String,
    pub values: Vec<Option<f64>>,
    pub role: ColourRole,
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
    /// A category or point, by index.
    Mark { at: usize, label: Option<String> },
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
}

/// One bar of a `spans` chart, from `start` to `end` on the shared axis.
/// `status` is the word the spec gave (`good`, `bad` or `accent`), kept
/// for the table; the layout maps it to a role.
#[derive(Clone, Debug, PartialEq)]
pub struct SpanItem {
    pub label: String,
    pub start: f64,
    pub end: f64,
    pub status: Option<String>,
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
}

#[derive(Clone, Debug, PartialEq)]
pub enum Data {
    Bar {
        categories: Vec<String>,
        series: Vec<Series>,
        orient: Orient,
        stacked: bool,
    },
    Line {
        x: Vec<String>,
        series: Vec<Series>,
    },
    /// As `line`, filled to the baseline: translucent overlapping fills,
    /// or stacked ones.
    Area {
        x: Vec<String>,
        series: Vec<Series>,
        stacked: bool,
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
    },
    Spans {
        items: Vec<SpanItem>,
    },
    Heat {
        categories: Vec<String>,
        values: Vec<Option<f64>>,
    },
    Bullet {
        items: Vec<BulletItem>,
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
        }
    }

    /// Whether the form has a vertical value axis over a category row,
    /// which is what the taller minimum height is for.
    pub fn is_axis(&self) -> bool {
        match self {
            Data::Bar { orient, .. } => *orient == Orient::Vertical,
            Data::Line { .. } | Data::Area { .. } | Data::Histogram { .. } => true,
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
        let rows = |n: usize, pitch: f64, chrome: f64| (560.0, (n as f64 * pitch + chrome).min(MAX_H));
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
            Data::Heat { .. } => (560.0, 64.0),
            Data::Bullet { items } => rows(items.len(), 28.0, 40.0),
        }
    }
}

const FORM_NAMES: [&str; 9] = [
    "bar",
    "line",
    "area",
    "sparkline",
    "dots",
    "histogram",
    "spans",
    "heat",
    "bullet",
];
const FORMS: &str = "bar, line, area, sparkline, dots, histogram, spans, heat or bullet";
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
    let value: Value = serde_json::from_str(source).map_err(|e| vec![err("", format!("not JSON: {e}"))])?;
    let Value::Object(obj) = &value else {
        return Err(vec![err("", "a chart spec is a JSON object")]);
    };
    if obj.contains_key("tugdraw") {
        if layers == Layers::Chart {
            return Err(vec![err("", LAYER0_IN_FENCE)]);
        }
        return draw::parse_value(&value).map(Source::Draw).map_err(|errors| {
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
        obj.get(key).and_then(|v| self.label(v, &key_path(base, key), key))
    }

    fn number(&mut self, value: &Value, path: &str, what: &str) -> Option<f64> {
        match value.as_f64() {
            Some(n) if n.abs() <= MAX_VALUE => Some(n),
            Some(_) => {
                self.err(path, format!("{what} is out of range: magnitude above 1e15"));
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

    fn labels(&mut self, value: Option<&Value>, path: &str, what: &str, numbers: bool) -> Option<Vec<String>> {
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
                    Value::Number(_) if numbers => self.number(item, &p, "an x value").map(|n| Format::Auto.apply(n)),
                    _ => self.label(item, &p, if numbers { "an x value" } else { "a category" }),
                }
                .unwrap_or_default()
            })
            .collect();
        (self.errors.len() == before).then_some(out)
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
            self.known_keys(s, &base, &["name", "values", "role"]);
            let name = self.opt_label(s, &base, "name").unwrap_or_else(|| format!("series {}", i + 1));
            let role = match s.get("role") {
                None => ColourRole::Series(i as u8 + 1),
                Some(Value::String(r)) if ["good", "bad", "accent"].contains(&r.as_str()) => {
                    ColourRole::parse(r).unwrap_or(ColourRole::Accent)
                }
                Some(_) => {
                    self.err(format!("{base}/role"), "a series role is good, bad or accent");
                    ColourRole::Accent
                }
            };
            if let Some(values) = self.values(s.get("values"), &format!("{base}/values")) {
                out.push(Series { name, values, role });
            }
        }
        (self.errors.len() == before).then_some(out)
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
                self.err(key_path("", key), format!("{key} is one of {}", allowed.join(", ")));
                None
            }
        }
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
            "bar" => &["categories", "series", "orient", "layout"],
            "line" => &["x", "series"],
            "area" => &["x", "series", "layout"],
            "sparkline" => &["values", "highlight"],
            "dots" => &["rows"],
            "histogram" => &["values", "bins"],
            "spans" => &["items"],
            "heat" => &["categories", "values"],
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
        let format = match obj.get("format") {
            None => Format::Auto,
            Some(Value::String(f)) if Format::parse(f).is_some() => Format::parse(f).unwrap_or(Format::Auto),
            Some(_) => {
                self.err("/format", format!("format is one of {}", Format::NAMES.join(", ")));
                Format::Auto
            }
        };
        let motion = self.one_of(obj, "motion", &["enter", "none"]).as_deref() != Some("none");
        // Read before the data, so a bad size is reported beside bad data;
        // the axis forms' taller floor is checked once the form is known.
        let (w, h) = self.size(obj);

        let data = match form.as_str() {
            "bar" => {
                let orient = match self.one_of(obj, "orient", &["vertical", "horizontal"]).as_deref() {
                    Some("horizontal") => Orient::Horizontal,
                    _ => Orient::Vertical,
                };
                let stacked = self.one_of(obj, "layout", &["grouped", "stacked"]).as_deref() == Some("stacked");
                let categories = self.labels(obj.get("categories"), "/categories", "categories", false);
                let series = self.series(obj);
                if let (Some(c), Some(s)) = (&categories, &series) {
                    self.same_length(s, c.len(), "categories");
                    if orient == Orient::Horizontal && c.len() > MAX_ROWS {
                        self.err("/categories", format!("a horizontal bar chart has at most {MAX_ROWS} categories"));
                    }
                }
                Data::Bar {
                    categories: categories?,
                    series: series?,
                    orient,
                    stacked,
                }
            }
            "line" | "area" => {
                let stacked =
                    form == "area" && self.one_of(obj, "layout", &["overlap", "stacked"]).as_deref() == Some("stacked");
                let series = self.series(obj)?;
                let x = match obj.get("x") {
                    Some(x) => self.labels(Some(x), "/x", "x", true)?,
                    None => (1..=series[0].values.len()).map(|i| i.to_string()).collect(),
                };
                self.same_length(&series, x.len(), "x values");
                if form == "line" {
                    Data::Line { x, series }
                } else {
                    Data::Area { x, series, stacked }
                }
            }
            "sparkline" => {
                let values = self.values(obj.get("values"), "/values")?;
                if values.iter().all(Option::is_none) {
                    self.err("/values", "a sparkline needs at least one number");
                }
                let highlight = match self.one_of(obj, "highlight", &["last", "min-max", "none"]).as_deref() {
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
                let values: Vec<f64> = self.values(obj.get("values"), "/values")?.into_iter().flatten().collect();
                if values.is_empty() {
                    self.err("/values", "a histogram needs at least one number");
                }
                let bins = match obj.get("bins") {
                    None => None,
                    Some(b) => match b.as_u64() {
                        Some(n) if (MIN_BINS as u64..=MAX_BINS as u64).contains(&n) => Some(n as usize),
                        _ => {
                            self.err("/bins", format!("bins is an integer from {MIN_BINS} to {MAX_BINS}"));
                            None
                        }
                    },
                };
                Data::Histogram { values, bins }
            }
            "spans" => Data::Spans {
                items: self.span_items(obj)?,
            },
            "heat" => {
                let categories = self.labels(obj.get("categories"), "/categories", "categories", false);
                let values = self.values(obj.get("values"), "/values");
                if let (Some(c), Some(v)) = (&categories, &values) {
                    if v.len() != c.len() {
                        self.err("/values", format!("values has {} entries for {} categories", v.len(), c.len()));
                    }
                }
                Data::Heat {
                    categories: categories?,
                    values: values?,
                }
            }
            _ => Data::Bullet {
                items: self.bullet_items(obj)?,
            },
        };
        if h.is_some_and(|h| data.is_axis() && h < MIN_AXIS_H) {
            self.err("/size/h", format!("size.h is a number from {MIN_AXIS_H} to {MAX_H} for a {}", data.form()));
        }
        let annotated = matches!(data, Data::Bar { .. } | Data::Line { .. } | Data::Area { .. });
        let annotations = self.annotations(obj, annotated.then_some(data.points()), data.form());
        Some(Spec {
            title,
            subtitle,
            unit,
            format,
            w,
            h,
            motion,
            annotations,
            data,
        })
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
                    self.err(format!("/size/{key}"), format!("size.{key} is a number from {lo} to {hi}"));
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
        self.rows(obj, "rows", &["label", "items"], |v, row, base, label| {
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
            Some(DotRow { label, items: dots })
        })
    }

    fn span_items(&mut self, obj: &Map<String, Value>) -> Option<Vec<SpanItem>> {
        self.rows(obj, "items", &["label", "start", "end", "status"], |v, row, base, label| {
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
                Some(Value::String(s)) if ["good", "bad", "accent"].contains(&s.as_str()) => Some(s.clone()),
                Some(_) => {
                    v.err(format!("{base}/status"), "a status is good, bad or accent");
                    None
                }
            };
            let (start, end) = (start?, end?);
            if end < start {
                v.err(format!("{base}/end"), "end is at least start");
                return None;
            }
            Some(SpanItem {
                label,
                start,
                end,
                status,
            })
        })
    }

    fn bullet_items(&mut self, obj: &Map<String, Value>) -> Option<Vec<BulletItem>> {
        self.rows(
            obj,
            "items",
            &["label", "value", "range", "target", "history"],
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
                                v.err(format!("{base}/range"), "a range is [lo, hi] with lo at most hi");
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
                    Some(h) => v.values(Some(h), &format!("{base}/history")).unwrap_or_default(),
                };
                Some(BulletItem {
                    label,
                    value: value?,
                    range,
                    target,
                    history,
                })
            },
        )
    }

    /// `points` is how many a mark may index, or `None` for a form that
    /// takes no annotations at all.
    fn annotations(&mut self, obj: &Map<String, Value>, points: Option<usize>, form: &str) -> Vec<Annotation> {
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
            self.err("/annotations", format!("a chart has at most {MAX_ANNOTATIONS} annotations"));
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
                            if let Some(value) = self.number(v, &format!("{base}/value"), "a rule value") {
                                out.push(Annotation::Rule { value, label });
                            }
                        }
                        None => self.err(format!("{base}/value"), "a rule needs a value"),
                    }
                }
                Some("mark") => {
                    self.known_keys(a, &base, &["kind", "at", "label"]);
                    match a.get("at").and_then(Value::as_u64) {
                        Some(at) if (at as usize) < points => out.push(Annotation::Mark {
                            at: at as usize,
                            label,
                        }),
                        _ => self.err(
                            format!("{base}/at"),
                            format!("a mark's at is an index from 0 to {}", points.saturating_sub(1)),
                        ),
                    }
                }
                _ => self.err(format!("{base}/kind"), "an annotation kind is rule or mark"),
            }
        }
        out
    }
}

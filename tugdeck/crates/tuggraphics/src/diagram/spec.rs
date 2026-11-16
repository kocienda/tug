//! The diagram spec: its types, and the validator that reads one from JSON
//! and reports every error and every warning, each addressed by a JSON
//! pointer into the spec.
//!
//! A spec names a form and gives names, relations and order. It has no x
//! and no y anywhere: the form gives every coordinate.
//!
//! An error is what leaves nothing to draw: no known form, a required
//! field missing or of the wrong type. Everything else wrong with a spec
//! is repaired and reported as a warning, so the figure is still drawn:
//! an unknown field is ignored, an optional field that is malformed is
//! left out, an edge or a message naming something that does not exist is
//! dropped, and a key number given twice keeps its first mark.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use unicode_segmentation::UnicodeSegmentation;

use crate::chart::ChartError;
use crate::draw::ColourRole;

/// The longest string a spec should carry, in graphemes; one longer is
/// kept and warned of. Names are capped tighter than this by their
/// measured width.
pub const MAX_TEXT: usize = 120;
/// The largest key number: two digits fit a key disc.
pub const MAX_KEY: u64 = 99;

/// The forms a diagram may take.
pub const FORM_NAMES: [&str; 4] = ["flow", "sequence", "layers", "stack"];
/// The most grid columns a stack may be ruled into.
pub const MAX_STACK_COLUMNS: u64 = 12;

/// What an edge or a lit row means. Nothing in particular is the muted ink
/// and is written by leaving `tone` out; the accent is the key discs' and
/// is never a tone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Good,
    Bad,
    Caution,
    Outside,
}

pub const TONE_NAMES: [&str; 4] = ["good", "bad", "caution", "outside"];

impl Tone {
    fn parse(s: &str) -> Option<Tone> {
        match s {
            "good" => Some(Tone::Good),
            "bad" => Some(Tone::Bad),
            "caution" => Some(Tone::Caution),
            "outside" => Some(Tone::Outside),
            _ => None,
        }
    }

    pub fn colour(self) -> ColourRole {
        match self {
            Tone::Good => ColourRole::Good,
            Tone::Bad => ColourRole::Bad,
            Tone::Caution => ColourRole::Caution,
            Tone::Outside => ColourRole::Outside,
        }
    }
}

/// A key: the number a mark shows, and its row in the keyed table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub n: u64,
    /// What the mark does.
    pub what: Option<String>,
    /// Where it is in the code.
    pub r#where: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FlowRow {
    pub name: String,
    pub sub: Option<String>,
    /// Set in the mono face: an identifier, a path, a key.
    pub mono: bool,
    /// Lit in a tone, as the target of an outcome.
    pub lit: Option<Tone>,
    pub key: Option<Key>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FlowNode {
    pub id: String,
    pub name: String,
    pub sub: Option<String>,
    pub rows: Vec<FlowRow>,
    /// Small lines beneath the box.
    pub notes: Vec<String>,
}

/// One end of an edge: a node, or one of its rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EndRef {
    pub col: usize,
    pub node: usize,
    /// The row, 0-based; `None` for the node itself.
    pub row: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FlowEdge {
    pub from: EndRef,
    pub to: EndRef,
    pub tone: Option<Tone>,
    pub label: Option<String>,
    pub dashed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Flow {
    /// Columns left to right, each a stack of nodes top to bottom.
    pub columns: Vec<Vec<FlowNode>>,
    pub edges: Vec<FlowEdge>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Form {
    Flow(Flow),
    Sequence(Sequence),
    Layers(Layers),
    Stack(Stack),
}

/// A span of a stack's grid columns, 1-based and inclusive.
pub type Span = (u64, u64);

/// What lies outside the stack, above or beneath it.
#[derive(Clone, Debug, PartialEq)]
pub struct StackBlock {
    pub name: String,
    pub sub: Option<String>,
    pub span: Span,
}

/// One thing a stack layer holds, centred in its cell.
#[derive(Clone, Debug, PartialEq)]
pub struct StackCell {
    pub name: String,
    pub sub: Option<String>,
    pub key: Option<Key>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StackLayer {
    pub name: String,
    pub sub: Option<String>,
    pub span: Span,
    /// Rows of cells; each row shares the layer's width equally.
    pub rows: Vec<Vec<StackCell>>,
}

/// What every layer uses: bars down the stack's side.
#[derive(Clone, Debug, PartialEq)]
pub struct Across {
    pub title: String,
    pub names: Vec<String>,
}

/// The block diagram: layers ruled on a column grid.
#[derive(Clone, Debug, PartialEq)]
pub struct Stack {
    pub columns: u64,
    pub above: Vec<StackBlock>,
    /// Top to bottom.
    pub layers: Vec<StackLayer>,
    pub below: Vec<StackBlock>,
    pub across: Option<Across>,
}

/// A cell of a layer: one thing the layer holds.
#[derive(Clone, Debug, PartialEq)]
pub struct LayerCell {
    pub name: String,
    pub sub: Option<String>,
    /// Set in the mono face: an identifier, a path, a key.
    pub mono: bool,
    pub key: Option<Key>,
}

/// One stratum, the full width of the figure.
#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    pub name: String,
    pub sub: Option<String>,
    pub cells: Vec<LayerCell>,
    /// What crosses the boundary to the layer beneath.
    pub below: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Layers {
    /// Top to bottom.
    pub layers: Vec<Layer>,
}

/// One of a sequence's actors: a lifeline with its name at the top.
#[derive(Clone, Debug, PartialEq)]
pub struct Actor {
    pub id: String,
    pub name: String,
    pub sub: Option<String>,
}

/// One message of a sequence, a row of its own in time order.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    /// The actor it leaves, by index.
    pub from: usize,
    /// The actor it reaches; the same as `from` for a step the actor takes
    /// alone.
    pub to: usize,
    /// One line: a message's row height is the figure's rhythm.
    pub label: String,
    pub tone: Option<Tone>,
    /// An answer coming back: dashed and muted.
    pub reply: bool,
    pub key: Option<Key>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sequence {
    /// Actors left to right.
    pub actors: Vec<Actor>,
    /// Messages top to bottom, in the order they happen.
    pub messages: Vec<Message>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub title: String,
    pub motion: bool,
    pub form: Form,
    /// What validation repaired or found over a budget. The figure is
    /// drawn all the same; these are for whoever wrote the spec.
    pub warnings: Vec<ChartError>,
}

/// One row of the keyed table: the key, the mark's name, what it does and
/// where it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyedRow {
    pub n: u64,
    pub name: String,
    pub what: String,
    pub r#where: String,
}

impl Spec {
    pub fn form_name(&self) -> &'static str {
        match self.form {
            Form::Flow(_) => "flow",
            Form::Sequence(_) => "sequence",
            Form::Layers(_) => "layers",
            Form::Stack(_) => "stack",
        }
    }

    /// The keyed marks, in key order.
    pub fn keyed(&self) -> Vec<KeyedRow> {
        let mut out = Vec::new();
        match &self.form {
            Form::Flow(flow) => {
                for row in flow.columns.iter().flatten().flat_map(|n| &n.rows) {
                    if let Some(k) = &row.key {
                        out.push(KeyedRow {
                            n: k.n,
                            name: row.name.clone(),
                            what: k.what.clone().unwrap_or_default(),
                            r#where: k.r#where.clone().unwrap_or_default(),
                        });
                    }
                }
            }
            Form::Sequence(seq) => {
                for m in &seq.messages {
                    if let Some(k) = &m.key {
                        out.push(KeyedRow {
                            n: k.n,
                            name: m.label.clone(),
                            what: k.what.clone().unwrap_or_default(),
                            r#where: k.r#where.clone().unwrap_or_default(),
                        });
                    }
                }
            }
            Form::Layers(layers) => {
                for cell in layers.layers.iter().flat_map(|l| &l.cells) {
                    if let Some(k) = &cell.key {
                        out.push(KeyedRow {
                            n: k.n,
                            name: cell.name.clone(),
                            what: k.what.clone().unwrap_or_default(),
                            r#where: k.r#where.clone().unwrap_or_default(),
                        });
                    }
                }
            }
            Form::Stack(stack) => {
                let cells = stack.layers.iter().flat_map(|l| l.rows.iter().flatten());
                for cell in cells {
                    if let Some(k) = &cell.key {
                        out.push(KeyedRow {
                            n: k.n,
                            name: cell.name.clone(),
                            what: k.what.clone().unwrap_or_default(),
                            r#where: k.r#where.clone().unwrap_or_default(),
                        });
                    }
                }
            }
        }
        out.sort_by_key(|r| r.n);
        out
    }
}

pub(crate) fn err(path: impl Into<String>, message: impl Into<String>) -> ChartError {
    ChartError {
        path: path.into(),
        message: message.into(),
    }
}

/// Escapes a key for a JSON pointer.
fn key_path(base: &str, key: &str) -> String {
    format!("{base}/{}", key.replace('~', "~0").replace('/', "~1"))
}

const COMMON: [&str; 4] = ["tugdiagram", "form", "title", "motion"];

/// Validates a parsed diagram spec, returning every error. A spec with
/// none is returned with its warnings, the budgets it is over among them.
pub fn validate_object(obj: &Map<String, Value>) -> Result<Spec, Vec<ChartError>> {
    let mut v = Validator::default();
    let spec = v.spec(obj);
    match spec {
        Some(mut spec) if v.errors.is_empty() => {
            // A well-formed figure may still be too full to read.
            v.warnings.extend(super::budget::check(&spec));
            spec.warnings = v.warnings;
            Ok(spec)
        }
        _ => Err(v.errors),
    }
}

#[derive(Default)]
struct Validator {
    errors: Vec<ChartError>,
    warnings: Vec<ChartError>,
    /// Every key number given, and where it was first given.
    keys: BTreeMap<u64, String>,
}

impl Validator {
    fn err(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.errors.push(err(path, message));
    }

    fn warn(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.warnings.push(err(path, message));
    }

    fn known_keys(&mut self, obj: &Map<String, Value>, base: &str, allowed: &[&str]) {
        for key in obj.keys() {
            if !allowed.contains(&key.as_str()) {
                self.warn(
                    key_path(base, key),
                    format!("unknown field \"{key}\" is ignored"),
                );
            }
        }
    }

    fn long(&mut self, s: &str, path: &str, what: &str) {
        if s.graphemes(true).count() > MAX_TEXT {
            self.warn(
                path,
                format!("{what} is over {MAX_TEXT} characters: shorten it"),
            );
        }
    }

    /// A required string: non-empty, and warned of past [`MAX_TEXT`]
    /// graphemes.
    fn text(&mut self, value: &Value, path: &str, what: &str) -> Option<String> {
        match value {
            Value::String(s) if s.trim().is_empty() => {
                self.err(path, format!("{what} is a non-empty string"));
                None
            }
            Value::String(s) => {
                self.long(s, path, what);
                Some(s.clone())
            }
            _ => {
                self.err(path, format!("{what} is a string"));
                None
            }
        }
    }

    /// An optional string: one that is empty or no string is left out.
    fn opt_text(&mut self, obj: &Map<String, Value>, base: &str, key: &str) -> Option<String> {
        let path = key_path(base, key);
        match obj.get(key)? {
            Value::String(s) if !s.trim().is_empty() => {
                self.long(s, &path, key);
                Some(s.clone())
            }
            _ => {
                self.warn(
                    path,
                    format!("{key} is a non-empty string, so it is left out"),
                );
                None
            }
        }
    }

    fn req_text(&mut self, obj: &Map<String, Value>, base: &str, key: &str) -> Option<String> {
        match obj.get(key) {
            Some(v) => self.text(v, &key_path(base, key), key),
            None => {
                self.err(key_path(base, key), format!("{key} is required"));
                None
            }
        }
    }

    fn opt_bool(&mut self, obj: &Map<String, Value>, base: &str, key: &str) -> bool {
        match obj.get(key) {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => {
                self.warn(
                    key_path(base, key),
                    format!("{key} is true or false, so it is left out"),
                );
                false
            }
        }
    }

    fn tone(&mut self, obj: &Map<String, Value>, base: &str, key: &str) -> Option<Tone> {
        let value = obj.get(key)?;
        let tone = value.as_str().and_then(Tone::parse);
        if tone.is_none() {
            let accent = if value.as_str() == Some("accent") {
                "; the accent is the key discs' alone"
            } else {
                ""
            };
            self.warn(
                key_path(base, key),
                format!(
                    "{key} is one of {}{accent}, so it is left out",
                    TONE_NAMES.join(", ")
                ),
            );
        }
        tone
    }

    fn array<'v>(&mut self, value: &'v Value, path: &str, what: &str) -> Option<&'v Vec<Value>> {
        match value {
            Value::Array(items) if !items.is_empty() => Some(items),
            Value::Array(_) => {
                self.err(path, format!("{what} holds at least one entry"));
                None
            }
            _ => {
                self.err(path, format!("{what} is an array"));
                None
            }
        }
    }

    /// An optional list: absent, empty, or no list at all is the list
    /// left out, the last with a warning.
    fn opt_array<'v>(
        &mut self,
        obj: &'v Map<String, Value>,
        base: &str,
        key: &str,
    ) -> Option<&'v Vec<Value>> {
        match obj.get(key)? {
            Value::Array(items) if items.is_empty() => None,
            Value::Array(items) => Some(items),
            _ => {
                self.warn(
                    key_path(base, key),
                    format!("{key} is an array, so it is ignored"),
                );
                None
            }
        }
    }

    fn object<'v>(
        &mut self,
        value: &'v Value,
        path: &str,
        what: &str,
    ) -> Option<&'v Map<String, Value>> {
        let obj = value.as_object();
        if obj.is_none() {
            self.err(path, format!("{what} is an object"));
        }
        obj
    }

    /// A mark's key and its table row. `what` and `where` belong to a
    /// keyed mark, so either one without a key is ignored. A key that is
    /// no number in range, or whose number is already given, leaves its
    /// mark unkeyed: the number's first mark keeps it.
    fn key(&mut self, obj: &Map<String, Value>, base: &str) -> Option<Key> {
        let what = self.opt_text(obj, base, "what");
        let r#where = self.opt_text(obj, base, "where");
        let Some(value) = obj.get("key") else {
            for k in ["what", "where"] {
                if obj.contains_key(k) {
                    self.warn(
                        key_path(base, k),
                        format!(
                            "{k} belongs to a keyed mark, so it is ignored: give the mark a key"
                        ),
                    );
                }
            }
            return None;
        };
        let path = key_path(base, "key");
        let Some(n) = value.as_u64().filter(|n| (1..=MAX_KEY).contains(n)) else {
            self.warn(
                &path,
                format!("key is a whole number from 1 to {MAX_KEY}, so this mark is drawn unkeyed"),
            );
            return None;
        };
        if let Some(first) = self.keys.get(&n) {
            let first = first.clone();
            self.warn(
                &path,
                format!("key {n} is already given at {first}, so this mark is drawn unkeyed"),
            );
            return None;
        }
        self.keys.insert(n, path);
        Some(Key { n, what, r#where })
    }

    fn spec(&mut self, obj: &Map<String, Value>) -> Option<Spec> {
        if obj.get("tugdiagram").and_then(Value::as_u64) != Some(1) {
            self.err(
                "/tugdiagram",
                "a diagram spec starts with \"tugdiagram\": 1",
            );
        }
        let forms = FORM_NAMES.join(", ");
        let form = match obj.get("form") {
            Some(Value::String(f)) if FORM_NAMES.contains(&f.as_str()) => f.clone(),
            Some(Value::String(f)) => {
                self.err("/form", format!("unknown form \"{f}\": expected {forms}"));
                return None;
            }
            Some(_) => {
                self.err("/form", format!("form is a string: {forms}"));
                return None;
            }
            None => {
                self.err("/form", format!("form is required: {forms}"));
                return None;
            }
        };
        // Each form's own fields.
        let data_keys: &[&str] = match form.as_str() {
            "sequence" => &["actors", "messages"],
            "layers" => &["layers"],
            "stack" => &["columns", "above", "layers", "below", "across"],
            _ => &["columns", "edges"],
        };
        let allowed: Vec<&str> = COMMON.iter().chain(data_keys).copied().collect();
        self.known_keys(obj, "", &allowed);
        let title = self.req_text(obj, "", "title");
        let motion = match obj.get("motion") {
            None => true,
            Some(Value::String(s)) if s == "enter" => true,
            Some(Value::String(s)) if s == "none" => false,
            Some(_) => {
                self.warn("/motion", "motion is one of enter, none, so it is left out");
                true
            }
        };
        let form = match form.as_str() {
            "sequence" => self.sequence(obj).map(Form::Sequence),
            "layers" => self.layers(obj).map(Form::Layers),
            "stack" => self.stack(obj).map(Form::Stack),
            _ => self.flow(obj).map(Form::Flow),
        };
        Some(Spec {
            title: title?,
            motion,
            form: form?,
            warnings: Vec::new(),
        })
    }

    fn stack(&mut self, obj: &Map<String, Value>) -> Option<Stack> {
        let before = self.errors.len();
        let columns = match obj.get("columns") {
            None => {
                self.err(
                    "/columns",
                    "columns is required: how many grid columns the stack is ruled into",
                );
                None
            }
            Some(v) => {
                let n = v.as_u64().filter(|n| (1..=MAX_STACK_COLUMNS).contains(n));
                if n.is_none() {
                    self.err(
                        "/columns",
                        format!("columns is a whole number from 1 to {MAX_STACK_COLUMNS}"),
                    );
                }
                n
            }
        };
        // Without the grid no span can be checked; check what can be.
        let cols = columns.unwrap_or(MAX_STACK_COLUMNS);
        let above = self.blocks(obj, "above", cols);
        let below = self.blocks(obj, "below", cols);
        let layers = match obj.get("layers") {
            None => {
                self.err(
                    "/layers",
                    "layers is required: an array of layers, top to bottom",
                );
                Vec::new()
            }
            Some(value) => match self.array(value, "/layers", "layers") {
                None => Vec::new(),
                Some(items) => items
                    .iter()
                    .enumerate()
                    .filter_map(|(i, l)| self.stack_layer(l, &format!("/layers/{i}"), cols))
                    .collect(),
            },
        };
        let across = obj.get("across").and_then(|v| self.across(v));
        (self.errors.len() == before).then_some(Stack {
            columns: columns?,
            above,
            layers,
            below,
            across,
        })
    }

    /// A span of the grid: `[first, last]`, 1-based; absent, every column.
    fn span(&mut self, obj: &Map<String, Value>, base: &str, cols: u64) -> Span {
        let Some(value) = obj.get("span") else {
            return (1, cols);
        };
        let pair = value.as_array().and_then(|a| match a.as_slice() {
            [a, b] => Some((a.as_u64()?, b.as_u64()?)),
            _ => None,
        });
        match pair {
            Some((a, b)) if 1 <= a && a <= b && b <= cols => (a, b),
            _ => {
                self.warn(
                    key_path(base, "span"),
                    format!("span is [first, last], two columns from 1 to {cols}, first no later than last, so this one takes every column"),
                );
                (1, cols)
            }
        }
    }

    fn blocks(&mut self, obj: &Map<String, Value>, key: &str, cols: u64) -> Vec<StackBlock> {
        let Some(items) = self.opt_array(obj, "", key) else {
            return Vec::new();
        };
        let path = format!("/{key}");
        items
            .iter()
            .enumerate()
            .filter_map(|(i, b)| {
                let base = format!("{path}/{i}");
                let obj = self.object(b, &base, "a block")?;
                self.known_keys(obj, &base, &["name", "sub", "span"]);
                let name = self.req_text(obj, &base, "name");
                let sub = self.opt_text(obj, &base, "sub");
                let span = self.span(obj, &base, cols);
                Some(StackBlock {
                    name: name?,
                    sub,
                    span,
                })
            })
            .collect()
    }

    fn stack_layer(&mut self, value: &Value, base: &str, cols: u64) -> Option<StackLayer> {
        let obj = self.object(value, base, "a layer")?;
        self.known_keys(obj, base, &["name", "sub", "span", "rows"]);
        let name = self.req_text(obj, base, "name");
        let sub = self.opt_text(obj, base, "sub");
        let span = self.span(obj, base, cols);
        let rows = match obj.get("rows") {
            None => {
                self.err(
                    key_path(base, "rows"),
                    "rows is required: rows of cells, each an array",
                );
                None
            }
            Some(value) => {
                let path = key_path(base, "rows");
                self.array(value, &path, "rows").map(|rows| {
                    rows.iter()
                        .enumerate()
                        .map(|(r, row)| {
                            let rp = format!("{path}/{r}");
                            self.array(row, &rp, "a row")
                                .map(|cells| {
                                    cells
                                        .iter()
                                        .enumerate()
                                        .filter_map(|(k, c)| {
                                            self.stack_cell(c, &format!("{rp}/{k}"))
                                        })
                                        .collect()
                                })
                                .unwrap_or_default()
                        })
                        .collect()
                })
            }
        };
        Some(StackLayer {
            name: name?,
            sub,
            span,
            rows: rows?,
        })
    }

    fn stack_cell(&mut self, value: &Value, base: &str) -> Option<StackCell> {
        let obj = self.object(value, base, "a cell")?;
        self.known_keys(obj, base, &["name", "sub", "key", "what", "where"]);
        let name = self.req_text(obj, base, "name");
        let sub = self.opt_text(obj, base, "sub");
        let key = self.key(obj, base);
        Some(StackCell {
            name: name?,
            sub,
            key,
        })
    }

    fn across(&mut self, value: &Value) -> Option<Across> {
        let obj = self.object(value, "/across", "across")?;
        self.known_keys(obj, "/across", &["title", "names"]);
        let title = self.req_text(obj, "/across", "title");
        let names = match obj.get("names") {
            None => {
                self.err("/across/names", "names is required: one bar per name");
                None
            }
            Some(value) => self.array(value, "/across/names", "names").map(|names| {
                names
                    .iter()
                    .enumerate()
                    .filter_map(|(i, n)| self.text(n, &format!("/across/names/{i}"), "a name"))
                    .collect()
            }),
        };
        Some(Across {
            title: title?,
            names: names?,
        })
    }

    fn layers(&mut self, obj: &Map<String, Value>) -> Option<Layers> {
        let before = self.errors.len();
        let Some(layers) = obj.get("layers") else {
            self.err(
                "/layers",
                "layers is required: an array of layers, top to bottom",
            );
            return None;
        };
        let layers = self.array(layers, "/layers", "layers")?;
        let last = layers.len() - 1;
        let mut out = Vec::new();
        for (i, layer) in layers.iter().enumerate() {
            let base = format!("/layers/{i}");
            let Some(obj) = self.object(layer, &base, "a layer") else {
                continue;
            };
            self.known_keys(obj, &base, &["name", "sub", "cells", "below"]);
            let name = self.req_text(obj, &base, "name");
            let sub = self.opt_text(obj, &base, "sub");
            let below = self.opt_text(obj, &base, "below");
            let below = if below.is_some() && i == last {
                self.warn(
                    format!("{base}/below"),
                    "the last layer has nothing beneath it for anything to cross to, so this is left out",
                );
                None
            } else {
                below
            };
            let cells = match obj.get("cells") {
                None => {
                    self.err(
                        format!("{base}/cells"),
                        "cells is required: what the layer holds",
                    );
                    None
                }
                Some(value) => {
                    let path = format!("{base}/cells");
                    self.array(value, &path, "cells").map(|cells| {
                        cells
                            .iter()
                            .enumerate()
                            .filter_map(|(k, c)| self.cell(c, &format!("{path}/{k}")))
                            .collect::<Vec<_>>()
                    })
                }
            };
            if let (Some(name), Some(cells)) = (name, cells) {
                out.push(Layer {
                    name,
                    sub,
                    cells,
                    below,
                });
            }
        }
        (self.errors.len() == before).then_some(Layers { layers: out })
    }

    fn cell(&mut self, value: &Value, base: &str) -> Option<LayerCell> {
        let obj = self.object(value, base, "a cell")?;
        self.known_keys(obj, base, &["name", "sub", "mono", "key", "what", "where"]);
        let name = self.req_text(obj, base, "name");
        let sub = self.opt_text(obj, base, "sub");
        let mono = self.opt_bool(obj, base, "mono");
        let key = self.key(obj, base);
        Some(LayerCell {
            name: name?,
            sub,
            mono,
            key,
        })
    }

    fn sequence(&mut self, obj: &Map<String, Value>) -> Option<Sequence> {
        let before = self.errors.len();
        let Some(actors) = obj.get("actors") else {
            self.err(
                "/actors",
                "actors is required: an array of actors, left to right",
            );
            return None;
        };
        let actors = self.array(actors, "/actors", "actors")?;
        let mut out: Vec<Actor> = Vec::new();
        // Each id, and the index of its actor.
        let mut ids: BTreeMap<String, usize> = BTreeMap::new();
        for (i, actor) in actors.iter().enumerate() {
            let base = format!("/actors/{i}");
            let Some(obj) = self.object(actor, &base, "an actor") else {
                continue;
            };
            self.known_keys(obj, &base, &["id", "name", "sub"]);
            let id = self.req_text(obj, &base, "id");
            let name = self.req_text(obj, &base, "name");
            let sub = self.opt_text(obj, &base, "sub");
            let (Some(id), Some(name)) = (id, name) else {
                continue;
            };
            if let Some(&first) = ids.get(&id) {
                self.warn(
                    format!("{base}/id"),
                    format!("id \"{id}\" is already used at /actors/{first}, which is the actor a message naming it reaches"),
                );
            } else {
                ids.insert(id.clone(), out.len());
            }
            out.push(Actor { id, name, sub });
        }
        let Some(messages) = obj.get("messages") else {
            self.err(
                "/messages",
                "messages is required: an array of messages, in the order they happen",
            );
            return None;
        };
        let messages = self.array(messages, "/messages", "messages")?;
        let messages: Vec<Message> = messages
            .iter()
            .enumerate()
            .filter_map(|(i, m)| self.message(m, &format!("/messages/{i}"), &ids))
            .collect();
        if messages.is_empty() && self.errors.len() == before {
            self.err(
                "/messages",
                "no message names two actors that exist, so there is nothing to draw",
            );
        }
        (self.errors.len() == before).then_some(Sequence {
            actors: out,
            messages,
        })
    }

    fn message(
        &mut self,
        value: &Value,
        base: &str,
        ids: &BTreeMap<String, usize>,
    ) -> Option<Message> {
        let obj = self.object(value, base, "a message")?;
        self.known_keys(
            obj,
            base,
            &[
                "from", "to", "label", "tone", "reply", "key", "what", "where",
            ],
        );
        let end = |v: &mut Validator, key: &str| -> Option<usize> {
            let id = v.req_text(obj, base, key)?;
            let at = ids.get(&id).copied();
            if at.is_none() {
                v.warn(
                    key_path(base, key),
                    format!("no actor has the id \"{id}\", so this message is dropped"),
                );
            }
            at
        };
        let from = end(self, "from");
        let to = end(self, "to");
        let label = self.req_text(obj, base, "label");
        let tone = self.tone(obj, base, "tone");
        let reply = self.opt_bool(obj, base, "reply");
        let key = self.key(obj, base);
        Some(Message {
            from: from?,
            to: to?,
            label: label?,
            tone,
            reply,
            key,
        })
    }

    fn flow(&mut self, obj: &Map<String, Value>) -> Option<Flow> {
        let Some(columns) = obj.get("columns") else {
            self.err(
                "/columns",
                "columns is required: an array of columns, each an array of boxes",
            );
            return None;
        };
        let columns = self.array(columns, "/columns", "columns")?;
        let mut out: Vec<Vec<FlowNode>> = Vec::new();
        // Each id, and where it is.
        let mut ids: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        let before = self.errors.len();
        for (c, column) in columns.iter().enumerate() {
            let base = format!("/columns/{c}");
            let Some(nodes) = self.array(column, &base, "a column") else {
                out.push(Vec::new());
                continue;
            };
            let mut col = Vec::new();
            for (k, node) in nodes.iter().enumerate() {
                let base = format!("{base}/{k}");
                if let Some(node) = self.node(node, &base) {
                    if let Some(&(c0, k0)) = ids.get(&node.id) {
                        self.warn(
                            format!("{base}/id"),
                            format!(
                                "id \"{}\" is already used at /columns/{c0}/{k0}, which is the box an edge naming it reaches",
                                node.id
                            ),
                        );
                    } else {
                        ids.insert(node.id.clone(), (c, col.len()));
                    }
                    col.push(node);
                }
            }
            out.push(col);
        }
        let edges = match self.opt_array(obj, "", "edges") {
            None => Vec::new(),
            Some(items) => items
                .iter()
                .enumerate()
                .filter_map(|(i, e)| self.edge(e, &format!("/edges/{i}"), &ids, &out))
                .collect(),
        };
        (self.errors.len() == before).then_some(Flow {
            columns: out,
            edges,
        })
    }

    fn node(&mut self, value: &Value, base: &str) -> Option<FlowNode> {
        let obj = self.object(value, base, "a box")?;
        self.known_keys(obj, base, &["id", "name", "sub", "rows", "notes"]);
        let id = self.req_text(obj, base, "id");
        if let Some(id) = &id {
            if id.contains('.') || id.chars().any(char::is_whitespace) {
                self.warn(
                    format!("{base}/id"),
                    "an id has no dot and no space: an edge names a row as id.n, so no edge can reach this box",
                );
            }
        }
        let name = self.req_text(obj, base, "name");
        let sub = self.opt_text(obj, base, "sub");
        let rows: Vec<FlowRow> = match self.opt_array(obj, base, "rows") {
            None => Vec::new(),
            Some(rows) => rows
                .iter()
                .enumerate()
                .filter_map(|(i, r)| self.row(r, &format!("{base}/rows/{i}")))
                .collect(),
        };
        let notes: Vec<String> = match self.opt_array(obj, base, "notes") {
            None => Vec::new(),
            Some(notes) => notes
                .iter()
                .enumerate()
                .filter_map(|(i, n)| self.text(n, &format!("{base}/notes/{i}"), "a note"))
                .collect(),
        };
        Some(FlowNode {
            id: id?,
            name: name?,
            sub,
            rows,
            notes,
        })
    }

    fn row(&mut self, value: &Value, base: &str) -> Option<FlowRow> {
        let obj = self.object(value, base, "a row")?;
        self.known_keys(
            obj,
            base,
            &["name", "sub", "mono", "lit", "key", "what", "where"],
        );
        let name = self.req_text(obj, base, "name");
        let sub = self.opt_text(obj, base, "sub");
        let mono = self.opt_bool(obj, base, "mono");
        let lit = self.tone(obj, base, "lit");
        let key = self.key(obj, base);
        Some(FlowRow {
            name: name?,
            sub,
            mono,
            lit,
            key,
        })
    }

    fn edge(
        &mut self,
        value: &Value,
        base: &str,
        ids: &BTreeMap<String, (usize, usize)>,
        columns: &[Vec<FlowNode>],
    ) -> Option<FlowEdge> {
        let obj = self.object(value, base, "an edge")?;
        self.known_keys(obj, base, &["from", "to", "tone", "label", "dashed"]);
        let end = |v: &mut Validator, key: &str| -> Option<EndRef> {
            let path = key_path(base, key);
            let text = v.req_text(obj, base, key)?;
            let (id, row) = match text.split_once('.') {
                Some((id, n)) => (id, Some(n)),
                None => (text.as_str(), None),
            };
            let Some(&(col, node)) = ids.get(id) else {
                v.warn(
                    &path,
                    format!("no box has the id \"{id}\", so this edge is dropped"),
                );
                return None;
            };
            let row = match row {
                None => None,
                Some(n) => {
                    let rows = columns[col][node].rows.len();
                    match n.parse::<usize>().ok().filter(|n| (1..=rows).contains(n)) {
                        Some(n) => Some(n - 1),
                        None if rows == 0 => {
                            v.warn(
                                &path,
                                format!("box \"{id}\" has no rows, so this edge is dropped"),
                            );
                            return None;
                        }
                        None => {
                            v.warn(
                                &path,
                                format!(
                                    "box \"{id}\" has rows 1 to {rows}; \"{n}\" is not one, so this edge is dropped"
                                ),
                            );
                            return None;
                        }
                    }
                }
            };
            Some(EndRef { col, node, row })
        };
        let from = end(self, "from");
        let to = end(self, "to");
        let tone = self.tone(obj, base, "tone");
        let label = self.opt_text(obj, base, "label");
        let dashed = self.opt_bool(obj, base, "dashed");
        let (from, to) = (from?, to?);
        if from.col == to.col && from.node == to.node {
            self.warn(
                base,
                "an edge joins two different boxes, so this one is dropped",
            );
            return None;
        }
        Some(FlowEdge {
            from,
            to,
            tone,
            label,
            dashed,
        })
    }
}

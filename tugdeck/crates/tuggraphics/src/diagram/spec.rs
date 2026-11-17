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
pub const FORM_NAMES: [&str; 6] = ["flow", "sequence", "layers", "stack", "states", "tree"];
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
    /// What each tone the figure uses means, drawn as one line under it.
    pub legend: Vec<LegendItem>,
}

/// One entry of a flow's legend: a tone and what it means here.
#[derive(Clone, Debug, PartialEq)]
pub struct LegendItem {
    pub tone: Tone,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Form {
    Flow(Flow),
    Sequence(Sequence),
    Layers(Layers),
    Stack(Stack),
    States(States),
    Tree(Tree),
}

/// A span of a stack's grid columns, 1-based and inclusive.
pub type Span = (u64, u64);

/// One state a thing can be in: on the main line, or hanging beneath a
/// state on it.
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub id: String,
    pub name: String,
    pub sub: Option<String>,
    pub key: Option<Key>,
    /// An outcome: the state wears the tone's wash and outline.
    pub tone: Option<Tone>,
    /// A state the thing ends in: a second outline.
    pub end: bool,
    /// The main-line state this one hangs beneath, by index into the
    /// states; `None` stands it on the main line.
    pub under: Option<usize>,
}

/// What moves a thing from one state to another.
#[derive(Clone, Debug, PartialEq)]
pub struct Transition {
    /// The states it leaves and reaches, by index.
    pub from: usize,
    pub to: usize,
    pub label: Option<String>,
    pub tone: Option<Tone>,
    pub dashed: bool,
}

/// A lifecycle: the states a thing can be in and what moves it between
/// them, placed by rule rather than by a graph layout.
#[derive(Clone, Debug, PartialEq)]
pub struct States {
    /// The state it begins in, by index.
    pub start: usize,
    /// In the order given: the main line's states left to right.
    pub states: Vec<State>,
    pub transitions: Vec<Transition>,
}

/// How a transition is placed, by where its two ends stand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    /// To the next state on the main line: a straight arrow.
    Step,
    /// Between two other states on the main line: over the top, in a lane
    /// of its own.
    Over,
    /// From a main-line state down to the state beneath it.
    Drop,
    /// From a side state up to the state it hangs beneath.
    Rise,
    /// From a side state to another main-line state: along the bottom and
    /// up into the target's lower edge.
    Back,
}

impl States {
    /// The main line's states, left to right, by index.
    pub fn main(&self) -> Vec<usize> {
        (0..self.states.len())
            .filter(|&i| self.states[i].under.is_none())
            .collect()
    }

    /// How a transition between `from` and `to` is placed, or `None` where
    /// no rule places it.
    pub fn placed(&self, from: usize, to: usize) -> Option<Move> {
        let (a, b) = (&self.states[from], &self.states[to]);
        if from == to {
            return None;
        }
        match (a.under, b.under) {
            (None, None) => {
                let main = self.main();
                let at = |s| main.iter().position(|&m| m == s);
                (at(to)? == at(from)? + 1)
                    .then_some(Move::Step)
                    .or(Some(Move::Over))
            }
            (None, Some(u)) => (u == from).then_some(Move::Drop),
            (Some(u), None) => Some(if u == to { Move::Rise } else { Move::Back }),
            (Some(_), Some(_)) => None,
        }
    }

    /// How each transition is drawn. A step drawn already between the same
    /// two states would lie on the first, so a second goes over the top.
    pub fn moves(&self) -> Vec<Move> {
        let mut stepped: Vec<(usize, usize)> = Vec::new();
        self.transitions
            .iter()
            .map(|t| match self.placed(t.from, t.to) {
                Some(Move::Step) if stepped.contains(&(t.from, t.to)) => Move::Over,
                Some(Move::Step) => {
                    stepped.push((t.from, t.to));
                    Move::Step
                }
                Some(m) => m,
                // The validator drops what no rule places.
                None => Move::Over,
            })
            .collect()
    }
}

/// One part of a tree, and the parts inside it.
#[derive(Clone, Debug, PartialEq)]
pub struct TreeNode {
    pub name: String,
    pub sub: Option<String>,
    /// Set in the mono face: an identifier, a path, a key.
    pub mono: bool,
    pub key: Option<Key>,
    pub tone: Option<Tone>,
    pub children: Vec<TreeNode>,
}

impl TreeNode {
    /// This node and every node beneath it, parents first.
    pub fn walk(&self) -> Vec<&TreeNode> {
        let mut out = vec![self];
        for c in &self.children {
            out.extend(c.walk());
        }
        out
    }

    /// How many levels this node and those beneath it stand on.
    pub fn depth(&self) -> usize {
        1 + self.children.iter().map(TreeNode::depth).max().unwrap_or(0)
    }
}

/// What is inside what: one root and the parts it holds.
#[derive(Clone, Debug, PartialEq)]
pub struct Tree {
    pub root: TreeNode,
}

/// What lies outside the stack, above or beneath it.
#[derive(Clone, Debug, PartialEq)]
pub struct StackBlock {
    pub name: String,
    pub sub: Option<String>,
    pub span: Span,
    /// What the arrow between this block and the stack carries.
    pub link: Option<String>,
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
    /// What passes between this layer and the one beneath it.
    pub below: Option<String>,
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
    /// A layer outside the system the figure explains, drawn as an outside
    /// block is.
    pub outside: bool,
    pub cells: Vec<LayerCell>,
    /// What crosses the boundary to the layer beneath.
    pub below: Option<Crossing>,
}

/// What crosses the boundary between two layers.
#[derive(Clone, Debug, PartialEq)]
pub enum Crossing {
    /// One label for what crosses both ways: a two-headed arrow.
    Both(String),
    /// The channel between, and what goes down and comes up over it. At
    /// least one of the three is given.
    Ways {
        via: Option<String>,
        down: Option<String>,
        up: Option<String>,
    },
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
    /// Named runs of messages, in order and never overlapping.
    pub phases: Vec<Phase>,
}

/// A run of a sequence's messages with a name: drawn as a faint band
/// behind the run, its label and note in the left gutter.
#[derive(Clone, Debug, PartialEq)]
pub struct Phase {
    pub label: String,
    pub note: Option<String>,
    /// The first and last message of the run, by index into the messages
    /// drawn.
    pub from: usize,
    pub to: usize,
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
            Form::States(_) => "states",
            Form::Tree(_) => "tree",
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
            Form::States(states) => {
                for s in &states.states {
                    if let Some(k) = &s.key {
                        out.push(KeyedRow {
                            n: k.n,
                            name: s.name.clone(),
                            what: k.what.clone().unwrap_or_default(),
                            r#where: k.r#where.clone().unwrap_or_default(),
                        });
                    }
                }
            }
            Form::Tree(tree) => {
                for node in tree.root.walk() {
                    if let Some(k) = &node.key {
                        out.push(KeyedRow {
                            n: k.n,
                            name: node.name.clone(),
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
            "sequence" => &["actors", "messages", "phases"],
            "layers" => &["layers"],
            "stack" => &["columns", "above", "layers", "below", "across"],
            "flow" => &["columns", "edges", "legend"],
            "states" => &["start", "states", "transitions"],
            "tree" => &["root"],
            _ => &[],
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
            "flow" => self.flow(obj).map(Form::Flow),
            "states" => self.states(obj).map(Form::States),
            "tree" => self.tree(obj).map(Form::Tree),
            // A form the list names and this match does not is a form
            // half-added; refuse it by name rather than draw it as another.
            other => {
                self.err(
                    "/form",
                    format!("unknown form \"{other}\": expected {forms}"),
                );
                None
            }
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
                Some(items) => {
                    let last = items.len() - 1;
                    items
                        .iter()
                        .enumerate()
                        .filter_map(|(i, l)| {
                            self.stack_layer(l, &format!("/layers/{i}"), cols, i == last)
                        })
                        .collect()
                }
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
                self.known_keys(obj, &base, &["name", "sub", "span", "link"]);
                let name = self.req_text(obj, &base, "name");
                let sub = self.opt_text(obj, &base, "sub");
                let span = self.span(obj, &base, cols);
                let link = self.opt_text(obj, &base, "link");
                Some(StackBlock {
                    name: name?,
                    sub,
                    span,
                    link,
                })
            })
            .collect()
    }

    fn stack_layer(
        &mut self,
        value: &Value,
        base: &str,
        cols: u64,
        last: bool,
    ) -> Option<StackLayer> {
        let obj = self.object(value, base, "a layer")?;
        self.known_keys(obj, base, &["name", "sub", "span", "rows", "below"]);
        let name = self.req_text(obj, base, "name");
        let sub = self.opt_text(obj, base, "sub");
        let span = self.span(obj, base, cols);
        let below = self.opt_text(obj, base, "below");
        let below = if below.is_some() && last {
            self.warn(
                key_path(base, "below"),
                "the last layer has no layer beneath it for anything to pass to, so this is left out",
            );
            None
        } else {
            below
        };
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
            below,
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
            self.known_keys(obj, &base, &["name", "sub", "tone", "cells", "below"]);
            let name = self.req_text(obj, &base, "name");
            let sub = self.opt_text(obj, &base, "sub");
            let outside = match self.tone(obj, &base, "tone") {
                None => false,
                Some(Tone::Outside) => true,
                Some(_) => {
                    self.warn(
                        format!("{base}/tone"),
                        "a layer's tone is outside alone, so it is left out",
                    );
                    false
                }
            };
            let below = self.crossing(obj, &base);
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
                    outside,
                    cells,
                    below,
                });
            }
        }
        (self.errors.len() == before).then_some(Layers { layers: out })
    }

    /// What crosses below a layer: a string for one two-headed arrow, or
    /// an object naming the channel and what goes each way. An object
    /// naming none of the three, or anything else, is left out.
    fn crossing(&mut self, obj: &Map<String, Value>, base: &str) -> Option<Crossing> {
        let path = key_path(base, "below");
        match obj.get("below")? {
            Value::String(_) => self.opt_text(obj, base, "below").map(Crossing::Both),
            Value::Object(o) => {
                self.known_keys(o, &path, &["via", "down", "up"]);
                let via = self.opt_text(o, &path, "via");
                let down = self.opt_text(o, &path, "down");
                let up = self.opt_text(o, &path, "up");
                if via.is_none() && down.is_none() && up.is_none() {
                    self.warn(
                        path,
                        "below names at least one of via, down and up, so it is left out",
                    );
                    return None;
                }
                Some(Crossing::Ways { via, down, up })
            }
            _ => {
                self.warn(
                    path,
                    "below is a string or {\"via\", \"down\", \"up\"}, so it is left out",
                );
                None
            }
        }
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
        // Each message as written, and where it is among those drawn: a
        // phase counts the messages as written.
        let mut drawn: Vec<Option<usize>> = Vec::new();
        let mut kept: Vec<Message> = Vec::new();
        for (i, m) in messages.iter().enumerate() {
            match self.message(m, &format!("/messages/{i}"), &ids) {
                Some(m) => {
                    drawn.push(Some(kept.len()));
                    kept.push(m);
                }
                None => drawn.push(None),
            }
        }
        let messages = kept;
        if messages.is_empty() && self.errors.len() == before {
            self.err(
                "/messages",
                "no message names two actors that exist, so there is nothing to draw",
            );
        }
        let phases = match obj.get("phases") {
            Some(value) => self.phases(value, &drawn),
            None => Vec::new(),
        };
        (self.errors.len() == before).then_some(Sequence {
            actors: out,
            messages,
            phases,
        })
    }

    /// A sequence's phases. A phase that cannot be drawn is left out with a
    /// warning, and the figure is drawn without it: one whose range starts
    /// past the last message or ends before it starts, one that overlaps
    /// the phase before it, and one whose run holds no message drawn. A
    /// range that runs off the end is cut to the last message.
    fn phases(&mut self, value: &Value, drawn: &[Option<usize>]) -> Vec<Phase> {
        let Some(list) = value.as_array() else {
            self.warn(
                "/phases",
                "phases is an array of {\"label\", \"note\", \"from\", \"to\"}, so it is left out",
            );
            return Vec::new();
        };
        let mut out: Vec<Phase> = Vec::new();
        for (i, value) in list.iter().enumerate() {
            let base = format!("/phases/{i}");
            let Some(obj) = value.as_object() else {
                self.warn(&base, "a phase is an object, so it is left out");
                continue;
            };
            self.known_keys(obj, &base, &["label", "note", "from", "to"]);
            let Some(label) = self.opt_text(obj, &base, "label") else {
                self.warn(
                    key_path(&base, "label"),
                    "a phase needs a label, so it is left out",
                );
                continue;
            };
            let note = self.opt_text(obj, &base, "note");
            let index = |v: &mut Validator, key: &str| -> Option<usize> {
                let n = obj
                    .get(key)
                    .and_then(Value::as_u64)
                    .and_then(|n| usize::try_from(n).ok());
                if n.is_none() {
                    v.warn(
                        key_path(&base, key),
                        format!("{key} is a message's 0-based index, so this phase is left out"),
                    );
                }
                n
            };
            let (Some(from), Some(to)) = (index(self, "from"), index(self, "to")) else {
                continue;
            };
            let last = drawn.len().saturating_sub(1);
            if from > last {
                self.warn(
                    key_path(&base, "from"),
                    format!(
                        "there is no message {from}, the last is {last}, so this phase is left out"
                    ),
                );
                continue;
            }
            if to < from {
                self.warn(
                    key_path(&base, "to"),
                    format!("to is before from ({to} < {from}), so this phase is left out"),
                );
                continue;
            }
            let to = if to > last {
                self.warn(
                    key_path(&base, "to"),
                    format!("there is no message {to}, so this phase ends at the last, {last}"),
                );
                last
            } else {
                to
            };
            // The run among the messages drawn.
            let run: Vec<usize> = drawn[from..=to].iter().flatten().copied().collect();
            let (Some(&first), Some(&end)) = (run.first(), run.last()) else {
                self.warn(
                    &base,
                    "no message in this phase is drawn, so it is left out",
                );
                continue;
            };
            if out.last().is_some_and(|p| p.to >= first) {
                self.warn(
                    &base,
                    "this phase overlaps the one before it, so it is left out",
                );
                continue;
            }
            out.push(Phase {
                label,
                note,
                from: first,
                to: end,
            });
        }
        out
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

    fn tree(&mut self, obj: &Map<String, Value>) -> Option<Tree> {
        let before = self.errors.len();
        let Some(root) = obj.get("root") else {
            self.err(
                "/root",
                "root is required: the part that holds every other, its parts in children",
            );
            return None;
        };
        let root = self.tree_node(root, "/root");
        (self.errors.len() == before).then_some(Tree { root: root? })
    }

    fn tree_node(&mut self, value: &Value, base: &str) -> Option<TreeNode> {
        let obj = self.object(value, base, "a node")?;
        self.known_keys(
            obj,
            base,
            &[
                "name", "sub", "mono", "key", "what", "where", "tone", "children",
            ],
        );
        let name = self.req_text(obj, base, "name");
        let sub = self.opt_text(obj, base, "sub");
        let mono = self.opt_bool(obj, base, "mono");
        let key = self.key(obj, base);
        let tone = self.tone(obj, base, "tone");
        let mut children = Vec::new();
        for (i, child) in self
            .opt_array(obj, base, "children")
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(c) = self.tree_node(child, &format!("{base}/children/{i}")) {
                children.push(c);
            }
        }
        Some(TreeNode {
            name: name?,
            sub,
            mono,
            key,
            tone,
            children,
        })
    }

    /// A lifecycle. A state whose `under` names no state on the main line
    /// stands on the main line itself; a transition whose end names
    /// nothing, or that no rule places, is dropped; a `start` that names
    /// nothing starts at the first state on the main line.
    fn states(&mut self, obj: &Map<String, Value>) -> Option<States> {
        let before = self.errors.len();
        let Some(list) = obj.get("states") else {
            self.err(
                "/states",
                "states is required: an array of states, the main line left to right",
            );
            return None;
        };
        let list = self.array(list, "/states", "states")?;
        let mut out: Vec<State> = Vec::new();
        // Each state's `under` as written, and where it was written.
        let mut written: Vec<Option<(String, String)>> = Vec::new();
        // Each id, and the index of its state.
        let mut ids: BTreeMap<String, usize> = BTreeMap::new();
        for (i, value) in list.iter().enumerate() {
            let base = format!("/states/{i}");
            let Some(obj) = self.object(value, &base, "a state") else {
                continue;
            };
            self.known_keys(
                obj,
                &base,
                &[
                    "id", "name", "sub", "key", "what", "where", "tone", "end", "under",
                ],
            );
            let id = self.req_text(obj, &base, "id");
            let name = self.req_text(obj, &base, "name");
            let sub = self.opt_text(obj, &base, "sub");
            let tone = self.tone(obj, &base, "tone");
            let end = self.opt_bool(obj, &base, "end");
            let under = self.opt_text(obj, &base, "under");
            let key = self.key(obj, &base);
            let (Some(id), Some(name)) = (id, name) else {
                continue;
            };
            if let Some(&first) = ids.get(&id) {
                self.warn(
                    format!("{base}/id"),
                    format!("id \"{id}\" is already used at /states/{first}, which is the state a transition naming it reaches"),
                );
            } else {
                ids.insert(id.clone(), out.len());
            }
            written.push(under.map(|u| (u, key_path(&base, "under"))));
            out.push(State {
                id,
                name,
                sub,
                key,
                tone,
                end,
                under: None,
            });
        }
        // A side state hangs one deep, beneath a state on the main line.
        // A state whose own `under` names no other state stands there.
        let hangs: Vec<bool> = (0..out.len())
            .map(|i| {
                written[i]
                    .as_ref()
                    .and_then(|(u, _)| ids.get(u))
                    .is_some_and(|&t| t != i)
            })
            .collect();
        for i in 0..out.len() {
            let Some((u, path)) = &written[i] else {
                continue;
            };
            let target = ids.get(u).copied();
            match target {
                None => self.warn(
                    path,
                    format!("no state has the id \"{u}\", so this state stands on the main line"),
                ),
                Some(t) if t == i => self.warn(
                    path,
                    "a state cannot hang beneath itself, so it stands on the main line",
                ),
                Some(t) if hangs[t] => self.warn(
                    path,
                    format!("\"{u}\" hangs beneath another state, and a side state hangs beneath one on the main line, so this state stands on the main line"),
                ),
                Some(t) => out[i].under = Some(t),
            }
        }
        if self.errors.len() != before {
            return None;
        }
        let first = (0..out.len()).find(|&i| out[i].under.is_none())?;
        let start = match obj.get("start") {
            None => first,
            Some(Value::String(s)) => ids.get(s).copied().unwrap_or_else(|| {
                self.warn(
                    "/start",
                    format!("no state has the id \"{s}\", so it starts at the first state on the main line"),
                );
                first
            }),
            Some(_) => {
                self.warn(
                    "/start",
                    "start is a state's id, so it starts at the first state on the main line",
                );
                first
            }
        };
        let mut states = States {
            start,
            states: out,
            transitions: Vec::new(),
        };
        for (k, value) in self
            .opt_array(obj, "", "transitions")
            .into_iter()
            .flatten()
            .enumerate()
        {
            let base = format!("/transitions/{k}");
            if let Some(t) = self.transition(value, &base, &ids, &states) {
                states.transitions.push(t);
            }
        }
        (self.errors.len() == before).then_some(states)
    }

    fn transition(
        &mut self,
        value: &Value,
        base: &str,
        ids: &BTreeMap<String, usize>,
        states: &States,
    ) -> Option<Transition> {
        let obj = self.object(value, base, "a transition")?;
        self.known_keys(obj, base, &["from", "to", "label", "tone", "dashed"]);
        let end = |v: &mut Validator, key: &str| -> Option<usize> {
            let id = v.req_text(obj, base, key)?;
            let at = ids.get(&id).copied();
            if at.is_none() {
                v.warn(
                    key_path(base, key),
                    format!("no state has the id \"{id}\", so this transition is dropped"),
                );
            }
            at
        };
        let from = end(self, "from");
        let to = end(self, "to");
        let label = self.opt_text(obj, base, "label");
        let tone = self.tone(obj, base, "tone");
        let dashed = self.opt_bool(obj, base, "dashed");
        let (from, to) = (from?, to?);
        if states.placed(from, to).is_none() {
            let why = if from == to {
                "a transition from a state to itself is not drawn"
            } else if states.states[from].under.is_some() {
                "a side state's transitions go to the main line"
            } else {
                "a side state is reached only from the state it hangs beneath"
            };
            self.warn(base, format!("{why}, so this transition is dropped"));
            return None;
        }
        Some(Transition {
            from,
            to,
            label,
            tone,
            dashed,
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
        let legend = match self.opt_array(obj, "", "legend") {
            None => Vec::new(),
            Some(items) => self.legend(items, &out, &edges),
        };
        (self.errors.len() == before).then_some(Flow {
            columns: out,
            edges,
            legend,
        })
    }

    /// A flow's legend. An entry is left out with a warning when it has no
    /// tone or no text, or names a tone no edge or row in the figure wears,
    /// since it would explain a colour the reader cannot find.
    fn legend(
        &mut self,
        items: &[Value],
        columns: &[Vec<FlowNode>],
        edges: &[FlowEdge],
    ) -> Vec<LegendItem> {
        let used: Vec<Tone> = edges
            .iter()
            .filter_map(|e| e.tone)
            .chain(
                columns
                    .iter()
                    .flatten()
                    .flat_map(|n| &n.rows)
                    .filter_map(|r| r.lit),
            )
            .collect();
        let mut out: Vec<LegendItem> = Vec::new();
        for (i, value) in items.iter().enumerate() {
            let base = format!("/legend/{i}");
            let Some(obj) = value.as_object() else {
                self.warn(
                    &base,
                    "a legend entry is {\"tone\", \"text\"}, so it is left out",
                );
                continue;
            };
            self.known_keys(obj, &base, &["tone", "text"]);
            let tone = self.tone(obj, &base, "tone");
            let text = self.opt_text(obj, &base, "text");
            let (Some(tone), Some(text)) = (tone, text) else {
                if !obj.contains_key("tone") || !obj.contains_key("text") {
                    self.warn(
                        &base,
                        "a legend entry needs a tone and a text, so it is left out",
                    );
                }
                continue;
            };
            let name = TONE_NAMES[tone as usize];
            if !used.contains(&tone) {
                self.warn(
                    key_path(&base, "tone"),
                    format!("no edge or row in this figure is {name}, so this entry is left out"),
                );
                continue;
            }
            if out.iter().any(|l| l.tone == tone) {
                self.warn(
                    key_path(&base, "tone"),
                    format!("{name} is already in the legend, so this entry is left out"),
                );
                continue;
            }
            out.push(LegendItem { tone, text });
        }
        out
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

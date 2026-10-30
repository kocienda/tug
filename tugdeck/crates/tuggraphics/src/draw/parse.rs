//! The layer 0 parser and validator. It reports every error it finds, each
//! with the index of the op that caused it, and keeps going after one so a
//! program with three faults says all three.

use serde_json::{Map, Value};

use super::*;
use crate::num::cos_sin_deg;

type Opts = Map<String, Value>;

/// Parses and validates a program from JSON text.
pub fn parse_program(source: &str) -> Result<Program, Vec<DrawError>> {
    match serde_json::from_str::<Value>(source) {
        Ok(v) => parse_value(&v),
        Err(e) => Err(vec![DrawError {
            op: None,
            message: format!("not JSON: {e}"),
        }]),
    }
}

/// Parses and validates a program already read as JSON.
pub fn parse_value(value: &Value) -> Result<Program, Vec<DrawError>> {
    let mut p = Parser::default();
    let Some(obj) = value.as_object() else {
        p.err(None, "a tugdraw program is a JSON object");
        return Err(p.errors);
    };
    for key in obj.keys() {
        if !matches!(key.as_str(), "tugdraw" | "frame" | "ops") {
            p.err(None, format!("unknown key \"{}\"", clip_str(key)));
        }
    }
    match obj.get("tugdraw") {
        Some(v) if v.as_u64() == Some(1) => {}
        Some(_) => p.err(None, "\"tugdraw\" must be 1"),
        None => p.err(None, "missing \"tugdraw\": 1"),
    }
    let frame = p.frame(obj.get("frame"));
    match obj.get("ops") {
        Some(Value::Array(ops)) => {
            if ops.len() > MAX_OPS {
                p.err(None, format!("a program holds at most {MAX_OPS} ops; this one holds {}", ops.len()));
            }
            for (i, op) in ops.iter().enumerate() {
                p.op(i, op);
            }
            p.finish();
        }
        Some(_) => p.err(None, "\"ops\" must be an array"),
        None => p.err(None, "missing \"ops\""),
    }
    match (frame, p.errors.is_empty()) {
        (Some(frame), true) => Ok(Program { frame, items: p.items }),
        _ => Err(p.errors),
    }
}

/// A string shortened for an error message.
fn clip_str(s: &str) -> String {
    let mut out: String = s.chars().take(40).collect();
    if s.chars().count() > 40 {
        out.push('…');
    }
    out
}

#[derive(Clone)]
struct PaintState {
    width: f64,
    dash: Vec<f64>,
    opacity: f64,
}

impl Default for PaintState {
    fn default() -> Self {
        PaintState {
            width: 1.0,
            dash: Vec::new(),
            opacity: 1.0,
        }
    }
}

#[derive(Default)]
struct PathState {
    segs: Vec<Seg>,
    /// The current point, if a subpath is open.
    cursor: Option<(f64, f64)>,
    /// The open subpath's first point, where `close` returns.
    start: Option<(f64, f64)>,
    /// The op that first added to the unpainted path.
    since: Option<usize>,
}

impl PathState {
    fn push(&mut self, i: usize, seg: Seg) {
        if self.since.is_none() {
            self.since = Some(i);
        }
        match seg {
            Seg::Move(x, y) => {
                self.cursor = Some((x, y));
                self.start = Some((x, y));
            }
            Seg::Line(x, y) | Seg::Arc { x, y, .. } => self.cursor = Some((x, y)),
            Seg::Curve(c) => self.cursor = Some((c[4], c[5])),
            Seg::Close => self.cursor = self.start,
        }
        self.segs.push(seg);
    }

    fn take(&mut self) -> Vec<Seg> {
        let segs = std::mem::take(&mut self.segs);
        *self = PathState::default();
        segs
    }
}

struct Turtle {
    pos: (f64, f64),
    heading: f64,
    down: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Target {
    Fill,
    Stroke,
    Text,
    Group,
}

#[derive(Default)]
struct Parser {
    errors: Vec<DrawError>,
    items: Vec<Item>,
    state: PaintState,
    stack: Vec<(usize, PaintState)>,
    path: PathState,
    turtle: Option<Turtle>,
}

impl Parser {
    fn err(&mut self, op: Option<usize>, message: impl Into<String>) {
        self.errors.push(DrawError {
            op,
            message: message.into(),
        });
    }

    fn frame(&mut self, v: Option<&Value>) -> Option<(f64, f64)> {
        let Some(v) = v else {
            self.err(None, "missing \"frame\": [width, height]");
            return None;
        };
        let pair = v.as_array().filter(|a| a.len() == 2);
        let Some(pair) = pair else {
            self.err(None, "\"frame\" is [width, height]");
            return None;
        };
        let mut out = [0.0; 2];
        let mut ok = true;
        for (k, n) in pair.iter().enumerate() {
            match n.as_f64() {
                Some(n) if n.is_finite() && (1.0..=MAX_FRAME).contains(&n) => out[k] = n,
                _ => {
                    self.err(None, format!("\"frame\" sides are numbers from 1 to {MAX_FRAME}"));
                    ok = false;
                }
            }
        }
        ok.then_some((out[0], out[1]))
    }

    /// A number operand or option value, finite and within the magnitude bound.
    fn num(&mut self, i: usize, verb: &str, what: &str, v: &Value) -> Option<f64> {
        match v.as_f64() {
            Some(n) if !n.is_finite() => {
                self.err(Some(i), format!("{verb} {what} is not a finite number"));
                None
            }
            Some(n) if n.abs() > MAX_MAGNITUDE => {
                self.err(Some(i), format!("{verb} {what} is out of range: magnitude above 1000000"));
                None
            }
            Some(n) => Some(n),
            None => {
                self.err(Some(i), format!("{verb} {what} must be a number"));
                None
            }
        }
    }

    /// Exactly `N` number operands.
    fn nums<const N: usize>(&mut self, i: usize, verb: &str, args: &[Value], names: [&str; N]) -> Option<[f64; N]> {
        if args.len() != N {
            let want = if N == 0 { "no operands".to_string() } else { names.join(" ") };
            self.err(Some(i), format!("{verb} takes {want}; it has {} operand(s)", args.len()));
            return None;
        }
        let mut out = [0.0; N];
        let mut ok = true;
        for k in 0..N {
            match self.num(i, verb, names[k], &args[k]) {
                Some(n) => out[k] = n,
                None => ok = false,
            }
        }
        ok.then_some(out)
    }

    /// Reports every option key outside `allowed`.
    fn check_opts(&mut self, i: usize, verb: &str, opts: Option<&Opts>, allowed: &[&str]) {
        let Some(opts) = opts else { return };
        for key in opts.keys() {
            if !allowed.contains(&key.as_str()) {
                self.err(Some(i), format!("unknown option \"{}\" on {verb}", clip_str(key)));
            }
        }
    }

    fn string(&mut self, i: usize, verb: &str, what: &str, v: &Value) -> Option<String> {
        let Some(s) = v.as_str() else {
            self.err(Some(i), format!("{verb} {what} must be a string"));
            return None;
        };
        if s.chars().count() > MAX_STRING {
            self.err(Some(i), format!("{verb} {what} is longer than {MAX_STRING} characters"));
            return None;
        }
        if s.chars().any(char::is_control) {
            self.err(Some(i), format!("{verb} {what} holds a control character"));
            return None;
        }
        Some(s.to_string())
    }

    fn colour(&mut self, i: usize, verb: &str, v: &Value) -> Option<ColourRole> {
        let s = self.string(i, verb, "role", v)?;
        let role = ColourRole::parse(&s);
        if role.is_none() {
            self.err(
                Some(i),
                format!("unknown colour role \"{}\"; a colour is a role (ink, grid, series-1, …), never a value", clip_str(&s)),
            );
        }
        role
    }

    fn word<'v>(&mut self, i: usize, verb: &str, key: &str, v: &'v Value, words: &[&str]) -> Option<&'v str> {
        match v.as_str() {
            Some(s) if words.contains(&s) => Some(s),
            _ => {
                self.err(Some(i), format!("{verb} {key} is one of {}", words.join(", ")));
                None
            }
        }
    }

    fn motion(&mut self, i: usize, verb: &str, opts: Option<&Opts>, target: Target) -> Option<Motion> {
        let opts = opts?;
        let (enter, from, delay) = (opts.get("enter"), opts.get("from"), opts.get("delay"));
        let Some(enter) = enter else {
            if from.is_some() {
                self.err(Some(i), format!("{verb} has \"from\" with no enter; it applies to enter \"grow\""));
            }
            if delay.is_some() {
                self.err(Some(i), format!("{verb} has \"delay\" with no enter"));
            }
            return None;
        };
        let delay = match delay {
            None => 0,
            Some(v) => match v.as_u64() {
                Some(d) if d <= MAX_DELAY => d as u8,
                _ => {
                    self.err(Some(i), format!("{verb} delay is a stagger index, an integer from 0 to {MAX_DELAY}"));
                    0
                }
            },
        };
        let kind = self.word(i, verb, "enter", enter, &["draw", "grow", "fade", "rise"])?;
        if kind != "grow" && from.is_some() {
            self.err(Some(i), format!("{verb} \"from\" applies only to enter \"grow\""));
        }
        let enter = match kind {
            "draw" => {
                if target != Target::Stroke {
                    self.err(Some(i), format!("enter \"draw\" applies only to stroke, not {verb}"));
                    return None;
                }
                Enter::Draw
            }
            "grow" => {
                let edge = match from {
                    None => Edge::Bottom,
                    Some(v) => match self.word(i, verb, "from", v, &["bottom", "top", "left", "right"])? {
                        "top" => Edge::Top,
                        "left" => Edge::Left,
                        "right" => Edge::Right,
                        _ => Edge::Bottom,
                    },
                };
                Enter::Grow(edge)
            }
            "fade" => Enter::Fade,
            _ => Enter::Rise,
        };
        Some(Motion { enter, delay })
    }

    fn op(&mut self, i: usize, v: &Value) {
        let Some(arr) = v.as_array() else {
            self.err(Some(i), "an op is an array: [verb, operands…, {options}]");
            return;
        };
        let Some(verb) = arr.first().and_then(Value::as_str) else {
            self.err(Some(i), "an op starts with its verb");
            return;
        };
        let rest = &arr[1..];
        let (args, opts) = match rest.last() {
            Some(Value::Object(m)) => (&rest[..rest.len() - 1], Some(m)),
            _ => (rest, None),
        };
        match verb {
            "move" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some([x, y]) = self.nums(i, verb, args, ["x", "y"]) {
                    self.path.push(i, Seg::Move(x, y));
                }
            }
            "line" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some([x, y]) = self.nums(i, verb, args, ["x", "y"]) {
                    if self.needs_point(i, verb) {
                        self.path.push(i, Seg::Line(x, y));
                    }
                }
            }
            "curve" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some(c) = self.nums(i, verb, args, ["x1", "y1", "x2", "y2", "x", "y"]) {
                    if self.needs_point(i, verb) {
                        self.path.push(i, Seg::Curve(c));
                    }
                }
            }
            "arc" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some([cx, cy, r, a0, a1]) = self.nums(i, verb, args, ["cx", "cy", "r", "a0", "a1"]) {
                    if r < 0.0 {
                        self.err(Some(i), "arc r must not be negative");
                    } else {
                        self.arc(i, cx, cy, r, a0, a1);
                    }
                }
            }
            "close" => {
                self.check_opts(i, verb, opts, &[]);
                if self.nums(i, verb, args, []).is_some() && self.needs_point(i, verb) {
                    self.path.push(i, Seg::Close);
                }
            }
            "rect" => {
                self.check_opts(i, verb, opts, &["r"]);
                let r = opts.and_then(|o| o.get("r")).map(|v| self.num(i, verb, "r", v));
                if let Some([x, y, w, h]) = self.nums(i, verb, args, ["x", "y", "w", "h"]) {
                    if w < 0.0 || h < 0.0 {
                        self.err(Some(i), "rect w and h must not be negative");
                    } else {
                        match r {
                            Some(None) => {}
                            Some(Some(r)) if r < 0.0 => self.err(Some(i), "rect r must not be negative"),
                            r => self.rect(i, x, y, w, h, r.flatten().unwrap_or(0.0)),
                        }
                    }
                }
            }
            "circle" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some([cx, cy, r]) = self.nums(i, verb, args, ["cx", "cy", "r"]) {
                    if r < 0.0 {
                        self.err(Some(i), "circle r must not be negative");
                    } else {
                        self.path.push(i, Seg::Move(cx + r, cy));
                        self.path.push(i, Seg::Arc { r, sweep: true, x: cx - r, y: cy });
                        self.path.push(i, Seg::Arc { r, sweep: true, x: cx + r, y: cy });
                        self.path.push(i, Seg::Close);
                    }
                }
            }
            "polyline" => {
                self.check_opts(i, verb, opts, &[]);
                self.polyline(i, args);
            }
            "fill" | "stroke" => self.paint(i, verb, args, opts),
            "width" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some([w]) = self.nums(i, verb, args, ["w"]) {
                    if w > 0.0 && w <= MAX_WIDTH {
                        self.state.width = w;
                    } else {
                        self.err(Some(i), format!("width is above 0 and at most {MAX_WIDTH}"));
                    }
                }
            }
            "dash" => {
                self.check_opts(i, verb, opts, &[]);
                self.dash(i, args);
            }
            "opacity" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some([o]) = self.nums(i, verb, args, ["o"]) {
                    if (0.0..=1.0).contains(&o) {
                        self.state.opacity = o;
                    } else {
                        self.err(Some(i), "opacity is from 0 to 1");
                    }
                }
            }
            "text" => self.text(i, args, opts),
            "group" => {
                self.check_opts(i, verb, opts, &["translate", "scale", "rotate", "clip", "enter", "from", "delay"]);
                if self.nums(i, verb, args, []).is_some() {
                    self.unpainted();
                    let g = self.group(i, opts);
                    self.stack.push((i, self.state.clone()));
                    self.items.push(Item::Group(g));
                }
            }
            "end" => {
                self.check_opts(i, verb, opts, &[]);
                if self.nums(i, verb, args, []).is_some() {
                    self.unpainted();
                    match self.stack.pop() {
                        Some((_, saved)) => {
                            self.state = saved;
                            self.items.push(Item::End);
                        }
                        None => self.err(Some(i), "end with no open group"),
                    }
                }
            }
            "pen" => self.pen(i, args, opts),
            "forward" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some([d]) = self.nums(i, verb, args, ["d"]) {
                    self.forward(i, d);
                }
            }
            "turn" => {
                self.check_opts(i, verb, opts, &[]);
                if let Some([deg]) = self.nums(i, verb, args, ["deg"]) {
                    match self.turtle.as_mut() {
                        Some(t) => t.heading += deg,
                        None => self.err(Some(i), "turn with no turtle; place one with pen"),
                    }
                }
            }
            other => self.err(Some(i), format!("unknown verb \"{}\"", clip_str(other))),
        }
    }

    /// Whether a subpath is open, reporting when it is not.
    fn needs_point(&mut self, i: usize, verb: &str) -> bool {
        if self.path.cursor.is_some() {
            return true;
        }
        self.err(Some(i), format!("{verb} with no current point; start the subpath with move"));
        false
    }

    fn arc(&mut self, i: usize, cx: f64, cy: f64, r: f64, a0: f64, a1: f64) {
        let at = |deg: f64| {
            let (c, s) = cos_sin_deg(deg);
            (cx + r * c, cy + r * s)
        };
        let begin = at(a0);
        match self.path.cursor {
            Some(p) if p == begin => {}
            Some(_) => self.path.push(i, Seg::Line(begin.0, begin.1)),
            None => self.path.push(i, Seg::Move(begin.0, begin.1)),
        }
        let sweep = a1 - a0;
        if r == 0.0 || sweep == 0.0 {
            return;
        }
        // SVG cannot draw a whole circle in one arc command, and a piece of
        // at most 180° never needs the large-arc flag.
        let pieces = (sweep.abs() / 180.0).ceil().max(1.0) as usize;
        for k in 1..=pieces {
            let (x, y) = at(a0 + sweep * k as f64 / pieces as f64);
            self.path.push(i, Seg::Arc { r, sweep: sweep > 0.0, x, y });
        }
    }

    fn rect(&mut self, i: usize, x: f64, y: f64, w: f64, h: f64, r: f64) {
        let r = r.min(w / 2.0).min(h / 2.0);
        let p = &mut self.path;
        if r == 0.0 {
            p.push(i, Seg::Move(x, y));
            p.push(i, Seg::Line(x + w, y));
            p.push(i, Seg::Line(x + w, y + h));
            p.push(i, Seg::Line(x, y + h));
        } else {
            let arc = |x, y| Seg::Arc { r, sweep: true, x, y };
            p.push(i, Seg::Move(x + r, y));
            p.push(i, Seg::Line(x + w - r, y));
            p.push(i, arc(x + w, y + r));
            p.push(i, Seg::Line(x + w, y + h - r));
            p.push(i, arc(x + w - r, y + h));
            p.push(i, Seg::Line(x + r, y + h));
            p.push(i, arc(x, y + h - r));
            p.push(i, Seg::Line(x, y + r));
            p.push(i, arc(x + r, y));
        }
        p.push(i, Seg::Close);
    }

    fn polyline(&mut self, i: usize, args: &[Value]) {
        let points = match args {
            [Value::Array(points)] if points.len() >= 2 => points,
            _ => {
                self.err(Some(i), "polyline takes one operand, a list of at least two [x, y] points");
                return;
            }
        };
        let mut out = Vec::with_capacity(points.len());
        for pt in points {
            match pt.as_array().map(Vec::as_slice) {
                Some([x, y]) => {
                    let (x, y) = (self.num(i, "polyline", "x", x), self.num(i, "polyline", "y", y));
                    if let (Some(x), Some(y)) = (x, y) {
                        out.push((x, y));
                    }
                }
                _ => {
                    self.err(Some(i), "polyline points are [x, y] pairs");
                    return;
                }
            }
        }
        if out.len() == points.len() {
            for (k, (x, y)) in out.into_iter().enumerate() {
                self.path.push(i, if k == 0 { Seg::Move(x, y) } else { Seg::Line(x, y) });
            }
        }
    }

    fn dash(&mut self, i: usize, args: &[Value]) {
        let items = match args {
            [Value::Array(items)] if items.len() <= 16 => items,
            _ => {
                self.err(Some(i), "dash takes one operand, a list of at most 16 lengths ([] clears it)");
                return;
            }
        };
        let mut out = Vec::with_capacity(items.len());
        for v in items {
            match self.num(i, "dash", "length", v) {
                Some(n) if n >= 0.0 => out.push(n),
                Some(_) => {
                    self.err(Some(i), "dash lengths must not be negative");
                    return;
                }
                None => return,
            }
        }
        if !out.is_empty() && out.iter().all(|&n| n == 0.0) {
            self.err(Some(i), "dash lengths must not all be zero");
            return;
        }
        self.state.dash = out;
    }

    fn paint(&mut self, i: usize, verb: &str, args: &[Value], opts: Option<&Opts>) {
        let stroke = verb == "stroke";
        if stroke {
            self.check_opts(i, verb, opts, &["enter", "from", "delay", "cap", "join"]);
        } else {
            self.check_opts(i, verb, opts, &["enter", "from", "delay"]);
        }
        let role = match args {
            [role] => self.colour(i, verb, role),
            _ => {
                self.err(Some(i), format!("{verb} takes one operand, a colour role"));
                None
            }
        };
        let motion = self.motion(i, verb, opts, if stroke { Target::Stroke } else { Target::Fill });
        let kind = if stroke {
            let cap = opts.and_then(|o| o.get("cap")).and_then(|v| {
                self.word(i, verb, "cap", v, &["butt", "round", "square"]).map(|w| match w {
                    "butt" => Cap::Butt,
                    "round" => Cap::Round,
                    _ => Cap::Square,
                })
            });
            let join = opts.and_then(|o| o.get("join")).and_then(|v| {
                self.word(i, verb, "join", v, &["miter", "round", "bevel"]).map(|w| match w {
                    "miter" => Join::Miter,
                    "round" => Join::Round,
                    _ => Join::Bevel,
                })
            });
            if matches!(motion, Some(Motion { enter: Enter::Draw, .. })) && !self.state.dash.is_empty() {
                self.err(Some(i), "enter \"draw\" cannot play on a dashed stroke; clear the dash with [\"dash\", []]");
            }
            PaintKind::Stroke { cap, join }
        } else {
            PaintKind::Fill
        };
        if self.path.segs.is_empty() {
            self.err(Some(i), format!("nothing to {verb}: the path is empty"));
            return;
        }
        let path = self.path.take();
        if let Some(role) = role {
            self.items.push(Item::Paint(PaintOp {
                kind,
                role,
                path,
                width: self.state.width,
                dash: self.state.dash.clone(),
                opacity: self.state.opacity,
                motion,
            }));
        }
    }

    fn text(&mut self, i: usize, args: &[Value], opts: Option<&Opts>) {
        let verb = "text";
        self.check_opts(i, verb, opts, &["role", "fill", "anchor", "baseline", "enter", "from", "delay"]);
        let (pos, text) = match args {
            [x, y, s] => {
                let (x, y) = (self.num(i, verb, "x", x), self.num(i, verb, "y", y));
                (x.zip(y), self.string(i, verb, "string", s))
            }
            _ => {
                self.err(Some(i), format!("text takes x y string; it has {} operand(s)", args.len()));
                return;
            }
        };
        let get = |k: &str| opts.and_then(|o| o.get(k));
        let role = match get("role") {
            None => Some(TypeRole::Label),
            Some(v) => {
                let r = v.as_str().and_then(TypeRole::parse);
                if r.is_none() {
                    self.err(Some(i), "text role is one of title, label, value, mono; a font is a role, never a value");
                }
                r
            }
        };
        let fill = match get("fill") {
            None => Some(ColourRole::Ink),
            Some(v) => self.colour(i, verb, v),
        };
        let anchor = match get("anchor") {
            None => Some(Anchor::Start),
            Some(v) => self.word(i, verb, "anchor", v, &["start", "middle", "end"]).map(|w| match w {
                "start" => Anchor::Start,
                "middle" => Anchor::Middle,
                _ => Anchor::End,
            }),
        };
        let baseline = match get("baseline") {
            None => Some(Baseline::Alphabetic),
            Some(v) => self
                .word(i, verb, "baseline", v, &["top", "middle", "alphabetic", "bottom"])
                .map(|w| match w {
                    "top" => Baseline::Top,
                    "middle" => Baseline::Middle,
                    "alphabetic" => Baseline::Alphabetic,
                    _ => Baseline::Bottom,
                }),
        };
        let motion = self.motion(i, verb, opts, Target::Text);
        if let (Some((x, y)), Some(text), Some(role), Some(fill), Some(anchor), Some(baseline)) =
            (pos, text, role, fill, anchor, baseline)
        {
            self.items.push(Item::Text(TextOp {
                x,
                y,
                text,
                role,
                fill,
                anchor,
                baseline,
                opacity: self.state.opacity,
                motion,
            }));
        }
    }

    fn group(&mut self, i: usize, opts: Option<&Opts>) -> GroupOp {
        let verb = "group";
        let mut g = GroupOp {
            motion: self.motion(i, verb, opts, Target::Group),
            ..GroupOp::default()
        };
        let Some(opts) = opts else { return g };
        if let Some(v) = opts.get("translate") {
            match v.as_array().map(Vec::as_slice) {
                Some([x, y]) => {
                    let (x, y) = (self.num(i, verb, "translate x", x), self.num(i, verb, "translate y", y));
                    g.translate = x.zip(y);
                }
                _ => self.err(Some(i), "group translate is [x, y]"),
            }
        }
        if let Some(v) = opts.get("rotate") {
            g.rotate = self.num(i, verb, "rotate", v);
        }
        if let Some(v) = opts.get("scale") {
            let scale = match v {
                Value::Array(a) if a.len() == 2 => {
                    let (x, y) = (self.num(i, verb, "scale x", &a[0]), self.num(i, verb, "scale y", &a[1]));
                    x.zip(y)
                }
                Value::Number(_) => self.num(i, verb, "scale", v).map(|s| (s, s)),
                _ => {
                    self.err(Some(i), "group scale is a number or [sx, sy]");
                    None
                }
            };
            if let Some((sx, sy)) = scale {
                if sx == 0.0 || sy == 0.0 {
                    self.err(Some(i), "group scale must not be zero");
                } else {
                    g.scale = Some((sx, sy));
                }
            }
        }
        if let Some(v) = opts.get("clip") {
            match v.as_array().map(Vec::as_slice) {
                Some([x, y, w, h]) => {
                    let c = [
                        self.num(i, verb, "clip x", x),
                        self.num(i, verb, "clip y", y),
                        self.num(i, verb, "clip w", w),
                        self.num(i, verb, "clip h", h),
                    ];
                    if let [Some(x), Some(y), Some(w), Some(h)] = c {
                        if w < 0.0 || h < 0.0 {
                            self.err(Some(i), "group clip w and h must not be negative");
                        } else {
                            g.clip = Some([x, y, w, h]);
                        }
                    }
                }
                _ => self.err(Some(i), "group clip is [x, y, w, h]"),
            }
        }
        g
    }

    fn pen(&mut self, i: usize, args: &[Value], opts: Option<&Opts>) {
        let verb = "pen";
        if args.is_empty() {
            self.check_opts(i, verb, opts, &["up"]);
            let up = match opts.and_then(|o| o.get("up")) {
                Some(Value::Bool(b)) => *b,
                _ => {
                    self.err(Some(i), "pen takes x y heading, or {\"up\": true|false} alone");
                    return;
                }
            };
            match self.turtle.as_mut() {
                Some(t) => t.down = !up,
                None => self.err(Some(i), "pen up/down with no turtle; place one with pen x y heading"),
            }
            return;
        }
        self.check_opts(i, verb, opts, &[]);
        if let Some([x, y, heading]) = self.nums(i, verb, args, ["x", "y", "heading"]) {
            self.turtle = Some(Turtle {
                pos: (x, y),
                heading,
                down: true,
            });
            self.path.push(i, Seg::Move(x, y));
        }
    }

    fn forward(&mut self, i: usize, d: f64) {
        let Some(t) = self.turtle.as_mut() else {
            self.err(Some(i), "forward with no turtle; place one with pen");
            return;
        };
        let (c, s) = cos_sin_deg(t.heading);
        let from = t.pos;
        let to = (from.0 + d * c, from.1 + d * s);
        t.pos = to;
        if t.down {
            if self.path.cursor != Some(from) {
                self.path.push(i, Seg::Move(from.0, from.1));
            }
            self.path.push(i, Seg::Line(to.0, to.1));
        }
    }

    /// Reports and drops a path left unpainted at a group boundary or the
    /// program's end.
    fn unpainted(&mut self) {
        if !self.path.segs.is_empty() {
            let since = self.path.since;
            self.err(
                since,
                "the path started here is never painted; paint it with fill or stroke before group, end or the end of the program",
            );
            self.path.take();
        }
    }

    fn finish(&mut self) {
        self.unpainted();
        for (open, _) in std::mem::take(&mut self.stack) {
            self.err(Some(open), "group is never closed with end");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn errors(ops: &str) -> Vec<DrawError> {
        let src = format!("{{\"tugdraw\": 1, \"frame\": [100, 100], \"ops\": [{ops}]}}");
        parse_program(&src).expect_err("expected errors")
    }

    fn one(ops: &str) -> DrawError {
        let errs = errors(ops);
        assert_eq!(errs.len(), 1, "{errs:?}");
        errs.into_iter().next().unwrap()
    }

    #[test]
    fn unknown_verb() {
        let e = one(r#"["move", 0, 0], ["fill", "ink"], ["paint", 1]"#);
        assert_eq!(e.op, Some(2));
        assert_eq!(e.message, "unknown verb \"paint\"");
    }

    #[test]
    fn literal_colour_is_refused() {
        let e = one(r##"["rect", 0, 0, 10, 10], ["fill", "#ff0000"]"##);
        assert_eq!(e.op, Some(1));
        assert_eq!(
            e.message,
            "unknown colour role \"#ff0000\"; a colour is a role (ink, grid, series-1, …), never a value"
        );
    }

    #[test]
    fn out_of_range_number() {
        let e = one(r#"["move", 0, 0], ["line", 1, -1e7], ["stroke", "ink"]"#);
        assert_eq!(e.op, Some(1));
        assert_eq!(e.message, "line y is out of range: magnitude above 1000000");
    }

    #[test]
    fn non_finite_number_is_refused_by_the_reader() {
        // JSON has no spelling for a non-finite number; one that overflows
        // f64 is refused as the program is read.
        let errs = parse_program(r#"{"tugdraw": 1, "frame": [10, 10], "ops": [["move", 1e999, 0]]}"#).unwrap_err();
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].op, None);
        assert!(errs[0].message.starts_with("not JSON: number out of range"), "{}", errs[0].message);
    }

    #[test]
    fn frame_bounds() {
        for frame in ["[0, 10]", "[10, 5000]"] {
            let src = format!("{{\"tugdraw\": 1, \"frame\": {frame}, \"ops\": []}}");
            let errs = parse_program(&src).unwrap_err();
            assert_eq!(errs.len(), 1, "{errs:?}");
            assert_eq!(errs[0].op, None);
            assert_eq!(errs[0].message, "\"frame\" sides are numbers from 1 to 4096");
        }
    }

    #[test]
    fn too_many_ops() {
        let ops = vec![r#"["opacity", 1]"#; MAX_OPS + 1].join(",");
        let errs = errors(&ops);
        assert_eq!(errs.len(), 1, "{errs:?}");
        assert_eq!(errs[0].op, None);
        assert_eq!(errs[0].message, "a program holds at most 20000 ops; this one holds 20001");
        let ok = format!("{{\"tugdraw\": 1, \"frame\": [1, 1], \"ops\": [{}]}}", vec![r#"["opacity", 1]"#; MAX_OPS].join(","));
        assert!(parse_program(&ok).is_ok());
    }

    #[test]
    fn unclosed_group() {
        let e = one(r#"["group", {"translate": [1, 2]}], ["rect", 0, 0, 1, 1], ["fill", "ink"]"#);
        assert_eq!(e.op, Some(0));
        assert_eq!(e.message, "group is never closed with end");
    }

    #[test]
    fn end_with_no_group() {
        let e = one(r#"["end"]"#);
        assert_eq!(e.op, Some(0));
        assert_eq!(e.message, "end with no open group");
    }

    #[test]
    fn unpainted_path() {
        let e = one(r#"["rect", 0, 0, 1, 1], ["fill", "ink"], ["move", 0, 0], ["line", 5, 5]"#);
        assert_eq!(e.op, Some(2));
        assert!(e.message.starts_with("the path started here is never painted"));
        let at_group = one(r#"["move", 0, 0], ["line", 5, 5], ["group"], ["end"]"#);
        assert_eq!(at_group.op, Some(0));
    }

    #[test]
    fn draw_on_a_dashed_stroke() {
        let e = one(r#"["dash", [4, 2]], ["move", 0, 0], ["line", 9, 9], ["stroke", "grid", {"enter": "draw"}]"#);
        assert_eq!(e.op, Some(3));
        assert_eq!(e.message, "enter \"draw\" cannot play on a dashed stroke; clear the dash with [\"dash\", []]");
        let cleared = r#"{"tugdraw": 1, "frame": [10, 10], "ops": [["dash", [4, 2]], ["dash", []], ["move", 0, 0], ["line", 9, 9], ["stroke", "grid", {"enter": "draw"}]]}"#;
        assert!(parse_program(cleared).is_ok());
    }

    #[test]
    fn draw_is_for_strokes() {
        let e = one(r#"["rect", 0, 0, 1, 1], ["fill", "ink", {"enter": "draw"}]"#);
        assert_eq!(e.op, Some(1));
        assert_eq!(e.message, "enter \"draw\" applies only to stroke, not fill");
    }

    #[test]
    fn three_errors_are_all_reported() {
        let errs = errors(r#"["line", 1, 1], ["width", 100], ["rect", 0, 0, 1, 1], ["fill", "red"], ["fill", "ink"]"#);
        let got: Vec<_> = errs.iter().map(|e| e.op).collect();
        assert_eq!(got, vec![Some(0), Some(1), Some(3), Some(4)], "{errs:?}");
        assert_eq!(errs[0].message, "line with no current point; start the subpath with move");
        assert_eq!(errs[1].message, "width is above 0 and at most 64");
    }

    #[test]
    fn delay_bounds_and_needs_an_enter() {
        let e = one(r#"["rect", 0, 0, 1, 1], ["fill", "ink", {"enter": "fade", "delay": 65}]"#);
        assert_eq!(e.message, "fill delay is a stagger index, an integer from 0 to 64");
        let e = one(r#"["rect", 0, 0, 1, 1], ["fill", "ink", {"delay": 2}]"#);
        assert_eq!(e.message, "fill has \"delay\" with no enter");
    }

    #[test]
    fn unknown_option_and_bad_role() {
        let e = one(r#"["text", 1, 1, "x", {"font": "Helvetica"}]"#);
        assert_eq!(e.message, "unknown option \"font\" on text");
        let e = one(r#"["text", 1, 1, "x", {"role": "Helvetica"}]"#);
        assert_eq!(e.message, "text role is one of title, label, value, mono; a font is a role, never a value");
    }

    #[test]
    fn text_strings_are_bounded() {
        let long = "x".repeat(201);
        let e = one(&format!(r#"["text", 1, 1, "{long}"]"#));
        assert_eq!(e.message, "text string is longer than 200 characters");
    }

    #[test]
    fn turtle_square_closes_exactly() {
        let src = r#"{"tugdraw": 1, "frame": [100, 100], "ops": [["pen", 10, 10, 0],
            ["forward", 50], ["turn", 90], ["forward", 50], ["turn", 90],
            ["forward", 50], ["turn", 90], ["forward", 50], ["stroke", "ink"]]}"#;
        let p = parse_program(src).unwrap();
        let Item::Paint(paint) = &p.items[0] else { panic!() };
        assert_eq!(paint.path.last(), Some(&Seg::Line(10.0, 10.0)));
        assert_eq!(paint.path.len(), 5);
    }
}

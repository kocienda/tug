//! Layer 0: the drawing language.
//!
//! A program is `{"tugdraw": 1, "frame": [W, H], "ops": [...]}`. Each op is
//! an array — verb first, positional operands next, an optional options
//! object last. The coordinate system is y-down with the origin at top-left.
//! Path ops accumulate a current path; `fill` and `stroke` paint it and
//! clear it, as in PostScript, so the renderer is one pass with no retained
//! path tree. Colour is a role ([`ColourRole`]) and type is a role
//! ([`TypeRole`]); there is no literal colour, font, raster, filter or
//! gradient.

mod parse;
mod svg;

use serde::Serialize;

pub use crate::measure::TypeRole;
pub use parse::{parse_program, parse_value};
pub use svg::{render_svg, Palette, RenderOpts};

/// At most this many ops in a program.
pub const MAX_OPS: usize = 20_000;
/// The largest frame side, in px.
pub const MAX_FRAME: f64 = 4096.0;
/// The largest magnitude any number may carry.
pub const MAX_MAGNITUDE: f64 = 1e6;
/// The longest string, in characters.
pub const MAX_STRING: usize = 200;
/// The largest stagger index.
pub const MAX_DELAY: u64 = 64;
/// The widest stroke.
pub const MAX_WIDTH: f64 = 64.0;
/// How many categorical series roles the themes carry.
pub const SERIES_COUNT: u8 = 8;

/// A colour role. The deck resolves each to a theme token through a class;
/// a standalone render resolves each through a [`Palette`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColourRole {
    Ink,
    InkMuted,
    Grid,
    Surface,
    Accent,
    Good,
    Bad,
    /// `series-1` … `series-N`, 1-based.
    Series(u8),
}

impl ColourRole {
    pub fn parse(s: &str) -> Option<ColourRole> {
        match s {
            "ink" => Some(ColourRole::Ink),
            "ink-muted" => Some(ColourRole::InkMuted),
            "grid" => Some(ColourRole::Grid),
            "surface" => Some(ColourRole::Surface),
            "accent" => Some(ColourRole::Accent),
            "good" => Some(ColourRole::Good),
            "bad" => Some(ColourRole::Bad),
            _ => {
                let k: u8 = s.strip_prefix("series-")?.parse().ok()?;
                // `parse` accepts "+3" and "03"; only the canonical spelling is a role.
                ((1..=SERIES_COUNT).contains(&k) && s == format!("series-{k}")).then_some(ColourRole::Series(k))
            }
        }
    }

    pub fn name(self) -> String {
        match self {
            ColourRole::Ink => "ink".into(),
            ColourRole::InkMuted => "ink-muted".into(),
            ColourRole::Grid => "grid".into(),
            ColourRole::Surface => "surface".into(),
            ColourRole::Accent => "accent".into(),
            ColourRole::Good => "good".into(),
            ColourRole::Bad => "bad".into(),
            ColourRole::Series(k) => format!("series-{k}"),
        }
    }

    /// Every role, in List L01 order.
    pub fn all() -> Vec<ColourRole> {
        let mut v = vec![
            ColourRole::Ink,
            ColourRole::InkMuted,
            ColourRole::Grid,
            ColourRole::Surface,
            ColourRole::Accent,
            ColourRole::Good,
            ColourRole::Bad,
        ];
        v.extend((1..=SERIES_COUNT).map(ColourRole::Series));
        v
    }
}

/// The edge a `grow` entrance grows from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Bottom,
    Top,
    Left,
    Right,
}

impl Edge {
    pub fn name(self) -> &'static str {
        match self {
            Edge::Bottom => "bottom",
            Edge::Top => "top",
            Edge::Left => "left",
            Edge::Right => "right",
        }
    }
}

/// An entrance. The deck plays it through CSS keyframes over the motion
/// tokens; nothing in the SVG animates by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Enter {
    /// Strokes only: the line draws itself along its length.
    Draw,
    Grow(Edge),
    Fade,
    Rise,
}

/// An entrance with its stagger index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Motion {
    pub enter: Enter,
    pub delay: u8,
}

/// One segment of a resolved path. Turtle ops, rects, circles, polylines
/// and arcs are all resolved to these at parse time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Move(f64, f64),
    Line(f64, f64),
    Curve([f64; 6]),
    /// A circular arc of at most 180°, ending at `(x, y)`; `sweep` is
    /// clockwise.
    Arc { r: f64, sweep: bool, x: f64, y: f64 },
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Join {
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaintKind {
    Fill,
    Stroke { cap: Option<Cap>, join: Option<Join> },
}

/// A painted path, carrying the paint state in force when it was painted.
#[derive(Clone, Debug, PartialEq)]
pub struct PaintOp {
    pub kind: PaintKind,
    pub role: ColourRole,
    pub path: Vec<Seg>,
    pub width: f64,
    pub dash: Vec<f64>,
    pub opacity: f64,
    pub motion: Option<Motion>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anchor {
    Start,
    Middle,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Baseline {
    /// `y` is the top of the font's bounding box.
    Top,
    /// `y` is the middle of the em box.
    Middle,
    Alphabetic,
    /// `y` is the bottom of the font's bounding box.
    Bottom,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextOp {
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub role: TypeRole,
    pub fill: ColourRole,
    pub anchor: Anchor,
    pub baseline: Baseline,
    pub opacity: f64,
    pub motion: Option<Motion>,
}

/// A group's transform and clip. The clip rect is in the group's own
/// coordinates, after its transform.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct GroupOp {
    pub translate: Option<(f64, f64)>,
    pub rotate: Option<f64>,
    pub scale: Option<(f64, f64)>,
    pub clip: Option<[f64; 4]>,
    pub motion: Option<Motion>,
}

/// One item of a validated program, in paint order.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Paint(PaintOp),
    Text(TextOp),
    Group(GroupOp),
    End,
}

/// A validated layer 0 program.
#[derive(Clone, Debug, PartialEq)]
pub struct Program {
    pub frame: (f64, f64),
    pub items: Vec<Item>,
}

/// A validation error: the index of the op that caused it, or `None` for
/// the program as a whole.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DrawError {
    pub op: Option<usize>,
    pub message: String,
}

/// Parses and renders in one call: the SVG, or every validation error.
pub fn render_program(source: &str, opts: &RenderOpts) -> Result<String, Vec<DrawError>> {
    parse_program(source).map(|p| render_svg(&p, opts))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_roles_round_trip() {
        for role in ColourRole::all() {
            assert_eq!(ColourRole::parse(&role.name()), Some(role));
        }
        for bad in ["series-0", "series-9", "series-03", "series-+3", "#ff0000", "red"] {
            assert_eq!(ColourRole::parse(bad), None, "{bad}");
        }
    }
}

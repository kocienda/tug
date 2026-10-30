//! The SVG renderer.
//!
//! Deck mode writes colour roles as classes — `tgf-<role>` for fill,
//! `tgs-<role>` for stroke — and type roles as `tgt-<role>`, which the
//! deck's stylesheet resolves to theme tokens, so a theme switch restyles
//! a chart on screen without a re-render and the output carries no colour
//! value and no `<style>`. Standalone mode adds one `<style>` resolving
//! the same classes through a [`Palette`]. Entrances become `tge-<kind>`
//! classes and a `--tg-i` stagger index; the SVG never animates itself.

use std::collections::BTreeMap;
use std::fmt::Write;

use super::*;
use crate::num::fmt_num;

/// A resolved palette for a standalone render: colour role name → CSS
/// colour, and type role name → CSS `font` shorthand.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Palette {
    pub colours: BTreeMap<String, String>,
    pub fonts: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug)]
pub struct RenderOpts<'a> {
    /// Prefixes every id the SVG defines, so two charts on one page cannot
    /// collide. Anything but ASCII letters, digits, `-` and `_` is dropped.
    pub id_prefix: &'a str,
    /// `Some` for a standalone file: one `<style>` resolves the classes.
    pub standalone: Option<&'a Palette>,
}

/// Renders a validated program.
pub fn render_svg(p: &Program, opts: &RenderOpts) -> String {
    let mut prefix: String = opts
        .id_prefix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if prefix.is_empty() {
        prefix = "tg".into();
    }
    let mut body = String::new();
    let mut defs = String::new();
    let mut clips = 0usize;
    for item in &p.items {
        match item {
            Item::Paint(paint) => write_paint(&mut body, paint),
            Item::Text(text) => write_text(&mut body, text),
            Item::Group(g) => {
                body.push_str("<g");
                let mut transform = Vec::new();
                if let Some((x, y)) = g.translate {
                    transform.push(format!("translate({} {})", fmt_num(x), fmt_num(y)));
                }
                if let Some(deg) = g.rotate {
                    transform.push(format!("rotate({})", fmt_num(deg)));
                }
                if let Some((sx, sy)) = g.scale {
                    transform.push(format!("scale({} {})", fmt_num(sx), fmt_num(sy)));
                }
                if !transform.is_empty() {
                    let _ = write!(body, " transform=\"{}\"", transform.join(" "));
                }
                if let Some([x, y, w, h]) = g.clip {
                    let id = format!("{prefix}-c{clips}");
                    clips += 1;
                    let _ = writeln!(
                        defs,
                        "<clipPath id=\"{id}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></clipPath>",
                        fmt_num(x),
                        fmt_num(y),
                        fmt_num(w),
                        fmt_num(h)
                    );
                    let _ = write!(body, " clip-path=\"url(#{id})\"");
                }
                write_motion(&mut body, &[], g.motion);
                body.push_str(">\n");
            }
            Item::End => body.push_str("</g>\n"),
            // A file has nothing to show on hover, and no stylesheet.
            Item::Hit(hit) if opts.standalone.is_none() => write_hit(&mut body, hit),
            Item::Hit(_) => {}
        }
    }

    let (w, h) = (fmt_num(p.frame.0), fmt_num(p.frame.1));
    let mut out = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" class=\"tugx-chart-svg\" viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\" aria-hidden=\"true\">\n"
    );
    if let Some(palette) = opts.standalone {
        out.push_str(&standalone_style(palette));
    }
    if !defs.is_empty() {
        out.push_str("<defs>\n");
        out.push_str(&defs);
        out.push_str("</defs>\n");
    }
    out.push_str(&body);
    out.push_str("</svg>");
    out
}

fn path_d(segs: &[Seg]) -> String {
    let mut parts = Vec::with_capacity(segs.len());
    for seg in segs {
        parts.push(match *seg {
            Seg::Move(x, y) => format!("M{} {}", fmt_num(x), fmt_num(y)),
            Seg::Line(x, y) => format!("L{} {}", fmt_num(x), fmt_num(y)),
            Seg::Curve(c) => format!(
                "C{}",
                c.iter().map(|&n| fmt_num(n)).collect::<Vec<_>>().join(" ")
            ),
            Seg::Arc { r, sweep, x, y } => {
                let r = fmt_num(r);
                format!(
                    "A{r} {r} 0 0 {} {} {}",
                    u8::from(sweep),
                    fmt_num(x),
                    fmt_num(y)
                )
            }
            Seg::Close => "Z".into(),
        });
    }
    parts.join(" ")
}

/// Writes ` class="…"` from the given classes plus the entrance's, and the
/// stagger index when there is an entrance.
fn write_motion(out: &mut String, classes: &[String], motion: Option<Motion>) {
    let mut all: Vec<String> = classes.to_vec();
    if let Some(m) = motion {
        match m.enter {
            Enter::Draw => all.push("tge-draw".into()),
            Enter::Grow(edge) => {
                all.push("tge-grow".into());
                all.push(format!("tge-from-{}", edge.name()));
            }
            Enter::Fade => all.push("tge-fade".into()),
            Enter::Rise => all.push("tge-rise".into()),
        }
    }
    if !all.is_empty() {
        let _ = write!(out, " class=\"{}\"", all.join(" "));
    }
    if let Some(m) = motion {
        let _ = write!(out, " style=\"--tg-i:{}\"", m.delay);
    }
}

fn write_paint(out: &mut String, p: &PaintOp) {
    let _ = write!(out, "<path d=\"{}\"", path_d(&p.path));
    match p.kind {
        PaintKind::Fill => write_motion(out, &[format!("tgf-{}", p.role.name())], p.motion),
        PaintKind::Stroke { cap, join } => {
            write_motion(out, &[format!("tgs-{}", p.role.name())], p.motion);
            let _ = write!(out, " fill=\"none\" stroke-width=\"{}\"", fmt_num(p.width));
            if !p.dash.is_empty() {
                let dash: Vec<_> = p.dash.iter().map(|&n| fmt_num(n)).collect();
                let _ = write!(out, " stroke-dasharray=\"{}\"", dash.join(" "));
            }
            if let Some(cap) = cap {
                let cap = match cap {
                    Cap::Butt => "butt",
                    Cap::Round => "round",
                    Cap::Square => "square",
                };
                let _ = write!(out, " stroke-linecap=\"{cap}\"");
            }
            if let Some(join) = join {
                let join = match join {
                    Join::Miter => "miter",
                    Join::Round => "round",
                    Join::Bevel => "bevel",
                };
                let _ = write!(out, " stroke-linejoin=\"{join}\"");
            }
            if matches!(
                p.motion,
                Some(Motion {
                    enter: Enter::Draw,
                    ..
                })
            ) {
                out.push_str(" pathLength=\"1\"");
            }
        }
    }
    if p.opacity != 1.0 {
        let _ = write!(out, " opacity=\"{}\"", fmt_num(p.opacity));
    }
    out.push_str("/>\n");
}

/// A region the pointer reaches whatever it paints, written without a colour
/// so it stays invisible with no stylesheet at all, and the hidden crosshair
/// after it, which is the region's next sibling for the deck's rule.
fn write_hit(out: &mut String, hit: &HitOp) {
    let _ = write!(
        out,
        "<path class=\"tgh\" d=\"{}\" fill=\"none\" pointer-events=\"all\" data-row=\"{}\"",
        path_d(&hit.path),
        hit.row
    );
    if let Some(col) = hit.col {
        let _ = write!(out, " data-col=\"{col}\"");
    }
    out.push_str("/>\n");
    if !hit.cross.is_empty() {
        let _ = writeln!(
            out,
            "<path class=\"tgh-cross tgs-ink-muted\" d=\"{}\" fill=\"none\" stroke-width=\"1\" visibility=\"hidden\" pointer-events=\"none\"/>",
            path_d(&hit.cross)
        );
    }
}

fn write_text(out: &mut String, t: &TextOp) {
    let _ = write!(out, "<text x=\"{}\" y=\"{}\"", fmt_num(t.x), fmt_num(t.y));
    write_motion(
        out,
        &[
            format!("tgt-{}", t.role.name()),
            format!("tgf-{}", t.fill.name()),
        ],
        t.motion,
    );
    let anchor = match t.anchor {
        Anchor::Start => "start",
        Anchor::Middle => "middle",
        Anchor::End => "end",
    };
    // The font's bounding box, the same box the measurers report ascent
    // and descent against.
    let baseline = match t.baseline {
        Baseline::Top => "text-before-edge",
        Baseline::Middle => "central",
        Baseline::Alphabetic => "alphabetic",
        Baseline::Bottom => "text-after-edge",
    };
    let _ = write!(
        out,
        " text-anchor=\"{anchor}\" dominant-baseline=\"{baseline}\""
    );
    if t.opacity != 1.0 {
        let _ = write!(out, " opacity=\"{}\"", fmt_num(t.opacity));
    }
    let _ = writeln!(out, ">{}</text>", escape(&t.text));
}

fn standalone_style(p: &Palette) -> String {
    let mut css = String::new();
    for (role, colour) in &p.colours {
        let _ = write!(
            css,
            ".tgf-{role}{{fill:{colour}}}.tgs-{role}{{stroke:{colour}}}"
        );
    }
    for (role, font) in &p.fonts {
        let _ = write!(css, ".tgt-{role}{{font:{font}}}");
    }
    format!("<style>{}</style>\n", escape(&css))
}

/// Escapes text for element content and attribute values.
pub(crate) fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const DECK: RenderOpts = RenderOpts {
        id_prefix: "t",
        standalone: None,
    };

    #[test]
    fn text_is_escaped_and_deck_output_has_no_style_or_script() {
        let src =
            r#"{"tugdraw": 1, "frame": [100, 20], "ops": [["text", 1, 15, "</text><script>&\""]]}"#;
        let svg = render_program(src, &DECK).unwrap();
        assert!(
            svg.contains(">&lt;/text&gt;&lt;script&gt;&amp;&quot;</text>"),
            "{svg}"
        );
        assert!(!svg.contains("<script"));
        assert!(!svg.contains("<style"));
    }

    #[test]
    fn standalone_carries_one_style() {
        let mut palette = Palette::default();
        palette.colours.insert("ink".into(), "#111".into());
        palette
            .fonts
            .insert("label".into(), "400 12px \"IBM Plex Sans\"".into());
        let src =
            r#"{"tugdraw": 1, "frame": [10, 10], "ops": [["rect", 0, 0, 5, 5], ["fill", "ink"]]}"#;
        let svg = render_program(
            src,
            &RenderOpts {
                id_prefix: "s",
                standalone: Some(&palette),
            },
        )
        .unwrap();
        assert_eq!(svg.matches("<style>").count(), 1);
        assert!(svg.contains("<style>.tgf-ink{fill:#111}.tgs-ink{stroke:#111}.tgt-label{font:400 12px &quot;IBM Plex Sans&quot;}</style>"));
    }

    #[test]
    fn id_prefix_is_sanitized() {
        let src = r#"{"tugdraw": 1, "frame": [10, 10], "ops": [["group", {"clip": [0, 0, 5, 5]}], ["end"]]}"#;
        let svg = render_program(
            src,
            &RenderOpts {
                id_prefix: "a\"b<c",
                standalone: None,
            },
        )
        .unwrap();
        assert!(svg.contains("id=\"abc-c0\""), "{svg}");
    }
}

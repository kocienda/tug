#!/usr/bin/env python3
"""build.py — draws Tug's key-symbol glyphs to match IBM Plex.

IBM Plex Sans and Plex Mono carry no glyphs for the Mac modifier and key
symbols (⌘ ⌥ ⌃ ⇧ ⎋ ⌫ ⌦ ⇥ ⇪ ⏎), and the arrows they do carry are thin. This
script draws all fourteen as filled outlines at Plex's cap height and stroke
weights, once per weight and family, and writes:

  svg/<family>-<weight>/<name>.svg   one outline per glyph, font units,
                                     viewBox "0 -760 <advance> 820"
  specimen.html                      the glyphs set beside Plex Sans and
                                     Plex Mono at several sizes

Every glyph is a centerline stroked by skia at the weight's stroke, then
flat-cut and unioned, so the three weights are one drawing. Geometry is in
font units: 1000/em, cap height 698, baseline 0, y up.

Rebuild:  python3 resources/glyphs/build.py   (needs skia-python, fonttools,
brotli — see README.md). The proof PNGs land in /tmp and are for the eye.
"""

import math
import os
import sys

import skia

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.normpath(os.path.join(HERE, "..", "..", "tugdeck", "public", "fonts"))

UPM = 1000
H = 698            # Plex cap height
XH = 516           # Plex x-height
MID = 349          # the math axis Plex centres + and ← on (plus spans 62..548)
OVER = 12          # round/pointed overshoot, as Plex's O and ↑
TOP, BOT = 760, -60  # the shared vertical box every SVG uses

# Stroke per weight: Plex's vertical stems are 84/113/152 and its horizontal
# bars 74/100/135. A symbol is monoline and carries more ink per em than a
# letter, so it leans toward the bar weight as it gets heavier.
WEIGHTS = {"regular": 82, "medium": 104, "bold": 130}
CSS_WEIGHT = {"regular": 400, "medium": 500, "bold": 700}
PLEX_FILE = {
    ("sans", "regular"): "IBMPlexSans-Regular.woff2",
    ("sans", "medium"): "IBMPlexSans-Medium.woff2",
    ("sans", "bold"): "IBMPlexSans-Bold.woff2",
    ("mono", "regular"): "IBMPlexMono-Regular.woff2",
    ("mono", "medium"): "IBMPlexMono-Medium.woff2",
    ("mono", "bold"): "IBMPlexMono-Bold.woff2",
}

# Glyph name → codepoint, in the order the specimen shows them.
GLYPHS = [
    ("cmd", 0x2318), ("opt", 0x2325), ("ctrl", 0x2303), ("shift", 0x21E7),
    ("esc", 0x238B), ("delete", 0x232B), ("fwddelete", 0x2326), ("tab", 0x21E5),
    ("caps", 0x21EA), ("return", 0x23CE),
    ("left", 0x2190), ("up", 0x2191), ("right", 0x2192), ("down", 0x2193),
]
CHAR_TO_NAME = {chr(cp): name for name, cp in GLYPHS}

SANS_BEARING = 44      # side bearing on a proportional advance
MONO_ADVANCE = 600
MONO_MAX_WIDTH = 552   # Plex Mono's own ← is 552 wide in a 600 cell


# ---------------------------------------------------------------------------
# Skia helpers
# ---------------------------------------------------------------------------

def polyline(pts, closed=False):
    p = skia.Path()
    p.moveTo(*pts[0])
    for pt in pts[1:]:
        p.lineTo(*pt)
    if closed:
        p.close()
    return p


def stroke(path, s, join="miter", cap="butt"):
    paint = skia.Paint(
        AntiAlias=True,
        Style=skia.Paint.kStroke_Style,
        StrokeWidth=s,
        StrokeCap={"butt": skia.Paint.kButt_Cap, "square": skia.Paint.kSquare_Cap,
                   "round": skia.Paint.kRound_Cap}[cap],
        StrokeJoin={"miter": skia.Paint.kMiter_Join, "round": skia.Paint.kRound_Join,
                    "bevel": skia.Paint.kBevel_Join}[join],
        StrokeMiter=10,
    )
    out = skia.Path()
    paint.getFillPath(path, out)
    return out


def rect(x0, y0, x1, y1):
    return skia.Path.Rect(skia.Rect.MakeLTRB(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))


def op(a, b, kind):
    return skia.Op(a, b, kind)


def union(*paths):
    acc = paths[0]
    for p in paths[1:]:
        acc = op(acc, p, skia.PathOp.kUnion_PathOp)
    return acc


def cut(path, x0, y0, x1, y1):
    """Keep only what lies inside the rectangle — a flat cut."""
    return op(path, rect(x0, y0, x1, y1), skia.PathOp.kIntersect_PathOp)


def xform(path, m):
    out = skia.Path()
    path.transform(m, out)
    return out


def mirror_x(path):
    return xform(path, skia.Matrix.Scale(-1, 1))


def mirror_y(path):
    return xform(path, skia.Matrix.Scale(1, -1))


def translate(path, dx, dy):
    return xform(path, skia.Matrix.Translate(dx, dy))


def scale_x(path, sx):
    return xform(path, skia.Matrix.Scale(sx, 1))


def miter_reach(s, half_angle):
    """How far a mitred corner's outer point lies past the centerline vertex."""
    return (s / 2) / math.sin(half_angle)


def normalize(path):
    """Shift the outline so its left edge sits at x = 0; return (path, width)."""
    # Simplify leaves no overlaps, so even-odd fills the holes correctly
    # whatever the contour directions; the SVGs say so.
    out = skia.Simplify(path)
    b = out.computeTightBounds()
    out = translate(out, -b.left(), 0)
    return out, b.width()


# ---------------------------------------------------------------------------
# The glyphs. Each takes the stroke `s` and an x-scale `xs` applied to the
# centerline geometry (1 for Sans; under 1 to fit a Mono cell). Each returns
# the filled outline with its left edge at 0, and its outer width.
# ---------------------------------------------------------------------------

def g_cmd(s, xs):
    hc = H - s                 # centerline box height
    a = 0.31 * hc              # the square's side
    r = (hc - a) / 4           # each loop's radius
    X = lambda x: x * xs
    p = skia.Path()
    p.moveTo(X(0), -a / 2)
    # Bottom-right loop
    p.lineTo(X(a / 2 + r), -a / 2)
    p.arcTo(skia.Rect.MakeLTRB(X(a / 2), -a / 2 - 2 * r, X(a / 2 + 2 * r), -a / 2), 90, -270, False)
    # Top-right loop
    p.lineTo(X(a / 2), a / 2 + r)
    p.arcTo(skia.Rect.MakeLTRB(X(a / 2), a / 2, X(a / 2 + 2 * r), a / 2 + 2 * r), 180, -270, False)
    # Top-left loop
    p.lineTo(X(-a / 2 - r), a / 2)
    p.arcTo(skia.Rect.MakeLTRB(X(-a / 2 - 2 * r), a / 2, X(-a / 2), a / 2 + 2 * r), 270, -270, False)
    # Bottom-left loop
    p.lineTo(X(-a / 2), -a / 2 - r)
    p.arcTo(skia.Rect.MakeLTRB(X(-a / 2 - 2 * r), -a / 2 - 2 * r, X(-a / 2), -a / 2), 0, -270, False)
    p.close()
    out = stroke(p, s)
    return normalize(translate(out, 0, H / 2))


def g_opt(s, xs):
    W = 0.86 * H
    X = lambda x: x * xs
    top, bot = H - s / 2, s / 2
    x1, x2, x4 = 0.30 * W, 0.60 * W, 0.52 * W
    stem = polyline([(X(0), top), (X(x1), top), (X(x2), bot), (X(W), bot)])
    bar = polyline([(X(x4), top), (X(W), top)])
    out = union(stroke(stem, s), stroke(bar, s))
    # The ends are cut square to the glyph's box, not to the stroke.
    out = cut(out, X(0) - s, -1, X(W), H + 1)
    return normalize(out)


def g_ctrl(s, xs):
    W = 0.80 * H
    hgt = 0.40 * H             # centerline rise of the chevron
    X = lambda x: x * xs
    half = math.atan2(X(W / 2), hgt)
    apex_y = H - miter_reach(s, half)
    foot_y = apex_y - hgt
    u = (X(W / 2), hgt)
    n = math.hypot(*u)
    ext = (u[0] / n * s * 1.5, u[1] / n * s * 1.5)
    p = polyline([(X(W / 2) - u[0] - ext[0], apex_y - u[1] - ext[1]),
                  (X(W / 2), apex_y),
                  (X(W / 2) + u[0] + ext[0], apex_y - u[1] - ext[1])])
    out = cut(stroke(p, s), -1000, foot_y, 1000, H + 100)
    return normalize(out)


def _arrow_outline(s, xs, W, top, bottom, wing_y, half_stem):
    """A hollow up-arrow: a pentagon head on a rectangular stem, stroked."""
    X = lambda x: x * xs
    cx = X(W / 2)
    # Solve the apex so the mitred outer tip lands on `top`.
    apex = top - s
    for _ in range(8):
        half = math.atan2(cx - X(s / 2), apex - wing_y)
        apex = top - miter_reach(s, half)
    pts = [(cx, apex), (X(W - s / 2), wing_y), (cx + X(half_stem), wing_y),
           (cx + X(half_stem), bottom + s / 2), (cx - X(half_stem), bottom + s / 2),
           (cx - X(half_stem), wing_y), (X(s / 2), wing_y)]
    return stroke(polyline(pts, closed=True), s)


def g_shift(s, xs):
    W = 0.90 * H
    out = _arrow_outline(s, xs, W, top=H, bottom=0, wing_y=0.46 * H, half_stem=0.20 * W)
    return normalize(out)


def g_caps(s, xs):
    W = 0.90 * H
    X = lambda x: x * xs
    arrow = _arrow_outline(s, xs, W, top=H, bottom=0.28 * H, wing_y=0.57 * H, half_stem=0.20 * W)
    bar = rect(X(W / 2 - 0.20 * W) - s / 2, 0, X(W / 2 + 0.20 * W) + s / 2, s)
    return normalize(union(arrow, bar))


def _delete(s, xs):
    dh = 0.84 * H
    W = 1.40 * dh
    X = lambda x: x * xs
    ytop, ybot = MID + dh / 2 - s / 2, MID - dh / 2 + s / 2
    xp = 0.30 * W
    half = math.atan2(dh / 2 - s / 2, X(xp))
    tipx = miter_reach(s, half)
    body = polyline([(tipx, MID), (X(xp), ytop), (X(W) - s / 2, ytop),
                     (X(W) - s / 2, ybot), (X(xp), ybot)], closed=True)
    out = stroke(body, s)
    cx = (X(xp) + X(W) - s / 2) / 2
    k = 0.17 * dh
    kx = k * xs
    cross = union(stroke(polyline([(cx - kx, MID - k), (cx + kx, MID + k)]), 0.85 * s),
                  stroke(polyline([(cx - kx, MID + k), (cx + kx, MID - k)]), 0.85 * s))
    return union(out, cross)


def g_delete(s, xs):
    return normalize(_delete(s, xs))


def g_fwddelete(s, xs):
    return normalize(mirror_x(_delete(s, xs)))


def _open_head(tip, direction, L, s):
    """Two wings meeting at `tip`, pointing along `direction` (unit)."""
    dx, dy = direction
    # Wings trail back from the tip at 45° either side.
    back = (-dx, -dy)
    w1 = (back[0] - back[1], back[1] + back[0])   # rotated +45° (scaled by √2)
    w2 = (back[0] + back[1], back[1] - back[0])   # rotated −45°
    n1 = math.hypot(*w1)
    w1 = (w1[0] / n1 * L, w1[1] / n1 * L)
    w2 = (w2[0] / n1 * L, w2[1] / n1 * L)
    pts = [(tip[0] + w1[0], tip[1] + w1[1]), tip, (tip[0] + w2[0], tip[1] + w2[1])]
    return stroke(polyline(pts), s)


def g_tab(s, xs):
    W = 0.96 * H
    X = lambda x: x * xs
    hb = 0.40 * H
    bar = rect(X(W) - s, MID - hb, X(W), MID + hb)
    gap = 0.12 * H
    L = 0.26 * H
    tipx = X(W) - s - gap - miter_reach(s, math.pi / 4)
    head = _open_head((tipx, MID), (1, 0), L, s)
    shaft = stroke(polyline([(0, MID), (tipx, MID)]), s)
    return normalize(union(bar, head, shaft))


def g_return(s, xs):
    W = 0.86 * H
    X = lambda x: x * xs
    yh = 0.28 * H
    L = 0.27 * H
    tipx = miter_reach(s, math.pi / 4)
    elbow = stroke(polyline([(X(W) - s / 2, H), (X(W) - s / 2, yh), (tipx, yh)]), s)
    head = _open_head((tipx, yh), (-1, 0), L, s)
    return normalize(union(elbow, head))


def g_esc(s, xs):
    R = 0.37 * H
    X = lambda x: x * xs
    cx, cy = X(R + s / 2), R + s / 2
    oval = skia.Rect.MakeLTRB(cx - X(R), cy - R, cx + X(R), cy + R)
    ring = skia.Path()
    ring.addArc(oval, 175, 280)
    ring = stroke(ring, s)
    u = (-math.sqrt(0.5), math.sqrt(0.5))
    d_tip = 1.92 * R
    tip = (cx + X(u[0] * d_tip), cy + u[1] * d_tip)
    start = (cx + X(u[0] * 0.30 * R), cy + u[1] * 0.30 * R)
    shaft = stroke(polyline([start, tip]), s)
    head = _open_head(tip, u, 0.22 * H, s)
    return normalize(union(ring, shaft, head))


def g_left(s, xs):
    W = 1.03 * H
    X = lambda x: x * xs
    L = 0.31 * H
    tipx = miter_reach(s, math.pi / 4)
    shaft = stroke(polyline([(tipx, MID), (X(W), MID)]), s)
    head = _open_head((tipx, MID), (-1, 0), L, s)
    return normalize(union(shaft, head))


def g_right(s, xs):
    p, w = g_left(s, xs)
    return normalize(mirror_x(p))


def g_up(s, xs):
    L = 0.31 * H
    tipy = H + OVER - miter_reach(s, math.pi / 4)
    shaft = stroke(polyline([(0, 0), (0, tipy)]), s)
    head = _open_head((0, tipy), (0, 1), L, s)
    return normalize(union(shaft, head))


def g_down(s, xs):
    p, w = g_up(s, xs)
    return normalize(translate(mirror_y(p), 0, H))


BUILDERS = {
    "cmd": g_cmd, "opt": g_opt, "ctrl": g_ctrl, "shift": g_shift, "esc": g_esc,
    "delete": g_delete, "fwddelete": g_fwddelete, "tab": g_tab, "caps": g_caps,
    "return": g_return, "left": g_left, "up": g_up, "right": g_right, "down": g_down,
}


# ---------------------------------------------------------------------------
# Families: Sans widens a touch with weight, as Plex does; Mono compresses the
# geometry into its cell, keeping the stroke, as Plex Mono's own arrows do.
# ---------------------------------------------------------------------------

def build_glyph(name, family, weight):
    s = WEIGHTS[weight]
    if family == "sans":
        xs = 1 + (s - WEIGHTS["regular"]) / WEIGHTS["regular"] * 0.12
        path, width = BUILDERS[name](s, xs)
        advance = round(width + 2 * SANS_BEARING)
        path = translate(path, SANS_BEARING, 0)
    else:
        path, width = BUILDERS[name](s, 1.0)
        xs = 1.0
        for _ in range(6):
            # Compress the centerline, not the ink: rebuild narrower until
            # the outline fits the cell. The stroke keeps its weight.
            if width <= MONO_MAX_WIDTH + 0.5:
                break
            xs *= MONO_MAX_WIDTH / width
            path, width = BUILDERS[name](s, xs)
        advance = MONO_ADVANCE
        path = translate(path, (advance - width) / 2, 0)
    return path, advance


def svg_d(path):
    """An SVG path string for a skia path, in its own coordinates."""
    out = []
    f = lambda v: f"{v:.1f}".rstrip("0").rstrip(".")
    for verb, pts in path:
        if verb == skia.Path.kMove_Verb:
            out.append(f"M{f(pts[0].x())} {f(pts[0].y())}")
        elif verb == skia.Path.kLine_Verb:
            out.append(f"L{f(pts[1].x())} {f(pts[1].y())}")
        elif verb == skia.Path.kQuad_Verb:
            out.append(f"Q{f(pts[1].x())} {f(pts[1].y())} {f(pts[2].x())} {f(pts[2].y())}")
        elif verb == skia.Path.kCubic_Verb:
            out.append(f"C{f(pts[1].x())} {f(pts[1].y())} {f(pts[2].x())} {f(pts[2].y())} "
                       f"{f(pts[3].x())} {f(pts[3].y())}")
        elif verb == skia.Path.kConic_Verb:
            raise RuntimeError("conic left in outline; Simplify should have removed it")
        elif verb == skia.Path.kClose_Verb:
            out.append("Z")
    return "".join(out)


def write_svg(dirpath, name, path, advance):
    d = svg_d(path)
    body = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {-TOP} {advance} {TOP - BOT}">\n'
        f'  <path transform="scale(1,-1)" fill="currentColor" fill-rule="evenodd" d="{d}"/>\n'
        f'</svg>\n'
    )
    with open(os.path.join(dirpath, f"{name}.svg"), "w") as fh:
        fh.write(body)


# ---------------------------------------------------------------------------
# Plex reference outlines, for the proof sheets
# ---------------------------------------------------------------------------

def plex_outlines(file, chars):
    from fontTools.ttLib import TTFont
    from fontTools.pens.basePen import BasePen

    class SkiaPen(BasePen):
        def __init__(self, glyphSet):
            super().__init__(glyphSet)
            self.path = skia.Path()
        def _moveTo(self, p):
            self.path.moveTo(*p)
        def _lineTo(self, p):
            self.path.lineTo(*p)
        def _curveToOne(self, p1, p2, p3):
            self.path.cubicTo(*p1, *p2, *p3)
        def _qCurveToOne(self, p1, p2):
            self.path.quadTo(*p1, *p2)
        def _closePath(self):
            self.path.close()

    f = TTFont(os.path.join(FONTS, file))
    gs = f.getGlyphSet()
    cm = f.getBestCmap()
    out = []
    for ch in chars:
        n = cm.get(ord(ch))
        if n is None:
            out.append((None, 0))
            continue
        pen = SkiaPen(gs)
        gs[n].draw(pen)
        out.append((pen.path, gs[n].width))
    return out


def proof_sheet(family, weight, built, out_png):
    """One row of our glyphs beside Plex's own letters and arrows."""
    scale = 0.22
    refs = plex_outlines(PLEX_FILE[(family, weight)], "HEl+←↑")
    items = [(p, adv) for (p, adv) in built] + refs
    total = sum(adv for _, adv in items) + 200
    w, h = int(total * scale) + 40, int((TOP - BOT) * scale) + 40
    surface = skia.Surface(w, h)
    c = surface.getCanvas()
    c.clear(skia.ColorWHITE)
    c.translate(20, 20 + TOP * scale)
    c.scale(scale, -scale)
    guide = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=3)
    for y, col in ((0, 0xFFE06060), (H, 0xFF60A0E0), (XH, 0xFFB0B0B0)):
        guide.setColor(col)
        c.drawLine(0, y, total, y, guide)
    ink = skia.Paint(AntiAlias=True, Color=skia.ColorBLACK)
    x = 0
    for i, (p, adv) in enumerate(items):
        if p is not None:
            if i >= len(built):
                ink.setColor(0xFF2060A0)
            c.save()
            c.translate(x, 0)
            c.drawPath(p, ink)
            c.restore()
        x += adv
    surface.makeImageSnapshot().save(out_png, skia.kPNG)


# ---------------------------------------------------------------------------
# The specimen
# ---------------------------------------------------------------------------

SPECIMEN_TEXT = [
    "Press ⌘S to save, ⇧⌘S to save as, and ⌥⇧⌘E to equalize. ⌃C interrupts.",
    "⎋ cancels. ⌫ deletes left, ⌦ right. ⇥ moves on, ⇪ is caps lock, ⏎ sends.",
    "Move with ← ↑ → ↓, select with ⇧←, ⇧→, ⌥⇧↑ and ⌥⇧↓, jump with ⌘↑ and ⌘↓.",
]
SIZES = [13, 15, 17, 20, 24, 32, 48]


def esc_html(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def html_line(text, family, weight, advances):
    out = []
    for ch in text:
        name = CHAR_TO_NAME.get(ch)
        if name is None:
            out.append(esc_html(ch))
        else:
            adv = advances[(family, weight, name)]
            out.append(f'<svg class="k" viewBox="0 {-TOP} {adv} {TOP - BOT}">'
                       f'<use href="#g-{family}-{weight}-{name}" transform="scale(1,-1)"/></svg>')
    return "".join(out)


def write_specimen(path_out, symbols, advances):
    css_font = {"sans": "'IBM Plex Sans'", "mono": "'IBM Plex Mono'"}
    faces = []
    for (fam, wt), file in PLEX_FILE.items():
        faces.append(f'@font-face {{ font-family: {css_font[fam]}; font-weight: {CSS_WEIGHT[wt]}; '
                     f'src: url("../../tugdeck/public/fonts/{file}") format("woff2"); }}')
    sections = []
    for fam in ("sans", "mono"):
        for wt in ("regular", "medium", "bold"):
            rows = []
            for size in SIZES:
                lines = "<br>".join(html_line(t, fam, wt, advances) for t in SPECIMEN_TEXT)
                rows.append(f'<p class="l" style="font-size:{size}px"><span class="sz">{size}px</span>{lines}</p>')
            today = "<br>".join(esc_html(t) for t in SPECIMEN_TEXT)
            rows.append(f'<p class="l today" style="font-size:20px"><span class="sz">today</span>{today}</p>')
            sheet = "".join(
                f'<figure><svg class="big" viewBox="0 {-TOP} {advances[(fam, wt, name)]} {TOP - BOT}">'
                f'<use href="#g-{fam}-{wt}-{name}" transform="scale(1,-1)"/></svg>'
                f'<figcaption>{name}</figcaption></figure>'
                for name, _ in GLYPHS)
            sections.append(
                f'<section style="font-family:{css_font[fam]}; font-weight:{CSS_WEIGHT[wt]}">'
                f'<h2>{fam} · {wt} · stroke {WEIGHTS[wt]}</h2>'
                f'{"".join(rows)}'
                f'<div class="sheet">{sheet}<figure class="ref"><span class="big-text">H⌘E</span>'
                f"<figcaption>Plex H, E and today's ⌘</figcaption></figure></div>"
                f'</section>')
    body = "".join(sections)
    html = f"""<!doctype html>
<meta charset="utf-8">
<title>Tug key glyphs — specimen</title>
<style>
{chr(10).join(faces)}
:root {{ color-scheme: light dark; }}
body {{ margin: 0; padding: 2rem 3rem 6rem; background: #1b1e24; color: #e8e8e8; }}
body.light {{ background: #fbfbfa; color: #1a1a1a; }}
h1 {{ font: 500 20px 'IBM Plex Sans'; margin: 0 0 .5rem; }}
h2 {{ font: 500 13px 'IBM Plex Sans'; letter-spacing: .08em; text-transform: uppercase; opacity: .6; margin: 2.5rem 0 .75rem; }}
.hint {{ font: 400 14px 'IBM Plex Sans'; opacity: .7; margin: 0 0 1rem; }}
.l {{ margin: 0 0 .9em; line-height: 1.45; }}
.sz {{ display: inline-block; width: 4.5em; font: 400 11px 'IBM Plex Mono'; opacity: .45; vertical-align: baseline; }}
.today {{ opacity: .75; }}
.k {{ height: {(TOP - BOT) / UPM}em; vertical-align: {BOT / UPM}em; fill: currentColor; display: inline-block; overflow: visible; }}
.sheet {{ display: flex; flex-wrap: wrap; gap: .5rem 1.2rem; margin-top: 1rem; }}
figure {{ margin: 0; text-align: center; }}
figcaption {{ font: 400 11px 'IBM Plex Mono'; opacity: .5; margin-top: .25rem; }}
.big {{ height: {(TOP - BOT) * 0.16}px; fill: currentColor;
        background: linear-gradient(to bottom, transparent {(TOP - H) / (TOP - BOT) * 100}%, rgba(96,160,224,.5) 0, rgba(96,160,224,.5) calc({(TOP - H) / (TOP - BOT) * 100}% + 1px), transparent 0,
                    transparent {(TOP - XH) / (TOP - BOT) * 100}%, rgba(128,128,128,.35) 0, rgba(128,128,128,.35) calc({(TOP - XH) / (TOP - BOT) * 100}% + 1px), transparent 0,
                    transparent {TOP / (TOP - BOT) * 100}%, rgba(224,96,96,.6) 0, rgba(224,96,96,.6) calc({TOP / (TOP - BOT) * 100}% + 1px), transparent 0); }}
.big-text {{ display: inline-block; font-size: {H * 0.16 / 0.698:.1f}px; line-height: 1; }}
.ref {{ align-self: flex-end; }}
button {{ font: 400 13px 'IBM Plex Sans'; margin-bottom: 1rem; }}
</style>
<body>
<button onclick="document.body.classList.toggle('light')">Toggle light / dark</button>
<h1>Tug key glyphs beside IBM Plex</h1>
<p class="hint">Each glyph is an outline in font units, sized 0.82em and seated on the baseline the way a font glyph would be. The "today" row is the raw characters as the deck renders them now, with the system fallback supplying the symbols. Guides on the sheet: cap height (blue), x-height (grey), baseline (red).</p>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
{symbols}
</defs></svg>
{body}
</body>
"""
    with open(path_out, "w") as fh:
        fh.write(html)


def main():
    svg_root = os.path.join(HERE, "svg")
    symbols = []
    advances = {}
    for fam in ("sans", "mono"):
        for wt in ("regular", "medium", "bold"):
            d = os.path.join(svg_root, f"{fam}-{wt}")
            os.makedirs(d, exist_ok=True)
            built = []
            for name, _ in GLYPHS:
                path, adv = build_glyph(name, fam, wt)
                write_svg(d, name, path, adv)
                advances[(fam, wt, name)] = adv
                symbols.append(f'<path id="g-{fam}-{wt}-{name}" fill-rule="evenodd" d="{svg_d(path)}"/>')
                built.append((path, adv))
            proof_sheet(fam, wt, built, f"/tmp/glyph-proof-{fam}-{wt}.png")
    write_specimen(os.path.join(HERE, "specimen.html"), "\n".join(symbols), advances)
    print(f"wrote {len(advances)} glyphs under {svg_root} and specimen.html")


if __name__ == "__main__":
    main()

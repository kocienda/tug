#!/usr/bin/env python3
"""cut.py — cuts build.py's outlines into the Tug Keys fonts.

Writes six woff2 files into tugdeck/public/fonts/: "Tug Keys" and "Tug Keys
Mono" at Regular, Medium and Bold, each with a cmap of exactly the fourteen
key symbols and IBM Plex's vertical metrics, so a glyph seats itself on Plex's
baseline at Plex's cap height and the CSS needs no overrides. A seating
mismatch is a bug here, never a knob in the stylesheet.

The outlines come straight from build.py, so the drawings stay the source and
the font is never hand-edited. Output is byte-for-byte reproducible: the
timestamps are fixed rather than read from the clock.

Rebuild:  python3 resources/glyphs/cut.py          (see README.md)
Check:    python3 resources/glyphs/cut.py --check  reads the files back and
          asserts metrics, cmap, advances and ink against build.py and Plex.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # the README runs this under `python -I`

import skia
from fontTools.fontBuilder import FontBuilder
from fontTools.misc.timeTools import timestampSinceEpoch
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.basePen import BasePen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

import build
from build import CSS_WEIGHT, FAMILIES, FONTS, GLYPHS, H, PLEX_FILE, UPM, XH, build_glyph, tug_keys_file

FACES = [(fam, wt) for fam in ("sans", "mono") for wt in ("regular", "medium", "bold")]

VERSION = "1.000"
COPYRIGHT = "Copyright 2026 Ken Kocienda"
LICENSE = ("This Font Software is licensed under the SIL Open Font License, Version 1.1. "
           "This license is available with a FAQ at: https://openfontlicense.org")
LICENSE_URL = "https://openfontlicense.org"
TIMESTAMP = timestampSinceEpoch(1793491200)  # 2026-11-01, fixed so a rebuild is byte-identical

# Plex's vertical metrics, every table as Plex writes them. WebKit on macOS
# reads hhea; the typo and win values are carried so no other reader disagrees.
ASCENT, DESCENT, LINE_GAP = 1025, -275, 0
TYPO_ASCENDER, TYPO_DESCENDER, TYPO_LINE_GAP = 780, -220, 300

MAX_CURVE_ERROR = 0.5  # font units, should a cubic ever reach the quadratic pen


class SkiaPen(BasePen):
    def __init__(self, glyph_set=None):
        super().__init__(glyph_set)
        self.path = skia.Path()  # winding fill, as a font's outline is read
    def _moveTo(self, p):
        self.path.moveTo(*p)
    def _lineTo(self, p):
        self.path.lineTo(*p)
    def _qCurveToOne(self, p1, p2):
        self.path.quadTo(*p1, *p2)
    def _curveToOne(self, p1, p2, p3):
        self.path.cubicTo(*p1, *p2, *p3)
    def _closePath(self):
        self.path.close()


def file_for(fam, wt):
    return os.path.join(FONTS, tug_keys_file(fam, wt))


def glyph_name(cp):
    return f"uni{cp:04X}"


def draw_outline(path, pen):
    """Replay a skia path into a font pen, on the integer grid.

    A point that rounds onto the one before it is dropped, as is a closing line
    back to the contour's start: glyf closes every contour implicitly.
    """
    def pt(p):
        return (round(p.x()), round(p.y()))

    segments, start, last = [], None, None
    def flush():
        nonlocal segments, start
        if start is None:
            return
        if segments and segments[-1][0] == "line" and segments[-1][1][-1] == start:
            segments.pop()
        if segments:
            pen.moveTo(start)
            for kind, pts in segments:
                if kind == "line":
                    pen.lineTo(pts[0])
                elif kind == "quad":
                    pen.qCurveTo(*pts)
                else:
                    pen.curveTo(*pts)
            pen.closePath()
        segments, start = [], None

    for verb, pts in path:
        if verb == skia.Path.kMove_Verb:
            flush()
            start = last = pt(pts[0])
        elif verb == skia.Path.kLine_Verb:
            if pt(pts[1]) != last:
                last = pt(pts[1])
                segments.append(("line", [last]))
        elif verb == skia.Path.kQuad_Verb:
            last = pt(pts[2])
            segments.append(("quad", [pt(pts[1]), last]))
        elif verb == skia.Path.kCubic_Verb:
            last = pt(pts[3])
            segments.append(("cubic", [pt(pts[1]), pt(pts[2]), last]))
        elif verb == skia.Path.kConic_Verb:
            raise RuntimeError("conic left in outline; Simplify should have removed it")
        elif verb == skia.Path.kClose_Verb:
            flush()
    flush()


def tt_glyph(path):
    """A glyf outline for build.py's even-odd path, filling under nonzero.

    Simplify's contours carry no meaningful direction, and a font fills by
    winding. They do not cross, so how many others enclose a contour says what
    it is: an even count is ink and runs clockwise, as TrueType wants, and an
    odd count is a hole and runs the other way.
    """
    recording = RecordingPen()
    draw_outline(path, recording)
    contours, current = [], []
    for op in recording.value:
        current.append(op)
        if op[0] == "closePath":
            contours.append(current)
            current = []

    def replay(contour, pen):
        for name, args in contour:
            getattr(pen, name)(*args)

    shapes = []
    for contour in contours:
        pen = SkiaPen()
        replay(contour, pen)
        shapes.append(pen.path)

    def encloses(shape, contour):
        # Contours may touch at a vertex, so the on-curve points vote.
        points = [args[-1] for name, args in contour if args]
        return sum(shape.contains(*p) for p in points) * 2 > len(points)

    tt = TTGlyphPen(None)
    for i, contour in enumerate(contours):
        depth = sum(encloses(shapes[j], contour) for j in range(len(contours)) if j != i)
        area = AreaPen()
        replay(contour, area)
        clockwise = area.value < 0
        target = tt if clockwise == (depth % 2 == 0) else ReverseContourPen(tt)
        replay(contour, Cu2QuPen(target, MAX_CURVE_ERROR, reverse_direction=False))
    return tt.glyph()


def cut_face(fam, wt):
    family, ps_family = FAMILIES[fam]
    style = wt.capitalize()
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupHead(fontRevision=float(VERSION), created=TIMESTAMP, modified=TIMESTAMP,
                 macStyle=1 if wt == "bold" else 0)

    order = [".notdef"] + [glyph_name(cp) for _, cp in GLYPHS]
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({cp: glyph_name(cp) for _, cp in GLYPHS})

    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    advances = {".notdef": build.MONO_ADVANCE}
    for name, cp in GLYPHS:
        path, advance = build_glyph(name, fam, wt)
        glyphs[glyph_name(cp)] = tt_glyph(path)
        advances[glyph_name(cp)] = advance
    fb.setupGlyf(glyphs)
    glyf = fb.font["glyf"]
    fb.setupHorizontalMetrics(
        {n: (advances[n], getattr(glyf[n], "xMin", 0)) for n in order})

    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT, lineGap=LINE_GAP)
    fs_selection = (0x20 if wt == "bold" else 0x40 if wt == "regular" else 0) | 0x100
    fb.setupOS2(
        version=4, usWeightClass=CSS_WEIGHT[wt], fsSelection=fs_selection, achVendID="TUG ",
        sTypoAscender=TYPO_ASCENDER, sTypoDescender=TYPO_DESCENDER, sTypoLineGap=TYPO_LINE_GAP,
        usWinAscent=ASCENT, usWinDescent=-DESCENT, sCapHeight=H, sxHeight=XH)
    fb.font["OS/2"].recalcUnicodeRanges(fb.font)
    fb.font["OS/2"].recalcAvgCharWidth(fb.font)
    fb.setupPost(keepGlyphNames=False, isFixedPitch=1 if fam == "mono" else 0)

    # Regular and Bold are the style-linked pair; Medium is its own legacy
    # family with the typographic names on 16 and 17, as Plex does it.
    linked = wt in ("regular", "bold")
    names = dict(
        copyright=COPYRIGHT,
        familyName=family if linked else f"{family} {style}",
        styleName=style if linked else "Regular",
        uniqueFontIdentifier=f"{VERSION};TUG;{ps_family}-{style}",
        fullName=family if wt == "regular" else f"{family} {style}",
        version=f"Version {VERSION}",
        psName=ps_family if wt == "regular" else f"{ps_family}-{style}",
        licenseDescription=LICENSE,
        licenseInfoURL=LICENSE_URL,
    )
    if not linked:
        names.update(typographicFamily=family, typographicSubfamily=style)
    fb.setupNameTable(names)

    fb.font.flavor = "woff2"
    fb.save(file_for(fam, wt))


# ---------------------------------------------------------------------------
# --check: read each woff2 back and hold it to build.py and to Plex.
# ---------------------------------------------------------------------------

def ink(path, advance):
    """The path rasterized at half a pixel per font unit, aliased, as a gray array."""
    scale = 0.5
    w, h = int((advance + 40) * scale), int((build.TOP - build.BOT + 40) * scale)
    surface = skia.Surface(w, h)
    canvas = surface.getCanvas()
    canvas.clear(skia.ColorWHITE)
    canvas.scale(scale, -scale)
    canvas.translate(20, -build.TOP - 20)
    canvas.drawPath(path, skia.Paint(AntiAlias=False, Color=skia.ColorBLACK))
    return surface.makeImageSnapshot().toarray(colorType=skia.kGray_8_ColorType)


MAX_INK_DIFFERENCE = 0.015  # the integer grid moves an edge by at most half a unit


def check_face(fam, wt):
    label = f"{fam}-{wt}"
    font = TTFont(file_for(fam, wt))
    plex = TTFont(os.path.join(FONTS, PLEX_FILE[(fam, wt)]))
    wrong = []

    def same(what, ours, want):
        if ours != want:
            wrong.append(f"{label}: {what} is {ours}, want {want}")

    same("flavor", font.flavor, "woff2")
    head, hhea, os2 = font["head"], font["hhea"], font["OS/2"]
    same("UPM", head.unitsPerEm, 1000)
    same("cap height", os2.sCapHeight, 698)
    same("x-height", os2.sxHeight, 516)
    same("ascent", hhea.ascent, 1025)
    same("descent", hhea.descent, -275)
    same("weight class", os2.usWeightClass, CSS_WEIGHT[wt])
    same("fixed pitch", font["post"].isFixedPitch, plex["post"].isFixedPitch)

    # The seating is only as good as its match to the face it sits beside.
    pos2, phhea = plex["OS/2"], plex["hhea"]
    for what, ours, want in (
        ("UPM against Plex", head.unitsPerEm, plex["head"].unitsPerEm),
        ("hhea ascent against Plex", hhea.ascent, phhea.ascent),
        ("hhea descent against Plex", hhea.descent, phhea.descent),
        ("hhea lineGap against Plex", hhea.lineGap, phhea.lineGap),
        ("typo ascender against Plex", os2.sTypoAscender, pos2.sTypoAscender),
        ("typo descender against Plex", os2.sTypoDescender, pos2.sTypoDescender),
        ("typo lineGap against Plex", os2.sTypoLineGap, pos2.sTypoLineGap),
        ("win ascent against Plex", os2.usWinAscent, pos2.usWinAscent),
        ("win descent against Plex", os2.usWinDescent, pos2.usWinDescent),
        ("cap height against Plex", os2.sCapHeight, pos2.sCapHeight),
    ):
        same(what, ours, want)

    same("cmap", sorted(font.getBestCmap()), sorted(cp for _, cp in GLYPHS))

    name = font["name"]
    family = FAMILIES[fam][0]
    same("family name", name.getDebugName(16) or name.getDebugName(1), family)
    same("license URL", name.getDebugName(14), LICENSE_URL)
    same("copyright", name.getDebugName(0), COPYRIGHT)

    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    for glyph, cp in GLYPHS:
        path, advance = build_glyph(glyph, fam, wt)
        same(f"{glyph} advance", glyph_set[cmap[cp]].width, advance)
        pen = SkiaPen(glyph_set)
        glyph_set[cmap[cp]].draw(pen)
        ours, want = ink(pen.path, advance), ink(path, advance)
        filled = int((want < 128).sum())
        differing = int(((ours < 128) != (want < 128)).sum())
        if filled == 0 or differing / filled > MAX_INK_DIFFERENCE:
            wrong.append(f"{label}: {glyph} ink differs by {differing} of {filled} pixels")
    return wrong


def main():
    if "--check" in sys.argv[1:]:
        wrong = [line for fam, wt in FACES for line in check_face(fam, wt)]
        for line in wrong:
            print(line)
        if wrong:
            sys.exit(1)
        print(f"checked {len(FACES)} faces: metrics, cmap, names, advances and ink all hold")
        return
    for fam, wt in FACES:
        cut_face(fam, wt)
        print(f"wrote {os.path.relpath(file_for(fam, wt))} "
              f"({os.path.getsize(file_for(fam, wt))} bytes)")


if __name__ == "__main__":
    main()

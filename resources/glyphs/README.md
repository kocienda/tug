# Key glyphs for IBM Plex

IBM Plex Sans and Plex Mono have no glyphs for the Mac key symbols
(⌘ ⌥ ⌃ ⇧ ⎋ ⌫ ⌦ ⇥ ⇪ ⏎), so the deck draws them from a system fallback face
at symbol scale, and the arrows Plex does carry (← ↑ → ↓) are thin. This
directory holds our own drawings of all fourteen, made to Plex's measure,
and cuts them into the small fallback fonts the deck draws them from.

- `build.py` — the drawings. Every glyph is a centerline stroked at the
  weight's stroke, flat-cut and unioned by skia, so the three weights are one
  design. Geometry is in font units: 1000/em, cap height 698, baseline 0.
- `svg/<family>-<weight>/<name>.svg` — one filled outline per glyph.
  `viewBox="0 -760 <advance> 820"`: the box runs from 60 below the baseline
  to 760 above, and the width is the glyph's advance (Sans: ink plus 44 a
  side; Mono: the 600 cell, ink centred).
- `specimen.html` — the glyphs set inline beside Plex Sans and Plex Mono at
  seven sizes and three weights, with a "today" row of the raw characters
  for comparison and a sheet of each glyph against cap, x-height and
  baseline guides. Open it in a browser straight from the checkout.
- `cut.py` — the cutter. It takes `build.py`'s outlines and writes six woff2
  files into `tugdeck/public/fonts/`: `TugKeys-*` and `TugKeysMono-*` at
  Regular, Medium and Bold, named "Tug Keys" and "Tug Keys Mono". Each carries
  Plex's vertical metrics and a cmap of exactly the fourteen symbols, so the
  stylesheet needs no overrides; a seating mismatch is a bug in the cutter.
  The fonts are OFL 1.1 (`tugdeck/public/fonts/licenses/tug-keys-OFL.txt`).

## Measures

| | Regular | Medium | Bold |
|---|---|---|---|
| Plex vertical stem | 84 | 113 | 152 |
| Plex horizontal bar | 74 | 100 | 135 |
| Our stroke | 82 | 104 | 130 |

The symbols are monoline and carry more ink per em than a letter, so the
stroke leans toward the bar weight as it gets heavier. Sans widens a little
with weight, as Plex does; Mono compresses the centerline into its cell,
keeping the stroke, as Plex Mono's own arrows do.

Modifier glyphs stand on the baseline at cap height. The arrows and ⇥ sit on
Plex's math axis (349), where its own ← and + sit. ↑ and ↓ overshoot by 12
like Plex's own, and ⌘'s loops are tangent-continuous with the square so the
knot reads as one stroke.

## Rebuilding

```bash
python3 -m venv /tmp/ftenv
/tmp/ftenv/bin/pip install skia-python fonttools brotli
/tmp/ftenv/bin/python -I resources/glyphs/build.py
/tmp/ftenv/bin/python -I resources/glyphs/cut.py
/tmp/ftenv/bin/python -I resources/glyphs/cut.py --check
```

Proof sheets (our glyphs beside Plex's H, E, l, +, ←, ↑) land in `/tmp` as
`glyph-proof-<family>-<weight>.png`.

`cut.py` is reproducible, so an unchanged drawing rebuilds to identical bytes.
`--check` reads each woff2 back and holds its metrics, cmap, names, advances and
ink to `build.py` and to the Plex face it sits beside.

# Color Palette

*TugColor is a thin, named-hue sugar over OKLCH. Components consume semantic tokens; those tokens resolve to `--tug-color(...)` recipes that carry OKLCH coordinates directly.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## Color Space

TugColor operates in OKLCH — a perceptually uniform color space. A TugColor value is a **named hue** plus three coordinates written as integers on **one uniform 0–1000 scale**:

- **Hue:** one of 48 named hues (or a hyphenated adjacency pair), supplying the OKLCH hue angle.
- **Lightness (l):** 0–1000 → OKLCH L 0–1, linear (`l: 670` = L 0.67).
- **Chroma (c):** 0–1000 → **OKLCH C 0–MAX_CHROMA, absolute, then clamped into the Display-P3 gamut.** The same `c` is the same perceived chroma on every hue; `c: 1000` always lands on the punchiest in-gamut color.
- **Alpha (a):** 0–1000 → opacity 0–1, linear. Defaults to 1000 (fully opaque).

Values are **whole numbers** — fractional values (`l: 300.5`) are rejected.

**Chroma is absolute and portable.** `c` maps linearly onto OKLCH C 0–`MAX_CHROMA` (0.5), then **clamps** into `maxChromaInGamut(hue, lightness, P3)` — the per-color P3 edge found by `palette-engine`. Because the mapping is fixed (not normalized per hue), **the same `c` is the same perceived chroma on every hue**, so an authored `l`/`c` pair copies cleanly from one theme into another — which differs only by hue — and yields the *same color, hue-rotated*. Authoring never goes out of P3: `c: 1000` (→ C 0.5, above every gamut) resolves to the in-gamut ceiling, so "punchiest valid color" is just `c: 1000` — no per-hue table, no separate `max` keyword. Two things to know: a high `c` on a low-gamut hue/lightness clamps (several near-max `c` values can resolve to the same color), and the migration from the old scale rounded sub-perceptibly (≤0.00025 in oklch C).

> **Why not gamut-relative?** An earlier version made `c` a *percentage of each hue's own ceiling*. It guaranteed in-gamut authoring, but it made identical numbers land on *different* colors per hue — so copying an `l`/`c` pair between themes silently produced a different color (a vivid hue's `c: 500` is far more chroma than a muted hue's `c: 500`). That broke the one ergonomic that matters most: copy-paste. Absolute chroma restores it; the gamut ceiling is preserved by clamping at resolve time instead of by normalizing the scale.

**Values vs. deltas.** Both a `--tug-color` chroma *value* and an additive chroma *delta* (the theme editor's duet/treatment re-hueing) are **absolute** oklch (×1000, same footing as lightness). The conversions live in one place — `fracFromAuthored` (l/a and deltas) and `chromaFromAuthored` / `authoredFromChroma` (chroma values; absolute, gamut-clamped) in `palette-engine.ts`; every surface routes through them, no module keeps its own copy.

> **History.** Earlier TugColor replaced OKLCH chroma/lightness with abstract *intensity* (0–100) and *tone* (0–100, piecewise lightness through a per-hue canonical L). That remapping was retired: it added conceptual overhead and a large conversion layer, its "shared tone skeleton" was undercut by per-hue canonical-L, and its headline benefit (P3 widening) is already handled by the browser (see [P3 Gamut](#p3-gamut)).

---

## The 48 Chromatic Hues

24 base hues and 24 intermediate hues, evenly distributed around the OKLCH wheel:

| # | Name | Angle | | # | Name | Angle |
|---|------|------:|-|---|------|------:|
| 1 | garnet | 2.5° | | 25 | seafoam | 165° |
| 2 | cherry | 10° | | 26 | teal | 175° |
| 3 | scarlet | 15° | | 27 | aqua | 187.5° |
| 4 | coral | 20° | | 28 | cyan | 200° |
| 5 | crimson | 22.5° | | 29 | azure | 207.5° |
| 6 | red | 25° | | 30 | sky | 215° |
| 7 | vermilion | 30° | | 31 | cerulean | 222.5° |
| 8 | tomato | 35° | | 32 | blue | 230° |
| 9 | ember | 40° | | 33 | sapphire | 240° |
| 10 | flame | 45° | | 34 | cobalt | 250° |
| 11 | tangerine | 50° | | 35 | indigo | 260° |
| 12 | orange | 55° | | 36 | violet | 270° |
| 13 | apricot | 60° | | 37 | iris | 277.5° |
| 14 | amber | 65° | | 38 | purple | 285° |
| 15 | honey | 70° | | 39 | grape | 292.5° |
| 16 | gold | 75° | | 40 | plum | 300° |
| 17 | saffron | 82.5° | | 41 | orchid | 310° |
| 18 | yellow | 90° | | 42 | pink | 320° |
| 19 | chartreuse | 102.5° | | 43 | peony | 327.5° |
| 20 | lime | 115° | | 44 | rose | 335° |
| 21 | grass | 127.5° | | 45 | cerise | 340° |
| 22 | green | 140° | | 46 | magenta | 345° |
| 23 | jade | 147.5° | | 47 | fuchsia | 350° |
| 24 | mint | 155° | | 48 | berry | 355° |

Names are single lowercase words drawn from nature, gemstones, flowers, fruits, spices, and pigments. All hue names are unhyphenated — hyphens are reserved for adjacency syntax. The vocabulary lives in `HUE_FAMILIES` (`tugdeck/src/components/tugways/palette-engine.ts`).

---

## Hyphenated Adjacency

Any two consecutive hues in the 48-color ring can be combined as `A-B`. The first name dominates:

```
hue(A-B) = (2/3 × angle(A)) + (1/3 × angle(B))
```

This yields **144 expressible chromatic hue points** (~2.5° average spacing). The ring is circular — berry (355°) and garnet (2.5°) are adjacent and wrap correctly across the 360°/0° boundary.

Only adjacent pairs are valid (`ADJACENCY_RING`). Non-adjacent combinations (e.g., `yellow-blue`) are hard errors at parse time. No silent fallback.

---

## Named Grays

Nine descriptive names for intermediate achromatic values, ordered dark to light, each a fixed OKLCH L (`ACHROMATIC_L_VALUES`):

| Name | OKLCH L |
|------|--------:|
| pitch | 0.22 |
| ink | 0.29 |
| charcoal | 0.36 |
| carbon | 0.43 |
| graphite | 0.50 |
| vellum | 0.592 |
| parchment | 0.684 |
| linen | 0.776 |
| paper | 0.868 |

Plus two endpoints: **black** (L=0) and **white** (L=1).

Named grays have fixed lightness and take no `l`/`c` (supplying them warns). For an arbitrary achromatic lightness, use the `gray` pseudo-hue with an explicit `l`.

### Transparent

`transparent` is a named color expanding to `oklch(0 0 0 / 0)`. Supplying any arguments warns.

---

## The `--tug-color()` Notation

A compact CSS notation that expands to `oklch()` at build time via a PostCSS plugin (`postcss-tug-color.ts`):

```css
--tug-color(indigo, l: 300, c: 500)        /* chromatic; c = C 0.25 absolute, gamut-clamped */
--tug-color(cobalt-indigo, l: 300, c: 300) /* hyphenated adjacency */
--tug-color(gray, l: 430)                  /* gray pseudo-hue (achromatic) */
--tug-color(charcoal)                      /* named gray (fixed L) */
--tug-color(white, a: 80)                  /* fixed endpoint + alpha */
--tug-color(transparent)                   /* fully transparent */
```

- **Chromatic hues require explicit `l` and `c`.** (The model is honest sugar over oklch — there is no canonical default.)
- Labels `l:`/`c:`/`a:` may appear in any order after the hue; positional order is `color, lightness, chroma, alpha`.
- Ranges: `l`, `c`, and `a` are all whole numbers 0–1000. Fractional values are rejected.
- The plugin expands these to concrete `oklch(L C h)` values. Zero runtime cost — built CSS contains only standard `oklch()`.

### `resolveTugColorToOklch()`

The single source of truth for expansion (`palette-engine.ts`): a hue-angle lookup plus l/c/a as oklch fractions, returning `{ L, C, h, alpha }`. Callers convert the authored 0–1000 values to those fractions first via `fracFromAuthored` (l/a) and `chromaFromAuthored` (absolute chroma, gamut-clamped). The PostCSS plugin formats the result into an `oklch(...)` string; the headless contrast audit feeds it straight into the WCAG/perceptual checks — so build output and audit never drift.

---

## P3 Gamut

`oklch()` is device-independent: the browser maps each coordinate to whatever the display can show. Because chroma is **clamped to the P3 edge at resolve time**, authored theme colors are in-P3 by construction (`c: 1000` lands on the edge); you cannot accidentally author past it. A chroma within sRGB renders the same everywhere; one between the sRGB and P3 edges (high `c`) is gamut-mapped down on sRGB displays and rendered richer on P3 — **automatically, with no media query**. There is no per-hue chroma table or `@media (color-gamut: p3)` override.

- `bun run audit:gamut` (`scripts/audit-gamut.ts`) resolves every `--tug-color()` recipe and reports, per theme, how many land out-of-sRGB versus out-of-P3. **out-of-sRGB is expected** — vivid colors are authored past sRGB by design so P3 renders them richer; those colors are still within P3. **out-of-P3 stays 0** — guaranteed now that chroma is clamped to the P3 edge at resolve time. Run `audit:gamut <theme>` for a per-recipe drill-down, or `--strict` for a CI exit code.
- `bun run scripts/clamp-theme-gamut.ts --write` (`scripts/clamp-theme-gamut.ts`) is a no-op safety net: the parser already gamut-clamps at resolve time, so nothing exceeds P3 and it has nothing to clamp. Retained as a guard.

---

## Three-Tier Token Architecture

1. **Palette tier** — the hue vocabulary (`HUE_FAMILIES`, `ADJACENCY_RING`) and named grays (`ACHROMATIC_L_VALUES`) in `palette-engine.ts`. Theme-independent; consumed by `--tug-color(...)` expansion, not referenced as CSS variables.
2. **Base tier** — `--tug7-*` seven-slot semantic tokens (surface and element). Theme-specific chromatic choices live here, authored as `--tug-color(...)` recipes. [D71, L17]
3. **Component tier** — `--tugx-<component>-*` aliases. Resolve to base tier in one hop. [D71, L17]

Components consume base and component tokens. The palette tier provides the raw hue/gray materials those recipes name.

---

## Theme Runtime Note

Theme runtime is CSS-first:

- theme tokens are authored in `styles/themes/*.css` (ironclad, sloop, and others) as `--tug-color(...)` recipes
- Vite/PostCSS expands `--tug-color(...)` to normal `oklch()` in dev/build

# TugColor Palette System Refinements

## Core Principle

The palette engine is a **continuous color space** — 24 hues × 100 intensity levels × 100
tone levels = 240,000 addressable colors. The system provides three ways to access it:

1. **Per-hue constants** (72 CSS custom properties): the foundation. Each hue's angle,
   canonical lightness, and peak chroma. Plus 2 global lightness anchors.
2. **Five convenience presets per hue** (120 CSS variables): canonical, light, dark,
   intense, muted. Fixed i/t values, same across all themes.
3. **Inline TugColor formula**: any element can specify arbitrary i/t using the
   `calc()`+`clamp()` piecewise formula with per-hue constants.
4. **`tugColor()` JS function**: programmatic access for inline styles, color pickers,
   data visualization.

Components never see the formula — they consume semantic tokens (`--tug-base-accent-default`)
which resolve to palette colors. The semantic token layer is where theme-specific chromatic
choices live.

---

## 1. Five convenience presets (not ten)

The old system had 7 presets with confusing coefficient knobs. The proposed 10-preset system
was rejected — ten arbitrary names on a perceptual scale are hard to remember and still only
cover 240 of the 240,000 addressable colors.

Instead, five instantly obvious presets per hue:

| Name      | i | t | Character                         |
|-----------|-----|-----|-----------------------------------|
| canonical | 50  | 50  | The crayon color — reference point |
| light     | 20  | 85  | Background-safe, airy             |
| dark      | 50  | 20  | Contrast text, dark surfaces      |
| intense   | 90  | 50  | Pops, draws attention             |
| muted     | 20  | 50  | Subdued, secondary                |

These are **fixed across all themes** — `--tug-red-intense` always means the same color.
They're convenience shortcuts, not the system's backbone.

Total: 120 convenience vars (24 hues × 5) + 72 per-hue constants + 2 globals + neutrals
+ black/white ≈ ~200 palette CSS vars.

---

## 2. Rename `accent` → `intense`

The canonical color is the accent color in most UI contexts. `intense` sits on a clear
scale alongside the other four presets.

All references to `-accent` **palette preset** names in tug-palette.css, tug-tokens.css,
theme files, and palette-engine.ts get renamed to `-intense`. Semantic tokens that use
`accent` as a **UI role** name (e.g., `--tug-base-accent-default`, `--tug-base-accent-strong`,
`--tug-base-element-global-text-normal-onAccent-rest`) keep `accent` — the UI role and the palette preset are distinct
concepts.

### Preset renames

| Old name | New name  | Notes |
|----------|-----------|-------|
| accent   | intense   | palette preset only; semantic `accent` role unchanged |
| subtle   | *(removed)* | no longer a preset |
| light    | light     | kept, new i/t |
| dark     | dark      | kept, new i/t (was i=50/t=25, now i=50/t=20) |
| deep     | *(removed)* | no longer a preset |

The old `subtle` and `deep` presets are removed. Components that referenced them are
updated to use semantic tokens or the inline formula with specific i/t numbers.

---

## 3. The formula (written once, used everywhere)

The `calc()`+`clamp()` piecewise formula is the shared math. It appears in three places:

1. **`tug-palette.css`**: defines the five convenience presets per hue
2. **Semantic tokens in theme files**: theme-specific chromatic choices use the same formula
   with their own i/t numbers
3. **`palette-engine.ts`**: `tugColor()` implements the same math in TypeScript

**Per-hue constants** (3 vars per hue, 24 hues = 72 vars):

```css
--tug-red-h: 25;
--tug-red-canonical-l: 0.62;
--tug-red-peak-c: 0.44;
```

**Global lightness anchors:**

```css
--tug-l-dark: 0.15;
--tug-l-light: 0.96;
```

**The formula** (example for `--tug-red-muted`):

```css
--tug-red-muted: oklch(
  calc(
    var(--tug-l-dark)
    + clamp(0, 50, 50)
      * (var(--tug-red-canonical-l) - var(--tug-l-dark)) / 50
    + (clamp(50, 50, 100) - 50)
      * (var(--tug-l-light) - var(--tug-red-canonical-l)) / 50
  )
  calc(20 / 100 * var(--tug-red-peak-c))
  var(--tug-red-h)
);
```

Note: the convenience presets use **literal numbers** for i/t (e.g., `20` and `50`),
not CSS custom property references. This is because the five presets have fixed values —
they don't need to be overridable per-theme. Theme-specific colors use the same formula
with different literal numbers in the semantic token definitions.

**How the piecewise clamp() math works:**

The TugColor tone-to-lightness mapping has two segments:

```
t 0→50:   L goes from L_DARK to canonical-l
t 50→100: L goes from canonical-l to L_LIGHT
```

`clamp(low, x, high)` acts as a gate. If x is outside the range, it pins to the boundary
and that segment contributes zero slope.

Walk through with t=20 (lower segment active, used by `dark` preset):

```
Segment 1: clamp(0, 20, 50) = 20   → 20 * (can-l - L_DARK) / 50   ← contributes
Segment 2: clamp(50, 20, 100) - 50 = 0  → 0 * ...                  ← contributes nothing
Result: L = L_DARK + 20/50 * (can-l - L_DARK)
```

Walk through with t=85 (upper segment active, used by `light` preset):

```
Segment 1: clamp(0, 85, 50) = 50   → maxed out, contributes (can-l - L_DARK)
Segment 2: clamp(50, 85, 100) - 50 = 35  → 35 * (L_LIGHT - can-l) / 50  ← contributes
Result: L = L_DARK + (can-l - L_DARK) + 35/50 * (L_LIGHT - can-l)
       = can-l + 0.7 * (L_LIGHT - can-l)
```

Walk through with t=50 (the hinge — produces canonical lightness):

```
Segment 1: maxes out → contributes (can-l - L_DARK)
Segment 2: clamp(50, 50, 100) - 50 = 0 → contributes nothing
Result: L = L_DARK + (can-l - L_DARK) = can-l
```

---

## 4. Theme-specific chromatic tokens

This is the key design shift. **Semantic tokens are where theme-specific color choices live.**

Each theme file defines its chromatic `--tug-base-*` tokens using the inline TugColor formula
with whatever i/t values suit that theme's visual identity. The five convenience presets
may be referenced where they happen to match, but themes are not limited to them.

Example — Brio's accent tokens:

```css
/* Brio theme (default) — accent is orange at canonical */
--tug-base-accent-default: var(--tug-orange);
--tug-base-accent-strong: var(--tug-orange-intense);
--tug-base-accent-muted: var(--tug-orange-muted);
```

Example — Harmony's accent tokens (custom i/t choices):

```css
/* Harmony theme — accent is orange, tuned for light backgrounds */
--tug-base-accent-default: oklch(
  calc(
    var(--tug-l-dark)
    + clamp(0, 55, 50)
      * (var(--tug-orange-canonical-l) - var(--tug-l-dark)) / 50
    + (clamp(50, 55, 100) - 50)
      * (var(--tug-l-light) - var(--tug-orange-canonical-l)) / 50
  )
  calc(60 / 100 * var(--tug-orange-peak-c))
  var(--tug-orange-h)
);
```

This is more verbose than `var(--tug-orange-intense)`, but the design intent is explicit:
"Harmony's accent default is orange at i=60, t=55." The numbers are right there in the
theme file.

**Theme design workflow:**

1. Use the gallery editor to explore i/t combinations interactively
2. Pick specific i/t numbers for each chromatic semantic token
3. Write them into the theme file using the inline formula
4. The five convenience presets serve as reference points during this process

---

## 5. Consumer API

**Components use semantic tokens. That's it.**

```css
.my-button {
  background: var(--tug-base-accent-default);
  color: var(--tug-base-element-global-text-normal-onAccent-rest);
}

.sidebar {
  background: var(--tug-base-surface-subtle);
}
```

**Convenience presets for one-off direct palette access:**

```css
.status-badge {
  background: var(--tug-red-light);
  color: var(--tug-red-dark);
}
```

**For transparency**, `color-mix()` with any palette var (opacity adjustment only):

```css
--tug-base-accent-subtle: color-mix(in oklch, var(--tug-orange) 15%, transparent);
```

**For arbitrary i/t in JS:**

```typescript
import { tugColor } from './palette-engine';
element.style.backgroundColor = tugColor('red', 30, 70);
```

---

## 6. `tugColor()` JS function

The TypeScript function uses the same piecewise math as the CSS formulas. It takes a hue
name (or raw angle), intensity, and tone, and returns an `oklch()` string. Used for:

- Color pickers and the gallery editor
- Data visualization with dynamic color ranges
- Any one-off color that no preset covers

The function already exists in `palette-engine.ts` — it is completely rewritten to use the
`clamp()`-based piecewise formula, matching the CSS exactly. The old coefficient-based
functions are removed entirely. `TUG_COLOR_PRESETS` is updated to the five-preset set.

---

## 7. Theme overrides

Themes define chromatic `--tug-base-*` tokens using the inline TugColor formula with theme-
specific i/t choices. This replaces the old model of overriding preset knobs.

For achromatic adjustments, themes override non-chromatic tokens (surfaces, grays, shadows)
with literal values as before.

For per-hue adjustments, themes can:

- Override per-hue canonical-l values for contrast adjustments (e.g., Harmony bumps
  `--tug-red-canonical-l` higher so red is readable on light surfaces)
- The five convenience presets are **not overridden per-theme** — they have fixed i/t
  values and serve as stable reference colors

---

## 8. P3 gamut handling

The `@media (color-gamut: p3)` block overrides `--tug-{hue}-peak-c` with wider values.
Since all formulas (convenience presets and theme inline formulas) reference `peak-c`, they
automatically produce richer colors on P3 displays. No per-preset overrides needed.

---

## 9. Neutral ramp

Five neutral presets matching the chromatic convenience presets, plus black/white anchors:

```css
--tug-neutral:         oklch(0.555 0 0);  /* t=50 (canonical) */
--tug-neutral-light:   oklch(0.835 0 0);  /* t=85 */
--tug-neutral-dark:    oklch(0.311 0 0);  /* t=20 */
--tug-neutral-intense: oklch(0.555 0 0);  /* same as canonical (no chroma to boost) */
--tug-neutral-muted:   oklch(0.555 0 0);  /* same as canonical (no chroma to reduce) */

--tug-black: oklch(0 0 0);
--tug-white: oklch(1 0 0);
```

---

## 10. Gallery editor enhancement

The gallery palette editor is enhanced to serve the theme design workflow:

- Interactive i/t explorer: pick any hue, drag across the full 100×100 i/t space,
  see the resulting color rendered in real time across the L-curve
- Preset reference overlay: the five convenience presets shown as labeled points in the
  i/t space for reference while designing
- Theme token export: once a i/t choice is made, the editor can generate the CSS
  inline formula snippet for pasting into a theme file

---

## 11. Comment policy

All comments describe the code as it is. No phase numbers, no "replaced X", no
"introduced in Y". The palette file header explains the TugColor model, the three axes, the
piecewise formula, and the preset system.

---

## 12. Implementation scope

### Preset renames and removals

1. Rename `accent` → `intense` across all palette files
2. Remove `subtle` and `deep` presets — update all references to use semantic tokens or
   inline formulas
3. Adjust `light` and `dark` i/t to new values
4. Add `TUG_COLOR_PRESETS` with the five-preset set in palette-engine.ts

### Formula rewrite

Complete rewrite. The old coefficient-based formulas (`--tug-preset-accent-l`, `min()`-based
piecewise) are removed entirely and replaced with the `calc()`+`clamp()` formula using
literal i/t numbers. Visual parity with the old system is not a goal.

### Theme file rewrite

Each theme's chromatic `--tug-base-*` tokens are rewritten to use the inline TugColor formula
with theme-specific i/t choices. This is the substantive design work — choosing the
right i/t for each chromatic role in each theme.

### Full consumer audit

Every file in the codebase is searched for references to old preset names (`-accent` as
palette preset, `-subtle`, `-deep`). All references are updated. No breakage is allowed.

### Gallery editor enhancement

The gallery palette editor gains the interactive i/t explorer and theme token export
functionality described in section 10.

### What changes

- `accent` → `intense` (palette preset only; semantic `accent` role unchanged)
- `subtle` and `deep` presets removed
- `light` and `dark` i/t adjusted
- 7 presets → 5 presets (fewer convenience vars, but full space accessible)
- Coefficient knobs eliminated — convenience presets use literal i/t in formulas
- Theme files rewritten with inline TugColor formulas for chromatic semantic tokens
- `TUG_COLOR_PRESETS` in palette-engine.ts rewritten to five-preset set
- `tugColor()` rewritten to match CSS formula
- Gallery editor enhanced for interactive i/t exploration
- All component CSS, theme files, and TS files audited and updated
- Historical comments stripped

### What stays the same

- Per-hue constants (h, canonical-l, peak-c)
- Global anchors (l-dark, l-light)
- P3 media query overrides
- Three-layer token architecture (palette → base → component)
- Semantic tokens keep `accent` as UI role name
- `tugColor()` function (rewritten to match)
- Neutral ramp + black/white (adjusted to match five presets)

---

## 13. Build-time `--tug-color()` expansion (Phase 5g2)

The inline `calc()`+`clamp()` formula (section 3) gives full parametric control, but it is verbose — too verbose for the hundreds of achromatic tokens (surfaces, grays, borders, text) that fill theme files. Phase 5g2 introduces a compact `--tug-color()` CSS notation that expands to `oklch()` at build time.

### The `--tug-color()` notation

```css
/* Named hue */
--tug-base-surface-app: --tug-color(cobalt, 3, 8);

/* Raw OKLCH angle */
--tug-base-surface-alt: --tug-color(237, 5, 13);
```

The PostCSS plugin expands these at build time to concrete `oklch(L C h)` values using the same piecewise math as `tugColor()`. Zero runtime cost — the built CSS contains only standard `oklch()`.

### When to use `--tug-color()` vs. the inline formula

| Use case | Approach |
|----------|----------|
| Achromatic tokens (surfaces, borders, text, grays) | `--tug-color()` — compact, build-time expansion |
| Chromatic tokens needing P3 override via `peak-c` | Inline `calc()`+`clamp()` formula with `var(--tug-{hue}-peak-c)` |
| Programmatic colors in JS | `tugColor()` function |
| Convenience presets in tug-palette.css | Inline formula (already uses `var()` references for P3) |

The key distinction: `--tug-color()` produces a static `oklch()` value at build time. The inline formula produces a live `calc()` expression that responds to CSS variable changes at runtime (e.g., P3 gamut overrides via `peak-c`). Theme achromatic tokens don't need P3 responsiveness, so `--tug-color()` is the right choice.

### Reverse mapper: `oklchToTugColor()`

To convert the hundreds of existing hex values programmatically, `oklchToTugColor()` inverts the TugColor math. Given an `oklch()` string, it finds the closest named hue family and recovers intensity/tone parameters. The companion `tugColorPretty()` formats results as `"blue i=5 t=13"` for developer tooling.

### Theme conversion outcome

After conversion, all three theme files (tug-tokens.css, bluenote.css, harmony.css) contain zero standalone hex color values in their body{} blocks. Every color is expressed as `--tug-color(hue, i, t)`, making the design intent — hue family, intensity, tone — explicit and machine-readable. `tug-palette.css` is not modified (its `var()` formulas for P3 overrides remain as-is).

# Theme Generator with Accessibility Engine

## What We're Building

A **Theme Generator** card in the Component Gallery that:

1. Takes a small set of seed colors and produces a complete theme
2. Validates all color combinations for contrast (WCAG 2.x + perceptual contrast)
3. Simulates color blindness across all types and flags problems
4. Supports high-contrast and reduced-contrast accessibility modes
5. Can be guided by aesthetic references — like the CHM mood board

---

## The Mood Board: What I See

Studying seven images from the Computer History Museum (Mountain View, CA), we extracted a specific color vocabulary from early computing hardware — mainframe panels, mechanical calculators, analog computer modules, pressure gauges, and operator consoles.

| Role | Source | Approximate TugColor Value |
|---|---|---|
| **Chassis surface** | Steel blue-gray panels | `--tug-color(blue+8, i: 8, t: 38)` — desaturated, warm-leaning blue-gray |
| **Panel inset** | Cream/ivory control surfaces | `--tug-color(yellow, i: 5, t: 92)` — warm off-white |
| **Deep frame** | Dark navy/charcoal housing | `--tug-color(cobalt, i: 5, t: 8)` — near-black with blue cast |
| **Signal: action** | Amber/orange toggles, nixie glow, Raytheon logos | `--tug-color(orange)` — the existing tug accent |
| **Signal: alert** | Red toggles, gauge needle | `--tug-color(red)` |
| **Signal: status** | Green/yellow/blue operator buttons | Maps to semantic tones |
| **Accent: cool** | Teal/sage TRICE label strips | `--tug-color(teal, i: 20, t: 45)` |
| **Accent: soft** | Lavender knurled knobs | `--tug-color(purple, i: 15, t: 55)` |
| **Metal/neutral** | Brushed aluminum knobs, bezels | Achromatic, `i: 0, t: 60-75` |

### Design Principles from the Mood Board

- **Muted surfaces, vivid signals** — chassis are subdued (low intensity, medium tone); color is reserved for things that need attention
- **Industrial but refined** — no frivolous decoration, everything has purpose
- **Warm neutrals** — cream not pure white, warm gray not cool
- **Tactile hierarchy** — different panel levels use different materials and colors
- **Color-coding for function** — orange/black toggles, colored buttons for different operations
- **Monospace uppercase labeling** — already present in the retronow/tugways design

The Theme Generator should support a **mood** parameter that adjusts derivation rules. The CHM aesthetic would be one mood: warmer neutrals, more separation between surface layers, and signal colors that pop harder against muted backgrounds.

---

## Theme Recipe Format

A theme is defined by a small config — minimum 3 values (mode + atmosphere + text), full control with ~12.

```typescript
interface ThemeRecipe {
  name: string;
  mode: "dark" | "light";

  // Core seeds (minimum 2: atmosphere + text)
  atmosphere: { hue: string; offset?: number };  // Surface color
  text: { hue: string; offset?: number };         // Foreground color

  // Optional seeds (defaults derived from mode + atmosphere)
  accent?: string;         // default: "orange"
  primary?: string;        // default: "blue"
  destructive?: string;    // default: "red"
  positive?: string;       // default: "green"
  warning?: string;        // default: "yellow"
  info?: string;           // default: "cyan"

  // Mood adjustments
  surfaceContrast?: number;  // 0-100: tone spread between surface layers (default: 50)
  signalVividity?: number;   // 0-100: how saturated accent/signal colors are (default: 50)
  warmth?: number;           // 0-100: bias toward warm neutrals (default: 50)

  // Accessibility
  accessibility?: {
    contrastTarget?: "aa" | "aaa" | "apca-bronze" | "apca-silver";
    colorBlindSafe?: boolean;  // ensure all semantic colors remain distinguishable
    highContrast?: boolean;    // boost all contrasts above minimum
  };
}
```

### Existing Themes as Recipes

**Brio** (default dark):
```json
{ "name": "brio", "mode": "dark",
  "atmosphere": { "hue": "violet", "offset": -6 },
  "text": { "hue": "cobalt" } }
```

**Bluenote** (cool dark):
```json
{ "name": "bluenote", "mode": "dark",
  "atmosphere": { "hue": "blue", "offset": 9 },
  "text": { "hue": "blue" } }
```

**Harmony** (warm light):
```json
{ "name": "harmony", "mode": "light",
  "atmosphere": { "hue": "yellow" },
  "text": { "hue": "blue", "offset": 5 } }
```

### Mood Knobs — CHM Example

The three mood parameters encode aesthetic choices:

- **surfaceContrast: 70** — more tonal separation between panel layers (like recessed insets vs. raised chassis)
- **signalVividity: 80** — accents pop hard (like amber toggles on gray metal)
- **warmth: 65** — cream not white, warm gray not cool (like ivory button caps)

---

## Accessibility Engine

### A. Contrast Validation (WCAG 2.x + perceptual contrast)

Every generated theme gets checked automatically.

**WCAG 2.x**: Standard relative luminance contrast ratio `(L1 + 0.05) / (L2 + 0.05)`.

**Perceptual contrast**: A polarity-aware algorithm more accurate for dark themes — WCAG 2.x overstates contrast for dark colors, which is exactly the problem behind `[D06]` overrides in Harmony.

#### Threshold Matrix

| Token Role | Min WCAG 2.x | Min perceptual contrast | Rationale |
|---|---|---|---|
| Body text (14px / 400wt) | 4.5:1 (AA) | contrast 75 | Primary readability |
| Large text (18px+ / 700wt) | 3:1 (AA) | contrast 45 | Button labels, headings |
| UI components (icons, borders) | 3:1 (AA) | contrast 30 | Non-text contrast |
| Decorative / dividers | — | contrast 15 | Structural only |

#### Perceptual Contrast Font Size/Weight Lookup (Silver level, selected entries)

| Font Size | Wt 300 | Wt 400 | Wt 500 | Wt 700 |
|---|---|---|---|---|
| 14px | — | contrast 100 | — | contrast 80 |
| 16px | contrast 90 | contrast 70 | — | contrast 60 |
| 18px | contrast 80 | contrast 65 | — | contrast 55 |
| 24px | contrast 65 | contrast 55 | — | contrast 45 |

#### Auto-Adjustment

When a token pair fails contrast, the engine:
1. Attempts to bump the fg tone value up (dark mode) or down (light mode) until contrast passes
2. Flags tokens that can't be fixed without changing seed colors

### B. Color Blindness Simulation

Using the **Machado et al. 2009** matrices (academic gold standard), the engine simulates how every color appears to people with color vision deficiency (CVD).

| Type | Affected Cones | Prevalence (males) | Pipeline |
|---|---|---|---|
| **Protanopia** | L-cone (red) missing | ~1% | linearRGB -> matrix -> sRGB |
| **Deuteranopia** | M-cone (green) missing | ~1% | linearRGB -> matrix -> sRGB |
| **Tritanopia** | S-cone (blue) missing | ~0.01% | linearRGB -> matrix -> sRGB |
| **Achromatopsia** | All/most cones | ~0.003% | Luminance weights |
| **Protanomaly / Deuteranomaly** | Partial deficiency | ~6% | Coblis matrices with severity param |

#### Key Checks

- Can you distinguish **positive** (green) from **warning** (yellow) from **danger** (red)?
- Can you distinguish **primary** (blue) from **destructive** (red)?
- Does the **accent** still stand out from the **atmosphere**?

If not, the engine suggests adjustments — typically shifting one confusing hue to increase lightness distance (lightness perception is unaffected by color blindness).

#### Simulation Matrices (Machado et al. 2009, severity = 1.0)

All matrices operate in **linear sRGB** space. Pipeline: sRGB gamma -> linearize -> apply matrix -> clamp [0,1] -> re-gamma.

```
Protanopia:   [[ 0.152286,  1.052583, -0.204868],
               [ 0.114503,  0.786281,  0.099216],
               [-0.003882, -0.048116,  1.051998]]

Deuteranopia: [[ 0.367322,  0.860646, -0.227968],
               [ 0.280085,  0.672501,  0.047413],
               [-0.011820,  0.042940,  0.968881]]

Tritanopia:   [[ 1.255528, -0.076749, -0.178779],
               [-0.078411,  0.930809,  0.147602],
               [ 0.004733,  0.691367,  0.303900]]

Achromatopsia: [[0.2126, 0.7152, 0.0722],
                [0.2126, 0.7152, 0.0722],
                [0.2126, 0.7152, 0.0722]]
```

### C. Accessibility Conformance Modes

Three levels a theme can target, applied as recipe-time adjustments:

1. **Standard** (default) — meets WCAG AA for all text, 3:1 for UI components
2. **Enhanced** — meets WCAG AAA (7:1 for body text), passes CVD checks, all semantic colors distinct in grayscale
3. **High Contrast** — responds to `prefers-contrast: more`, boosts all minimum contrasts by 30%, widens surface tone spread, ensures `forced-colors` fallback works

The generator can also produce companion tokens for `@media (prefers-contrast: more)` blocks.

#### CSS Media Query Support

```css
@media (prefers-contrast: more) { /* User wants higher contrast */ }
@media (prefers-contrast: less) { /* User wants lower contrast */ }
@media (forced-colors: active)  { /* Windows High Contrast mode */ }
```

---

## Theme Generator Card: UI Design

The card follows the Palette Engine card's interaction pattern, with these sections:

1. **Seed Selector** — Pick mode (dark/light toggle), atmosphere hue (click one of 24 hue swatches), text hue. Live preview updates immediately.
2. **Mood Controls** — Three sliders for `surfaceContrast`, `signalVividity`, `warmth`. Each shows a mini-preview of how that parameter affects the palette.
3. **Contrast Dashboard** — Grid showing every fg/bg pair with its WCAG ratio and perceptual contrast value. Green = pass, yellow = marginal, red = fail. Click any cell to inspect and adjust.
4. **CVD Preview Strip** — The current theme's key colors rendered through protanopia, deuteranopia, tritanopia, and grayscale. Flags semantic pairs that become indistinguishable.
5. **Token Preview** — Full token list showing generated `--tug-color()` values. Editable — click any token to override. Overrides tracked separately from generated values.
6. **Export** — Download as `.css` theme file (ready to drop into `styles/`), or as recipe JSON for regeneration. Import recipe JSON to reload.

---

## What Changes to Existing Code?

Mostly additive. No existing components or themes change.

| Change | Files | Why |
|---|---|---|
| New content component | `gallery-theme-generator-content.tsx` + `.css` | The card UI |
| New tab in gallery | `gallery-card.tsx` | Register the card |
| New derivation engine | `theme-derivation-engine.ts` | Role formulas + generation logic |
| New accessibility module | `theme-accessibility.ts` | Contrast calc, perceptual contrast, CVD simulation |
| Extend palette-engine | `palette-engine.ts` | Add `oklchToLinearRGB()` if needed for CVD |

---

## Implementation Roadmap

### Layer 1: Derivation Engine

The analytical core — role formulas that map seed colors to complete themes.

- Catalog all ~40 role formulas by analyzing the three existing themes
- Build `theme-derivation-engine.ts` that takes a recipe and outputs CSS
- Validate by regenerating Bluenote and Harmony from recipes and diff-comparing

### Layer 2: Accessibility Module

The contrast and color vision engine.

- WCAG 2.x luminance contrast function
- Perceptual contrast calculation (full algorithm with polarity detection)
- CVD simulation matrices (Machado et al. 2009)
- Pair-checking logic (which tokens check against which backgrounds)

### Layer 3: Theme Generator Card

The interactive UI in the Component Gallery.

- Seed selector + mood sliders
- Live token preview
- Export/import
- Contrast dashboard wired to the accessibility module

### Layer 4: CVD Preview + Auto-fix

Visual aid simulation and automatic remediation.

- Live CVD simulation strip
- Auto-adjustment suggestions
- High-contrast mode generation

---

## Why This Is Tractable

1. **The foundation is ready.** `palette-engine.ts` already has `tugColor()`, `oklchToHex()`, `oklchToLinearSRGB()`, gamut checking — 80% of the math we need.
2. **The UI pattern exists.** The Palette Engine card demonstrates the exact interaction model (swatches, sliders, grids, export/import).
3. **The role formulas are derivable.** Three existing themes provide enough data points. The formulas are simple tone/intensity mappings parameterized by hue and mode.
4. **The accessibility algorithms are well-documented.** Perceptual contrast constants and CVD matrices are published standards — computation, not invention.

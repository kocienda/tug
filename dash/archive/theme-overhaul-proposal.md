# Tugways Theme Token Overhaul Proposal

This proposal replaces the current theme/token naming with a researched,
code-grounded model that is large enough to support the actual scope of
`design-system-concepts.md` and `tugways-implementation-strategy.md`.

This revision corrects a flaw in the earlier draft: the semantic set was too
small, too generic, and did not account for the current code's heavy use of the
accent system, chart tokens, syntax tokens, shadcn bridge aliases, workspace
chrome, and the roadmap's much larger component inventory.

The intent here is not a cosmetic rename. The intent is to:

- Replace `--tways-*` and `--td-*` with a clearer long-term structure.
- Remove all legacy aliases.
- Preserve and improve the accent concept instead of deleting it.
- Define a large, explicit `--tug-base-*` semantic contract.
- Make future component styling additive and controlled rather than ad hoc.
- Add a TugColor (Hue · Intensity · Tone · Alpha) computed color palette with 24 hue families, two
  independent axes (intensity 0–100, tone 0–100), 7 named presets per hue,
  and P3 wide-gamut support, using OKLCH for perceptual uniformity.
- Add a global scale system: one root number controls all dimensions in the UI.
- Add a global timing system: one root number controls all animation durations.
- Add a dev-mode `Ctrl+Option + hover` cascade inspector for direct style
  introspection.

---

## Proposal Status

This is a research-backed proposal document, not yet an implementation plan.

If approved, the next document should be a concrete implementation tugplan with:

- File-by-file migration order.
- Temporary compatibility shims.
- Search-based enforcement checks.
- Theme parity verification across Brio, Bluenote, and Harmony.

---

## Inputs Used

This proposal is based on four inputs:

1. Current code in `tugdeck/`.
2. `dash/design-system-concepts.md`.
3. `dash/tugways-implementation-strategy.md`.
4. Public token-system references with permissive or compatible licensing.

### Current Code Reviewed

The current token consumers and declarations were reviewed in:

- `tugdeck/styles/tokens.css`
- `tugdeck/styles/chrome.css`
- `tugdeck/src/globals.css`
- `tugdeck/src/components/tugways/*.css`
- `tugdeck/src/components/ui/*.tsx`

### Roadmap Scope Reviewed

The roadmap review included the current and planned styling needs for:

- Canvas and chrome.
- Tugcard, tab bar, dock, snapping, flashing, selection, shadows.
- Form controls.
- Overlays and feedback components.
- Data display and visualization.
- Inspector panels and mutation-preview tooling.
- Rebuilt cards including terminal, code/conversation, git, files, stats,
  settings, developer, about, and the gallery card.

---

## External Research

The following systems were used as naming-structure references only. No code,
token values, or proprietary assets are being copied.

### 1. Primer Primitives (MIT)

References:

- [Primitives](https://primer.style/product/primitives)
- [Token names](https://primer.style/product/primitives/token-names)
- [primer/design](https://github.com/primer/design)

Relevant takeaways:

- Primer explicitly separates `base`, `functional`, and `component/pattern`
  token categories.
- Primer requires a property block in token names and uses reusable pattern
  names such as `control`, not just component names.
- Primer's documented examples are directly useful for tugways naming:
  `bgColor-inset`, `borderColor-default`, `control-danger-borderColor-rest`,
  `button-primary-bgColor-hover`.
- Primer's color modifiers `default`, `muted`, and `emphasis` are especially
  useful for the tugways semantic layer.

### 2. Spectrum Design Data (Apache-2.0)

References:

- [Spectrum tokens](https://opensource.adobe.com/spectrum-design-data/tokens/)
- [spectrum-design-data](https://github.com/adobe/spectrum-design-data)

Relevant takeaways:

- Spectrum separates raw palette, semantic aliases, component color tokens,
  layout primitives, layout component tokens, and icon tokens.
- This is strong evidence that tugways should not stop at generic color tokens;
  it should explicitly model icon, layout, overlay, and component-family needs.
- Spectrum's separation between semantic aliases and component tokens matches
  the direction tugways needs.

### 3. Open Props (MIT)

References:

- [Open Props](https://open-props.style/)
- [argyleink/open-props](https://github.com/argyleink/open-props)

Relevant takeaways:

- Open Props demonstrates the usefulness of consistent size/radius/shadow/motion
  scales and surface ladders such as `--surface-1` through `--surface-4`.
- Tugways should adopt the discipline of named scale families, but with
  tugways-specific semantics rather than generic raw scales in the public layer.
- Open Props also reinforces the value of explicit motion and shadow scales.

### 4. Carbon Design System (Apache-2.0)

References:

- [Carbon color tokens](https://carbondesignsystem.com/elements/color/tokens/)
- [carbon-design-system/carbon](https://github.com/carbon-design-system/carbon)

Relevant takeaways:

- Carbon is particularly strong on role + state naming: `background-hover`,
  `background-active`, `layer-01`, `field-01`, `border-subtle-01`,
  `layer-accent-01`, etc.
- Carbon shows that a serious semantic layer must model state transitions across
  multiple surfaces, not just define one neutral background and one border.
- Carbon's `background`, `layer`, `field`, `border`, `support`, `focus`, and
  `icon` domains map cleanly to tugways needs.

### 5. Chakra UI Semantic Tokens

References:

- [Semantic tokens](https://chakra-ui.com/docs/theming/semantic-tokens)

Relevant takeaways:

- Chakra's simple nested semantic groups are a good readability model: `bg`,
  `fg`, `border`, `focusRing`.
- Tugways should use a similarly readable domain hierarchy even though our
  implementation is plain CSS custom properties.

### 6. OKLCH Guidance and Modern CSS Palette Practice

References:

- [OKLCH FYI](https://www.oklch.fyi/)
- [Tailwind color customization](https://tailwindcss.com/docs/customizing-colors)

Relevant takeaways:

- OKLCH is perceptually uniform, which makes fixed lightness and chroma ramps
  behave more consistently across named hues.
- Equal lightness values across different hues are far more trustworthy in OKLCH
  than in HSL or ad hoc hex picking.
- Modern CSS token systems increasingly use `oklch()` directly for theme-token
  authoring, which fits tugways well.

### 7. Adobe Color Naming Guidance

References:

- [Naming colors in design systems](https://adobe.design/stories/design-for-scale/naming-colors-in-design-systems)

Relevant takeaways:

- Common-language hue names such as `red`, `blue`, and `purple` are clearer
  than poetic or highly branded color names.
- A stable `name + value` system scales better than one-off descriptive names.
- This strongly supports the named hue families proposed for the tugways palette
  layer.

### Licensing Note

These references are used for naming-pattern inspiration only. This proposal
does not copy theme values, CSS, component code, or artwork from any external
system. The external sources are standards, MIT-licensed projects, or
Apache-2.0-licensed projects, which are all compatible with using the ideas and
naming structures as references in an MIT-licensed codebase.

---

## What Current Code Actually Uses

The current code is more specific and more ambitious than the earlier draft
acknowledged.

### 1. Accent Is Not Optional

Accent usage is already widespread in live code:

- `tug-button.css`: `--td-accent-2` for primary button fill, `--td-accent` for
  state dots.
- `tug-tab-bar.css`: `--td-accent` for active tab underline, overflow badge
  background, insert indicator, and drag-drop target highlights.
- `chrome.css`: `--td-accent-cool` for snap guides, `--td-accent` for perimeter
  flash.
- `tugcard.css`: `--td-selection-bg` and `--td-selection-text`.
- `gallery-card.css`: `--td-accent` and `--td-accent-cool` in the mutation demo.

Conclusion:

- The accent concept must be preserved.
- The accent system needs to become clearer, not smaller.
- The numbered accent scale must be replaced by descriptive names, not removed
  without replacement.

### 2. The Code Already Implies More Domains Than the Old Draft Covered

Current declared or consumed domains include:

- Surface and canvas.
- Text and inverse text.
- Accent and status.
- Chart.
- Syntax.
- Border and selection.
- Header and icon states.
- Active and inactive card shadow.
- Dim overlays.
- Spacing, radius, typography, line height.
- Motion tokens.
- Grid lines, drag/drop indicators, flash overlays.

### 3. There Are Existing Gaps

The current system already has holes that a better semantic layer should fix:

- `hello-card.tsx` consumes `--td-text-muted`, but that token is not declared.
- Drag ghost, badge, banner, and flash semantics are partly ad hoc.
- Many component states still rely on local styling choices rather than named
  cross-component semantics.
- The legacy alias layer obscures what is actually canonical.

### 4. The Shadcn Bridge Is a Real Migration Problem

`globals.css` and `components/ui/*.tsx` still depend on variables such as:

- `--background`, `--foreground`, `--primary`, `--accent`, `--destructive`,
  `--ring`.

This means the proposal must include an explicit bridge strategy. We cannot just
declare legacy aliases dead without describing how the shadcn/Tailwind bridge is
replaced.

---

## What the Roadmap Requires

The roadmap requires a token system that can credibly support all of the
following, not just today's small CSS footprint.

### Workspace Chrome

Canvas grid, Tugcard chrome, title bar active/inactive states, tabs and overflow
tabs, tab drag indicators, dock rail and buttons, resize handles, snap guides,
set shadows, perimeter flash, selection containment visuals.

### Controls and Inputs

Buttons, input, textarea, select, checkbox, radio, switch, slider,
label/helper/required states, validation and error states, grouped control
seams, loading and disabled states.

### Overlay and Feedback Components

Alert, sheet, confirm popover, toast, tooltip, dropdown menu, context menu,
dialog, badges, status indicators, progress, skeleton, spinner, separator, kbd,
avatar, disconnect and warning banners.

### Data Display and Visualization

Tables, stat cards, sparklines, linear gauges, arc gauges, chart series,
threshold and trend states.

### Inspector / Dev Tools

Color picker, font picker, coordinate inspector, inspector panel, mutation
preview vs commit vs cancel states, cascade/source display, hovered-target
highlighting.

### Card Domain Surfaces

Terminal, code/conversation, git/files, stats, settings/developer, about,
gallery.

Conclusion: `--tug-base-*` must be large enough to cover workspace chrome,
generic controls, feedback, data display, visualization, inspector tooling, and
domain-specific surfaces such as syntax and terminal presentation.

---

## Core Decisions

### 1. `--tways-*` and `--td-*` Are Transitional, Not Permanent

Both current prefixes should become migration smells.

Long-term target:

- Theme/palette primitives: `--tug-palette-*`
- Canonical semantics: `--tug-base-*`
- Component/pattern tokens: `--tug-comp-*`

This intentionally makes any future `--tways-*` or `--td-*` usage a sign that
old code or migration debris remains.

### 2. `--tug-base-*` Is the Public Contract

Everything components use should resolve directly or indirectly from
`--tug-base-*`.

That means:

- Components consume `--tug-base-*` or `--tug-comp-*`.
- `--tug-comp-*` must resolve from `--tug-base-*`.
- Palette/theme primitives never leak into component CSS.

### 3. Accent Survives as a First-Class System

The current accent system is doing several jobs at once:

- Primary action color.
- Cool/secondary interactive accent.
- Chart series colors.
- Syntax color sources.
- Status tone sources.
- Visual instrumentation color.

These jobs should be separated, but the accent concept absolutely remains.

### 4. TugColor (Hue · Intensity · Tone · Alpha) Computed Color Palette

The earlier draft proposed 12 hue families with 4 fixed tones for 48 total
palette entries. That was too rigid. The intensity-based system that replaced it
(smoothstep transfer function, `--tug-palette-hue-<angle>-<name>-tone-<intensity>`
naming) was then itself replaced by the **TugColor (Hue · Intensity · Tone · Alpha) system** — a simpler,
more expressive model built on three axes:

- **Hue**: 24 named color families (cherry through coral), mapped to OKLCH hue
  angles. Each hue has a per-hue **canonical lightness** tuned by eye.
- **Intensity (i)**: Chroma axis scaled 0–100. At i=50, chroma equals the
  sRGB-safe maximum for the hue. Above 50 pushes toward P3 wide-gamut.
- **Tone (t)**: Lightness axis scaled 0–100. At t=50, lightness equals the
  per-hue canonical L. t=0 is dark (L=0.15), t=100 is light (L=0.96).

CSS variables use short-form naming: `--tug-{hue}` for canonical colors,
`--tug-{hue}-{preset}` for the 7 named presets, and `--tug-{hue}-h`,
`--tug-{hue}-canonical-l`, `--tug-{hue}-peak-c` for per-hue constants.

See [TugColor Color Palette System](#tug-color-color-palette-system) for the full design.

### 5. One Global Scale Controls All Dimensions

A single `--tug-zoom` value (default: `1`) drives `zoom: var(--tug-zoom)` on
`<body>`, scaling the entire UI — layout boxes, text, spacing, radii, icons,
everything — with one number. No per-token `calc()` wiring is needed. Each
`Tug*` component can optionally set `zoom` on its root element for fine-tuning.

See [Global Scale System](#global-scale-system) for the full design.

### 6. One Global Timing Controls All Motion

A single `--tug-timing` value (default: `1`) multiplies every animation
duration and transition in the system. Setting it to `5` gives slow-motion
for debugging. A separate `--tug-motion` toggle (default: `1`) disables motion
entirely when set to `0` — either manually or via `prefers-reduced-motion`.

See [Global Timing System](#global-timing-system) for the full design.

### 7. Size Tokens Use a Uniform Adjectival Scale

Standard size ladder: `2xs`, `xs`, `sm`, `md`, `lg`, `xl`, `2xl`.

This scale should be used consistently across spacing, radius, typography, icon
size, stroke width, and elevation tiers where appropriate.

---

## TugColor Color Palette System

### The Problem with Earlier Approaches

A fixed 4-tone system (soft/default/strong/intense) forces designers into
exactly four choices per hue. The intensity-based system that followed (11
standard stops per hue, smoothstep transfer function) was more flexible but
still tied to a single axis. The TugColor (Hue · Intensity · Tone · Alpha) system replaces both with a
two-axis model that separates chroma control (intensity) from lightness control
(value), giving independent control over saturation and brightness.

### Design: 24 Hue Families x Intensity x Tone (Implemented)

**Hue families.** 24 named hues mapped to OKLCH hue angles. Each hue has a
per-hue **canonical lightness** tuned for visual balance at i=50, t=50:

| Hue Name | OKLCH Hue Angle | Canonical L |
|----------|-----------------|-------------|
| `cherry` | 10 | 0.619 |
| `coral` | 20 | 0.632 |
| `red` | 25 | 0.659 |
| `tomato` | 35 | 0.704 |
| `flame` | 45 | 0.740 |
| `orange` | 55 | 0.780 |
| `amber` | 65 | 0.821 |
| `gold` | 75 | 0.852 |
| `yellow` | 90 | 0.901 |
| `lime` | 115 | 0.861 |
| `green` | 140 | 0.821 |
| `mint` | 155 | 0.807 |
| `teal` | 175 | 0.803 |
| `cyan` | 200 | 0.803 |
| `sky` | 215 | 0.807 |
| `blue` | 230 | 0.771 |
| `cobalt` | 250 | 0.744 |
| `violet` | 270 | 0.708 |
| `purple` | 285 | 0.686 |
| `plum` | 300 | 0.731 |
| `pink` | 320 | 0.794 |
| `rose` | 335 | 0.758 |
| `magenta` | 345 | 0.726 |
| `berry` | 355 | 0.668 |

Note: The hue angles are adjusted so names land on perceptually distinct,
recognizable colors. Canonical L values are tuned per-hue (all must be > 0.555)
so that the "default" color for each hue sits at a visually balanced lightness.

**Token naming format.** Short-form CSS variable names:

- `--tug-{hue}` — canonical color (i=50, t=50)
- `--tug-{hue}-{preset}` — named preset (e.g., `--tug-red-accent`)
- `--tug-{hue}-h` — hue angle constant
- `--tug-{hue}-canonical-l` — canonical lightness constant
- `--tug-{hue}-peak-c` — peak chroma constant (MAX_CHROMA × 2)
- `--tug-l-dark` — global dark lightness (0.15)
- `--tug-l-light` — global light lightness (0.96)

Examples:

- `--tug-red` — red at canonical (i=50, t=50)
- `--tug-red-accent` — red at i=80, t=50
- `--tug-violet-subtle` — violet at i=15, t=92
- `--tug-orange-dark` — orange at i=50, t=25

**TugColor axes:**

- **Intensity (i, 0–100):** Controls chroma. At i=0, chroma is zero
  (achromatic). At i=50, chroma equals the per-hue sRGB-safe maximum. At
  i=100, chroma reaches the peak (2× the sRGB-safe max, pushing into P3 gamut
  on capable displays).
- **Tone (t, 0–100):** Controls lightness via piecewise linear mapping
  through the per-hue canonical L at t=50. t=0 maps to L_DARK (0.15),
  t=100 maps to L_LIGHT (0.96).

### The Transfer Function (Implemented)

The TugColor system uses two independent linear mappings, not a smoothstep curve:

**Value-to-Lightness:** Piecewise linear through the per-hue canonical L at
t=50. Two segments:
- t 0→50: L interpolates linearly from L_DARK (0.15) to canonical L
- t 50→100: L interpolates linearly from canonical L to L_LIGHT (0.96)

**Intensity-to-Chroma:** Linear from 0 to peak chroma:
- C = (i / 100) × peakChroma

Peak chroma defaults to `MAX_CHROMA_FOR_HUE[hue] × PEAK_C_SCALE` (where
PEAK_C_SCALE = 2). For P3 displays, peak chroma uses the wider
`MAX_P3_CHROMA_FOR_HUE[hue] × PEAK_C_SCALE`.

```typescript
export function tugColor(
  hueName: string,
  i: number,
  t: number,
  canonicalL: number,
  peakChroma?: number,  // defaults to MAX_CHROMA_FOR_HUE[hue] * PEAK_C_SCALE
): string
// Returns an oklch(L C h) CSS string.
```

Per-hue chroma caps (`MAX_CHROMA_FOR_HUE`) are derived via binary search at
three L sample points per hue: L_DARK (0.15), the per-hue canonical L, and
L_LIGHT (0.96). The minimum safe chroma across all three points becomes the cap,
with a 2% safety margin. This ensures no out-of-gamut colors at any tone setting.

### Seven Semantic Presets Per Hue (Implemented)

Instead of arbitrary intensity stops, the TugColor system provides 7 named presets
per hue with fixed i/t mappings:

| Preset | CSS Variable | i | t | Use Case |
|--------|-------------|-----|-----|----------|
| canonical | `--tug-{hue}` | 50 | 50 | General-purpose default |
| accent | `--tug-{hue}-accent` | 80 | 50 | Emphasized, high-chroma actions |
| muted | `--tug-{hue}-muted` | 25 | 55 | Muted text, secondary elements |
| light | `--tug-{hue}-light` | 30 | 82 | Light backgrounds, soft fills |
| subtle | `--tug-{hue}-subtle` | 15 | 92 | Very subtle tinted washes |
| dark | `--tug-{hue}-dark` | 50 | 25 | Dark theme accents |
| deep | `--tug-{hue}-deep` | 70 | 15 | Deep, saturated anchors |

7 presets × 24 hues = 168 preset variables, plus 74 per-hue constants
(3 per hue + 2 global) = 242 total CSS variables in the sRGB block.

### Runtime Architecture (Transitioning to Pure CSS)

**Current state.** The palette engine defines CSS variables via pure CSS formulas
in `tug-palette.css`. The `tugColor()` JS function in `palette-engine.ts` provides
programmatic access for inline styles and data visualization.

**Target state (Phase 5d5e).** Per-hue constants and preset formulas are defined
in a static `tug-palette.css` file using CSS `oklch()` + `calc()`:

```css
:root {
  /* Per-hue constants (static, from tug-color-canonical.json): */
  --tug-red-h: 25;
  --tug-red-canonical-l: 0.659;
  --tug-red-peak-c: 0.346;
  /* ... 23 more hues ... */
  --tug-l-dark: 0.15;
  --tug-l-light: 0.96;

  /* Presets as pure CSS formulas: */
  --tug-red: oklch(var(--tug-red-canonical-l) calc(0.5 * var(--tug-red-peak-c)) var(--tug-red-h));
  --tug-red-accent: oklch(var(--tug-red-canonical-l) calc(0.8 * var(--tug-red-peak-c)) var(--tug-red-h));
  /* ... */

  /* Neutral ramp (achromatic): */
  --tug-neutral: oklch(0.555 0 0);
  --tug-neutral-light: oklch(0.812 0 0);
  --tug-black: oklch(0 0 0);
  --tug-white: oklch(1 0 0);
}

@media (color-gamut: p3) {
  :root {
    /* Only peak-c overrides needed — preset formulas auto-produce wider colors */
    --tug-red-peak-c: 0.434;
    /* ... */
  }
}
```

**Programmatic use.** For arbitrary i/t combinations beyond the 7 presets,
the TypeScript function `tugColor(hueName, i, t, canonicalL)` returns a raw
`oklch(...)` string. Used in inline styles, color pickers, and data
visualization. Retained in `palette-engine.ts` after JS injection is removed.

**P3 wide-gamut support.** A `@media (color-gamut: p3)` block overrides
`--tug-{hue}-peak-c` constants with wider P3 chroma caps. The preset formulas
reference `peak-c`, so they automatically produce richer colors — no separate
P3 preset definitions needed.

**Opacity.** Semi-transparent variants use CSS relative color syntax at the
point of use: `oklch(from var(--tug-orange) l c h / 0.5)` or
`color-mix(in oklch, var(--tug-orange) 50%, transparent)`. No precomputed
alpha variants needed.

**Theme influence.** All three themes (Brio, Bluenote, Harmony) currently share
the same canonical L values and hue angles. Per-theme tuning (if needed) would
override per-hue constants in theme-specific CSS files.

---

## Global Scale System

### The Problem (Resolved)

Resizing a design system by wiring every dimension token through
`calc(<base> * var(--tug-zoom))` requires touching hundreds of tokens and
rewriting every component to consume those tokens. The original Phase 5d5b
attempt proved this: only 10 tokens were wired, yet the actual UI uses Tailwind
utility classes, inline JS styles, and hardcoded pixel values for dimensions.
The calc()-based approach would have required rewriting every component.

### Design: CSS Zoom

CSS `zoom` on `<body>` scales the entire UI — layout boxes, text, spacing,
radii, icons, everything — with one property. No per-token `calc()` wiring
needed. No component rewrites needed.

```css
:root { --tug-zoom: 1; }
body  { zoom: var(--tug-zoom); }
```

Setting `--tug-zoom: 1.25` makes the entire UI 25% larger. Setting
`--tug-zoom: 0.85` produces a compact mode. The relationship between all
elements is preserved because zoom scales everything uniformly. Unlike
`transform: scale()`, CSS `zoom` affects layout boxes — scaled elements occupy
their correct space without overlaps or gaps.

**Component-level scale.** Each `Tug*` component family can optionally set
`zoom` on its root element for fine-tuning relative proportions:

```css
.tug-tab-bar {
  zoom: var(--tug-comp-tab-zoom, 1);
}
```

Zoom composes multiplicatively — a component with `zoom: 0.9` inside a body
with `zoom: 1.25` renders at effective zoom `1.125`. Component-level zoom
tokens default to `1` and are optional.

**What scales:** Everything rendered — font sizes, spacing, radii, icon sizes,
stroke widths, component internal dimensions (padding, gaps, min-heights),
Tailwind utility classes, hardcoded pixel values, inline styles.

**What doesn't scale:** Color, opacity, z-index, animation timing (that is the
timing system's job).

**Gallery demo note:** The scale slider applies zoom on pointer release (not
continuously) because zoom triggers a full layout recalculation. Continuous
updates would cause visual thrashing.

### Accessibility Use Cases

| `--tug-zoom` | Use Case |
|---------------|----------|
| `0.85` | Compact/dense mode for power users |
| `1.0` | Default |
| `1.25` | Large text mode |
| `1.5` | Low-vision accessible mode |
| `2.0` | Extreme magnification / demo mode |

The scale value can be exposed in the Settings card as a slider, persisted in
tugbank (`dev.tugtool.app` domain, key `scale`), and restored on reload.

---

## Global Timing System

### The Problem (Resolved)

The legacy `--td-duration-scalar` system has been replaced. The TugColor Runtime
phase removed `--td-duration-scalar` entirely. Phase 5d5b introduced the
`--tug-timing` / `--tug-motion` system described below, which is now
implemented and working.

### Design: One Root Timing, Universal Application

**Root timing.** A single CSS custom property controls all temporal values:

```css
:root {
  --tug-timing: 1;
}
```

Every duration and delay in the system includes `--tug-timing` as a factor:

```css
:root {
  --tug-base-motion-duration-instant: calc(0ms * var(--tug-timing));
  --tug-base-motion-duration-fast: calc(100ms * var(--tug-timing));
  --tug-base-motion-duration-moderate: calc(200ms * var(--tug-timing));
  --tug-base-motion-duration-slow: calc(350ms * var(--tug-timing));
  --tug-base-motion-duration-glacial: calc(500ms * var(--tug-timing));
}
```

**The `--tug-motion` on/off switch.** Separate from timing speed, motion can be
turned off entirely. This is a discrete toggle, not a continuous value:

```css
:root {
  --tug-motion: 1; /* 1 = motion enabled, 0 = motion disabled */
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --tug-motion: 0;
  }
}
```

When `--tug-motion` is `0`, all animations and transitions are disabled. This is
implemented by components checking the value and conditionally applying
animation classes, or by a global rule:

```css
[data-tug-motion="off"] *,
[data-tug-motion="off"] *::before,
[data-tug-motion="off"] *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}
```

The `data-tug-motion` attribute is set on `<body>` by the theme engine based on
the `--tug-motion` value. This gives CSS a discrete hook to work with, since
`calc()` inside `animation-duration` has browser support limitations.

**Why two controls?** The timing scalar and the motion toggle serve different
purposes:

- `--tug-timing: 5` = slow motion for debugging. Animations play at 5x normal
  duration. Invaluable for tuning easing curves and transition choreography.
- `--tug-timing: 0.5` = snappy mode. Everything feels faster.
- `--tug-motion: 0` = no motion at all. Accessibility requirement for users
  who experience motion sickness or vestibular disorders. This is categorically
  different from "very fast motion" — it means no visual movement whatsoever.

**Component-level timing is not proposed.** Unlike scale (where different
components may need different densities), there is no clear use case for
per-component timing overrides. All motion in the system should feel unified.
If a specific animation needs a unique duration, it should define a named token
in `--tug-base-motion-*`, not a component-level multiplier.

### Easing tokens remain as-is

Easing curves are not affected by the timing scalar. They describe the shape of
motion, not its duration:

```css
:root {
  --tug-base-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
  --tug-base-motion-easing-enter: cubic-bezier(0, 0, 0, 1);
  --tug-base-motion-easing-exit: cubic-bezier(0.2, 0, 1, 1);
}
```

### JavaScript Integration

For animations driven by JavaScript (e.g., RAF-based drag, spring physics,
inspector scrub), the timing value must be readable from JS:

```typescript
function getTugTiming(): number {
  const raw = getComputedStyle(document.body)
    .getPropertyValue('--tug-timing').trim();
  return parseFloat(raw) || 1;
}

function isTugMotionEnabled(): boolean {
  return document.body.dataset.tugMotion !== 'off';
}
```

The `MutationTransaction` preview animations and `SelectionGuard` RAF-based
autoscroll should both respect these values.

### Debug and Accessibility Use Cases

| `--tug-timing` | `--tug-motion` | Effect |
|----------------|----------------|--------|
| `1` | `1` | Normal (default) |
| `5` | `1` | Slow motion — debug animations |
| `10` | `1` | Very slow — inspect individual frames |
| `0.5` | `1` | Snappy — everything faster |
| `any` | `0` | No motion — accessibility mode |

Both values can be exposed in the Settings card and persisted in tugbank.

---

## Proposed Naming Grammar

External research suggests a useful combined model:

- Primer contributes `base / functional / component` layering and
  `pattern-property-state` naming.
- Chakra contributes the clarity of `bg / fg / border / focusRing`.
- Carbon contributes role + state families like `hover / active / selected`.
- Spectrum contributes the explicit distinction between aliases and component
  tokens.

### Finalized Grammar (Phase 3.5A)

All structured tokens use the six-slot format:

`--tug-base-<plane>-<component>-<constituent>-<emphasis>-<role>-<state>`

Where:
- **plane**: `element` (visible marks: text, icons, borders) or `surface` (backgrounds)
- **component**: `global`, `control`, `tab`, `tone`, `field`, `badge`, `toggle`, `radio`, etc.
- **constituent**: `text`, `icon`, `border`, `shadow`, `divider`, `fill`, `thumb`, `dot` (elements); `primary`, `track` (surfaces)
- **emphasis**: `normal`, `filled`, `outlined`, `ghost`, `tinted`
- **role**: `plain`, `default`, `accent`, `action`, `danger`, `success`, `caution`, `muted`, `subtle`, etc.
- **state**: `rest`, `hover`, `active`, `focus`, `disabled`, `readOnly`, `mixed`, `inactive`

Examples (finalized names):

- `--tug-base-element-global-text-normal-default-rest`
- `--tug-base-element-global-text-normal-muted-rest`
- `--tug-base-element-global-border-normal-default-rest`
- `--tug-base-element-global-border-normal-accent-hover`
- `--tug-base-surface-control-primary-filled-action-rest`
- `--tug-base-element-tab-text-normal-active-rest`

> *Note: The grammar shown above (`--tug-base-<domain>-<role>[-<emphasis>][-<state>]`) was a draft convention. The finalized convention above supersedes it.*

For component or pattern tokens:

`--tug-comp-<pattern>-<role>[-<state>]`

Examples:

- `--tug-comp-control-border-rest`
- `--tug-comp-button-primary-bg-hover`
- `--tug-comp-menu-item-bg-hover`
- `--tug-comp-table-row-bg-selected`

The important distinction:

- `--tug-base-*` is the shared semantic language.
- `--tug-comp-*` is where a component family binds itself to that shared
  language.

---

## Proposed Token Architecture

### Layer 0: TugColor Palette (`--tug-{hue}[-preset]`, `--tug-{hue}-{constant}`)

Purpose:

- Color primitives defined as pure CSS `oklch()` + `calc()` formulas.
- Declared in a static `tug-palette.css` file — no JS injection required.
- Includes chromatic presets (24 hues × 7 presets), achromatic neutral ramp,
  black/white anchors, per-hue constants, and P3 overrides.
- No component or app-role meaning — purely color primitives.

Examples:

- `--tug-red` — red canonical (i=50, t=50)
- `--tug-red-accent` — red accent preset (i=80, t=50)
- `--tug-orange-subtle` — orange subtle preset (i=15, t=92)
- `--tug-violet-dark` — violet dark preset (i=50, t=25)
- `--tug-neutral` — mid gray (t=50, C=0)
- `--tug-neutral-light` — light gray (t=82, C=0)
- `--tug-black` — pure black (oklch(0 0 0))
- `--tug-white` — pure white (oklch(1 0 0))
- `--tug-red-h: 25` — hue angle constant
- `--tug-red-canonical-l: 0.659` — canonical lightness constant
- `--tug-red-peak-c: 0.346` — peak chroma constant
- `--tug-l-dark: 0.15` — global dark lightness
- `--tug-l-light: 0.96` — global light lightness

Rules:

- Chromatic presets are pure CSS formulas: `oklch(L-calc C-calc h-const)`.
- Per-hue constants (the only values requiring computation) are static —
  derived from `tug-color-canonical.json` and hardcoded in the CSS file.
- 242+ CSS variables: 168 chromatic presets + 74 constants + neutral ramp.
- P3 support: `@media (color-gamut: p3)` overrides `--tug-{hue}-peak-c`
  with wider chroma caps; preset formulas auto-produce richer colors.
- Opacity: CSS relative color syntax (`oklch(from var(...) l c h / alpha)`)
  or `color-mix()` applied at point of use — no precomputed alpha variants.
- All three themes share the same canonical L values and hue angles for now.
- Per-theme tuning (if needed) via overriding per-hue constants in theme CSS.
- No direct component usage — components consume `--tug-base-*` semantics
  that reference these palette variables.

### Layer 0.5: Global Multipliers

These are not palette values but system-level factors that affect how every
other token is consumed.

```css
:root {
  --tug-zoom: 1;    /* multiplies all dimensions */
  --tug-timing: 1;   /* multiplies all durations */
  --tug-motion: 1;   /* 1 = motion on, 0 = motion off */
}
```

Rules:

- Set at the `:root` level.
- Persisted in tugbank (`dev.tugtool.app` domain).
- Overridable by user preferences, accessibility settings, or debug controls.
- `--tug-zoom` drives `zoom` on `<body>` — all size tokens scale automatically without `calc()` wiring.
- Every duration token in Layer 1 includes `var(--tug-timing)` as a factor.

### Layer 1: Canonical Semantics (`--tug-base-*`)

Purpose:

- The stable, readable contract for app and component styling.
- All public semantics live here.

Rules:

- All component styling eventually resolves from this layer.
- No raw palette values in component CSS.
- No `--td-*`, `--tways-*`, or legacy aliases after migration.
- Size tokens are plain values — CSS `zoom` on body handles global scaling.
- All duration tokens include `calc(... * var(--tug-timing))`.

### Layer 2: Component / Pattern Tokens (`--tug-comp-*`)

Purpose:

- Bind a component or component family to shared semantics.
- Allow family-specific tuning without inventing new raw values.

Examples:

- `--tug-comp-button-primary-bg-rest: var(--tug-base-action-primary-bg-rest);`
- `--tug-comp-tab-badge-bg: var(--tug-base-badge-accent-bg);`
- `--tug-comp-card-header-bg-active: var(--tug-base-card-header-bg-active);`
- `--tug-comp-button-zoom: 1;` (component-level zoom override)

Rules:

- May exist only when base semantics are too generic.
- Must resolve entirely from `--tug-base-*`.
- Should prefer family names like `control`, `button`, `field`, `menu`, `tab`,
  `card`, `table`, `inspector` over one-off widget names whenever possible.
- Each component family may declare a `--tug-comp-<family>-zoom` property
  (default `1`) that its internal dimensions multiply by.

---

## `--tug-base-*` Semantic Taxonomy (Phase 3.5A finalized names)

> *This section was originally a draft taxonomy using legacy `fg-` / `bg-` naming. Updated to Phase 3.5A six-slot finalized names.*

All structured tokens follow `<plane>-<component>-<constituent>-<emphasis>-<role>-<state>`.

### A. Foundation Domains

#### Surfaces (global)

- `--tug-base-surface-global-primary-normal-app-rest`
- `--tug-base-surface-global-primary-normal-canvas-rest`
- `--tug-base-surface-global-primary-normal-sunken-rest`
- `--tug-base-surface-global-primary-normal-default-rest`
- `--tug-base-surface-global-primary-normal-raised-rest`
- `--tug-base-surface-global-primary-normal-overlay-rest`
- `--tug-base-surface-global-primary-normal-inset-rest`
- `--tug-base-surface-global-primary-normal-control-rest`
- `--tug-base-surface-global-primary-normal-content-rest`
- `--tug-base-surface-global-primary-normal-screen-rest`

#### Element — Text (global)

- `--tug-base-element-global-text-normal-default-rest`
- `--tug-base-element-global-text-normal-muted-rest`
- `--tug-base-element-global-text-normal-subtle-rest`
- `--tug-base-element-global-text-normal-plain-disabled`
- `--tug-base-element-global-text-normal-inverse-rest`
- `--tug-base-element-global-text-normal-placeholder-rest`
- `--tug-base-element-global-text-normal-link-rest`
- `--tug-base-element-global-text-normal-link-hover`
- `--tug-base-element-global-text-normal-onAccent-rest`
- `--tug-base-element-global-text-normal-onDanger-rest`
- `--tug-base-element-global-text-normal-onSuccess-rest`

#### Element — Icon (global)

- `--tug-base-element-global-icon-normal-default-rest`
- `--tug-base-element-global-icon-normal-muted-rest`
- `--tug-base-element-global-icon-normal-plain-disabled`
- `--tug-base-element-global-icon-normal-active-rest`
- `--tug-base-element-global-icon-normal-onAccent-rest`

#### Borders / Dividers / Focus

- `--tug-base-border-default`
- `--tug-base-border-muted`
- `--tug-base-border-strong`
- `--tug-base-border-inverse`
- `--tug-base-border-accent`
- `--tug-base-border-danger`
- `--tug-base-divider-default`
- `--tug-base-divider-muted`
- `--tug-base-focus-ring-default`
- `--tug-base-focus-ring-danger`
- `--tug-base-focus-ring-offset`

#### Elevation / Overlay

- `--tug-base-shadow-xs`
- `--tug-base-shadow-sm`
- `--tug-base-shadow-md`
- `--tug-base-shadow-lg`
- `--tug-base-shadow-xl`
- `--tug-base-shadow-card-active`
- `--tug-base-shadow-card-inactive`
- `--tug-base-shadow-overlay`
- `--tug-base-overlay-dim`
- `--tug-base-overlay-scrim`
- `--tug-base-overlay-highlight`

#### Typography

Plain values — CSS `zoom` on body handles global scaling.

- `--tug-base-font-family-sans`
- `--tug-base-font-family-mono`
- `--tug-base-font-size-2xs` = `10px`
- `--tug-base-font-size-xs` = `11px`
- `--tug-base-font-size-sm` = `12px`
- `--tug-base-font-size-md` = `14px`
- `--tug-base-font-size-lg` = `16px`
- `--tug-base-font-size-xl` = `20px`
- `--tug-base-font-size-2xl` = `24px`
- `--tug-base-line-height-2xs` = `14px`
- `--tug-base-line-height-xs` = `16px`
- `--tug-base-line-height-sm` = `18px`
- `--tug-base-line-height-md` = `20px`
- `--tug-base-line-height-lg` = `24px`
- `--tug-base-line-height-xl` = `28px`
- `--tug-base-line-height-2xl` = `32px`

#### Spacing

- `--tug-base-space-2xs` = `2px`
- `--tug-base-space-xs` = `4px`
- `--tug-base-space-sm` = `6px`
- `--tug-base-space-md` = `8px`
- `--tug-base-space-lg` = `12px`
- `--tug-base-space-xl` = `16px`
- `--tug-base-space-2xl` = `24px`

#### Radius

- `--tug-base-radius-2xs` = `1px`
- `--tug-base-radius-xs` = `2px`
- `--tug-base-radius-sm` = `4px`
- `--tug-base-radius-md` = `6px`
- `--tug-base-radius-lg` = `8px`
- `--tug-base-radius-xl` = `12px`
- `--tug-base-radius-2xl` = `16px`

#### Stroke

- `--tug-base-stroke-hairline` = `0.5px`
- `--tug-base-stroke-thin` = `1px`
- `--tug-base-stroke-medium` = `1.5px`
- `--tug-base-stroke-thick` = `2px`

#### Icon Size

- `--tug-base-icon-size-2xs` = `10px`
- `--tug-base-icon-size-xs` = `12px`
- `--tug-base-icon-size-sm` = `14px`
- `--tug-base-icon-size-md` = `16px`
- `--tug-base-icon-size-lg` = `20px`
- `--tug-base-icon-size-xl` = `24px`

#### Motion (timed)

All durations include `var(--tug-timing)`:

- `--tug-base-motion-duration-instant` = `calc(0ms * var(--tug-timing))`
- `--tug-base-motion-duration-fast` = `calc(100ms * var(--tug-timing))`
- `--tug-base-motion-duration-moderate` = `calc(200ms * var(--tug-timing))`
- `--tug-base-motion-duration-slow` = `calc(350ms * var(--tug-timing))`
- `--tug-base-motion-duration-glacial` = `calc(500ms * var(--tug-timing))`
- `--tug-base-motion-easing-standard` = `cubic-bezier(0.2, 0, 0, 1)`
- `--tug-base-motion-easing-enter` = `cubic-bezier(0, 0, 0, 1)`
- `--tug-base-motion-easing-exit` = `cubic-bezier(0.2, 0, 1, 1)`

#### Shared Motion Patterns

- `--tug-base-motion-pattern-fade-enter`
- `--tug-base-motion-pattern-fade-exit`
- `--tug-base-motion-pattern-overlay-enter`
- `--tug-base-motion-pattern-overlay-exit`
- `--tug-base-motion-pattern-collapse`
- `--tug-base-motion-pattern-expand`
- `--tug-base-motion-pattern-crossfade`
- `--tug-base-motion-pattern-startup-reveal`

### B. Accent System

This is a first-class domain, not a side note.

#### Palette Foundation

The accent system derives from the TugColor palette. Semantic accent tokens
reference TugColor preset variables:

```css
--tug-base-accent-default: var(--tug-orange);
--tug-base-accent-strong: var(--tug-orange-accent);
--tug-base-accent-muted: var(--tug-orange-muted);
--tug-base-accent-subtle: var(--tug-orange-subtle);
--tug-base-accent-cool-default: var(--tug-cyan);
--tug-base-accent-info: var(--tug-cyan-accent);
--tug-base-accent-positive: var(--tug-green-accent);
--tug-base-accent-warning: var(--tug-yellow-accent);
--tug-base-accent-danger: var(--tug-red-accent);
```

The seven TugColor presets per hue (canonical, accent, muted, light, subtle, dark,
deep) map naturally to semantic accent roles. Because these resolve from the
TugColor palette, all themes share consistent accent behavior.

#### Accent-Derived Interaction Tokens

- `--tug-base-accent-bg-subtle`
- `--tug-base-accent-bg-emphasis`
- `--tug-base-accent-border`
- `--tug-base-accent-border-hover`
- `--tug-base-accent-underline-active`
- `--tug-base-accent-guide`
- `--tug-base-accent-flash`

### C. Selection / Highlight / Preview

- `--tug-base-selection-bg`
- `--tug-base-selection-fg`
- `--tug-base-highlight-hover`
- `--tug-base-highlight-dropTarget`
- `--tug-base-highlight-preview`
- `--tug-base-highlight-inspectorTarget`
- `--tug-base-highlight-snapGuide`
- `--tug-base-highlight-flash`

### D. Workspace Chrome

#### Card

- `--tug-base-card-bg`
- `--tug-base-card-border`
- `--tug-base-card-shadow-active`
- `--tug-base-card-shadow-inactive`
- `--tug-base-card-dim-overlay`

#### Card Header

- `--tug-base-card-header-bg-active`
- `--tug-base-card-header-bg-inactive`
- `--tug-base-card-header-bg-collapsed`
- `--tug-base-card-header-fg`
- `--tug-base-card-header-icon-active`
- `--tug-base-card-header-icon-inactive`
- `--tug-base-card-header-divider`
- `--tug-base-card-header-button-bg-hover`
- `--tug-base-card-header-button-bg-active`
- `--tug-base-card-header-button-fg`
- `--tug-base-card-header-button-fg-danger`
- `--tug-base-card-header-button-fg-danger-hover`
- `--tug-base-card-accessory-bg`
- `--tug-base-card-accessory-border`
- `--tug-base-card-findbar-bg`
- `--tug-base-card-findbar-border`
- `--tug-base-card-findbar-match`
- `--tug-base-card-findbar-match-active`

#### Tab Bar

- `--tug-base-tab-bar-bg`
- `--tug-base-tab-bg-rest`
- `--tug-base-tab-bg-hover`
- `--tug-base-tab-bg-active`
- `--tug-base-tab-bg-compact`
- `--tug-base-tab-fg-rest`
- `--tug-base-tab-fg-active`
- `--tug-base-tab-fg-compact`
- `--tug-base-tab-close-bg-hover`
- `--tug-base-tab-close-fg-hover`
- `--tug-base-tab-underline-active`
- `--tug-base-tab-dropTarget-bg`
- `--tug-base-tab-dropTarget-border`
- `--tug-base-tab-badge-bg`
- `--tug-base-tab-badge-fg`
- `--tug-base-tab-ghost-bg`
- `--tug-base-tab-ghost-border`
- `--tug-base-tab-insertIndicator`
- `--tug-base-tab-overflow-trigger-bg`
- `--tug-base-tab-overflow-trigger-fg`
- `--tug-base-tab-add-bg-hover`
- `--tug-base-tab-add-fg`
- `--tug-base-tab-typePicker-bg`
- `--tug-base-tab-typePicker-fg`

#### Dock / Canvas / Snap

- `--tug-base-dock-bg`
- `--tug-base-dock-border`
- `--tug-base-dock-indicator`
- `--tug-base-dock-menu-caret`
- `--tug-base-dock-button-bg-hover`
- `--tug-base-dock-button-bg-active`
- `--tug-base-dock-button-fg`
- `--tug-base-dock-button-fg-active`
- `--tug-base-dock-button-fg-attention`
- `--tug-base-dock-button-badge-bg`
- `--tug-base-dock-button-badge-fg`
- `--tug-base-dock-button-insertIndicator`
- `--tug-base-canvas-grid-line`
- `--tug-base-canvas-grid-emphasis`
- `--tug-base-snap-guide`
- `--tug-base-sash-hover`
- `--tug-base-flash-perimeter`

#### Snap Sets

- `--tug-base-set-member-border-collapsed`
- `--tug-base-set-member-corner-squared`
- `--tug-base-set-focused-outline`
- `--tug-base-set-hull-flash`
- `--tug-base-set-breakout-flash`
- `--tug-base-set-dropTarget`

### E. Actions and Generic Controls

This follows Primer's useful idea of generic `control` patterns, not just
component-by-component naming.

#### Cross-Control Disabled Contract

Disabled controls should be treated as a first-class system state, not as an
afterthought handled ad hoc by opacity alone.

Every interactive control family should be able to derive its disabled
presentation from a shared base contract, with component-specific overrides
only when necessary.

Core disabled-control tokens:

- `--tug-base-control-disabled-bg`
- `--tug-base-control-disabled-fg`
- `--tug-base-control-disabled-border`
- `--tug-base-control-disabled-icon`
- `--tug-base-control-disabled-opacity`
- `--tug-base-control-disabled-shadow`

These are the cross-control defaults for disabled presentation. More specific
control families may override them through the action, field, toggle, range, or
menu-item domains below, but they should not invent unrelated disabled styling
rules.

#### Generic Action Tokens

- `--tug-base-action-primary-bg-rest`
- `--tug-base-action-primary-bg-hover`
- `--tug-base-action-primary-bg-active`
- `--tug-base-action-primary-fg`
- `--tug-base-action-primary-border`
- `--tug-base-action-secondary-bg-rest`
- `--tug-base-action-secondary-bg-hover`
- `--tug-base-action-secondary-bg-active`
- `--tug-base-action-secondary-fg`
- `--tug-base-action-secondary-border`
- `--tug-base-action-ghost-bg-hover`
- `--tug-base-action-ghost-fg`
- `--tug-base-action-destructive-bg-rest`
- `--tug-base-action-destructive-bg-hover`
- `--tug-base-action-destructive-bg-active`
- `--tug-base-action-destructive-fg`
- `--tug-base-action-destructive-border`
- `--tug-base-action-disabled-bg`
- `--tug-base-action-disabled-fg`
- `--tug-base-action-disabled-border`

#### Generic Field Tokens

- `--tug-base-field-bg-rest`
- `--tug-base-field-bg-hover`
- `--tug-base-field-bg-focus`
- `--tug-base-field-bg-disabled`
- `--tug-base-field-bg-readOnly`
- `--tug-base-field-fg`
- `--tug-base-field-fg-disabled`
- `--tug-base-field-fg-readOnly`
- `--tug-base-field-placeholder`
- `--tug-base-field-border-rest`
- `--tug-base-field-border-hover`
- `--tug-base-field-border-focus`
- `--tug-base-field-border-invalid`
- `--tug-base-field-border-valid`
- `--tug-base-field-border-disabled`
- `--tug-base-field-border-readOnly`
- `--tug-base-field-helper`
- `--tug-base-field-label`
- `--tug-base-field-required`
- `--tug-base-field-meta`
- `--tug-base-field-counter`
- `--tug-base-field-limit`
- `--tug-base-field-dirty`
- `--tug-base-field-readOnly`
- `--tug-base-field-error`
- `--tug-base-field-warning`
- `--tug-base-field-success`

#### Toggle / Range Tokens

- `--tug-base-toggle-track-off`
- `--tug-base-toggle-track-on`
- `--tug-base-toggle-track-disabled`
- `--tug-base-toggle-track-mixed`
- `--tug-base-toggle-thumb`
- `--tug-base-toggle-thumb-disabled`
- `--tug-base-toggle-icon-disabled`
- `--tug-base-toggle-icon-mixed`
- `--tug-base-checkmark`
- `--tug-base-checkmark-mixed`
- `--tug-base-radio-dot`
- `--tug-base-range-track`
- `--tug-base-range-fill`
- `--tug-base-range-thumb`
- `--tug-base-range-thumb-disabled`
- `--tug-base-range-tick`
- `--tug-base-range-scrub-active`
- `--tug-base-range-label`
- `--tug-base-range-annotation`
- `--tug-base-range-value`

### F. Menus, Overlays, Modalities, Feedback

#### Menu / Popover / Tooltip

- `--tug-base-menu-bg`
- `--tug-base-menu-fg`
- `--tug-base-menu-border`
- `--tug-base-menu-shadow`
- `--tug-base-menu-item-bg-hover`
- `--tug-base-menu-item-bg-selected`
- `--tug-base-menu-item-fg`
- `--tug-base-menu-item-fg-disabled`
- `--tug-base-menu-item-fg-danger`
- `--tug-base-menu-item-meta`
- `--tug-base-menu-item-shortcut`
- `--tug-base-menu-item-icon`
- `--tug-base-menu-item-icon-danger`
- `--tug-base-menu-item-chevron`
- `--tug-base-popover-bg`
- `--tug-base-popover-fg`
- `--tug-base-popover-border`
- `--tug-base-tooltip-bg`
- `--tug-base-tooltip-fg`
- `--tug-base-tooltip-border`

#### Dialog / Sheet / Toast / Alert

- `--tug-base-dialog-bg`
- `--tug-base-dialog-fg`
- `--tug-base-dialog-border`
- `--tug-base-sheet-bg`
- `--tug-base-sheet-fg`
- `--tug-base-sheet-border`
- `--tug-base-toast-info-bg`
- `--tug-base-toast-info-fg`
- `--tug-base-toast-success-bg`
- `--tug-base-toast-success-fg`
- `--tug-base-toast-warning-bg`
- `--tug-base-toast-warning-fg`
- `--tug-base-toast-danger-bg`
- `--tug-base-toast-danger-fg`
- `--tug-base-alert-bg`
- `--tug-base-alert-fg`

#### Status / Badge / Progress / Skeleton / Banner

- `--tug-base-badge-neutral-bg`
- `--tug-base-badge-neutral-fg`
- `--tug-base-badge-accent-bg`
- `--tug-base-badge-accent-fg`
- `--tug-base-badge-success-bg`
- `--tug-base-badge-success-fg`
- `--tug-base-badge-warning-bg`
- `--tug-base-badge-warning-fg`
- `--tug-base-badge-danger-bg`
- `--tug-base-badge-danger-fg`
- `--tug-base-status-success`
- `--tug-base-status-warning`
- `--tug-base-status-danger`
- `--tug-base-status-info`
- `--tug-base-progress-track`
- `--tug-base-progress-fill`
- `--tug-base-spinner`
- `--tug-base-skeleton-base`
- `--tug-base-skeleton-highlight`
- `--tug-base-emptyState-fg`
- `--tug-base-emptyState-icon`
- `--tug-base-banner-info-bg`
- `--tug-base-banner-info-fg`
- `--tug-base-banner-warning-bg`
- `--tug-base-banner-warning-fg`
- `--tug-base-banner-danger-bg`
- `--tug-base-banner-danger-fg`
- `--tug-base-kbd-bg`
- `--tug-base-kbd-fg`
- `--tug-base-kbd-border`

#### Scroll Area / Separator / Avatar

- `--tug-base-scrollbar-track`
- `--tug-base-scrollbar-thumb`
- `--tug-base-scrollbar-thumb-hover`
- `--tug-base-separator`
- `--tug-base-avatar-bg`
- `--tug-base-avatar-fg`
- `--tug-base-avatar-ring`

### G. Tables, Lists, Stats, Visualization

#### Table / List

- `--tug-base-table-header-bg`
- `--tug-base-table-header-fg`
- `--tug-base-table-row-bg`
- `--tug-base-table-row-bg-striped`
- `--tug-base-table-row-bg-hover`
- `--tug-base-table-row-bg-selected`
- `--tug-base-table-row-border`
- `--tug-base-table-cell-divider`
- `--tug-base-table-sortIndicator`
- `--tug-base-list-row-hover`
- `--tug-base-list-row-selected`

#### Stat / Trend

- `--tug-base-stat-label`
- `--tug-base-stat-value`
- `--tug-base-stat-trend-positive`
- `--tug-base-stat-trend-negative`
- `--tug-base-stat-trend-neutral`

#### Chart / Gauge

Chart series colors reference TugColor palette presets:

- `--tug-base-chart-series-warm` = `var(--tug-orange)`
- `--tug-base-chart-series-cool` = `var(--tug-cyan)`
- `--tug-base-chart-series-violet` = `var(--tug-violet)`
- `--tug-base-chart-series-rose` = `var(--tug-rose)`
- `--tug-base-chart-series-verdant` = `var(--tug-green)`
- `--tug-base-chart-series-golden` = `var(--tug-gold)`
- `--tug-base-chart-series-orchid` = `var(--tug-purple)`
- `--tug-base-chart-series-coral` = `var(--tug-coral)`

Gauge and chart infrastructure tokens:

- `--tug-base-chart-grid`
- `--tug-base-chart-axis`
- `--tug-base-chart-tick`
- `--tug-base-chart-threshold-warning`
- `--tug-base-chart-threshold-danger`
- `--tug-base-gauge-track`
- `--tug-base-gauge-fill`
- `--tug-base-gauge-needle`
- `--tug-base-gauge-tick-major`
- `--tug-base-gauge-tick-minor`
- `--tug-base-gauge-readout`
- `--tug-base-gauge-threshold-warning`
- `--tug-base-gauge-threshold-danger`
- `--tug-base-gauge-unit`
- `--tug-base-gauge-annotation`

### H. Syntax, Terminal, Code-Oriented Domains

The existing code already declares syntax and chart families. Those should not
be treated as optional extras.

#### Syntax

- `--tug-base-syntax-keyword`
- `--tug-base-syntax-string`
- `--tug-base-syntax-number`
- `--tug-base-syntax-function`
- `--tug-base-syntax-type`
- `--tug-base-syntax-variable`
- `--tug-base-syntax-comment`
- `--tug-base-syntax-operator`
- `--tug-base-syntax-punctuation`
- `--tug-base-syntax-constant`
- `--tug-base-syntax-decorator`
- `--tug-base-syntax-tag`
- `--tug-base-syntax-attribute`

#### Terminal

- `--tug-base-terminal-bg`
- `--tug-base-terminal-fg`
- `--tug-base-terminal-fg-muted`
- `--tug-base-terminal-cursor`
- `--tug-base-terminal-selection-bg`
- `--tug-base-terminal-border`
- `--tug-base-terminal-ansi-black`
- `--tug-base-terminal-ansi-red`
- `--tug-base-terminal-ansi-green`
- `--tug-base-terminal-ansi-yellow`
- `--tug-base-terminal-ansi-blue`
- `--tug-base-terminal-ansi-magenta`
- `--tug-base-terminal-ansi-cyan`
- `--tug-base-terminal-ansi-white`

#### Conversation / Chat / Code Block

- `--tug-base-chat-transcript-bg`
- `--tug-base-chat-message-user-bg`
- `--tug-base-chat-message-assistant-bg`
- `--tug-base-chat-message-system-bg`
- `--tug-base-chat-message-border`
- `--tug-base-chat-composer-bg`
- `--tug-base-chat-composer-border`
- `--tug-base-chat-attachment-bg`
- `--tug-base-chat-attachment-border`
- `--tug-base-chat-attachment-fg`
- `--tug-base-codeBlock-bg`
- `--tug-base-codeBlock-border`
- `--tug-base-codeBlock-header-bg`
- `--tug-base-codeBlock-header-fg`

#### Files / Git / Tree

- `--tug-base-tree-row-bg-hover`
- `--tug-base-tree-row-bg-selected`
- `--tug-base-tree-row-bg-current`
- `--tug-base-tree-row-fg`
- `--tug-base-tree-chevron`
- `--tug-base-file-status-added`
- `--tug-base-file-status-modified`
- `--tug-base-file-status-deleted`
- `--tug-base-file-status-renamed`
- `--tug-base-diff-addition-bg`
- `--tug-base-diff-addition-fg`
- `--tug-base-diff-deletion-bg`
- `--tug-base-diff-deletion-fg`

#### Workflow / Feed Progress

- `--tug-base-feed-bg`
- `--tug-base-feed-border`
- `--tug-base-feed-step-bg`
- `--tug-base-feed-step-fg`
- `--tug-base-feed-step-active`
- `--tug-base-feed-step-complete`
- `--tug-base-feed-step-error`
- `--tug-base-feed-stream-cursor`
- `--tug-base-feed-handoff`

### I. Inspector / Dev Tooling

This category is required by the roadmap and by the requested hover inspector.

- `--tug-base-inspector-panel-bg`
- `--tug-base-inspector-panel-border`
- `--tug-base-inspector-panel-bg-pinned`
- `--tug-base-inspector-section-bg`
- `--tug-base-inspector-field-bg`
- `--tug-base-inspector-field-border`
- `--tug-base-inspector-field-readOnly`
- `--tug-base-inspector-field-inherited`
- `--tug-base-inspector-field-default`
- `--tug-base-inspector-field-preview`
- `--tug-base-inspector-field-cancelled`
- `--tug-base-inspector-target-outline`
- `--tug-base-inspector-preview-outline`
- `--tug-base-inspector-source-token`
- `--tug-base-inspector-source-class`
- `--tug-base-inspector-source-inline`
- `--tug-base-inspector-source-preview`
- `--tug-base-inspector-emptyState-fg`
- `--tug-base-inspector-emptyState-icon`
- `--tug-base-inspector-swatch-border`
- `--tug-base-inspector-scrub-track`
- `--tug-base-inspector-scrub-thumb`
- `--tug-base-inspector-scrub-active`
- `--tug-base-dev-overlay-bg`
- `--tug-base-dev-overlay-fg`
- `--tug-base-dev-overlay-border`
- `--tug-base-dev-overlay-targetHighlight`
- `--tug-base-dev-overlay-targetDim`

### J. Required Component Token Families

Some of the roadmap gaps are not solved by base semantics alone. These
component-token families should be treated as expected parts of the system.

- Dock and titlebar controls:
  - `--tug-comp-dock-button-*`
  - `--tug-comp-titlebar-button-*`
  - `--tug-comp-titlebar-accessory-*`
- Tab overflow and type picker:
  - `--tug-comp-tab-overflow-*`
  - `--tug-comp-tab-add-*`
  - `--tug-comp-tab-typePicker-*`
- Field metadata and range controls:
  - `--tug-comp-field-meta-*`
  - `--tug-comp-slider-annotation-*`
  - `--tug-comp-slider-value-*`
- Menu metadata:
  - `--tug-comp-menu-shortcut-*`
  - `--tug-comp-menu-icon-*`
  - `--tug-comp-menu-chevron-*`
- Visualization:
  - `--tug-comp-gauge-annotation-*`
  - `--tug-comp-gauge-threshold-*`
- Domain surfaces:
  - `--tug-comp-chat-*`
  - `--tug-comp-codeBlock-*`
  - `--tug-comp-tree-*`
  - `--tug-comp-feed-*`
  - `--tug-comp-sectionPanel-*`
- Tooling:
  - `--tug-comp-inspector-property-*`
  - `--tug-comp-devOverlay-*`
  - `--tug-comp-keybindingEditor-*`
- Scale overrides:
  - `--tug-comp-button-zoom`
  - `--tug-comp-tab-zoom`
  - `--tug-comp-dock-zoom`
  - `--tug-comp-card-header-zoom`
  - `--tug-comp-field-zoom`
  - `--tug-comp-menu-zoom`
  - `--tug-comp-badge-zoom`
  - `--tug-comp-tooltip-zoom`
  - `--tug-comp-gauge-zoom`

---

## Accent Migration Map

The current accent contract needs a direct mapping so the migration is explicit.

### Current -> Proposed

| Current | Proposed |
|---------|----------|
| `--td-accent` | `--tug-base-accent-default` = `var(--tug-orange)` |
| `--td-accent-strong` | `--tug-base-accent-strong` = `var(--tug-orange-accent)` |
| `--td-accent-cool` | `--tug-base-accent-cool-default` = `var(--tug-cyan)` |
| `--td-accent-1` | `var(--tug-orange)` |
| `--td-accent-2` | `var(--tug-cyan)` |
| `--td-accent-3` | `var(--tug-violet)` |
| `--td-accent-4` | `var(--tug-red)` |
| `--td-accent-5` | `var(--tug-green)` |
| `--td-accent-6` | `var(--tug-yellow)` |
| `--td-accent-7` | `var(--tug-magenta)` |
| `--td-accent-8` | `var(--tug-coral-muted)` |

### Derived Semantic Roles

| Current | Proposed |
|---------|----------|
| `--td-success` (accent 5) | `--tug-base-accent-positive` = `var(--tug-green-accent)` |
| `--td-warning` (accent 6) | `--tug-base-accent-warning` = `var(--tug-yellow-accent)` |
| `--td-danger` (accent 4) | `--tug-base-accent-danger` = `var(--tug-red-accent)` |
| `--td-info` (accent 2) | `--tug-base-accent-info` = `var(--tug-cyan-accent)` |

### Why This Is Better

- Chart, syntax, and multi-series visualization still get a stable expressive
  palette — now with 7 named presets per hue plus programmatic `tugColor()` for
  arbitrary i/t combinations.
- Component authors no longer consume meaningless ordinals.
- Semantic roles such as info/warning/danger stop depending on "knowing" what
  accent number means what.
- Any hue at any intensity/tone is available on demand via `tugColor()`.

---

## Legacy Removal Policy

The following are scheduled for full remot:

- `--td-*`
- `--tways-*`
- All legacy alias variables: `--background`, `--foreground`, `--card`,
  `--primary`, `--accent`, `--destructive`, `--chart-*`, `--syntax-*`.

### But the Bridge Must Be Deliberate

Because shadcn/Tailwind still relies on those names, migration must happen in
three passes:

1. Introduce `--tug-base-*` and `--tug-comp-*`.
2. Repoint the Tailwind/shadcn bridge from legacy aliases to new tokens.
3. Remove legacy alias declarations after all consumers are migrated.

This proposal rejects permanent legacy aliases. It does not reject temporary
migration shims.

---

## Dev-Mode `Ctrl+Option + Hover` Cascade Inspector

### Interaction Model

- Only available in dev mode.
- Hold `Ctrl+Option`.
- Hover any inspectable component or widget.
- A floating overlay appears near the cursor or pinned panel edge.

The overlay should show:

- Component or pattern identity.
- DOM path and class list.
- Selected computed properties: background, foreground, border, shadow, radius,
  typography.
- Full resolution chain for each inspected property:
  - Computed value.
  - Source CSS rule.
  - `--tug-comp-*` token if present.
  - `--tug-base-*` token it resolves from.
  - `--tug-{hue}[-preset]` palette value beneath that (including the hue family
    name, preset name, and TugColor coordinates: intensity/tone/canonical L).
- Current `--tug-zoom` and `--tug-timing` values and their effect on the
  inspected element's dimensions and transitions.

### Technical Direction

This should build on the roadmap's existing inspector architecture:

- `StyleCascadeReader`.
- Mutation transactions.
- Property store.
- Responder-chain-aware inspector panels.

Recommended implementation:

1. Add a dev-only `StyleInspectorOverlay` singleton.
2. Track global modifier state for `Ctrl+Option`.
3. On pointer move with modifiers active:
   - Locate target with `elementFromPoint`.
   - Walk up to the nearest inspect root.
   - Read computed style.
   - Resolve token chain using a cascade reader utility.
4. Highlight the target element with a dev-only overlay token.
5. Allow pin/unpin so the user can stop live-hover and inspect in place.
6. `Escape` closes the overlay.

### Why This Belongs in the Theme Machinery

Because the point is not generic DOM inspection. The point is to expose the
tugways style contract:

- Which `--tug-comp-*` token applied.
- Which `--tug-base-*` semantic is responsible.
- Which theme primitive supplied the value.
- For TugColor palette colors: which hue family, preset name, and TugColor coordinates
  (intensity/tone) produced the value.
- What multiplier effects `--tug-zoom` and `--tug-timing` have on the
  element.

This makes the style system navigable instead of mystical.

---

## Migration Strategy

### Phase A: Inventory and Rename Spec

1. Freeze new additions under old prefixes.
2. Produce a definitive token mapping table.
3. Inventory all consumers in:
   - `tugdeck/styles/*.css`
   - `tugdeck/src/components/tugways/**/*.css`
   - `tugdeck/src/components/ui/**/*.tsx`
   - Runtime style token readers/writers in TS.

### Phase B: Introduce New Layers

1. Implement the TugColor palette engine. **DONE** — Pure CSS formulas in `tug-palette.css` generate ~200 CSS variables with P3 support. `tugColor()` JS API for programmatic access.
2. Add `--tug-{hue}[-preset]` computed variables and per-hue constants. **DONE.**
3. Add `--tug-zoom`, `--tug-timing`, `--tug-motion` global multipliers. **DONE** — `--tug-zoom` drives `zoom: var(--tug-zoom)` on `<body>`, scaling the entire UI. Timing and motion work correctly.
4. Add `--tug-base-*` with scaled dimensions and timed durations. **DONE** (Phase 5d5c) — but chromatic tokens used hardcoded hex, not TugColor palette references. Phase 5d5e will wire them.
5. Add `--tug-comp-*` where needed, including component-level zoom overrides. **DONE** (Phase 5d5c).
6. Add `--tug-neutral-*` achromatic ramp and `--tug-black`/`--tug-white` anchors. Planned for Phase 5d5e.
6. Keep temporary aliases from old tokens to new tokens.

### Phase C: Migrate Consumers

1. Move tugways component CSS first.
2. Move chrome CSS.
3. Move globals/Tailwind bridge.
4. Move shadcn wrapper assumptions.
5. Move chart/syntax consumers.

### Phase D: Remove Migration Debris

1. Remove `--td-*`.
2. Remove `--tways-*`.
3. Remove legacy aliases.
4. Add search-based enforcement checks.

### Phase E: Add Dev Inspector

1. Implement `Ctrl+Option + hover` live inspector.
2. Add gallery demo coverage.
3. Add dev-only documentation and verification checklist.

---

## Risks

### 1. Visual Drift During Rename

Mitigation: keep a temporary old-to-new mapping layer. Verify Brio/Bluenote/
Harmony parity after each migration slice.

### 2. Hidden Dependence on Legacy Aliases

Mitigation: static search in CSS and TS, explicit audit of `components/ui/*`,
targeted runtime checks where `getComputedStyle` is involved.

### 3. Token Explosion

Mitigation: use the grammar above, prefer shared pattern domains (`control`,
`field`, `menu`, `table`) before inventing one-off component tokens, require
that every new `--tug-comp-*` resolves from existing `--tug-base-*`.

### 4. Computed Palette Performance

Mitigation: pre-compute 242 CSS variables (168 presets + 74 constants) at
startup. This is a one-time cost of < 1ms. Arbitrary i/t combinations are
computed on demand via `tugColor()`, which is pure math with no DOM access.
**RESOLVED** — implemented and verified.

### 5. OKLCH Gamut Clipping

Mitigation: the TugColor palette engine includes per-hue chroma capping derived via
binary search at three L sample points (L_DARK, canonical L, L_LIGHT) for both
sRGB and P3 gamuts. A 2% safety margin prevents clipping.
**RESOLVED** — implemented with `MAX_CHROMA_FOR_HUE` and `MAX_P3_CHROMA_FOR_HUE`
static tables, verified by unit tests.

### 6. `calc()` with `var()` Browser Compatibility

Mitigated. The zoom-based scale approach (`zoom: var(--tug-zoom)` on body)
eliminates all `calc(<value> * var(--tug-zoom))` expressions for dimension
tokens. The only remaining `calc()` usage is for duration tokens
(`calc(<base> * var(--tug-timing))`), which works in all modern browsers.
Since tugdeck targets a known WebView (WKWebView on macOS), browser
compatibility is controlled.

### 7. Inspector Performance Overhead

Mitigation: dev-mode only, throttle pointer processing, cache cascade-resolution
results per element while hovered.

---

## Definition of Done

1. No `--td-*` tokens remain in source.
2. No `--tways-*` tokens remain in source.
3. No legacy alias tokens remain in source.
4. All current accent use cases have explicit replacements.
5. Chart and syntax token families are preserved under the new contract.
6. Tugways component CSS consumes `--tug-base-*` and `--tug-comp-*` only.
7. Theme files own only `--tug-palette-*` primitives (plus engine parameters).
8. The Tailwind/shadcn bridge points at the new canonical layer.
9. The TugColor palette engine computes 242 CSS variables (168 presets + 74
   constants) at startup, with P3 overrides in a `@media (color-gamut: p3)` block.
10. `--tug-zoom` resizes the entire UI when changed. Verified at 0.85, 1.0,
    1.25, and 1.5.
11. `--tug-timing` scales all animation durations when changed. Verified at 0.5,
    1.0, and 5.0.
12. `--tug-motion: 0` disables all motion. Verified with `prefers-reduced-motion`
    and manual toggle.
13. Dev-mode `Ctrl+Option + hover` inspector can show full cascade resolution
    for hovered components, including TugColor palette provenance (hue/preset/i/t).

---

## Recommended Next Steps

Implementation status and remaining work across six sub-phases:

1. **Phase 5d5a: TugColor Palette Engine** — **COMPLETE.** TugColor palette engine
   with 24 hue families, 5 presets per hue, short-form `--tug-{hue}[-preset]`
   CSS variables, P3 wide-gamut support, `tugColor()` JS API. Pure CSS formulas
   in `tug-palette.css`. All legacy anchor/smoothstep/tone code removed.

2. **Phase 5d5b: Global Scale & Timing** — **COMPLETE.** `--tug-zoom` drives
   `zoom: var(--tug-zoom)` on `<body>`, scaling the entire UI with one number.
   `--tug-timing` multiplies all durations via calc(). `--tug-motion` toggles
   motion on/off. Gallery demo with scale slider (applies on release), timing
   slider, and motion toggle. The zoom-based approach eliminates the need for
   per-token `calc()` dimension wiring and component rewrites for scale — this
   massively simplifies Phases 5d5c and 5d5d.

3. **Phase 5d5c: Token Architecture** — **COMPLETE.** Introduced `--tug-base-*`
   and `--tug-comp-*` token layers with the full semantic taxonomy (~300 tokens)
   in `tug-tokens.css` and `tug-comp-tokens.css`. Added temporary backward-
   compatibility aliases in `tokens.css`. Theme override files (`bluenote.css`,
   `harmony.css`) created. However, all chromatic `--tug-base-*` tokens used
   hardcoded hex values instead of `var(--tug-{hue})` palette references —
   the TugColor palette integration was deferred and is now Phase 5d5e.

4. **Phase 5d5d: Consumer Migration** — **COMPLETE.** Migrated all CSS and TS
   consumers from `--td-*`/`--tways-*` to `--tug-base-*`/`--tug-comp-*`.
   Rewrote the Tailwind/shadcn `@theme` bridge. Removed legacy aliases. Added
   `check-legacy-tokens.sh` CI enforcement script. Merged as PR #98. All
   consumers now point at `--tug-base-*` tokens — but those tokens still
   resolve to hardcoded hex values, not the TugColor palette.

5. **Phase 5d5e: Palette Engine Integration** — Wire `--tug-base-*` chromatic
   tokens to the TugColor palette. Convert the palette layer from JS-injected
   `oklch()` strings to pure CSS formulas using `oklch()` + `calc()` + per-hue
   constants. Add `--tug-neutral-*` achromatic ramp [D75]. Wire accent, chart,
   syntax, status, and all other chromatic semantic tokens to `var(--tug-{hue}
   [-preset])` references as specified in the proposal. Update theme override
   files (`bluenote.css`, `harmony.css`) to override hue assignments rather
   than hardcoded hex values. This is the missing link between the implemented
   palette engine and the consumer-facing tokens.

6. **Phase 5d5f: Cascade Inspector** — Dev-mode `Ctrl+Option + hover` overlay,
   TugColor palette provenance display (hue/preset/i/t), scale/timing readout.

Each sub-phase has its own tugplan. See `tugways-implementation-strategy.md` for
the full phase descriptions and dependency map.

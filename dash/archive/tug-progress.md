# Progress Indication System

*A unified approach to communicating work-in-progress — from spinning petals to filling bars, from "something's happening" to "30% complete."*

---

## The Problem with "tug-spinner" and "tug-progress"

The roadmap lists these as separate components:
- **tug-spinner** — "Size variants, replaces ad-hoc loading visuals"
- **tug-progress** — "Bar, percentage, indeterminate mode"

But these aren't really separate concepts. They're different **visual treatments** of the same **semantic concept**: progress indication. A spinner is an indeterminate progress indicator. A progress bar can be determinate *or* indeterminate. The barber pole (already prototyped in the Scale & Timing gallery) transitions from indeterminate to determinate.

Separating them by visual treatment leads to:
- Duplicate data-source coupling logic
- Inconsistent APIs for the same semantic operation
- No path for transitioning between states (indeterminate → determinate)
- No framework for adding new visual treatments later

---

## Design Intent

One semantic component — **TugProgress** — with pluggable visual treatments. The component owns the data model (indeterminate vs. determinate, value, label, ARIA). The visual treatment is selected via a `variant` prop and rendered by an internal sub-component.

### Architecture: Control + Label

TugProgress follows the same structural pattern as TugCheckbox and TugRadioGroup: a **control** portion (the visual indicator) paired with a **label** portion (text describing the progress).

```
┌─────────────────────────────────────────┐
│  [control]  Label text here             │   ← spinner variant
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Uploading files... 47%                 │   ← bar variant, label above
│  ████████████████░░░░░░░░░░░░░░░░░░░░░░ │
└─────────────────────────────────────────┘
```

The outer **TugProgress** component owns:
- Mode logic (indeterminate vs. determinate via `value`)
- Label rendering and positioning
- ARIA (`role="progressbar"`, `aria-valuenow`, etc.)
- `data-slot`, `forwardRef`, `className`, `...rest`
- Role color injection
- TugBox disabled cascade

The inner **variant components** own:
- Visual rendering only (petals, bar+fill, ring arc)
- Their own CSS (animations, sizing)
- Accept: `value`, `max`, `size`, and inherited CSS variables for color

### The Two Modes

| Mode | Data | Visual Feedback | Example |
|------|------|----------------|---------|
| **Indeterminate** | No value — just "working" | Continuous animation (spinner, barber pole) | "Loading...", "Connecting..." |
| **Determinate** | 0–1 (or 0–max) numeric value | Filling bar, percentage, label | "3 of 10", "47% complete" |

### The Transition

A progress indicator starts indeterminate ("we know work has started but not how much") and may transition to determinate ("now we know it's 30% done"). This transition must be smooth — no jarring visual jump. The component handles this by:

1. Starting with an indeterminate animation
2. When a `value` is first provided, cross-fading to the determinate visual
3. From then on, the bar fills / percentage updates normally

---

## File Structure

```
tugways/
  tug-progress.tsx           ← public API: mode, label, ARIA, variant dispatch
  tug-progress.css           ← layout: control + label positioning, label typography
  internal/
    tug-progress-spinner.tsx  ← petals rendering (visual only)
    tug-progress-spinner.css  ← petals ring animation, sizing
    tug-progress-bar.tsx      ← track + fill rendering (visual only)
    tug-progress-bar.css      ← bar fill, barber-pole animation, transition
    tug-progress-ring.tsx     ← SVG circular arc rendering (visual only)
    tug-progress-ring.css     ← ring arc animation, sizing
```

The internal components are **not independently importable by app code** — they're building blocks composed by TugProgress, following the same pattern as `internal/tug-button.tsx`. Each internal component:
- Opens with "Internal building block — app code should use TugProgress instead."
- Has `data-slot` (e.g., `data-slot="tug-progress-spinner"`)
- Receives `value`, `max`, `size`, `disabled` as props
- Reads `--tugx-progress-fill` from inherited CSS variables for color
- Renders the visual indicator and nothing else
- Owns its own CSS for animations and sizing
- Does NOT handle ARIA, label, or mode logic

### Disabled behavior

When TugProgress is disabled (via prop or TugBox cascade):
- Indeterminate animations **freeze** (CSS `animation-play-state: paused`)
- Fill/spinner/ring colors dim via `opacity: var(--tugx-control-disabled-opacity)`
- Label text uses disabled color token
- The component remains visible but clearly inactive

### Motion compliance [L13]

All animation durations scale via `calc(Xms * var(--tug-timing, 1))` for global timing control. When `data-tug-motion="off"` is set on `<body>`, the global `animation-duration: 0s !important` rule suppresses all progress animations — both existing patterns already established in the petals/pole prototypes.

---

## Visual Treatments (Variants)

### `"spinner"` — The Petals

The existing 8-petal ring animation from `gallery.css`. Indeterminate only visually — spinners don't show determinate progress in the graphic itself. When determinate, the spinner remains spinning while the **label** shows the progress text.

| Mode | Visual |
|------|--------|
| Indeterminate | Spinning petals |
| Determinate | Spinning petals + text label ("47%", "3 of 10") |

Layout: spinner to the left, label to the right. Vertically centered.

### `"bar"` — The Progress Bar

A horizontal track with a filling region. Supports both modes natively.

| Mode | Visual |
|------|--------|
| Indeterminate | Barber-pole diagonal stripes animating continuously |
| Determinate | Solid fill advancing left-to-right |

Layout: label above the bar. Label can show percentage, counts, or description.

The indeterminate → determinate transition: the barber-pole stripes dissolve into a solid fill at the current value position, then the fill grows normally.

### `"ring"` — Circular Progress

A circular arc that fills clockwise from 12 o'clock. Common in mobile UIs, timers, and dashboard widgets.

| Mode | Visual |
|------|--------|
| Indeterminate | Arc segment chasing around the ring (rotating dash) |
| Determinate | Arc growing from 0° to 360° proportional to value |

Implementation: SVG `<circle>` with `stroke-dasharray` and `stroke-dashoffset`. The indeterminate animation rotates the dash segment. The determinate arc length is set imperatively via `stroke-dashoffset` [L06]. Same token-driven fill color as the bar variant.

Layout: same as spinner — control left, label right. Vertically centered.

---

## Data Source: TugProgressSource

Progress data comes from external systems — API calls, file uploads, build processes, agent workflows. The component needs a clean way to receive updates without tight coupling.

### Option A: Props-only (simple)

The simplest approach. The parent component manages state and passes `value` / `max` / `label` as props. React re-renders handle updates.

```tsx
const [progress, setProgress] = useState<number | undefined>(undefined);

// Later, when we know the total:
setProgress(0.3); // 30%

<TugProgress value={progress} label="Uploading..." />
```

When `value` is `undefined`, the component is indeterminate. When `value` is a number (0–1), it's determinate.

### Option B: External store via useSyncExternalStore [L02]

For high-frequency updates (many per second) where React re-renders would be wasteful. A `TugProgressStore` object provides `subscribe` and `getSnapshot` — the component reads progress imperatively.

```typescript
class TugProgressStore {
  private value: number | undefined = undefined;
  private label: string | undefined = undefined;
  private listeners = new Set<() => void>();

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getSnapshot(): TugProgressSnapshot {
    return { value: this.value, label: this.label };
  }

  // Called by the external system
  update(value: number | undefined, label?: string): void {
    this.value = value;
    this.label = label;
    this.listeners.forEach(cb => cb());
  }
}
```

The component can accept either props or a store:

```tsx
// Props mode (simple)
<TugProgress value={0.3} label="Uploading..." />

// Store mode (high-frequency)
<TugProgress source={uploadProgressStore} />
```

### Recommendation: Start with Props, Design for Store

Props-only is sufficient for v1. The `source` prop and `TugProgressStore` are designed but not built until a concrete high-frequency use case demands them. The component's internal implementation reads from a unified snapshot either way — switching from props to store is a non-breaking addition.

---

## Props

```typescript
export type TugProgressVariant = "spinner" | "bar" | "ring";
export type TugProgressSize = "sm" | "md" | "lg";

/**
 * Semantic role for the progress fill / spinner / ring color.
 * Same union as other role-injected controls, but defined locally —
 * TugProgress is not a group-family component and should not import
 * from tug-group-utils.
 *
 * NOTE: If this role union continues to duplicate across components,
 * consider extracting to a shared location (e.g., internal/tug-roles.ts).
 */
export type TugProgressRole =
  | "option" | "action" | "agent" | "data"
  | "success" | "caution" | "danger";

export interface TugProgressProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "role" | "children"> {
  /**
   * Visual treatment.
   * @selector .tug-progress-spinner | .tug-progress-bar | .tug-progress-ring
   * @default "spinner"
   */
  variant?: TugProgressVariant;

  /**
   * Progress value, 0 to max. When undefined, the indicator is indeterminate.
   * When a number, the indicator shows determinate progress.
   * The transition from undefined → number triggers the indeterminate-to-determinate
   * visual crossfade.
   */
  value?: number;

  /**
   * Maximum value. Progress fraction = value / max.
   * @default 1
   */
  max?: number;

  /**
   * Size variant. Controls dimensions of the spinner or bar height.
   * @selector .tug-progress-sm | .tug-progress-md | .tug-progress-lg
   * @default "md"
   */
  size?: TugProgressSize;

  /**
   * Label text. Shown below the bar or beside the spinner.
   * Can include dynamic text: "Uploading 3 of 10 files", "47%", etc.
   * The component does NOT auto-format value as percentage — the caller
   * controls the label text entirely.
   */
  label?: string;

  /**
   * Semantic role color for the progress fill / spinner color.
   * Omit for the theme's accent color.
   * @selector [data-role="<role>"]
   */
  role?: TugProgressRole;

  /**
   * Disables the progress indicator. Animations freeze,
   * colors dim. Also driven by TugBox disabled cascade.
   * @selector [data-disabled]
   * @default false
   */
  disabled?: boolean;

  /** Accessible label when no visible label. */
  "aria-label"?: string;
}
```

### The `value` prop is the mode switch

- `value={undefined}` → indeterminate (spinner spins, bar shows barber pole)
- `value={0.47}` → determinate at 47% (spinner spins + label, bar fills to 47%)

No separate `indeterminate` boolean prop. The presence or absence of `value` is the signal. This is clean — there's no way to accidentally set both `indeterminate={true}` and `value={0.5}`.

---

## ARIA

```html
<!-- Indeterminate -->
<div role="progressbar" aria-label="Loading">
  <!-- visual content -->
</div>

<!-- Determinate -->
<div role="progressbar" aria-valuenow="47" aria-valuemin="0" aria-valuemax="100" aria-label="Uploading">
  <!-- visual content -->
</div>
```

- `role="progressbar"` always (both modes)
- `aria-valuenow` only when determinate
- `aria-valuemin="0"` and `aria-valuemax` only when determinate
- `aria-label` from prop or derived from `label`

---

## Tokens

All three variants share a single role injection pattern. The outer TugProgress component injects `--tugx-progress-fill` as an inline CSS variable (same `buildRoleStyle` pattern as toggle controls). Internal variant components read this variable for their active/fill color.

### Shared tokens (injected by TugProgress on the root element)

| Usage | Token |
|-------|-------|
| Fill / active color | `--tugx-progress-fill` → role-injected, default accent |
| Fill hover | `--tugx-progress-fill-hover` → role-injected |
| Track background | `--tug7-surface-progress-primary-normal-default-rest` |
| Label text | `--tug7-element-field-text-normal-label-rest` |
| Disabled opacity | `--tugx-control-disabled-opacity` (shared across all controls) |

### How each variant uses them

| Variant | Fill color source | Track color source |
|---------|------------------|-------------------|
| Spinner | `var(--tugx-progress-fill)` for petal color | n/a (no track) |
| Bar | `var(--tugx-progress-fill)` for fill + stripe color | `var(--tug7-surface-progress-primary-normal-default-rest)` |
| Ring | `var(--tugx-progress-fill)` for arc stroke | `var(--tug7-surface-progress-primary-normal-default-rest)` for background ring |

The existing `--tugx-spinner: currentColor` pattern in gallery.css is replaced by `--tugx-progress-fill` so that role injection works consistently. The spinner no longer inherits from `currentColor` — it uses the same role-driven color as bar and ring.

### New base-tier tokens needed in theme files

```css
--tug7-surface-progress-primary-normal-default-rest: /* track background */
```

The fill colors come from the existing `--tug7-surface-toggle-primary-normal-{role}-rest` tokens via role injection — no new fill tokens needed.

---

## Size Scale

### Spinner

| Size | Petals diameter | Petal dimensions |
|------|----------------|-----------------|
| sm | 16px | proportional |
| md | 24px | proportional |
| lg | 32px | proportional |

The existing petals use `--tug-petals-size` for scaling — this maps directly to the size prop.

### Bar

| Size | Track height | Border radius |
|------|-------------|---------------|
| sm | 4px | 2px |
| md | 8px | 4px |
| lg | 12px | 6px |

### Ring

| Size | Diameter | Stroke width |
|------|----------|-------------|
| sm | 16px | 2px |
| md | 24px | 3px |
| lg | 32px | 4px |

Ring sizes match spinner sizes — they're interchangeable in the same layout context.

---

## Rendering Structure

TugProgress always renders: root div (ARIA + data-slot) > control + optional label. The control is the internal variant component. The label is a `<span>` rendered by TugProgress itself.

### Spinner variant

```html
<!-- Indeterminate -->
<div role="progressbar" data-slot="tug-progress"
     class="tug-progress tug-progress-spinner tug-progress-md" aria-label="Loading">
  <span class="tug-progress-control" aria-hidden="true">
    <!-- TugProgressSpinner renders here -->
    <span class="tug-petals"><span class="petal" />...(8x)</span>
  </span>
  <span class="tug-progress-label">Loading...</span>
</div>

<!-- Determinate -->
<div role="progressbar" data-slot="tug-progress"
     class="tug-progress tug-progress-spinner tug-progress-md"
     aria-valuenow="47" aria-valuemin="0" aria-valuemax="100">
  <span class="tug-progress-control" aria-hidden="true">
    <span class="tug-petals"><span class="petal" />...(8x)</span>
  </span>
  <span class="tug-progress-label">47% complete</span>
</div>
```

Layout: `display: inline-flex; align-items: center; gap`. Control left, label right.

### Bar variant

```html
<!-- Indeterminate -->
<div role="progressbar" data-slot="tug-progress"
     class="tug-progress tug-progress-bar tug-progress-md" aria-label="Processing">
  <span class="tug-progress-label">Processing...</span>
  <div class="tug-progress-control">
    <!-- TugProgressBar renders here -->
    <div class="tug-progress-track">
      <div class="tug-progress-fill tug-progress-indeterminate" />
    </div>
  </div>
</div>

<!-- Determinate -->
<div role="progressbar" data-slot="tug-progress"
     class="tug-progress tug-progress-bar tug-progress-md"
     aria-valuenow="47" aria-valuemin="0" aria-valuemax="100">
  <span class="tug-progress-label">Uploading files... 47%</span>
  <div class="tug-progress-control">
    <div class="tug-progress-track">
      <div class="tug-progress-fill" style="width: 47%" />
    </div>
  </div>
</div>
```

Layout: `display: flex; flex-direction: column; gap`. Label above, bar below. The bar stretches to fill width.

The fill width is set imperatively via inline style [L06] — no React state for the visual width.

---

## Indeterminate → Determinate Transition

When `value` changes from `undefined` to a number:

1. The `.tug-progress-indeterminate` class is removed from the fill element
2. The fill width transitions from its current animated position to the actual value position
3. CSS `transition: width 300ms ease` on the fill handles the smooth animation
4. The barber-pole stripe animation fades out via `opacity` transition on the stripe pseudo-element

This is all CSS — no JavaScript animation, no React state for the transition [L06, L13].

---

## What Happens to the Existing Code

| Current Location | What Happens |
|-----------------|-------------|
| `.tug-petals` in `gallery.css` | Promoted to `internal/tug-progress-spinner.css`. Gallery continues to work because TugProgress imports the internal component. |
| `.tug-pole` in `gallery.css` | Promoted to `internal/tug-progress-bar.css` as the indeterminate barber-pole variant. |
| `Spinner` in `tug-button.tsx` | **Stays.** TugButton's loading spinner is self-contained and intentionally simple (14px, currentColor). It doesn't need the full TugProgress machinery. |
| `tug-skeleton.tsx` | **Stays.** Skeleton shimmer is a distinct concept — placeholder content, not progress indication. |

---

## Implementation Plan

### Phase 1: Internal variants + public component

- `internal/tug-progress-spinner.tsx` + `.css` — petals rendering (promoted from gallery.css)
- `internal/tug-progress-bar.tsx` + `.css` — track + fill + barber-pole (promoted from gallery.css)
- `tug-progress.tsx` — public component: mode logic, label, ARIA, variant dispatch
- `tug-progress.css` — control + label layout, label typography
- Role color injection for fill/spinner
- Indeterminate → determinate CSS transition (bar variant)
- TugBox disabled cascade

### Phase 2: Gallery card

- `cards/gallery-progress.tsx` — demo sections:
  - Spinner: indeterminate, with label, sizes
  - Spinner: determinate with label showing progress text
  - Bar indeterminate: barber pole, sizes
  - Bar determinate: various fill levels, with label
  - Transition demo: button triggers indeterminate → determinate
  - Roles: accent, action, success, danger
  - Inside TugBox (disabled cascade)

### Future: TugProgressStore

- `TugProgressStore` class for high-frequency updates
- `source` prop on TugProgress
- `useSyncExternalStore` integration [L02]

---

## Dashes

| # | Scope | Description |
|---|-------|-------------|
| 1 | Internal | `internal/tug-progress-spinner.tsx/.css` — petals (promote from gallery.css) |
| 2 | Internal | `internal/tug-progress-bar.tsx/.css` — track + fill + barber-pole (promote from gallery.css) |
| 3 | Internal | `internal/tug-progress-ring.tsx/.css` — SVG circular arc |
| 4 | Public | `tug-progress.tsx/.css` — mode, label, ARIA, variant dispatch, role injection |
| 5 | Gallery | Gallery card with all demos (spinner, bar, ring, transitions, roles) |

---

## Laws Compliance

| Law | How |
|-----|-----|
| L02 | Future store integration via useSyncExternalStore |
| L06 | Fill width via inline style, arc offset via inline style, transitions via CSS. No React state for visuals. |
| L13 | All animations via CSS @keyframes. Durations scale via `--tug-timing`. No rAF. |
| L15 | Token-driven colors, role injection for fill. Progressive lightening in hover states. |
| L16 | Pairings declared in each CSS file. @tug-renders-on on foreground rules. |
| L19 | Follows component authoring guide — docstring, data-slot, forwardRef, @tug-pairings, @selector. |
| L20 | Compound composition — TugProgress owns layout/label/ARIA; internal variants own their visual tokens. Each variant's CSS references only its own scoped styles. |

---

## What This Replaces in the Roadmap

| Old Entry | New |
|-----------|-----|
| tug-spinner (Group B, #8) | **Merged into TugProgress** as `variant="spinner"` |
| tug-progress (Group E, #9) | **Merged into TugProgress** as `variant="bar"` |

One component, one API, one data model, multiple visual treatments.

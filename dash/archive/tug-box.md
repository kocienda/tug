# tug-box

*Container providing visual grouping and functional grouping. Modeled on Apple's NSBox and HTML `<fieldset>` semantics. Optional border, optional background fill, optional label with configurable position, recursive disable propagation.*

---

## Design

TugBox is a grouping container that serves two purposes:

1. **Visual grouping** — a configurable visual appearance (border, background fill, label) creates a visible boundary around a set of controls or content. Inspired by NSBox's box types.

2. **Functional grouping** — a `disabled` prop on the box cascades to all controls inside it via React context. This is recursive: a disabled outer box disables all inner boxes and their controls, no matter how deeply nested.

TugBox renders a `<fieldset>` element (not a `<div>`) for native HTML semantics. The `disabled` attribute on `<fieldset>` already disables all form controls inside it natively. TugBox adds a React context layer on top so that custom components (TugCheckbox, TugSwitch, TugRadioGroup, TugSegmentedChoice, TugSlider, TugValueInput, etc.) also respect the group disable.

### Inspiration from NSBox

Apple's NSBox provides several ideas that translate well to the web:

| NSBox Concept | TugBox Equivalent |
|---|---|
| **Box types** (primary, secondary, separator, custom) | `variant` prop: `"plain"` (invisible, grouping only), `"bordered"` (border, no fill), `"filled"` (fill + border), `"separator"` (horizontal rule) |
| **Title position** (noTitle, aboveTop, atTop, belowTop, etc.) | `labelPosition` prop: `"legend"` (in the border line, fieldset/legend style), `"above"` (above the box content) |
| **Content view margins** | `inset` prop controlling internal padding |
| **Transparency** | The `"plain"` variant — no visual footprint |
| **Border + fill independence** | Variants let border and fill be controlled together in semantically meaningful combinations |

### The TugBoxContext Pattern

TugBox provides a `TugBoxContext` that any tugways control can read. The context value is simply `{ disabled: boolean }`. When `disabled` is true, every control inside the box should behave as disabled — regardless of its own `disabled` prop.

**Nesting:** When TugBoxes nest, the inner box's context merges with the outer box's. If the outer box is disabled, the inner box is disabled too — even if the inner box's own `disabled` prop is false. This is a logical OR: `effectiveDisabled = ownDisabled || parentDisabled`.

**Opt-in for existing controls:** Today, only TugRadioItem reads a group-level disabled context. For TugBox to work, each tugways control needs to read `TugBoxContext` and merge it with its own disabled prop. This is a small change per control: add a `useContext(TugBoxContext)` call and OR the result with the control's own `disabled` prop.

### Anatomy

```
TugBox (root — <fieldset>)
├── legend (optional — rendered when label + labelPosition="legend")
├── label above (optional — rendered when label + labelPosition="above")
└── children (arbitrary React nodes — controls, other TugBoxes, content)
```

---

## Props

```typescript
export type TugBoxSize = "sm" | "md" | "lg";
export type TugBoxVariant = "plain" | "bordered" | "filled" | "separator";
export type TugBoxLabelPosition = "legend" | "above";

export interface TugBoxProps
  extends Omit<React.FieldsetHTMLAttributes<HTMLFieldSetElement>, "disabled"> {
  /** Visible label text. Rendered as <legend> or <span> depending on labelPosition. */
  label?: string;
  /**
   * Where the label appears relative to the box.
   * - "legend": in the border line (standard fieldset/legend). Only meaningful with "bordered" or "filled" variants.
   * - "above": above the box content as a standalone heading.
   * @selector .tug-box-label-legend | .tug-box-label-above
   * @default "legend"
   */
  labelPosition?: TugBoxLabelPosition;
  /**
   * Visual variant controlling border and background.
   * - "plain": invisible — functional grouping only, no visual chrome.
   * - "bordered": visible border, no background fill.
   * - "filled": visible border + subtle background fill.
   * - "separator": renders as a horizontal rule (no children, no label).
   * @selector .tug-box-plain | .tug-box-bordered | .tug-box-filled | .tug-box-separator
   * @default "plain"
   */
  variant?: TugBoxVariant;
  /**
   * Internal padding between the border and children.
   * When true, applies size-appropriate padding. When false, no padding.
   * Only applies to "bordered" and "filled" variants.
   * @selector .tug-box-inset
   * @default true (for bordered/filled), false (for plain)
   */
  inset?: boolean;
  /**
   * Disables all controls inside this box. Cascades recursively to nested TugBoxes.
   * @selector [data-disabled] | :disabled
   * @default false
   */
  disabled?: boolean;
  /**
   * Visual size — controls label font size and inset padding scale.
   * @selector .tug-box-sm | .tug-box-md | .tug-box-lg
   * @default "md"
   */
  size?: TugBoxSize;
  /** Box content. Not used when variant is "separator". */
  children?: React.ReactNode;
}
```

### Why `<fieldset>` and Not `<div>`

HTML `<fieldset disabled>` natively disables all form controls (inputs, buttons, selects) inside it without JavaScript. This means:

- Native `<input>`, `<button>`, `<select>` elements get disabled for free.
- Screen readers understand the grouping semantics.
- The `<legend>` element is the accessible name for the group.

TugBox adds the context layer for custom components that aren't native form controls (TugCheckbox wrapping a Radix root, TugSegmentedChoice wrapping a div, etc.).

The `"separator"` variant is the exception — it renders an `<hr>` element instead of `<fieldset>`, since it has no children or grouping semantics.

---

## TugBoxContext — Shared Infrastructure

The context is defined as a shared module, not inside the TugBox component file, so that any control can import it without depending on TugBox itself.

```
tugdeck/src/components/tugways/internal/tug-box-context.tsx
```

```typescript
export interface TugBoxContextValue {
  disabled: boolean;
}

export const TugBoxContext = React.createContext<TugBoxContextValue>({
  disabled: false,
});

/**
 * Hook for controls to read the nearest TugBox's disabled state.
 * Returns the context disabled value OR'd with any parent context.
 */
export function useTugBoxDisabled(): boolean {
  return React.useContext(TugBoxContext).disabled;
}
```

### Adoption in Existing Controls

Each tugways control adopts TugBox disabled by adding two lines:

```typescript
const boxDisabled = useTugBoxDisabled();
const effectiveDisabled = disabled || boxDisabled;
```

Controls that need this change:
- TugCheckbox
- TugSwitch
- TugInput
- TugSlider (and indirectly TugValueInput)
- TugRadioGroup (merge with its own group disabled)
- TugSegmentedChoice
- TugPushButton (and indirectly TugButton)

This is a mechanical change — import the hook, OR with own disabled prop, use the result. The default context value is `{ disabled: false }`, so controls outside any TugBox are unaffected.

---

## Visual Behavior

### Variants

**Plain** (default): Invisible — no border, no background, no padding. Provides only functional grouping (disable cascade) and optional label. The most common variant for layout-only grouping.

**Bordered:** Visible border around children. No background fill — the parent surface shows through. Border uses a subtle global border token. Inset padding separates children from the border.

**Filled:** Visible border + subtle background fill. Creates a visually distinct surface region. The fill uses a sunken/inset surface token to differentiate from the surrounding area. Inset padding included.

**Separator:** Renders as a horizontal rule (`<hr>`) — no children, no label. A thin line using the global separator token. Useful between groups of controls within a larger layout.

### Label Position

**Legend** (default): The label sits in the border line, interrupting it — standard `<fieldset>`/`<legend>` behavior. Only visually meaningful with "bordered" or "filled" variants. With "plain", the legend still provides accessibility naming but has no visual border to sit in.

**Above:** The label renders above the box content as a standalone heading-like text. Works with all variants. With "plain", this gives a section-heading effect with disable cascade.

### Inset (Content Margins)

Modeled on NSBox's `contentViewMargins`. When `inset` is true (default for bordered/filled), children have padding separating them from the border. The padding scales with size:

| Size | Inset padding |
|------|---------------|
| sm | `--tug-space-sm` (6px) |
| md | `--tug-space-md` (8px) |
| lg | `--tug-space-lg` (12px) |

### Disabled Visual

The box itself doesn't dim — the individual controls inside handle their own disabled appearance. The box simply propagates the `disabled` signal via context and the native `<fieldset disabled>` attribute.

### Nesting

Boxes nest freely. An outer bordered box can contain inner bordered or filled boxes, creating a visual hierarchy. Disable cascades through all levels.

---

## Token Strategy

TugBox is primarily structural. It reuses existing global tokens — no new component-specific tokens needed.

**Border (element):**
```
--tug7-element-global-border-normal-default-rest     ← existing global border token
```

**Fill (surface — for "filled" variant):**
```
--tug7-surface-global-primary-normal-sunken-rest     ← existing sunken surface token
```

**Label text (element):**
```
--tug7-element-field-text-normal-label-rest           ← existing field label token
```

**Separator (element — for "separator" variant):**
```
--tug7-element-global-divider-normal-separator-rest   ← existing divider token
```

---

## CSS Structure

```css
/* @tug-pairings {
  --tug7-element-field-text-normal-label-rest       | --tug7-surface-global-primary-normal-default-rest | content
  --tug7-element-global-border-normal-default-rest  | --tug7-surface-global-primary-normal-default-rest | informational
} */

/* Reset fieldset defaults */
.tug-box {
  border: none;
  padding: 0;
  margin: 0;
  min-inline-size: auto;
}

/* ---- Variants ---- */

.tug-box-bordered {
  border: 1px solid var(--tug7-element-global-border-normal-default-rest);
}

.tug-box-filled {
  border: 1px solid var(--tug7-element-global-border-normal-default-rest);
  background-color: var(--tug7-surface-global-primary-normal-sunken-rest);
}

.tug-box-separator {
  border: none;
  border-top: 1px solid var(--tug7-element-global-divider-normal-separator-rest);
}

/* ---- Border radius (bordered + filled) ---- */

.tug-box-bordered, .tug-box-filled {
  border-radius: var(--tug-radius-lg);
}

/* ---- Inset padding ---- */

.tug-box-inset.tug-box-sm { padding: var(--tug-space-sm); }
.tug-box-inset.tug-box-md { padding: var(--tug-space-md); }
.tug-box-inset.tug-box-lg { padding: var(--tug-space-lg); }

/* ---- Legend / label ---- */

.tug-box-legend {
  font-weight: 500;
  color: var(--tug7-element-field-text-normal-label-rest);
  padding: 0 var(--tug-space-xs);
}

.tug-box-label-above {
  font-weight: 500;
  color: var(--tug7-element-field-text-normal-label-rest);
  margin-bottom: var(--tug-space-xs);
}

/* ---- Size variants for labels ---- */

.tug-box-sm .tug-box-legend,
.tug-box-sm .tug-box-label-above { font-size: var(--tug-font-size-xs); }

.tug-box-md .tug-box-legend,
.tug-box-md .tug-box-label-above { font-size: var(--tug-font-size-sm); }

.tug-box-lg .tug-box-legend,
.tug-box-lg .tug-box-label-above { font-size: var(--tug-font-size-md); }
```

---

## Nesting and Disable Cascade

```tsx
<TugBox label="Account Settings" disabled variant="bordered">
  {/* Everything inside is disabled */}
  <TugCheckbox label="Enable notifications" />
  <TugSwitch label="Dark mode" />

  <TugBox label="Advanced" variant="filled">
    {/* Also disabled — parent box cascades */}
    <TugInput placeholder="Custom endpoint" />
    <TugRadioGroup aria-label="Protocol">
      <TugRadioItem value="http">HTTP</TugRadioItem>
      <TugRadioItem value="https">HTTPS</TugRadioItem>
    </TugRadioGroup>
  </TugBox>
</TugBox>
```

The inner "Advanced" box doesn't set `disabled` itself, but it's disabled because its parent is. The context merge ensures this:

```typescript
// Inside TugBox render:
const parentDisabled = useTugBoxDisabled();
const effectiveDisabled = disabled || parentDisabled;

// Provide merged context to children:
<TugBoxContext.Provider value={{ disabled: effectiveDisabled }}>
```

---

## Implementation Notes

1. **`<fieldset>` element for grouping variants; `<hr>` for separator.** The grouping variants (plain, bordered, filled) render `<fieldset>` for native semantics. The separator variant renders `<hr>` — it has no children or grouping semantics.

2. **Context in `internal/tug-box-context.tsx`.** The context and `useTugBoxDisabled` hook live in a separate file so controls can import them without circular dependencies on TugBox.

3. **Adoption is incremental.** Existing controls work without TugBox today. Adding `useTugBoxDisabled()` is backward-compatible — the default context value is `{ disabled: false }`, so controls outside any TugBox are unaffected.

4. **No size propagation.** Unlike TugRadioGroup which propagates `size` to items, TugBox doesn't propagate size. Each control inside sets its own size. Box size only affects the label font size and inset padding.

5. **No role color injection.** TugBox is a structural container, not a selection control. No semantic role colors.

6. **`inset` defaults are variant-dependent.** For "bordered" and "filled", `inset` defaults to true (children get padding). For "plain", `inset` defaults to false (no visual chrome means no padding needed). Callers can override either way.

7. **Module docstring cites [L06], [L16], [L19].** As a structural container with minimal appearance, L15 (interactive control states) doesn't apply.

---

## Files

```
tugdeck/src/components/tugways/internal/tug-box-context.tsx  — TugBoxContext + useTugBoxDisabled hook
tugdeck/src/components/tugways/tug-box.tsx                    — TugBox component
tugdeck/src/components/tugways/tug-box.css                    — Fieldset reset, variants, legend, inset
tugdeck/src/components/tugways/cards/gallery-box.tsx           — Gallery card
```

### Control adoption (add useTugBoxDisabled to each):
```
tugdeck/src/components/tugways/tug-checkbox.tsx
tugdeck/src/components/tugways/tug-switch.tsx
tugdeck/src/components/tugways/tug-input.tsx
tugdeck/src/components/tugways/tug-slider.tsx
tugdeck/src/components/tugways/tug-value-input.tsx
tugdeck/src/components/tugways/tug-radio-group.tsx
tugdeck/src/components/tugways/tug-segmented-choice.tsx
tugdeck/src/components/tugways/internal/tug-button.tsx
```

---

## Checklist

- [ ] Renders `<fieldset>` element (or `<hr>` for separator)
- [ ] `TugBoxContext` in `internal/tug-box-context.tsx` with `useTugBoxDisabled` hook
- [ ] Recursive disable cascade: outer disabled → inner disabled via context OR
- [ ] Variant prop: plain, bordered, filled, separator
- [ ] Label prop with labelPosition: legend (in border) or above (heading)
- [ ] Inset prop for content margins, defaults vary by variant
- [ ] Size variants (sm, md, lg) for label and inset padding
- [ ] `data-slot="tug-box"` on root
- [ ] Reuses global/field tokens — no new component-specific tokens
- [ ] `@tug-pairings` with existing token references
- [ ] Existing controls adopt `useTugBoxDisabled()` (8 files)
- [ ] Module docstring cites [L06], [L16], [L19]
- [ ] Gallery card demonstrating: all variants, labeled (both positions), nested, disabled cascade, separator
- [ ] `bun run build` passes
- [ ] `bun run audit:tokens lint` passes

---

## Addendum: `resize` Prop

### Problem

The animator gallery uses TugBox as a visual canvas for animated elements. Each stage needs to be user-resizable so the animation travel distance can be adjusted interactively. Currently, `resize: horizontal` lives on inner stage divs, which creates a structural problem:

1. The resize handle is on the inner div, not the TugBox border. The TugBox fieldset doesn't resize with the inner content — its border stays fixed while the inner div changes size, creating visible gaps.
2. The inner div needs `overflow: hidden` for resize to work (CSS requirement). But the TugBox also wraps content in `.tug-box-content`. This creates layered containment where heights and padding don't align.
3. Ad-hoc CSS hacks (`padding: 0 !important`, `margin-left: 0`, `width: 100%`) are needed to fight TugBox's own styling — a sign that the component should handle this natively.

### Proposal

Add a `resize` prop to TugBox:

```typescript
/**
 * User-resizable direction. Requires bordered or filled variant.
 * Sets CSS `resize` and `overflow: hidden` on the fieldset.
 * When omitted, the box is not resizable.
 * @selector .tug-box-resize-horizontal | .tug-box-resize-vertical | .tug-box-resize-both
 */
resize?: "horizontal" | "vertical" | "both";
```

**Implementation:**
- When `resize` is not `"none"`, add a CSS class `.tug-box-resize-{direction}` to the fieldset.
- The CSS class sets `resize: {direction}` and `overflow: hidden` on the fieldset itself.
- The resize handle appears on the TugBox's own border. When the user drags it, the fieldset resizes — border, background fill, and content all move together.
- The `.tug-box-content` wrapper inside naturally fills the fieldset, so children resize with the box.

**CSS:**
```css
.tug-box-resize-horizontal { resize: horizontal; overflow: hidden; }
.tug-box-resize-vertical   { resize: vertical;   overflow: hidden; }
.tug-box-resize-both       { resize: both;       overflow: hidden; }
```

**Why this solves the animator problem:**
- Each animation stage becomes `<TugBox variant="filled" resize="horizontal">`. The box IS the track.
- No inner wrapper divs needed for resize. The stage content (animated dots/boxes) sits directly inside the box.
- The resize handle is on the TugBox border — dragging it resizes the entire box including its border and fill.
- No `padding: 0 !important` hacks. The box's own inset padding works naturally.
- `ResizeObserver` on the TugBox ref measures the right element (the fieldset itself).

**What changes in the animator gallery:**
- Remove the `.cg-anim-stage-box` hack class and all its CSS overrides.
- Physics: each lane is a `<TugBox variant="filled" resize="horizontal" rounded="sm">` containing just the track div with the animated dot. The track fills the box.
- Token/cancel/slot: each is a `<TugBox variant="filled" resize="horizontal" rounded="md">` containing the animated element directly. The stage height is set via inline `style={{ height: "40px" }}` or a CSS class on the TugBox.
- The `stageRef` for measurement goes on the TugBox via `ref` — `fieldsetRef.current.clientWidth` gives the available width.

### Checklist Addendum

- [ ] `resize` prop: "horizontal" | "vertical" | "both" (optional, omit for no resize)
- [ ] CSS classes: `.tug-box-resize-horizontal`, `.tug-box-resize-vertical`, `.tug-box-resize-both`
- [ ] Each sets `resize` + `overflow: hidden` on the fieldset
- [ ] Animator gallery refactored to use `resize="horizontal"` — no hack classes
- [ ] Gallery card: add a "Resizable" section demonstrating the feature

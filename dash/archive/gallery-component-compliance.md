# Gallery Component Compliance

Every gallery card must use the standard tug component library. No raw HTML elements styled with `cg-*` CSS classes where a tug component exists. The gallery is the showcase for the component library — it must use the library it showcases.

## Problem

Gallery cards use ~60 `cg-*` CSS classes defined in `gallery.css` to style raw `<div>`, `<p>`, `<span>`, `<input>`, and `<button>` elements. These bypass the tug component library: they don't participate in the responder chain, don't follow the selection model (no copyable context menus on text), and aren't themed through the standard token system.

## Scope

46 gallery cards + `gallery.css`. Non-gallery cards (`hello-world-card.tsx`, `git-card.tsx`) do not use `cg-*` classes.

## What stays as-is

**Demo targets** remain as raw `<div>` — these are the subjects being demonstrated, not UI chrome:

| Class | Purpose |
|-------|---------|
| `cg-mutation-box` | Animated target in mutation demo |
| `cg-mutation-tx-stage` | Positioned stage area |
| `cg-mutation-tx-card` | Mock card element |
| `cg-hue-swatch` | Gradient color strip |
| `cg-anim-dot` | Animated circle |
| `cg-anim-token-box` | Duration token indicator |
| `cg-anim-cancel-box` | Cancellation mode indicator |
| `cg-anim-slot-box` | Named slot indicator |

## Step 0: Type scale foundation

Before migrating gallery components, establish a type scale that all components consume from the theme. TugLabel currently hardcodes its own `rem` values and ignores the `--tug-font-size-*` tokens that 10 other components already use. This must be fixed at the foundation level first.

### Design decisions

**D-TS1: One type scale, defined in the theme.** All font sizes come from `--tug-font-size-*` CSS custom properties defined in `brio.css` and `harmony.css`. No component hardcodes pixel or rem values for font-size. The `--tug-` prefix conforms to the scale/dimension category in `tuglaws/token-naming.md`.

**D-TS2: Scale stop names follow the established convention.** All `--tug-` scale tokens (spacing, radius, icon-size) already use the same stop names. The type scale uses the same vocabulary. The full set of available stop names, in order:

`8xs · 7xs · 6xs · 5xs · 4xs · 3xs · 2xs · xs · sm · md · lg · xl · 2xl · 3xl · 4xl · 5xl · 6xl · 7xl · 8xl`

Not every scale must define every stop. A scale defines the stops it needs. The type scale defines the full 19-stop range from 5px to 72px to accommodate future needs without extending the scale later.

**D-TS3: Values are in `px`.** All existing `--tug-` scale tokens use `px`. The type scale follows suit. This is a desktop developer tool — absolute pixel sizing is appropriate.

**D-TS4: The current theme values are canonical.** The existing 7-stop type scale in the theme files (`2xs=11, xs=12, sm=13, md=14, lg=16, xl=20, 2xl=24`) is consumed by 10+ component CSS files. These values are the source of truth. TugLabel must be brought into conformance with them, not the other way around.

**D-TS5: Paired line-height tokens.** Each `--tug-font-size-*` stop has a corresponding `--tug-line-height-*` stop. New size stops require new line-height stops.

**D-TS6: Components reference tokens, never raw values.** Every `font-size` declaration in component CSS must be `var(--tug-font-size-*)`. Any hardcoded font-size is a bug.

### Current state

Theme tokens (both brio and harmony, identical):

| Token | Value |
|-------|-------|
| `--tug-font-size-2xs` | 11px |
| `--tug-font-size-xs` | 12px |
| `--tug-font-size-sm` | 13px |
| `--tug-font-size-md` | 14px |
| `--tug-font-size-lg` | 16px |
| `--tug-font-size-xl` | 20px |
| `--tug-font-size-2xl` | 24px |

TugLabel's hardcoded values (wrong — ignores theme tokens):

| TugLabel size prop | Hardcoded value | Nearest theme token |
|--------------------|----------------|---------------------|
| `xs` | 0.6875rem (11px) | `--tug-font-size-2xs` (11px) |
| `sm` | 0.75rem (12px) | `--tug-font-size-xs` (12px) |
| `md` | 0.8125rem (13px) | `--tug-font-size-sm` (13px) |
| `lg` | 0.875rem (14px) | `--tug-font-size-md` (14px) |

TugLabel's size names don't even match the token names they correspond to. `size="md"` maps to `--tug-font-size-sm`. This is a mess.

### Required work

**0a. Extend the scale to 19 stops.** The type scale covers 5px–72px:

| Token | Value |
|-------|-------|
| `--tug-font-size-8xs` | 5px |
| `--tug-font-size-7xs` | 6px |
| `--tug-font-size-6xs` | 7px |
| `--tug-font-size-5xs` | 8px |
| `--tug-font-size-4xs` | 9px |
| `--tug-font-size-3xs` | 10px |
| `--tug-font-size-2xs` | 11px |
| `--tug-font-size-xs` | 12px |
| `--tug-font-size-sm` | 13px |
| `--tug-font-size-md` | 14px |
| `--tug-font-size-lg` | 16px |
| `--tug-font-size-xl` | 20px |
| `--tug-font-size-2xl` | 24px |
| `--tug-font-size-3xl` | 30px |
| `--tug-font-size-4xl` | 36px |
| `--tug-font-size-5xl` | 48px |
| `--tug-font-size-6xl` | 56px |
| `--tug-font-size-7xl` | 64px |
| `--tug-font-size-8xl` | 72px |

The existing 7 stops (2xs through 2xl) retain their current values. The scale extends 5 stops below and 6 stops above.

**0b. Add any new stops to both theme files.** Add new `--tug-font-size-*` and `--tug-line-height-*` entries to `brio.css` and `harmony.css`.

**0c. Update `tug-token-names.ts`.** Regenerate or manually add new token names to the generated file.

**0d. Rewrite TugLabel to consume theme tokens.** Replace all hardcoded rem values with `var(--tug-font-size-*)`. The `size` prop values must match the token stop names exactly: `size="md"` → `var(--tug-font-size-md)`. Remove `font-size` from the base `.tug-label` class — it comes from the size variant class.

**0e. Fix TugLabel's size type.** `TugLabelSize` must enumerate the same stop names used by the theme tokens: `"8xs" | "7xs" | "6xs" | "5xs" | "4xs" | "3xs" | "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "7xl" | "8xl"`.

**0f. Update all TugLabel call sites.** Every `size="xs"` that actually means 11px must change to `size="2xs"` to match the theme token. Every `size="md"` that actually means 13px must change to `size="sm"`. This is a name correction — the visual output at each call site stays the same.

**0g. Fix TugLabel's `gap` unit.** Change `gap: 0.375rem` to `0.35em` so icon-text spacing scales proportionally with font size.

**0h. Audit all other components for hardcoded font-size.** Any component CSS with a raw `font-size` value (not `var(--tug-font-size-*)`) is non-conforming and must be fixed.

**0i. Update `tuglaws/token-naming.md`.** Document the type scale convention under the `--tug-` scale/dimension section, including the stop name vocabulary and the requirement that every font-size declaration uses a token.

## Step 1: Text labels to TugLabel

Replace all text-display `<div>`, `<p>`, `<span>` elements that use `cg-*` text classes with `<TugLabel>`.

| Class | Count | Replacement |
|-------|-------|-------------|
| `cg-description` | 40 | `<TugLabel className="cg-description">` |
| `cg-demo-status` | 18 | `<TugLabel className="cg-demo-status">` — flatten `<code>` children to template literals |
| `cg-control-label` | 14 | `<TugLabel className="cg-control-label">` |
| `cg-variant-label` | 3 | `<TugLabel className="cg-variant-label">` |
| `cg-subtype-label` | 3 | `<TugLabel className="cg-subtype-label">` |
| `cg-st-readout-fn` | 3 | `<TugLabel className="cg-st-readout-fn">` |
| `cg-st-readout-value` | 3 | `<TugLabel className="cg-st-readout-value">` |
| `cg-st-note` | 2 | `<TugLabel className="cg-st-note">` |
| `cg-st-indicator-label` | 2 | `<TugLabel className="cg-st-indicator-label">` |
| `cg-st-value` | 1 | `<TugLabel className="cg-st-value">` |
| `cg-st-slider-label` | 1 | `<TugLabel className="cg-st-slider-label">` |
| `cg-anim-pct-value` | 1 | `<TugLabel className="cg-anim-pct-value">` |

`cg-demo-status` elements contain `<code>` children (e.g., `Value: <code>42</code>`). Every instance follows the same pattern and can be flattened to a template literal: `` {`Value: ${smValue}`} ``. No need to extend TugLabel.

Table cells (`<td className="cg-cascade-*">`) stay as `<td>` — TugLabel renders a `<label>`, which cannot be a table cell. Wrap with `<TugLabel>` inside the `<td>` for copyability.

## Step 2: Dividers to TugSeparator

Replace all `<div className="cg-divider" />` with `<TugSeparator />`.

- 169 occurrences across all gallery files
- Mechanical sed replacement
- Remove `cg-divider` CSS rule from `gallery.css`

## Step 3: Layout containers to TugBox

Replace `cg-*` layout containers with `<TugBox>`. TugBox exists for exactly this purpose — grouping content with optional visual chrome.

| Class | Count | Current | TugBox variant |
|-------|-------|---------|----------------|
| `cg-content` | 43 | Root scrollable wrapper | `<TugBox variant="plain">` with scroll styling |
| `cg-section` | 213 | Section grouping (flex column, 16px gap) | `<TugBox variant="plain">` |
| `cg-controls` | 3 | Bordered control bar | `<TugBox variant="bordered">` |
| `cg-control-group` | 12 | Horizontal label+input pair | `<TugBox variant="plain">` with flex-row |
| `cg-variant-row` | 21 | Row in variant matrix | `<TugBox variant="plain">` with flex-row |
| `cg-size-group` | 3 | Button size grouping | `<TugBox variant="plain">` with flex-row |
| `cg-matrix` | 2 | Button grid wrapper | `<TugBox variant="plain">` |
| `cg-subtype-block` | 3 | Subtype section wrapper | `<TugBox variant="plain">` |
| `cg-st-readout` | 1 | Bordered readout box | `<TugBox variant="bordered">` |
| `cg-st-preview` | 1 | Bordered preview area | `<TugBox variant="bordered">` |
| `cg-st-readout-row` | 3 | Readout row | `<TugBox variant="plain">` with flex-row |
| `cg-st-preview-row` | 5 | Preview row | `<TugBox variant="plain">` with flex-row |
| `cg-st-controls` | 1 | Controls column | `<TugBox variant="plain">` |
| `cg-st-slider-row` | 2 | Slider row | `<TugBox variant="plain">` with flex-row |
| `cg-cascade-table` | 2 | Cascade display table | Keep as `<table>` — TugBox is not a table |
| `cg-mutation-tx-controls` | 2 | Control row | `<TugBox variant="plain">` with flex-row |
| `cg-mutation-tx-slider-group` | 2 | Slider group | `<TugBox variant="plain">` with flex-row |
| `cg-tab-bar-demo` | 1 | Demo wrapper | `<TugBox variant="plain">` |
| `cg-popup-button-demo` | 1 | Demo wrapper | `<TugBox variant="plain">` with flex-row |
| `cg-mutation-demo` | 1 | Demo wrapper | `<TugBox variant="plain">` |
| `cg-anim-stages` | 1 | Stage list | `<TugBox variant="plain">` |
| `cg-anim-token-legend` | 1 | Legend layout | `<TugBox variant="plain">` with flex-row |
| `cg-anim-token-entry` | 1 | Legend entry | `<TugBox variant="plain">` with flex-row |
| `cg-anim-pct-row` | 1 | Control row | `<TugBox variant="plain">` with flex-row |
| `cg-observable-props-stage` | 1 | Demo stage | `<TugBox variant="bordered">` |

**Note:** Many of these containers need flex-direction, gap, and alignment. TugBox's `plain` variant renders a `<fieldset>` with no visible chrome. The `cg-*` class can remain alongside TugBox to supply the flex layout, or TugBox can accept style/className props for layout. Either approach works — the key is that the container IS a TugBox so it participates in the disabled cascade and carries the component identity.

## Step 4: Raw HTML controls to tug components

### Call sites

| Raw element | Count | Files | Tug replacement |
|------------|-------|-------|-----------------|
| `<input type="range">` | 7 | gallery-scale-timing (2), gallery-animator (1, used 4×), gallery-mutation-tx (2), gallery-badge (1, used 10×), gallery-observable-props (1) | `<TugSlider>` |
| `<input type="checkbox">` | 2 | gallery-scale-timing, gallery-title-bar | `<TugCheckbox>` |
| `<input type="number">` | 1 | gallery-observable-props | `<TugValueInput>` |
| `<input type="color">` | 2 | gallery-mutation-tx, gallery-observable-props | No tug equivalent — keep for now |

### Blockers — component gaps that must be closed first

Attempting to replace these raw inputs exposed three gaps in the component library. Each must be fixed in the core component before the gallery migration can proceed.

**B1: TugSlider layout inflexibility.** TugSlider renders as a block-level div with its own label, track, and value-input in a fixed layout (inline or stacked). It cannot participate as a peer element inside a flex row alongside buttons, labels, or other content. The gallery's PercentSlider (gallery-animator) sits in a `cg-variant-row` next to Reset/Play buttons. TugSlider's label occupies the full width, pushing sibling content out.

The gallery needs TugSlider to work in two modes:
- **Standalone**: current behavior — label + track + value input as a self-contained block.
- **Compact/trackOnly**: just the track (and optionally the value input), no label, no wrapper layout. The caller provides its own label and positions the slider in its own flex layout.

Proposed fix: Add a `layout="track"` variant (or similar) that renders only the track element without wrapper chrome, or allow `label` to be omitted and have the slider render compactly as an inline-flex element that participates in its parent's layout.

**B2: Phase semantics — RESOLVED.** Design decisions D-PH1, D-PH2, D-PH3 are documented in `tuglaws/responder-chain.md` under "Phase definitions", "Control-phase contract", and "Handler phase patterns". Summary:

- Five canonical phases: `discrete`, `begin`, `change`, `commit`, `cancel` (modeled on Apple's `UIGestureRecognizer.State`).
- Discrete controls dispatch `discrete` only. Continuous controls dispatch `begin` → `change`* → `commit` | `cancel`. A slider is continuous when dragged, discrete when arrow-keyed.
- `useResponderForm` setters receive `(value, phase)`. The `commit || discrete` guard is the standard pattern for "do this when the value is finalized". No per-phase slots.

**B3: TugCheckbox wiring is straightforward but blocked on testing.** TugCheckbox renders a `<button role="checkbox">` via Radix, not an `<input type="checkbox">`. Existing tests for gallery-scale-timing query by `#st-motion` and check `HTMLInputElement.checked`. These tests must be rewritten to use `[role="checkbox"]` and `data-state="checked"`. This is mechanical test work, not a design issue — but it must be done correctly.

### Proposed execution order

1. ~~**Document phase semantics** (D-PH1, D-PH2, D-PH3)~~ — DONE. Written in `tuglaws/responder-chain.md`.
2. **Fix TugSlider layout** (B1) — allow `label` to be omitted so the slider renders compactly and participates in parent flex layout.
3. **Replace checkboxes** (B3) — TugCheckbox replacements in gallery-title-bar and gallery-scale-timing, plus test updates.
4. **Replace sliders** — all raw range inputs across gallery-animator, gallery-badge, gallery-scale-timing, gallery-mutation-tx, gallery-observable-props.
5. **Replace number input** — gallery-observable-props `<input type="number">` → TugValueInput (already has the component, just needs responder wiring).

## Step 5: Remove dead CSS

After all migrations:
- Remove replaced `cg-*` rules from `gallery.css`
- Remove unused rules: `cg-control-select`, `cg-demo-trigger`, `cg-demo-controls`
- Keep demo-target rules (`cg-mutation-box`, `cg-anim-dot`, etc.)
- Layout rules (`cg-content`, `cg-section`, etc.) can be removed if TugBox + className handles layout, or kept as supplementary layout classes on TugBox

## Files

All files are in `tugdeck/src/components/tugways/cards/`:

| File | Changes |
|------|---------|
| `gallery.css` | Remove migrated rules, keep demo-target rules |
| All 46 `gallery-*.tsx` | Steps 1-4 replacements as applicable |

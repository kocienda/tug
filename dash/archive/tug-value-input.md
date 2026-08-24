# tug-value-input

Public component: compact editable value display with imperative DOM management [L06].

---

## Problem

The slider's value input needed: formatted display ("75%"), raw editing ("0.75"), select-all on focus, validate on commit, arrow key increment. We built all of this inline in tug-slider.tsx. But this pattern will recur — stat cards with editable numbers, inline-editable labels, gauge readouts, any component that shows a formatted value the user can click to edit.

Building it once as a standard public component means:
- The [L06]-compliant imperative DOM pattern is implemented and tested in one place
- TugSlider (and future consumers) pass props instead of managing refs and handlers
- The mouseup guard, escape handling, arrow key increment, format/parse cycle, and validation are not copy-pasted

## Design

TugValueInput is a **public** component in `tugways/`. It follows the component authoring guide like every other component: `.tsx` + `.css` file pair, docstring, forwardRef, data-slot, pairings, tokens.

It is distinct from TugInput. TugInput is a general form field (placeholder, validation states, full-width). TugValueInput is a compact inline numeric editor (formatted display, type-to-replace, commit-on-blur).

### Props

```typescript
export interface TugValueInputProps
  extends Omit<React.ComponentPropsWithoutRef<"input">, "value" | "onChange" | "defaultValue" | "type"> {
  /** Current numeric value. Display is derived from this via the formatter. */
  value: number;
  /** Called when the user commits a new value (Enter, blur, or arrow key). */
  onValueCommit: (value: number) => void;
  /** Formatter for display/parse. When absent, shows raw number. */
  formatter?: TugFormatter<number>;
  /** Minimum value. Used for clamping on commit and arrow key lower bound. */
  min?: number;
  /** Maximum value. Used for clamping on commit and arrow key upper bound. */
  max?: number;
  /** Step increment. Used for snap-to-step on commit and arrow key increment. @default 1 */
  step?: number;
  /** Visual size variant. @selector .tug-value-input-sm | .tug-value-input-md | .tug-value-input-lg @default "md" */
  size?: "sm" | "md" | "lg";
  /** @selector [aria-disabled="true"] @default false */
  disabled?: boolean;
}
```

### Behavior

**Display mode (not focused):**
- Shows `formatter.format(value)` or `String(value)`
- Updated imperatively via `useLayoutEffect` when `value` prop changes and the input is not being edited [L06]

**Focus (click or tab):**
- Sets input to raw `String(value)` for editing
- Selects all text (type-to-replace)
- Mouseup guard prevents browser deselection after click-to-focus

**Editing:**
- Keystrokes go directly to DOM — no React state, no onChange, no re-renders [L06]

**Arrow keys (Up/Down):**
- Increment/decrement by `step` (default 1)
- Clamp to `min`/`max`
- Commit immediately via `onValueCommit`
- Update display imperatively

**Enter or blur:**
- Reads DOM value, validates via `validateNumericInput(raw, { min, max, step })`
- Calls `onValueCommit` if valid
- Restores formatted display imperatively

**Escape:**
- Reverts to display value, exits edit mode without committing

**Input width:**
- Auto-sized via `ch` units based on formatted max value length

## Files

```
tugdeck/src/components/tugways/tug-value-input.tsx
tugdeck/src/components/tugways/tug-value-input.css
tugdeck/src/components/tugways/tug-slider.tsx  (simplified — replace inline logic with TugValueInput)
tugdeck/src/components/tugways/tug-slider.css  (remove slider-specific input styles, use TugValueInput)
```

## CSS

Standard component CSS file following the authoring guide:
- @tug-pairings (compact + expanded)
- body{} aliases: `--tugx-value-input-*` resolving to `--tug7-*` field tokens
- .tug-value-input — root input element
- Size variants: .tug-value-input-sm, .tug-value-input-md, .tug-value-input-lg
- States: rest, focus, disabled
- Tokens: field-surface for bg, field-text for color, field-border for border (same token family as TugInput but compact sizing)

## How TugSlider Changes

The ~80 lines of inline ref/handler code in tug-slider.tsx are replaced by:

```tsx
<TugValueInput
  value={value}
  onValueCommit={onValueChange}
  formatter={formatter}
  min={min}
  max={max}
  step={step}
  size={size}
  disabled={disabled}
/>
```

The slider's CSS removes the `.tug-slider-value-input` rules and the `--tugx-slider-input-*` aliases — TugValueInput owns its own styling.

## Checkpoints

- `bun run build` exits 0
- `bun run test` exits 0
- `bun run audit:tokens lint` exits 0
- Select-all on click-to-focus works
- Select-all on tab-to-focus works
- Arrow Up/Down increments/decrements by step, clamps to min/max
- Type a number, press Enter → value commits
- Type garbage, press Enter → reverts to current value
- Escape → reverts without committing
- Formatter round-trip: "75%" displays, editing shows "0.75", commit restores "75%"
- Slider continuous drag still updates the value input display in real time
- data-slot="tug-value-input" on root element
- Renders correctly in Component Gallery across themes

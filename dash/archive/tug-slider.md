# tug-slider

Wraps `@radix-ui/react-slider` with optional label, editable value input, and continuous updates.

## Pre-step

Install Radix Slider: `bun add @radix-ui/react-slider`

## Design

```
Inline layout:
┌─────────────────────────────────────────────┐
│  Volume          ━━━━━━●━━━━━━━━━━  [ 42 ]  │
│  (label)         (track + thumb)    (input) │
└─────────────────────────────────────────────┘

Stacked layout:
┌─────────────────────────────────────────────┐
│  Volume                                     │
│  ━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━  [ 42 ]   │
└─────────────────────────────────────────────┘
```

## Props

```typescript
export interface TugSliderProps extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange"> {
  /** Current value. Controlled. */
  value: number;
  /** Fires continuously during drag. */
  onValueChange: (value: number) => void;
  /** Minimum value. Default: 0. */
  min?: number;
  /** Maximum value. Default: 100. */
  max?: number;
  /** Step increment. Default: 1. */
  step?: number;
  /** Optional label text. */
  label?: string;
  /** Layout when label is present. Default: "inline". */
  layout?: "inline" | "stacked";
  /** Show editable value input. Default: true. */
  showValue?: boolean;
  /** Formatter for display/parse. Created via createNumberFormatter(). */
  formatter?: TugFormatter<number>;
  /** Size variant. @selector .tug-slider-sm | .tug-slider-md | .tug-slider-lg @default "md" */
  size?: "sm" | "md" | "lg";
  /** @selector [data-disabled] @default false */
  disabled?: boolean;
}
```

**Key decisions:**
- `value` / `onValueChange` use single numbers, not arrays. Radix supports multi-thumb but we don't need it yet. Single-value API is simpler.
- `formatter` is optional. When provided, the value input shows formatted text (e.g., "75%") and parsing uses the formatter's `parse()`. When absent, plain number display.
- `layout` only matters when `label` is provided. Without a label, layout has no effect.

## Editable Value Input

The input field to the right of the track that shows and accepts numeric values.

**Display mode (default):**
- Shows the current value, formatted if a formatter is provided
- Clicking or tabbing into it switches to edit mode

**Edit mode (on focus):**
- Selects all text for easy replacement
- Shows the raw numeric value (not formatted) so the user can type a plain number
- Does NOT update the slider while typing — avoids "typing 12 sets to 1"
- On Enter or blur: parse → clamp → snap → commit via onValueChange
- On Escape: revert to current value, exit edit mode
- If parse fails (non-numeric input): revert to current value

**Width:**
- Auto-sizes based on the max value's formatted width so the input doesn't jump around
- Computed once from `formatter?.format(max) ?? String(max)` character count

## Files

```
tugdeck/src/components/tugways/tug-slider.tsx
tugdeck/src/components/tugways/tug-slider.css
tugdeck/src/components/tugways/cards/gallery-slider.tsx
```

## TSX Structure

- forwardRef on root div
- data-slot="tug-slider"
- CSS import first
- cn() for className composition
- ...rest spread on root
- Uses tug-format.ts (TugFormatter) for value display/parse
- Uses tug-validate.ts (clamp, snapToStep, validateNumericInput) for input validation

## CSS Structure

- @tug-pairings (compact + expanded)
- body{} aliases: --tugx-slider-* resolving to --tug7-* in one hop
- .tug-slider — root flex container
- .tug-slider-label — optional label
- .tug-slider-track — Radix Track
- .tug-slider-range — Radix Range (filled portion)
- .tug-slider-thumb — Radix Thumb
- .tug-slider-value-input — editable input field
- Size variants: .tug-slider-sm, .tug-slider-md, .tug-slider-lg
- States: rest → hover → active → focus → disabled
- Layout variants: .tug-slider-inline, .tug-slider-stacked

## Token Design

Track and thumb use control-state tokens following the established pattern:

- Track background (unfilled): surface token, subtle
- Track range (filled): accent fill or role-based fill
- Thumb: solid fill with border, hover/active states
- Value input: field tokens (same family as tug-input)

## Gallery Card

Interactive demo showing:
- All three sizes (sm, md, lg)
- Both layouts (inline, stacked)
- With and without label
- With and without value input
- With a formatter (percentage, decimal)
- Disabled state
- Real-time value display showing continuous updates

## Checkpoints

- `bun run build` exits 0
- `bun run test` exits 0
- `bun run audit:tokens lint` exits 0
- Continuous value updates during drag
- Value input: type a number, press Enter → slider moves
- Value input: type garbage, press Enter → reverts to current value
- Value input: type out-of-range number → clamps
- Keyboard: arrow keys on thumb move by step
- Tab order: label (skip) → thumb → value input
- Disabled state prevents all interaction

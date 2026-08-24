# tug-textarea

*Multi-line text input. The third member of the text-field family alongside tug-input and tug-label.*

---

## Design Intent

TugTextarea is the multi-line sibling of TugInput. Where TugInput wraps `<input>`, TugTextarea wraps `<textarea>`. The two share a visual identity: same border treatment, same token set, same size scale, same validation states, same hover/focus/disabled/read-only state progression. A user looking at a TugInput and a TugTextarea side by side should see them as two sizes of the same control.

TugLabel already covers the labeling pattern — callers pair TugLabel + TugTextarea themselves, just as they do with TugLabel + TugInput. No built-in label prop on the textarea.

---

## Family Alignment: input / textarea / label

The "text-field family" shares these traits:

| Trait | TugInput | TugTextarea | TugLabel |
|-------|----------|-------------|----------|
| Size variants | sm / md / lg | sm / md / lg | sm / md / lg |
| Font sizes | 0.75 / 0.8125 / 0.875rem | same | same |
| Border radius | 6px (0.375rem) | same | n/a |
| Validation states | default / invalid / valid / warning | same | n/a |
| Token set | `--tug7-*-field-*-plain-*` | same tokens exactly | `--tug7-*-field-text-normal-label-*` |
| TugBox cascade | `useTugBoxDisabled()` | same | n/a (labels don't disable) |
| `data-slot` | `tug-input` | `tug-textarea` | `tug-label` |
| `forwardRef` target | `HTMLInputElement` | `HTMLTextAreaElement` | `HTMLLabelElement` |

The CSS for TugTextarea reuses the exact same `--tug7-*-field-*` tokens as TugInput. No new tokens needed — they render on the same surface with the same element colors. The pairings table is identical.

---

## Props

```typescript
export type TugTextareaSize = "sm" | "md" | "lg";
export type TugTextareaValidation = "default" | "invalid" | "valid" | "warning";
export type TugTextareaResize = "horizontal" | "vertical" | "both";

export interface TugTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> {

  /** Visual size variant. Controls font size and padding.
   *  @selector .tug-textarea-size-sm | .tug-textarea-size-md | .tug-textarea-size-lg
   *  @default "md" */
  size?: TugTextareaSize;

  /** Validation state. Controls border color.
   *  @selector .tug-textarea-invalid | .tug-textarea-valid | .tug-textarea-warning
   *  @default "default" */
  validation?: TugTextareaValidation;

  /** User-resizable direction. Sets CSS resize property.
   *  When omitted, the textarea is not user-resizable (resize: none).
   *  @selector .tug-textarea-resize-horizontal | .tug-textarea-resize-vertical | .tug-textarea-resize-both
   *  @default undefined (not resizable) */
  resize?: TugTextareaResize;

  /** Number of visible text rows. Maps directly to the HTML rows attribute.
   *  @default 3 */
  rows?: number;

  /** Maximum character count. When provided, renders a character counter
   *  below the textarea showing "current / max". The textarea also gets
   *  maxLength set on the native element.
   *  @default undefined (no limit, no counter) */
  maxLength?: number;

  /** Auto-resize: grow the textarea height to fit content, up to maxRows.
   *  When true, the textarea expands vertically as the user types.
   *  Mutually exclusive with resize prop (auto-resize overrides user resize).
   *  Implemented via imperative DOM height adjustment [L06].
   *  @default false */
  autoResize?: boolean;

  /** Maximum rows before scrolling kicks in. Only meaningful when autoResize is true.
   *  @default undefined (no limit — grows indefinitely) */
  maxRows?: number;
}
```

### Props NOT included (and why)

- **`label`**: Not a textarea concern. Use TugLabel separately, same as with TugInput.
- **`resize: "none"`**: Omitting the resize prop means not resizable. No need for an explicit "none" value (same reasoning as TugBox).
- **`minRows`**: The `rows` prop already controls the minimum visible height.
- **`autoComplete`**: Pass through via native textarea attributes (spread `...rest`).

---

## Resize Behavior

Borrowed directly from TugBox's resize model:

| `resize` value | CSS | Notes |
|----------------|-----|-------|
| omitted | `resize: none` | Default. Fixed height (or auto-resize if `autoResize` is set). |
| `"horizontal"` | `resize: horizontal; overflow: hidden` | Rarely useful for textarea, but included for completeness. |
| `"vertical"` | `resize: vertical; overflow: auto` | The classic textarea resize handle. |
| `"both"` | `resize: both; overflow: auto` | Full resize freedom. |

Note: native `<textarea>` defaults to `resize: both` in browsers. We explicitly set `resize: none` as our default and require the caller to opt in. This is more intentional and matches TugBox's approach.

When `autoResize` is true, the `resize` prop is ignored — the textarea height is driven by content, not user drag.

---

## Auto-Resize Implementation

Auto-resize adjusts the textarea's height imperatively via DOM [L06]:

1. On every `input` event (and on mount), set `element.style.height = "auto"` to collapse, then read `element.scrollHeight`, then set `element.style.height = scrollHeight + "px"`.
2. If `maxRows` is set, compute `maxHeight = lineHeight * maxRows + verticalPadding` and cap with `element.style.maxHeight`. Beyond this, the textarea scrolls.
3. Use `useLayoutEffect` for the initial sizing to avoid a visible flash.
4. Listen to `input` events via the native element (not React's onChange) for immediate response [L06].

This is a well-established pattern. No React state for the height — pure imperative DOM.

---

## Character Counter

When `maxLength` is provided:

- The native `maxLength` attribute prevents further input.
- A `<span className="tug-textarea-counter">` renders below the textarea showing `"{current} / {max}"`.
- Counter uses `--tug7-element-field-text-normal-label-rest` (same as label text).
- When within 10% of the limit, counter gets a warning color (`--tug7-element-field-border-normal-caution-rest`).
- When at the limit, counter gets a danger color (`--tug7-element-field-border-normal-danger-rest`).
- Counter font size matches the textarea's size variant (sm/md/lg).

The counter requires a wrapper `<div>` around the textarea + counter span. This wrapper gets `data-slot="tug-textarea"` and the textarea itself has no data-slot.

Actually — let's keep it simpler. The counter is a span positioned below the textarea. The component returns a fragment with `<textarea>` + `<span>` when maxLength is set, and just `<textarea>` when not. But fragments can't take refs or className.

Better: when `maxLength` is set, render a wrapper `<div className="tug-textarea-wrapper">` containing the `<textarea>` and the counter `<span>`. When not set, render just the `<textarea>`. The ref always forwards to the `<textarea>` element. The `data-slot="tug-textarea"` goes on the textarea in both cases.

---

## Size Scale

Matching TugInput exactly in font size, with textarea-appropriate padding:

| Size | Font size | Padding | Min height (via rows) |
|------|-----------|---------|----------------------|
| sm | 0.75rem | 0.375rem 0.5rem | rows × line-height |
| md | 0.8125rem | 0.5rem 0.625rem | rows × line-height |
| lg | 0.875rem | 0.625rem 0.75rem | rows × line-height |

Horizontal padding matches TugInput. Vertical padding is slightly more generous than horizontal to give text breathing room in the multi-line context.

---

## State Tokens

Identical to TugInput — same token names, same surfaces:

| State | Surface | Border | Text |
|-------|---------|--------|------|
| Rest | `--tug7-surface-field-primary-normal-plain-rest` | `--tug7-element-field-border-normal-plain-rest` | `--tug7-element-field-text-normal-plain-rest` |
| Hover | `--tug7-surface-field-primary-normal-plain-hover` | `--tug7-element-field-border-normal-plain-hover` | — |
| Focus | `--tug7-surface-field-primary-normal-plain-focus` | `--tug7-element-field-border-normal-plain-active` | — |
| Disabled | `--tug7-surface-field-primary-normal-plain-disabled` | `--tug7-element-field-border-normal-plain-disabled` | `--tug7-element-field-text-normal-plain-disabled` |
| Read-only | `--tug7-surface-field-primary-normal-plain-readonly` | `--tug7-element-field-border-normal-plain-readonly` | `--tug7-element-field-text-normal-plain-readonly` |
| Invalid | — | `--tug7-element-field-border-normal-danger-rest` | — |
| Valid | — | `--tug7-element-field-border-normal-success-rest` | — |
| Warning | — | `--tug7-element-field-border-normal-caution-rest` | — |

No new tokens. The field token set already covers everything.

---

## CSS Structure

```
tug-textarea.css
├── Base (.tug-textarea) — reset, font, border, background, transition
├── Placeholder (.tug-textarea::placeholder)
├── Hover (.tug-textarea:hover:not(:disabled):not(:read-only):not(:focus))
├── Focus (.tug-textarea:focus)
├── Disabled (.tug-textarea:disabled, .tug-textarea:disabled::placeholder)
├── Read-only (.tug-textarea:read-only:not(:disabled))
├── Size variants (.tug-textarea-size-sm/md/lg)
├── Validation (.tug-textarea-invalid/valid/warning :not(:focus))
├── Resize (.tug-textarea-resize-horizontal/vertical/both)
├── Auto-resize (.tug-textarea-auto-resize) — overflow: hidden (for scrollHeight measurement)
├── Counter (.tug-textarea-counter, .tug-textarea-counter-warning, .tug-textarea-counter-danger)
└── Wrapper (.tug-textarea-wrapper) — only present when maxLength is set
```

This is a near-mirror of `tug-input.css` structure. The main additions are the resize classes, auto-resize overflow behavior, and the counter.

---

## Implementation Plan

Two dashes:

### Dash 1: Component + CSS
- `tug-textarea.tsx` — component with all props
- `tug-textarea.css` — all styles mirroring tug-input.css
- Wire up TugBox disabled cascade
- Auto-resize via imperative DOM
- Character counter

### Dash 2: Gallery card
- `cards/gallery-textarea.tsx` — demo all features:
  - Sizes (sm/md/lg)
  - Validation states
  - Resize variants
  - Auto-resize demo
  - Character counter
  - Disabled and read-only
  - Inside a TugBox (disabled cascade)

---

## Laws Compliance

| Law | How |
|-----|-----|
| L01 | No root.render() — standard component |
| L06 | Auto-resize height via imperative DOM, not React state |
| L15 | All visual states via `--tug7-field-*` tokens |
| L16 | Pairings declared in CSS header |
| L19 | Follows component authoring guide |
| L20 | Reuses field tokens (no compound composition — this is a simple wrapper) |

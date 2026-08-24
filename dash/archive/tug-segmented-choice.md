# tug-segmented-choice

*Mutually exclusive segment picker modeled on Apple's UISegmentedControl. Horizontal row of connected segments with sliding selection indicator inside a unified visual frame.*

---

## Design

TugSegmentedChoice is a single-selection control rendered as a row of connected segments inside a pill-shaped container. A sliding background highlight moves between segments to indicate the current selection. This is an original component — no Radix primitive wraps it. Accessibility and keyboard navigation are hand-implemented.

The visual identity is a **unified frame** containing segments, with an **animated indicator pill** that slides behind the selected segment. This distinguishes it from TugRadioGroup (discrete buttons with gaps, circle-and-dot indicators) and TugTabBar (view-level navigation with underline indicator).

### This Is Not a Tab Bar

TugSegmentedChoice is a **value picker** — it selects a setting, a mode, or a filter. It does NOT switch views or content panels. If you need to switch between different content views, use TugTabBar instead.

Do not wire a TugSegmentedChoice's `onValueChange` to swap out child components or content sections. That pattern produces a "poor man's tab bar" that lacks proper accessibility semantics (`role="tablist"`, `aria-controls`, tab panel association), keyboard navigation expectations (tabs use arrow keys to move focus without selecting; segmented choice selects on arrow), and the progressive overflow behavior that TugTabBar provides.

| | tug-segmented-choice | tug-tab-bar |
|---|---|---|
| Purpose | Pick a value | Switch a view |
| ARIA role | `radiogroup` | `tablist` |
| Keyboard | Arrow keys select immediately | Arrow keys move focus; Enter/Space selects |
| Overflow | Not supported — keep options few | Collapses → icon-only → dropdown |
| Indicator | Sliding background pill | Underline |
| Content | Controls a value, not a panel | Controls which panel is visible |

### Anatomy

```
TugSegmentedChoice (root — div, role="radiogroup")
├── indicator pill (div, absolutely positioned, slides via transform)
└── segments (× N — button, role="radio")
    └── label text
```

---

## Props

```typescript
export type TugSegmentedChoiceSize = "sm" | "md" | "lg";
export type TugSegmentedChoiceRole = "option" | "action" | "agent" | "data" | "success" | "caution" | "danger";

export interface TugSegmentedChoiceItem {
  /** Unique value for this segment. */
  value: string;
  /** Display label. */
  label: string;
  /** Disables this segment individually. */
  disabled?: boolean;
}

export interface TugSegmentedChoiceProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "role" | "defaultValue" | "onChange"> {
  /** The items to display as segments. */
  items: TugSegmentedChoiceItem[];
  /** Current selected value. @selector [data-state="active"] on segments */
  value: string;
  /** Fires when selection changes. */
  onValueChange: (value: string) => void;
  /**
   * Visual size.
   * @selector .tug-segmented-choice-sm | -md | -lg
   * @default "md"
   */
  size?: TugSegmentedChoiceSize;
  /**
   * Semantic role color for the selected indicator.
   * @selector [data-role="<role>"]
   */
  role?: TugSegmentedChoiceRole;
  /**
   * Disables all segments.
   * @selector [data-disabled]
   */
  disabled?: boolean;
  /** Accessible label for the group. */
  "aria-label"?: string;
}
```

### Why `items` Instead of Children

Segments are data-driven (value + label), not arbitrary React nodes. An `items` array guarantees uniform structure, makes it possible to measure segment widths for the sliding indicator, and avoids the complexity of React.Children manipulation. This follows the TugPopupButton/TugPopupMenu pattern.

---

## Visual Behavior

**Container:** Pill-shaped frame with a subtle background fill. Holds all segments in a tight row with no gaps.

**Selected segment:** A sliding indicator pill sits behind the selected segment's text. The pill background is the accent/active color. The selected segment's text is high-contrast against the pill.

**Unselected segments:** Text sits directly on the container background. Standard rest → hover progression.

**Sliding animation:** When selection changes, the indicator pill translates horizontally to the new segment's position. Uses CSS `transform: translateX()` with a transition for smooth GPU-accelerated animation. The pill's width adjusts to match the target segment's width. [L06] — this is appearance-zone work; the indicator position is computed imperatively from DOM measurements and applied via refs, not React state.

**Hover:** Unselected segments show a subtle hover highlight. The selected segment's hover is on the indicator pill itself.

**Disabled:** Standard opacity treatment. Individual segments can be disabled (skipped by keyboard navigation). Entire group can be disabled.

**Focus:** `:focus-visible` ring on the focused segment. Arrow keys move selection immediately (unlike tabs where arrows move focus).

---

## Token Strategy

Own tokens scoped to the `segment` component slot. The indicator pill, container frame, and segment text all get segment-specific tokens.

### Segmented-Choice Tokens

**Container (surface):**
```
--tug7-surface-segment-primary-normal-plain-rest       ← container background
```

**Indicator pill (surface — injected via role, same as checkbox/switch/radio):**
```
--tugx-segment-on-color                                ← injected: var(--tug7-surface-toggle-primary-normal-${role}-rest)
--tugx-segment-on-hover-color                          ← injected: var(--tug7-surface-toggle-primary-normal-${role}-hover)
--tugx-segment-disabled-color                          ← injected: var(--tug7-surface-toggle-primary-normal-${role}-disabled)
```

**Segment text (element):**
```
--tug7-element-segment-text-normal-plain-rest          ← unselected text
--tug7-element-segment-text-normal-plain-hover         ← unselected text, hovered
--tug7-element-segment-text-normal-active-rest         ← selected text (on indicator)
--tug7-element-segment-text-normal-plain-disabled      ← disabled text
```

**Segment border (element):**
```
--tug7-element-segment-border-normal-plain-rest        ← container border
```

### Contrast Pairings

| Element | Surface | Role | Context |
|---------|---------|------|---------|
| `--tug7-element-segment-text-normal-active-rest` | `--tugx-segment-on-color (injected, role-dependent)` | control | selected text on indicator pill |
| `--tug7-element-segment-text-normal-plain-rest` | `--tug7-surface-segment-primary-normal-plain-rest` | control | unselected text on container |
| `--tug7-element-segment-border-normal-plain-rest` | `--tug7-surface-segment-primary-normal-plain-rest` | control | container border on container bg |

---

## Keyboard Navigation

Hand-implemented (no Radix):

- **Arrow Left/Right:** Move selection to previous/next enabled segment. Wraps at ends.
- **Home/End:** Select first/last enabled segment.
- **Tab:** Moves focus into/out of the control (the whole group is one tab stop).

Arrow keys select immediately — this matches `role="radiogroup"` semantics and Apple's UISegmentedControl behavior. This is different from `role="tablist"` where arrows move focus without selecting.

---

## Sliding Indicator Implementation [L06]

The indicator pill position and width are computed from DOM measurements and applied imperatively — never through React state.

1. Each segment is a ref'd button. On mount and on selection change, measure the active segment's `offsetLeft` and `offsetWidth`.
2. Apply `transform: translateX(${left}px)` and `width: ${width}px` to the indicator element via a ref.
3. CSS `transition: transform <duration> ease, width <duration> ease` handles the animation.
4. Use `useLayoutEffect` for initial positioning (before paint). Subsequent changes use the same ref-based update in the `onValueChange` flow.

No `useState` for indicator position. No `useEffect` triggering re-renders. Pure appearance-zone work. [L06]

---

## Implementation Notes

1. **Original component, no Radix.** No Radix primitive matches this pattern. The component manages its own ARIA attributes, keyboard handling, and focus.

2. **`role="radiogroup"` + `role="radio"`.** Each segment is `role="radio"` with `aria-checked`. The container is `role="radiogroup"`. This matches the semantics: mutually exclusive selection from a fixed set.

3. **`items` prop, not children.** Segments come from a data array, not JSX children. This enables width measurement, uniform structure, and index-based keyboard navigation.

4. **Controlled only.** `value` + `onValueChange` are required. No `defaultValue` — the caller always knows the selection. This simplifies the indicator positioning logic.

5. **Role color injection.** Same pattern as checkbox/switch/radio: compute `tokenSuffix` from the `role` prop, inject `--tugx-segment-on-color` and related custom properties as inline styles pointing to `--tug7-surface-toggle-primary-normal-${tokenSuffix}-*`. Default is accent. The indicator pill uses the injected color.

---

## Files

```
tugdeck/src/components/tugways/tug-segmented-choice.tsx   — TugSegmentedChoice
tugdeck/src/components/tugways/tug-segmented-choice.css   — Container, indicator, segments
tugdeck/styles/themes/brio.css                             — segment tokens
tugdeck/styles/themes/harmony.css                          — segment tokens
tugdeck/src/components/gallery/gallery-segmented-choice.tsx — Gallery card
```

---

## Checklist

- [ ] Original component (no Radix wrapper)
- [ ] `role="radiogroup"` on root, `role="radio"` + `aria-checked` on segments
- [ ] Sliding indicator via imperative DOM measurement + transform [L06]
- [ ] Own segment component tokens (`--tug7-{surface,element}-segment-*`)
- [ ] `items` array prop for uniform segment structure
- [ ] Controlled only (`value` + `onValueChange`)
- [ ] Arrow key selection (immediate, with wrapping)
- [ ] Individual + group-level disable
- [ ] Size variants (sm, md, lg)
- [ ] `data-slot="tug-segmented-choice"` on root
- [ ] `@tug-pairings` with segment-specific contrast pairings
- [ ] Role color injection for indicator pill (same pattern as checkbox/switch/radio)
- [ ] Module docstring cites [L06], [L16], [L19]
- [ ] Explicitly NOT a tab bar — documented in component and gallery
- [ ] Gallery card with representative examples
- [ ] Theme tokens in brio.css and harmony.css
- [ ] `bun run build` passes
- [ ] `bun run audit:tokens lint` passes

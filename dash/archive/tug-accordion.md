# tug-accordion — Roadmap Proposal

*Collapsible content sections wrapping `@radix-ui/react-accordion`.*

---

## What It Is

A disclosure widget: a vertical stack of collapsible sections, each with a trigger header and expandable content. Radix handles all the hard parts — ARIA, keyboard navigation, focus management, enter/exit DOM lifecycle. We wrap it with tugways tokens, consistent styling, and a chevron indicator.

**Not** a card collapse (tug-card owns that). Not a tree view. Just stacked disclosure sections.

---

## Radix Primitive

`@radix-ui/react-accordion` — **not currently installed**, needs `bun add`.

### Parts We Wrap

| Radix Part | Our Element | Purpose |
|------------|-------------|---------|
| `Accordion.Root` | TugAccordion root | Container, manages open state |
| `Accordion.Item` | TugAccordionItem | Individual section |
| `Accordion.Header` | Rendered inside item | Semantic heading wrapper |
| `Accordion.Trigger` | Trigger button | Click/keyboard target |
| `Accordion.Content` | Content panel | Collapsible content area |

### Key Radix Features We Get Free

- **Two modes**: `type="single"` (one open at a time) and `type="multiple"` (any combination)
- **Keyboard**: Space/Enter toggle, Arrow keys between triggers, Home/End
- **ARIA**: `role="region"`, `aria-expanded`, `aria-controls`, `aria-labelledby`
- **Data attributes**: `data-state="open"|"closed"`, `data-disabled`, `data-orientation`
- **Animation CSS variables**: `--radix-accordion-content-height` and `--radix-accordion-content-width` — set on the Content element during open/close, enabling CSS keyframe animations [L14]

---

## Design Decisions

### D1: Wrapper, Not Composition

This is a straightforward Radix wrapper like tug-checkbox or tug-switch. Radix provides the complete interactive behavior. We add:
- Tugways token-driven styling
- Chevron rotation indicator
- Consistent sizing
- TugBox disabled cascade

No internal sub-components needed. No variant dispatch.

### D2: Two Exported Components

```
TugAccordion      — wraps Accordion.Root
TugAccordionItem  — wraps Accordion.Item + Header + Trigger + Content
```

TugAccordionItem is a convenience that bundles the four Radix parts (Item, Header, Trigger, Content) into one component with `trigger` and `children` props. This matches how accordions are actually used — you don't need to reach into the Header/Trigger/Content decomposition for standard cases.

```tsx
<TugAccordion type="single" collapsible>
  <TugAccordionItem value="section-1" trigger="Getting Started">
    <p>Content here...</p>
  </TugAccordionItem>
  <TugAccordionItem value="section-2" trigger="Configuration">
    <p>More content...</p>
  </TugAccordionItem>
</TugAccordion>
```

The `trigger` prop accepts `ReactNode` — usually a string, but could be a more complex layout.

### D3: Chevron Indicator

A ChevronDown icon (from lucide-react, already used by tug-card and tug-popup-button) rotates from 0° to 180° on open. Pure CSS transform on `[data-state="open"]` — no React state [L06].

The chevron sits at the trailing edge of the trigger, auto-positioned via flexbox. It's part of TugAccordionItem's trigger rendering, not a separate component.

### D4: Animation via CSS Keyframes [L14]

Radix Presence manages DOM lifecycle. Content expand/collapse uses CSS `@keyframes` that reference `--radix-accordion-content-height`:

```css
@keyframes tug-accordion-expand {
  from { height: 0; opacity: 0; }
  to   { height: var(--radix-accordion-content-height); opacity: 1; }
}

@keyframes tug-accordion-collapse {
  from { height: var(--radix-accordion-content-height); opacity: 1; }
  to   { height: 0; opacity: 0; }
}
```

This obeys [L14] — Radix Presence owns enter/exit DOM lifecycle; we use CSS keyframes, not WAAPI or TugAnimator.

Duration scales via `calc(Xms * var(--tug-timing, 1))` for motion compliance [L13].

### D5: No Role Color Injection

Accordion is structural/informational, not a toggle control. There's no "on state" that carries semantic meaning. No `role` prop, no `--tugx-*` color injection. Styling uses field/global tokens:
- Trigger text: element-field-text tokens
- Borders: element-global-border tokens (dividers between items)
- Content background: transparent (inherits parent surface)

### D6: No Size Variants (Initially)

One size. The trigger has comfortable padding and the content area has consistent internal spacing. If size variants prove necessary after gallery testing, they can be added — but accordion content is typically variable-height, making size variants less meaningful than for compact controls.

### D7: Border Variants

Four variant styles via the `variant` prop (default `"separator"`):

- **`"separator"`** — divider lines between items. Default.
- **`"outline"`** — single border around the entire group with rounded corners. Internal dividers between items. `overflow: hidden` clips trigger hover to corner radius.
- **`"inset"`** — each item has its own border with rounded corners, gap between items. `overflow: hidden` on each item.
- **`"plain"`** — no borders at all.

### D8: Disabled State

- Group-level: `disabled` on TugAccordion disables all items (passed to Radix Root)
- Item-level: `disabled` on TugAccordionItem disables one item (passed to Radix Item)
- TugBox cascade: `useTugBoxDisabled()` at the TugAccordion level, merged with `disabled` prop
- Disabled items: dimmed opacity, no pointer events, chevron frozen

---

## Props

### TugAccordion

Uses a discriminated union to preserve Radix's type safety — `value` and `onValueChange` are narrowed by `type`. Matches the pattern used by tug-radio-group.

```typescript
type TugAccordionSingleProps = {
  /** One item open at a time. */
  type: "single";
  /** Allow all items to be closed. @default false */
  collapsible?: boolean;
  /** Currently open item. */
  value?: string;
  /** Initial open item. */
  defaultValue?: string;
  /** Called when open item changes. */
  onValueChange?: (value: string) => void;
};

type TugAccordionMultipleProps = {
  /** Any combination of items open. */
  type: "multiple";
  /** Currently open items. */
  value?: string[];
  /** Initial open items. */
  defaultValue?: string[];
  /** Called when open items change. */
  onValueChange?: (value: string[]) => void;
};

export type TugAccordionVariant = "separator" | "outline" | "inset" | "plain";

export type TugAccordionProps = (TugAccordionSingleProps | TugAccordionMultipleProps) & {
  /** Border style. @selector .tug-accordion-{variant} @default "separator" */
  variant?: TugAccordionVariant;
  /** @selector [data-disabled] @default false */
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
};
```

### TugAccordionItem

```typescript
export interface TugAccordionItemProps {
  /** Unique identifier for this item. */
  value: string;
  /** Trigger content — the clickable header. Accepts ReactNode. */
  trigger: React.ReactNode;
  /** @selector [data-state="open"] | [data-state="closed"] */
  /** Collapsible content. */
  children: React.ReactNode;
  /** @selector [data-disabled] @default false */
  disabled?: boolean;
  className?: string;
}
```

---

## Token Strategy

Use existing global/field tokens — no new accordion-specific tokens needed.

| Element | Token | Purpose |
|---------|-------|---------|
| Trigger text | `--tug7-element-field-text-normal-label-rest` | Header text color |
| Trigger hover | `--tug7-element-field-text-normal-label-hover` | Header hover color |
| Chevron icon | `--tug7-element-field-text-normal-placeholder-rest` | Muted icon color |
| Item border | `--tug7-element-global-border-normal-default-rest` | Divider between items |
| Trigger bg (hover) | `--tug7-surface-field-primary-normal-plain-hover` | Subtle hover highlight |
| Content text | inherits | Content inherits parent text color |
| Disabled opacity | `--tugx-control-disabled-opacity` | Standard dim |

---

## CSS Structure

```
tug-accordion.css:
  @tug-pairings table
  Base (.tug-accordion)
  Bordered variant (.tug-accordion-bordered)
  Item (.tug-accordion-item)
  Trigger (.tug-accordion-trigger) — flexbox, rest → hover → active → disabled
  Chevron (.tug-accordion-chevron) — rotation on [data-state="open"]
  Content (.tug-accordion-content) — expand/collapse keyframes
  Disabled state
```

---

## File Plan

```
tugdeck/src/components/tugways/
  tug-accordion.tsx     — TugAccordion + TugAccordionItem
  tug-accordion.css     — All styles

tugdeck/src/components/tugways/cards/
  gallery-accordion.tsx — Gallery demo card

tugdeck/src/__tests__/
  tug-accordion.test.tsx — Behavioral tests
```

Single file pair. Both components in one file (TugAccordionItem is a sub-component, per authoring guide pattern for structural parts).

---

## Gallery Card Sections

1. **Single Mode** — One item open at a time, collapsible
2. **Multiple Mode** — Multiple items open simultaneously
3. **Default Open** — Item pre-expanded via defaultValue
4. **Variants** — separator, outline, inset, plain
5. **Disabled** — Group disabled + individual item disabled
6. **TugBox Cascade** — Disabled via parent TugBox
7. **Rich Triggers** — Trigger with icon + description layout
8. **Nested Content** — Content containing other tugways components

---

## Dashes

Three dashes, building incrementally:

1. **Component implementation** — Install Radix package, build TugAccordion + TugAccordionItem with full CSS, animation, disabled cascade
2. **Gallery card** — All 8 sections above, registered in component gallery
3. **Tests** — Render, keyboard, disabled, open/close state, TugBox cascade

---

## Dependencies

- `@radix-ui/react-accordion` — must install
- `lucide-react` — ChevronDown icon (already installed)
- `useTugBoxDisabled` — existing TugBox context hook
- No new theme tokens needed

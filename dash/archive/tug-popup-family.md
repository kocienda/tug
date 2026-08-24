# tug-popup-family — Consolidated Roadmap Proposal

*Three components that share the "anchored popup" pattern: context-menu, popover, confirm-popover.*

---

## The Popup Family

Five tugways components share the behavior of popping interactive content from a source element. Two are already built. Three are new.

| Component | Family | Trigger | Content | Status |
|-----------|--------|---------|---------|--------|
| tug-popup-button | Menu | Click | Action menu | **Done** |
| tug-context-menu | Menu | Right-click | Action menu | **New** |
| tug-tooltip | Floating | Hover/focus | Non-interactive label | **Done** |
| tug-popover | Popover | Click | Arbitrary interactive | **New** |
| tug-confirm-popover | Popover | Click | Confirmation dialog | **New** |

### Two Families, Not Five Separate Things

**Menu family** — Action lists with arrow-key navigation, typeahead, nested submenus. The user picks one item and it fires. Radix DropdownMenu (popup-button) and Radix ContextMenu (context-menu) share the same WAI-ARIA Menu pattern, keyboard contract, and item semantics.

**Popover family** — Arbitrary interactive content anchored to a trigger. Tab-based focus management, free-form layout. Radix Popover provides the primitive. Confirm-popover is a pre-built composition on top.

### Token Sovereignty [L20]

The shared visual DNA lives in **owned internal components**, not duplicated across public APIs.

**Menu family**: `tug-menu.css` owns the `menu` token scope — item styling, separators, shortcut labels, animations. The internal `tug-popup-menu` component already uses these. `tug-context-menu` will use the **same CSS classes and tokens** for its Radix ContextMenu items. One token owner, two consumers. Neither popup-button nor context-menu defines menu-scoped tokens — they delegate to the shared CSS.

**Popover family**: `tug-popover` owns the `popover` token scope — bg, border, shadow, arrow, animation. `tug-confirm-popover` composes tug-popover and adds its own content inside. Confirm-popover never touches popover tokens — it renders inside the popover's content area and adds only confirmation-specific styling (message text, button row).

**Floating surface convention**: Tooltip, menu, and popover all use the "floating surface" visual pattern (dark bg, subtle border, shadow, enter/exit animation). Each scopes to its own token namespace: `--tugx-tooltip-*`, `--tugx-menu-*`, `--tugx-popover-*`. All resolve to the same `--tug7-*` base tokens. This is independent tunability, not duplication — a theme could make tooltips darker than popovers, or give menus a different shadow. The component aliases are the tuning knobs.

---

## Component 1: tug-context-menu

*Right-click menu wrapping `@radix-ui/react-context-menu`.*

### What It Is

Right-click (or long-press on touch) opens an action menu positioned at the pointer. The menu items look and behave identically to tug-popup-button's dropdown — same CSS classes, same tokens, same blink animation on selection.

### Radix Primitive

`@radix-ui/react-context-menu` — **not currently installed**, needs `bun add`.

Key Radix features: positioned at pointer (not at trigger element), same Menu keyboard contract as DropdownMenu (arrow keys, typeahead, Enter/Space to select, Escape to close), submenus via Sub/SubTrigger/SubContent.

### Design Decisions

**D1: Reuse tug-menu.css for all item styling.** Context menu items get the same `.tug-menu-item`, `.tug-menu-item-icon`, `.tug-menu-item-label` classes. Same `--tugx-menu-*` tokens. Same hover/disabled/selected states. Zero new menu tokens. [L20]

**D2: Reuse the blink animation pattern.** The double-blink selection feedback from tug-popup-menu (via TugAnimator) is replicated in context-menu. Same keyframes, same duration token (`--tug-motion-duration-slow`), same visual. The implementation will need its own `handleSelect` with the blink logic since it wraps different Radix primitives (ContextMenu.Item vs DropdownMenu.Item).

**D3: Simple item model — same as TugPopupMenuItem.** Same `{ id, label, icon?, disabled? }` interface. Re-export from the shared type.

**D4: Trigger is the context area, not a button.** The `children` of TugContextMenu is the right-click target area (a card, a row, a region). Radix ContextMenu.Trigger wraps it with `asChild`.

**D5: Separator and label support.** Items array accepts separator markers (`{ type: "separator" }`) and label markers (`{ type: "label", label: "Section" }`) interspersed with action items. Renders Radix ContextMenu.Separator and ContextMenu.Label with existing `.tug-menu-separator` and `.tug-menu-label` classes from tug-menu.css.

**D6: No submenus in v1.** Radix supports nested submenus, but we don't need them yet. The items array is flat. Submenus can be added later by extending the item model.

### Props

```typescript
/** Action item in the context menu. */
export interface TugContextMenuItem {
  type?: "item";
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
}

/** Separator between item groups. */
export interface TugContextMenuSeparator {
  type: "separator";
}

/** Section label. */
export interface TugContextMenuLabel {
  type: "label";
  label: string;
}

export type TugContextMenuEntry =
  | TugContextMenuItem
  | TugContextMenuSeparator
  | TugContextMenuLabel;

export interface TugContextMenuProps {
  /** Menu entries — items, separators, and labels. */
  items: TugContextMenuEntry[];
  /** Called when an item is selected. Receives the item id. */
  onSelect?: (id: string) => void;
  /** Controlled open state. */
  open?: boolean;
  /** Controlled state callback. */
  onOpenChange?: (open: boolean) => void;
  /** The right-click target area. Wrapped with asChild. */
  children: React.ReactElement;
}
```

### File Plan

```
tugdeck/src/components/tugways/
  tug-context-menu.tsx  — TugContextMenu component (no CSS file — uses tug-menu.css)
```

No `.css` file. Context menu is a compositional component that delegates all visual identity to `tug-menu.css`. It may need a few lines of CSS for the content container positioning, which can go in tug-menu.css under a `.tug-context-menu-content` block.

---

## Component 2: tug-popover

*Anchored interactive popup wrapping `@radix-ui/react-popover`.*

### What It Is

Click a trigger to open a floating panel with arbitrary interactive content. Form controls, settings, pickers, info panels — anything that needs to be anchored to an element but isn't a menu. Focus is trapped inside the popover; Escape closes it and returns focus to the trigger.

**Not** a menu (no arrow keys, no typeahead). **Not** a tooltip (interactive, click-triggered, persistent). **Not** a modal dialog (anchored to trigger, no backdrop).

### Radix Primitive

`@radix-ui/react-popover` — **already installed** (^1.1.15).

Key Radix features: anchored positioning with collision avoidance, focus trapping, Escape to close, `data-state`/`data-side`/`data-align` for CSS, `--radix-popover-content-transform-origin` for directional animation, optional arrow, Close button primitive.

### Design Decisions

**D1: Compound API — Root + Trigger + Content.**

Unlike tooltip (inline API), popover exposes the Radix composition pattern directly. Popover content is arbitrary — it could be a form, a color picker, a settings panel. The inline "wrap children, pass content as prop" pattern doesn't scale for rich interactive content that callers need to compose freely.

```tsx
<TugPopover>
  <TugPopoverTrigger asChild>
    <TugPushButton>Settings</TugPushButton>
  </TugPopoverTrigger>
  <TugPopoverContent>
    <h3>Display Settings</h3>
    <TugSwitch label="Dark mode" />
    <TugSlider label="Font size" />
    <TugPopoverClose asChild>
      <TugPushButton size="sm">Done</TugPushButton>
    </TugPopoverClose>
  </TugPopoverContent>
</TugPopover>
```

**D2: Three exports + one re-export.**

- `TugPopover` — thin wrapper on Radix Popover.Root (open, onOpenChange, modal)
- `TugPopoverTrigger` — thin wrapper on Radix Popover.Trigger (asChild)
- `TugPopoverContent` — styled wrapper on Radix Portal + Content + optional Arrow. Owns the popover chrome: bg, border, shadow, padding, animation. data-slot="tug-popover".
- `TugPopoverClose` — re-export of Radix Popover.Close (no styling needed)

**D3: Popover chrome tokens.**

New `popover` component-tier aliases in `tug-popover.css`, resolving to existing base-tier tokens:

| Alias | Resolves To | Purpose |
|-------|-------------|---------|
| `--tugx-popover-bg` | `--tug7-surface-global-primary-normal-overlay-rest` | Background |
| `--tugx-popover-fg` | `--tug7-element-global-text-normal-default-rest` | Text color |
| `--tugx-popover-border` | `--tug7-element-global-border-normal-default-rest` | Border |
| `--tugx-popover-shadow` | `--tug7-element-global-shadow-normal-overlay-rest` | Box shadow |

Note: popover bg uses `overlay-rest` (same as menu), not `screen-rest` (tooltip). Popovers and menus are at the same visual elevation — heavier than tooltips.

**D4: Animation via CSS keyframes [L14].**

Fade + scale entrance/exit, same pattern as tooltip but with slightly longer duration (popovers are heavier UI):

```css
.tug-popover-content[data-state="open"] {
  animation: tug-popover-enter calc(150ms * var(--tug-timing, 1)) ease;
}
.tug-popover-content[data-state="closed"] {
  animation: tug-popover-exit calc(100ms * var(--tug-timing, 1)) ease;
}
```

Transform origin from `--radix-popover-content-transform-origin` for directional animation.

**D5: Positioning props on Content.**

Expose `side` (default "bottom"), `align` (default "center"), `sideOffset` (default 6), `arrow` (default false — popovers are visually heavier than tooltips, arrow optional). Radix handles collision avoidance automatically.

**D6: No forced padding inside Content.**

The popover chrome (bg, border, shadow, radius) is on the content wrapper. Internal padding is left to the caller — different use cases need different spacing. The content is a blank canvas inside a styled container.

### Props

```typescript
export interface TugPopoverProps {
  /** Controlled open state. */
  open?: boolean;
  /** Default open state (uncontrolled). */
  defaultOpen?: boolean;
  /** Called when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /** Whether popover is modal (traps focus, dims outside). @default false */
  modal?: boolean;
  children: React.ReactNode;
}

export interface TugPopoverTriggerProps {
  /** Render as child element. @default true */
  asChild?: boolean;
  children: React.ReactNode;
}

export interface TugPopoverContentProps {
  /**
   * Which side of the trigger to place the popover.
   * @selector [data-side="top"] | [data-side="bottom"] | [data-side="left"] | [data-side="right"]
   * @default "bottom"
   */
  side?: "top" | "bottom" | "left" | "right";
  /**
   * Alignment along the side axis.
   * @selector [data-align="start"] | [data-align="center"] | [data-align="end"]
   * @default "center"
   */
  align?: "start" | "center" | "end";
  /** Distance from trigger in px. @default 6 */
  sideOffset?: number;
  /** Show the arrow pointer. @default false */
  arrow?: boolean;
  /** Additional CSS class names. */
  className?: string;
  children: React.ReactNode;
}
```

### File Plan

```
tugdeck/src/components/tugways/
  tug-popover.tsx   — TugPopover, TugPopoverTrigger, TugPopoverContent, TugPopoverClose
  tug-popover.css   — Chrome styling, animations, token aliases
```

---

## Component 3: tug-confirm-popover

*Pre-built confirmation pattern composing tug-popover.*

### What It Is

"Are you sure you want to delete this?" — a small anchored popover with a message, a cancel button, and a confirm button. The most common destructive-action guard pattern. Appears next to the button that triggered the action, not as a centered modal.

### Design Decisions

**D1: Composes tug-popover [L20].**

Confirm-popover renders a TugPopover + TugPopoverTrigger + TugPopoverContent internally. It does not touch popover tokens — the chrome comes from tug-popover.css. Confirm-popover only styles its own content: the message text and button row.

**D2: Imperative API via ref.**

The common pattern: user clicks "Delete", code needs to ask "are you sure?", then proceed or cancel. This is promise-based:

```tsx
const confirmRef = useRef<TugConfirmPopoverHandle>(null);

async function handleDelete() {
  const confirmed = await confirmRef.current?.confirm();
  if (confirmed) {
    deleteItem();
  }
}

<TugConfirmPopover
  ref={confirmRef}
  message="Delete this item? This cannot be undone."
  confirmLabel="Delete"
  confirmRole="danger"
>
  <TugPushButton onClick={handleDelete}>Delete</TugPushButton>
</TugConfirmPopover>
```

The `confirm()` method opens the popover and returns a promise that resolves `true` (confirmed) or `false` (cancelled/dismissed).

**D3: Also supports declarative usage.**

For simpler cases, controlled `open`/`onOpenChange` + `onConfirm`/`onCancel` callbacks:

```tsx
<TugConfirmPopover
  message="Discard changes?"
  onConfirm={() => discard()}
  onCancel={() => {}}
>
  <TugPushButton>Discard</TugPushButton>
</TugConfirmPopover>
```

In declarative mode, clicking the trigger opens the popover automatically (no imperative call needed). Clicking Confirm fires `onConfirm` and closes. Clicking Cancel or pressing Escape fires `onCancel` and closes.

**D4: Confirm button defaults to role="danger".**

Most confirmations guard destructive actions. The confirm button uses `role="danger"` by default (red). Callers can override with `confirmRole` for non-destructive confirmations (e.g., `confirmRole="action"` for "Publish?").

**D5: Cancel button is always present and labeled "Cancel".**

The cancel button uses `emphasis="ghost"`. Its label can be overridden via `cancelLabel`.

**D6: Positioning defaults to side="top".**

The confirmation appears above the trigger button by default — the user's eye moves up to read the confirmation, then back down to the trigger area to decide. Can be overridden.

### Props

```typescript
export interface TugConfirmPopoverHandle {
  /** Opens the popover and returns a promise. Resolves true if confirmed, false if cancelled/dismissed. */
  confirm: () => Promise<boolean>;
}

export interface TugConfirmPopoverProps {
  /** Confirmation message. */
  message: React.ReactNode;
  /** Confirm button label. @default "Confirm" */
  confirmLabel?: string;
  /** Confirm button role. @default "danger" */
  confirmRole?: "danger" | "action" | "accent";
  /** Cancel button label. @default "Cancel" */
  cancelLabel?: string;
  /** Called when confirmed (declarative mode). */
  onConfirm?: () => void;
  /** Called when cancelled or dismissed (declarative mode). */
  onCancel?: () => void;
  /**
   * Which side of the trigger to place the popover.
   * @default "top"
   */
  side?: "top" | "bottom" | "left" | "right";
  /** Distance from trigger in px. @default 6 */
  sideOffset?: number;
  /** The trigger element. Wrapped with asChild. */
  children: React.ReactElement;
}
```

### File Plan

```
tugdeck/src/components/tugways/
  tug-confirm-popover.tsx   — TugConfirmPopover (composes TugPopover)
  tug-confirm-popover.css   — Message and button row styling only
```

Minimal CSS — just the internal layout (message text styling, button row with gap). The popover chrome comes from tug-popover.css via composition.

---

## Skipped: tug-hover-card

The roadmap already notes: "Tooltip + popover cover this space." Confirmed:

- **Non-interactive hover preview** → TugTooltip with `content` as ReactNode (already supported)
- **Interactive hover preview** → Unusual UX; hover is unstable. If ever needed, a thin hover-trigger wrapper on TugPopover would suffice.

Not building a standalone component.

---

## Gallery Cards

One gallery card per component:

### gallery-context-menu.tsx
1. **Basic** — Right-click a colored region, menu with Cut/Copy/Paste
2. **With Icons** — Menu items with lucide icons
3. **With Shortcuts** — Items showing keyboard shortcut labels
4. **Separators and Labels** — Grouped items with section labels
5. **Disabled Items** — Some items disabled
6. **On a Card** — Context menu on a card-like element (primary use case)

### gallery-popover.tsx
1. **Basic** — Button opens a popover with text content
2. **Positioning** — Four buttons with side=top/bottom/left/right
3. **With Arrow** — arrow={true} for visual connection
4. **Form Content** — Popover containing TugInput + TugSwitch + TugSlider
5. **With Close Button** — TugPopoverClose inside the content
6. **Controlled** — External open/close state management

### gallery-confirm-popover.tsx
1. **Danger Confirmation** — Delete button with "are you sure?" (default danger role)
2. **Action Confirmation** — Publish button with action role
3. **Custom Labels** — Custom confirm/cancel button text
4. **Positioning** — side=top vs side=bottom
5. **Promise API** — Imperative confirm() demo with result display

---

## Dashes

Five dashes, building in dependency order:

1. **tug-context-menu** — Install Radix package, build component reusing tug-menu.css, blink animation
2. **tug-context-menu gallery** — Gallery card, register in component gallery
3. **tug-popover** — Build component with chrome CSS, animations, token aliases
4. **tug-popover gallery** — Gallery card
5. **tug-confirm-popover + gallery** — Build component composing tug-popover, gallery card (combined — small component)

tug-popover must be built before tug-confirm-popover (composition dependency).

---

## Dependencies

| Component | Radix Package | Installed? |
|-----------|--------------|------------|
| tug-context-menu | `@radix-ui/react-context-menu` | No — `bun add` |
| tug-popover | `@radix-ui/react-popover` | Yes (^1.1.15) |
| tug-confirm-popover | (composes tug-popover) | N/A |

No new theme tokens needed. All components resolve to existing `--tug7-*` base tokens.

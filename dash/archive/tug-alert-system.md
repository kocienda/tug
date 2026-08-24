# Tug Alert System — Consolidated Proposal

*Five modality tiers for interruption, confirmation, notification, and system state. Modeled on AppKit (NSAlert, beginSheet, NSPopover, Notification Center) but adapted for tug's card-based deck architecture.*

*Cross-references: `[L##]` → [laws-of-tug.md](../tuglaws/laws-of-tug.md). `[D##]` → [design-decisions.md](../tuglaws/design-decisions.md).*

---

## Overview

Tug needs five tiers of user interruption, each with distinct modality and scope:

| Tier | Component | Modality | Scope | Wraps | Analogy |
|------|-----------|----------|-------|-------|---------|
| 0 | **tug-banner** | App-modal (state) | Entire app | Original | System state barrier |
| 1 | **tug-alert** | App-modal (action) | Entire app | Radix AlertDialog | NSAlert |
| 2 | **tug-sheet** | Card-modal | Single card | Original + Radix FocusScope | beginSheet |
| 3 | **tug-dialog** | Card-spawned | Deck | Card registry | NSPanel / utility window |
| 4 | **tug-bulletin** | Modeless | Global viewport | Sonner | Notification Center |

Already built (Group B): **tug-confirm-popover** — button-local, non-modal, anchored to trigger. Handles the lightest confirmation case. The five tiers above handle everything heavier.

Note the two flavors of app-modal: **tug-banner** is state-driven (appears/disappears when a system condition changes, no user action can dismiss it) while **tug-alert** is action-driven (appears because something asked a question, user must respond).

### Blocked, Not Disabled — The Scrim Model

TugBox cascades `disabled` to all contained controls. Disabled means the controls themselves are unavailable — they gray out, reduce opacity, change cursor. That's the right treatment when controls are turned off.

Modal blocking is different. Controls behind a modal aren't turned off — they're **unreachable because something is in front of them**. A checkbox behind a sheet is still checked, still colored, still looks exactly like itself. The user just can't reach it right now. When the modal closes, nothing about the controls changes — they were never in a different state.

The correct visual treatment is a **dimming scrim**: a semi-transparent overlay that sits between the user and the blocked content. The content behind dims but every control looks perfectly normal underneath. This is what macOS does with sheets.

**Two layers, two jobs:**
- **Visual layer (scrim):** Dims content behind the modal. Communicates "you can't reach this." Appearance-zone only [L06].
- **Interaction layer (`inert`):** The HTML `inert` attribute on the blocked container prevents focus, pointer events, and assistive tech from reaching the content. Native browser behavior — no React context needed.

The modality model:

- **App-modal (tug-banner, tug-alert):** Full-viewport scrim. Banner manages `inert` on the deck canvas container itself. Alert gets this for free from Radix AlertDialog (sets `aria-hidden` on sibling subtrees). Both render as siblings *outside* the inert container — never as children of it.
- **Card-modal (tug-sheet):** Card-scoped scrim over `.tugcard-body` + `inert` attribute on the same element. Only that card's content is dimmed and blocked; other cards remain fully interactive and visually normal.
- **Card-spawned (tug-dialog):** No scrim, no inertness. The dialog is a peer card in the deck — it participates naturally in focus/z-order.
- **Modeless (tug-bulletin):** No scrim, no inertness. Notifications live in a fixed viewport outside the card system entirely.

---

## Component 0: tug-banner

*App-modal state barrier. Appears when a system condition prevents work; disappears when the condition resolves. No user action can dismiss it.*

### Concept

Two existing cases in Tug.app today:

1. **Disconnected banner** (`disconnect-banner.tsx`) — WebSocket connection lost. Currently a hand-built `position: fixed` div with inline styles and hardcoded fallback colors. Uses `useState` to subscribe to connection state.
2. **Error boundary** (`error-boundary.tsx`) — React render error. Currently a class component with full-screen error display, hardcoded colors, monospace stack trace, no reload mechanism.

Both share the same pattern: a system condition makes the app non-functional, a prominent visual indicator appears, and interaction is blocked until the condition resolves. Neither requires a user response — they come and go on their own.

TugBanner replaces the *rendering* of both with a proper tugways component: token-driven colors, `@tug-pairings`, `data-slot`, scrim + `inert` for modality, and CSS keyframe animations for enter/exit. Note: the ErrorBoundary class component must remain (React requires class components for `getDerivedStateFromError`) — it would render `<TugBanner variant="error">` instead of its current inline JSX.

### How It Differs from tug-alert

| | tug-banner | tug-alert |
|---|-----------|-----------|
| **Trigger** | System state (reactive) | Code request (imperative) |
| **Dismissal** | Condition resolves | User responds |
| **User action** | None — wait for recovery | Confirm or cancel |
| **Promise API** | No | Yes |
| **Content** | Status message or rich error content | Title + message + buttons |

### Variants

| Variant | Content | Use Case |
|---------|---------|----------|
| `"status"` | Icon + message string. Compact horizontal strip. | Connection lost, syncing, maintenance mode |
| `"error"` | Rich content via `children` prop. Stack traces, reload button, details. Full-height. | React render errors, fatal exceptions |

The `"status"` variant is the default — a single-line horizontal banner. The `"error"` variant accepts arbitrary `children` for rich diagnostic content, including composed TugButton for reload actions [L20].

### API Design

```tsx
// Status variant (default) — compact strip
<TugBanner
  visible={!isConnected}
  tone="caution"
  message="Connection lost — reconnecting..."
  icon="wifi-off"
/>

// Error variant — rich content with children
<TugBanner
  visible={hasError}
  variant="error"
  tone="danger"
  message="Render Error"
>
  <pre>{error.message}</pre>
  <pre>{error.stack}</pre>
  <TugPushButton role="action" onClick={handleReload}>Reload</TugPushButton>
</TugBanner>
```

No imperative API. Banner visibility is driven by reactive state (connection status, error boundaries). The component renders when `visible` is true and animates out when false.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `visible` | `boolean` | Whether the banner is shown. @selector `[data-visible]` |
| `variant` | `"status" \| "error"` | Banner layout variant. Default: `"status"`. @selector `[data-variant="status"]` \| `[data-variant="error"]` |
| `tone` | `"danger" \| "caution" \| "default"` | Visual severity. Default: `"danger"`. @selector `[data-tone]` |
| `message` | `string` | Banner heading/message text |
| `icon` | `string` | Optional Lucide icon name (status variant) |
| `children` | `ReactNode` | Rich content (error variant) |

### Presence Pattern — Status vs Error

The two variants have different lifecycles:

**Status variant (disconnect banner):** Always mounted in the DOM. Visibility controlled by `data-visible` attribute, not conditional rendering:

- `data-visible="true"` → CSS keyframe enter animation, scrim fades in
- `data-visible="false"` → CSS keyframe exit animation, scrim fades out
- After exit animation completes, `inert` is removed from the deck canvas
- This avoids the unmount-before-animation problem. CSS controls visibility. Appearance-zone only [L06].

**Error variant (error boundary):** Conditionally rendered by ErrorBoundary as its fallback UI. No exit animation needed — recovery means the ErrorBoundary re-renders its children, replacing the banner entirely. The error variant mounts when an error is caught and unmounts when the error clears (typically a reload). Enter animation plays on mount; no exit animation required.

### Mounting Point in the React Tree

The current React tree (`deck-manager.ts` line 273):
```
TugThemeProvider
  TugTooltipProvider
    ErrorBoundary
      ResponderChainProvider
        DeckManagerContext.Provider
          DeckCanvas  ← cards render here
```

TugBanner (status variant) must render **outside** DeckCanvas but **inside** the Provider wrapper, as a sibling of DeckCanvas. This requires modifying `deck-manager.ts` to add TugBanner into the `root.render()` tree:

```
TugThemeProvider
  TugTooltipProvider
    ErrorBoundary          ← catches errors, renders TugBanner error variant as fallback
      ResponderChainProvider
        DeckManagerContext.Provider
          TugBanner          ← status variant, always mounted, sibling of DeckCanvas
          DeckCanvas         ← cards render here; target for inert
```

The status variant TugBanner reads connection state from TugConnection (available via DeckManagerContext). It sets `inert` on the DeckCanvas container element (found via a ref or DOM query on its sibling).

The error variant TugBanner is rendered by ErrorBoundary's `render()` method when `this.state.error` is non-null. It replaces the entire subtree below ErrorBoundary.

### Visual Design

- **Status variant:** Full-width horizontal strip at top of viewport. High contrast, tone-colored. Icon + message centered.
- **Error variant:** Full-viewport panel. Error title at top, scrollable content area for stack traces, action buttons at bottom.
- **Status variant** has a full-viewport scrim beneath it that dims the entire deck.
- **Error variant** has no scrim — when ErrorBoundary fires, it replaces the entire subtree below it (DeckCanvas, cards, everything). There's no deck to dim. The error panel IS the entire UI.
- Slide down from top on appear, slide up on dismiss (status). Fade in/out (error).
- `inert` on the deck canvas while visible — nothing behind the scrim is interactive.
- No close button, no dismiss gesture — the banner leaves when the condition resolves.

### Accessibility

- **Status variant:** `role="status"` + `aria-live="polite"` — connection status is important but not an emergency interruption.
- **Error variant:** `role="alert"` + `aria-live="assertive"` — render errors are urgent.
- No keyboard interaction — the banner is informational. No Tab target, no Escape dismiss.
- Screen readers announce the banner when it appears via the `aria-live` region.

### Modality Mechanism

- Banner + scrim render as siblings of the deck canvas, not children of it
- Scrim overlay covers the entire viewport beneath the banner
- `inert` attribute set on the deck canvas container element
- Banner + scrim render above all z-index layers (above cards, above popovers, above menus)
- When `visible` transitions to false: CSS exit animation plays, then `inert` removed from deck canvas

### Token Sovereignty [L20]

TugBanner owns:
- `--tugx-banner-bg`, `--tugx-banner-fg`, `--tugx-banner-border` — banner strip/panel
- `--tugx-banner-overlay-bg` — full-viewport scrim
- Tone variants: `--tugx-banner-danger-bg`, `--tugx-banner-caution-bg`, etc.

Error variant composes TugPushButton for reload actions — TugButton keeps its own tokens [L20].

### Law Citations

```
Laws: [L06] appearance via CSS, [L16] pairings declared, [L19] component authoring guide,
      [L20] token sovereignty (error variant composes TugButton)
```

[L15] does not apply — the banner strip itself is not an interactive control.

### Files

```
tug-banner.tsx       — component (status: always-mounted presence pattern; error: conditional render)
tug-banner.css       — banner strip, error panel, scrim overlay, tone variants, enter/exit animations
deck-manager.ts      — modified: add TugBanner (status) to root.render() tree as sibling of DeckCanvas
error-boundary.tsx   — modified: render TugBanner (error variant) instead of inline JSX
```

---

## Component 1: tug-alert

*App-modal dialog for critical interruptions that require explicit user response.*

### Radix Primitive

`@radix-ui/react-alert-dialog` — purpose-built for this. Key properties:
- **Always modal** — no `modal` prop; cannot be dismissed by clicking outside
- **Focus trapped** inside Content automatically
- **Cancel + Action** buttons (not a generic Close) — forces explicit user choice
- **`aria-labelledby` / `aria-describedby`** wired automatically from Title/Description
- **Escape** closes (maps to Cancel)

### API Design

```tsx
// Imperative (primary API — mirrors tug-confirm-popover)
const alertRef = useRef<TugAlertHandle>(null);
const result = await alertRef.current.alert({
  title: "Delete Card",
  message: "This action cannot be undone.",
  confirmLabel: "Delete",
  confirmRole: "danger",
});
// result: true (confirmed) | false (cancelled)

// Declarative (for static/controlled use)
<TugAlert
  open={open}
  onOpenChange={setOpen}
  title="Delete Card"
  message="This action cannot be undone."
  confirmLabel="Delete"
  confirmRole="danger"
  onConfirm={handleConfirm}
  onCancel={handleCancel}
/>
```

### Props

| Prop | Type | Description |
|------|------|-------------|
| `title` | `string` | Alert title (required) |
| `message` | `string \| ReactNode` | Body content |
| `confirmLabel` | `string` | Confirm button text (default: "OK") |
| `cancelLabel` | `string \| null` | Cancel button text (default: "Cancel"). Pass `null` to hide cancel button entirely. |
| `confirmRole` | `TugButtonRole` | Semantic role for confirm button (default: "action") |
| `open` | `boolean` | Controlled open state. @selector `[data-state]` |
| `onOpenChange` | `(open: boolean) => void` | Open state callback |
| `onConfirm` | `() => void` | Confirm callback |
| `onCancel` | `() => void` | Cancel callback |

### Imperative Handle

```tsx
interface TugAlertHandle {
  alert(options?: {
    title?: string;
    message?: string | ReactNode;
    confirmLabel?: string;
    cancelLabel?: string | null;
    confirmRole?: TugButtonRole;
  }): Promise<boolean>;
}
```

Options passed to `alert()` override props for that invocation. The Promise resolves `true` for confirm, `false` for cancel/escape.

### Visual Design

- Full-viewport scrim overlay (semi-transparent, token-driven) — dimming, not disabling
- Centered dialog panel with constrained max-width
- Title + message + button row
- Confirm button rightmost (nearest to default pointer position)
- **Focus goes to Cancel on open** — safety-first default. Enter/Space activates the focused button, so the non-destructive choice is the easiest to make. Radix AlertDialog enforces this by redirecting auto-focus to the Cancel element.
- Escape closes (maps to Cancel)
- CSS keyframe enter/exit animations on `[data-state]` [L14]

### Token Sovereignty [L20]

TugAlert owns:
- `--tugx-alert-overlay-bg` — scrim color
- `--tugx-alert-bg`, `--tugx-alert-fg`, `--tugx-alert-border`, `--tugx-alert-shadow` — panel chrome

Composed TugButton children keep their own tokens (emphasis × role). No descendant restyling.

### Law Citations

```
Laws: [L06] appearance via CSS, [L16] pairings declared, [L19] component authoring guide,
      [L20] token sovereignty (composes TugButton)
```

### Mounting

TugAlert is app-modal — it must be mounted near the app root, not inside a card. A `<TugAlertProvider>` is added to the root tree (alongside TugTooltipProvider in `deck-manager.ts`). It provides a `useTugAlert()` hook so any component anywhere in the tree can show an alert:

```tsx
const showAlert = useTugAlert();
const confirmed = await showAlert({
  title: "Delete Card",
  confirmLabel: "Delete",
  confirmRole: "danger",
});
```

The ref-based API (`useRef<TugAlertHandle>`) remains available for cases where the caller needs to configure default props on a specific instance, but the provider + hook is the primary pattern for app-modal.

### Files

```
tug-alert.tsx   — component + TugAlertProvider + useTugAlert hook + imperative handle
tug-alert.css   — overlay, panel, layout, animations
deck-manager.ts — modified: add TugAlertProvider to root.render() tree
```

---

## Component 2: tug-sheet

*Card-modal dialog scoped to a single card. Other cards remain fully interactive. Drops from the card title bar like a window shade.*

### Why Not Radix Dialog?

Radix Dialog is designed for document-level dialogs. Card-scoped modality is outside its design center:

- `modal={true}` makes the **entire page** inert — wrong for card-modal
- `modal={false}` gives up focus trapping — we'd add it back manually
- Portal `container` prop needs a DOM element at render time, but discovering the parent card requires a DOM query that can't run during render — leading to fragile two-pass rendering
- We'd end up bypassing Radix's modality, bypassing its portal, and adding our own focus trapping — using Radix for almost nothing

**tug-sheet is an original component.** We use Radix `FocusScope` (standalone, already installed as a transitive dependency of `react-dialog`) for focus trapping. Everything else — open/close state, ARIA, Escape handling, animation — we build directly. This gives us full control over card-scoped behavior without fighting a primitive designed for a different purpose.

### Architecture

1. Sheet opens → set `inert` attribute on the card's `.tugcard-body` element
2. Scrim overlay fades in over the card content area
3. Sheet panel drops down from just below the card title bar
4. `FocusScope` traps Tab/Shift-Tab within the sheet; auto-focuses first tabbable element
5. Escape closes sheet → sheet slides up, scrim fades → remove `inert` → FocusScope restores focus to trigger
6. Other cards remain fully interactive throughout

### Card Portal Infrastructure

The sheet trigger lives inside `.tugcard-content` (inside `.tugcard-body`). But when the sheet opens, `.tugcard-body` becomes inert. The sheet overlay and panel must render **outside** `.tugcard-body` but **inside** `.tugcard` — as siblings of the body, not children of it.

This requires a portal from inside card content up to the card root. **Tugcard provides its DOM element via React context:**

```tsx
// New context in tug-card.tsx
const TugcardPortalContext = createContext<HTMLDivElement | null>(null);

// Tugcard uses a ref callback to provide the card element:
const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);

<TugcardPortalContext value={cardEl}>
  <div ref={setCardEl} className="tugcard" data-slot="tug-card">
    <CardTitleBar />
    <div className="tugcard-body">
      <div className="tugcard-content">
        {children}  ← TugSheet lives here, reads context
      </div>
    </div>
  </div>
</TugcardPortalContext>
```

TugSheetContent reads the context and uses `React.createPortal` to render into the card element:

```tsx
const cardEl = useContext(TugcardPortalContext);

// Portal overlay + panel into the card root (sibling of .tugcard-body)
{open && cardEl && createPortal(
  <>
    <div className="tug-sheet-overlay" />
    <FocusScope trapped loop onMountAutoFocus={...} onUnmountAutoFocus={...}>
      <div className="tug-sheet-content" role="dialog" aria-labelledby={titleId}>
        {/* sheet header + children */}
      </div>
    </FocusScope>
  </>,
  cardEl
)}
```

**Why this works cleanly:**
- On first render, `cardEl` is null (ref hasn't fired). The portal doesn't render. This is fine — the sheet isn't open on mount.
- After mount, `setCardEl` fires, context updates. When the sheet later opens, `cardEl` is available.
- No DOM queries at render time. The portal target comes from React context, not `closest()` or other DOM traversals during render.
- TugcardPortalContext fits the existing pattern — Tugcard already provides TugcardPropertyContext, TugcardPersistenceContext, and TugcardDirtyContext.

**Finding `.tugcard-body` for `inert`:** TugSheetContent finds the body element via `cardEl.querySelector('.tugcard-body')` in `useLayoutEffect` when the sheet opens. This is a targeted query on a known parent element in a layout effect — not a render-time DOM traversal.

### API Design

```tsx
// Compound API (primary — sheet content is arbitrary)
<TugSheet open={open} onOpenChange={setOpen}>
  <TugSheetTrigger asChild>
    <TugPushButton>Open Settings</TugPushButton>
  </TugSheetTrigger>
  <TugSheetContent title="Card Settings">
    {/* arbitrary content */}
  </TugSheetContent>
</TugSheet>

// Imperative (for programmatic open/close)
const sheetRef = useRef<TugSheetHandle>(null);
sheetRef.current.open();
sheetRef.current.close();
```

### Props — TugSheet (Root)

| Prop | Type | Description |
|------|------|-------------|
| `open` | `boolean` | Controlled open state. @selector `[data-state="open"]` \| `[data-state="closed"]` |
| `onOpenChange` | `(open: boolean) => void` | Open state callback |
| `children` | `ReactNode` | Trigger + Content |

### Props — TugSheetTrigger

Wraps a single child element via `asChild` pattern (like TugPopoverTrigger). Merges ARIA attributes onto the child:

| Attribute | Value | Description |
|-----------|-------|-------------|
| `aria-haspopup` | `"dialog"` | Indicates the trigger opens a dialog |
| `aria-expanded` | `boolean` | Reflects current open state |
| `aria-controls` | `string` | ID of the sheet content element (when open) |

### Props — TugSheetContent

| Prop | Type | Description |
|------|------|-------------|
| `title` | `string` | Sheet title (required — renders in header row, wired to `aria-labelledby`) |
| `description` | `string` | Optional description text (wired to `aria-describedby`) |
| `onOpenAutoFocus` | `(event: Event) => void` | Override initial focus target. Call `event.preventDefault()` to manage focus manually. |
| `children` | `ReactNode` | Arbitrary content |

### Card-Modal Mechanics

**Inertness via `inert` attribute:**
- When sheet opens: find `.tugcard-body` via `cardEl.querySelector('.tugcard-body')`, set `inert` attribute
- When sheet closes: remove `inert` attribute
- The `inert` attribute disables all pointer events, focus, and assistive tech within the element — a native browser feature
- The card body is dimmed by the scrim but every control underneath looks normal — they're blocked, not disabled
- `inert` is set/removed in `useLayoutEffect` synchronized with open state [L03]

**Focus trapping via Radix FocusScope:**
- `FocusScope` with `trapped={true}` and `loop={true}` wraps the sheet content
- Tab/Shift-Tab cycle within the sheet — focus cannot escape to inert card body
- On mount: auto-focuses first tabbable element inside the sheet
- On unmount: restores focus to the element that was focused before the sheet opened (the trigger)
- Clicking another card is allowed — card-modal blocks the parent card's content, not the entire app

**Escape handling:**
- Keydown listener on the sheet content element
- Escape calls `onOpenChange(false)` to close the sheet
- No Radix dependency — direct DOM event handling

**Responder chain:**
- When the sheet is open and the card body is inert, pointer/keyboard events within the card body are suppressed by the browser
- The sheet itself is NOT inert, so it receives events normally
- Actions dispatched from sheet content travel up the responder chain through the card's node as usual

### Visual Design — Window Shade

The sheet drops from the bottom edge of the card title bar like a window shade:

- **Position:** Absolutely positioned inside the card, top anchored to the bottom of the title bar (`top: var(--tug-chrome-height)`)
- **Animation:** `translateY(-100%)` → `translateY(0)` on open. No swoop, no spring — a clean linear drop. Reverse on close.
- **Width:** Full card width (no horizontal margins)
- **Height:** Sized to content, max-height constrained to the card content area
- **Scrim:** Covers the `.tugcard-body` area, fades in simultaneously with the sheet drop
- **Title bar:** The card's title bar remains fully visible and interactive above the sheet — the user always sees which card the sheet belongs to
- **Sheet header:** A header row inside the sheet with the sheet title and a close button
- CSS keyframe enter/exit animations [L14]

### Token Sovereignty [L20]

TugSheet owns:
- `--tugx-sheet-overlay-bg` — card-scoped scrim
- `--tugx-sheet-bg`, `--tugx-sheet-fg`, `--tugx-sheet-border`, `--tugx-sheet-shadow` — sheet panel
- `--tugx-sheet-header-bg`, `--tugx-sheet-header-fg` — sheet header row

Children (forms, controls) keep their own tokens.

### Law Citations

```
Laws: [L06] appearance via CSS, [L16] pairings declared, [L19] component authoring guide,
      [L20] token sovereignty (composes child controls)
```

### Accessibility — Radix-Quality ARIA

Since tug-sheet is an original component, it must match Radix Dialog's ARIA implementation. Every attribute and behavior below is required, not optional.

**Sheet content element:**
- `role="dialog"`
- `aria-labelledby={titleId}` — auto-wired to the sheet header title element via generated ID
- `aria-describedby={descriptionId}` — auto-wired when optional `description` prop is provided
- **No `aria-modal="true"`** — the sheet is modal within the card, not within the document. Other cards remain accessible. Setting `aria-modal` would tell the screen reader to hide everything outside the dialog, which is wrong for card-modal. The `inert` attribute on `.tugcard-body` handles card-scoped blocking at the DOM level — the browser removes the inert subtree from the accessibility tree, which is the correct scoped behavior.

**Trigger element** (TugSheetTrigger applies these via `asChild` merge):
- `aria-haspopup="dialog"`
- `aria-expanded={open}` — reflects current open state
- `aria-controls={contentId}` — points to the sheet content element when open

**Focus management:**
- FocusScope `trapped={true}` + `loop={true}` — Tab/Shift-Tab cycle within the sheet, never escape
- On open: auto-focus first tabbable element inside the sheet (configurable via `onOpenAutoFocus` prop)
- On close: restore focus to the trigger element (FocusScope `onUnmountAutoFocus`)

**Keyboard:**
- Escape closes the sheet
- Tab/Shift-Tab cycle within sheet content

**Background:**
- `inert` on `.tugcard-body` — removes it from the accessibility tree and blocks all interaction
- Clicking the scrim overlay closes the sheet (pointer-down on overlay calls `onOpenChange(false)`)

**Dev-time safeguards:**
- Console warning if `TugSheetContent` renders without a `title` prop — `aria-labelledby` would have no target

### Files

```
tug-sheet.tsx   — compound components (Root/Trigger/Content) + imperative handle
tug-sheet.css   — overlay, panel, window-shade animation, header
tug-card.tsx    — modified: add TugcardPortalContext providing card root element
```

---

## Component 3: tug-dialog

*A dialog that IS a card. Leverages the entire deck infrastructure.*

Instead of building a parallel overlay system, **tug-dialog spawns a card**. A traditional dialog overlay duplicates what the deck already provides: positioning, z-order, focus management, title bars, close buttons, drag handles. The deck already does all of this.

### How It Works

1. Caller requests a dialog via imperative API
2. DeckManager creates a new card with dialog-specific registration
3. The card renders with a customized title bar (no tabs, centered on the deck, closable)
4. Card appears centered on the deck
5. User interacts with it like any card — drag, resize, focus, close
6. Closing the dialog card resolves the caller's Promise

### API Design

```tsx
// Imperative (primary API)
const result = await tugDialog({
  componentId: "settings-dialog",
  title: "Application Settings",
  width: 480,
  height: 360,
});
// result: whatever the dialog content resolves with, or undefined if closed

// Or via hook
const openDialog = useTugDialog();
const result = await openDialog({
  componentId: "settings-dialog",
  title: "Application Settings",
});
```

### Card Registration

Dialog content is registered in the card registry like any other card:

```tsx
registerCard({
  componentId: "settings-dialog",
  contentFactory: (cardId) => <SettingsContent cardId={cardId} />,
  defaultMeta: { title: "Application Settings", icon: "settings", closable: true },
  family: "dialog",  // distinct family for dialog cards
});
```

The `"dialog"` family allows the deck to treat dialog cards differently:
- **Centered initial position** — not cascade-offset like normal cards
- **No tab drops** — dialog cards are single-purpose, not tab targets
- **No persist-on-reload** — dialog state is ephemeral

### Why Card-Based?

| Concern | Traditional Dialog | Dialog-as-Card |
|---------|-------------------|----------------|
| Positioning | Custom centering logic | DeckManager — centered on deck |
| Z-order | Manual z-index management | Array position (existing) |
| Focus | Manual focus trap | Card focus system |
| Drag | Not draggable (usually) | Free — CardFrame handles it |
| Title bar | Build another one | Tugcard title bar |
| Resize | Build resize handles | CardFrame resize handles |
| Responder chain | Wire up manually | Card responder node |
| Close | Build close logic | Card close flow |

Everything needed already exists. The only new code is the imperative spawning API and the Promise resolution on close.

### What's New

- `useTugDialog()` hook — calls `deckManager.addCard()` with dialog-specific options, returns a Promise
- Dialog family positioning — `DeckManager.addCard()` centers dialog-family cards on the deck viewport
- Promise resolution — dialog content calls a resolve callback (provided via React context) when done; card close resolves with `undefined`

### Files

No new component CSS — dialog cards use existing Tugcard chrome. Infrastructure changes:

```
use-tug-dialog.ts     — new: hook for spawning dialog cards + TugDialogResolveContext
deck-manager.ts       — modified: addCard() gains centered positioning for dialog family;
                         removeCard() gains close-callback for Promise resolution
layout-tree.ts        — modified: CardState may need family field (or resolved from card registry)
deck-canvas.tsx        — modified: skip dialog-family cards as tab-drop targets
```

Dialog content is authored as regular card content components — they just happen to be registered with `family: "dialog"`. Changes to DeckManager are fully in scope for this work — the alert system explicitly alters core assumptions about cards, event flow, and app-wide state.

---

## Component 4: tug-bulletin

*Non-blocking notification. Fire-and-forget. The tug name for what others call "toast."*

### Library Choice: Sonner

Radix Toast has a complex, verbose API (Provider → Viewport → Root → Title → Description → Action → Close) requiring each toast to be manually composed in JSX. **Sonner** — a headless toast library by Emil Kowalski — provides a dramatically simpler API:

```tsx
// Sonner: one function call
import { toast } from "sonner";
toast("Card saved successfully");
toast.error("Connection lost");

// vs Radix Toast: mount a provider, viewport, and manually compose each toast
```

Sonner provides: auto-dismiss, stacking, swipe-to-dismiss, pause-on-hover, `aria-live` regions, and a headless mode for full styling control.

### API Design

```tsx
import { bulletin } from "@/components/tugways/tug-bulletin";

// Simple
bulletin("Card saved");

// With tone
bulletin.success("Export complete");
bulletin.danger("Connection lost — retrying");
bulletin.caution("Approaching rate limit");

// With options
bulletin("Processing complete", {
  duration: 8000,
  action: { label: "View", onClick: () => focusCard(cardId) },
});

// With description
bulletin("Export complete", {
  description: "3 cards exported to ~/Desktop/export.json",
});
```

### Tone Variants

| Tone | Use Case | Visual |
|------|----------|--------|
| `default` | Neutral information | Standard chrome |
| `success` | Positive outcome | Success accent |
| `danger` | Error or failure | Danger accent |
| `caution` | Warning | Caution accent |

Tones map to the existing role token system — `--tug7-surface-tone-*` and `--tug7-element-tone-*`.

### Architecture

- **TugBulletinViewport** — mounted once in the app root (alongside TugTooltipProvider). Fixed-position container for bulletin stack.
- **`bulletin()` function** — imperative fire-and-forget API. Internally calls Sonner's `toast()` with tug styling.
- **Sonner's `<Toaster>`** — rendered inside TugBulletinViewport with tug classes and token-driven styling.
- **No compound JSX API** — bulletins are fire-and-forget; there's no trigger/content composition.

### Visual Design

- **Default position:** Top-right of viewport, like macOS notification banners
- **Configurable:** All four corners via `position` prop on TugBulletinViewport (`"top-right"` | `"top-left"` | `"bottom-right"` | `"bottom-left"`)
- Stack downward from top (or upward from bottom), newest on top
- Slide in from the near edge, slide out on dismiss
- Pause timer on hover
- Swipe to dismiss (direction matches position)
- Max 3 visible; older ones compress
- Auto-dismiss after configurable duration (default: 5000ms)

### Token Sovereignty [L20]

TugBulletin owns its own tokens:
- `--tugx-bulletin-bg`, `--tugx-bulletin-fg`, `--tugx-bulletin-border`, `--tugx-bulletin-shadow`
- `--tugx-bulletin-success-accent`, `--tugx-bulletin-danger-accent`, `--tugx-bulletin-caution-accent`

### Law Citations

```
Laws: [L06] appearance via CSS, [L16] pairings declared, [L19] component authoring guide
```

[L15] does not apply — bulletins are display-only, not interactive controls. [L20] does not apply — no tugways children are composed.

### Files

```
tug-bulletin.tsx   — TugBulletinViewport + bulletin() function
tug-bulletin.css   — viewport layout, bulletin card styling, tone variants, animations
```

### Package

`sonner` — needs to be installed. Not currently in package.json.

---

## Shared Patterns

### Animation — Two Regimes [L13, L14]

The alert system uses two distinct animation regimes, determined by **who owns the DOM lifecycle**:

**Library-managed lifecycle → CSS keyframes [L14]:** When a library (Radix, Sonner) controls when elements mount and unmount, it listens for `animationend` on CSS keyframes to know when exit animations complete. WAAPI does NOT fire `animationend`, so using TugAnimator here would break the library's unmount timing. CSS keyframes are correct and required.

- **tug-alert:** Radix AlertDialog manages Presence. CSS `@keyframes` on `[data-state]`. Correct.
- **tug-bulletin:** Sonner manages toast lifecycle. CSS styling of Sonner's DOM. Correct.

**Self-managed lifecycle → TugAnimator [L13]:** When we own the DOM lifecycle (original components that control their own mount/unmount), we need completion promises to sequence post-animation work (unmount portals, remove `inert`, restore focus). TugAnimator provides `.finished` promises, named slot cancellation (for rapid open-close-open sequences), and duration token scaling — exactly the machinery we need.

- **tug-banner:** Original. Uses `animate()` with `.finished` to sequence `inert` removal after scrim fade-out.
- **tug-sheet:** Original. Uses `animate()` with `.finished` to sequence portal unmount after retract, and `group()` to coordinate overlay fade + content retract simultaneously.

**tug-dialog** has no component-level animation — the card system handles card appearance/removal.

**What TugAnimator replaces in banner and sheet:**
- Manual `animationend` event listeners → `.finished` promise
- `mounted` state + `useLayoutEffect` listener dance → `animate().finished.then(() => setMounted(false))`
- CSS `@keyframes` + `animation-fill-mode: forwards` → WAAPI keyframes with `fill: 'forwards'`
- No named slot cancellation → `key` option handles rapid toggling cleanly

| Component | Regime | Enter | Exit |
|-----------|--------|-------|------|
| tug-banner (status) | TugAnimator [L13] | Slide down + scrim fade | Slide up + scrim fade → `.finished` removes `inert` |
| tug-banner (error) | Mount only | Fade in on mount | No exit (ErrorBoundary replaces tree) |
| tug-alert | CSS keyframes [L14] | Fade + scale + scrim fade | Fade + scrim fade (Radix Presence manages unmount) |
| tug-sheet | TugAnimator [L13] | Drop from title bar + scrim fade | Retract into title bar + scrim fade → `.finished` unmounts portal |
| tug-dialog | Card system | Card appears (DeckManager) | Card close (DeckManager) |
| tug-bulletin | CSS/Sonner [L14] | Slide in (Sonner-managed) | Slide out (Sonner-managed) |

### Scrim — Dimming, Not Disabling

The scrim is the visual layer of modal blocking. It communicates "you can't reach this right now" without changing the appearance of anything underneath. Controls behind the scrim look normal — they're dimmed but not disabled.

| Component | Scrim Scope | Scrim Token | `inert` Target |
|-----------|-------------|-------------|----------------|
| tug-banner | Full viewport | `--tugx-banner-overlay-bg` | Deck canvas container |
| tug-alert | Full viewport | `--tugx-alert-overlay-bg` | Radix handles (aria-hidden) |
| tug-sheet | Card body only | `--tugx-sheet-overlay-bg` | `.tugcard-body` element |
| tug-dialog | None | — | — |
| tug-bulletin | None | — | — |

The scrim is an appearance-zone element [L06] — a semi-transparent overlay with a token-driven background color. It sits between the blocked content and the modal surface. The `inert` attribute handles the interaction/accessibility layer separately.

### Focus Management

- **tug-banner:** No focus target — the banner is informational. `inert` on deck canvas prevents focus from reaching cards.
- **tug-alert:** Radix AlertDialog traps focus automatically.
- **tug-sheet:** Radix `FocusScope` (trapped + loop) cycles Tab within sheet content. `inert` on card body prevents focus on card content. FocusScope restores focus to trigger on unmount. Clicking another card is allowed (card-modal, not app-modal).
- **tug-dialog:** Card focus system handles it (existing infrastructure).
- **tug-bulletin:** No focus trap. User reaches bulletins via hotkey (configurable).

### Responder Chain Integration

- **tug-banner:** Deck canvas is `inert`, so no pointer/keyboard events reach responder nodes. The responder chain is effectively suspended.
- **tug-alert:** While open, the alert's content is the only interactive surface. Radix's inertness on the rest of the page means no responder chain actions fire from behind the alert.
- **tug-sheet:** Sheet content participates in the card's responder subtree. Card body is `inert`, so no competing actions from card content.
- **tug-dialog:** Dialog card has its own responder node (standard card behavior).
- **tug-bulletin:** Bulletins don't participate in the responder chain. Action buttons on bulletins fire callbacks directly.

---

## What Radix/Sonner Provides vs What We Build

| Concern | Library Provides | We Build |
|---------|-----------------|----------|
| State-driven barrier (banner) | — | Original: scrim + `inert` + presence pattern |
| Focus trapping (alert) | Radix AlertDialog Content | — |
| Full-page inertness (alert) | Radix AlertDialog aria-hidden | — |
| Full-page inertness (banner) | — | `inert` attribute on deck canvas |
| Card portal (sheet) | — | TugcardPortalContext + React.createPortal |
| Card-scoped inertness (sheet) | — | `inert` attribute on `.tugcard-body` |
| Focus trapping (sheet) | Radix `FocusScope` (standalone) | Wired into original sheet component |
| Escape handling (sheet) | — | Keydown listener on sheet content |
| Window-shade animation (sheet) | — | TugAnimator WAAPI with `.finished` for unmount sequencing |
| Card spawning (dialog) | — | `useTugDialog` hook + DeckManager centered positioning |
| Toast stacking (bulletin) | Sonner | Tug styling + token integration |
| Enter/exit animations | Radix `data-state` / Sonner | CSS keyframes |
| Accessible roles | Radix `alertdialog` (alert only) | Banner: `role="alert"`/`"status"` + `aria-live`. Sheet: `role="dialog"` (no `aria-modal` — card-scoped, not document-scoped) |
| ARIA labeling | Radix Title → aria-labelledby (alert) | Sheet: manual `aria-labelledby` |
| Escape handling | Radix built-in (alert) | Sheet: keydown listener. Banner: N/A (no dismiss) |

---

## Package Requirements

| Package | Status | Needed For |
|---------|--------|------------|
| `@radix-ui/react-alert-dialog` | Not installed | tug-alert |
| `@radix-ui/react-focus-scope` | Install as direct dep | tug-sheet (standalone focus trapping) |
| `sonner` | Not installed | tug-bulletin |

Note: `@radix-ui/react-focus-scope` is currently installed as a transitive dependency of `react-dialog`. Since tug-sheet no longer uses `react-dialog`, add `react-focus-scope` as a direct dependency and move `react-dialog` to the package cleanup list in the roadmap.

---

## Build Order

1. **tug-banner** — Original component, no Radix dependency. Scrim + `inert` + presence pattern establishes the blocking model that tug-alert and tug-sheet also use. Build first so the infrastructure is proven. Replaces existing `disconnect-banner.tsx` and `error-boundary.tsx` rendering.
2. **tug-alert** — Radix AlertDialog does the heavy lifting. App-modal with Promise API. Reuses the full-viewport scrim pattern from tug-banner.
3. **tug-sheet** — Card-modal. Card-scoped scrim + `inert` on `.tugcard-body` + window-shade animation. Medium complexity.
4. **tug-bulletin** — Install Sonner, wire up viewport, style with tokens. Independent of the other three.
5. **tug-dialog** — Infrastructure only (hook + card registry conventions). Small scope — the dialog-as-card pattern means most work is in content components, which are authored as regular cards.

### Dashes

- **Dash 1:** tug-banner component + CSS + gallery card ✅
- **Dash 2:** tug-alert component + CSS ✅
- **Dash 3:** tug-alert gallery card ✅
- **Dash 4:** tug-sheet component + CSS ✅
- **Dash 5:** tug-sheet gallery card ✅
- **Dash 5.1:** Migrate banner + sheet animations from CSS keyframes to TugAnimator ✅
- **Dash 6:** tug-bulletin component + CSS + gallery card ✅
- **Dash 6.1:** API consistency audit + `useTugSheet()` imperative hook ✅
- **Dash 7:** ~~tug-dialog hook~~ — **Skipped.** The card system already handles everything a "dialog card" would need. When specific use cases arise (about box, settings, pickers), they'll be registered as card content components with positioning options added to `addCard()` at that point.

**Group C: Alert System is complete.**

### Dash 5.1 — TugAnimator Migration for Banner + Sheet

**Problem:** tug-banner and tug-sheet are original components (we own the DOM lifecycle) but use CSS keyframes with manual `animationend` listeners for post-animation sequencing. This is L14-style tooling applied to L13-category work. The result is fragile: hand-rolled `animationend` listeners, a `mounted` state dance, `animation-fill-mode: forwards` hacks, and no cancellation handling for rapid open-close-open sequences.

**Solution:** Migrate both components to use `animate()` from TugAnimator. Replace CSS keyframes + `animationend` listeners with WAAPI keyframes + `.finished` promises.

**tug-banner changes:**
- Remove CSS `@keyframes` for `tug-banner-slide-in`, `tug-banner-slide-out`, `tug-banner-scrim-fade-in`, `tug-banner-scrim-fade-out`
- Remove `animationend` listener and `animEndListenerRef` from the useLayoutEffect
- Add `animate()` calls in useLayoutEffect when `visible` changes:
  - Banner strip: `animate(stripEl, [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }], { key: 'banner-strip', duration: '--tug-motion-duration-moderate' })`
  - Scrim: `animate(scrimEl, [{ opacity: 0 }, { opacity: 1 }], { key: 'banner-scrim', duration: '--tug-motion-duration-moderate' })`
- On close: reverse animations, then `.finished.then(() => canvas.removeAttribute('inert'))`
- Named `key` slots handle rapid toggling — a close animation cancels a running open animation cleanly
- Keep CSS for static layout (position, z-index, background-color) — only motion moves to WAAPI

**tug-sheet changes:**
- Remove CSS `@keyframes` for `tug-sheet-drop`, `tug-sheet-retract`, `tug-sheet-overlay-in`, `tug-sheet-overlay-out`
- Remove the `mounted` state, the `animationend` useLayoutEffect, and `data-state` attribute
- Replace with TugAnimator `group()` for coordinated enter/exit:
  - Enter: `group().animate(contentEl, drop keyframes).animate(overlayEl, fade-in keyframes)`
  - Exit: `group().animate(contentEl, retract keyframes).animate(overlayEl, fade-out keyframes)`
  - `group.finished.then(() => { setMounted(false); })` for clean unmount after retract
- Named `key` slots on sheet content and overlay for cancellation on rapid toggle
- Keep CSS for static layout (position, sizing, border-radius, background) — only motion moves to WAAPI

**tug-alert — NO changes:** Radix AlertDialog owns the DOM lifecycle via Presence. CSS keyframes are correct per L14. Do not migrate.

**tug-bulletin — plan ahead:** Sonner owns toast lifecycle. CSS styling only. When building Dash 6, use CSS for Sonner-managed enter/exit animations (same as tug-alert's relationship with Radix). Note this in the bulletin implementation instructions so the dash agent doesn't reach for TugAnimator.

**Files modified:**
```
tug-banner.tsx       — replace animationend listener with animate() + .finished
tug-banner.css       — remove @keyframes (keep static layout rules)
tug-sheet.tsx        — replace mounted state dance with animate()/group() + .finished
tug-sheet.css        — remove @keyframes (keep static layout rules)
gallery-banner.tsx   — may need minor adjustments if data-visible CSS animations are removed
gallery-sheet.tsx    — may need minor adjustments if data-state CSS animations are removed
```

### Dash 6.1 — API Consistency Audit + `useTugSheet()` Imperative Hook

#### The Problem: Three Singletons, Three Patterns

The four alert system components use three different API patterns, with inconsistent naming:

| Component | Singleton Mount | Access Pattern | Naming |
|---|---|---|---|
| **Banner** | `TugBannerBridge` (component) | Props-only — no hook, no context | "Bridge" — unique term |
| **Alert** | `TugAlertProvider` (context provider) | `useTugAlert()` hook → `showAlert()` | "Provider" + "use" hook |
| **Sheet** | None (composed at use site) | Compound JSX + controlled state | No singleton, no hook |
| **Bulletin** | `TugBulletinViewport` (component) | `bulletin()` bare function import | "Viewport" — unique term |

Problems:
1. **Naming inconsistency:** Bridge, Provider, Viewport — three different suffixes for the same concept (a singleton mounted in the root tree).
2. **Access inconsistency:** Hook (alert), bare function (bulletin), props (banner), compound JSX (sheet) — four different patterns.
3. **Sheet is the outlier:** It's the only component that requires callers to compose JSX, manage controlled state, and wire up Cancel buttons. Every other component is imperative ("call a function, get a result").

#### The Apple Model

In AppKit, modal presentation is always programmatic:
- `NSAlert.runModal()` / `beginSheetModal(for:)` — call a method, get a result
- `NSWindow.beginSheet(_:completionHandler:)` — call a method, pass content, get a callback
- `UNUserNotificationCenter.add(_:)` — call a method, fire-and-forget

The common thread: **the caller describes what to show, the framework handles presentation**. The caller never composes layout, manages open/close state, or wires dismiss buttons.

#### Proposed Changes

**1. Standardize singleton naming: all use "Provider" suffix.**

| Current | Proposed |
|---|---|
| `TugBannerBridge` | `TugBannerProvider` |
| `TugAlertProvider` | `TugAlertProvider` (no change) |
| `TugBulletinViewport` | `TugBulletinProvider` |

The "Provider" suffix communicates: "this is a singleton mounted in the root tree that provides a service to the app." Bridge and Viewport are implementation details, not concepts callers care about.

**2. Standardize access: all use `useTug*()` hooks.**

| Component | Current Access | Proposed Access |
|---|---|---|
| **Banner** | Props on TugBannerBridge | No change — banner is system-driven, not caller-invoked. The "provider" renders it based on connection state. No hook needed. |
| **Alert** | `useTugAlert()` → `showAlert()` | No change — already correct. |
| **Sheet** | Compound JSX | **Add `useTugSheet()`** → `showSheet()` as primary API. Keep compound JSX as escape hatch. |
| **Bulletin** | `bulletin()` bare function | **Add `useTugBulletin()`** → `showBulletin()` for consistency. Keep `bulletin()` bare function as convenience alias. |

The hook pattern provides:
- Consistent API across alert, sheet, bulletin
- React context awareness (the hook knows it's inside a provider)
- Clear error when used outside the provider tree
- Testability (mock the hook in tests)

The `bulletin()` bare function is a valid convenience — it works because Sonner's `toast()` is global. But `useTugBulletin()` provides the standard access pattern for code that's already in a React component.

**3. Add `useTugSheet()` — imperative sheet presentation.**

```tsx
const showSheet = useTugSheet();

// Show a sheet programmatically — returns when the sheet closes
await showSheet({
  title: "Card Settings",
  content: (close) => (
    <>
      <form>...</form>
      <div className="tug-sheet-actions">
        <TugPushButton emphasis="outlined" onClick={() => close()}>Cancel</TugPushButton>
        <TugPushButton emphasis="filled" onClick={() => close("save")}>Save</TugPushButton>
      </div>
    </>
  ),
});
```

Key design points:
- **`content` is a render function** that receives a `close` callback. The callback optionally takes a result value.
- **Returns a Promise** that resolves when the sheet closes (with the close result, or `undefined` if dismissed via Escape).
- **The caller provides the content, the framework handles everything else:** portal into card, inert management, focus trapping, scrim, animation, Escape/Cmd+. handling.
- **No controlled state, no `onOpenChange`, no wiring Cancel buttons to close** — the `close` callback does it all.
- **Scoped to the card** — `useTugSheet()` reads `TugcardPortalContext` to know which card to present in. Must be called from within a card's content.

This is the AppKit `beginSheet` model: call a method, pass a content factory, get notified on close.

**4. Where `useTugSheet()` lives:**

Unlike alert and bulletin (which are app-level singletons), sheet is card-scoped. It doesn't need a provider in the root tree — it needs the TugcardPortalContext (already provided by every Tugcard). The hook reads the portal context directly.

```tsx
export function useTugSheet(): (options: ShowSheetOptions) => Promise<string | undefined> {
  const cardEl = useContext(TugcardPortalContext);
  // Returns a function that creates a sheet portal, manages lifecycle, returns a Promise
}
```

No new provider needed. The hook is self-contained — it uses the card portal context that already exists.

**5. Keep compound JSX as escape hatch.**

`TugSheet` / `TugSheetTrigger` / `TugSheetContent` remain for cases where:
- The trigger is tightly coupled to the sheet (e.g., a settings gear icon that always opens the same sheet)
- The caller wants fine-grained control over open/close state
- The content needs to react to external state changes while open

But `useTugSheet()` is the **primary API** — most callers just want "open a sheet with this content."

#### Implementation Plan

**Files changed:**
```
tug-banner.tsx (or tug-banner-bridge.tsx) — rename TugBannerBridge to TugBannerProvider
tug-bulletin.tsx                         — rename TugBulletinViewport to TugBulletinProvider,
                                           add useTugBulletin() hook
tug-sheet.tsx                            — add useTugSheet() hook + internal sheet renderer
deck-manager.ts                          — update createElement calls for renamed components
gallery-sheet.tsx                        — add demos using useTugSheet()
```

**What NOT to change:**
- `TugAlertProvider` / `useTugAlert()` — already correct
- `bulletin()` bare function — keep as convenience alias alongside the hook
- `TugSheet` compound API — keep as escape hatch
- `TugBanner` component — keep as-is (banner is system-driven, not user-invoked)

# React Foundation Cleanup

Preparatory work to ground tugdeck on React + shadcn before building
a complete custom design+component system for Tug.

## Current State Assessment

The React+shadcn migration (dash/react-shadcn-adoption.md) is
**partially complete**. Phases 0-4 are done: all card content is React,
shadcn UI components are installed and used inside cards, Tailwind v4
is the styling framework, and the token bridge works. But the migration
stopped short of Phase 5 (chrome layer) and Phase 6 (cleanup), leaving
the codebase in a hybrid state.

### What's Already React

Every card component renders as React JSX inside a CardContextProvider:
- ConversationCard, TerminalCard, GitCard, FilesCard, StatsCard
- SettingsCard, DeveloperCard, AboutCard
- All use shadcn components (Button, RadioGroup, Switch, ScrollArea, etc.)
- All use React hooks (useState, useEffect, useCallback, useContext)
- No native HTML controls (`<input>`, `<select>`, `<button>`) appear
  in card content — shadcn wraps everything

### What's Still Vanilla JS

Six files use raw `document.createElement`, manual `addEventListener`,
and direct DOM style mutation:

| File | Lines | Role |
|------|-------|------|
| `card-frame.ts` | 340 | Card container: positioning, resize handles, drag |
| `card-header.ts` | 245 | 28px header bar: icon, title, menu/collapse/close buttons |
| `card-menu.ts` | 185 | Dropdown menu: positioned overlay with action/toggle/select items |
| `dock.ts` | 290 | 48px sidebar rail: icon buttons, settings dropdown, badge system |
| `tab-bar.ts` | 183 | Tab strip for multi-tab panels: click, close, drag-reorder |
| `deck-manager.ts` | ~800 | Canvas renderer: creates CardFrames, manages layout, guide lines, sash elements |

Plus some vanilla patterns leak into otherwise-React code:
- `connection.ts` manipulates a disconnect banner via `document.getElementById`
- `action-dispatch.ts` routes events via `document.dispatchEvent(new CustomEvent(...))`
- `useTheme.ts` mutates `document.body.classList` directly
- `developer-card.tsx` listens on `document` for CustomEvents
- `conversation-card.tsx` uses `document.addEventListener("keydown", ...)`

### The CustomEvent Bridge Problem

The biggest architectural smell is the CustomEvent bridge between
vanilla JS and React. There are **7 distinct CustomEvent channels**:

1. `td-theme-change` — Dock's MutationObserver → useTheme, terminal-card
2. `td-dev-notification` — action-dispatch → developer-card
3. `td-dev-build-progress` — action-dispatch → developer-card
4. `td-dev-badge` — developer-card → dock
5. `td-hmr-update` — developer-card (Vite HMR) → developer-card (self)
6. `card-meta-update` — useCardMeta → ReactCardAdapter → CardFrame → CardHeader

These exist solely because vanilla JS code can't participate in React's
data flow. Once the chrome layer is React, most of these vanish — replaced
by React context, props, or callbacks.

### The card-menu.ts Native Control Problem

`card-menu.ts` is the one place where native HTML controls appear in the
chrome layer. Its `buildItems()` method creates:
- Native `<input type="checkbox">` for toggle menu items (line 126)
- Native `<div>` elements styled as select options (lines 163-181)

These are platform-rendered controls that won't match a custom design
system. They need to become shadcn DropdownMenu with DropdownMenuCheckboxItem
and DropdownMenuRadioGroup.

## Goals

Three objectives, in priority order:

1. **Banish vanilla JS** — every chrome element (CardFrame, CardHeader,
   CardMenu, Dock, TabBar) and every canvas overlay (guide lines, sashes,
   flash overlays) becomes a React component
2. **Base all event flow on React** — eliminate CustomEvent bridges,
   use React context/props/callbacks for all cross-component communication;
   all pointer events (drag, resize, sash drag) use React synthetic events
3. **Use shadcn controls exclusively** — no platform-native checkboxes,
   radio buttons, or styled divs pretending to be controls

## What We Do NOT Touch

- **DeckManager state management** — the flat-array layout model, snap
  computation, shared-edge detection, set-move logic, card registry,
  feed fan-out, layout persistence, and serialization stay as-is.
  DeckManager remains a TypeScript class that owns canvas state. What
  changes is how it renders that state: React instead of imperative DOM.
- **snap.ts, layout-tree.ts, serialization.ts, protocol.ts** — pure
  functions with no DOM dependencies. Already clean.
- **connection.ts WebSocket lifecycle** — stays as a plain class. But
  the disconnect banner DOM manipulation moves to a React component.

## Plan

### Step 1: CardMenu → shadcn DropdownMenu

Replace `card-menu.ts` (185 lines) with shadcn's DropdownMenu.

**Current:** DropdownMenu is a vanilla class that creates a positioned
div, builds items via createElement, manages click-outside dismissal
and Escape handling manually, and uses native `<input type="checkbox">`
for toggles and styled `<div>` elements as select options.

**Target:** A `<CardDropdownMenu>` React component using shadcn:
- `DropdownMenu` + `DropdownMenuTrigger` — positioning and lifecycle
- `DropdownMenuItem` — for action items
- `DropdownMenuCheckboxItem` — replaces native checkbox (shadcn-styled)
- `DropdownMenuRadioGroup` + `DropdownMenuRadioItem` — replaces DIV
  select options (shadcn-styled)
- `DropdownMenuSeparator` — replaces styled divs
- Built-in positioning, click-outside dismiss, keyboard navigation,
  and focus management via Radix — all the behavior currently
  hand-coded in card-menu.ts

This step is first because it's standalone (no parent dependency) and
is consumed by both CardHeader (Step 2) and Dock (Step 5). It's also
the primary win for the "shadcn controls exclusively" goal — the
native checkbox and DIV-based select are the last platform controls.

**Deletes:** `card-menu.ts`

**CSS removed:** `.card-dropdown-menu`, `.card-dropdown-item`,
`.card-dropdown-separator`, `.card-dropdown-select-group`,
`.card-dropdown-select-option` rules from `cards-chrome.css`

### Step 2: CardHeader → React

Convert `card-header.ts` (245 lines) to a React component.

**Current:** CardHeader is a class that builds DOM via createElement,
manages icon lookup via a vanilla Lucide map (`import { createElement }
from "lucide"`), wires button click handlers with addEventListener,
and exposes `updateMeta()` for targeted DOM mutation when the active
card changes title/icon/menu items.

**Target:** A `<CardHeader>` React component that:
- Receives `meta: TugCardMeta` and callbacks as props
- Renders icon via `lucide-react` components (replaces vanilla Lucide
  `createElement` calls)
- Renders title, spacer, menu/collapse/close buttons as JSX
- Uses `onPointerDown` for drag initiation (React synthetic event)
- Integrates `<CardDropdownMenu>` from Step 1 for the menu button
- Re-renders naturally when meta changes — no `updateMeta()` method

**Key change:** The imperative `updateMeta()` method disappears. When
the parent component passes new `meta` props, React re-renders. This
eliminates the `card-meta-update` CustomEvent channel (#6).

**Deletes:** `card-header.ts`

**CSS retained (for now):** `.card-header`, `.card-header-key`,
`.card-header-icon`, `.card-header-title`, `.card-header-spacer`,
`.card-header-btn` — these move to Tailwind in Step 9

### Step 3: CardFrame → React

Convert `card-frame.ts` (340 lines) to a React component.

**Current:** CardFrame is a class that creates the absolutely-positioned
card shell: a root div with the card header, a content area for card
mounting, and eight resize handles. It manages:
- Pointer capture for header drag (handleHeaderDrag)
- Pointer capture for resize handles (attachResizeDrag)
- Canvas boundary clamping during drag
- Drag threshold detection (3px before movement begins)
- Z-index assignment via `setZIndex()`
- Live position/size updates via direct style mutation

**Target:** A `<CardFrame>` React component that:
- Receives `panelState: CardState`, callbacks, and `meta` as props
- Renders `<CardHeader>` from Step 2 as a child
- Renders the content area as a ref-accessible div for card mounting
- Renders eight resize handle divs as JSX
- Uses React `onPointerDown` for drag and resize initiation
- Uses refs for position/size style mutations during drag (performance:
  bypasses React re-rendering during pointer moves, commits final
  position to parent callback on pointer up)
- Pointer capture via `e.currentTarget.setPointerCapture(e.pointerId)`
  in React synthetic event handlers

**Drag/resize event flow (React):**

```
onPointerDown on header
  → e.currentTarget.setPointerCapture(pointerId)
  → onPointerMove: compute new position, clamp to canvas bounds,
    call onMoving callback for snap, update position via ref
  → onPointerUp: release capture, call onMoveEnd callback

onPointerDown on resize handle
  → same pattern: capture, compute geometry, call onResizing
    for snap, update via ref, release and call onResizeEnd
```

The math is identical to the current implementation. The difference is
React synthetic events instead of `addEventListener`, and ref-based
style mutation instead of `this.el.style.left = ...`.

**Key panel tint:** `setKey(isKey)` becomes a `isKey: boolean` prop.
The header gets `card-header-key` class via conditional className.

**Deletes:** `card-frame.ts`

**CSS retained (for now):** `.card-frame`, `.card-frame-content`,
`.card-frame-resize-*` — these move to Tailwind in Step 9

### Step 4: TabBar → React

Convert `tab-bar.ts` (183 lines) to a React component.

**Current:** TabBar creates tab elements with createElement, wires
pointer events for click-to-switch and drag-reorder via setPointerCapture,
and manages hit testing with getBoundingClientRect.

**Target:** A `<TabBar>` React component that:
- Receives `tabs`, `activeTabIndex`, and callbacks as props
- Renders tabs as JSX with React event handlers
- Handles drag-reorder with `onPointerDown`/`onPointerMove` using
  pointer capture (same algorithm, React events)
- Hit testing uses refs to tab elements + getBoundingClientRect

The `update(node)` imperative method disappears — React re-renders
when the parent passes new props.

**Deletes:** `tab-bar.ts`

**CSS retained (for now):** `.card-tab-bar`, `.card-tab`,
`.card-tab-active`, `.card-tab-close` — these move to Tailwind in Step 9

### Step 5: Dock → React

Convert `dock.ts` (290 lines) to a React component.

**Current:** Dock creates DOM elements for icon buttons and a settings
gear, wires click handlers, manages a MutationObserver watching
`document.body` class changes for theme sync, listens for `td-dev-badge`
CustomEvents for badge counts, and builds settings menu items
imperatively using the vanilla DropdownMenu class.

**Target:** A `<Dock>` React component that:
- Renders icon buttons via `lucide-react` components
- Uses `<CardDropdownMenu>` from Step 1 for the settings dropdown
- Receives badge state via React props or context (not CustomEvents)
- Reads theme state via the existing `useTheme` hook
- Dispatches card actions via a React callback

**CustomEvents eliminated:**
- `td-dev-badge` (#4) — badge count flows through React state from
  DeveloperCard up to the app root, then down to Dock as props
- `td-theme-change` (#1) — Dock no longer needs a MutationObserver;
  theme state comes from useTheme

**Deletes:** `dock.ts`

**CSS removed:** All of `dock.css` (65 lines) — replaced by Tailwind
utilities on the Dock component

### Step 6: DeckManager → React Canvas Rendering

Convert DeckManager's `render()` method from imperative DOM creation
to React rendering. DeckManager creates a single React root for the
canvas and renders `<CardFrame>` and `<TabBar>` React components.

**Current render() flow (imperative):**

```
render()
  → destroy all CardFrame instances
  → destroy all TabBar instances
  → for each panel in deckState.cards:
      → new CardFrame(panelState, callbacks, canvasEl, meta)
      → container.appendChild(fp.getElement())
      → create mount divs, reparent card containers
      → card.mount(mountEl) / card.setCardFrame(fp) / card.setActiveTab()
      → if multi-tab: new TabBar(node, callbacks)
  → apply key panel state
  → recomputeSets()
```

**Target render() flow (React):**

```
render()
  → update React state with current deckState.cards
  → React renders <DeckCanvas>
      → for each panel: <CardFrame panelState={panel} meta={meta}
          callbacks={callbacks} isKey={isKey} zIndex={100+i}>
            {multi-tab && <TabBar tabs={panel.tabs} .../>}
            <CardContent ref={mountRef} />
          </CardFrame>
  → useEffect: mount card content into CardContent refs
  → useEffect: apply key panel state
```

DeckManager itself stays as a TypeScript class. It keeps:
- All state management (deckState, cardRegistry, cardsByFeed, etc.)
- All layout logic (focusPanel, addCard, removeCard, resetLayout, etc.)
- All geometry (snap callbacks, set computation, ensureSetAdjacency)
- IDragState implementation

What changes: instead of calling `new CardFrame()` and manipulating
DOM, it calls `this.reactRoot.render(...)` with updated props. The
CardFrame callbacks (onMoveEnd, onResizeEnd, onFocus, onClose, onMoving,
onResizing) stay identical — they're just passed as React props instead
of constructor arguments.

**Performance:** During drag/resize, CardFrame uses refs for style
mutations (see Step 3). DeckManager's `onMoving`/`onResizing` callbacks
return snapped positions. CardFrame applies them via refs. No React
re-render happens during the drag. React re-renders only on structural
changes (add/remove/reorder panels, tab switches).

**ReactCardAdapter simplification:** With CardFrame as a React component,
the adapter no longer needs `setCardFrame()` or the `card-meta-update`
CustomEvent listener. Card components call `updateMeta()` from
CardContext, and the meta flows up through React state to the
CardHeader props.

**Deletes:** The `cardFrames: Map<string, CardFrame>` and
`tabBars: Map<string, TabBar>` tracking maps in DeckManager — React
owns these instances now.

### Step 7: Canvas Overlays → React

Convert DeckManager's imperative DOM overlays to React components
rendered within the canvas.

Three overlay systems currently use raw `document.createElement`:

**Guide lines** (4 elements: 2 vertical, 2 horizontal)
- `createGuideLines()` creates div pool in constructor
- `showGuides(guides)` positions and shows/hides them
- `hideGuides()` hides all

**Virtual sashes** (one per shared-edge group)
- `createSashes()` creates positioned div elements at shared boundaries
- `attachSashDrag()` wires pointer events for multi-panel resize
- `destroySashes()` removes them

**Flash overlays** (transient, one per panel in a set)
- `flashPanels(cardIds)` creates overlay divs with animation
- Overlay self-removes on animationend

**Target:** These become React components rendered inside `<DeckCanvas>`:

```jsx
<DeckCanvas>
  {panels.map(p => <CardFrame .../>)}
  {guides.map(g => <SnapGuideLine axis={g.axis} position={g.position} />)}
  {sashGroups.map(sg => <VirtualSash group={sg} onResize={...} />)}
  {flashingPanels.map(id => <SetFlashOverlay panelId={id} />)}
</DeckCanvas>
```

The sash pointer events (multi-panel resize) move to React synthetic
events within the `<VirtualSash>` component. Same pointer capture
pattern as CardFrame: `onPointerDown` → capture → `onPointerMove` →
compute geometry → update via refs → `onPointerUp` → release.

**Deletes:** `createGuideLines()`, `showGuides()`, `hideGuides()`,
`createSashes()`, `attachSashDrag()`, `destroySashes()`,
`flashPanels()` methods and their associated state
(`guideElements`, `sashElements` arrays)

**CSS retained (for now):** `.snap-guide-line-*`, `.virtual-sash-*`,
`.set-flash-overlay` — these move to Tailwind in Step 9

### Step 8: Event Bridge Cleanup

With the entire chrome layer in React (Steps 1-7), clean up remaining
vanilla patterns.

**connection.ts disconnect banner:**
- Extract the banner into a `<DisconnectBanner>` React component
- Reads connection state from React context (or a hook wrapping
  TugConnection's onOpen/onClose callbacks)
- Remove `showDisconnectBanner()`, `hideDisconnectBanner()`,
  `updateBannerText()`, `updateBannerCountdown()` from connection.ts
- Remove `document.getElementById("disconnect-banner")` and the
  `<div id="disconnect-banner">` from index.html

**action-dispatch CustomEvents:**
- `td-dev-notification` (#2) and `td-dev-build-progress` (#3) currently
  dispatch CustomEvents on document so React components can listen
- With Dock and DeckManager rendering in React, action-dispatch can
  update React state directly (via a shared store or context) instead
  of dispatching CustomEvents
- DeveloperCard becomes a React context consumer instead of calling
  `document.addEventListener`

**useTheme body class mutation:**
- Keep the body class mechanism (CSS tokens require it for theme switching)
- Remove the MutationObserver in Dock (already deleted in Step 5)
- useTheme's `document.body.classList` manipulation is acceptable —
  it's a side effect of theme switching, not a rendering pattern.
  The important thing is that theme state flows through React, and
  the body class is a secondary effect for CSS

**td-hmr-update (#5):**
- This is developer-card dispatching a CustomEvent to itself as a
  testability indirection for Vite HMR events. It's fine as-is — the
  event doesn't cross a vanilla/React boundary. Low priority.

**Remaining document.addEventListener in React cards:**
- `conversation-card.tsx` line 360: `document.addEventListener("keydown")`
  — this is inside a useEffect with proper cleanup. It's a standard
  React pattern for global keyboard shortcuts. Acceptable.
- `terminal-card.tsx` line 223: `document.addEventListener("td-theme-change")`
  — once Dock's MutationObserver is removed and theme changes flow
  through React, terminal-card can use `useTheme` instead of listening
  for the CustomEvent

### Step 9: CSS Consolidation

With all chrome rendering in React + Tailwind:

- **cards-chrome.css** (404 lines) — Rules for card-frame, card-header,
  tab-bar, resize handles, snap guides, sashes, and flash overlays.
  These become Tailwind utilities on their respective React components.
  Some rules (resize handle hit areas, snap guide styling) may stay as
  CSS for clarity, moved into a minimal `chrome.css`.
- **dock.css** (65 lines) — Already removed in Step 5
- **tokens.css** — Stays as the design token source of truth, unchanged

## Dependency Graph

```
Step 1: CardMenu
  ↓         ↓
Step 2    Step 5
CardHeader  Dock
  ↓
Step 3
CardFrame
  ↓
Step 4 ──→ Step 6
TabBar     DeckManager Canvas
             ↓
           Step 7
           Canvas Overlays
             ↓
           Step 8
           Event Bridge Cleanup
             ↓
           Step 9
           CSS Consolidation
```

Steps 1 through 5 can proceed with some parallelism:
- Step 1 (CardMenu) is a prerequisite for Steps 2 and 5
- Steps 2→3 are sequential (CardHeader before CardFrame)
- Step 4 (TabBar) is independent of Steps 2-3
- Step 5 (Dock) depends only on Step 1
- Step 6 depends on Steps 3, 4, and 5
- Steps 7→8→9 are sequential after Step 6

## Risks and Mitigations

### Pointer Capture in React

The drag/resize system in CardFrame and the sash system in DeckManager
both use `setPointerCapture` for smooth cross-element tracking. React's
synthetic events fully support pointer capture:

```tsx
onPointerDown={(e) => {
  e.currentTarget.setPointerCapture(e.pointerId);
  // ... start drag state
}}
onPointerMove={(e) => {
  // ... compute position, update via ref
}}
onPointerUp={(e) => {
  e.currentTarget.releasePointerCapture(e.pointerId);
  // ... commit final position
}}
```

The migration is 1:1. Canvas boundary clamping math and snap geometry
stay identical.

### DeckManager Re-render Performance

DeckManager currently does targeted DOM mutations (move/resize update
individual element styles). A naive React re-render of the entire canvas
on every pointer move would be too slow.

Mitigation: CardFrame uses refs for position/size style mutations during
drag. React re-renders only on structural changes (panel add/remove/
reorder, tab switch, key panel change). During drag, only the ref-based
style updates run — no virtual DOM diffing.

Sash drag is the same pattern: refs during drag, state commit on
pointer up.

### Test Migration

The current tests use happy-dom with direct DOM assertions. React chrome
components will need React Testing Library. Migrate tests alongside each
step — don't defer test migration to a later step.

### DeckManager as Non-React Class

DeckManager remains a TypeScript class, not a React component. It holds
a React root and calls `root.render()`. This is the same pattern the
codebase already uses in ReactCardAdapter — a non-React class that
owns a React root and re-renders it when state changes.

The alternative (converting DeckManager to a React component) would
require lifting ~1200 lines of state management and geometry logic
into hooks. That's possible but is a larger refactor with no clear
benefit for this phase. It can happen later if needed.

## End State

After this work:

- Zero vanilla `document.createElement` in the UI layer
- Zero `addEventListener` in the UI layer (React synthetic events only,
  except xterm.js which manages its own DOM)
- Zero native HTML controls — all interactive elements are shadcn
- Zero CustomEvent bridges between vanilla and React — all data flows
  through React props, context, or callbacks
- All pointer-driven interactions (card drag, card resize, sash resize,
  tab drag-reorder) use React synthetic events with pointer capture
- A clean foundation for building a complete Tug design system on top
  of shadcn primitives

The follow-on phase (custom design+component system) can then focus
entirely on design — component variants, spacing system, color palette,
typography scale, animation language — without fighting architectural
debt in the rendering layer.

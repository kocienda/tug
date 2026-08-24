# Tugways Implementation Strategy

## The Idea

Tear down the current tugdeck frontend to a minimal canvas shell, then build the tugways design system back up from scratch — cleanly, one concept at a time, following the architecture defined in `design-system-concepts.md`.

The retronow-unified-review model is the inspiration: build components in isolation, see them visually, iterate, integrate. The app itself becomes the proving ground. Mac-native menu commands (via `sendControl` WebSocket frames) are the initial mechanism for triggering UI creation before the dock exists.

## Retronow Design Reference

The `dash/retronow/` directory contains the canonical design mockups and style references for the tugways design system. **All future phase plans must consult these resources** when designing components, layouts, and visual treatments.

### Resource Inventory

| Resource | Path | What It Provides |
|----------|------|------------------|
| **Component Pack Page** | `components/retronow/RetronowComponentPackPage.tsx` | Full-page mockup showing wrapper-style component interactions end-to-end: tabs, dialogs, buttons, sliders, inputs, textareas, selects, radio groups, checkboxes, card canvas, toasts, and the ArcGauge custom component. This is the primary reference for component gallery layout and interactive controls. |
| **Control Pack** | `components/retronow/RetronowControlPack.tsx` | Compact control showcase covering input, textarea, combo, button, slider, radio, checkbox, and address bar patterns. Reference for control layout and grouping. |
| **Deck Canvas** | `components/retronow/RetronowDeckCanvas.tsx` | React card deck canvas with drag, resize, and snap behavior. Reference for card frame, header, and canvas layout patterns. |
| **Class Recipes** | `components/retronow/retronow-classes.ts` | Central class recipes for all controls: `shell`, `panel`, `button`, `buttonSecondary`, `input`, `textarea`, `tabs`, `card`, `cardHeader`, `cardBody`, `cardCanvas`. Reference for consistent styling patterns. |
| **Component CSS** | `styles/retronow-components.css` | Full CSS for all retronow controls: titlebar, tabs, buttons, fields, sliders, panels, popups, screens, gauges, scrollbars, dialog, toast, typography. Three theme variants (light, dark/bluenote, brio). Reference for CSS structure and theme-aware styling. |
| **Deck CSS** | `styles/retronow-deck.css` | Card/canvas system styles: visible grid, snap affordances, resize handles, card frames. |
| **Design Tokens** | `styles/retronow-tokens.css` | Three-theme token system (`--rn-*`): surfaces, text, accents (8-color palette), borders, shadows, spacing, radii, fonts, depths. Reference for token naming and palette structure. |
| **Unified Review** | `mockups/retronow-unified-review.html` | Browser-openable all-in-one review page. Open directly in a browser to see the full visual language across all themes. |
| **Style Mockup** | `mockups/retronow-style-mockup.html` | Standalone style exploration mockup. |
| **Component Pack Mockup** | `mockups/retronow-component-pack-mockup.html` | Browser-openable component pack preview. |

### How to Use These References

**When planning new components:** Consult `RetronowComponentPackPage.tsx` and `RetronowControlPack.tsx` for layout patterns, interactive control grouping, and the wrapper-style component approach. The retronow "AppButton wraps Radix primitives directly" pattern is exactly the pattern tugways follows (TugButton wraps Radix primitives directly, etc.).

**When designing the Component Gallery:** The retronow component pack page is the direct inspiration for the tugways Component Gallery. Its tabbed layout (controls, workspace, diagnostics, custom gauges), panel grouping, and interactive toggle patterns should guide gallery expansion as new components are added in later phases.

**When creating CSS for components:** Consult `retronow-components.css` for the CSS structure — how controls are themed across light/dark/brio variants, how gradients, borders, and shadows are applied, and how theme-specific overrides are organized. The tugways equivalent uses `var(--td-*)` semantic tokens instead of `var(--rn-*)`, but the structural patterns are the same.

**When defining tokens for new components:** Consult `retronow-tokens.css` for the token naming scheme and palette structure. The 8-accent-color system (orange, cyan, purple, red, green, yellow, magenta, coral) and surface layering (surface-1 through surface-4) directly informed the tugways token design.

**When building card frames and canvas layout:** Consult `RetronowDeckCanvas.tsx`, `retronow-deck.css`, and the class recipes for card shell, header, and body patterns.

## What We Have Today

The current tugdeck frontend is ~60 source files across:

| Layer | Files | Lines (approx) | Role |
|-------|-------|-----------------|------|
| Transport | `connection.ts`, `protocol.ts` | ~430 | Binary WebSocket, frame encode/decode |
| Settings | `settings-api.ts` | ~90 | Server-side settings fetch/post |
| Tokens | `tokens.css`, `globals.css`, `chrome.css` | ~650 | Three-tier design tokens, Tailwind bridge, chrome CSS |
| Layout engine | `deck-manager.ts`, `snap.ts`, `serialization.ts`, `layout-tree.ts` | ~2400 | DeckManager: panels, snap, sets, sashes, persistence |
| Card layer | `card.ts`, `react-card-adapter.tsx`, `card-context.tsx` | ~290 | Card interface, adapter, context provider |
| Chrome | `deck-canvas.tsx`, `card-frame.tsx`, `card-header.tsx`, `dock.tsx`, etc. | ~1500 | Canvas renderer, panel frames, dock, tab bar |
| Card components | 8 cards + conversation sub-components | ~3000 | about, code, terminal, git, files, stats, settings, developer |
| Supporting | hooks, contexts, action-dispatch, lib, drag-state | ~500 | Wiring, utilities |
| Entry | `main.tsx`, `index.html` | ~270 | Boot sequence |
| shadcn primitives | `components/ui/*.tsx` | ~600 | button, dialog, dropdown, tooltip, etc. — **removed in Phase 8a; Tug components now wrap Radix primitives directly** |

**Total: ~9700 lines of frontend TypeScript/CSS.**

## What To Keep

These modules are solid infrastructure with no design conflicts:

| Module | Why Keep | Notes |
|--------|----------|-------|
| `connection.ts` | Clean WebSocket client, well-structured | No changes needed |
| `protocol.ts` | Binary frame protocol, shared with Rust backend | No changes needed |
| `settings-api.ts` | Clean API client, correct no-localStorage design | No changes needed |
| `tokens.css` | Three-tier token system, three themes, fonts | Tier 1 prefix rename (`--tl-` → `--tways-`), shadcn aliases removed |
| `chrome.css` | Resize handles, snap guides, sash cursors, set-flash | Compact, appropriate as CSS |
| `globals.css` | Body/grid styling | Tailwind `@import` and `@theme` bridge removed in Phase 7d — now only imports token layers and defines body/html resets |
| `index.html` | Minimal shell | Add inline body styles per eliminate-frontend-flash plan |
| `snap.ts` | Spatial geometry — snapping, sets, shared edges | ~500 lines of real math, no design conflicts |
| `serialization.ts` | Layout persistence (v5 format) | Extend for new CardState fields (collapsed, etc.) |
| `layout-tree.ts` | Core data types (`CardState`, `DeckState`, `TabItem`) | Remove dead `TabNode` type |
| `action-dispatch.ts` | Control frame routing from server/menu commands | Extend for new actions |
| `components/ui/*.tsx` | **REMOVED** — shadcn primitives (button, dialog, dropdown, tooltip, etc.) deleted in Phase 8a. All Tug components now wrap Radix primitives directly and are styled with `--tug-base-*` tokens. The `components/ui/` directory and `shadcn-base.css` are deleted. |
| `lib/utils.ts` | `cn()` utility for class joining | Simplified to plain `clsx` in Phase 7d — `tailwind-merge` removed since no Tailwind utilities remain |

## What To Demolish

### Delete entirely

| Module | Why |
|--------|-----|
| `cards/react-card-adapter.tsx` + test | All lifecycle methods are no-ops. It's a data bag that duplicates `CardConfig`. |
| `cards/card.ts` (the `TugCard` interface) | Has `@deprecated` methods (`setCardFrame`, `setActiveTab`), wrong abstraction for new system. Replaced by Tugcard composition (concept 6). |
| All 8 card components + tests | Placeholders. Will be rebuilt from scratch on the Tugcard base. The conversation card sub-components (code-block, message-renderer, etc.) are real work but can be revived later when the code card is rebuilt. |
| `card-titles.ts` | Simple string map, trivially recreated. |
| `drag-state.ts` | Tiny `IDragState` interface, collapses into DeckManager or the mutation model. |
| `hooks/use-card-meta.ts` | Tied to current `CardConfig.initialMeta` + `updateMeta` pattern. Replaced by Tugcard data hooks. |
| `hooks/use-feed.ts` | Current feed hook. Replaced by feed abstraction (concept 7). |
| `hooks/use-connection.ts` | Thin hook, trivially recreated. |
| `cards/card-context.tsx` | Current context provider. Replaced by Tugcard's own context. |
| `contexts/dev-notification-context.tsx` | Notification routing. Rebuilds cleanly on new infrastructure. |

### Gut and rewrite

| Module | What stays | What goes |
|--------|-----------|-----------|
| `main.tsx` | Boot sequence shape (fetch settings → apply theme → mount → connect). Native bridge hook. | Triple-registration mess (every card defined 3 times). All card imports. Factory/adapter wiring. |
| `deck-manager.ts` | Geometric core: snap computation, set management, shared edges, sashes, docking groups, layout persistence, sash drag. (~800 lines) | Card registration layer, `TugCard` interface usage, `cardsByFeed` fan-out routing, `ReactCardAdapter` factory methods, dock callback wiring, `keydownHandler` (→ responder chain). (~1000 lines) |
| `deck-canvas.tsx` | Panel rendering loop, imperative handle for sash drag. | `CardContent` component (→ Tugcard composition), feed data broadcasting, `callbacksRef` trick. |
| `card-frame.tsx` | Drag/resize with ref-based mutation. | Header/content split (→ Tugcard owns this). |
| `card-header.tsx` | Header layout structure. | Hardcoded `showCollapse={false}`, missing collapse icon toggle, no close confirmation. |
| `dock.tsx` | Delete and rewrite per concept 11. |

## The DeckManager Question

DeckManager is 1816 lines. It does two things:

**Geometric engine** (~800 lines worth keeping):
- Snap computation during drag/resize
- Set detection: shared edges → connected groups
- Sash groups: virtual resize handles at shared edges
- Docked corner computation (rounded vs. square per shared edge)
- Position offsets (1px overlap for docked panels)
- Set-move: dragging one set member moves the group
- Break-out detection: dragging away from a set
- Layout persistence (serialize → POST to settings API)

**App wiring** (~1000 lines to demolish):
- `cardsByFeed` routing (→ concept 7 feed abstraction)
- `TugCard` interface + `ReactCardAdapter` usage (→ concept 6 Tugcard)
- `cardConfigs` + `cardFactories` + `addCard` triple-registration (→ single registry)
- `cardMetas` state (→ Tugcard manages its own meta)
- React root creation + `render()` method (→ simpler, DeckCanvas owns more)
- Dock callbacks wiring (→ responder chain actions)
- `keyPanelId` + `focusPanel()` (→ concept 4 responder chain focus model)
- `keydownHandler` for Ctrl+` (→ responder chain key pipeline)

**Verdict**: Keep DeckManager, but extract the geometric engine into a clean
module (`canvas-geometry.ts` or similar) and rebuild the orchestrator on top of
it using the new concepts. The geometric code is ~500 lines of spatial math with
no design system dependencies — it just works on rectangles.

## Phases

### Phase 0: Demolition

**Goal**: Empty canvas. Dark grid. Connected to backend. No cards. No dock.

**What to do**:
1. Delete all card components (`components/cards/*`)
2. Delete card infrastructure (`card.ts`, `react-card-adapter.tsx`, `card-context.tsx`, `card-titles.ts`, `drag-state.ts`)
3. Delete card hooks (`use-card-meta.ts`, `use-feed.ts`, `use-connection.ts`)
4. Delete dev notification context
5. Strip `main.tsx` to: CSS imports → connection → fetch settings → apply theme → create minimal DeckManager → connect
6. Strip `DeckManager` to: hold empty DeckState, own React root, render empty DeckCanvas
7. Strip `DeckCanvas` to: render canvas div with grid background, no panels, no dock
8. Remove dead `TabNode` type from `layout-tree.ts`
9. Verify: app loads, shows dark grid, connects to backend, no errors

**Result**: ~300 lines of working frontend. A blank canvas ready for new work.

**Risk**: The backend still sends frames to the frontend. Without card
subscribers, those frames are silently dropped by `connection.ts` (it just won't
find any registered callbacks). This is fine — no errors, no crashes.

### Phase 1: Theme Foundation (Concepts 1, 2)

**Goal**: Loadable theme architecture. `components/tugways/` directory exists.

**What to do**:
1. Rename token prefix `--tl-` → `--tways-` throughout `tokens.css` and all CSS references ([D02])
2. Implement theme-as-CSS-stylesheet pattern ([D01], [D03]): theme switching injects/replaces a `<link>` tag instead of toggling body classes
3. Add `--td-duration-fast/moderate/slow/glacial` and `--td-easing-standard/enter/exit` motion tokens to tokens.css ([D23])
4. Add `--td-duration-scalar` with `prefers-reduced-motion` media query ([D24])
5. Create `components/tugways/` directory ([D06])
6. Implement `TugThemeProvider` (React context for current theme name + setter)
7. Wire Mac menu "Settings > Theme" to switch themes via control frame

**Result**: Themes load as CSS files. Motion tokens exist. Directory structure ready.

### Phase 2: First Component + Gallery (Concept 3)

**Goal**: TugButton works end-to-end. Component gallery visible in the app.

**What to do**:
1. Create `components/tugways/tug-button.tsx` — wraps Radix primitives directly, adds `onAction` chain-action mode, tugways variant tokens ([D07], [D08])
2. Create a "Component Gallery" card — a standalone view (like retronow-unified-review but live in the app) that shows all tugways components with variant toggles
3. Wire a Mac Developer menu item ("Show Component Gallery") via `sendControl` → `action-dispatch` to display the gallery as a floating panel on the canvas
4. Gallery starts with just TugButton in all its variants
5. As each new component is built in later phases, add it to the gallery

**Result**: Visible proof that the design system works. A live environment for testing components.

**Design reference**: The retronow `RetronowComponentPackPage.tsx` is the direct model for the Component Gallery. As new components are added in later phases, the gallery should grow to match the retronow pack's tabbed layout, panel grouping, and interactive toggle patterns. See [Retronow Design Reference](#retronow-design-reference) for the full inventory.

**Note on the gallery**: This is not a card in the old sense — it doesn't need the Tugcard infrastructure from concept 6. It's a simple React component rendered in a basic frame on the canvas. It exists to prove the component system before the card system is rebuilt.

### Phase 3: Responder Chain (Concept 4)

**Goal**: Event routing infrastructure. Key pipeline works.

**What to do**:
1. Implement `ResponderChainManager` — singleton that manages the chain tree ([D09])
2. Implement `useResponder` hook — registers a component as a responder node
3. Implement four-stage key pipeline: capture → focused responder → bubble → app-level ([D10])
4. Implement action validation: `canHandle` + `validateAction` ([D11])
5. Wire DeckCanvas as a responder (receives canvas-level actions)
6. Wire the gallery panel as a responder (test basic key routing)
7. Implement keyboard shortcuts (e.g., panel cycling) in the responder chain key pipeline

**Result**: Actions flow through the responder chain. Focus is chain-managed, not DeckManager-managed.

### Phase 4: Mutation Model + DOM Hooks (Concept 5)

**Goal**: Three-zone mutation model is operational.

**What to do**:
1. Implement `useCSSVar` hook — read/write CSS custom properties on a ref'd element ([D13])
2. Implement `useDOMClass` hook — toggle classes without re-render
3. Implement `useDOMStyle` hook — set inline styles without re-render
4. Document the three zones: appearance (CSS, zero re-renders), local data (targeted setState), structure (subtree re-render) ([D12])
5. Apply the five structure-zone rules ([D14])

**Result**: Components can mutate appearance without React re-renders. The mutation discipline is established.

**Note**: DeckManager's existing ref-based style mutation during drag is a natural appearance-zone operation. Formalizing it with the new hooks happens in Phase 5 when the DeckManager orchestrator is rebuilt and cards exist to test with.

### Phase 5: Tugcard Base (Concept 6)

**Goal**: Cards can be created, framed, receive data, participate in the chain.

**What to do**:
1. Implement `Tugcard` composition component ([D15]): `<Tugcard><Tugcard.Header /><Tugcard.Content /></Tugcard>`
2. Implement `useTugcardData` hook ([D16]) — provides card dimensions, feed data, dispatch, collapse state
3. Implement dynamic min-size ([D17]) — cards report their minimum dimensions
4. Rebuild `CardFrame` to wrap Tugcard and integrate with DeckManager geometry
5. Implement card registration: single registry, one call per card type (no triple-registration)
6. Wire Mac menu "Developer > Show [Card Type]" commands via control frames
7. Rebuild `DeckManager` orchestrator: new card registry, simplified render method, feed routing delegated to Tugcard hooks
8. Build one test card (maybe a simple "hello world" card) to prove the pipeline end-to-end

**Result**: A card appears on the canvas when triggered from the Mac menu. It has a title bar, can be dragged, resized, snapped, and docked. The old infrastructure is fully replaced.

### Phase 5a: Tugcard Selection Model (Concept 14)

**Goal**: Selection is contained within card boundaries. Card chrome is never selectable. Cmd+A is scoped to the focused card.

**What to do**:
1. Add `user-select: none` to canvas background, card frames, accessory slots, and resize handles. Add explicit `user-select: text` to card content areas. Title bar header already has `user-select: none` from Phase 5.
2. Implement `SelectionGuard` singleton — registers card content areas as selection boundaries, tracks which card owns the active selection, clips selection when it escapes the originating card. Includes `saveSelection`/`restoreSelection` methods for per-card selection persistence (used by Phase 5b tab switching).
3. Implement `useSelectionBoundary` hook — called by Tugcard on its content area div to register/unregister with SelectionGuard. Card authors never interact with the guard directly.
4. Implement pointer-clamped selection clipping ([D36]): during drag selection, when the pointer exits the card boundary, clamp coordinates to the boundary edge and use `document.caretPositionFromPoint()` to find the nearest text position. Call `selection.extend()` to pin the selection focus at the edge. Zero visual flash.
5. Implement RAF-based autoscroll in SelectionGuard: pointer-clamping breaks native browser autoscroll (the browser never sees the pointer leave the scrollable area), so SelectionGuard must implement distance-based autoscroll via `requestAnimationFrame` during clamped selection drag. After each scroll tick, re-clamp and re-extend the selection to track newly visible content.
6. Implement `selectionchange` safety net for keyboard-driven selection extension (Shift+arrow).
7. Implement `data-td-select` attribute API ([D37]) with four modes: default (text), `none`, `all`, `custom`. Wire via CSS rules and SelectionGuard awareness. The `custom` mode explicitly handles contenteditable regions — verify with a contenteditable test div that selection containment works correctly when contenteditable's native behavior tries to extend selection beyond the card.
8. Wire `selectAll` responder action in Tugcard ([D38]) to call `selectAllChildren` on the card's content area. Cmd+A now selects within the focused card only.
9. Add `--td-selection-bg` and `--td-selection-text` semantic tokens to `tokens.css`. Add `::selection` rule to `tugcard.css`.
10. Add `overscroll-behavior: contain` to card content area CSS to prevent scroll chaining during selection drag.
11. Test: selection cannot cross card boundaries, chrome is never selectable, Cmd+A is card-scoped, autoscroll works in overflow content, contenteditable regions work correctly with `data-td-select="custom"`, save/restore selection round-trips correctly.

**Result**: Selection is fully contained within card boundaries. Title bars, accessory slots, canvas gaps, and resize handles are never selectable. Drag selection clamps smoothly at card edges with RAF-based autoscroll for overflow content. Cmd+A selects within the focused card. Card authors can mark regions as non-selectable, atomic-selectable, or custom-managed (including contenteditable) via `data-td-select`. Selection persistence infrastructure is ready for Phase 5b tab switching.

### Phase 5a2: DeckManager Store Migration (Concept 5, [D40]-[D42])

**Goal**: DeckManager becomes a subscribable store. One `root.render()` at construction time. All subsequent state changes flow through `useSyncExternalStore`. Responder registration uses `useLayoutEffect`. The async render gap that causes timing bugs between imperative state and React rendering is eliminated.

**Background**: React 19's `createRoot().render()` is asynchronous — it schedules work via `queueMicrotask()` and returns immediately. DeckManager currently calls `root.render()` on every state mutation (10+ call sites), creating a timing gap where imperative code (like `makeFirstResponder`) runs before React has processed the render. This manifests as responder chain bugs (Ctrl+` cycling fails) and will affect any future feature that combines imperative state mutations with React rendering.

**What to do**:
1. Add `subscribe`/`getSnapshot`/`getVersion` methods to DeckManager following the `useSyncExternalStore` contract. Add a `notify()` private method that increments the version and fires subscriber callbacks.
2. Create `DeckManagerContext` (`createContext<DeckManager | null>(null)`) and `useDeckManager()` convenience hook in a new `deck-manager-context.tsx` module.
3. Modify DeckManager constructor: wrap the single `root.render()` call with a `<DeckManagerContext.Provider value={this}>` around the existing component tree. This is the only `root.render()` call that will ever execute.
4. Replace all `this.render()` calls in DeckManager's mutating methods (`addCard`, `removeCard`, `moveCard`, `focusCard`, `applyLayout`, `refresh`) with `this.notify()`. Remove the `private render()` method entirely.
5. DeckCanvas reads `deckState` from DeckManager via `useSyncExternalStore(manager.subscribe, manager.getSnapshot)` instead of receiving it as a prop. Remove `deckState` from `DeckCanvasProps`. Read `onCardMoved`, `onCardClosed`, `onCardFocused` callbacks from the DeckManager instance (accessed via context) instead of props.
6. Switch `useResponder` registration from `useEffect` to `useLayoutEffect`. This ensures responder nodes register during the commit phase (before paint), not after. Responder chain is always consistent before the next browser event fires.
7. Verify: Ctrl+` cycling works end-to-end, card focus visuals update correctly, add/remove cards works via Mac menu, layout persistence works (save/load), drag/resize works (onCardMoved), close button works (onCardClosed), all existing tests pass.

**Files modified**:
1. `tugdeck/src/deck-manager.ts` — subscribe/getSnapshot/notify API, remove repeated render() calls
2. `tugdeck/src/deck-manager-context.tsx` — new module: DeckManagerContext + useDeckManager hook
3. `tugdeck/src/components/chrome/deck-canvas.tsx` — read from store via useSyncExternalStore, remove deckState/callback props
4. `tugdeck/src/components/tugways/use-responder.tsx` — useEffect → useLayoutEffect for registration

**Result**: DeckManager state changes are deterministic. The async render gap is eliminated. The responder chain is always consistent. Future features that combine imperative mutations with React rendering (tab switching, card snapping, dock actions, modal dialogs) inherit these guarantees automatically.

**Note**: This phase is a focused infrastructure change — it does not add new user-facing features. It fixes the architectural root cause of timing bugs between DeckManager and React, establishing a reliable foundation for all subsequent phases.

### Phase 5b: Card Tabs (Concept 12)

**Goal**: Cards support multiple tabs with click-based management. Tab bar appears when a card has more than one tab.

**What to do**:
1. Implement `TugTabBar` component — horizontal tab strip with tab select, close, and add ([D30])
2. Wire tab state into Tugcard: `tabs` array, `activeTabId`, content switching ([D31])
3. Tab bar renders only when `tabs.length > 1` — single-tab cards show no tab bar
4. Tab icons — each tab displays its card type icon from `getRegistration(tab.componentId).defaultMeta.icon`. Same icon source for title bar (single-tab) and tab bar (multi-tab)
5. Active/inactive tab visual states — active tab has bottom border accent, inactive tabs are muted, close buttons appear on hover
6. [+] button with type picker dropdown — lists all registered card types (icon + title) from `getAllRegistrations()`. Selecting a type adds a new tab of that type. Mixed-type tabs fully supported — no card type restrictions
7. Active tab's content mounts; inactive tabs unmount (responder chain follows automatically)
8. Register `previousTab` and `nextTab` responder actions on Tugcard — switch tabs via the responder chain (no-op for single-tab cards). Keyboard bindings wired in a later phase
9. Wire Mac menu command to add a tab to the focused card (for testing)
9. Verify tab persistence via existing `CardState.tabs` / `CardState.activeTabId` in serialization
10. Add TugTabBar to the Component Gallery

**Result**: A card can host multiple tabs of any type. Switching tabs changes the visible content and the active responder. The tab bar is invisible for the common single-tab case. Tab icons provide visual identity, especially for mixed-type cards.

### Phase 5b2: Tab Drag Gestures (Concept 12)

**Goal**: Tabs can be reordered, detached, and merged via drag gestures.

**What to do**:
1. Drag-to-reorder — drag a tab within its tab bar to change position. Pointer-capture on the tab element, hit-test against tab positions, animated insertion indicator
2. Drag-to-detach — drag a tab out of the tab bar onto the canvas to create a new single-tab card. Hit-test against the tab bar boundary; once outside, create a new CardState with the detached tab and remove it from the source card
3. Drag-to-merge — drag a tab from one card onto another card's tab bar to add it as a new tab. Hit-test against all visible tab bars. Works regardless of card type (mixed-type tabs supported)
4. Visual feedback during drag — ghost tab follows pointer, insertion indicator shows drop position, tab bar highlights as valid drop target

**Result**: Users can freely reorganize tabs between cards via direct manipulation. Combined with Phase 5b's click-based management, tabs are a fully interactive composition feature.

**Note**: Phase 5b2 depends on Phase 5b (tab bar component and tab state management must exist). It does not block any other phase.

### Phase 5b3: Gallery Card (Concept 3, [D43])

**Goal**: Convert the Component Gallery from a floating absolute-positioned panel to a proper registered card with tabs.

**What to do**:
1. Register `"component-gallery"` as a card type in `card-registry.ts` with `CardRegistration` — contentFactory, defaultMeta (title: "Component Gallery", icon, closable: true), defaultFeedIds: []
2. Create `ComponentGalleryCard` content component — replaces the current `ComponentGallery` floating panel. Uses five tabs, one per demo section: TugButton, Chain-Action Buttons, Mutation Model, TugTabBar, TugDropdown
3. Rework `show-component-gallery` action to create/focus the gallery card in the deck (via `DeckManager.addCard` or focus if already present) rather than toggling a floating panel
4. Remove the floating panel infrastructure — `galleryVisible` state in DeckCanvas, `registerGallerySetter` in action-dispatch, the absolute-positioned `cg-panel` CSS
5. Extract each gallery section into a standalone content component (one per tab) — each renders independently when its tab is active
6. Verify gallery card works with existing tab infrastructure — tab switching, type picker, persistence, responder chain
7. Update tests — replace floating panel assertions with card-in-deck assertions

**Result**: The Component Gallery is a proper card that dogfoods the card and tab systems. No z-index hacks for dropdown portals. Gallery persists across sessions. The five tabs provide clean section separation.

**Note**: Phase 5b3 depends on Phase 5b (tab bar and tab state must exist). It does not depend on Phase 5b2 (drag gestures).

### Phase 5b4: Tab Overflow (Concept 12, [D44])

**Goal**: Tab bars handle overflow gracefully via progressive collapse — icon-only inactive tabs, then an overflow dropdown.

**What to do**:
1. Add a `ResizeObserver` to TugTabBar that measures available width and computes which tabs fit
2. Implement Stage 1 collapse — when tabs don't fit at full size, render inactive tabs as icon-only (hide labels). Active tab always shows icon+label
3. Implement Stage 2 overflow — when icon-only tabs still don't fit, excess tabs move into an overflow dropdown at the right end of the bar. The dropdown shows icon+label for each overflow tab
4. Implement active tab visibility rule — selecting a tab from the overflow dropdown moves it to the rightmost visible slot, displacing the previous rightmost tab into the overflow
5. Add overflow dropdown button with tab count badge, styled with `--td-*` tokens, using TugDropdown
6. Ensure the [+] type picker button remains visible at all times (rightmost, after overflow dropdown if present)
7. Handle dynamic changes — tab add/remove, card resize, and drag-to-merge (Phase 5b2) all trigger re-measurement
8. Update Component Gallery's TugTabBar demo to show overflow behavior

**Result**: Tab bars degrade gracefully as tabs accumulate. The active tab is always visible. Users can access all tabs via the overflow dropdown. The tab bar never wraps or scrolls.

**Note**: Phase 5b4 depends on Phase 5b (tab bar component must exist). It does not depend on Phase 5b2 (drag gestures) or Phase 5b3 (gallery card), though both benefit from overflow handling.

### Phase 5b5: Tab Refinements (Concept 12, [D45])

**Goal**: Tab interaction refinements discovered during implementation of Phases 5b2–5b4.

**What to do**:
1. Card-as-tab merge — when a card drag (via CardFrame) ends over another card's tab bar, merge the source card's tab into the target instead of completing the move. On pointer up in CardFrame's drag handler, hit-test against all `.tug-tab-bar[data-card-id]` elements. If the drop position is inside a tab bar belonging to a different card, call `store.mergeTab(sourceCardId, sourceTabId, targetCardId, insertIndex)` and remove the now-empty source card. This reuses the existing `mergeTab` DeckManager method and the `data-card-id` hit-test infrastructure from Phase 5b2.

**Result**: Single-tab cards can be merged into other cards via drag, completing the tab composition story. Combined with Phase 5b2's tab-to-tab drag gestures, all tab reorganization scenarios are covered.

**Note**: Phase 5b5 depends on Phase 5b2 (drag coordinator and hit-test infrastructure must exist). Additional refinement items may be added as Phases 5b3 and 5b4 are implemented.

### Phase 5e: Tugbank Defaults Store (Concept 17, [D46]-[D48])

**Goal**: Replace the flat-file settings backend with a SQLite-backed typed defaults store. Establish the persistence infrastructure that Phase 5f (state preservation) and all future state-heavy features build on.

Phase 5e is split into four sub-phases for incremental delivery.

**Storage path**: The default database file is `~/.tugbank.db`. The `--path` CLI flag or programmatic path parameter overrides this default. Exactly one file is active at a time — no cascade or multi-file lookup.

**Blob size limit**: Values of type `Bytes` are capped at 10 MB, enforced at the API level before touching SQLite.

#### Phase 5e1: `tugbank-core` Library Crate

**Goal**: Build the core Rust library that all other sub-phases depend on.

**What to do**:
1. Create `tugbank-core` library crate in the tugtool workspace
2. SQLite schema bootstrap (WAL mode, `meta`, `domains`, `entries` tables)
3. `Value` enum (null, bool, i64, f64, string, bytes, json) with SQL mapping
4. `DefaultsStore` — open/create database, schema versioning and migration
5. `DomainHandle` — domain CRUD, key get/set/remove, `read_all`, `keys`
6. CAS concurrency via generation counters (`generation`, `set_if_generation`, `update` transaction)
7. 10 MB blob size enforcement at write API boundary
8. Unit tests: value roundtrip, SQL mapping, CAS conflict detection, blob size enforcement
9. Integration tests: two-process writer contention

**Files created**:
1. `tugcode/crates/tugbank-core/` — new library crate (Cargo.toml, src/lib.rs, src/schema.rs, src/value.rs, src/store.rs, src/domain.rs, src/error.rs)

**Result**: Standalone library crate that can be depended on by both the CLI and tugcast. Full test coverage for correctness and concurrency.

#### Phase 5e2: `tugbank` CLI Binary

**Goal**: Provide a `defaults`-like command-line tool for debugging, scripting, and manual inspection of tugbank databases.

**What to do**:
1. Create `tugbank` binary crate with `clap`-based CLI
2. Default database path: `~/.tugbank.db`; overridable with `--path <db-path>`
3. Global flags: `--json` (machine output), `--pretty` (pretty JSON)
4. Commands: `domains`, `read`, `write`, `delete`, `keys`, `cas-write`, `generation`
5. Exit codes: 0=success, 2=not found, 3=conflict, 4=invalid usage, 5=busy/timeout, 1=other
6. Verify: CLI can create databases, write/read all value types, CAS operations work

**Files created**:
1. `tugcode/crates/tugbank/` — new binary crate (Cargo.toml, src/main.rs)

**Result**: `tugbank` CLI is a standalone tool usable for development and scripting without requiring tugcast.

#### Phase 5e3: Tugcast HTTP Bridge Integration

**Goal**: Wire tugbank into the tugcast Rust server so the frontend can read/write defaults via HTTP.

**What to do**:
1. Add `DefaultsStore` to tugcast — open `~/.tugbank.db` at startup (path configurable)
2. Implement HTTP bridge endpoints: `GET /api/defaults/<domain>`, `GET /api/defaults/<domain>/<key>`, `PUT /api/defaults/<domain>/<key>`, `DELETE /api/defaults/<domain>/<key>`
3. Verify: HTTP endpoints work end-to-end with tugbank-core

**Files modified**:
1. `tugcode/crates/tugcast/` — DefaultsStore integration, HTTP bridge endpoints

**Result**: Tugcast exposes tugbank via HTTP. Frontend integration is possible but not yet wired.

#### Phase 5e4: Settings Migration

**Goal**: Migrate from the legacy flat-file settings backend to tugbank. Update the frontend to use the new endpoints.

**What to do**:
1. On first startup, if legacy flat settings file exists, read its contents and write them into `dev.tugtool.deck.layout` (cards JSON) and `dev.tugtool.app` (theme) domains, then remove the flat file
2. Update `settings-api.ts` to use the new `/api/defaults/` endpoints for layout and theme reads/writes. Preserve the debounced save pattern.
3. Preserve `GET /api/settings` and `POST /api/settings` as compatibility shims during transition, then remove
4. Verify: app loads layout from tugbank, theme persists across reload

**Files modified**:
1. `tugcode/crates/tugcast/` — migration logic
2. `tugdeck/src/settings-api.ts` — new endpoint URLs, domain-aware reads/writes

**Result**: All persistence flows through tugbank. The flat settings file is gone. Domain separation (`dev.tugtool.deck.layout`, `dev.tugtool.deck.state`, `dev.tugtool.deck.tabstate`, `dev.tugtool.app`) is established for Phase 5f and beyond.

**Note**: Phases 5e1 and 5e2 are pure Rust work. Phase 5e3 adds backend integration. Phase 5e4 is the only phase that touches the frontend.

### Phase 5f: Inactive State Preservation (Concept 18, [D49]-[D52])

**Goal**: Card and tab state survives both tab switching and app reload. Selections, scroll positions, collapse state, focused card identity, and card content state are all preserved. Inactive cards display selections with a dimmed appearance following standard GUI conventions.

**What to do**:
1. Add `collapsed?: boolean` to `CardState` in `layout-tree.ts` ([D52]). Update serialization to read/write it. No UI yet — Phase 8c builds the collapse toggle.
2. Add `focusedCardId?: string` to `DeckState` in `layout-tree.ts` ([D51]). DeckManager writes it to tugbank (`dev.tugtool.deck.state` → `focusedCardId`) on focus change. On reload, call `makeFirstResponder` on the restored card ID after mount.
3. Implement `TabStateBag` type — `{ scroll?: { x: number; y: number }; selection?: SavedSelection | null; content?: unknown }`. Create an in-memory cache (`Map<string, TabStateBag>`) on DeckManager for fast tab-switch access.
4. Implement Tugcard deactivation capture: on tab switch away, read `contentArea.scrollLeft`/`scrollTop`, call `SelectionGuard.saveSelection()`, call the card content's `onSave` callback (if registered). Write the state bag to the in-memory cache and debounce-write to tugbank (`dev.tugtool.deck.tabstate` domain, keyed by tab ID).
5. Implement Tugcard activation restore: on tab switch to, read the state bag from the in-memory cache (falling back to tugbank on cache miss). After mount, set `contentArea.scrollLeft`/`scrollTop`. Call `SelectionGuard.restoreSelection()`. Call the card content's `onRestore` callback (if registered).
6. Implement `useTugcardPersistence` hook ([D50]) — card content components call `useTugcardPersistence({ onSave: () => T, onRestore: (state: T) => void })`. The hook registers callbacks with Tugcard via context. Tugcard calls `onSave` on deactivation and `onRestore` on activation.
7. On app reload: DeckManager reads all tab state bags from tugbank during initialization. Passes them to Tugcard instances. Each Tugcard restores its active tab's state on first mount.
8. Implement inactive selection appearance ([D77]): add `--tug-base-selection-bg-inactive` token to `tug-tokens.css` with theme-specific overrides in `bluenote.css` and `harmony.css`. Add CSS rule scoped to `.card-frame[data-focused="false"] .tugcard-content ::selection` to use the dimmed background. Pure CSS, no React state — follows Rule 4.
9. Verify: switch tabs → scroll position restored, selection restored. Reload app → scroll position restored, selection restored, focused card restored, collapsed state restored. Card content state round-trips via `useTugcardPersistence`. Inactive cards display selections with dimmed background across all three themes.

**Files created/modified**:
1. `tugdeck/src/layout-tree.ts` — add `collapsed` to CardState, `focusedCardId` to DeckState
2. `tugdeck/src/serialization.ts` — serialize/deserialize new fields
3. `tugdeck/src/deck-manager.ts` — tab state cache, focus persistence, tugbank writes
4. `tugdeck/src/components/tugways/tugcard.tsx` — deactivation capture, activation restore lifecycle
5. `tugdeck/src/components/tugways/use-tugcard-persistence.tsx` — new hook
6. `tugdeck/src/selection-guard.ts` — ensure save/restore works with the new lifecycle (may need no changes if the API is already correct)
7. `tugdeck/styles/tug-tokens.css` — add `--tug-base-selection-bg-inactive` token
8. `tugdeck/styles/bluenote.css`, `tugdeck/styles/harmony.css` — theme-specific inactive selection overrides

**Result**: Tab state survives both tab switches and app reload. Card content components can opt into state persistence via a simple hook. The selection guard's existing save/restore mechanism is extended from in-memory-only to durable persistence via tugbank. The `collapsed` field is ready for Phase 8c's UI. The focused card is restored on reload. Inactive cards display selections with a dimmed background following standard GUI conventions.

**Note**: Terminal buffer persistence is explicitly deferred to Phase 9's terminal card work. The `useTugcardPersistence` hook provides the mechanism; the terminal card will implement its own `onSave`/`onRestore` for xterm.js buffer state when the time comes. Similarly, Monaco editor state persistence (cursor position, scroll, folding, find widget) will use the same `useTugcardPersistence` hook via `editor.saveViewState()`/`editor.restoreViewState()` when a code card is introduced in Phase 8/9 — the hook's opaque `content` blob is designed to handle arbitrarily complex state structures.

### Phase 5f2: State Preservation Fixes (Concept 18, [D77])

**Goal**: Fix four state preservation failures from Phase 5f so that scroll positions, text selections, and card content state actually survive tab switches and app reloads without visual glitches or silent failures.

**What to do**:
1. Defer scroll and selection restore from `useLayoutEffect` to `requestAnimationFrame` in tugcard.tsx. The `useLayoutEffect` fires before the browser completes layout, so `scrollTop` assignments are clamped to 0 and `setBaseAndExtent` silently fails. RAF fires after layout when content has its full scrollable dimensions.
2. Suppress the one-frame visual flash (content visible at scroll position 0 before RAF fires) by applying `visibility: hidden` on the content area during the first frame, restoring visibility in the RAF callback. Apply only when scroll state needs restoring — selection-only restores have no visible flash.
3. Replace the `::selection`-based inactive selection styling with the CSS Custom Highlight API (`CSS.highlights`, `::highlight(inactive-selection)`). The browser clears the global Selection on `pointerdown`, so `::selection` has nothing to style. The Highlight API paints saved ranges independently of the global Selection.
4. Add proactive range capture in SelectionGuard's `handlePointerDown` (capture phase): a separate loop visits ALL boundaries before the existing tracking loop, capturing the live Range for cards losing focus and clearing highlights for cards gaining focus.
5. Add `::highlight(inactive-selection)` CSS rule to tugcard.css, reusing the existing `--tug-base-selection-bg-inactive` token.
6. Update D77 in `dash/design-system-concepts.md` to document the CSS Custom Highlight API approach.
7. Remove the dead `savedSelections` field from SelectionGuard (vestigial from Phase 5b, replaced by DeckManager cache in Phase 5f).

**Files created/modified**:
1. `tugdeck/src/components/tugways/tugcard.tsx` — rewrite activation restore `useLayoutEffect` with RAF deferral and flash suppression
2. `tugdeck/src/components/tugways/selection-guard.ts` — add highlight fields, `captureInactiveHighlight`/`clearInactiveHighlight` methods, pointerdown integration, remove dead `savedSelections` field
3. `tugdeck/src/components/tugways/tugcard.css` — add `::highlight(inactive-selection)` rule
4. `tugdeck/src/types/highlight-api.d.ts` — ambient TypeScript declarations for CSS Custom Highlight API
5. `dash/design-system-concepts.md` — update D77

**Result**: All four Phase 5f failures are resolved. Scroll positions and selections survive tab switches and app reloads. Inactive cards display saved selections with a dimmed highlight via the CSS Custom Highlight API. No visual flash on restore. Rules of Tugways strictly followed — all appearance changes via CSS/DOM (Rule 4), no React state mutations.

**Note**: Phase 5f2 depends on Phase 5f (the infrastructure it fixes must exist). It does not change any data model, API surface, or hook interface — it fixes timing and visual behavior only.

### Phase 5f3: State Preservation More Fixes (Concept 18, [D49], [D77])

**Goal**: Fix three remaining state preservation failures that survived Phase 5f2. The corrected design decisions D49 (lifecycle ordering, save-on-close) and D77 (click-back selection restore) in design-system-concepts.md define the correct behavior. This phase implements those corrections.

**What to do**:
1. Fix restore ordering in tugcard.tsx: move `onRestore` (content restore) out of the RAF callback and into the `useLayoutEffect` body so it runs synchronously before the RAF. Content must be in the DOM before scroll and selection restore — `scrollTop` is clamped when content hasn't populated the scrollable area, and `setBaseAndExtent` fails when text nodes don't exist yet. The RAF callback then restores scroll and selection against a fully-populated DOM.
2. Add save-on-close: each Tugcard registers a save callback with DeckManager on mount via `useLayoutEffect` (Rule #3). DeckManager listens for `visibilitychange` (`document.visibilityState === 'hidden'`) and `beforeunload`. On either event, DeckManager calls all registered save callbacks to capture the currently-active tab's state in every card, then flushes all dirty tab states to tugbank immediately (bypassing the normal 500ms debounce). Unregistration in `useLayoutEffect` cleanup.
3. Add click-back selection restore in SelectionGuard: on `pointerdown` in a card that has a stored highlight range, stash the range as `pendingHighlightRestore` and clear the highlight. On `pointerup`, if the current selection is collapsed (simple click, no drag), restore the real Selection from the stashed range via `removeAllRanges()` + `addRange()`. If non-collapsed (user dragged to select new text), discard the stash — the user's new selection takes precedence.

**Files created/modified**:
1. `tugdeck/src/components/tugways/tugcard.tsx` — reorder restore: content in useLayoutEffect body, scroll+selection in RAF
2. `tugdeck/src/deck-manager.ts` — add save callback registration (`registerSaveCallback`/`unregisterSaveCallback`), `visibilitychange` and `beforeunload` listeners in `attach()`/`detach()`, immediate flush on close
3. `tugdeck/src/components/tugways/selection-guard.ts` — add `pendingHighlightRestore` field, modify pointerdown highlight loop to stash range on click-back, add pointerup logic to conditionally restore selection
4. `tugdeck/src/__tests__/tugcard.test.tsx` — update restore tests for new ordering (content before RAF)
5. `tugdeck/src/__tests__/selection-guard.test.ts` — add click-back restore tests
6. `tugdeck/src/__tests__/deck-manager.test.ts` — add save-on-close tests (visibilitychange, beforeunload)

**Result**: All three bugs are fixed. Scroll positions are restored accurately (content populates DOM before scroll is set). Selections survive app close/reload (save callback fires on visibilitychange/beforeunload). Clicking back into a card with a dimmed selection restores the real selection instead of clearing it. Rules of Tugways strictly followed — save callback registration via useLayoutEffect (Rule #3), current state via refs (Rule #5), appearance changes via CSS/DOM (Rule #4), one responsibility per layer (Rule #8).

**Note**: Phase 5f3 depends on Phase 5f2 (the CSS Custom Highlight infrastructure and RAF deferral must exist). It corrects ordering, adds missing lifecycle hooks, and closes the click-back restore loop.

### Phase 5f4: State Preservation Solidified (Concept 18, [D78], [D79])

**Goal**: Replace the double-RAF timing bet in tugcard's scroll/selection restore with a deterministic child-driven ready callback. Establish the `onContentReady` facility as a general-purpose primitive in `useTugcardPersistence`. Add Rules of Tugways 11 and 12 to codify the proven React 19 commit timing guarantees.

**Background — React 19 commit timing (spike findings)**:

A spike (`tugdeck/src/__tests__/react19-commit-timing.test.tsx`) proved six facts about React 19's commit timing that invalidate the double-RAF approach:

1. **F1**: `setState` inside `useLayoutEffect` does NOT commit child DOM inline. The parent's effect body sees stale DOM (0 items, not 3).
2. **F2**: `flushSync` inside `useLayoutEffect` is a noop — does not force inline commit.
3. **F3**: Bottom-up effect ordering does not help. Child's `useLayoutEffect` fires first, calls `setState`, but parent's effect fires after and still sees stale DOM.
4. **F4**: A parent's no-deps `useLayoutEffect` does NOT fire on the child's re-render (the parent doesn't re-render — only the child does).
5. **F5**: After `act()` boundary (all React work flushed), DOM is committed. This confirms the re-render happens but in a separate commit cycle.
6. **F6**: Direct DOM mutation (no `setState`) IS immediately visible inline.

A second spike (`tugdeck/src/__tests__/content-ready-spike.test.tsx`) proved the general principle for the replacement mechanism across 11 scenarios:

**The ref-flag principle**: A component's own no-deps `useLayoutEffect` fires on every render of THAT component — including re-renders caused by its own `setState`. By setting a ref flag when `onRestore` is called and checking it in a no-deps `useLayoutEffect`, the hook fires `onContentReady` at exactly the right moment: after the child's restored state is committed to the DOM. The mechanism is content-agnostic — it doesn't need to know what state changed, only that `onRestore` was called.

Scenarios proven: basic ref-flag (S1), DOM committed at callback time (S2), one-shot per restore (S3), rapid sequential restores (S4), no false fires from user interaction setState (S5), independent sibling components (S6), full persistence context indirection (S7), nested content with grandchild rendering (S8), static content no false signals (S9), DOM measurements valid in callback (S10), rapid tab switch cancellation (S11).

**What to do**:

1. **Extend `TugcardPersistenceCallbacks`**: Add `onContentReady?: () => void` to the interface in `use-tugcard-persistence.tsx`. This is optional — existing card content that doesn't need the ready signal continues to work unchanged.

2. **Extend `useTugcardPersistence` with the ref-flag mechanism**: Add a `restorePendingRef` and a no-deps `useLayoutEffect` inside the hook. When `onRestore` is called (by Tugcard), the wrapper sets `restorePendingRef = true` before delegating to the card content's restore callback. The no-deps `useLayoutEffect` checks the flag on every render; when set, it fires `onContentReady` (through the registered callbacks) and clears the flag. This is the 12-line mechanism proven in the spike.

3. **Rewrite tugcard's restore flow**: Replace the double-RAF pattern (lines 344-409 of `tugcard.tsx`) with a two-phase approach:
   - **Phase 1 effect** (`useLayoutEffect [activeTabId]`): Call `onRestore(bag.content)` to trigger child `setState`. If `bag.scroll` exists, apply `visibility: hidden` to the content area and store pending scroll/selection in refs.
   - **`onContentReady` callback**: Registered by Tugcard with the persistence callbacks. When fired by the child's hook, applies `scrollTop`/`scrollLeft` from pending refs, restores selection via `selectionGuard.restoreSelection`, and removes `visibility: hidden`. No RAF anywhere.
   - **Cleanup**: If the effect re-fires (rapid tab switch) before `onContentReady`, clear pending refs and restore visibility.
   - **No-persistence fallback**: When no card content has registered `useTugcardPersistence` (so `onContentReady` never fires), apply scroll/selection immediately in the Phase 1 effect — no hiding needed since there's no child `setState` to wait for.

4. **Update existing tests**: Rewrite tests in `tugcard.test.tsx` that verify or work around the double-RAF pattern. Tests that use double `setTimeout(0)` to flush nested RAFs should be replaced with tests that verify the `onContentReady` callback sequence. Add new tests for the no-persistence fallback path.

5. **Keep spike tests**: The two spike test files (`react19-commit-timing.test.tsx` and `content-ready-spike.test.tsx`) are reference documentation. They stay as-is — they prove the foundational facts that Rules 11 and 12 are built on.

**Files created/modified**:
1. `tugdeck/src/components/tugways/use-tugcard-persistence.tsx` — add `onContentReady` to `TugcardPersistenceCallbacks`, add ref-flag mechanism to `useTugcardPersistence`
2. `tugdeck/src/components/tugways/tugcard.tsx` — replace double-RAF restore with Phase 1 effect + `onContentReady` callback + cleanup + no-persistence fallback
3. `tugdeck/src/__tests__/use-tugcard-persistence.test.tsx` — add tests for `onContentReady` registration, ref-flag one-shot behavior, no false fires
4. `tugdeck/src/__tests__/tugcard.test.tsx` — rewrite RAF-dependent restore tests for `onContentReady` pattern
5. `dash/design-system-concepts.md` — Rules 11 and 12 added, design decisions D78 and D79 added (done prior to this phase as spike conclusions)

**Result**: Scroll and selection restore is deterministic. The double-RAF timing bet is eliminated. The `onContentReady` facility is generally available via `useTugcardPersistence` for any future DOM operation that depends on restored content being committed. Rules of Tugways 11 ([D78]) and 12 ([D79]) codify the React 19 commit timing facts and the correct pattern. The spike test files serve as permanent reference documentation for the underlying React guarantees.

**Note**: Phase 5f4 depends on Phase 5f3 (the content-first restore ordering and save-on-close infrastructure must exist). It replaces the RAF timing mechanism but preserves all other Phase 5f3 behavior (visibility flash suppression, cleanup on rapid tab switch, save callbacks). The `onContentReady` pattern is forward-compatible with Monaco editor and terminal buffer persistence (Phase 9) — any card content that calls `setState` in its `onRestore` callback automatically gets the deterministic ready signal.

**Post-5f4 solidification** (state preservation across app lifecycle):

After Phase 5f4 shipped, state preservation was extended to cover the full macOS app lifecycle and several architectural improvements were made:

1. **Unified card rendering**: DeckCanvas now always constructs Tugcard directly with all props. The old two-path system (factory + `cloneElement` for single-tab, direct Tugcard construction for multi-tab) was replaced with a single `contentFactory` field on `CardRegistration`. The `factory` field, `CardFrameInjectedProps` export, and all `cloneElement` injection were removed.

2. **Native app lifecycle integration**: Swift's `AppDelegate` uses `applicationShouldTerminate` (not `applicationWillTerminate`) with `terminateLater` to call `window.__tugdeckSaveState()` before quit. This invokes `DeckManager.saveAndFlushSync()`, which uses synchronous XHR to guarantee writes complete before teardown. App deactivation (`applicationDidResignActive`) saves state asynchronously via `saveAndFlush()` and dims all selections via `SelectionGuard.deactivateApp()`. App activation (`applicationDidBecomeActive`) restores the active card's highlight and browser Selection via `SelectionGuard.activateApp()`.

3. **Eager CSS Highlight creation**: SelectionGuard creates CSS Custom Highlight objects in its constructor (module scope, before React mounts) rather than in `attach()`. This ensures highlights exist before any Tugcard restore effects fire. `attach()` only installs event listeners; `detach()` unregisters from `CSS.highlights` but does not null the objects.

4. **Auto-save**: Each Tugcard installs debounced scroll and selectionchange listeners that funnel into a `markDirty` callback (1-second debounce). Card content can also trigger saves via `useTugcardDirty()` hook (`TugcardDirtyContext`). This ensures state is persisted continuously during normal use, not just on tab switch or app close.

5. **Close button highlight bypass**: Elements marked with `data-no-activate` are skipped by SelectionGuard's native pointerdown handler. The close button uses this plus `stopPropagation` (prevents bring-to-front) and `preventDefault` (prevents focus shift) on pointerdown, with pointer capture for Mac-like pointer-up-inside tracking.

6. **Method naming**: `saveAndFlushSync()` for the synchronous app-quit path, `saveAndFlush()` for the asynchronous deactivation path.

### Phase 5c: Card Snapping (Concept 13)

**Status: COMPLETE** (2026-03-04)

**Goal**: Snap-to-edge and set formation require the Option (Alt) modifier. Free drag is the default.

**What was done**:
1. Gated snap behavior on configurable modifier key (default: Alt/Option) via `SNAP_MODIFIER_KEY` constant and `isSnapModifier()` helper in `card-frame.tsx`. Solo card drag only calls `computeSnap` when modifier is held.
2. Mid-drag modifier toggle supported: pressing/releasing Option immediately shows/hides guides and snaps/unsnaps.
3. Set-move works without modifier once a set is formed — dragging any member moves the group.
4. Break-out triggered by pressing Option during set-move (modifier transition false→true), not just drag distance.

**Result**: Casual drags are free movement. Option+drag activates snap guides and set formation. Set-move and break-out behavior work correctly.

### Phase 5c2: Card Snap Set Refinements (Concept 13, [D53]-[D60])

**Status: COMPLETE** (2026-03-05)

**Goal**: Snapped card sets look and behave like unified shapes — squared corners, single-line borders, outer-hull perimeter flash, clip-path shadow management, and clean break-out visuals. Plus card activation refinements.

**What was done** (across PRs #85-#88 and a dash):

1. **Border collapse in snap math** ([D56]): `computeSnap` in `snap.ts` gained a `borderWidth` parameter. Snap positions offset inward by border width so adjacent card borders overlap. Drag reads computed width via `getComputedStyle(tugcardEl).borderTopWidth`; resize uses hardcoded 1px.
2. **Set corner rounding** ([D53]): simplified from per-corner computation to uniform `border-radius: 0` for all set members via CSS `data-in-set` attribute. `updateSetAppearance()` sets/removes the attribute based on set membership.
3. **Outer-hull perimeter flash** ([D54]): `computeSetHullPolygon()` added to `snap.ts` — coordinate compression + grid-based boundary trace. `flashSetPerimeter()` renders a single SVG `<path>` stroking the hull with glow filter. Replaced the per-card overlay edge-suppression approach.
4. **Break-out visual restoration** ([D55]): removing `data-in-set` restores rounded corners via CSS. `flashCardPerimeter()` creates a `.card-flash-overlay` div. Break-out triggered by Alt key transition (false→true) during set-move.
5. **Shadow rewrite** ([D57]): replaced `.set-shadow` DOM elements with `clip-path: inset()` on `.tugcard`. `computeClipPathForCard()` helper maps SharedEdge data to inset values. `SHADOW_EXTEND_PX = 20`. Deleted `_gestureActive` flag system, `dragShadowEl`/`resizeShadowEl` refs, shadow tracking in drag/resize RAF loops. Store subscriber calls `updateSetAppearance` unconditionally.
6. **Active/inactive shadow tokens** ([D58]): added `--td-card-shadow-inactive` across all three themes. `.tugcard` uses inactive shadow by default; `.card-frame[data-focused="true"] .tugcard` uses active shadow.
7. **Command-key suppresses activation** ([D59]): `metaKey` check in `handleFramePointerDown` and `handleResizeStart` skips `onCardFocused` call.
8. **Resize click activates card** ([D60]): `handleResizeStart` explicitly calls `onCardFocused(id)` since `stopPropagation()` prevents the frame handler from firing.

**Files modified**:
1. `tugdeck/src/snap.ts` — `computeSnap` borderWidth parameter, `computeSetHullPolygon` algorithm
2. `tugdeck/src/components/chrome/card-frame.tsx` — clip-path system, flash functions, break-out, activation, deleted shadow tracking infrastructure
3. `tugdeck/src/components/chrome/deck-canvas.tsx` — removed `isGestureActive` guard, unconditional `updateSetAppearance`
4. `tugdeck/styles/chrome.css` — `.tugcard` shadow rules, `.card-flash-overlay`, removed `.set-shadow`/`.set-shadow-shape`
5. `tugdeck/styles/tokens.css` — `--td-card-shadow-inactive` token
6. `tugdeck/styles/bluenote.css` — bluenote inactive shadow override
7. `tugdeck/styles/harmony.css` — harmony inactive shadow override

**Result**: Snapped sets look like unified shapes with clean single-line borders, squared corners, clip-path shadow management, and hull-polygon perimeter flash. Break-out cleanly restores visual independence. Active/inactive shadows differentiate focused cards. Resize activates cards. Command-click preserves window order.

**Note**: Phase 5c2 depended on Phase 5c (snap and set-move). Both phases are now complete. They do not block any other phase.

### Phase 5d1: Default Button (Concept 3, [D39])

**Goal**: Dialogs, alerts, sheets, and popovers can designate a default button. Enter activates it. The `primary` variant is the visual affordance.

**What to do**:
1. Add `setDefaultButton(buttonRef)` and `clearDefaultButton(buttonRef)` methods to `ResponderChainManager` — registers/unregisters a default button for the current modal scope
2. Extend the stage-2 key pipeline handler to check for a registered default button when Enter is pressed: if no native `<button>` or text input has DOM focus, activate the default button via synthetic click
3. Confirm `primary` variant styling uses `--td-accent` fill as the default button visual — already wired via `--primary: var(--td-accent)` in `tokens.css`, verify it reads clearly in all three themes
4. Fix `destructive` variant styling in `tug-button.css` — the destructive button currently looks indistinguishable from other variants. Add explicit `background-color: var(--td-danger)` and `color: var(--td-text-inverse)` to `.tug-button-destructive` so destructive buttons have a bold red fill with white text across all three themes. Verify in the Component Gallery that primary (accent fill) and destructive (danger fill) are clearly distinct
5. Update TugConfirmPopover to register its confirm button as the default button on open, clear on close
6. Wire alert button role logic in `TugAlertHost`: when a `"destructive"` button is present, the `"cancel"` button gets `variant="primary"` and is registered as the default button; when no destructive button is present, the `"default"` role button gets `variant="primary"` and is registered as the default button
7. Wire the same role logic in `TugSheetHost`
8. Test: Enter activates the default button in alerts, sheets, and popovers; Enter does not interfere when a native button or text input has focus; destructive actions have Cancel as the default button; destructive buttons are visually distinct (bold red fill, white text) from primary buttons (accent fill)

**Result**: The default button pattern works end-to-end. Enter activates the accent-filled `primary` button in any modal context. The responder chain manages scoping so nested modals (sheet inside a card while an alert is open) route Enter correctly.

**Note**: Phase 5d1 depends on Phase 3 (responder chain exists) and Phase 5 (Tugcard base, where alerts and sheets are first consumed). It does not depend on Phase 8g (which builds TugAlert/TugSheet/TugConfirmPopover) — rather, Phase 8g depends on Phase 5d1 for the default button registration mechanism. Phase 5d1 establishes the responder chain extension and key pipeline wiring; Phase 8g wires it into the concrete alert/sheet/popover components.

### Phase 5d2: Control Action Foundation (Concept 19, [D61]-[D63])

**Status: COMPLETE** (2026-03-05)

**Goal**: The responder chain supports typed action payloads, continuous action phases, explicit-target dispatch, never-hide button semantics, and a last-resort responder. All existing dispatch call sites migrated from bare strings to `ActionEvent` with zero legacy support.

**What was done**:
1. Defined `ActionPhase` type and `ActionEvent` interface in `responder-chain.ts` — `{ action, sender?, value?, phase }` with five phases: `discrete`, `begin`, `change`, `commit`, `cancel`
2. Changed `dispatch()` to accept only `ActionEvent` (clean break — no string overload, no backward compatibility). All handler signatures changed from `() => void` to `(event: ActionEvent) => void`
3. Added `dispatchTo(targetId, event)` for explicit-target dispatch — throws `Error` on unregistered target
4. Added `nodeCanHandle(nodeId, action)` for per-node capability queries without chain walk
5. Added `target` prop to `TugButton` — uses `dispatchTo` and `nodeCanHandle` instead of chain-walk dispatch/canHandle
6. Changed TugButton to never hide — buttons render as `aria-disabled` when unhandled, never return `null`
7. Added `canHandle: () => true` to DeckCanvas as last-resort responder
8. Added ActionEvent Dispatch demo section to gallery Chain Actions tab
9. Migrated all ~40 dispatch call sites and all handler registrations in a single step
10. Removed obsolete `nonexistentAction` button from gallery and its test

**Files modified** (19 total):
1. `tugdeck/src/components/tugways/responder-chain.ts` — ActionPhase, ActionEvent, dispatch signature, dispatchTo, nodeCanHandle
2. `tugdeck/src/components/tugways/use-responder.tsx` — UseResponderOptions.actions type change
3. `tugdeck/src/components/tugways/responder-chain-provider.tsx` — keybinding dispatch produces ActionEvent
4. `tugdeck/src/components/tugways/tug-button.tsx` — target prop, never-hide, ActionEvent dispatch
5. `tugdeck/src/action-dispatch.ts` — dispatch calls produce ActionEvent
6. `tugdeck/src/components/tugways/tugcard.tsx` — handler signatures accept ActionEvent
7. `tugdeck/src/components/chrome/deck-canvas.tsx` — handler signatures, canHandle: () => true
8. `tugdeck/src/components/tugways/cards/gallery-card.tsx` — removed nonexistentAction, added ActionEvent demo
9. `tugdeck/src/__tests__/responder-chain.test.ts` — dispatch migration + dispatchTo/nodeCanHandle tests
10. `tugdeck/src/__tests__/chain-action-button.test.tsx` — dispatch migration + hide-to-disable inversion + target tests
11. `tugdeck/src/__tests__/tugcard.test.tsx` — dispatch migration
12. `tugdeck/src/__tests__/deck-canvas.test.tsx` — dispatch migration + last-resort test
13. `tugdeck/src/__tests__/use-responder.test.tsx` — dispatch migration
14. `tugdeck/src/__tests__/e2e-responder-chain.test.tsx` — dispatch migration
15. `tugdeck/src/__tests__/action-dispatch.test.ts` — mock manager + assertion migration
16. `tugdeck/src/__tests__/component-gallery-action.test.ts` — mock manager migration
17. `tugdeck/src/__tests__/key-pipeline.test.tsx` — handler signature migration
18. `tugdeck/src/__tests__/selection-model.test.tsx` — dispatch migration
19. `tugdeck/src/__tests__/component-gallery.test.tsx` — handler migration, removed nonexistentAction test

**Result**: The responder chain speaks a richer action language. `dispatch()` accepts only `ActionEvent` — bare strings are a compile error. Continuous controls can express begin/change/commit/cancel phases. Inspector panels can target specific cards via `dispatchTo`. TugButton never hides — unhandled actions render as disabled. DeckCanvas is the last-resort responder. 655 tests pass, zero TypeScript errors.

**Note**: Phase 5d2 depends on Phase 5a2 (responder chain infrastructure must be stable). It does not depend on Phase 5d1 (default button) — the two are independent extensions to the responder chain.

### Phase 5d3: Mutation Transactions (Concept 20, [D64]-[D66])

**Goal**: Live-preview editing with snapshot/restore. Inspector scrubs mutate CSS/DOM in the appearance zone; commit finalizes, cancel reverts. Style cascade introspection available for inspector display.

**What to do**:
1. Implement `MutationTransaction` class — `begin(target, properties)` snapshots current CSS/inline/data-attribute values; `preview(target, property, value)` applies appearance-zone mutations; `commit()` finalizes; `cancel()` restores snapshot
2. Implement `MutationTransactionManager` singleton — creates transactions, tracks active transactions per element, auto-cancels previous transaction if a new one starts on the same element
3. Implement `StyleCascadeReader` utility — `getDeclared(element, property)` returns value + source layer (`token`/`class`/`inline`/`preview`); `getComputed(element, property)` returns computed value; `getTokenValue(tokenName)` reads from document computed style
4. Build a vertical-slice demo in the Component Gallery: a mock card element with a color swatch and x/y coordinate fields. Scrubbing the color picker previews the change in real time (appearance zone). Releasing commits. Pressing Escape cancels and restores the original color. The demo shows the cascade reader displaying which layer the current value comes from
5. Verify: preview mutations are pure CSS/DOM (no React re-renders during scrub). Cancel restores exactly the snapshotted state. Commit leaves final values in place. Multiple sequential transactions on the same element work correctly

**Files created/modified**:
1. `tugdeck/src/components/tugways/mutation-transaction.ts` — new: MutationTransaction, MutationTransactionManager
2. `tugdeck/src/components/tugways/style-cascade-reader.ts` — new: StyleCascadeReader utility
3. `tugdeck/src/components/tugways/cards/gallery-card.tsx` — mutation transaction demo section

**Result**: The infrastructure for live-preview editing exists. Inspector panels (Phase 8h) and continuous controls (Phase 8d) can use transactions for scrub-preview-commit workflows without custom snapshot/restore code.

**Note**: Phase 5d3 depends on Phase 5d2 (action phases drive transaction lifecycle) and Phase 4 (mutation model hooks for appearance-zone operations). It does not depend on Phase 5d1.

### Phase 5d4: Observable Properties (Concept 21, [D67]-[D69])

**Goal**: Cards can expose inspectable properties via a typed key-path store. Inspectors discover, read, write, and observe properties without importing card internals. PropertyStore integrates with `useSyncExternalStore` for targeted React re-renders.

**What to do**:
1. Implement `PropertyStore` class — typed key-value store with schema validation, `get(path)`, `set(path, value, source)`, `observe(path, listener)` returning unsubscribe function. Change records include `{ path, oldValue, newValue, source, transactionId? }`
2. Implement `PropertySchema` and `PropertyDescriptor` types — path, type (`string`/`number`/`boolean`/`color`/`point`/`enum`), label, constraints (min/max, enumValues, readOnly)
3. Implement `usePropertyStore` hook — card content components call this to register a PropertyStore with their card. Takes schema + `onGet`/`onSet` callbacks. Returns the store instance
4. Ensure `useSyncExternalStore` compatibility — `PropertyStore.observe()` works as a subscribe function; `PropertyStore.get()` returns stable references for unchanged values (no spurious re-renders)
5. Wire `setProperty` action handler in Tugcard — when a `setProperty` action arrives via the responder chain (from an inspector), route it to the card content's PropertyStore
6. Build a minimal inspector demo in the Component Gallery: a PropertyStore with three properties (color, fontSize, fontFamily). An inspector panel reads the schema, renders appropriate controls, and edits via `dispatchTo`. Changes reflect in both the target element (live preview via transaction) and the inspector fields (via store observation)
7. Verify: inspector reads match card state, inspector writes update the card, changes from the card side notify the inspector, source attribution prevents circular updates, `useSyncExternalStore` triggers re-renders only for the changed property

**Files created/modified**:
1. `tugdeck/src/components/tugways/property-store.ts` — new: PropertyStore, PropertySchema, PropertyChange
2. `tugdeck/src/components/tugways/hooks/use-property-store.ts` — new: usePropertyStore hook
3. `tugdeck/src/components/tugways/tugcard.tsx` — setProperty action handler routing
4. `tugdeck/src/components/tugways/cards/gallery-card.tsx` — inspector demo section

**Result**: The property observation infrastructure is complete. Cards can opt in to inspectability with a hook call and a schema. Inspector panels (Phase 8h) compose with any card via the PropertyStore + responder chain, with zero direct coupling.

**Note**: Phase 5d4 depends on Phase 5d2 (explicit-target dispatch for inspector→card actions) and Phase 5d3 (mutation transactions for live preview). It is the capstone of the 5d sub-phases, establishing the full inspector pipeline.

### Phase 5d5a: Palette Engine → TugColor Runtime (Concept 22, [D70])

**Status: COMPLETE**

**Goal**: A computed OKLCH color palette with 24 hue families using the TugColor (Hue · Intensity · Tone · Alpha) system, runtime-generated and injectable as CSS custom properties. P3 wide-gamut support. An interactive gallery demo for canonical lightness tuning.

**What was done** (across three implementation rounds):

*Round 1 — Palette Engine (PR #93, commit 2858e85):* Initial smoothstep/anchor-based system with `tugPaletteColor()`, 264 CSS variables (24 hues × 11 stops), named tone aliases, per-hue chroma caps, theme parameter protocol, and an interactive gallery demo with smoothstep/bezier/piecewise curve comparison.

*Round 2 — Anchor Palette Engine (PR #94, commit 8898a8a):* Added anchor-point interpolation (`tugAnchoredColor`), per-theme anchor data (`theme-anchors.ts` with BRIO/BLUENOTE/HARMONY_ANCHORS), and `injectPaletteCSS(theme, anchorData)` wiring. Gallery editor gained piecewise transfer function with third breakpoint. Canonical lightness values were tuned interactively.

*Round 3 — TugColor Runtime (PR #95, commit 4fbdeda + fixup d3b7e33):* Complete replacement of the smoothstep/anchor system with TugColor. Promoted `tugColor()` and canonical constants from the gallery editor to `palette-engine.ts`. Implemented `injectTugColorCSS(themeName)` emitting three layers: 168 semantic preset CSS variables (7 presets × 24 hues), 74 per-hue constants, and `@media (color-gamut: p3)` overrides. Added `oklchToLinearP3`, `isInP3Gamut`, `MAX_P3_CHROMA_FOR_HUE`. Wired into `main.tsx` and `theme-provider.tsx`. Removed all legacy code: smoothstep, anchor types, `tugPaletteColor`, `tugAnchoredColor`, `TONE_ALIASES`, `theme-anchors.ts`, old `--tug-palette-hue-*` variable names. Post-merge fix: corrected chroma cap derivation to sample at canonical L only (not L_DARK/L_LIGHT extremes which crushed all chroma to near-zero).

**Final state of files**:
1. `tugdeck/src/components/tugways/palette-engine.ts` — TugColor runtime: `tugColor()`, `injectTugColorCSS()`, `HUE_FAMILIES`, `MAX_CHROMA_FOR_HUE`, `MAX_P3_CHROMA_FOR_HUE`, `DEFAULT_CANONICAL_L`, `TUG_COLOR_PRESETS`, P3 gamut functions
2. `tugdeck/src/components/tugways/cards/gallery-palette-content.tsx` — interactive palette gallery with canonical L editor, TugColor grid, import/export
3. `tugdeck/src/components/tugways/cards/gallery-palette-content.css` — gallery styles
4. `tugdeck/src/components/tugways/theme-anchors.ts` — **deleted** (legacy anchor data removed)
5. `tugdeck/src/main.tsx` — calls `injectTugColorCSS(initialTheme)` at boot
6. `tugdeck/src/contexts/theme-provider.tsx` — calls `injectTugColorCSS(newTheme)` on theme switch

**Result**: The TugColor palette is live. 242 CSS variables (168 presets + 74 constants) plus P3 overrides are injected at boot and theme switch. `tugColor()` provides programmatic color computation. The gallery editor enables interactive canonical L tuning. All legacy smoothstep/anchor code is removed.

**Key lesson**: Chroma cap derivation must sample at the canonical lightness only — not at extreme L values (L_DARK=0.15, L_LIGHT=0.96) where the sRGB gamut is narrow. Sampling at extremes bottlenecks all caps to near-zero, producing grey colors. At extreme tone values, CSS `oklch()` handles out-of-gamut colors via browser gamut mapping.

### Phase 5d5b: Global Scale & Timing (Concept 22, [D72]-[D73])

**Goal**: A single `--tug-zoom` value controls all UI dimensions via CSS `zoom`. A single `--tug-timing` value controls all animation durations. A `--tug-motion` toggle disables motion entirely.

**What was done**:
1. Added `--tug-zoom: 1`, `--tug-timing: 1`, and `--tug-motion: 1` to `:root` in `tokens.css`
2. Added `zoom: var(--tug-zoom)` on `<body>` — scales the entire UI (layout boxes, text, spacing, radii, icons) with one property. No per-token `calc()` wiring needed
3. Added `prefers-reduced-motion` media query that sets `--tug-motion: 0`
4. Implemented `data-tug-motion` attribute management with global CSS rule that zeroes all animation/transition durations when off
5. Defined timed duration tokens: `--tug-base-motion-duration-{fast,moderate,slow,glacial}` expressed as `calc(<base> * var(--tug-timing))`
6. Implemented JS helpers: `getTugScale()`, `getTugTiming()`, `isTugMotionEnabled()`, `initMotionObserver()`
7. Built gallery demo with scale slider (0.85–2.0, applies on release to avoid layout thrash), timing slider (0.1–10.0), and motion toggle

**Key design decision**: CSS `zoom` on `<body>` replaces the originally-proposed `calc(<base> * var(--tug-zoom))` pattern for every dimension token. Zoom scales everything uniformly — Tailwind utility classes, hardcoded pixel values, inline styles, and token-driven dimensions all scale together. This eliminates the need to rewrite every component to use scaled tokens, massively simplifying Phases 5d5c and 5d5d.

**Files created/modified**:
1. `tugdeck/styles/tokens.css` — global multipliers on `:root`, `zoom` on body, timed duration tokens
2. `tugdeck/src/components/tugways/scale-timing.ts` — JS helpers and motion observer
3. `tugdeck/src/components/tugways/cards/gallery-scale-timing-content.tsx` — scale/timing demo tab
4. `tugdeck/src/components/tugways/cards/gallery-card.css` — demo styles

**Result**: The entire UI resizes by changing one number (zoom). All animations speed up or slow down by changing one number. Motion can be disabled entirely. JS-driven animations respect the same values.

**Note**: Phase 5d5b does not depend on Phase 5d5a (palette engine) — the two are independent.

### Phase 5d5c: Token Architecture (Concept 22, [D71])

**Status: COMPLETE** (2026-03-06)

**Goal**: Introduce the `--tug-base-*` and `--tug-<component>-*` token layers with the full semantic taxonomy. Temporary aliases bridge old tokens to new tokens. No consumer migration yet.

**What was done**:
1. Defined the complete `--tug-base-*` semantic taxonomy in `tug-tokens.css` — ~300 tokens across surfaces, foreground, icon, borders, elevation, typography, spacing, radius, motion, accent, selection, workspace chrome, controls, menus, overlays, feedback, tables, charts, syntax, terminal, chat, files, inspector domains
2. Created `tug-comp-tokens.css` with initial `--tug-<component>-*` component token families (naming convention: `--tug-<component>-<property>`, where `base` is the special root-level component)
3. Created temporary backward-compatibility aliases in `tokens.css` — every `--td-*` and `--tways-*` token got an alias pointing to the equivalent `--tug-base-*` token
4. Created theme override files: `bluenote.css` (~139 overrides) and `harmony.css` (~304 overrides) with theme-specific `--tug-base-*` values
5. Verified: all existing components render identically with the backward-compatibility aliases in place across all three themes

**What was deferred**: All chromatic `--tug-base-*` tokens were defined with hardcoded hex values instead of `var(--tug-{hue}[-preset])` palette references. The intent was to wire accent, chart, syntax, and status tokens to the TugColor palette, but this was deferred in favor of getting the naming architecture in place first. The palette integration is now Phase 5d5e.

**Files created/modified**:
1. `tugdeck/styles/tug-tokens.css` — new: complete `--tug-base-*` taxonomy (hardcoded hex values, not TugColor-wired)
2. `tugdeck/styles/tug-comp-tokens.css` — new: `--tug-<component>-*` families
3. `tugdeck/styles/tokens.css` — backward-compatibility aliases added
4. `tugdeck/styles/bluenote.css` — new: Bluenote theme overrides
5. `tugdeck/styles/harmony.css` — new: Harmony theme overrides

**Result**: The new token architecture exists in parallel with the old one. All new tokens are defined. Backward-compatibility aliases ensure zero visual regression. However, chromatic tokens use hardcoded hex values rather than resolving from the TugColor palette — the palette integration that connects Layer 0 to Layer 1 is deferred to Phase 5d5e.

### Phase 5d5d: Consumer Migration (Concept 22, [D71])

**Status: COMPLETE** (2026-03-07, PR #98)

**Goal**: Migrate all CSS and TypeScript consumers from `--td-*`/`--tways-*` to `--tug-base-*`/`--tug-<component>-*`. Remove all legacy aliases. Search-based enforcement.

**What was done**:
1. Migrated 6 tugways component CSS files — `tug-button.css`, `tug-tab-bar.css`, `tugcard.css`, `tug-dropdown.css`, `gallery-card.css`, `tug-tab-bar-animations.css` (169 var references updated)
2. Migrated chrome CSS — `chrome.css` (12 replacements)
3. Migrated `globals.css` — rewrote the Tailwind v4 `@theme` bridge to reference `--tug-base-*` directly
4. Migrated `tokens.css` — Shiki bridge, chart aliases, motion tokens, scrollbar styling
5. Migrated 12 TypeScript files — inline SVG, style objects, JSDoc, test assertions
6. Removed backward-compatibility aliases from `tokens.css`
7. Added `tugdeck/scripts/check-legacy-tokens.sh` — CI enforcement script that greps for `--td-`, `--tways-`, and legacy alias names
8. Verified all three themes render correctly. 923/924 tests pass (1 pre-existing unrelated failure)

**Files modified**:
1. `tugdeck/src/components/tugways/*.css` — 6 component CSS files
2. `tugdeck/styles/chrome.css` — chrome token references
3. `tugdeck/styles/tokens.css` — Shiki bridge, chart aliases, removed legacy aliases
4. `tugdeck/src/globals.css` — Tailwind bridge rewritten
5. 12 TypeScript files — inline style references
6. `tugdeck/scripts/check-legacy-tokens.sh` — new: CI enforcement

**Result**: The migration is complete. All consumers point at `--tug-base-*` and `--tug-<component>-*` tokens. No `--td-*`, `--tways-*`, or legacy aliases remain. CI enforcement prevents regression. However, the `--tug-base-*` tokens themselves still resolve to hardcoded hex values — the palette integration connecting Layer 0 (TugColor palette) to Layer 1 (semantic tokens) is Phase 5d5e.

### Phase 5d5e: Palette Engine Integration (Concept 22, [D70], [D71], [D75])

**Goal**: Wire the TugColor palette engine to the semantic token layer. Convert the palette from JS-injected `oklch()` strings to pure CSS formulas. Add neutral ramp. Replace all hardcoded hex color values in `--tug-base-*` chromatic tokens with `var(--tug-{hue}[-preset])` references.

**What to do**:
1. Create a static `tug-palette.css` file containing the 74 per-hue constants (`--tug-{hue}-h`, `--tug-{hue}-canonical-l`, `--tug-{hue}-peak-c`) plus globals (`--tug-l-dark`, `--tug-l-light`), derived from `tug-color-canonical.json`
2. Define the 168 chromatic preset variables (7 presets × 24 hues) as pure CSS formulas using `oklch()` + `calc()` + per-hue constants. Phase 5g later reshapes this to 5 convenience presets with `calc()`+`clamp()` formulas and inline TugColor formulas in theme files
3. Add `--tug-neutral-*` achromatic ramp (7 presets with C=0) plus `--tug-black` and `--tug-white` anchors [D75]
4. Add `@media (color-gamut: p3)` block that overrides `--tug-{hue}-peak-c` with wider P3 chroma caps — preset formulas automatically produce richer colors since they reference `peak-c`
5. Wire `--tug-base-*` chromatic tokens in `tug-tokens.css` to TugColor palette variables: accent tokens → `var(--tug-orange[-preset])`, chart series → `var(--tug-{hue})`, syntax tokens → `var(--tug-{hue}[-preset])`, status tokens → `var(--tug-{hue}-accent)`, etc., per the mappings in `theme-overhaul-proposal.md`
6. Update theme override files (`bluenote.css`, `harmony.css`) — replace hardcoded hex overrides with hue reassignments (e.g., Bluenote's accent becomes `var(--tug-blue)` instead of a hardcoded blue hex). Theme differentiation becomes "which hues map to which roles" rather than "which hex values"
7. Remove `injectTugColorCSS()` runtime injection — the palette is now static CSS. Retain `tugColor()` in `palette-engine.ts` for programmatic JS use (color pickers, data viz, inline styles)
8. Remove `injectTugColorCSS` calls from `main.tsx` and `theme-provider.tsx`
9. Verify: all three themes render correctly with palette-derived colors. Chromatic tokens resolve through the palette. Inspector shows full chain. `bun test` passes

**Files created/modified**:
1. `tugdeck/styles/tug-palette.css` — new: per-hue constants, preset formulas, neutral ramp, P3 overrides
2. `tugdeck/styles/tug-tokens.css` — modified: chromatic tokens rewired from hex to `var(--tug-{hue}[-preset])`
3. `tugdeck/styles/bluenote.css` — modified: hex overrides → hue reassignments
4. `tugdeck/styles/harmony.css` — modified: hex overrides → hue reassignments
5. `tugdeck/src/globals.css` — modified: import `tug-palette.css` in the correct order
6. `tugdeck/src/components/tugways/palette-engine.ts` — modified: remove `injectTugColorCSS`, keep `tugColor()` and constants
7. `tugdeck/src/main.tsx` — modified: remove `injectTugColorCSS` call
8. `tugdeck/src/contexts/theme-provider.tsx` — modified: remove `injectTugColorCSS` call

**Result**: The color system is fully connected. `--tug-base-*` semantic tokens resolve through `var(--tug-{hue}[-preset])` palette variables, which are pure CSS `oklch()` formulas built from per-hue constants. Themes differentiate by overriding hue assignments. The palette is inspectable in static CSS — no JS injection needed. Neutrals and chromatic colors use the same system. Opacity is available via CSS relative color syntax at the point of use.

**Key design insight**: The TugColor transfer function (piecewise linear L, linear C) is simple enough to express entirely in CSS `calc()`. CSS `oklch()` natively accepts `calc()` expressions. This eliminates JS runtime injection and makes the entire palette inspectable, debuggable, and composable in standard CSS.

**Note**: Phase 5d5e depends on Phase 5d5d (consumers must already reference `--tug-base-*` tokens). It does not depend on any other phase. This is the critical integration step that connects the TugColor palette engine (Phase 5d5a) to the semantic token layer (Phase 5d5c) through the consumer migration (Phase 5d5d).

### Phase 5d5f: Cascade Inspector (Concept 22, [D74])

**Goal**: A dev-mode `Ctrl+Option + hover` overlay that shows the full token resolution chain for any inspected component.

**What to do**:
1. Implement `StyleInspectorOverlay` singleton — tracks global modifier state for `Ctrl+Option`, manages overlay lifecycle
2. On pointer move with modifiers active: locate target with `elementFromPoint`, walk to nearest inspect root, read computed style, resolve token chain via `StyleCascadeReader`
3. Display overlay showing: component identity, DOM path, selected computed properties (background, foreground, border, shadow, radius, typography), full resolution chain (`--tug-<component>-*` → `--tug-base-*` → `--tug-{hue}[-preset]`)
4. For TugColor palette colors: display hue family name, preset name, and TugColor coordinates (e.g., "orange canonical — i:50, t:50, L:0.780")
5. Display current `--tug-zoom` and `--tug-timing` values and their effect on the inspected element's dimensions and transitions
6. Implement pin/unpin — clicking while inspecting pins the overlay so the user can stop hovering and examine details. `Escape` closes
7. Highlight the target element with a dev-only overlay outline
8. Add gallery demo section showing the inspector in action
9. Verify: inspector correctly resolves all three token layers, palette provenance is accurate, scale/timing readout matches actual values

**Files created/modified**:
1. `tugdeck/src/components/tugways/style-inspector-overlay.ts` — new: StyleInspectorOverlay singleton
2. `tugdeck/src/components/tugways/style-inspector-overlay.css` — new: overlay styles
3. `tugdeck/src/components/tugways/cards/gallery-card.tsx` — inspector demo section

**Result**: The style system is navigable. Developers can point at any element and see exactly which tokens are in play, where they come from, and how scale/timing affect them. The computed palette provenance makes OKLCH color choices transparent.

**Note**: Phase 5d5f depends on Phase 5d5e (palette integration must be complete so the inspector shows the full resolution chain from `--tug-<component>-*` through `--tug-base-*` to `--tug-{hue}[-preset]` palette variables). It also benefits from Phase 5d3 (`StyleCascadeReader` utility) and Phase 5d4 (`PropertyStore` for additional introspection), though it can function without them.

### Phase 5g: Palette Refinements (Concept 22, [D70])

**Goal**: Reshape the TugColor palette from a fixed-preset system to a continuous color space with five convenience presets per hue. Replace confusing coefficient knobs with `calc()`+`clamp()` formulas using literal i/t numbers. Rename `accent` → `intense`. Rewrite theme files to define chromatic semantic tokens using the inline TugColor formula with theme-specific i/t choices. Enhance the gallery editor for interactive i/t exploration.

**Full specification**: `dash/palette-refinements.md` contains the complete design — five convenience presets, inline formula for arbitrary colors, theme design workflow, consumer API, and implementation scope.

**Key design shift**: Semantic tokens (`--tug-base-*`) become where theme-specific chromatic choices live. Each theme writes its chromatic tokens using the inline TugColor formula with whatever i/t numbers suit that theme. The five convenience presets (canonical, light, dark, intense, muted) are fixed reference colors — stable across all themes, not the system's backbone.

**What to do**:
1. **Rename `accent` → `intense`**: Update all palette preset references in `tug-palette.css`, `tug-tokens.css`, `palette-engine.ts`, theme files, and all component CSS/TS files. Semantic tokens using `accent` as a UI role name (e.g., `--tug-base-accent-default`) keep `accent`.
2. **Remove `subtle` and `deep` presets**: These are no longer convenience presets. Update all references to use semantic tokens or the inline formula.
3. **Adjust `light` and `dark` i/t**: `light` → i=20, t=85. `dark` → i=50, t=20. Rewrite their formulas.
4. **Rewrite preset formulas**: Replace all coefficient-based and `min()`-based formulas with `calc()`+`clamp()` using literal i/t numbers. 120 convenience preset variables (24 hues × 5 presets) replace the previous 168.
5. **Remove coefficient knobs**: Eliminate `--tug-preset-*-l` and `--tug-preset-*-c` custom properties entirely. Convenience presets use literal numbers in their formulas, not CSS custom property references.
6. **Update neutral ramp**: Reduce from 7 to 5 neutral presets matching the chromatic convenience preset names.
7. **Rewrite theme files**: This is the substantive design work. Each theme's chromatic `--tug-base-*` tokens are rewritten to use the inline TugColor formula with theme-specific i/t choices. Brio may reference convenience presets where they match; Bluenote and Harmony will use custom i/t numbers for their distinct visual identities.
8. **Update `palette-engine.ts`**: Rewrite `TUG_COLOR_PRESETS` to the five-preset set. Rewrite `tugColor()` to use the `clamp()`-based piecewise formula.
9. **Full consumer audit**: Search all component CSS, TypeScript, and test files for references to old preset names (`-accent` as palette preset, `-subtle`, `-deep`). Fix every reference. No breakage allowed.
10. **Gallery editor enhancement**: Add interactive i/t explorer — pick any hue, drag across the full 100×100 space, see the resulting color in real time. Show the five convenience presets as labeled reference points. Add theme token export (generate CSS formula snippet for a chosen i/t).
11. **Strip historical comments**: Remove all phase numbers, "replaced X", "introduced in Y" comments.
12. **Verify**: All three themes render correctly. All tests pass. No old preset names remain.

**Files created/modified**:
1. `tugdeck/styles/tug-palette.css` — rewritten: five convenience presets with literal i/t, neutral ramp
2. `tugdeck/styles/tug-tokens.css` — modified: chromatic token references updated
3. `tugdeck/styles/bluenote.css` — rewritten: chromatic semantic tokens use inline TugColor formulas
4. `tugdeck/styles/harmony.css` — rewritten: chromatic semantic tokens use inline TugColor formulas
5. `tugdeck/src/components/tugways/palette-engine.ts` — modified: `TUG_COLOR_PRESETS`, `tugColor()` formula
6. `tugdeck/src/components/tugways/cards/gallery-palette-content.tsx` — modified: i/t explorer, preset reference overlay, theme token export
7. All component CSS and TS files referencing old preset names — modified

**Result**: The palette is a continuous color space, not a fixed set of presets. Five convenience presets per hue serve as stable reference colors. Themes express their chromatic identity through inline TugColor formulas in semantic token definitions — the design intent (hue, i, t) is explicit in every theme file. The gallery editor supports interactive color exploration for the theme design workflow. All consumers updated, no breakage.

**Note**: Phase 5g depends on Phase 5d5e (palette engine integration — the pure CSS palette and semantic token wiring must already be in place). It does not depend on Phase 5f (state preservation).

### Phase 5g2: TugColor PostCSS Plugin and Theme Conversion (Concept 22, [D80])

**Goal**: Ship a PostCSS plugin that expands `--tug-color(hue, i, t)` notation to concrete `oklch()` values at build time, add an `oklchToTugColor()` reverse mapper to palette-engine.ts, and convert all hardcoded hex tokens in theme files to `--tug-color()` calls. This makes the color system fully parametric: every color in every theme is described by hue family, intensity, and tone.

**Full specification**: `.tugtool/tugplan-tugways-phase-5g2-tug-color-postcss.md` contains the complete plan with 8 execution steps, design decisions, specs, and test plan.

**Key design shift**: Theme files move from hardcoded hex values to `--tug-color()` notation. The verbose `calc()`+`clamp()` formula [D70] remains for cases needing runtime CSS variable resolution (P3 overrides), but the compact `--tug-color()` syntax handles the hundreds of achromatic tokens (surfaces, grays, borders, text) that were previously hardcoded hex. Build-time expansion means zero runtime cost.

**What to do**:
1. **Add `oklchToTugColor()` and `tugColorPretty()`** to palette-engine.ts — reverse maps oklch strings to TugColor parameters; enables programmatic hex-to-TugColor derivation and developer tooling.
2. **Create PostCSS plugin** (`postcss-tug-color.ts`) — bespoke AST walker that expands `--tug-color()` in CSS declaration values. Supports named hues and raw numeric angles. Uses same math as `tugColor()`.
3. **Wire plugin into Vite** — inline `css.postcss.plugins` config in vite.config.ts, coexisting with `@tailwindcss/vite`.
4. **Build conversion script** (`scripts/convert-hex-to-tug-color.ts`) — one-time tool that uses `postcss.parse()` to walk CSS ASTs, convert standalone hex values to `--tug-color()` calls via `oklchToTugColor()`, and validate round-trip accuracy.
5. **Convert tug-tokens.css** — replace all standalone hex values in body{} block with `--tug-color()` calls. Cobalt/violet tint, i 3-6 range.
6. **Convert bluenote.css** — replace all standalone hex values in body{} block. Blue tint, i 5-14 range.
7. **Convert harmony.css** — replace all standalone hex values in body{} block, including contrast-critical overrides. Yellow/gold tint for surfaces, blue tint for text. `#ffffff` → `var(--tug-white)`.
8. **Integration checkpoint** — verify all themes work together, no hex regression, full test suite passes.

**Files created/modified**:
- `tugdeck/postcss-tug-color.ts` — new: PostCSS plugin
- `tugdeck/scripts/convert-hex-to-tug-color.ts` — new: one-time conversion script
- `tugdeck/src/__tests__/postcss-tug-color.test.ts` — new: plugin tests
- `tugdeck/src/__tests__/convert-hex-to-tug-color.test.ts` — new: conversion tests
- `tugdeck/src/components/tugways/palette-engine.ts` — modified: `oklchToTugColor()`, `tugColorPretty()`
- `tugdeck/vite.config.ts` — modified: PostCSS plugin wiring
- `tugdeck/styles/tug-tokens.css` — modified: hex → `--tug-color()`
- `tugdeck/styles/bluenote.css` — modified: hex → `--tug-color()`
- `tugdeck/styles/harmony.css` — modified: hex → `--tug-color()`

**Result**: Zero standalone hex color values remain in theme file body{} blocks. Every color is expressed as `--tug-color(hue, i, t)` — the design intent is explicit and machine-readable. The PostCSS plugin expands these to `oklch()` at build time with zero runtime cost. `tug-palette.css` and `brio.css` are completely unmodified.

**Note**: Phase 5g2 depends on Phase 5g (palette refinements — the five-preset system, renamed presets, and `tugColor()` with piecewise formula must already be in place). The PostCSS plugin reuses the same constants and math from palette-engine.ts.

### Phase 6: Feed Abstraction (Concept 7)

**Goal**: Cards receive typed, accumulated data from backend feeds.

**What to do**:
1. Implement `useFeedBuffer` (ring buffer for append-stream feeds like terminal output) ([D20])
2. Implement `useFeedStore` (indexed store for snapshot feeds like git status)
3. Wire connection frame callbacks to feed distribution
4. Interface-first: define TypeScript types for each feed's payload ([D21])
5. Test with a simple card that displays live feed data

**Result**: Feed data flows from backend → connection → feed hooks → card content. No more `onFrame` method on cards.

### Phase 7: Motion + Startup Continuity (Concept 8, [D23]-[D24], [D76])

**Goal**: Establish the complete motion foundation for tugways — a programmatic animation engine with completion handlers, cancellation, spring/physics dynamics, and coordinated multi-element animations. Migrate all existing `@keyframes` and `requestAnimationFrame` animations to TugAnimator. Implement skeleton loading states and startup continuity.

Phase 7 is split into three sub-phases.

**Motion architecture**: CSS `transition` declarations remain for declarative hover/focus states (compositor-accelerated, zero-JS). Everything programmatic goes through TugAnimator, which wraps the Web Animations API (WAAPI).

#### Phase 7a: TugAnimator Engine

**Goal**: Build the programmatic animation engine that all motion in tugways depends on.

**What to do**:
1. Create `tug-animator.ts` — WAAPI wrapper with core animation API
   - `animate(el, keyframes, options)` → returns `TugAnimation` with `.finished` promise
   - Named animation slots per element (key-based, like `CALayer.add(_:forKey:)`) — new animation with same key cancels previous
   - Cancellation modes: snap-to-end, hold-at-current, reverse-from-current
   - Additive composition via WAAPI's `composite: 'add'`
2. Animation groups with coordinated completion (UIView.animate model)
   - `group(options)` → returns `TugAnimationGroup`
   - `group.animate(el, keyframes)` adds element to group
   - `await group.finished` resolves when all animations complete
3. Physics solvers — pre-compute curves into WAAPI keyframes
   - Spring: damped harmonic oscillator (mass, stiffness, damping, initial velocity), velocity matching on interruption
   - Gravity + bounce: constant acceleration with coefficient of restitution
   - Friction / deceleration: exponential decay
4. Token awareness — read `--tug-timing` to scale durations, respect `--tug-motion` toggle
5. Reduced-motion awareness — spatial animations replaced with opacity fades when motion disabled
6. Unit tests: completion promises resolve, cancellation modes work, spring curves are correct, additive composition layers properly, groups coordinate, token scaling applies

**Files created**:
1. `tugdeck/src/components/tugways/tug-animator.ts` — animation engine
2. `tugdeck/src/components/tugways/physics.ts` — spring, gravity, friction solvers

**Result**: TugAnimator is the single programmatic animation engine for tugways. Completion handlers, cancellation, spring physics, and coordinated groups all work. No existing code is migrated yet — this phase establishes the foundation only.

#### Phase 7b: Managed Animations + Skeleton Loading

**Goal**: Migrate programmatic animations to TugAnimator (per Rule 13: only animations needing completion promises, cancellation, or coordination). CSS-only animations stay as CSS. Implement skeleton loading states.

**What to do**:
1. Migrate programmatic `@keyframes` animations to TugAnimator:
   - Flash overlay (`set-flash-fade` in chrome.css) → TugAnimator with completion-based cleanup (replaces `animationend` listener)
   - Dropdown blink (`tug-dropdown-blink`) → TugAnimator
   - Button spinner (`tug-button-spin`) → TugAnimator
2. Keep CSS-only animations as CSS `@keyframes` (Rule 13 — no completion/cancellation needed):
   - Gallery petals/pole animations — continuous, infinite, already respect `--tug-timing`
   - Skeleton shimmer — continuous, synchronized via `background-attachment: fixed`
   - All Radix-managed enter/exit — Radix Presence depends on `animationend` (Rule 14)
3. Keep `requestAnimationFrame` loops as-is (Rule 13 — gesture-driven, not animations):
   - `card-frame.tsx` drag/resize loops
   - `selection-guard.ts` autoscroll
   - `tab-drag-coordinator.ts` drag feedback
   - `tug-tab-bar.tsx` overflow detection
4. Implement skeleton shimmer via CSS `@keyframes` with `background-attachment: fixed` for synchronized shimmer across all skeleton elements
5. Implement per-card skeleton shapes — each card type defines its own skeleton structure
6. Implement skeleton → content crossfade via TugAnimator completion promise (skeleton fades out, content fades in, skeleton removed from DOM on completion)
7. Verify: migrated animations work identically, skeleton shimmer is synchronized, skeleton → content transition is smooth

**Files created/modified**:
1. `tugdeck/styles/chrome.css` — remove `@keyframes set-flash-fade`, add `@keyframes td-shimmer`
2. `tugdeck/src/components/tugways/tug-button.css` — remove `@keyframes tug-button-spin`
3. `tugdeck/src/components/tugways/tug-dropdown.css` — remove `@keyframes tug-dropdown-blink`
4. `tugdeck/src/components/tugways/tugcard.tsx` — skeleton mounting and crossfade logic
5. Per-card skeleton components as needed

**Result**: Clear animation boundary enforced. Programmatic animations (needing completion/cancellation) use TugAnimator. CSS-only animations (continuous, Radix enter/exit) stay as `@keyframes`. Gesture-driven rAF loops are unchanged. Skeleton loading states work for all card types.

#### Phase 7c: Startup Continuity

**Goal**: No visual flash on reload. Clean startup sequence.

**What to do**:
1. Layer A — Inline body styles in `index.html` (background matches Brio theme, eliminates white flash during HTML parse)
2. Layer B — Startup overlay div (covers viewport during mount, fades out via TugAnimator triggered by `useLayoutEffect` in DeckCanvas — the `onContentReady` pattern at viewport scope, per Rules 11–12 and [D79])
3. Layer C — CSS HMR boundary module (`css-imports.ts` with `import.meta.hot.accept()`, prevents CSS changes from triggering full page reload in dev mode)
4. Verify: CSS edit → no flash. Browser reload → no flash. Backend restart → no flash.

**Files created/modified**:
1. `tugdeck/index.html` — inline body styles, startup overlay div
2. `tugdeck/src/css-imports.ts` — CSS HMR boundary module
3. `tugdeck/src/components/chrome/deck-canvas.tsx` — `useLayoutEffect` triggers TugAnimator overlay fade-out on first mount

**Result**: Startup is seamless. The user never sees a blank or flashing viewport. Overlay fade-out uses TugAnimator for consistency (completion-based cleanup).

#### Phase 7d: Glitch Reduction (depends on 7c)

**Goal**: Eliminate the CSS-edit flash caused by `@tailwindcss/vite`'s forced full-reload behavior by stripping Tailwind from the codebase entirely and adding a reload continuity overlay for all Vite-initiated reloads.

**What to do**:
1. **Strip Tailwind**: remove `@tailwindcss/vite` and `tailwindcss` from `package.json`, remove `tailwindcss()` plugin from `vite.config.ts`, remove `@import "tailwindcss"` and the `@theme` bridge block from `globals.css`
2. **Create `shadcn-base.css`**: new stylesheet in `tugdeck/styles/` with a minimal CSS reset, `.sr-only` utility, animation keyframes (`shadcn-fade-in/out`, `shadcn-zoom-in/out`, `shadcn-slide-in/out`) per Spec S03, and semantic CSS class definitions for all 13 shadcn components — replacing every Tailwind utility string
3. **Convert 13 shadcn components**: replace all Tailwind utility class strings in `components/ui/*.tsx` with single semantic class names (e.g., `.shadcn-dialog-content`, `.shadcn-button--default`) and define those classes in `shadcn-base.css` using `--tug-base-*` tokens directly
4. **Simplify `cn()`**: change `lib/utils.ts` from `twMerge(clsx(...))` to `clsx(...)` and remove `tailwind-merge` from dependencies — no longer needed with no Tailwind utilities in the codebase
5. **Add reload continuity overlay**: register `import.meta.hot.on('vite:beforeFullReload', ...)` in `css-imports.ts` — paints a `#16171a` fixed overlay synchronously before `location.reload()` fires, creating seamless dark-to-dark continuity for Vite-initiated reloads

**Future-phase guidance**: Do not install new shadcn components in Phases 8b–8e or later. The shadcn CLI approach brings Tailwind utility strings that would need another stripping pass. Instead, wrap Radix primitives directly (as `components/ui/*.tsx` files did before shadcn was added) and style them with `--tug-base-*` tokens in the relevant CSS file from the start.

**Result**: CSS edits in dev mode produce no visible flash. The `@tailwindcss/vite` plugin (which forced full-reload on every CSS change, bypassing HMR boundaries) is gone. The CSS bundle is ~15 kB smaller. All 13 shadcn components are styled with plain CSS using the existing design token system.

**Post-completion note**: This phase's shadcn infrastructure (`shadcn-base.css`, `components/ui/*.tsx`) is superseded by Phase 8a, which removes shadcn entirely. All Tug components now wrap Radix primitives directly.

**Note**: Phase 7a is pure TypeScript infrastructure. Phase 7b migrates only programmatic animations to TugAnimator and adds skeletons — CSS-only animations and rAF loops are untouched (Rules 13–14). Phase 7c is the smallest phase — mostly HTML and module wiring. Phase 7d is an internal refactoring only — no component public APIs changed.

### Phase 8: Radix Foundation, Control State Visual Identity & Chrome

**See `.tugtool/tugplan-tugways-phase-8-radix-redesign.md` for the complete Phase 8 plan.**

Phase 8 replaces shadcn with direct Radix primitives, defines a token-driven control state visual language (every control property — bg, fg, border, icon — responds independently to rest/hover/active states), builds the component library, and completes the chrome layer (title bar, alerts, inspectors, dock).

Nine sub-phases:
- **8a**: Shadcn Excision
- **8b**: Control State Visual Language (token-driven states, retronow-inspired aesthetic)
- **8c**: Card Frame & Title Bar
- **8d**: Form Controls & Core Display (one component at a time, interactively tuned)
- **8e**: Navigation, Data Display & Visualization
- **8f**: Compound Components & Gallery Completion
- **8g**: Alerts
- **8h**: Inspector Panels
- **8i**: Dock

### Phase 9: Card Rebuild

**Goal**: All card content rebuilt on new infrastructure.

**What to do** (one card at a time):
1. **Terminal card** — rebuild on Tugcard + useFeedBuffer. xterm.js integration. Most complex, proves feed streaming works.
2. **Code/Conversation card** — rebuild on Tugcard + useFeedStore. Revive code-block, message-renderer, etc. from deleted files.
3. **Git card** — rebuild on Tugcard + useFeedStore. Snapshot feed.
4. **Files card** — rebuild on Tugcard + useFeedStore. Snapshot feed.
5. **Stats card** — rebuild on Tugcard + useFeedBuffer/Store. Multiple feeds.
6. **Settings card** — rebuild on Tugcard. Uses theme provider.
7. **Developer card** — rebuild on Tugcard. Dev-mode features.
8. **About card** — rebuild on Tugcard. Static content.

**Design reference**: Retronow's card frame, header, and canvas patterns (`RetronowDeckCanvas.tsx`, `retronow-deck.css`, `retronow-classes.ts`) are the visual models for card chrome and layout. See [Retronow Design Reference](#retronow-design-reference).

Each rebuilt card can optionally expose a `PropertyStore` via `usePropertyStore` ([D67]) for inspector integration. Cards that expose inspectable properties (style, layout, content settings) get free inspector panel support without any inspector-specific code.

**Result**: Full app restored with new infrastructure. Every card uses Tugcard composition, feed hooks, responder chain, and the three-zone mutation model. Cards with PropertyStore registrations are automatically inspectable.

## Phase Dependencies

```
Phase 0: Demolition
    │
    ▼
Phase 1: Theme Foundation ──────────────────────────────────┐
    │                                                        │
    ▼                                                        │
Phase 2: First Component + Gallery                           │
    │                                                        │
    ├────────────────┐                                       │
    ▼                ▼                                       │
Phase 3:         Phase 4:                                    │
Responder Chain  Mutation Model                              │
    │                │                                       │
    └────────┬───────┘                                       │
             ▼                                               │
         Phase 5: Tugcard Base                               │
             │                                               │
             ▼                                               │
         Phase 5a: Selection Model                           │
             │                                               │
             ▼                                               │
         Phase 5a2: DeckManager Store Migration              │
             │                                               │
             ├──────────┬──────────┬──────────┬──────┐       │
             ▼          ▼          ▼          ▼      ▼       ▼
         Phase 5b:  Phase 5c:  Phase 5d1: Phase 6:  Phase 7:
         Card Tabs  Card Snap  Default    Feed Abs. Motion
                        │      Button               ◄── (tokens from Phase 1)
                        ▼          │
                    Phase 5c2:  Phase 5d2:
                    Snap Set    Control Action
                    Refinements Foundation
                                   │
                                Phase 5d3:
                                Mutation
                                Transactions
                                   │
                                Phase 5d4:
                                Observable
                                Properties
             │                    │
             ├────────┐            │
             ▼        ▼            ▼
         Phase 5b2: Phase 5b3: Phase 8: ◄─── (5d1 + 5d2–5d4)
         Tab Drag   Gallery    Radix Foundation,
         Gestures   Card       Control State Visual Identity
             │        │        & Chrome
             ├────────┤        (see redesign doc:
             ▼        │         8a–8i)
         Phase 5b4:   │           │
         Tab          │           │
         Overflow     │           │
             │        │           │
         Phase 5b5:   │           │
         Tab          │           │
         Refinements  │           │         │       │
             │        │           │         │       │
             │     Phase 5e: ◄────┤         │       │
             │     Tugbank        │         │       │
             │        │           │         │       │
             │     Phase 5f: ◄─── (5b + 5e) │       │
             │     State                    │       │
             │     Preservation             │       │
             │        │                     │       │
             └────────┴─────────────────┬───┴───────┘
                                        ▼
                          Phase 9: Card Rebuild

    Theme Token Overhaul (can run in parallel with 5b–8e):

         Phase 5d5a: ◄─── (5a2)    Phase 5d5b: ◄─── (5a2)
         Palette Engine ✓          Scale & Timing ✓
             │                          │
             └────────────┬─────────────┘
                          ▼
                  Phase 5d5c: ◄─── (5d5a + 5d5b) ✓
                  Token Architecture
                          │
                          ▼
                  Phase 5d5d: ◄─── (5d5c) ✓
                  Consumer Migration
                          │
                          ▼
                  Phase 5d5e: ◄─── (5d5d)
                  Palette Engine Integration
                          │
                          ▼
                  Phase 5d5f: ◄─── (5d5e, benefits from 5d3 + 5d4)
                  Cascade Inspector
```

Phases 3 and 4 can run in parallel. Phase 5a (Selection Model) depends on Phase 5 and
should be completed before Phase 5a2 and all subsequent phases — card content in all
subsequent phases needs correct selection behavior from the start. Phase 5a2 (DeckManager
Store Migration) depends on Phase 5a and must complete before Phases 5b, 5c, 5d1, 6, 7,
and 8a — all subsequent phases inherit the deterministic event flow guarantees established
by the store migration. Phases 5b, 5c, 5d1, 6, and 7 can all start as soon as Phase 5a2
completes (Phase 7 also needs Phase 1's motion tokens). Phase 5d1 (Default Button) adds
`setDefaultButton`/`clearDefaultButton` to the responder chain and wires Enter at stage 2
of the key pipeline — a prerequisite for Phase 8g's alert, sheet, and popover components,
which register their default buttons on mount. Phase 8 (Radix Foundation, Control State Visual Identity & Chrome)
depends on Phase 5d1 for the default button mechanism and Phases 5d2–5d4 for action phases, mutation transactions, and PropertyStore. See `dash/tugways-phase-8-radix-redesign.md` for the complete Phase 8 plan (sub-phases 8a–8i). Phase 9
(Card Rebuild) is the true convergence point: rebuilt cards need feeds (Phase 6) for data,
motion (Phase 7) for skeleton/transitions, chrome (Phase 8) for title bar and dock, and
the component library (Phase 8) for form controls, data display, visualization, and inspectors.
Phases 5b, 5b2, 5b3, 5b4, 5b5, 5c, 5c2, and 5d1–5d4 are enhancements that can land before, during, or after Phase 9.
Phase 5c2 (Card Snap Set Refinements) depends on Phase 5c (snap and set-move must exist). It adds set visual identity: corner rounding, perimeter flash, border collapse, and break-out restoration.
Phase 5b2 (Tab Drag Gestures) depends on Phase 5b (tab bar component and tab state must exist).
Phase 5b3 (Gallery Card) depends on Phase 5b (tab system must exist). It does not depend on Phase 5b2.
Phase 5b4 (Tab Overflow) depends on Phase 5b (tab bar must exist). It does not depend on Phase 5b2 or 5b3, though both benefit from overflow handling.
Phase 5b5 (Tab Refinements) depends on Phase 5b2 (drag coordinator and hit-test infrastructure must exist). It is a collection phase — additional items may be added during 5b3/5b4 implementation.
Phase 5d2 (Control Action Foundation) depends on Phase 5a2 (responder chain infrastructure must be stable). It does not depend on Phase 5d1 — the two are independent extensions to the responder chain.
Phase 5d3 (Mutation Transactions) depends on Phase 5d2 (action phases drive transaction lifecycle) and Phase 4 (mutation model hooks for appearance-zone operations).
Phase 5d4 (Observable Properties) depends on Phase 5d2 (explicit-target dispatch) and Phase 5d3 (mutation transactions for live preview). It is the capstone of the 5d sub-phases.
Phase 5e (Tugbank) can start anytime after Phase 5a2 — it is primarily Rust/backend work with a small `settings-api.ts` update. It does not depend on any frontend phase beyond the basic infrastructure.
Phase 5f (State Preservation) depends on Phase 5e (tugbank must exist for durable storage) and Phase 5b (tabs must exist for per-tab state lifecycle). It does not block Phase 9, but Phase 9 cards benefit from the `useTugcardPersistence` hook.
Phase 5f4 (State Preservation Solidified) depends on Phase 5f3 (content-first restore ordering and save-on-close must exist). It replaces the double-RAF timing bet with a deterministic child-driven ready callback (`onContentReady`). The `onContentReady` pattern is forward-compatible with Monaco editor and terminal buffer persistence in Phase 9. Rules of Tugways 11 [D78] and 12 [D79] are established here.
Phase 8h (Inspector Panels) depends on Phases 5d2–5d4 (action phases, mutation transactions, PropertyStore) and Phase 8d (form controls). It does not block Phase 9, but Phase 9 cards benefit from PropertyStore support for inspector integration.
Phase 5d5a (Palette Engine → TugColor Runtime) is complete. It shipped a standalone TugColor palette engine with no coupling to the responder chain, mutation model, or property store.
Phase 5d5b (Global Scale & Timing) is complete. CSS `zoom` on `<body>` scales the entire UI with one number.
Phase 5d5c (Token Architecture) is complete. Introduced the full `--tug-base-*` and `--tug-<component>-*` taxonomy with backward-compatibility aliases. Chromatic tokens used hardcoded hex values — palette integration was deferred.
Phase 5d5d (Consumer Migration) is complete (PR #98). All consumers migrated from `--td-*`/`--tways-*` to `--tug-base-*`/`--tug-<component>-*`. Legacy aliases removed. CI enforcement added.
Phase 5d5e (Palette Engine Integration) depends on Phase 5d5d (consumers must already reference `--tug-base-*`). This is the critical missing step — it wires `--tug-base-*` chromatic tokens to `var(--tug-{hue}[-preset])` palette variables, converts the palette to pure CSS formulas (no JS injection), and adds the neutral ramp. This connects the TugColor palette engine to the consumer-facing tokens.
Phase 5d5f (Cascade Inspector) depends on Phase 5d5e (palette integration must be complete so the inspector shows the full resolution chain). It benefits from Phase 5d3 (StyleCascadeReader) and Phase 5d4 (PropertyStore) but can function without them.
The 5d5 sub-phases are an enhancement track that can run in parallel with Phases 5b–8e. They do not block Phase 9. Phase 5d5e (Palette Engine Integration) should ideally complete before Phase 9 begins, so rebuilt cards use palette-derived colors from the start.

## Estimated Scope

| Phase | New/Modified Files | Rough Size |
|-------|-------------------|------------|
| 0 | -40 files deleted, 3 gutted | Net reduction: ~8000 lines |
| 1 | ~5 files | ~300 lines |
| 2 | ~3 files | ~400 lines |
| 3 | ~4 files | ~500 lines |
| 4 | ~3 files | ~200 lines |
| 5 | ~8 files | ~1200 lines |
| 5a | ~5 files | ~400 lines |
| 5a2 | ~4 files | ~200 lines |
| 5b | ~4 files | ~400 lines |
| 5b2 | ~3 files | ~300 lines |
| 5b3 | ~5 files | ~400 lines |
| 5b4 | ~3 files | ~300 lines |
| 5b5 | ~2 files | ~100 lines |
| 5c | ~1 file | ~50 lines |
| 5c2 | ~3 files | ~200 lines |
| 5d1 | ~3 files | ~150 lines |
| 5d2 | ~3 files | ~200 lines |
| 5d3 | ~3 files | ~300 lines |
| 5d4 | ~4 files | ~400 lines |
| 5d5a | ~3 files | ~400 lines |
| 5d5b | ~4 files | ~300 lines |
| 5d5c | ~5 files | ~600 lines |
| 5d5d | ~20 files | ~500 lines (net change, mostly renames) |
| 5d5e | ~8 files | ~500 lines |
| 5d5f | ~3 files | ~400 lines |
| 5e | ~10 files | ~1500 lines |
| 5f | ~6 files | ~500 lines |
| 6 | ~4 files | ~400 lines |
| 7a | ~2 files | ~500 lines |
| 7b | ~8 files | ~400 lines |
| 7c | ~3 files | ~100 lines |
| 8 (8a–8i) | See `dash/tugways-phase-8-radix-redesign.md` | ~4300 lines |
| 9 | ~20 files | ~3000 lines |

**Total rebuild: ~18,700 lines** replacing the current ~9700 lines. The new
codebase is larger because the component library (Phase 8, sub-phases 8a–8i) adds ~4300
lines of reusable UI primitives and chrome, the control action/transaction/property
infrastructure (Phases 5d2–5d4) adds ~900 lines, tugbank (Phase 5e) adds ~1500 lines of Rust infrastructure
for typed persistence, and the theme token overhaul (Phases 5d5a–5d5f) adds
~2200 lines of palette engine, scaled/timed tokens, semantic taxonomy, and
cascade inspector. The triple-registration redundancy is gone, the adapter
layer is gone, and the component abstractions do more with less code.

## How This Drives Tugplan Creation

Each phase becomes one tugplan. The phases are designed to be:

- **Self-contained**: each phase has a clear deliverable and can be verified independently
- **Testable**: each phase produces something visible (empty canvas, gallery component, working card)
- **Ordered but parallelizable**: phases 3+4 can overlap, phase 7 can start early
- **Right-sized**: each phase is 200–1200 lines of new code, which fits well in a single plan

The suggested plan sequence:

1. `tugways-phase-0-demolition` — tear down, verify empty canvas
2. `tugways-phase-1-theme` — tokens, theme loading, directory structure
3. `tugways-phase-2-first-component` — TugButton + gallery
4. `tugways-phase-3-responder-chain` — event routing
5. `tugways-phase-4-mutation-model` — DOM hooks, three-zone discipline
6. `tugways-phase-5-tugcard` — card base component, new DeckManager
7. `tugways-phase-5a-selection-model` — selection containment, SelectionGuard, developer API
8. `tugways-phase-5a2-deckmanager-store` — subscribable store, eliminate root.render() calls, useLayoutEffect registration
9. `tugways-phase-5b-card-tabs` — tab bar, icons, type picker, tab switching, active/inactive states
10. `tugways-phase-5b2-tab-drag-gestures` — reorder, detach to new card, merge into existing card
11. `tugways-phase-5b3-gallery-card` — convert Component Gallery to a proper tabbed card
12. `tugways-phase-5b4-tab-overflow` — progressive tab collapse: icon-only, then overflow dropdown
13. `tugways-phase-5b5-tab-refinements` — card-as-tab merge, additional refinements
14. `tugways-phase-5c-card-snapping` — modifier-gated snap, Option+drag to form sets, `Geometric engine` section features used
15. `tugways-phase-5c2-card-snapping-refinements` — set corner rounding, outer-hull perimeter flash, break-out restoration, border collapse
16. `tugways-phase-5d1-default-button` — Enter key routing, default button registration, primary variant as default button visual
17. `tugways-phase-5d2-control-action` — ActionEvent with payloads/phases, explicit-target dispatch, control/responder separation
18. `tugways-phase-5d3-mutation-transactions` — snapshot/preview/commit/cancel, StyleCascadeReader, vertical-slice gallery demo
19. `tugways-phase-5d4-observable-properties` — PropertyStore, usePropertyStore hook, inspector demo
20. `tugways-phase-5d5a-palette-engine` — TugColor OKLCH palette engine, 24 hues with Hue/Intensity/Tone axes, 7 presets, P3 support, interactive gallery editor
21. `tugways-phase-5d5b-scale-timing` — global scale, global timing, motion toggle, per-component scale, JS helpers
22. `tugways-phase-5d5c-token-architecture` — `--tug-base-*` and `--tug-<component>-*` layers, full semantic taxonomy, backward-compatibility aliases
23. `tugways-phase-5d5d-consumer-migration` — migrate all CSS/TS from `--td-*`/`--tways-*`, remove legacy aliases, enforcement
24. `tugways-phase-5d5e-palette-engine-integration` — pure CSS palette formulas, wire `--tug-base-*` to TugColor palette, neutral ramp, remove JS injection
25. `tugways-phase-5d5f-cascade-inspector` — dev-mode Ctrl+Option hover, token chain resolution, palette provenance
26. `tugways-phase-5e1-tugbank-core` — `tugbank-core` library crate (schema, value, domain, store, CAS, blob limit)
27. `tugways-phase-5e2-tugbank-cli` — `tugbank` CLI binary (defaults-like CLI, `~/.tugbank.db` default path)
28. `tugways-phase-5e3-tugbank-bridge` — tugcast HTTP bridge integration (REST endpoints for defaults)
29. `tugways-phase-5e4-tugbank-migration` — settings migration (flat file → tugbank, frontend endpoint update)
30. `tugways-phase-5f-state-preservation` — per-tab state bags, scroll/selection persistence, collapse field, focused card, useTugcardPersistence hook
31. `tugways-phase-5f2-state-preservation-fixes` — RAF-deferred scroll/selection restore, CSS Custom Highlight API for inactive selections, flash suppression
32. `tugways-phase-5f3-state-preservation-more-fixes` — restore ordering (content first), save-on-close (visibilitychange/beforeunload), click-back selection restore
33. `tugways-phase-5f4-state-preservation-solidified` — child-driven ready callback (onContentReady), eliminate double-RAF, Rules of Tugways 11 & 12
34. `tugways-phase-5g-palette-refinements` — continuous color space with 5 convenience presets, inline TugColor formulas in theme files, gallery i/t explorer
35. `tugways-phase-5g2-tug-color-postcss` — PostCSS `--tug-color()` plugin, `oklchToTugColor()` reverse mapper, convert all theme hex tokens to `--tug-color()` notation
36. `tugways-phase-6-feed` — feed hooks, data flow
37. `tugways-phase-7a-tug-animator` — TugAnimator engine (WAAPI wrapper, completion, cancellation, springs, physics, groups)
38. `tugways-phase-7b-managed-animations` — migrate programmatic @keyframes to TugAnimator (CSS-only and rAF stay), skeleton loading states
39. `tugways-phase-7c-startup-continuity` — three-layer flash elimination (inline body, overlay, HMR boundary)
40. `tugways-phase-8` — see `dash/tugways-phase-8-radix-redesign.md` for the complete plan (sub-phases 8a–8i: shadcn excision, control state visual language, card frame & title bar, form controls, navigation & data display, compound components, alerts, inspector panels, dock)
41. `tugways-phase-9a-terminal` through `tugways-phase-9h-about` — one plan per card; each card can expose PropertyStore for inspector support

## Resolved Questions

1. **Conversation card sub-components**: The code-block renderer, message
   renderer, approval prompt, etc. are real work (~800 lines). **Archive in
   `_archive/`** during demolition for easy revival.

2. **Backend changes**: None needed. The feed abstraction (concept 7) is
   entirely a frontend refactor. The binary wire protocol (`[FeedId][length]
   [Uint8Array]`) stays as-is. Concept 7's TypeScript interfaces are frontend
   decode targets — they describe the shape of data after the frontend decodes
   the bytes it already receives. The `decode` function on each Tugcard converts
   `Uint8Array` → typed object, same as today's ad-hoc parsing, just
   standardized. The only new backend work is the optional `FeedId.TUG_FEED`
   (`0x50`) for the tug-feed progress stream — a new feature, not a change to
   existing feeds, and explicitly designed to come later per [D21].

3. **Incremental usability**: Mac menu commands are acceptable until the dock
   is built (Phase 8i). Phase 8 can start right after Phase 5 — it doesn't
   need to wait for feeds, motion, tabs, or snapping.

4. **Test strategy**: Per-phase. Write tests for each new component as it's
   built, not as a batch sweep at the end.

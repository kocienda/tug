# Deck & Card Fit and Finish

A collection of improvements to bring polish to the deck canvas, card chrome, and Tug.app host.

---

## 1. Startup Spinner with Tug Logo

**Problem:** While Tug.app launches and the web engine loads, the user sees an empty canvas with the correct background color but no activity indicator. The `frontendReady` gate (MainWindow.swift) keeps the WebView hidden until the deck is fully loaded, so this is purely dead time from the user's perspective.

**Approach:** Add a native SwiftUI or AppKit spinner view to MainWindow that displays the Tug logo with a rotation animation. This view sits in the window's content view *behind* the WebView and is visible from launch until `revealWebView()` fires.

**Details:**
- Add a `SpinnerView` (NSView subclass or SwiftUI hosting view) that renders the Tug logo asset with a continuous rotation animation (e.g., `CABasicAnimation` on `transform.rotation`).
- Insert `SpinnerView` into `MainWindow.contentView` at init, behind (lower z-order than) the WebView.
- In `revealWebView()`, after the WebView opacity animation completes, remove/hide the spinner and release its resources.
- The spinner inherits the window's background color, so theme continuity is maintained.
- Consider a subtle fade-out on the spinner concurrent with the WebView fade-in for a smooth handoff.

**Scope:** Swift only (`tugapp/Sources/MainWindow.swift`, new `SpinnerView.swift`). No tugdeck changes.

---

## 2. Card Min/Max/Preferred Sizes

**Problem:** Card sizing is currently governed by a single hardcoded default (400x300) in DeckManager and a per-card minimum (150x100 frame, 100x60 content) reported via `onMinSizeChange`. There is no concept of maximum size or preferred size, and no API for card content to declare its own sizing preferences.

**Approach:** Introduce a `CardSizePolicy` structure that each card type can declare, and wire it through DeckManager and CardFrame for enforcement.

**Details:**

### Data model
```ts
interface CardSizePolicy {
  min:       { width: number; height: number };  // hard floor for resize
  max?:      { width: number; height: number };  // hard ceiling for resize (null = unbounded)
  preferred: { width: number; height: number };  // size for new cards with no saved state
}
```

### Declaration
- Each card component (Tide, Git, Settings, Gallery, Hello) exports a static `sizePolicy` on its factory or registration entry in the card registry.
- Sensible defaults: `min: 250x180`, `max: null`, `preferred: 400x300` (matching current behavior). Individual card types override as needed (e.g., Settings card might have a smaller preferred and a max).

### Enforcement
- **DeckManager.addCard():** When creating a new card with no persisted size, use `sizePolicy.preferred` instead of the current `DEFAULT_CARD_WIDTH/HEIGHT` constants.
- **CardFrame resize clamping:** Currently clamps to `minSizeRef.current`. Extend to also clamp to `max` (when present) on both width and height.
- **Canvas clamping:** If `max` is set, ensure the card never exceeds it even when the canvas resizes.

### API
- `DeckManager.getCardSizePolicy(cardId)` — returns the resolved policy for a card.
- `DeckManager.setCardSize(cardId, { width, height })` — sets size, clamping to policy bounds. Usable from control-frame actions or from card content.
- These are also exposed to card content via the existing card bridge/context so that a card's own UI can trigger resize-to-preferred or resize-to-fit.

**Scope:** tugdeck (`deck-manager.ts`, `card-frame.tsx`, card registry, individual card components).

---

## 3. Relaxed Card Placement (Finder-Style Window Constraining)

**Problem:** Cards are currently hard-clamped to the canvas bounds with a 2px padding (`CANVAS_PADDING`). A card cannot be dragged to overhang any edge. This feels rigid compared to macOS Finder, where windows can extend partially off-screen but the title bar always remains accessible.

**Approach:** Adopt Finder-style constraining rules: a card may extend off any edge of the canvas, but enough of its title bar must remain visible and grabbable.

**Research notes — macOS Finder rules:**
- **Top edge:** The title bar cannot move above the menu bar. In our case, the top of the deck canvas is the equivalent boundary — the card's title bar top must remain at or below `y = 0` (canvas top).
- **Bottom edge:** A minimum grabbable strip of the title bar (~title bar height) must remain visible. The card body can extend below the canvas.
- **Left/right edges:** A minimum horizontal strip (~80-100px) of the title bar must remain visible. The card can otherwise hang off either side.
- **No minimum visible area for the card body** — only the title bar matters for recoverability.

**Details:**
- Replace the current `CANVAS_PADDING`-based clamp in `clampedPosition()` (card-frame.tsx) with Finder-style rules:
  ```
  const TITLE_BAR_VISIBLE_MIN_X = 100;  // px of title bar visible horizontally
  const TITLE_BAR_VISIBLE_MIN_Y = CARD_TITLE_BAR_HEIGHT;  // full title bar height visible vertically
  
  // Clamp so title bar stays reachable:
  clampedX = clamp(x, -(cardWidth - TITLE_BAR_VISIBLE_MIN_X), canvasWidth - TITLE_BAR_VISIBLE_MIN_X);
  clampedY = clamp(y, 0, canvasHeight - TITLE_BAR_VISIBLE_MIN_Y);
  ```
- Same rules apply during resize: the card may grow beyond the canvas edge, but cannot resize such that its title bar leaves the reachable zone.
- The "Arrange" commands (see item 4) serve as the recovery mechanism for cards that get lost off-edge.

**Scope:** tugdeck (`card-frame.tsx` — `clampedPosition` and resize clamping logic).

---

## 4. View Menu

**Problem:** There is no View menu. Card arrangement commands don't exist. The "Show card" items are buried in the Developer menu where they serve double duty as both dev tools and potential user-facing features.

**Approach:** Add a View menu between Edit and Developer (menu position 3, pushing Developer to position 4). It contains card arrangement commands, a card list, and the dev-only show-card items.

**Details:**

### Menu structure
```
View
  ├── Cascade                     ⌃⌥C
  ├── Tile                        ⌃⌥T
  ├── ─────────────────────
  ├── [Card Title 1]              (checkmark if focused)
  ├── [Card Title 2]
  ├── [Card Title 3]
  ├── ─────────────────────       (dev-mode only, below)
  ├── Show Component Gallery      ⌘⌥G    (moved from Developer)
  ├── Show Hello World Card       ⌘⌥1    (moved from Developer)
  └── Show Git Card               ⌘⌥2    (moved from Developer)
```

### Arrangement commands
- **Cascade:** Reposition all visible cards in a diagonal cascade from top-left, each offset by `CASCADE_STEP` (30px). Respects card size policies. Brings all off-canvas cards back into view.
- **Tile:** Arrange all visible cards in a grid that fills the canvas. Compute rows/cols to approximate each card's preferred aspect ratio. Respects min sizes.
- Both commands dispatch a control-frame action (`arrange-cards`) with a `mode` param (`cascade` | `tile`). DeckManager handles the layout computation and commits the new positions.

### Card list
- Dynamically built from DeckManager's current card list.
- Each item shows the card's display title.
- Clicking an item focuses (brings to front) that card.
- A checkmark decorates the currently-focused card.
- Requires dynamic menu population: use `NSMenuDelegate` on the View menu to rebuild the card list section each time the menu opens. The card titles and focus state come from a JS bridge query (`evaluateJavaScript` to call a deck-manager accessor).

### Dev-mode items
- Move "Show Component Gallery", "Show Hello World Card", and "Show Git Card" from the Developer menu to the bottom of the View menu.
- These items are only visible when `devModeEnabled` is true (same gating as the current Developer menu).
- The Developer menu retains: Reload, Show JavaScript Console, Add Tab To Active Card, Source Tree.

### Action routing
- Cascade/Tile: Swift menu action -> `sendControl("arrange-cards", { mode: "cascade" })` -> DeckManager handles it.
- Card list focus: Swift menu action -> `sendControl("focus-card", { cardId: "..." })`.
- Show-card items: same mechanism as today, just moved to a different menu.

**Scope:** Swift (`AppDelegate.swift` menu setup), tugdeck (`deck-manager.ts` for arrange logic, `deck-canvas.ts` for action handling).

---

---

## 5. Eliminate Reload Flash

**Problem:** A full-window flash occurs on both HMR updates and the Developer > Reload command. The flash is a brief white (or theme-mismatch) frame that appears while the WebView tears down and re-renders. This looks terrible and must be eliminated in both cases.

**Approach:** Investigate the root cause — likely the WebView briefly shows its default background between teardown and the new render. Possible fixes include keeping the WebView hidden (or opacity 0) during reload until `frontendReady` fires again, or ensuring the WebView's background color matches the canvas at all times so any intermediate frame is invisible.

**Scope:** Likely Swift (`MainWindow.swift` — reload handling, WebView background color) and possibly tugdeck (`main.tsx` — frontendReady signaling on HMR).

---

## 6. Tighten Active Card Shadow

**Problem:** The drop shadow on the focused (active) card spreads too wide, visually overwhelming adjacent cards and making the layout feel heavy.

**Approach:** Reduce the shadow spread to no more than 5px (matching `SNAP_GAP_PX`) so the shadow fits cleanly in the gap between snapped cards. The shadow should still be visible enough to convey depth/focus but should not bleed past the snap gap.

**Scope:** tugdeck CSS (`chrome.css` or equivalent — the `.card-frame` focused shadow rule).

---

## 7. Gallery Tab Icons Not Promoted to Title Bar

**Problem:** Some gallery card tabs (e.g. TugTextarea) use the generic diamond icon instead of their registered icon. When these tabs are active, the title bar shows the diamond instead of the correct icon. Other tabs (e.g. TugValueInput with `#`) correctly promote their icon to the title bar. All tabs must show their registered icon in the title bar when active.

**Approach:** Audit the icon promotion path from tab registration through to the title bar render. The title bar icon comes from the active tab's registration `defaultMeta.icon`. Tabs with missing or incorrect icons need their registrations fixed, or the icon lookup path has a bug for certain componentIds.

**Scope:** tugdeck (`gallery-registrations.tsx` icon values, `tug-card.tsx` / `deck-canvas.tsx` icon resolution logic).

---

## 8. Close Card vs. Close Tab (⌘W)

**Problem:** The File > Close Card (⌘W) command always closes the entire card, even when the card has multiple tabs. On a multi-tab card, ⌘W should close the active tab. Only when one tab remains should ⌘W close the card.

**Approach:** Change the `close` action handler to check whether the focused card has multiple tabs. If yes, close the active tab (via `store.removeTab`). If only one tab remains, close the card (via `store.handleCardClosed`). The menu item title should update dynamically: "Close Tab" when the focused card has multiple tabs, "Close Card" when it has one.

**Details:**
- The `close` chain action currently walks to `tug-card.tsx`'s registered handler, which calls `onClose` unconditionally.
- Change the handler to check `tabs.length > 1`: if so, call `store.removeTab(cardId, activeTabId)` instead of `onClose`.
- For the dynamic menu title: the Swift side can read the tab count from the cached card list (already pushed via WKScriptMessage) and update the File menu item title in `menuNeedsUpdate`.

**Scope:** tugdeck (`tug-card.tsx` close handler), Swift (`AppDelegate.swift` File menu delegate).

---

## 9. Inactive Card Dim Overlay Scrolls With Content

**Problem:** The dimming overlay on inactive (unfocused) cards is applied at a level in the card hierarchy that scrolls with the content. When a user scrolls an inactive card's content, the dim overlay scrolls out of view, leaving un-dimmed content visible. The overlay must cover the entire visible card area at all times, regardless of scroll position.

**Approach:** Move the dim overlay from its current position (inside the scrollable content area) to a fixed-position layer above the content but inside the card frame. It should be a `position: absolute` or `position: sticky` element that covers the full card content viewport and does not participate in scroll.

**Scope:** tugdeck CSS (`tug-card.css` — the `.tugcard-content::before` / `::after` pseudo-elements that implement the dim overlay).

---

## Implementation Order

Suggested sequencing based on dependencies and risk:

1. ~~**Card size policies (2)**~~ — done.
2. ~~**Relaxed placement (3)**~~ — done.
3. ~~**View menu (4)**~~ — done.
4. ~~**Reload flash (5)**~~ — done.
5. ~~**Active card shadow (6)**~~ — done.
6. **Gallery tab icons (7)** — quick audit and fix.
7. **Close Card vs. Close Tab (8)** — moderate scope, touches Swift and tugdeck.
8. **Inactive card dim overlay (9)** — CSS fix, needs careful positioning.
9. **Startup spinner (1)** — fully independent, cosmetic, low-risk.

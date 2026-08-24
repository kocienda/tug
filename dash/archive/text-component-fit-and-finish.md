# Text Component Fit-and-Finish

Fit-and-finish changes for text display and editing components: tug-input, tug-value-input, tug-textarea, tug-prompt-input, and tug-markdown-view.

## Items

### 6. Selection model rework + text selection adapter (foundational — do first)

**Problem:** The current selection system (SelectionGuard) was designed as a **selection manager** that owns rendering for all card content — it suppresses native `::selection`, mirrors every `selectionchange` into CSS Highlights, manages card-switch preservation, and enforces boundaries. This architecture has proven deeply problematic:

- **Stuck selections.** Hidden state (`cardRanges`, `justActivatedCardId`, `activeHighlightCardId`) creates cycles where stale Ranges are re-added to highlights on click, making selections impossible to clear.
- **Multiple activation paths.** `activateCard` is called from both `handlePointerDown` (capture phase) and DeckCanvas's `useLayoutEffect` (after React commit). These paths have different timing and semantics but share the same state, creating race conditions.
- **Chrome is selectable.** The boundary is `.tugcard-content`, which includes both content and chrome. `::highlight()` paints through `user-select: none` regions, so chrome appears selected even when CSS says it shouldn't be.
- **Double rendering.** Native inputs re-enable `::selection` for themselves AND have `::highlight(card-selection)` rules — two systems paint simultaneously.
- **Components can't manage their own selection.** Because SelectionGuard reacts to every `selectionchange` globally, any component that calls `removeAllRanges()` or manipulates the DOM Selection triggers SelectionGuard state changes that cascade unpredictably.

See `tuglaws/selection-model.md` for the full audit.

#### Architectural change: SelectionGuard becomes a boundary enforcer

**Core principle:** SelectionGuard operates at the **card level only**. It prevents selections from escaping card boundaries and handles card-switch dimming/restoration. It does NOT reach inside cards to manage how content components handle selection. Card contents never know about or care about SelectionGuard.

**What changes:**

| Responsibility | Current (selection manager) | New (boundary enforcer) |
|---|---|---|
| **Active selection rendering** | `::selection` suppressed globally; `card-selection` CSS Highlight mirrors every `selectionchange` | Native `::selection` paints active selections. No `card-selection` highlight. No `syncActiveHighlight`. No `cardRanges` mirroring. |
| **Inactive selection rendering** | Range moves between `card-selection` and `inactive-selection` highlights | Only `inactive-selection` highlight exists. Range cloned into it on card deactivation, removed on reactivation. |
| **Boundary enforcement** | Pointer clamping + selectionchange clipping (unchanged) | Same — still needed. |
| **Card-switch preservation** | `activateCard` with `justActivatedCardId` guard, `preventMousedown`, `cardRanges` persistence | Simpler: on deactivation, clone Range into `inactive-selection` and save it. On activation, restore browser Selection from saved Range. `justActivatedCardId` and `cardRanges` eliminated. |
| **Tab persistence** | `saveSelection` / `restoreSelection` (unchanged) | Same API, same mechanism. |
| **App activation** | Move Range between highlights (unchanged) | Same. |
| **Chrome selectability** | Boundary on `.tugcard-content` includes chrome; `::highlight()` paints through `user-select: none` | Native `::selection` respects `user-select: none`. Components opt in to `user-select: text` individually. Chrome is naturally non-selectable. |

**What gets eliminated:**
- `syncActiveHighlight` — the entire method (runs on every `selectionchange`, source of most bugs)
- `cardRanges` — no longer needed for mirroring (only written at card deactivation)
- `justActivatedCardId` — no longer needed (existed to prevent `syncActiveHighlight` from overwriting restored selections)
- `card-selection` CSS Highlight — removed entirely
- `.tugcard-content ::selection { transparent }` — removed; native `::selection` paints
- Per-component `::selection` re-enablement (tug-input, tug-textarea, etc.) — not needed; never suppressed
- Per-component `::highlight(card-selection)` rules — removed; highlight doesn't exist
- tug-prompt-input's `::highlight(card-selection) { transparent !important }` — not needed
- Double rendering on native inputs — eliminated

**What stays:**
- Boundary enforcement (pointer clamping, `selectstart` gating, `selectionchange` clipping)
- `inactive-selection` highlight for dimmed cards
- `useSelectionBoundary` hook
- Save/restore for tab switches
- App activation/deactivation
- `preventMousedown` for click-back (still needed, but only on genuine card switches — simpler to reason about)

**What each component owns:**
- **tug-markdown-view:** Uses native DOM Selection directly. Browser handles click-to-clear, drag-to-select. `user-select: text` on the scroll container. `caret-color: transparent` (read-only, no caret needed). Context menu samples `window.getSelection()`. Select-all uses a logical flag + CSS visual + data-model copy.
- **tug-prompt-input:** Uses TugTextEngine's selection model via contentEditable. No change from current behavior (already uses `data-tug-select="custom"` to exempt from clipping).
- **tug-input, tug-textarea, tug-value-input:** Use native `selectionStart`/`selectionEnd`. No change from current behavior except removing the now-unnecessary `::highlight()` and `::selection` override CSS rules.

#### Implementation plan

**Step 1: Remove the `card-selection` highlight and `syncActiveHighlight`.**
- Delete `syncActiveHighlight` method.
- Remove `card-selection` from `CSS.highlights` registration in `initHighlights` and `attach`.
- Remove the `activeHighlight` field, `cardRanges` map, `justActivatedCardId`, and `activeHighlightCardId`.
- Remove `::selection { transparent }` from `.tugcard-content` in tug-card.css.
- Remove all `::highlight(card-selection)` CSS rules from tug-card.css, tug-input.css, tug-textarea.css, tug-value-input.css, tug-prompt-input.css, tug-markdown-view.css.
- Remove `::selection` re-enablement rules from tug-input.css, tug-textarea.css, tug-value-input.css, tug-prompt-input.css (native `::selection` is no longer suppressed).
- **Test:** Drag-to-select in all text components works. Selection is visible via native `::selection`. No double rendering.

**Step 2: Rework card-switch to save/restore without `syncActiveHighlight`.**
- On card deactivation (a different card is clicked): clone the current card's DOM Selection Range, add it to `inactive-selection` highlight, clear the browser Selection.
- On card activation (clicking back): restore browser Selection from the saved Range, remove from `inactive-selection`. Install `preventMousedown` to stop the click from collapsing.
- DeckCanvas's `useLayoutEffect` calls a simplified `activateCard` that only manages the `inactive-selection` highlight, not a `card-selection` highlight.
- **Test:** Select text in Card A, click Card B, Card A's selection dims. Click back to Card A, selection restores.

**Step 3: Verify boundary enforcement still works.**
- Pointer clamping, `selectstart` gating, and keyboard selection clipping should work unchanged — they don't depend on `syncActiveHighlight` or `card-selection`.
- **Test:** Drag selection in a card, drag pointer outside the card boundary — selection clips at the edge. Start a selection in card chrome — blocked by `selectstart` handler + `user-select: none`.

**Step 4: Clean up and update tests.**
- Update SelectionGuard tests to reflect the new architecture.
- Remove tests for `syncActiveHighlight`, `cardRanges`, `justActivatedCardId`.
- Add tests for the new save/restore flow.

#### TextSelectionAdapter interface

The `TextSelectionAdapter` interface (already implemented in `text-selection-adapter.ts`) provides a uniform selection query/mutation API for items 1–2. With the selection model rework, the `HighlightSelectionAdapter` simplifies — it queries native DOM Selection directly, with no dependency on SelectionGuard state:

```ts
interface TextSelectionAdapter {
  hasRangedSelection(): boolean;
  getSelectedText(): string;
  selectAll(): void;
  expandToWord(): void;
  classifyRightClick(clientX: number, clientY: number, proximityThreshold: number):
    "near-caret" | "within-range" | "elsewhere";
  selectWordAtPoint(clientX: number, clientY: number): void;
}
```

Three implementations:
1. **`NativeInputSelectionAdapter`** — offset-based, wraps `<input>`/`<textarea>`. Already in `use-text-input-responder.tsx`.
2. **`EngineSelectionAdapter`** — wraps TugTextEngine. Already in `tug-prompt-input.tsx`.
3. **`HighlightSelectionAdapter`** — wraps native DOM Selection for read-only views. Already in `text-selection-adapter.ts`. After the rework, this is just standard DOM Selection queries — no SelectionGuard dependency.

#### Resolved questions

**Q1: Native input caret-to-point.** `caretPositionFromPoint`/`caretRangeFromPoint` do NOT resolve positions inside `<input>`/`<textarea>`. Solution: let the browser place the caret on mousedown; read `selectionStart`/`selectionEnd` at contextmenu time. Offset-based three-case algorithm. See `createNativeInputAdapter` in `use-text-input-responder.tsx`.

**Q2: tug-markdown-view's `selectAll` scope.** The view is virtualized — most blocks aren't in the DOM. Solution: logical `selectAllActive` flag + `data-select-all` CSS attribute on the scroll container for visual feedback + `regionMap.text` for copy. Cleared on next pointerdown (bubble phase, scroll container only). The select-all visual uses the same selection color tokens. After the rework, the `data-select-all` CSS suppresses `::selection` (not `::highlight(card-selection)`, which no longer exists) and paints block backgrounds.

**Key files:**
- `tugdeck/src/components/tugways/selection-guard.ts` (major rework)
- `tugdeck/src/components/tugways/tug-card.css` (remove `::selection` suppression, `::highlight(card-selection)` rules)
- `tugdeck/src/components/tugways/tug-input.css`, `tug-textarea.css`, `tug-value-input.css`, `tug-prompt-input.css` (remove `::selection` re-enablement, `::highlight()` rules)
- `tugdeck/src/components/tugways/tug-markdown-view.css` (update select-all CSS for native `::selection`)
- `tugdeck/src/components/tugways/text-selection-adapter.ts` (simplify HighlightSelectionAdapter)
- `tugdeck/src/components/chrome/deck-canvas.tsx` (simplify `activateCard` call)
- `tugdeck/src/__tests__/selection-guard.test.ts`, `selection-model.test.tsx` (rework tests)

---

### 1. tug-markdown-view: right-click context menu

**Depends on:** Item 6 (selection model rework must land first).

**Current state:** WIP context menu and responder registration exist but selection behavior is broken due to SelectionGuard's `syncActiveHighlight` interference. See checkpoint commit `eec440f5`.

**Goal:** Right-click context menu with Cut (disabled), Copy (enabled when selection or select-all), Paste (disabled), Select All. Standard mac-like menu: all commands shown, inapplicable ones disabled.

**Approach (after item 6 lands):** With the selection model rework, native `::selection` paints the active selection. The browser handles drag-to-select, click-to-clear, and selection rendering natively. The markdown view just needs:

- `user-select: text` on the scroll container (content is selectable)
- `caret-color: transparent` (read-only, no caret needed)
- Responder registration with `copy`, `selectAll`, and no-op `cut`/`paste` handlers
- `contextmenu` listener to show `TugEditorContextMenu`
- `pointerdown` listener (bubble) to clear `selectAllActive` flag
- Virtualized select-all via logical flag + `data-select-all` CSS + `regionMap.text` copy

No custom pointer tracking, no selection state management, no coordination with SelectionGuard internals. The browser does the work; the component reads the result.

**Key files:**
- `tugdeck/src/components/tugways/tug-markdown-view.tsx`
- `tugdeck/src/components/tugways/tug-editor-context-menu.tsx`
- `tugdeck/src/components/tugways/tug-markdown-view.css`

---

### 2. Selection repositioning on right-click

**Depends on:** Item 6 (selection model rework must land first).

**Current state:** tug-prompt-input captures pre-right-click selection and restores it (defeating WebKit's smart-click word expansion). Native input components (`useTextInputResponder`) have `createNativeInputAdapter` with offset-based `classifyRightClick`. tug-markdown-view has `HighlightSelectionAdapter` with geometry-based `classifyRightClick`. Adapters exist but aren't wired into contextmenu handlers yet.

**Goal:** Three-case behavior for all text components:

1. **Caret + click near caret (within ~1em):** Keep caret where it is, open menu.
2. **Range + click inside range:** Keep range as-is, open menu.
3. **Otherwise:** Move selection to click point and expand to word bounds.

**Approach (after item 6 lands):** Each component's `contextmenu` handler calls `adapter.classifyRightClick()` and acts on the result. For tug-markdown-view, the adapter queries native DOM Selection directly (no SelectionGuard dependency). For native inputs, offset comparison. For tug-prompt-input, DOM geometry.

**Key files:**
- `tugdeck/src/components/tugways/use-text-input-responder.tsx`
- `tugdeck/src/components/tugways/tug-prompt-input.tsx`
- `tugdeck/src/components/tugways/tug-markdown-view.tsx`
- `tugdeck/src/components/tugways/text-selection-adapter.ts`

---

### 3. Content and selection persistence across tab changes — DEFERRED

Deferred: requires a proper document model for card content, not per-component save/restore into a key-value store. The single-slot persistence design (`useTugcardPersistence`) doesn't scale to cards with multiple inputs, and the right solution is a card-level content model that captures the full editing surface.

**Current state:** Only tug-prompt-input persists via `useTugcardPersistence` (saves engine state including text, atoms, selection). TugInput, TugValueInput, and TugTextarea have no persistence — content and selection are lost on tab switch.

**Goal:** All text components save and restore their editing contents and selection per tab/card across tab changes.

**Approach:** Each component adopts `useTugcardPersistence` with `onSave`/`onRestore` callbacks. For native inputs: save `{ value, selectionStart, selectionEnd }`, restore on activation. The tug-card.tsx plumbing already supports this; components just need to opt in.

**Key files:**
- `tugdeck/src/components/tugways/tug-input.tsx`
- `tugdeck/src/components/tugways/tug-value-input.tsx`
- `tugdeck/src/components/tugways/tug-textarea.tsx`
- `tugdeck/src/components/tugways/use-tugcard-persistence.tsx`
- `tugdeck/src/components/tugways/tug-card.tsx`

---

### 4. Undo stack persistence across tab changes

**Current state:** All components use `document.execCommand("undo")` — the browser's native undo stack. When tug-prompt-input deactivates and restores, it rebuilds DOM content but the undo stack is lost. Native inputs likewise lose their undo stack when DOM is torn down.

**Goal:** Undo history survives tab switches.

**Approach options:**

- **Custom undo stack:** Replace `execCommand("undo/redo")` with an application-level undo manager that records operations and can be serialized per tab. Significant change to tug-text-engine and potentially all input components.
- **DOM preservation:** Instead of destroying and rebuilding DOM on tab switch, keep deactivated tab DOM alive but hidden. The native undo stack survives because elements persist. Trades memory for simplicity.

**Key files:**
- `tugdeck/src/lib/tug-text-engine.ts`
- `tugdeck/src/components/tugways/tug-prompt-input.tsx`
- `tugdeck/src/components/tugways/use-text-input-responder.tsx`
- `tugdeck/src/components/tugways/tug-card.tsx`

---

### 5. select-all broken in tug-prompt-input (keyboard and context menu)

**Root cause (confirmed):** `tug-text-engine.ts:420` had `document.execCommand("select-all")` — the kebab-case action name leaked into an execCommand call. The browser's `document.execCommand` API uses its own camelCase command vocabulary (`"selectAll"`, `"insertText"`, `"forwardDelete"`, etc.). The hyphenated `"select-all"` is not a recognized command and WebKit silently ignores it.

**Fix:** Change `document.execCommand("select-all")` to `document.execCommand("selectAll")` at `tug-text-engine.ts:420`.

**Why the Swift Edit menu still worked:** `NSText.selectAll(_:)` goes through WebKit's native editing command infrastructure, bypassing JavaScript entirely. The keyboard (⌘A) and context menu paths both route through the responder chain → handler continuation → `engine.selectAll()` → `document.execCommand(...)`, hitting the broken string.

**How the bug happened:** The action naming convention (tuglaws/action-naming.md) mandates kebab-case for action names on the responder chain wire format: `TUG_ACTIONS.SELECT_ALL = "select-all"`. The `document.execCommand` API uses a different vocabulary with different casing: `"selectAll"`, `"insertText"`, `"forwardDelete"`, etc. These are two separate namespaces that happen to describe overlapping concepts. The kebab-case action name was mistakenly used where the camelCase execCommand name was needed.

**Prevention:** Add explicit guidance to tuglaws docs and action-vocabulary.ts making the namespace boundary clear. Two naming systems coexist in the editing code — action names (kebab-case, ours) and execCommand names (camelCase, the browser's) — and they must never be mixed. See conventions below.

**Conventions to add:**

1. **action-naming.md** — new section: "Action Names vs. Browser Command Names." Explicitly call out that `document.execCommand` has its own vocabulary (`"selectAll"`, `"insertText"`, `"delete"`, `"undo"`, `"redo"`, `"forwardDelete"`, `"insertHTML"`, `"insertLineBreak"`) that uses camelCase. Action names and execCommand names describe overlapping concepts but are separate namespaces with different casing rules. Action names flow through the responder chain; execCommand names flow to the browser. Never use one where the other is expected.

2. **action-vocabulary.ts** — add a comment block near the clipboard/editing constants noting the namespace boundary: the `TUG_ACTIONS` kebab-case strings are dispatched through the chain; the browser's `document.execCommand` calls use a separate camelCase vocabulary. The two must not be mixed.

3. **responder-chain.md** — in the section on handlers that call `document.execCommand` (the two-phase continuation pattern for editing), note that the execCommand string is *not* the action name — it is a browser API identifier with its own casing convention.

4. **component-authoring.md** — in the editing/text component guidance, note the same boundary.

**Key files:**
- `tugdeck/src/lib/tug-text-engine.ts` (line 420 — the fix site)
- `tuglaws/action-naming.md` (new section)
- `tuglaws/responder-chain.md` (amendment)
- `tuglaws/component-authoring.md` (amendment)
- `tugdeck/src/components/tugways/action-vocabulary.ts` (comment addition)

---

### 7. Card content selection design (do after #6)

**Depends on:** Item 6 (boundary enforcer model must be in place).

**Problem:** With the boundary enforcer model landed, native `::selection` paints active selections and SelectionGuard only handles card-level concerns. But within a card, selection still leaks through chrome — labels, section headers, button text, description text. A card like the TugSheet gallery shows a rich UI surface with many components, and drag-selecting or ⌘A-ing selects *everything*, revealing the web implementation underneath. The card should feel like a native app panel where only designated content regions are selectable.

**Current state after item 6:**

- `body` has `user-select: none` (baseline)
- `.tugcard-content` inherits `none` (we removed `user-select: text` in item 6)
- Content components opt in individually: `.tugx-md-scroll-container`, `.tug-input`, `.tug-textarea`, `.tug-value-input` have `user-select: text`
- `.tug-sheet` has `user-select: text` (the entire sheet overlay, including labels and chrome)
- `tug-card.tsx:handleSelectAll` calls `selectAllChildren` on the card content area or the active contentEditable — this selects everything inside the card if no contentEditable is focused

The `user-select: none` inheritance means most card chrome is already non-selectable for drag-to-select. But two problems remain:

1. **Select-all selects everything.** The card's `handleSelectAll` calls `selectAllChildren(contentRef)` which selects all text in the content area, including chrome elements that have `user-select: none` (the DOM Selection API ignores `user-select` — it operates on DOM nodes, not CSS layout).

2. **Some components set `user-select: text` too broadly.** `.tug-sheet` makes the entire sheet selectable, including its section headers and labels.

#### Design concept: three selection categories

Every component in a card falls into one of three categories, declared via the `data-tug-select` attribute:

| Category | `data-tug-select` | CSS | Click-drag | ⌘A | Right-click | Selection highlight |
|----------|-------------------|-----|-----------|-----|-------------|-------------------|
| **Selectable** | `"text"` | `user-select: text` | Creates visible selection | Selects all within component | Copy from selection | Native `::selection` paints |
| **Copyable** | `"copy"` | `user-select: none` | No effect on selection | Not included in any select-all | Context menu with Copy (copies component's text content) | Never shows selection highlight |
| **Chrome** | `"none"` or absent | `user-select: none` | No effect on selection | Not included in any select-all | No copy option | Never shows selection highlight |

**Selectable** (`data-tug-select="text"`) — text the user can directly select via keyboard or click-drag. Examples: markdown view content, text input content, textarea content, prompt input content. These components set `user-select: text` (via the `[data-tug-select="text"]` CSS rule) and handle `selectAll` in the responder chain.

**Copyable** (`data-tug-select="copy"`) — informational text the user might want to copy but should never directly select. Examples: labels, timestamps, status lines. These components inherit `user-select: none`. They cannot be drag-selected or included in ⌘A. The only way to copy their content is right-click → Copy from a context menu, which reads the component's text content directly (e.g., `el.textContent`), not from the DOM Selection. No visible selection highlight ever appears.

**Chrome** (`data-tug-select="none"` or attribute absent) — UI surface with no copyable text content. Examples: buttons, toolbar icons, section dividers, decorative elements. Inherits `user-select: none` and offers no copy mechanism.

#### Mechanism: `data-tug-select` attribute

The `data-tug-select` attribute (tugdeck namespace) is already established for per-region selection control. The existing values (`none`, `all`, `custom`) are extended with `text` and `copy`:

| Value | Purpose | CSS rule |
|-------|---------|----------|
| `"text"` | Selectable content | `[data-tug-select="text"] { user-select: text }` |
| `"copy"` | Copyable content (right-click only) | No CSS override (inherits `none`) |
| `"none"` | Chrome (explicit) | `[data-tug-select="none"] { user-select: none }` |
| `"custom"` | Component owns selection (tug-prompt-input) | SelectionGuard skips clipping |
| `"all"` | Select entire region on click | `[data-tug-select="all"] { user-select: all }` |
| absent | Chrome (default) | Inherits `user-select: none` from body |

Component authors set `data-tug-select` on their root element. The attribute drives both CSS behavior (via rules in tug-card.css) and responder behavior (selectable components handle `selectAll` + `copy`; copyable components handle `copy` only via the `useCopyableText` hook).

#### Rules

**Rule 1: Only selectable components set `user-select: text`.** Copyable and chrome components inherit `user-select: none` from the body. No container element (`.tugcard-content`, `.tug-sheet`, etc.) sets `user-select: text` on behalf of its children.

**Rule 2: Select-all is always scoped to the first responder.** When ⌘A is dispatched through the responder chain:
- If the first responder is a selectable component that handles `selectAll`, the selection stays within that component. The action does not bubble.
- If ⌘A reaches the card (no selectable component is focused), it is a no-op. The card does not handle `selectAll`. There is no "select everything in the card" behavior.

**Rule 3: Drag-selection is confined to the component where it started.** A drag that starts in a markdown view stays in the markdown view. A drag that starts in a text input stays in the text input. `user-select: none` on surrounding chrome prevents the selection from extending into copyable or chrome regions. SelectionGuard prevents it from escaping the card.

**Rule 4: Components that contain both chrome and selectable regions use `user-select: none` on the container and `user-select: text` on the selectable region.** For example, tug-sheet should have `user-select: none` on the sheet overlay and `user-select: text` only on form inputs inside it.

**Rule 5: Copyable components offer right-click → Copy.** They register as responders with a `copy` handler that reads `el.textContent` (or equivalent) and writes to the clipboard. They show a `TugEditorContextMenu` with Copy enabled and all other items disabled. They do NOT handle `selectAll`.

**Rule 6: Chrome controls refuse focus on click.** Controls (buttons, checkboxes, switches, sliders, radio/choice/option group items, tab bar tabs) prevent mousedown default to stop the browser from moving focus to them on click. This mirrors Cocoa's `acceptsFirstResponder = false` — controls respond to clicks but never steal keyboard focus from the active editor. The click event and its action dispatch are unaffected. Keyboard accessibility is preserved: controls remain in the Tab order (`tabindex` unchanged) so keyboard users can reach them via Tab and activate with Enter/Space. Only mouse-driven focus theft is prevented.

| Component | Focus behavior | Implementation |
|-----------|---------------|----------------|
| TugButton (internal) | Refuses focus on click | `onMouseDown={preventFocusTheft}` |
| TugPushButton | Refuses focus on click | Inherits from TugButton |
| TugPopupButton | Refuses focus on click | Inherits from TugButton |
| TugCheckbox | Refuses focus on click | `onMouseDown={preventFocusTheft}` |
| TugSwitch | Refuses focus on click | `onMouseDown={preventFocusTheft}` |
| TugSlider | Refuses focus on click | `onMouseDown={preventFocusTheft}` |
| TugRadioGroup items | Refuses focus on click | On radio item element |
| TugChoiceGroup items | Refuses focus on click | On choice item element |
| TugOptionGroup items | Refuses focus on click | On option item element |
| TugTabBar tabs | Refuses focus on click | On tab element |
| TugInput | **Accepts focus** | No change — needs keyboard input |
| TugTextarea | **Accepts focus** | No change |
| TugValueInput | **Accepts focus** | No change |
| TugPromptInput | **Accepts focus** | No change |
| TugMarkdownView | **Accepts focus** | No change (tabIndex=0 for shortcuts) |
| Display components | N/A | Non-interactive, no focus behavior |

#### Implementation plan

**Step 1: Remove card-level `selectAll` handler. — DONE**

The card's `handleSelectAll` in `tug-card.tsx` currently calls `selectAllChildren(contentRef)` as a fallback when no contentEditable is focused. Remove this handler entirely. The card should not handle `selectAll` — it should bubble up through the chain unhandled.

The responder chain already provides the right scoping: tug-prompt-input, tug-input, tug-textarea, tug-value-input, and tug-markdown-view all handle `selectAll` in their own responder registrations. If ⌘A reaches the card, it means no selectable component is focused — the correct behavior is to do nothing.

**Step 2: Fix `.tug-sheet` user-select. — DONE**

Remove `user-select: text` from `.tug-sheet`. The sheet overlay is unselectable chrome. Form inputs inside the sheet already have their own `user-select: text`. The sheet's `user-select: text` was a workaround for a WebKit double-click bug — test whether the bug still occurs with the boundary enforcer model. If it does, find a narrower fix (e.g., `user-select: text` only on the sheet's form input region, or a targeted `pointerdown` handler).

**Step 3: Implement focus refusal on chrome controls. — DONE**

Controls that should not steal focus from editors are marked with `data-tug-focus="refuse"` on their root element. That attribute is the single source of truth — controls add nothing else. Two document-level listeners in `responder-chain-provider.tsx` handle both concerns centrally:
- `pointerdown` (capture): if target is inside `[data-tug-focus="refuse"]`, skip first-responder promotion
- `mousedown` (capture): if target is inside `[data-tug-focus="refuse"]`, call `preventDefault()` to prevent browser focus transfer

The `click` event is unaffected. Keyboard Tab navigation is preserved (controls keep default `tabindex`).

Applied to: `TugButton` (covers TugPushButton, TugPopupButton), `TugCheckbox`, `TugSwitch`, `TugSlider`, `TugChoiceGroup`, `TugOptionGroup`, `TugTabBar` (tabs + close buttons). `TugRadioGroup` items use TugButton via `asChild` — already covered.

Also resolves the tug-sheet WebKit workaround (Q3) — buttons no longer steal focus from text inputs.

**Step 4: Audit all `user-select: text` declarations. — DONE**

All active `user-select: text` declarations are on selectable content components:

| Selector | File | Category | Status |
|----------|------|----------|--------|
| `.tugx-md-scroll-container` | tug-markdown-view.css | Selectable | Correct |
| `.tug-input` | tug-input.css | Selectable | Correct |
| `.tug-textarea` | tug-textarea.css | Selectable | Correct |
| `.tug-value-input` | tug-value-input.css | Selectable | Correct |
| `.style-inspector-overlay` | style-inspector-overlay.css | Selectable (dev tool) | Correct |
| `.tug-sheet` | tug-sheet.css | Chrome (container) | Fixed in step 2 |

**Step 5: Implement copyable component pattern.**

Create a reusable pattern for copyable components (labels, timestamps, status text):
- Component registers as a responder with a `copy` handler
- `copy` handler reads `el.textContent` (or a prop) and writes to the clipboard via `navigator.clipboard.writeText()`
- Component adds a `contextmenu` listener that shows `TugEditorContextMenu` with Copy enabled, Cut/Paste/SelectAll disabled
- No `user-select: text` — the component inherits `user-select: none`
- No visible selection ever appears

This could be a shared hook (e.g., `useCopyableText(ref)`) that handles the responder registration, context menu, and clipboard write. Each copyable component calls it.

**Step 6: Update `tuglaws/selection-model.md`, `tuglaws/responder-chain.md`, and `tuglaws/component-authoring.md`.**

Document the three selection categories, six rules, and focus acceptance model:
- `selection-model.md`: Three categories (selectable, copyable, chrome), six rules, `data-tug-select` attribute, focus acceptance model.
- `responder-chain.md`: Add "Focus acceptance" section explaining that controls refuse focus on click (mousedown prevention) while remaining Tab-accessible. Update the chain walk diagram to remove `select-all` from TugCard.
- `component-authoring.md`: Add guidance:
  - "Selectable components set `user-select: text` and handle `selectAll`."
  - "Copyable components inherit `user-select: none`, handle `copy` via right-click, use `useCopyableText` hook."
  - "Chrome controls refuse focus on click via mousedown prevention. Use the same pattern as TugButton."

#### Resolved questions

**Q1: Card-level selectAll.** Cards do not handle `selectAll`. An empty card ignores it entirely. The action bubbles up to SelectionGuard's boundary, which does not propagate it further. No selection is created.

**Q2: Informational text.** Three categories — selectable, copyable, unselectable. Labels, timestamps, and status lines are **copyable**: right-click → Copy works, but click-drag and ⌘A do not. No visible selection highlight ever appears on copyable content.

**Q3: tug-sheet WebKit workaround.** Resolved by Rule 6 (focus refusal). The bug was that clicking a button inside a sheet while a text input had an active selection caused the first click to be consumed as a selection-clear action. With focus refusal on TugButton (`mousedown.preventDefault`), the button never steals focus from the input — the selection stays, and the button activates on the first click. The broad `user-select: text` on `.tug-sheet` is no longer needed.

**Key files:**
- `tugdeck/src/components/tugways/tug-card.tsx` (remove handleSelectAll — done)
- `tugdeck/src/components/tugways/tug-sheet.css` (remove user-select: text — done)
- `tugdeck/src/components/tugways/internal/tug-button.tsx` (mousedown focus refusal)
- `tugdeck/src/components/tugways/tug-checkbox.tsx` (mousedown focus refusal)
- `tugdeck/src/components/tugways/tug-switch.tsx` (mousedown focus refusal)
- `tugdeck/src/components/tugways/tug-slider.tsx` (mousedown focus refusal)
- `tugdeck/src/components/tugways/tug-radio-group.tsx` (mousedown focus refusal)
- `tugdeck/src/components/tugways/tug-choice-group.tsx` (mousedown focus refusal)
- `tugdeck/src/components/tugways/tug-option-group.tsx` (mousedown focus refusal)
- `tugdeck/src/components/tugways/tug-tab-bar.tsx` (mousedown focus refusal)
- `tugdeck/src/components/tugways/style-inspector-overlay.css` (audit)
- `tugdeck/src/components/tugways/use-copyable-text.ts` (new — shared hook for copyable pattern)
- `tuglaws/selection-model.md` (document three categories and six rules)
- `tuglaws/responder-chain.md` (focus acceptance section, diagram update)
- `tuglaws/component-authoring.md` (add selection + focus guidance)

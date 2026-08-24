# Right-Click Selection Repositioning

Wire up the three-case selection logic for the text editing context menu across all five text components.

## Desired behavior

When the user right-clicks to open the editor context menu, the selection is adjusted according to three cases:

1. **Near-caret:** The current selection is a collapsed caret and the click lands close to it (within ~1em). The caret stays put. The context menu applies to the current caret position.

2. **Within-range:** The current selection is a range and the click lands inside the selected region. The selection stays put. The context menu applies to the existing range (Cut/Copy enabled).

3. **Elsewhere:** The click lands away from the current selection (whether caret or range). The selection moves to the click point and expands to word boundaries. The context menu applies to the newly-selected word (Cut/Copy enabled).

## Current state

The `TextSelectionAdapter` interface in `text-selection-adapter.ts` already models all three cases:

- `classifyRightClick(clientX, clientY, proximityThreshold)` returns `"near-caret"` | `"within-range"` | `"elsewhere"`
- `selectWordAtPoint(clientX, clientY)` places the caret and expands to word boundaries
- `expandToWord()` expands the current caret to word boundaries

Concrete adapter factories exist for all three selection models:

| Adapter | Components | Location |
|---------|-----------|----------|
| `createNativeInputAdapter` | tug-input, tug-textarea, tug-value-input | `use-text-input-responder.tsx` |
| `createEngineAdapter` | tug-prompt-input | `tug-prompt-input.tsx` |
| `HighlightSelectionAdapter` | tug-markdown-view | `text-selection-adapter.ts` |

**None of these adapters are currently called from the context menu handlers.** The adapter methods exist and are tested against the interface, but the contextmenu handlers don't use them:

- **use-text-input-responder** (`openMenu`): Simply checks whether a ranged selection exists, opens the menu. No pre-click capture, no classification, no repositioning.
- **tug-prompt-input**: Captures selection at pointerdown, restores it verbatim at contextmenu time (undoing WebKit smart-click), then checks hasSelection. Never classifies or repositions.
- **tug-markdown-view**: Checks for existing DOM selection or logical select-all flag. No classification or repositioning.

## Changes

### A. use-text-input-responder — native inputs (tug-input, tug-textarea, tug-value-input)

The `openMenu` callback needs a pointerdown capture step and classification logic:

1. Add a `pointerdown` listener (button === 2) that creates a `NativeInputAdapter` from the current element and calls `capturePreRightClick()`. Store the adapter instance in a ref so the contextmenu handler can use it.
2. In `openMenu` (the contextmenu handler), call `adapter.classifyRightClick()`. Branch on the result:
   - `"near-caret"`: restore the pre-click caret position, open menu with `hasSelection: false`.
   - `"within-range"`: restore the pre-click range, open menu with `hasSelection: true`.
   - `"elsewhere"`: call `adapter.selectWordAtPoint()`, open menu with `hasSelection: adapter.hasRangedSelection()` (true if the word expansion selected something, false if on whitespace/punctuation).
3. The pointerdown listener must be a native DOM listener (not a React event) so it fires before the browser's mousedown default action moves the caret. This matches the pattern tug-prompt-input already uses.

**Note on proximity threshold:** For native inputs, `classifyRightClick` uses offset comparison (not geometry), so the 1em threshold doesn't apply directly. The native adapter classifies "near-caret" when the browser places the caret at the same offset as the captured caret. This is the correct behavior for native inputs since the browser's own caret placement from the click is pixel-accurate.

### B. tug-prompt-input — contentEditable engine

The contextmenu handler already captures and restores the pre-click selection. It needs to add classification after restoration:

1. After restoring the pre-click selection (existing code), call `adapter.classifyRightClick(e.clientX, e.clientY, proximityThreshold)` using the engine adapter.
2. Branch on the result:
   - `"near-caret"`: leave selection as-is (already restored), open menu with `hasSelection: false`.
   - `"within-range"`: leave selection as-is (already restored), open menu with `hasSelection: true`.
   - `"elsewhere"`: call `adapter.selectWordAtPoint(e.clientX, e.clientY)`, open menu with `hasSelection: adapter.hasRangedSelection()`.
3. The proximity threshold should be computed from the element's computed font size (`parseFloat(getComputedStyle(engine.root).fontSize)` gives 1em in pixels).

### C. tug-markdown-view — readonly highlight selection

The contextmenu handler needs pre-click capture and classification:

1. Add a `pointerdown` listener (button === 2) to snapshot the DOM Selection state before the browser moves it. For the `HighlightSelectionAdapter`, this means saving the current `Selection` anchor/focus/range so it can be compared or restored.
2. In the contextmenu handler, use the `HighlightSelectionAdapter` to classify:
   - `"near-caret"`: leave caret as-is, open menu with `hasSelection: false`.
   - `"within-range"`: restore the pre-click range, open menu with `hasSelection: true`.
   - `"elsewhere"`: call `adapter.selectWordAtPoint(e.clientX, e.clientY)`, open menu with `hasSelection: adapter.hasRangedSelection()`.
3. The proximity threshold is `parseFloat(getComputedStyle(boundaryEl).fontSize)`.

**Note:** The `HighlightSelectionAdapter` may need a `capturePreRightClick()` / restore method added, similar to the native input adapter. Currently it reads the live DOM Selection, but the browser may have already moved it by contextmenu time.

## Proximity threshold

All geometric adapters (engine adapter, highlight adapter) use a pixel distance for "near-caret" classification. Start with 1em (the element's computed font size in pixels). This can be tuned later.

Native input adapters use offset comparison instead of geometry, which is inherently exact — a caret at offset 5 is "near" if the browser places the post-click caret at offset 5 too.

## Testing

Manual testing in the browser across all five components:
- Right-click near a caret: menu opens, caret doesn't move
- Right-click inside a range selection: menu opens, selection preserved, Cut/Copy enabled
- Right-click away from selection: selection moves to click point, word selected, Cut/Copy enabled
- Right-click on whitespace/punctuation: caret moves, no word selected, Cut/Copy disabled
- Verify in both Safari (WKWebView) and Chrome (dev)

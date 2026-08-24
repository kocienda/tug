# T3.2 Tactical Plan: tug-prompt-input

*Tactical execution plan for building the tug-prompt-input component. Companion to the T3.2 section in [tide.md](tide.md).*

---

## Principle: the browser is the engine

WebKit's native contentEditable with `<img>` atoms handles text editing correctly. We do not maintain a parallel document model, reconciler, or mutation observer. The DOM is the source of truth. Our code is a thin event-handling layer — a few focused customizations on top of WebKit's editing.

This principle was validated by the IMG atom spike (2026-04-05). The spike proved:

- `<img src="data:image/svg+xml,...">` atoms are replaced elements — WebKit navigates them atomically, positions the caret correctly before/after them, and handles selection natively.
- No `contentEditable="false"` needed. No ZWSP. No anchor spans. No domPosition/flatFromDOM mapping. No reconciler.
- Native undo/redo via `execCommand`. Native IME. Native arrow navigation. Native click-to-position.
- ~300 lines of focused event handling vs 1800+ lines of the old engine.

---

## What Failed (and Why)

The original TugTextEngine architecture used `contentEditable="false"` spans for atom badges. This caused WebKit's caret renderer to misposition the caret near atoms. We spent days building increasingly complex workarounds:

- ZWSP cursor anchors + ce=false anchor spans (broke trailing newlines)
- rootPosition (WebKit rendered caret at height 0)
- Ce=true badges with real text (caret entered the badge text)
- Custom caret rendering plans (would break IME)

**Root cause:** `contentEditable="false"` inline elements create "non-editable islands" that WebKit's editing code cannot handle correctly. Every major web editor (ProseMirror, Lexical, Slate) fights the same bugs. The solution is not more workarounds — it's eliminating ce=false from the text flow entirely.

**The fix:** atoms as `<img>` elements. Images are replaced elements — WebKit already knows how to lay them out and navigate around them. Twenty years of browser engineering handles the caret correctly.

---

## What We Need

A thin event-handling layer on top of native contentEditable. Seven focused behaviors:

### 1. Atom creation and rendering

Atoms are `<img src="data:image/svg+xml,...">` elements with `data-atom-*` attributes. Each atom SVG contains:
- Rounded rect background with border
- Lucide-style icon (file, command, doc, link, image)
- Label text, measured via canvas `measureText` for accurate width

Creation: `createAtomImgElement(type, label, value)` → `HTMLImageElement`.

**Theming:** Data URI SVGs are isolated from the page's CSS cascade — `currentColor`, `var()`, and CSS custom properties do not cross into them. Colors are read live from theme tokens via `getComputedStyle(document.documentElement).getPropertyValue('--tug7-...')` at atom creation time. No hardcoded hex values in the builder — always token lookups. Atoms created under the current theme automatically match it. For theme changes to update existing atoms, see Step 6.

### 2. Clipboard (copy / cut / paste)

- **Copy**: intercept `copy` event. Write `text/html` (preserving atom `<img>` tags with `data-atom-*` attributes) and `text/plain` (atom labels as text) to clipboard.
- **Cut**: write to clipboard (same as copy), then `document.execCommand("delete")` for undo-stack-compatible deletion.
- **Paste**: check `text/html` for `data-atom-label` markers. If present, `e.preventDefault()` + `document.execCommand("insertHTML", false, content)`. Otherwise let browser handle natively. Both paths are undoable.

### 3. Drag and drop

- `dragover`: `e.preventDefault()`, `dropEffect = "copy"`
- `drop`: read `dataTransfer.files`, position caret at drop point via `document.caretRangeFromPoint(e.clientX, e.clientY)`, build atom HTML for each file, insert via `document.execCommand("insertHTML")`.

### 4. Option+Arrow word boundaries at atoms

Native `Selection.modify("move", dir, "word")` skips over images. Intercept Option+Arrow:
1. Record caret position before the move (as a Range)
2. Let `sel.modify` do the native word move
3. Check if any atom `<img>` is between the before and after positions using `Range.compareBoundaryPoints`
4. If so, clamp to the first atom boundary crossed

### 5. Click on atom → select

Click handler: if `e.target` is an `<img data-atom-label>`, create a Range that selects the entire image and set it as the selection. The image shows as selected; backspace deletes it.

### 6. Return / Enter key configuration

Keydown handler for Enter:
- Read `data-return-action` / `data-enter-action` from the editor element (set by React via data attributes, L06 compliant)
- Distinguish Return (main keyboard) from Enter (numpad) via `e.code`
- Shift inverts the action
- `e.isComposing` → ignore (IME gets the key)
- Submit action → fire `onSubmit` callback
- Newline action → `document.execCommand("insertLineBreak")`

### 7. Selection guard integration

The app's selection guard uses CSS Custom Highlights for cross-card selection management. Without mitigation, this causes visual selection artifacts during arrow navigation near images.

**Fix:** suppress Custom Highlights inside the editor via CSS:
```css
.tug-prompt-input-editor ::selection,
.tug-prompt-input-editor::selection {
  background-color: Highlight;
  color: HighlightText;
}
.tug-prompt-input-editor::highlight(card-selection),
.tug-prompt-input-editor ::highlight(card-selection) {
  background-color: transparent !important;
  color: inherit !important;
}
.tug-prompt-input-editor::highlight(inactive-selection),
.tug-prompt-input-editor ::highlight(inactive-selection) {
  background-color: transparent !important;
  color: inherit !important;
}
```

**Critical:** do NOT use `-webkit-user-modify: read-write-plaintext-only`. It strips `<img>` elements from `execCommand("insertHTML")`, breaking atom paste. Standard contentEditable with the Custom Highlight suppression above is correct.

---

## ContentEditable Setup

The editor div:
```html
<div
  contenteditable
  class="tug-prompt-input-editor"
  style="line-height: 24px"  /* accommodates 22px atom images without layout shift */
  data-return-action="submit"
  data-enter-action="submit"
>
```

No `-webkit-user-modify`. No `white-space: pre-wrap` (standard contentEditable handles whitespace). Line breaks via `<br>` (native `insertLineBreak` behavior).

---

## Read API (getText / getAtoms)

Read directly from the DOM. No parallel model.

- **getText()**: walk `editor.childNodes`. Text nodes → their content. `<img data-atom-label>` → U+FFFC. `<br>` → `\n`. Join.
- **getAtoms()**: `editor.querySelectorAll("img[data-atom-label]")` → map to `AtomSegment` objects from data attributes.
- **getSelectedRange()**: use `window.getSelection()` and a DOM walk to compute flat offsets. Same flat offset convention: text chars = 1, atoms = 1.

These are computed on demand, not maintained as state.

---

## What We're Removing

The following infrastructure from the old TugTextEngine is no longer needed:

- **Segment array as source of truth** — DOM is the source of truth
- **MutationObserver + handleMutations** — no model to sync
- **Reconciler (reconcile method)** — no model to render
- **domPosition / flatFromDOM mapping** — no parallel model to map between
- **ZWSP cursor anchors** — atoms are `<img>`, caret works natively
- **ce=false anchor spans** — no ce=false elements in the flow
- **rootPosition helper** — was compensating for ce=false caret issues
- **selectionchange handler for caret fixup** — caret positions correctly natively
- **Arrow key interception for basic navigation** — browser handles it (we only intercept Option+Arrow for word boundaries)
- **Two-step atom deletion state (highlightedAtomIndices)** — click selects the image natively, backspace deletes it
- **hasAdjacentAtom / needsZWSP logic** — no ZWSP, no anchors
- **Badge DOM creation (createAtomBadgeDOM)** — replaced by createAtomImgElement

---

## What We're Keeping (adapted)

- **Typeahead state machine** — `@` trigger, query filtering, accept/cancel/navigate. Tightly coupled to cursor position. Adapted to work with DOM-based cursor position instead of flat offset model.
- **Completion provider interface** — `(query: string) => CompletionItem[]` callback.
- **Drop handler interface** — `(files: FileList) => AtomSegment[]` callback.
- **Tugbank persistence** [L23] — serialize editor innerHTML + selection. Restore on mount.
- **Delegate API surface** — `getText()`, `getAtoms()`, `insertAtom()`, `focus()`, `clear()`, `getSelectedRange()`, `setSelectedRange()`. Implementations read/write DOM directly.

## What We're Removing (obsolete infrastructure)

The following was built to test and support the parallel editing engine. The engine is gone; the infrastructure goes with it.

- **TEOI (Text Editing Operation Inventory)** — formal catalog of editing operations as state machine transitions on a segment model. No segment model anymore.
- **TEOE (Text Editing Operation Examples)** — concrete test triples with incoming/outgoing `TugTextEditingState`. The TEOE framework is gone; `TugTextEditingState` itself evolves into the new persistence format (see Step 5).
- **`tug-text-editing-operations.ts`** — the TEOI/TEOE framework, builder helpers, operation taxonomy. All of it.
- **`tug-integration-tests.ts`** — 154 integration tests that tested the old engine's model state, domPosition, flatFromDOM, ZWSP handling, etc. Not applicable to the new architecture.
- **`tug-text-visible-units.ts`** — visible units as pure functions over `Segment[]`. Needs reimplementation for DOM traversal if we want Option+Delete granularity.
- **`tug-atom-dom-tests.ts`** — tested the old ce=false badge DOM structure.
- **`/api/eval` test pipeline** — `__runIntegrationTests`, `__runTEOETests`, `__runIMETests`, `__runAtomDOMTests`, `__getTestDelegate`. The formal test suites are removed; the `/api/eval` endpoint itself stays as a general debugging tool.
- **`/api/key` (simulateKey)** — trusted key event simulation via NSEvent. Was needed because we intercepted arrow keys. We don't intercept basic navigation anymore.
- **Clone-and-marker caret measurement** — was compensating for unreliable caret positioning near ce=false elements. With `<img>` atoms, caret positions correctly. If we need caret measurement later, we can rebuild it, but it's not part of the core architecture.

---

## Principle: the spike is frozen

The IMG atom spike in `gallery-prompt-input.tsx` (the "IMG Atom Spike" section) is a **read-only reference** for the new architecture. It contains the proven patterns for atom creation, clipboard handling, drag & drop, word boundaries, key configuration, and selection guard integration.

The spike is preserved exactly as-is while we clean up and reimplement. None of the fresh tug-prompt-input implementation imports or depends on the spike code. The spike is a reference, not a dependency. Implementation code goes into proper standalone component locations (`tug-prompt-input.tsx`, `tug-prompt-input.css`, and supporting modules).

Once the properly-refactored tug-prompt-input is working and verified, the spike section is retired and deleted from the gallery card.

---

## Execution Order

### Step 1: Clean up — remove obsolete infrastructure

Remove the dead code from the old engine-based architecture. This comes first so we have a clean codebase before building the replacement.

- Delete `lib/tug-text-editing-operations.ts` (TEOI/TEOE framework)
- Delete `lib/tug-integration-tests.ts` (old integration test suite)
- Delete `lib/tug-atom-dom-tests.ts` (old atom DOM tests)
- Delete `lib/tug-text-visible-units.ts` (segment-model visible units)
- Remove `simulateKey` message handler from `MainWindow.swift` (trusted key events no longer needed — registration in `setupWebView`, handler in `userContentController`, teardown in `cleanupMessageHandlers`)
- Remove `loadLocalFile` method from `MainWindow.swift` (spike-only, not needed going forward)
- Remove `/api/key` endpoint from `tugcast/src/server.rs`
- Remove `__runIntegrationTests`, `__runTEOETests`, `__runIMETests`, `__runAtomDOMTests`, `__getTestDelegate` from gallery card (keep `/api/eval` endpoint as general debugging tool)
- Keep `TugTextEditingState`, `captureEditingState`, `formatEditingState` for now — persistence depends on them. Migrated in Step 5.
- Clean up gallery card: remove TEOE test runner UI, atom DOM test runner UI, integration test runner buttons. Keep the spike section and the interactive editor section.

### Step 2: Strip TugTextEngine

Gut the engine down to what we actually need. Remove:
- Segment array, normalizeSegments, cloneSegments
- MutationObserver + handleMutations + rebuildFromDOM
- Reconciler (reconcile method, domNodes, domChildren)
- domPosition, flatFromDOM, segmentPosition, rootPosition, hasAdjacentAtom
- ZWSP infrastructure, anchor span creation
- Arrow key interception for basic navigation (keep Option+Arrow for word boundaries)
- selectionchange handler for caret fixup
- highlightedAtomIndices, two-step deletion state
- Badge DOM creation (createAtomBadgeDOM)
- Kill ring, transpose, openLine (reimplement later if needed, directly on DOM)

Keep the shell: React component, useLayoutEffect setup, imperative handle, props interface, auto-resize, placeholder.

### Step 3: Implement the new architecture

Replace the no-op engine stubs with a working editor built on native contentEditable + `<img>` atoms. The DOM is the source of truth — no parallel document model. Code written fresh, referencing the spike but not importing from it.

#### Sub-step 3.1: Create `lib/tug-atom-img.ts` (new file)

Extract from the spike into a standalone module:
- `ATOM_ICON_PATHS` — Lucide-style icon paths (24×24 viewBox)
- `measureTextWidth(text, font)` — canvas-based text measurement
- `createAtomImgElement(type, label, value)` → `HTMLImageElement` with SVG data URI
- `atomImgHTML(type, label, value?)` → HTML string for `execCommand("insertHTML")`

No dependency on old `tug-atom` badge code. Colors hardcoded initially (Step 6 adds theming).

#### Sub-step 3.2: Implement `TugTextEngine` methods

Replace no-op stubs with DOM-reading implementations in `tug-text-engine.ts`. No segment model — read directly from the contentEditable div.

**Read API (DOM is truth):**
- `getText()` — walk `root.childNodes`, replace `<img data-atom-label>` with U+FFFC, `<br>` with `\n`, text nodes as-is
- `getAtoms()` — `root.querySelectorAll("img[data-atom-label]")`, return `AtomSegment[]` from data attributes
- `isEmpty()` — `root.textContent === ""` and no atom images
- `getSelectedRange()` / `setSelectedRange()` — flat-offset ↔ DOM position conversion via child node walk (count text chars + 1 per atom + 1 per `<br>`)

**Mutation API (all via execCommand for native undo):**
- `insertText(text)` — `document.execCommand("insertText", false, text)`
- `insertAtom(atom)` — `atomImgHTML` + `document.execCommand("insertHTML", false, html)`
- `clear()` — `root.innerHTML = ""; onChange()`
- `selectAll()` — `document.execCommand("selectAll")`
- `focus()` — `root.focus()`
- Delete methods — `execCommand("delete")` / `execCommand("forwardDelete")`. Word/paragraph granularity: `setSelectedRange` to the boundary, then `execCommand("delete")`
- `undo()` / `redo()` — `document.execCommand("undo")` / `document.execCommand("redo")` (browser's native stack)

**Deferred (stubs for now):**
- `captureState()` / `restoreState()` — keep returning empty state (Step 5 migrates persistence)
- `killLine` / `yank` / `transpose` / `openLine` — implement in Step 8
- `flushMutations()` — no-op, no MutationObserver

#### Sub-step 3.3: Wire event handlers in `setupEvents()` / `teardown()`

Called from constructor, cleaned up in `teardown()`. All proven in the spike:

1. **Return/Enter** — keydown: `e.isComposing` guard, read action from config, submit callback or `execCommand("insertLineBreak")`
2. **Click on atom** — click: if target is `img[data-atom-label]`, select entire image via `Range.selectNode`
3. **Option+Arrow** — keydown: browser word move + atom boundary clamping via `Range.compareBoundaryPoints`
4. **Copy** — copy: write `text/html` (preserves img tags) + `text/plain` (atoms → labels)
5. **Cut** — cut: same as copy, then `execCommand("delete")`
6. **Paste** — paste (capture phase): if HTML has `data-atom-label`, extract body content, `execCommand("insertHTML")`. If no atoms, strip markup, `execCommand("insertText")` (rich text blocking)
7. **Drag & drop** — dragover: `preventDefault` + `dropEffect="copy"`. drop: `caretRangeFromPoint` + build atom imgs + `execCommand("insertHTML")`
8. **Rich text blocking** — beforeinput: reject `formatBold`, `formatItalic`, `formatUnderline`, etc.
9. **Change detection** — input event: fire `onChange` callback, update `data-empty` attribute
10. **Auto-resize** — input event (same handler): `root.style.height = Math.min(scrollHeight, maxHeight)`

**IME guards:** Every intercepted keydown handler checks `e.isComposing` and bails out during IME composition. This applies to: Option+Arrow, Return/Enter, and any future key handlers.

#### Sub-step 3.4: Update CSS (`tug-prompt-input.css`)

- Remove `-webkit-user-modify: read-write-plaintext-only` (blocks `insertHTML` with images)
- Remove `.tug-cursor-anchor` (ZWSP infrastructure gone)
- Set `line-height: 24px` (accommodates 22px atom images without layout shift)
- Custom Highlight suppression already in place — keep it

#### Sub-step 3.5: Verify

- `bun run check` passes
- Gallery card renders working editor: type text, insert atoms via button, copy/paste atoms, drag files, Option+Arrow stops at atoms, click atom selects it, Return submits

#### Sub-step 3.6: Fix stale docstrings

- `tug-text-engine.ts` module docstring still says "stripped shell" and "no-op stubs" — rewrite to describe the DOM-based implementation
- `tug-prompt-input.tsx` line 6 references `tug-atom's createAtomDOM (T3.1)` — update to reflect `<img>` atom architecture
- `_compositionJustEnded` comment says "cleared at end of the event loop turn" — update to say "cleared on keyup"

#### Sub-step 3.7: Fix LINE_HEIGHT mismatch

`tug-prompt-input.tsx` has `const LINE_HEIGHT = 21` but CSS sets `line-height: 24px`. The constant is used for `maxHeight` calculation. Fix to `24`.

#### Sub-step 3.8: Wire the dropHandler prop

The drop event handler in `setupEvents` hardcodes file-to-atom conversion. It never calls `this.dropHandler`. When a `dropHandler` prop is provided, delegate to it. Keep the hardcoded logic as the fallback when no handler is set.

#### Sub-step 3.9: Extract shared clipboard helper

Copy and cut handlers duplicate ~20 lines of clipboard-writing logic. Extract a private method (e.g., `writeSelectionToClipboard`) called by both.

#### Sub-step 3.10: Escape SVG label text

`tug-atom-img.ts` interpolates `label` directly into SVG `<text>` content. Characters like `<`, `>`, `&`, `"` will produce malformed SVG. Escape them.

#### Sub-step 3.11: Harden flat ↔ DOM offset conversion

Two issues in the offset helpers:

1. **`domToFlat` nested nodes:** If the selection lands inside a nested element (e.g., a `<span>` WebKit inserts during paste or undo), `domToFlat` falls through silently and returns a wrong offset. Walk up from `node` to find its root-level ancestor before matching.

2. **`flatToDom` position after atom:** When `remaining === 0` on an atom/BR, the function returns `{ node: root, offset: i }` — position *before* the element. But if we consumed the atom's character to get here, we need position *after* it (`offset: i + 1`). This causes selection to land before an atom when it should land after.

#### Sub-step 3.12: Delete dead code

- Remove `flushMutations()` from `TugTextEngine` and `TugTextInputDelegate`. No MutationObserver means no flush. No "no-op for API compatibility" — dead code gets deleted.
- Remove `flushMutations()` call from `tug-prompt-input.tsx` imperative handle.
- Remove `getHighlightedAtomIndices` / `setHighlightedAtomIndices` — two-step deletion is gone, highlighted atom indices are vestigial. Remove from delegate interface, engine, and imperative handle.
- Remove `canUndo` / `canRedo` — browser's `execCommand("undo")` silently no-ops when there's nothing to undo, and we can't query the browser's undo state. Lying about it is worse than not exposing it. Remove from delegate interface, engine, and imperative handle.
- Audit for any other dead delegate methods that have no real implementation.

#### Sub-step 3.13: Minor cleanup

- `measureTextWidth` in `tug-atom-img.ts` is exported but only used internally — make it module-private.
- Option+Arrow handler should also check `_compositionJustEnded` for consistency with Enter handler.

#### What Step 3 does NOT build

- Typeahead (Step 4)
- Persistence (Step 5 — `captureState`/`restoreState` stay as stubs)
- Theme-aware atom colors (Step 6)
- Option+Delete word granularity (Step 8)
- `killLine`/`yank`/`transpose`/`openLine` (Step 8)

#### Key architectural decisions

- **`execCommand` for everything** — typing, insertions, deletions all go through the browser's editing pipeline. Native undo for free.
- **DOM is truth** — `getText()`, `getAtoms()`, `getSelectedRange()` read from the DOM every time. No caching, no stale state.
- **IME: don't touch it** — every keydown handler checks `e.isComposing`. We never intercept basic arrow keys or typing. Browser handles IME natively.
- **Dead code gets deleted.** No no-op stubs for API compatibility. If it doesn't do anything, it doesn't exist.

### Step 4: Typeahead

Implement `@`-trigger typeahead in the DOM-based engine. When the user types `@`, a completion popup appears, filtered as they type. The engine owns the state machine; the popup is a proper component using our design system.

#### Sub-step 4.1: Add typeahead state to the engine

Private state on `TugTextEngine`:
```typescript
private _typeahead = {
  active: false,
  query: "",
  anchorOffset: 0,  // flat offset of the @ character
  filtered: [] as CompletionItem[],
  selectedIndex: 0,
};
```

The old engine tracked `anchorSegment` + `anchorOffset` in segment-model terms. We track a single flat character offset — DOM is truth.

#### Sub-step 4.2: Detect `@` trigger

In the existing `input` event handler, after `updateEmpty`/`autoResize`/`onChange`:
- If typeahead is not active and `completionProvider` is set
- Read the character just before the caret (walk DOM backward one position)
- If it's `@`, activate: record the flat offset, call `completionProvider("")`, emit `onTypeaheadChange`

Detection happens in the `input` handler — the DOM is already updated, so the `@` is present.

#### Sub-step 4.3: Update query on every input

When typeahead is active and `input` fires:
- Read text from `anchorOffset + 1` to the current caret position (the query)
- If caret moved before the `@`, cancel
- Call `completionProvider(query)` with the extracted query
- Update `filtered`, clamp `selectedIndex`
- Emit `onTypeaheadChange`

#### Sub-step 4.4: Key interception during typeahead

New keydown listener registered early (before Enter/Option+Arrow handlers):
- If typeahead is not active, bail
- **Tab or Enter:** `preventDefault`, accept the selected completion
- **ArrowDown:** `preventDefault`, increment `selectedIndex`
- **ArrowUp:** `preventDefault`, decrement `selectedIndex`
- **Escape:** `preventDefault`, cancel typeahead
- All other keys: fall through (typing updates query via input event)
- IME guard: `e.isComposing` → bail

#### Sub-step 4.5: Accept completion

When the user accepts (Tab/Enter or click on popup item):
- Get the selected `CompletionItem`
- Delete the `@query` text: `setSelectedRange(anchorOffset, anchorOffset + 1 + query.length)` then `execCommand("delete")`
- Insert the atom: `execCommand("insertHTML", false, atomImgHTML(...))`
- Cancel typeahead state
- All via execCommand → undoable

#### Sub-step 4.6: Cancel typeahead

Set `active = false`, emit `onTypeaheadChange(false, [], 0)`. Triggered by:
- Escape key
- Caret moves before the `@` anchor
- Editor blur
- `clear()` called

#### Sub-step 4.7: Public API

Add to `TugTextInputDelegate` and the imperative handle:
- `acceptTypeahead(): void`
- `cancelTypeahead(): void`
- `typeaheadNavigate(direction: "up" | "down"): void`
- `readonly isTypeaheadActive: boolean`

#### Sub-step 4.8: TugCompletionMenu component

A new library component following [component-authoring.md](../tuglaws/component-authoring.md):
- `tug-completion-menu.tsx` + `tug-completion-menu.css` in `tugdeck/src/components/tugways/`
- Module docstring with law citations ([L06], [L15], [L16], [L19])
- Exported props interface with JSDoc and `@selector` annotations
- `data-slot="tug-completion-menu"` on root element
- `@tug-pairings` (compact + expanded table) declaring all foreground-on-background relationships
- `@tug-renders-on` on every foreground rule without a co-located background
- All colors via `--tug7-*` tokens, zero hardcoded colors
- State selectors in canonical order (rest → hover → active)

**Props:**
- `items: CompletionItem[]` — filtered completion items
- `selectedIndex: number` — which item is highlighted
- `onAccept: (index: number) => void` — called when an item is clicked
- `anchorRect: DOMRect | null` — caret position for placement
- `containerRef: React.RefObject<HTMLElement>` — editor container for relative positioning

**Design:**
- Floating panel positioned above/below the caret (prefers above, flips if no room)
- Each item shows the atom type icon + label
- Selected item uses token-driven highlight state
- Click on item calls `onAccept`
- No keyboard handling — that's the engine's job (Sub-step 4.4)
- Mount/unmount driven by whether `items.length > 0`

#### Sub-step 4.9: Wire TugCompletionMenu into TugPromptInput

`TugPromptInput` manages the completion menu internally:
- Engine emits `onTypeaheadChange(active, filtered, selectedIndex)`
- Component stores these in refs (L06 — appearance via DOM, not React state) or minimal state for the popup
- Renders `TugCompletionMenu` when active, passing caret rect from `Range.getBoundingClientRect`
- `onAccept` callback calls `engine.acceptTypeahead(index)` (engine sets selected index then accepts)
- The parent (gallery card) no longer builds the popup with raw DOM — `handleTypeaheadChange`, `popupRef`, and the popup CSS in `gallery-prompt-input.css` become dead code and get removed

#### Step 4 scope: UI/UX only

Step 4 builds the typeahead *mechanism* — trigger detection, state machine, popup component, accept/cancel. It does not build the real data source or matching algorithm.

**Mock data source:** The gallery card's `galleryCompletionProvider` uses a hardcoded file list with `String.includes()` matching. This is sufficient to prove the UI works end-to-end. The mock is clearly demarcated (it lives in the gallery card, not in library code).

**Deferred to later steps:**
- Real completion data source (project file tree from source tree path via tugbank/tugcast)
- Fuzzy/subsequence matching algorithm (typing "fst" matches "feed-store.ts")
- Multiple completion categories (files, commands, docs, links)

These are pluggable via the `CompletionProvider` callback — the engine doesn't care where data comes from or how matching works. The real provider replaces the mock when the prompt input is wired into the Tide shell.

### Step 5: Persistence

Migrate the editing state format from the old segment model to a DOM-friendly representation. The persistence mechanism (`useTugcardPersistence` via Tugcard → tugbank) is already wired — only the state format and the `captureState`/`restoreState` implementations need to change.

Must survive reload, app quit, `just app` [L23].

#### Sub-step 5.1: Define the new state format

Replace `TugTextEditingState` with a DOM-friendly format:
```typescript
export interface TugTextEditingState {
  text: string;                  // plain text with U+FFFC at atom positions
  atoms: { position: number; type: string; label: string; value: string }[];
  selection: { start: number; end: number } | null;
}
```

- `text` + `atoms` replace `segments[]` — same information, reads directly from DOM via `getText()`/`getAtoms()`
- `position` is the index of the U+FFFC character in `text` for each atom (for ordered reconstruction)
- Each atom is serialized as `{ type, label, value }` — its identity. The label is semantic data (the human-readable name chosen by the completion provider or drop handler), not visual data. The SVG is generated at render time from type + label.
- No SVG, no visual data in the persisted state
- `selection` preserved — restoring cursor position across reload is a real feature
- `markedText` dropped — IME composition is transient, never persists across sessions
- `highlightedAtomIndices` dropped — vestigial from two-step delete

This is a breaking change to the persisted format. Existing saved state from the old format will fail to restore. This is fine — the old format produced no useful data (captureState was a stub returning empty state).

#### Sub-step 5.2: Implement `captureState()`

Replace the stub with a real implementation:
- `text` = `this.getText()`
- `atoms` = `this.getAtoms()` mapped to `{ position, type, label, value }` — position is the index of each U+FFFC in `text`
- `selection` = `this.getSelectedRange()`

All reads from DOM. No segment model.

#### Sub-step 5.3: Implement `restoreState()`

Rebuild the DOM from the saved state:
1. Build HTML string: walk `text`, emit text runs (with `\n` → `<br>` conversion), emit `atomImgHTML(atom.type, atom.label, atom.value)` at each U+FFFC position
3. Set `root.innerHTML` to the built HTML
4. Restore selection via `setSelectedRange` if selection was saved
5. Update `data-empty` attribute
6. Do NOT fire `onChange` — this is restoring previous state, not a user edit

All via DOM. No execCommand (this is not a user edit, it's reconstruction — undo stack should be clean after restore).

#### Sub-step 5.4: Clean up old format

- Remove `segments`, `markedText`, `highlightedAtomIndices` from `TugTextEditingState`
- Remove `Segment`, `TextSegment` types if no longer used elsewhere
- Update `TugPromptInputPersistence` — the empty-state fallback changes shape
- Remove any remaining references to the old format

#### Sub-step 5.5: Verify

- Type text + atoms, reload → content and cursor restored
- Empty editor, reload → stays empty
- Multiple atoms, reload → all atoms in correct positions
- `bun run check` passes

#### Sub-step 5.6: Audit fixes

Post-implementation audit found six issues:

1. **`restoreState` doesn't cancel typeahead.** If typeahead is active when state is restored (tab activation), `anchorOffset` points into the old DOM. Add `this.cancelTypeahead()` at the top.

2. **Typeahead popup anchored to current caret, not `@` position.** `onTypeaheadChange` re-reads `getBoundingClientRect` on every update, including as the user types query characters. The popup drifts rightward. Anchor to the `@` position captured at trigger time.

3. **`flatToDom` doesn't handle nested elements.** `domToFlat` was hardened with `rootChild`/`offsetWithin` for WebKit-inserted `<span>` wrappers, but `flatToDom` only walks direct children. If WebKit has wrapped text, `setSelectedRange` will land at the wrong position. Harden to match.

4. **`onTypeaheadChange` prop docstring is stale.** Says "parent renders the popup" — the parent no longer does. Update.

5. **Completion popup uses `useState` — violates [L06].** L06: "Appearance changes go through CSS and DOM, never React state." The completion menu is driven by `setCompletionState`, triggering React re-renders on every keystroke during typeahead. Fix: always render the popup container in the DOM, drive visibility and content via direct DOM writes from the engine's `onTypeaheadChange` callback. No React state for the popup.

6. **`restoreState` HTML builder is O(n²).** Character-by-character `+=` string concatenation. Use an array and `join`.

### Step 6: Theme change handling

Atom SVG colors are baked into `<img src="data:image/svg+xml,...">` data URIs at creation time. CSS custom property changes (from theme switching) don't reach inside data URIs. When the theme changes, all atom images must be regenerated with the new colors.

#### Sub-step 6.1: Create `theme-tokens.ts` module

New module: `tugdeck/src/theme-tokens.ts` — runtime API for the theme token system. Consolidates token value reading and theme change observation into one place.

```typescript
/** Read the current resolved value of a CSS custom property. */
getTokenValue(tokenName: string): string

/** Subscribe to theme change notifications. */
subscribeThemeChange(callback: () => void): void

/** Unsubscribe from theme change notifications. */
unsubscribeThemeChange(callback: () => void): void

/** Called by the theme provider when the theme changes. */
notifyThemeChange(): void
```

- `getTokenValue` encapsulates `getComputedStyle` — callers never see it
- Theme change observers backed by a `Set<() => void>`
- `notifyThemeChange` called by `TugThemeProvider` alongside its existing `setThemeState` call
- Gives non-React code a direct path to observe theme changes [L22]

#### Sub-step 6.2: Wire theme provider to `notifyThemeChange`

Update `theme-provider.tsx` to call `notifyThemeChange()` from `theme-tokens.ts` when the theme changes. One line added to the `setTheme` flow.

#### Sub-step 6.3: Read atom colors from tokens

Update `createAtomImgElement` in `tug-atom-img.ts` to read colors via `getTokenValue`:
- Background: `getTokenValue('--tug7-surface-atom-primary-normal-default-rest')`
- Border: `getTokenValue('--tug7-element-atom-border-normal-default-rest')`
- Icon stroke: `getTokenValue('--tug7-element-atom-icon-normal-default-rest')`
- Label text: `getTokenValue('--tug7-element-atom-text-normal-default-rest')`

Remove the hardcoded hex values. After this sub-step, newly created atoms pick up the current theme's colors. Existing atoms in the DOM still show old colors until regenerated.

#### Sub-step 6.4: Add `regenerateAtoms()` to the engine

A method on `TugTextEngine` that walks all `img[data-atom-label]` elements in the editor, reads their data attributes, builds a new SVG data URI with current theme colors via `createAtomImgElement`, and updates the existing `<img>` element's `src` attribute.

- **Minimal mutation [L23]:** Update `src` on the existing `<img>` — do not remove/insert DOM nodes. The element stays in place, selection is undisturbed.
- **Not via execCommand:** This is appearance, not user editing. The undo stack must not be touched.

#### Sub-step 6.5: Wire theme change to engine

`TugPromptInput` subscribes via `subscribeThemeChange` in a `useLayoutEffect`:
- On theme change, call `engine.regenerateAtoms()`
- Teardown calls `unsubscribeThemeChange`
- No React state, no re-render — direct DOM update in the callback [L22]

#### Sub-step 6.6: Verify

- Switch between brio and harmony themes — atom colors update immediately
- Create new atoms after theme switch — they use the new theme's colors
- Undo after theme switch — content is undone, atom colors remain current theme
- `bun run check` passes

### Step 7: Testing

Simple, direct tests on the real editor. A test function that exercises the editor and reports pass/fail results — not a formal state-machine framework, but not "no tests" either:

- Type text, check DOM content via `getText()`
- Insert atom, check it appears via `getAtoms()`
- Cut/paste atom, check round-trip
- Option+Arrow near atoms, check caret stops at boundary
- Drag file, check atom created
- Return key, check newline or submit
- Paste rich HTML from external source, verify only plain text arrives (no formatting)
- IME composition, verify no interference from event handlers
- Theme change, verify atom colors update

Tests run in the gallery card on the real component.

### Step 8: Emacs binding fixes

Native WebKit contentEditable handles Option+Delete word deletion, Cmd+Delete line deletion, and most Emacs bindings (Ctrl+K, Ctrl+Y, Ctrl+O, Ctrl+A, Ctrl+E) correctly with `<img>` atoms. Two gaps remain:

#### Sub-step 8.1: Implement Ctrl+U (kill line backward)

WebKit doesn't handle Ctrl+U in contentEditable. Add a keydown handler:
- Select from cursor to beginning of line (walk backward to previous `<br>` or start of content)
- Delete via `execCommand("delete")` — goes on the undo stack
- Store deleted content in the kill ring (already exists via native Ctrl+K)

#### Sub-step 8.2: Implement Ctrl+T (transpose with atoms)

Native Ctrl+T transposes text characters but doesn't handle atoms. Add a keydown handler:
- Read the two items flanking the cursor (each is either a text character or an atom `<img>`)
- If either is an atom, intercept: delete both, re-insert in swapped order via execCommand
- If both are text characters, let the browser handle natively

### Step 9: Remaining features

#### Sub-step 9.1: Consolidate atom rendering into tug-atom-img.ts

The React `TugAtom` component (`tug-atom.tsx`) predates the img-based atom architecture. Now that the engine uses `<img>` atoms exclusively, the React component is dead weight. This sub-step consolidates everything into `tug-atom-img.ts`.

**Move to `tug-atom-img.ts`:**
- `AtomSegment` interface (currently defined in `tug-atom.tsx`, imported by engine)
- `AtomLabelMode` type and `formatAtomLabel()` utility (label truncation/formatting)

**Add to `tug-atom-img.ts`:**
- `maxLabelWidth` option for `createAtomImgElement` — SVG-level text truncation with ellipsis, replacing CSS truncation that doesn't work inside `<img>` elements
- Consider label mode support (filename/relative/absolute) as an option on the create function

**Delete:**
- `tug-atom.tsx` — React component, `createAtomBadgeDOM`, `createAtomDOM`, `DOM_ICON_SVGS`, `ICON_MAP`, all props/states (selected, highlighted, disabled, dismissible)
- `tug-atom.css` — all styles for the old React component

**Update imports:**
- `tug-text-engine.ts` — import `AtomSegment` from `tug-atom-img` instead
- `gallery-atom.tsx` — rewrite to showcase img-based atoms: all types, inline with text, label modes, truncation

**Gallery card rewrite:**
- Show all atom types as `<img>` elements (via `createAtomImgElement`)
- Label mode switcher (filename/relative/absolute) using `formatAtomLabel`
- Truncation demo with long labels
- Inline-with-text sample showing atoms in a text flow

**Do NOT carry forward:**
- React component states (selected, highlighted, disabled) — the engine handles selection natively via browser `::selection`
- Dismiss affordance (hover X icon) — deferred; needs engine-level event delegation for contentEditable
- `contentEditable="false"` badge DOM path — replaced by `<img>` atoms entirely

#### Sub-step 9.2 and beyond (remaining)

- [x] History navigation (up/down at document boundaries)
- [x] Auto-resize (1 row → maxRows) — already implemented via `autoResize()` and `maxRows` prop
- [ ] DEFER: Prefix detection (first-character routing)

### Step 10: Retire the spike

Once tug-prompt-input is working and verified with all the above features, remove the spike section from the gallery card. The gallery card's interactive editor section remains as the testing surface for the real component.

---

## Key Lessons

### The browser is smarter than us

We spent days building a parallel document model, reconciler, and caret fixup layer. The browser does all of this correctly for `<img>` elements. The lesson: use the browser's editing engine, don't replace it. Customize at the edges (clipboard, word boundaries, key config), not at the core (caret movement, undo, selection).

### contentEditable="false" is poison for inline elements

It works for block-level non-editable regions. For inline elements in a text flow, it breaks caret navigation in every browser. The entire web editing ecosystem (ProseMirror, Lexical, Slate) struggles with this. The fix: don't use it. Use `<img>` replaced elements instead.

### `-webkit-user-modify: read-write-plaintext-only` blocks image operations

It strips `<img>` elements from `execCommand("insertHTML")`, breaking atom paste. It also prevents the browser from inserting images via drop. Standard contentEditable with CSS Custom Highlight suppression is the correct setup.

### The selection guard's CSS Custom Highlights cause visual artifacts

The app's selection guard paints selection via the CSS Custom Highlight API. Inside a contentEditable with images, this causes spurious selection highlighting during arrow navigation. The fix: suppress Custom Highlights inside the editor element and re-enable native `::selection`.

### Tests must verify what the user sees

Automated tests that check model state but not visual behavior are dangerous — they pass while the product is broken. The clone-and-marker technique for caret measurement, and testing on the real interactive editor, are essential.

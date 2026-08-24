# T3.0 Text Model Spike — Findings

*Spike conducted 2026-04-02. Three approaches tested, then the engine-based approach (C-done-right) was built and validated in the Component Gallery.*

## Approaches Tested

### Approach A: Textarea + Overlay Mirror

Hidden `<textarea>` for input capture with transparent text. Visible mirror div positioned behind renders styled text + atom pills. Caret comes from the real textarea.

**Result: Non-functional.** Arrow keys cannot navigate past atoms. The textarea treats the atom placeholder character (U+FFFC) as a single character, but cursor movement in the textarea doesn't correspond to spatial positions in the overlay when atom pills have different visual widths than placeholder characters. Fundamental spatial correspondence problem with proportional fonts.

### Approach B: Thin contentEditable

`contentEditable` div with `role="textbox"` and `aria-multiline="true"`. Plain text nodes interspersed with inline `<span contentEditable="false">` atom pill elements.

**Result: Best surface-level result, but deeply flawed.** See detailed findings below.

### Approach C: Hidden Textarea + Rendered Div (original)

Hidden `<textarea>` captures all keyboard input. Separate visible div renders content (text + atoms). The textarea is the input device; the div is the display.

**Result: Correct architecture but the initial implementation had no blinking insertion point.** Abandoned early — but this is what ProseMirror, CodeMirror 6, and Lexical all do (all MIT licensed).

### Approach C-Done-Right: Engine-Based contentEditable

contentEditable div used as **input capture surface only**. Own document model (segment array) is the source of truth. DOM reconciled from model. MutationObserver reads browser text changes back into model. Native browser caret. Own undo stack.

**Result: Working.** This is the chosen architecture. See "Engine Findings" below.

---

## Approach B Detailed Findings

### What Worked

| Feature | Status | Notes |
|---------|--------|-------|
| Basic typing | OK | English text input works |
| Arrow key movement | OK | Cursor moves past atoms |
| Shift+arrow selection | OK | Selection extends correctly |
| Japanese IME composition | OK | Hiragana → kanji conversion works, composition underline appears correctly |
| VoiceOver | OK | Atom labels announced when cursor enters atom (role="img" + aria-label) |
| Auto-resize | OK | Grows from 1 row up to maxRows, caps with overflow scroll |
| Drag-and-drop | OK | Files from Finder create file atoms |
| Paste as plain text | OK | `clipboardData.getData("text/plain")` + `document.execCommand("insertText")` strips formatting |

### What Failed

| Issue | Severity | Root Cause |
|-------|----------|------------|
| **Spurious marked text** | Critical | macOS/WebKit treats contentEditable text as having an active input session. US keyboard typing appears "marked" (underlined) as if IME composition is active. |
| **Cmd+A selects entire page** | High | Card keybinding system has document-level capture-phase handler that fires before element-level handlers. Dispatches `selectAll` to card content area, not the editor. |
| **Click+drag to select text doesn't work** | High | SelectionGuard's pointer tracking (L12) intercepts pointer events, interfering with contentEditable selection. |
| **Cursor enters atom interior** | High | Despite `contentEditable="false"` on atom spans, the browser places the caret inside after `execCommand('insertHTML')`. |
| **Insertion point after atom insertion is wrong** | High | `execCommand('insertHTML')` leaves caret inside atom span. |
| **Undo repositions atoms instead of removing them** | High | `execCommand('insertHTML')` integrates with browser undo but undo semantics don't match our intent. |
| **Enter during IME composition submits** | High | WebKit fires `compositionend` BEFORE the `keydown` for Enter. So when Enter arrives, `isComposing` is false and `composingIndex` is null. |
| **Return and Enter are conflated** | Medium | `e.code === "Enter"` (Return) vs `e.code === "NumpadEnter"` (numpad Enter). Must be independently configurable. |
| **CSS Custom Highlight paints incorrectly** | High | Card system suppresses native `::selection` and uses CSS Custom Highlight API. The Highlight API doesn't track contentEditable selection correctly, painting stale ranges. |

---

## Engine Findings (Approach C-Done-Right)

The engine-based implementation validated the architecture. Key findings:

### What Works

| Feature | Status | Notes |
|---------|--------|-------|
| Text typing | OK | MutationObserver reads browser changes back to model (CM6 fast path) |
| Atom insertion | OK | Model split + reconcile. Cursor lands after atom. |
| Two-step atom delete | OK | Backspace adjacent to atom → highlights. Second press deletes. Click atom also selects. |
| Undo/redo | OK | Immutable segment snapshots. Merge within 300ms. |
| IME composition | OK | `composingIndex` tracks composing segment. Reconciler skips it. |
| IME Enter acceptance | OK | `compositionEndedAt` timing window (100ms) catches WebKit ordering bug. |
| Return vs Enter | OK | `e.code` distinguishes. Independent configuration per key. Shift inverts. |
| Cmd+A scoped | OK | Fixed in tug-card.tsx: selectAll checks `document.activeElement` for contentEditable. |
| Native selection | OK | Re-enabled `::selection` in editor, suppressed `::highlight(card-selection)`. |
| Auto-resize | OK | Direct DOM height manipulation (L06). |
| Paste as plain text | OK | Intercept paste event, insert via model. |
| Placeholder | OK | `data-empty` attribute driven by engine, CSS `::before` pseudo-element. Clears on composition start. |

### Patterns That Proved Correct

1. **"Let the browser mutate, diff afterward"** for normal text typing. `beforeinput` with `insertText` type is NOT prevented. The browser inserts the character. MutationObserver reads it back. Model updated. DOM is already correct — no reconcile needed. This is the fast path.

2. **Text-atom-text invariant.** Segments always alternate: text, atom, text, atom, text. Text segments exist at boundaries and between every pair of atoms. Empty text segments are allowed. This guarantees the cursor is always in a Text node — never inside an atom.

3. **Native browser caret.** We do NOT render our own cursor. `sel.collapse(node, offset)` positions it. The browser renders it. This eliminates the "colossal pain" of cursor rendering from Approach C.

4. **Reconciliation skips the composing node.** During IME composition (`composingIndex !== null`), the reconciler returns immediately. The browser is freely mutating the composing Text node. We pick up the result on `compositionend`.

5. **Own undo stack with immutable snapshots.** `cloneSegments()` before each mutation. Merge heuristic: consecutive same-type edits within 300ms collapse. Browser undo (`historyUndo`/`historyRedo` beforeinput types) is intercepted and redirected to our stack.

6. **Flat offset as universal position type.** Text characters count as 1 each, atoms count as 1 each. Selection, undo cursor restoration, and DOM position mapping all use flat offsets. `segmentPosition(flat)` converts to segment index + local offset.

### Browser/Platform Bugs Fixed

1. **WebKit `compositionend` before `keydown` for Enter.** Safari fires `compositionend`, then Enter keydown arrives with `isComposing=false`. Fix: `compositionEndedAt` timestamp + 100ms window. CM6 uses the same pattern.

2. **CSS Custom Highlight API vs contentEditable.** The card system's `::highlight(card-selection)` paints stale/incorrect highlights inside contentEditable. Fix: re-enable native `::selection` and suppress Custom Highlight via CSS override inside the editor element.

3. **Card selectAll ignores first responder.** The keybinding system dispatches `selectAll` to the card regardless of focus. Fix: tug-card.tsx `handleSelectAll` checks `document.activeElement` for contentEditable and scopes `selectAllChildren` to it.

4. **Spurious composition markers on US keyboard.** `-webkit-user-modify: read-write-plaintext-only` tells WebKit the field is plain-text, preventing the macOS text input system from adding composition styling.

5. **Placeholder not clearing during IME.** The model is empty during composition (hasn't committed yet), so `isEmpty()` returns true. Fix: set `data-empty="false"` on `compositionstart`.

### System Changes Made During Spike

| File | Change | Reason |
|------|--------|--------|
| `tug-card.tsx` | `handleSelectAll` respects contentEditable first responder | Cmd+A was selecting entire card content instead of editor |

---

## Architecture: Two-Layer Design

### Layer 1: Engine (TugTextEngine)

A plain TypeScript class (not a React component). Owns:

- **Document model**: `segments: (TextSegment | AtomSegment)[]` with text-atom-text invariant
- **DOM reconciler**: renders segments → DOM nodes, reuses existing nodes, skips during composition
- **MutationObserver**: reads browser text changes back into model (fast path for typing)
- **Composition tracker**: `composingIndex` + `compositionEndedAt`
- **Undo stack**: immutable segment snapshots with merge heuristic
- **Event handlers**: keydown, beforeinput, compositionstart/end, paste, click

The engine attaches to a `<div contentEditable>` provided by the component.

### Layer 2: API (UITextInput-inspired)

```typescript
interface TugTextInputDelegate {
  // --- Text storage ---
  readonly text: string;
  readonly segments: readonly Segment[];

  // --- Selection ---
  selectedRange: { start: number; end: number } | null;
  // selectionAffinity: future — upstream/downstream at soft line breaks

  // --- Marked text (composition / IME) ---
  hasMarkedText: boolean;
  markedTextRange: { start: number; end: number } | null;

  // --- Text mutation ---
  insertText(text: string): void;
  insertAtom(atom: AtomSegment): void;
  deleteBackward(): void;
  deleteForward(): void;

  // --- Undo ---
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;

  // --- Key handling ---
  returnAction: "submit" | "newline";
  numpadEnterAction: "submit" | "newline";
  // Shift always inverts. hasMarkedText=true → key goes to IME.

  // --- Lifecycle ---
  clear(): void;
  selectAll(): void;
}
```

### Component Integration

The React component (tug-prompt-input) creates the engine in `useLayoutEffect` (L01) and never re-renders for text content changes. All text/atom rendering happens in the DOM zone (L06). Status updates use direct DOM writes via `onChange` callback (L22). The engine instance is accessed via ref (L07).

### tug-atom: Dual Rendering Paths

tug-atom is a proper tugways component (L19) with two rendering paths:

1. **React path**: `<TugAtom type="file" label="src/main.ts" />` — for gallery card, standalone usage
2. **DOM path**: `TugAtom.createDOM(seg)` — static method for engine reconciler inside contentEditable

Both produce identical DOM structure, same CSS classes, same data attributes, same a11y. The engine calls the DOM path during reconciliation.

---

## Reference Implementations Studied (All MIT)

### CodeMirror 6 (`@codemirror/view`)

- contentEditable as input surface (switched from textarea in v5)
- Let browser mutate DOM, read back via MutationObserver + DOM diffing
- Native browser caret (no custom cursor rendering)
- Composition: find composed Text node, tag for reuse during re-render
- Own undo stack via transaction system
- ~30 browser-specific workarounds (Android Chrome, iOS Safari, Firefox)
- EditContext API for Android Chrome 126+

### Lexical (`lexical`)

- contentEditable as input surface with command pattern
- "Uncontrolled fast path": normal single-char typing flows through browser, synced back via MutationObserver
- DecoratorNode = atom equivalent (`contentEditable="false"`, keyboard-selectable)
- `_compositionKey` tracks composing node, transforms/history skip it
- Own undo stack with immutable editor state snapshots
- MutationObserver as safety net to revert external DOM changes

### Key Patterns Adopted

| Pattern | Source | How Used |
|---------|--------|----------|
| Let browser mutate, diff afterward | CM6 | MutationObserver fast path for typing |
| Native browser caret | CM6 | No custom cursor rendering |
| DecoratorNode (atom) | Lexical | `contentEditable="false"` spans, model-enforced atomicity |
| Composition key | Lexical | `composingIndex` tracks composing segment |
| `compositionEndedAt` timing | CM6 | Swallow Enter within 100ms of compositionend |
| Own undo stack | Both | Immutable snapshots, merge heuristic |
| MutationObserver safety net | Lexical | `rebuildFromDOM()` for unexpected structural changes |

---

## What Was Not Tested in the Spike

- Chinese pinyin IME
- Screen reader with atom selection/deletion flow end-to-end
- Multiple atoms adjacent (the text-atom-text invariant handles this but untested)
- Very long text performance (scrolling + many atoms)
- Complex undo sequences across atom insertion/deletion
- Word-level and line-level deletion (Option+Backspace, Cmd+Backspace)
- Drag-and-drop of atoms (rearranging)
- @-trigger typeahead (deferred to T3.2)
- Prefix routing (`>` `$` `:` detection)

These are all T3.2+ scope items.

**Implementation notes for T3.2:**
- `@` completion must use a service/provider interface (`(query: string) => Promise<CompletionItem[]>`), not a hardcoded file list. The file completion service architecture is TBD.
- Drop handler must accept a configurable list of file types (extensions/MIME types), not accept everything.

---

## Spike Gallery Card

The spike card (`gallery-text-model-spike.tsx`) remains in the Component Gallery as a reference implementation. It contains the working TugTextEngine class, the diagnostics panel (selectedRange, hasMarkedText, canUndo, canRedo, segments), and the Return/Enter configuration controls. It should be preserved until tug-prompt-input (T3.2) is implemented and replaces it.

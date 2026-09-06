/**
 * tug-text-editor/keymap.ts — high-precedence keyboard handler for the
 * tug-specific input actions: Enter (submit / newline), numpad Enter,
 * Cmd-Enter (forced submit), history nav (Cmd-Up / Cmd-Down at the
 * document edges, plus Opt-Up / Opt-Down as a position-independent
 * walk), and the gap-fill text-editing bindings Ctrl-U / Ctrl-W /
 * Alt-F / Alt-B.
 *
 * The three vertical-arrow meanings, and why they split this way:
 *
 *   - **Plain Up / Down are caret keys, and nothing else.** They move a
 *     line, and at a document edge they arm the boundary latch so a
 *     second discrete press can leave the editor for the spatial plane.
 *     They never recall history. This is the whole point of the split:
 *     walking the caret to the top of a draft used to overshoot into an
 *     unwanted history entry, and holding the key made it worse.
 *   - **Cmd-Up / Cmd-Down keep their editing function** —
 *     `defaultKeymap`'s `cursorDocStart` / `cursorDocEnd`, the Home /
 *     End stand-ins a compact keyboard lacks dedicated keys for — and
 *     take on history only where that function is already a no-op: with
 *     the caret collapsed at the edge they are moving toward. Repeating
 *     keeps walking, because `navHistory` lands the caret back on that
 *     same edge.
 *   - **Opt-Up / Opt-Down** remain the position-independent walk: the
 *     reliable way to step entries while editing mid-document.
 *
 * Cmd-A (selectAll), Cmd-Z (undo), and Cmd-Shift-Z (redo) are inherited
 * from `@codemirror/commands` `defaultKeymap` + `historyKeymap`, which
 * the React shell wires alongside this module — no need to redeclare
 * them here.
 *
 * Why `EditorView.domEventHandlers` rather than `keymap.of` for the
 * Enter / history-nav family: the keymap facet normalizes both
 * main-row Enter and numpad Enter to the same key string, so a binding
 * written against `key: "Enter"` cannot tell them apart. Tug requires
 * per-source action: numpad Enter submits even when
 * `returnAction === "newline"` if the host wires
 * `numpadEnterAction === "submit"`. We need `KeyboardEvent.code`,
 * which only the raw event exposes, so the handler reads keydown
 * events directly. `Prec.high` ensures we run before the default
 * keymap and the history extension; returning `false` from any branch
 * lets the next handler take over (e.g., a "newline" Enter falls
 * through to `defaultKeymap`'s `insertNewlineAndIndent`).
 *
 * The four gap-fill bindings (Ctrl-U / Ctrl-W / Alt-F / Alt-B) ride on
 * a `keymap.of([...])` block layered alongside the `domEventHandlers`
 * inside the same `Prec.high([...])` wrapper. They dispatch existing
 * `@codemirror/commands` commands directly per [DM04]:
 *   - Ctrl-U → `deleteLineBoundaryBackward`
 *   - Ctrl-W → `deleteGroupBackward`
 *   - Alt-F  → `cursorGroupForward` (Shift variant: `selectGroupForward`)
 *   - Alt-B  → `cursorGroupBackward` (Shift variant: `selectGroupBackward`)
 * The `shift:` slot on each entry expresses the [DM05] shift-extends
 * pattern idiomatically — CM6 routes Shift-Alt-F to `selectGroupForward`
 * while a bare Alt-F runs `cursorGroupForward`. The CM6 commands push
 * onto CM6's own `history()` stack, so Cmd-Z reverts them naturally
 * (no execCommand bridge needed for the editor substrate).
 *
 * Configuration is supplied as a `getConfig` thunk so the React shell
 * can update the values (returnAction / onSubmit / historyProvider)
 * across renders without rebuilding the editor — the closure reads
 * the latest config at fire time per [L07].
 *
 * Laws: [L02] config reaches CM6 through a closure over a ref, never
 *        React state copied into CM6 state, [L07] handlers read
 *        config / view at call time via the supplied closure, [L11]
 *        the substrate is the responder for the submit / history-nav
 *        actions on its owned document, [L19] file structure.
 */

import { EditorSelection, Prec, Transaction } from "@codemirror/state";
import type { EditorState, Extension, TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import type { WidgetType } from "@codemirror/view";
import {
  cursorGroupBackward,
  cursorGroupForward,
  deleteGroupBackward,
  deleteLineBoundaryBackward,
  selectGroupBackward,
  selectGroupForward,
} from "@codemirror/commands";
import {
  AtomWidget,
  atomDecorationField,
  replaceAtomsEffect,
} from "./atom-decoration";
import { suppressCompletionDetection } from "./completion-extension";
import type { PositionedAtom } from "./atom-decoration";
import type {
  HistoryProvider,
  InputAction,
  TugSubstrateAtom,
  TugTextEditingState,
  TugTextSubstrate,
} from "@/lib/tug-text-types";
import type { AtomSegment } from "@/lib/tug-atom-img";
import { DEFAULT_BUTTON_PRESS_MS } from "@/components/tugways/responder-chain";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Live policy values consulted at every keystroke. The React shell
 * mirrors its props into a ref of this shape and passes a thunk that
 * dereferences the ref, so prop changes take effect on the next event
 * without needing to rebuild any extension.
 */
export interface TugTextEditorKeymapConfig {
  /** Action for the main-row Enter key (modifier-free). */
  returnAction: InputAction;
  /** Action for the numpad Enter key. */
  numpadEnterAction: InputAction;
  /** Submit handler. Invoked when the resolved action is `"submit"`. */
  onSubmit: () => void;
  /**
   * History provider. Cmd-Up / Cmd-Down and Opt-Up / Opt-Down history
   * nav are no-ops when this is `null`; in that case those arrows fall
   * through to the default keymap (`cursorDocStart` / `cursorDocEnd`,
   * normal caret motion).
   */
  historyProvider: HistoryProvider | null;
  /**
   * When the editor's resolved Enter action is `"submit"`, the
   * keymap consults this callback to see whether a higher-priority
   * default button is registered (typically by a dialog overlaying
   * the editor). When the callback returns a non-null `HTMLButtonElement`,
   * the editor clicks it instead of calling {@link onSubmit} — the
   * chain's bubble-phase activation path (press visual + click)
   * runs through the click handler the button itself owns. When
   * the callback returns `null` (no dialog default registered),
   * Enter falls through to the editor's own submit. Optional;
   * omit to keep the original "Enter always submits" behavior.
   */
  peekDefaultButton?: () => HTMLButtonElement | null;
  /**
   * Whether a surface above this editor has taken Return for its own
   * ([P14] "Return's home"). When this returns `true`, a plain Return
   * consults {@link peekDefaultButton} even on the `"newline"` action and
   * presses that button instead of breaking the line.
   *
   * The `"submit"` action already defers, so without this the yield is
   * only half honored: the Session card's History shade paints its Done
   * as the deck's one default ring and stands the composer's own default
   * down — and then a Return in the composer, whose shipped action is
   * `"newline"`, wrote a newline under a ring promising dismissal.
   *
   * The button's declared chord is honored exactly as the chain's
   * bubble-phase activation honors it ([#chord-ring]): a plain Return
   * presses a chordless button and nothing else, so an entry's own
   * Shift+Return submit can never be fired by the key that writes a line.
   * Optional; omit for an editor no surface yields to.
   */
  defaultButtonOwnsReturn?: () => boolean;
}

// ---------------------------------------------------------------------------
// State capture / restore
// ---------------------------------------------------------------------------

/**
 * Read the `(text, atoms)` substrate off an editor state: the document text
 * with a `U+FFFC` at each atom's spot, and the parallel positioned list of
 * what stands there.
 *
 * Pure over the state — no view, no DOM, no scroll — which is what lets an
 * `updateListener` mirror the substrate out on every edit ([B04]: a field
 * reports what it holds, and a document that leaves an editor as
 * `doc.toString()` alone has already dropped every chip in it). {@link
 * captureEditState} is this plus the caret and the two scroll axes.
 */
export function captureSubstrate(state: EditorState): TugTextSubstrate {
  const atoms: TugSubstrateAtom[] = [];
  const cursor = state.field(atomDecorationField).iter();
  while (cursor.value !== null) {
    const widget = (cursor.value.spec as { widget?: WidgetType }).widget;
    if (widget instanceof AtomWidget) {
      atoms.push({
        position: cursor.from,
        type: widget.segment.type,
        label: widget.segment.label,
        value: widget.segment.value,
        // Preserve the bytes-store key so a capture→restore round-trip
        // (fast-refresh / remount) keeps an in-progress image atom linked
        // to its bytes. Undefined for self-contained atoms.
        ...(widget.segment.id !== undefined ? { id: widget.segment.id } : {}),
      });
    }
    cursor.next();
  }
  return { text: state.doc.toString(), atoms };
}

/**
 * Snapshot the editor's text + atoms + selection + scroll position
 * (both axes) into the serializable shape the existing
 * `HistoryProvider` and state-preservation APIs both consume. The
 * shape matches `TugTextEditingState` produced by `TugTextEngine` so
 * a session / route history populated from `tug-prompt-input` can
 * drive `tug-text-editor` without translation, and so the same payload
 * survives a tugbank round-trip across reloads ([L23]).
 *
 * Both scroll axes are read directly off `view.scrollDOM` (the
 * `.cm-scroller` element CM6 owns) — the live, single-source-of-
 * truth scroll positions. History nav consumers ignore these fields;
 * state preservation consumers honor them. `scrollLeft` matters
 * specifically for `tug-text-editor` (line-wrap off by default) — long
 * lines scroll horizontally and the user's chosen horizontal
 * position must survive reload.
 */
export function captureEditState(view: EditorView): TugTextEditingState {
  const { text, atoms } = captureSubstrate(view.state);
  const sel = view.state.selection.main;
  // Layout-invariant scroll anchor: doc position of the line at the
  // top of the viewport plus the sub-line pixel offset. Computed from
  // CM6's height map (`lineBlockAtHeight`) rather than the DOM so it
  // tracks the engine's authoritative line layout even when the
  // scroller's CSS height differs from the height map (transient
  // states during ResizeObserver settle). See
  // `TugTextEditingState#scrollAnchor` for the restore contract.
  const scrollTop = view.scrollDOM.scrollTop;
  let scrollAnchor: { topPos: number; topOffsetPx: number } | null = null;
  if (view.contentDOM.isConnected && scrollTop > 0) {
    const block = view.lineBlockAtHeight(scrollTop);
    scrollAnchor = {
      topPos: block.from,
      topOffsetPx: scrollTop - block.top,
    };
  } else if (scrollTop === 0) {
    // Explicit top-of-document anchor — round-trips deterministically
    // even when the document is short enough to not require scroll on
    // restore (CM6 has no anchor to drift away from).
    scrollAnchor = { topPos: 0, topOffsetPx: 0 };
  }
  return {
    text,
    atoms: [...atoms],
    selection: { start: sel.from, end: sel.to },
    scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
    scrollAnchor,
  };
}

/**
 * Build the transaction spec that replaces the document, atom
 * decorations, and selection in one step. Shared between
 * `applyEditState` (history nav — also requests `scrollIntoView`) and
 * `restoreEditState` in `state-preservation.ts` (state-preservation
 * restore — writes scrollTop separately so a saved scroll position
 * is honored verbatim).
 *
 * The replace-atoms effect feeds the atom decoration field's
 * `replaceAtomsEffect` branch, so the new positions point into the
 * freshly-installed document — never into a stale one.
 */
export function buildEditStateTransaction(
  view: EditorView,
  state: TugTextEditingState,
  opts: { scrollIntoView: boolean; addToHistory?: boolean },
): TransactionSpec {
  const positioned: PositionedAtom[] = state.atoms.map((a) => ({
    position: a.position,
    segment: {
      kind: "atom",
      type: a.type,
      label: a.label,
      value: a.value,
      // Carry the optional bytes-store key through the reconstruction so a
      // restored image atom keeps its link to its bytes (thumbnail in the
      // editor, payload on re-submit). History-nav atoms carry no `id`, so
      // they pass `undefined` — no behavior change on that shared path.
      ...(a.id !== undefined ? { id: a.id } : {}),
    } satisfies AtomSegment,
  }));
  const docLen = view.state.doc.length;
  const sel = state.selection
    ? EditorSelection.range(state.selection.start, state.selection.end)
    : EditorSelection.cursor(state.text.length);
  const spec: TransactionSpec = {
    changes: { from: 0, to: docLen, insert: state.text },
    effects: replaceAtomsEffect.of(positioned),
    selection: sel,
    // Programmatic whole-document swap — never reopen the typeahead
    // popup from the restored text's leading trigger char. Without
    // this, recalling a `/command` from history reopens the popup and
    // the active popup swallows the next Enter / Shift+Return.
    annotations:
      opts.addToHistory === false
        ? [suppressCompletionDetection.of(true), Transaction.addToHistory.of(false)]
        : suppressCompletionDetection.of(true),
  };
  if (opts.scrollIntoView) {
    spec.scrollIntoView = true;
  }
  return spec;
}

/**
 * History-navigation restore: replace the document, atom decorations,
 * and selection in a single transaction; scroll the cursor into view.
 *
 * `state.scrollTop` is intentionally ignored on the history-nav
 * path: the user just navigated to a different document and expects
 * the cursor to be visible, not the prior scroll offset
 * reinstated. The state-preservation restore path uses
 * `restoreEditState` in `state-preservation.ts`, which honors
 * `state.scrollTop`.
 *
 * Caret rendering after the doc swap is owned by `caret-layer.ts`,
 * which paints from `state.selection` on every transaction — no
 * cache to flush, no blur/focus thrash needed.
 */
export function applyEditState(
  view: EditorView,
  state: TugTextEditingState,
): void {
  view.dispatch(buildEditStateTransaction(view, state, { scrollIntoView: true }));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective action for an Enter-family keystroke,
 * considering whether Shift flipped the base action.
 *
 * Exported separately so unit tests can drive the policy logic
 * without synthesizing keyboard events or mounting an editor.
 */
export function resolveEnterAction(
  config: TugTextEditorKeymapConfig,
  isNumpad: boolean,
  shiftKey: boolean,
): InputAction {
  const base = isNumpad ? config.numpadEnterAction : config.returnAction;
  if (!shiftKey) return base;
  return base === "submit" ? "newline" : "submit";
}

/**
 * Back-nav precondition for ArrowUp: caret collapsed at the very start
 * of the document (index 0). An empty document satisfies this too
 * (head 0 === doc length 0).
 */
function atBackBoundary(view: EditorView): boolean {
  const sel = view.state.selection.main;
  return sel.empty && sel.head === 0;
}

/**
 * Forward-nav precondition for ArrowDown: caret collapsed at the very
 * end of the document (or an empty document).
 */
function atForwardBoundary(view: EditorView): boolean {
  const sel = view.state.selection.main;
  return sel.empty && sel.head === view.state.doc.length;
}

/**
 * Walk the prompt history one step. `back` saves the current editor
 * state onto the provider's draft slot (on the first call) before
 * serving the most-recent entry; `forward` returns the next-newer
 * entry, or the saved draft when it reaches the end. A `null` result
 * (provider absent, or no entry in that direction) yields the keystroke
 * so the caret can move normally.
 *
 * Caret placement rides the edge being navigated toward, so repeated
 * presses keep walking without leaving the boundary: `back` lands the
 * caret at index 0 (another Cmd-ArrowUp navigates again), `forward`
 * lands it at the end (another Cmd-ArrowDown navigates again). This
 * overrides whatever selection the provider entry carried.
 */
function navHistory(
  view: EditorView,
  config: TugTextEditorKeymapConfig,
  direction: "back" | "forward",
): boolean {
  if (config.historyProvider === null) return false;
  const next = direction === "back"
    ? config.historyProvider.back(captureEditState(view))
    : config.historyProvider.forward();
  if (next === null) return false;
  const caret = direction === "back" ? 0 : next.text.length;
  applyEditState(view, { ...next, selection: { start: caret, end: caret } });
  return true;
}

/**
 * Which meaning a vertical arrow carries, given its modifiers and where the
 * caret sits. Exported separately so the policy is unit-testable without
 * synthesizing keyboard events or mounting an editor, the same way
 * {@link resolveEnterAction} is.
 *
 *  - `"history"` — walk the history provider in this direction.
 *  - `"caret"` — not the history's; fall through to the default keymap
 *    (a line step for a plain arrow, `cursorDocStart` / `cursorDocEnd`
 *    for a Cmd arrow away from its edge).
 *
 * Opt is checked first: it is the position-independent walk, so it means
 * history wherever the caret is, even in combination.
 */
export function resolveArrowHistory(input: {
  altKey: boolean;
  metaKey: boolean;
  atBoundary: boolean;
}): "history" | "caret" {
  if (input.altKey) return "history";
  if (input.metaKey) return input.atBoundary ? "history" : "caret";
  return "caret";
}

/** Handle an Enter or numpad-Enter keystroke. */
function handleEnter(
  view: EditorView,
  config: TugTextEditorKeymapConfig,
  event: KeyboardEvent,
): boolean {
  // IME composition: leave Enter alone — the IME owns commit.
  if (event.isComposing) return false;
  const isNumpad = event.code === "NumpadEnter";
  // Cmd-Enter (no Shift / Alt / Ctrl on macOS): forced submit, regardless
  // of the configured returnAction. Wrappers (e.g., `tug-prompt-entry`)
  // can layer additional Cmd-Enter semantics on top via the action
  // chain; the substrate guarantees a submit fires.
  if (event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey) {
    event.preventDefault();
    // The editor owns this Enter — stop it bubbling to the document
    // keyboard pipeline's Stage-2 (Enter → default-button activation). A
    // submit may open a sheet mid-event; without this, the same Enter then
    // clicks the just-opened sheet's primary button and dismisses it.
    event.stopPropagation();
    config.onSubmit();
    return true;
  }
  // Disqualify any other modifier combinations — pass through.
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const action = resolveEnterAction(config, isNumpad, event.shiftKey);
  if (action === "submit") {
    event.preventDefault();
    // Editor owns the Enter — don't let it ALSO drive Stage-2 default-button
    // activation (see the Cmd-Enter branch above).
    event.stopPropagation();
    // Defer to a chain-registered default button (e.g., a dialog's
    // primary action) when one is in scope. The click routes
    // through the button's own onClick — and the chain provider's
    // bubble-phase activation already paints the press visual via
    // `data-pressing` — so a Return from inside the editor looks
    // and behaves like a real mouse click on that button. Without
    // a default button registered, the editor's own submit runs.
    const defaultButton = config.peekDefaultButton?.() ?? null;
    if (defaultButton !== null) {
      pressDefaultButton(defaultButton);
      return true;
    }
    config.onSubmit();
    return true;
  }
  // Newline — unless a surface above this editor holds Return
  // ([P14]): a ring saying "Return lands here" has to be true from
  // wherever the keyboard is, and the composer under the History shade is
  // one of the places it can be. Shift is spent flipping the action, so
  // only a plain Return yields, and only to a button claiming no chord of
  // its own.
  if (!event.shiftKey && (config.defaultButtonOwnsReturn?.() ?? false)) {
    const yielded = config.peekDefaultButton?.() ?? null;
    if (yielded !== null && !yielded.hasAttribute("data-default-chord")) {
      event.preventDefault();
      event.stopPropagation();
      pressDefaultButton(yielded);
      return true;
    }
  }
  // Fall through to `defaultKeymap`'s `insertNewlineAndIndent`.
  return false;
}

/**
 * Click a default button the way the responder chain's own bubble-phase
 * activation does — with the press visual, so a Return from inside an editor
 * looks and behaves like a real mouse click on that button.
 */
function pressDefaultButton(button: HTMLButtonElement): void {
  button.setAttribute("data-pressing", "true");
  window.setTimeout(() => {
    button.removeAttribute("data-pressing");
  }, DEFAULT_BUTTON_PRESS_MS);
  button.click();
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Build the high-precedence tug keymap extension.
 *
 * Layers two registrations inside one `Prec.high([...])` wrapper:
 *
 *   1. `EditorView.domEventHandlers` for the Enter family + history
 *      nav (Cmd-Up / Cmd-Down from the edges, Opt-Up / Opt-Down anywhere).
 *      Reads `KeyboardEvent.code` directly to tell main-row Enter and
 *      numpad Enter apart (the keymap facet normalizes them).
 *   2. `keymap.of([...])` for the four gap-fill bindings (Ctrl-U /
 *      Ctrl-W / Alt-F / Alt-B), each dispatching an existing
 *      `@codemirror/commands` command. The `shift:` slot expresses
 *      shift-extends-selection per [DM05] — CM6 idiom for "same
 *      motion with extension."
 *
 * `Prec.high` ensures both registrations precede `defaultKeymap` and
 * `historyKeymap`. Returning `true` from a `domEventHandlers` branch
 * claims the event; returning `false` lets the lower-precedence
 * handlers run (e.g. newline insertion via `insertNewlineAndIndent`).
 * `keymap.of` calls `preventDefault` automatically on a matched
 * binding.
 */
export function tugTextEditorKeymap(
  getConfig: () => TugTextEditorKeymapConfig,
): Extension {
  return Prec.high([
    EditorView.domEventHandlers({
      keydown(event, view) {
        const config = getConfig();
        if (event.key === "Enter") {
          return handleEnter(view, config, event);
        }
        if (
          (event.key === "ArrowUp" || event.key === "ArrowDown")
          && (event.altKey || event.metaKey)
          && !event.shiftKey
          && !event.ctrlKey
          && !event.isComposing
        ) {
          const direction = event.key === "ArrowUp" ? "back" : "forward";
          const atBoundary = direction === "back"
            ? atBackBoundary(view)
            : atForwardBoundary(view);
          const meaning = resolveArrowHistory({
            altKey: event.altKey,
            metaKey: event.metaKey,
            atBoundary,
          });
          if (meaning === "history") return navHistory(view, config, direction);
          // The caret's — fall through to the default keymap, where a Cmd arrow
          // runs `cursorDocStart` / `cursorDocEnd`. (A `navHistory` that finds
          // no entry also lands here, so Cmd-Up at the start of an empty
          // history still jumps to the start.)
          return false;
        }
        // Plain arrows are the caret's, unconditionally and in every
        // direction. The boundary latch that used to arm here — two presses at
        // a document edge to cross out of the editor — is gone with the mode
        // division: in KBF mode OFF a text surface owns all four arrows
        // whatever its content, and in mode ON the keyboard is on a ring rather
        // than in this editor, so there is no edge to cross from.
        return false;
      },
    }),
    keymap.of([
      { key: "Ctrl-u", run: deleteLineBoundaryBackward },
      { key: "Ctrl-w", run: deleteGroupBackward },
      { key: "Alt-f", run: cursorGroupForward, shift: selectGroupForward },
      { key: "Alt-b", run: cursorGroupBackward, shift: selectGroupBackward },
    ]),
  ]);
}

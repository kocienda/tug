/**
 * useTextInputResponder — shared responder wiring for native text inputs.
 *
 * Encapsulates the six standard editing actions (`cut`, `copy`, `paste`,
 * `selectAll`, `undo`, `redo`), a right-click `TugEditorContextMenu`,
 * and responder-node registration for a single `<input>` or
 * `<textarea>` DOM element. One source of truth for every native text
 * input in the tugways suite — tug-input, tug-textarea, and
 * tug-value-input all consume this hook.
 *
 * Why one hook and not three copies:
 *
 * - All three components touch the exact same browser editing APIs
 *   (`execCommand`, `navigator.clipboard`, `select()`, `setRangeText`).
 * - All three components open the same context menu with the same
 *   items at the same coordinates.
 * - Paste in particular is subtle (see the handler body below) and
 *   any divergence invites Safari-vs-Chrome regressions.
 *
 * ## Action handlers (two-phase)
 *
 * Each handler returns an `ActionHandlerResult` — either `void` or a
 * continuation callback. The sync body runs inside the dispatching
 * user gesture; the continuation runs at the caller's commit point
 * (keyboard path = immediately; context menu path = after the ~120ms
 * activation blink). This matches the pattern documented on
 * `responder-chain.ts` and in tug-prompt-input.tsx.
 *
 *   - cut       → sync: `execCommand("copy")` so the selection stays
 *                        visible during the blink
 *                 continuation: `execCommand("delete")` — pushes to
 *                               the native undo stack.
 *   - copy      → sync-only: `execCommand("copy")`.
 *   - paste     → sync: capture clipboard data via the paste event
 *                        (see below); no Clipboard API, no nag.
 *                 continuation: insert the captured data after the
 *                               activation blink.
 *   - selectAll → continuation: `input.select()`.
 *   - undo      → continuation: `execCommand("undo")`.
 *   - redo      → continuation: `execCommand("redo")`.
 *
 * ## Editing motion / deletion (Ctrl-U/W, Alt-F/B)
 *
 * Four substrate-local "gap" bindings consumed from
 * `text-editing-keybindings.ts` per [DM01]: AppKit's field editor
 * inside a WKWebView already handles Ctrl-A/E/F/B/P/N/D/H/K/T and
 * Option-Delete; this hook fills the remaining four — Ctrl-U
 * (`DELETE_TO_LINE_START`), Ctrl-W (`DELETE_WORD_BACKWARD`), Alt-F
 * (`MOVE_WORD_FORWARD`), Alt-B (`MOVE_WORD_BACKWARD`). The bindings
 * arrive two ways:
 *
 *   1. **Keystroke.** A `useLayoutEffect`-installed `keydown` listener
 *      calls `matchEditingKeybinding(event)` per [L03]; on a match,
 *      `event.preventDefault()` runs and the corresponding handler is
 *      invoked directly with `event.shiftKey` (so the `MOVE_*`
 *      handlers can extend selection per [DM05]). On a null match,
 *      the listener returns immediately — no `preventDefault` — so
 *      AppKit's field editor still sees the keystroke for the
 *      platform-handled bindings.
 *
 *   2. **Chain dispatch** (future settings UI / menu). The four
 *      actions are registered in the `actions` map alongside CUT /
 *      COPY / etc., so a `manager.sendToTarget(id, ...)` call
 *      reaches the same code. Chain dispatch carries no native
 *      event, so the `MOVE_*` handlers default to no shift extension
 *      — settings/menu dispatch never extends selection.
 *
 * Native deletes route through `el.setSelectionRange(...)` then
 * `document.execCommand("delete")` per [DM03] / [L23] so Cmd-Z
 * reverts them through the WKWebView's NSUndoManager — same shape as
 * the existing `cut` continuation.
 *
 * ## Paste — native bridge with browser fallback
 *
 * Goal: no Safari "Paste" permission popup, AND the text insertion
 * happens after the menu item's activation blink (not before).
 *
 * Safari's permission popup fires whenever JavaScript reads the
 * clipboard via the JS-level Clipboard API (`navigator.clipboard.*`)
 * or via `document.execCommand("paste")` on contentEditable. In
 * Safari 16.4+ there is no JavaScript-only code path that reads the
 * clipboard without the popup. The only clean fix in a WKWebView app
 * is to delegate to the native side: Swift reads `NSPasteboard` (no
 * popup, no prompt) and passes the contents back to JavaScript via
 * `evaluateJavaScript`. See `lib/tug-native-clipboard.ts` and
 * `tugapp/Sources/MainWindow.swift` for the bridge implementation.
 *
 * The paste handler therefore branches on `hasNativeClipboardBridge()`:
 *
 *   1. **Native bridge present (Tug.app production).** Kick off
 *      `readClipboardViaNative()` immediately — the promise is created
 *      inside the user gesture so it stays alive across the menu
 *      blink. Return a continuation that awaits the promise and
 *      inserts the resolved text via `setRangeText` after the blink.
 *      Zero clipboard-API calls, zero execCommand calls, zero popup.
 *
 *   2. **No bridge (browser dev / tests).** Fall back to the
 *      "capture the paste event fired by execCommand" pattern:
 *      register a one-time paste listener on `el`, call
 *      `document.execCommand("paste")`, intercept the event to
 *      `preventDefault()` and read `clipboardData`, defer insertion
 *      to the continuation. On browsers where execCommand is blocked
 *      (Chrome), fall through once more to
 *      `navigator.clipboard.readText()` kicked off inside the user
 *      gesture so the read is authorized.
 *
 * In all paths the DOM write lands in the continuation so the user
 * sees the menu item blink first, then the pasted text, matching the
 * order of every other editing action.
 *
 * ## Context menu
 *
 * Right-click on the host element opens a `TugEditorContextMenu`
 * anchored at the cursor with Cut / Copy / Paste / Select All.
 * Cut and Copy are disabled when there is no ranged selection —
 * matching native input behavior where right-click does not
 * auto-select a word. Menu item activation dispatches through the
 * chain; the innermost-first walk routes it right back to the host
 * input and the sync/continuation split described above fires.
 *
 * ## Usage
 *
 * The hook returns a pre-composed `ref`, a pre-bridged
 * `handleContextMenu`, and a ready-to-render `contextMenu` element,
 * so every consumer is the same three-line wire-up:
 *
 * ```tsx
 * const inputRef = useRef<HTMLInputElement | null>(null);
 * const { composedRef, handleContextMenu, contextMenu } =
 *   useTextInputResponder({
 *     inputRef,
 *     disabled,
 *     forwardedRef,           // optional — merged into composedRef
 *     onContextMenu,          // optional — chained after menu opens
 *   });
 *
 * return (
 *   <>
 *     <input
 *       ref={composedRef}
 *       onContextMenu={handleContextMenu}
 *       ...
 *     />
 *     {contextMenu}
 *   </>
 * );
 * ```
 *
 * `composedRef` populates the hook's internal `inputRef`, applies the
 * consumer's `forwardedRef` (function or object form), and writes
 * `data-responder-id` for the chain's first-responder resolution —
 * all in one ref callback. Consumers do not compose refs themselves.
 *
 * Laws: [L06] appearance via CSS/DOM,
 *       [L11] controls emit actions; responders handle actions,
 *       [L19] component authoring guide
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { useOptionalResponder } from "./use-responder";
import { useResponderChain } from "./responder-chain-provider";
import type { ActionEvent, ActionHandler, ActionHandlerResult } from "./responder-chain";
import { correctedText, isSpellingCorrection } from "@/lib/spelling-guesses";
import { SPELLING_MEMORY_HANDLERS } from "./spelling-actions";
import { TUG_ACTIONS, type TugAction } from "./action-vocabulary";
import { useTextSurfaceContextMenu } from "./use-text-surface-context-menu";
import {
  hasNativeClipboardBridge,
  readClipboardViaNative,
  warnIfWKWebViewRace,
} from "@/lib/tug-native-clipboard";
import { quoteMarkdown, stripMarkdown } from "@/lib/paste-transforms";
import {
  type TextSelectionAdapter,
  findWordBoundaries,
} from "./text-selection-adapter";
import { matchEditingKeybinding } from "./text-editing-keybindings";

// ---- applyPastedText — pure helper ----
//
// The tail of every paste branch (native bridge, execCommand event
// capture, Clipboard API fallback) does the same work: guard against
// the component being unmounted while the async read was in flight,
// guard against the element being detached, capture the current
// selection range, replace it with the pasted text via
// `setRangeText`, and dispatch a synthetic `input` event so
// controlled React inputs stay in sync with the DOM value.
//
// Before extraction, this tail was triplicated across three branches
// in `handlePaste` — three near-identical blocks in one function,
// each with the same mountedRef guard, the same null-input guard,
// the same selectionStart/End capture, the same setRangeText call
// with `"end"` cursor placement, and the same input-event dispatch.
// Extracting it (a) eliminates the duplication, and (b) turns the
// bug-prone half of paste (state: mountedRef, inputRef, selection
// range, event dispatch) into a pure function.
//
// The function is exported so tests can exercise it directly. It is
// not intended for use outside the paste-handler cascade — consumers
// building their own paste should go through the full hook.
export function applyPastedText(
  inputRef: React.MutableRefObject<TextInputLikeElement | null>,
  mountedRef: React.MutableRefObject<boolean>,
  text: string,
): void {
  // Guard against the component unmounting between the async read
  // starting and the continuation running — the input ref may still
  // point at a detached element, and writing to it would be a silent
  // no-op in the browser but a confusing footgun in tests.
  if (!mountedRef.current) return;
  // Empty clipboard (or a native bridge read that resolved with no
  // text / no html payload) is a no-op — don't dispatch a spurious
  // input event for a no-op edit.
  if (!text) return;
  const node = inputRef.current;
  if (!node) return;
  // Focus the node so execCommand targets it.
  node.focus();
  // Re-establish the editing selection on this element before inserting.
  // After a prior execCommand("delete") empties the field (the Cut path),
  // the WKWebView field editor leaves "insertText" disabled until the
  // selection is explicitly set on the element again — so a paste into a
  // just-cut field silently no-ops (execCommand returns false, nothing is
  // inserted). Setting the range re-points WebKit's frame selection at this
  // element and re-enables the command. Harmless for the already-valid case.
  const caret = node.selectionStart ?? node.value.length;
  try {
    node.setSelectionRange(caret, caret);
  } catch {
    // setSelectionRange throws on input types that don't support selection
    // (e.g. type="email"); the insert below still targets the caret.
  }
  // Insert via execCommand("insertText") so the edit routes through
  // the browser's native editing pipeline. This pushes onto the undo
  // stack (so Cmd+Z can revert a paste) and fires the input event
  // natively — no synthetic event dispatch needed.
  document.execCommand("insertText", false, text);
}

// ---- findLineStart — pure helper ----
//
// Compute the index of the start of the line containing `caret` in
// `value`. For `<input>` (single-line) the returned index is always
// 0; for `<textarea>` it is the index immediately after the last
// `\n` at-or-before the caret. Used by `handleDeleteToLineStart`
// per [DM03] to seed the `setSelectionRange` call before
// `execCommand("delete")`.
//
// Exported so tests can exercise it in pure-logic mode without a
// React render (no focus, no event ordering — just string math).
export function findLineStart(value: string, caret: number): number {
  // Clamp caret to the value range. `selectionStart` is always
  // inside [0, value.length] in normal use, but defensive clamping
  // keeps the helper a pure function over arbitrary inputs.
  const clamped = Math.max(0, Math.min(caret, value.length));
  const newlineIndex = value.lastIndexOf("\n", clamped - 1);
  return newlineIndex < 0 ? 0 : newlineIndex + 1;
}

/** Any DOM element that has an editable text value, caret, and selection. */
export type TextInputLikeElement = HTMLInputElement | HTMLTextAreaElement;

// ---------------------------------------------------------------------------
// createNativeInputAdapter
// ---------------------------------------------------------------------------

/**
 * Factory that wraps a native `<input>` or `<textarea>` element in a query-only
 * `TextSelectionAdapter` (`hasRangedSelection` / `getSelectedText` / `selectAll`)
 * for the right-click context menu. Selection *preservation* on a secondary-click
 * is handled by the input's `mousedown` preventDefault guard
 * (`useTextSurfaceContextMenu`'s `onMouseDown`), not by this adapter.
 *
 * @param el  The host `<input>` or `<textarea>` DOM element.
 */
export function createNativeInputAdapter(
  el: TextInputLikeElement,
): TextSelectionAdapter {
  function hasRangedSelection(): boolean {
    return (
      el.selectionStart !== null &&
      el.selectionEnd !== null &&
      el.selectionStart !== el.selectionEnd
    );
  }

  return {
    hasRangedSelection,

    getSelectedText(): string {
      if (!hasRangedSelection()) return "";
      return el.value.slice(el.selectionStart!, el.selectionEnd!);
    },

    selectAll(): void {
      el.select();
    },
  };
}

export interface UseTextInputResponderOptions<T extends TextInputLikeElement> {
  /**
   * Ref to the host input/textarea DOM element. The hook reads
   * `selectionStart` / `selectionEnd` on it for context-menu
   * enablement and calls `select()` / `setRangeText()` on it from the
   * handlers. Must be the same element the returned `composedRef`
   * is attached to.
   */
  inputRef: React.MutableRefObject<T | null>;
  /**
   * When true, all handlers short-circuit before touching the DOM and
   * the context menu refuses to open. This is defence-in-depth — a
   * disabled input normally cannot receive focus, but
   * `manager.sendToTarget(id, ...)` can target it directly and must not
   * mutate a disabled field.
   */
  disabled: boolean;
  /**
   * Consumer's forwarded ref (from `React.forwardRef`). When provided,
   * `composedRef` applies it alongside writing the hook's internal
   * `inputRef` and the responder chain's `data-responder-id`. Handles
   * both callback refs and `MutableRefObject` refs. Omit when the
   * caller composes refs itself.
   */
  forwardedRef?: React.Ref<T>;
  /**
   * Consumer's `onContextMenu` handler. The returned
   * `handleContextMenu` opens the right-click menu first and then
   * invokes this callback, so consumers still observe the event for
   * analytics, logging, or additional side effects without breaking
   * the menu. Parameterized on `T` so consumers pass a native
   * `React.MouseEventHandler<HTMLInputElement>` /
   * `HTMLTextAreaElement` without variance conflicts.
   */
  onContextMenu?: (e: React.MouseEvent<T>) => void;
}

export interface UseTextInputResponderResult<T extends TextInputLikeElement> {
  /**
   * Attach to the host input/textarea element. Populates the hook's
   * internal `inputRef`, applies the forwarded consumer ref (if any),
   * and writes `data-responder-id` for the chain's innermost-first
   * responder resolution — one ref callback, three destinations.
   */
  composedRef: (el: T | null) => void;
  /**
   * Pass to the input's `onContextMenu` prop. Opens the editor
   * context menu at the cursor and chains the consumer's
   * `onContextMenu` callback after (if provided). Samples the
   * current selection at open time so Cut/Copy are disabled when
   * no range is selected — matching native input behavior.
   */
  handleContextMenu: (e: React.MouseEvent<T>) => void;
  /**
   * Ready-to-render `<TugEditorContextMenu>` element (or `null` when
   * no chain provider is in scope — see note below). Drop as a
   * sibling of the input/textarea. The hook owns its open state,
   * cursor position, item list, and close handler — consumers never
   * touch any of it.
   *
   * Returns `null` when the hook is called outside a
   * `ResponderChainProvider`: `TugEditorContextMenu` internally
   * requires a chain manager to dispatch cut/copy/paste through, so
   * it can't render without one. The opener is likewise gated, so
   * the menu is never opened in the no-provider case. On a provider
   * transition the `contextMenu` slot flips between `null` and the
   * real menu element; the sibling input element is unaffected, so
   * caret and focus survive.
   */
  contextMenu: React.ReactNode;
}

export function useTextInputResponder<T extends TextInputLikeElement>({
  inputRef,
  disabled,
  forwardedRef,
  onContextMenu: consumerOnContextMenu,
}: UseTextInputResponderOptions<T>): UseTextInputResponderResult<T> {
  // Read the chain manager once. `useResponderChain` (unlike
  // `useRequiredResponderChain`) returns `null` when no provider is
  // in scope. The hook uses this to decide whether to render the
  // right-click context menu and whether to let the opener fire:
  // outside a provider the menu cannot dispatch cut/copy/paste
  // through the chain, so it's gated off. When a provider enters or
  // leaves mid-lifecycle, the menu availability flips with it, but
  // the host input element itself stays mounted — see the
  // `useOptionalResponder` docstring for why state survives the
  // transition.
  const manager = useResponderChain();

  // Mounted flag for the async paste continuation. `useRef` is enough
  // because the continuation reads it synchronously in a promise
  // callback; no subscriber semantics are required.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---- Action handlers ----
  //
  // See the module docstring for the full rationale of each sync /
  // continuation split. The disabled guards in every handler are
  // defence-in-depth (see UseTextInputResponderOptions.disabled).

  const handleCut = useCallback((): ActionHandlerResult => {
    if (disabled) return;
    if (!inputRef.current) return;
    // Sync: copy the current selection to the clipboard so it stays
    // visible during the menu item's activation blink.
    document.execCommand("copy");
    // Continuation: remove the selection after the blink. execCommand
    // routes the deletion through the native editing pipeline so it
    // pushes onto the input's undo stack.
    return () => {
      document.execCommand("delete");
    };
  }, [disabled, inputRef]);

  const handleCopy = useCallback((): ActionHandlerResult => {
    if (disabled) return;
    // Sync-only: nothing to defer past the blink.
    document.execCommand("copy");
  }, [disabled]);

  const handleDelete = useCallback((): ActionHandlerResult => {
    if (disabled) return;
    if (!inputRef.current) return;
    // Cut without the copy. execCommand routes the deletion through the
    // native editing pipeline, so the WKWebView's NSUndoManager records it
    // and ⌘Z reverts it — the same reason cut's continuation uses it.
    return () => {
      document.execCommand("delete");
    };
  }, [disabled, inputRef]);

  const handlePaste = useCallback((): ActionHandlerResult => {
    if (disabled) return;
    const el = inputRef.current;
    if (!el) return;

    // ---- Native bridge path (Tug.app WKWebView) ----
    //
    // Preferred: ask the Swift side to read NSPasteboard and send the
    // contents back. This is the only path that avoids Safari's
    // "Paste" permission popup — neither `navigator.clipboard.*` nor
    // `document.execCommand("paste")` qualify, because both read the
    // clipboard from inside the JavaScript context and Safari treats
    // that as a prompt-required action. NSPasteboard access from the
    // native Cocoa side does not trigger any popup.
    //
    // The read is kicked off immediately (inside the user gesture, so
    // the menu stays live) and the insertion is deferred to the
    // continuation so the text appears after the activation blink —
    // matching cut / selectAll / undo / redo on every browser.
    // `hasNativeClipboardBridge()` is a live check, not a module-load
    // cache — a late-installed bridge (Swift registers after first JS
    // execution) is picked up on the next paste. The diagnostic for
    // the race window where a user pastes before the bridge install
    // lives at the fall-through site below via `warnIfWKWebViewRace`.
    if (hasNativeClipboardBridge()) {
      const nativeReadPromise = readClipboardViaNative();
      return () => {
        if (!mountedRef.current) return;
        void nativeReadPromise.then(({ text }) => {
          applyPastedText(inputRef, mountedRef, text);
        });
      };
    }

    // ---- Fall-through race diagnostic ----
    //
    // We're taking the JS Clipboard API path. In a normal browser
    // that's legitimate (no WKWebView, no native bridge expected).
    // Inside a WKWebView it's the race condition from the audit:
    // the Swift-side `clipboardRead` handler should have been
    // installed by MainWindow.swift before the first JS execution,
    // but for whatever reason wasn't. Emit a one-shot console
    // warning so the race is audible in dev consoles; production
    // Tug.app with a correctly-installed bridge stays silent.
    warnIfWKWebViewRace();

    // ---- Browser fallback (no WKWebView bridge) ----
    //
    // Development in Chrome / Firefox, Storybook, standalone previews,
    // tests. No native bridge → fall back to the "capture the paste
    // event fired by execCommand" pattern that works in the browsers
    // that still honor execCommand("paste"), then to the Clipboard API
    // path for the ones that don't.
    //
    // Register a one-time paste listener BEFORE calling execCommand so
    // we can intercept the synchronous paste event it fires. Focus the
    // element explicitly: execCommand("paste") fires the paste event
    // on the currently-focused element, and in test environments
    // `document.activeElement` must resolve to `el` for the spy to
    // target it correctly.
    el.focus();
    let pasteEventFired = false;
    let capturedText = "";
    const onPaste = (e: Event) => {
      const ce = e as ClipboardEvent;
      pasteEventFired = true;
      // Prevent the browser's native insertion — we'll insert manually
      // in the continuation, after the activation blink.
      ce.preventDefault();
      capturedText = ce.clipboardData?.getData("text/plain") ?? "";
    };
    el.addEventListener("paste", onPaste, { once: true });

    try {
      document.execCommand("paste");
    } catch {
      // Some browsers throw; treat as failure (Chrome path).
    }
    // Remove listener in case execCommand fired no event (Chrome).
    el.removeEventListener("paste", onPaste);

    if (pasteEventFired) {
      const text = capturedText;
      if (!text) return; // clipboard was empty — no-op
      return () => {
        applyPastedText(inputRef, mountedRef, text);
      };
    }

    // Last-resort: Clipboard API. execCommand is blocked and the
    // paste event never fired. Kick off the clipboard read NOW (still
    // inside the user gesture) so the read is authorized, then insert
    // in the continuation.
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return;
    }
    const readPromise = navigator.clipboard.readText().catch(() => "");
    return () => {
      if (!mountedRef.current) return;
      void readPromise.then((text) => {
        applyPastedText(inputRef, mountedRef, text);
      });
    };
  }, [disabled, inputRef]);

  // Paste-as-quote / paste-as-plain-text: read the clipboard's plain
  // text and run a transform (blockquote wrap / Markdown strip) before
  // inserting via `applyPastedText`. Plain-text only — no atom sidecar,
  // no execCommand("paste") interception, because the transform must see
  // the raw text. The native bridge is preferred (popup-free read in
  // Tug.app); otherwise the async Clipboard API. Insertion is deferred
  // into the continuation so it lands after any menu activation blink.
  const pasteWithTransform = useCallback(
    (transform: (text: string) => string): ActionHandlerResult => {
      if (disabled) return;
      const el = inputRef.current;
      if (!el) return;
      const apply = (raw: string) => {
        if (!mountedRef.current) return;
        applyPastedText(inputRef, mountedRef, transform(raw));
      };
      if (hasNativeClipboardBridge()) {
        const nativeReadPromise = readClipboardViaNative();
        return () => {
          void nativeReadPromise.then(({ text }) => apply(text));
        };
      }
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        return;
      }
      const readPromise = navigator.clipboard.readText().catch(() => "");
      return () => {
        void readPromise.then(apply);
      };
    },
    [disabled, inputRef, mountedRef],
  );

  const handlePasteAsQuote = useCallback(
    (): ActionHandlerResult => pasteWithTransform(quoteMarkdown),
    [pasteWithTransform],
  );

  const handlePasteAsPlainText = useCallback(
    (): ActionHandlerResult => pasteWithTransform(stripMarkdown),
    [pasteWithTransform],
  );

  const handleSelectAll = useCallback((): ActionHandlerResult => {
    if (disabled) return;
    return () => {
      inputRef.current?.select();
    };
  }, [disabled, inputRef]);

  // ---- Case transforms ----
  //
  // Replace the selection with its case-transformed text, through
  // `execCommand("insertText")` so the WKWebView's NSUndoManager records
  // the edit and ⌘Z reverts it per [DM03] — the same reason the paste and
  // delete paths route through execCommand rather than assigning `value`.
  // The selection is re-established first (the field editor leaves
  // insertText disabled otherwise) and restored over the replacement after,
  // so a second press transforms the same run. A collapsed selection is a
  // no-op, and so is text the transform leaves unchanged: neither should
  // push an entry onto the undo stack. Deferred into a continuation like
  // paste's, so a menu activation lands the edit after the blink.
  const transformSelectionCase = useCallback(
    (transform: (text: string) => string): ActionHandlerResult => {
      if (disabled) return;
      if (!inputRef.current) return;
      return () => {
        const el = inputRef.current;
        if (!mountedRef.current || !el) return;
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        if (start === end) return;
        const selected = el.value.slice(start, end);
        const next = transform(selected);
        if (next === selected) return;
        el.focus();
        el.setSelectionRange(start, end);
        document.execCommand("insertText", false, next);
        el.setSelectionRange(start, start + next.length);
      };
    },
    [disabled, inputRef, mountedRef],
  );

  const handleMakeUppercase = useCallback(
    (): ActionHandlerResult =>
      transformSelectionCase((text) => text.toUpperCase()),
    [transformSelectionCase],
  );

  const handleMakeLowercase = useCallback(
    (): ActionHandlerResult =>
      transformSelectionCase((text) => text.toLowerCase()),
    [transformSelectionCase],
  );

  // A spelling guess from the context menu, over the word it was opened on.
  const handleCorrectSpelling = useCallback(
    (event: ActionEvent): ActionHandlerResult => {
      const correction = event.value;
      if (!isSpellingCorrection(correction)) return;
      return transformSelectionCase(
        (text) => correctedText(text, correction) ?? text,
      );
    },
    [transformSelectionCase],
  );

  // ---- Editing motion / deletion ----
  //
  // Four substrate-local handlers for the gap bindings consumed from
  // `text-editing-keybindings.ts` per [DM01]. The DELETE_* handlers
  // route through `setSelectionRange` + `execCommand("delete")` per
  // [DM03] so the WKWebView's NSUndoManager records the operation
  // and Cmd-Z reverts it. The MOVE_* handlers take an internal
  // `(shift: boolean)` parameter so the keystroke listener can
  // extend the selection on Shift per [DM05]; the chain-dispatch
  // wrappers below pin shift=false because settings/menu dispatch
  // carries no native event.

  const handleDeleteToLineStart = useCallback((): ActionHandlerResult => {
    if (disabled) return;
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionEnd ?? el.value.length;
    const lineStart = findLineStart(el.value, caret);
    // Nothing to delete when the caret is already at the line start
    // and no range is selected — bail without calling execCommand so
    // we don't push a no-op onto the undo stack.
    if (lineStart === caret && el.selectionStart === el.selectionEnd) return;
    el.setSelectionRange(lineStart, caret);
    document.execCommand("delete");
  }, [disabled, inputRef]);

  const handleDeleteWordBackward = useCallback((): ActionHandlerResult => {
    if (disabled) return;
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionEnd ?? el.value.length;
    // findWordBoundaries returns the word containing `offset`. When
    // the caret sits *just past* a word (the typical Ctrl-W
    // position), step one character back so the boundary search
    // lands inside the word we want to delete.
    let probe = caret;
    while (probe > 0 && /\s/.test(el.value[probe - 1] ?? "")) probe--;
    const { start } = findWordBoundaries(el.value, Math.max(0, probe - 1));
    // Clamp: never delete forward past the caret. If the boundary
    // search came back collapsed (caret on punctuation with nothing
    // word-shaped behind it), delete just the run of whitespace
    // back to where the probe stopped.
    const targetStart = Math.min(start, probe);
    if (targetStart >= caret) return;
    el.setSelectionRange(targetStart, caret);
    document.execCommand("delete");
  }, [disabled, inputRef]);

  // Move handlers carry an internal `(shift: boolean)` parameter so
  // the keystroke listener can extend the selection on Shift per
  // [DM05]. The chain `actions` map registers wrappers that pin
  // shift=false — settings/menu dispatch never extends selection.
  const handleMoveWordForward = useCallback(
    (shift: boolean): ActionHandlerResult => {
      if (disabled) return;
      const el = inputRef.current;
      if (!el) return;
      const value = el.value;
      const anchor = shift ? (el.selectionStart ?? 0) : null;
      const cursor = el.selectionEnd ?? 0;
      // Move past whitespace, then to the end of the next word.
      let i = cursor;
      while (i < value.length && /\s/.test(value[i] ?? "")) i++;
      const { end } = findWordBoundaries(value, i);
      const nextOffset = end > cursor ? end : Math.min(value.length, i + 1);
      if (shift && anchor !== null) {
        // Extend from the existing anchor (the side of the current
        // selection that is *not* moving). For a forward motion
        // starting from a collapsed caret, anchor === cursor — the
        // selection grows forward.
        const start = Math.min(anchor, nextOffset);
        const finish = Math.max(anchor, nextOffset);
        el.setSelectionRange(start, finish);
      } else {
        el.setSelectionRange(nextOffset, nextOffset);
      }
    },
    [disabled, inputRef],
  );

  const handleMoveWordBackward = useCallback(
    (shift: boolean): ActionHandlerResult => {
      if (disabled) return;
      const el = inputRef.current;
      if (!el) return;
      const value = el.value;
      const anchor = shift ? (el.selectionEnd ?? 0) : null;
      const cursor = el.selectionStart ?? 0;
      // Move past whitespace going backward, then to the start of
      // the previous word.
      let i = cursor;
      while (i > 0 && /\s/.test(value[i - 1] ?? "")) i--;
      const { start } = findWordBoundaries(value, Math.max(0, i - 1));
      const prevOffset = start < cursor ? start : Math.max(0, i - 1);
      if (shift && anchor !== null) {
        const lo = Math.min(anchor, prevOffset);
        const hi = Math.max(anchor, prevOffset);
        el.setSelectionRange(lo, hi);
      } else {
        el.setSelectionRange(prevOffset, prevOffset);
      }
    },
    [disabled, inputRef],
  );

  // Chain-dispatch wrappers. The `actions` map below registers
  // `ActionHandler` shapes — `(event: ActionEvent) => result`. Native
  // chain dispatch (settings UI, future menu) carries no
  // `event.shiftKey`, so the wrappers pin shift=false. The keystroke
  // listener bypasses these and calls the shift-aware closures
  // directly.
  const handleMoveWordForwardChain = useCallback(
    (): ActionHandlerResult => handleMoveWordForward(false),
    [handleMoveWordForward],
  );
  const handleMoveWordBackwardChain = useCallback(
    (): ActionHandlerResult => handleMoveWordBackward(false),
    [handleMoveWordBackward],
  );

  // ---- Responder registration ----
  //
  // `useResponder` installs a live Proxy over `options.actions` — so
  // a fresh object literal each render is fine, every dispatch reads
  // the latest handler identities via the ref. No need to memoize
  // the actions map here.
  //
  // Undo / redo are intentionally not registered. execCommand("undo")
  // does not operate on native <input>/<textarea> — their undo stack
  // is browser-internal and only reachable via the native Cmd+Z
  // keystroke. By not registering handlers, the keybinding dispatch
  // returns handled=false, skips preventDefault, and the browser's
  // native undo runs. (Context menu undo/redo for native inputs will
  // require a custom undo stack — that work is tabled for now.)

  const responderId = useId();
  const actions: Partial<Record<TugAction, ActionHandler>> = {
    [TUG_ACTIONS.CUT]: handleCut,
    [TUG_ACTIONS.COPY]: handleCopy,
    [TUG_ACTIONS.DELETE]: handleDelete,
    [TUG_ACTIONS.PASTE]: handlePaste,
    [TUG_ACTIONS.PASTE_AS_QUOTE]: handlePasteAsQuote,
    [TUG_ACTIONS.PASTE_AS_PLAIN_TEXT]: handlePasteAsPlainText,
    [TUG_ACTIONS.SELECT_ALL]: handleSelectAll,
    [TUG_ACTIONS.MAKE_UPPERCASE]: handleMakeUppercase,
    [TUG_ACTIONS.MAKE_LOWERCASE]: handleMakeLowercase,
    [TUG_ACTIONS.CORRECT_SPELLING]: handleCorrectSpelling,
    ...SPELLING_MEMORY_HANDLERS,
    // ---- Editing motion / deletion ----
    [TUG_ACTIONS.DELETE_TO_LINE_START]: handleDeleteToLineStart,
    [TUG_ACTIONS.DELETE_WORD_BACKWARD]: handleDeleteWordBackward,
    [TUG_ACTIONS.MOVE_WORD_FORWARD]: handleMoveWordForwardChain,
    [TUG_ACTIONS.MOVE_WORD_BACKWARD]: handleMoveWordBackwardChain,
  };
  // `useOptionalResponder` (not `useResponder`) so the three consuming
  // components — TugInput, TugTextarea, TugValueInput — can render
  // as a single component regardless of whether a ResponderChainProvider
  // is in scope. When the provider is absent, registration and the
  // `data-responder-id` attribute are skipped; when present, the
  // behavior is identical to `useResponder`. The component type and
  // DOM element stay stable across provider transitions, so caret
  // position, focus, and selection survive any test that wraps or
  // unwraps a provider around a mounted leaf control.
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions,
    // Delete and the two case transforms write, so they are dark on a
    // read-only or disabled control. They deliberately do NOT gate on having
    // a selection: the pushed edit block is republished on focus and
    // registration changes, not on caret moves, so a selection-granular
    // answer would be stale by the time the menu opened — the same reason
    // Cut doesn't gate on one either. The handlers no-op when nothing is
    // selected. Reads the live element at query time, never a captured
    // value [L07].
    validateAction: (action) => {
      if (
        action !== TUG_ACTIONS.DELETE &&
        action !== TUG_ACTIONS.MAKE_UPPERCASE &&
        action !== TUG_ACTIONS.MAKE_LOWERCASE &&
        action !== TUG_ACTIONS.CORRECT_SPELLING
      ) {
        return true;
      }
      const el = inputRef.current;
      return el !== null && !disabled && !el.readOnly;
    },
  });

  // ---- Ref composition ----
  //
  // One callback writes three destinations:
  //   1. The hook's internal `inputRef` (so the action handlers can
  //      reach `selectionStart`, `select()`, `setRangeText()`, etc.).
  //   2. The consumer's forwarded ref (if provided) — honored for both
  //      function refs and MutableRefObject refs, matching React's
  //      own ref-handling semantics.
  //   3. `responderRef` from `useResponder`, which writes
  //      `data-responder-id` for the chain's innermost-first walk.
  //
  // Every consumer of this hook used to open-code this merge. Moving
  // it into the hook removes ~12 duplicated lines per consumer and
  // eliminates the "did you remember to call responderRef last?"
  // footgun.

  const composedRef = useCallback(
    (el: T | null) => {
      inputRef.current = el;
      if (typeof forwardedRef === "function") {
        forwardedRef(el);
      } else if (forwardedRef) {
        (forwardedRef as React.MutableRefObject<T | null>).current = el;
      }
      responderRef(el);
    },
    [inputRef, forwardedRef, responderRef],
  );

  // ---- Right-click context menu via shared hook ----
  //
  // A single query-only `TextSelectionAdapter` instance lives in a ref for the
  // input's lifetime; the hook reads it live (via the ref) to gate the menu's
  // Cut / Copy and to decide whether a secondary-click mousedown should
  // preventDefault. Creating it once per element is sufficient.
  const adapterRef = useRef<TextSelectionAdapter | null>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    adapterRef.current = el !== null ? createNativeInputAdapter(el) : null;
  }, [inputRef]);

  const {
    onMouseDown: hookMouseDown,
    onContextMenu: hookContextMenu,
    menu: hookMenu,
  } = useTextSurfaceContextMenu({
    adapterRef,
    // Spelling guesses only where one can land, and only where the control
    // asks for spelling at all: a field marked `spellcheck="false"` (a
    // filter, a path) is one whose words are not prose. Read live [L07].
    canCorrectSpelling: useCallback(() => {
      const el = inputRef.current;
      return el !== null && !disabled && !el.readOnly && el.spellcheck;
    }, [inputRef, disabled]),
  });

  // Native mousedown listener: stop the secondary-click selection clobber at the
  // source. The hook's onMouseDown preventDefaults a right-click / Control-click
  // over a ranged selection, so the browser never collapses the selection — the
  // context menu then acts on the live selection.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onMouseDown = (e: Event) => {
      if (e instanceof MouseEvent) hookMouseDown(e);
    };
    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
    };
  }, [inputRef, hookMouseDown]);

  // ---- Editing keystroke listener ----
  //
  // Installs a `keydown` listener on the host element that consults
  // `matchEditingKeybinding` per [DM01]. Registration uses
  // `useLayoutEffect` per [L03] so the listener is in place before
  // any user keystroke can reach the element after mount — same
  // pattern as the mousedown registration above.
  //
  // On a null match the listener returns immediately (no
  // `preventDefault`), so AppKit's field editor still handles the
  // platform-handled bindings (Ctrl-A/E/F/B/etc., Option-Delete,
  // Cmd-Z) untouched. On a match, the listener calls
  // `preventDefault()` and invokes the corresponding handler
  // directly (bypassing chain dispatch — the closures are already
  // bound in this hook). The MOVE_* handlers receive
  // `event.shiftKey` per [DM05] so they extend selection on Shift.
  //
  // The `disabled` guard is defence-in-depth — a disabled input
  // normally cannot receive focus, but we mirror the chain handlers'
  // own short-circuit shape here so the keystroke surface stays
  // symmetric with the dispatch surface.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (disabled) return;
    const onKeyDown = (e: Event) => {
      if (!(e instanceof KeyboardEvent)) return;
      const binding = matchEditingKeybinding(e);
      if (binding === null) return;
      e.preventDefault();
      switch (binding.action) {
        case TUG_ACTIONS.DELETE_TO_LINE_START:
          handleDeleteToLineStart();
          return;
        case TUG_ACTIONS.DELETE_WORD_BACKWARD:
          handleDeleteWordBackward();
          return;
        case TUG_ACTIONS.MOVE_WORD_FORWARD:
          handleMoveWordForward(e.shiftKey);
          return;
        case TUG_ACTIONS.MOVE_WORD_BACKWARD:
          handleMoveWordBackward(e.shiftKey);
          return;
        default:
          // Registry contains an action this hook doesn't own (e.g.,
          // a future entry routed through CM6 only). Don't swallow
          // the keystroke — release the preventDefault by re-dispatching
          // would be racy, so the safe choice is to let the action
          // be a no-op for native inputs. Reachable only after a
          // settings-driven remap to an unsupported action.
          return;
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [
    disabled,
    inputRef,
    handleDeleteToLineStart,
    handleDeleteWordBackward,
    handleMoveWordForward,
    handleMoveWordBackward,
  ]);

  // ---- Context menu (consumer-facing handler) ----
  //
  // Consumers wire `handleContextMenu` to the input's React
  // `onContextMenu` prop. We bridge: open via the hook, then fire the
  // consumer's own `onContextMenu` prop (if supplied) afterward, so
  // legacy consumers that observed contextmenu events keep their
  // semantics. Disabled inputs and out-of-provider mounts skip the
  // menu entirely; the browser's native context menu shows in those
  // cases (we don't `preventDefault`).
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<T>) => {
      if (!disabled && manager !== null) {
        hookContextMenu(e.nativeEvent);
      }
      consumerOnContextMenu?.(e);
    },
    [disabled, manager, hookContextMenu, consumerOnContextMenu],
  );

  // Outside a chain provider the hook's menu has nowhere to dispatch
  // its actions, so suppress it. The hook itself returns `null` for
  // `menu` until `setMenuState` runs (and we don't call the hook's
  // contextmenu when `manager === null` per the gate above), but we
  // layer a second gate here so a future hook change that
  // always-renders won't leak a chain-less menu into the input's
  // tree.
  //
  // Wrap the menu in this hook's `<ResponderScope>` so that
  // `TugEditorContextMenu`'s `useControlDispatch` reads this input's
  // responder id from `ResponderParentContext` and dispatches its
  // items here — the canonical "control dispatches to its parent
  // responder" shape from `tuglaws/responder-chain.md`. The other
  // text-surface consumers (editor, markdown view, transcript cell)
  // already render their menu inside their own `<ResponderScope>`;
  // the native input is the only one whose JSX returns `<input>` and
  // `{contextMenu}` as siblings (not children of a wrapping host
  // div), so the wrap happens here at the hook boundary instead of
  // burdening every consumer with the same wiring.
  const contextMenu: React.ReactNode =
    manager !== null && hookMenu !== null ? (
      <ResponderScope>{hookMenu}</ResponderScope>
    ) : null;

  return {
    composedRef,
    handleContextMenu,
    contextMenu,
  };
}

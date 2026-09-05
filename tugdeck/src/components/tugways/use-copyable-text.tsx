/**
 * useCopyableText — hook for copyable components.
 *
 * Provides right-click → Copy for components that display informational
 * text the user might want to copy but should never directly select.
 * Examples: labels, timestamps, status lines.
 *
 * The hook:
 *   - Registers the component as a responder with a `copy` handler
 *   - Shows a TugEditorContextMenu on right-click with Copy enabled
 *     and Cut/Paste/SelectAll disabled
 *   - Copies the element's text content to the clipboard
 *   - Does NOT set user-select: text — the component inherits none
 *   - No visible selection highlight ever appears
 *
 * This is the "copyable" category from the three-category selection
 * model (selectable, copyable, chrome). See tuglaws/card-state-model.md.
 *
 * Usage:
 *   const ref = useRef<HTMLElement>(null);
 *   const { composedRef, handleContextMenu, contextMenu } = useCopyableText({ ref });
 *   return (
 *     <>
 *       <span ref={composedRef} onContextMenu={handleContextMenu}>
 *         {timestamp}
 *       </span>
 *       {contextMenu}
 *     </>
 *   );
 *
 * Laws: [L11] controls emit actions; responders handle actions
 */

import React, { useCallback, useId, useMemo, useState } from "react";
import { TugEditorContextMenu, type TugEditorContextMenuEntry } from "./tug-editor-context-menu";
import { useOptionalResponder } from "./use-responder";
import { useResponderChain } from "./responder-chain-provider";
import type { ActionHandlerResult } from "./responder-chain";
import { TUG_ACTIONS } from "./action-vocabulary";
import { useWholeEntityPress } from "@/lib/whole-entity-press";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseCopyableTextOptions {
  /**
   * Ref to the host element. The hook reads `textContent` from it
   * for the copy handler. Must be the same element the returned
   * `composedRef` is attached to.
   */
  ref: React.MutableRefObject<HTMLElement | null>;
  /**
   * Optional override for the text to copy. When provided, the copy
   * handler uses this instead of `el.textContent`. Useful when the
   * element contains child elements whose text should be filtered.
   */
  getText?: () => string;
  /**
   * Optional override for the WRITE itself, for content that is more than
   * plain text — an atom, which carries a private sidecar flavor beside its
   * text so a paste back into Tug re-materializes the chip rather than the
   * string. Return `true` when the write was handled; `false` falls through
   * to the plain-text write (the browser-mode path, where the native
   * pasteboard bridge that carries custom flavors is not installed).
   */
  write?: () => boolean;
  /**
   * When true, the context menu is suppressed and the copy handler
   * is a no-op.
   */
  disabled?: boolean;
  /**
   * Forwarded ref from the consumer. Composed with the hook's
   * internal ref so both land on the same DOM element.
   */
  forwardedRef?: React.Ref<HTMLElement>;
}

export interface UseCopyableTextResult {
  /**
   * Attach to the host element. Populates the hook's internal ref,
   * applies the forwarded consumer ref, and writes data-responder-id
   * for chain resolution.
   */
  composedRef: (el: HTMLElement | null) => void;
  /**
   * Pass to the element's onContextMenu prop. Opens the Copy menu.
   */
  handleContextMenu: (e: React.MouseEvent) => void;
  /**
   * Render this alongside the element. Contains the TugEditorContextMenu
   * portal. Returns null outside a ResponderChainProvider.
   */
  contextMenu: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCopyableText({
  ref,
  getText,
  write,
  disabled,
  forwardedRef,
}: UseCopyableTextOptions): UseCopyableTextResult {
  const manager = useResponderChain();

  // ---- Menu state ----
  const [menuState, setMenuState] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenuState(null), []);

  // ---- Action handlers ----

  const handleCopy = useCallback((): ActionHandlerResult => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    // A caller with more than plain text to write — an atom, which carries a
    // private sidecar flavor beside its text — takes the write itself. It
    // returns false when its own path is unavailable (a browser-mode run with
    // no native bridge), and the plain-text write below is the fallback.
    if (write !== undefined && write()) return;
    const text = getText ? getText() : (el.textContent ?? "");
    if (text) {
      void navigator.clipboard.writeText(text);
    }
  }, [ref, getText, write, disabled]);

  // ---- Responder registration ----

  const responderId = useId();

  // COPY_COPYABLE, not COPY. A copyable is `user-select: none`, so it can
  // never BE the document selection — and Edit ▸ Copy / ⌘C are performed by
  // AppKit against that selection (`NSText.copy(_:)`) without entering this
  // chain. Registering plain COPY here bought no keyboard copy; it only
  // terminated the Edit-menu validation walk (`findValidationResponder`
  // stops at the first node holding a handler) and, with no `validateAction`
  // to say otherwise, reported Copy as ENABLED over a chip that has nothing
  // to give it. Standing aside lets the walk reach the text surface behind
  // the chip, which validates against a real selection.
  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.COPY_COPYABLE]: handleCopy,
    },
  });

  // ---- Composed ref ----

  // The press that opens the Copy menu selects the copyable whole and paints
  // it — the one rule every menu about an entity is under
  // (`lib/whole-entity-press`). The entity is the copyable itself. Most
  // copyables are `user-select: none`, where the selection settles to nothing
  // and the press puts no mark on; a selectable one — a commit atom in the
  // transcript under its own Copy — lights whole, as it does under the
  // transcript's menu. A disabled copyable names nothing: its host claims the
  // press and names the entity itself, and so does a copyable with no
  // responder chain under it, whose menu never opens at all.
  const { attach: attachPress } = useWholeEntityPress(() =>
    disabled || manager === null ? null : ref.current,
  );

  const composedRef = useCallback(
    (el: HTMLElement | null) => {
      (ref as React.MutableRefObject<HTMLElement | null>).current = el;
      responderRef(el);
      attachPress(el);
      if (typeof forwardedRef === "function") {
        forwardedRef(el);
      } else if (forwardedRef) {
        (forwardedRef as React.MutableRefObject<HTMLElement | null>).current = el;
      }
    },
    [ref, responderRef, attachPress, forwardedRef],
  );

  // ---- Context menu ----

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (disabled || !manager) return;
      e.preventDefault();
      // The gesture is CLAIMED, not merely handled. Copyables nest — every
      // `TugLabel` is one, and a row's title is a copyable span inside a
      // `TugLabel` — so a right-click that only suppressed the native menu
      // kept bubbling and every copyable ancestor on the path opened its own
      // menu at the same point. The innermost one is the one the pointer is
      // on, and it is the only one whose text the user asked for.
      e.stopPropagation();
      setMenuState({ x: e.clientX, y: e.clientY });
    },
    [disabled, manager],
  );

  // One item, because there is one act. A copyable is an OBJECT — a badge, a
  // label, a chip — not a text surface: it holds no selection, so Cut, Paste
  // and Select All have nothing to be about. They were shown here dimmed, on
  // the theory that a familiar menu with three dead rows reads better than a
  // short live one. It does not. A dead row is not information, and the same
  // press on the same kind of object gave a five-row menu on a TugLabel and a
  // one-row menu on a TugBadge purely because one had passed a flag.
  //
  // No chord hints. This text is deliberately unselectable, and ⌘C is routed
  // natively to WebKit's copy of the DOM SELECTION — so the chord cannot
  // reach these items, and a chip promising it would be advertising a key
  // that does nothing here. The menu is the whole affordance.
  const menuItems = useMemo<TugEditorContextMenuEntry[]>(
    () => [{ action: TUG_ACTIONS.COPY_COPYABLE, label: "Copy" }],
    [],
  );

  // Wrap the menu in this hook's ResponderScope so TugEditorContextMenu's
  // targeted dispatch (via useControlDispatch) reads our responder as its
  // parent \u2014 that's the responder carrying the COPY handler. Without the
  // scope, dispatch would target whatever surrounds the consumer (a pane
  // or card), which has no copy handler, and Copy would silently no-op.
  const contextMenu = manager ? (
    <ResponderScope>
      <TugEditorContextMenu
        open={menuState !== null}
        x={menuState?.x ?? 0}
        y={menuState?.y ?? 0}
        items={menuItems}
        onClose={closeMenu}
      />
    </ResponderScope>
  ) : null;

  return { composedRef, handleContextMenu, contextMenu };
}

// ---------------------------------------------------------------------------
// useCopyableButton — right-click → Copy for chip-style buttons
// ---------------------------------------------------------------------------

/** Wiring for a copyable button: attach to its element and render the menu. */
export interface UseCopyableButtonResult {
  /** Attach to the button's `ref` prop. */
  ref: (el: HTMLElement | null) => void;
  /** Pass to the button's `onContextMenu` prop. */
  onContextMenu: (e: React.MouseEvent) => void;
  /** Render alongside the button (holds the Copy menu portal). */
  contextMenu: React.ReactNode;
}

/**
 * Right-click → Copy for a chip-style button (TugPushButton with a
 * `label-top` layout). Buttons own no intrinsic copy affordance the way
 * {@link TugBadge} does, so the Z4B control chips (Project / Mode / Model /
 * Effort) call this to copy their `Label: value` text on right-click —
 * matching the display badges beside them. `text` is the exact string copied.
 *
 * `write` is the escape hatch for content that is more than its text — a
 * session atom writes its private sidecar flavor beside the citation, so a
 * paste back into Tug returns the chip. See {@link UseCopyableTextOptions.write}.
 */
export function useCopyableButton(
  text: string,
  write?: () => boolean,
): UseCopyableButtonResult {
  const ref = React.useRef<HTMLElement | null>(null);
  const { composedRef, handleContextMenu, contextMenu } = useCopyableText({
    ref,
    getText: () => text,
    write,
  });
  return { ref: composedRef, onContextMenu: handleContextMenu, contextMenu };
}

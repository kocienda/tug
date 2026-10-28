/**
 * `useReadOnlyTextSurface` — the one selection behaviour every read-only
 * document shares.
 *
 * A read-only document is text the reader selects and copies but never
 * edits: a help document, a markdown block outside the transcript, the About
 * card. Each one gets the same four things, so the keyboard and the mouse act
 * on it the way they act on the transcript:
 *
 *   - a responder answering `SELECT_ALL` (the whole surface) and `COPY` (the
 *     current selection), with `CUT` and `PASTE` absorbed and validated off,
 *     so they stop here instead of reaching something that would perform
 *     them;
 *   - the text-surface context menu, Copy enabled over a selection that
 *     touches the surface;
 *   - selection extension — ⇧-click and the ⇧-arrow family extend a range
 *     made here ({@link attachSelectionExtension});
 *   - the `user-select: text` opt-in, which the surface's element carries as
 *     `data-tug-read-only-text` (styled in `use-read-only-text-surface.css`).
 *
 * The transcript and the Overview do not use this: their cells own the same
 * verbs with a markdown-reconstructing copy (`useTranscriptCellMenu`), and
 * they say so through {@link ReadOnlyTextHostContext}, which a nested
 * markdown block reads to stand aside.
 *
 * Laws: [L03] the context-menu listener and the extender are installed in a
 * layout effect, live before the first gesture; [L06] the opt-in is a DOM
 * attribute styled by CSS; [L07] handlers read the surface through a ref at
 * the moment they run; [L11] the verbs arrive through the responder chain.
 *
 * @module components/tugways/use-read-only-text-surface
 */

import "./use-read-only-text-surface.css";

import React, { useCallback, useId, useLayoutEffect, useRef } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import type { ActionHandlerResult } from "@/components/tugways/responder-chain";
import { attachSelectionExtension } from "@/components/tugways/selection-extension";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import { useTextSurfaceContextMenu } from "@/components/tugways/use-text-surface-context-menu";

/**
 * True inside a host that already owns Select All, Copy and the context menu
 * for the read-only text beneath it — a transcript or Overview cell. A
 * markdown block rendered there defers to the host rather than registering a
 * responder of its own, which would take ⌘A down to one block and Copy away
 * from the host's markdown reconstruction.
 */
export const ReadOnlyTextHostContext = React.createContext(false);

/** The attribute that opts a read-only surface into text selection. */
export const READ_ONLY_TEXT_ATTR = "data-tug-read-only-text";

export interface ReadOnlyTextSurface {
  /** Wrap the surface (and the menu) in this so the menu dispatches to it. */
  ResponderScope: React.FC<{ children: React.ReactNode }>;
  /** Attach to the surface's root element. */
  responderRef: (el: Element | null) => void;
  /** The context menu, rendered inside `ResponderScope`. */
  menu: React.ReactNode;
}

/** Whether the document selection is a range touching `root`. */
function selectionTouches(root: HTMLElement): boolean {
  const sel = window.getSelection();
  if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return false;
  return sel.getRangeAt(0).intersectsNode(root);
}

export function useReadOnlyTextSurface(
  rootRef: React.RefObject<HTMLElement | null>,
): ReadOnlyTextSurface {
  // Select All returns a continuation so the selection lands after the
  // menu's activation blink; the root is sampled now, inside the gesture,
  // and the continuation closes over it ([L07]).
  const handleSelectAll = useCallback((): ActionHandlerResult => {
    const root = rootRef.current;
    if (root === null) return;
    return () => {
      const sel = window.getSelection();
      if (sel === null) return;
      const range = document.createRange();
      range.selectNodeContents(root);
      sel.removeAllRanges();
      sel.addRange(range);
    };
  }, [rootRef]);

  // Copy what is selected, synchronously inside the gesture.
  const handleCopy = useCallback((): ActionHandlerResult => {
    document.execCommand("copy");
  }, []);

  // Read-only: absorbed, never performed.
  const handleAbsorb = useCallback((): ActionHandlerResult => {}, []);

  const { ResponderScope, responderRef } = useOptionalResponder({
    id: useId(),
    actions: {
      [TUG_ACTIONS.CUT]: handleAbsorb,
      [TUG_ACTIONS.COPY]: handleCopy,
      [TUG_ACTIONS.PASTE]: handleAbsorb,
      [TUG_ACTIONS.SELECT_ALL]: handleSelectAll,
    },
    validateAction: (action) =>
      action !== TUG_ACTIONS.CUT && action !== TUG_ACTIONS.PASTE,
  });

  // No adapter: right-click reflects what is already selected, with no
  // smart-click word expansion, as in `TugMarkdownView`.
  const { onContextMenu, menu } = useTextSurfaceContextMenu({
    adapterRef: null,
    hasSelectionOverride: () => {
      const root = rootRef.current;
      return root !== null && selectionTouches(root);
    },
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    root.setAttribute(READ_ONLY_TEXT_ATTR, "");
    root.addEventListener("contextmenu", onContextMenu);
    const detachExtension = attachSelectionExtension(root);
    return () => {
      detachExtension();
      root.removeEventListener("contextmenu", onContextMenu);
      root.removeAttribute(READ_ONLY_TEXT_ATTR);
    };
  }, [rootRef, onContextMenu]);

  return {
    ResponderScope,
    responderRef: responderRef as (el: Element | null) => void,
    menu,
  };
}

/** A document surface with nothing else to do: one element and its text. */
function DocumentSurface({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { ResponderScope, responderRef, menu } = useReadOnlyTextSurface(rootRef);
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );
  return (
    <ResponderScope>
      <div ref={setRoot} className={className}>
        {children}
      </div>
      {menu}
    </ResponderScope>
  );
}

/**
 * A `<div>` that is a read-only document — the shared selection behaviour
 * around whatever it holds — or, inside a host that already owns it
 * ({@link ReadOnlyTextHostContext}), a plain `<div>` that stands aside.
 */
export function ReadOnlyTextSurface({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const hosted = React.useContext(ReadOnlyTextHostContext);
  if (hosted) return <div className={className}>{children}</div>;
  return <DocumentSurface className={className}>{children}</DocumentSurface>;
}

/**
 * `usePointMenu` — the open flag, the anchor point and the menu element every
 * right-click menu on a row or an entity shares.
 *
 * Six menus — the commit, file and session identity menus, and the space, jot
 * and arc row menus — each held the same skeleton: a `{ x, y } | null` in
 * state, a close that cleared it, an open that stood down when there was no
 * responder chain, and a `TugEditorContextMenu` fed `open`/`x`/`y`/`onClose`
 * from those. This is that skeleton once. What each menu says — its items,
 * its responder, the scope and host it renders inside — stays with the menu,
 * because those are what make it the menu it is.
 *
 * **A target rides the point.** The jot row menu is raised for one jot of a
 * list, and its handlers outlive the render that opened them, so the hook
 * carries an optional target beside the point and exposes it on a ref as well
 * as on the render ([L07]): the items read `target`, the handlers read
 * `targetRef.current` at dispatch time.
 *
 * **No responder chain, no menu.** Every caller rendered nothing and opened
 * nothing outside a chain, since a menu whose items dispatch into no chain is
 * a menu that does nothing. `available` is that fact, and `openAt` refuses
 * without it.
 *
 * The open flag is React state because it decides what is MOUNTED — the menu
 * portal exists only while open — which is structure, not appearance ([L06]).
 *
 * @module components/tugways/use-point-menu
 */

import React from "react";

import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";

/** Where the menu is anchored, and what it was raised for. */
export interface PointMenuAnchor<T> {
  x: number;
  y: number;
  target: T;
}

export interface PointMenu<T> {
  /** Whether a responder chain is present; without one no menu opens. */
  available: boolean;
  /** The open anchor, or null while closed. */
  anchor: PointMenuAnchor<T> | null;
  /** The open target, read at dispatch time by handlers ([L07]). */
  targetRef: React.RefObject<T | null>;
  /** Open at a viewport point, for a target. A no-op with no chain. */
  openAt: (x: number, y: number, target: T) => void;
  /**
   * Open at a mouse event's point, claiming the event: the native menu is
   * suppressed and the event stops, so a copyable run inside the row does
   * not open a second menu over the same point.
   */
  openAtEvent: (e: React.MouseEvent, target: T) => void;
  /** Close the menu (and run the caller's `onClose`). */
  close: () => void;
  /** The `TugEditorContextMenu` for these items, wired to the anchor. */
  renderMenu: (items: TugEditorContextMenuEntry[]) => React.ReactNode;
}

export function usePointMenu<T = null>(
  options: {
    /** Runs after the menu closes, however it closed. */
    onClose?: () => void;
  } = {},
): PointMenu<T> {
  const { onClose } = options;
  const manager = useResponderChain();
  const available = manager !== null;
  const [anchor, setAnchor] = React.useState<PointMenuAnchor<T> | null>(null);

  const targetRef = React.useRef<T | null>(null);
  targetRef.current = anchor?.target ?? null;

  const close = React.useCallback((): void => {
    setAnchor(null);
    onClose?.();
  }, [onClose]);

  const openAt = React.useCallback(
    (x: number, y: number, target: T): void => {
      if (!available) return;
      setAnchor({ x, y, target });
    },
    [available],
  );

  const openAtEvent = React.useCallback(
    (e: React.MouseEvent, target: T): void => {
      if (!available) return;
      e.preventDefault();
      e.stopPropagation();
      setAnchor({ x: e.clientX, y: e.clientY, target });
    },
    [available],
  );

  const renderMenu = (items: TugEditorContextMenuEntry[]): React.ReactNode => (
    <TugEditorContextMenu
      open={anchor !== null}
      x={anchor?.x ?? 0}
      y={anchor?.y ?? 0}
      items={items}
      onClose={close}
    />
  );

  return { available, anchor, targetRef, openAt, openAtEvent, close, renderMenu };
}

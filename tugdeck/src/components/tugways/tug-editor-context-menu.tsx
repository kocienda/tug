/**
 * TugEditorContextMenu — lightweight context menu for editor surfaces.
 *
 * Purpose-built for contentEditable and input contexts where Radix's
 * focus-scope and focus-trap management would hide the selection
 * highlight and break clipboard shortcuts. Uses the industry-standard
 * editor-menu pattern: a portaled positioned <div> with
 * mousedown-preventDefault items so focus never leaves the trigger.
 *
 * Invariants:
 *
 * - Focus never moves. Each item handles onMouseDown with preventDefault,
 *   which suppresses the browser's default focus shift. The editor
 *   retains focus for the entire menu lifecycle, so:
 *     (a) the contentEditable selection stays visually painted;
 *     (b) callers can run document.execCommand and navigator.clipboard.*
 *         inside the mousedown handler — a synchronous user gesture.
 *
 * - Actions flow through the responder chain [L11] via targeted
 *   dispatch. Each item's `action` is dispatched through
 *   `useControlDispatch().dispatchForContinuation`, which calls
 *   `manager.sendToTarget(parentId, event)` with `parentId` read from
 *   `ResponderParentContext`. The handler runs on the consumer that
 *   opened the menu — not on whatever happens to be first responder —
 *   so a menu opened from a non-focused surface (e.g. a transcript
 *   cell while the editor remains first responder) still routes its
 *   actions to the correct owner. This matches the pattern used by
 *   `TugContextMenu` (Radix-backed) and is the canonical "control
 *   dispatches to its parent responder" shape from
 *   `tuglaws/responder-chain.md`. Handlers may return a continuation
 *   callback for two-phase execution: the sync body runs inside the
 *   user gesture, the continuation runs after the activation blink
 *   for visible side effects — so the user sees flash feedback
 *   first, then the result (cut, paste, etc.).
 *
 *   Contract for consumers: render `<TugEditorContextMenu />` inside
 *   the `<ResponderScope>` of the responder that should handle the
 *   menu's actions. The React-tree position *is* the dispatch target
 *   — there is no `target` prop and no fallback to first-responder
 *   dispatch. Consumers that already wrap their hosts in
 *   `useResponder().ResponderScope` (the editor, the markdown view,
 *   the transcript cells) get this for free; consumers like the
 *   native-input hook wrap the returned menu inside the responder's
 *   scope themselves.
 *
 * - Press dismissal: window-level capture-phase `pointerdown` AND `mousedown`
 *   outside the menu close it; presses inside the menu element are ignored.
 *   Both, because `mousedown` is a compatibility event a surface can suppress
 *   by calling `preventDefault` on its `pointerdown` — which is what left a
 *   menu over a Cards card row undismissable.
 *
 * - Dispatch-observer dismissal: the menu subscribes to the responder
 *   chain's observeDispatch while open. Any action flowing through the
 *   chain (keyboard shortcut, button click, programmatic dispatch)
 *   while the menu is open — other than the menu's own item
 *   activation — dismisses the menu. Uses blinkingRef to skip
 *   self-triggered dispatches during activation. This generalizes
 *   "close on external shortcut" through a single signal.
 *
 * - Referent dismissal: a menu opened over something — a whole entity,
 *   a ranged selection — is handed that thing as its `referent`, and it
 *   closes when the referent leaves the visible area of its scroller.
 *   The menu is never chased: it stays exactly where it opened, and a
 *   scroll that keeps the referent on screen does nothing to it, so the
 *   user can always see what the menu will act on. A menu with only a
 *   surface referent (a bare right-click with no selection, and every
 *   consumer that passes no referent) has nothing to lose and gains no
 *   scroll-driven dismissal. This is `TugPopover`'s stranded-dismissal
 *   rule with scroll as the mover; a per-frame reposition loop would be
 *   the wrong tool ([L05] / [L13]).
 *
 * - The wheel over the menu is inert: a wheel event on the menu element
 *   scrolls nothing and reaches nobody. The menu is portaled and fixed,
 *   so the scroller the pointer looks to be over is not its ancestor —
 *   without this a wheel over a short menu scrolled the document, and a
 *   horizontal one slid the deck behind it. A menu long enough to scroll
 *   still scrolls itself; only the leftover at its ends is swallowed.
 *
 * - Keyboard contract while the menu is open (handled at window
 *   capture before the responder chain sees the keydown):
 *     • Escape or ⌘. → close the menu.
 *     • Enter or Space → activate the keyboard-selected item.
 *     • ArrowDown / ArrowUp → cycle through actionable items,
 *       wrapping at the ends. If no item is highlighted yet,
 *       ArrowDown selects the first and ArrowUp selects the last.
 *     • Home / End → jump to the first or last actionable item.
 *     • Printable character → typeahead select: the character is
 *       appended to a 500ms-reset buffer and the first actionable
 *       item whose label begins with the buffer becomes
 *       keyboard-selected. The character does not reach the editor.
 *     • ⌘/Ctrl/Alt + anything else → close the menu and let the event
 *       continue. If the shortcut is in the keybinding map, the
 *       responder chain dispatches its action and the dispatch
 *       observer closes the menu redundantly. If not, this branch is
 *       the sole dismiss path.
 *     • Any other non-character key (Tab, function keys) → close the
 *       menu and let the event continue.
 *
 * - Visual identity: shared with TugContextMenu via tug-menu.css
 *   classes and tug-menu-item-blink.ts for the activation flash.
 *   Every menu in the suite looks and reacts identically [L20].
 *
 * When to use: over contentEditables, inputs, or any focus-sensitive
 * editing surface. For menus over buttons/rows/tree nodes, use the
 * Radix-backed TugContextMenu instead.
 *
 * Laws: [L03] register event listeners in useLayoutEffect,
 *       [L06] appearance via CSS/DOM, never React state,
 *       [L07] handlers access current state through refs,
 *       [L11] controls emit actions; responders handle actions,
 *       [L13] motion compliance — durations scale via --tug-timing,
 *       [L16] color-setting rules declare their rendering surface,
 *       [L19] component authoring guide,
 *       [L20] token sovereignty — visual identity owned by tug-menu.css
 */

import "./tug-menu.css";
import "./tug-editor-context-menu.css";

import React, {
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { playMenuItemBlink } from "./tug-menu-item-blink";
import { useRequiredResponderChain } from "./responder-chain-provider";
import { useControlDispatch } from "./use-control-dispatch";
import { useFocusTrap } from "./use-focus-trap";
import { isCancelChordEvent } from "./keymap-registry";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useOpenMenuClaim } from "@/components/tugways/use-open-menu-claim";
import type { TugAction } from "./action-vocabulary";

// ---- Typed entry shapes ----
//
// TugEditorContextMenu has its own entry types, distinct from
// tug-context-menu's TugContextMenuEntry, so the `action` field can
// be typed as `TugAction`. Typos in an item's action are compile
// errors at the item definition site, not runtime `handled: false`
// dead-ends. This is the L11-correct shape: a control emitting a
// typed action name, with no string coercion anywhere on the path
// from item definition to chain dispatch.

/**
 * An action item in an editor context menu. Activating the item
 * dispatches `action` through the responder chain.
 */
export interface TugEditorContextMenuItem {
  /** Entry discriminator. Omit or set to "item" for action items. */
  type?: "item";
  /**
   * The responder-chain action to dispatch when the item is
   * activated. Typed against `TugAction` so misspellings are compile
   * errors and autocomplete surfaces the vocabulary.
   */
  action: TugAction;
  /**
   * The `ActionEvent.value` the dispatch carries. An item that names
   * what it acts on — a path, a descriptor — puts it here, sampled at
   * menu-open time, so the action lands on whichever responder
   * implements it rather than on an intermediate node that exists only
   * to supply the missing argument.
   */
  value?: unknown;
  /** Display label for this item. Also used as the typeahead match target. */
  label: string;
  /** Optional icon node rendered before the label. */
  icon?: React.ReactNode;
  /** Optional keyboard shortcut hint rendered after the label (display only). */
  shortcut?: string;
  /** Whether this item is disabled. Disabled items are skipped by typeahead and not activatable. */
  disabled?: boolean;
}

/** A horizontal rule separating item groups. */
export interface TugEditorContextMenuSeparator {
  type: "separator";
}

/** A non-interactive section label. */
export interface TugEditorContextMenuLabel {
  type: "label";
  /** Label text. */
  label: string;
}

/** Discriminated union of all entry types in a TugEditorContextMenu items array. */
export type TugEditorContextMenuEntry =
  | TugEditorContextMenuItem
  | TugEditorContextMenuSeparator
  | TugEditorContextMenuLabel;

/**
 * What a menu is about, for the scroll-out dismissal above: the element
 * the press settled on, or the range the selection covers. Both move with
 * the content, so both answer "is the thing this menu acts on still
 * visible?" from one `getBoundingClientRect`.
 */
export type TugEditorContextMenuReferent = HTMLElement | Range;

/** The element a referent hangs from — what its scroller is found from. */
function referentHost(referent: TugEditorContextMenuReferent): Element | null {
  if (referent instanceof Range) {
    const node = referent.startContainer;
    return node instanceof Element ? node : node.parentElement;
  }
  return referent;
}

/**
 * Nearest ancestor that can scroll its overflow — the referent's
 * visible-area owner. `null` when nothing above it scrolls, in which case
 * the viewport is the only port that matters.
 */
function nearestScroller(el: Element | null): HTMLElement | null {
  for (
    let node = el?.parentElement ?? null;
    node !== null;
    node = node.parentElement
  ) {
    const style = window.getComputedStyle(node);
    const scrollsY =
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight;
    const scrollsX =
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      node.scrollWidth > node.clientWidth;
    if (scrollsY || scrollsX) return node;
  }
  return null;
}

/** A viewport-coordinate rectangle, as the ports below are compared. */
interface Port {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * The scroller's scrollport in viewport coordinates. `clientTop` /
 * `clientLeft` are the border widths, and `clientHeight` / `clientWidth`
 * already exclude both the borders and any classic scrollbar gutter — so
 * this is the content box the user actually sees through.
 */
function scrollportOf(scroller: HTMLElement): Port {
  const box = scroller.getBoundingClientRect();
  const top = box.top + scroller.clientTop;
  const left = box.left + scroller.clientLeft;
  return {
    top,
    left,
    bottom: top + scroller.clientHeight,
    right: left + scroller.clientWidth,
  };
}

/** Whether any part of `rect` is drawn inside `port`. */
function intersects(rect: DOMRect, port: Port): boolean {
  return (
    rect.bottom > port.top &&
    rect.top < port.bottom &&
    rect.right > port.left &&
    rect.left < port.right
  );
}

/**
 * Whether the referent is still drawn somewhere the user can see it.
 *
 * Any overlap counts: a referent half out of the scrollport is still a
 * referent the user can point at, and closing early would cost the peek
 * that makes staying-put the right behavior in the first place. Two ports
 * are checked — the referent's own scroller, and the viewport, which
 * catches a whole card moved off screen by something other than the
 * scroll that fired the event.
 *
 * A referent that has gone unanswerable — its host disconnected by
 * virtualization, or its box collapsed to nothing — is not visible. That
 * is the honest reading: a row recycled out of the DOM scrolled away.
 */
function referentIsVisible(
  referent: TugEditorContextMenuReferent,
  scroller: HTMLElement | null,
): boolean {
  const host = referentHost(referent);
  if (host === null || !host.isConnected) return false;
  const rect = referent.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  if (scroller !== null && !intersects(rect, scrollportOf(scroller))) {
    return false;
  }
  return intersects(rect, {
    top: 0,
    left: 0,
    bottom: window.innerHeight,
    right: window.innerWidth,
  });
}

export interface TugEditorContextMenuProps {
  /** Whether the menu is open. */
  open: boolean;
  /** Viewport x coordinate of the anchor point (typically clientX of the contextmenu event). */
  x: number;
  /** Viewport y coordinate of the anchor point (typically clientY of the contextmenu event). */
  y: number;
  /**
   * Menu entries — items, separators, and section labels. Each action
   * item's `action` field is the responder-chain action name
   * dispatched when the item is activated. The dispatch is targeted
   * via `useControlDispatch` to the parent responder — i.e., the
   * nearest enclosing `<ResponderScope>` in the React tree — so the
   * consumer's responder must wrap the rendered
   * `<TugEditorContextMenu />`.
   */
  items: TugEditorContextMenuEntry[];
  /** Called when the menu should close (Escape, outside click, or after a selection). */
  onClose: () => void;
  /**
   * What this menu is about, when it is about something the user can see:
   * the element a whole-entity press settled on, or the range a selection
   * covers. Supplied, the menu closes as soon as that thing leaves the
   * visible area of its scroller. Omitted — which is every menu whose
   * items act on the surface rather than on a point in it — the menu
   * keeps its other dismiss paths and survives any scroll.
   */
  referent?: TugEditorContextMenuReferent | null;
}

/** Gap in px between the menu and the viewport edge when flipping. */
const VIEWPORT_MARGIN = 8;

/** How long the typeahead buffer persists between keystrokes. */
const TYPEAHEAD_BUFFER_TIMEOUT_MS = 500;

/**
 * Keep a gesture inside the menu. Only React's own propagation is stopped —
 * the menu portals out of its host's DOM subtree but not out of its REACT
 * subtree, so without this the host's handlers run on the menu's clicks. Native
 * listeners on `window`/`document` (dismissal, the responder chain) travel the
 * DOM and are untouched.
 */
function stopReactPropagation(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

/** True if the entry is a selectable, non-disabled action item. */
function isActionable(entry: TugEditorContextMenuEntry): entry is TugEditorContextMenuItem {
  if (entry.type === "separator" || entry.type === "label") return false;
  return !entry.disabled;
}

export function TugEditorContextMenu({
  open,
  x,
  y,
  items,
  onClose,
  referent = null,
}: TugEditorContextMenuProps) {
  const manager = useRequiredResponderChain();
  // Targeted dispatch to the parent responder — the consumer that
  // wrapped this menu in its `<ResponderScope>`. Mirrors
  // `TugContextMenu`'s use of the same hook for the same reason.
  const { dispatchForContinuation } = useControlDispatch();
  const overlayRoot = useCanvasOverlay();
  const menuRef = useRef<HTMLDivElement>(null);

  // Two-pass positioning: the JSX renders the menu off-screen with
  // visibility:hidden. useLayoutEffect measures the actual size and
  // writes the final position + visibility directly to the DOM [L06].
  // Using React state for position would trigger an extra render
  // cycle; direct style writes on the ref avoid it. `positionedRef`
  // prevents re-positioning on subsequent renders (which could happen
  // if `items` changes while the menu is open).
  const positionedRef = useRef(false);

  // All transient UI state lives in refs with direct DOM mutation [L06].
  // The only React state is `open` (mount/unmount lifecycle) via the prop.
  const itemsRef = useRef(items);
  const onCloseRef = useRef(onClose);
  // Keyboard-selected item's action (the item painted via data-highlighted).
  // Updated by typeahead and pointer enter; writes bypass React state
  // and imperatively set the attribute on the matching DOM node.
  const selectedActionRef = useRef<TugAction | null>(null);
  const typeBufferRef = useRef("");
  const typeBufferTimerRef = useRef<number | null>(null);
  // Re-entrancy guard: while the activation blink is in flight, ignore
  // additional activation attempts. Reset when the menu closes.
  const blinkingRef = useRef(false);

  useLayoutEffect(() => { itemsRef.current = items; }, [items]);
  useLayoutEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Stable close request: imperatively hide the menu then fire `onClose`. Used by
  // the engine's Escape ladder (the trap's `onEscapeDismiss`) and the ⌘. keydown.
  const requestClose = useCallback(() => {
    const menu = menuRef.current;
    if (menu) menu.style.display = "none";
    onCloseRef.current();
  }, []);

  // Engine focus trap ([P04] / [Q02]): the hand-rolled editor context menu joins
  // the engine model for STACK PRESENCE + Escape arbitration only. It keeps the
  // editor focused for its whole lifecycle (items mousedown-preventDefault), so it
  // needs NO close-focus teardown writer — `onCloseAutoFocus` is unused and the
  // trap pops with `moveDomFocus: true`, harmlessly re-projecting the editor key
  // view (which never lost focus). Registering `onEscapeDismiss` lets the engine's
  // ladder own Escape; the local Escape keydown branch is deleted below. ⌘. stays
  // handled in the window keydown listener.
  //
  // `kbf: false` keeps that contract whole. An engaging trap flips
  // `kbfEngaged()`, and the settle that follows RE-LANDS the keyboard for the
  // current key view — which grants the caret back onto the editor. That grant
  // collapses the document selection, so a right-click that WebKit had just
  // smart-selected a word for came back with nothing selected, and every menu
  // item scoped to the selection acted on an empty one. This menu has no engine
  // stops to ring (its highlight is `data-highlighted`, written imperatively),
  // and it is opened by a pointer — the gesture the mode's own rule says leaves
  // keyboard navigation. So it takes the same opt-out the completion popup
  // takes: stack presence without engagement.
  useFocusTrap({ active: open, onEscapeDismiss: requestClose, kbf: false });

  // While this menu stands, no tooltip opens anywhere. A commit row raises
  // this menu from a right-click and also carries a hover tip; without the
  // claim, a pointer crossing the rows behind the menu would float a second
  // surface over the one the user is reading.
  useOpenMenuClaim(open);

  // Reset all transient state whenever the menu closes so the next
  // open starts fresh.
  useLayoutEffect(() => {
    if (open) return;
    positionedRef.current = false;
    selectedActionRef.current = null;
    typeBufferRef.current = "";
    if (typeBufferTimerRef.current !== null) {
      window.clearTimeout(typeBufferTimerRef.current);
      typeBufferTimerRef.current = null;
    }
    blinkingRef.current = false;
  }, [open]);

  /**
   * Imperatively set the highlighted menu item. Queries the DOM by
   * data-item-action and toggles the `data-highlighted` attribute.
   * Avoids React state for appearance per L06 — single item
   * highlighted at any instant, no render cycle, driven by both
   * keyboard typeahead and pointer enter so mouse and keyboard share
   * one selection.
   */
  const setHighlightedItem = useCallback((action: TugAction | null) => {
    const menu = menuRef.current;
    if (!menu) return;
    selectedActionRef.current = action;
    // Clear any previously-highlighted item.
    menu.querySelectorAll<HTMLElement>("[data-highlighted]").forEach((el) => {
      el.removeAttribute("data-highlighted");
    });
    // Mark the new one, if any.
    if (action) {
      const escAction = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(action) : action;
      const next = menu.querySelector<HTMLElement>(`[data-item-action="${escAction}"]`);
      next?.setAttribute("data-highlighted", "");
    }
  }, []);

  // Position the menu after it mounts by writing directly to style [L06].
  // No React state, no extra render.
  useLayoutEffect(() => {
    if (!open) return;
    if (positionedRef.current) return;
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, vw - rect.width - VIEWPORT_MARGIN);
    }
    if (top + rect.height > vh - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, vh - rect.height - VIEWPORT_MARGIN);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
    positionedRef.current = true;
  }, [open, x, y]);

  /**
   * Activate an item. Two-phase execution via the responder chain:
   *
   * 1. Dispatch `{action, phase: "discrete"}` through the chain
   *    synchronously — inside the current user gesture. The handler
   *    runs inside the mousedown/keydown stack, so clipboard APIs
   *    and execCommand work. If the handler returns a continuation
   *    callback (see ActionHandler), `dispatchForContinuation`
   *    exposes it here.
   *
   * 2. Play the activation blink. When it finishes, run the optional
   *    continuation returned by the handler — for visible side effects
   *    like deleting the cut text or inserting pasted text. This is
   *    where the user *sees* the result, after the flash feedback,
   *    matching the "button press then result" UX [L11].
   *
   * Then close the menu.
   *
   * Dispatch is targeted to the menu's parent responder via
   * `useControlDispatch`. The first responder is irrelevant — the
   * action lands on whoever wrapped the rendered menu in their
   * `<ResponderScope>`. `action` is typed as TugAction because menu
   * items are declared with typed actions at the consumer site
   * (via TugEditorContextMenuItem); no cast or coercion is needed
   * on the dispatch path.
   *
   * The item's `value` rides along, resolved from the live items by
   * action name so the pointer and keyboard paths carry it alike.
   */
  const activateItem = useCallback((target: HTMLElement, action: TugAction) => {
    if (blinkingRef.current) return;
    blinkingRef.current = true;
    const item = itemsRef.current.find(
      (entry): entry is TugEditorContextMenuItem =>
        entry.type !== "separator" && entry.type !== "label" && entry.action === action,
    );
    // Phase 1: synchronous targeted dispatch to the parent responder.
    const { continuation } = dispatchForContinuation({
      action,
      value: item?.value,
      phase: "discrete",
    });
    // Phase 2: play the blink, then the continuation (if any), then close.
    playMenuItemBlink(target).finally(() => {
      blinkingRef.current = false;
      try {
        continuation?.();
      } finally {
        onCloseRef.current();
      }
    });
  }, [dispatchForContinuation]);

  /**
   * Append a character to the typeahead buffer and move the keyboard
   * selection to the first actionable item whose label begins with the
   * buffer (case-insensitive). The buffer clears after
   * TYPEAHEAD_BUFFER_TIMEOUT_MS of inactivity.
   */
  const applyTypeahead = useCallback((char: string) => {
    typeBufferRef.current += char.toLowerCase();
    const buffer = typeBufferRef.current;
    const match = itemsRef.current.find(
      (entry) =>
        isActionable(entry) &&
        entry.label.toLowerCase().startsWith(buffer),
    );
    if (match && isActionable(match)) {
      setHighlightedItem(match.action);
    }
    if (typeBufferTimerRef.current !== null) {
      window.clearTimeout(typeBufferTimerRef.current);
    }
    typeBufferTimerRef.current = window.setTimeout(() => {
      typeBufferRef.current = "";
      typeBufferTimerRef.current = null;
    }, TYPEAHEAD_BUFFER_TIMEOUT_MS);
  }, [setHighlightedItem]);

  // Dismiss on unrelated responder-chain traffic.
  //
  // The menu registers a dispatch observer with the responder chain:
  // every action flowing through the chain (via dispatch,
  // sendToFirstResponderForContinuation, or sendToTarget) fires this callback. If
  // the menu is the one dispatching (an item activation in flight —
  // blinkingRef is true), we skip the close so the menu can finish
  // its own animation. Otherwise, the dispatch is external (⌘A,
  // ⌘Backtick, a button click somewhere else, etc.) and the menu
  // dismisses.
  //
  // This is the generalized version of "close on external shortcut"
  // and uses the responder chain as the single signal, per [L11].
  // Keyboard shortcuts, clicks, and programmatic dispatches all
  // funnel through the same observer.
  useLayoutEffect(() => {
    if (!open) return;
    const unsubscribe = manager.observeDispatch(() => {
      if (blinkingRef.current) return;
      const menu = menuRef.current;
      if (menu) menu.style.display = "none";
      onCloseRef.current();
    });
    return unsubscribe;
  }, [open, manager]);

  // Referent dismissal: close as soon as the thing this menu is about
  // leaves the visible area of its scroller [B02]. Registered in a layout
  // effect per [L03], on `window` in the capture phase because `scroll`
  // does not bubble — capture is the only way one listener hears every
  // scroller, and the menu does not know which of them moves its
  // referent. The check is event-driven and one-shot [B04]: two rect
  // reads per scroll event, no per-frame loop, and no repositioning —
  // the menu stays exactly where it opened [B01].
  //
  // A menu with no referent registers nothing, which is the whole of
  // [B03]: Paste and Select All act on a surface that is still there
  // after any scroll, so there is nothing for a scroll to strand.
  useLayoutEffect(() => {
    if (!open) return;
    if (referent === null) return;
    // Resolved once at open time, like the popover's observed ancestors:
    // the scroller a referent hangs from does not change while a menu
    // stands over it.
    const scroller = nearestScroller(referentHost(referent));
    const onScroll = (): void => {
      if (referentIsVisible(referent, scroller)) return;
      // Hide before the close commits, so no frame paints a menu armed
      // against something already gone.
      requestClose();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, referent, requestClose]);

  // A wheel over the menu itself is inert [B05]. The menu is portaled and
  // `position: fixed`, so the scroller the pointer appears to be over is not
  // its DOM ancestor: a wheel over a menu with nothing to scroll reached the
  // document, and a horizontal one reached DeckCanvas's own bubble-phase
  // wheel listener and slid the deck sideways behind the open menu. Resting
  // the pointer on a menu and scrolling now does nothing, which is what a
  // native menu does and what a reader expects of a surface they are reading.
  //
  // Native and `{ passive: false }` because React attaches `wheel` at its
  // root as a passive listener, where `preventDefault` is a no-op — the same
  // reason `deck-canvas` and `use-outer-scroll-on-modifier-wheel` register
  // their own. `stopPropagation` is the other half: `preventDefault` stops
  // the browser's scroll but not an ancestor's listener.
  //
  // A menu long enough to scroll keeps its own wheel. Only the leftover at
  // either end is swallowed, so nothing here can make a long menu's last
  // items unreachable.
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (menu === null) return;
    const onWheel = (event: WheelEvent): void => {
      const room = menu.scrollHeight - menu.clientHeight;
      if (room > 0 && event.deltaY !== 0) {
        const atEnd =
          event.deltaY > 0 ? menu.scrollTop >= room - 1 : menu.scrollTop <= 0;
        if (!atEnd) return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    menu.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      menu.removeEventListener("wheel", onWheel);
    };
  }, [open]);

  // Window-level event registration, capture phase, via useLayoutEffect
  // per L03. Two critical reasons to register on window rather than
  // document:
  //
  // 1. The responder-chain-provider installs a document-level capture
  //    keydown listener. When a keybinding matches (e.g. ⌘A → selectAll
  //    dispatched to TugPane's responder) and a responder handles it,
  //    the provider calls event.stopImmediatePropagation() — which
  //    silences every other listener registered on the same element
  //    and phase. A document-level listener installed after the
  //    provider never sees handled shortcuts.
  // 2. Window is higher in the native capture chain than document, so
  //    a window capture listener runs *before* any document-level
  //    listener regardless of registration order. This lets us dismiss
  //    the menu first and still let the native shortcut proceed.
  //
  // Using useLayoutEffect (not useEffect) guarantees the listeners are
  // attached before the browser paints the menu — so the first key
  // event after the menu appears is always handled.
  useLayoutEffect(() => {
    if (!open) return;

    const onWindowPress = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      // Imperatively hide immediately, then schedule React unmount.
      // Direct DOM mutation guarantees the menu is visually gone
      // before the event's default action proceeds, regardless of
      // React 19 concurrent batching.
      const menu = menuRef.current;
      if (menu) menu.style.display = "none";
      onCloseRef.current();
    };

    const dismiss = () => {
      const menu = menuRef.current;
      if (menu) menu.style.display = "none";
      onCloseRef.current();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Modifier-only keypress (Meta, Control, Alt, or Shift pressed
      // by itself, no other key) — ignore entirely. The modifier state
      // is set on the event, but the user hasn't actually invoked
      // anything yet. They're either in the middle of pressing a
      // combo or will release the key; neither case should dismiss
      // the menu.
      if (
        e.key === "Meta" ||
        e.key === "Control" ||
        e.key === "Alt" ||
        e.key === "Shift"
      ) {
        return;
      }

      // Every branch below is menu-local: it is the open menu's own keyboard —
      // arrow cycling, typeahead, activation, dismiss — live only while the
      // menu is on screen and gone when it closes. That is a surface's
      // internal navigation rather than a command claim, which is why it stays
      // here rather than becoming scoped bindings: the keymap describes what
      // chords mean in the app, and inside an open menu the answer is "the
      // menu", once, for all of them.

      // ⌘. — the registry's Cancel chord, read from the table rather than
      // authored, so a rebind reaches here too. Close without letting the
      // event propagate (it has no meaning in the editor).
      if (isCancelChordEvent(e)) {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
        return;
      }

      // Escape is owned by the engine's Escape ladder ([P02]) via the trap's
      // `onEscapeDismiss` (= `requestClose`). Do NOT handle it here — letting it
      // propagate to the engine's document listener is what routes it to the
      // ladder (this window listener fires first in the capture chain, so a local
      // handler would shadow the engine).

      // Enter / Space — activate the keyboard-selected item, if any.
      if (e.key === "Enter" || e.key === " ") {
        const action = selectedActionRef.current;
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        // Locate the item's DOM element for the blink via its action
        // name. Escape the action for use in the attribute selector.
        const escAction = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(action) : action;
        const target = menuRef.current?.querySelector<HTMLElement>(
          `[data-item-action="${escAction}"]`,
        );
        if (target) activateItem(target, action);
        return;
      }

      // Arrow / Home / End — cycle the highlighted item through the
      // actionable entries (skipping separators, labels, and disabled
      // items). Wraps at both ends. If nothing is currently
      // highlighted, ArrowDown picks the first actionable and ArrowUp
      // picks the last — matching native menu behavior. Separators
      // and disabled items are never highlighted because `isActionable`
      // filters them out of the cycle list, so walking the cycle
      // never lands on one and the user can't get "stuck" on a
      // non-activatable entry.
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        e.preventDefault();
        e.stopPropagation();
        const actionables = itemsRef.current.filter(isActionable);
        if (actionables.length === 0) return;
        const currentAction = selectedActionRef.current;
        const currentIdx = currentAction
          ? actionables.findIndex((it) => it.action === currentAction)
          : -1;
        let nextIdx: number;
        if (e.key === "Home") {
          nextIdx = 0;
        } else if (e.key === "End") {
          nextIdx = actionables.length - 1;
        } else if (e.key === "ArrowDown") {
          // No current selection → first. Otherwise → next, wrap.
          nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % actionables.length;
        } else {
          // ArrowUp: no current selection → last. Otherwise → prev, wrap.
          nextIdx =
            currentIdx < 0
              ? actionables.length - 1
              : (currentIdx - 1 + actionables.length) % actionables.length;
        }
        setHighlightedItem(actionables[nextIdx].action);
        return;
      }

      // Any other modifier combo (⌘X, ⌘C, ⌘V, ⌘Z, …) — close the menu
      // and let the event continue to the editor so the shortcut runs
      // natively. No preventDefault, but flushSync so the menu is
      // visibly gone before the editor processes the shortcut.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        dismiss();
        return;
      }

      // Printable character — typeahead select. Consume the key so it
      // doesn't reach the editor.
      if (e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        applyTypeahead(e.key);
        return;
      }

      // Any other non-character key (Tab, function keys) — close the
      // menu and let the event pass through.
      dismiss();
    };
    // BOTH presses, and the pair is not belt-and-braces. `mousedown` alone was
    // the dismissal for a long time, and it is a COMPATIBILITY event: a
    // surface whose `pointerdown` handler calls `preventDefault` suppresses it
    // outright, and the menu then had nothing left to hear. The Cards card's rows do
    // exactly that — a press there is a reorder that has not decided it is a
    // drag yet, and claiming the press is how the list knows to hold its
    // selection — so a menu opened over a session row stayed up while the user
    // clicked around underneath it. `pointerdown` always fires and fires
    // first; `mousedown` stays for anything that synthesizes only mouse
    // events. Both are guarded by the same containment check, so a press
    // inside the menu is still the menu's own, and dismissing twice is
    // idempotent.
    window.addEventListener("pointerdown", onWindowPress, true);
    window.addEventListener("mousedown", onWindowPress, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onWindowPress, true);
      window.removeEventListener("mousedown", onWindowPress, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, activateItem, applyTypeahead, setHighlightedItem]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      data-slot="tug-editor-context-menu"
      className="tug-menu-content tug-editor-context-menu"
      role="menu"
      // Mark the menu and its items as focus-refusing so a click on
      // an item does NOT promote a first responder. The menu portals
      // to canvas overlay, which is structurally outside the
      // responder hierarchy but, in the DOM, sits inside DeckCanvas's
      // wrapper (data-responder-id="deck-canvas"). Without this
      // attribute, `responder-chain-provider`'s document-level
      // pointerdown listener would walk DOM-up from the clicked menu
      // item, find no closer responder, land on deck-canvas, and
      // promote it. Even though the menu's own dispatch is *targeted*
      // (sendToTarget(parentId)) and so doesn't depend on first
      // responder, clobbering first responder mid-menu would break
      // unrelated chain behavior — keyboard shortcuts arriving while
      // the menu is open would route to deck-canvas instead of the
      // surface the user was working with. With the attribute,
      // promotion is skipped and the responder that owned the
      // surface that opened the menu (the editor, the transcript
      // cell, etc.) keeps first-responder status across the menu's
      // lifetime.
      data-tug-focus="refuse"
      // Suppress the browser's native context menu on right-click
      // within our own menu — otherwise right-clicking an item would
      // stack the system menu on top.
      onContextMenu={(e) => e.preventDefault()}
      // The menu's own gestures stop at the menu. It PORTALS to the canvas
      // overlay, but React events bubble along the REACT tree, not the DOM one
      // — so a click on `Copy` was still delivered to whatever surface rendered
      // the menu, as an ordinary primary click on that surface. Right-clicking
      // a session chip in a History row and taking Copy folded the commit open
      // under it, and the row's own `button !== 0` guard could not see it: by
      // then the event was a real left-click on a menu item several layers away
      // in the DOM. Native listeners (the dismissal watcher on `window`, the
      // responder chain's own `pointerdown`) are unaffected — React's
      // propagation is not the DOM's.
      onPointerDown={stopReactPropagation}
      onPointerUp={stopReactPropagation}
      onMouseDown={stopReactPropagation}
      onMouseUp={stopReactPropagation}
      onClick={stopReactPropagation}
      onDoubleClick={stopReactPropagation}
      onAuxClick={stopReactPropagation}
      // The wheel is swallowed by the native listener above, which is where
      // `preventDefault` still works; this keeps the React tree's own
      // handlers out of it for the same reason the presses above do.
      onWheel={stopReactPropagation}
      // Initial style: off-screen and hidden. A useLayoutEffect
      // measures the menu size and writes left/top/visibility directly
      // to the DOM (L06) — no React state, no extra render cycle.
      style={{
        position: "fixed",
        left: -9999,
        top: -9999,
        visibility: "hidden",
      }}
    >
      {items.map((entry, index) => {
        if (entry.type === "separator") {
          return (
            <div
              key={`sep-${index}`}
              className="tug-menu-separator"
              role="separator"
            />
          );
        }

        if (entry.type === "label") {
          return (
            <div
              key={`label-${index}`}
              className="tug-menu-label"
              role="presentation"
            >
              {entry.label}
            </div>
          );
        }

        // Action item (type === "item" or undefined).
        const item = entry;
        const disabled = item.disabled ?? false;

        return (
          <div
            key={item.action}
            data-item-action={item.action}
            className="tug-menu-item"
            role="menuitem"
            aria-disabled={disabled || undefined}
            data-disabled={disabled ? "" : undefined}
            // onMouseDown (not onClick) with preventDefault is the core
            // trick: it suppresses the browser's default focus shift, so
            // the editor keeps focus and the DOM selection stays live.
            // Running onSelect synchronously in the same handler means
            // the caller's clipboard commands execute inside the user
            // gesture window.
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              if (disabled) return;
              activateItem(e.currentTarget as HTMLElement, item.action);
            }}
            // Mouse hover updates the highlighted item via a direct
            // DOM write (L06) — shares the same single-selection model
            // as keyboard typeahead.
            onPointerEnter={() => {
              if (!disabled) setHighlightedItem(item.action);
            }}
          >
            {item.icon !== undefined && (
              <span className="tug-menu-item-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="tug-menu-item-label">{item.label}</span>
            {item.shortcut !== undefined && (
              <span className="tug-menu-item-shortcut">{item.shortcut}</span>
            )}
          </div>
        );
      })}
    </div>,
    overlayRoot,
  );
}

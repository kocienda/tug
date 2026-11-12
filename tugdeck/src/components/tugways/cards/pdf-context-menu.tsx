/**
 * PdfContextMenu — Right-click context menu wrapping @radix-ui/react-context-menu.
 *
 * A compositional component: all visual identity is delegated to tug-menu.css [L20].
 * No component CSS file — uses the same `.tug-menu-*` classes and `--tugx-menu-*`
 * tokens as TugPopupMenu, sharing the menu token owner without duplication.
 *
 * The `children` prop is the right-click target area (a card, a row, a region),
 * wrapped by Radix ContextMenu.Trigger with asChild. Items carry a typed
 * `action: TugAction` (optionally with a `value` payload). Activation plays
 * the shared double-blink WAAPI animation and then dispatches the action
 * through the responder chain via targeted `dispatchToForContinuation`,
 * matching the TugPopupButton precedent [L11].
 *
 * ## Chain-reactive dismissal via observeDispatch
 *
 * While the menu is open, PdfContextMenu subscribes to
 * `manager.observeDispatch`. Any action flowing through the chain — a
 * keyboard shortcut, a button click elsewhere, a programmatic dispatch —
 * dismisses the menu. The menu's own item activations are guarded by
 * `blinkingRef`: during the blink-animate-then-dispatch window, blinkingRef
 * is true and the observer skips its close so the menu can finish its own
 * animation. Matches the `tug-popup-menu` and `tug-editor-context-menu`
 * precedents.
 *
 * Because Radix ContextMenu is uncontrolled by design (no `open` /
 * `defaultOpen` props — it opens only on a native contextmenu event),
 * both the chain-reactive dismiss and the post-blink close synthesize a
 * document-level Escape keydown to trigger Radix's own dismiss path. We
 * still track local open state via `onOpenChange` so the effect can
 * install and tear down cleanly.
 *
 * ## The trigger claims the gesture
 *
 * The trigger's right-click is claimed: the cloned child stops the synthetic
 * `contextmenu` event, so an ancestor surface that runs its own contextmenu
 * pipeline (a transcript cell, the markdown view) doesn't open a second menu
 * over the same press. Radix's own trigger handler is composed after the
 * child's, so this menu still opens.
 *
 * When rendered outside a ResponderChainProvider (standalone previews,
 * unit tests without a provider), `useResponderChain()` returns null and
 * the dispatch + subscription are silently skipped. The menu still
 * renders, opens via right-click, and closes via the native Escape path.
 *
 * Laws: [L06] appearance via CSS/DOM, [L11] controls emit actions,
 *       [L16] foreground rules declare surfaces, [L19] component authoring guide,
 *       [L20] token sovereignty
 */

import "@/components/tugways/tug-menu.css";

import React, { useCallback, useContext, useId, useLayoutEffect, useRef, useState } from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { playMenuItemBlink } from "@/components/tugways/tug-menu-item-blink";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import { isSyntheticEscape, markSyntheticEscape } from "@/components/tugways/internal/synthetic-escape";
import { TugSheetStackingContext } from "@/components/tugways/tug-sheet-stacking-context";
import { cn } from "@/lib/utils";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useOpenMenuClaim } from "@/components/tugways/use-open-menu-claim";
import type { TugAction } from "@/components/tugways/action-vocabulary";
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";

// ---- Types ----

/**
 * Payload types supported by the `value` field of a `PdfContextMenuItem`.
 *
 * Mirrors `TugPopupButtonPayload` — the same runtime-narrowable shapes
 * that `useResponderForm`'s binding slots expect. A single items array is
 * homogeneous: every item's `value` has the same type `V`, enforced at
 * compile time via the generic parameter on `PdfContextMenuItem<V>`.
 */
export type PdfContextMenuItemPayload = boolean | number | string | string[];

/**
 * A single action item in the context menu. Activating the item dispatches
 * `action` through the responder chain, carrying `value` as the payload.
 *
 * Mirrors `TugPopupButtonItem<V>`: for semantic-action menus, each item
 * carries a distinct `action` and `value` is usually undefined. For
 * value-picker use cases (rare for a context menu but supported), all
 * items share one `action` such as `TUG_ACTIONS.SET_VALUE` and differ by
 * the `value` field.
 *
 * The default type parameter is `never`, which forces consumers who pass
 * `value` to annotate the items array explicitly. Semantic-action items
 * with no payload work with the default and do not require annotation.
 */
export interface PdfContextMenuItem<V extends PdfContextMenuItemPayload = never> {
  /**
   * Entry type. Omit or set to "item" for action items.
   * @default "item"
   */
  type?: "item";
  /**
   * The responder-chain action to dispatch when the item is activated.
   * Typed against `TugAction` so misspellings are compile errors.
   */
  action: TugAction;
  /**
   * Optional payload shipped as the dispatched event's `value` field.
   * For pure semantic-action items, omit. For value pickers, all items
   * in a single array must share the same `V`.
   */
  value?: V;
  /** Display label for this item. */
  label: string;
  /** Optional icon node rendered before the label. */
  icon?: React.ReactNode;
  /** Optional keyboard shortcut hint rendered after the label. */
  shortcut?: string;
  /** Whether this item is disabled. Disabled items are not interactive. */
  disabled?: boolean;
}

/** A horizontal rule separating item groups. */
export interface PdfContextMenuSeparator {
  type: "separator";
}

/** A non-interactive section label. */
export interface PdfContextMenuLabel {
  type: "label";
  /** Label text. */
  label: string;
}

/** Discriminated union of all entry types in a PdfContextMenu items array. */
export type PdfContextMenuEntry<V extends PdfContextMenuItemPayload = never> =
  | PdfContextMenuItem<V>
  | PdfContextMenuSeparator
  | PdfContextMenuLabel;

// ---- Props ----

export interface PdfContextMenuProps<V extends PdfContextMenuItemPayload = never> {
  /** Menu entries — action items, separators, and section labels. */
  items: PdfContextMenuEntry<V>[];
  /**
   * Stable opaque sender id for chain dispatches. Auto-derived via
   * `useId()` if omitted. Parent responders disambiguate multi-menu
   * forms by matching this id in their action handler bindings. [L11]
   */
  senderId?: string;
  /** The right-click target area. Wrapped by Radix ContextMenu.Trigger with asChild. */
  children: React.ReactElement;
}

// ---- Internal helpers ----

/**
 * Synthesize a document-level Escape keydown to dismiss the open Radix
 * ContextMenu. Radix ContextMenu is uncontrolled, so this is the only
 * programmatic close path available.
 */
function synthesizeEscapeDismiss(): void {
  // [P03]/[R02] Mark the synthetic Escape so the engine's own listeners
  // early-return on it (no re-arbitration → no loop through `onEscapeDismiss`)
  // while the context menu's `onEscapeKeyDown` suppressor lets it THROUGH to
  // Radix's DismissableLayer, which performs the actual close.
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  markSyntheticEscape(event);
  document.dispatchEvent(event);
}

// ---- PdfContextMenu ----

/**
 * PdfContextMenu — right-click context menu with chain-native activation
 * and chain-reactive dismissal.
 *
 * Items carry typed `action: TugAction` (+ optional payload); selection
 * dispatches via `manager.sendToFirstResponderForContinuation` after the shared
 * double-blink animation. While open, the menu subscribes to
 * `observeDispatch` so external chain activity dismisses it (menu's own
 * activations are guarded by `blinkingRef`).
 */
export function PdfContextMenu<V extends PdfContextMenuItemPayload = never>({
  items,
  senderId,
  children,
}: PdfContextMenuProps<V>) {
  const overlayRoot = useCanvasOverlay();

  // Popup-in-sheet z-tier elevation per [D09]. When the menu's React
  // tree is rendered inside a `<TugSheetContent>`, the sheet provides
  // `TugSheetStackingContext` with `true`; we tag the portaled content
  // so its CSS class swaps to `--tug-z-overlay-menu-in-dialog`.
  const inDialog = useContext(TugSheetStackingContext);

  // Guards against re-entrant blink calls during animation. Also used by
  // the observeDispatch observer to skip dismissal while the menu is
  // dispatching its own action (so the blink can finish before close).
  const blinkingRef = useRef(false);

  // Local mirror of Radix's internal open state. Radix ContextMenu is
  // uncontrolled (no open/defaultOpen props), but onOpenChange still fires
  // so we can gate the observeDispatch effect AND the engine focus trap on it.
  const [open, setOpen] = useState(false);

  // Engine focus trap ([P04]), replacing the old service-popup binding. Keyed off the
  // open mirror: the trap captures the key view + first responder at push and its
  // `onCloseAutoFocus` is the single close-focus DOM writer. Because Radix
  // ContextMenu is uncontrolled, its only programmatic close is a synthesized
  // Escape — so `onEscapeDismiss` is `synthesizeEscapeDismiss` (marked, [P03]):
  // the engine's ladder decides WHEN to dismiss, and the marked synthetic Escape
  // is the close MECHANISM that reaches Radix. Menu items register no engine
  // focusables, so Radix's arrow-nav/typeahead fall through untouched.
  const { FocusModeScope, onCloseAutoFocus } = useFocusTrap({
    active: open,
    deferDomFocusToTeardown: true,
    onEscapeDismiss: synthesizeEscapeDismiss,
  });

  // The trap captures at push (keyed off `open`), so there is no separate
  // capture-on-open call — flipping the open mirror drives both Radix and the trap.
  const handleOpenChange = useCallback((next: boolean): void => {
    setOpen(next);
  }, []);

  // No tooltip opens while this menu stands. [see lib/open-menu-registry]
  useOpenMenuClaim(open);

  // Chain manager for observeDispatch subscription. Null outside a provider.
  const manager = useResponderChain();
  // Targeted dispatch to parent responder.
  const { dispatchForContinuation } = useControlDispatch();

  const fallbackSenderId = useId();
  const effectiveSenderId = senderId ?? fallbackSenderId;

  // Subscribe to observeDispatch while the menu is open. Any action
  // flowing through the chain dismisses the menu, with one exception:
  // the menu's own item activation sets blinkingRef=true for the
  // duration of the blink-animate-then-dispatch window, and the
  // observer skips its close so the menu can finish its animation.
  // Matches the tug-popup-menu / tug-editor-context-menu precedent.
  // Uses useLayoutEffect per [L03] so the subscription is in place
  // before any paint that could deliver a pointer or key event through
  // the chain. [L11]
  useLayoutEffect(() => {
    if (!open || !manager) return;
    return manager.observeDispatch(() => {
      if (blinkingRef.current) return;
      synthesizeEscapeDismiss();
    });
  }, [open, manager]);

  const handleItemSelect = useCallback(
    (entry: PdfContextMenuItem<V>, event: Event) => {
      // Prevent Radix from immediately closing the menu — we drive the
      // close ourselves after the blink animation completes.
      event.preventDefault();

      if (blinkingRef.current) return;
      blinkingRef.current = true;

      const target = event.currentTarget as HTMLElement;

      // Drive the shared double-blink feedback, then dispatch the item's
      // action through the chain. The dispatch happens while blinkingRef
      // is still true so our own observeDispatch subscription skips the
      // self-dismiss path. After the dispatch, reset the guard and
      // synthesize an Escape keydown to close the Radix menu. [L06]
      playMenuItemBlink(target).then(() => {
        // Targeted dispatch to parent responder with continuation.
        const { continuation } = dispatchForContinuation({
          action: entry.action,
          value: entry.value,
          sender: effectiveSenderId,
          phase: "discrete",
        });
        continuation?.();
        blinkingRef.current = false;
        synthesizeEscapeDismiss();
      });
    },
    [dispatchForContinuation, effectiveSenderId],
  );

  const trigger = children as React.ReactElement<{
    onContextMenu?: (event: React.MouseEvent) => void;
  }>;
  const childContextMenu = trigger.props.onContextMenu;

  // A right-click inside this trigger is THIS menu's gesture. An ancestor text
  // surface runs its own React `onContextMenu` (the transcript cell's, say),
  // and without this both menus open over the same click — the file row's
  // Open / Reveal pair AND the cell's editing menu, two popups for one press.
  // Stopping the SYNTHETIC event's propagation is enough: Radix composes its
  // trigger handler after the child's, so the menu still opens, and the native
  // event still reaches document-level listeners.
  const claimGesture = useCallback(
    (event: React.MouseEvent) => {
      childContextMenu?.(event);
      event.stopPropagation();
    },
    [childContextMenu],
  );

  return (
    <ContextMenuPrimitive.Root onOpenChange={handleOpenChange}>
      <ContextMenuPrimitive.Trigger asChild>
        {React.cloneElement(trigger, { onContextMenu: claimGesture })}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal container={overlayRoot}>
        <ContextMenuPrimitive.Content
          data-slot="tug-context-menu"
          className={cn("tug-menu-content", inDialog && "tug-menu-in-dialog")}
          onCloseAutoFocus={onCloseAutoFocus}
          // [P03] Suppress a user-originated Escape (the engine ladder owns it),
          // but let the engine's MARKED synthetic Escape through — it IS the close
          // mechanism for this uncontrolled menu and must reach Radix.
          onEscapeKeyDown={(e) => {
            if (!isSyntheticEscape(e)) e.preventDefault();
          }}
        >
          <FocusModeScope>
          {items.map((entry, index) => {
            if (entry.type === "separator") {
              return (
                <ContextMenuPrimitive.Separator
                  key={index}
                  className="tug-menu-separator"
                />
              );
            }

            if (entry.type === "label") {
              return (
                <ContextMenuPrimitive.Label
                  key={index}
                  className="tug-menu-label"
                >
                  {entry.label}
                </ContextMenuPrimitive.Label>
              );
            }

            // Default: action item (type === "item" or type is undefined)
            return (
              <ContextMenuPrimitive.Item
                key={`${entry.action}-${index}`}
                className="tug-menu-item"
                disabled={entry.disabled}
                onSelect={(event) => handleItemSelect(entry, event)}
              >
                {entry.icon !== undefined && (
                  <span className="tug-menu-item-icon" aria-hidden="true">
                    {entry.icon}
                  </span>
                )}
                <span className="tug-menu-item-label">{entry.label}</span>
                {entry.shortcut !== undefined && (
                  <span className="tug-menu-item-shortcut">{entry.shortcut}</span>
                )}
              </ContextMenuPrimitive.Item>
            );
          })}
          </FocusModeScope>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

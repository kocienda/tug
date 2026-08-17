/**
 * TugConfirmPopover — Pre-built confirmation pattern composing TugPopover.
 *
 * Renders an anchored popover with a message, a cancel button, and a confirm
 * button. Exposes two interchangeable APIs:
 *
 *  - **Imperative API** (legacy): `ref.current.confirm() → Promise<boolean>`
 *    opens the popover and resolves when the user confirms, cancels, or
 *    dismisses it. The popover is anchored to a `<children>` trigger
 *    element. Each call site mounts its own popover instance.
 *  - **Controlled API** (preferred): `open`, `anchorEl`, `onConfirm`,
 *    `onCancel` props. The caller drives the popover's open state from
 *    its own state; the popover anchors to an arbitrary external element
 *    via `<TugPopoverAnchor virtualRef>`. One instance can serve N
 *    distinct anchor targets — the canonical "in-list confirmation"
 *    shape (see [tugplan-session-picker-redesign §D15](
 *    ../../roadmap/tugplan-session-picker-redesign.md#d15-tug-confirm-popover-controlled)).
 *    Anchor to the ROW rather than to a row's hover-revealed button: the
 *    popover covers the row it opened from, the pointer leaves, and a button
 *    anchor unmounts under its own popover, which then re-resolves and hops.
 *    A controlled popover also sizes to its message rather than to its anchor
 *    (`data-anchored="external"`), since an arbitrary anchor's width says
 *    nothing about how wide the question is.
 *
 * The two APIs are mutually exclusive at the call site: a controlled-mode
 * caller passes `open` and skips the imperative `ref.confirm()` path
 * entirely; an imperative-mode caller passes `<children>` as the trigger
 * and never sets `open`. The component dev-warns when both shapes are
 * used together.
 *
 * Composition: TugPopover owns the popover chrome (bg, border, shadow,
 * animation). This component adds only the confirmation-specific layout:
 * message text and button row. Never touches popover tokens. [L20]
 *
 * ## Chain-native button wiring
 *
 * The confirm and cancel buttons dispatch `confirmDialog` / `cancelDialog`
 * through the responder chain rather than calling local handlers directly.
 * The popover registers itself as a responder via `useOptionalResponder`
 * with matching handlers that resolve the pending promise (imperative
 * mode) or invoke the `onConfirm` / `onCancel` callbacks (controlled
 * mode), in either case ending in a close.
 *
 * Buttons dispatch via `sendToTarget(responderId, ...)` — explicitly
 * addressing the popover's own responder rather than relying on
 * pointerdown-driven first-responder promotion. The buttons (TugPushButton)
 * carry `data-tug-focus="refuse"`, which the responder-chain provider's
 * pointerdown handler treats as a signal to SKIP first-responder promotion.
 * Without explicit targeting, the dispatch would land on whatever ambient
 * responder happens to be first when the click fires (commonly a TugSheet
 * ancestor that also registers a `cancelDialog` handler), and clicking our
 * Cancel would dismiss the host modal instead of just the popover.
 * Targeting ourselves keeps the dispatch a true self-loop, independent of
 * promotion state. [L11]
 *
 * Rendered outside a `ResponderChainProvider` (standalone previews,
 * tests), `useOptionalResponder` no-ops and the buttons fall back to
 * invoking the handler functions directly so the component still works
 * as a plain confirmation popover.
 *
 * ## External dismissal via observeDispatch
 *
 * TugConfirmPopover subscribes to `manager.observeDispatch` on mount
 * and keeps the subscription active for the lifetime of the
 * component. Any chain action whose sender is NOT this popover's
 * own `senderId` resolves the pending confirmation negatively (via
 * `handleResolution(false)`) and triggers the close path. Self-
 * dispatches from our own confirm/cancel buttons carry our `senderId`
 * and are filtered out by the sender check. The same gating means the
 * subscription is a no-op when no confirmation is in flight (no
 * `confirm()` Promise pending in imperative mode AND `open !== true`
 * in controlled mode), so there is no need for a separate open-state
 * gate on the effect.
 *
 * **Double subscription with the underlying `TugPopover` is
 * intentional.** `TugPopoverContentShell` also subscribes to
 * `observeDispatch` while the popover is open, and its handler also
 * closes the popover on external chain activity. We need BOTH
 * subscriptions: the shell closes the popover, but it has no way to
 * resolve `TugConfirmPopover`'s pending promise or invoke its
 * controlled-mode callbacks. Without the confirm-popover subscription
 * here, an external dispatch would silently close the popover while
 * leaving the `confirm()` promise hanging or the parent's `pending*`
 * state stuck non-null. Do not "optimize" by deleting either
 * subscription.
 *
 * Laws: [L06] appearance via CSS/DOM, never React state,
 *       [L11] controls emit actions; responders handle actions,
 *       [L16] pairings declared,
 *       [L19] component authoring guide,
 *       [L20] token sovereignty — popover chrome owned by tug-popover.css
 *
 * @see ./internal/floating-surface-notes.ts for the cross-surface
 *      invariants table covering popover / confirm-popover / alert /
 *      sheet and the chain-reactive vs. modal semantic models.
 */

import "./tug-confirm-popover.css";

import React from "react";
import {
  TugPopover,
  TugPopoverTrigger,
  TugPopoverContent,
  TugPopoverAnchor,
  type TugPopoverHandle,
  type TugPopoverMeasurable,
} from "./tug-popover";
import { TugLabel } from "./tug-label";
import { isCancelChordEvent } from "./keymap-registry";
import { TugPushButton } from "./tug-push-button";
import type { TugButtonRole } from "./internal/tug-button";
import { suppressButtonFocusShift } from "./internal/safari-focus-shift";
import { useResponderChain } from "./responder-chain-provider";
import { useFocusManager } from "./use-focusable";
import { useOptionalResponder } from "./use-responder";
import { useSpatialOrder } from "./use-spatial-order";
import type { SpatialOrder } from "./spatial-order";
import { TUG_ACTIONS } from "./action-vocabulary";

/* ---------------------------------------------------------------------------
 * TugConfirmPopoverHandle
 * ---------------------------------------------------------------------------*/

/** Imperative handle for TugConfirmPopover (imperative-mode API only). */
export interface TugConfirmPopoverHandle {
  /**
   * Opens the popover and returns a promise.
   * Resolves true if confirmed, false if cancelled or dismissed.
   *
   * Imperative-mode only: callers in controlled mode (`open` prop set)
   * should not use this method. Calling it in controlled mode dev-warns
   * and returns a promise that never resolves.
   */
  confirm: () => Promise<boolean>;
}

/* ---------------------------------------------------------------------------
 * TugConfirmPopoverProps
 * ---------------------------------------------------------------------------*/

/** TugConfirmPopover props. */
export interface TugConfirmPopoverProps {
  /** Confirmation message displayed in the popover body. */
  message: string;
  /**
   * Confirm button label.
   * @default "Confirm"
   */
  confirmLabel?: string;
  /**
   * Confirm button semantic role.
   * @default "danger"
   */
  confirmRole?: Extract<TugButtonRole, "danger" | "action" | "accent">;
  /**
   * Cancel button label.
   * @default "Cancel"
   */
  cancelLabel?: string;
  /**
   * Which side of the trigger / anchor to place the popover.
   * @default "bottom"
   */
  side?: "top" | "bottom" | "left" | "right";
  /**
   * Alignment along the side axis (forwarded to `TugPopoverContent`).
   * Use `"end"` when the anchor sits at the trailing edge of its
   * container — e.g. a card's close X — so the popover hangs back toward
   * the container's interior instead of centering under the anchor and
   * spilling past the edge.
   * @default "center"
   */
  align?: "start" | "center" | "end";
  /**
   * Distance from trigger / anchor in px.
   * @default 6
   */
  sideOffset?: number;
  /**
   * Collision-shift behavior (forwarded to `TugPopoverContent`). Set to
   * `"always"` for confirmations whose anchor can be pushed off the canvas
   * edge — e.g. a card's close-confirm popover anchored to an X button on a
   * card whose right side is off-deck — so the popover slides fully into
   * view instead of trailing the off-screen anchor.
   * @default "partial"
   */
  sticky?: "partial" | "always";
  /**
   * Distance in px the popover keeps from the viewport edge when shifting
   * into view (forwarded to `TugPopoverContent`). Pair with
   * `sticky="always"` so a slid-into-view popover keeps a margin.
   * @default 0
   */
  collisionPadding?: number;
  /**
   * Element(s) the popover must stay inside when shifting/flipping
   * (forwarded to `TugPopoverContent` as `collisionBoundary`). Defaults
   * to the viewport. Pass the confirmed object's own element — e.g. the
   * card behind a close-confirm — so the popover can never overlap a
   * sibling and leave the target ambiguous.
   */
  collisionBoundary?: Element | null | Array<Element | null>;
  /**
   * Show the arrow pointer aimed back at the anchor (forwarded to
   * `TugPopoverContent`). Use it so the popover visibly names which
   * control opened it.
   * @default false
   */
  arrow?: boolean;
  /**
   * Stable opaque sender id for chain dispatches. Auto-derived via
   * `useId()` if omitted. Parent responders disambiguate multi-popover
   * pages by matching this id when observing dispatches. The sender
   * also gates this component's own `observeDispatch` listener — chain
   * traffic carrying this `senderId` is treated as a self-dispatch and
   * skipped. [L11]
   */
  senderId?: string;
  /**
   * Controlled-mode open state. When `open !== undefined`, the popover
   * runs in controlled mode: the caller drives open/close state and
   * receives confirm/cancel via the `onConfirm` / `onCancel` callbacks
   * instead of an awaited Promise. Pair with `anchorEl` to position
   * the popover against an arbitrary external element.
   *
   * Controlled mode is mutually exclusive with the imperative
   * `<children>` trigger + `ref.confirm()` API.
   */
  open?: boolean;
  /**
   * Controlled-mode anchor. The popover positions itself relative to it
   * via `<TugPopoverAnchor virtualRef>`. Required (but allowed to be
   * `null` transiently) in controlled mode; ignored in imperative mode.
   *
   * Usually an element. A `TugPopoverMeasurable` — any object reporting a
   * rect — covers the case where the thing to point at is a REGION rather
   * than a node: a row's hover-revealed accessory collapses when the
   * pointer leaves, so a popover that must keep pointing at it anchors to
   * the accessory's column measured off the still-present row.
   *
   * When `open === true` but `anchorEl == null`, the popover stays
   * closed — useful for callers that resolve the anchor in a layout
   * effect after the open-flipping render. The popover opens on the
   * next render once both `open === true` and a non-null `anchorEl`
   * are observed.
   */
  anchorEl?: HTMLElement | TugPopoverMeasurable | null;
  /**
   * Controlled-mode confirm callback. Fires when the user clicks the
   * confirm button or presses the corresponding key binding. Use the
   * callback to update parent state — typically clearing whatever
   * pending-id field drove the popover's `open` to `true`.
   */
  onConfirm?: () => void;
  /**
   * Controlled-mode cancel callback. Fires when the user clicks the
   * cancel button, presses Escape, clicks outside the popover, or any
   * unrelated chain action causes external dismissal. Use the callback
   * to update parent state.
   */
  onCancel?: () => void;
  /**
   * Imperative-mode trigger element. Wrapped with `asChild` by
   * `TugPopoverTrigger`. Ignored in controlled mode (where the popover
   * is anchored to `anchorEl` and opened via the `open` prop).
   */
  children?: React.ReactElement;
}

/* ---------------------------------------------------------------------------
 * TugConfirmPopover
 * ---------------------------------------------------------------------------*/

/**
 * TugConfirmPopover — confirmation popover composing TugPopover.
 *
 * Use `ref.current.confirm()` for the imperative Promise API, or set
 * `open` + `anchorEl` + `onConfirm` + `onCancel` for the controlled API
 * (preferred for in-list confirmation flows). The two APIs are mutually
 * exclusive at the call site.
 */
export const TugConfirmPopover = React.forwardRef<
  TugConfirmPopoverHandle,
  TugConfirmPopoverProps
>(function TugConfirmPopover(
  {
    message,
    confirmLabel = "Confirm",
    confirmRole = "danger",
    cancelLabel = "Cancel",
    side = "bottom",
    align = "center",
    sideOffset = 6,
    sticky = "partial",
    collisionPadding = 0,
    collisionBoundary,
    arrow = false,
    senderId: senderIdProp,
    open: openProp,
    anchorEl,
    onConfirm,
    onCancel,
    children,
  },
  ref,
) {
  const isControlled = openProp !== undefined;

  // Handle on the inner TugPopover. In imperative mode `confirm()` opens
  // it and chain-action handlers close it. In controlled mode the parent
  // owns open state via the `open` prop, but we still pass `popoverRef`
  // for parity with imperative-mode close-helpers.
  const popoverRef = React.useRef<TugPopoverHandle>(null);

  // Resolver for the imperative `confirm()` Promise. Null when no
  // imperative call is in flight or when running in controlled mode.
  const resolverRef = React.useRef<((value: boolean) => void) | null>(null);

  // Chain manager — null when rendered outside a ResponderChainProvider
  // (standalone previews, unit tests). The responder registration is
  // skipped and the buttons fall back to calling the handler functions
  // directly when no manager is in scope.
  const manager = useResponderChain();
  const focusManager = useFocusManager();

  // The two action buttons are authored into the popover's own trapped focus
  // mode (the `useFocusTrap` mode `TugPopover` pushes while open): a stable
  // per-instance group whose members the engine cycles under Tab — so Tab is
  // trapped inside the popover (you cannot escape to the host surface) and the
  // engine moves the key view (`data-key-view-kbd`) between Cancel/Confirm, which
  // drives each outlined button's promotion to its filled role style + ring
  // ([P02]/[P06]) — the fill follows the ring. The default button is seeded with
  // the key view on open via a keyboard `place()`.
  const buttonFocusGroup = React.useId();
  const CANCEL_ORDER = 0;
  const CONFIRM_ORDER = 1;

  // Arrow navigation over the button row ([P22] / [P23]): Cancel ↔ Confirm as both
  // a horizontal AND a vertical closed ring, so *any* arrow toggles between the two
  // buttons (moving the ring + DOM focus, driving fill-follows-ring) — the same Tab
  // walk the trap already cycles, now reachable by every arrow. A 2-choice
  // confirmation has no second axis to lose, so collapsing both axes onto the pair
  // is the forgiving behavior and leaves no undeclared direction (no dead-arrow
  // fallback / warning). Declared against the popover's trapped focus mode by the
  // context-form registrar below, which renders inside `TugPopover`'s
  // `FocusModeScope` (the component body here is above it).
  const buttonSpatialOrder = React.useMemo<SpatialOrder>(() => {
    const nodes = [
      `${buttonFocusGroup}:${CANCEL_ORDER}`,
      `${buttonFocusGroup}:${CONFIRM_ORDER}`,
    ];
    return {
      rings: [
        { axis: "horizontal", nodes, closed: true },
        { axis: "vertical", nodes, closed: true },
      ],
    };
  }, [buttonFocusGroup]);

  const fallbackResponderId = React.useId();
  const fallbackSenderId = React.useId();
  const responderId = fallbackResponderId;
  const senderId = senderIdProp ?? fallbackSenderId;

  // Refs for controlled-mode policy parameters. The chain handlers
  // and the observeDispatch listener read these at dispatch time so
  // they always see the latest callbacks and open state without
  // re-subscribing on every prop change.
  const isControlledRef = React.useRef(isControlled);
  isControlledRef.current = isControlled;
  const openPropRef = React.useRef(openProp);
  openPropRef.current = openProp;
  const onConfirmRef = React.useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const onCancelRef = React.useRef(onCancel);
  onCancelRef.current = onCancel;

  // Dev-mode warning when both API shapes are used together. The
  // controlled API takes precedence at runtime; the imperative
  // `<children>` trigger is silently ignored in controlled mode.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (isControlled && children !== undefined) {
      console.warn(
        "TugConfirmPopover: controlled mode (`open` prop) is mutually exclusive with " +
          "the imperative `children` trigger. Drop one or the other; the controlled API is preferred.",
      );
    }
  }, [isControlled, children]);

  // Single resolution path for both modes. Imperative mode: resolves
  // the pending Promise and closes via the popover handle. Controlled
  // mode: invokes the appropriate callback so the parent flips
  // `open` to false on its next render.
  const handleResolution = React.useCallback((value: boolean) => {
    if (resolverRef.current) {
      // Imperative mode.
      resolverRef.current(value);
      resolverRef.current = null;
      popoverRef.current?.close();
      return;
    }
    if (isControlledRef.current) {
      // Controlled mode.
      if (value) onConfirmRef.current?.();
      else onCancelRef.current?.();
      // Parent flips `open` -> TugPopover unmounts content. No imperative
      // close required.
      return;
    }
    // Neither mode active — spurious dispatch (no open in flight). Close
    // redundantly so a stale state can't keep the popover visible.
    popoverRef.current?.close();
  }, []);

  const handleConfirmAction = React.useCallback(() => {
    handleResolution(true);
  }, [handleResolution]);

  const handleCancelAction = React.useCallback(() => {
    handleResolution(false);
  }, [handleResolution]);

  // Register the popover as a chain responder so buttons inside the
  // portaled content can dispatch confirmDialog / cancelDialog and have
  // the walk land back here. Tolerant of no-provider contexts.
  const { responderRef } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.CONFIRM_DIALOG]: handleConfirmAction,
      [TUG_ACTIONS.CANCEL_DIALOG]: handleCancelAction,
    },
  });

  // External dismissal: any chain activity (other than our own
  // confirm/cancel button dispatches, identified by sender id) cancels
  // the open confirmation.
  //
  //  - Imperative mode: gated on `resolverRef !== null`.
  //  - Controlled mode: gated on `openPropRef.current === true`.
  //
  // Self-dispatches (our own confirmDialog / cancelDialog buttons) carry
  // the popover's own `senderId` and are filtered out so we don't
  // re-fire `onCancel` after `onConfirm` has just landed. The
  // self-filter also makes the listener correct in controlled mode,
  // where the resolverRef-null guard alone is insufficient (the parent
  // hasn't yet flipped `open` to `false` when our self-dispatch's
  // observer runs — without the sender filter, we'd see "controlled
  // active" still true and call onCancel after onConfirm fired).
  React.useLayoutEffect(() => {
    if (!manager) return;
    return manager.observeDispatch((event) => {
      if (event.sender === senderId) return;
      const imperativeActive = resolverRef.current !== null;
      const controlledActive =
        isControlledRef.current && openPropRef.current === true;
      if (!imperativeActive && !controlledActive) return;
      handleResolution(false);
    });
  }, [manager, handleResolution, senderId]);

  React.useImperativeHandle(ref, () => ({
    confirm(): Promise<boolean> {
      if (process.env.NODE_ENV !== "production" && isControlledRef.current) {
        console.warn(
          "TugConfirmPopover.confirm(): imperative API called on a controlled-mode " +
            "popover (the `open` prop is set). The Promise will never resolve. Drive open/close " +
            "via the parent's state and `onConfirm`/`onCancel` callbacks instead.",
        );
      }
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
        popoverRef.current?.open();
      });
    },
  }));

  // Button click handlers. In the normal chain-native path they
  // dispatch through the manager; with no provider in scope they call
  // the primary handler directly.
  //
  // We target the popover's OWN responder id explicitly via
  // `sendToTarget` rather than `sendToFirstResponder`. The buttons
  // (TugPushButton) carry `data-tug-focus="refuse"`, which blocks the
  // pointerdown promotion the responder-chain provider would otherwise
  // run on click — so the popover's responder is never promoted to
  // first responder and `sendToFirstResponder` would land on whatever
  // ambient responder happens to be first (e.g., a TugSheet ancestor
  // that also handles `cancelDialog`, in which case clicking our
  // Cancel would dismiss the sheet, not just the popover). Targeting
  // ourselves keeps the dispatch a true self-loop independent of
  // promotion state.
  function onConfirmClick() {
    if (!manager) {
      handleConfirmAction();
      return;
    }
    manager.sendToTarget(responderId, {
      action: TUG_ACTIONS.CONFIRM_DIALOG,
      sender: senderId,
      phase: "discrete",
    });
  }

  function onCancelClick() {
    if (!manager) {
      handleCancelAction();
      return;
    }
    manager.sendToTarget(responderId, {
      action: TUG_ACTIONS.CANCEL_DIALOG,
      sender: senderId,
      phase: "discrete",
    });
  }

  // Cmd-. cancels, mirroring Escape. Escape is owned by Radix's DismissableLayer
  // (the popover's light-dismiss); Cmd-. is not a Radix key, and the global
  // Cmd-. → cancelDialog binding routes by first responder — unreliable for a
  // portaled popover whose buttons carry `data-tug-focus="refuse"` and never
  // promote. Route it to our OWN cancelDialog by identity (`sendToTarget`),
  // exactly as the Cancel button does, so the two cancel keys behave identically.
  // Runs in bubble phase after the capture-phase keybinding listener; if that
  // listener had handled Cmd-. it would have stopped propagation, so this fires
  // only when the chain dispatch did not land.
  function handleKeyDown(e: React.KeyboardEvent) {
    if (isCancelChordEvent(e)) {
      e.preventDefault();
      if (!manager) {
        handleCancelAction();
        return;
      }
      manager.sendToTarget(responderId, {
        action: TUG_ACTIONS.CANCEL_DIALOG,
        sender: senderId,
        phase: "discrete",
      });
    }
  }

  // Claim first responder when focus lands anywhere in the popover — THE fix that
  // makes keyboard cancel work. The action buttons carry `data-tug-focus="refuse"`
  // (so a click never promotes the popover over the host editor), but the
  // responder-chain provider's `focusin` promotion honors that same refusal, so a
  // keyboard-focused button never promotes the popover either. Result: the global
  // Cmd-. → CANCEL_DIALOG binding (dispatched to the FIRST RESPONDER) would miss
  // the open popover and land on the editor / a host dialog's Cancel (dismissing
  // the wrong thing). A modal confirmation must own the first responder while open;
  // claim it here (the popover's own focus handler, not the refusal-gated global
  // one) so Cmd-. and any other first-responder-routed accelerator reach our
  // cancel/confirm handlers. Idempotent.
  function handleContentFocus() {
    if (manager && manager.getFirstResponder() !== responderId) {
      manager.makeFirstResponder(responderId);
    }
  }

  // ---- Anchor element wiring (controlled mode) ----
  //
  // Radix Popover.Anchor accepts a `virtualRef` (a ref-shaped object
  // whose `current` is anything with `getBoundingClientRect`). The
  // `current` is read on every Popper update, so a parent that swaps
  // `anchorEl` between renders gets correct repositioning without us
  // re-creating the ref object.
  //
  // The inner popover's effective open state in controlled mode is
  // `openProp && anchorEl != null`. This handles the brief race where
  // a parent flips `open` to `true` in render N and resolves the
  // anchor in a layout effect after that render — the popover stays
  // closed for one render, then opens on the next once `anchorEl` is
  // available. Without this gate, Radix would mount Popper with no
  // anchor and warn.
  const virtualAnchorRef = React.useRef<TugPopoverMeasurable | null>(
    anchorEl ?? null,
  );
  virtualAnchorRef.current = anchorEl ?? null;

  const effectiveOpenForControlled = isControlled
    ? openProp === true && anchorEl != null
    : undefined;

  // Explicit default-focus target on open. Driven by `confirmRole`
  // intent, not DOM order:
  //   - `danger`: Enter should NOT fire a destructive action, so the
  //     default lands on Cancel (Return-safe).
  //   - `action` / `accent`: Enter accepts, so the default lands on
  //     Confirm.
  // The default is seeded as the engine KEY VIEW (a keyboard `place()`,
  // by the button's stable `group:order` focus key), not a bare
  // `.focus()` — so the engine is the single owner, the ring rests on
  // the seed at open, and the default button promotes to its filled
  // role style + ring (the live control, [P14]). `preventDefault()`
  // stops Radix's own first-focusable walk; the engine drives focus.
  const cancelButtonRef = React.useRef<HTMLButtonElement>(null);
  const confirmButtonRef = React.useRef<HTMLButtonElement>(null);
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      event.preventDefault();
      const defaultOrder = confirmRole === "danger" ? CANCEL_ORDER : CONFIRM_ORDER;
      focusManager?.place(null, { kind: "focus-key", focusKey: `${buttonFocusGroup}:${defaultOrder}` }, { modality: "keyboard" });
    },
    [confirmRole, focusManager, buttonFocusGroup],
  );

  return (
    <TugPopover
      ref={popoverRef}
      open={effectiveOpenForControlled}
      // No `onOpenChange` in controlled mode: the chain-action handlers
      // and observeDispatch own the close path; Radix's open-state
      // changes flow through the chain re-emit (DISMISS_POPOVER) and
      // back into our observer.
    >
      {!isControlled && children !== undefined && (
        <TugPopoverTrigger asChild>{children}</TugPopoverTrigger>
      )}
      {isControlled && (
        <TugPopoverAnchor virtualRef={virtualAnchorRef} />
      )}
      <TugPopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        sticky={sticky}
        collisionPadding={collisionPadding}
        collisionBoundary={collisionBoundary}
        arrow={arrow}
        onOpenAutoFocus={handleOpenAutoFocus}
      >
        <div
          data-slot="tug-confirm-popover"
          className="tug-confirm-popover"
          // Refuse first-responder promotion on the surface itself, not just its
          // buttons. A pointerdown in the popover's empty space (or on the message
          // label) would otherwise run a pointer-driven promotion of this responder,
          // coarsening the key view off the default button and clearing its
          // `data-key-view-kbd` ring — visually "deactivating" the default control.
          // A modal confirmation owns first responder while open; refusing here
          // keeps the key view on the default button no matter where inside the
          // popover the user clicks.
          data-tug-focus="refuse"
          onMouseDown={suppressButtonFocusShift}
          onKeyDown={handleKeyDown}
          onFocus={handleContentFocus}
          data-side={side}
          // Which of the two APIs positioned this box. Imperative mode wraps a
          // TRIGGER, and a surface that drops from a trigger conventionally
          // spans it. Controlled mode anchors to an arbitrary element — a list
          // row, a whole card — where "as wide as what you clicked" is not a
          // size at all, so the box sizes to the question instead.
          data-anchored={isControlled ? "external" : "trigger"}
          ref={responderRef as (el: HTMLDivElement | null) => void}
        >
          {/* Registers the button-row arrow order against the popover's trap mode.
              Rendered here (inside TugPopover's FocusModeScope) so the context-form
              `useSpatialOrder` reads the trap scope, not the component's outer one. */}
          <ConfirmPopoverSpatialOrder order={buttonSpatialOrder} />
          <div className="tug-confirm-popover-actions">
            <TugPushButton
              ref={cancelButtonRef}
              emphasis="outlined"
              role="action"
              size="sm"
              onClick={onCancelClick}
              focusGroup={buttonFocusGroup}
              focusOrder={CANCEL_ORDER}
              data-slot="tug-confirm-cancel"
            >
              {cancelLabel}
            </TugPushButton>
            <TugPushButton
              ref={confirmButtonRef}
              emphasis="outlined"
              role={confirmRole}
              size="sm"
              onClick={onConfirmClick}
              focusGroup={buttonFocusGroup}
              focusOrder={CONFIRM_ORDER}
              data-slot="tug-confirm-confirm"
            >
              {confirmLabel}
            </TugPushButton>
          </div>
          {/* Named parts, so a test can aim a real pointer at the act it means
              rather than walking the button list by label text. */}
          <TugLabel size="md" align="center" data-slot="tug-confirm-message">
            {message}
          </TugLabel>
        </div>
      </TugPopoverContent>
    </TugPopover>
  );
});

/* ---------------------------------------------------------------------------
 * ConfirmPopoverSpatialOrder
 * ---------------------------------------------------------------------------*/

/**
 * Null-rendering registrar for the button-row arrow order. It must mount INSIDE
 * `TugPopover`'s `FocusModeScope` — which wraps `TugPopoverContent`'s children —
 * so the context-form `useSpatialOrder(order)` resolves the enclosing
 * `FocusModeContext` to the popover's trapped focus mode. Calling
 * `useSpatialOrder` in the `TugConfirmPopover` body would instead bind the order
 * to whatever mode is current ABOVE the popover (commonly the base mode), since
 * that body renders the `FocusModeScope`, not within it. [L03]
 */
function ConfirmPopoverSpatialOrder({ order }: { order: SpatialOrder }): null {
  useSpatialOrder(order);
  return null;
}

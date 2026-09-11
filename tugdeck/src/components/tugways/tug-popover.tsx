/**
 * TugPopover — Anchored interactive popup wrapping @radix-ui/react-popover.
 *
 * Exposes a compound API: TugPopover (root), TugPopoverTrigger (trigger),
 * TugPopoverContent (styled chrome with portal, arrow, animation), and
 * TugPopoverClose (re-export of Radix Close). Focus is trapped inside the
 * popover; Escape closes it and returns focus to the trigger.
 *
 * ## Chain-native open state
 *
 * TugPopover owns its open state internally and exposes an imperative
 * handle (`TugPopoverHandle`) with `open()` / `close()` / `isOpen()` for
 * consumers (like `TugConfirmPopover`) that need to drive the popover
 * programmatically. There is no `open` / `onOpenChange` prop pair —
 * dismissal flows through the responder chain via `cancelDialog` /
 * `dismissPopover` rather than through a React callback. [L11]
 *
 * ## Responder registration lives on TugPopoverContent
 *
 * The chain responder is registered by `TugPopoverContentShell`, a
 * nested component rendered INSIDE `Popover.Content` and therefore
 * mounted only while Radix actually shows the popover. Two reasons:
 *
 * 1. `TugPopover` has no DOM node of its own — it's a state owner and
 *    Radix Root wrapper. The responder needs a DOM element to carry
 *    `data-responder-id`, and that element is the portaled content.
 * 2. The shell's lifecycle matches the popover's open lifecycle.
 *    Registering at mount and unregistering at unmount keeps the
 *    auto-first-responder promotion (see
 *    `ResponderChainManager.register`) from stealing focus from
 *    inner composites (e.g. `TugConfirmPopover`'s own inner
 *    responder) that mount in the same commit and expect to become
 *    first responder themselves. If the responder hook ran at
 *    `TugPopoverContent`'s outer level it would register even when
 *    `open=false` — the component function still evaluates to
 *    produce JSX for Radix's Presence wrapper — and the effect
 *    would auto-promote at initial mount, blocking the inner
 *    composite's walk forever.
 *
 * **This is a structural contract, not a code invariant.** The fix
 * relies on `Popover.Content` returning null when not open, so its
 * children (including our shell) are not in the React tree during
 * the closed state. If a future change makes `TugPopoverContent`
 * eagerly render its children (e.g. wrapping everything in
 * `<Popover.Content forceMount>` for custom exit animations), the
 * shell will start mounting at initial render, its responder will
 * auto-promote, and inner composites will break. The first
 * regression is visible in `tug-confirm-popover.test.tsx`'s
 * `dispatching confirmDialog resolves the promise with true` case —
 * the walk fails to reach the inner confirm handler and the test
 * resolves with `false`. Keep that test passing, and this structural
 * contract stays intact.
 *
 * The `cancelDialog` and `dismissPopover` handlers both close the
 * popover via a `close` callback passed through the
 * `TugPopoverInternalContext` from the root.
 *
 * ## Radix-level dismissal → chain dispatch
 *
 * When Radix's own DismissableLayer closes the popover (Escape,
 * click-outside, explicit `TugPopoverClose` activation), the internal
 * `handleOpenChange` on the root runs and:
 *
 * 1. Flips internal state to false so React re-renders Radix as closed.
 * 2. Dispatches `dismissPopover` through the responder chain so any
 *    inner composite (e.g. `TugConfirmPopover`) whose responder is
 *    registered under the popover content can observe the dismissal
 *    via `observeDispatch` and resolve its pending promise. Without
 *    this re-emission, consumers would have no chain-native way to
 *    hear about Radix-initiated closes and their Promise adapters
 *    would hang.
 *
 * The action is `dismissPopover`, NOT `cancelDialog`, because
 * `cancelDialog` is also handled by `TugSheet`. A popover rendered
 * inside a sheet that auto-dismisses (click-outside, Escape) cannot
 * assume the popover's own responder is the first responder at the
 * moment the dismissal fires — the walk routinely starts at the
 * picker form / card and proceeds upward via parentId. With
 * `cancelDialog`, that walk passes the popover and lands on the
 * sheet's handler, closing the surrounding sheet. `dismissPopover`
 * is popover-private (only `TugPopoverContentShell` handles it), so
 * the walk either lands on the shell and stops or falls off the
 * chain harmlessly. Inner composites still observe the dispatch
 * unchanged because `observeDispatch` does not filter by action.
 *
 * The dispatch carries the popover's own `senderId`, so the
 * `observeDispatch` subscription in `TugPopoverContent` filters it
 * out and does not schedule a second close.
 *
 * **Undocumented Radix assumption.** This design relies on Radix
 * firing `onOpenChange` ONLY in response to user-initiated DOM
 * dismissal (Escape, click-outside, TugPopoverClose activation), not
 * in response to our own controlled prop flipping from `true` to
 * `false`. This has held across the Radix versions we've shipped
 * on, but it is not an invariant Radix documents explicitly. If a
 * future Radix release starts firing `onOpenChange` on every
 * controlled close, every programmatic `close()` will cascade
 * through `handleOpenChange` and emit an extra `dismissPopover` —
 * not wrong semantically (both the shell's responder handler and
 * any inner resolver are idempotent once `resolverRef` is nulled),
 * but noisy. If the gallery starts showing duplicate close
 * animations or tests start seeing double-resolve warnings, check
 * Radix's release notes first.
 *
 * ## External dismissal via observeDispatch
 *
 * While the popover is open (i.e. `TugPopoverContent` is mounted), the
 * content subscribes to `manager.observeDispatch`. Any chain action
 * whose sender is not this popover closes the popover via the
 * context `close` callback. This matches the `tug-popup-menu` /
 * `tug-editor-context-menu` precedents for chain-reactive dismissal.
 *
 * Rendered outside a `ResponderChainProvider`, `useOptionalResponder`
 * no-ops, the `observeDispatch` subscription is skipped, and the
 * popover still works as a plain Radix popover — but consumers that
 * rely on chain-dispatched dismissal (e.g. `TugConfirmPopover`
 * resolving its promise on Escape) will silently degrade. Standalone
 * previews and unit tests should mount inside a provider to exercise
 * the chain-native paths.
 *
 * ## Dismissal on a layout change
 *
 * A popover is anchored to its trigger by Radix's Popper. Radix
 * dismisses on a `pointerdown` outside the popover and repositions
 * when the trigger itself resizes or scrolls — but it does not catch
 * the trigger being *moved* by an ancestor resizing: a pane
 * drag-resize, a window resize. The trigger's own box is unchanged,
 * so none of Radix's observers fire, and the popover is left
 * anchored where it opened while the trigger slides away.
 *
 * `TugPopoverContentShell` closes the popover on those layout
 * changes. While open it watches the trigger's layout ancestors
 * (captured via `triggerElRef`) with a `ResizeObserver` — any
 * ancestor resizing means the trigger has shifted — plus a `window`
 * `resize` listener. RO callbacks run after layout and before
 * paint, so the popover is hidden synchronously and then closed
 * before a detached frame can render or its exit animation can play
 * stranded. Chasing the trigger with a per-frame reposition loop
 * would be the wrong tool ([L05] / [L13]).
 *
 * Laws: [L06] appearance via CSS/DOM, never React state,
 *       [L11] controls emit actions; responders handle actions,
 *       [L13] motion compliance — animation durations scale via --tug-timing,
 *       [L14] Radix Presence owns DOM lifecycle — use CSS keyframes,
 *       [L16] pairings declared,
 *       [L17] component aliases resolve to base tier in one hop,
 *       [L19] component authoring guide
 *
 * @see ./internal/floating-surface-notes.ts for the cross-surface
 *      invariants table (popover / confirm-popover / alert / sheet)
 *      and the chain-reactive vs. modal semantic models.
 *
 * ## Status-cell anchor pattern
 *
 * When the trigger is not an obvious-affordance element (a button), the
 * substrate contract requires the consumer to supply the hover hint —
 * `TugPopoverTrigger` itself adds no cursor or background change. The
 * canonical pattern for status-row cells (the Z2 layout's TIME / TOKENS
 * / CONTEXT cells and the `TugProgressIndicator`) is to wrap the cell in
 * `TugPopoverTrigger` and apply a `cursor: pointer` + subtle
 * hover-tinted background class so the click target is discoverable.
 */

import "./tug-popover.css";

import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { useCardLifecycle } from "@/lib/card-lifecycle";
import { useResponderChain } from "./responder-chain-provider";
import { useOptionalResponder } from "./use-responder";
import { TugSheetStackingContext } from "./tug-sheet-stacking-context";
import { TUG_ACTIONS } from "./action-vocabulary";
import { suppressButtonFocusShift } from "./internal/safari-focus-shift";
import { useFocusTrap } from "./use-focus-trap";
import { composeRefs, refOfElement } from "./compose-refs";

/* ---------------------------------------------------------------------------
 * TugPopoverHandle
 * ---------------------------------------------------------------------------*/

/** Imperative handle for TugPopover. */
export interface TugPopoverHandle {
  /** Open the popover. */
  open(): void;
  /** Close the popover. Does not emit a chain action. */
  close(): void;
  /** Whether the popover is currently open. */
  isOpen(): boolean;
}

/* ---------------------------------------------------------------------------
 * Internal context (TugPopover ↔ TugPopoverContent)
 * ---------------------------------------------------------------------------*/

interface TugPopoverInternalContextValue {
  /** Close the popover. Called by chain action handlers and observeDispatch. */
  close: () => void;
  /**
   * Close the popover AND re-emit `DISMISS_POPOVER` through the chain ([P05]).
   * The engine's Escape ladder calls this (registered as the trap's
   * `onEscapeDismiss`) so an engine-initiated close resolves inner composites
   * exactly as a Radix-initiated one does.
   */
  closeAndEmit: () => void;
  /**
   * The popover's effective open state. The content shell drives its engine
   * focus mode ([P02]) off this — pushing while open and popping the instant it
   * flips false, so the opener's key view is restored promptly on close rather
   * than waiting for the exit animation to unmount the shell (the same
   * `active: open` shape `TugSheet` uses for its trap).
   */
  open: boolean;
  /** Stable sender id used by the root when re-emitting dismissPopover from Radix dismissal. */
  senderId: string;
  /** When false, the inner shell skips its `observeDispatch` subscription —
   *  the popover stays open across nested chain traffic (e.g. a TugPopupButton
   *  menu selection inside the popover). Click-outside / Escape dismissal via
   *  Radix still work. Default true. */
  dismissOnChainActivity: boolean;
  /**
   * Captures the trigger DOM node. `TugPopoverTrigger` writes the
   * element it renders here; `TugPopoverContentShell` reads it to
   * observe the trigger's layout ancestors for resize-driven
   * dismissal. `null` until the trigger mounts, or for popovers
   * driven by `TugPopoverAnchor` rather than a `TugPopoverTrigger`.
   */
  triggerElRef: React.RefObject<HTMLElement | null>;
}

const TugPopoverInternalContext =
  React.createContext<TugPopoverInternalContextValue | null>(null);

/* ---------------------------------------------------------------------------
 * TugPopover
 * ---------------------------------------------------------------------------*/

/** TugPopover props. */
export interface TugPopoverProps {
  /**
   * Controlled open state. When provided, TugPopover is controlled: the
   * caller owns the value, TugPopover simply reflects it, and dismissal
   * paths (trigger, Escape, click-outside, imperative close, chain
   * actions) route through `onOpenChange` to ask the caller to update.
   * Leave undefined to run TugPopover uncontrolled — it then manages its
   * own state internally, seeded by `defaultOpen`.
   */
  open?: boolean;
  /** Default open state. Used only in uncontrolled mode (when `open` is undefined). */
  defaultOpen?: boolean;
  /**
   * Whether popover is modal (traps focus, dims outside).
   * @default false
   */
  modal?: boolean;
  /**
   * Stable opaque sender id for chain dispatches. Auto-derived via
   * `useId()` if omitted. Disambiguates multi-popover pages when a
   * parent responder observes dispatches by sender. [L11]
   */
  senderId?: string;
  /**
   * When `true` (default), any chain dispatch that happens while the
   * popover is open closes the popover — this is the "responders outside
   * the popover took the focus" dismissal the form-content gallery
   * example relies on. Set to `false` for popovers whose content itself
   * dispatches chain actions (e.g. a TugPopupButton menu inside the
   * popover) — without this, activating a nested menu item closes the
   * outer popover. Click-outside and Escape dismissal via Radix remain
   * active regardless of this flag.
   * @default true
   */
  dismissOnChainActivity?: boolean;
  /**
   * Fires whenever the popover's open state should change — on trigger
   * activation, Escape, click-outside, Close activation, chain-action
   * dismissal, and imperative `handle.open()` / `handle.close()` calls.
   *
   * In **controlled** mode (`open` prop set), this is the setter the
   * caller uses to update its own state — TugPopover will not close
   * itself without the caller honoring the callback.
   *
   * In **uncontrolled** mode, this is an optional observer — TugPopover
   * flips its internal state regardless, and the callback just notifies
   * the caller for side effects (e.g. flipping the trigger button's
   * emphasis to accent).
   */
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Thin wrapper on Radix Popover.Root. Place TugPopoverTrigger and
 * TugPopoverContent as direct children.
 *
 * Use `ref.current.open()` / `.close()` / `.isOpen()` to drive the
 * popover imperatively; dismissal otherwise flows through the responder
 * chain via `cancelDialog` / `dismissPopover`.
 */
export const TugPopover = React.forwardRef<TugPopoverHandle, TugPopoverProps>(
  function TugPopover(
    {
      open: openProp,
      defaultOpen = false,
      modal = false,
      senderId: senderIdProp,
      dismissOnChainActivity = true,
      onOpenChange: onOpenChangeProp,
      children,
    },
    ref,
  ) {
    // Uncontrolled-mode internal state, seeded by `defaultOpen`. Ignored
    // when `openProp !== undefined` (controlled mode).
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const isControlled = openProp !== undefined;
    const effectiveOpen = isControlled ? openProp : internalOpen;

    // Chain manager — null when rendered outside a ResponderChainProvider
    // (standalone previews, unit tests). Dismissal re-emission below
    // only fires when a manager is in scope.
    const manager = useResponderChain();

    const fallbackSenderId = React.useId();
    const senderId = senderIdProp ?? fallbackSenderId;

    // Track effective open state in a ref so the imperative handle's
    // isOpen() closure reads the latest value without triggering
    // dependency-array churn.
    const openRef = React.useRef(effectiveOpen);
    openRef.current = effectiveOpen;

    // Refs for policy parameters so `close` (below) can stay
    // identity-stable even when `isControlled` or `onOpenChangeProp`
    // change between renders. Context consumers get a stable `close`,
    // so responder handlers that close over it don't re-register.
    const isControlledRef = React.useRef(isControlled);
    isControlledRef.current = isControlled;
    const onOpenChangePropRef = React.useRef(onOpenChangeProp);
    onOpenChangePropRef.current = onOpenChangeProp;
    const managerRef = React.useRef(manager);
    managerRef.current = manager;

    // Single helper the chain-action shell and the imperative handle
    // both route through for "close." In controlled mode it cannot flip
    // state directly — it just asks the caller to update via the
    // callback. In uncontrolled mode it flips internal state AND
    // notifies the caller. Stable identity via useCallback + refs.
    const close = React.useCallback(() => {
      if (!isControlledRef.current) setInternalOpen(false);
      onOpenChangePropRef.current?.(false);
    }, []);

    // [P05] Close AND re-emit the popover-scoped `DISMISS_POPOVER` through the
    // chain in one place. Inner composites (TugConfirmPopover's promise/callback
    // resolution, other `observeDispatch` consumers) listen to the chain, not to
    // Radix — so the emission must be close-path-invariant. Both the Radix/user
    // close (`handleOpenChange(false)`) and the engine's Escape dismiss
    // (registered as the trap's `onEscapeDismiss`) route through here, so an
    // engine-initiated close resolves them exactly as a Radix-initiated one did
    // ([R01]). The emission carries our `senderId` so the shell's `observeDispatch`
    // filters its own re-entry; handlers are idempotent once resolved, so a
    // double-delivery is harmless. Stable identity (refs) — safe in `contextValue`.
    const closeAndEmit = React.useCallback(() => {
      if (!isControlledRef.current) setInternalOpen(false);
      onOpenChangePropRef.current?.(false);
      managerRef.current?.sendToFirstResponder({
        action: TUG_ACTIONS.DISMISS_POPOVER,
        sender: senderId,
        phase: "discrete",
      });
    }, [senderId]);

    React.useImperativeHandle(
      ref,
      () => ({
        open() {
          if (!isControlledRef.current) setInternalOpen(true);
          onOpenChangePropRef.current?.(true);
        },
        close() {
          close();
        },
        isOpen() {
          return openRef.current;
        },
      }),
      [close],
    );

    // Card-lifecycle dismissal. A popover is a transient surface; when
    // the user switches cards, a popover left open on the outgoing
    // card must not linger as a floating overlay across the incoming
    // card (Radix renders content in a portal, so it does not unmount
    // with the deactivating card's subtree). `observeCardWillDeactivate
    // (null, …)` fires for ANY card transition — and since only one
    // card is active at a time, an open popover necessarily belongs to
    // the card that is deactivating. `useCardLifecycle` returns `null`
    // outside a provider (standalone previews, unit tests); the effect
    // no-ops cleanly there.
    const cardLifecycle = useCardLifecycle();
    React.useEffect(() => {
      if (cardLifecycle === null) return;
      return cardLifecycle.observeCardWillDeactivate(null, () => {
        if (openRef.current) close();
      });
    }, [cardLifecycle, close]);

    // Radix-level dismissal (Escape via DismissableLayer, click-outside
    // via DismissableLayer, explicit TugPopoverClose activation). In
    // uncontrolled mode, flip internal state; in controlled mode, let
    // the caller's onOpenChange drive it. Always re-emit a popover-
    // scoped dismiss action through the chain on close so inner
    // composites (e.g. TugConfirmPopover) can observe the dismissal
    // via `observeDispatch` (action-agnostic). The dispatch carries
    // our own senderId so the observeDispatch subscription in
    // TugPopoverContent filters its own re-entry out.
    //
    // We dispatch `DISMISS_POPOVER`, not `CANCEL_DIALOG`. CANCEL_DIALOG
    // is also handled by `TugSheet`, so a click-outside dismissal of a
    // popover rendered inside a sheet would walk up the chain past the
    // popover (whose responder may not be the first responder when the
    // dismissal fires) and hit the sheet's `cancelDialog` handler —
    // closing the surrounding sheet along with the popover. That is
    // chain pollution, not the intended behavior. DISMISS_POPOVER is
    // popover-private (only `TugPopoverContentShell` handles it), so
    // the walk either lands on the shell and stops, or falls off the
    // chain harmlessly. Inner composites still observe the dispatch
    // unchanged because `observeDispatch` does not filter by action.
    function handleOpenChange(nextOpen: boolean) {
      if (!nextOpen) {
        // Route through the shared close-and-emit helper ([P05]) so a Radix/user
        // close (outside pointerdown) and an engine Escape dismiss resolve inner
        // composites identically.
        closeAndEmit();
        return;
      }
      // First responder + key view are captured by the engine focus trap's
      // `pushFocusMode` (in `TugPopoverContent`) when the surface opens; the
      // trap's `onCloseAutoFocus` restores them on close. No separate capture here.
      if (!isControlled) setInternalOpen(nextOpen);
      onOpenChangeProp?.(nextOpen);
    }

    // Captures the trigger element so the open popover can watch the
    // trigger's layout ancestors for resize-driven dismissal. Stable
    // ref — not a `useMemo` dependency.
    const triggerElRef = React.useRef<HTMLElement | null>(null);

    const contextValue = React.useMemo<TugPopoverInternalContextValue>(
      () => ({
        close,
        closeAndEmit,
        open: effectiveOpen,
        senderId,
        dismissOnChainActivity,
        triggerElRef,
      }),
      [close, closeAndEmit, effectiveOpen, senderId, dismissOnChainActivity],
    );

    return (
      <TugPopoverInternalContext.Provider value={contextValue}>
        <Popover.Root open={effectiveOpen} onOpenChange={handleOpenChange} modal={modal}>
          {children}
        </Popover.Root>
      </TugPopoverInternalContext.Provider>
    );
  },
);

/* ---------------------------------------------------------------------------
 * TugPopoverTrigger
 * ---------------------------------------------------------------------------*/

/** TugPopoverTrigger props. */
export interface TugPopoverTriggerProps {
  /**
   * Render as child element, merging Radix behavior onto it.
   * @default true
   */
  asChild?: boolean;
  children: React.ReactNode;
}

/**
 * Thin wrapper on Radix Popover.Trigger. Defaults to asChild so the caller's
 * element is used directly as the trigger without a wrapper button.
 *
 * In `asChild` mode the trigger element is captured into the shared
 * `triggerElRef` (via a ref composed onto the child — Radix's `Slot`
 * merges its own ref alongside) so the open popover can observe the
 * trigger's layout ancestors for resize-driven dismissal.
 */
export function TugPopoverTrigger({ asChild = true, children }: TugPopoverTriggerProps) {
  const ctx = React.useContext(TugPopoverInternalContext);
  const triggerElRef = ctx?.triggerElRef;
  const captureTrigger = React.useCallback(
    (node: HTMLElement | null) => {
      if (triggerElRef) triggerElRef.current = node;
    },
    [triggerElRef],
  );
  const child =
    asChild && triggerElRef !== undefined && React.isValidElement(children)
      ? React.cloneElement(
          children,
          {
            // Composed, not assigned: a `ref` in the clone's props replaces the
            // child's own, and a trigger that has been given a popover must
            // keep reporting its node to whatever was already listening.
            ref: composeRefs(refOfElement<Element>(children), captureTrigger),
          } as React.Attributes,
        )
      : children;
  return <Popover.Trigger asChild={asChild}>{child}</Popover.Trigger>;
}

/* ---------------------------------------------------------------------------
 * TugPopoverAnchor
 * ---------------------------------------------------------------------------*/

/**
 * Anything that can report a rectangle — what Radix's Popper actually needs
 * from an anchor. An `HTMLElement` satisfies it; so does a hand-written
 * object that derives its rect from a live element, which is how a popover
 * points at a REGION of an element (a row's trailing accessory column)
 * without depending on a node that may collapse or unmount.
 */
export interface TugPopoverMeasurable {
  getBoundingClientRect(): DOMRect;
}

/** TugPopoverAnchor props. */
export interface TugPopoverAnchorProps {
  /**
   * Render as child element, merging anchor behavior onto it. Honored
   * only when `children` is provided; ignored when `virtualRef` is the
   * anchor source.
   * @default true
   */
  asChild?: boolean;
  /**
   * Virtual anchor: a ref to an external `HTMLElement` — or to any
   * `TugPopoverMeasurable` — that the popover positions itself against.
   * When provided, the anchor renders no DOM node of its own — Radix
   * reads `ref.current` on every Popper update to compute the anchor
   * rectangle. Lets a single popover instance point at different anchors
   * across renders by swapping the ref's `current` (or by passing a
   * different ref object).
   *
   * Because the rect is re-read on every update, a `TugPopoverMeasurable`
   * that computes its rect from a live element tracks that element through
   * scroll and layout exactly as an element anchor would.
   *
   * The ref's `current` is permitted to be `null` transiently. Radix
   * only reads `current` while the popover is mounted (i.e., the
   * `open` prop on the surrounding `TugPopover` is `true`); callers
   * that want the popover to stay closed while the anchor is
   * unresolved should gate the surrounding popover's `open` state on
   * a non-null anchor at the call site.
   *
   * Mutually exclusive with `children`. When `virtualRef` is set,
   * `children` is ignored.
   */
  virtualRef?: React.RefObject<TugPopoverMeasurable | null>;
  /**
   * Anchor element rendered in the React tree. Pass when the anchor IS
   * a component in the tree (the typical "anchor a popover to this
   * tab's <button>" case). Mutually exclusive with `virtualRef`.
   */
  children?: React.ReactNode;
}

/**
 * Thin wrapper on Radix `Popover.Anchor`. Use when the popover should
 * position relative to an element WITHOUT composing the trigger's
 * auto-toggle `onClick` onto that element. Two anchoring modes:
 *
 *  - **Tree-anchored** (`children` prop): the anchor element lives in
 *    the React tree and is used directly as the anchor. Pair with
 *    imperative `popoverRef.current.open()` / `.close()` for purely
 *    imperative-control popovers — i.e., a popover whose visibility is
 *    driven by a parent's logic (matrix branches, async work, etc.)
 *    rather than a single click on a button.
 *  - **Virtual-anchored** (`virtualRef` prop): the anchor element is
 *    referenced from outside the React tree (a `useRef` populated by
 *    `querySelector` in a layout effect, a callback ref registered by
 *    a child cell, etc.). Renders no DOM of its own. Lets one popover
 *    instance serve N anchor targets by swapping the ref's `current`.
 *    This is the shape `TugConfirmPopover`'s controlled-mode API uses
 *    to point at whichever in-list row owns the current confirmation
 *    request — see [tugplan-session-picker-redesign §D14](
 *    ../../arc/tugplan-session-picker-redesign.md#d14-no-per-cell-popovers).
 *
 * Why this exists: composing `Popover.Trigger` onto an element that
 * already participates in pointerdown / pointerup / click event
 * choreography (X buttons with pointer-capture, controls that have
 * their own onClick semantics, etc.) creates a fight between Radix's
 * toggle and the imperative `open()` call. The toggle reads the
 * `open` prop from its closure at click time; if the popover state
 * has updated between event phases (e.g., between `pointerup` and
 * `click` when the parent's pointerup handler already opened the
 * popover imperatively), the toggle inverts and immediately closes
 * what just opened. Using Anchor + imperative open avoids this
 * because no `onClick` toggle is composed onto the host element.
 *
 * Defaults to `asChild` so the caller's element is used directly as
 * the anchor without a wrapper div (tree-anchored mode only).
 */
export function TugPopoverAnchor({
  asChild = true,
  virtualRef,
  children,
}: TugPopoverAnchorProps) {
  if (virtualRef !== undefined) {
    // Radix's `virtualRef` is typed `RefObject<Measurable>` where Measurable
    // is non-nullable. Our prop type is intentionally permissive — `current`
    // may be null transiently, with the caller gating the surrounding
    // popover's `open` state to ensure Radix only reads the ref while
    // `current` is non-null. The cast bridges the typing gap at this single
    // boundary; the caller-side gate is the runtime guarantee.
    return (
      <Popover.Anchor
        virtualRef={virtualRef as React.RefObject<HTMLElement>}
      />
    );
  }
  return <Popover.Anchor asChild={asChild}>{children}</Popover.Anchor>;
}

/* ---------------------------------------------------------------------------
 * TugPopoverContent
 * ---------------------------------------------------------------------------*/

/** TugPopoverContent props. */
export interface TugPopoverContentProps {
  /**
   * Which side of the trigger to place the popover.
   * @selector [data-side="top"] | [data-side="bottom"] | [data-side="left"] | [data-side="right"]
   * @default "bottom"
   */
  side?: "top" | "bottom" | "left" | "right";
  /**
   * Alignment along the side axis.
   * @selector [data-align="start"] | [data-align="center"] | [data-align="end"]
   * @default "center"
   */
  align?: "start" | "center" | "end";
  /**
   * Distance from trigger in px.
   * @default 6
   */
  sideOffset?: number;
  /**
   * Collision-shift behavior, forwarded verbatim to Radix's
   * `Popover.Content`.
   *
   *  - `"partial"` (default): Radix's `shift` keeps the popover *attached*
   *    to its anchor (via `limitShift`) and stops sliding once the anchor
   *    edge is reached — so an anchor that scrolls or sits off-screen drags
   *    the popover off-screen with it.
   *  - `"always"`: drops the limiter, so `shift` slides the popover fully
   *    into the viewport even when the anchor is off the canvas edge. Use
   *    for popovers whose anchor can be pushed past the deck boundary (e.g.
   *    a card's close-confirm popover anchored to an X button on a card
   *    whose right side is off-deck) so the popover always lands in view.
   *
   * @default "partial"
   */
  sticky?: "partial" | "always";
  /**
   * Distance in px the popover keeps from the collision boundary (the
   * viewport) when shifting to avoid overflow. Forwarded to Radix's
   * `Popover.Content`. Pair with `sticky="always"` so a slid-into-view
   * popover keeps a margin from the edge rather than sitting flush.
   * @default 0
   */
  collisionPadding?: number;
  /**
   * Element(s) the popover must stay inside when shifting/flipping to
   * avoid overflow. Forwarded verbatim to Radix's `Popover.Content` as
   * `collisionBoundary`. Defaults (`undefined`) to the viewport. Pass a
   * specific element to pin the popover within that element's bounds —
   * e.g. a card's close-confirm popover constrained to the card so it can
   * never spill over a neighboring card and make the target ambiguous.
   */
  collisionBoundary?: Element | null | Array<Element | null>;
  /**
   * Show the arrow pointer.
   * @default false
   */
  arrow?: boolean;
  /**
   * Override Radix's open-time auto-focus. Radix Popover's `FocusScope`
   * focuses the first focusable descendant by default, which couples
   * the Enter-key activation to DOM order rather than caller intent.
   * Confirm-style popovers should pick the focused button explicitly:
   *
   *   - `accept` semantics (Enter should activate the Confirm/primary
   *     button): pass a handler that `preventDefault()`s and focuses the
   *     Confirm button ref.
   *   - `cancel` semantics (Enter should dismiss, used for destructive
   *     confirmations): same shape, but focus the Cancel button ref.
   *
   * Forwarded verbatim to Radix's `Popover.Content`.
   */
  onOpenAutoFocus?: (event: Event) => void;
  /**
   * Opt this popover into "Space also closes it" — a second Space, after the
   * one that opened it from a focus-cycle trigger, dismisses it. The act
   * dispatch gates this so a Space on an interactive control inside the popover
   * still presses it; only a Space on the popover's own chrome closes. Use for
   * info popovers (Z2 status cells, the beat, the route report); leave off for
   * pickers, menus, and modal confirms whose Space belongs to their content.
   * @default false
   */
  spaceDismisses?: boolean;
  /** Additional CSS class names. */
  className?: string;
  children: React.ReactNode;
}

/**
 * Styled wrapper on Radix Portal + Content + optional Arrow. Owns the
 * popover chrome: background, border, shadow, border-radius, and
 * enter/exit animations. Internal spacing is left to the caller.
 *
 * The chain responder is registered by the nested `TugPopoverContentShell`
 * which is only mounted when Radix actually renders the popover content.
 * This keeps the responder lifecycle locked to the popover's open state
 * and prevents the chain's auto-promotion logic (fired on any
 * parentId===null registration while `firstResponderId===null`) from
 * stealing first responder from inner composites that mount earlier
 * in the React tree (e.g. `TugConfirmPopover`'s own inner responder,
 * which mounts at the TugConfirmPopover component level regardless of
 * open state). See the docstring on this file for the full rationale.
 */
export const TugPopoverContent = React.forwardRef<HTMLDivElement, TugPopoverContentProps>(
  function TugPopoverContent(
    {
      side = "bottom",
      align = "center",
      sideOffset = 6,
      sticky = "partial",
      collisionPadding = 0,
      collisionBoundary,
      arrow = false,
      onOpenAutoFocus,
      spaceDismisses,
      className,
      children,
    },
    forwardedRef,
  ) {
    const overlayRoot = useCanvasOverlay();
    const ctx = React.useContext(TugPopoverInternalContext);
    // Engine focus trap ([#cfrunloop-model]): while the popover is open, push a
    // trapped focus mode (Tab cycles the popover's own focusables; the opener's key
    // view + first responder are captured at open and restored on close). The trap
    // also provides the SINGLE close-focus DOM writer wired to Radix's
    // `onCloseAutoFocus` below, and `deferDomFocusToTeardown` so `popFocusMode`
    // restores only logical state (the hook owns the DOM move, at teardown timing).
    // `FocusModeScope` is handed to the content shell so focusables inside join this
    // mode. [L03] (push in a layout effect) / [L06] (mode projection is DOM).
    const { FocusModeScope, onCloseAutoFocus } = useFocusTrap({
      active: ctx?.open ?? false,
      deferDomFocusToTeardown: true,
      spaceDismisses,
      // [P01]/[P05] The engine's Escape ladder owns this surface's dismissal:
      // when the popover's trap is the top mode, the ladder calls this to close
      // AND re-emit `DISMISS_POPOVER` (so inner composites resolve). Radix's own
      // Escape is suppressed below — the engine is the single arbiter.
      onEscapeDismiss: ctx ? () => ctx.closeAndEmit() : undefined,
    });
    // Popup-in-sheet z-tier elevation per [D09]. When TugPopover is
    // rendered inside a `<TugSheetContent>`, the sheet provides
    // `TugSheetStackingContext` with value `true`; we tag the portaled
    // content so its CSS class swaps to `--tug-z-overlay-popup-in-dialog`.
    // Outside a sheet the context is `false` (default) and stacking is
    // unchanged.
    const inDialog = React.useContext(TugSheetStackingContext);
    return (
      <Popover.Portal container={overlayRoot}>
        <Popover.Content
          ref={forwardedRef}
          data-slot="tug-popover"
          className={cn(
            "tug-popover-content",
            inDialog && "tug-popup-in-dialog",
            className,
          )}
          side={side}
          align={align}
          sideOffset={sideOffset}
          sticky={sticky}
          collisionPadding={collisionPadding}
          collisionBoundary={collisionBoundary}
          onOpenAutoFocus={onOpenAutoFocus}
          // The engine focus trap is the single close-focus writer: at FocusScope
          // teardown (the only moment focus won't be yanked back into the closing
          // popover) it re-projects the restored key view, or defers when the user
          // dismissed by clicking elsewhere / on a relinquish close. See
          // `useFocusTrap`'s `onCloseAutoFocus`.
          onCloseAutoFocus={onCloseAutoFocus}
          // Suppress Radix DismissableLayer's focus-outside dismissal.
          // Focus moving to a sibling element (e.g. the editor under a
          // popover that opened with persisted `open=true` after reload,
          // or the editor regaining focus after a chain-driven re-focus
          // while the popover stays mounted) would otherwise call
          // `onDismiss` and flip our controlled `open` prop to false.
          // The pointerdown-outside path still dismisses on real
          // user-driven clicks; the focus-outside path is redundant
          // because every user click that moves focus also fires
          // pointerdown first.
          onFocusOutside={(e) => e.preventDefault()}
          // A context menu spawned from this popover's own content (a copyable
          // row's right-click → Copy) portals to the canvas overlay, structurally
          // OUTSIDE this content — so clicking its `Copy` item reads as a
          // pointerdown-outside and would dismiss the popover mid-interaction.
          // The menu is part of this surface's interaction, not an exit: ignore
          // pointerdowns that land within a `tug-editor-context-menu`.
          onPointerDownOutside={(e) => {
            const target = e.detail.originalEvent.target;
            if (
              target instanceof Element &&
              target.closest('[data-slot="tug-editor-context-menu"]') !== null
            ) {
              e.preventDefault();
            }
          }}
          // [P03] Suppress Radix's own Escape dismissal — the engine's Escape
          // ladder is the single arbiter and calls `onEscapeDismiss` (above).
          // Listener ordering can never matter again: Radix never acts on Escape.
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <TugPopoverContentShell FocusModeScope={FocusModeScope}>
            {children}
          </TugPopoverContentShell>
          {arrow && (
            <Popover.Arrow className="tug-popover-arrow" width={14} height={7} />
          )}
        </Popover.Content>
      </Popover.Portal>
    );
  },
);

/**
 * Inner shell mounted only when Radix's Popover.Content actually renders
 * its children (i.e., while the popover is open or during its exit
 * animation). This is where `useOptionalResponder` is called, so the
 * responder registers on open and unregisters on close — matching the
 * popover's open lifecycle exactly.
 *
 * Renders a `display: contents` div so the wrapper has no layout box
 * but still carries `data-responder-id`, captures `onMouseDown` for
 * the Safari focus-shift fix, and receives the ref for
 * `findResponderForTarget` walks.
 */
function TugPopoverContentShell({
  children,
  FocusModeScope,
}: {
  children: React.ReactNode;
  FocusModeScope: React.FC<{ children: React.ReactNode }>;
}) {
  const ctx = React.useContext(TugPopoverInternalContext);
  const manager = useResponderChain();
  const responderId = React.useId();

  // Local ref to the shell's root div. Used by observeDispatch to
  // check whether the currently focused element is inside the
  // popover before dismissing — dispatches originating from form
  // controls inside the popover should not dismiss their own
  // containing popover.
  const contentElRef = React.useRef<HTMLDivElement | null>(null);

  const handleClose = React.useCallback(() => {
    ctx?.close();
  }, [ctx]);

  // Dismiss the popover when a layout change moves its trigger.
  // Radix only dismisses on a `pointerdown` outside the popover and
  // repositions on the trigger's own resize / scroll — it does not
  // catch the trigger being *moved* by an ancestor resizing (a pane
  // drag-resize, a window resize). So the open popover watches the
  // trigger's layout ancestors with a `ResizeObserver`: any of them
  // resizing means the trigger has shifted. RO callbacks run after
  // layout and before paint, so the popover is hidden synchronously
  // and closed before a detached frame can render — no per-frame
  // reposition loop, which would be the wrong tool ([L05] / [L13]).
  // The `window` `resize` listener is a second, direct trigger;
  // without a captured trigger element (anchor-driven popovers) the
  // observer falls back to the document element.
  React.useLayoutEffect(() => {
    if (!ctx) return;
    const dismiss = (): void => {
      // Hide before the close commits so the 100ms exit animation
      // never plays while the popover is detached from its trigger.
      const contentEl = contentElRef.current?.parentElement;
      if (contentEl instanceof HTMLElement) {
        contentEl.style.visibility = "hidden";
      }
      ctx.close();
    };
    // Observe every layout ancestor of the trigger, up to <html>.
    // A pane / card resize resizes an ancestor; a window resize
    // resizes <html>. The trigger itself is skipped — Radix already
    // repositions correctly when the trigger resizes.
    const targets: Element[] = [];
    const triggerEl = ctx.triggerElRef.current;
    if (triggerEl) {
      let el: Element | null = triggerEl.parentElement;
      while (el) {
        targets.push(el);
        el = el.parentElement;
      }
    } else {
      targets.push(document.documentElement);
    }
    let primed = false;
    const observer = new ResizeObserver(() => {
      // ResizeObserver delivers one callback at observe() time
      // carrying the starting sizes — that is not a resize.
      if (!primed) {
        primed = true;
        return;
      }
      dismiss();
    });
    for (const target of targets) observer.observe(target);
    window.addEventListener("resize", dismiss);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", dismiss);
    };
  }, [ctx]);

  const { responderRef } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.CANCEL_DIALOG]: handleClose,
      [TUG_ACTIONS.DISMISS_POPOVER]: handleClose,
    },
  });

  const composedShellRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      contentElRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );

  // External dismissal: chain activity while the popover is open
  // closes it — with two filters:
  //
  // 1. Self-dispatches (the cancelDialog re-emission from the root's
  //    handleOpenChange) carry the root's senderId and are filtered
  //    so we do not schedule a redundant close.
  //
  // 2. Dispatches originating from inside the popover (e.g. a
  //    TugSwitch toggle or TugInput commit dispatched from a form
  //    control nested within the popover content) should not dismiss
  //    their own container. We detect this by checking whether
  //    `document.activeElement` is inside our content element — if
  //    the user's focus is on a control inside the popover, the
  //    dispatch was their interaction with the popover, not a
  //    signal to close it. Without this filter, the Form Content
  //    gallery example (popover containing an input, a switch, and
  //    a save button) would self-dismiss on every field change.
  //
  // **The focus-inside filter is a heuristic.** It assumes that
  // `document.activeElement` accurately reflects "the user is
  // interacting with the popover", which is true for the cases we
  // care about (text input focused, Safari's click-without-focus
  // on buttons leaving focus on the last field) but can be fooled
  // by a programmatic dispatch that happens to run while focus is
  // inside the popover — e.g. a timer firing a shortcut action
  // while the user is typing. The filter will skip such a
  // dispatch and keep the popover open, even though the dispatch
  // may have represented a legitimate "close now" signal. This is
  // an acceptable trade-off for now: keeping form-content popovers
  // usable is more important than dismissing on weird background
  // traffic, and users can always press Escape or click outside.
  // Revisit if a concrete use case surfaces where this trade-off
  // goes the wrong way.
  //
  // Subscribe via useLayoutEffect so the subscription is in place
  // before any paint that could deliver an event through the chain.
  // [L03]
  React.useLayoutEffect(() => {
    if (!manager || !ctx) return;
    // Caller opted out of chain-triggered dismissal — the popover stays
    // open across nested dispatches. Click-outside + Escape still close
    // it via Radix's own handlers.
    if (!ctx.dismissOnChainActivity) return;
    const selfSenderId = ctx.senderId;
    return manager.observeDispatch((event) => {
      if (event.sender === selfSenderId) return;
      const contentEl = contentElRef.current;
      if (contentEl && typeof document !== "undefined") {
        const activeEl = document.activeElement;
        if (
          activeEl &&
          activeEl !== document.body &&
          contentEl.contains(activeEl)
        ) {
          return;
        }
      }
      ctx.close();
    });
  }, [manager, ctx]);

  return (
    <div
      ref={composedShellRef}
      onMouseDown={suppressButtonFocusShift}
      style={{ display: "contents" }}
    >
      <FocusModeScope>{children}</FocusModeScope>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * TugPopoverClose
 * ---------------------------------------------------------------------------*/

/**
 * Re-export of Radix Popover.Close. Renders a button that closes the popover
 * when activated. Use with asChild to render a custom element.
 */
export const TugPopoverClose = Popover.Close;


/* ---------------------------------------------------------------------------
 * useTugPopoverClose
 * ---------------------------------------------------------------------------*/

/**
 * Hook that returns a function closing the nearest enclosing TugPopover.
 *
 * Call this from any component nested inside a `TugPopoverContent` when
 * you need to dismiss the popover from a control that isn't a Cancel
 * button — e.g. a "Save Changes" button in a form-content popover, a
 * custom confirmation flow, or any imperative "close now" trigger.
 *
 * The returned function dispatches `dismissPopover` through the
 * responder chain with the popover's own senderId. The walk reaches
 * `TugPopoverContentShell`'s registered handler, which closes the
 * popover via the internal context. If the dispatch isn't handled
 * (no chain-native responder in scope), the function falls back to
 * calling the context `close` callback directly so the popover still
 * closes in no-provider contexts.
 *
 * The action is `dismissPopover`, not `cancelDialog`, for the same
 * reason `handleOpenChange` re-emits `dismissPopover` (see the file
 * docstring's "Radix-level dismissal → chain dispatch" section):
 * `cancelDialog` is also handled by `TugSheet`, so dismissing a
 * popover-in-sheet via this hook would walk past the popover and
 * close the sheet too. `dismissPopover` is popover-private.
 *
 * When called outside a TugPopover context, the returned function is a
 * no-op.
 *
 * Distinct from the `focus-inside-popover` filter that protects
 * ordinary form controls (switches, inputs, sliders) from dismissing
 * their own container: that filter operates on `observeDispatch`
 * traffic, whereas this hook drives an intentional dismissal through
 * the responder's own `cancelDialog` handler path.
 */
export function useTugPopoverClose(): () => void {
  const ctx = React.useContext(TugPopoverInternalContext);
  const manager = useResponderChain();
  return React.useCallback(() => {
    if (!ctx) return;
    if (manager) {
      const handled = manager.sendToFirstResponder({
        action: TUG_ACTIONS.DISMISS_POPOVER,
        sender: ctx.senderId,
        phase: "discrete",
      });
      if (handled) return;
    }
    ctx.close();
  }, [ctx, manager]);
}

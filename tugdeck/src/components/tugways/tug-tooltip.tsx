/**
 * TugTooltip — Hover/focus tooltip wrapping @radix-ui/react-tooltip.
 *
 * Provides TugTooltipProvider (shared delay config) and TugTooltip (inline
 * API: child element becomes the trigger, content + optional shortcut badge
 * rendered inside the tooltip bubble). Supports truncation-aware mode where
 * the tooltip is suppressed when the trigger content is not actually clipped —
 * measured at the open transition, so hover and focus opens are gated alike.
 *
 * ## Keyboard model — passive, never a focus stop
 *
 * Per the keyboard model ([P01]/[P03]), the tooltip is purely passive: it
 * **never takes the key view** and is **not a Tab stop**. The bubble is Radix
 * tooltip content — non-interactive, no `tabIndex`, no `useFocusable`
 * registration — so the engine never routes keystrokes to it and the ring never
 * moves onto it. It opens on the *trigger's* focus (Radix's focus/hover open
 * path); the trigger is the real focusable and keeps the key view and the ring
 * the whole time the tooltip is showing. There is nothing to trap, descend
 * into, or restore — the surface is display-only.
 *
 * ## Chain-reactive dismissal via observeDispatch
 *
 * While the tooltip is open, TugTooltip subscribes to
 * `manager.observeDispatch`. Any action flowing through the responder
 * chain — a keyboard shortcut, a button click elsewhere, a programmatic
 * dispatch — dismisses the tooltip. Rationale: a click that triggers
 * unrelated app activity is a strong signal the user is no longer
 * interested in the hovered content, and matches the macOS convention
 * of hover-surfaced affordances evaporating on any deliberate action.
 *
 * Tooltips never self-dispatch (they are display-only), so no blinkRef
 * guard is needed. When rendered outside a ResponderChainProvider
 * (standalone previews, unit tests that don't mount a provider),
 * `useResponderChain()` returns null and the subscription is silently
 * skipped — Radix's own hover/focus dismissal keeps working unchanged.
 *
 * ## Input gestures and open menus
 *
 * Two more gates sit beside that one. A click, right-click, or scroll ends a
 * hover wherever it lands, heard at the document in the capture phase
 * (`lib/tooltip-dismiss`) — the chain never sees a right-click that only
 * raises a menu. And no bubble opens at all while a menu is on screen
 * (`lib/open-menu-registry`): a menu and a tooltip float over the same region
 * describing the same target, and the one the user did not ask for gives way.
 *
 * To gate the subscription and close the tooltip from JS, TugTooltip
 * now always tracks a local mirror of Radix's open state via
 * `onOpenChange`. In pure uncontrolled mode this is a no-op relative
 * to prior behavior — Radix still calls `onOpenChange(true/false)`
 * during hover/focus, we update the mirror, and Radix sees the mirror
 * flow back through the `open` prop. Truncation suppression and
 * controlled-mode forwarding behave exactly as before.
 *
 * Laws: [L06] appearance via CSS/DOM — truncation measured off the live
 *       element at the open edge, not state,
 *       [L11] controls emit actions; responders handle actions,
 *       [L13] motion compliance — animation durations scale via --tug-timing,
 *       [L14] Radix Presence owns DOM lifecycle — use CSS keyframes,
 *       [L16] pairings declared, [L19] component authoring guide
 */

import "./tug-tooltip.css";

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { observeTooltipDismiss } from "@/lib/tooltip-dismiss";
import { anyMenuOpen, observeOpenMenus } from "@/lib/open-menu-registry";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";

/* ---------------------------------------------------------------------------
 * TugTooltipProvider
 * ---------------------------------------------------------------------------*/

/** TugTooltipProvider props. */
export interface TugTooltipProviderProps {
  /**
   * Delay in ms before tooltip appears on hover. Long enough that a pointer
   * crossing a control on its way somewhere else never raises a bubble.
   * @default 900
   */
  delayDuration?: number;
  /**
   * Window in ms after closing where the next tooltip opens instantly. Zero:
   * every control pays the full delay, so sweeping a toolbar stays quiet.
   * @default 0
   */
  skipDelayDuration?: number;
  /** App subtree. */
  children: React.ReactNode;
}

/**
 * Thin wrapper around Radix Tooltip.Provider. Place once at the app root
 * near other top-level providers (TugThemeProvider, ResponderChainProvider).
 */
export function TugTooltipProvider({
  delayDuration = 900,
  skipDelayDuration = 0,
  children,
}: TugTooltipProviderProps) {
  return (
    <Tooltip.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
      {children}
    </Tooltip.Provider>
  );
}

/* ---------------------------------------------------------------------------
 * TugTooltip
 * ---------------------------------------------------------------------------*/

/** TugTooltip props. */
export interface TugTooltipProps {
  /**
   * Content rendered inside the tooltip bubble. Accepts ReactNode for rich
   * multi-line tooltips.
   */
  content: React.ReactNode;
  /**
   * Keyboard shortcut string rendered as a styled kbd badge alongside content.
   * @selector .tug-tooltip-shortcut
   */
  shortcut?: string;
  /**
   * What kind of thing the bubble is saying, which decides its measure and
   * flow. `label` is the default — a phrase, optionally with a chord chip,
   * laid out as one centered row. `entity` is a block of facts about a
   * commit, a session, or a file (see `entity-tips.tsx`): it flows as a
   * block and takes a wider cap, because a file roster in a 300px column
   * wraps every path.
   * @selector [data-variant="label"] | [data-variant="entity"]
   * @default "label"
   */
  variant?: "label" | "entity";
  /**
   * Which side of the trigger to place the tooltip.
   * @selector [data-side="top"] | [data-side="bottom"] | [data-side="left"] | [data-side="right"]
   * @default "top"
   */
  side?: "top" | "bottom" | "left" | "right";
  /**
   * Alignment along the side axis.
   * @selector [data-align="start"] | [data-align="center"] | [data-align="end"]
   * @default "center"
   */
  align?: "start" | "center" | "end";
  /**
   * Distance in px from the trigger element.
   * @default 6
   */
  sideOffset?: number;
  /**
   * Render the directional arrow pointer.
   * @default true
   */
  arrow?: boolean;
  /** Override delay duration for this specific tooltip. */
  delayDuration?: number;
  /**
   * Only show when the trigger content is visually clipped (overflow ellipsis).
   * Measures scrollWidth vs clientWidth (and scrollHeight vs clientHeight) at
   * the open transition. Suppresses open when content fits; never blocks close.
   * Reads the live element, no React state, no re-render. [L06]
   *
   * Measured at the OPEN EDGE rather than on pointerenter, which is where this
   * started. Two things were wrong with the earlier point. React synthesizes
   * `onPointerEnter` from `pointerover`, so the handler was subject to an event
   * the caller never dispatches directly and a synthetic hover skipped the
   * measurement entirely — leaving the previous measurement standing. And a
   * tooltip opened by FOCUS never sees a pointer at all, so a keyboard user got
   * the bubble whether or not anything was clipped. The open edge is the one
   * moment both paths pass through, and it is when the answer is wanted.
   * @default false
   */
  truncated?: boolean;
  /**
   * Optional predicate invoked at each open-transition with the current
   * trigger element. Returning `true` suppresses the open; returning `false`
   * allows it. Evaluated only on the open edge — never blocks close.
   *
   * Intended for callers that need to gate the tooltip on an appearance-zone
   * attribute (e.g. `data-overflow="collapsed"`) without escaping into React
   * state. Read directly from the live DOM — no ref, no re-render. [L06]
   */
  suppressOpen?: (trigger: Element) => boolean;
  /** Controlled open state. */
  open?: boolean;
  /**
   * Seed the initial open state for uncontrolled mode. Useful for tests
   * that want to render a pre-opened tooltip without driving pointer
   * events through Radix. Ignored in controlled mode (the consumer owns
   * the state via `open`).
   * @default false
   */
  defaultOpen?: boolean;
  /** Controlled state callback. */
  onOpenChange?: (open: boolean) => void;
  /** The trigger element. Rendered with Radix asChild — no wrapper div. */
  children: React.ReactElement;
}

/**
 * Whether an element is showing less than it holds — the question `truncated`
 * mode asks. One synchronous read of both axes, so an element clipped by a
 * `nowrap` line and one clipped by a `max-height` both answer yes.
 */
function isClipped(el: Element): boolean {
  return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
}

/**
 * Inline tooltip API. Wrap any element to give it a tooltip:
 *
 * ```tsx
 * <TugTooltip content="Save document" shortcut="⌘S">
 *   <button>💾</button>
 * </TugTooltip>
 * ```
 *
 * Does not use forwardRef — TugTooltip is a wrapper, not a DOM element.
 */
export function TugTooltip({
  content,
  shortcut,
  variant = "label",
  side = "top",
  align = "center",
  sideOffset = 6,
  arrow = true,
  delayDuration,
  truncated = false,
  suppressOpen,
  open: controlledOpen,
  defaultOpen,
  onOpenChange: controlledOnOpenChange,
  children,
}: TugTooltipProps) {
  const overlayRoot = useCanvasOverlay();

  // Local mirror of Radix's open state. Always tracked (not just in
  // truncated mode) so the observeDispatch effect below has a stable
  // boolean to gate on and a setter to drive chain-reactive dismissal.
  // Radix is bound to this via `open` / `onOpenChange` below, so hover /
  // focus events still flow through Radix's delay machinery normally —
  // Radix calls `onOpenChange(true)` after the delay, we update the
  // mirror, and the mirror flows back into Radix through the `open`
  // prop on the next render.
  const [openMirror, setOpenMirror] = React.useState<boolean>(defaultOpen ?? false);

  // Ref to the trigger DOM element for truncation measurement.
  const triggerElRef = React.useRef<Element | null>(null);

  // Determine whether we operate in controlled or uncontrolled mode.
  // Controlled = the consumer owns the open state via the `open` prop.
  // `onOpenChange` alone does not make the component controlled — a
  // consumer may observe state changes without owning the value.
  const isControlled = controlledOpen !== undefined;

  // The effective open value handed to Radix. In controlled mode the
  // consumer owns it; otherwise we use our local mirror. Truncation
  // suppression is applied inside handleOpenChange at the open
  // transition, not here.
  const effectiveOpen = isControlled ? controlledOpen : openMirror;

  function handleOpenChange(nextOpen: boolean) {
    // Never block close — only suppress open when a gate says so. [L06]
    if (nextOpen === true) {
      // A menu is up: the user is answering a question, not asking one. No
      // bubble opens over an open menu, whatever the hover says.
      if (anyMenuOpen()) {
        return;
      }
      if (truncated && triggerElRef.current !== null && !isClipped(triggerElRef.current)) {
        return;
      }
      if (suppressOpen && triggerElRef.current && suppressOpen(triggerElRef.current)) {
        return;
      }
    }
    if (!isControlled) {
      setOpenMirror(nextOpen);
    }
    controlledOnOpenChange?.(nextOpen);
  }

  // Chain-reactive dismissal via observeDispatch. [L11]
  //
  // Manager is null when rendered outside a ResponderChainProvider
  // (standalone previews, unit tests without a provider); the effect
  // then short-circuits and Radix's own hover/focus dismissal keeps
  // working unchanged. Tooltips never self-dispatch, so no blink guard
  // is needed — any action flowing through the chain dismisses.
  //
  // Uses useLayoutEffect per [L03] so the subscription is in place
  // before any paint that could deliver a dispatch.
  const manager = useResponderChain();
  React.useLayoutEffect(() => {
    if (!effectiveOpen || !manager) return;
    return manager.observeDispatch(() => {
      handleOpenChange(false);
    });
    // handleOpenChange is a fresh closure each render but its behavior
    // is stable for a given (isControlled, controlledOnOpenChange, truncated)
    // tuple; re-subscribing on every render would churn the effect,
    // so we intentionally narrow deps to the gating values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOpen, manager]);

  // Input-gesture dismissal. [L06]
  //
  // Click, right-click, and scroll end a hover — unconditionally, wherever
  // they land. observeDispatch above catches the deliberate act that reaches
  // the responder chain; this catches the gestures that never get there: a
  // right-click that only raises a menu, a press on a surface owning its own
  // pointer handling, a wheel over the transcript. The subscription is
  // capture-phase at the document, so the bubble is gone before the menu
  // that gesture opens can paint beside it.
  React.useLayoutEffect(() => {
    if (!effectiveOpen) return;
    return observeTooltipDismiss(() => {
      handleOpenChange(false);
    });
    // Same narrowing as above: handleOpenChange is a fresh closure per
    // render but stable in behavior, and re-subscribing every render would churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOpen]);

  // A menu appearing takes the bubble down with it.
  //
  // The open gate above keeps a bubble from opening while a menu stands; this
  // handles the other order — a menu raised while a bubble is already up. Most
  // of those arrive as a right-click, which the gesture subscription above
  // already caught, but a menu raised by a chord or by another surface's code
  // has no pointer press to hear. Subscribing closes that gap, so "never both
  // at once" holds however the menu came to be.
  React.useLayoutEffect(() => {
    if (!effectiveOpen) return;
    return observeOpenMenus(() => {
      if (anyMenuOpen()) handleOpenChange(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOpen]);

  // Callback ref that captures the trigger DOM element for measurement.
  // Merged onto the Radix Trigger child via React.cloneElement on the asChild path.
  const triggerCallbackRef = React.useCallback((el: Element | null) => {
    triggerElRef.current = el;
  }, []);

  // Radix Root props: always bind open + onOpenChange to our mirror so
  // the observeDispatch effect has a stable gate and a programmatic
  // close path. delayDuration is forwarded only when the caller
  // overrides the provider-level default.
  const rootProps: React.ComponentPropsWithoutRef<typeof Tooltip.Root> = {
    ...(delayDuration !== undefined ? { delayDuration } : {}),
    open: effectiveOpen,
    onOpenChange: handleOpenChange,
  };

  // Clone the child to attach the callback ref, so both open-edge gates —
  // truncation measurement and the caller's `suppressOpen` — can read the live
  // trigger element. The Radix asChild trigger merges it. Nothing else is
  // added: the child keeps its own handlers untouched. [L06]
  const needsTriggerRef = truncated || suppressOpen !== undefined;
  const trigger = needsTriggerRef
    ? React.cloneElement(children, {
        ref: triggerCallbackRef,
      } as Record<string, unknown>)
    : children;

  return (
    <Tooltip.Root {...rootProps}>
      <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
      <Tooltip.Portal container={overlayRoot}>
        <Tooltip.Content
          data-slot="tug-tooltip"
          data-variant={variant}
          className={cn("tug-tooltip-content")}
          side={side}
          align={align}
          sideOffset={sideOffset}
        >
          {content}
          {shortcut && <kbd className="tug-tooltip-shortcut">{shortcut}</kbd>}
          {arrow && <Tooltip.Arrow className="tug-tooltip-arrow" />}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

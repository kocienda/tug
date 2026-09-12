/**
 * tug-placard.tsx — a card-scoped, in-DOM floating panel.
 *
 * `TugPlacard` is a third floating surface alongside the popover and the
 * modal (sheet/alert) families documented in {@link file://./internal/floating-surface-notes.ts}.
 * Unlike a `TugPopover` it renders **in place** rather than portaling to the
 * deck-level canvas overlay, which makes it card-scoped for free: it hides with
 * its card when the card becomes a background tab (`display: none`), reappears
 * intact on refront, and never bleeds over a neighbouring pane. Rendering
 * in-DOM also lets it own its own position.
 *
 * ## Behavior axes
 *
 * Two orthogonal props configure a placard per-surface:
 *
 *  - `dismiss` — `"explicit"` (default) stays open until the user clicks the
 *    header `×`; nothing else dismisses it. `"auto"` renders no `×` and closes
 *    on an outside pointerdown or Escape / Cmd-. (see {@link usePlacardAutoDismiss}).
 *  - `reposition` — `false` (default) opens centered on a caller-supplied `anchorCenter`
 *    and is fixed. `true` makes the header a horizontal drag handle whose
 *    committed fraction persists through tugbank (see {@link ./tug-placard-pref}).
 *
 * ## Positioning contract
 *
 * The placard owns the **horizontal** axis (`left`, written imperatively); the
 * caller owns the **vertical** axis and the width via `className` (e.g.
 * `bottom: calc(100% + …)` to sit just above the container). The caller MUST
 * render it inside a positioned ancestor (that ancestor is the horizontal
 * bounds — its `clientWidth` is the travel).
 *
 * ## Viewport guard
 *
 * The placard writes `--radix-popover-content-available-height` onto its own
 * root from the gap between its anchored edge and the edge it grows toward, so
 * a long composed `TugPopupList` scroller caps and scrolls rather than
 * overflowing — the same custom property the list CSS reads for a real Radix
 * popover, so no shared CSS changes ([R01]). Upward (the default) that gap runs
 * from the panel's bottom edge to the top of the viewport; downward it runs
 * from the panel's top edge to {@link TugPlacardProps.bottomBoundEl}'s bottom,
 * never past the window.
 *
 * ## Growth
 *
 * `growth` is which way the panel opens off its anchor, and the caller's CSS
 * has to agree with it: `"up"` anchors the panel's `bottom` and grows toward
 * the viewport top, `"down"` anchors its `top` and grows toward the bound. It
 * is a whole axis rather than a Session-card special case because the reason a
 * surface flips is always the same — there is no room the other way.
 *
 * All position + appearance is DOM/CSS, never React state ([L06]).
 *
 * @module components/tugways/tug-placard
 */

import React from "react";
import { X } from "lucide-react";

import { TugButton } from "@/components/tugways/internal/tug-button";
import { cn } from "@/lib/utils";
import { isCancelChordEvent } from "./keymap-registry";
import {
  clampOffsetFraction,
  usePlacardOffset,
  writePlacardOffset,
} from "./tug-placard-pref";

import "./tug-placard.css";

/** Inset (px) kept between the panel and the LEFT edge of its container. */
const DRAG_INSET = 8;

/**
 * Extra inset reserved on the RIGHT edge so the panel never overlaps the
 * card's scrollbar — the container spans the full card width (scrollbar
 * included), and the scroller reserves a stable 12px gutter. We keep that 12px
 * plus the ordinary 8px gap. This bounds both the default placement and the
 * rightmost draggable / anchored position.
 */
const RIGHT_INSET = DRAG_INSET + 12;

/** Default horizontal fraction when no position has been saved: right-aligned. */
const DEFAULT_FRACTION = 1;

/** Inset (px) kept short of the edge the guard measures toward. */
const AVAILABLE_EDGE_INSET = 8;

/**
 * Horizontal travel available to the panel: the container's inner width
 * minus the panel width and both insets. Clamped at 0 for a container
 * narrower than the panel.
 */
function computeTravel(containerWidth: number, panelWidth: number): number {
  return Math.max(0, containerWidth - panelWidth - DRAG_INSET - RIGHT_INSET);
}

/** Placard dismiss model. @see TugPlacardProps.dismiss */
export type TugPlacardDismiss = "auto" | "explicit";

/** Which way a placard opens off its anchor. @see TugPlacardProps.growth */
export type TugPlacardGrowth = "up" | "down";

export interface TugPlacardProps {
  /** Whether the placard is shown. When false, nothing renders. */
  open: boolean;
  /** Invoked on the header `×` (explicit) or on an auto-dismiss (auto). */
  onClose: () => void;
  /** Centered header title. */
  title: string;
  /** Placard body. */
  children: React.ReactNode;
  /** Caller styling — owns the placard's width and vertical placement. */
  className?: string;
  /** Caller inline style — the vertical anchor a computed placement writes. */
  style?: React.CSSProperties;
  /**
   * Dismiss model. `"explicit"` (default) shows the header `×` and dismisses
   * only on it. `"auto"` shows no `×` and dismisses on an outside pointerdown
   * or Escape / Cmd-.
   * @default "explicit"
   */
  dismiss?: TugPlacardDismiss;
  /**
   * Horizontal drag repositioning via the header. When false the placard opens
   * centered on {@link anchorCenter} and is fixed.
   * @default false
   */
  reposition?: boolean;
  /**
   * Which way the panel opens off its anchor, and which edge its guard
   * measures toward. The caller's CSS owns the matching anchor (`bottom` for
   * `"up"`, `top` for `"down"`).
   * @default "up"
   */
  growth?: TugPlacardGrowth;
  /**
   * The element whose bottom edge bounds a downward placard — the visible
   * canvas, for a placard hanging past its own pane. Clamped to the window in
   * either case. Only meaningful with `growth="down"`.
   */
  bottomBoundEl?: HTMLElement | null;
  /**
   * Horizontal center (px, within the positioned container) to center the
   * placard on when {@link reposition} is false — the host measures the
   * trigger cell's center and passes it, so the placard opens centered on its
   * trigger, clamped inside the container. Ignored when a persisted reposition
   * offset applies.
   */
  anchorCenter?: number;
  /**
   * CSS predicate for the trigger chrome an auto-dismiss placard must NOT treat
   * as an outside pointerdown (so the trigger's own click toggles cleanly).
   * Only meaningful with `dismiss="auto"`.
   */
  triggerSelector?: string;
  /**
   * Tugbank key persisting the horizontal drag position. Only meaningful with
   * `reposition`; omit for an ephemeral position.
   */
  persistKey?: string;
  /** Accessible label / tooltip for the close button (explicit only). */
  closeLabel?: string;
  /** Accessible label for the placard region. */
  "aria-label"?: string;
}

/**
 * Write `--radix-popover-content-available-height` onto the placard from the
 * gap between its anchored edge and the edge it grows toward, so a composed
 * `TugPopupList` scroller never overflows ([R01]). The anchored edge is the one
 * the caller's CSS pins (`bottom:` upward, `top:` downward), so this value is
 * stable across height changes and cannot feed a layout loop.
 */
function applyAvailableHeight(
  panel: HTMLDivElement,
  growth: TugPlacardGrowth,
  bottomBoundEl: HTMLElement | null | undefined,
): void {
  const box = panel.getBoundingClientRect();
  // Downward, the floor is the bound element's bottom — but never past the
  // window, which the bound (a canvas taller than the window, scrolled) can be.
  const floor =
    bottomBoundEl == null
      ? window.innerHeight
      : Math.min(bottomBoundEl.getBoundingClientRect().bottom, window.innerHeight);
  const available =
    growth === "down"
      ? Math.max(0, floor - box.top - AVAILABLE_EDGE_INSET)
      : Math.max(0, box.bottom - AVAILABLE_EDGE_INSET);
  panel.style.setProperty(
    "--radix-popover-content-available-height",
    `${available}px`,
  );
}

/**
 * Place the placard's `left` imperatively. Repositionable placards derive it
 * from the persisted/dragged fraction; fixed placards center on `anchorCenter`
 * (the trigger's center), clamped into the container.
 */
function applyPlacement(
  panel: HTMLDivElement,
  opts: { reposition: boolean; fraction: number; anchorCenter: number | undefined },
): void {
  const container = panel.offsetParent as HTMLElement | null;
  const containerWidth =
    container?.clientWidth ?? panel.parentElement?.clientWidth ?? 0;
  const travel = computeTravel(containerWidth, panel.offsetWidth);
  // Center the placard on the trigger: left = center − half the panel width,
  // clamped into the container. Falls back to right-aligned when no anchor.
  const desiredLeft =
    opts.anchorCenter !== undefined
      ? opts.anchorCenter - panel.offsetWidth / 2
      : DRAG_INSET + travel;
  const left = opts.reposition
    ? DRAG_INSET + clampOffsetFraction(opts.fraction) * travel
    : Math.max(DRAG_INSET, Math.min(DRAG_INSET + travel, desiredLeft));
  panel.style.left = `${left}px`;
  panel.style.right = "auto";
}

/**
 * While an auto-dismiss placard is open, close it on an outside pointerdown or
 * Escape / Cmd-. Registered capture-phase so it precedes the trigger's own
 * bubble handler; the trigger chrome is excluded so its click toggles the
 * placard rather than being read as "outside" ([P04]). Chain-free by design —
 * placards do not participate in the responder chain
 * ({@link file://./internal/floating-surface-notes.ts}).
 */
function usePlacardAutoDismiss(args: {
  open: boolean;
  dismiss: TugPlacardDismiss;
  panelRef: React.RefObject<HTMLDivElement | null>;
  triggerSelector: string | undefined;
  onClose: () => void;
}): void {
  const { open, dismiss, panelRef, triggerSelector, onClose } = args;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useLayoutEffect(() => {
    if (!open || dismiss !== "auto") return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      const panel = panelRef.current;
      if (panel !== null && panel.contains(target)) return;
      if (triggerSelector !== undefined && target.closest(triggerSelector)) return;
      onCloseRef.current();
    };
    // Surface-local dismiss, live only while this placard is open. A placard
    // is an in-DOM panel that does not push a focus mode, so the engine's
    // Escape ladder has nothing to route to it — dismissing it is the panel's
    // own business rather than a command with a chord. It neither prevents the
    // default nor stops propagation, so it takes the chord from nobody: it
    // closes itself and the event carries on to whoever else wants it.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || isCancelChordEvent(event)) {
        onCloseRef.current();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, dismiss, panelRef, triggerSelector]);
}

/**
 * A card-scoped, in-DOM floating panel. See the module docstring for the
 * behavior axes, positioning contract, and viewport guard.
 */
export function TugPlacard({
  open,
  onClose,
  title,
  children,
  className,
  style,
  dismiss = "explicit",
  reposition = false,
  growth = "up",
  bottomBoundEl,
  anchorCenter,
  triggerSelector,
  persistKey,
  closeLabel = "Close",
  "aria-label": ariaLabel,
}: TugPlacardProps): React.ReactElement | null {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const draggingRef = React.useRef(false);
  const dragStartXRef = React.useRef(0);
  const dragStartLeftRef = React.useRef(0);
  const travelRef = React.useRef(0);

  const persistedOffset = usePlacardOffset(reposition ? persistKey : undefined);
  const fraction = persistedOffset ?? DEFAULT_FRACTION;

  usePlacardAutoDismiss({ open, dismiss, panelRef, triggerSelector, onClose });

  // Initial placement + upward guard, reclamped on container resize / window
  // resize. The live drag writes `style.left` directly and must not be
  // clobbered mid-gesture, so the effect no-ops the placement while a drag is
  // in flight. Inline `left` survives a card-tab hide/refront (the node is
  // never unmounted), so this mostly fires on open and on resize.
  React.useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const apply = (): void => {
      if (!draggingRef.current) {
        applyPlacement(panel, { reposition, fraction, anchorCenter });
      }
      applyAvailableHeight(panel, growth, bottomBoundEl);
    };
    apply();

    const container = panel.offsetParent as HTMLElement | null;
    const onWindowResize = (): void => apply();
    window.addEventListener("resize", onWindowResize);
    let observer: ResizeObserver | undefined;
    if (container && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(apply);
      observer.observe(container);
    }
    return () => {
      window.removeEventListener("resize", onWindowResize);
      observer?.disconnect();
    };
  }, [open, reposition, fraction, anchorCenter, growth, bottomBoundEl, style]);

  function onHeaderPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    // A pointerdown on the close button must not begin a drag.
    if ((event.target as HTMLElement).closest("[data-placard-close]")) return;
    const panel = panelRef.current;
    if (!panel) return;

    event.preventDefault();
    const container = panel.offsetParent as HTMLElement | null;
    const containerWidth = container?.clientWidth ?? 0;
    travelRef.current = computeTravel(containerWidth, panel.offsetWidth);
    dragStartXRef.current = event.clientX;
    const currentLeft = Number.parseFloat(panel.style.left);
    dragStartLeftRef.current = Number.isFinite(currentLeft) ? currentLeft : DRAG_INSET;
    draggingRef.current = true;
    panel.dataset.dragging = "true";
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onHeaderPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return;
    const panel = panelRef.current;
    if (!panel) return;
    const delta = event.clientX - dragStartXRef.current;
    const left = Math.max(
      DRAG_INSET,
      Math.min(DRAG_INSET + travelRef.current, dragStartLeftRef.current + delta),
    );
    // Live gesture is DOM-only ([L06]).
    panel.style.left = `${left}px`;
  }

  function onHeaderPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const panel = panelRef.current;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!panel) return;
    delete panel.dataset.dragging;
    if (persistKey) {
      const left = Number.parseFloat(panel.style.left);
      const travel = travelRef.current;
      const committed = travel > 0 && Number.isFinite(left)
        ? (left - DRAG_INSET) / travel
        : DEFAULT_FRACTION;
      writePlacardOffset(persistKey, committed);
    }
  }

  if (!open) return null;

  // Drag handlers only when repositionable; a fixed placard's header is inert.
  const headerDragProps = reposition
    ? {
        onPointerDown: onHeaderPointerDown,
        onPointerMove: onHeaderPointerMove,
        onPointerUp: onHeaderPointerUp,
        onPointerCancel: onHeaderPointerUp,
      }
    : {};

  return (
    <div
      ref={panelRef}
      className={cn("tug-placard", className)}
      style={style}
      data-slot="tug-placard"
      // Which way the panel opens, for the caller's anchor rule and for the
      // enter animation, which travels away from the anchor either way ([L06]).
      data-growth={growth}
      // The placard is chrome; clicking it (drag, close, inner affordances)
      // must not pull first-responder focus off the card's editor.
      data-tug-focus="refuse"
      role="region"
      aria-label={ariaLabel}
    >
      <div
        className="tug-placard-header"
        data-slot="tug-placard-header"
        data-reposition={reposition ? "" : undefined}
        {...headerDragProps}
      >
        <span className="tug-placard-title">{title}</span>
        {dismiss === "explicit" ? (
          // The shared ghost/icon TugButton ([use-Tug-components]), absolutely
          // positioned by CSS so it never shifts the centered title.
          <TugButton
            subtype="icon"
            emphasis="ghost"
            role="action"
            size="sm"
            icon={<X />}
            className="tug-placard-close"
            data-placard-close=""
            data-tug-focus="refuse"
            tabIndex={-1}
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          />
        ) : null}
      </div>

      <div className="tug-placard-body" data-slot="tug-placard-body">
        {children}
      </div>
    </div>
  );
}

/**
 * use-miniature-gestures.ts — a hand on the Layout miniature's parts.
 *
 * The places overlay (`LayoutPlaces`) stands one invisible target over every
 * column block, every split member and every rail member of the drawing, and
 * calls `onTargetPointerDown` when a hand lands on one. This hook owns what
 * happens next. It is the half of the gesture with state and side effects; the
 * arithmetic of what a press reaches and where each drop zone stands in the
 * picture is `miniature-gestures.ts`, pure.
 *
 * **A release that has not travelled is a press** (Table T01): a block goes
 * to its slot through the card's own `goToSlot` — centred under flow, and its
 * front card raised and flashed in both layouts — and a member or a rail
 * member raises its own card and flashes its pane. Presses move activation to
 * the card they name, away from the Layout card.
 *
 * **A second press on a stacked slot cycles it.** "In succession" is tracked
 * as an `armed` record — which slot the last press reached and which pane it
 * raised there — and a store subscription disarms it the moment anything but
 * that pane or the Layout card's own pane becomes active. The Layout card is
 * excused because pressing anywhere in the card activates its pane first; no
 * timer is involved.
 *
 * **A hand that travels drags the card it names.** Past the travel threshold
 * the gesture asks the canvas's drop-zone host for the zones it would offer
 * that card's pane, places each on the part of the picture that draws its
 * place (`miniatureZoneRects`), and from then on picks among them in the
 * picture's own space. The canvas draws its outline for the zone picked, the
 * miniature draws the drag's ghost and offered place from the gauges this hook
 * publishes — in fractions of the drawing's padding box, the box both are
 * drawn in — and the release commits through the canvas's own `commit`. So a
 * drop from the picture can land exactly where a drop on the canvas could and
 * nowhere else. A drop rearranges and does not activate: the commit settles
 * the deck, and an activation inside that settle would be a second commit. A
 * refusal flashes the dragged card's pane, as the canvas's own does. Escape,
 * a cancel, and a lost capture retire the drag with nothing committed.
 *
 * Laws: [L03] the store subscription and its teardown are a layout effect;
 * [L06] the drag's appearance is DOM attributes and the gauge channel; [L07]
 * the gesture in flight and the armed record are refs, never state; [L30]
 * presses call `goToSlot`/`raiseCard` and drops call the host's `commit`
 * directly, the same calls the numbered strip and the pane chrome make — a
 * hand on the picture is not a user-invocable command.
 *
 * @module components/layout/use-miniature-gestures
 */

import type React from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

import {
  frontPaneOfSlot,
  MINIATURE_ZONE_HYSTERESIS_PX,
  miniatureZoneRects,
  stackPressCardId,
  type MiniatureTarget,
  type MiniatureZoneParts,
} from "@/components/layout/miniature-gestures";
import { deckFlowStrip } from "@/deck-store-selectors";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { raiseCard } from "@/focus-transfer";
import { getDeckStore } from "@/lib/deck-store-registry";
import { getDropZoneHost } from "@/lib/drop-zone-host-registry";
import {
  dropZoneKey,
  pickLiveZone,
  type DropZone,
  type DropZoneHost,
} from "@/lib/drop-zones";
import { flashCardPane } from "@/lib/flash-pane-border";
import {
  publishDragFrame,
  publishDragZone,
  type GaugeRect,
} from "@/lib/imposer-gauges";
import { flowCenterOffset, isSidebarSide } from "@/lib/layout-imposer";
import { DRAG_MOVE_THRESHOLD_PX } from "@/lib/press-travel";
import type { Rect } from "@/snap";

/** The card's `goToSlot`, with the option a block press passes. */
export type GoToSlot = (
  slot: number,
  center: number | null,
  options?: { raiseCardId?: string | null },
) => void;

/** The drawing's padding box, in client px. */
interface PadBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A drag in flight: everything latched when the hand crossed the threshold. */
interface Drag {
  host: DropZoneHost;
  paneId: string;
  /** The dragged pane's card, for a refusal's flash. */
  cardId: string;
  pad: PadBox;
  /** The zones as the picture places them, rects in padding-box px. */
  picks: readonly DropZone[];
  /** The canvas's own zone for each pick, by key — what the canvas outlines
   *  and commits. */
  canvasZones: ReadonlyMap<string, DropZone>;
  /** Where the dragged card stands now; a release there commits nothing. */
  originKey: string | null;
  live: DropZone | null;
  /** The target's own rect at the start, in padding-box px — the ghost. */
  startFrame: Rect;
  /** Removes the Escape listener. */
  detachKey: () => void;
}

/** One gesture in flight, from pointerdown to its retirement. */
interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  target: MiniatureTarget;
  element: HTMLElement;
  /** Past the travel threshold: the release is no longer a press. */
  travelled: boolean;
  /** The drag, once latched; null for a press, or for a travel that found
   *  nothing to drag (an empty slot, no host, no zones) — that gesture is
   *  inert and its release does nothing. */
  drag: Drag | null;
  /** Removes the listeners this gesture installed. */
  detach: () => void;
}

/**
 * Where the band would have to stand to centre `slot`, or `null` when there
 * is nowhere to travel (fit, or a strip nobody has measured) — the same answer
 * the numbered strip's press computes for the same slot.
 */
function centerOffsetFor(store: IDeckManagerStore, slot: number): number | null {
  const strip = deckFlowStrip(store.getSnapshot());
  const band = store.getBandWidth();
  if (strip === null || band === null || band <= 0) return null;
  const stripLeft = strip.positions.get(slot);
  if (stripLeft === undefined) return null;
  return flowCenterOffset({
    stripLeft,
    extent: strip.extents.get(slot) ?? 0,
    stripWidth: strip.width,
    band,
  });
}

/**
 * The overlay root's padding box in client px — which is the drawing's, since
 * the overlay restates `.layout-mini`'s box. The rect is scaled by however the
 * card is drawn, so the border is scaled by the same ratio.
 */
function padBoxOf(root: HTMLElement): PadBox | null {
  const rect = root.getBoundingClientRect();
  if (root.offsetWidth <= 0) return null;
  const scale = rect.width / root.offsetWidth;
  const width = root.clientWidth * scale;
  const height = root.clientHeight * scale;
  if (width <= 0 || height <= 0) return null;
  return {
    left: rect.left + root.clientLeft * scale,
    top: rect.top + root.clientTop * scale,
    width,
    height,
  };
}

function rectInPad(rect: DOMRect, pad: PadBox): Rect {
  return {
    x: rect.left - pad.left,
    y: rect.top - pad.top,
    width: rect.width,
    height: rect.height,
  };
}

/** The drawing's parts a zone can stand on: each slot's block, each drawn rail. */
function measureParts(root: HTMLElement, pad: PadBox): MiniatureZoneParts {
  const slots = new Map<number, Rect>();
  for (const el of root.querySelectorAll<HTMLElement>(
    ".layout-places-block[data-slot]",
  )) {
    const slot = Number(el.getAttribute("data-slot"));
    if (Number.isInteger(slot)) {
      slots.set(slot, rectInPad(el.getBoundingClientRect(), pad));
    }
  }
  const rails: MiniatureZoneParts["rails"] = {};
  for (const el of root.querySelectorAll<HTMLElement>(
    ".layout-places-rail[data-side]",
  )) {
    const side = el.getAttribute("data-side");
    if (isSidebarSide(side)) {
      rails[side] = rectInPad(el.getBoundingClientRect(), pad);
    }
  }
  return { slots, rails };
}

/** A padding-box rect as fractions of the padding box — the gauge's unit. */
function fractionOf(rect: Rect, pad: PadBox): GaugeRect {
  return {
    x: rect.x / pad.width,
    y: rect.y / pad.height,
    width: rect.width / pad.width,
    height: rect.height / pad.height,
  };
}

export function useMiniatureGestures({
  cardId,
  goToSlot,
}: {
  /** The Layout card's own id — its pane is excused from disarming. */
  cardId: string;
  goToSlot: GoToSlot;
}): {
  onTargetPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    target: MiniatureTarget,
  ) => void;
} {
  const gesture = useRef<Gesture | null>(null);
  const armed = useRef<{ slot: number; paneId: string } | null>(null);
  // Handlers bound once read the latest props through refs ([L07]).
  const latest = useRef({ cardId, goToSlot });
  useLayoutEffect(() => {
    latest.current = { cardId, goToSlot };
  });

  // [P04] — anything but the armed pane or this card's own pane becoming
  // active ends the succession.
  useLayoutEffect(() => {
    const store = getDeckStore();
    if (store === null) return;
    return store.subscribe(() => {
      const record = armed.current;
      if (record === null) return;
      const state = store.getSnapshot();
      const active = state.activePaneId;
      if (active === record.paneId) return;
      const own = state.panes.find((p) =>
        p.cardIds.includes(latest.current.cardId),
      );
      if (own !== undefined && active === own.id) return;
      armed.current = null;
    });
  }, []);

  /** Run the press a target names (Table T01). */
  const press = useCallback((target: MiniatureTarget): void => {
    const store = getDeckStore();
    if (store === null) return;
    if (target.kind === "block") {
      const state = store.getSnapshot();
      const record = armed.current;
      const raiseCardId = stackPressCardId(
        state,
        target.slot,
        record !== null && record.slot === target.slot ? record.paneId : null,
      );
      latest.current.goToSlot(
        target.slot,
        centerOffsetFor(store, target.slot),
        { raiseCardId },
      );
      const pane =
        raiseCardId === null
          ? undefined
          : store
              .getSnapshot()
              .panes.find((p) => p.cardIds.includes(raiseCardId));
      armed.current =
        pane === undefined ? null : { slot: target.slot, paneId: pane.id };
      return;
    }
    // A member or a rail member is one pane: raise its own card. Never cycles.
    armed.current = null;
    const pane = store
      .getSnapshot()
      .panes.find((p) => p.id === target.paneId);
    if (pane === undefined) return;
    raiseCard(store, pane.activeCardId);
    flashCardPane(store, pane.activeCardId);
  }, []);

  /** End the gesture, taking every drag affordance with it. Idempotent: it
   *  clears the ref before anything else, so the `lostpointercapture` that
   *  follows every release finds nothing, and so does a retire from unmount
   *  after the commit's re-render replaced the target. */
  const retire = useCallback((): void => {
    const current = gesture.current;
    if (current === null) return;
    gesture.current = null;
    current.detach();
    const drag = current.drag;
    if (drag !== null) {
      drag.detachKey();
      publishDragFrame(null);
      drag.host.outline(null);
      drag.host.carry(null);
      current.element.removeAttribute("data-drag-source");
    }
    if (current.element.hasPointerCapture(current.pointerId)) {
      current.element.releasePointerCapture(current.pointerId);
    }
  }, []);

  // A Layout card closed mid-gesture leaves nothing behind: no carrying
  // stamp, no canvas outline, no live gauge.
  useLayoutEffect(() => retire, [retire]);

  /** Move the indication to `zone` if it is not already there. */
  const indicate = useCallback((drag: Drag, zone: DropZone | null): void => {
    const key = zone === null ? null : dropZoneKey(zone);
    const was = drag.live === null ? null : dropZoneKey(drag.live);
    drag.live = zone;
    if (key === was) return;
    drag.host.outline(key === null ? null : (drag.canvasZones.get(key) ?? null));
    publishDragZone(zone === null ? null : fractionOf(zone.rect, drag.pad));
  }, []);

  /**
   * The hand crossed the threshold: find what it is dragging and where that
   * may land, or leave the gesture inert. Returns the drag, already showing.
   */
  const latch = useCallback(
    (current: Gesture): Drag | null => {
      const store = getDeckStore();
      const host = getDropZoneHost();
      if (store === null || host === null) return null;
      const state = store.getSnapshot();
      const target = current.target;
      const pane =
        target.kind === "block"
          ? frontPaneOfSlot(state, target.slot)
          : (state.panes.find((p) => p.id === target.paneId) ?? null);
      if (pane === null) return null;
      const set = host.enumerateRemote(pane.id);
      if (set.zones.length === 0) return null;
      const root = current.element.closest<HTMLElement>(".layout-places");
      if (root === null) return null;
      const pad = padBoxOf(root);
      if (pad === null) return null;
      const placed = miniatureZoneRects(set.zones, measureParts(root, pad));
      if (placed.length === 0) return null;

      const canvasZones = new Map<string, DropZone>();
      const picks = placed.map((m) => {
        canvasZones.set(dropZoneKey(m.zone), m.zone);
        return { ...m.zone, rect: m.rect, hit: undefined };
      });
      const originKey = set.origin === null ? null : dropZoneKey(set.origin);
      const onKey = (e: KeyboardEvent): void => {
        if (e.key !== "Escape") return;
        // Escape belongs to the drag while one is in the air.
        e.preventDefault();
        e.stopPropagation();
        retire();
      };
      window.addEventListener("keydown", onKey, true);
      const drag: Drag = {
        host,
        paneId: pane.id,
        cardId: pane.activeCardId,
        pad,
        picks,
        canvasZones,
        originKey,
        live: null,
        startFrame: rectInPad(current.element.getBoundingClientRect(), pad),
        detachKey: () => window.removeEventListener("keydown", onKey, true),
      };
      current.element.setAttribute("data-drag-source", "");
      host.carry(target.kind === "rail" ? "rail" : "card");
      publishDragFrame(fractionOf(drag.startFrame, pad));
      indicate(
        drag,
        picks.find((zone) => dropZoneKey(zone) === originKey) ?? null,
      );
      return drag;
    },
    [indicate, retire],
  );

  /** A latched move: re-pick the zone and move the ghost with the hand. */
  const follow = useCallback(
    (current: Gesture, drag: Drag, e: PointerEvent): void => {
      const pointer = {
        x: e.clientX - drag.pad.left,
        y: e.clientY - drag.pad.top,
      };
      indicate(
        drag,
        pickLiveZone(
          drag.picks,
          pointer,
          drag.live,
          MINIATURE_ZONE_HYSTERESIS_PX,
        ),
      );
      publishDragFrame(
        fractionOf(
          {
            ...drag.startFrame,
            x: drag.startFrame.x + (e.clientX - current.startX),
            y: drag.startFrame.y + (e.clientY - current.startY),
          },
          drag.pad,
        ),
      );
    },
    [indicate],
  );

  /** A latched release: commit the picked zone unless it is where the card
   *  already stands, and flash a refusal. */
  const drop = useCallback(
    (drag: Drag, e: PointerEvent): void => {
      const live = pickLiveZone(
        drag.picks,
        { x: e.clientX - drag.pad.left, y: e.clientY - drag.pad.top },
        drag.live,
        MINIATURE_ZONE_HYSTERESIS_PX,
      );
      if (live === null) return;
      const key = dropZoneKey(live);
      if (key === drag.originKey) return;
      const zone = drag.canvasZones.get(key);
      if (zone === undefined) return;
      if (!drag.host.commit(zone, drag.paneId)) {
        const store = getDeckStore();
        if (store !== null) flashCardPane(store, drag.cardId);
      }
    },
    [],
  );

  const onTargetPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, target: MiniatureTarget): void => {
      if (event.button !== 0) return;
      retire();
      const element = event.currentTarget;
      const pointerId = event.pointerId;
      const onMove = (e: PointerEvent): void => {
        const current = gesture.current;
        if (current === null || e.pointerId !== current.pointerId) return;
        if (!current.travelled) {
          if (
            Math.hypot(
              e.clientX - current.startX,
              e.clientY - current.startY,
            ) <= DRAG_MOVE_THRESHOLD_PX
          ) {
            return;
          }
          current.travelled = true;
          current.drag = latch(current);
        }
        if (current.drag !== null) follow(current, current.drag, e);
      };
      const onUp = (e: PointerEvent): void => {
        const current = gesture.current;
        if (current === null || e.pointerId !== current.pointerId) return;
        const { travelled, target: pressed, drag } = current;
        if (drag !== null) drop(drag, e);
        retire();
        if (!travelled) press(pressed);
      };
      const onCancel = (e: PointerEvent): void => {
        const current = gesture.current;
        if (current === null || e.pointerId !== current.pointerId) return;
        retire();
      };
      element.addEventListener("pointermove", onMove);
      element.addEventListener("pointerup", onUp);
      element.addEventListener("pointercancel", onCancel);
      element.addEventListener("lostpointercapture", onCancel);
      gesture.current = {
        pointerId,
        startX: event.clientX,
        startY: event.clientY,
        target,
        element,
        travelled: false,
        drag: null,
        detach: () => {
          element.removeEventListener("pointermove", onMove);
          element.removeEventListener("pointerup", onUp);
          element.removeEventListener("pointercancel", onCancel);
          element.removeEventListener("lostpointercapture", onCancel);
        },
      };
      element.setPointerCapture(pointerId);
    },
    [drop, follow, latch, press, retire],
  );

  return { onTargetPointerDown };
}

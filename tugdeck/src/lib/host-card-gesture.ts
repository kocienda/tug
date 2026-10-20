/**
 * host-card-gesture — the shell's half of a card drag or resize the host tracks.
 *
 * A card whose chrome is drawn in its own page starts its title-bar drag or
 * its grip resize by posting `cardGesture` to the host, and from then until
 * the mouse comes up the host moves the card's view on every mouse event and
 * reports each step here (`window.__tugBridge.onCardGesture`). The card is the
 * host's for the gesture's length; what is the shell's is everything the hand
 * means for the arrangement:
 *
 * - each `move` of a drag picks the drop zone the pointer asks for, from the
 *   zones the canvas enumerated at the first move, and indicates it — none
 *   while ⌘ frees the card;
 * - `end` commits, by the same decisions a drag the shell tracks ends by
 *   (`card-gesture-commit.ts`): a click activates the card, or with ⌘
 *   reveals its pane's stack in its own page; a zone drop commits the zone; a
 *   free drop merges onto the pane whose title band it was released over, or
 *   lands at the rect the host reported, already clamped and snapped;
 * - a resize's `end` writes the slot height, the slot-keeping width, or the
 *   free rect, as the pane's standing says;
 * - a flow card's right-edge resize moves every later slot with the hand
 *   while it holds: each report shifts the later stand-ins and the strip's
 *   length by the strip's own answer at the width the host reports
 *   (`openFlowFollow`), and the placer's wake on those writes carries their
 *   views, so the commit at the release lays out what the hand already
 *   showed. A cancel hands every stand-in back its own pin;
 * - a split column member's inner top or bottom edge is the seam it borders,
 *   so its resize drives the seam's own drag (`driveColumnSeam`), as a press
 *   on that edge in the shell hands the seam the pointer: each report moves
 *   the seam and the release commits the column's division;
 * - a rail's edge drag (`kind: "rail"`) is the rail's width draft: the host
 *   moves no view, and each report drives the driver the draft's owner
 *   hands this module for the rail's pane (`railEdgeDriverFor` in
 *   `rail-width-draft.ts`), which moves every member of the side and commits
 *   one width at the release;
 * - `cancel` takes the indication back and commits nothing.
 *
 * Rects and points arrive in the shell's viewport points and are taken into
 * the canvas's layout space, where the zones and the deck's geometry live.
 *
 * @module lib/host-card-gesture
 */

import { commandForCard } from "../bus/declarations/verbs";
import { getRegistration } from "../card-registry";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { Rect } from "../snap";
import { onHostMessage } from "../host/channel";
import { cardGestureToPage } from "../host/declarations/geometry";
import { TUG_ACTIONS } from "./action-vocabulary";
import {
  commitFreeMove,
  commitResizeEnd,
  commitZoneDrop,
  dragOutcomeOf,
  freeDropOutcomeOf,
  mergePaneInto,
  type ZoneDragState,
} from "./card-gesture-commit";
import { getDropZoneHost } from "./drop-zone-host-registry";
import { mergeBandOf, pickLiveZone, type DropZoneHost } from "./drop-zones";
import { flashCardPane } from "./flash-pane-border";
import { flowResizeShift, slotHeightAfterDrag } from "./keep-slot-resize";
import { FLOW_STRIP_PROPERTY } from "./layout-imposer";
import type { DeckState } from "../layout-tree";
import { pageZoomFactor } from "./page-zoom-store";
import { paneStandingOf } from "./pane-chrome-projection";
import { CANVAS_BACKGROUND_ATTRIBUTE, SHOWN_PANE_FRAMES } from "./pane-frame-selectors";
import type { ResizeEdge } from "../bus/declarations/pane";
import { landCard } from "./card-placement";
import { createDragAutoscroll, type DragAutoscroll } from "./drag-autoscroll";
import type { ColumnSeamGesture } from "../components/chrome/column-seam-drag";
import { overlaySurfaceBook } from "./overlay-surfaces";
import { indicate } from "./drag-indication";

/** One step of a gesture the host tracks, as it reports it (`onCardGesture`, decoded by its codec). */
export interface CardGestureReport {
  cardId: string;
  kind: "move" | "resize" | "rail";
  phase: "move" | "end" | "cancel";
  /** The pane's rect (not the apron) in viewport points, after this step. */
  rect: Rect;
  pointer: { x: number; y: number };
  /** Where the press landed, in viewport points. */
  start: { x: number; y: number };
  /** Whether the pointer has travelled past the move threshold. */
  moved: boolean;
  meta: boolean;
  alt: boolean;
  /** The edge or corner a resize is from. */
  edge?: ResizeEdge;
  /** The guides the host snapped this step to, viewport points; absent when it snapped to none. */
  snap?: { x: number | null; y: number | null };
}

/** Where the canvas stands in the viewport, and the page zoom its layout is at. */
export interface CanvasFrame {
  left: number;
  top: number;
  zoom: number;
}

/** The four calls of a rail width drag, addressed by viewport points. */
export interface RailEdgeDriver {
  /** The press, at the point it landed. */
  begin(clientX: number, clientY: number): void;
  change(clientX: number, clientY: number, altKey: boolean): void;
  commit(clientX: number, altKey: boolean): void;
  /** A no-op when no drag is open. */
  cancel(): void;
}

/** What the gesture reads beyond the deck. */
export interface HostGestureReaders {
  /** The canvas's frame, or null when the shell shows none. */
  canvas: () => CanvasFrame | null;
  /** The canvas's drop-zone host, or null. */
  zones: () => DropZoneHost | null;
  /** Every shown pane's rect, in the canvas's layout space. */
  paneRects: () => Map<string, Rect>;
  /** Show `cardId`'s pane's stack, in the page that draws its chrome. */
  revealStack: (cardId: string) => void;
  /** The rail width drag of the pinned rail `paneId`, or null. */
  railEdge: (paneId: string) => RailEdgeDriver | null;
  /** Column `slot`'s seam `index` dragging from a press at viewport `clientY`, or null. */
  columnSeam: (slot: number, index: number, clientY: number) => ColumnSeamGesture | null;
  /** Land the view of `cardId`, dropped, where its placement stands once the drop's commit is placed. */
  land: (cardId: string, paneRect: Rect) => void;
  /** Run `step` at the next frame: the autoscroll's clock while the hand holds. */
  requestFrame: (step: () => void) => void;
  /** The later slots of a flow deck following `paneId`'s right edge, or null when the deck is not in flow. */
  flowFollow: (state: DeckState, paneId: string) => FlowFollow | null;
}

/** A flow resize's later slots, moved with the hand while it holds the right edge. */
export interface FlowFollow {
  /** Stand the later slots where the strip puts them at `width`, layout px. */
  move(width: number): void;
  /** The release at `width`: the commit lays out what this leaves, and overwrites each moved pin. */
  release(width: number): void;
  /** Hand every stand-in back the pin it had, and the strip its length. */
  cancel(): void;
}

/**
 * The later slots of the flow deck `state` following `paneId`'s right edge,
 * by the stand-ins under `root`: each slotted frame other than the one in
 * hand, with the `left` its render gave it, and the element carrying the
 * strip's length the frames' offset clamp reads. Each `move` asks the deck's
 * one strip at the new width (`flowResizeShift`), so the frames it shifts are
 * the frames the canvas places once the width is in the store. Null when the
 * deck is not in flow.
 */
export function openFlowFollow(state: DeckState, paneId: string, root: ParentNode): FlowFollow | null {
  const pane = state.panes.find((p) => p.id === paneId);
  if (pane === undefined || flowResizeShift(state, paneId, pane.size.width) === null) return null;
  const frameOf = (id: string) => root.querySelector<HTMLElement>(`.tug-pane[data-pane-id="${id}"]`);
  const frames = new Map<string, { el: HTMLElement; left: string }>();
  for (const p of state.panes) {
    if (p.slot === undefined || p.id === paneId) continue;
    const el = frameOf(p.id);
    if (el !== null) frames.set(p.id, { el, left: el.style.left });
  }
  let stripHost = frameOf(paneId)?.parentElement ?? null;
  while (stripHost !== null && stripHost.style.getPropertyValue(FLOW_STRIP_PROPERTY) === "") {
    stripHost = stripHost.parentElement;
  }
  const stripStart = stripHost?.style.getPropertyValue(FLOW_STRIP_PROPERTY) ?? "";
  const move = (width: number): void => {
    const strip = flowResizeShift(state, paneId, width);
    if (strip === null) return;
    for (const [id, { el, left }] of frames) {
      const dx = strip.shifts.get(id) ?? 0;
      el.style.left = dx === 0 ? left : `calc(${left} + ${dx}px)`;
    }
    stripHost?.style.setProperty(FLOW_STRIP_PROPERTY, `${strip.stripWidth}px`);
  };
  return {
    move,
    release: move,
    cancel: () => {
      for (const { el, left } of frames.values()) el.style.left = left;
      if (stripHost !== null && stripStart !== "") stripHost.style.setProperty(FLOW_STRIP_PROPERTY, stripStart);
    },
  };
}

/**
 * The gesture's handler: one gesture at a time, its zone drag latched at the
 * first `move` that has travelled. Returned for `installHostCardGesture` and
 * for a reader that drives it with its own readers.
 */
export function createHostCardGesture(
  deck: IDeckManagerStore,
  readers: HostGestureReaders,
): (r: CardGestureReport) => void {
  let live: {
    cardId: string;
    paneId: string;
    zone: ZoneDragState | null;
    /** What the zones were enumerated from, so a scrolled strip re-enumerates against the same. */
    start: Rect;
    bands: Map<string, Rect>;
    autoscroll: DragAutoscroll;
    /** The hand and the pane in it, in the canvas's layout space, and whether ⌘ frees the card. */
    pointer: { x: number; y: number };
    rect: Rect;
    /** Which kind of card is in the air, for the places that show themselves to it. */
    carrying: "rail" | "card";
    meta: boolean;
    framePending: boolean;
    /** A flow resize's later slots, following the right edge; null for every other gesture. */
    follow: FlowFollow | null;
  } | null = null;

  const toCanvas = (canvas: CanvasFrame, p: { x: number; y: number }) => ({
    x: (p.x - canvas.left) / canvas.zoom,
    y: (p.y - canvas.top) / canvas.zoom,
  });
  const rectToCanvas = (canvas: CanvasFrame, r: Rect): Rect => ({
    ...toCanvas(canvas, r),
    width: r.width / canvas.zoom,
    height: r.height / canvas.zoom,
  });
  /** A rect in the canvas's layout space, in viewport points: what the overlay draws in. */
  const rectToViewport = (canvas: CanvasFrame, r: Rect): Rect => ({
    x: canvas.left + r.x * canvas.zoom,
    y: canvas.top + r.y * canvas.zoom,
    width: r.width * canvas.zoom,
    height: r.height * canvas.zoom,
  });
  /** The title band under `pointer` (canvas layout px) among `bands`, or null. */
  const bandUnder = (bands: Map<string, Rect>, pointer: { x: number; y: number }): Rect | null => {
    for (const band of bands.values()) {
      if (pointer.x >= band.x && pointer.x <= band.x + band.width && pointer.y >= band.y && pointer.y <= band.y + band.height) {
        return band;
      }
    }
    return null;
  };
  /**
   * Indicate the band a free drop would merge onto: a drag with no zones, or
   * one ⌘ frees, released over another pane's title merges there
   * ({@link endDrag}), so the band under the hand is the place it would go.
   */
  const indicateBand = (): void => {
    const canvas = readers.canvas();
    const free = live !== null && (live.meta || live.zone === null);
    const band = free && live !== null && canvas !== null ? bandUnder(live.bands, live.pointer) : null;
    indicate({ band: band === null || canvas === null ? null : rectToViewport(canvas, band) });
  };
  const paneOf = (cardId: string) => deck.getSnapshot().panes.find((p) => p.cardIds.includes(cardId));
  const roleOf = (paneId: string): "content" | "sidebar" => {
    const pane = deck.getSnapshot().panes.find((p) => p.id === paneId);
    const card = deck.getSnapshot().cards.find((c) => c.id === pane?.activeCardId);
    return card !== undefined && getRegistration(card.componentId)?.layoutRole === "sidebar" ? "sidebar" : "content";
  };
  const tabbed = (paneId: string): boolean =>
    (deck.getSnapshot().panes.find((p) => p.id === paneId)?.cardIds.length ?? 0) > 1;
  /** Every other pane's title band: where a card merges, and the tab bars a zone drag offers. */
  const bandsBesides = (paneId: string): Map<string, Rect> => {
    const bands = new Map<string, Rect>();
    for (const [id, rect] of readers.paneRects()) {
      if (id !== paneId) bands.set(id, mergeBandOf(rect, roleOf(id), tabbed(id)));
    }
    return bands;
  };

  /** Latch the drag at its first travelled move: a zone drag when the card has places, else free. */
  const begin = (r: CardGestureReport, canvas: CanvasFrame): void => {
    const pane = paneOf(r.cardId);
    if (pane === undefined) return;
    const host = readers.zones();
    let zone: ZoneDragState | null = null;
    // The places are measured from where the pane stood in the shell before
    // the hand took it, which the shell's frame still says.
    const start = readers.paneRects().get(pane.id) ?? rectToCanvas(canvas, r.rect);
    const bands = bandsBesides(pane.id);
    if (r.kind === "move" && host !== null) {
      const set = host.enumerate(pane.id, bands, start);
      if (set.origin !== null) zone = { zones: set.zones, live: set.origin, origin: set.origin };
    }
    const autoscroll = createDragAutoscroll({ host: readers.zones, paneId: pane.id, schedule: () => scheduleFrame() });
    const follow =
      r.kind === "resize" && r.edge === "e" && paneStandingOf(deck.getSnapshot(), pane.id).keepSlot?.layout === "flow"
        ? readers.flowFollow(deck.getSnapshot(), pane.id)
        : null;
    live = {
      cardId: r.cardId,
      paneId: pane.id,
      zone,
      start,
      bands,
      autoscroll,
      pointer: toCanvas(canvas, r.pointer),
      rect: rectToCanvas(canvas, r.rect),
      carrying: roleOf(pane.id) === "sidebar" ? "rail" : "card",
      meta: r.meta,
      framePending: false,
      follow,
    };
    if (zone !== null) host?.indicate(zone.live);
  };

  /**
   * One frame of a zone drag: advance a strip the hand holds at the edge of,
   * re-enumerate the places if it moved (every tile moved with it), and
   * indicate the zone the pointer asks for — none while ⌘ frees the card.
   * Run at every report and, while a strip is still advancing, on frames of
   * its own, since a held hand posts no moves.
   */
  const zoneFrame = (): void => {
    if (live === null) return;
    live.framePending = false;
    indicateBand();
    const zone = live.zone;
    if (zone === null) return;
    const host = readers.zones();
    host?.gaugeDragRect(live.rect, live.carrying);
    if (live.meta) {
      live.autoscroll.pause();
      zone.live = null;
      host?.indicate(null);
      return;
    }
    if (live.autoscroll.advance(live.pointer) && host !== null) {
      zone.zones = host.enumerate(live.paneId, live.bands, live.start).zones;
    }
    zone.live = pickLiveZone(zone.zones, live.pointer, zone.live);
    host?.indicate(zone.live);
  };
  const scheduleFrame = (): void => {
    if (live === null || live.framePending) return;
    live.framePending = true;
    readers.requestFrame(zoneFrame);
  };

  const endDrag = (r: CardGestureReport, canvas: CanvasFrame, paneId: string, zone: ZoneDragState | null): void => {
    const pointer = toCanvas(canvas, r.pointer);
    const outcome = dragOutcomeOf({ moved: r.moved, startedWithMeta: r.meta, metaAtRelease: r.meta, zone, pointer });
    if (outcome.kind === "click") {
      if (outcome.revealStack) readers.revealStack(r.cardId);
      else deck.activateCard(r.cardId);
      return;
    }
    if (outcome.kind === "zone-merge") {
      const target = deck.getSnapshot().panes.find((p) => p.id === outcome.zone.paneId);
      mergePaneInto(deck, paneId, outcome.zone.paneId, target?.cardIds.length ?? 0);
      return;
    }
    if (outcome.kind === "zone" || outcome.kind === "zone-home") {
      // The host carries the card home or into its place; the shell's
      // landing mark is not set, since no landing of the shell's clears it.
      const committed =
        outcome.kind === "zone" && commitZoneDrop(deck, readers.zones(), paneId, null, outcome.zone);
      if (!committed) flashCardPane(deck, r.cardId);
      return;
    }
    let mergeTarget: { paneId: string; insertIndex: number } | null = null;
    for (const [id, band] of bandsBesides(paneId)) {
      if (pointer.x >= band.x && pointer.x <= band.x + band.width && pointer.y >= band.y && pointer.y <= band.y + band.height) {
        const target = deck.getSnapshot().panes.find((p) => p.id === id);
        mergeTarget = { paneId: id, insertIndex: target?.cardIds.length ?? 0 };
        break;
      }
    }
    const rect = rectToCanvas(canvas, r.rect);
    const drop = freeDropOutcomeOf({
      mergeTarget,
      position: { x: rect.x, y: rect.y },
      // The host's rect is already clamped and snapped.
      snap: null,
      size: { width: rect.width, height: rect.height },
      derived: paneStandingOf(deck.getSnapshot(), paneId).derived,
    });
    if (drop.kind === "merge") mergePaneInto(deck, paneId, drop.targetPaneId, drop.insertIndex);
    else commitFreeMove(deck.handlePaneMoved, paneId, drop);
  };

  const endResize = (r: CardGestureReport, canvas: CanvasFrame, paneId: string): void => {
    if (!r.moved) return;
    const state = deck.getSnapshot();
    const pane = state.panes.find((p) => p.id === paneId);
    if (pane === undefined) return;
    const rect = rectToCanvas(canvas, r.rect);
    const standing = paneStandingOf(state, paneId);
    const start = { position: pane.position, size: pane.size };
    if (standing.keepSlot === null) {
      commitResizeEnd(deck.handlePaneMoved, paneId, start, { kind: "free", rect, evictSlot: standing.derived });
    } else if (r.edge === "s" && standing.keepSlot.heightHeld) {
      const run = deck.getColumnRunHeight() ?? Number.POSITIVE_INFINITY;
      commitResizeEnd(deck.handlePaneMoved, paneId, start, {
        kind: "height",
        slotHeight: slotHeightAfterDrag(rect.height, run),
      });
    } else {
      commitResizeEnd(deck.handlePaneMoved, paneId, start, { kind: "width", width: rect.width });
    }
  };

  /** The rail drag in hand: opened at its first travelled move, at the press point. */
  let rail: { cardId: string; driver: RailEdgeDriver } | null = null;
  const stepRail = (r: CardGestureReport): void => {
    if (rail !== null && rail.cardId !== r.cardId) return;
    if (r.phase === "move") {
      if (!r.moved) return;
      if (rail === null) {
        const paneId = paneOf(r.cardId)?.id;
        const driver = paneId === undefined ? null : readers.railEdge(paneId);
        if (driver === null) return;
        driver.begin(r.start.x, r.start.y);
        rail = { cardId: r.cardId, driver };
      }
      rail.driver.change(r.pointer.x, r.pointer.y, r.alt);
      return;
    }
    let held = rail;
    rail = null;
    // A release that travelled with no move reported before it is still a
    // drag: the draft opens at the press and commits at the release.
    if (held === null && r.phase === "end" && r.moved) {
      const paneId = paneOf(r.cardId)?.id;
      const driver = paneId === undefined ? null : readers.railEdge(paneId);
      if (driver !== null) {
        driver.begin(r.start.x, r.start.y);
        held = { cardId: r.cardId, driver };
      }
    }
    if (held === null) return;
    if (r.phase === "end" && r.moved) held.driver.commit(r.pointer.x, r.alt);
    else held.driver.cancel();
  };

  /** The seam a resize from `r`'s edge drives: a split member's inner top or bottom edge. */
  const seamOf = (r: CardGestureReport): { slot: number; index: number } | null => {
    if (r.edge !== "n" && r.edge !== "s") return null;
    const pane = paneOf(r.cardId);
    if (pane === undefined || pane.slot === undefined) return null;
    const column = paneStandingOf(deck.getSnapshot(), pane.id).keepSlot?.column;
    if (column === undefined) return null;
    const index = r.edge === "n" ? column.index - 1 : column.index;
    return index < 0 || index >= column.count - 1 ? null : { slot: pane.slot, index };
  };

  /** The seam drag in hand: opened at the first travelled report, at the press point. */
  let seam: { cardId: string; gesture: ColumnSeamGesture } | null = null;
  /** Drive a resize that is a seam's; false when `r` is no seam's and is the resize's own. */
  const stepSeam = (r: CardGestureReport): boolean => {
    if (seam !== null && seam.cardId !== r.cardId) return false;
    if (seam === null) {
      const at = seamOf(r);
      if (at === null) return false;
      if (r.phase === "cancel" || !r.moved) return true;
      const gesture = readers.columnSeam(at.slot, at.index, r.start.y);
      if (gesture === null) return true;
      seam = { cardId: r.cardId, gesture };
    }
    if (r.phase === "move") {
      seam.gesture.move(r.pointer.y);
      return true;
    }
    const held = seam;
    seam = null;
    if (r.phase === "end") {
      // The view the hand carried lands where the column's commit places
      // it, from where the hand let go: told before the commit, so the
      // commit's own plan carries it there.
      readers.land(r.cardId, r.rect);
      deck.batchGesture(() => held.gesture.release(r.pointer.y));
    } else {
      held.gesture.cancel();
    }
    return true;
  };

  return (r: CardGestureReport): void => {
    // The card is moving from its first travelled report to its release: its
    // overlay surface comes off for that span ([B07]).
    if (r.phase === "move") {
      if (r.moved) overlaySurfaceBook.hold(r.cardId, "gesture");
    } else {
      overlaySurfaceBook.release(r.cardId, "gesture");
    }
    // The guides the host snapped the step to, drawn in the overlay for the
    // length of the step ([B08]); none once the hand lets go.
    indicate({
      guides: r.phase === "move" && r.snap !== undefined ? { x: r.snap.x, y: r.snap.y } : { x: null, y: null },
    });
    if (r.kind === "rail") {
      stepRail(r);
      return;
    }
    if (r.kind === "resize" && stepSeam(r)) return;
    const canvas = readers.canvas();
    if (canvas === null) return;
    if (live !== null && live.cardId !== r.cardId) return;
    if (r.phase === "move") {
      if (!r.moved) return;
      if (live === null) begin(r, canvas);
      if (live === null) return;
      live.pointer = toCanvas(canvas, r.pointer);
      live.rect = rectToCanvas(canvas, r.rect);
      live.meta = r.meta;
      live.follow?.move(live.rect.width);
      zoneFrame();
      return;
    }
    const held = live;
    live = null;
    readers.zones()?.indicate(null);
    indicate({ band: null });
    if (held?.zone != null) readers.zones()?.gaugeDragRect(null, held.carrying);
    if (r.phase === "cancel") {
      held?.follow?.cancel();
      // The strips the hand scrolled stay where it took them: real state,
      // committed though the card goes home.
      deck.batchGesture(() => held?.autoscroll.commit());
      return;
    }
    const paneId = held?.paneId ?? paneOf(r.cardId)?.id;
    if (paneId === undefined) return;
    held?.follow?.release(rectToCanvas(canvas, r.rect).width);
    // The view the hand carried lands where its placement stands once the
    // commit's own placement is posted, from where the hand let go: a plan
    // from the released rect to the pane's, posted by the commit's settle or
    // by the measurement after it, so a drop that moved nothing — home, a
    // refusal — lands too. Told before the commit, so the commit's plan sees
    // the released rect ([B11]).
    if (r.moved) readers.land(r.cardId, r.rect);
    deck.batchGesture(() => {
      // Ahead of the drop, so the settle that lands the card is the
      // arrangement change's rather than the offset's.
      held?.autoscroll.commit();
      if (r.kind === "resize") endResize(r, canvas, paneId);
      else endDrag(r, canvas, paneId, held?.zone ?? null);
    });
  };
}

/** The canvas and the shown panes as the shell's document has them. */
const DOCUMENT_READERS: Omit<HostGestureReaders, "railEdge" | "columnSeam"> = {
  canvas: () => {
    const el = document.querySelector<HTMLElement>(`[${CANVAS_BACKGROUND_ATTRIBUTE}]`);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, zoom: pageZoomFactor() };
  },
  zones: getDropZoneHost,
  paneRects: () => {
    const rects = new Map<string, Rect>();
    const canvas = DOCUMENT_READERS.canvas();
    if (canvas === null) return rects;
    for (const el of document.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
      const id = el.dataset.paneId;
      if (id === undefined) continue;
      const r = el.getBoundingClientRect();
      rects.set(id, {
        x: (r.left - canvas.left) / canvas.zoom,
        y: (r.top - canvas.top) / canvas.zoom,
        width: r.width / canvas.zoom,
        height: r.height / canvas.zoom,
      });
    }
    return rects;
  },
  revealStack: (cardId) => commandForCard.dispatch({ id: TUG_ACTIONS.REVEAL_STACK }, { card: cardId }),
  land: landCard,
  requestFrame: (step) => {
    requestAnimationFrame(step);
  },
  flowFollow: (state, paneId) => openFlowFollow(state, paneId, document),
};

/**
 * Take the host's gesture reports in this page: `window.__tugBridge.onCardGesture`.
 * `readers.railEdge` is the rail width draft's, and `readers.columnSeam` the
 * canvas's seams', which their owner supplies.
 */
export function installHostCardGesture(
  deck: IDeckManagerStore,
  readers: Pick<HostGestureReaders, "railEdge" | "columnSeam">,
): () => void {
  return onHostMessage(cardGestureToPage, createHostCardGesture(deck, { ...DOCUMENT_READERS, ...readers }));
}

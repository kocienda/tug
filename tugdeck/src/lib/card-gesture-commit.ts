/**
 * card-gesture-commit — how a pane drag or a pane resize ends.
 *
 * A drag ends one of five ways, read off the release: a click (the pointer
 * never travelled; with ⌘ held it reveals the pane's stack), a zone drop (the
 * place the indicator showed, re-picked at the release point), a merge onto
 * the tab bar a zone named, a refused zone drop that goes home, or a free
 * drop — which may itself merge onto a pane's title band, or else commits the
 * clamped and snapped rect. A resize ends by writing a slot height, a
 * slot-keeping width, or a free rect.
 *
 * The decisions are pure functions over what the gesture read, and the
 * commits are the deck calls each ending makes. `TugPane`'s own pointer-up
 * runs them for a drag the shell tracks, beside the DOM work only it has (the
 * frame's transform, the landing animation, the tab-bar insert index), and
 * `host-card-gesture.ts` runs the same ones for a drag the host tracks, so the
 * two cannot end one gesture differently.
 *
 * @module lib/card-gesture-commit
 */

import type { IDeckManagerStore, MovePaneOptions } from "../deck-manager-store";
import type { Rect, SnapResult } from "../snap";
import { dropZoneKey, pickLiveZone, type DropZone, type DropZoneHost } from "./drop-zones";

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/** The deck's move, as `DeckCanvas` hands it to a pane (`handlePaneMoved`). */
export type MovePane = (paneId: string, position: Point, size: Size, opts?: MovePaneOptions) => void;

/** A zone drag's state at the release: the zones it enumerated, the one indicated last, and the card's own. */
export interface ZoneDragState {
  zones: readonly DropZone[];
  live: DropZone | null;
  origin: DropZone | null;
}

/** What a drag's release reads to decide how it ends. */
export interface DragRelease {
  /** Whether the pointer travelled past the move threshold. */
  moved: boolean;
  /** Whether ⌘ was held when the press began. */
  startedWithMeta: boolean;
  /** Whether ⌘ is held at the release: it frees the card from its zones. */
  metaAtRelease: boolean;
  /** The zone drag the gesture latched, or null for a free drag. */
  zone: ZoneDragState | null;
  /** The release point, in the canvas's coordinates. */
  pointer: Point;
}

/** How a drag ends, before any free drop's details are read. */
export type DragOutcome =
  /** No travel: nothing moves; with ⌘ held at the press, the pane's stack is revealed. */
  | { kind: "click"; revealStack: boolean }
  /** A zone drop onto `zone`; `onOrigin` when it is the card's own place, which commits nothing. */
  | { kind: "zone"; zone: DropZone; onOrigin: boolean }
  /** The zone the release asks for is a pane's tab bar: the card merges into that pane. */
  | { kind: "zone-merge"; zone: DropZone & { kind: "tab-bar" } }
  /** A zone drag with no zone to take it: the card goes home. */
  | { kind: "zone-home" }
  /** A free drop, or a zone drag freed by ⌘ at the release. */
  | { kind: "free"; freedFromZone: boolean };

/**
 * How a drag ends. A zone drag re-picks its zone from the release point
 * rather than reading the last frame's, with the same incumbent and the same
 * hysteresis, so the indicator and the outcome cannot disagree at the moment
 * they must not.
 */
export function dragOutcomeOf(release: DragRelease): DragOutcome {
  if (!release.moved) return { kind: "click", revealStack: release.startedWithMeta };
  const zone = release.zone;
  if (zone === null) return { kind: "free", freedFromZone: false };
  if (release.metaAtRelease) return { kind: "free", freedFromZone: true };
  const live = pickLiveZone(zone.zones, release.pointer, zone.live);
  if (live === null) return { kind: "zone-home" };
  if (live.kind === "tab-bar") return { kind: "zone-merge", zone: live };
  return { kind: "zone", zone: live, onOrigin: zone.origin !== null && dropZoneKey(live) === dropZoneKey(zone.origin) };
}

/** What a free drop reads once the card is free: a merge target under the pointer, and the rect it would land at. */
export interface FreeDropRelease {
  /** The pane whose tab bar or title band the pointer is over, and where the card would go in it. */
  mergeTarget: { paneId: string; insertIndex: number } | null;
  /** The clamped position the pointer asks for. */
  position: Point;
  /** The snap the last frame computed with Option held, or null. */
  snap: Pick<SnapResult, "x" | "y"> | null;
  size: Size;
  /** Whether the pane's geometry was derived — slotted, pinned or bullseyed — so the drop evicts it. */
  derived: boolean;
}

/** How a free drop ends. */
export type FreeDropOutcome =
  | { kind: "merge"; targetPaneId: string; insertIndex: number }
  | { kind: "move"; position: Point; size: Size; evictSlot: boolean };

/** A free drop merges onto the pane under the pointer, or else lands at its snapped position. */
export function freeDropOutcomeOf(release: FreeDropRelease): FreeDropOutcome {
  if (release.mergeTarget !== null) {
    return { kind: "merge", targetPaneId: release.mergeTarget.paneId, insertIndex: release.mergeTarget.insertIndex };
  }
  const snap = release.snap;
  return {
    kind: "move",
    position: {
      x: snap !== null && snap.x !== null ? snap.x : release.position.x,
      y: snap !== null && snap.y !== null ? snap.y : release.position.y,
    },
    size: release.size,
    evictSlot: release.derived,
  };
}

/**
 * Commit a zone drop of `paneId` onto `zone` through the canvas's host. When
 * the drop has a landing to run, `landingCardId` names its card and the
 * landing mark goes on first, so the reveal the commit schedules waits for the
 * landing as well as for the settle; null for a drop with no landing of the
 * shell's to clear the mark. False is a refusal: no host, or the host would
 * not take it.
 */
export function commitZoneDrop(
  deck: Pick<IDeckManagerStore, "noteCardWillLand">,
  host: Pick<DropZoneHost, "commit"> | null,
  paneId: string,
  landingCardId: string | null,
  zone: DropZone,
): boolean {
  if (landingCardId !== null) deck.noteCardWillLand(landingCardId);
  return host !== null && host.commit(zone, paneId);
}

/** Merge `sourcePaneId`'s active card into `targetPaneId` at `insertIndex`. */
export function mergePaneInto(
  deck: Pick<IDeckManagerStore, "getSnapshot" | "moveCardToPane">,
  sourcePaneId: string,
  targetPaneId: string,
  insertIndex: number,
): void {
  const source = deck.getSnapshot().panes.find((p) => p.id === sourcePaneId);
  if (source === undefined) return;
  deck.moveCardToPane(sourcePaneId, source.activeCardId, targetPaneId, insertIndex);
}

/** Commit a free drop's move: the dropped rect becomes the pane's free geometry, evicting a derived pane. */
export function commitFreeMove(move: MovePane, paneId: string, outcome: FreeDropOutcome & { kind: "move" }): void {
  move(paneId, outcome.position, outcome.size, outcome.evictSlot ? { evictSlot: true } : undefined);
}

/** How a resize ends. */
export type ResizeRelease =
  /** A slot-keeping height: `slotHeight` null fills the run again. */
  | { kind: "height"; slotHeight: number | null }
  /** A slot-keeping width, in fit or flow. */
  | { kind: "width"; width: number }
  /** A released resize: the rect is the pane's free geometry, evicting it when it was derived. */
  | { kind: "free"; rect: Rect; evictSlot: boolean };

/**
 * Commit a resize's end. A slot-keeping end writes the height or width
 * alone, at the stored position, which an imposed frame does not read; a
 * released one writes the whole rect.
 */
export function commitResizeEnd(
  move: MovePane,
  paneId: string,
  start: { position: Point; size: Size },
  release: ResizeRelease,
): void {
  const position = { x: start.position.x, y: start.position.y };
  switch (release.kind) {
    case "height":
      move(
        paneId,
        position,
        { width: start.size.width, height: release.slotHeight ?? start.size.height },
        { slotHeight: release.slotHeight },
      );
      return;
    case "width":
      move(paneId, position, { width: release.width, height: start.size.height });
      return;
    case "free":
      move(
        paneId,
        { x: release.rect.x, y: release.rect.y },
        { width: release.rect.width, height: release.rect.height },
        release.evictSlot ? { evictSlot: true } : undefined,
      );
  }
}

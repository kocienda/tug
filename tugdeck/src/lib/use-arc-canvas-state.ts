/**
 * use-arc-canvas-state.ts — one arc's remembered canvas: where its four cards
 * stand and which are open.
 *
 * Kept per arc, keyed by the arc's name, in tugbank's
 * `dev.tugapp.arc-canvas` domain — the defaults path every card-level
 * setting takes (`useTugbankValue` to read, an optimistic cache write plus a
 * PUT to write), so the canvas comes back as it was left across a lowered
 * shade, a closed card and a relaunch. The shape and its parser are in
 * `arc-canvas-geometry.ts`.
 *
 * Laws: [L02] the tugbank cache enters React through `useTugbankValue`.
 *
 * @module lib/use-arc-canvas-state
 */

import {
  ARC_CANVAS_DOMAIN,
  arcCanvasDefaultState,
  arcCanvasHomePositions,
  parseArcCanvasState,
  type ArcCanvasState,
} from "@/lib/arc-canvas-geometry";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { putCardSettings } from "@/settings-api";

/** The canvas an arc with nothing remembered opens on. One object, so the snapshot is stable. */
const FRESH: ArcCanvasState = arcCanvasDefaultState();

/** The arc's remembered canvas as it is right now, read outside React. */
export function readArcCanvasState(arcName: string): ArcCanvasState {
  return parseArcCanvasState(getTugbankClient()?.get(ARC_CANVAS_DOMAIN, arcName)) ?? FRESH;
}

/**
 * Remember an arc's canvas: an optimistic write to the local cache, so every
 * reader re-renders at once, and the PUT that makes it last.
 */
export function writeArcCanvasState(arcName: string, state: ArcCanvasState): void {
  getTugbankClient()?.setLocalValue(ARC_CANVAS_DOMAIN, arcName, { kind: "json", value: state });
  putCardSettings(ARC_CANVAS_DOMAIN, arcName, state);
}

/** Send an arc's four cards home. Which are open is left as it is. */
export function tidyArcCanvas(arcName: string): void {
  writeArcCanvasState(arcName, {
    positions: arcCanvasHomePositions(),
    expanded: readArcCanvasState(arcName).expanded,
  });
}

/** An arc's remembered canvas, or the fresh one when nothing is remembered. */
export function useArcCanvasState(arcName: string): ArcCanvasState {
  return useTugbankValue<ArcCanvasState | null>(ARC_CANVAS_DOMAIN, arcName, parseArcCanvasState, null) ?? FRESH;
}

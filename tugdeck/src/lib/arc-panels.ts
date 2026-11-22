/**
 * arc-panels.ts — the arc shade's three panels as data: their order, and what
 * each panel's state says about its progress dot and the seams between
 * panels.
 *
 * Pure: no DOM, no store. `SessionArcPanels` draws what these return.
 *
 * @module lib/arc-panels
 */

/** The three panels, in reading order: the full top row, then bottom-left and bottom-right. */
export const ARC_PANEL_RUNGS = ["sketch", "brief", "arc"] as const;

export type ArcPanelRung = (typeof ARC_PANEL_RUNGS)[number];

/**
 * Where a rung is: `done` is settled, `active` is where the work is, and
 * `pending` is a seat nothing fills yet.
 */
export type ArcPanelState = "done" | "active" | "pending";

/** A seam between two panels: the later rung was made from the earlier, or not yet. */
export type ArcPanelSeamState = "linked" | "pending";

/** The poses a panel's progress dot takes. */
export type ArcPanelDotState = "completed" | "running" | "paused" | "stopped";

/** Every panel's state, by rung. */
export type ArcPanelStates = Readonly<Record<ArcPanelRung, ArcPanelState>>;

/**
 * The progress dot's pose. A settled rung is complete and an empty seat is
 * still. The rung the work is at pulses, unless the work is stopped, where it
 * holds its pose.
 */
export function arcPanelDotState(state: ArcPanelState, paused: boolean): ArcPanelDotState {
  if (state === "done") return "completed";
  if (state === "pending") return "stopped";
  return paused ? "paused" : "running";
}

/**
 * The two seams, in order: Sketch to Brief, Brief to Arc.
 * A seam is joined once there is something on both sides of it.
 */
export function arcPanelSeamStates(
  states: ArcPanelStates,
): readonly [ArcPanelSeamState, ArcPanelSeamState] {
  const seam = (from: ArcPanelRung, to: ArcPanelRung): ArcPanelSeamState =>
    states[from] !== "pending" && states[to] !== "pending" ? "linked" : "pending";
  return [seam("sketch", "brief"), seam("brief", "arc")];
}

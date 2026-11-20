import { describe, expect, test } from "bun:test";

import {
  ARC_PANEL_RUNGS,
  arcPanelDotState,
  arcPanelRestingFocus,
  arcPanelSeamStates,
  type ArcPanelStates,
} from "../arc-panels";

const states = (idea: string, sketch: string, brief: string, arc: string): ArcPanelStates =>
  ({ idea, sketch, brief, arc }) as ArcPanelStates;

describe("arc panels", () => {
  test("the panels read idea, sketch, brief, arc", () => {
    expect([...ARC_PANEL_RUNGS]).toEqual(["idea", "sketch", "brief", "arc"]);
  });

  test("a settled rung's dot is complete and an empty seat's is still", () => {
    expect(arcPanelDotState("done", false)).toBe("completed");
    expect(arcPanelDotState("pending", false)).toBe("stopped");
    // Stopped work changes neither: only the live rung holds a pose.
    expect(arcPanelDotState("done", true)).toBe("completed");
    expect(arcPanelDotState("pending", true)).toBe("stopped");
  });

  test("the active rung's dot pulses, and holds when the work is stopped", () => {
    expect(arcPanelDotState("active", false)).toBe("running");
    expect(arcPanelDotState("active", true)).toBe("paused");
  });

  test("a seam is joined only with something on both sides", () => {
    // An arc cut from its brief, with no idea or sketch recorded.
    expect(arcPanelSeamStates(states("pending", "pending", "done", "active"))).toEqual([
      "pending",
      "pending",
      "linked",
    ]);
    // An arc with no brief joins nothing.
    expect(arcPanelSeamStates(states("pending", "pending", "pending", "active"))).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    // Every rung recorded, and the arc finished.
    expect(arcPanelSeamStates(states("done", "done", "done", "done"))).toEqual(["linked", "linked", "linked"]);
    // The work is at the sketch: the seam into it is joined, the one out is not.
    expect(arcPanelSeamStates(states("done", "active", "pending", "pending"))).toEqual([
      "linked",
      "pending",
      "pending",
    ]);
  });

  test("the resting focus is the rung the work is at", () => {
    expect(arcPanelRestingFocus(states("pending", "pending", "done", "active"))).toBe("arc");
    expect(arcPanelRestingFocus(states("done", "active", "pending", "pending"))).toBe("sketch");
  });

  test("with no active rung the resting focus is the furthest settled one", () => {
    expect(arcPanelRestingFocus(states("pending", "pending", "done", "done"))).toBe("arc");
    expect(arcPanelRestingFocus(states("done", "done", "pending", "pending"))).toBe("sketch");
    expect(arcPanelRestingFocus(states("pending", "pending", "pending", "pending"))).toBe("idea");
  });
});

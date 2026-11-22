import { describe, expect, test } from "bun:test";

import {
  ARC_PANEL_RUNGS,
  arcPanelDotState,
  arcPanelSeamStates,
  type ArcPanelStates,
} from "../arc-panels";

const states = (sketch: string, brief: string, arc: string): ArcPanelStates =>
  ({ sketch, brief, arc }) as ArcPanelStates;

describe("arc panels", () => {
  test("the panels read sketch, brief, arc", () => {
    expect([...ARC_PANEL_RUNGS]).toEqual(["sketch", "brief", "arc"]);
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
    // An arc cut from its brief, with no sketch recorded.
    expect(arcPanelSeamStates(states("pending", "done", "active"))).toEqual(["pending", "linked"]);
    // An arc with no brief joins nothing.
    expect(arcPanelSeamStates(states("pending", "pending", "active"))).toEqual(["pending", "pending"]);
    // Every rung recorded, and the arc finished.
    expect(arcPanelSeamStates(states("done", "done", "done"))).toEqual(["linked", "linked"]);
    // A sketch and a brief, and the arc not yet cut: only the first seam is joined.
    expect(arcPanelSeamStates(states("done", "active", "pending"))).toEqual(["linked", "pending"]);
  });
});

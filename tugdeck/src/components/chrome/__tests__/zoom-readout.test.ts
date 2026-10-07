/**
 * zoom-readout — the number it names and the states it moves through over a
 * zoom's notices. The DOM writes and the paint are the app-test's (at0710).
 */

import { describe, expect, test } from "bun:test";

import {
  nextZoomReadoutState,
  zoomReadoutText,
} from "../zoom-readout";

describe("zoomReadoutText", () => {
  test("names the factor as a whole percentage", () => {
    expect(zoomReadoutText(0.9)).toBe("90%");
    expect(zoomReadoutText(0.5)).toBe("50%");
    expect(zoomReadoutText(2)).toBe("200%");
    expect(zoomReadoutText(1.1)).toBe("110%");
  });
});

describe("nextZoomReadoutState", () => {
  test("the factor reported at boot shows nothing", () => {
    expect(nextZoomReadoutState("hidden", { factor: 1, phase: "settled" })).toBe("hidden");
  });

  test("before shows it; after lets it go", () => {
    const shown = nextZoomReadoutState("hidden", { factor: 0.9, phase: "zooming" });
    expect(shown).toBe("shown");
    expect(nextZoomReadoutState(shown, { factor: 0.9, phase: "settled" })).toBe("leaving");
  });

  test("a second step while leaving raises it again", () => {
    expect(nextZoomReadoutState("leaving", { factor: 0.8, phase: "zooming" })).toBe("shown");
  });

  test("a zoom with no factor shows nothing", () => {
    expect(nextZoomReadoutState("hidden", { factor: null, phase: "zooming" })).toBe("hidden");
  });
});

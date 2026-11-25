/**
 * The arc and sketch atom shapes: how a value's two halves are read apart.
 */

import { describe, expect, test } from "bun:test";

import {
  arcAtomName,
  arcAtomProject,
  isArcAtomType,
  isSketchAtomType,
  projectLeafOf,
  sketchAtomLabel,
} from "../record-atom-shape";

describe("record atom shape", () => {
  test("an arc value splits into its project and its name", () => {
    expect(arcAtomName("tug/parser")).toBe("parser");
    expect(arcAtomProject("tug/parser")).toBe("tug");
  });

  test("a value with no `/` is a bare name with no project", () => {
    expect(arcAtomName("parser")).toBe("parser");
    expect(arcAtomProject("parser")).toBeNull();
  });

  test("the types and the sketch label", () => {
    expect(isArcAtomType("arc")).toBe(true);
    expect(isArcAtomType("session")).toBe(false);
    expect(isSketchAtomType("sketch")).toBe(true);
    expect(sketchAtomLabel("0a1b2c3d")).toBe("sketch:0a1b2c3d");
  });

  test("a directory's leaf ignores a trailing slash", () => {
    expect(projectLeafOf("/u/src/tug/")).toBe("tug");
    expect(projectLeafOf("/u/src/tug")).toBe("tug");
  });
});

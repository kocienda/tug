/**
 * The arc, sketch, docket and idea atom shapes: how a value's two halves are read
 * apart, and what each is labelled and copied as.
 */

import { describe, expect, test } from "bun:test";

import {
  arcAtomName,
  arcAtomProject,
  docketAtomLabel,
  docketPlainText,
  IDEA_LABEL_LIMIT,
  ideaAtomLabel,
  ideaPlainText,
  isArcAtomType,
  isDocketAtomType,
  isIdeaAtomType,
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

  test("a docket is labelled by its name and copied as its id", () => {
    expect(isDocketAtomType("docket")).toBe(true);
    expect(isDocketAtomType("sketch")).toBe(false);
    expect(docketAtomLabel("3f9a1c2e", "GPU wedge")).toBe("GPU wedge");
    expect(docketAtomLabel("3f9a1c2e")).toBe("docket:3f9a1c2e");
    expect(docketAtomLabel("3f9a1c2e", "")).toBe("docket:3f9a1c2e");
    expect(docketPlainText("3f9a1c2e")).toBe("docket:3f9a1c2e");
  });

  test("an idea is labelled by its line, cut to the limit, and copied as its id", () => {
    expect(isIdeaAtomType("idea")).toBe(true);
    expect(isIdeaAtomType("docket")).toBe(false);
    expect(ideaAtomLabel("1a2b3c4d", "  An inbox  ")).toBe("An inbox");
    expect(ideaAtomLabel("1a2b3c4d")).toBe("idea:1a2b3c4d");
    expect(ideaAtomLabel("1a2b3c4d", " ")).toBe("idea:1a2b3c4d");
    const exact = "y".repeat(IDEA_LABEL_LIMIT);
    expect(ideaAtomLabel("1a2b3c4d", exact)).toBe(exact);
    const cut = ideaAtomLabel("1a2b3c4d", `${"y".repeat(IDEA_LABEL_LIMIT)}z`);
    expect(Array.from(cut).length).toBe(IDEA_LABEL_LIMIT);
    expect(cut.endsWith("…")).toBe(true);
    expect(ideaPlainText("1a2b3c4d")).toBe("idea:1a2b3c4d");
  });

  test("a directory's leaf ignores a trailing slash", () => {
    expect(projectLeafOf("/u/src/tug/")).toBe("tug");
    expect(projectLeafOf("/u/src/tug")).toBe("tug");
  });
});

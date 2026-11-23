/**
 * sketch-ref-block.test.ts — the trailing block that resolves a message's
 * sketch references: each verdict's line for the model, and a parse that
 * recovers the owning checkout for a replay.
 */

import { describe, expect, test } from "bun:test";

import {
  SKETCH_REFS_MARKER,
  buildSketchRefBlock,
  isSketchRefBlock,
  parseSketchRefBlock,
} from "@/lib/sketch-ref-block";

const HEADING =
  "Sketch references in this message (read one with the command shown; do not guess at what a reference means):";
const DIR = "/Users/k/src/tug";

describe("buildSketchRefBlock", () => {
  test("no entries is no block, not an empty one", () => {
    expect(buildSketchRefBlock([])).toBeNull();
  });

  test("a here sketch names its project, arc and versions, and the read", () => {
    const block = buildSketchRefBlock([
      { value: "3f9a1c2e", verdict: "here", projectDir: DIR, arc: "gpu-wedge", versions: 3 },
    ]);
    expect(block).toBe(
      `${SKETCH_REFS_MARKER}\n${HEADING}\n`
      + `- @sketch:3f9a1c2e — project ${DIR}, arc gpu-wedge, versions 3, verdict: here — read: tugtool sketch show 3f9a1c2e`,
    );
  });

  test("a sketch with no arc leaves the arc out", () => {
    const block = buildSketchRefBlock([
      { value: "3f9a1c2e", verdict: "elsewhere", projectDir: DIR, versions: 1 },
    ]);
    expect(block).toContain(
      `- @sketch:3f9a1c2e — project ${DIR}, versions 1, verdict: elsewhere — read: tugtool sketch show 3f9a1c2e`,
    );
  });

  test("absent says so plainly and offers no read", () => {
    const block = buildSketchRefBlock([{ value: "00ff00ff", verdict: "absent" }]);
    expect(block).toContain("- @sketch:00ff00ff — verdict: absent — this sketch is not on this machine");
    expect(block).not.toContain("sketch show");
  });

  test("unverified names the command that settles it", () => {
    const block = buildSketchRefBlock([{ value: "12ab34cd", verdict: "unverified" }]);
    expect(block).toContain(
      "- @sketch:12ab34cd — verdict: unverified — check: tugtool sketch show 12ab34cd",
    );
  });
});

describe("parseSketchRefBlock", () => {
  test("recovers value, project and verdict from a built block", () => {
    const block = buildSketchRefBlock([
      { value: "3f9a1c2e", verdict: "here", projectDir: DIR, arc: "gpu-wedge", versions: 3 },
      { value: "4a4a4a4a", verdict: "elsewhere", projectDir: "/u/a, b", versions: 2 },
      { value: "00ff00ff", verdict: "absent" },
    ]);
    expect(parseSketchRefBlock(block ?? "")).toEqual([
      { value: "3f9a1c2e", projectDir: DIR, verdict: "here" },
      { value: "4a4a4a4a", projectDir: "/u/a, b", verdict: "elsewhere" },
    ]);
  });

  test("a text that is not the block parses to nothing", () => {
    expect(isSketchRefBlock("hello")).toBe(false);
    expect(parseSketchRefBlock("- @sketch:3f9a1c2e — project /x, verdict: here")).toEqual([]);
  });
});

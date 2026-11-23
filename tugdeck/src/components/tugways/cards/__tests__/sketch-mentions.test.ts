/**
 * The sketch mention provider's rows: each searched sketch mints the sketch
 * atom, labelled `sketch:<id>`, with its want as the description.
 */

import { describe, expect, test } from "bun:test";

import { sketchMentionItem } from "../completion-providers/sketch-mentions";
import type { SearchedSketch } from "@/protocol";

const ROW: SearchedSketch = {
  id: "0a1b2c3d",
  arc: { name: "drawn", created: null },
  want: "Want the atoms.",
  updated: "2026-10-01T00:00:01Z",
};

describe("the sketch provider's rows", () => {
  test("a row mints a sketch atom owned by the composer's checkout", () => {
    const item = sketchMentionItem(ROW, "", "/u/src/tug");
    expect(item.label).toBe("sketch:0a1b2c3d");
    expect(item.description).toBe("Want the atoms.");
    expect(item.atom).toEqual({
      kind: "atom",
      type: "sketch",
      label: "sketch:0a1b2c3d",
      value: "0a1b2c3d",
      sketch: { projectDir: "/u/src/tug" },
    });
  });

  test("a row with no want has no description", () => {
    expect(sketchMentionItem({ ...ROW, want: null }, "", "/u/src/tug").description).toBeUndefined();
  });
});

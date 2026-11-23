/**
 * The arc mention provider's rows: each searched arc mints the same arc atom
 * every other surface does, pinned to its generation, with the brief's title
 * as the description.
 */

import { describe, expect, test } from "bun:test";

import { arcMentionItem } from "../completion-providers/arc-mentions";
import type { SearchedArc } from "@/protocol";

const ROW: SearchedArc = {
  name: "parser",
  created: "2026-10-03T00:00:00Z",
  fate: "joined",
  joinSha: "abc1234567",
  title: "Faster parsing",
  sketchId: null,
};

describe("the arc provider's rows", () => {
  test("a row mints an arc atom under the composer's checkout", () => {
    const item = arcMentionItem(ROW, "par", "/u/src/tug");
    expect(item.label).toBe("parser");
    expect(item.description).toBe("Faster parsing");
    expect(item.atom).toEqual({
      kind: "atom",
      type: "arc",
      label: "parser",
      value: "tug/parser",
      arc: { projectDir: "/u/src/tug", created: "2026-10-03T00:00:00Z" },
    });
    expect(item.matches).toEqual([[0, 3]]);
  });

  test("a row with no brief has no description", () => {
    const item = arcMentionItem({ ...ROW, title: null }, "", "/u/src/tug");
    expect(item.description).toBeUndefined();
  });
});

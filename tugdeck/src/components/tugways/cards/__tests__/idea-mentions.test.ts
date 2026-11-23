/**
 * The idea mention provider's rows: each searched idea mints the idea atom,
 * labelled by its line, owned by the checkout that was searched.
 */

import { describe, expect, test } from "bun:test";

import { ideaMentionItem } from "../completion-providers/idea-mentions";
import { IDEA_LABEL_LIMIT } from "@/lib/record-atom-shape";

describe("the idea provider's rows", () => {
  test("a row mints an idea atom labelled by its line", () => {
    const item = ideaMentionItem({ id: "1a2b3c4d", text: "An inbox for ideas" }, "", "/u/src/tug");
    expect(item.label).toBe("An inbox for ideas");
    expect(item.description).toBe("idea:1a2b3c4d");
    expect(item.atom).toEqual({
      kind: "atom",
      type: "idea",
      label: "An inbox for ideas",
      value: "1a2b3c4d",
      idea: { projectDir: "/u/src/tug" },
    });
  });

  test("a long line is cut to the limit with an ellipsis", () => {
    const text = "x".repeat(IDEA_LABEL_LIMIT + 10);
    const label = ideaMentionItem({ id: "1a2b3c4d", text }, "", "/r").label;
    expect(Array.from(label).length).toBe(IDEA_LABEL_LIMIT);
    expect(label.endsWith("…")).toBe(true);
  });

  test("an idea with no line is labelled by its id", () => {
    expect(ideaMentionItem({ id: "1a2b3c4d", text: "" }, "", "/r").label).toBe("idea:1a2b3c4d");
  });
});

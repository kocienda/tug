/**
 * The Auto-Message stream's write rule, pinned through the pure
 * `streamedDraftChange` helper: a reading that continues the document is
 * written as the tail alone, so the prefix — and everything painted on it —
 * never moves while the scribe writes.
 */
import { describe, expect, test } from "bun:test";

import { streamedDraftChange } from "@/components/tugways/tug-prompt-entry";

describe("streamedDraftChange", () => {
  test("an empty editor takes the first reading whole", () => {
    expect(streamedDraftChange("", "tug")).toEqual({
      from: 0,
      to: 0,
      insert: "tug",
    });
  });

  test("a continued reading is the tail, inserted at the end", () => {
    expect(streamedDraftChange("tugcast(", "tugcast(feeds): Re")).toEqual({
      from: 8,
      to: 8,
      insert: "feeds): Re",
    });
  });

  test("an unchanged reading writes nothing at all", () => {
    expect(streamedDraftChange("tugcast(feeds)", "tugcast(feeds)")).toBeNull();
  });

  test("a reading that rewrites what it said replaces the document", () => {
    expect(streamedDraftChange("tugcast(feeds)", "tugdeck(entry)")).toEqual({
      from: 0,
      to: 14,
      insert: "tugdeck(entry)",
    });
  });

  test("the insertion always ends at the new document's end", () => {
    const doc = "subject\n\nsummary";
    const next = `${doc} paragraph\n\n- detail`;
    const change = streamedDraftChange(doc, next);
    expect(change).not.toBeNull();
    expect(change!.from + change!.insert.length).toBe(next.length);
  });
});

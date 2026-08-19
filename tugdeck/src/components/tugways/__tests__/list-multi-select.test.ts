/**
 * The gesture-record → selection-intent rule behind `TugListView`'s multi-select.
 */
import { describe, expect, test } from "bun:test";
import { multiSelectIntentFor } from "../list-multi-select";

describe("multiSelectIntentFor", () => {
  test("a bare click picks", () => {
    expect(multiSelectIntentFor({ metaKey: false, shiftKey: false })).toBe(
      "pick",
    );
  });

  test("⌘ toggles", () => {
    expect(multiSelectIntentFor({ metaKey: true, shiftKey: false })).toBe(
      "toggle",
    );
  });

  test("⇧ extends", () => {
    expect(multiSelectIntentFor({ metaKey: false, shiftKey: true })).toBe(
      "extend",
    );
  });

  test("⌘ wins over ⇧ when both are held", () => {
    expect(multiSelectIntentFor({ metaKey: true, shiftKey: true })).toBe(
      "toggle",
    );
  });

  test("an unclassified gesture reads as a plain pick", () => {
    expect(multiSelectIntentFor(null)).toBe("pick");
    expect(multiSelectIntentFor(undefined)).toBe("pick");
  });
});

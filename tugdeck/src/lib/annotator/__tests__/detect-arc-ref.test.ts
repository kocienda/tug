/**
 * The `arc:<name>` grammar — what the prose scan asks the arc log about.
 */

import { describe, expect, test } from "bun:test";

import { scanArcRefs } from "../detect-arc-ref";

describe("scanArcRefs", () => {
  test("finds a reference in a sentence, with its offsets", () => {
    const text = "See arc:chart-cross-references for the work.";
    const found = scanArcRefs(text);
    expect(found).toEqual([
      { name: "chart-cross-references", start: 4, end: 30 },
    ]);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(
      "arc:chart-cross-references",
    );
  });

  test("a prefix that does not start a word is not a reference", () => {
    expect(scanArcRefs("xarc:foo")).toEqual([]);
    expect(scanArcRefs("my-arc:foo")).toEqual([]);
  });

  test("an empty name is not a reference", () => {
    expect(scanArcRefs("arc: foo")).toEqual([]);
    expect(scanArcRefs("arc:")).toEqual([]);
    expect(scanArcRefs("arc:-x")).toEqual([]);
  });

  test("stops at punctuation, and a trailing hyphen is not the name's", () => {
    expect(scanArcRefs("(arc:dash-hardening).").map((m) => m.name)).toEqual([
      "dash-hardening",
    ]);
    expect(scanArcRefs("arc:lens-, then").map((m) => m.name)).toEqual(["lens"]);
  });

  test("a name running on into characters the grammar refuses is not one", () => {
    expect(scanArcRefs("arc:fooBar")).toEqual([]);
    expect(scanArcRefs("arc:foo_bar")).toEqual([]);
  });

  test("finds every reference in a line", () => {
    expect(
      scanArcRefs("arc:one and arc:two-b").map((m) => m.name),
    ).toEqual(["one", "two-b"]);
  });
});

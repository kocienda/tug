/**
 * three-way-merge — what the store is allowed to merge without asking.
 *
 * The fixtures are adversarial on purpose: the failure this module exists to
 * prevent is not a refused merge, it is a merge that produces text neither
 * the user nor the agent wrote. So every case that could plausibly be fudged
 * — touching lines, two appends at EOF, a whole-file reformat against a
 * one-line edit, a diff too large to compute finely — asserts the refusal.
 */

import { describe, test, expect } from "bun:test";

import { mergeThreeWay } from "@/lib/three-way-merge";
import { MAX_EDIT_DISTANCE } from "@/lib/minimal-text-changes";

const BASE = "one\ntwo\nthree\nfour\nfive\nsix\n";

describe("mergeThreeWay — the identities", () => {
  test("both sides agree: the agreed text, no work", () => {
    expect(mergeThreeWay(BASE, "same\n", "same\n")).toEqual({
      ok: true,
      text: "same\n",
    });
  });

  test("disk is unchanged: ours", () => {
    expect(mergeThreeWay(BASE, "one\nTWO\nthree\nfour\nfive\nsix\n", BASE)).toEqual(
      { ok: true, text: "one\nTWO\nthree\nfour\nfive\nsix\n" },
    );
  });

  test("the buffer is unchanged: theirs", () => {
    const theirs = "one\ntwo\nTHREE\nfour\nfive\nsix\n";
    expect(mergeThreeWay(BASE, BASE, theirs)).toEqual({ ok: true, text: theirs });
  });
});

describe("mergeThreeWay — the merges", () => {
  test("edits in distant regions carry both", () => {
    const ours = "ONE\ntwo\nthree\nfour\nfive\nsix\n";
    const theirs = "one\ntwo\nthree\nfour\nfive\nSIX\n";
    expect(mergeThreeWay(BASE, ours, theirs)).toEqual({
      ok: true,
      text: "ONE\ntwo\nthree\nfour\nfive\nSIX\n",
    });
  });

  test("both sides make the SAME change: applied once", () => {
    const both = "one\ntwo\nTHREE\nfour\nfive\nsix\n";
    expect(mergeThreeWay(BASE, both, both)).toEqual({ ok: true, text: both });
  });

  test("the same change plus a distant one: applied once, with the other", () => {
    const ours = "one\ntwo\nTHREE\nfour\nfive\nsix\n";
    const theirs = "one\ntwo\nTHREE\nfour\nfive\nSIX\n";
    expect(mergeThreeWay(BASE, ours, theirs)).toEqual({
      ok: true,
      text: "one\ntwo\nTHREE\nfour\nfive\nSIX\n",
    });
  });

  test("one side deletes a region, the other edits a distant one", () => {
    const ours = "one\nfour\nfive\nsix\n";
    const theirs = "one\ntwo\nthree\nfour\nfive\nSIX\n";
    expect(mergeThreeWay(BASE, ours, theirs)).toEqual({
      ok: true,
      text: "one\nfour\nfive\nSIX\n",
    });
  });

  test("one side reformats the whole file and the other is unchanged", () => {
    const ours = "ONE\nTWO\nTHREE\nFOUR\nFIVE\nSIX\n";
    expect(mergeThreeWay(BASE, ours, BASE)).toEqual({ ok: true, text: ours });
  });

  test("a final line with no terminator, extended on one side only", () => {
    const base = "alpha\nbeta";
    const ours = "alpha\nbeta gamma";
    expect(mergeThreeWay(base, ours, base)).toEqual({ ok: true, text: ours });
    expect(mergeThreeWay(base, base, ours)).toEqual({ ok: true, text: ours });
  });

  test("one side adds a trailing terminator, the other edits line one", () => {
    const base = "alpha\nbeta\ngamma\ndelta";
    const ours = "ALPHA\nbeta\ngamma\ndelta";
    const theirs = "alpha\nbeta\ngamma\ndelta\n";
    expect(mergeThreeWay(base, ours, theirs)).toEqual({
      ok: true,
      text: "ALPHA\nbeta\ngamma\ndelta\n",
    });
  });
});

describe("mergeThreeWay — the refusals", () => {
  test("both sides edit the SAME line", () => {
    expect(
      mergeThreeWay(
        BASE,
        "one\ntwo\nTHREE ours\nfour\nfive\nsix\n",
        "one\ntwo\nTHREE theirs\nfour\nfive\nsix\n",
      ),
    ).toEqual({ ok: false });
  });

  test("both sides edit TOUCHING lines", () => {
    expect(
      mergeThreeWay(
        BASE,
        "one\ntwo\nTHREE\nfour\nfive\nsix\n",
        "one\ntwo\nthree\nFOUR\nfive\nsix\n",
      ),
    ).toEqual({ ok: false });
  });

  test("both append at EOF with different text", () => {
    expect(
      mergeThreeWay(BASE, `${BASE}ours\n`, `${BASE}theirs\n`),
    ).toEqual({ ok: false });
  });

  test("one side reformats the whole file while the other edits a line", () => {
    expect(
      mergeThreeWay(
        BASE,
        "ONE\nTWO\nTHREE\nFOUR\nFIVE\nSIX\n",
        "one\ntwo\nthree\nfour\nfive\nSIX!\n",
      ),
    ).toEqual({ ok: false });
  });

  test("one side deletes the region the other edited", () => {
    expect(
      mergeThreeWay(
        BASE,
        "one\nfive\nsix\n",
        "one\ntwo\nTHREE\nfour\nfive\nsix\n",
      ),
    ).toEqual({ ok: false });
  });

  test("a diff past MAX_EDIT_DISTANCE is a conflict, never a coarse merge", () => {
    const n = MAX_EDIT_DISTANCE + 200;
    const base = Array.from({ length: n }, (_, i) => `base ${i}\n`).join("");
    const ours = Array.from({ length: n }, (_, i) => `ours ${i}\n`).join("");
    const theirs = `${base}tail\n`;
    expect(mergeThreeWay(base, ours, theirs)).toEqual({ ok: false });
  });
});

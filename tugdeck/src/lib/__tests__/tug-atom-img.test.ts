/**
 * Pure-logic tests for the `tug-atom-img` exports that don't depend on
 * the DOM. The full chip-builder (`bakeAtomChipDataUri`) is
 * DOM-dependent (it reads theme tokens via `getComputedStyle(document.body)`)
 * and is exercised through the real-app manual smoke; this file pins
 * the pure pieces consumers rely on:
 *
 *   - {@link formatAtomLabel} — basename extraction. Tool-block path
 *     chips call this with mode `"filename"` to derive the chip's
 *     label from the full path.
 *   - {@link dotWellFor} — where a session chip's phase dot sits in its own
 *     box. The overlay layer positions the live dot from this and nothing
 *     else, so a drift from the painter's arithmetic seats the dot beside the
 *     hole the bake left. That the bake actually leaves the hole is a claim
 *     about pixels, and is pinned by the app-test that drives the real app.
 * The register table and the editor leading derived from it are pinned in
 * `atom-register.test`, beside the table they are about.
 */

import { describe, expect, test } from "bun:test";

import { COMMIT_ATOM_TYPE } from "@/lib/command-atom";
import { dotWellFor, formatAtomLabel } from "../tug-atom-img";
import type { AtomChipGeometry } from "../tug-atom-img";

describe("formatAtomLabel — `filename` mode (basename extraction)", () => {
  test("absolute path: returns the last component", () => {
    expect(formatAtomLabel("/repo/src/main.ts", "filename")).toBe("main.ts");
  });

  test("relative path: returns the last component", () => {
    expect(formatAtomLabel("src/components/foo.tsx", "filename")).toBe(
      "foo.tsx",
    );
  });

  test("bare filename (no slash): returns the input as-is", () => {
    expect(formatAtomLabel("main.ts", "filename")).toBe("main.ts");
  });

  test("path ending in slash returns empty (last component after trailing slash)", () => {
    // The transcript / tool-block side never passes a directory path
    // — the tool inputs are always file paths — but pin the deterministic
    // behaviour of `lastIndexOf('/')` so a future regression to a
    // non-empty fallback would be observable.
    expect(formatAtomLabel("src/", "filename")).toBe("");
  });

  test("nested basename keeps its extension", () => {
    expect(
      formatAtomLabel("/Users/kocienda/notebooks/exploration.ipynb", "filename"),
    ).toBe("exploration.ipynb");
  });

  test("http URL: returns the trailing component (after query strip)", () => {
    expect(
      formatAtomLabel("https://example.com/api/v2/users?id=42", "filename"),
    ).toBe("users");
  });

  test("https URL ending in slash (homepage): returns the full URL fallback", () => {
    // The `filename` branch falls back to the full value when the
    // post-strip basename is empty (a homepage URL).
    expect(formatAtomLabel("https://example.com/", "filename")).toBe(
      "https://example.com/",
    );
  });
});

/**
 * A geometry literal rather than `computeAtomChipGeometry`'s output: that
 * function measures text through a canvas, and tugdeck's `bun test` has no
 * DOM. The four fields the well reads are the four given real values; the rest
 * are whatever keeps the type honest.
 */
function geometry(over: Partial<AtomChipGeometry> = {}): AtomChipGeometry {
  return {
    iconPath: "",
    displayLabel: "tugtool/kind-floor",
    width: 120,
    height: 18,
    radius: 9,
    hasIcon: true,
    iconTransform: "",
    iconX: 5,
    iconY: 3,
    iconScale: 0.5,
    textX: 22,
    textY: 13,
    fontSize: 12,
    fontFamily: "sans-serif",
    dotSize: 7,
    baselineOffset: -4,
    ...over,
  };
}

describe("dotWellFor — the geometry the overlay layer positions from", () => {
  test("a session chip's well is the centre of its leading mark span", () => {
    // The same `iconX + fontSize / 2`, `height / 2` the painter uses. If these
    // two ever part, the live dot sits beside the hole the bake left.
    expect(dotWellFor("session", geometry())).toEqual({ x: 11, y: 9 });
  });

  test("the well is unrounded, because the chip's geometry is", () => {
    expect(dotWellFor("session", geometry({ fontSize: 13, height: 19 }))).toEqual({
      x: 11.5,
      y: 9.5,
    });
  });

  test("a commit pill has no well: its ring is ink, not phase", () => {
    expect(dotWellFor(COMMIT_ATOM_TYPE, geometry())).toBeNull();
  });

  test("a file chip has no well: its mark is a glyph", () => {
    expect(dotWellFor("file", geometry())).toBeNull();
  });

  test("a chip that reserves no mark span has no well", () => {
    // A slash command, whose leading `/` is its marker.
    expect(dotWellFor("command", geometry({ hasIcon: false }))).toBeNull();
    // And the belt to that brace: a session chip somehow baked without the
    // span answers null too, rather than pointing into its label.
    expect(dotWellFor("session", geometry({ hasIcon: false }))).toBeNull();
  });
});

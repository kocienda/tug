/**
 * `tuglaws/menus.md`'s generated sections must match the registry.
 *
 * The doc used to hand-maintain a catalog of control frames and a table of
 * chords, and both drifted — twelve separate ways, by the audit's count.
 * A doc table and a code table are two spellings of one fact, and only one of
 * them is executed, so the other is free to be wrong for as long as nobody
 * reads it carefully.
 *
 * This test removes that freedom: it regenerates the two derived regions and
 * diffs them against what is checked in. Prose outside the markers is
 * untouched — the doc's argument is written by hand, only its tables are
 * derived.
 *
 * Run with `TUG_WRITE_MENUS_DOC=1` to rewrite the regions in place instead of
 * failing, which is how a registry change is landed with its doc.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  generateCatalog,
  generateChordTable,
  readRegion,
  spliceRegion,
} from "./menus-doc";

const DOC_PATH = resolve(import.meta.dir, "../../../../../tuglaws/menus.md");

const REGIONS: ReadonlyArray<readonly [string, () => string]> = [
  ["catalog", generateCatalog],
  ["chords", generateChordTable],
];

describe("tuglaws/menus.md is generated where it is derived", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  if (process.env.TUG_WRITE_MENUS_DOC === "1") {
    test("rewrite the generated regions", () => {
      let next = doc;
      for (const [name, generate] of REGIONS) next = spliceRegion(next, name, generate());
      writeFileSync(DOC_PATH, next, "utf8");
      expect(next.length).toBeGreaterThan(0);
    });
    return;
  }

  for (const [name, generate] of REGIONS) {
    test(`the ${name} section matches the registry`, () => {
      expect(
        readRegion(doc, name),
        `menus.md's ${name} table has drifted — rerun with TUG_WRITE_MENUS_DOC=1`,
      ).toBe(generate().trim());
    });
  }

  test("the doc names every top-level key the host decodes", () => {
    // The drift that mattered most was not a wrong row, it was six keys the
    // decoder read and the doc never mentioned. A reader working from the
    // contract has to be able to see the whole contract.
    for (const key of [
      "panes",
      "activeCard",
      "selectionActive",
      "stackDepth",
      "session",
      "file",
      "document",
      "edit",
      "commands",
      "recentDocuments",
      "activeTheme",
      "openQuickly",
      "captureArmed",
      "appModalOpen",
    ]) {
      expect(doc, `menus.md documents "${key}"`).toContain(`"${key}"`);
    }
  });

  test("the doc no longer names the blocks and wires that were retired", () => {
    expect(doc).not.toContain("show-dev-panel-toggle");
    expect(doc).not.toContain("set-maker-mode");
    expect(doc).not.toContain("maker.sessionPanel");
    // The block is `session`, not `dev`.
    expect(doc).not.toContain('"dev": {');
    expect(doc).not.toContain("applyStackChordKeyEquivalent");
    expect(doc).not.toContain("five tiers");
  });
});

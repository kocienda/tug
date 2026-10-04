/**
 * canvas-deck-fields — the canvas's narrowed deck read never serves a stale
 * field.
 *
 * `canvasDeckEqual` keeps the previous snapshot when only a field in
 * `CANVAS_UNREAD_FIELDS` moved. That is safe only while no module the canvas's
 * read feeds reads such a field, so the first case reads those modules as text
 * and fails on any mention of a listed field in code. `isFocusDestination` is
 * the one reader allowed, because no chrome module imports it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DeckState } from "@/layout-tree";
import { CANVAS_UNREAD_FIELDS, canvasDeckEqual } from "../canvas-deck-fields";

const SRC = join(import.meta.dir, "..", "..", "..");

const CANVAS_MODULES = [
  "components/chrome/deck-canvas.tsx",
  "components/chrome/settle-engine.ts",
  "components/chrome/pane-focus-controller.ts",
  "components/chrome/pane-occlusion-controller.ts",
  "deck-store-selectors.ts",
  "lib/layout-imposer.ts",
];

/** The text with its comments and `isFocusDestination`'s body removed. */
function codeOf(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLines = withoutBlocks.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return withoutLines.replace(
    /export function isFocusDestination\([\s\S]*?\n\}\n/,
    "",
  );
}

describe("CANVAS_UNREAD_FIELDS", () => {
  it("names no field a canvas module reads", () => {
    const reads: string[] = [];
    for (const rel of CANVAS_MODULES) {
      const code = codeOf(readFileSync(join(SRC, rel), "utf8"));
      for (const field of CANVAS_UNREAD_FIELDS) {
        if (new RegExp(`\\b${field}\\b`).test(code)) reads.push(`${rel}: ${field}`);
      }
    }
    expect(reads).toEqual([]);
  });

  it("strips isFocusDestination, which is the field's one reader", () => {
    const selectors = readFileSync(join(SRC, "deck-store-selectors.ts"), "utf8");
    expect(selectors).toContain("state.hasFocus");
    expect(codeOf(selectors)).not.toContain("hasFocus");
  });
});

describe("canvasDeckEqual", () => {
  const base = {
    panes: [],
    cards: [],
    activePaneId: "p1",
    hasFocus: true,
  } as unknown as DeckState;

  it("is equal when only hasFocus moved", () => {
    expect(canvasDeckEqual(base, { ...base, hasFocus: false })).toBe(true);
  });

  it("is unequal when any other key moved in identity", () => {
    expect(canvasDeckEqual(base, { ...base, panes: [] })).toBe(false);
    expect(canvasDeckEqual(base, { ...base, activePaneId: "p2" })).toBe(false);
  });

  it("is unequal when a key is absent from one side", () => {
    const withArriving = { ...base, arriving: undefined } as DeckState;
    expect(canvasDeckEqual(base, withArriving)).toBe(false);
    expect(canvasDeckEqual(withArriving, base)).toBe(false);
  });
});

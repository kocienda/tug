/**
 * Drift guard for Fast Refresh boundary hygiene.
 *
 * Pure-logic test over the static reachability analyzer in
 * `scripts/fast-refresh-sweep.ts` (the oracle — happy-dom is deleted, so a
 * runtime HMR test is impossible; this is the falsifiable substitute). It
 * freezes the set of files that have been made clean refresh boundaries: if
 * any of them regains a runtime non-component export (re-mixing the
 * boundary), `escapesPath` flips to `true` and this test fails — catching the
 * regression before it ships a full-page-reload back into the transcript spine.
 *
 * The frozen list grows as boundary work lands. It starts with only the
 * analyzer's own wiring asserted; spine files are added when they are cleaned.
 */
import { describe, expect, test } from "bun:test";
import { analyze } from "../../../scripts/fast-refresh-sweep";

/**
 * Files proven to be clean refresh boundaries. Editing any of these must NOT
 * trigger a full page reload. Extend this list when a file is cleaned.
 */
const FROZEN_BOUNDARIES: readonly string[] = [
  "src/components/tugways/cards/session-card.tsx",
  "src/components/tugways/cards/session-card-transcript.tsx",
  // The picker's own module. It left `session-card.tsx` when the opening-form
  // factory needed it from outside, and it is frozen here for the same reason
  // the card is: the picker is a surface people edit, and a full page reload
  // per edit is what the boundary work bought back. The factory and the notice
  // mapper are separate modules precisely so this one stays component-only.
  "src/components/tugways/cards/session-picker-form.tsx",
];

describe("fast-refresh boundary oracle", () => {
  const result = analyze();

  test("analyze() returns a populated graph and census", () => {
    expect(result.mods.size).toBeGreaterThan(0);
    expect(result.focusGraph.size).toBeGreaterThan(0);
    expect(Array.isArray(result.reloaders)).toBe(true);
    const { boundaries, mixed, transparent } = result.census;
    expect(boundaries + mixed + transparent).toBeGreaterThan(0);
  });

  test("the entry module escapes (it has no boundary above it)", () => {
    // main.tsx is the no-importer entry: an edit there always full-reloads.
    // This proves the analyzer detects an escaper, not just reports clean.
    expect(result.escapesPath("src/main.tsx")).toBe(true);
  });

  test("a component-only module is recognized as a boundary", () => {
    // tug-copy-badge.tsx exports only the TugCopyBadge component (plus its
    // type-only props interface) — the analyzer must classify it as
    // not-escaping, proving it detects boundaries too.
    expect(result.escapesPath("src/components/tugways/tug-copy-badge.tsx")).toBe(false);
  });

  test("frozen boundary files do not escape", () => {
    for (const file of FROZEN_BOUNDARIES) {
      expect(result.escapesPath(file)).toBe(false);
    }
  });
});

/**
 * arc-note-command.test.ts — the synthetic quiet-line matcher reads both verb
 * heads.
 *
 * `command_for_line` in tugcast renders an arc gesture's row as `arc step
 * <name> done` and friends. Rows written before the word moved say `arc …`
 * and are in the shell ledger for good, so the matcher claims both ([F19]) —
 * a matcher that claimed only the new head would turn every gesture already
 * recorded back into an ordinary shell entry on the next card reload.
 *
 * @covers tugdeck/src/lib/arc-note-command.ts
 */

import { describe, expect, it } from "bun:test";

import { matchesArcNote } from "@/lib/arc-note-command";

describe("matchesArcNote", () => {
  it("claims every verb the record renders, under the arc head", () => {
    expect(matchesArcNote("arc create demo")).toBe(true);
    expect(matchesArcNote("arc step demo start")).toBe(true);
    expect(matchesArcNote("arc step demo start --through")).toBe(true);
    expect(matchesArcNote("arc step demo done")).toBe(true);
    expect(matchesArcNote("arc mark demo built")).toBe(true);
    expect(matchesArcNote("arc commit demo")).toBe(true);
  });

  it("still claims the head the record rendered before the word moved", () => {
    // These rows are in the shell ledger and replay on every card reload.
    expect(matchesArcNote("arc create demo")).toBe(true);
    expect(matchesArcNote("arc step demo done")).toBe(true);
    expect(matchesArcNote("arc mark demo built")).toBe(true);
    expect(matchesArcNote("arc commit demo")).toBe(true);
  });

  it("claims nothing a user could have typed", () => {
    // The synthetic tell is the bare head: a typed command spells the binary.
    expect(matchesArcNote("tugtool arc step demo done")).toBe(false);
    // A verb the record never renders.
    expect(matchesArcNote("arc status demo")).toBe(false);
    // A head that merely starts alike.
    expect(matchesArcNote("arcane create demo")).toBe(false);
    // A verb with no name after it is not a gesture's line.
    expect(matchesArcNote("arc create")).toBe(false);
    expect(matchesArcNote("")).toBe(false);
  });
});

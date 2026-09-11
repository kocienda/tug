/**
 * pane-folded.test.ts — unit tests for the pure core of the fold
 * commit: `panesWithFolded` ([P01]) and `panesWithWallFolded` ([P06]).
 *
 * The verb around it (`DeckManager.setPaneFolded`) needs a live manager —
 * a container, a connection, the imposer — and no unit test in this project
 * builds one; the deck-manager behaviour it adds (the rail refusal, the single
 * commit) is covered from the app-test side. What IS pure is the decision this
 * helper makes: which pane array the commit writes, and when there is nothing
 * to commit at all. That is what these cases hold.
 */

import { describe, test, expect } from "bun:test";
import type { TugPaneState } from "../layout-tree";
import {
  columnIsWall,
  panesWithFolded,
  panesWithWallFolded,
} from "../deck-manager";

function pane(id: string, folded?: true): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: "",
    acceptsFamilies: ["standard"],
    ...(folded !== undefined ? { folded } : {}),
  };
}

describe("panesWithFolded", () => {
  test("writes the flag on the named pane and leaves its siblings alone", () => {
    const panes = [pane("a"), pane("b")];
    const next = panesWithFolded(panes, "a", true);
    expect(next[0].folded).toBe(true);
    expect(next[1]).toBe(panes[1]);
  });

  test("DELETES the key rather than writing false", () => {
    const next = panesWithFolded([pane("a", true)], "a", false);
    expect("folded" in next[0]).toBe(false);
  });

  test("returns the array by identity when the pane already reads that way", () => {
    const folded = [pane("a", true)];
    expect(panesWithFolded(folded, "a", true)).toBe(folded);
    const open = [pane("a")];
    expect(panesWithFolded(open, "a", false)).toBe(open);
  });

  test("returns the array by identity for a pane id naming no pane", () => {
    const panes = [pane("a")];
    expect(panesWithFolded(panes, "pane-gone", true)).toBe(panes);
  });

  test("does not mutate the array it was handed", () => {
    const panes = [pane("a")];
    panesWithFolded(panes, "a", true);
    expect(panes[0].folded).toBeUndefined();
  });

  test("carries every other field of the pane through untouched", () => {
    const original = { ...pane("a"), slot: 2, widthPreset: "slim" as const };
    const next = panesWithFolded([original], "a", true);
    expect(next[0].slot).toBe(2);
    expect(next[0].widthPreset).toBe("slim");
    expect(next[0].cardIds).toEqual(["card-a"]);
  });
});

describe("panesWithWallFolded", () => {
  const MEMBERS = ["a", "b", "c"];

  test("opening a card in a wall folds every other member", () => {
    // `a` has just been opened; `b` and `c` were folded, and `b` stays folded
    // while `c`… is already folded too. The case that matters is the one
    // below; this one holds the resting shape.
    const panes = [pane("a"), pane("b", true), pane("c", true)];
    const next = panesWithWallFolded(panes, "a", MEMBERS);
    // Nothing to fold — every sibling is already folded — so the array comes
    // back by identity and the commit spreads nothing.
    expect(next).toBe(panes);
  });

  test("a second open member is folded, so the wall stays a wall", () => {
    // `c` is the wall's evidence; `b` is the card that was being read before
    // `a` was opened, and it is what has to fold ([P06]).
    const panes = [pane("a"), pane("b"), pane("c", true)];
    const next = panesWithWallFolded(panes, "a", MEMBERS);
    expect(next).not.toBe(panes);
    expect(next[0].folded).toBeUndefined();
    expect(next[1].folded).toBe(true);
    expect(next[2].folded).toBe(true);
  });

  test("a plain split of full sessions is left alone", () => {
    // No member is folded, so this is not a wall — it is two or three whole
    // sessions sharing a slot, and folding one would take away a division the
    // user made with the seams.
    const panes = [pane("a"), pane("b"), pane("c")];
    expect(panesWithWallFolded(panes, "a", MEMBERS)).toBe(panes);
  });

  test("a column of one has no siblings to fold", () => {
    const panes = [pane("a"), pane("b", true)];
    expect(panesWithWallFolded(panes, "a", ["a"])).toBe(panes);
  });

  test("panes outside the column are never touched", () => {
    // The membership is the imposition's answer, not "every folded pane on
    // the deck": a wall in slot 0 says nothing about a card in slot 1.
    const panes = [pane("a"), pane("b"), pane("c", true), pane("elsewhere")];
    const next = panesWithWallFolded(panes, "a", MEMBERS);
    expect(next[3].folded).toBeUndefined();
    expect(next[3]).toBe(panes[3]);
  });

  test("does not mutate the array it was handed", () => {
    const panes = [pane("a"), pane("b"), pane("c", true)];
    panesWithWallFolded(panes, "a", MEMBERS);
    expect(panes[1].folded).toBeUndefined();
  });

  test("carries every other field of a folded sibling through", () => {
    const b = { ...pane("b"), slot: 0, widthPreset: "comfy" as const };
    const next = panesWithWallFolded([pane("a"), b, pane("c", true)], "a", MEMBERS);
    expect(next[1].slot).toBe(0);
    expect(next[1].widthPreset).toBe("comfy");
    expect(next[1].folded).toBe(true);
  });
});

describe("columnIsWall", () => {
  const MEMBERS = ["a", "b", "c"];

  test("a settled wall is a wall even though nothing needs folding", () => {
    // The distinction the predicate exists for: `panesWithWallFolded` answers
    // by identity here, and the reveal is still owed. Reading the fold's
    // identity as "not a wall" is what left the column unscrolled.
    const panes = [pane("a"), pane("b", true), pane("c", true)];
    expect(columnIsWall(panes, "a", MEMBERS)).toBe(true);
    expect(panesWithWallFolded(panes, "a", MEMBERS)).toBe(panes);
  });

  test("one folded sibling is enough", () => {
    expect(
      columnIsWall([pane("a"), pane("b"), pane("c", true)], "a", MEMBERS),
    ).toBe(true);
  });

  test("a plain split of full sessions is not a wall", () => {
    expect(columnIsWall([pane("a"), pane("b"), pane("c")], "a", MEMBERS)).toBe(
      false,
    );
  });

  test("the opened pane's own flag is not evidence", () => {
    // It is the one member that is definitionally open by the time this is
    // asked, and counting it would make every single-member column a wall.
    expect(columnIsWall([pane("a", true)], "a", ["a"])).toBe(false);
  });
});

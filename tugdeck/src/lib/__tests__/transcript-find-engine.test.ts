/**
 * transcript-find-engine.test — the Session card's find engine behind the
 * shared session: debounced index search, active-match identity
 * preservation across re-searches, wrap-around navigation, and the anchored
 * landing rule that decides where a fresh query puts the reader.
 */

import { describe, expect, test } from "bun:test";
import { TranscriptFindEngine } from "../transcript-find-engine";
import { buildSegments, rowIds } from "./helpers/segments";
import type { RowSegment } from "../transcript-search";

const settle = () => new Promise((r) => setTimeout(r, 130));

describe("TranscriptFindEngine", () => {
  test("searches the index after the debounce and reports matchInfo", async () => {
    const engine = new TranscriptFindEngine();
    engine.setIndex(buildSegments(["alpha beta", "beta gamma beta"]), rowIds);
    engine.searchDidChange("beta", {
      caseSensitive: false,
      wholeWord: false,
      grep: false,
    });
    await settle();
    expect(engine.matchInfo()).toEqual({
      count: 3,
      activeOrdinal: 0,
      capped: false,
    });
  });

  test("navigation wraps around the match set", async () => {
    const engine = new TranscriptFindEngine();
    engine.setIndex(buildSegments(["x y", "x"]), rowIds);
    engine.searchDidChange("x", {
      caseSensitive: false,
      wholeWord: false,
      grep: false,
    });
    await settle();
    engine.findNext();
    expect(engine.matchInfo().activeOrdinal).toBe(1);
    engine.findNext();
    expect(engine.matchInfo().activeOrdinal).toBe(0);
    engine.findPrevious();
    expect(engine.matchInfo().activeOrdinal).toBe(1);
  });

  test("a re-search preserves the active match by identity when it survives", async () => {
    const engine = new TranscriptFindEngine();
    engine.setIndex(buildSegments(["needle", "needle here"]), rowIds);
    engine.searchDidChange("needle", {
      caseSensitive: false,
      wholeWord: false,
      grep: false,
    });
    await settle();
    engine.findNext(); // active = the row-1 needle
    expect(engine.matchInfo().activeOrdinal).toBe(1);
    // The transcript grows a row ABOVE the active match's row order in the
    // index; the surviving match keeps its (row, segment, start) identity.
    engine.setIndex(buildSegments(["needle", "needle here", "no hits"]), rowIds);
    await settle();
    expect(engine.matchInfo().activeOrdinal).toBe(1);
  });

  test("clearing empties immediately (no debounce)", async () => {
    const engine = new TranscriptFindEngine();
    engine.setIndex(buildSegments(["zzz"]), rowIds);
    engine.searchDidChange("z", {
      caseSensitive: false,
      wholeWord: false,
      grep: false,
    });
    await settle();
    expect(engine.matchInfo().count).toBe(3);
    engine.clear();
    expect(engine.matchInfo()).toEqual({
      count: 0,
      activeOrdinal: null,
      capped: false,
    });
  });
});

/**
 * The anchored landing rule. The fixture puts matches in rows
 * `[1, 3, 5, 5, 9]` — match indices 0..4 — so "the last match at or above
 * the anchor" has a different answer from "match zero" for every anchor
 * worth testing.
 */
describe("TranscriptFindEngine anchored landing", () => {
  const OPTIONS = { caseSensitive: false, wholeWord: false, grep: false };
  const ROWS = [
    "",
    "hit",
    "",
    "hit",
    "",
    "hit and hit",
    "",
    "",
    "",
    "hit",
  ];

  const seeded = (anchor: number | null): TranscriptFindEngine => {
    const engine = new TranscriptFindEngine();
    engine.setIndex(buildSegments(ROWS), rowIds);
    engine.setAnchorRow(anchor);
    return engine;
  };

  test("a gesture lands on the last match at or above the anchor row", async () => {
    const engine = seeded(5);
    engine.searchDidChange("hit", OPTIONS);
    await settle();
    expect(engine.matchInfo().count).toBe(5);
    // Row 5 holds matches 2 and 3; the LAST of them is where the reader is.
    expect(engine.matchInfo().activeOrdinal).toBe(3);
  });

  test("an anchor with nothing at or above it wraps to the last match", async () => {
    const engine = seeded(0);
    engine.searchDidChange("hit", OPTIONS);
    await settle();
    expect(engine.matchInfo().activeOrdinal).toBe(4);
  });

  test("no anchor at all clamps to the first match", async () => {
    const engine = seeded(null);
    engine.searchDidChange("hit", OPTIONS);
    await settle();
    expect(engine.matchInfo().activeOrdinal).toBe(0);
  });

  test("a setIndex re-search preserves identity and does not re-anchor", async () => {
    const engine = seeded(9);
    engine.searchDidChange("hit", OPTIONS);
    await settle();
    expect(engine.matchInfo().activeOrdinal).toBe(4);
    engine.findPrevious(); // active = match 3, in row 5
    expect(engine.matchInfo().activeOrdinal).toBe(3);
    // A background re-projection (a row expanded, a frame arrived) must keep
    // the reader on their match rather than re-running the landing rule.
    engine.setIndex(buildSegments([...ROWS, "no hits here"]), rowIds);
    await settle();
    expect(engine.matchInfo().activeOrdinal).toBe(3);
  });

  test("findNext moves the anchor, so a following query edit lands there", async () => {
    const engine = seeded(null);
    engine.searchDidChange("hit", OPTIONS);
    await settle();
    expect(engine.matchInfo().activeOrdinal).toBe(0); // row 1
    engine.findNext(); // → match 1, row 3
    expect(engine.matchInfo().activeOrdinal).toBe(1);
    // Retyping the same query is a gesture: it lands relative to where the
    // user stepped to, not back at the top where the search began.
    engine.searchDidChange("hit", OPTIONS);
    await settle();
    expect(engine.matchInfo().activeOrdinal).toBe(1);
  });
});

/**
 * The heal path ([P03]). The painter compares each mounted row's live DOM
 * against the projection the engine searched and, where they disagree,
 * hands the DOM's own text back here. The engine's job is to believe it,
 * re-search at once, and keep the reader where they were.
 */
describe("TranscriptFindEngine healRows", () => {
  const OPTIONS = { caseSensitive: false, wholeWord: false, grep: false };

  const searched = (
    index: RowSegment[][],
    query = "hit",
  ): TranscriptFindEngine => {
    const engine = new TranscriptFindEngine();
    engine.setIndex(index, rowIds);
    engine.searchDidChange(query, OPTIONS);
    return engine;
  };

  test("a projection that missed an occurrence gains it, synchronously", async () => {
    // The projection says the row holds one "hit"; the DOM holds two.
    const engine = searched(buildSegments(["a hit here", "nothing"]));
    await settle();
    expect(engine.matchInfo().count).toBe(1);
    // No timer is awaited between the heal and the read: a debounce here
    // is 100ms of the painter holding a match set the index disagrees with.
    engine.healRows([{ row: 0, rowId: rowIds(0), domTexts: ["a hit and a hit"] }]);
    expect(engine.matchInfo().count).toBe(2);
    expect(engine.getIndex()[0][0].text).toBe("a hit and a hit");
  });

  test("the reader keeps their match across a heal", async () => {
    const engine = searched(buildSegments(["hit one", "hit two", "hit three"]));
    await settle();
    engine.findNext(); // active = the row-1 match
    expect(engine.matchInfo().activeOrdinal).toBe(1);
    // Row 0 grows text ABOVE nothing the reader is looking at; their match
    // survives by identity and the ordinal does not move.
    engine.healRows([{ row: 0, rowId: rowIds(0), domTexts: ["hit one exactly"] }]);
    expect(engine.matchInfo().activeOrdinal).toBe(1);
  });

  test("a heal that moves the reader's offsets lands them nearest in the same row", async () => {
    const engine = searched(buildSegments(["lead hit tail"]));
    await settle();
    expect(engine.matchInfo().activeOrdinal).toBe(0);
    // The DOM says the row begins with text the projection dropped, so the
    // match's `start` moves. Identity fails; the nearest start in the same
    // row is the same place on screen.
    engine.healRows([
      { row: 0, rowId: rowIds(0), domTexts: ["PREFIX lead hit tail"] },
    ]);
    expect(engine.matchInfo().count).toBe(1);
    expect(engine.matchInfo().activeOrdinal).toBe(0);
  });

  test("editor segments keep their positions and the dom ones are replaced", () => {
    const index: RowSegment[][] = [
      [
        { kind: "dom", text: "head", key: "fold-a" },
        { kind: "editor", key: "ed-1", text: "inside the editor" },
        { kind: "dom", text: "tail" },
      ],
    ];
    const engine = searched(index, "zzz");
    engine.healRows([
      { row: 0, rowId: rowIds(0), domTexts: ["HEAD", "TAIL"] },
    ]);
    const healed = engine.getIndex()[0];
    expect(healed.map((s) => s.kind)).toEqual(["dom", "editor", "dom"]);
    expect(healed.map((s) => s.text)).toEqual(["HEAD", "inside the editor", "TAIL"]);
    // The unit count is unchanged, so the fold key rides across — it is
    // what navigation unfolds a hidden match through.
    expect(healed[0].key).toBe("fold-a");
    expect(healed[1].key).toBe("ed-1");
  });

  test("a setIndex keeps the heal when the projection is unchanged and drops it when it is not", async () => {
    const engine = searched(buildSegments(["a hit here", "nothing"]));
    await settle();
    engine.healRows([{ row: 0, rowId: rowIds(0), domTexts: ["a hit and a hit"] }]);
    expect(engine.matchInfo().count).toBe(2);

    // Same projection for row 0 — the transcript re-projected around it,
    // so the correction still describes this row and is kept.
    engine.setIndex(buildSegments(["a hit here", "nothing", "still nothing"]), rowIds);
    await settle();
    expect(engine.matchInfo().count).toBe(2);
    expect(engine.getIndex()[0][0].text).toBe("a hit and a hit");

    // Row 0's own projection changed: the heal describes text nobody has
    // compared, so it goes rather than being held over the new row.
    engine.setIndex(buildSegments(["a hit there", "nothing"]), rowIds);
    await settle();
    expect(engine.matchInfo().count).toBe(1);
    expect(engine.getIndex()[0][0].text).toBe("a hit there");
  });

  test("a heal mid-debounce answers the published query, not the pending one", async () => {
    const engine = searched(buildSegments(["hit tail", "tail", "hit tail"]));
    engine.setAnchorRow(2);
    await settle();
    // The user types a new query; its search is still debouncing when a
    // paint heals a row. Publishing the pending query from the heal would
    // call it settled under the background rule — an unanchored landing the
    // host would reveal a moment before the gesture's own search ran.
    engine.searchDidChange("tail", OPTIONS);
    engine.healRows([{ row: 0, rowId: rowIds(0), domTexts: ["hit tail hit"] }]);
    expect(engine.getSnapshot().query).toBe("hit");
    expect(engine.matchInfo().count).toBe(3);
    // The gesture's own search still runs, and lands at the anchor.
    await settle();
    expect(engine.getSnapshot().query).toBe("tail");
    expect(engine.matchInfo().activeOrdinal).toBe(2);
  });

  test("the raw projection is never overwritten by a heal", async () => {
    const engine = searched(buildSegments(["a hit here"]));
    await settle();
    engine.healRows([{ row: 0, rowId: rowIds(0), domTexts: ["a hit and a hit"] }]);
    // The signature check on the NEXT setIndex compares against the raw
    // projection; a heal that had merged in place would compare the
    // corrected text against the fresh projection and drop itself every
    // time. Handing back the identical projection must keep the heal.
    engine.setIndex(buildSegments(["a hit here"]), rowIds);
    await settle();
    expect(engine.getIndex()[0][0].text).toBe("a hit and a hit");
  });
});

/**
 * transcript-find-engine.remote.test — assistant text and thinking searched
 * by tugcast: the engine sends one request per search naming the remote
 * units in order, merges the answer with its local search in
 * `(row, segment, start)` order under one cap, drops an answer a newer
 * search superseded, projects locally what tugcast cannot answer, keeps the
 * answer so a heal re-searches without asking again, and publishes a remote
 * unit `pending` until its text is held.
 */

import { describe, expect, test } from "bun:test";
import type { FindResultFrame } from "@tugproto/rendered";
import {
  TranscriptFindEngine,
  type RemoteFind,
  type RemoteFindRequest,
} from "../transcript-find-engine";
import { DEFAULT_MATCH_LIMIT, type FindOptions, type RowSegment } from "../transcript-search";
import { textHash } from "../ingest/text-hash";
import { rowIds } from "./helpers/segments";

const settle = () => new Promise((r) => setTimeout(r, 130));
const LITERAL: FindOptions = { caseSensitive: false, wholeWord: false, grep: false };
const GREP: FindOptions = { caseSensitive: false, wholeWord: false, grep: true };

/** A remote unit whose page projection is `text`, counting each projection. */
function remote(unit: string, text: string, projections: string[] = []): RowSegment {
  return {
    kind: "dom",
    text: "",
    remote: {
      unit,
      source: `md:${text}`,
      project: () => {
        projections.push(unit);
        return text;
      },
    },
    pending: true,
  };
}

function dom(text: string): RowSegment {
  return { kind: "dom", text };
}

/** A remote side whose answers the test hands out. */
class FakeRemote implements RemoteFind {
  readonly requests: RemoteFindRequest[] = [];
  private readonly answers: ((answer: FindResultFrame | null) => void)[] = [];

  request(request: RemoteFindRequest): Promise<FindResultFrame | null> {
    this.requests.push(request);
    return new Promise((resolve) => this.answers.push(resolve));
  }

  /** Answer request `index` (the latest by default). */
  async answer(answer: Partial<FindResultFrame> | null, index = this.answers.length - 1): Promise<void> {
    this.answers[index]!(
      answer === null ? null : { kind: "find-result", requestId: "r", tugSessionId: "s", missing: [], ...answer },
    );
    await Promise.resolve();
    await Promise.resolve();
  }
}

function spans(engine: TranscriptFindEngine): [number, number, number, number][] {
  return engine.getSnapshot().matches.map((m) => [m.row, m.segment, m.start, m.end]);
}

describe("TranscriptFindEngine with tugcast's find", () => {
  test("one request names the remote units in order, and the answer merges with the local search", async () => {
    const projections: string[] = [];
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex(
      [[dom("x a")], [remote("m1-b1", "a x x", projections), dom("x")], [remote("m2-b1", "none", projections)]],
      rowIds,
    );
    engine.searchDidChange("x", LITERAL);
    await settle();
    expect(fake.requests).toEqual([
      { query: "x", options: LITERAL, limit: DEFAULT_MATCH_LIMIT, units: ["m1-b1", "m2-b1"], mountedUnits: [] },
    ]);
    // Nothing is published until the answer arrives.
    expect(spans(engine)).toEqual([]);
    await fake.answer({
      matches: [
        { unit: "m1-b1", start: 2, end: 3 },
        { unit: "m1-b1", start: 4, end: 5 },
      ],
    });
    expect(spans(engine)).toEqual([
      [0, 0, 0, 1],
      [1, 0, 2, 3],
      [1, 0, 4, 5],
      [1, 1, 0, 1],
    ]);
    expect(engine.getSnapshot().query).toBe("x");
    expect(projections).toEqual([]);
  });

  test("the merged set is capped at one search's limit", async () => {
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex([[remote("m1-b1", "")], [dom("x ".repeat(DEFAULT_MATCH_LIMIT))]], rowIds);
    engine.searchDidChange("x", LITERAL);
    await settle();
    await fake.answer({
      matches: Array.from({ length: 10 }, (_, i) => ({ unit: "m1-b1", start: i, end: i + 1 })),
    });
    const matches = engine.getSnapshot().matches;
    expect(matches.length).toBe(DEFAULT_MATCH_LIMIT);
    // The remote unit's row comes first, so all ten of its matches survive the cap.
    expect(matches.slice(0, 10).every((m) => m.row === 0)).toBe(true);
    expect(matches[matches.length - 1]!.row).toBe(1);
  });

  test("an answer a newer search superseded is dropped", async () => {
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex([[remote("m1-b1", "ab")]], rowIds);
    engine.searchDidChange("a", LITERAL);
    await settle();
    engine.searchDidChange("ab", LITERAL);
    await settle();
    expect(fake.requests.map((r) => r.query)).toEqual(["a", "ab"]);
    await fake.answer({ matches: [{ unit: "m1-b1", start: 0, end: 2 }] }, 1);
    await fake.answer({ matches: [{ unit: "m1-b1", start: 0, end: 1 }] }, 0);
    expect(engine.getSnapshot().query).toBe("ab");
    expect(spans(engine)).toEqual([[0, 0, 0, 2]]);
  });

  test("an answer that never came, and a unit tugcast holds nothing for, are projected here", async () => {
    const projections: string[] = [];
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex([[remote("m1-b1", "x", projections)], [remote("m2-b1", "x x", projections)]], rowIds);

    engine.searchDidChange("x", LITERAL);
    await settle();
    await fake.answer(null);
    expect(spans(engine)).toEqual([
      [0, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 2, 3],
    ]);
    expect(projections).toEqual(["m1-b1", "m2-b1"]);

    projections.length = 0;
    engine.searchDidChange("x ", LITERAL);
    await settle();
    await fake.answer({ matches: [], missing: ["m2-b1"] });
    // m1-b1 was answered (no match); m2-b1 is searched from its projection,
    // which the engine already holds for this source.
    expect(spans(engine)).toEqual([[1, 0, 0, 2]]);
    expect(projections).toEqual([]);
  });

  test("a grep search runs the page's RegExp over the texts tugcast returns", async () => {
    const projections: string[] = [];
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex([[remote("m1-b1", "never projected", projections)]], rowIds);
    engine.searchDidChange("a+b", GREP);
    await settle();
    await fake.answer({ texts: { "m1-b1": "xaab ab" } });
    expect(spans(engine)).toEqual([
      [0, 0, 1, 4],
      [0, 0, 5, 7],
    ]);
    expect(projections).toEqual([]);
  });

  test("a grep search names the texts it holds, and keeps one tugcast leaves out for the unit's new source", async () => {
    const projections: string[] = [];
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex([[remote("m1-b1", "first source", projections)]], rowIds);
    engine.searchDidChange("a+b", GREP);
    await settle();
    expect(fake.requests[0]!.knownTexts).toBeUndefined();
    await fake.answer({ texts: { "m1-b1": "xaab ab" } });

    // The Message's source moved (a heading's marks, say) but its rendered
    // text did not: tugcast leaves the text out, and the held one serves.
    engine.setIndex([[remote("m1-b1", "second source", projections)]], rowIds);
    engine.searchDidChange("ab", GREP);
    await settle();
    expect(fake.requests[1]!.knownTexts).toEqual({ "m1-b1": textHash("xaab ab") });
    await fake.answer({});
    expect(spans(engine)).toEqual([
      [0, 0, 2, 4],
      [0, 0, 5, 7],
    ]);
    expect(projections).toEqual([]);

    // A text that did change comes back and replaces the held one.
    engine.searchDidChange("b", GREP);
    await settle();
    await fake.answer({ texts: { "m1-b1": "b" } });
    expect(spans(engine)).toEqual([[0, 0, 0, 1]]);
  });

  test("a gesture lands at the anchor when its answer arrives", async () => {
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex([[remote("m0-b1", "")], [remote("m1-b1", "")], [remote("m2-b1", "")]], rowIds);
    engine.setAnchorRow(1);
    engine.searchDidChange("x", LITERAL);
    await settle();
    await fake.answer({
      matches: [
        { unit: "m0-b1", start: 0, end: 1 },
        { unit: "m1-b1", start: 0, end: 1 },
        { unit: "m2-b1", start: 0, end: 1 },
      ],
    });
    expect(engine.matchInfo().activeOrdinal).toBe(1);
  });

  test("a heal re-searches from the kept answer without asking again", async () => {
    const projections: string[] = [];
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex([[dom("x")], [remote("m1-b1", "never projected", projections)]], rowIds);
    engine.searchDidChange("x", LITERAL);
    await settle();
    await fake.answer({ matches: [{ unit: "m1-b1", start: 3, end: 4 }] });
    engine.healRows([{ row: 0, rowId: rowIds(0), domTexts: ["x x"] }]);
    expect(fake.requests.length).toBe(1);
    expect(spans(engine)).toEqual([
      [0, 0, 0, 1],
      [0, 0, 2, 3],
      [1, 0, 3, 4],
    ]);
    expect(projections).toEqual([]);
  });

  test("a mounted remote unit is pending until its text arrives, and heals like any other unit after", async () => {
    const fake = new FakeRemote();
    const engine = new TranscriptFindEngine();
    engine.setRemote(fake);
    engine.setIndex([[remote("m1-b1", "x")], [remote("m2-b1", "x")]], rowIds);
    engine.setMountedRange({ firstIndex: 1, lastIndex: 1 });
    engine.searchDidChange("x", LITERAL);
    await settle();
    expect(fake.requests[0]!.mountedUnits).toEqual(["m2-b1"]);
    expect(engine.getIndex()[1]).toMatchObject([{ pending: true }]);
    await fake.answer({
      matches: [
        { unit: "m1-b1", start: 0, end: 1 },
        { unit: "m2-b1", start: 0, end: 1 },
      ],
      texts: { "m2-b1": "x" },
    });
    expect(engine.getIndex()[1]).toEqual([expect.objectContaining({ kind: "dom", text: "x" })]);
    expect(engine.getIndex()[1]![0]).not.toHaveProperty("pending");
    expect(engine.getIndex()[0]).toMatchObject([{ pending: true }]);

    // Scrolling row 0 into view asks for its text alone.
    engine.setMountedRange({ firstIndex: 0, lastIndex: 1 });
    expect(fake.requests[1]).toMatchObject({ units: [], mountedUnits: ["m1-b1"] });
    await fake.answer({ texts: { "m1-b1": "x" } });
    expect(engine.getIndex()[0]).toEqual([expect.objectContaining({ kind: "dom", text: "x" })]);

    // The DOM disagrees about row 1: its text wins, and the row is searched here.
    engine.healRows([{ row: 1, rowId: rowIds(1), domTexts: ["y x"] }]);
    expect(spans(engine)).toEqual([
      [0, 0, 0, 1],
      [1, 0, 2, 3],
    ]);
  });
});

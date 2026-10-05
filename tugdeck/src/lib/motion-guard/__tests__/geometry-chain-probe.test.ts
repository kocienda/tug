/**
 * geometry-chain-probe.test.ts — the chain classifier, held as data.
 *
 * The wrapping half needs a browser; the half that decides what a chain IS does
 * not, and it is the half that can be wrong in a way nobody notices — a
 * classifier that ignored `taskId` would report every read after any write as a
 * forced resolve and rank the innocent above the guilty.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyGeometryChains,
  type ChainLogEntry,
} from "../geometry-chain-probe";

let seq = 0;

function entry(
  kind: "read" | "write",
  name: string,
  taskId: number,
  stack: string,
  ms = 0,
): ChainLogEntry {
  seq += 1;
  return { seq, t: seq, ms, kind, name, taskId, stack };
}

describe("classifyGeometryChains", () => {
  test("a read, a write and a read in one task is one chain", () => {
    const reading = classifyGeometryChains([
      entry("read", "clientWidth", 1, "at measure (a.ts:1)"),
      entry("write", "setProperty", 1, "at apply (b.ts:2)"),
      entry("read", "offsetWidth", 1, "at remeasure (c.ts:3)"),
    ]);
    expect(reading.chains).toBe(1);
    expect(reading.tasks).toBe(1);
    expect(reading.ranked[0].site).toBe("at remeasure (c.ts:3)");
    expect(reading.ranked[0].names).toEqual(["offsetWidth"]);
    expect(reading.ranked[0].writeSites).toEqual(["at apply (b.ts:2)"]);
  });

  test("the same three entries across two tasks are not a chain", () => {
    const reading = classifyGeometryChains([
      entry("read", "clientWidth", 1, "at measure (a.ts:1)"),
      entry("write", "setProperty", 1, "at apply (b.ts:2)"),
      entry("read", "offsetWidth", 2, "at remeasure (c.ts:3)"),
    ]);
    expect(reading.chains).toBe(0);
    expect(reading.tasks).toBe(2);
    expect(reading.ranked).toEqual([]);
  });

  test("two chains sharing a reading site are grouped and counted", () => {
    const reading = classifyGeometryChains([
      entry("read", "clientWidth", 1, "at loop (a.ts:1)"),
      entry("write", "setProperty", 1, "at applyOne (b.ts:2)"),
      entry("read", "clientWidth", 1, "at loop (a.ts:1)"),
      entry("write", "setAttribute", 1, "at applyTwo (b.ts:9)"),
      entry("read", "clientWidth", 1, "at loop (a.ts:1)"),
    ]);
    expect(reading.chains).toBe(2);
    expect(reading.ranked.length).toBe(1);
    expect(reading.ranked[0].chains).toBe(2);
    expect(reading.ranked[0].writeSites.length).toBe(2);
  });

  test("a read with no write before it pays nothing", () => {
    const reading = classifyGeometryChains([
      entry("read", "clientWidth", 1, "at measure (a.ts:1)"),
      entry("read", "clientHeight", 1, "at measure (a.ts:2)"),
      entry("read", "offsetWidth", 1, "at measure (a.ts:3)"),
    ]);
    expect(reading.chains).toBe(0);
  });

  test("a write before any read in the task starts no chain", () => {
    const reading = classifyGeometryChains([
      entry("write", "setProperty", 1, "at apply (b.ts:2)"),
      entry("read", "clientWidth", 1, "at measure (a.ts:1)"),
    ]);
    expect(reading.chains).toBe(0);
  });

  test("the ranking is by chains, descending", () => {
    const reading = classifyGeometryChains([
      entry("read", "clientWidth", 1, "at once (a.ts:1)"),
      entry("write", "setProperty", 1, "at apply (b.ts:2)"),
      entry("read", "clientWidth", 1, "at once (a.ts:1)"),
      entry("read", "clientHeight", 2, "at twice (c.ts:1)"),
      entry("write", "setProperty", 2, "at apply (b.ts:2)"),
      entry("read", "clientHeight", 2, "at twice (c.ts:1)"),
      entry("write", "setProperty", 2, "at apply (b.ts:2)"),
      entry("read", "clientHeight", 2, "at twice (c.ts:1)"),
    ]);
    expect(reading.ranked[0].site).toBe("at twice (c.ts:1)");
    expect(reading.ranked[0].chains).toBe(2);
    expect(reading.ranked[1].chains).toBe(1);
  });

  test("a truncated log reports the reading as a lower bound", () => {
    const reading = classifyGeometryChains(
      [entry("read", "clientWidth", 1, "at measure (a.ts:1)")],
      true,
    );
    expect(reading.truncated).toBe(true);
    expect(reading.entries).toBe(1);
  });

  test("each chain is timed by its paying read, summed per site", () => {
    seq = 100;
    const reading = classifyGeometryChains([
      entry("read", "clientWidth", 1, "at loop (a.ts:1)", 9),
      entry("write", "setProperty", 1, "at apply (b.ts:2)", 4),
      entry("read", "clientWidth", 1, "at loop (a.ts:1)", 3),
      entry("write", "setProperty", 1, "at apply (b.ts:2)", 4),
      entry("read", "clientWidth", 1, "at loop (a.ts:1)", 5),
      entry("read", "clientHeight", 2, "at once (c.ts:1)", 1),
      entry("write", "setAttribute", 2, "at mark (d.ts:1)", 1),
      entry("read", "clientHeight", 2, "at once (c.ts:1)", 7),
    ]);
    // The first read of each task pays nothing, and the writes are never a
    // chain's cost: only the closing read forced the layout.
    expect(reading.chains).toBe(3);
    expect(reading.longestChainMs).toBe(7);
    expect(reading.totalChainMs).toBe(15);
    expect(reading.chainTimes).toEqual([
      {
        t: 103,
        ms: 3,
        taskId: 1,
        name: "clientWidth",
        site: "at loop (a.ts:1)",
        writes: [{ name: "setProperty", site: "at apply (b.ts:2)" }],
      },
      {
        t: 105,
        ms: 5,
        taskId: 1,
        name: "clientWidth",
        site: "at loop (a.ts:1)",
        writes: [{ name: "setProperty", site: "at apply (b.ts:2)" }],
      },
      {
        t: 108,
        ms: 7,
        taskId: 2,
        name: "clientHeight",
        site: "at once (c.ts:1)",
        writes: [{ name: "setAttribute", site: "at mark (d.ts:1)" }],
      },
    ]);
    const loop = reading.ranked.find((s) => s.site === "at loop (a.ts:1)");
    const once = reading.ranked.find((s) => s.site === "at once (c.ts:1)");
    expect(loop?.ms).toBe(8);
    expect(once?.ms).toBe(7);
  });

  test("an empty log reads zero ms, not -Infinity", () => {
    const reading = classifyGeometryChains([]);
    expect(reading.longestChainMs).toBe(0);
    expect(reading.totalChainMs).toBe(0);
    expect(reading.chainTimes).toEqual([]);
  });

  test("a log armed without stacks still counts its chains", () => {
    const reading = classifyGeometryChains([
      entry("read", "clientWidth", 1, "<no stack>", 1),
      entry("write", "setProperty", 1, "<no stack>", 1),
      entry("read", "clientHeight", 1, "<no stack>", 2),
      entry("write", "setProperty", 1, "<no stack>", 1),
      entry("read", "offsetWidth", 1, "<no stack>", 4),
    ]);
    expect(reading.chains).toBe(2);
    expect(reading.totalChainMs).toBe(6);
    expect(reading.ranked.length).toBe(1);
    expect(reading.ranked[0].site).toBe("<no stack>");
    expect(reading.ranked[0].chains).toBe(2);
  });
});

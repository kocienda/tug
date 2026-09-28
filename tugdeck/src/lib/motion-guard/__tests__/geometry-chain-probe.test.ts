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
): ChainLogEntry {
  seq += 1;
  return { seq, t: seq, kind, name, taskId, stack };
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
});

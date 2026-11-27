/**
 * changeset-types — the cycle entry guard accepts an entry from a server that
 * sends the queued-work fields and one from a server that predates them, and
 * refuses a field of the wrong type rather than letting it through.
 */

import { describe, test, expect } from "bun:test";

import { isCycleEntryWire, isCycleWire } from "../changeset-types";

const bare = {
  n: 1,
  brief: "briefs/one.md",
  waits: [],
  added: "2026-11-27T00:00:00.000Z",
  state: "ready",
};

const queued = {
  ...bare,
  brief_id: "0a1b2c3d",
  name: "alpha",
  label: "the first",
  stated_by: { session: "sess-q", turn: 3 },
  listed: true,
};

describe("isCycleEntryWire", () => {
  test("accepts an entry with and without the queued-work fields", () => {
    expect(isCycleEntryWire(bare)).toBe(true);
    expect(isCycleEntryWire(queued)).toBe(true);
    expect(isCycleEntryWire({ ...queued, stated_by: { session: "sess-q" } })).toBe(true);
  });

  test("refuses a field of the wrong type", () => {
    expect(isCycleEntryWire({ ...queued, listed: "yes" })).toBe(false);
    expect(isCycleEntryWire({ ...queued, stated_by: { turn: 3 } })).toBe(false);
    expect(isCycleEntryWire({ ...queued, name: 4 })).toBe(false);
  });
});

describe("isCycleWire", () => {
  const cycle = {
    id: "3f9a1c2e",
    name: "Cycle",
    created: "2026-11-27T00:00:00.000Z",
    updated: "2026-11-27T00:00:00.000Z",
    project_dir: "/u/src/proj",
    entries: [queued],
    landed: 0,
  };

  test("reads the run's counts when they are sent, and passes without them", () => {
    expect(isCycleWire(cycle)).toBe(true);
    expect(isCycleWire({ ...cycle, run_landed: 0, run_total: 1 })).toBe(true);
    expect(isCycleWire({ ...cycle, run_total: "1" })).toBe(false);
  });
});

/**
 * Pure-logic tests for `foldRestoreGate` — the rule that turns the cards
 * holding the restore gate, and the cards a restore pass named, into
 * "n of N sessions" over a total fixed when the round opens.
 *
 * Each test drives the fold with literal holder lists, pass names and a
 * facts table. A card's `holding` fact always agrees with the holder list
 * (the store builds both from the same reports); the other facts default
 * to `waiting: false, live: true, painted: false`.
 *
 * @covers tugdeck/src/lib/restore-gate-round.ts
 */

import { describe, it, expect } from "bun:test";

import {
  CLOSED_READING,
  INITIAL_FOLD,
  foldRestoreGate,
  type RestoreCardFacts,
  type RestoreGateFoldState,
  type RestoreGateReading,
} from "@/lib/restore-gate-round";

type FactsTable = Record<string, Partial<Omit<RestoreCardFacts, "holding">>>;

interface Step {
  state: RestoreGateFoldState;
  reading: RestoreGateReading;
}

function fold(
  prev: RestoreGateFoldState,
  holding: readonly string[],
  table: FactsTable = {},
  arrived: readonly string[] = [],
): Step {
  const holders = new Set(holding);
  return foldRestoreGate(prev, {
    holding: holders,
    arrived,
    facts: (id) => ({
      waiting: false,
      live: true,
      painted: false,
      ...table[id],
      holding: holders.has(id),
    }),
  });
}

function open(done: number, total: number): RestoreGateReading {
  return { open: true, sessionsDone: done, sessionsTotal: total };
}

describe("foldRestoreGate", () => {
  it("keeps a round's total fixed and its done count rising", () => {
    const waiting = { waiting: true };
    const script: Array<[string[], FactsTable, string[]]> = [
      [["a"], { b: waiting, c: waiting, d: waiting, e: waiting }, ["a", "b", "c", "d", "e"]],
      [["a", "b"], { c: waiting, d: waiting, e: waiting }, []],
      [["b"], { c: waiting, d: waiting, e: waiting }, []],
      [["b", "c"], { d: waiting, e: waiting }, []],
      [["c"], { d: waiting, e: waiting }, []],
      [["c", "d"], { e: waiting }, []],
      [["c", "d"], { e: { painted: true } }, []],
      [["c", "d"], { e: { painted: true } }, []],
      [["d"], {}, []],
      [["d"], {}, []],
      [["d"], {}, []],
      [[], {}, []],
    ];
    let state = INITIAL_FOLD;
    const readings: RestoreGateReading[] = [];
    for (const [holding, table, arrived] of script) {
      const next = fold(state, holding, table, arrived);
      state = next.state;
      readings.push(next.reading);
    }
    const opened = readings.filter((r) => r.open);
    expect(opened.length).toBe(11);
    expect(new Set(opened.map((r) => r.sessionsTotal))).toEqual(new Set([5]));
    const dones = opened.map((r) => r.sessionsDone);
    for (let i = 1; i < dones.length; i++) {
      expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1]);
    }
    expect(dones).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
    expect(readings[readings.length - 1]).toEqual(CLOSED_READING);
    expect(state.round).toBeNull();
  });

  it("opens a round of three when a pass names three and one holds", () => {
    const { reading } = fold(
      INITIAL_FOLD,
      ["a"],
      { b: { waiting: true }, c: { waiting: true } },
      ["a", "b", "c"],
    );
    expect(reading).toEqual(open(0, 3));
  });

  it("leaves the total alone for a late holder, then rolls over to it", () => {
    let s = fold(INITIAL_FOLD, ["a"], { b: { waiting: true } }, ["a", "b"]);
    expect(s.reading).toEqual(open(0, 2));
    s = fold(s.state, ["a", "x"], { b: { waiting: true } });
    expect(s.reading).toEqual(open(0, 2));
    s = fold(s.state, ["a", "x"], { b: { live: false } });
    expect(s.reading).toEqual(open(1, 2));
    s = fold(s.state, ["x"], { a: { painted: true } });
    expect(s.reading).toEqual(open(0, 1));
    expect([...(s.state.round?.members ?? [])]).toEqual(["x"]);
  });

  it("counts a member done when its hold ends, settled or errored alike", () => {
    let s = fold(INITIAL_FOLD, ["a", "b", "c"]);
    expect(s.reading).toEqual(open(0, 3));
    // `a` settled: its page painted and its body reports nothing.
    s = fold(s.state, ["b", "c"], { a: { painted: true } });
    expect(s.reading).toEqual(open(1, 3));
    // `b` errored: its body reports nothing either; the fold cannot tell.
    s = fold(s.state, ["c"], { a: { painted: true }, b: { painted: true } });
    expect(s.reading).toEqual(open(2, 3));
  });

  it("counts a member that never held done when it leaves, falls silent, or paints unreported", () => {
    let s = fold(
      INITIAL_FOLD,
      ["x"],
      { p: { waiting: true }, q: { waiting: true } },
      ["x", "p", "q", "r"],
    );
    expect(s.reading).toEqual(open(0, 4));
    // `p` leaves the deck.
    s = fold(s.state, ["x"], { p: { live: false }, q: { waiting: true } });
    expect(s.reading).toEqual(open(1, 4));
    // `q` reported waiting and now reports nothing.
    s = fold(s.state, ["x"], { p: { live: false } });
    expect(s.reading).toEqual(open(2, 4));
    // `r` never reported; its page paints.
    s = fold(s.state, ["x"], { p: { live: false }, r: { painted: true } });
    expect(s.reading).toEqual(open(3, 4));
  });

  it("does not count a member reporting waiting", () => {
    let s = fold(INITIAL_FOLD, ["a"], { b: { waiting: true, painted: true } }, ["a", "b"]);
    for (let i = 0; i < 3; i++) {
      s = fold(s.state, ["a"], { b: { waiting: true, painted: true } });
      expect(s.reading).toEqual(open(0, 2));
    }
  });

  it("keeps a round with a pending member across a closed gate", () => {
    let s = fold(INITIAL_FOLD, ["a"], { b: { waiting: true } }, ["a", "b"]);
    expect(s.reading).toEqual(open(0, 2));
    s = fold(s.state, [], { a: { painted: true }, b: { waiting: true } });
    expect(s.reading).toEqual(CLOSED_READING);
    expect(s.state.round?.members.size).toBe(2);
    s = fold(s.state, ["b"], { a: { painted: true } });
    expect(s.reading).toEqual(open(1, 2));
  });

  it("ends a round whose members are all done, and opens a fresh one later", () => {
    let s = fold(INITIAL_FOLD, ["a"]);
    expect(s.reading).toEqual(open(0, 1));
    s = fold(s.state, [], { a: { painted: true } });
    expect(s.reading).toEqual(CLOSED_READING);
    expect(s.state.round).toBeNull();
    s = fold(s.state, ["b"], { a: { painted: true } });
    expect(s.reading).toEqual(open(0, 1));
    expect([...(s.state.round?.members ?? [])]).toEqual(["b"]);
  });

  it("leaves nothing behind when a pass's cards all end without holding", () => {
    let s = fold(INITIAL_FOLD, [], { b: { live: false }, c: { painted: true } }, ["b", "c"]);
    expect(s.reading).toEqual(CLOSED_READING);
    expect(s.state.expected.size).toBe(0);
    expect(s.state.seen.size).toBe(0);
    s = fold(s.state, ["x"], { b: { live: false }, c: { painted: true } });
    expect(s.reading).toEqual(open(0, 1));
  });

  it("reads equal by value for an unchanged input", () => {
    const table: FactsTable = { b: { waiting: true } };
    const first = fold(INITIAL_FOLD, ["a"], table, ["a", "b"]);
    const second = fold(first.state, ["a"], table);
    const third = fold(second.state, ["a"], table);
    expect(second.reading).toEqual(first.reading);
    expect(third.reading).toEqual(second.reading);
    const closed = fold(INITIAL_FOLD, []);
    expect(fold(closed.state, []).reading).toEqual(closed.reading);
  });
});

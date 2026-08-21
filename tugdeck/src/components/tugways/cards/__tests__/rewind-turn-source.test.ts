/**
 * rewind-turn-source.test.ts — `/rewind` message-list projection ([#step-7-3]).
 *
 * Pins the pure projection: every user message becomes a row carrying its own
 * text, time, anchor, and attachments (targetable = user opener + anchor), the
 * ordering, the two-message floor that gates whether `/rewind` is offered, and
 * the data source's blocked-cut enablement.
 *
 * @module components/tugways/cards/__tests__/rewind-turn-source
 */

import { describe, expect, test } from "bun:test";

import {
  projectRewindTurns,
  canOfferRewind,
  REWIND_MESSAGE_KIND,
  RewindTurnDataSource,
} from "@/components/tugways/cards/rewind-turn-source";
import type { Message, TurnEntry } from "@/lib/code-session-store/types";
import { TURN_ENTRY_TELEMETRY_DEFAULTS } from "@/lib/code-session-store/testing/turn-entry-defaults";

function userTurn(
  turnKey: string,
  promptUuid: string | undefined,
  text: string,
  submitAt: number,
): TurnEntry {
  const opener: Message = {
    kind: "user_message",
    messageKey: `${turnKey}-user`,
    createdAt: submitAt,
    text,
    attachments: [],
    submitAt,
  };
  return {
    turnKey,
    msgId: `m-${turnKey}`,
    ...(promptUuid !== undefined ? { promptUuid } : {}),
    messages: [opener],
    result: "success",
    endedAt: submitAt + 1,
    ...TURN_ENTRY_TELEMETRY_DEFAULTS,
  };
}

function wakeTurn(turnKey: string): TurnEntry {
  // A wake turn opens with assistant content, no user_message.
  const opener: Message = {
    kind: "assistant_text",
    messageKey: `m-${turnKey}-b0`,
    createdAt: 0,
    text: "woke",
  };
  return {
    turnKey,
    msgId: `m-${turnKey}`,
    messages: [opener],
    result: "success",
    endedAt: 0,
    ...TURN_ENTRY_TELEMETRY_DEFAULTS,
  };
}

describe("projectRewindTurns", () => {
  test("one row per user message, as typed, with its own anchor", () => {
    const rows = projectRewindTurns([
      userTurn("t1", "uuid-1", "first prompt", 100),
      userTurn("t2", "uuid-2", "second prompt", 200),
    ]);
    expect(rows).toEqual([
      {
        promptUuid: "uuid-1",
        turnKey: "t1",
        text: "first prompt",
        submitAt: 100,
        atoms: [],
      },
      {
        promptUuid: "uuid-2",
        turnKey: "t2",
        text: "second prompt",
        submitAt: 200,
        atoms: [],
      },
    ]);
  });

  test("keeps conversation order (oldest first), newest message included", () => {
    const rows = projectRewindTurns([
      userTurn("t1", "uuid-1", "a", 1),
      userTurn("t2", "uuid-2", "b", 2),
      userTurn("t3", "uuid-3", "c", 3),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.promptUuid)).toEqual([
      "uuid-1",
      "uuid-2",
      "uuid-3",
    ]);
    expect(rows.map((r) => r.turnKey)).toEqual(["t1", "t2", "t3"]);
  });

  test("carries each message's attachments (the re-edit draft atoms)", () => {
    const atom = {
      kind: "atom" as const,
      type: "image",
      label: "shot.png",
      value: "shot.png",
      id: "atom-1",
    };
    const turn = userTurn("t2", "uuid-2", "with attachment", 2);
    (turn.messages[0] as unknown as { attachments: unknown[] }).attachments = [
      atom,
    ];
    const rows = projectRewindTurns([
      userTurn("t1", "uuid-1", "first", 1),
      turn,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].atoms).toEqual([atom]);
  });

  test("skips turns with no anchor (older / pre-[#step-7-1] sessions)", () => {
    const rows = projectRewindTurns([
      userTurn("t1", undefined, "no anchor", 1),
      userTurn("t2", "uuid-2", "has anchor", 2),
      userTurn("t3", "uuid-3", "also anchored", 3),
    ]);
    expect(rows.map((r) => r.promptUuid)).toEqual(["uuid-2", "uuid-3"]);
    expect(rows.map((r) => r.text)).toEqual(["has anchor", "also anchored"]);
  });

  test("skips wake turns (no user_message opener)", () => {
    const rows = projectRewindTurns([
      userTurn("t1", "uuid-1", "real", 1),
      userTurn("t2", "uuid-2", "real2", 2),
      wakeTurn("w1"),
    ]);
    expect(rows.map((r) => r.turnKey)).toEqual(["t1", "t2"]);
  });

  test("empty transcript → no rows", () => {
    expect(projectRewindTurns([])).toEqual([]);
  });
});

describe("canOfferRewind (empty-state gating)", () => {
  test("false below two messages; true once a cut has both sides", () => {
    expect(canOfferRewind([])).toBe(false);
    expect(canOfferRewind([userTurn("t1", "uuid-1", "only", 1)])).toBe(false);
    expect(
      canOfferRewind([
        userTurn("t1", "uuid-1", "a", 1),
        userTurn("t2", "uuid-2", "b", 2),
      ]),
    ).toBe(true);
  });

  test("false when only one turn carries an anchor", () => {
    expect(
      canOfferRewind([
        userTurn("t1", "uuid-1", "a", 1),
        userTurn("t2", undefined, "b", 2),
      ]),
    ).toBe(false);
  });
});

describe("RewindTurnDataSource", () => {
  const rows = projectRewindTurns([
    userTurn("t1", "uuid-1", "a", 1),
    userTurn("t2", "uuid-2", "b", 2),
    userTurn("t3", "uuid-3", "c", 3),
  ]);

  test("indexes every message by promptUuid and exposes it by index", () => {
    const ds = new RewindTurnDataSource(rows);
    expect(ds.numberOfItems()).toBe(3);
    expect(ds.idForIndex(0)).toBe("uuid-1");
    expect(ds.kindForIndex()).toBe(REWIND_MESSAGE_KIND);
    expect(ds.rowAt(1).text).toBe("b");
  });

  test("blocked cuts disable their row and tick subscribers", () => {
    const ds = new RewindTurnDataSource(rows);
    let ticks = 0;
    const unsubscribe = ds.subscribe(() => {
      ticks += 1;
    });
    expect(ds.enabledForIndex(0)).toBe(true);

    ds.setBlockedCuts(new Set([0]));
    expect(ticks).toBe(1);
    expect(ds.enabledForIndex(0)).toBe(false);
    expect(ds.enabledForIndex(1)).toBe(true);

    // The row set never changes, so the identity holds and the list keeps its
    // selection; only the version moves.
    const version = ds.getVersion();
    ds.setBlockedCuts(new Set());
    expect(ds.getVersion()).not.toBe(version);
    expect(ds.enabledForIndex(0)).toBe(true);

    unsubscribe();
    ds.setBlockedCuts(new Set([1]));
    expect(ticks).toBe(2);
  });
});

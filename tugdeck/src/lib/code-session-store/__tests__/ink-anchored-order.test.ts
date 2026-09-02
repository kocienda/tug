/**
 * Anchored placement for restored ink rows.
 *
 * A durable ink row records, at write time, the transcript turn it followed.
 * On restore it seats itself after that turn instead of re-deriving a position
 * from clocks — the derivation that put a `/arc-join` receipt five thousand
 * pixels above the transcript's end after a relaunch, because a replayed
 * assistant turn wore the relaunch wall-clock.
 *
 * These exercise the pure reducer helpers directly: placement resolution,
 * sibling order, the fallback, the hoist that converges both boot-race arrival
 * orders, and the mint that no longer fabricates a timestamp.
 */
import { describe, it, expect } from "bun:test";

import {
  appendTurnInterleavingInk,
  createInitialState,
  deriveActiveTurnSnapshot,
  insertInkAnchored,
  reduce,
  upsertInkTurn,
} from "@/lib/code-session-store/reducer";
import type { TurnEntry, TurnOrigin } from "@/lib/code-session-store/types";

/**
 * A committed turn. `messageKeys` overrides the single synthesized Message key
 * so a test can give a Claude turn the `${msgId}-b${n}` shape the wire mints.
 */
function turn(opts: {
  turnKey: string;
  msgId: string;
  origin: TurnOrigin;
  endedAt: number;
  anchorMsgId?: string;
  messageKeys?: string[];
}): TurnEntry {
  const keys = opts.messageKeys ?? [`${opts.turnKey}-m`];
  return {
    turnKey: opts.turnKey,
    msgId: opts.msgId,
    origin: opts.origin,
    ...(opts.anchorMsgId !== undefined ? { anchorMsgId: opts.anchorMsgId } : {}),
    messages: keys.map((messageKey) => ({
      kind: "system_note",
      messageKey,
      createdAt: opts.endedAt,
      text: "",
      source: "other",
    })),
    result: "success",
    endedAt: opts.endedAt,
    wallClockMs: 0,
    awaitingApprovalMs: 0,
    transportDowntimeMs: 0,
    activeMs: 0,
    ttftMs: null,
    ttftcMs: null,
    reconnectCount: 0,
    maxStreamGapMs: 0,
    turnEndReason: "complete",
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
    },
  } as TurnEntry;
}

/** A Claude turn keyed on a real-shaped assistant `message.id`. */
function claudeTurn(msgId: string, endedAt: number): TurnEntry {
  return turn({
    turnKey: `t-${msgId}`,
    msgId,
    origin: "assistant",
    endedAt,
    messageKeys: [`${msgId}-b0`],
  });
}

/** A restored shell row: ledger id `id`, anchored to `anchor`. */
function shellRow(id: number, endedAt: number, anchor?: string): TurnEntry {
  return turn({
    turnKey: `shell-restored-${id}`,
    msgId: `restored-${id}`,
    origin: "shell",
    endedAt,
    anchorMsgId: anchor,
  });
}

const keys = (ts: ReadonlyArray<TurnEntry>): string[] => ts.map((t) => t.turnKey);

describe("insertInkAnchored — a row seats where it was written", () => {
  it("seats the row immediately after its anchor turn", () => {
    // The incident, in miniature: the receipt was written after the last turn,
    // and a clock sort put it before one — with a very tall report between.
    const transcript = [
      claudeTurn("msg_01A", 1_000),
      claudeTurn("msg_01B", 2_000),
      claudeTurn("msg_01C", 3_000),
    ];
    const receipt = shellRow(1124, 2_500, "msg_01C");

    expect(keys(insertInkAnchored(transcript, receipt))).toEqual([
      "t-msg_01A",
      "t-msg_01B",
      "t-msg_01C",
      "shell-restored-1124",
    ]);
  });

  it("beats the timestamp sort that misplaced the row", () => {
    // The anchor turn wears a *later* timestamp than the receipt — exactly the
    // fabricated-mint shape. Anchored placement ignores the clock entirely.
    const transcript = [claudeTurn("msg_01A", 1_000), claudeTurn("msg_01C", 9_999_999)];
    const receipt = shellRow(1124, 2_500, "msg_01C");

    expect(keys(insertInkAnchored(transcript, receipt))).toEqual([
      "t-msg_01A",
      "t-msg_01C",
      "shell-restored-1124",
    ]);
  });

  it("takes the LAST turn answering to the anchor", () => {
    // A compacted transcript can re-append one `message.id`. The row followed
    // the later appearance — that is where the user watched it land.
    const transcript = [
      claudeTurn("msg_01A", 1_000),
      claudeTurn("msg_01B", 2_000),
      turn({
        turnKey: "t-msg_01A-again",
        msgId: "msg_01Z",
        origin: "assistant",
        endedAt: 3_000,
        messageKeys: ["msg_01A-b0"],
      }),
    ];

    expect(keys(insertInkAnchored(transcript, shellRow(7, 3_500, "msg_01A")))).toEqual([
      "t-msg_01A",
      "t-msg_01B",
      "t-msg_01A-again",
      "shell-restored-7",
    ]);
  });

  it("resolves an anchor through a Message key when the turn's msgId moved on", () => {
    const transcript = [
      claudeTurn("msg_01A", 1_000),
      turn({
        turnKey: "t-multi",
        msgId: "msg_01LATER",
        origin: "assistant",
        endedAt: 2_000,
        messageKeys: ["msg_01EARLY-b0", "msg_01LATER-b1"],
      }),
    ];

    expect(keys(insertInkAnchored(transcript, shellRow(9, 500, "msg_01EARLY")))).toEqual([
      "t-msg_01A",
      "t-multi",
      "shell-restored-9",
    ]);
  });

  it("orders siblings by settle time, then by ledger row id", () => {
    const transcript = [claudeTurn("msg_01A", 1_000)];
    let out = insertInkAnchored(transcript, shellRow(20, 5_000, "msg_01A"));
    // Same settle time, lower id → before row 20.
    out = insertInkAnchored(out, shellRow(10, 5_000, "msg_01A"));
    // Later settle time → after both, despite the lowest id.
    out = insertInkAnchored(out, shellRow(3, 9_000, "msg_01A"));
    // Earlier settle time → first, despite the highest id.
    out = insertInkAnchored(out, shellRow(99, 1_500, "msg_01A"));

    expect(keys(out)).toEqual([
      "t-msg_01A",
      "shell-restored-99",
      "shell-restored-10",
      "shell-restored-20",
      "shell-restored-3",
    ]);
  });

  it("a row with no anchor falls back to timestamp placement", () => {
    // A legacy row, or a row from a session with no assistant turn behind it.
    const transcript = [claudeTurn("msg_01A", 1_000), claudeTurn("msg_01C", 9_000)];

    expect(keys(insertInkAnchored(transcript, shellRow(1, 5_000)))).toEqual([
      "t-msg_01A",
      "shell-restored-1",
      "t-msg_01C",
    ]);
  });

  it("an anchor naming a turn outside the loaded window falls back, never drops", () => {
    // The common case at first paint on a long session: ink restores whole,
    // Claude turns load windowed. R02 — a fallback here is by design.
    const transcript = [claudeTurn("msg_01LATE", 9_000)];
    const out = insertInkAnchored(transcript, shellRow(1, 5_000, "msg_01ANCIENT"));

    expect(keys(out)).toEqual(["shell-restored-1", "t-msg_01LATE"]);
    expect(out).toHaveLength(2);
  });
});

describe("the hoist — both boot-race arrival orders converge", () => {
  it("a late-arriving anchor turn collects the ink already seated by timestamp", () => {
    // The ledger restore beat the JSONL replay: the row seated by timestamp
    // against turns that did not exist yet.
    const seated = insertInkAnchored([claudeTurn("msg_01A", 1_000)], shellRow(1, 2_000, "msg_01C"));
    expect(keys(seated)).toEqual(["t-msg_01A", "shell-restored-1"]);

    const out = appendTurnInterleavingInk(seated, claudeTurn("msg_01C", 3_000));
    expect(keys(out)).toEqual(["t-msg_01A", "t-msg_01C", "shell-restored-1"]);
  });

  it("restore-first and replay-first end at the same transcript", () => {
    const turns = [claudeTurn("msg_01A", 1_000), claudeTurn("msg_01C", 9_999_999)];
    const receipt = shellRow(1124, 2_500, "msg_01C");

    // Replay first, then the restore.
    let replayFirst: TurnEntry[] = [];
    for (const t of turns) replayFirst = appendTurnInterleavingInk(replayFirst, t);
    replayFirst = upsertInkTurn(replayFirst, receipt);

    // The restore first, then the replay.
    let restoreFirst = upsertInkTurn([], receipt);
    for (const t of turns) restoreFirst = appendTurnInterleavingInk(restoreFirst, t);

    expect(keys(replayFirst)).toEqual(keys(restoreFirst));
    expect(keys(replayFirst)).toEqual([
      "t-msg_01A",
      "t-msg_01C",
      "shell-restored-1124",
    ]);
  });

  it("the hoist preserves sibling order", () => {
    let seated: TurnEntry[] = [];
    seated = upsertInkTurn(seated, shellRow(20, 5_000, "msg_01C"));
    seated = upsertInkTurn(seated, shellRow(10, 5_000, "msg_01C"));

    const out = appendTurnInterleavingInk(seated, claudeTurn("msg_01C", 1_000));
    expect(keys(out)).toEqual(["t-msg_01C", "shell-restored-10", "shell-restored-20"]);
  });

  it("leaves ink anchored elsewhere alone", () => {
    const seated = upsertInkTurn([claudeTurn("msg_01A", 1_000)], shellRow(1, 2_000, "msg_01OTHER"));
    const out = appendTurnInterleavingInk(seated, claudeTurn("msg_01C", 3_000));

    expect(keys(out)).toEqual(["t-msg_01A", "shell-restored-1", "t-msg_01C"]);
  });

  it("an arriving ink turn never hoists anything", () => {
    // Only a Claude turn is an anchor target; ink appending must not reorder.
    const seated = upsertInkTurn([claudeTurn("msg_01A", 1_000)], shellRow(1, 2_000, "msg_01A"));
    const out = appendTurnInterleavingInk(seated, shellRow(2, 3_000));

    expect(keys(out)).toEqual(["t-msg_01A", "shell-restored-1", "shell-restored-2"]);
  });
});

describe("upsertInkTurn — settle still replaces in place", () => {
  it("a same-turnKey settle keeps the row's position", () => {
    const transcript = [
      claudeTurn("msg_01A", 1_000),
      shellRow(1, 2_000, "msg_01A"),
      claudeTurn("msg_01C", 3_000),
    ];
    const settled = shellRow(1, 2_500, "msg_01A");

    const out = upsertInkTurn(transcript, settled);
    expect(keys(out)).toEqual(["t-msg_01A", "shell-restored-1", "t-msg_01C"]);
    expect(out[1]!.endedAt).toBe(2_500);
  });

  it("a live row with no anchor still mints at the end", () => {
    // [P06]: the end IS its correct position at the moment of the act.
    const transcript = [claudeTurn("msg_01A", 1_000), claudeTurn("msg_01C", 2_000)];
    const live = turn({
      turnKey: "shell-live-1",
      msgId: "live-1",
      origin: "shell",
      endedAt: 3_000,
    });

    expect(keys(upsertInkTurn(transcript, live))).toEqual([
      "t-msg_01A",
      "t-msg_01C",
      "shell-live-1",
    ]);
  });
});

describe("the mint no longer fabricates a time", () => {
  /** `createdAt` of the Message a `content_block_start` mints. */
  function mintedCreatedAt(event: Record<string, unknown>): number {
    const opened = reduce(createInitialState("session", "test", "new"), {
      type: "send",
      text: "hi",
      atoms: [],
      content: [{ type: "text" as const, text: "hi" }],
      turnKey: "k",
    } as never);
    const after = reduce(opened.state, event as never);
    const message = deriveActiveTurnSnapshot(after.state)!.messages.find(
      (m) => m.kind === "assistant_text",
    );
    expect(message).toBeDefined();
    return message!.createdAt;
  }

  it("mints a replayed block at the entry's historical time", () => {
    // 2026-08-24T17:37:37Z — the incident's real turn time, against the
    // 17:42:13 relaunch clock the old mint would have stamped.
    const historical = Date.parse("2026-08-24T17:37:37.000Z");
    expect(
      mintedCreatedAt({
        type: "content_block_start",
        msg_id: "m",
        block_index: 0,
        kind: "text",
        timestamp: historical,
      }),
    ).toBe(historical);
  });

  it("mints a live block at the wall clock, as it always did", () => {
    const before = Date.now();
    const minted = mintedCreatedAt({
      type: "content_block_start",
      msg_id: "m",
      block_index: 0,
      kind: "text",
    });
    expect(minted).toBeGreaterThanOrEqual(before);
    expect(minted).toBeLessThanOrEqual(Date.now());
  });
});

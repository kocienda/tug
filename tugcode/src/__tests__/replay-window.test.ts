// Recency windowing — the translator emits only the requested
// committed-turn range and reports the window on `replay_complete`.
//
// These pin the turn-boundary slice (last-N turns; explicit range,
// including load-previous paging; a window larger than the session =
// load-all) and the two edge cases that make boundary detection tricky:
// a same-`message.id` continuation (one turn split across two JSONL
// records must not be split by the window) and an orphan-synthesized
// turn (interrupted, no clean terminal) landing on the correct side of
// the cut with no partial / duplicate turn.

import { describe, expect, test } from "bun:test";

import { translateJsonlSession } from "../replay.ts";
import type { ReplayWindow } from "../types.ts";
import type {
  OutboundMessage,
  ReplayComplete,
  TurnComplete,
  AddUserMessage,
} from "../types.ts";

async function collectSession(
  jsonl: string,
  opts: {
    window?: ReplayWindow;
    synthesizeDanglingTerminal?: boolean;
  } = {},
): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  for await (const m of translateJsonlSession(
    { kind: "ok", jsonl, claudeSessionId: "sess-window" },
    {
      disableYield: true,
      synthesizeDanglingTerminal: opts.synthesizeDanglingTerminal ?? true,
      window: opts.window,
    },
  )) {
    out.push(m);
  }
  return out;
}

const userTextEntry = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });

const assistantEntry = (
  msgId: string,
  stopReason: string | null,
  text: string,
): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      id: msgId,
      stop_reason: stopReason,
      content: [{ type: "text", text }],
    },
  });

const addUserMessagesOf = (out: OutboundMessage[]): AddUserMessage[] =>
  out.filter((m): m is AddUserMessage => m.type === "add_user_message");
const turnCompletesOf = (out: OutboundMessage[]): TurnComplete[] =>
  out.filter((m): m is TurnComplete => m.type === "turn_complete");
const replayCompleteOf = (
  out: OutboundMessage[],
): ReplayComplete | undefined =>
  out.find((m): m is ReplayComplete => m.type === "replay_complete");
const userTextsOf = (out: OutboundMessage[]): string[] =>
  addUserMessagesOf(out).map((m) =>
    m.content[0] !== undefined && m.content[0].type === "text"
      ? m.content[0].text
      : "",
  );

/** A session of `k` clean turns: turn i is `u{i}` + assistant `msg{i}`
 *  ending on `end_turn`. */
const cleanSession = (k: number): string => {
  const lines: string[] = [];
  for (let i = 0; i < k; i++) {
    lines.push(userTextEntry(`u${i}`));
    lines.push(assistantEntry(`msg${i}`, "end_turn", `a${i}`));
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// last-N turns slice
// ---------------------------------------------------------------------------

describe("translateJsonlSession — last-N-turns window", () => {
  // Each clean turn is 2 messages (user row + assistant row).
  test("emits the trailing N turns", async () => {
    // 5 turns; last 2 turns.
    const out = await collectSession(cleanSession(5), {
      window: { lastTurns: 2 },
    });

    expect(userTextsOf(out)).toEqual(["u3", "u4"]);
    expect(turnCompletesOf(out)).toHaveLength(2);

    const complete = replayCompleteOf(out);
    expect(complete?.count).toBe(2);
    expect(complete?.totalTurns).toBe(5);
    expect(complete?.firstLoadedTurnIndex).toBe(3);
    expect(complete?.hasOlder).toBe(true);
  });

  test("a session with <= N turns loads whole and reports hasOlder false", async () => {
    // 3 turns, window of 50 → all.
    const out = await collectSession(cleanSession(3), {
      window: { lastTurns: 50 },
    });

    expect(userTextsOf(out)).toEqual(["u0", "u1", "u2"]);
    const complete = replayCompleteOf(out);
    expect(complete?.count).toBe(3);
    expect(complete?.totalTurns).toBe(3);
    expect(complete?.firstLoadedTurnIndex).toBe(0);
    expect(complete?.hasOlder).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// explicit turn range (the general form; load-previous paging builds on it)
// ---------------------------------------------------------------------------

describe("translateJsonlSession — turnRange window", () => {
  test("emits the half-open [start, end) range above the bottom", async () => {
    // Also models load-previous: viewing from turn 3, page the 2 turns
    // older than it via `[firstLoadedTurnIndex − N, firstLoadedTurnIndex]`.
    const out = await collectSession(cleanSession(5), {
      window: { turnRange: [1, 3] },
    });

    expect(userTextsOf(out)).toEqual(["u1", "u2"]);
    expect(turnCompletesOf(out)).toHaveLength(2);

    const complete = replayCompleteOf(out);
    expect(complete?.count).toBe(2);
    expect(complete?.totalTurns).toBe(5);
    expect(complete?.firstLoadedTurnIndex).toBe(1);
    expect(complete?.hasOlder).toBe(true);
  });

  test("clamps a start below zero to turn 0 (load-all-older, hasOlder false)", async () => {
    // Load-previous past the older span: N beyond what remains drives the
    // start below 0, which clamps to turn 0 and loads everything older.
    const out = await collectSession(cleanSession(5), {
      window: { turnRange: [-100, 3] },
    });

    expect(userTextsOf(out)).toEqual(["u0", "u1", "u2"]);
    const complete = replayCompleteOf(out);
    expect(complete?.firstLoadedTurnIndex).toBe(0);
    expect(complete?.hasOlder).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// no window — legacy, no metadata
// ---------------------------------------------------------------------------

describe("translateJsonlSession — no window (legacy)", () => {
  test("loads the whole session and omits window metadata", async () => {
    const out = await collectSession(cleanSession(4));

    expect(userTextsOf(out)).toEqual(["u0", "u1", "u2", "u3"]);
    const complete = replayCompleteOf(out);
    expect(complete?.count).toBe(4);
    expect(complete?.firstLoadedTurnIndex).toBeUndefined();
    expect(complete?.totalTurns).toBeUndefined();
    expect(complete?.hasOlder).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// same-message.id continuation — one turn, never split by the window
// ---------------------------------------------------------------------------

describe("translateJsonlSession — continuation at the window edge", () => {
  // Turn 1's assistant message is split across two JSONL records sharing
  // `msgB` (each carrying `end_turn`). It is ONE committed turn; a window
  // must include both records and emit exactly one turn_complete for it.
  const continuationSession = [
    userTextEntry("u0"),
    assistantEntry("msgA", "end_turn", "a0"),
    userTextEntry("u1"),
    assistantEntry("msgB", "end_turn", "b-think"),
    assistantEntry("msgB", "end_turn", "b-text"),
    userTextEntry("u2"),
    assistantEntry("msgC", "end_turn", "a2"),
  ].join("\n");

  test("counts a split-message turn once; window keeps it whole", async () => {
    // 3 turns total; the last-2-turns window is turns 1 (split) + 2.
    const out = await collectSession(continuationSession, {
      window: { lastTurns: 2 },
    });

    // Three committed turns total (the two msgB records are one turn);
    // the last-2 window is turns 1 (split) + 2.
    const complete = replayCompleteOf(out);
    expect(complete?.totalTurns).toBe(3);
    expect(complete?.firstLoadedTurnIndex).toBe(1);
    expect(complete?.count).toBe(2);

    expect(userTextsOf(out)).toEqual(["u1", "u2"]);
    // Exactly one terminal for the split turn — not two.
    expect(turnCompletesOf(out)).toHaveLength(2);
    // Both halves of the split message are present in the window.
    const texts = out
      .filter((m) => m.type === "assistant_text")
      .map((m) => (m as { text: string }).text);
    expect(texts).toContain("b-think");
    expect(texts).toContain("b-text");
  });
});

// ---------------------------------------------------------------------------
// orphan-synthesized (interrupted) turn at the cut
// ---------------------------------------------------------------------------

describe("translateJsonlSession — interrupted turn at the window edge", () => {
  // Turn 0 never reaches a clean terminal (stop_reason null); it
  // historically commits as `interrupted` when turn 1's opener arrives.
  const interruptedFirst = [
    userTextEntry("u0"),
    assistantEntry("msg0", null, "partial"),
    userTextEntry("u1"),
    assistantEntry("msg1", "end_turn", "a1"),
  ].join("\n");

  test("a bounded range ending before EOF commits its last open turn at the cut", async () => {
    // turnRange [0,1) is just the interrupted turn 0. The next opener
    // (u1) is outside the window, so the cut must force the same
    // interrupted commit the next-opener orphan would have produced.
    const out = await collectSession(interruptedFirst, {
      window: { turnRange: [0, 1] },
      synthesizeDanglingTerminal: false,
    });

    expect(userTextsOf(out)).toEqual(["u0"]);
    const tcs = turnCompletesOf(out);
    expect(tcs).toHaveLength(1);
    expect(tcs[0].result).toBe("interrupted");

    const complete = replayCompleteOf(out);
    expect(complete?.count).toBe(1);
    expect(complete?.totalTurns).toBe(2);
    expect(complete?.firstLoadedTurnIndex).toBe(0);
    expect(complete?.hasOlder).toBe(false);
  });

  test("last-N-turns past an interrupted older turn loads only the clean tail", async () => {
    // 2 turns; last 1 turn = just turn 1.
    const out = await collectSession(interruptedFirst, {
      window: { lastTurns: 1 },
    });

    expect(userTextsOf(out)).toEqual(["u1"]);
    const tcs = turnCompletesOf(out);
    expect(tcs).toHaveLength(1);
    expect(tcs[0].result).toBe("success");

    const complete = replayCompleteOf(out);
    expect(complete?.firstLoadedTurnIndex).toBe(1);
    expect(complete?.hasOlder).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// catch-up: every turn after the newest one the card names
// ---------------------------------------------------------------------------

describe("translateJsonlSession — afterTurn window", () => {
  test("carries every turn after the newest named turn, to the end", async () => {
    const out = await collectSession(cleanSession(5), {
      window: { afterTurn: { msgIds: ["msg2", "msg1"], heldTurns: 99 } },
    });
    expect(userTextsOf(out)).toEqual(["u3", "u4"]);
    const complete = replayCompleteOf(out);
    expect(complete?.firstLoadedTurnIndex).toBe(3);
    expect(complete?.totalTurns).toBe(5);
  });

  test("passes over an id the session does not hold for the next one named", async () => {
    // `u-7` is the shape of an id the translator mints for a turn with no
    // content: it is never a JSONL `message.id`.
    const out = await collectSession(cleanSession(5), {
      window: { afterTurn: { msgIds: ["u-7", "msg3"], heldTurns: 0 } },
    });
    expect(userTextsOf(out)).toEqual(["u4"]);
  });

  test("a card holding the newest turn gets an empty bracket", async () => {
    const out = await collectSession(cleanSession(3), {
      window: { afterTurn: { msgIds: ["msg2"], heldTurns: 3 } },
    });
    expect(userTextsOf(out)).toEqual([]);
    expect(replayCompleteOf(out)?.count).toBe(0);
  });

  test("with no named turn found, the count places the card one turn early", async () => {
    const out = await collectSession(cleanSession(5), {
      window: { afterTurn: { msgIds: ["gone"], heldTurns: 3 } },
    });
    expect(userTextsOf(out)).toEqual(["u2", "u3", "u4"]);
  });

  test("a card holding nothing gets the whole session", async () => {
    const out = await collectSession(cleanSession(3), {
      window: { afterTurn: { msgIds: [], heldTurns: 0 } },
    });
    expect(userTextsOf(out)).toEqual(["u0", "u1", "u2"]);
    expect(replayCompleteOf(out)?.hasOlder).toBe(false);
  });
});

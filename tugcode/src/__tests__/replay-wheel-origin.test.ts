// Wheel authorship is stated by the producer, not inferred by the consumer.
//
// A dash arc's stage session opens on a prompt the Wheel wrote, and the deck
// used to work out which frame that was from a replayed stage divider's
// POSITION. Replay is windowed, so on a long run the divider fired and the
// first user message the window happened to contain inherited the label —
// the user's own words, attributed to the Wheel.
//
// So the translator marks the one frame it can identify from the file itself:
// the first USER turn's opening entry, located over the whole JSONL and
// therefore stable whatever window is applied. A window that starts after it
// marks nothing, which is the correct outcome — the Wheel's prompt is off
// screen, and nobody else's words are relabelled.

import { describe, expect, test } from "bun:test";

import { translateJsonlSession } from "../replay.ts";
import type {
  AddUserMessage,
  OutboundMessage,
  ReplayWindow,
} from "../types.ts";

async function collect(
  jsonl: string,
  opts: { stageSession?: boolean; window?: ReplayWindow } = {},
): Promise<AddUserMessage[]> {
  const out: OutboundMessage[] = [];
  for await (const m of translateJsonlSession(
    { kind: "ok", jsonl, claudeSessionId: "sess-wheel" },
    {
      disableYield: true,
      synthesizeDanglingTerminal: true,
      stageSession: opts.stageSession,
      window: opts.window,
    },
  )) {
    out.push(m);
  }
  return out.filter((m): m is AddUserMessage => m.type === "add_user_message");
}

const user = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });

const assistant = (msgId: string, text: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      id: msgId,
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  });

/** Three turns, each a user prompt and its answer. */
const THREE_TURNS = [
  user("the wheel's opening prompt"),
  assistant("m1", "on it"),
  user("the user's own second message"),
  assistant("m2", "done"),
  user("the user's own third message"),
  assistant("m3", "done again"),
].join("\n");

describe("a stage session's opening prompt", () => {
  test("is the only frame marked, and it is the first one", async () => {
    const msgs = await collect(THREE_TURNS, { stageSession: true });
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.origin)).toEqual(["wheel", undefined, undefined]);
  });

  test("is marked on an UNWINDOWED pass, which is the commonest case", async () => {
    // Every ancestor stage session is translated with no window at all, so a
    // marker computed off the window block's own scan would mark nothing on
    // the path this whole change exists for.
    const msgs = await collect(THREE_TURNS, { stageSession: true });
    expect(msgs[0]?.origin).toBe("wheel");
  });

  test("is absent entirely when the session is not a stage's", async () => {
    const msgs = await collect(THREE_TURNS, { stageSession: false });
    expect(msgs.map((m) => m.origin)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("is absent when no lineage said anything at all", async () => {
    const msgs = await collect(THREE_TURNS);
    expect(msgs.every((m) => m.origin === undefined)).toBe(true);
  });

  test("goes unmarked when the window starts after it", async () => {
    // The regression, in the shape that produced it: the opener is outside
    // the window, so the Wheel's prompt is off screen. What must NOT happen
    // is the label landing on the user's own message instead.
    const msgs = await collect(THREE_TURNS, {
      stageSession: true,
      window: { lastTurns: 1 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toEqual([
      { type: "text", text: "the user's own third message" },
    ]);
    expect(msgs[0]?.origin).toBeUndefined();
  });

  test("is still marked when the window reaches back to it", async () => {
    const msgs = await collect(THREE_TURNS, {
      stageSession: true,
      window: { lastTurns: 3 },
    });
    expect(msgs.map((m) => m.origin)).toEqual(["wheel", undefined, undefined]);
  });

  test("lands on the first USER turn, never on entry 0", async () => {
    // A session whose JSONL opens assistant-first — a wake, or a leading
    // orphan — still opened on a prompt somewhere; the mark follows the turn
    // list's first user-originated turn rather than the file's first line.
    const assistantFirst = [
      assistant("m0", "an orphan opener"),
      user("the wheel's opening prompt"),
      assistant("m1", "on it"),
    ].join("\n");
    const msgs = await collect(assistantFirst, { stageSession: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.origin).toBe("wheel");
  });

  test("marks nothing in a session that never carried a user turn", async () => {
    const msgs = await collect(assistant("m0", "alone"), {
      stageSession: true,
    });
    expect(msgs).toHaveLength(0);
  });
});

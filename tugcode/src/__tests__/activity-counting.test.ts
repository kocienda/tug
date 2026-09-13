// Activity counting — the single authoritative interpreter (Spec S04).
//
// tugcode is the one place the claude stream is parsed, so it is the one
// place per-session work is counted ([P13]/[Q05]). `ActiveTurn.accountActivity`
// folds each outbound frame into a per-channel accumulator; `drainActivity`
// snapshots + resets it for the 250 ms flush bin. These tests pin the Spec
// S04 units per row — the (parity) rows relocated verbatim from the deck's
// former `recordThroughput`, and the two (enhancement) rows (token velocity,
// foreground tool_use burst) — and the flush's `suppressEmit` gate.

import { describe, expect, test } from "bun:test";
import { ActiveTurn, SessionManager } from "../session.ts";
import type { ActivityChannel, OutboundMessage } from "../types.ts";

function newTurn(): ActiveTurn {
  return new ActiveTurn(0, [{ type: "text", text: "go" }]);
}

/** Fold a list of outbound frames, then drain the accumulated channels. */
function account(
  frames: Array<Record<string, unknown>>,
): Partial<Record<ActivityChannel, number>> | null {
  const turn = newTurn();
  for (const f of frames) turn.accountActivity(f);
  return turn.drainActivity();
}

/**
 * Drive one turn across several bins: each element of `bins` is the frames
 * folded before that bin drains, and the result is one drain per bin in
 * order. {@link account} folds and drains once, so it cannot express a signal
 * that is *held* across bins — which is exactly what the foreground hum is.
 */
function accountBins(
  bins: Array<Array<Record<string, unknown>>>,
): Array<Partial<Record<ActivityChannel, number>> | null> {
  const turn = newTurn();
  return bins.map((frames) => {
    for (const f of frames) turn.accountActivity(f);
    return turn.drainActivity();
  });
}

describe("ActiveTurn.accountActivity — Spec S04 counting", () => {
  test("assistant_text / thinking_text partial deltas sum into text (parity)", () => {
    const channels = account([
      { type: "assistant_text", is_partial: true, text: "hello" },
      { type: "thinking_text", is_partial: true, text: "world!" },
      // Non-partial (a terminal baseline frame) is NOT counted — the deck
      // only credited the live stream's deltas.
      { type: "assistant_text", is_partial: false, text: "IGNORED" },
    ]);
    expect(channels).toEqual({ text: "hello".length + "world!".length });
  });

  test("tool_input_progress credits the per-tool byte GROWTH into text (parity)", () => {
    const channels = account([
      { type: "tool_input_progress", tool_use_id: "t1", bytes: 100 },
      { type: "tool_input_progress", tool_use_id: "t1", bytes: 260 },
      // A different forming tool tracks its own cumulative baseline.
      { type: "tool_input_progress", tool_use_id: "t2", bytes: 40 },
    ]);
    // t1: 100 (from 0) + 160 growth; t2: 40 (from 0).
    expect(channels).toEqual({ text: 100 + 160 + 40 });
  });

  test("streaming_usage records output_tokens velocity per msg_id (enhancement)", () => {
    const channels = account([
      // msg A grows 12 → 30 → 30 (no growth on the repeat).
      { type: "streaming_usage", msg_id: "A", usage: { output_tokens: 12 } },
      { type: "streaming_usage", msg_id: "A", usage: { output_tokens: 30 } },
      { type: "streaming_usage", msg_id: "A", usage: { output_tokens: 30 } },
      // msg B is independent — its first sample seeds from 0.
      { type: "streaming_usage", msg_id: "B", usage: { output_tokens: 7 } },
    ]);
    // A: 12 + 18 + 0; B: 7.
    expect(channels).toEqual({ tokens: 12 + 18 + 7 });
  });

  test("a foreground tool_use pulses a deduped burst into tools (enhancement)", () => {
    const channels = account([
      { type: "tool_use", tool_use_id: "f1", input: { cmd: "ls" } },
      // A re-emit of the same id (e.g. tool_use_structured refresh) does not
      // double-credit.
      { type: "tool_use", tool_use_id: "f1", input: { cmd: "ls" } },
      // An empty-input tool_use is not a real call — not counted.
      { type: "tool_use", tool_use_id: "f2", input: {} },
    ]);
    // f1 is still in flight when the bin drains, so the burst is joined by
    // one hum ([B01]/[B02]) — the drain of a bin with an open foreground
    // tool is never idle.
    expect(channels).toEqual({ tools: 250 + 30 });
  });

  test("a foreground tool_result credits capped output length into tools (parity)", () => {
    const channels = account([
      { type: "tool_result", output: "x".repeat(50) },
      // Capped at 600 so one huge result can't swamp the window.
      { type: "tool_result", output: "y".repeat(5000) },
    ]);
    expect(channels).toEqual({ tools: 50 + 600 });
  });

  test("an open foreground tool hums into tools every bin until its result lands", () => {
    const bins = accountBins([
      // The call opens: its burst, plus the first hum.
      [{ type: "tool_use", tool_use_id: "f1", input: { cmd: "sleep 51" } }],
      // Bins with nothing on the wire at all — the shell is running and no
      // bytes move. Without the hum these are the flat floor the tape drew.
      [],
      [],
      [],
      // The result lands, closing the tool.
      [{ type: "tool_result", tool_use_id: "f1", output: "x".repeat(50) }],
      // Nothing is open now, so the turn is idle again.
      [],
      [],
    ]);
    expect(bins).toEqual([
      { tools: 250 + 30 },
      { tools: 30 },
      { tools: 30 },
      { tools: 30 },
      // The id leaves the in-flight set when the result is folded, which is
      // before this bin drains — so the result's bin carries the result and
      // no hum. The tool is no longer open by the time the bin is taken.
      { tools: 50 },
      null,
      null,
    ]);
  });

  test("a live turn with no open tool hums nothing — the hum is conditional on the tool", () => {
    // The turn exists and is being drained; only an open foreground tool
    // raises a bin off null. A completed call leaves nothing humming.
    expect(accountBins([[], [], []])).toEqual([null, null, null]);
    expect(
      accountBins([
        [
          { type: "tool_use", tool_use_id: "g1", input: { cmd: "ls" } },
          { type: "tool_result", tool_use_id: "g1", output: "ok" },
        ],
        [],
      ]),
    ).toEqual([{ tools: 250 + 2 }, null]);
  });

  test("a tool_use re-emitted after its result does not re-open the hum", () => {
    // The burst is deduped by id because the same foreground `tool_use`
    // reaches the accumulator more than once. The in-flight set is opened
    // under that same dedupe, so a late re-emit cannot re-open a tool whose
    // result has landed — nothing would ever close it again, and the tape
    // would hum for the rest of the turn on a session doing nothing.
    const call = { type: "tool_use", tool_use_id: "h1", input: { cmd: "ls" } };
    expect(
      accountBins([
        [call],
        [{ type: "tool_result", tool_use_id: "h1", output: "ok" }],
        [call],
        [],
      ]),
    ).toEqual([{ tools: 250 + 30 }, { tools: 2 }, null, null]);
  });

  test("subagent tool_use burst + tool_result land on subagents, not tools (parity)", () => {
    const channels = account([
      {
        type: "tool_use",
        tool_use_id: "s1",
        parent_tool_use_id: "agent",
        input: { q: "search" },
      },
      {
        type: "tool_use",
        tool_use_id: "s1",
        parent_tool_use_id: "agent",
        input: { q: "search" },
      },
      {
        type: "tool_result",
        parent_tool_use_id: "agent",
        output: "z".repeat(1000),
      },
    ]);
    // burst 250 (deduped) + capped result 600.
    expect(channels).toEqual({ subagents: 250 + 600 });
  });

  test("task_progress pulses a burst into tools (parity)", () => {
    expect(account([{ type: "task_progress" }])).toEqual({ tools: 250 });
  });

  test("drainActivity returns null for an idle bin and resets after a drain", () => {
    const turn = newTurn();
    expect(turn.drainActivity()).toBeNull();
    turn.accountActivity({ type: "assistant_text", is_partial: true, text: "hi" });
    expect(turn.drainActivity()).toEqual({ text: 2 });
    // Second drain of the same turn is idle again — the accumulator reset.
    expect(turn.drainActivity()).toBeNull();
  });

  test("unrecognized frame types contribute nothing", () => {
    expect(
      account([
        { type: "turn_complete" },
        { type: "cost_update", usage: { output_tokens: 99 } },
        { type: "content_block_start" },
      ]),
    ).toBeNull();
  });
});

// ── flush wiring: dispatch → accumulate → activity_delta on the wire ─────────

async function captureStdout(
  fn: () => Promise<void> | void,
): Promise<OutboundMessage[]> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as unknown as { write: typeof Bun.write }).write = ((
    dest: unknown,
    data: unknown,
  ) => {
    if (dest === Bun.stdout) {
      const text =
        typeof data === "string"
          ? data
          : data instanceof Uint8Array
            ? decoder.decode(data)
            : "";
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.length > 0) {
          try {
            captured.push(JSON.parse(t) as OutboundMessage);
          } catch {
            // ignore
          }
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array
        ? data.length
        : typeof data === "string"
          ? data.length
          : 0,
    );
  }) as typeof Bun.write;
  try {
    await fn();
    const { drainPendingWrites } = await import("../ipc.ts");
    await drainPendingWrites();
  } finally {
    (Bun as unknown as { write: typeof Bun.write }).write = originalWrite;
  }
  return captured;
}

function newManagerWithTurn(turn: ActiveTurn): SessionManager {
  const manager = new SessionManager(
    "/tmp/activity-" + Date.now() + "-" + Math.random().toString(36).slice(2),
    crypto.randomUUID(),
  );
  (manager as unknown as { activeTurn: ActiveTurn }).activeTurn = turn;
  return manager;
}

function streamEvent(inner: Record<string, unknown>): Record<string, unknown> {
  return { type: "stream_event", event: inner, session_id: "sess" };
}

describe("activity flush — dispatch to activity_delta", () => {
  test("a live turn's streamed text flushes one activity_delta with the text total", async () => {
    const turn = newTurn();
    const manager = newManagerWithTurn(turn);
    const m = manager as unknown as {
      dispatchEventToTurn(t: ActiveTurn, e: Record<string, unknown>): void;
      flushActivity(t: ActiveTurn | null): void;
    };

    const emitted = await captureStdout(() => {
      m.dispatchEventToTurn(
        turn,
        streamEvent({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }),
      );
      m.dispatchEventToTurn(
        turn,
        streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      );
      m.dispatchEventToTurn(
        turn,
        streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abcd" } }),
      );
      m.dispatchEventToTurn(
        turn,
        streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ef" } }),
      );
      // The 250 ms interval would fire this; drive it directly for determinism.
      m.flushActivity(turn);
    });

    const deltas = emitted.filter((e) => e.type === "activity_delta");
    expect(deltas.length).toBe(1);
    // The streamed text sums into `text`; the `message_start`'s usage
    // (`output_tokens: 1`) rides the same turn and seeds one token of
    // velocity — end-to-end proof that both channels flow through dispatch.
    expect(
      (deltas[0] as unknown as { channels: Record<string, number> }).channels,
    ).toEqual({ text: "abcd".length + "ef".length, tokens: 1 });
  });

  test("no activity_delta is emitted while suppressEmit gates the turn (replay-safe)", async () => {
    const turn = newTurn();
    turn.suppressEmit = true;
    const manager = newManagerWithTurn(turn);
    const m = manager as unknown as {
      dispatchEventToTurn(t: ActiveTurn, e: Record<string, unknown>): void;
      flushActivity(t: ActiveTurn | null): void;
    };

    const emitted = await captureStdout(() => {
      m.dispatchEventToTurn(
        turn,
        streamEvent({
          type: "message_start",
          message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 1 } },
        }),
      );
      m.dispatchEventToTurn(
        turn,
        streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      );
      m.dispatchEventToTurn(
        turn,
        streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "replayed" } }),
      );
      m.flushActivity(turn);
    });

    expect(emitted.some((e) => e.type === "activity_delta")).toBe(false);
    // And nothing accumulated — the accounting rides the same gate, so a
    // later un-suppressed flush has nothing stale to emit.
    expect(turn.drainActivity()).toBeNull();
  });
});

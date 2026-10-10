/**
 * Reducer tests for `handleStreamingUsage` — the live intra-turn token
 * telemetry path.
 *
 * A `streaming_usage` frame carries one tool-loop iteration's `usage`
 * snapshot. `observedInput` grows monotonically across a turn's API
 * calls, so the LATEST frame is always the current context window —
 * the reducer publishes the frame's `usage` via a `write-live-usage`
 * effect (the streaming document's fine-grained path), never through
 * snapshot state: usage frames arrive at streaming frequency, and a
 * snapshot change per frame would re-render the whole transcript list
 * for a value only the status cells read.
 *
 * Pins:
 *   - a frame emits `write-live-usage` carrying the decoded `usage`,
 *   - a frame does NOT change the state reference once
 *     `sessionInitTokens` is captured (the no-snapshot-churn guarantee),
 *   - `sessionInitTokens` is captured once from the first frame's
 *     `observedInput` and never overwritten,
 *   - `sessionInitTokens` is session-level — NOT reset at a turn
 *     boundary,
 *   - a frame with no `msg_id` is inert (no state change, no effect),
 *   - the handler is phase-tolerant (replay bracket included).
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { Effect } from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): CodeSessionState {
  let current = state;
  for (const ev of events) {
    current = reduce(current, ev).state;
  }
  return current;
}

/** The `write-live-usage` effects of one reduction. */
function liveUsageEffects(effects: Effect[]): Effect[] {
  return effects.filter((e) => e.kind === "write-live-usage");
}

/** A `streaming_usage` wire event carrying a raw snake_case `usage`. */
function streamingUsage(
  msgId: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
): CodeSessionEvent {
  return { type: "streaming_usage", msg_id: msgId, usage } as CodeSessionEvent;
}

describe("reducer — handleStreamingUsage", () => {
  it("emits write-live-usage carrying the frame's decoded usage", () => {
    const afterSend = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
    ]);
    const { effects } = reduce(
      afterSend,
      streamingUsage("msg_a", {
        input_tokens: 3,
        cache_creation_input_tokens: 7327,
        cache_read_input_tokens: 13148,
        output_tokens: 2,
      }),
    );
    expect(liveUsageEffects(effects)).toEqual([
      {
        kind: "write-live-usage",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cacheCreationInputTokens: 7327,
          cacheReadInputTokens: 13148,
        },
      },
    ]);
  });

  it("each frame emits its own usage verbatim — latest wins, no merge", () => {
    // The terminal `message_delta` of a message finalizes `output`;
    // a later message's frame carries the grown window. The consumer
    // observes the most recent write, never an accumulation.
    const afterFirst = applyAll(fresh(), [
      { type: "send", text: "run echo", atoms: [], content: [{ type: "text" as const, text: "run echo" }], turnKey: "k1" },
      streamingUsage("msg_a", {
        input_tokens: 3,
        cache_creation_input_tokens: 7340,
        cache_read_input_tokens: 13148,
        output_tokens: 64,
      }),
    ]);
    const { effects } = reduce(
      afterFirst,
      streamingUsage("msg_b", {
        input_tokens: 4,
        cache_creation_input_tokens: 99,
        cache_read_input_tokens: 20488,
        output_tokens: 12,
      }),
    );
    expect(liveUsageEffects(effects)).toEqual([
      {
        kind: "write-live-usage",
        usage: {
          inputTokens: 4,
          outputTokens: 12,
          cacheCreationInputTokens: 99,
          cacheReadInputTokens: 20488,
        },
      },
    ]);
  });

  it("leaves the state reference untouched once sessionInit is captured", () => {
    // The no-snapshot-churn guarantee: after the one-time
    // `sessionInitTokens` capture, a usage frame must not produce a new
    // state object — otherwise every frame would re-render the whole
    // transcript list.
    const afterFirst = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      streamingUsage("msg_a", { input_tokens: 3, cache_read_input_tokens: 18572, output_tokens: 10 }),
    ]);
    const { state } = reduce(
      afterFirst,
      streamingUsage("msg_a", { input_tokens: 4, cache_read_input_tokens: 40000, output_tokens: 200 }),
    );
    expect(state).toBe(afterFirst);
  });

  it("captures sessionInitTokens from the first frame's observedInput", () => {
    // observedInput = input + cache_read + cache_creation =
    // 3 + 13148 + 7327 = 20478. output is excluded — it is the
    // model's response, not its resident input.
    const state = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      streamingUsage("msg_a", {
        input_tokens: 3,
        cache_creation_input_tokens: 7327,
        cache_read_input_tokens: 13148,
        output_tokens: 999,
      }),
    ]);
    expect(state.sessionInitTokens).toBe(20478);
  });

  it("never overwrites a captured sessionInitTokens", () => {
    const state = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      streamingUsage("msg_a", {
        input_tokens: 3,
        cache_read_input_tokens: 18572,
        output_tokens: 10,
      }),
      // A later, larger iteration must not move window(0).
      streamingUsage("msg_a", {
        input_tokens: 4,
        cache_read_input_tokens: 40000,
        output_tokens: 200,
      }),
    ]);
    expect(state.sessionInitTokens).toBe(18575);
  });

  it("keeps sessionInitTokens across turn boundaries — it is session-level", () => {
    const afterTurn = applyAll(fresh(), [
      { type: "send", text: "first", atoms: [], content: [{ type: "text" as const, text: "first" }], turnKey: "k1" },
      streamingUsage("msg_a", { input_tokens: 3, cache_read_input_tokens: 18572, output_tokens: 80 }),
      { type: "assistant_text", msg_id: "msg_a",
      block_index: 0,
      text: "ok", is_partial: false,
      seq: 0,
      rev: 0,
      status: "complete" },
      { type: "turn_complete", msg_id: "msg_a", result: "success", seq: 0 },
    ]);
    expect(afterTurn.sessionInitTokens).toBe(18575);
    const nextTurn = applyAll(afterTurn, [
      { type: "send", text: "second", atoms: [], content: [{ type: "text" as const, text: "second" }], turnKey: "k2" },
    ]);
    expect(nextTurn.sessionInitTokens).toBe(18575);
  });

  it("drops a frame with no msg_id — a malformed frame", () => {
    const afterSend = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
    ]);
    const { state, effects } = reduce(afterSend, {
      type: "streaming_usage",
      usage: { output_tokens: 50 },
    } as unknown as CodeSessionEvent);
    expect(state).toBe(afterSend);
    expect(effects).toEqual([]);
    expect(state.sessionInitTokens).toBeNull();
  });

  it("phase-tolerant during replay bracket — the inflight snapshot's streaming_usage still publishes", () => {
    // Mirrors the wire shape tugcode's `emitInflightTurnFromActiveTurn`
    // produces: a `streaming_usage` frame inside the replay bracket,
    // re-emitting the latest observed in-flight `usage` so the status
    // bar's TOKENS / CONTEXT cells climb back to where they were
    // before the reload. The handler's phase contract is "tolerant" —
    // it must publish whatever the prevailing phase is (submitting /
    // replaying / streaming / tool_work / …). Pinning the contract here
    // so a future regression that adds a phase guard would surface.
    const afterReplayStart = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      { type: "replay_started" } as CodeSessionEvent,
    ]);
    const { state, effects } = reduce(
      afterReplayStart,
      streamingUsage("msg_inflight", {
        input_tokens: 1,
        output_tokens: 200,
        cache_read_input_tokens: 18029,
        cache_creation_input_tokens: 7081,
      }),
    );
    // Phase is "submitting" or "replaying" depending on the reducer's
    // post-send handling of `replay_started`; the streaming_usage
    // contract holds regardless.
    expect(state.phase).not.toBe("idle");
    expect(liveUsageEffects(effects)).toEqual([
      {
        kind: "write-live-usage",
        usage: {
          inputTokens: 1,
          outputTokens: 200,
          cacheCreationInputTokens: 7081,
          cacheReadInputTokens: 18029,
        },
      },
    ]);
    // sessionInitTokens is captured from the first token-bearing
    // frame's observedInput regardless of phase.
    expect(state.sessionInitTokens).toBe(1 + 18029 + 7081);
  });
});

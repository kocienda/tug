/**
 * Reducer tests for the per-turn `TurnCost` — `handleSend` snapshots
 * `lastCost` into `costAtSubmit`; `handleTurnComplete` builds the
 * committed `TurnEntry.cost` via `extractTurnCost`.
 *
 * `cost_update.usage` is per-turn on the live wire — each turn reports
 * its own token counts — so the four token fields are frozen onto the
 * entry RAW, never differenced against the prior turn. `total_cost_usd`
 * IS cumulative-per-session, so it alone is the `after − before` delta.
 *
 * Pins:
 *   - token fields are this turn's raw `cost_update.usage`,
 *   - `totalCostUsd` is the cumulative `after − before` delta,
 *   - no cost_update for a turn → committed cost is all zeros,
 *   - the cost snapshot is taken at submit time, not at completion.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type {
  AppendTranscriptEffect,
  Effect,
} from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function appended(effects: ReadonlyArray<Effect>) {
  return effects.filter(
    (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
  );
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): { state: CodeSessionState; effects: Effect[] } {
  let current = state;
  const collected: Effect[] = [];
  for (const ev of events) {
    const r = reduce(current, ev);
    current = r.state;
    collected.push(...r.effects);
  }
  return { state: current, effects: collected };
}

describe("reducer — per-turn cost delta", () => {
  it("first turn: TurnCost token fields are this turn's raw cost_update usage", () => {
    const events: CodeSessionEvent[] = [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "ok",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      {
        type: "cost_update",
        total_cost_usd: 0.045,
        num_turns: 1,
        usage: {
          input_tokens: 3,
          output_tokens: 10,
          cache_creation_input_tokens: 6180,
          cache_read_input_tokens: 12507,
        },
        modelUsage: {},
        duration_ms: 0,
        duration_api_ms: 0,
      },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ];
    const { effects } = applyAll(fresh(), events);
    const entry = appended(effects)[0].entry;
    expect(entry.cost.inputTokens).toBe(3);
    expect(entry.cost.outputTokens).toBe(10);
    expect(entry.cost.cacheCreationInputTokens).toBe(6180);
    expect(entry.cost.cacheReadInputTokens).toBe(12507);
    expect(entry.cost.totalCostUsd).toBeCloseTo(0.045);
  });

  it("second turn: token fields are raw per-turn usage; totalCostUsd is the cumulative delta", () => {
    // Turn 1: usage=(3, 10, 6180, 12507), cumulative cost=0.045.
    const r1 = applyAll(fresh(), [
      { type: "send", text: "first", atoms: [], content: [{ type: "text" as const, text: "first" }], turnKey: "k1" },
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "ok",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      {
        type: "cost_update",
        total_cost_usd: 0.045,
        num_turns: 1,
        usage: {
          input_tokens: 3,
          output_tokens: 10,
          cache_creation_input_tokens: 6180,
          cache_read_input_tokens: 12507,
        },
        modelUsage: {},
        duration_ms: 0,
        duration_api_ms: 0,
      },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    // Turn 2: per-turn usage=(4, 180, 6349, 31204); cumulative cost=0.060.
    const r2 = applyAll(r1.state, [
      { type: "send", text: "second", atoms: [], content: [{ type: "text" as const, text: "second" }], turnKey: "k2" },
      {
        type: "assistant_text",
        msg_id: "m2",
      block_index: 0,
      text: "done",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      {
        type: "cost_update",
        total_cost_usd: 0.06,
        num_turns: 2,
        usage: {
          input_tokens: 4,
          output_tokens: 180,
          cache_creation_input_tokens: 6349,
          cache_read_input_tokens: 31204,
        },
        modelUsage: {},
        duration_ms: 0,
        duration_api_ms: 0,
      },
      { type: "turn_complete", msg_id: "m2", result: "success", seq: 0 },
    ]);
    const entry2 = appended(r2.effects)[0].entry;
    // Token fields are turn 2's raw usage — NOT differenced against turn 1.
    expect(entry2.cost.inputTokens).toBe(4);
    expect(entry2.cost.outputTokens).toBe(180);
    expect(entry2.cost.cacheCreationInputTokens).toBe(6349);
    expect(entry2.cost.cacheReadInputTokens).toBe(31204);
    // `totalCostUsd` IS cumulative — the committed value is the delta.
    expect(entry2.cost.totalCostUsd).toBeCloseTo(0.06 - 0.045);
  });

  it("a turn with NO cost_update commits with cost = all zeros", () => {
    const { effects } = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" },
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "ok",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]);
    const entry = appended(effects)[0].entry;
    expect(entry.cost.inputTokens).toBe(0);
    expect(entry.cost.outputTokens).toBe(0);
    expect(entry.cost.cacheCreationInputTokens).toBe(0);
    expect(entry.cost.cacheReadInputTokens).toBe(0);
    expect(entry.cost.totalCostUsd).toBe(0);
  });

  it("costAtSubmit is snapshotted at handleSend, not at completion", () => {
    // Seed a lastCost from a prior turn.
    const seeded = applyAll(fresh(), [
      { type: "send", text: "first", atoms: [], content: [{ type: "text" as const, text: "first" }], turnKey: "k1" },
      {
        type: "assistant_text",
        msg_id: "m1",
      block_index: 0,
      text: "ok",
        is_partial: false,
        seq: 0,
        rev: 0,
        status: "complete",
      },
      {
        type: "cost_update",
        total_cost_usd: 0.045,
        num_turns: 1,
        usage: {
          input_tokens: 3,
          output_tokens: 10,
          cache_creation_input_tokens: 6180,
          cache_read_input_tokens: 12507,
        },
        modelUsage: {},
        duration_ms: 0,
        duration_api_ms: 0,
      },
      { type: "turn_complete", msg_id: "m1", result: "success", seq: 0 },
    ]).state;

    // New send. costAtSubmit should equal the seeded lastCost.
    const afterSend = applyAll(seeded, [
      { type: "send", text: "next", atoms: [], content: [{ type: "text" as const, text: "next" }], turnKey: "k2" },
    ]).state;
    expect(afterSend.costAtSubmit).not.toBeNull();
    expect(afterSend.costAtSubmit?.totalCostUsd).toBeCloseTo(0.045);
  });
});

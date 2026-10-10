/**
 * Reducer tests for `handleApiRetry` — the display-only API-retry path.
 *
 * An `api_retry` frame announces that claude's SDK is backing off and
 * retrying; the reducer folds it into `apiRetry` with no phase change. A
 * later attempt replaces the prior announcement, and the next turn
 * boundary clears it.
 *
 * Pins:
 *   - a frame stores the normalized fields on `apiRetry`,
 *   - a later attempt replaces the prior one,
 *   - `cost_update` clears it (turn resolved / ended),
 *   - `turn_complete` clears it (via `resetPerTurnTelemetry`),
 *   - a live stream event clears it mid-turn (the retry recovered and
 *     content resumed before any turn boundary).
 *
 * The wire→event normalization (snake_case + `deadline` stamping) lives
 * in the impure store wrapper, not the reducer, so these events are
 * already in the reducer's camelCase shape with an absolute `deadline`.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
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

function apiRetry(
  overrides: Partial<{
    attempt: number;
    maxRetries: number;
    deadline: number;
    error: string;
    errorStatus: number | null;
  }> = {},
): CodeSessionEvent {
  return {
    type: "api_retry",
    attempt: 1,
    maxRetries: 10,
    deadline: 1_700_000_010_000,
    error: "rate_limit",
    errorStatus: 429,
    ...overrides,
  } as CodeSessionEvent;
}

describe("reducer — handleApiRetry", () => {
  it("stores the announcement on apiRetry with no phase change", () => {
    const before = fresh();
    const after = reduce(before, apiRetry()).state;
    expect(after.apiRetry).toEqual({
      attempt: 1,
      maxRetries: 10,
      deadline: 1_700_000_010_000,
      error: "rate_limit",
      errorStatus: 429,
    });
    expect(after.phase).toBe(before.phase);
  });

  it("a later attempt replaces the prior announcement", () => {
    const after = applyAll(fresh(), [
      apiRetry({ attempt: 1, deadline: 1_700_000_010_000 }),
      apiRetry({ attempt: 2, deadline: 1_700_000_020_000, error: "overloaded", errorStatus: 529 }),
    ]);
    expect(after.apiRetry).toEqual({
      attempt: 2,
      maxRetries: 10,
      deadline: 1_700_000_020_000,
      error: "overloaded",
      errorStatus: 529,
    });
  });

  it("cost_update clears the retry announcement", () => {
    const after = applyAll(fresh(), [
      apiRetry(),
      { type: "cost_update", total_cost_usd: 0.01, modelUsage: {}, num_turns: 0, duration_ms: 0, duration_api_ms: 0, usage: {} } as CodeSessionEvent,
    ]);
    expect(after.apiRetry).toBeNull();
  });

  it("a live stream event clears the retry announcement mid-turn", () => {
    // The retry recovers and content resumes before the turn ends — no
    // cost_update / turn_complete yet, so the per-turn clear hasn't run.
    // The streamed assistant_text must dismiss the stale banner on its own.
    const after = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" } as CodeSessionEvent,
      apiRetry(),
      { type: "assistant_text", msg_id: "m1", block_index: 0, text: "ok", is_partial: false } as CodeSessionEvent,
    ]);
    expect(after.apiRetry).toBeNull();
  });

  it("turn_complete clears the retry announcement", () => {
    const after = applyAll(fresh(), [
      { type: "send", text: "hi", atoms: [], content: [{ type: "text" as const, text: "hi" }], turnKey: "k1" } as CodeSessionEvent,
      { type: "assistant_text", msg_id: "m1", block_index: 0, text: "ok", is_partial: false } as CodeSessionEvent,
      apiRetry(),
      { type: "turn_complete", msg_id: "m1", result: "success" } as CodeSessionEvent,
    ]);
    expect(after.apiRetry).toBeNull();
  });
});

/**
 * Reducer tests for the logout `interruptReason` sidecar.
 *
 * A CASE B interrupt carrying `reason: "logout"` stashes
 * `pendingInterruptReason` on state, which `buildTurnEntry` reads at the
 * following `turn_complete` so the committed `TurnEntry` carries
 * `interruptReason: "logout"` (its `turnEndReason` stays `"interrupted"`).
 * A plain interrupt leaves the field unset, and the bridge clears after
 * the turn commits.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

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

let now = 0;
let originalDateNow: () => number;
beforeEach(() => {
  now = 3_000_000_000;
  originalDateNow = Date.now;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = originalDateNow;
});

// Drive a content-bearing turn to a CASE B interrupt with the given reason,
// then complete it; return the committed entry + the post-commit state.
function interruptedTurn(reason?: "logout") {
  const { state: opened } = applyAll(fresh(), [
    {
      type: "send",
      text: "hi",
      atoms: [],
      content: [{ type: "text" as const, text: "hi" }],
      turnKey: "k1",
    },
    {
      type: "assistant_text",
      msg_id: "m1",
      block_index: 0,
      text: "partial",
      is_partial: true,
      seq: 0,
      rev: 0,
      status: "partial",
    },
  ]);
  const { state: mid } = applyAll(opened, [
    { type: "interrupt_action", reason },
  ]);
  const { state, effects } = applyAll(mid, [
    { type: "turn_complete", msg_id: "m1", result: "error", seq: 0 },
  ]);
  return { midState: mid, state, entry: appended(effects)[0]!.entry };
}

describe("reducer — logout interruptReason sidecar", () => {
  it("initial state carries no pending interrupt reason", () => {
    expect(fresh().pendingInterruptReason).toBeNull();
  });

  it("a logout interrupt stashes the reason and commits it on the turn", () => {
    const { midState, entry } = interruptedTurn("logout");
    // Stashed while the interrupt round-trip is in flight.
    expect(midState.pendingInterruptReason).toBe("logout");
    // Committed onto the interrupted turn.
    expect(entry.turnEndReason).toBe("interrupted");
    expect(entry.result).toBe("interrupted");
    expect(entry.interruptReason).toBe("logout");
  });

  it("a plain interrupt leaves interruptReason unset", () => {
    const { midState, entry } = interruptedTurn();
    expect(midState.pendingInterruptReason).toBeNull();
    expect(entry.turnEndReason).toBe("interrupted");
    expect(entry.interruptReason).toBeUndefined();
  });

  it("the pending reason clears after the turn commits", () => {
    const { state } = interruptedTurn("logout");
    expect(state.pendingInterruptReason).toBeNull();
    expect(state.interruptInFlight).toBe(false);
  });

  it("a CASE A logout interrupt commits no turn and clears the reason", () => {
    // Interrupt before any answer content: CASE A resets to idle, appends
    // no TurnEntry, and carries no marker.
    const { state, effects } = applyAll(fresh(), [
      {
        type: "send",
        text: "hi",
        atoms: [],
        content: [{ type: "text" as const, text: "hi" }],
        turnKey: "k1",
      },
      { type: "interrupt_action", reason: "logout" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.pendingInterruptReason).toBeNull();
    expect(appended(effects)).toEqual([]);
  });
});

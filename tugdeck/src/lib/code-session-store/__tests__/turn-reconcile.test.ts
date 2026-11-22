/**
 * The card's record of turns it can place: `rememberTurnIds` keeps the last
 * `KNOWN_TURN_IDS_CAP` ids, each once, oldest dropped first, and hands back
 * the same list when nothing was added.
 */

import { describe, it, expect } from "bun:test";

import {
  KNOWN_TURN_IDS_CAP,
  cycleTurnIds,
  reconcileRule,
  reconcileTurn,
  rememberTurnIds,
  type ReconcileEdge,
} from "@/lib/code-session-store/turn-reconcile";
import {
  createInitialState,
  endTurnAsReconciled,
  reduce,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { TurnReconciledEffect } from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

/** A card streaming turn `A` (its typed send's key), whose latch reads idle for `A`. */
function holding(over: Partial<CodeSessionState> = {}): CodeSessionState {
  const sent = reduce(createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new"), {
    type: "send",
    text: "hi",
    atoms: [],
    content: [{ type: "text" as const, text: "hi" }],
    turnKey: "A",
  } as CodeSessionEvent).state;
  return { ...sent, phase: "streaming", serverTurn: { active: false, turnId: "A" }, ...over };
}

function fired(state: CodeSessionState, edge: ReconcileEdge): TurnReconciledEffect | undefined {
  const result = reconcileTurn(state, edge, endTurnAsReconciled);
  return result?.effects.find((e): e is TurnReconciledEffect => e.kind === "turn-reconciled");
}

describe("rememberTurnIds", () => {
  it("appends a new id and keeps an id it already holds where it is", () => {
    const known = rememberTurnIds([], ["a", "b"]);
    expect(known).toEqual(["a", "b"]);
    expect(rememberTurnIds(known, ["a", "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns the list it was given when nothing is new", () => {
    const known = ["a", "b"];
    expect(rememberTurnIds(known, ["b", "a"])).toBe(known);
    expect(rememberTurnIds(known, [undefined, null, ""])).toBe(known);
  });

  it("drops the oldest past the cap", () => {
    const ids = Array.from({ length: KNOWN_TURN_IDS_CAP + 3 }, (_, i) => `t${i}`);
    const known = rememberTurnIds([], ids);
    expect(known).toHaveLength(KNOWN_TURN_IDS_CAP);
    expect(known[0]).toBe("t3");
    expect(known[known.length - 1]).toBe(`t${KNOWN_TURN_IDS_CAP + 2}`);
  });

  it("dedupes within one call", () => {
    expect(rememberTurnIds([], ["a", "a", "b", "a"])).toEqual(["a", "b"]);
  });
});

describe("cycleTurnIds", () => {
  it("names a cycle by its own id and every id it heard", () => {
    expect(cycleTurnIds(null)).toEqual([]);
    expect(
      cycleTurnIds({ turnKey: "k", submitAt: 0, origin: "user", turnId: "t1", heardTurnIds: ["w1"] }),
    ).toEqual(["t1", "w1"]);
    expect(cycleTurnIds({ turnKey: "k", submitAt: 0, origin: "assistant" })).toEqual([]);
  });
});

describe("reconcileRule — which rule a card's state fires", () => {
  it("same-turn: the reading names the cycle's own turn", () => {
    expect(reconcileRule(holding())).toBe("same-turn");
    // A card still submitting is running its own turn too.
    expect(reconcileRule(holding({ phase: "submitting" }))).toBe("same-turn");
  });

  it("later-turn: the reading names a turn the card never heard of", () => {
    expect(reconcileRule(holding({ serverTurn: { active: false, turnId: "Z" } }))).toBe("later-turn");
  });

  it("a turn the card already finished, or one the cycle heard, fires nothing", () => {
    expect(reconcileRule(holding({ serverTurn: { active: false, turnId: "Z" }, knownTurnIds: ["Z"] }))).toBeNull();
    const s = holding({ serverTurn: { active: false, turnId: "W" } });
    expect(reconcileRule({ ...s, pendingTurn: { ...s.pendingTurn!, heardTurnIds: ["W"] } })).toBeNull();
  });

  it("a card still submitting refuses later-turn: its own turn may not have reached the latch", () => {
    expect(reconcileRule(holding({ phase: "submitting", serverTurn: { active: false, turnId: "Z" } }))).toBeNull();
  });

  it("each guard refuses", () => {
    const s = holding();
    const refusals: Array<[string, CodeSessionState]> = [
      ["no cycle", { ...s, pendingTurn: null }],
      ["idle", { ...s, phase: "idle" }],
      ["replaying", { ...s, phase: "replaying" }],
      ["shadow", { ...s, replayShadowActive: true }],
      ["catch-up standing", { ...s, catchUp: { ...s.catchUp, stage: "asked" } }],
      ["asleep", { ...s, catchUp: { ...s.catchUp, asleep: true } }],
      ["offline", { ...s, transportState: "offline" }],
      ["no reading", { ...s, serverTurn: null }],
      ["a turn running", { ...s, serverTurn: { active: true, turnId: "A" } }],
      ["no turn named", { ...s, serverTurn: { active: false, turnId: null } }],
      ["already ended once", { ...s, lastReconciledTurnId: "A" }],
    ];
    for (const [why, state] of refusals) {
      expect([why, reconcileRule(state)]).toEqual([why, null]);
    }
  });
});

describe("reconcileTurn — what a fire does at each edge", () => {
  it("at the latch and transport edges it asks, and leaves the state as it was", () => {
    for (const edge of ["latch", "transport"] as const) {
      const s = holding();
      const result = reconcileTurn(s, edge, endTurnAsReconciled);
      expect(result?.state).toBe(s);
      expect(result?.effects).toHaveLength(1);
      expect(fired(s, edge)).toMatchObject({
        edge,
        rule: "same-turn",
        action: "asked",
        before: { phase: "streaming", canInterrupt: true, turnId: "A", origin: "user" },
        latch: { active: false, turnId: "A" },
      });
    }
  });

  it("at the catch-up edge it ends the cycle: dropped, nothing committed, the ids remembered", () => {
    const s = holding({ serverTurn: { active: false, turnId: "Z" }, queuedSends: [] });
    const result = reconcileTurn(s, "catch-up", endTurnAsReconciled)!;
    expect(result.state).toMatchObject({
      phase: "idle",
      pendingTurn: null,
      activeMsgId: null,
      lastReconciledTurnId: "Z",
    });
    expect(result.state.scratch.has("A")).toBe(false);
    expect(result.state.knownTurnIds).toEqual(["A", "Z"]);
    expect(result.effects.some((e) => e.kind === "append-transcript")).toBe(false);
    expect(result.effects.map((e) => e.kind)).toEqual(["clear-inflight", "cancel_timer", "cancel_timer", "turn-reconciled"]);
    expect(fired(s, "catch-up")).toMatchObject({ edge: "catch-up", rule: "later-turn", action: "ended" });
  });

  it("a fire keeps the queue: those are the user's messages", () => {
    const s = holding();
    const queued = [{ ...({} as CodeSessionState["queuedSends"][number]), turnKey: "B" }];
    const result = reconcileTurn({ ...s, queuedSends: queued }, "catch-up", endTurnAsReconciled)!;
    expect(result.state.queuedSends).toBe(queued);
  });

  it("refuses the turn it already ended, so a rebuilt turn is ended once", () => {
    const once = reconcileTurn(holding(), "catch-up", endTurnAsReconciled)!.state;
    // A catch-up's answer rebuilds A in flight and closes, the latch still idle for A.
    const rebuilt = { ...holding(), knownTurnIds: once.knownTurnIds, lastReconciledTurnId: once.lastReconciledTurnId };
    expect(reconcileTurn(rebuilt, "catch-up", endTurnAsReconciled)).toBeNull();
  });
});

describe("reduce — the three edges", () => {
  const reading = (turnId: string): CodeSessionEvent =>
    ({ type: "server_turn", latch: { active: false, turnId }, cardId: "c1" }) as CodeSessionEvent;

  it("a latch reading is an edge; a reading taken while the catch-up stands is only kept", () => {
    const s = holding({ serverTurn: null });
    const latch = reduce(s, reading("A"));
    expect(latch.effects.find((e) => e.kind === "turn-reconciled")).toMatchObject({ edge: "latch", action: "asked" });
    const standing = reduce({ ...s, catchUp: { ...s.catchUp, stage: "asked" } }, reading("A"));
    expect(standing.effects.some((e) => e.kind === "turn-reconciled")).toBe(false);
    expect(standing.state.serverTurn).toEqual({ active: false, turnId: "A" });
  });

  it("the wire back online is an edge, and asks", () => {
    const s = holding({ transportState: "restoring" });
    const settled = reduce(s, { type: "transport_settled" } as CodeSessionEvent);
    expect(settled.state.pendingTurn?.turnId).toBe("A");
    expect(settled.effects.find((e) => e.kind === "turn-reconciled")).toMatchObject({
      edge: "transport",
      action: "asked",
    });
  });

  it("an event that makes no edge runs nothing, whatever the reading says", () => {
    const s = holding();
    const ticked = reduce(s, { type: "tick_soft_budget" } as CodeSessionEvent);
    expect(ticked.effects.some((e) => e.kind === "turn-reconciled")).toBe(false);
  });
});

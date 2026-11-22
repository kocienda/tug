/**
 * Each turn's tugcast id, and the session's latch, in the reducer.
 *
 * tugcast's turn latch names the turn it last opened, and the card learns
 * each cycle's id from the frame that opens it on its own feed. These pin
 * where the id comes from for every opener, how a cycle that is already
 * running hears a live wake's id, which ids a closed cycle leaves the card
 * able to place, and how a latch reading is kept.
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

function run(state: CodeSessionState, ...events: CodeSessionEvent[]): CodeSessionState {
  return events.reduce((s, e) => reduce(s, e).state, state);
}

function send(turnKey: string): CodeSessionEvent {
  return {
    type: "send",
    text: "hi",
    atoms: [],
    content: [{ type: "text" as const, text: "hi" }],
    turnKey,
  } as CodeSessionEvent;
}

function wake(turnKey: string, turnId?: string): CodeSessionEvent {
  return {
    type: "wake_started",
    wake_trigger: { task_id: "", tool_use_id: "", status: "completed", summary: "", output_file: "" },
    turnKey,
    ...(turnId !== undefined ? { turnId } : {}),
  } as CodeSessionEvent;
}

function notice(origin: string, turnKey: string, submissionId?: string): CodeSessionEvent {
  return {
    type: "tug_notice",
    origin,
    text: "the base moved",
    turnKey,
    ...(submissionId !== undefined ? { submissionId } : {}),
  } as CodeSessionEvent;
}

const COMPLETE: CodeSessionEvent = {
  type: "turn_complete",
  seq: 0,
  msg_id: FIXTURE_IDS.MSG_ID_N(1),
  result: "success",
} as CodeSessionEvent;

describe("each opener names its turn by the id tugcast's latch uses", () => {
  it("a typed send: its turn key, which it goes out under", () => {
    expect(run(fresh(), send("k1")).pendingTurn?.turnId).toBe("k1");
  });

  it("a queued send: its own turn key, once the turn ahead of it ends", () => {
    const s = run(fresh(), send("k1"), send("k2"), COMPLETE);
    expect(s.pendingTurn?.turnKey).toBe("k2");
    expect(s.pendingTurn?.turnId).toBe("k2");
  });

  it("a wheel notice: the submission id tugcast dispatched it under", () => {
    const s = run(fresh(), notice("wheel", "k1", "s1"));
    expect(s.pendingTurn?.origin).toBe("wheel");
    expect(s.pendingTurn?.turnId).toBe("s1");
  });

  it("an injected notice: its submission id", () => {
    const s = run(fresh(), notice("base-motion", "k1", "s1"));
    expect(s.phase).toBe("waking");
    expect(s.pendingTurn?.turnId).toBe("s1");
  });

  it("a rotation: the submission id the segment echoes", () => {
    const s = run(fresh(), {
      type: "session_stage",
      stage: "implement",
      model: "opus",
      document: "plan.md",
      arc: "a",
      prompt: "go",
      turnKey: "k1",
      submissionId: "s1",
    } as CodeSessionEvent);
    expect(s.pendingTurn?.turnId).toBe("s1");
  });

  it("a live wake: the id the merger stamped", () => {
    expect(run(fresh(), wake("k1", "w1")).pendingTurn?.turnId).toBe("w1");
  });

  it("a replayed prompt: its submission id; a replayed wake: none", () => {
    const replaying = run(fresh(), { type: "replay_started" } as CodeSessionEvent);
    const prompt = run(replaying, {
      type: "add_user_message",
      text: "q",
      atoms: [],
      turnKey: "k1",
      submissionId: "s1",
    } as CodeSessionEvent);
    expect(prompt.pendingTurn?.turnId).toBe("s1");
    expect(run(replaying, wake("k2")).pendingTurn?.turnId).toBeUndefined();
  });

  it("an opener that carries no id leaves the cycle without one", () => {
    expect(run(fresh(), notice("base-motion", "k1")).pendingTurn?.turnId).toBeUndefined();
  });
});

describe("a running cycle hears a live wake's id", () => {
  it("adds it to the cycle's heard ids, once, and keeps the cycle's own", () => {
    const s = run(fresh(), send("k1"), wake("k2", "w1"), wake("k3", "w1"));
    expect(s.pendingTurn?.turnKey).toBe("k1");
    expect(s.pendingTurn?.turnId).toBe("k1");
    expect(s.pendingTurn?.heardTurnIds).toEqual(["w1"]);
  });

  it("a nested wake's id is heard by the wake already open", () => {
    const s = run(fresh(), wake("k1", "w1"), wake("k2", "w2"));
    expect(s.pendingTurn?.turnId).toBe("w1");
    expect(s.pendingTurn?.heardTurnIds).toEqual(["w2"]);
  });
});

describe("a closed cycle's ids are turns the card can place", () => {
  it("records the cycle's id and every id it heard", () => {
    const s = run(fresh(), send("k1"), wake("k2", "w1"), COMPLETE);
    expect(s.pendingTurn).toBeNull();
    expect(s.knownTurnIds).toEqual(["k1", "w1"]);
  });

  it("records a replayed turn that commits with a submission id", () => {
    const s = run(
      fresh(),
      { type: "replay_started" } as CodeSessionEvent,
      { type: "add_user_message", text: "q", atoms: [], turnKey: "k1", submissionId: "s1" } as CodeSessionEvent,
      COMPLETE,
    );
    expect(s.knownTurnIds).toEqual(["s1"]);
  });

  it("an open cycle is not yet known", () => {
    expect(run(fresh(), send("k1")).knownTurnIds).toEqual([]);
  });
});

describe("server_turn", () => {
  function reading(active: boolean, turnId: string | null): CodeSessionEvent {
    return { type: "server_turn", latch: { active, turnId }, cardId: "c1" } as CodeSessionEvent;
  }

  it("keeps the newest reading, and the same reading again returns the same state", () => {
    const once = run(fresh(), reading(true, "t1"));
    expect(once.serverTurn).toEqual({ active: true, turnId: "t1" });
    expect(reduce(once, reading(true, "t1")).state).toBe(once);
    expect(run(once, reading(false, "t1")).serverTurn).toEqual({ active: false, turnId: "t1" });
  });

  it("a null reading clears what was held and decides nothing", () => {
    const s = run(fresh(), reading(false, "t1"));
    const cleared = run(s, { type: "server_turn", latch: null, cardId: "c1" } as CodeSessionEvent);
    expect(cleared.serverTurn).toBeNull();
    expect(reduce(cleared, { type: "server_turn", latch: null, cardId: "c1" } as CodeSessionEvent).state).toBe(cleared);
  });

  it("an idle card records an idle reading's turn as one it is past", () => {
    expect(run(fresh(), reading(false, "t1")).knownTurnIds).toEqual(["t1"]);
  });

  it("a busy card, or a reading of a running turn, records nothing", () => {
    expect(run(fresh(), send("k1"), reading(false, "t9")).knownTurnIds).toEqual([]);
    expect(run(fresh(), reading(true, "t1")).knownTurnIds).toEqual([]);
    expect(run(fresh(), reading(false, null)).knownTurnIds).toEqual([]);
  });
});

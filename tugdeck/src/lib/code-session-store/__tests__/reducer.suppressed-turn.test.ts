/**
 * Reducer tests for single-turn suppression and the legacy fake-compaction
 * replay reconstruction ([P06]).
 *
 * A suppressed turn runs on claude (the send-frame still goes out) but is
 * never committed to the transcript: `turn_complete` drops the append, and the
 * in-flight active turn reports `suppressed: true` so the data source skips it.
 * The `suppress` option survives the native-`/compact` migration (test-surface
 * uses it generically); only `/compact`'s use of it went away.
 *
 * The reload-reconstruction block is the legacy proof: OLD JSONLs with
 * `<!-- tug:compact-seed -->` blocks (`compactionSummary`) and canceled
 * summarize turns (`suppressedTurn`) must keep restoring. The
 * `mark_compaction_seed` event and the deferred send-path seed flush are gone
 * with the fork, so their coverage is deleted, not kept.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  deriveActiveTurnSnapshot,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import { isAppendTranscript } from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function send(suppress: boolean): CodeSessionEvent {
  return {
    type: "send",
    text: "seed",
    atoms: [],
    content: [{ type: "text" as const, text: "seed" }],
    turnKey: "k1",
    suppress,
  } as CodeSessionEvent;
}

const ASSISTANT: CodeSessionEvent = {
  type: "assistant_text", msg_id: "m1", block_index: 0, text: "ok", is_partial: false,
} as CodeSessionEvent;
const COMPLETE: CodeSessionEvent = { type: "turn_complete", msg_id: "m1", result: "success" } as CodeSessionEvent;

describe("reducer — suppressed turn", () => {
  it("a suppressed turn still emits the send-frame (claude runs it)", () => {
    const { effects } = reduce(fresh(), send(true));
    expect(effects.some((e) => e.kind === "send-frame")).toBe(true);
  });

  it("the in-flight suppressed turn reports suppressed:true", () => {
    const state = reduce(fresh(), send(true)).state;
    expect(deriveActiveTurnSnapshot(state)?.suppressed).toBe(true);
  });

  it("turn_complete does NOT append a suppressed turn to the transcript", () => {
    let s = fresh();
    s = reduce(s, send(true)).state;
    s = reduce(s, ASSISTANT).state;
    const { effects } = reduce(s, COMPLETE);
    expect(effects.some(isAppendTranscript)).toBe(false);
  });

  it("an ordinary (non-suppressed) turn DOES append", () => {
    let s = fresh();
    s = reduce(s, send(false)).state;
    s = reduce(s, ASSISTANT).state;
    const { effects } = reduce(s, COMPLETE);
    expect(effects.some(isAppendTranscript)).toBe(true);
  });

  it("a non-suppressed send carries only the user content (no seed prepend)", () => {
    const frame = reduce(fresh(), send(false)).effects.find(
      (e) => e.kind === "send-frame",
    );
    if (frame === undefined || frame.kind !== "send-frame") {
      throw new Error("no send-frame effect");
    }
    if (frame.msg.type !== "user_message") throw new Error("not a user_message");
    expect(frame.msg.content).toEqual([{ type: "text", text: "seed" }]);
  });

  it("interrupting a suppressed turn does NOT strand its prompt in the composer", () => {
    let s = fresh();
    s = reduce(s, send(true)).state; // suppressed, no assistant content yet (CASE A)
    const r = reduce(s, { type: "interrupt_action" } as CodeSessionEvent);
    expect(r.state.phase).toBe("idle");
    expect(r.state.pendingDraftRestore).toBeNull();
  });

  it("interrupting an ordinary turn DOES restore its draft (the contrast)", () => {
    let s = fresh();
    s = reduce(s, send(false)).state;
    const r = reduce(s, { type: "interrupt_action" } as CodeSessionEvent);
    expect(r.state.pendingDraftRestore).toEqual({ text: "seed", atoms: [] });
  });
});

describe("reducer — reload reconstruction of the carry-forward (legacy)", () => {
  function replaying(): CodeSessionState {
    return reduce(fresh(), { type: "replay_started" } as CodeSessionEvent).state;
  }

  it("an add_user_message carrying compactionSummary re-marks the carry-forward and shows only the residual bubble", () => {
    const r = reduce(replaying(), {
      type: "add_user_message",
      text: "start the arc",
      atoms: [],
      turnKey: "u1",
      compactionSummary: "recap body",
    } as CodeSessionEvent);
    expect(r.state.compactionSeed).toEqual({
      summary: "recap body",
      preTokens: null,
    });
    expect(r.state.scratch.get("u1")?.messages[0]).toMatchObject({
      kind: "user_message",
      text: "start the arc",
    });
  });

  it("an ordinary replay opener leaves compactionSeed untouched", () => {
    const r = reduce(replaying(), {
      type: "add_user_message",
      text: "hello",
      atoms: [],
      turnKey: "u1",
    } as CodeSessionEvent);
    expect(r.state.compactionSeed).toBeNull();
  });

  it("a canceled /compact summarization turn replayed from JSONL is dropped", () => {
    let s = replaying();
    s = reduce(s, {
      type: "add_user_message",
      text: "Please write a detailed summary…",
      atoms: [],
      turnKey: "u1",
      suppressedTurn: true,
    } as CodeSessionEvent).state;
    // The partial recap claude streamed before the cancel.
    s = reduce(s, {
      type: "assistant_text",
      msg_id: "m1",
      block_index: 0,
      text: "Conversation Summary…",
      is_partial: true,
    } as CodeSessionEvent).state;
    const r = reduce(s, {
      type: "turn_complete",
      msg_id: "m1",
      result: "interrupted",
    } as CodeSessionEvent);
    expect(r.effects.some(isAppendTranscript)).toBe(false);
  });

  it("an ordinary replayed turn still commits (the contrast)", () => {
    let s = replaying();
    s = reduce(s, {
      type: "add_user_message",
      text: "hello",
      atoms: [],
      turnKey: "u1",
    } as CodeSessionEvent).state;
    s = reduce(s, {
      type: "assistant_text",
      msg_id: "m1",
      block_index: 0,
      text: "hi",
      is_partial: false,
    } as CodeSessionEvent).state;
    const r = reduce(s, {
      type: "turn_complete",
      msg_id: "m1",
      result: "success",
    } as CodeSessionEvent);
    expect(r.effects.some(isAppendTranscript)).toBe(true);
  });
});

/**
 * `isTextOnlyChange` — which streamed deltas the session snapshot does not
 * publish.
 *
 * A same-phase text or thinking delta that only grew a Message's text costs
 * React nothing: the `PropertyStore` carries the text and the snapshot stays
 * pinned. The function decides that by what the delta changed, not by its
 * event name, so the cases here are the deltas that look like text and are
 * not: one that mints a Message, one that clears a retry, one that releases a
 * held send. Each changed something a reader draws, and must publish.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  isTextOnlyChange,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function send(): CodeSessionEvent {
  return {
    type: "send",
    text: "hi",
    atoms: [],
    content: [{ type: "text" as const, text: "hi" }],
    turnKey: "k1",
  } as CodeSessionEvent;
}

function blockStart(blockIndex: number, kind: "text" | "thinking" = "text"): CodeSessionEvent {
  return {
    type: "content_block_start",
    msg_id: "m1",
    block_index: blockIndex,
    kind,
  } as CodeSessionEvent;
}

function delta(
  text: string,
  blockIndex = 0,
  type: "assistant_text" | "thinking_text" = "assistant_text",
): CodeSessionEvent {
  return {
    type,
    msg_id: "m1",
    block_index: blockIndex,
    text,
    is_partial: true,
  } as CodeSessionEvent;
}

function apiRetry(): CodeSessionEvent {
  return {
    type: "api_retry",
    attempt: 1,
    maxRetries: 10,
    deadline: 1_700_000_010_000,
    error: "ECONNRESET: socket hang up",
    errorStatus: null,
  } as CodeSessionEvent;
}

function applyAll(state: CodeSessionState, events: ReadonlyArray<CodeSessionEvent>): CodeSessionState {
  let current = state;
  for (const ev of events) current = reduce(current, ev).state;
  return current;
}

/** A turn already streaming into one text Message, past every phase crossing. */
function streaming(): CodeSessionState {
  return applyAll(fresh(), [send(), blockStart(0), delta("a"), delta("b")]);
}

describe("isTextOnlyChange", () => {
  it("a delta that only grows an existing Message's text is text-only", () => {
    const prev = streaming();
    expect(prev.phase).toBe("streaming");
    const next = reduce(prev, delta("c")).state;
    expect(next).not.toBe(prev);
    expect(isTextOnlyChange(prev, next)).toBe(true);
  });

  it("a thinking delta that only grows its Message is text-only too", () => {
    const prev = applyAll(streaming(), [blockStart(1, "thinking"), delta("t", 1, "thinking_text")]);
    const next = reduce(prev, delta("u", 1, "thinking_text")).state;
    expect(isTextOnlyChange(prev, next)).toBe(true);
  });

  it("a delta that mints a Message is structural: the list gains a row", () => {
    const prev = streaming();
    // No `content_block_start` for block 1, so the delta mints defensively.
    const next = reduce(prev, delta("new block", 1)).state;
    expect(isTextOnlyChange(prev, next)).toBe(false);
  });

  it("a block start that mints a Message is structural", () => {
    const prev = streaming();
    const next = reduce(prev, blockStart(1)).state;
    expect(isTextOnlyChange(prev, next)).toBe(false);
  });

  it("a delta that clears a live retry announcement is structural", () => {
    const prev = reduce(streaming(), apiRetry()).state;
    expect(prev.apiRetry).not.toBeNull();
    const next = reduce(prev, delta("c")).state;
    expect(next.apiRetry).toBeNull();
    expect(isTextOnlyChange(prev, next)).toBe(false);
  });

  it("a delta that clears a stream stall is structural", () => {
    const stalled = { ...streaming(), streamStalled: true } as CodeSessionState;
    const next = reduce(stalled, delta("c")).state;
    expect(next.streamStalled).toBe(false);
    expect(isTextOnlyChange(stalled, next)).toBe(false);
  });

  it("a delta that releases a held send is structural", () => {
    // A send made while claude retries queues behind the open turn, held.
    // The held queue is carried onto a state with no retry standing, so the
    // release is the only thing besides text the delta changes.
    const heldQueue = applyAll(streaming(), [apiRetry(), send()]).queuedSends;
    expect(heldQueue[0]?.held).toBe(true);
    const prev = { ...streaming(), queuedSends: heldQueue } as CodeSessionState;
    const next = reduce(prev, delta("c")).state;
    expect(next.queuedSends[0]?.held).toBe(false);
    expect(next.apiRetry).toBe(prev.apiRetry);
    expect(isTextOnlyChange(prev, next)).toBe(false);
  });

  it("an unchanged state is text-only: nothing moved at all", () => {
    const s = streaming();
    expect(isTextOnlyChange(s, s)).toBe(true);
  });
});

/**
 * Unsent text at application exit.
 *
 * Two kinds of user text live only in memory: sends queued behind a running
 * turn, and a submission pulled back by a CASE A interrupt (parked in
 * `pendingDraftRestore` until a render seeds it into the composer). At quit
 * neither has a durable home, so the termination pipeline folds both into
 * the draft it persists — via `captureUnsentText`.
 *
 * The ordering trap this pins: the pipeline interrupts live turns *before*
 * it captures (a CASE A interrupt is what produces the pulled-back text in
 * the first place), and a CASE A interrupt clears `queuedSends`. So the
 * pipeline stashes the queue first — `stashUnsentText` — and the capture
 * reports the union, oldest first.
 *
 * Real store, real reducer, scripted wire frames.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";
import {
  networkPathStore,
  networkPathFromPayload,
} from "@/lib/network-path-store";

/**
 * Put the host's path hint into a given state for the duration of one test.
 *
 * The store is a module singleton, so every use resets it afterwards — and
 * resets it to "the host has not said" (`{}`) rather than to `satisfied`,
 * because a transition into `satisfied` is a release event and would flush a
 * held prompt out of the queue the test is still looking at.
 */
function withPathReport<T>(
  payload: Record<string, unknown>,
  body: () => T,
): T {
  try {
    networkPathStore.apply(networkPathFromPayload(payload));
    return body();
  } finally {
    networkPathStore.apply(networkPathFromPayload({}));
  }
}

function constructStore(conn: TestFrameChannel): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

/**
 * Advance a submitted turn with thinking only. Thinking does not cross the
 * answer line, so the turn stays a clean CASE A pull-down — which is what a
 * quit during "claude is thinking" actually looks like.
 */
function driveToThinking(conn: TestFrameChannel, msgId: string): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "thinking_text",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: msgId,
    block_index: 0,
    text: "pondering",
    is_partial: true,
  });
}

/** Advance a turn past the first answer delta, making it CASE B. */
function driveToAnswer(conn: TestFrameChannel, msgId: string): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "assistant_text",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: msgId,
    text: "here is the answer",
    is_partial: true,
    rev: 0,
    seq: 0,
  });
}

describe("CodeSessionStore.captureUnsentText", () => {
  it("is empty for an idle session with nothing queued", () => {
    const store = constructStore(new TestFrameChannel());
    expect(store.captureUnsentText()).toEqual([]);
  });

  it("reports queued sends in the order they were queued", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("the turn that is running", []);
    driveToThinking(conn, FIXTURE_IDS.MSG_ID_N(1));
    store.send("queued first", []);
    store.send("queued second", []);

    expect(store.captureUnsentText()).toEqual(["queued first", "queued second"]);
  });

  it("keeps queued text across the CASE A interrupt that clears the queue", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("pulled back", []);
    driveToThinking(conn, FIXTURE_IDS.MSG_ID_N(1));
    store.send("queued first", []);
    store.send("queued second", []);

    // What the termination pipeline does, in order.
    store.stashUnsentText();
    store.interrupt();

    // CASE A: the in-flight submission is parked for re-edit and the queue
    // is cleared by the reducer — the exact loss this stash exists for.
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.pendingDraftRestore?.text).toBe("pulled back");
    expect(snap.queuedSends).toEqual([]);

    expect(store.captureUnsentText()).toEqual([
      "pulled back",
      "queued first",
      "queued second",
    ]);
  });

  it("captures a prompt held for the network, exactly once", () => {
    // A held prompt rides `queuedSends` rather than a second queue ([P09]),
    // which is the whole reason it survives quit with no new persistence
    // work: this capture already walks that FIFO, and the prompt entry folds
    // the result into the draft it persists on a "termination" save ([L23]).
    const store = constructStore(new TestFrameChannel());

    withPathReport({ status: "unsatisfied" }, () => {
      store.send("written on a plane", []);
      // Nothing was sent — the card is idle and the words are in the queue.
      const snap = store.getSnapshot();
      expect(snap.phase).toBe("idle");
      expect(snap.queuedSends.length).toBe(1);
      expect(snap.queuedSends[0].held).toBe(true);

      expect(store.captureUnsentText()).toEqual(["written on a plane"]);
    });
  });

  it("deduplicates a held prompt against the stash, as it does a queued one", () => {
    const store = constructStore(new TestFrameChannel());

    withPathReport({ status: "unsatisfied" }, () => {
      store.send("held once", []);
      store.stashUnsentText();
      // The stash and the live queue hold the same text; the union reports
      // it once, which is what the composer receives.
      expect(store.captureUnsentText()).toEqual(["held once"]);
    });
  });

  it("does not report the same text twice when the interrupt left the queue intact", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("running", []);
    driveToThinking(conn, FIXTURE_IDS.MSG_ID_N(1));
    store.send("queued once", []);

    store.stashUnsentText();
    // No interrupt — the stash and the live queue hold the same text.
    expect(store.captureUnsentText()).toEqual(["queued once"]);
  });
});

describe("termination interrupt gate", () => {
  it("publishes canInterrupt for a running turn and withholds it when idle", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    expect(store.getSnapshot().canInterrupt).toBe(false);

    store.send("running", []);
    expect(store.getSnapshot().canInterrupt).toBe(true);

    driveToThinking(conn, FIXTURE_IDS.MSG_ID_N(1));
    expect(store.getSnapshot().canInterrupt).toBe(true);

    store.interrupt();
    expect(store.getSnapshot().phase).toBe("idle");
    expect(store.getSnapshot().canInterrupt).toBe(false);
  });

  it("a CASE A interrupt settles synchronously, so the pipeline never waits on it", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("pull me back", []);
    let notified = false;
    store.subscribe(() => {
      notified = true;
    });

    store.interrupt();

    // Settled inside `interrupt()` — the subscription fired and the phase is
    // already terminal, which is what lets an idle-ish quit add no latency.
    expect(notified).toBe(true);
    expect(store.getSnapshot().phase).toBe("idle");
  });

  it("a CASE B turn stays open until the wire commits it — the case the bound exists for", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("answer me", []);
    driveToAnswer(conn, FIXTURE_IDS.MSG_ID_N(1));

    store.interrupt();

    // Answer content has begun, so the turn is not retractable: the pipeline
    // has to wait for the wire, which is why the await is bounded rather
    // than unconditional.
    expect(store.getSnapshot().phase).not.toBe("idle");

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "turn_complete",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "interrupted",
    });

    expect(store.getSnapshot().phase).toBe("idle");
  });
});

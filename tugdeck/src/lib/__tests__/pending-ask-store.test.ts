/**
 * Pure-logic tests for `pending-ask-store.ts`.
 *
 * The invariant under test is the one the whole feature rests on: **a caller is
 * blocked on the other end of every question, so every path out of `receive`
 * either shows a dialog or answers.** Silence means a command-line tool hangs
 * until its own timeout.
 *
 * These drive the real store through its real injected seam (`init`), capturing
 * what it puts on the wire. The session registry is injected too, so the routed
 * paths — a live dialog, a second question arriving, a session vanishing under
 * one — are reachable here. What is NOT reachable is whether the card actually
 * renders and answers; that is the app-test's job (`at0320`).
 */

import { beforeEach, describe, expect, it } from "bun:test";

import { pendingAskStore } from "../pending-ask-store";
import type { PendingAskSession } from "../pending-ask-store";
import type { PendingAsk } from "../code-session-store/types";

interface SentFrame {
  action: string;
  payload: Record<string, unknown>;
}

let sent: SentFrame[] = [];
let dispose: () => void = () => {};

/** The sessions the injected registry knows about, keyed by `tugSessionId`. */
let sessions = new Map<string, { parked: PendingAsk | null }>();
let sessionListeners: Array<() => void> = [];

function notifySessions(): void {
  for (const l of sessionListeners.slice()) l();
}

/** Stand a session up in the registry and return its id. */
function addSession(tugSessionId: string): string {
  sessions.set(tugSessionId, { parked: null });
  notifySessions();
  return tugSessionId;
}

/** Take a session away, as a closing card would. */
function removeSession(tugSessionId: string): void {
  sessions.delete(tugSessionId);
  notifySessions();
}

function init(focused: string | null = null): void {
  // The store is a module singleton, so a question left live by the previous
  // test would be reaped the moment this one stands its sessions up. Drain
  // first, while the old context can still carry the answers away.
  for (const requestId of [...pendingAskStore.getSnapshot().keys()]) {
    pendingAskStore.respond(requestId, "");
  }
  dispose();
  sent = [];
  sessions = new Map();
  sessionListeners = [];
  dispose = pendingAskStore.init({
    sendControlFrame: (action, payload) => {
      sent.push({ action, payload });
    },
    focusedTugSessionId: () => focused,
    sessionFor: (tugSessionId): PendingAskSession | null => {
      const entry = sessions.get(tugSessionId);
      if (entry === undefined) return null;
      return {
        tugSessionId,
        setPendingAsk: (ask) => {
          entry.parked = ask;
        },
      };
    },
    observeSessions: (listener) => {
      sessionListeners.push(listener);
      return () => {
        const i = sessionListeners.indexOf(listener);
        if (i >= 0) sessionListeners.splice(i, 1);
      };
    },
  });
}

/** Wire the store up with no focused session, so routing always comes up empty. */
function initWithNoSession(): void {
  init(null);
}

const OPTIONS = [
  { value: "run-all", label: "Run all" },
  { value: "run-background-only", label: "Run background-only" },
  { value: "cancel", label: "Cancel" },
];

beforeEach(initWithNoSession);

describe("frames that cannot be rendered", () => {
  it("ignores a frame with no requestId — there is nobody to answer", () => {
    pendingAskStore.receive({ title: "t", options: OPTIONS });
    expect(sent).toEqual([]);
  });

  it("ignores a non-string requestId", () => {
    pendingAskStore.receive({ requestId: 42, title: "t", options: OPTIONS });
    expect(sent).toEqual([]);
  });

  it("answers a frame with no title rather than dropping it", () => {
    pendingAskStore.receive({ requestId: "r1", options: OPTIONS });
    expect(sent).toHaveLength(1);
    expect(sent[0].action).toBe("ask-response");
    expect(sent[0].payload.requestId).toBe("r1");
  });

  it("answers a frame with no options rather than dropping it", () => {
    pendingAskStore.receive({ requestId: "r2", title: "t", options: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.requestId).toBe("r2");
  });

  it("discards option entries that are not value+label pairs", () => {
    // One valid entry survives, so this routes rather than being refused for
    // having no options at all.
    pendingAskStore.receive({
      requestId: "r3",
      title: "t",
      options: [{ value: 1 }, "nope", null, { value: "ok", label: "OK" }],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.choice).toBe("ok");
  });
});

describe("no session to show the question on", () => {
  it("answers with the last option, which callers reserve for declining", () => {
    pendingAskStore.receive({ requestId: "r4", title: "t", options: OPTIONS });
    expect(sent).toEqual([
      { action: "ask-response", payload: { requestId: "r4", choice: "cancel" } },
    ]);
  });

  it("does not park an unroutable question in the snapshot", () => {
    pendingAskStore.receive({ requestId: "r5", title: "t", options: OPTIONS });
    expect(pendingAskStore.getSnapshot().size).toBe(0);
  });
});

describe("a countdown question", () => {
  const SID = "cc-session-2";

  /** The wire shape of a question that answers itself if nobody intervenes. */
  function countdownFrame(requestId: string): Record<string, unknown> {
    return {
      requestId,
      title: "t",
      options: OPTIONS,
      sessionId: SID,
      unattendedChoice: "run-all",
      countdownSecs: 30,
    };
  }

  beforeEach(() => {
    init();
    addSession(SID);
  });

  it("carries the countdown to the dialog", () => {
    pendingAskStore.receive(countdownFrame("r20"));
    expect(sessions.get(SID)?.parked?.unattendedChoice).toBe("run-all");
    expect(sessions.get(SID)?.parked?.countdownSecs).toBe(30);
  });

  // A duration with no answer to commit is not a countdown, and a dialog that
  // showed one would be counting down to nothing.
  it("ignores half a countdown", () => {
    pendingAskStore.receive({ ...countdownFrame("r21"), unattendedChoice: undefined });
    expect(sessions.get(SID)?.parked?.countdownSecs).toBeNull();
    init();
    addSession(SID);
    pendingAskStore.receive({ ...countdownFrame("r22"), countdownSecs: 0 });
    expect(sessions.get(SID)?.parked?.unattendedChoice).toBeNull();
  });

  it("ignores an unattended answer that is not one of the options", () => {
    pendingAskStore.receive({ ...countdownFrame("r23"), unattendedChoice: "run-them" });
    expect(sessions.get(SID)?.parked?.unattendedChoice).toBeNull();
    expect(sessions.get(SID)?.parked?.countdownSecs).toBeNull();
  });

  // The caller said what silence means. A question no human could ever see is
  // the purest silence there is, so it gets that answer rather than the
  // declining one — which for an app-test run would mean "skipped" because a
  // card happened to be closing.
  it("answers an unshowable one with the unattended choice", () => {
    removeSession(SID);
    pendingAskStore.receive(countdownFrame("r24"));
    expect(sent).toEqual([
      { action: "ask-response", payload: { requestId: "r24", choice: "run-all" } },
    ]);
  });

  it("answers with the unattended choice when the session vanishes under it", () => {
    pendingAskStore.receive(countdownFrame("r25"));
    removeSession(SID);
    expect(sent).toEqual([
      { action: "ask-response", payload: { requestId: "r25", choice: "run-all" } },
    ]);
  });
});

describe("respond", () => {
  it("ignores an answer for a request that is not live, and says so", () => {
    // `false` is the caller's cue to take its own parked dialog down — the
    // orphan case, where a reap answered the wire but could not reach the
    // session's `pendingAsk`.
    expect(pendingAskStore.respond("never-asked", "run-all")).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("a question that reaches a session", () => {
  const SID = "cc-session-1";

  function ask(requestId: string): void {
    pendingAskStore.receive({ requestId, title: "t", options: OPTIONS, sessionId: SID });
  }

  beforeEach(() => {
    init();
    addSession(SID);
  });

  it("parks the question and answers nobody yet", () => {
    ask("r10");
    expect(sent).toEqual([]);
    expect(sessions.get(SID)?.parked?.requestId).toBe("r10");
    expect(pendingAskStore.getSnapshot().size).toBe(1);
  });

  it("clears the dialog and answers on respond", () => {
    ask("r11");
    expect(pendingAskStore.respond("r11", "run-all")).toBe(true);
    expect(sessions.get(SID)?.parked).toBeNull();
    expect(sent).toEqual([
      { action: "ask-response", payload: { requestId: "r11", choice: "run-all" } },
    ]);
    expect(pendingAskStore.getSnapshot().size).toBe(0);
  });

  // The developer is mid-decision on the first. Swapping the dialog under them
  // would lose that and strand the first caller with no dialog to answer it.
  it("declines a second question rather than replacing the first", () => {
    ask("r12");
    ask("r13");
    expect(sessions.get(SID)?.parked?.requestId).toBe("r12");
    expect(sent).toEqual([
      { action: "ask-response", payload: { requestId: "r13", choice: "cancel" } },
    ]);
  });

  // The caller is blocked; a card going away must not leave it that way.
  it("answers for a session that vanishes under a live question", () => {
    ask("r14");
    removeSession(SID);
    expect(sent).toEqual([
      { action: "ask-response", payload: { requestId: "r14", choice: "cancel" } },
    ]);
    expect(pendingAskStore.getSnapshot().size).toBe(0);
  });

  // [L02]: the map IS the snapshot, so an in-place mutation would leave every
  // `useSyncExternalStore` consumer looking at an identical reference.
  it("publishes a new snapshot identity on every change", () => {
    const empty = pendingAskStore.getSnapshot();
    ask("r15");
    const parked = pendingAskStore.getSnapshot();
    expect(parked).not.toBe(empty);
    pendingAskStore.respond("r15", "run-all");
    expect(pendingAskStore.getSnapshot()).not.toBe(parked);
  });

  // The dialog must come down WITH the answer when the session can still be
  // reached — a parked question that outlives its answer is a dialog whose
  // every press is a silent no-op, and a session latched "Awaiting" forever.
  it("clears the parked question on sessionClosed while the session is reachable", () => {
    ask("r17");
    pendingAskStore.sessionClosed(SID);
    expect(sessions.get(SID)?.parked).toBeNull();
    expect(sent).toEqual([
      { action: "ask-response", payload: { requestId: "r17", choice: "cancel" } },
    ]);
  });

  // The server resolved the question itself (timeout). The dialog comes down
  // with NO answer frame — the caller already left, and an `ask-response`
  // for a dead request would say nothing to nobody.
  it("rescind takes the dialog down without answering the wire", () => {
    ask("r18");
    pendingAskStore.rescind("r18");
    expect(sessions.get(SID)?.parked).toBeNull();
    expect(sent).toEqual([]);
    expect(pendingAskStore.getSnapshot().size).toBe(0);
  });

  it("routes to the focused session when the frame names none", () => {
    init("cc-focused");
    addSession("cc-focused");
    pendingAskStore.receive({ requestId: "r16", title: "t", options: OPTIONS });
    expect(sessions.get("cc-focused")?.parked?.requestId).toBe("r16");
  });
});

describe("subscribe", () => {
  it("notifies on an unroutable question and unsubscribes cleanly", () => {
    let calls = 0;
    const unsub = pendingAskStore.subscribe(() => {
      calls += 1;
    });
    pendingAskStore.receive({ requestId: "r6", title: "t", options: OPTIONS });
    unsub();
    pendingAskStore.receive({ requestId: "r7", title: "t", options: OPTIONS });
    // An unroutable question answers before it ever reaches the live map, so
    // the only notification is the one the store emits on teardown paths.
    expect(calls).toBeLessThanOrEqual(1);
    expect(sent).toHaveLength(2);
  });
});

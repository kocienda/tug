/**
 * changeset-join-store — the dash-join resolve overlay over the ladder's
 * CONTROL frames (Spec S12): resolving → per-file deltas → out of the way,
 * keyed by (workspace_key, dash).
 *
 * The overlay holds the *run*, never its result. What the ladder built lands in
 * git and comes back on the dash's feed entry, so what these cases pin is that
 * an `_ok` puts the overlay away rather than becoming a second, competing
 * account of the resolution — and that a run which stops talking always ends in
 * a sentence rather than a spinner nothing will ever take down.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  ConnectionLifecycle,
  getConnectionLifecycle,
  registerConnectionLifecycle,
} from "../connection-lifecycle";
import {
  attachChangesetJoinStore,
  _resetChangesetJoinStoreForTest,
  _ingestJoinFrameForTest,
} from "../changeset-join-store";

const fakeConn = { onFrame: () => () => {}, sendControlFrame: () => {} } as never;

const K = { project_dir: "/p", dash: "demo" };

beforeEach(() => _resetChangesetJoinStoreForTest());

describe("changeset join resolve overlay", () => {
  test("deltas accumulate per file, then ok puts the overlay away", () => {
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_delta",
      ...K,
      path: "a.rs",
      rung: "ai",
      status: "trying",
    });
    expect(store.state("/p", "demo").phase).toBe("resolving");

    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_delta",
      ...K,
      path: "a.rs",
      rung: "ai",
      status: "streaming",
      text: "merged so far",
    });
    // The per-file progress collapses to one latest entry per path.
    const resolving = store.state("/p", "demo");
    expect(resolving.progress.length).toBe(1);
    expect(resolving.progress[0]).toMatchObject({
      path: "a.rs",
      rung: "ai",
      status: "streaming",
      text: "merged so far",
    });

    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [
        { path: "a.rs", resolved_by: "ai", diff: "@@ -1 +1 @@\n-old\n+new\n", added: 1, removed: 1 },
        // Counts are optional on the wire — git omits them for a binary path.
        { path: "b.bin", resolved_by: "driver", diff: "Binary files differ\n" },
      ],
      unresolved: [],
      candidate_commit: "abc123",
      shape: "squash",
    });
    // The run is over, so the overlay is over. The candidate and every file's
    // rung and diff came back in the same frame, and every one of them is
    // ignored here on purpose: the server wrote them into git before it bumped
    // the feed, and the row reads them from there. A copy kept here would be a
    // second account of the same resolution, free to disagree with the first —
    // which is what a reload used to expose, and what a lost frame used to
    // destroy.
    const done = store.state("/p", "demo");
    expect(done.phase).toBe("idle");
    expect(done.progress).toEqual([]);
    expect(done.error).toBeNull();
  });

  test("review pins the acknowledgment to the candidate's sha, on the wire", () => {
    // The review is not a client flag: it is a mark the server writes against
    // this exact candidate, so a candidate rebuilt after the base moved cannot
    // inherit a reading that answered a different one. The store's whole part
    // is the send.
    const sent: { action: string; body: Record<string, unknown> }[] = [];
    const conn = {
      onFrame: () => () => {},
      sendControlFrame: (action: string, body: Record<string, unknown>) => {
        sent.push({ action, body });
      },
    } as never;
    const store = attachChangesetJoinStore(conn);
    store.review("/u/src/tugtool", "demo", "abc123");
    expect(sent).toEqual([
      {
        action: "changeset_join_review",
        body: { project_dir: "/u/src/tugtool", dash: "demo", candidate: "abc123" },
      },
    ]);
  });

  test("answering an escalation carries the request id that scopes it", () => {
    // The request id is the whole safety of this send. A resolve that already
    // expired, or a later one asking something else, must not be resolved by
    // an answer written for a different question — so the answer names which
    // one it belongs to and the server matches on that, not on the dash.
    const sent: { action: string; body: Record<string, unknown> }[] = [];
    const conn = {
      onFrame: () => () => {},
      sendControlFrame: (action: string, body: Record<string, unknown>) => {
        sent.push({ action, body });
      },
    } as never;
    const store = attachChangesetJoinStore(conn);
    store.answerQuestion("/u/src/tugtool", "demo", "join-demo-7", "the dash");
    expect(sent).toEqual([
      {
        action: "changeset_join_question_answer",
        body: {
          project_dir: "/u/src/tugtool",
          dash: "demo",
          request_id: "join-demo-7",
          answer: "the dash",
        },
      },
    ]);
  });

  test("ok with unresolved files names them, because the feed cannot", () => {
    // The ladder's honest dead end. The dash's conflicts are still on the feed,
    // but nothing on the entry says a run just tried them and stopped — so
    // clearing the overlay here would erase the only record that re-running
    // decides nothing new.
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "driver" }],
      unresolved: ["b.rs", "c.rs"],
      candidate_commit: null,
      shape: "squash",
    });
    const st = store.state("/p", "demo");
    expect(st.phase).toBe("error");
    expect(st.error).toBe("Still conflicting — resolve by hand: b.rs, c.rs");
  });

  test("err carries the detail", () => {
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_err",
      ...K,
      detail: "Dash not found",
    });
    const st = store.state("/p", "demo");
    expect(st.phase).toBe("error");
    expect(st.error).toBe("Dash not found");
  });

  test("clear resets to idle; unrelated dashes stay idle", () => {
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_delta",
      ...K,
      path: "a.rs",
      rung: "ai",
      status: "trying",
    });
    expect(store.state("/other", "x").phase).toBe("idle");
    store.clear("/p", "demo");
    expect(store.state("/p", "demo").phase).toBe("idle");
  });
});

/**
 * The lifecycle the store will actually subscribe to.
 *
 * Registering one is not enough to know you have it: two suites in this repo
 * `mock.module` the whole connection-lifecycle module, and bun keeps a module
 * mock for the rest of the single-process run — so in a full sweep
 * `registerConnectionLifecycle` is a no-op and the store subscribes to the
 * mock's instance. Reading the singleton back after registering gets whichever
 * instance is real in this run.
 */
function liveLifecycle(): ConnectionLifecycle {
  registerConnectionLifecycle(new ConnectionLifecycle());
  const live = getConnectionLifecycle();
  if (live === null) throw new Error("no connection lifecycle to drop");
  return live;
}

describe("a run whose answer never arrives", () => {
  test("the wire dropping mid-ladder fails the run instead of latching it", () => {
    try {
      const lifecycle = liveLifecycle();
      const store = attachChangesetJoinStore(fakeConn);
      store.resolve("/p", "demo");
      expect(store.state("/p", "demo").phase).toBe("resolving");

      // The server finished and broadcast its result to a socket that was
      // already gone. Nothing will replay a CONTROL reply, so the run has no
      // answer coming — and `resolving` with no answer coming is the shade
      // stuck with the Resolve button gone and nothing in its place.
      lifecycle.notifyConnectionDidClose();

      const dropped = store.state("/p", "demo");
      expect(dropped.phase).toBe("error");
      expect(dropped.error).toContain("connection dropped");
    } finally {
      registerConnectionLifecycle(null);
    }
  });

  test("a finished run is not failed retroactively when the wire drops", () => {
    try {
      const lifecycle = liveLifecycle();
      const store = attachChangesetJoinStore(fakeConn);
      _ingestJoinFrameForTest({
        action: "changeset_join_resolve_ok",
        ...K,
        resolved: [{ path: "a.rs", resolved_by: "driver", diff: "@@\n" }],
        unresolved: [],
        candidate_commit: "abc123",
        shape: "squash",
      });
      lifecycle.notifyConnectionDidClose();

      // Idle, not error: the run ended, and the resolution it built is in git
      // where a dropped socket cannot reach it.
      expect(store.state("/p", "demo").phase).toBe("idle");
    } finally {
      registerConnectionLifecycle(null);
    }
  });
});

/**
 * The silence deadline, driven on the real timer at a compressed length —
 * `attachChangesetJoinStore` takes the interval so these cases exercise the
 * shipping `setTimeout` path rather than a faked clock.
 */
describe("the silence deadline", () => {
  const DEADLINE = 20;
  const settle = (ms: number): Promise<void> =>
    new Promise((done) => setTimeout(done, ms));

  test("a run that goes quiet is declared lost, and names the deadline", async () => {
    const store = attachChangesetJoinStore(fakeConn, DEADLINE);
    store.resolve("/p", "demo");
    expect(store.state("/p", "demo").phase).toBe("resolving");

    await settle(DEADLINE * 3);

    const lost = store.state("/p", "demo");
    expect(lost.phase).toBe("error");
    expect(lost.error).toContain("No answer");
  });

  test("a run that keeps talking outlives the deadline", async () => {
    const store = attachChangesetJoinStore(fakeConn, DEADLINE);
    store.resolve("/p", "demo");

    // A scribe streaming its merge. Each delta restarts the clock, so the run
    // survives a span several deadlines long — which is the whole reason the
    // deadline can be short enough to be useful.
    for (let i = 0; i < 5; i++) {
      await settle(DEADLINE / 2);
      _ingestJoinFrameForTest({
        action: "changeset_join_resolve_delta",
        ...K,
        path: "a.rs",
        rung: "ai",
        status: "streaming",
        text: `chunk ${i}`,
      });
      expect(store.state("/p", "demo").phase).toBe("resolving");
    }
  });

  test("an answer that arrives late still lands", async () => {
    const store = attachChangesetJoinStore(fakeConn, DEADLINE);
    store.resolve("/p", "demo");
    await settle(DEADLINE * 3);
    expect(store.state("/p", "demo").phase).toBe("error");

    // Nothing was cancelled — the ladder ran to completion on the server
    // whatever this client concluded — so its answer still takes the face off
    // the error the deadline put there.
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "driver", diff: "@@\n" }],
      unresolved: [],
      candidate_commit: "abc123",
      shape: "squash",
    });

    const late = store.state("/p", "demo");
    expect(late.phase).toBe("idle");
    expect(late.error).toBeNull();
  });

  test("a terminal answer stops the clock", async () => {
    const store = attachChangesetJoinStore(fakeConn, DEADLINE);
    store.resolve("/p", "demo");
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "driver", diff: "@@\n" }],
      unresolved: [],
      candidate_commit: "abc123",
      shape: "squash",
    });

    // The deadline that was live when the answer arrived must not fire behind
    // it and paint an error over a row that has already moved on.
    await settle(DEADLINE * 3);
    expect(store.state("/p", "demo").phase).toBe("idle");
  });
});

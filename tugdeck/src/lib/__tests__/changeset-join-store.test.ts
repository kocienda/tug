/**
 * changeset-join-store — the dash-join resolve overlay over the ladder's
 * CONTROL frames (Spec S12, [P31]/[P32]): resolving → per-file deltas →
 * resolved / partial / error, keyed by (project_dir, dash).
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
  test("deltas accumulate per file, then ok with a candidate → resolved", () => {
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
    const done = store.state("/p", "demo");
    expect(done.phase).toBe("resolved");
    expect(done.candidateCommit).toBe("abc123");
    expect(done.shape).toBe("squash");
    expect(done.resolved).toEqual([
      {
        path: "a.rs",
        resolvedBy: "ai",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
        added: 1,
        removed: 1,
      },
      {
        path: "b.bin",
        resolvedBy: "driver",
        diff: "Binary files differ\n",
        added: null,
        removed: null,
      },
    ]);
    // The ladder's decision arrives unread, whatever the last one was ([P31]).
    expect(done.reviewed).toBe(false);
  });

  test("markReviewed arms the candidate, and a fresh ladder run disarms it", () => {
    const store = attachChangesetJoinStore(fakeConn);
    const ok = {
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "rerere", diff: "@@ -1 +1 @@\n-x\n+y\n" }],
      unresolved: [],
      candidate_commit: "abc123",
      shape: "squash",
    };
    _ingestJoinFrameForTest(ok);
    expect(store.state("/p", "demo").reviewed).toBe(false);

    store.markReviewed("/p", "demo");
    expect(store.state("/p", "demo").reviewed).toBe(true);

    // A second run over the same dash is a second decision — the review it
    // carries is not the one the user read.
    _ingestJoinFrameForTest(ok);
    expect(store.state("/p", "demo").reviewed).toBe(false);
  });

  test("markReviewed is a no-op on a dash the ladder has not touched", () => {
    const store = attachChangesetJoinStore(fakeConn);
    store.markReviewed("/p", "never-resolved");
    expect(store.state("/p", "never-resolved").reviewed).toBe(false);
  });

  test("ok with unresolved files → partial, no candidate", () => {
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "driver" }],
      unresolved: ["b.rs"],
      candidate_commit: null,
      shape: "squash",
    });
    const st = store.state("/p", "demo");
    expect(st.phase).toBe("partial");
    expect(st.unresolved).toEqual(["b.rs"]);
    expect(st.candidateCommit).toBeNull();
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

  test("a result already in hand survives the wire dropping", () => {
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

      const done = store.state("/p", "demo");
      expect(done.phase).toBe("resolved");
      expect(done.candidateCommit).toBe("abc123");
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
    // whatever this client concluded — so its result is still true and takes
    // the face back off the error.
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "driver", diff: "@@\n" }],
      unresolved: [],
      candidate_commit: "abc123",
      shape: "squash",
    });

    const late = store.state("/p", "demo");
    expect(late.phase).toBe("resolved");
    expect(late.candidateCommit).toBe("abc123");
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
    // it and paint an error over a result the user is reading.
    await settle(DEADLINE * 3);
    expect(store.state("/p", "demo").phase).toBe("resolved");
  });
});

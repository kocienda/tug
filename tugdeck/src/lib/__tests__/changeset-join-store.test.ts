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

describe("the resolver rung is not measured by the client's clock ([P02])", () => {
  const DEADLINE = 20;
  const settle = (ms: number): Promise<void> =>
    new Promise((done) => setTimeout(done, ms));

  test("silence on the resolver rung is work, at every status", async () => {
    // The deadline's premise is per-chunk streaming. That is true of the scribe
    // and false of the resolver, which reports four discrete beats with minutes
    // of legitimate quiet between them — a model composing a reconciliation, a
    // build, a test selection. Measured by this clock, a healthy resolve was
    // declared dead and the error face re-mounted Resolve, which is how a
    // second run came to `reset --hard` the workshop the first was editing.
    const store = attachChangesetJoinStore(fakeConn, DEADLINE);
    store.resolve("/p", "demo");
    for (const status of ["working", "verifying", "iterating"]) {
      _ingestJoinFrameForTest({
        action: "changeset_join_resolve_delta",
        ...K,
        path: "",
        candidate: "cafe1234",
        rung: "resolver",
        status,
      });
      await settle(DEADLINE * 3);
      const live = store.state("/p", "demo");
      expect(live.phase).toBe("resolving");
      expect(live.error).toBeNull();
    }
    // Liveness for this rung is the server's: a per-turn silence bound, a
    // tier-0 timeout, and an overall deadline, each landing in the durable
    // stuck fact with a sentence naming which one fired.
  });

  test("the scribe rung is still on the clock", async () => {
    const store = attachChangesetJoinStore(fakeConn, DEADLINE);
    store.resolve("/p", "demo");
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_delta",
      ...K,
      path: "a.rs",
      rung: "ai",
      status: "streaming",
      text: "half a merge",
    });
    await settle(DEADLINE * 3);
    expect(store.state("/p", "demo").phase).toBe("error");
  });

  test("the resolver's progress names a candidate, not a path", () => {
    // The sha used to ride in `path`, which put a commit hash in the face's
    // filename column and made each status of one run key as a separate file.
    const store = attachChangesetJoinStore(fakeConn, DEADLINE);
    store.resolve("/p", "demo");
    for (const status of ["working", "verifying"]) {
      _ingestJoinFrameForTest({
        action: "changeset_join_resolve_delta",
        ...K,
        path: "",
        candidate: "cafe1234",
        rung: "resolver",
        status,
      });
    }
    const progress = store.state("/p", "demo").progress;
    expect(progress.length).toBe(1);
    expect(progress[0]).toMatchObject({ path: "", candidate: "cafe1234", status: "verifying" });
  });
});

describe("a press that changed nothing says so ([P04], [P06])", () => {
  /** A connection that records, so a send can be asserted rather than assumed. */
  function recordingConn(): {
    conn: never;
    sent: { action: string; body: Record<string, unknown> }[];
  } {
    const sent: { action: string; body: Record<string, unknown> }[] = [];
    const conn = {
      onFrame: () => () => {},
      sendControlFrame: (action: string, body: Record<string, unknown>) => {
        sent.push({ action, body });
      },
    } as never;
    return { conn, sent };
  }

  test("the override is sent from the settled state the old one was lost in", () => {
    // The exact shape of the no-op. A dash that has finished resolving is
    // *idle*, idle was the state the store deleted, and the client-local
    // override was written into it — so the one press this control existed for
    // set a field on an object that was thrown away in the same call.
    const { conn, sent } = recordingConn();
    const store = attachChangesetJoinStore(conn);
    store.resolve("/p", "demo");
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "driver", diff: "@@\n" }],
      unresolved: [],
      candidate_commit: "cafe1234",
      shape: "squash",
    });
    expect(store.state("/p", "demo").phase).toBe("idle");

    store.overrideRed("/p", "demo", "cafe1234");
    expect(sent.filter((s) => s.action === "changeset_join_override")).toEqual([
      {
        action: "changeset_join_override",
        body: { project_dir: "/p", dash: "demo", candidate: "cafe1234" },
      },
    ]);
  });

  test("a refused override states its reason without failing the dash", () => {
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_override_err",
      ...K,
      detail: "that candidate no longer stands",
    });
    const refused = store.state("/p", "demo");
    expect(refused.error).toBe("that candidate no longer stands");
    // The dash is not mid-run and nothing about it failed — the *press* was
    // refused, and painting the row as a failed resolve would be a second lie
    // on top of the first.
    expect(refused.phase).toBe("idle");
  });

  test("a refused answer reaches the face instead of vanishing", () => {
    // The server has always been able to refuse an answer — the resolver may
    // have expired, or a later run may be asking something else — and nothing
    // on this side listened for the refusal. The press looked accepted and the
    // wizard sat there, which is the silence [L31] exists to forbid.
    const store = attachChangesetJoinStore(fakeConn, 20);
    store.resolve("/p", "demo");
    _ingestJoinFrameForTest({
      action: "changeset_join_question_answer_err",
      ...K,
      detail: "nobody is waiting on that question any more",
    });
    const live = store.state("/p", "demo");
    expect(live.error).toBe("nobody is waiting on that question any more");
    // And the run it belongs to is untouched: an expired question does not
    // mean the resolver died.
    expect(live.phase).toBe("resolving");
  });
});

describe("an admission refusal does not kill the run it was refused for ([P01])", () => {
  test("the second press is stated, and the first press keeps running", async () => {
    // The refusal arrives on the same (workspace, dash) cell the live run is
    // streaming into. Read as an ordinary failure it would report the healthy
    // run as dead — the false error face, rebuilt out of the very mechanism
    // that exists to prevent the damage it used to invite.
    const store = attachChangesetJoinStore(fakeConn, 20);
    store.resolve("/p", "demo");
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_delta",
      ...K,
      path: "",
      candidate: "cafe1234",
      rung: "resolver",
      status: "working",
    });

    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_err",
      ...K,
      detail: "a resolve is already running for this dash",
      admission: true,
    });
    const during = store.state("/p", "demo");
    expect(during.phase).toBe("resolving");
    expect(during.error).toBe("a resolve is already running for this dash");

    // And the first run's own answer still lands, over the top of the notice.
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_ok",
      ...K,
      resolved: [{ path: "a.rs", resolved_by: "resolver", diff: "@@\n" }],
      unresolved: [],
      candidate_commit: "cafe1234",
      shape: "squash",
    });
    const after = store.state("/p", "demo");
    expect(after.phase).toBe("idle");
    expect(after.error).toBeNull();
  });
});

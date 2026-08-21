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

describe("the join narrates itself ([P03])", () => {
  const beat = (dash: string, name: string, status: string): void =>
    _ingestJoinFrameForTest({
      action: "changeset_join_land_delta",
      project_dir: "/p",
      dash,
      beat: name,
      status,
    });

  test("a beat lands on its own dash's cell and nobody else's", () => {
    const store = attachChangesetJoinStore(fakeConn);
    expect(store.landProgress("/p", "demo")).toBeNull();

    beat("demo", "squash", "start");
    expect(store.landProgress("/p", "demo")).toEqual({ beat: "squash", status: "start" });
    // Keyed by (workspace, dash) exactly as resolve progress is: two joins in
    // two projects, or two dashes in one, must not narrate over each other.
    expect(store.landProgress("/p", "other")).toBeNull();
    expect(store.landProgress("/elsewhere", "demo")).toBeNull();

    beat("demo", "teardown", "start");
    expect(store.landProgress("/p", "demo")).toEqual({ beat: "teardown", status: "start" });
  });

  test("the terminal frame settles the narration rather than erasing it", () => {
    const store = attachChangesetJoinStore(fakeConn);
    beat("demo", "record", "start");
    expect(store.landProgress("/p", "demo")).not.toBeNull();

    // The join is over — and that is the beat the reader most needs, so it
    // rests rather than clearing.
    //
    // Erasing here made the whole narration unobservable on any join fast
    // enough to arrive in one frame batch: every beat and the terminal reply
    // land together, the store ends the batch empty, and the renderer paints
    // the state from before the press. The join narrated itself perfectly and
    // silently, which an app-test caught only by sampling the DOM at 10ms and
    // finding nothing there.
    _ingestJoinFrameForTest({
      action: "changeset_join_ok",
      ...K,
      previewed: false,
      commit_hash: "cafe1234",
    });
    // The terminal beat carries what the ending was about, so the settled
    // sheet names the outcome rather than a bare word. With no server-format
    // summary on the frame, the sha it produced is what there is to say.
    expect(store.landProgress("/p", "demo")).toEqual({
      beat: "joined",
      status: "done",
      terminal: true,
      detail: "cafe1234",
    });
  });

  test("a landed join settles on the summary the server formatted", () => {
    const store = attachChangesetJoinStore(fakeConn);
    beat("demo", "squash", "start");
    _ingestJoinFrameForTest({
      action: "changeset_join_ok",
      ...K,
      previewed: false,
      commit_hash: "cafe1234",
      summary: "joined demo into main (3 rounds)",
    });
    // The summary outranks the sha: it is the receipt's own words, and the
    // sha is inside it.
    expect(store.landProgress("/p", "demo")?.detail).toBe(
      "joined demo into main (3 rounds)",
    );
  });

  test("a refused join settles as a failure, not as silence", () => {
    const store = attachChangesetJoinStore(fakeConn);
    beat("demo", "squash", "start");
    _ingestJoinFrameForTest({
      action: "changeset_join_err",
      ...K,
      detail: "stale candidate",
    });
    expect(store.landProgress("/p", "demo")).toEqual({
      beat: "failed",
      status: "error",
      terminal: true,
      detail: "stale candidate",
    });
  });

  test("a settled narration rests until a new press retires it", () => {
    const store = attachChangesetJoinStore(fakeConn);
    beat("demo", "squash", "start");
    _ingestJoinFrameForTest({
      action: "changeset_join_ok",
      ...K,
      previewed: false,
      commit_hash: "cafe1234",
    });
    // `clear` is what the controller calls the instant a join reports done —
    // which is exactly when the settled beat is the newest thing the reader
    // has been told. It must not be what deletes it.
    store.clear("/p", "demo");
    expect(store.landProgress("/p", "demo")).not.toBeNull();

    store.clearLand("/p", "demo");
    expect(store.landProgress("/p", "demo")).toBeNull();
  });

  test("a beat with no name is not a beat", () => {
    const store = attachChangesetJoinStore(fakeConn);
    beat("demo", "", "start");
    expect(store.landProgress("/p", "demo")).toBeNull();
  });

  test("the wire dropping takes the narration with it", () => {
    try {
      const lifecycle = liveLifecycle();
      const store = attachChangesetJoinStore(fakeConn);
      beat("demo", "teardown", "start");
      // Nothing will replay a CONTROL frame, so the beats stop arriving — and a
      // register resting on whichever one landed last would say the join is
      // still tearing down, forever.
      lifecycle.notifyConnectionDidClose();
      expect(store.landProgress("/p", "demo")).toBeNull();
    } finally {
      registerConnectionLifecycle(null);
    }
  });
});

describe("the client does not guess at liveness ([P03])", () => {
  const settle = (ms: number): Promise<void> =>
    new Promise((done) => setTimeout(done, ms));

  test("a run that goes quiet stays a run", async () => {
    // There was a twelve-second silence clock here, and it was deleted rather
    // than tuned. Its premise was per-chunk streaming — true of the scribe rung
    // and false of every other: the algorithmic rungs are git work, and the
    // resolver reports four discrete beats with minutes of legitimate quiet
    // between them. So it measured nothing and declared healthy work dead, and
    // the error face it produced re-mounted Resolve, which is how a second run
    // came to `reset --hard` the workshop the first was editing.
    //
    // Liveness for a run is the server's to bound: a per-turn silence bound, a
    // tier-0 timeout, an overall deadline, each landing in the durable stuck
    // fact with a sentence naming which one fired.
    const store = attachChangesetJoinStore(fakeConn);
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
      await settle(30);
      const live = store.state("/p", "demo");
      expect(live.phase).toBe("resolving");
      expect(live.error).toBeNull();
    }

    // And the same for a scribe that has said one thing and gone quiet: it was
    // the one rung the old clock was right about, and it is still not this
    // client's to judge.
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_delta",
      ...K,
      path: "a.rs",
      rung: "ai",
      status: "streaming",
      text: "half a merge",
    });
    await settle(60);
    expect(store.state("/p", "demo").phase).toBe("resolving");
  });

  test("both banished sentences are gone, and cannot come back", async () => {
    // A drift assertion over the module's own source. The two sentences were
    // word salad in different ways — one guessed at liveness the client cannot
    // see and named no act, the other promised a result would appear on a row,
    // which is not something this side can know.
    const source = await Bun.file(
      new URL("../changeset-join-store.ts", import.meta.url).pathname,
    ).text();
    expect(source).not.toContain("resolution ladder in");
    expect(source).not.toContain("if it finished");
  });

  test("the resolver's progress names a candidate, not a path", () => {
    // The sha used to ride in `path`, which put a commit hash in the face's
    // filename column and made each status of one run key as a separate file.
    const store = attachChangesetJoinStore(fakeConn);
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

  test("a refused answer reaches the face instead of vanishing", () => {
    // The server has always been able to refuse an answer — the resolver may
    // have expired, or a later run may be asking something else — and nothing
    // on this side listened for the refusal. The press looked accepted and the
    // wizard sat there, which is the silence [L31] exists to forbid.
    const store = attachChangesetJoinStore(fakeConn);
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

  test("the join decision's answer carries the id the ask was about", () => {
    // The `request_id` is the whole safety of this round trip ([P06]). The
    // prompt is re-derived from durable state on every recompute and a person
    // reads a sheet at their own pace, so the answer that arrives may be about
    // a state the repository has already left. Sending the id is what lets the
    // server refuse that rather than apply a decision nobody made.
    const { conn, sent } = recordingConn();
    const store = attachChangesetJoinStore(conn);
    store.answerPrompt("/p", "demo", "demo:base0:head0:clean", "join-now");
    expect(sent).toEqual([
      {
        action: "changeset_join_prompt_answer",
        body: {
          project_dir: "/p",
          dash: "demo",
          request_id: "demo:base0:head0:clean",
          answer: "join-now",
        },
      },
    ]);
  });

  test("the decision names the session that made it, when it has one", () => {
    // What makes the prompt route leave the same durable `/dash-join` receipt
    // the composer route leaves: the server writes the row against the session
    // the answer names, and returns early when it has none.
    const { conn, sent } = recordingConn();
    const store = attachChangesetJoinStore(conn);
    store.answerPrompt("/p", "demo", "demo:base0:head0", "join-now", "sess-1");
    expect(sent[0]?.body.session_id).toBe("sess-1");

    // A card with no identity still gets to decide — the key is omitted rather
    // than sent empty, and the server tolerates its absence.
    store.answerPrompt("/p", "demo", "demo:base0:head0", "not-yet", null);
    expect(sent[1]?.body).not.toHaveProperty("session_id");
  });

  test("a refused decision states its reason on the same path the others take", () => {
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_prompt_answer_err",
      ...K,
      detail: "that decision was about a state that has since moved",
    });
    const refused = store.state("/p", "demo");
    expect(refused.error).toBe("that decision was about a state that has since moved");
    // Nothing about the dash failed — the answer was refused, and painting the
    // row as a failed run would be a second lie on top of the first.
    expect(refused.phase).toBe("idle");
  });
});

describe("an admission refusal does not kill the run it was refused for ([P01])", () => {
  test("the second press is stated, and the first press keeps running", async () => {
    // The refusal arrives on the same (workspace, dash) cell the live run is
    // streaming into. Read as an ordinary failure it would report the healthy
    // run as dead — the false error face, rebuilt out of the very mechanism
    // that exists to prevent the damage it used to invite.
    const store = attachChangesetJoinStore(fakeConn);
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

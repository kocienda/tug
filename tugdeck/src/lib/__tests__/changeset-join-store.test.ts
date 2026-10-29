/**
 * changeset-join-store — the overlay over the base fold's CONTROL frames and
 * the join's own narration, keyed by (workspace_key, arc).
 *
 * The overlay holds the *run*, never its result. What the fold did lands in
 * git and comes back on the arc's feed entry, so what these cases pin is that
 * an `_ok` puts the overlay away rather than becoming a second, competing
 * account of it — and that a press which stops talking always ends in
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
  _setPressAcknowledgementMsForTest,
  PRESS_ACKNOWLEDGEMENT_MS,
} from "../changeset-join-store";
import okFrame from "@/__tests__/fixtures/changeset-join-resolve-base-ok.golden.json";

import type { WorkspacesChangesetSnapshot } from "../changeset-types";

const fakeConn = { onFrame: () => () => {}, sendControlFrame: () => {} } as never;

const K = { project_dir: "/p", arc: "demo" };

beforeEach(() => {
  _resetChangesetJoinStoreForTest();
  // The deadline is a module-level number a test may shorten, so every case
  // starts from the shipped one rather than from whatever the last one left.
  _setPressAcknowledgementMsForTest(PRESS_ACKNOWLEDGEMENT_MS);
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
  test("the wire dropping mid-fold fails the run instead of latching it", () => {
    try {
      const lifecycle = liveLifecycle();
      const store = attachChangesetJoinStore(fakeConn);
      store.resolveBase("/p", "demo");
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
      store.resolveBase("/p", "demo");
      _ingestJoinFrameForTest(okFrame);
      lifecycle.notifyConnectionDidClose();

      // Idle, not error: the run ended, and the commit it made is in git
      // where a dropped socket cannot reach it.
      expect(store.state("/p", "demo").phase).toBe("idle");
    } finally {
      registerConnectionLifecycle(null);
    }
  });
});

describe("the join narrates itself ([P03])", () => {
  const beat = (arc: string, name: string, status: string): void =>
    _ingestJoinFrameForTest({
      action: "changeset_join_land_delta",
      project_dir: "/p",
      arc: arc,
      beat: name,
      status,
    });

  test("a beat lands on its own arc's cell and nobody else's", () => {
    const store = attachChangesetJoinStore(fakeConn);
    expect(store.landProgress("/p", "demo")).toBeNull();

    beat("demo", "squash", "start");
    expect(store.landProgress("/p", "demo")).toEqual({ beat: "squash", status: "start" });
    // Keyed by (workspace, arc) exactly as resolve progress is: two joins in
    // two projects, or two arcs in one, must not narrate over each other.
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

  test("the press opens the narration before the server has said anything", () => {
    const store = attachChangesetJoinStore(fakeConn);
    // The silent span this closes is real: between the press and the server's
    // first word the register had no beat at all and fell through to the
    // standing-candidate arm, reading "Ready to join" over a running join.
    store.beginLand("/p", "demo");
    expect(store.landProgress("/p", "demo")).toEqual({ beat: "requested", status: "start" });
    expect(store.landProgress("/p", "other")).toBeNull();

    // A placeholder and nothing more — the server's own front beat replaces it.
    beat("demo", "preflight", "start");
    expect(store.landProgress("/p", "demo")).toEqual({ beat: "preflight", status: "start" });
  });

  test("the press's own beat settles and drops like any other", () => {
    const store = attachChangesetJoinStore(fakeConn);
    store.beginLand("/p", "demo");
    _ingestJoinFrameForTest({
      action: "changeset_join_ok",
      ...K,
      previewed: false,
      commit_hash: "cafe1234",
    });
    expect(store.landProgress("/p", "demo")?.terminal).toBe(true);

    // And a new press retires that settled word in the same write that opens
    // its own narration.
    store.beginLand("/p", "demo");
    expect(store.landProgress("/p", "demo")).toEqual({ beat: "requested", status: "start" });
  });

  test("a press the wire outlives leaves no line behind", () => {
    try {
      const lifecycle = liveLifecycle();
      const store = attachChangesetJoinStore(fakeConn);
      store.beginLand("/p", "demo");
      // Non-terminal, so it goes with the wire — the optimistic beat inherits
      // the drop handling every other in-flight beat already had.
      lifecycle.notifyConnectionDidClose();
      expect(store.landProgress("/p", "demo")).toBeNull();
    } finally {
      registerConnectionLifecycle(null);
    }
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

/**
 * What the Changes room reads to stop offering an arc it is already joining.
 *
 * The press spends every act the room held for that arc, and an arc left on
 * offer while its join runs invites the one gesture that can only be refused —
 * which is how a join in progress came to read to its own author as a join
 * that had failed.
 */
describe("an arc whose join is running is not on offer ([P05])", () => {
  const beat = (arc: string, name: string, status: string): void =>
    _ingestJoinFrameForTest({
      action: "changeset_join_land_delta",
      project_dir: "/p",
      arc: arc,
      beat: name,
      status,
    });
  /** The join is over — the frame that settles the narration. */
  const ended = (arc: string, ok: boolean): void =>
    _ingestJoinFrameForTest({
      action: ok ? "changeset_join_ok" : "changeset_join_err",
      project_dir: "/p",
      arc: arc,
      ...(ok ? { commit_hash: "cafe1234" } : { detail: "the merge did not build" }),
    });

  test("the press names it, and the terminal beat hands it back", () => {
    const store = attachChangesetJoinStore(fakeConn);
    expect(store.landingArcs("/p").size).toBe(0);

    // The press's own first beat, written before the request leaves.
    store.beginLand("/p", "demo");
    expect([...store.landingArcs("/p")]).toEqual(["demo"]);

    // Still running through every beat the server reports.
    beat("demo", "squash", "start");
    expect([...store.landingArcs("/p")]).toEqual(["demo"]);

    // Over. A failure hands the arc straight back to the room, because a
    // failure is the one outcome that still wants somebody; a success takes
    // the arc out of the feed and it never returns by this door at all.
    ended("demo", false);
    expect(store.landingArcs("/p").size).toBe(0);
  });

  test("it is one workspace's answer, and one arc's", () => {
    const store = attachChangesetJoinStore(fakeConn);
    store.beginLand("/p", "demo");
    store.beginLand("/p", "other");
    store.beginLand("/elsewhere", "demo");
    expect([...store.landingArcs("/p")].sort()).toEqual(["demo", "other"]);
    expect([...store.landingArcs("/elsewhere")]).toEqual(["demo"]);
    expect(store.landingArcs("/nowhere").size).toBe(0);
  });

  test("a retracted press hands the arc back too", () => {
    // `clearLand` is what a press accepted and then refused on the live
    // re-check undoes. The room must offer the arc again — nothing is
    // running, and the user has something to fix.
    const store = attachChangesetJoinStore(fakeConn);
    store.beginLand("/p", "demo");
    expect(store.landingArcs("/p").size).toBe(1);
    store.clearLand("/p", "demo");
    expect(store.landingArcs("/p").size).toBe(0);
  });

  test("an unchanged answer keeps its identity, so a reader does not re-render", () => {
    // The room reads this through `useSyncExternalStore`, which compares by
    // reference: a fresh `Set` per store frame would re-render the whole lane
    // on every unrelated beat the store forwards.
    const store = attachChangesetJoinStore(fakeConn);
    store.beginLand("/p", "demo");
    const first = store.landingArcs("/p");
    beat("demo", "squash", "start");
    expect(store.landingArcs("/p")).toBe(first);
    store.beginLand("/p", "other");
    expect(store.landingArcs("/p")).not.toBe(first);
  });
});

describe("the client does not guess at liveness ([P03])", () => {
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
});

describe("an admission refusal does not kill the run it was refused for ([P01])", () => {
  test("the second press is stated, and the first press keeps running", async () => {
    // The refusal arrives on the same (workspace, arc) cell the live run is
    // streaming into. Read as an ordinary failure it would report the healthy
    // run as dead — the false error face, rebuilt out of the very mechanism
    // that exists to prevent the damage it used to invite.
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");

    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_err",
      ...K,
      detail: "a resolve-base is already running for this arc",
      admission: true,
    });
    const during = store.state("/p", "demo");
    expect(during.phase).toBe("resolving");
    expect(during.error).toBe("a resolve-base is already running for this arc");

    // And the first run's own answer still lands, over the top of the notice.
    _ingestJoinFrameForTest(okFrame);
    const after = store.state("/p", "demo");
    expect(after.phase).toBe("idle");
    expect(after.error).toBeNull();
  });

  test("the resolve-base ok frame settles the overlay it was sent for", () => {
    // The frame the server actually builds, read from the fixture the Rust
    // side asserts it against — so a server that stops carrying `arc` fails
    // here as well as there. Correlation by `arc` is the whole of this case:
    // a frame without one is dropped in silence, which is what left a real
    // press spinning under a fold that had already finished.
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");
    expect(store.state("/p", "demo").phase).toBe("resolving");

    _ingestJoinFrameForTest(okFrame);

    expect(store.state("/p", "demo").phase).toBe("idle");
  });

  test("a resolve-base ok frame for another arc leaves this cell alone", () => {
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");

    _ingestJoinFrameForTest({ ...okFrame, arc: "other" });

    expect(store.state("/p", "demo").phase).toBe("resolving");
  });

  test("an undo refusal reaches the face without failing anything", () => {
    // The refusal the narrowed verb exists to produce — the arc has joined,
    // so its newest operation is not a fold. It is a statement about the
    // press and about nothing else, so the cell keeps whatever it was doing.
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");
    expect(store.state("/p", "demo").phase).toBe("resolving");

    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_base_undo_err",
      ...K,
      detail: "the newest operation on 'demo' is a join, not a resolve",
    });

    const after = store.state("/p", "demo");
    expect(after.phase).toBe("resolving");
    expect(after.error).toBe(
      "the newest operation on 'demo' is a join, not a resolve",
    );
  });

  test("an undo ok clears the stated reason", () => {
    const store = attachChangesetJoinStore(fakeConn);
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_base_undo_err",
      ...K,
      detail: "nothing to undo on 'demo'",
    });
    expect(store.state("/p", "demo").error).toBe("nothing to undo on 'demo'");

    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_base_undo_ok",
      ...K,
      base_tip: "0".repeat(40),
    });

    expect(store.state("/p", "demo").error).toBeNull();
  });
});

describe("the feed settles the overlay ([P02], [P03])", () => {
  const settle = (ms: number): Promise<void> =>
    new Promise((done) => setTimeout(done, ms));

  /** One recompute, carrying whatever the arc's join state is said to be. */
  const feed = (join?: Record<string, unknown>): WorkspacesChangesetSnapshot =>
    ({
      projects: [
        {
          workspace_key: "/p",
          changesets: [
            {
              kind: "arc",
              display_name: "demo",
              ...(join === undefined ? {} : { join }),
            },
          ],
        },
      ],
    }) as unknown as WorkspacesChangesetSnapshot;

  const baseDirt = { kind: "base-dirt", title: "t", detail: "d", paths: ["a"] };

  test("resolve-base settles from the feed when no ok frame ever arrives", () => {
    // The defect this whole round is about: the fold ran, the blocker went
    // away, and the deck sat under a spinner because the one frame that could
    // have taken it down was dropped on arrival. The blocker's absence is the
    // outcome, so the recompute alone is enough.
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");
    expect(store.state("/p", "demo").phase).toBe("resolving");

    store.observeFeed(feed({ phase: "resolved", blockers: [] }));

    expect(store.state("/p", "demo").phase).toBe("idle");
  });

  test("resolve-base stays resolving while the feed still shows the blocker", async () => {
    _setPressAcknowledgementMsForTest(20);
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");

    store.observeFeed(
      feed({ phase: "blocked", blockers: [baseDirt], run: "resolve-base" }),
    );
    expect(store.state("/p", "demo").phase).toBe("resolving");

    // And the run named on the feed is acknowledgement, so the deadline has
    // nothing left to catch — a fold slower than the deadline is still a fold.
    await settle(40);
    expect(store.state("/p", "demo").phase).toBe("resolving");
  });

  test("a press nothing acknowledges becomes a stated error at the deadline", async () => {
    _setPressAcknowledgementMsForTest(20);
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");

    await settle(40);

    const state = store.state("/p", "demo");
    expect(state.phase).toBe("error");
    expect(state.error).toContain("got no answer");
  });

  test("a frame for the cell acknowledges the press on its own", async () => {
    _setPressAcknowledgementMsForTest(20);
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");

    // An admission refusal names the cell, so the press was heard.
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_err",
      ...K,
      detail: "a join is already running for this arc",
      admission: true,
    });

    await settle(40);
    expect(store.state("/p", "demo").phase).toBe("resolving");
  });

  test("a settled cell is left alone by later recomputes", () => {
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");
    _ingestJoinFrameForTest(okFrame);
    expect(store.state("/p", "demo").phase).toBe("idle");

    // A recompute that still carries the blocker — the one that raced the
    // frame — must not reopen a run that is over.
    store.observeFeed(feed({ phase: "blocked", blockers: [baseDirt] }));

    expect(store.state("/p", "demo").phase).toBe("idle");
  });

  test("a run that ended names no act, whichever way it ended", async () => {
    // `act` is what the register and the report face read to say WHICH act is
    // in flight, and both read it beside the phase. A press that failed and
    // kept its act painted `Committing base work` over its own stated error.
    _setPressAcknowledgementMsForTest(20);
    const store = attachChangesetJoinStore(fakeConn);
    store.resolveBase("/p", "demo");
    expect(store.state("/p", "demo").act).toBe("resolve-base");

    await settle(40);

    const stated = store.state("/p", "demo");
    expect(stated.phase).toBe("error");
    expect(stated.act, "nothing is in flight to name").toBeUndefined();

    // The server's own refusal is the same story.
    store.resolveBase("/p", "demo");
    _ingestJoinFrameForTest({
      action: "changeset_join_resolve_err",
      ...K,
      detail: "not an open project",
    });
    expect(store.state("/p", "demo").phase).toBe("error");
    expect(store.state("/p", "demo").act).toBeUndefined();
  });
});

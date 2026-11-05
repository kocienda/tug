/**
 * editor-find-observer.test — the editor engine's view observation: a change
 * the observed view reports refreshes the attached {@link FindSession} once
 * per frame, a change on any other view is ignored, the view is resolved when
 * the frame runs (so a remount behind the getter is followed), and the
 * release stops everything.
 *
 * The views are plain objects: the observation compares identities and reads
 * nothing else of them, and the extension's own act is one call to
 * `reportFindViewChange`.
 */

import { describe, expect, test } from "bun:test";

import {
  observeFindView,
  reportFindViewChange,
  type FindChangeScheduler,
} from "../editor-find-engine";
import {
  FindSession,
  type FindEngineDelegate,
  type FindMatchInfo,
} from "@/lib/find-session";

/** A scheduler whose frames run when the test says so. */
function manualFrames() {
  let queue: Array<() => void> = [];
  const schedule: FindChangeScheduler = (fn) => {
    queue.push(fn);
    return () => {
      queue = queue.filter((f) => f !== fn);
    };
  };
  const flush = (): void => {
    const due = queue;
    queue = [];
    for (const fn of due) fn();
  };
  return { schedule, flush, pending: () => queue.length };
}

/**
 * An engine over a document whose match count and writability the test
 * moves, observing whichever view `getView` resolves to — the shape the
 * editor engine's `didAttach` wires.
 */
function observingEngine(
  getView: () => object | null,
  schedule: FindChangeScheduler,
) {
  const doc = { count: 3, writable: true };
  let release: (() => void) | null = null;
  const engine: FindEngineDelegate = {
    didAttach: (session) => {
      release = observeFindView(getView, () => session.refresh(), schedule);
    },
    didDetach: () => {
      release?.();
      release = null;
    },
    searchDidChange: () => {},
    matchInfo: (): FindMatchInfo => ({
      count: doc.count,
      activeOrdinal: null,
      capped: false,
    }),
    replaceNext: () => {},
    replaceAll: () => {},
    isWritable: () => doc.writable,
  };
  return { engine, doc };
}

describe("editor find observer", () => {
  test("a reported edit refreshes the session's count on the next frame", () => {
    const view = {};
    const frames = manualFrames();
    const { engine, doc } = observingEngine(() => view, frames.schedule);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("red");
    expect(session.getSnapshot().count).toBe(3);

    doc.count = 4;
    reportFindViewChange(view);
    expect(session.getSnapshot().count).toBe(3);
    frames.flush();
    expect(session.getSnapshot().count).toBe(4);
  });

  test("a reported read-only change re-reads canReplace", () => {
    const view = {};
    const frames = manualFrames();
    const { engine, doc } = observingEngine(() => view, frames.schedule);
    const session = new FindSession();
    session.setDelegate(engine);
    expect(session.getSnapshot().canReplace).toBe(true);

    doc.writable = false;
    reportFindViewChange(view);
    frames.flush();
    expect(session.getSnapshot().canReplace).toBe(false);
  });

  test("many reports in one frame cost one refresh", () => {
    const view = {};
    const frames = manualFrames();
    let refreshes = 0;
    const release = observeFindView(() => view, () => (refreshes += 1), frames.schedule);
    reportFindViewChange(view);
    reportFindViewChange(view);
    reportFindViewChange(view);
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(refreshes).toBe(1);
    release();
  });

  test("a change on another view is not this engine's", () => {
    const view = {};
    const frames = manualFrames();
    let refreshes = 0;
    const release = observeFindView(() => view, () => (refreshes += 1), frames.schedule);
    reportFindViewChange({});
    frames.flush();
    expect(refreshes).toBe(0);
    release();
  });

  test("a view constructed before its getter points at it is followed", () => {
    let current: object | null = {};
    const frames = manualFrames();
    let refreshes = 0;
    const release = observeFindView(() => current, () => (refreshes += 1), frames.schedule);
    // A remount: the new view reports while it is being built, and the
    // host's ref moves to it before the frame runs.
    const remounted = {};
    reportFindViewChange(remounted);
    current = remounted;
    frames.flush();
    expect(refreshes).toBe(1);
    release();
  });

  test("a scheduler with no frame runs at once and still coalesces later reports", () => {
    const view = {};
    let refreshes = 0;
    const immediate: FindChangeScheduler = (fn) => {
      fn();
      return () => {};
    };
    const release = observeFindView(() => view, () => (refreshes += 1), immediate);
    reportFindViewChange(view);
    reportFindViewChange(view);
    expect(refreshes).toBe(2);
    release();
  });

  test("detaching releases the observation and cancels a pending frame", () => {
    const view = {};
    const frames = manualFrames();
    const { engine, doc } = observingEngine(() => view, frames.schedule);
    const session = new FindSession();
    session.setDelegate(engine);
    session.setQuery("red");
    doc.count = 9;
    reportFindViewChange(view);
    session.setDelegate(null);
    expect(frames.pending()).toBe(0);
    reportFindViewChange(view);
    expect(frames.pending()).toBe(0);
  });
});

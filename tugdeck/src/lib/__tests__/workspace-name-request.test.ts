/**
 * The workspace-name question: one open at a time, answered by number, and
 * never closed by an empty name.
 *
 * @covers tugdeck/src/lib/workspace-name-request.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  adoptWorkspaceNameRequest,
  answerWorkspaceName,
  askWorkspaceName,
  getWorkspaceNameRequest,
  resetWorkspaceNameRequestForTests,
  setWorkspaceNameDestination,
  setWorkspaceNameTimerForTests,
  subscribeWorkspaceNameRequest,
  windowRectOf,
  WORKSPACE_NAME_DESTINATION_BOUND_MS,
  type WorkspaceNameTimer,
} from "../workspace-name-request";

afterEach(() => resetWorkspaceNameRequestForTests());

describe("askWorkspaceName", () => {
  test("opens the question with the verb and the proposed name", () => {
    void askWorkspaceName("duplicate", "Duplicate of Home");
    const request = getWorkspaceNameRequest();
    expect(request.open).toBe(true);
    expect(request.verb).toBe("duplicate");
    expect(request.proposed).toBe("Duplicate of Home");
  });

  test("resolves with the trimmed name its answer commits, and closes", async () => {
    const asked = askWorkspaceName("new", "Workspace 2");
    const { seq } = getWorkspaceNameRequest();
    expect(answerWorkspaceName(seq, "  Notes  ")).toBe(true);
    expect(await asked).toBe("Notes");
    expect(getWorkspaceNameRequest().open).toBe(false);
  });

  test("resolves null on a cancel", async () => {
    const asked = askWorkspaceName("duplicate", "Duplicate of Home");
    expect(answerWorkspaceName(getWorkspaceNameRequest().seq, null)).toBe(true);
    expect(await asked).toBeNull();
    expect(getWorkspaceNameRequest().open).toBe(false);
  });

  test("an empty name answers nothing and leaves the question open", async () => {
    let settled = false;
    const asked = askWorkspaceName("new", "Workspace 2").then((name) => {
      settled = true;
      return name;
    });
    const { seq } = getWorkspaceNameRequest();
    expect(answerWorkspaceName(seq, "   ")).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(getWorkspaceNameRequest().open).toBe(true);
    answerWorkspaceName(seq, "Kept");
    expect(await asked).toBe("Kept");
  });

  test("a second ask cancels the first and takes a new number", async () => {
    const first = askWorkspaceName("new", "Workspace 2");
    const firstSeq = getWorkspaceNameRequest().seq;
    const second = askWorkspaceName("duplicate", "Duplicate of Home");
    expect(await first).toBeNull();
    const { seq, verb } = getWorkspaceNameRequest();
    expect(seq).toBe(firstSeq + 1);
    expect(verb).toBe("duplicate");
    // The first question's answer, arriving late, is dropped.
    expect(answerWorkspaceName(firstSeq, "Late")).toBe(false);
    expect(getWorkspaceNameRequest().open).toBe(true);
    answerWorkspaceName(seq, "Copy");
    expect(await second).toBe("Copy");
  });

  test("an answer with no question open does nothing", () => {
    expect(answerWorkspaceName(1, "Anything")).toBe(false);
  });

  test("notifies its subscribers on open and on close", () => {
    let calls = 0;
    const release = subscribeWorkspaceNameRequest(() => {
      calls += 1;
    });
    void askWorkspaceName("new", "Workspace 2");
    answerWorkspaceName(getWorkspaceNameRequest().seq, null);
    release();
    expect(calls).toBe(2);
  });
});

describe("a settle", () => {
  test("that returns nothing runs before the question closes", async () => {
    const seen: string[] = [];
    const asked = askWorkspaceName("new", "Workspace 2", {
      settle: (name) => {
        seen.push(`settle ${name} open=${getWorkspaceNameRequest().open}`);
      },
    });
    answerWorkspaceName(getWorkspaceNameRequest().seq, " Notes ");
    expect(seen).toEqual(["settle Notes open=true"]);
    expect(getWorkspaceNameRequest().open).toBe(false);
    expect(await asked).toBe("Notes");
  });

  test("that returns a promise holds the question open and waiting, answering nothing more", async () => {
    let finish: () => void = () => {};
    const asked = askWorkspaceName("new", "Workspace 2", { settle: () => new Promise<void>((resolve) => (finish = resolve)) });
    const { seq } = getWorkspaceNameRequest();
    expect(answerWorkspaceName(seq, "Notes")).toBe(true);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, waiting: true });
    expect(answerWorkspaceName(seq, null)).toBe(false);
    expect(answerWorkspaceName(seq, "Other")).toBe(false);
    finish();
    expect(await asked).toBe("Notes");
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, waiting: false });
  });

  test("is not run on a cancel", async () => {
    let ran = false;
    const asked = askWorkspaceName("new", "Workspace 2", {
      settle: () => {
        ran = true;
      },
    });
    answerWorkspaceName(getWorkspaceNameRequest().seq, null);
    expect(await asked).toBeNull();
    expect(ran).toBe(false);
  });
});

describe("adoptWorkspaceNameRequest", () => {
  test("takes the shell's question in the drawing page, and notifies only on a change", () => {
    let calls = 0;
    const release = subscribeWorkspaceNameRequest(() => {
      calls += 1;
    });
    const asked = {
      open: true,
      seq: 3,
      verb: "duplicate" as const,
      proposed: "Duplicate of Home",
      waiting: false,
      from: { top: 40, left: 12, width: 200, height: 24 },
      to: null,
    };
    adoptWorkspaceNameRequest(asked);
    adoptWorkspaceNameRequest({ ...asked });
    release();
    expect(getWorkspaceNameRequest()).toEqual(asked);
    expect(calls).toBe(1);
  });

  test("sees a rect change as a change", () => {
    const asked = { open: true, seq: 3, verb: "new" as const, proposed: "Workspace 2", waiting: true, from: null, to: null };
    adoptWorkspaceNameRequest(asked);
    let calls = 0;
    const release = subscribeWorkspaceNameRequest(() => {
      calls += 1;
    });
    const to = { top: 80, left: 12, width: 200, height: 24 };
    adoptWorkspaceNameRequest({ ...asked, to });
    adoptWorkspaceNameRequest({ ...asked, to: { ...to } });
    adoptWorkspaceNameRequest({ ...asked, to: { ...to, top: 81 } });
    release();
    expect(calls).toBe(2);
    expect(getWorkspaceNameRequest().to).toEqual({ ...to, top: 81 });
  });
});

/** A clock the test runs by hand: the bound fires when the test says so. */
function manualTimer(): { timer: WorkspaceNameTimer; fire: () => void; pending: () => number; delays: number[] } {
  const queue: Array<() => void> = [];
  const delays: number[] = [];
  const timer: WorkspaceNameTimer = (fn, ms) => {
    queue.push(fn);
    delays.push(ms);
    return () => {
      const at = queue.indexOf(fn);
      if (at >= 0) queue.splice(at, 1);
    };
  };
  return { timer, fire: () => queue.shift()?.(), pending: () => queue.length, delays };
}

const BUTTON = { top: 30, left: 260, width: 20, height: 20 };
const ROW = { top: 72, left: 8, width: 280, height: 28 };

describe("the zoom rects", () => {
  test("from is carried on the question it was asked with, and to starts empty", () => {
    void askWorkspaceName("new", "Workspace 2", { from: BUTTON });
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, from: BUTTON, to: null });
  });

  test("a door with no place on screen asks with no from", () => {
    void askWorkspaceName("new", "Workspace 2");
    expect(getWorkspaceNameRequest().from).toBeNull();
  });

  test("a destination set on the open question is carried on it", () => {
    void askWorkspaceName("duplicate", "Duplicate of Home", { from: BUTTON, settle: () => new Promise(() => {}), awaitDestination: true });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Copy");
    setWorkspaceNameDestination(ROW);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, waiting: true, from: BUTTON, to: ROW });
  });

  test("a superseded question carries neither rect onward", async () => {
    const first = askWorkspaceName("new", "Workspace 2", { from: BUTTON, settle: () => new Promise(() => {}), awaitDestination: true });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    setWorkspaceNameDestination(ROW);
    void askWorkspaceName("duplicate", "Duplicate of Home");
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, verb: "duplicate", from: null, to: null });
    void first;
  });

  test("a destination a question still being typed hears is an earlier one's, and is dropped", () => {
    // A row asked for by an earlier question, answered late — a Duplicate
    // whose row a filter hid, reported once the filter cleared — reaching a
    // New still being named: it is not this question's row.
    void askWorkspaceName("new", "Workspace 2", { from: BUTTON, awaitDestination: true });
    setWorkspaceNameDestination(ROW);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, to: null });
    let held = false;
    setWorkspaceNameTimerForTests(() => {
      held = true;
      return () => {};
    });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    // The commit still waits for its own row.
    expect(held).toBe(true);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, waiting: true, to: null });
  });

  test("a rect that arrives after the close is dropped", async () => {
    const asked = askWorkspaceName("new", "Workspace 2", { from: BUTTON });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    expect(await asked).toBe("Notes");
    let calls = 0;
    const release = subscribeWorkspaceNameRequest(() => {
      calls += 1;
    });
    setWorkspaceNameDestination(ROW);
    release();
    expect(calls).toBe(0);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, to: null });
  });
});

describe("a close that awaits its destination", () => {
  test("waits for to, then closes with it", async () => {
    const clock = manualTimer();
    setWorkspaceNameTimerForTests(clock.timer);
    const asked = askWorkspaceName("new", "Workspace 2", { from: BUTTON, awaitDestination: true });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, waiting: true, to: null });
    expect(clock.delays).toEqual([WORKSPACE_NAME_DESTINATION_BOUND_MS]);
    setWorkspaceNameDestination(ROW);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, waiting: false, from: BUTTON, to: ROW });
    expect(clock.pending()).toBe(0);
    expect(await asked).toBe("Notes");
  });

  test("closes with no to past the bound", async () => {
    const clock = manualTimer();
    setWorkspaceNameTimerForTests(clock.timer);
    const asked = askWorkspaceName("new", "Workspace 2", { awaitDestination: true });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    expect(getWorkspaceNameRequest().open).toBe(true);
    clock.fire();
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, to: null });
    expect(await asked).toBe("Notes");
    // Late: the row reports after the bound closed the question.
    setWorkspaceNameDestination(ROW);
    expect(getWorkspaceNameRequest().to).toBeNull();
  });

  test("closes at once when its settle already set to", async () => {
    const clock = manualTimer();
    setWorkspaceNameTimerForTests(clock.timer);
    const asked = askWorkspaceName("new", "Workspace 2", {
      awaitDestination: true,
      settle: () => setWorkspaceNameDestination(ROW),
    });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, to: ROW });
    expect(clock.delays).toEqual([]);
    expect(await asked).toBe("Notes");
  });

  test("waits after a settle that returned a promise", async () => {
    const clock = manualTimer();
    setWorkspaceNameTimerForTests(clock.timer);
    let finish: () => void = () => {};
    const asked = askWorkspaceName("new", "Workspace 2", {
      awaitDestination: true,
      settle: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, waiting: true });
    setWorkspaceNameDestination(ROW);
    expect(await asked).toBe("Notes");
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, to: ROW });
  });

  test("a cancel does not wait", async () => {
    const clock = manualTimer();
    setWorkspaceNameTimerForTests(clock.timer);
    const asked = askWorkspaceName("new", "Workspace 2", { from: BUTTON, awaitDestination: true });
    answerWorkspaceName(getWorkspaceNameRequest().seq, null);
    expect(getWorkspaceNameRequest().open).toBe(false);
    expect(clock.delays).toEqual([]);
    expect(await asked).toBeNull();
  });

  test("a question with no awaitDestination closes at once", () => {
    const clock = manualTimer();
    setWorkspaceNameTimerForTests(clock.timer);
    void askWorkspaceName("duplicate", "Duplicate of Home", { from: BUTTON });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Copy");
    expect(getWorkspaceNameRequest().open).toBe(false);
    expect(clock.delays).toEqual([]);
  });
});

describe("windowRectOf", () => {
  test("offsets a card's rect by its content box's origin", () => {
    expect(windowRectOf(BUTTON, { x: 900, y: 52 })).toEqual({ top: 82, left: 1160, width: 20, height: 20 });
  });

  test("is the identity with no content box, where the card and the modal share a page", () => {
    expect(windowRectOf(BUTTON, null)).toEqual(BUTTON);
  });
});

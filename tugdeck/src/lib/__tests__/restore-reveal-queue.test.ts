/**
 * restore-reveal-queue.test.ts — the reveal queue's rule: arm, admit,
 * settle, release, and removal.
 *
 * The rule is pure over deck-owned events, so each test drives it with a
 * scripted sequence of frames and tasks on a fake clock and reads the
 * admissions and the cover phase back.
 */

import { describe, expect, test } from "bun:test";

import {
  COVER_COMPOSITE_BOUND_MS,
  COVER_LINGER_MS,
  INITIAL_REVEAL_QUEUE,
  REVEAL_SETTLE_BOUND_MS,
  coverRequested,
  revealingCardIds,
  stepRevealQueue,
  type RevealQueueEvent,
  type RevealQueueState,
} from "@/lib/restore-reveal-queue";

const FRAME_MS = 16.7;

/** Run a sequence of events, collecting every admission in order. */
function run(
  events: RevealQueueEvent[],
  from: RevealQueueState = INITIAL_REVEAL_QUEUE,
): { state: RevealQueueState; admitted: string[] } {
  let state = from;
  const admitted: string[] = [];
  for (const event of events) {
    const step = stepRevealQueue(state, event);
    state = step.state;
    if (step.admit !== null) admitted.push(step.admit);
  }
  return { state, admitted };
}

/** Enqueue at t=0, then two frames: the cover is up at 2 × FRAME_MS. */
function armedWith(...cardIds: string[]): RevealQueueState {
  return run([
    ...cardIds.map((cardId) => ({ type: "enqueue" as const, cardId, now: 0 })),
    { type: "frame", now: FRAME_MS },
    { type: "frame", now: 2 * FRAME_MS },
  ]).state;
}

describe("arm", () => {
  test("the first enqueue arms the cover; it is requested before any admission", () => {
    const { state, admitted } = run([{ type: "enqueue", cardId: "A", now: 0 }]);
    expect(state.cover).toBe("arming");
    expect(coverRequested(state)).toBe(true);
    expect(admitted).toEqual([]);
  });

  test("no reveal is admitted until the cover has composited (two frames)", () => {
    const { state, admitted } = run([
      { type: "enqueue", cardId: "A", now: 0 },
      { type: "task", now: 1 },
      { type: "frame", now: FRAME_MS },
      { type: "task", now: FRAME_MS + 1 },
    ]);
    expect(state.cover).toBe("arming");
    expect(admitted).toEqual([]);

    const after = run(
      [
        { type: "frame", now: 2 * FRAME_MS },
        { type: "task", now: 2 * FRAME_MS + 1 },
      ],
      state,
    );
    expect(after.state.cover).toBe("up");
    expect(after.admitted).toEqual(["A"]);
  });

  test("a window whose frames have stopped admits after the composite bound", () => {
    // An occluded window suspends rAF; its cards must not wait for it to show.
    const { admitted } = run([
      { type: "enqueue", cardId: "A", now: 0 },
      { type: "task", now: COVER_COMPOSITE_BOUND_MS - 1 },
      { type: "task", now: COVER_COMPOSITE_BOUND_MS },
    ]);
    expect(admitted).toEqual(["A"]);
  });

  test("an enqueue onto a raised cover does not re-arm it", () => {
    const up = armedWith("A");
    const { state } = run([{ type: "enqueue", cardId: "B", now: 40 }], up);
    expect(state.cover).toBe("up");
  });

  test("enqueueing a card twice queues it once", () => {
    const { state } = run([
      { type: "enqueue", cardId: "A", now: 0 },
      { type: "enqueue", cardId: "A", now: 1 },
    ]);
    expect(state.queued).toEqual(["A"]);
  });
});

describe("admit", () => {
  test("one reveal per task, oldest first", () => {
    const { admitted, state } = run(
      [
        { type: "task", now: 40 },
        { type: "task", now: 41 },
        { type: "task", now: 42 },
        { type: "task", now: 43 },
      ],
      armedWith("A", "B", "C"),
    );
    expect(admitted).toEqual(["A", "B", "C"]);
    expect(state.queued).toEqual([]);
    expect(state.inFlight.map((r) => r.cardId)).toEqual(["A", "B", "C"]);
  });

  test("the key card goes first whenever it is queued", () => {
    const { admitted } = run(
      [
        { type: "key", cardId: "C" },
        { type: "task", now: 40 },
        { type: "task", now: 41 },
        { type: "task", now: 42 },
      ],
      armedWith("A", "B", "C"),
    );
    expect(admitted).toEqual(["C", "A", "B"]);
  });

  test("a key card enqueued late still jumps the queue", () => {
    const { admitted } = run(
      [
        { type: "key", cardId: "K" },
        { type: "task", now: 40 },
        { type: "enqueue", cardId: "K", now: 41 },
        { type: "task", now: 42 },
        { type: "task", now: 43 },
      ],
      armedWith("A", "B"),
    );
    expect(admitted).toEqual(["A", "K", "B"]);
  });

  test("the cards under the cover are the in-flight then the queued", () => {
    const { state } = run([{ type: "task", now: 40 }], armedWith("A", "B"));
    expect(revealingCardIds(state)).toEqual(["A", "B"]);
  });
});

describe("release", () => {
  test("the cover holds through an in-flight reveal and lifts after its settle plus the linger", () => {
    const admitted = run([{ type: "task", now: 40 }], armedWith("A")).state;
    // In flight, unsettled: frames keep the cover up.
    let state = run(
      [
        { type: "frame", now: 60 },
        { type: "frame", now: 300 },
      ],
      admitted,
    ).state;
    expect(state.cover).toBe("up");

    state = run([{ type: "settled", cardId: "A", now: 310 }], state).state;
    expect(state.cover).toBe("up");
    // A frame inside the linger keeps it.
    state = run([{ type: "frame", now: 310 + COVER_LINGER_MS - 1 }], state).state;
    expect(state.cover).toBe("up");
    // The first frame past the linger lifts it.
    state = run([{ type: "frame", now: 310 + COVER_LINGER_MS }], state).state;
    expect(state.cover).toBe("down");
    expect(coverRequested(state)).toBe(false);
  });

  test("a reveal enqueued inside the linger stays under the same appearance", () => {
    let state = run(
      [
        { type: "task", now: 40 },
        { type: "settled", cardId: "A", now: 200 },
      ],
      armedWith("A"),
    ).state;
    state = run(
      [
        { type: "enqueue", cardId: "B", now: 205 },
        { type: "frame", now: 200 + COVER_LINGER_MS + 5 },
      ],
      state,
    ).state;
    expect(state.cover).toBe("up");
    // Already composited: B is admitted on the next task with no new arm.
    const next = run([{ type: "task", now: 230 }], state);
    expect(next.admitted).toEqual(["B"]);
  });

  test("the cover lifts between reveals when they land further apart than the linger", () => {
    // [B04]: when the deck is live, it is shown live.
    let state = run(
      [
        { type: "task", now: 40 },
        { type: "settled", cardId: "A", now: 200 },
        { type: "frame", now: 200 + COVER_LINGER_MS },
      ],
      armedWith("A"),
    ).state;
    expect(state.cover).toBe("down");
    state = run([{ type: "enqueue", cardId: "B", now: 500 }], state).state;
    expect(state.cover).toBe("arming");
  });

  test("a reveal that never settles stops holding the cover at the settle bound", () => {
    const admitted = run([{ type: "task", now: 40 }], armedWith("A")).state;
    let state = run(
      [{ type: "frame", now: 40 + REVEAL_SETTLE_BOUND_MS - 1 }],
      admitted,
    ).state;
    expect(state.inFlight.length).toBe(1);
    state = run(
      [
        { type: "frame", now: 40 + REVEAL_SETTLE_BOUND_MS },
        { type: "frame", now: 40 + REVEAL_SETTLE_BOUND_MS + COVER_LINGER_MS },
      ],
      state,
    ).state;
    expect(state.inFlight).toEqual([]);
    expect(state.cover).toBe("down");
  });

  test("a settle for a card that was never admitted changes nothing", () => {
    const up = armedWith("A");
    const { state } = run([{ type: "settled", cardId: "A", now: 40 }], up);
    expect(state).toBe(up);
  });
});

describe("removal", () => {
  test("a queued card that is removed never holds the cover", () => {
    let state = run(
      [
        { type: "task", now: 40 },
        { type: "removed", cardId: "B", now: 41 },
        { type: "settled", cardId: "A", now: 100 },
      ],
      armedWith("A", "B"),
    ).state;
    expect(revealingCardIds(state)).toEqual([]);
    state = run([{ type: "frame", now: 100 + COVER_LINGER_MS }], state).state;
    expect(state.cover).toBe("down");
  });

  test("an in-flight card that dies releases the cover without its settle", () => {
    let state = run(
      [
        { type: "task", now: 40 },
        { type: "removed", cardId: "A", now: 60 },
      ],
      armedWith("A"),
    ).state;
    expect(state.inFlight).toEqual([]);
    state = run([{ type: "frame", now: 60 + COVER_LINGER_MS }], state).state;
    expect(state.cover).toBe("down");
  });

  test("removing the only card from an arming cover drops it at once", () => {
    const { state } = run([
      { type: "enqueue", cardId: "A", now: 0 },
      { type: "key", cardId: "A" },
      { type: "removed", cardId: "A", now: 5 },
    ]);
    expect(state.cover).toBe("down");
    expect(state.keyCardId).toBe("A");
  });

  test("a removed card that was never enqueued changes nothing", () => {
    const up = armedWith("A");
    const { state } = run([{ type: "removed", cardId: "Z", now: 40 }], up);
    expect(state).toBe(up);
  });
});

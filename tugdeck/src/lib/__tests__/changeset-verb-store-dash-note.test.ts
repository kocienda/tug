/**
 * changeset-verb-store — the run's quiet lines (W8 Task 3).
 *
 * Every manipulation of a dash's step list is announced by the verb that made
 * it, server-side, so it cannot be forgotten: a run's progression was
 * previously invisible from the card and the only sign was a stuck indicator.
 *
 * The frames arrive unsolicited, like `arc_receipt` and for the same reason —
 * a `tugtool dash` verb is a short-lived process with nobody waiting. What is
 * different, and is what this file tests, is that they are a **sequence**: a
 * run makes dozens and every one is meant to be read, so the store accumulates
 * them under a monotonic `seq` rather than keeping only the newest.
 *
 * Drives the real store through a fake `TugConnection`, so `_onControl` itself
 * is under test.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { ChangesetVerbStore } from "../changeset-verb-store";

const SESSION = "sess-note";

function harness(): {
  store: ChangesetVerbStore;
  reply: (body: Record<string, unknown>) => void;
} {
  let handler: ((payload: Uint8Array) => void) | null = null;
  const conn = {
    onFrame: (_feed: number, cb: (payload: Uint8Array) => void) => {
      handler = cb;
      return () => {};
    },
    sendControlFrame: () => {},
  } as never;
  const store = new ChangesetVerbStore(conn);
  const reply = (body: Record<string, unknown>): void => {
    if (handler === null) throw new Error("no CONTROL handler registered");
    handler(new TextEncoder().encode(JSON.stringify(body)));
  };
  return { store, reply };
}

const frame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: "dash_note",
  project_dir: "/proj",
  tug_session_id: SESSION,
  command: "dash step foo done 1",
  note: "foo: step 1/7 closed (999353ca1)",
  receipt_id: 41,
  ...over,
});

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("dash_note", () => {
  test("a gesture is filed under the session it names, with its row identity", () => {
    h.reply(frame());
    const notes = h.store.dashNotes(SESSION);
    expect(notes.length).toBe(1);
    expect(notes[0].command).toBe("dash step foo done 1");
    expect(notes[0].note).toBe("foo: step 1/7 closed (999353ca1)");
    // Without the row identity the live copy and the copy a later restore
    // replays become two rows for one gesture.
    expect(notes[0].receiptId).toBe(41);
    expect(h.store.dashNotes("somebody-else").length).toBe(0);
  });

  test("a run's gestures accumulate in arrival order under a rising seq", () => {
    h.reply(frame({ note: "foo: step 1/7 started", receipt_id: 1 }));
    h.reply(frame({ note: "foo: committed (abc1234)", receipt_id: 2 }));
    h.reply(frame({ note: "foo: step 1/7 closed", receipt_id: 3 }));
    const notes = h.store.dashNotes(SESSION);
    expect(notes.map((n) => n.note)).toEqual([
      "foo: step 1/7 started",
      "foo: committed (abc1234)",
      "foo: step 1/7 closed",
    ]);
    // Strictly rising, and never reused: this is what lets a card append only
    // the rows that arrived after it started watching. A receipt id cannot
    // serve, because the server writes `null` for it with no shell ledger.
    expect(notes[0].seq).toBeLessThan(notes[1].seq);
    expect(notes[1].seq).toBeLessThan(notes[2].seq);
  });

  test("a frame with nothing to say is not a row", () => {
    h.reply(frame({ note: "" }));
    h.reply(frame({ tug_session_id: "" }));
    expect(h.store.dashNotes(SESSION).length).toBe(0);
  });

  test("an older tugcast that persisted nothing still paints", () => {
    // `receipt_id` absent means the server wrote no durable row, so there is
    // no restore that could ever collide — the card falls back to a local
    // identity rather than dropping the line.
    h.reply(frame({ receipt_id: undefined }));
    expect(h.store.dashNotes(SESSION)[0].receiptId).toBeNull();
  });

  test("subscribers are notified, because a card paints on the edge", () => {
    let beats = 0;
    h.store.subscribe(() => {
      beats += 1;
    });
    h.reply(frame());
    expect(beats).toBe(1);
  });
});

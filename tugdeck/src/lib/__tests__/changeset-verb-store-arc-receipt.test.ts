/**
 * changeset-verb-store — the arc's terminal receipt ([P12]).
 *
 * Every other state in this store is the far half of a round trip this client
 * started, and settles an in-flight entry keyed by the press that opened it.
 * An arc has no such press: it finishes on a server tick, with nobody waiting
 * and no entry to settle, so its frame arrives unsolicited and is filed under
 * the *session* it names rather than under an entry key.
 *
 * That difference is the whole of what is tested here, plus the two things the
 * receipt has to carry for the card to paint it correctly: the row identity —
 * without which the live copy and the replayed copy become two receipts for
 * one arc — and the summary verbatim, since the server formats it once so both
 * copies read the same bytes.
 *
 * Drives the real store through a fake `TugConnection`, so `_onControl` itself
 * is under test.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { ChangesetVerbStore } from "../changeset-verb-store";

const SESSION = "sess-arc";
const SUMMARY = "arc complete · foo\ndevise · opus · claude-a\nplan arc/foo.md";

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
  action: "arc_receipt",
  project_dir: "/proj",
  arc: "foo",
  tug_session_id: SESSION,
  receipt_id: 41,
  summary: SUMMARY,
  ...over,
});

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("an arc receipt nobody asked for", () => {
  test("a session with no arc has no receipt", () => {
    expect(h.store.arcReceipt(SESSION)).toBeNull();
  });

  test("the frame files itself under the session it names", () => {
    h.reply(frame());
    expect(h.store.arcReceipt(SESSION)).toEqual({
      arc: "foo",
      summary: SUMMARY,
      receiptId: 41,
    });
    expect(h.store.arcReceipt("some-other-session")).toBeNull();
  });

  test("it notifies, because nothing else will — no press is watching", () => {
    let beats = 0;
    h.store.subscribe(() => {
      beats += 1;
    });
    h.reply(frame());
    expect(beats).toBe(1);
  });

  test("the summary rides verbatim, newlines and all", () => {
    h.reply(frame());
    expect(h.store.arcReceipt(SESSION)?.summary).toBe(SUMMARY);
  });

  test("a server that persisted nothing sends no row id, and says so", () => {
    h.reply(frame({ receipt_id: null }));
    expect(h.store.arcReceipt(SESSION)?.receiptId).toBeNull();
  });

  test("a frame naming no session, or carrying no words, is not a receipt", () => {
    h.reply(frame({ tug_session_id: "" }));
    h.reply(frame({ summary: "" }));
    expect(h.store.arcReceipt(SESSION)).toBeNull();
  });

  test("a second arc on one card supersedes the first", () => {
    h.reply(frame());
    h.reply(frame({ receipt_id: 42, arc: "bar", summary: "arc complete · bar" }));
    expect(h.store.arcReceipt(SESSION)).toEqual({
      arc: "bar",
      summary: "arc complete · bar",
      receiptId: 42,
    });
  });
});

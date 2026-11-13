/**
 * changeset-verb-store — the engine's re-audit row writes.
 *
 * tugcast writes a re-audit as one shell-ledger row and rewrites it at every
 * transition, announcing each write with an `arc_reaudit` frame that carries
 * the row's receipt id. The store files each write under the session it names
 * as a sequence, so a card appends every write after it began watching — and
 * the repeated receipt id is what makes the card's append an upsert of one
 * turn rather than a second row.
 *
 * Drives the real store through a fake `TugConnection`, so `_onControl` itself
 * is under test.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { ChangesetVerbStore } from "../changeset-verb-store";

const SESSION = "sess-reaudit";

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
  action: "arc_reaudit",
  project_dir: "/proj",
  arc: "demo",
  tug_session_id: SESSION,
  receipt_id: 77,
  summary: "arc: demo\nrun: r1\nbase: main abc\nstate: running\nstarted: 2027-01-15T08:00:00+00:00\n",
  started_at_ms: 1_800_000_000_000,
  ...over,
});

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("arc_reaudit", () => {
  test("a write lands under the session it names, with its row identity and clock", () => {
    let notified = 0;
    h.store.subscribe(() => {
      notified += 1;
    });
    h.reply(frame());
    const writes = h.store.arcReaudits(SESSION);
    expect(writes.length).toBe(1);
    expect(writes[0].arc).toBe("demo");
    expect(writes[0].receiptId).toBe(77);
    expect(writes[0].startedAtMs).toBe(1_800_000_000_000);
    expect(writes[0].summary).toContain("state: running");
    expect(notified).toBe(1);
    expect(h.store.arcReaudits("somebody-else").length).toBe(0);
  });

  test("a rewrite of the same row is a new seq carrying the same receipt id", () => {
    h.reply(frame());
    h.reply(frame({ summary: String(frame().summary).replace("running", "verified") }));
    const writes = h.store.arcReaudits(SESSION);
    expect(writes.length).toBe(2);
    expect(writes[0].seq).toBeLessThan(writes[1].seq);
    expect(writes[1].receiptId).toBe(writes[0].receiptId);
    expect(writes[1].startedAtMs).toBe(writes[0].startedAtMs);
    expect(writes[1].summary).toContain("state: verified");
  });

  test("a frame with no session or no row is not a write", () => {
    h.reply(frame({ tug_session_id: "" }));
    h.reply(frame({ summary: "" }));
    expect(h.store.arcReaudits(SESSION).length).toBe(0);
  });
});

/**
 * Unit tests for `SessionLedgerStore`.
 *
 * Drives the store directly: a `TestFrameChannel` stands in for the wire,
 * and the events bus (`session-ledger-events`) is the channel through
 * which simulated server pushes flow into the store.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { TugConnection } from "@/connection";
import { FeedId } from "@/protocol";
import type { SessionRow } from "@/protocol";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import {
  SessionLedgerStore,
} from "@/lib/session-ledger-store";
import {
  _resetSessionLedgerEventsForTest,
  publishTrashSessionErr,
  publishTrashSessionOk,
  publishListSessionsErr,
  publishListSessionsOk,
  publishListSessionsProgress,
  publishSessionUpdated,
} from "@/lib/session-ledger-events";

function makeRow(partial: Partial<SessionRow> & { session_id: string }): SessionRow {
  return {
    session_id: partial.session_id,
    line_id: partial.line_id ?? partial.session_id,
    workspace_key: partial.workspace_key ?? "ws-1",
    project_dir: partial.project_dir ?? "/proj",
    created_at: partial.created_at ?? 1,
    last_used_at: partial.last_used_at ?? 1,
    turn_count: partial.turn_count ?? 0,
    last_user_prompt: partial.last_user_prompt ?? null,
    state: partial.state ?? "closed",
    card_id: partial.card_id ?? null,
    name: partial.name ?? null,
    name_user_set: partial.name_user_set ?? false,
    tag: partial.tag ?? null,
    synopsis: partial.synopsis ?? null,
    origin: partial.origin ?? "tug",
    terminal_live: partial.terminal_live ?? null,
    background: partial.background ?? false,
  };
}

function newStore(): { store: SessionLedgerStore; conn: TestFrameChannel } {
  const conn = new TestFrameChannel();
  const store = new SessionLedgerStore(conn as unknown as TugConnection);
  return { store, conn };
}

describe("SessionLedgerStore", () => {
  beforeEach(() => {
    _resetSessionLedgerEventsForTest();
  });
  afterEach(() => {
    _resetSessionLedgerEventsForTest();
  });

  it("first call returns pending and dispatches a list_sessions request", () => {
    const { store, conn } = newStore();
    const snap = store.getSnapshot("ws-1");
    expect(snap.status).toBe("pending");
    expect(snap.rows).toEqual([]);

    // The store must have emitted a CONTROL frame.
    const frames = conn.recordedFrames.filter((f) => f.feedId === FeedId.CONTROL);
    expect(frames.length).toBe(1);
    const decoded = JSON.parse(
      new TextDecoder().decode(frames[0].decoded as Uint8Array),
    );
    expect(decoded).toEqual({
      action: "list_sessions",
      project_dir: "ws-1",
    });
    store.dispose();
  });

  it("settles to ready after list_sessions_ok", () => {
    const { store } = newStore();
    let ticks = 0;
    const unsub = store.subscribe(() => {
      ticks += 1;
    });
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      sessions: [
        makeRow({ session_id: "s1", last_used_at: 100 }),
        makeRow({ session_id: "s2", last_used_at: 200 }),
      ],
    });
    const snap = store.getSnapshot("ws-1");
    expect(snap.status).toBe("ready");
    expect(snap.rows.map((r) => r.session_id)).toEqual(["s2", "s1"]);
    expect(ticks).toBeGreaterThanOrEqual(1);
    unsub();
    store.dispose();
  });

  it("two-phase scan: phase-1 is ready+scanning, phase-2 settles with the union", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    // Phase 1 — ledger rows only, scan still running. The picker is
    // interactive immediately (status ready) even though scanning is true.
    publishListSessionsOk({
      project_dir: "ws-1",
      dir_exists: true,
      scanning: true,
      sessions: [makeRow({ session_id: "tug", last_used_at: 100 })],
    });
    const phase1 = store.getSnapshot("ws-1");
    expect(phase1.status).toBe("ready");
    expect(phase1.scanning).toBe(true);
    expect(phase1.rows.map((r) => r.session_id)).toEqual(["tug"]);
    // Phase 2 — full union arrives, scanning clears.
    publishListSessionsOk({
      project_dir: "ws-1",
      dir_exists: true,
      scanning: false,
      sessions: [
        makeRow({ session_id: "tug", last_used_at: 100 }),
        makeRow({ session_id: "ext", last_used_at: 200 }),
      ],
    });
    const phase2 = store.getSnapshot("ws-1");
    expect(phase2.scanning).toBe(false);
    expect(phase2.rows.map((r) => r.session_id)).toEqual(["ext", "tug"]);
    store.dispose();
  });

  it("carries dir_exists from list_sessions_ok into the snapshot", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      project_dir: "ws-1",
      dir_exists: false,
      sessions: [],
    });
    expect(store.getSnapshot("ws-1").dirExists).toBe(false);
    store.dispose();
  });

  it("settles to error on list_sessions_err", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsErr({ project_dir: "ws-1", reason: "ledger_read_failed" });
    const snap = store.getSnapshot("ws-1");
    expect(snap.status).toBe("error");
    expect(snap.error).toEqual({ reason: "ledger_read_failed" });
    store.dispose();
  });

  it("returns the same snapshot reference until a change lands", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      sessions: [makeRow({ session_id: "s1" })],
    });
    const a = store.getSnapshot("ws-1");
    const b = store.getSnapshot("ws-1");
    expect(a).toBe(b);
    store.dispose();
  });

  it("session_updated patches a row in place and re-sorts", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      sessions: [
        makeRow({ session_id: "s1", last_used_at: 100, turn_count: 0 }),
        makeRow({ session_id: "s2", last_used_at: 50, turn_count: 0 }),
      ],
    });
    publishSessionUpdated({
      session_id: "s2",
      fields: makeRow({ session_id: "s2", last_used_at: 200, turn_count: 1 }),
    });
    const snap = store.getSnapshot("ws-1");
    expect(snap.rows.map((r) => r.session_id)).toEqual(["s2", "s1"]);
    expect(snap.rows[0].turn_count).toBe(1);
    store.dispose();
  });

  it("session_updated for a prompt-free session never enters the list", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      sessions: [makeRow({ session_id: "s1", last_user_prompt: "hello" })],
    });
    // A just-spawned session: no turns, no prompt, no name.
    publishSessionUpdated({
      session_id: "fresh",
      fields: makeRow({ session_id: "fresh", state: "live", card_id: "c1" }),
    });
    const snap = store.getSnapshot("ws-1");
    expect(snap.rows.map((r) => r.session_id)).toEqual(["s1"]);
    store.dispose();
  });

  it("findRow answers for the spawn-time row the list leaves out", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      sessions: [makeRow({ session_id: "s1", last_user_prompt: "hello" })],
    });
    // A just-spawned session. It stays out of the LIST — nobody is offered an
    // abandoned empty session to resume into — but the card that holds it has
    // to be able to ask when it was made, and this push is the only record of
    // that the deck ever gets: a zero-turn session has written no JSONL, so
    // the card's replay anchor is blind to it.
    publishSessionUpdated({
      session_id: "fresh",
      fields: makeRow({
        session_id: "fresh",
        project_dir: "ws-1",
        state: "live",
        card_id: "c1",
        created_at: 1_700_000_000_000,
      }),
    });
    expect(
      store.getSnapshot("ws-1").rows.map((r) => r.session_id),
    ).toEqual(["s1"]);
    expect(store.findRow("fresh")?.created_at).toBe(1_700_000_000_000);
    // And a listed row still answers through the same door.
    expect(store.findRow("s1")?.session_id).toBe("s1");
    expect(store.findRow("nobody")).toBeNull();
    store.dispose();
  });

  it("findRow drops the detached copy once the session has content", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      sessions: [],
    });
    publishSessionUpdated({
      session_id: "fresh",
      fields: makeRow({
        session_id: "fresh",
        project_dir: "ws-1",
        created_at: 1_700_000_000_000,
      }),
    });
    expect(store.getSnapshot("ws-1").rows).toHaveLength(0);
    // First prompt lands: the row has content, so the LIST is its home and a
    // detached copy would only be a second, staler answer.
    publishSessionUpdated({
      session_id: "fresh",
      fields: makeRow({
        session_id: "fresh",
        project_dir: "ws-1",
        created_at: 1_700_000_000_000,
        turn_count: 1,
        last_user_prompt: "hello",
        last_used_at: 1_700_000_009_000,
      }),
    });
    const listed = store.getSnapshot("ws-1").rows;
    expect(listed.map((r) => r.session_id)).toEqual(["fresh"]);
    expect(store.findRow("fresh")).toBe(listed[0]);
    store.dispose();
  });

  it("findRow answers for a content-bearing push into a workspace nobody listed", () => {
    // The masthead's whole rest form — turn count, on-disk size, when it last
    // moved — is this row. A card bound without the picker (a restored deck)
    // has no listing for its project, and dropping the push left that line with
    // nothing to report but `Ready.`
    const { store } = newStore();
    publishSessionUpdated({
      session_id: "s1",
      fields: makeRow({
        session_id: "s1",
        project_dir: "/unlisted",
        turn_count: 7,
        last_user_prompt: "hello",
        last_used_at: 1_700_000_009_000,
      }),
    });
    expect(store.findRow("s1")?.turn_count).toBe(7);
    // The BROWSE still sees nothing: no listing settled, so there is no list.
    expect(store.getSnapshot("/unlisted").rows).toHaveLength(0);
    store.dispose();
  });

  it("a settled listing takes over from the detached copy", () => {
    const { store } = newStore();
    publishSessionUpdated({
      session_id: "s1",
      fields: makeRow({
        session_id: "s1",
        project_dir: "/proj",
        turn_count: 7,
        last_user_prompt: "hello",
      }),
    });
    expect(store.findRow("s1")?.turn_count).toBe(7);
    store.getSnapshot("/proj");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "/proj",
      sessions: [
        makeRow({
          session_id: "s1",
          project_dir: "/proj",
          turn_count: 9,
          last_user_prompt: "hello",
        }),
      ],
    });
    const listed = store.getSnapshot("/proj").rows;
    // The listing is authoritative, and it is the same object the browse
    // shows — not a staler copy held beside it.
    expect(store.findRow("s1")).toBe(listed[0]);
    expect(store.findRow("s1")?.turn_count).toBe(9);
    store.dispose();
  });

  it("session_updated { removed: true } drops the row", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      sessions: [
        makeRow({ session_id: "s1" }),
        makeRow({ session_id: "s2" }),
      ],
    });
    publishSessionUpdated({ session_id: "s1", removed: true });
    const snap = store.getSnapshot("ws-1");
    expect(snap.rows.map((r) => r.session_id)).toEqual(["s2"]);
    store.dispose();
  });

  it("session_updated for an uncached workspace is ignored", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({ project_dir: "ws-1", sessions: [], dir_exists: true });
    // Push for a workspace we never subscribed to.
    publishSessionUpdated({
      session_id: "other",
      fields: makeRow({ session_id: "other", workspace_key: "ws-other" }),
    });
    expect(store.getSnapshot("ws-1").rows).toEqual([]);
    store.dispose();
  });

  it("invalidateAll flips ready entries to idle and re-fetches on next getSnapshot", () => {
    const { store, conn } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      sessions: [makeRow({ session_id: "s1" })],
    });
    expect(store.getSnapshot("ws-1").status).toBe("ready");
    const beforeInvalidate = conn.recordedFrames.length;

    store.invalidateAll();
    // After invalidateAll, the next getSnapshot returns pending and
    // re-issues the request.
    const next = store.getSnapshot("ws-1");
    expect(next.status).toBe("pending");
    expect(conn.recordedFrames.length).toBe(beforeInvalidate + 1);
    store.dispose();
  });

  it("refresh re-issues list_sessions for a settled path without dropping rows", () => {
    const { store, conn } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: false,
      sessions: [makeRow({ session_id: "s1", last_used_at: 100 })],
    });
    const before = conn.recordedFrames.length;

    store.refresh("ws-1");
    const snap = store.getSnapshot("ws-1");
    expect(snap.status).toBe("ready");
    expect(snap.scanning).toBe(true);
    expect(snap.rows.map((r) => r.session_id)).toEqual(["s1"]);
    expect(conn.recordedFrames.length).toBe(before + 1);

    // A second refresh while the first is in flight is a no-op.
    store.refresh("ws-1");
    expect(conn.recordedFrames.length).toBe(before + 1);
    store.dispose();
  });

  it("refresh on an unseen path falls through to the normal request", () => {
    const { store, conn } = newStore();
    store.refresh("ws-new");
    expect(store.getSnapshot("ws-new").status).toBe("pending");
    const frames = conn.recordedFrames.filter((f) => f.feedId === FeedId.CONTROL);
    expect(frames.length).toBe(1);
    store.dispose();
  });

  it("phase-1 of a refresh merges with the previous settle instead of collapsing", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    // First settle: full union with an external row.
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: false,
      sessions: [
        makeRow({ session_id: "tug", last_used_at: 100 }),
        makeRow({ session_id: "ext", last_used_at: 200, origin: "external" }),
      ],
    });
    store.refresh("ws-1");
    // Phase 1 of the refresh carries ledger rows only — the external
    // row must survive from the previous settle.
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: true,
      sessions: [makeRow({ session_id: "tug", last_used_at: 300 })],
    });
    const phase1 = store.getSnapshot("ws-1");
    expect(phase1.scanning).toBe(true);
    expect(phase1.rows.map((r) => r.session_id)).toEqual(["tug", "ext"]);
    // Phase 2 replaces wholesale (a trashed/vanished file drops out).
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: false,
      sessions: [makeRow({ session_id: "tug", last_used_at: 300 })],
    });
    const phase2 = store.getSnapshot("ws-1");
    expect(phase2.scanning).toBe(false);
    expect(phase2.rows.map((r) => r.session_id)).toEqual(["tug"]);
    store.dispose();
  });

  it("phase-1 backfills a sparser incoming row from the previous settle", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    // Previous settle: the union showed the session rich (50 turns,
    // prompt, title — merged from its on-disk transcript).
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: false,
      sessions: [
        makeRow({
          session_id: "s1",
          last_used_at: 100,
          turn_count: 50,
          last_user_prompt: "rich prompt",
          name: "Rich title",
        }),
      ],
    });
    store.refresh("ws-1");
    // Phase 1 re-emits the raw ledger row — sparse (zero turns, no
    // prompt). The picker hides zero-turn rows, so without backfill
    // the session would vanish for the scan window.
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: true,
      sessions: [
        makeRow({ session_id: "s1", last_used_at: 200, turn_count: 0 }),
      ],
    });
    const row = store.getSnapshot("ws-1").rows[0];
    expect(row.turn_count).toBe(50);
    expect(row.last_user_prompt).toBe("rich prompt");
    expect(row.name).toBe("Rich title");
    expect(row.last_used_at).toBe(200);
    store.dispose();
  });

  it("phase-1 reflects a downward reconcile (no stale-high MAX pin)", () => {
    // [P08]: the count is server-authoritative. A session that legitimately
    // dropped (10 → 5, e.g. the canonical strict rule corrected an inflated
    // estimate) must show 5 immediately during a refresh scan — the old
    // client Math.max would have pinned the stale 10 until phase-2.
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: false,
      sessions: [
        makeRow({
          session_id: "s1",
          last_used_at: 100,
          turn_count: 10,
          last_user_prompt: "prompt",
          name: "Title",
        }),
      ],
    });
    store.refresh("ws-1");
    // Phase 1 of the refresh carries the reconciled (lower) count.
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: true,
      sessions: [
        makeRow({
          session_id: "s1",
          last_used_at: 200,
          turn_count: 5,
          last_user_prompt: "prompt",
          name: "Title",
        }),
      ],
    });
    expect(store.getSnapshot("ws-1").rows[0].turn_count).toBe(5);
    store.dispose();
  });

  it("scan progress ticks decorate an in-flight scan and clear on settle", () => {
    const { store } = newStore();
    store.getSnapshot("ws-1");
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: true,
      sessions: [makeRow({ session_id: "tug" })],
    });
    publishListSessionsProgress({ project_dir: "ws-1", parsed: 0, total: 40 });
    expect(store.getSnapshot("ws-1").scanProgress).toEqual({
      parsed: 0,
      total: 40,
    });
    publishListSessionsProgress({ project_dir: "ws-1", parsed: 25, total: 40 });
    expect(store.getSnapshot("ws-1").scanProgress).toEqual({
      parsed: 25,
      total: 40,
    });
    // The settled phase-2 frame clears the progress decoration.
    publishListSessionsOk({
      dir_exists: true,
      project_dir: "ws-1",
      scanning: false,
      sessions: [makeRow({ session_id: "tug" })],
    });
    expect(store.getSnapshot("ws-1").scanProgress).toBeUndefined();
    // A straggler tick after settle is ignored.
    publishListSessionsProgress({ project_dir: "ws-1", parsed: 40, total: 40 });
    expect(store.getSnapshot("ws-1").scanProgress).toBeUndefined();
    store.dispose();
  });

  it("trashSession resolves with the CONTROL ack", async () => {
    const { store, conn } = newStore();
    const promise = store.trashSession("s1");

    // The store must have emitted a trash_session frame.
    const frames = conn.recordedFrames.filter((f) => f.feedId === FeedId.CONTROL);
    expect(frames.length).toBe(1);
    const decoded = JSON.parse(
      new TextDecoder().decode(frames[0].decoded as Uint8Array),
    );
    expect(decoded).toEqual({ action: "trash_session", session_id: "s1" });

    // Simulate the server's ack.
    publishTrashSessionOk({ session_id: "s1" });
    const result = await promise;
    expect(result).toEqual({ ok: true });
    store.dispose();
  });

  it("trashSession resolves with error on _err", async () => {
    const { store } = newStore();
    const promise = store.trashSession("live1");
    publishTrashSessionErr({ session_id: "live1", reason: "session_is_live" });
    const result = await promise;
    expect(result).toEqual({ error: { reason: "session_is_live" } });
    store.dispose();
  });

  it("session_updated patches across workspaces using the row payload's workspace_key", () => {
    // Even if the row's workspace isn't in the cache, the reverse index
    // remembers the location for a future lookup. Verifies the
    // bookkeeping doesn't lose track of late-arriving rows.
    const { store } = newStore();
    publishSessionUpdated({
      session_id: "s1",
      fields: makeRow({ session_id: "s1", workspace_key: "ws-2" }),
    });
    // The store hasn't fetched ws-2 yet; first getSnapshot triggers a
    // pending state. The reverse index now knows about s1, but the
    // visible snapshot remains pending until list_sessions_ok lands.
    const snap = store.getSnapshot("ws-2");
    expect(snap.status).toBe("pending");
    store.dispose();
  });
});

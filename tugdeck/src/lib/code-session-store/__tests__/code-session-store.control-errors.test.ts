/**
 * T3.4.a.1 — CONTROL-error routing.
 *
 * Closes the gap between [§T3.4.a](../../../../../design doc)
 * promised `lastError.cause` union (five members) and the three-member
 * union T3.4.a shipped. Two new causes reach the store via the CONTROL
 * feed:
 *
 * - `session_unknown`: supervisor orphan-dispatcher path. Fires when
 *   a CODE_INPUT write references a session the supervisor no longer
 *   knows about — typically a stale `tug_session_id` from tugbank
 *   after a server reconnect. The wire frame carries
 *   `tug_session_id`, so the per-card filter routes it via the normal
 *   session-match path.
 *
 * - `session_not_owned`: router P5 authz rejection path. Fires when a
 *   client sends CODE_INPUT for a session another client owns, or
 *   (more commonly) a session this client never registered via
 *   `spawn_session`. The wire frame from `router.rs` currently carries
 *   NO `tug_session_id`, so the per-card filter relaxes for CONTROL
 *   error frames and the reducer's phase gate picks the store that is
 *   actually waiting on an input response.
 *
 * Neither failure mode is covered by SESSION_STATE errored or
 * transport_close — the supervisor doesn't emit a state change, and
 * the socket stays open. Without this handling, a card with a stale
 * `tug_session_id` hits Send and sits in `submitting` forever.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import {
  TestFrameChannel,
} from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG_A = FIXTURE_IDS.TUG_SESSION_ID;
const TUG_B = "tug00000-0000-4000-8000-0000000000bb";

function constructStore(
  conn: TestFrameChannel,
  tugSessionId: string = TUG_A,
): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId,
    sessionMode: "new",
  });
}

describe("CodeSessionStore — session_unknown CONTROL error (T3.4.a.1)", () => {
  it("routes to errored with cause=session_unknown when the frame matches this session", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("read something", []);
    expect(store.getSnapshot().phase).toBe("submitting");

    // Supervisor's orphan-dispatcher frame (see
    // `build_session_unknown_frame` in agent_supervisor/mod.rs) — carries
    // `tug_session_id`, so the per-card filter routes it directly.
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_unknown",
      tug_session_id: TUG_A,
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.lastError?.cause).toBe("session_unknown");
    expect(snap.lastError?.message).toBe("session_unknown");
  });

  it("drops session_unknown while the store is idle", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_unknown",
      tug_session_id: TUG_A,
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.lastError).toBeNull();
  });

  it("does not route session_unknown for some other session", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);

    // Frame for a different tug_session_id — per-card filter drops it.
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_unknown",
      tug_session_id: TUG_B,
    });

    expect(store.getSnapshot().phase).toBe("submitting");
    expect(store.getSnapshot().lastError).toBeNull();
  });
});

describe("CodeSessionStore — session_not_owned CONTROL error (T3.4.a.1)", () => {
  it("errors the card the rejected write was for", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    expect(store.getSnapshot().phase).toBe("submitting");

    // Exactly the shape `router.rs` emits on the P5 authz reject: the
    // rejection names the session whose CODE_INPUT write it killed.
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_not_owned",
      tug_session_id: TUG_A,
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.lastError?.cause).toBe("session_not_owned");
    expect(snap.lastError?.message).toBe("session_not_owned");
  });

  it("drops session_not_owned while the store is idle (no turn to kill)", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_not_owned",
      tug_session_id: TUG_A,
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.lastError).toBeNull();
  });

  it("drops an unaddressed CONTROL error outright", () => {
    // No `tug_session_id` means no card can prove the notice is its own,
    // and acting on it would end an unrelated card's turn.
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_not_owned",
    });

    expect(store.getSnapshot().phase).toBe("submitting");
    expect(store.getSnapshot().lastError).toBeNull();
  });

  it("ends a streaming turn whose write was rejected", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    // Drive past awaiting_first_token into streaming.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      tug_session_id: TUG_A,
      msg_id: FIXTURE_IDS.MSG_ID,
      text: "a",
      is_partial: true,
      rev: 0,
      seq: 0,
    });
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      tug_session_id: TUG_A,
      msg_id: FIXTURE_IDS.MSG_ID,
      text: "b",
      is_partial: true,
      rev: 1,
      seq: 0,
    });
    expect(store.getSnapshot().phase).toBe("streaming");

    // A streaming card still issues CODE_INPUT writes — approvals,
    // interrupts, mode changes. The rejection names this session, so it
    // is this turn that died, and the turn must end: no `turn_complete`
    // is coming, and a turn left live here bows its in-flight indicator
    // forever.
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_not_owned",
      tug_session_id: TUG_A,
    });

    expect(store.getSnapshot().phase).toBe("errored");
    expect(store.getSnapshot().lastError?.cause).toBe("session_not_owned");
  });
});

describe("CodeSessionStore — multi-card routing of CONTROL errors (T3.4.a.1)", () => {
  it("routes session_not_owned by id, not by which card looks busy", () => {
    const conn = new TestFrameChannel();
    const storeA = constructStore(conn, TUG_A);
    const storeB = constructStore(conn, TUG_B);

    // BOTH cards have a live turn — the old phase heuristic could not
    // have told them apart.
    storeA.send("from A", []);
    storeB.send("from B", []);
    expect(storeA.getSnapshot().phase).toBe("submitting");
    expect(storeB.getSnapshot().phase).toBe("submitting");

    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_not_owned",
      tug_session_id: TUG_B,
    });

    expect(storeA.getSnapshot().phase).toBe("submitting");
    expect(storeA.getSnapshot().lastError).toBeNull();
    expect(storeB.getSnapshot().phase).toBe("errored");
    expect(storeB.getSnapshot().lastError?.cause).toBe("session_not_owned");
  });

  it("recovers via send() from errored after a CONTROL error", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("first attempt", []);
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_unknown",
      tug_session_id: TUG_A,
    });
    expect(store.getSnapshot().phase).toBe("errored");
    const errAt = store.getSnapshot().lastError;
    expect(errAt).not.toBeNull();

    // The existing errored → submitting retry path already covers us.
    store.send("retry", []);
    expect(store.getSnapshot().phase).toBe("submitting");
    // lastError preserved across retry.
    expect(store.getSnapshot().lastError).toBe(errAt);

    // Successful turn clears lastError per.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      tug_session_id: TUG_A,
      msg_id: FIXTURE_IDS.MSG_ID,
      text: "a",
      is_partial: true,
      rev: 0,
      seq: 0,
    });
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "assistant_text",
      tug_session_id: TUG_A,
      msg_id: FIXTURE_IDS.MSG_ID,
      text: "b",
      is_partial: true,
      rev: 1,
      seq: 0,
    });
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "turn_complete",
      tug_session_id: TUG_A,
      msg_id: FIXTURE_IDS.MSG_ID,
      result: "success",
    });
    expect(store.getSnapshot().phase).toBe("idle");
    expect(store.getSnapshot().lastError).toBeNull();
  });

  it("ignores non-error CONTROL frames with matching tug_session_id", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);

    // A spawn_session_ok frame for this session: the per-card filter
    // lets it through (tsid matches) but frameToEvent returns null
    // for anything that's not a CONTROL error. State untouched.
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "spawn_session_ok",
      tug_session_id: TUG_A,
      workspace_key: "ws-000",
    });

    expect(store.getSnapshot().phase).toBe("submitting");
    expect(store.getSnapshot().lastError).toBeNull();
  });

  it("ignores app-level CONTROL frames with no tug_session_id (reload, set-theme)", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);

    // App-level frames handled by action-dispatch.ts global handler.
    // The per-card filter drops them (non-error + no tsid).
    conn.dispatchDecoded(FeedId.CONTROL, { type: "reload" });
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "set-theme",
      theme: "dark",
    });

    expect(store.getSnapshot().phase).toBe("submitting");
    expect(store.getSnapshot().lastError).toBeNull();
  });
});

describe("CodeSessionStore — resume_failed CODE_OUTPUT event", () => {
  it("populates lastError with cause=resume_failed without flipping phase to errored", () => {
    // tugcode emits this after a failed `--resume` spawn falls back to
    // fresh. The fallback produced a usable session, so the store stays
    // in `idle`; `lastError` carries the notice for Step 6's affordance.
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    expect(store.getSnapshot().phase).toBe("idle");
    expect(store.getSnapshot().lastError).toBeNull();

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "resume_failed",
      reason: "claude exited before session init (likely stale --resume id)",
      stale_session_id: "sess-old-abc",
      tug_session_id: TUG_A,
      ipc_version: 2,
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.lastError?.cause).toBe("resume_failed");
    expect(snap.lastError?.message).toContain("claude exited");
    expect(snap.lastError?.message).toContain("sess-old-abc");
  });

  it("drops resume_failed frames whose tug_session_id does not match this store", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "resume_failed",
      reason: "timed out",
      stale_session_id: "sess-other",
      tug_session_id: TUG_B,
      ipc_version: 2,
    });

    expect(store.getSnapshot().lastError).toBeNull();
  });
});

/**
 * Per-card store coverage for the `context_breakdown` wire-frame path.
 *
 * The reducer's projection + effect dispatch are pinned in
 * `reducer.context-breakdown.test.ts`. The complementary surface this
 * file pins is the entry-side filter in `CodeSessionStore`: the per-card
 * predicate must let `context_breakdown` frames through to the reducer.
 * A regression here (the type missing from `KNOWN_CODE_OUTPUT_TYPES`)
 * leaves `snap.lastContextBreakdown` permanently `null` and the Context
 * popover stuck on its empty state, since the supervisor's bind-attach
 * re-emit travels the same channel and is filtered out for the same
 * reason.
 *
 * Covers:
 *  - Live `context_breakdown` frame populates `snap.lastContextBreakdown`
 *    AND emits a `record_context_breakdown` CONTROL frame so the
 *    supervisor persists the payload to the ledger.
 *  - Bind-attach frame (`from_supervisor_attach: true`) populates the
 *    snapshot but does NOT emit a CONTROL frame (the row already
 *    exists; round-tripping it would be a no-op UPSERT).
 *  - The per-card `tug_session_id` filter still applies — a frame for
 *    a different session leaves the snapshot untouched.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

interface RecordContextBreakdownWire {
  action: string;
  tug_session_id: string;
  payload: {
    context_max: number;
    categories: ReadonlyArray<{ id: string; label: string; tokens: number }>;
  };
  captured_at: number;
}

function constructStore(conn: TestFrameChannel): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

function recordContextBreakdownFrames(
  conn: TestFrameChannel,
): RecordContextBreakdownWire[] {
  return conn.recordedFrames
    .filter((f) => f.feedId === FeedId.CONTROL)
    .map((f) => {
      const bytes = f.decoded as Uint8Array;
      const json = new TextDecoder().decode(bytes);
      return JSON.parse(json) as RecordContextBreakdownWire;
    })
    .filter((p) => p.action === "record_context_breakdown");
}

describe("CodeSessionStore — context_breakdown wire-frame ingestion", () => {
  it("a live frame populates lastContextBreakdown and emits a record CONTROL", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    expect(store.getSnapshot().lastContextBreakdown).toBeNull();

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "context_breakdown",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      context_max: 200_000,
      categories: [
        { id: "system_prompt", label: "System prompt", tokens: 3_500 },
        { id: "messages", label: "Messages", tokens: 12_000 },
      ],
    });

    const snap = store.getSnapshot();
    expect(snap.lastContextBreakdown).not.toBeNull();
    expect(snap.lastContextBreakdown!.contextMax).toBe(200_000);
    expect(snap.lastContextBreakdown!.categories.length).toBe(2);

    const recordFrames = recordContextBreakdownFrames(conn);
    expect(recordFrames.length).toBe(1);
    expect(recordFrames[0]!.tug_session_id).toBe(FIXTURE_IDS.TUG_SESSION_ID);
    expect(recordFrames[0]!.payload.context_max).toBe(200_000);
    expect(recordFrames[0]!.payload.categories.length).toBe(2);
    expect(typeof recordFrames[0]!.captured_at).toBe("number");
  });

  it("a bind-attach frame populates the snapshot without re-persisting", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "context_breakdown",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      from_supervisor_attach: true,
      context_max: 200_000,
      categories: [
        { id: "messages", label: "Messages", tokens: 8_000 },
      ],
    });

    // The snapshot reflects the bind-attach projection — the popover
    // surfaces the persisted breakdown immediately on reload instead
    // of waiting for the first live frame.
    const snap = store.getSnapshot();
    expect(snap.lastContextBreakdown).not.toBeNull();
    expect(snap.lastContextBreakdown!.contextMax).toBe(200_000);

    // But the round-trip CONTROL frame is suppressed — the row the
    // supervisor synthesized this frame from already holds the bytes
    // we'd be writing back.
    expect(recordContextBreakdownFrames(conn)).toEqual([]);
  });

  it("rejects frames for other sessions (per-card filter)", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "context_breakdown",
      tug_session_id: "tug00000-0000-4000-8000-000000000aaa",
      context_max: 200_000,
      categories: [
        { id: "messages", label: "Messages", tokens: 8_000 },
      ],
    });

    expect(store.getSnapshot().lastContextBreakdown).toBeNull();
    expect(recordContextBreakdownFrames(conn)).toEqual([]);
  });
});

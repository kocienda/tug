/**
 * Pin the Promise + bus correlation of `loadSessionStateChanges`.
 *
 * The reader sends a `list_session_state_changes` CONTROL frame and
 * resolves when a matching `_ok` or `_err` payload arrives on the
 * pub/sub bus. Correlation is by `tug_session_id`; concurrent calls
 * for different sessions resolve independently.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  _resetSessionLedgerEventsForTest,
  publishListSessionStateChangesErr,
  publishListSessionStateChangesOk,
} from "@/lib/session-ledger-events";
import { loadSessionStateChanges } from "@/lib/session-state-changes-reader";
import {
  FeedId,
  type FeedIdValue,
} from "@/protocol";

interface RecordedFrame {
  feedId: FeedIdValue;
  payload: Uint8Array;
}

class FakeConnection {
  readonly frames: RecordedFrame[] = [];
  send(feedId: FeedIdValue, payload: Uint8Array): void {
    this.frames.push({ feedId, payload });
  }
}

function decodeFrame(frame: RecordedFrame): { action: string; tug_session_id: string } {
  const text = new TextDecoder().decode(frame.payload);
  return JSON.parse(text) as { action: string; tug_session_id: string };
}

beforeEach(() => {
  _resetSessionLedgerEventsForTest();
});

afterEach(() => {
  _resetSessionLedgerEventsForTest();
});

describe("loadSessionStateChanges", () => {
  it("sends a list_session_state_changes frame for the requested session", async () => {
    const conn = new FakeConnection();
    const promise = loadSessionStateChanges(
      conn as unknown as Parameters<typeof loadSessionStateChanges>[0],
      "sess-A",
    );
    expect(conn.frames.length).toBe(1);
    const decoded = decodeFrame(conn.frames[0]!);
    expect(conn.frames[0]!.feedId).toBe(FeedId.CONTROL);
    expect(decoded.action).toBe("list_session_state_changes");
    expect(decoded.tug_session_id).toBe("sess-A");
    // Resolve so the promise settles cleanly.
    publishListSessionStateChangesOk({ tug_session_id: "sess-A", rows: [] });
    await promise;
  });

  it("resolves ok with decoded rows for the matching tug_session_id", async () => {
    const conn = new FakeConnection();
    const promise = loadSessionStateChanges(
      conn as unknown as Parameters<typeof loadSessionStateChanges>[0],
      "sess-B",
    );
    publishListSessionStateChangesOk({
      tug_session_id: "sess-B",
      rows: [
        {
          at_ms: 100,
          phase: "idle",
          transport_state: "online",
          interrupt_in_flight: false,
        },
        {
          at_ms: 200,
          phase: "submitting",
          transport_state: "online",
          interrupt_in_flight: true,
        },
      ],
    });
    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]).toEqual({
      atMs: 100,
      phase: "idle",
      transportState: "online",
      interruptInFlight: false,
    });
    expect(result.rows[1]).toEqual({
      atMs: 200,
      phase: "submitting",
      transportState: "online",
      interruptInFlight: true,
    });
  });

  it("resolves err on a matching err response", async () => {
    const conn = new FakeConnection();
    const promise = loadSessionStateChanges(
      conn as unknown as Parameters<typeof loadSessionStateChanges>[0],
      "sess-C",
    );
    publishListSessionStateChangesErr({
      tug_session_id: "sess-C",
      reason: "ledger_read_failed",
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ledger_read_failed");
  });

  it("ignores responses for other sessions", async () => {
    const conn = new FakeConnection();
    const promise = loadSessionStateChanges(
      conn as unknown as Parameters<typeof loadSessionStateChanges>[0],
      "sess-D",
    );
    // A response for an unrelated session — must NOT settle the promise.
    publishListSessionStateChangesOk({
      tug_session_id: "sess-other",
      rows: [
        {
          at_ms: 1,
          phase: "idle",
          transport_state: "online",
          interrupt_in_flight: false,
        },
      ],
    });
    // Race the promise against an immediately-resolving sentinel.
    const sentinel = Promise.resolve("sentinel" as const);
    const winner = await Promise.race([promise, sentinel]);
    expect(winner).toBe("sentinel");
    // Now publish the real response so the promise settles.
    publishListSessionStateChangesOk({ tug_session_id: "sess-D", rows: [] });
    await promise;
  });

  it("settles concurrent calls for the same session to whichever response arrives first", async () => {
    const conn = new FakeConnection();
    const p1 = loadSessionStateChanges(
      conn as unknown as Parameters<typeof loadSessionStateChanges>[0],
      "sess-E",
    );
    const p2 = loadSessionStateChanges(
      conn as unknown as Parameters<typeof loadSessionStateChanges>[0],
      "sess-E",
    );
    publishListSessionStateChangesOk({
      tug_session_id: "sess-E",
      rows: [
        {
          at_ms: 50,
          phase: "idle",
          transport_state: "online",
          interrupt_in_flight: false,
        },
      ],
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error("unreachable");
    expect(r1.rows.length).toBe(1);
    expect(r2.rows.length).toBe(1);
  });
});

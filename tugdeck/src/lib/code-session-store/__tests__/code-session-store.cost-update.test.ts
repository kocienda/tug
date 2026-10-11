/**
 * Step 6 — `cost_update` telemetry surface. The reducer builds a
 * `CostSnapshot` from `total_cost_usd`, `num_turns`, `duration_ms`,
 * `duration_api_ms`, `usage`, and `modelUsage`, surfaces it on
 * `snapshot.lastCost`, and makes no phase transition. Because the
 * golden loader preprocesses `"{{f64}}"` → `0` and `"{{i64}}"` → `0`,
 * fixture replays land zero-valued cost snapshots; non-zero and
 * structured coverage use synthetic dispatches.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import {
  TestFrameChannel,
} from "@/lib/code-session-store/testing/mock-feed-store";
import {
  FIXTURE_IDS,
  loadGoldenProbe,
} from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

function constructStore(conn: TestFrameChannel): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

/** The fields tugcode's `cost_update` always carries, zeroed. */
const COST_FIELDS = {
  num_turns: 0,
  duration_ms: 0,
  duration_api_ms: 0,
  usage: {},
  modelUsage: {},
};

function driveToStreaming(
  conn: TestFrameChannel,
  store: CodeSessionStore,
): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "assistant_text",
    status: "partial",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: FIXTURE_IDS.MSG_ID,
    text: "h",
    is_partial: true,
    rev: 0,
    seq: 0,
  });
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
    type: "assistant_text",
    status: "partial",
    tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    msg_id: FIXTURE_IDS.MSG_ID,
    text: "i",
    is_partial: true,
    rev: 1,
    seq: 0,
  });
  expect(store.getSnapshot().phase).toBe("streaming");
}

describe("CodeSessionStore — cost_update (Step 6)", () => {
  it("captures a full CostSnapshot including num_turns/duration/usage", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    driveToStreaming(conn, store);

    expect(store.getSnapshot().lastCost).toBeNull();

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "cost_update",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      total_cost_usd: 0.01337,
      num_turns: 2,
      duration_ms: 4200,
      duration_api_ms: 3900,
      usage: { input_tokens: 1234, output_tokens: 567 },
      modelUsage: { "claude-opus-4-6": { costUSD: 0.01337 } },
    });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("streaming");
    expect(snap.lastCost).not.toBeNull();
    expect(snap.lastCost?.totalCostUsd).toBe(0.01337);
    expect(snap.lastCost?.numTurns).toBe(2);
    expect(snap.lastCost?.durationMs).toBe(4200);
    expect(snap.lastCost?.durationApiMs).toBe(3900);
    expect(snap.lastCost?.usage).toEqual({
      input_tokens: 1234,
      output_tokens: 567,
    });
    expect(snap.lastCost?.modelUsage).toEqual({
      "claude-opus-4-6": { costUSD: 0.01337 },
    });
  });

  it("overwrites lastCost on a second cost_update", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    driveToStreaming(conn, store);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "cost_update",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      total_cost_usd: 0.01337,
      ...COST_FIELDS,
      duration_ms: 4200,
    });
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "cost_update",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      total_cost_usd: 0.042,
      ...COST_FIELDS,
      num_turns: 5,
      duration_ms: 100,
    });

    const snap = store.getSnapshot();
    expect(snap.lastCost?.totalCostUsd).toBe(0.042);
    expect(snap.lastCost?.numTurns).toBe(5);
    expect(snap.lastCost?.durationMs).toBe(100);
  });

  it("drops a cost_update that omits a field tugcode always sends", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "cost_update",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      total_cost_usd: 0.0001,
    });
    // The frame fails its decoder at `num_turns` and never reaches the
    // reducer.
    expect(store.getSnapshot().lastCost).toBeNull();
  });

  it("ignores cost_update with non-numeric total_cost_usd", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hi", []);
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "cost_update",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      // Simulate a wire-contract break.
      total_cost_usd: "not-a-number",
    });
    expect(store.getSnapshot().lastCost).toBeNull();
  });

  it("captures a zero CostSnapshot from the test-01 fixture round-trip", () => {
    const probe = loadGoldenProbe("v2.1.105", "test-01-basic-round-trip");
    const conn = new TestFrameChannel();
    const store = constructStore(conn);

    store.send("hello", []);
    for (const event of probe.events) {
      conn.dispatchDecoded(FeedId.CODE_OUTPUT, event);
    }

    // The golden loader rewrites `"{{f64}}"` → `0` and `"{{i64}}"` →
    // `0`, so every fixture cost_update resolves to a zero-valued
    // snapshot. The reducer still captures it.
    const snap = store.getSnapshot();
    expect(snap.lastCost).not.toBeNull();
    expect(snap.lastCost?.totalCostUsd).toBe(0);
    expect(snap.lastCost?.numTurns).toBe(1); // literal int in the fixture
    // duration_ms / duration_api_ms are `{{i64}}` placeholders that
    // preprocess to 0; usage/modelUsage pass through as unknown trees.
    expect(snap.lastCost?.durationMs).toBe(0);
    expect(snap.lastCost?.durationApiMs).toBe(0);
    expect(snap.lastCost?.usage).not.toBeNull();
    expect(snap.lastCost?.modelUsage).not.toBeNull();
  });

  it("accumulates permission_denials across turns, deduped by tool_use_id", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    store.send("hi", []);
    driveToStreaming(conn, store);

    expect(store.getSnapshot().permissionDenials).toEqual([]);

    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "cost_update",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      total_cost_usd: 0.01,
      ...COST_FIELDS,
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "tu-1", tool_input: { command: "curl x" } },
      ],
    });

    let denials = store.getSnapshot().permissionDenials;
    expect(denials).toHaveLength(1);
    expect(denials[0]).toEqual({
      toolName: "Bash",
      toolUseId: "tu-1",
      toolInput: { command: "curl x" },
    });

    // A second cost_update re-reporting tu-1 plus a new tu-2 → only tu-2 added.
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "cost_update",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      total_cost_usd: 0.02,
      ...COST_FIELDS,
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "tu-1", tool_input: { command: "curl x" } },
        { tool_name: "WebFetch", tool_use_id: "tu-2", tool_input: { url: "https://x" } },
      ],
    });

    denials = store.getSnapshot().permissionDenials;
    expect(denials.map((d) => d.toolUseId)).toEqual(["tu-1", "tu-2"]);

    // A cost_update with no denials leaves the list reference unchanged.
    const before = store.getSnapshot().permissionDenials;
    conn.dispatchDecoded(FeedId.CODE_OUTPUT, {
      type: "cost_update",
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
      total_cost_usd: 0.03,
      ...COST_FIELDS,
    });
    expect(store.getSnapshot().permissionDenials).toBe(before);
  });
});

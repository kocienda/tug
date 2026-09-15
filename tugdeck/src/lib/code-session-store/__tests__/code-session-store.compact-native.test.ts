/**
 * Native-compaction intake over the REAL store + reducer + wrapper
 * ([P03]/[P04]/[P05]). Frames are delivered through the same `TestFrameChannel`
 * the app-test harness uses, mirroring the cold-replay sequence tugcode emits:
 * a replayed turn, then `compact_boundary`, then `compact_summary`, all inside
 * the replay bracket. The boundary arrives with no open turn (the prior turn
 * closed and the `/compact` scaffolding is skipped), so the divider must fall
 * back onto the last committed turn ([P04]); the summary must restore the
 * carry-forward via `compactionSeed` ([P05]).
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { deriveContextWindows } from "@/lib/code-session-store/end-state";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;

function makeStore(): { store: CodeSessionStore; conn: TestFrameChannel } {
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
  });
  return { store, conn };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

function turnFrames(n: number): Array<Record<string, unknown>> {
  return [
    { type: "add_user_message", content: [{ type: "text", text: `prompt ${n}` }] },
    {
      type: "assistant_text",
      msg_id: FIXTURE_IDS.MSG_ID_N(n),
      text: `reply ${n}`,
      is_partial: false,
      rev: 0,
      seq: 0,
    },
    { type: "turn_complete", msg_id: FIXTURE_IDS.MSG_ID_N(n), result: "success" },
  ];
}

const SUMMARY =
  "This session is being continued from a previous conversation that ran " +
  "out of context.\n\nSummary:\n1. Primary Request: fun facts about numbers.";

describe("CodeSessionStore — native compaction replay ([P04]/[P05])", () => {
  it("boundary after a committed turn seats the divider on that turn; summary restores the carry-forward", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    for (const f of turnFrames(1)) emit(conn, f);
    emit(conn, { type: "compact_boundary", trigger: "manual", pre_tokens: 26239 });
    emit(conn, { type: "compact_summary", summary: SUMMARY });
    emit(conn, { type: "replay_complete", count: 1 });

    const tx = store.getSnapshot().transcript;
    expect(tx).toHaveLength(1);

    // The compaction divider landed on the last committed turn.
    const note = tx[0].messages.find((m) => m.kind === "system_note");
    expect(note).toBeDefined();
    if (note && note.kind === "system_note") {
      expect(note.source).toBe("compact");
      expect(note.text).toBe("Session compacted · ~26k tokens");
    }
    // The user + assistant rows are undisturbed ahead of the appended note.
    expect(tx[0].messages[0]?.kind).toBe("user_message");

    // The carry-forward summary restored from the summary frame.
    const seed = store.getSnapshot().compactionSeed;
    expect(seed).not.toBeNull();
    expect(seed!.summary).toBe(SUMMARY);
  });

  it("a boundary with no committed turn (empty transcript) is a no-op", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    emit(conn, { type: "compact_boundary", trigger: "manual", pre_tokens: 26239 });
    emit(conn, { type: "replay_complete", count: 0 });

    expect(store.getSnapshot().transcript).toHaveLength(0);
  });
});

describe("CodeSessionStore — post-compaction accounting (transcript intact)", () => {
  it("leaves every turn in place; stamps the honest total on the last turn (H1); CONTEXT may drop BELOW the latched base", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    // Establish the session base.
    emit(conn, { type: "streaming_usage", msg_id: FIXTURE_IDS.MSG_ID_N(1), usage: { input_tokens: 24_000 } });
    for (let n = 1; n <= 3; n++) for (const f of turnFrames(n)) emit(conn, f);
    emit(conn, {
      type: "compact_boundary",
      trigger: "manual",
      pre_tokens: 26_239,
      post_tokens: 1_442,
    });
    emit(conn, { type: "replay_complete", count: 3 });

    const snap = store.getSnapshot();
    const tx = snap.transcript;
    // The transcript is untouched — all three turns remain.
    expect(tx).toHaveLength(3);
    // The compaction divider seats on the last committed turn.
    const last = tx[tx.length - 1];
    expect(last.messages.some((m) => m.kind === "system_note" && m.source === "compact")).toBe(true);
    // Honest total = post_tokens (1_442), stamped on it. The base is already
    // inside that figure — `pre_tokens`/`post_tokens` are whole-window
    // measures — so the latch below is not added to it.
    expect(last.compactionPostTotal).toBe(1_442);
    expect(snap.sessionInitTokens).toBe(24_000);
    // deriveContextWindows reports the honest window — no stale peak, and no
    // floor at the latch: a latch captured from a RESUMED conversation is the
    // whole resident transcript, and a compaction is entitled to land under
    // it. Pinning CONTEXT at the base is what kept a 9_205-token session
    // reading 231.8K.
    const windows = deriveContextWindows(
      tx.map((t) => t.cost),
      snap.sessionInitTokens ?? 0,
      tx.map((t) => t.compactionPostTotal ?? null),
    );
    expect(windows[windows.length - 1]!.window).toBe(1_442);
    expect(windows[windows.length - 1]!.window).toBeLessThan(24_000);
  });
});

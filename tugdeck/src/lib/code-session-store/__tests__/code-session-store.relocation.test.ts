/**
 * The directory-change divider, end to end through the store and the reducer.
 *
 * A card that moved into another directory replays the history it carried,
 * and tugcode marks the move with one `replay_relocation` frame. The store
 * translates it to a `session_relocation` event; the reducer asks for one
 * `append-relocation-note` and moves nothing; the wrapper seats a
 * `relocation` system note on the last committed turn, so the divider reads
 * after the carried history and before the first turn in the new directory.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { reduce, createInitialState } from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import { RELOCATION_BOUNDARY_EVENT } from "@/lib/code-session-store/stages";
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

describe("session_relocation in the reducer", () => {
  it("at idle, leaves state reference-identical and asks for one divider", () => {
    const state = createInitialState(TUG, "test", "new");
    const event = {
      type: "session_relocation",
      fromDir: "/work/a",
      toDir: "/work/b",
    } as CodeSessionEvent;
    const { state: next, effects } = reduce(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([
      { kind: "append-relocation-note", fromDir: "/work/a", toDir: "/work/b" },
    ]);
  });
});

describe("CodeSessionStore — replayed directory change", () => {
  it("seats the divider after the carried history, before the turn said after the move", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    for (const f of turnFrames(1)) emit(conn, f);
    for (const f of turnFrames(2)) emit(conn, f);
    emit(conn, { type: "replay_relocation", from_dir: "/work/a", to_dir: "/work/b" });
    for (const f of turnFrames(3)) emit(conn, f);
    emit(conn, { type: "replay_complete", count: 3 });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    const tx = snap.transcript;
    expect(tx).toHaveLength(3);
    const notesOn = (i: number) => tx[i]!.messages.filter((m) => m.kind === "system_note");
    expect(notesOn(0)).toHaveLength(0);
    expect(notesOn(2)).toHaveLength(0);
    const last = tx[1]!.messages[tx[1]!.messages.length - 1];
    expect(last).toMatchObject({
      kind: "system_note",
      source: "relocation",
      text: RELOCATION_BOUNDARY_EVENT,
      relocation: { fromDir: "/work/a", toDir: "/work/b" },
    });
  });

  it("a trailing divider closes the carried history", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    for (const f of turnFrames(1)) emit(conn, f);
    emit(conn, { type: "replay_relocation", from_dir: "/work/a", to_dir: "/work/b" });
    emit(conn, { type: "replay_complete", count: 1 });

    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    const messages = snap.transcript[0]!.messages;
    expect(messages[messages.length - 1]).toMatchObject({
      kind: "system_note",
      source: "relocation",
    });
  });

  it("with nothing replayed before it, the divider is a no-op", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    emit(conn, { type: "replay_relocation", from_dir: "/work/a", to_dir: "/work/b" });
    emit(conn, { type: "replay_complete", count: 0 });
    expect(store.getSnapshot().transcript).toHaveLength(0);
  });
});

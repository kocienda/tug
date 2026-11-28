/**
 * code-session-store.follow-on.test.ts — a turn the deck did not open is
 * drawn, as a continuation of the exchange it follows ([B03], [B04]).
 *
 * claude runs a message it did not merge into the running turn as a turn of
 * its own, right after that turn's result. tugcode announces it with a
 * `follow_on_started` frame; before that frame existed, every frame of the
 * follow-on arrived at an idle card and was dropped, so the commands it ran
 * passed in silence ([F06]).
 *
 * The frames are the real tugcode recording in `fixtures/follow-on-turn/`.
 * It predates tugcode forwarding `command_lifecycle` and announcing the
 * follow-on, so the two frames tugcode now writes at claude's `started` are
 * spliced in where claude reported it: after the first turn's result, ahead
 * of the follow-on's own `system/init` (`system_metadata`, line 33).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CodeSessionStore } from "@/lib/code-session-store";
import { reduce, createInitialState, type CodeSessionState } from "@/lib/code-session-store/reducer";
import type { Effect } from "@/lib/code-session-store/effects";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { Message, TurnEntry } from "@/lib/code-session-store/types";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FeedId } from "@/protocol";

const TUG = "17eb4174-ca22-4cc0-a47c-6c539f44aa3b";
/** The second message's submission id in the recording. */
const RECORDED_SECOND_ID = "2bd7ccb3-1ea1-4cad-9329-4a60719d3f04";
const SECOND_TEXT = "Also run: echo pushed";

const FRAMES: ReadonlyArray<Record<string, unknown>> = readFileSync(
  join(import.meta.dir, "fixtures/follow-on-turn/tugcode-frames.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as Record<string, unknown>);

/** 1-based recording line numbers, as the fixture's README names them. */
const LINE = { promptAnchor: 8, firstToolResult: 18, firstTurnComplete: 30, followOnInit: 33, secondTurnComplete: 53 };

function makeStore(): { store: CodeSessionStore; conn: TestFrameChannel } {
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "new",
  });
  return { store, conn };
}

function emit(conn: TestFrameChannel, frame: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...frame, tug_session_id: TUG });
}

/** Emit recording lines `from`..`to` (1-based, inclusive). */
function emitLines(conn: TestFrameChannel, from: number, to: number): void {
  for (let n = from; n <= to; n++) emit(conn, FRAMES[n - 1]);
}

/** The two frames tugcode writes at claude's `command_lifecycle started` for a follow-on. */
function emitFollowOnStart(conn: TestFrameChannel, submissionId: string): void {
  emit(conn, { type: "command_lifecycle", submissionId, state: "started", ipc_version: 2 });
  emit(conn, {
    type: "follow_on_started",
    submissionId,
    content: [{ type: "text", text: SECOND_TEXT }],
    ipc_version: 2,
  });
}

/** What a transcript turn draws, one line per message. */
function shape(messages: ReadonlyArray<Message>): string[] {
  return messages.map((m) => {
    switch (m.kind) {
      case "user_message":
        return `user: ${m.text}`;
      case "tool_use":
        return `tool: ${String((m.input as { command?: unknown }).command)}`;
      case "assistant_text":
        return `text: ${m.text}`;
      default:
        return m.kind;
    }
  });
}

const EXCHANGE = [
  "user: Run exactly one Bash command: echo committed. Then reply with one short sentence saying it is done. Do nothing else.",
  "tool: echo committed",
  "text: The command ran and printed `committed`.",
  `user: ${SECOND_TEXT}`,
  "tool: echo pushed",
  "text: The command ran and printed `pushed`.",
];

/** Drive the first turn from the user's send up to its `turn_complete`. */
function firstTurn(conn: TestFrameChannel, store: CodeSessionStore): void {
  emitLines(conn, 1, LINE.promptAnchor - 1);
  store.send(EXCHANGE[0].slice("user: ".length), []);
  emitLines(conn, LINE.promptAnchor, LINE.firstToolResult - 1);
}

describe("a follow-on turn is drawn as a continuation", () => {
  it("draws both turns' work as one exchange, the message seated where claude took it in", () => {
    const { store, conn } = makeStore();
    firstTurn(conn, store);
    // The user's second message, posted while the command ran and sent at
    // Return; claude has already begun its next request when it arrives, so
    // it runs it as a turn of its own.
    store.send(SECOND_TEXT, []);
    const secondId = store.getSnapshot().queuedSends[0].turnKey;
    emitLines(conn, LINE.firstToolResult, LINE.followOnInit - 1);
    expect(store.getSnapshot().phase).toBe("idle");
    const firstKey = store.getSnapshot().transcript[0].turnKey;

    emitFollowOnStart(conn, secondId);
    // The committed turn is in flight again, under its own key, so its rows
    // are the same rows; nothing is committed twice meanwhile.
    expect(store.getSnapshot().transcript.length).toBe(0);
    expect(store.getSnapshot().activeTurn?.turnKey).toBe(firstKey);

    emitLines(conn, LINE.followOnInit, LINE.secondTurnComplete);
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.transcript.length).toBe(1);
    const turn: TurnEntry = snap.transcript[0];
    expect(turn.turnKey).toBe(firstKey);
    expect(shape(turn.messages)).toEqual(EXCHANGE);
    // One message, one row: the waiting row became the seated one.
    expect(turn.messages.filter((m) => m.kind === "user_message" && m.submissionId === secondId).length).toBe(1);
    // `/rewind` stays on the exchange's opener, not the follow-on's message.
    expect(turn.promptUuid).toBe(FRAMES[LINE.promptAnchor - 1].promptUuid as string);
  });

  it("draws a follow-on the card holds no copy of from the announced content", () => {
    const { store, conn } = makeStore();
    firstTurn(conn, store);
    emitLines(conn, LINE.firstToolResult, LINE.followOnInit - 1);
    emitFollowOnStart(conn, RECORDED_SECOND_ID);
    emitLines(conn, LINE.followOnInit, LINE.secondTurnComplete);

    const snap = store.getSnapshot();
    expect(snap.transcript.length).toBe(1);
    expect(shape(snap.transcript[0].messages)).toEqual(EXCHANGE);
  });
});

// ---------------------------------------------------------------------------
// Reducer-level guarantees the recording does not reach.
// ---------------------------------------------------------------------------

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): { state: CodeSessionState; effects: Effect[] } {
  let current = state;
  const effects: Effect[] = [];
  for (const ev of events) {
    const r = reduce(current, ev);
    current = r.state;
    effects.push(...r.effects);
  }
  return { state: current, effects };
}

function followOn(submissionId: string, text = SECOND_TEXT): CodeSessionEvent {
  return { type: "follow_on_started", submissionId, text, atoms: [], turnKey: `minted-${submissionId}` };
}

function textTurn(msgId: string, text: string): CodeSessionEvent[] {
  return [
    { type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" },
    { type: "assistant_text", msg_id: msgId, block_index: 0, seq: 0, rev: 0, text, is_partial: false, status: "complete" },
    { type: "turn_complete", msg_id: msgId, seq: 1, result: "success" },
  ];
}

function committed(effects: ReadonlyArray<Effect>): TurnEntry[] {
  return effects.flatMap((e) => (e.kind === "append-transcript" ? [e.entry] : []));
}

describe("follow_on_started in the reducer", () => {
  it("opens a turn of its own when there is no committed turn to continue", () => {
    const { state, effects } = applyAll(createInitialState("s", "t", "new"), [
      followOn("sub-1"),
      ...textTurn("m1", "done"),
    ]);
    expect(effects.some((e) => e.kind === "reopen-turn")).toBe(false);
    const [entry] = committed(effects);
    expect(entry.origin).toBe("user");
    expect(shape(entry.messages)).toEqual([`user: ${SECOND_TEXT}`, "text: done"]);
    expect(state.phase).toBe("idle");
  });

  it("joins a turn already open rather than opening another", () => {
    const send: CodeSessionEvent = { type: "send", text: "go", atoms: [], content: [{ type: "text", text: "go" }], turnKey: "k1" };
    const { effects } = applyAll(createInitialState("s", "t", "new"), [
      send,
      followOn("sub-2"),
      ...textTurn("m1", "both"),
    ]);
    const entries = committed(effects);
    expect(entries.length).toBe(1);
    expect(shape(entries[0].messages)).toEqual(["user: go", `user: ${SECOND_TEXT}`, "text: both"]);
  });

  it("folds the two segments' telemetry into the exchange, and records the follow-on's own", () => {
    const send: CodeSessionEvent = { type: "send", text: "go", atoms: [], content: [{ type: "text", text: "go" }], turnKey: "k1" };
    const first = applyAll(createInitialState("s", "t", "new"), [send, ...textTurn("m1", "one")]);
    const [prior] = committed(first.effects);
    const second = applyAll(first.state, [followOn("sub-3"), ...textTurn("m2", "two")]);
    const [entry] = committed(second.effects);
    expect(second.effects.find((e) => e.kind === "reopen-turn")).toEqual({ kind: "reopen-turn", turnKey: "k1" });
    expect(entry.turnKey).toBe("k1");
    expect(entry.msgId).toBe("m2");
    expect(entry.activeMs).toBeGreaterThanOrEqual(prior.activeMs);
    expect(entry.wallClockMs).toBeGreaterThanOrEqual(prior.wallClockMs);
    const recorded = second.effects.find((e) => e.kind === "record-telemetry");
    expect(recorded?.kind === "record-telemetry" ? recorded.msgId : null).toBe("m2");
  });

  it("reopens nothing after a rewind or a replay rewrote the transcript", () => {
    const send: CodeSessionEvent = { type: "send", text: "go", atoms: [], content: [{ type: "text", text: "go" }], turnKey: "k1" };
    const first = applyAll(createInitialState("s", "t", "new"), [send, ...textTurn("m1", "one")]);
    expect(first.state.lastLiveCommit?.turnKey).toBe("k1");
    const replayed = applyAll(first.state, [{ type: "replay_started" }, { type: "replay_complete", count: 0 }]);
    expect(replayed.state.lastLiveCommit).toBeNull();
    const after = applyAll(replayed.state, [followOn("sub-4")]);
    expect(after.effects.some((e) => e.kind === "reopen-turn")).toBe(false);
  });
});

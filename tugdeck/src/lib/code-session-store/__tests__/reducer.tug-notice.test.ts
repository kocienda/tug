// A server-initiated turn is never unannounced. When Tug injects a submission
// into a session — the base-motion engine does, when a dash's base moves under
// it — tugcast emits a `tug_notice` beside it, and that frame is what puts the
// turn's head row on screen: the live user row comes from the composer echoing
// its own submission, and an injection has no composer.
//
// These drive the real store over real frames: the notice opens an
// assistant-origin turn carrying its text as a `notice` system_note, so the
// words are visibly Tug's and not the user's.
//
// The WHEEL is the exception, and it is a difference in kind rather than in
// degree. The base-motion engine is plumbing: it has no name a reader would
// recognize, so its words can only be shown as a note about the session. The
// wheel is a participant — it is the thing steering an arc, and the transcript
// has a name and a mark for it. A prompt it sends is the wheel TALKING, so it
// opens a `wheel` turn with a real `user_message` in it, the same shape a
// typed prompt gets. Shown as a quoted note instead, the wheel reads as
// something the session is citing rather than the hand on the tiller.

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;
const BODY =
  "[base-motion replay] The base branch main moved to abcdef012 under dash \"demo\".";
const WHEEL_PROMPT =
  "/tugplug:dash-implement tripwire Steps 4-13 — under this arc, close one step and end your turn; the arc prompts you with the next";

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

describe("tug_notice — the opener that makes an injected turn visible", () => {
  it("opens a turn whose head row carries the notice, attributed to its origin", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "tug_notice", origin: "base-motion", text: BODY });

    const active = store.getSnapshot().activeTurn;
    expect(active).not.toBeNull();
    expect(active!.origin).toBe("assistant");
    const head = active!.messages[0];
    expect(head.kind).toBe("system_note");
    expect(head).toMatchObject({
      source: "notice",
      noticeOrigin: "base-motion",
      text: BODY,
    });
  });

  it("puts no words in the user's mouth — the turn commits with no user message", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "tug_notice", origin: "base-motion", text: BODY });
    emit(conn, {
      type: "assistant_text",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "on it",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    emit(conn, {
      type: "turn_complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });

    const { transcript } = store.getSnapshot();
    expect(transcript).toHaveLength(1);
    expect(transcript[0].origin).toBe("assistant");
    expect(
      transcript[0].messages.some((m) => m.kind === "user_message"),
    ).toBe(false);
    // Exactly one head row, not two: the notice is the turn's opening ink and
    // nothing else claims that position.
    expect(
      transcript[0].messages.filter(
        (m) => m.kind === "system_note" && m.source === "notice",
      ),
    ).toHaveLength(1);
  });

  it("is refused mid-turn, so it can never split a running turn in half", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "tug_notice", origin: "base-motion", text: BODY });
    const first = store.getSnapshot().activeTurn!.turnKey;
    emit(conn, { type: "tug_notice", origin: "base-motion", text: "again" });
    const snap = store.getSnapshot();
    expect(snap.activeTurn!.turnKey).toBe(first);
    expect(snap.activeTurn!.messages).toHaveLength(1);
  });

  it("a notice with no body opens nothing", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "tug_notice", origin: "base-motion", text: "" });
    expect(store.getSnapshot().activeTurn).toBeNull();
  });

  // The wheel's own prompts. An arc's opening prompt already takes this path
  // (through `session_stage`); these are the ones it sends later — a continued
  // implement range, a `/compact` — and they are the same voice, so they get
  // the same row.
  it("opens a wheel turn holding the wheel's own message, not a quoted note", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "tug_notice", origin: "wheel", text: WHEEL_PROMPT });

    const active = store.getSnapshot().activeTurn;
    expect(active).not.toBeNull();
    expect(active!.origin).toBe("wheel");
    const head = active!.messages[0];
    expect(head.kind).toBe("user_message");
    expect(head).toMatchObject({ origin: "wheel" });
    expect(
      active!.messages.some(
        (m) => m.kind === "system_note" && m.source === "notice",
      ),
      "the wheel speaks in its own row; nothing quotes it",
    ).toBe(false);
  });

  // The prompt opens with `/tugplug:dash-implement`, which the wheel INVOKED
  // rather than wrote about. A typed prompt's leading command becomes a command
  // atom in the composer, and the wheel's does too — the row reads as a command
  // run, not as a line of text that happens to start with a slash.
  it("mints the leading command atom, as a typed prompt would", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "tug_notice", origin: "wheel", text: WHEEL_PROMPT });

    const head = store.getSnapshot().activeTurn!.messages[0];
    expect(head.kind).toBe("user_message");
    if (head.kind !== "user_message") return;
    expect(head.attachments).toHaveLength(1);
    expect(head.attachments[0]).toMatchObject({ type: "command" });
  });

  // tugcast put the submission on the wire before it ever sent this frame —
  // the notice announces an arrival, it does not request one. A turn opened
  // here that also sent would run the wheel's prompt twice.
  it("sends nothing back out — tugcast already dispatched the submission", () => {
    const { store, conn } = makeStore();
    const before = conn.recordedFrames.length;
    emit(conn, { type: "tug_notice", origin: "wheel", text: WHEEL_PROMPT });
    expect(store.getSnapshot().activeTurn).not.toBeNull();
    expect(
      conn.recordedFrames.slice(before).filter((f) => f.feedId === FeedId.CODE_INPUT),
      "no submission goes back out",
    ).toHaveLength(0);
  });

  // The reload path renders the same submission as an ordinary user row: the
  // JSONL records the injection as a user entry, so the replay translator
  // emits `add_user_message`. Live and reload are two renderings of one
  // submission — this pins that the replayed one still reads as a user turn,
  // so the two never double up into a pair of head rows.
  it("the same submission replays from the JSONL as one user-origin turn", () => {
    const { store, conn } = makeStore();
    emit(conn, { type: "replay_started" });
    emit(conn, { type: "add_user_message", text: BODY, atoms: [] });
    emit(conn, {
      type: "assistant_text",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      text: "on it",
      is_partial: false,
      rev: 0,
      seq: 0,
    });
    emit(conn, {
      type: "turn_complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });
    emit(conn, { type: "replay_complete", count: 1 });

    const { transcript } = store.getSnapshot();
    expect(transcript).toHaveLength(1);
    expect(transcript[0].origin).toBe("user");
    expect(
      transcript[0].messages.filter((m) => m.kind === "user_message"),
    ).toHaveLength(1);
    expect(
      transcript[0].messages.some(
        (m) => m.kind === "system_note" && m.source === "notice",
      ),
    ).toBe(false);
  });
});

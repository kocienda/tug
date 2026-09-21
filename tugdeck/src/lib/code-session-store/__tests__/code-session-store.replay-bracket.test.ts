/**
 * The replay bracket's two horizons, driven through the real store with
 * an injected `TimerSource`.
 *
 * The reported restore hang: a card stuck on "Restoring 1 session — 10 of
 * 10 turns" behind an app-wide modal, forever. The transcript had already
 * arrived — `runReplay` reads the JSONL off disk and touches neither the
 * network nor the claude process — and only the bracket's close was
 * missing. What held the card there was the silence deadline's arming
 * rule: it restarted on *any* wire frame, and the claude behind the card
 * was retrying a dead API, emitting `api_retry` more often than every
 * 15 s. The one horizon the bracket had could be bought indefinitely by
 * traffic that said nothing about the replay.
 *
 * Two changes close it, and this file is their pin:
 *
 *   - the silence deadline restarts only on a frame in
 *     `BRACKET_FRAME_TYPES` ([P05]), so `api_retry` chatter no longer
 *     buys time;
 *   - a second timer, `replay_bracket`, caps the bracket absolutely at
 *     `REPLAY_BRACKET_DEADLINE_MS` ([P04]) — armed once on entering
 *     `replaying`, never re-armed, so even a bracket that is genuinely
 *     being fed ends.
 *
 * The two are deliberately distinguishable after the fact: `replay_stalled`
 * says the relay stopped talking, `replay_bracket_timeout` says it never
 * stopped and never finished.
 */

import { describe, it, expect } from "bun:test";

import {
  CodeSessionStore,
  REPLAY_BRACKET_DEADLINE_MS,
  REPLAY_BRACKET_MESSAGE,
  REPLAY_SILENCE_DEADLINE_MS,
  REPLAY_STALLED_MESSAGE,
  type TimerSource,
} from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;
const IPC_VERSION = 2;

interface FakeTimerEntry {
  id: number;
  cb: () => void;
  fireAt: number;
  cleared: boolean;
}

/** The captured-table fake from `code-session-store.replay-clock.test.ts`. */
class FakeTimers {
  private now = 0;
  private nextId = 1;
  private entries: FakeTimerEntry[] = [];

  readonly source: TimerSource = {
    setTimeout: (cb, ms) => {
      const id = this.nextId++;
      this.entries.push({ id, cb, fireAt: this.now + ms, cleared: false });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle !== "number") return;
      const entry = this.entries.find((e) => e.id === handle);
      if (entry) entry.cleared = true;
    },
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const due = this.entries
        .filter((e) => !e.cleared && e.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0]!;
      this.now = next.fireAt;
      next.cleared = true; // a fired timer is one-shot
      next.cb();
    }
    this.now = target;
  }

  pendingCount(): number {
    return this.entries.filter((e) => !e.cleared).length;
  }
}

function makeStore(): {
  store: CodeSessionStore;
  conn: TestFrameChannel;
  timers: FakeTimers;
} {
  const conn = new TestFrameChannel();
  const timers = new FakeTimers();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
    timerSource: timers.source,
  });
  return { store, conn, timers };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

/**
 * Feed an open bracket a real replay frame every 10 s until `totalMs`
 * has passed since the caller last advanced — a healthy slow replay, and
 * the shape the cap has to end anyway. The step is well inside
 * `REPLAY_SILENCE_DEADLINE_MS`, so the silence timer is restarted every
 * time and never gets to fire.
 */
function feedBracket(
  conn: TestFrameChannel,
  timers: FakeTimers,
  totalMs: number,
): void {
  const step = 10_000;
  let elapsed = 0;
  let n = 0;
  while (elapsed < totalMs) {
    const chunk = Math.min(step, totalMs - elapsed);
    timers.advance(chunk);
    elapsed += chunk;
    emit(conn, {
      type: "add_user_message",
      text: `turn ${n++}`,
      ipc_version: IPC_VERSION,
    });
  }
}

const replayStarted = () => ({
  type: "replay_started",
  ipc_version: IPC_VERSION,
});
const replayComplete = (count: number) => ({
  type: "replay_complete",
  count,
  ipc_version: IPC_VERSION,
});
const apiRetry = (attempt: number) => ({
  type: "api_retry",
  attempt,
  message: "Connection error, retrying",
  ipc_version: IPC_VERSION,
});
const replayBatch = (frames: ReadonlyArray<Record<string, unknown>>) => ({
  type: "replay_batch",
  frames,
  ipc_version: IPC_VERSION,
});

describe("replay bracket — the absolute cap", () => {
  it("a bracket fed forever still ends at REPLAY_BRACKET_DEADLINE_MS", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());

    // Real replay frames, right up to the last millisecond before the
    // cap. Every one of them restarts the silence deadline, so that
    // deadline never expires — this bracket is being fed, not stalled.
    feedBracket(conn, timers, REPLAY_BRACKET_DEADLINE_MS - 1);
    expect(store.getSnapshot().phase).toBe("replaying");
    expect(store.getSnapshot().lastError).toBeNull();

    // The cap does not care, and it lands on the millisecond: it has
    // been running since `replay_started` and nothing moved it.
    timers.advance(1);
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.lastError?.cause).toBe("replay_bracket_timeout");
    expect(snap.lastError?.message).toBe(REPLAY_BRACKET_MESSAGE);
    // Nothing is left running on the abandoned bracket.
    expect(timers.pendingCount()).toBe(0);
  });

  it("does not fire once the bracket has closed", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    emit(conn, replayComplete(3));
    expect(timers.pendingCount()).toBe(0);
    timers.advance(REPLAY_BRACKET_DEADLINE_MS * 2);
    expect(store.getSnapshot().phase).toBe("idle");
    expect(store.getSnapshot().lastError).toBeNull();
  });

  it("a fresh bracket gets a fresh cap", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    timers.advance(5_000);
    emit(conn, replayComplete(1));
    // The second window's cap starts now: cancelled on the way out of
    // the first bracket, scheduled again on the way into this one.
    emit(conn, replayStarted());
    feedBracket(conn, timers, REPLAY_BRACKET_DEADLINE_MS - 1);
    expect(store.getSnapshot().phase).toBe("replaying");
    timers.advance(1);
    expect(store.getSnapshot().lastError?.cause).toBe("replay_bracket_timeout");
  });
});

describe("replay bracket — only bracket frames buy silence time", () => {
  it("a bracket fed nothing but api_retry ends at the silence deadline", () => {
    // The reported hang, run forward. `api_retry` arrives well inside
    // the 15 s window, as a claude retrying a dead API does, and the
    // card gives up anyway.
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    for (let i = 0; i < 3; i += 1) {
      timers.advance(4_000);
      emit(conn, apiRetry(i + 1));
    }
    // 12 s of `api_retry` chatter has bought nothing.
    expect(store.getSnapshot().phase).toBe("replaying");
    timers.advance(REPLAY_SILENCE_DEADLINE_MS - 12_000);
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.lastError?.cause).toBe("replay_stalled");
    expect(snap.lastError?.message).toBe(REPLAY_STALLED_MESSAGE);
    // The retry itself still landed on the snapshot — the frame is not
    // ignored, only disqualified from buying the bracket time.
    expect(snap.apiRetry).not.toBeNull();
  });

  it("a replay_batch does re-arm it, so a healthy slow replay survives", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    // Six half-deadlines: 45 s in total, never 15 s of bracket silence.
    for (let i = 0; i < 6; i += 1) {
      timers.advance(REPLAY_SILENCE_DEADLINE_MS / 2);
      emit(
        conn,
        replayBatch([
          { type: "add_user_message", text: `turn ${i}` },
          { type: "turn_complete", msg_id: `m${i}`, seq: i, result: "" },
        ]),
      );
      expect(store.getSnapshot().phase).toBe("replaying");
      expect(store.getSnapshot().lastError).toBeNull();
    }
    // …and then the batches stop.
    timers.advance(REPLAY_SILENCE_DEADLINE_MS);
    expect(store.getSnapshot().lastError?.cause).toBe("replay_stalled");
  });

  it("chatter interleaved with real progress does not mask a stall", () => {
    // The mixed case, which is the realistic one: the replay is genuinely
    // progressing *and* the claude is retrying. The bracket frames buy
    // time; when they stop, the retries alone cannot keep it open.
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    timers.advance(10_000);
    emit(conn, {
      type: "add_user_message",
      text: "turn 0",
      ipc_version: IPC_VERSION,
    });
    // Four retries over 12 s, all inside the window the real frame
    // opened at t=10 s. None of them moves its deadline.
    for (let i = 0; i < 4; i += 1) {
      timers.advance(3_000);
      emit(conn, apiRetry(i + 1));
    }
    expect(store.getSnapshot().phase).toBe("replaying");
    timers.advance(3_000);
    expect(store.getSnapshot().lastError?.cause).toBe("replay_stalled");
  });
});

describe("replay bracket — closing cancels both deadlines", () => {
  it("replay_complete cancels the silence timer and the cap", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    // soft_budget + replay_silence + replay_bracket.
    expect(timers.pendingCount()).toBe(3);
    emit(conn, replayComplete(2));
    expect(timers.pendingCount()).toBe(0);
    expect(store.getSnapshot().phase).toBe("idle");
  });

  it("a second replay_complete is dropped and schedules nothing", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    emit(conn, replayComplete(2));
    const settled = store.getSnapshot();
    emit(conn, replayComplete(2));
    expect(timers.pendingCount()).toBe(0);
    expect(store.getSnapshot().phase).toBe("idle");
    expect(store.getSnapshot().lastError).toBeNull();
    // The dropped frame changed nothing observable.
    expect(store.getSnapshot().lastReplayResult).toEqual(
      settled.lastReplayResult,
    );
  });

  it("the silence deadline firing takes the cap down with it", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    timers.advance(REPLAY_SILENCE_DEADLINE_MS);
    expect(store.getSnapshot().lastError?.cause).toBe("replay_stalled");
    // Leaving `replaying` cancels the cap, so the later deadline cannot
    // overwrite the cause the card already reported.
    expect(timers.pendingCount()).toBe(0);
    timers.advance(REPLAY_BRACKET_DEADLINE_MS);
    expect(store.getSnapshot().lastError?.cause).toBe("replay_stalled");
  });
});

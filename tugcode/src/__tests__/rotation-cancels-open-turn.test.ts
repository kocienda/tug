/**
 * rotation-cancels-open-turn — retiring a claude ends its open turn as a
 * cancel, never as an error.
 *
 * `newSession` kills the current claude and spawns a fresh one. The drain on
 * the retiring process then observes EOF, and `signalEofToActiveTurn` picks
 * between two frames by one flag: `turn_cancelled` for a turn somebody
 * interrupted, `error "Claude process stream ended unexpectedly"` for any
 * other turn that never got its `result`. The deck maps that `error` to the
 * "Protocol error" banner — the banner a rotation must never raise, because
 * a rotation is the wheel's deliberate act and the turn it retires was not
 * lost. `forceTerminateAndRespawn` has always set the flag before its kill;
 * `newSession` did not, so a rotation landing over an open turn produced the
 * banner by construction.
 *
 * The drain runs for real here: the fake claude's stdout is a stream the
 * kill closes, so the EOF the assertions read is the one the production
 * drain loop observes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager, ActiveTurn } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";
import type { SessionStageSpec } from "../types.ts";

const SID = "55555555-5555-5555-5555-555555555555";
const FAKE_CLAUDE = "/usr/local/bin/claude-under-test";

const realWhich = Bun.which;
const realSpawn = Bun.spawn;
const realWrite = Bun.write;

/** Every JSON line written to stdout since the last reset, in write order. */
let emitted: any[] = [];

/**
 * A claude whose stdout is a live stream. `kill()` and `stdin.end()` close
 * it, which is what drives the drain to its EOF `finally`.
 */
function fakeProcess(): any {
  let close: () => void = () => {};
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
  });
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((res) => {
    resolveExit = res;
  });
  const die = () => {
    close();
    resolveExit(0);
  };
  return {
    stdin: { write: () => {}, flush: () => {}, end: () => die() },
    stdout,
    exited,
    kill: () => die(),
    pid: 5555,
  };
}

beforeEach(() => {
  emitted = [];
  (Bun as unknown as { which: unknown }).which = (cmd: string) =>
    cmd === "claude" ? FAKE_CLAUDE : null;
  (Bun as unknown as { spawn: unknown }).spawn = () => fakeProcess();
  const decoder = new TextDecoder();
  (Bun as any).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      const text =
        typeof data === "string"
          ? data
          : data instanceof Uint8Array
            ? decoder.decode(data)
            : "";
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          emitted.push(JSON.parse(trimmed));
        } catch {
          // non-JSON lines are not IPC
        }
      }
    }
    return Promise.resolve(0);
  };
});

afterEach(() => {
  (Bun as unknown as { which: unknown }).which = realWhich;
  (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
  (Bun as any).write = realWrite;
});

/** A manager with a live claude and its real drain running. */
function manager(): any {
  const m = new SessionManager(
    "/tmp/tugcode-rotation-cancel-" + SID,
    SID,
    "new",
    undefined,
    { sessionsDbPath: null },
  ) as any;
  m.claudeCodeVersion = "2.1.195";
  m.claudeProcess = fakeProcess();
  m.startStdoutDrain(m.claudeProcess);
  return m;
}

/** Install an open turn that has streamed some text and never got its result. */
function openTurn(m: any): ActiveTurn {
  const turn = new ActiveTurn(7, [{ type: "text", text: "hello" }] as any);
  turn.currentMessageId = "msg_abc";
  m.activeTurn = turn;
  return turn;
}

const STAGE: SessionStageSpec = {
  name: "audit",
  document: ".tug/arcs/protocol-hardening/tasks.md",
  arc: "protocol-hardening",
};

describe("a rotation over an open turn", () => {
  test("ends the retiring turn as a recovery cancel, never an error", async () => {
    const m = manager();
    const turn = openTurn(m);

    await m.handleSessionCommand("new", STAGE);
    await drainPendingWrites();

    expect(turn.interrupted).toBe(true);
    expect(turn.interruptCause).toBe("recovery");

    const cancels = emitted.filter((e) => e?.type === "turn_cancelled");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].is_recovery).toBe(true);
    expect(cancels[0].msg_id).toBe("msg_abc");
    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
  });

  test("a user cancel already in flight keeps its own cause", async () => {
    const m = manager();
    const turn = openTurn(m);
    turn.interrupted = true;
    turn.interruptCause = "user";

    await m.handleSessionCommand("new", STAGE);
    await drainPendingWrites();

    // First writer wins: the rotation does not relabel the user's cancel as
    // a recovery, so the deck still reads it as the user taking the card back.
    expect(turn.interruptCause).toBe("user");
    const cancels = emitted.filter((e) => e?.type === "turn_cancelled");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].is_recovery).toBeUndefined();
    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
  });

  test("a plain /new is the same deliberate act, and raises no banner either", async () => {
    const m = manager();
    openTurn(m);

    await m.handleSessionCommand("new");
    await drainPendingWrites();

    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
    expect(emitted.filter((e) => e?.type === "turn_cancelled")).toHaveLength(1);
  });

  test("a rotation with no open turn emits neither frame", async () => {
    const m = manager();

    await m.handleSessionCommand("new", STAGE);
    await drainPendingWrites();

    expect(emitted.filter((e) => e?.type === "error")).toEqual([]);
    expect(emitted.filter((e) => e?.type === "turn_cancelled")).toEqual([]);
  });
});

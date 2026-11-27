/**
 * spawn-clears-shutting-down — a fresh claude is never born "shutting down".
 *
 * `killAndCleanup` latches `isShuttingDown` so the teardown it runs is read as
 * ours: the early-exit watcher returns early on it, and the EOF logs carry it
 * as `self_inflicted`. The flag is a fact about the process being torn down,
 * so it has to be false again for the one spawned after it — otherwise a real
 * crash of the new claude is logged as one tugcode asked for and the watcher
 * ignores it. Every respawn path is checked here: an effort respawn, a `/new`,
 * a fork and a continue, each followed by an unasked death of the fresh
 * process over an open turn.
 *
 * The drain runs for real: the fake claude's stdout is a stream its death
 * closes, so the EOF the assertions read is the one production reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager, ActiveTurn } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";

const SID = "77777777-7777-7777-7777-777777777777";
const FAKE_CLAUDE = "/usr/local/bin/claude-under-test";

const realWhich = Bun.which;
const realSpawn = Bun.spawn;
const realWrite = Bun.write;
const realLog = console.log;

/** Every JSON line written to stdout since the last reset, in write order. */
let emitted: any[] = [];
/** Every console line since the last reset. */
let logged: string[] = [];

/** A claude whose stdout is a live stream that `kill()` / `stdin.end()` close. */
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
    pid: 7777,
  };
}

beforeEach(() => {
  emitted = [];
  logged = [];
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
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  (Bun as unknown as { which: unknown }).which = realWhich;
  (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
  (Bun as any).write = realWrite;
  console.log = realLog;
});

/** A manager with a live claude and its real drain running. */
function manager(): any {
  const m = new SessionManager(
    "/tmp/tugcode-spawn-clears-" + SID,
    SID,
    "new",
    undefined,
    { sessionsDbPath: null },
  ) as any;
  m.claudeCodeVersion = "2.1.195";
  // Made-up pid: keep the group signal off the OS ("gone" signals the child).
  m.claude.signalProcessGroup = () => "gone";
  m.claudeProcess = fakeProcess();
  m.startStdoutDrain(m.claudeProcess);
  return m;
}

/** Wait out every respawn queued on the manager. */
async function respawnsSettled(m: any): Promise<void> {
  while (m.respawnGate !== null) await m.respawnGate;
  await drainPendingWrites();
}

/**
 * Open a turn on the live claude and let that claude die without being asked,
 * as a crash would; resolve once its drain has observed the EOF.
 */
async function unaskedDeathOverOpenTurn(m: any): Promise<void> {
  const turn = new ActiveTurn(9, [{ type: "text", text: "go" }] as any);
  turn.currentMessageId = "msg_crash";
  m.activeTurn = turn;
  // A turn is open, so claude was handed its message: a death now is a
  // runtime crash, which the early-exit watcher leaves to the EOF path.
  m.claudeReceivedInput = true;
  m.claudeProcess.kill();
  await m.claude.stdoutDrainTask;
  await drainPendingWrites();
}

/** The `self_inflicted` field of the open-turn EOF line, as logged. */
function eofSelfInflicted(): string[] {
  return logged
    .filter((l) => l.includes("event=tugcode.claude_stdout_eof_open_turn"))
    .map((l) => /self_inflicted=(\S+)/.exec(l)?.[1] ?? "?");
}

const RESPAWNS: Array<[string, (m: any) => Promise<void>]> = [
  ["an effort respawn", (m) => m.handleEffortChange("medium")],
  ["a /new", (m) => m.handleSessionCommand("new")],
  ["a fork", (m) => m.handleSessionCommand("fork")],
  ["a continue", (m) => m.handleSessionCommand("continue")],
];

describe("after a respawn, a later crash is not ours", () => {
  for (const [name, respawn] of RESPAWNS) {
    test(`${name} leaves the fresh claude armed`, async () => {
      const m = manager();
      await respawn(m);
      await respawnsSettled(m);

      // The flag the early-exit watcher returns early on is down.
      expect(m.isShuttingDown).toBe(false);

      await unaskedDeathOverOpenTurn(m);

      expect(eofSelfInflicted()).toEqual(["false"]);
      const errors = emitted.filter((e) => e?.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].site).toBe("drain_eof_open_turn");
    });
  }

  test("the teardown itself still reads as ours", async () => {
    const m = manager();
    // `shutdown` tears down with nothing spawned after it.
    await m.killAndCleanup("shutdown");
    expect(m.isShuttingDown).toBe(true);
  });
});

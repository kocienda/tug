// tugcode/src/__tests__/respawn-timers.test.ts
//
// A respawn inherits no timer from the process it replaced ([B04]). Every
// process-bound timer lives in the manager's one `TimerSet`, and
// `killAndCleanup` clears it, so a wedge recovery that fires with all four
// armed comes back with only the timer its own fresh spawn armed.

import { ClaudeHome } from "../claude-home.ts";
import { describe, expect, test } from "bun:test";

import { drainPendingWrites } from "../ipc.ts";
import { ActiveTurn, SessionManager } from "../session.ts";
import { fakeSpawner } from "./fake-spawner.ts";

/** A claude that exits on stdin EOF or on any signal. */
function politeChild(pid: number) {
  let exit: ((code: number) => void) | null = null;
  const closed = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  return {
    stdout: closed(),
    stderr: closed(),
    stdin: { write: () => {}, end: () => exit?.(0), flush: () => {} },
    exited: new Promise<number>((r) => {
      exit = r;
    }),
    exitCode: null,
    kill: () => exit?.(0),
    pid,
  };
}

/** Swallow IPC stdout writes while `fn` runs. */
async function quietIpc(fn: () => Promise<void>): Promise<void> {
  const originalWrite = Bun.write;
  (Bun as unknown as { write: unknown }).write = (dest: unknown, data: unknown) =>
    dest === Bun.stdout
      ? Promise.resolve(data instanceof Uint8Array ? data.length : String(data).length)
      : originalWrite(dest as never, data as never);
  try {
    await fn();
    await drainPendingWrites();
  } finally {
    (Bun as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
}

describe("respawn timers", () => {
  test("a wedge recovery clears every timer the old process armed, and the respawn arms only its own", async () => {
    const manager = new SessionManager(
      `/tmp/respawn-timers-${Date.now()}`,
      crypto.randomUUID(),
      "resume",
      undefined,
      {
        claudeHome: ClaudeHome.at("/tmp/respawn-timers-fixtures"),
        sessionsDbPath: null,
        spawner: fakeSpawner(() => politeChild(5151)),
      },
    );
    // Private seams: the process-bound timers are armed by turn events and
    // the spawn path, and this test arms each one directly.
    const m = manager as unknown as {
      claudeProcess: unknown;
      activeTurn: ActiveTurn | null;
      claude: { signalProcessGroup: (pid: number, signal: string) => string };
      timers: {
        keys(): string[];
        clearAll(): void;
        setTimeout(...args: unknown[]): void;
      };
      ensureActivityFlush(): void;
      armInterruptEscalation(turn: ActiveTurn): void;
      armResultWatchdog(turn: ActiveTurn): void;
      sendInitializeHandshake(): void;
      forceTerminateAndRespawn(reason: string): Promise<void>;
    };
    // "gone": the ladder then signals the child itself, and no signal ever
    // reaches a real process group.
    m.claude.signalProcessGroup = () => "gone";
    m.claudeProcess = politeChild(4242);
    const turn = new ActiveTurn(0, []);
    m.activeTurn = turn;

    m.ensureActivityFlush();
    m.armInterruptEscalation(turn);
    m.armResultWatchdog(turn);
    m.sendInitializeHandshake();
    expect(m.timers.keys().sort()).toEqual([
      "activity-flush",
      "interrupt-escalation",
      "result-watchdog",
      "resume-handshake",
    ]);

    // Record what the teardown cleared and what was armed after it.
    const events: string[] = [];
    const clearAll = m.timers.clearAll.bind(m.timers);
    m.timers.clearAll = () => {
      events.push(`clearAll:${m.timers.keys().sort().join(",")}`);
      clearAll();
    };
    const arm = m.timers.setTimeout.bind(m.timers);
    m.timers.setTimeout = (...args: unknown[]) => {
      events.push(`arm:${String(args[0])}`);
      arm(...args);
    };

    await quietIpc(() => m.forceTerminateAndRespawn("result_timeout"));

    expect(events).toEqual([
      "clearAll:activity-flush,interrupt-escalation,result-watchdog,resume-handshake",
      "arm:resume-handshake",
    ]);
    expect(m.timers.keys()).toEqual(["resume-handshake"]);

    m.timers.clearAll();
  });
});

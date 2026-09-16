// tugcode/src/__tests__/stop-all-work.test.ts
//
// `stop_all_work` ([P04], Spec S02): end every piece of the session's work —
// its tasks, its scheduled wakes, its process group — respawn `--resume`, and
// answer `stop_all_work_done`. The answer is the frame tugcast's quiet wait
// turns on ([P12]), so it is pinned here on its own rather than only seen
// through the app-test chain.
//
// The process-group signal is stubbed at `signalProcessGroup`, the one seam
// that spells `kill(-pid, …)`: a test that let it reach the OS with a made-up
// pid would be signalling somebody else's process group.

import { describe, expect, test } from "bun:test";

import { drainPendingWrites } from "../ipc.ts";
import { ActiveTurn, SessionManager } from "../session.ts";
import type { OutboundMessage } from "../types.ts";

interface MockChild {
  child: {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    stdin: { write: () => void; end: () => void; flush: () => void };
    exited: Promise<number>;
    kill: (signal?: number | string) => void;
    pid: number;
  };
  exit: (code: number) => void;
}

/**
 * A *polite* claude: its stdin EOF is enough to end it, which is the path
 * every `stop_all_work` takes — and the path on which the signal ladder never
 * runs, so the post-exit sweep is the only thing that reaches the group.
 */
function politeClaudeChild(pid: number): MockChild {
  let exitResolve: ((code: number) => void) | null = null;
  const closed = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  const child = {
    stdout: closed(),
    stderr: closed(),
    stdin: {
      write: () => {},
      end: () => exitResolve?.(0),
      flush: () => {},
    },
    exited: new Promise<number>((r) => {
      exitResolve = r;
    }),
    kill: () => exitResolve?.(0),
    pid,
  };
  return { child, exit: (code: number) => exitResolve?.(code) };
}

/** Capture every `writeLine` frame; stub `process.exit`. */
async function captureIpc(
  fn: () => Promise<void>,
): Promise<OutboundMessage[]> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Bun as any).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      const text =
        typeof data === "string"
          ? data
          : data instanceof Uint8Array
            ? decoder.decode(data)
            : "";
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.length > 0) {
          try {
            captured.push(JSON.parse(t) as OutboundMessage);
          } catch {
            // ignore non-JSON
          }
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  };
  const originalExit = process.exit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = () => {};
  try {
    await fn();
    await drainPendingWrites();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bun as any).write = originalWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = originalExit;
  }
  return captured;
}

function makeManager(): {
  manager: SessionManager;
  sessionId: string;
  spawns: Array<{ id: string | null; mode: string }>;
  groupSignals: Array<{ pid: number; signal: string }>;
  stoppedTasks: string[];
} {
  const sessionId = crypto.randomUUID();
  const projectDir = `/tmp/stop-all-work-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const manager = new SessionManager(projectDir, sessionId, "resume", undefined, {
    claudeProjectsRoot: "/tmp/stop-all-work-fixtures",
    jsonlReader: async () => ({ kind: "ok" as const, jsonl: "" }),
  });
  const spawns: Array<{ id: string | null; mode: string }> = [];
  const groupSignals: Array<{ pid: number; signal: string }> = [];
  const stoppedTasks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = manager as any;
  m.spawnClaude = (id: string | null, mode: string) => {
    spawns.push({ id, mode });
    return politeClaudeChild(5151).child;
  };
  m.signalProcessGroup = (pid: number, signal: string) => {
    groupSignals.push({ pid, signal });
    return "sent";
  };
  m.handleStopTask = (taskId: string) => {
    stoppedTasks.push(taskId);
  };
  // The respawn's handshake, acked: what the answer waits on.
  m.awaitSpawnReady = () => Promise.resolve();
  return { manager, sessionId, spawns, groupSignals, stoppedTasks };
}

describe("handleStopAllWork", () => {
  test("a_stop_all_work_answers_done", async () => {
    const { manager, sessionId, spawns, groupSignals, stoppedTasks } =
      makeManager();
    const handle = politeClaudeChild(4242);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = manager as any;
    m.claudeProcess = handle.child;
    const turn = new ActiveTurn(0, []);
    m.activeTurn = turn;
    m.pendingScheduledTriggers = [
      { toolUseId: "t1", kind: "wakeup", label: "watching CI" },
      { toolUseId: "t2", kind: "cron", label: "nightly" },
    ];

    const emitted = await captureIpc(async () => {
      await manager.handleStopAllWork(["task-a", "task-b"]);
    });

    // Rung 1: every id tugcast named got its best-effort stop_task.
    expect(stoppedTasks).toEqual(["task-a", "task-b"]);
    // Rung 2: both kinds of scheduled trigger are gone.
    expect(m.pendingScheduledTriggers).toEqual([]);
    // Rung 3: the polite exit never ran the ladder, and the sweep still
    // reached the group claude led.
    expect(groupSignals).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
    // The in-flight turn was flagged so the drain's EOF closed it as a
    // cancel, not an error — and closed it: the manager holds no turn now.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((turn as any).interrupted).toBe(true);
    expect(m.activeTurn).toBeNull();
    // Then the respawn: `--resume`, the card stays bound.
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.mode).toBe("resume");
    expect(emitted.some((e) => e.type === "session_init")).toBe(true);
    // Rung 4: the answer names the session — the frame [P12] turns on.
    const done = emitted.find((e) => e.type === "stop_all_work_done");
    expect(done).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((done as any).tug_session_id).toBe(sessionId);
    // And the latch is released for the next teardown.
    expect(m.forceTerminateInProgress).toBe(false);
  });

  test("a stop racing a wedge recovery answers done without a second respawn", async () => {
    const { manager, sessionId, spawns } = makeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = manager as any;
    m.claudeProcess = politeClaudeChild(4242).child;
    m.forceTerminateInProgress = true;

    const emitted = await captureIpc(async () => {
      await manager.handleStopAllWork([]);
    });

    expect(spawns.length).toBe(0);
    const done = emitted.find((e) => e.type === "stop_all_work_done");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((done as any)?.tug_session_id).toBe(sessionId);
    // The recovery still owns the latch.
    expect(m.forceTerminateInProgress).toBe(true);
  });

  test("a teardown that throws still answers done", async () => {
    const { manager, sessionId } = makeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = manager as any;
    m.claudeProcess = politeClaudeChild(4242).child;
    m.respawnResume = () => {
      throw new Error("claude CLI not found");
    };

    let threw = false;
    const emitted = await captureIpc(async () => {
      try {
        await manager.handleStopAllWork([]);
      } catch {
        threw = true;
      }
    });

    expect(threw).toBe(true);
    const done = emitted.find((e) => e.type === "stop_all_work_done");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((done as any)?.tug_session_id).toBe(sessionId);
    expect(m.forceTerminateInProgress).toBe(false);
  });
});

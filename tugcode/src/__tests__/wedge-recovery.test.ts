// tugcode/src/__tests__/wedge-recovery.test.ts
//
// The 2026-07-22 commit-xp incident: a turn wedged after claude delivered its
// final assistant text but before the terminal `result`; the in-band interrupt
// couldn't reach the wedged process, and the follow-on exit was misclassified
// as `resume_failed`, which unbound the card and marked its (intact) session
// row failed.
//
// These tests pin the recovery contract:
//   - a post-handshake claude exit is a runtime crash (recoverable), never
//     `resume_failed`;
//   - a genuine pre-handshake resume exit is still `resume_failed`;
//   - `handleInterrupt` arms an escalation that a clean turn-close cancels;
//   - a terminal `stop_reason` with no `result` arms the liveness watchdog,
//     while a `tool_use` stop does not;
//   - `forceTerminateAndRespawn` closes the turn as cancelled and respawns
//     `--resume`, keeping the card bound.

import { describe, expect, test } from "bun:test";

import { drainPendingWrites } from "../ipc.ts";
import { ActiveTurn, SessionManager } from "../session.ts";
import type { OutboundMessage } from "../types.ts";

// ---------------------------------------------------------------------------
// Mock claude child whose kill() resolves `exited` (so the force-terminate
// signal ladder completes without a real process).
// ---------------------------------------------------------------------------

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

function mockClaudeChild(opts?: { stderr?: string[] }): MockChild {
  let exitResolve: ((code: number) => void) | null = null;
  const stderrLines = opts?.stderr ?? [];
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of stderrLines) controller.enqueue(enc.encode(l + "\n"));
      controller.close();
    },
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const child = {
    stdout,
    stderr,
    stdin: { write: () => {}, end: () => {}, flush: () => {} },
    exited: new Promise<number>((r) => {
      exitResolve = r;
    }),
    // A real kill terminates the process, which resolves `exited`; mirror
    // that so `killAndCleanup({ escalate })` doesn't hang awaiting exit.
    kill: () => exitResolve?.(0),
    pid: 4242,
  };
  return { child, exit: (code: number) => exitResolve?.(code) };
}

/** Capture every `writeLine`/`writeLineAndExit` frame; stub `process.exit`. */
async function captureIpc(
  fn: () => Promise<void>,
): Promise<{ emitted: OutboundMessage[]; exitCode: number | undefined }> {
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
  let exitCode: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    exitCode = code;
  };
  try {
    await fn();
    // `writeLine` is fire-and-forget: it chains the real `Bun.write` onto a
    // serialized tail, so frames emitted by `fn` land a microtask later. Without
    // this drain the restore below can win the race, sending those frames to the
    // real stdout instead of `captured` — the assertion then sees nothing.
    await drainPendingWrites();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bun as any).write = originalWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = originalExit;
  }
  return { emitted: captured, exitCode };
}

/** A resume-mode manager with a stubbed spawn; `spawns` records every spawn. */
function makeManager(): {
  manager: SessionManager;
  spawns: Array<{ id: string | null; mode: string }>;
  nextChild: () => MockChild;
  currentChild: () => MockChild;
} {
  const sessionId = crypto.randomUUID();
  const projectDir = `/tmp/wedge-recovery-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const manager = new SessionManager(projectDir, sessionId, "resume", undefined, {
    claudeProjectsRoot: "/tmp/wedge-recovery-fixtures",
    jsonlReader: async () => ({ kind: "ok" as const, jsonl: "" }),
  });
  const spawns: Array<{ id: string | null; mode: string }> = [];
  let child = mockClaudeChild();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).spawnClaude = (id: string | null, mode: string) => {
    spawns.push({ id, mode });
    child = mockClaudeChild();
    return child.child;
  };
  return {
    manager,
    spawns,
    nextChild: () => child,
    currentChild: () => child,
  };
}

// ---------------------------------------------------------------------------
// Defect 2 — exit-watcher classification
// ---------------------------------------------------------------------------

describe("exit-watcher classification", () => {
  test("a post-handshake claude exit is a recoverable crash, never resume_failed", async () => {
    const { manager } = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // The handshake acked — claude proved it launched and opened its JSONL.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).initializeHandshakeAcked = true;

    const { emitted } = await captureIpc(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).installEarlyExitWatcher();
      handle.exit(0);
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(emitted.some((e) => e.type === "resume_failed")).toBe(false);
    const err = emitted.find((e) => e.type === "error");
    expect(err).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((err as any).recoverable).toBe(true);
  });

  test("a pre-handshake resume exit with no stderr is still resume_failed", async () => {
    const { manager } = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // Handshake never acked (default false) → genuine init-time failure.

    const { emitted } = await captureIpc(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).installEarlyExitWatcher();
      handle.exit(0);
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(emitted.some((e) => e.type === "resume_failed")).toBe(true);
  });

  test("a definitive stderr signature still yields resume_failed even post-handshake", async () => {
    const { manager } = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).initializeHandshakeAcked = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeStderrClassification = "collision";

    const { emitted } = await captureIpc(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).installEarlyExitWatcher();
      handle.exit(1);
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(emitted.some((e) => e.type === "resume_failed")).toBe(true);
  });

  test("the watcher never fires for a superseded process (teardown/respawn)", async () => {
    const { manager } = makeManager();
    const oldChild = mockClaudeChild();
    const newChild = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = oldChild.child;

    const { emitted } = await captureIpc(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).installEarlyExitWatcher();
      // A respawn swapped the live handle before the old exit landed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).claudeProcess = newChild.child;
      oldChild.exit(0);
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(emitted.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Defect 1 — cancel escalation ladder (arming)
// ---------------------------------------------------------------------------

describe("cancel escalation arming", () => {
  test("handleInterrupt arms an escalation that a clean turn-close cancels", async () => {
    const { manager } = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    const turn = new ActiveTurn(0, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).activeTurn = turn;

    manager.handleInterrupt();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).interruptEscalationTimer).not.toBeNull();

    // The turn completes cleanly (claude acked the interrupt) → timer cleared.
    turn.finish();
    await new Promise((r) => setTimeout(r, 0));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).interruptEscalationTimer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Defect 5 — result-liveness watchdog (arming)
// ---------------------------------------------------------------------------

describe("result-liveness watchdog arming", () => {
  function dispatchStreamEvent(
    manager: SessionManager,
    turn: unknown,
    inner: Record<string, unknown>,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).dispatchEventToTurn(turn, {
      type: "stream_event",
      event: inner,
    });
  }

  test("a terminal stop_reason arms the watchdog; tool_use does not", async () => {
    const { manager } = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;

    await captureIpc(async () => {
      const turn = new ActiveTurn(0, []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).activeTurn = turn;

      // A tool_use stop is an iteration boundary — no watchdog.
      dispatchStreamEvent(manager, turn, {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: {},
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((manager as any).resultWatchdogTimer).toBeNull();

      // A terminal end_turn stop arms the watchdog (result must follow).
      dispatchStreamEvent(manager, turn, {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {},
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((manager as any).resultWatchdogTimer).not.toBeNull();
    });
  });

  test("the terminal `result` disarms the watchdog", async () => {
    const { manager } = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;

    await captureIpc(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const turn = new ActiveTurn(0, []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).activeTurn = turn;
      dispatchStreamEvent(manager, turn, {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {},
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((manager as any).resultWatchdogTimer).not.toBeNull();

      // Claude's terminal result lands.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).dispatchEventToTurn(turn, {
        type: "result",
        subtype: "success",
        result: "",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((manager as any).resultWatchdogTimer).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Defects 1 & 5 — the shared recovery primitive
// ---------------------------------------------------------------------------

describe("forceTerminateAndRespawn", () => {
  test("closes the turn as cancelled and respawns --resume, keeping the card bound", async () => {
    const { manager, spawns } = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const turn = new ActiveTurn(0, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).activeTurn = turn;

    const { emitted } = await captureIpc(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).forceTerminateAndRespawn("result_timeout");
    });

    // The wedged turn was flagged so the drain closes it as a cancel, not error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((turn as any).interrupted).toBe(true);
    // A fresh claude was spawned in resume mode — the card stays live.
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.mode).toBe("resume");
    // A synthetic session_init re-announces the (same) session to the card.
    expect(emitted.some((e) => e.type === "session_init")).toBe(true);
    // Recovery keeps the JSONL: it never emits resume_failed.
    expect(emitted.some((e) => e.type === "resume_failed")).toBe(false);
  });

  test("marks its cancel as a recovery, and a user's cancel is left unmarked", async () => {
    // Both paths set one flag — `ActiveTurn.interrupted` — and reach the same
    // emit site, so the frame is the only place the cause can be carried. A
    // consumer that read every cancel as the user taking their card back would
    // act on a session this recovery leaves alive and working.
    const recovery = makeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (recovery.manager as any).claudeProcess = mockClaudeChild().child;
    const wedged = new ActiveTurn(0, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (recovery.manager as any).activeTurn = wedged;
    const { emitted: afterRecovery } = await captureIpc(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (recovery.manager as any).forceTerminateAndRespawn("result_timeout");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (recovery.manager as any).activeTurn = wedged;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (recovery.manager as any).signalEofToActiveTurn();
    });
    expect(wedged.interruptCause).toBe("recovery");
    const recoveryCancel = afterRecovery.find((e) => e.type === "turn_cancelled");
    expect(recoveryCancel).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((recoveryCancel as any).is_recovery).toBe(true);

    const user = makeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (user.manager as any).claudeProcess = mockClaudeChild().child;
    const cancelled = new ActiveTurn(0, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (user.manager as any).activeTurn = cancelled;
    const { emitted: afterUser } = await captureIpc(async () => {
      user.manager.handleInterrupt();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (user.manager as any).signalEofToActiveTurn();
    });
    expect(cancelled.interruptCause).toBe("user");
    const userCancel = afterUser.find((e) => e.type === "turn_cancelled");
    expect(userCancel).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((userCancel as any).is_recovery).toBeUndefined();
  });

  test("an interrupt claude never acked stays the user's cancel through the escalation", async () => {
    // `interrupt_unacked` reaches the same force-terminate, but the gesture
    // that started it was the user's — tugcode only had to press harder.
    const { manager } = makeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = mockClaudeChild().child;
    const turn = new ActiveTurn(0, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).activeTurn = turn;

    const { emitted } = await captureIpc(async () => {
      manager.handleInterrupt();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).forceTerminateAndRespawn("interrupt_unacked");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).activeTurn = turn;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).signalEofToActiveTurn();
    });

    expect(turn.interruptCause).toBe("user");
    const cancel = emitted.find((e) => e.type === "turn_cancelled");
    expect(cancel).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((cancel as any).is_recovery).toBeUndefined();
  });

  test("is idempotent — a second call while in progress is a no-op", async () => {
    const { manager, spawns } = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;

    await captureIpc(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p1 = (manager as any).forceTerminateAndRespawn("interrupt_unacked");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p2 = (manager as any).forceTerminateAndRespawn("interrupt_unacked");
      await Promise.all([p1, p2]);
    });

    expect(spawns.length).toBe(1);
  });
});

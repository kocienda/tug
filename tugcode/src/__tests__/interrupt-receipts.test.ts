// tugcode/src/__tests__/interrupt-receipts.test.ts
//
// Every interrupt gets an answer.
//
// `handleInterrupt` has two early returns — no claude process, and no active
// turn — and both used to end in a bare `console.log`. The deck raises
// `interruptInFlight` the instant the user presses Stop and has no way to tell
// a working interrupt from one that reached a bridge with nothing to
// interrupt, so a silent early return stranded the card with no frame in the
// protocol able to settle it.
//
// These tests pin the receipts, and pin that the ordinary path still has none:
//   - no claude process → exactly one `interrupt_noop{reason:"no_process"}`;
//   - a live claude with no turn → `interrupt_noop{reason:"no_turn"}`, and no
//     escalation armed, because there is nothing to escalate against;
//   - a real interrupt on a live turn → no `interrupt_noop`, an escalation
//     armed, and exactly one `turn_cancelled` when that escalation fires.

import { describe, expect, test } from "bun:test";

import { drainPendingWrites } from "../ipc.ts";
import { ActiveTurn, SessionManager } from "../session.ts";
import type { OutboundMessage } from "../types.ts";

// ---------------------------------------------------------------------------
// Mock claude child whose kill() resolves `exited`, so a force-terminate
// completes without a real process. Same shape `wedge-recovery.test.ts` uses.
// ---------------------------------------------------------------------------

function mockClaudeChild() {
  let exitResolve: ((code: number) => void) | null = null;
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const writes: string[] = [];
  const child = {
    stdout,
    stderr,
    stdin: {
      write: (data: string) => {
        writes.push(data);
      },
      end: () => {},
      flush: () => {},
    },
    exited: new Promise<number>((r) => {
      exitResolve = r;
    }),
    kill: () => exitResolve?.(0),
    pid: 4242,
  };
  return { child, writes, exit: (code: number) => exitResolve?.(code) };
}

/** Capture every `writeLine` frame; stub `process.exit`. */
async function captureIpc(
  fn: () => Promise<void> | void,
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
    // `writeLine` is fire-and-forget — it chains the real `Bun.write` onto a
    // serialized tail, so frames land a microtask after `fn` returns.
    await drainPendingWrites();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bun as any).write = originalWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = originalExit;
  }
  return captured;
}

function makeManager(): SessionManager {
  const sessionId = crypto.randomUUID();
  const projectDir = `/tmp/interrupt-receipts-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const manager = new SessionManager(projectDir, sessionId, "resume", undefined, {
    claudeProjectsRoot: "/tmp/interrupt-receipts-fixtures",
    jsonlReader: async () => ({ kind: "ok" as const, jsonl: "" }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).spawnClaude = () => mockClaudeChild().child;
  return manager;
}

function noops(emitted: ReadonlyArray<OutboundMessage>) {
  return emitted.filter((e) => e.type === "interrupt_noop");
}

describe("interrupt receipts — no silent early return", () => {
  test("no claude process emits exactly one interrupt_noop{no_process}", async () => {
    const manager = makeManager();
    // `claudeProcess` is null by construction — nothing spawned.

    const emitted = await captureIpc(() => {
      manager.handleInterrupt();
    });

    const receipts = noops(emitted);
    expect(receipts).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((receipts[0] as any).reason).toBe("no_process");
    // The receipt names the session, so the supervisor can route it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (receipts[0] as any).tug_session_id).toBe("string");
    // Nothing else went out — no turn ended, because there was no turn.
    expect(emitted.some((e) => e.type === "turn_cancelled")).toBe(false);
    expect(emitted.some((e) => e.type === "turn_complete")).toBe(false);
  });

  test("a live claude with no turn emits interrupt_noop{no_turn} and arms nothing", async () => {
    const manager = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).activeTurn).toBeNull();

    const emitted = await captureIpc(() => {
      manager.handleInterrupt();
    });

    const receipts = noops(emitted);
    expect(receipts).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((receipts[0] as any).reason).toBe("no_turn");
    // The control request still reached stdin — harmless, and claude may act
    // on it — but no escalation is armed, because there is no turn to force.
    expect(handle.writes.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).interruptEscalationTimer).toBeNull();
  });

  test("a real interrupt on a live turn receipts nothing and arms the escalation", async () => {
    const manager = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    const turn = new ActiveTurn(0, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).activeTurn = turn;

    const emitted = await captureIpc(() => {
      manager.handleInterrupt();
    });

    // The ordinary path keeps its silence: a turn that can end needs no
    // receipt, because its ending is the receipt.
    expect(noops(emitted)).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).interruptEscalationTimer).not.toBeNull();
    expect(turn.interrupted).toBe(true);
    expect(turn.interruptCause).toBe("user");
  });

  test("when that escalation fires, exactly one turn_cancelled reaches the wire", async () => {
    const manager = makeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = mockClaudeChild().child;
    const turn = new ActiveTurn(0, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).activeTurn = turn;

    const emitted = await captureIpc(async () => {
      manager.handleInterrupt();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).forceTerminateAndRespawn("interrupt_unacked");
    });

    const cancels = emitted.filter((e) => e.type === "turn_cancelled");
    expect(cancels).toHaveLength(1);
    // One rung of the ladder, one ending: the force-terminate closes the turn
    // itself and clears `activeTurn`, so the drain's later EOF finds nothing
    // and writes nothing. That is what keeps the count at one.
    expect(noops(emitted)).toHaveLength(0);
    // The user started it; tugcode only had to press harder.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((cancels[0] as any).is_recovery).toBeUndefined();
  });
});

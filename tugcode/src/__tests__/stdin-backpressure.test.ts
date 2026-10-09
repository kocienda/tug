// stdin-backpressure — a wedged claude cannot swallow a user message forever.
//
// Bun's `FileSink.write` and `flush` return a byte count when the pipe took
// the bytes, and a promise when it is full — when claude has stopped reading
// its stdin. `handleUserMessage` used to drop both results on the floor, so a
// wedged claude was an unbounded buffer with no signal. Now the session reads
// `stdinBackpressured` while a write is pending, and a write still pending
// past its bound takes the path a stalled turn takes: force-terminate and
// resume a fresh claude, closing the turn as a recovery cancel.

import { ClaudeHome } from "../claude-home.ts";
import { describe, expect, test } from "bun:test";

import { drainPendingWrites } from "../ipc.ts";
import { SessionManager } from "../session.ts";
import type { OutboundMessage, UserMessage } from "../types.ts";

/** The write bound every test below narrows to. */
const TEST_TIMEOUT_MS = 25;

const closed = <T,>() =>
  new ReadableStream<T>({
    start(controller) {
      controller.close();
    },
  });

/**
 * A mock claude child whose stdin `write` returns what `writeResult` gives
 * back — a byte count for a pipe with room, a promise for a full one — and
 * whose kill resolves `exited`, so the force-terminate ladder completes.
 */
function mockClaudeChild(writeResult: (data: string) => number | Promise<number>) {
  let exitResolve: ((code: number) => void) | null = null;
  const writes: string[] = [];
  const child = {
    stdout: closed<Uint8Array>(),
    stderr: closed<Uint8Array>(),
    stdin: {
      write: (data: string) => {
        writes.push(data);
        return writeResult(data);
      },
      end: () => {},
      flush: () => 0,
    },
    exited: new Promise<number>((r) => {
      exitResolve = r;
    }),
    kill: () => exitResolve?.(0),
    pid: 4545,
  };
  return { child, writes };
}

/** Capture `writeLine` frames and lifecycle log lines while `fn` runs. */
async function capture(
  fn: () => Promise<void>,
): Promise<{ emitted: OutboundMessage[]; logs: string[] }> {
  const emitted: OutboundMessage[] = [];
  const logs: string[] = [];
  const originalWrite = Bun.write;
  const originalLog = console.log;
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
        const t = line.trim();
        if (t.length === 0) continue;
        try {
          emitted.push(JSON.parse(t) as OutboundMessage);
        } catch {
          // non-JSON lines are not frames
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
    await drainPendingWrites();
  } finally {
    (Bun as any).write = originalWrite;
    console.log = originalLog;
  }
  return { emitted, logs };
}

/** A manager seated on `child`, with spawns stubbed and recorded. */
function makeManager(child: ReturnType<typeof mockClaudeChild>["child"]) {
  const sessionId = crypto.randomUUID();
  const projectDir = `/tmp/stdin-backpressure-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const manager = new SessionManager(projectDir, sessionId, "resume", undefined, {
    claudeHome: ClaudeHome.at("/tmp/stdin-backpressure-fixtures"),
    jsonlReader: async () => ({ kind: "ok" as const, jsonl: "" }),
  });
  (manager as any).stdinWriteTimeoutMs = TEST_TIMEOUT_MS;
  (manager as any).claudeReadyPromise = Promise.resolve();
  (manager as any).claudeProcess = child;
  const spawns: Array<{ id: string | null; mode: string }> = [];
  (manager as any).spawnClaude = (id: string | null, mode: string) => {
    spawns.push({ id, mode });
    return mockClaudeChild(() => 0).child;
  };
  return { manager, spawns };
}

const submit = (): UserMessage => ({
  type: "user_message",
  content: [{ type: "text", text: "hello" }],
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("stdin backpressure", () => {
  test("a never-draining stdin flags the session, then recovers it as a stalled turn", async () => {
    const wedged = mockClaudeChild(() => new Promise<number>(() => {}));
    const { manager, spawns } = makeManager(wedged.child);

    const { emitted, logs } = await capture(async () => {
      void manager.handleUserMessage(submit());
      // Past the send-path gates to the write.
      await sleep(1);
      // The message reached the sink and is waiting on a full pipe.
      expect(wedged.writes).toHaveLength(1);
      expect(manager.stdinBackpressured).toBe(true);
      const turn = (manager as any).activeTurn;
      expect(turn).not.toBeNull();

      await sleep(TEST_TIMEOUT_MS * 6);

      // The bound ran out and the stalled-turn recovery took the session:
      // the turn is a recovery cancel and a fresh claude resumed under it.
      expect(turn.interrupted).toBe(true);
      expect(turn.interruptCause).toBe("recovery");
      expect(spawns).toEqual([{ id: expect.any(String), mode: "resume" }]);
      expect(manager.stdinBackpressured).toBe(false);
    });

    expect(logs.some((l) => l.includes("event=tugcode.stdin_backpressured"))).toBe(true);
    expect(logs.some((l) => l.includes("event=tugcode.stdin_write_timeout"))).toBe(true);
    expect(
      logs.some(
        (l) => l.includes("event=tugcode.force_terminate ") && l.includes("reason=stdin_write_timeout"),
      ),
    ).toBe(true);
    expect(emitted.some((e) => e.type === "session_init")).toBe(true);
  });

  test("a pipe that drains within the bound clears the flag and touches nothing", async () => {
    const slow = mockClaudeChild(
      (data) => new Promise<number>((r) => setTimeout(() => r(data.length), 5)),
    );
    const { manager, spawns } = makeManager(slow.child);

    const { logs } = await capture(async () => {
      void manager.handleUserMessage(submit());
      await sleep(1);
      expect(manager.stdinBackpressured).toBe(true);
      await sleep(TEST_TIMEOUT_MS * 6);
    });

    expect(manager.stdinBackpressured).toBe(false);
    expect(spawns).toEqual([]);
    expect((manager as any).activeTurn.interrupted).toBe(false);
    expect(logs.some((l) => l.includes("event=tugcode.stdin_write_timeout"))).toBe(false);
  });

  test("a write the pipe takes at once never raises the flag", async () => {
    const healthy = mockClaudeChild((data) => data.length);
    const { manager } = makeManager(healthy.child);

    const { logs } = await capture(async () => {
      void manager.handleUserMessage(submit());
      await sleep(1);
      expect(manager.stdinBackpressured).toBe(false);
    });

    expect(healthy.writes).toHaveLength(1);
    expect(logs.some((l) => l.includes("event=tugcode.stdin_backpressured"))).toBe(false);
  });
});

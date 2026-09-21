// send-path-horizon — a submit never waits forever for a claude to exist.
//
// `handleUserMessage` sits behind two gates before it may write a byte to
// claude's stdin: `claudeReadyPromise`, the cold-boot gate that holds a
// submit typed during the replay window until the background spawn has
// finished its synchronous setup; and `respawnGate`, held for the whole of
// a kill-and-reseat. Both were bare `await`s. Neither promise is guaranteed
// to settle — a spawn that throws before it resolves the gate, or a respawn
// whose `work()` never returns, leaves one of them pending for the life of
// the process — and a submit parked on a pending promise emits nothing at
// all. The deck raises the turn optimistically and then waits on a frame
// that is never coming.
//
// So each gate is raced against `SEND_HORIZON_MS`, and the expiry is a named
// `error` frame rather than silence: `send_ready_timeout` for the first,
// `send_respawn_timeout` for the second, so a reader of `tugcode.error_frame`
// can tell which wait ran out.
//
// **What is NOT bounded here** is claude's silence. `spawnClaudeAndWatch`'s
// docstring records why the 30 s spawn watchdog was removed — its proxy for
// "claude is hung" only flipped on user input, so it read as "user idle" and
// killed healthy sessions — and this step does not reintroduce it. These
// horizons cover two promises tugcode owns and can see the state of, and on
// expiry the claude process is not touched: the tests below assert exactly
// that, by checking the mock child took no writes.

import { describe, expect, test } from "bun:test";

import { drainPendingWrites } from "../ipc.ts";
import { SessionManager } from "../session.ts";
import type { OutboundMessage, UserMessage } from "../types.ts";

/** The horizon every test below narrows to, so an expiry costs milliseconds. */
const TEST_HORIZON_MS = 25;

/** A mock claude child that records everything written to its stdin. */
function mockClaudeChild() {
  const closed = <T,>() =>
    new ReadableStream<T>({
      start(controller) {
        controller.close();
      },
    });
  const writes: string[] = [];
  return {
    writes,
    child: {
      stdout: closed<Uint8Array>(),
      stderr: closed<Uint8Array>(),
      stdin: {
        write: (data: string) => {
          writes.push(data);
        },
        end: () => {},
        flush: () => {},
      },
      exited: new Promise<number>(() => {}),
      kill: () => {},
      pid: 4343,
    },
  };
}

/** Capture every `writeLine` frame written while `fn` runs. */
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
        if (t.length === 0) continue;
        try {
          captured.push(JSON.parse(t) as OutboundMessage);
        } catch {
          // non-JSON lines are not frames
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  };
  try {
    await fn();
    await drainPendingWrites();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bun as any).write = originalWrite;
  }
  return captured;
}

function makeManager(): SessionManager {
  const sessionId = crypto.randomUUID();
  const projectDir = `/tmp/send-path-horizon-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const manager = new SessionManager(projectDir, sessionId, "resume", undefined, {
    claudeProjectsRoot: "/tmp/send-path-horizon-fixtures",
    jsonlReader: async () => ({ kind: "ok" as const, jsonl: "" }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any).sendHorizonMs = TEST_HORIZON_MS;
  return manager;
}

const submit = (): UserMessage => ({
  type: "user_message",
  content: [{ type: "text", text: "are you there" }],
});

function errorsWithSite(
  emitted: ReadonlyArray<OutboundMessage>,
  site: string,
): OutboundMessage[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return emitted.filter((e) => e.type === "error" && (e as any).site === site);
}

describe("send-path horizon — the readiness gate", () => {
  test("a spawn that never happens ends the submit in send_ready_timeout", async () => {
    const manager = makeManager();
    const handle = mockClaudeChild();
    // A claude is seated, so the submit would have gone through were the
    // gate not still held — the timeout is the only thing stopping it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // The gate `prepareSession()` establishes, with the spawn that would
    // resolve it never arriving.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeReadyPromise = new Promise<void>(() => {});

    const started = Date.now();
    const emitted = await captureIpc(async () => {
      await manager.handleUserMessage(submit());
    });
    const elapsed = Date.now() - started;

    const frames = errorsWithSite(emitted, "send_ready_timeout");
    expect(frames).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((frames[0] as any).recoverable).toBe(true);
    // It ended on its own horizon, not on some ambient timeout further out.
    expect(elapsed).toBeLessThan(TEST_HORIZON_MS * 20);
    // And it gave up without touching claude: no stdin write, no turn.
    expect(handle.writes).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).activeTurn).toBeNull();
  });

  test("a gate that resolves in time emits nothing and lets the submit run", async () => {
    const manager = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeReadyPromise = Promise.resolve();

    const emitted = await captureIpc(() => {
      // Not awaited: the healthy path opens a turn and parks on the drain's
      // completion, which no mock child will ever supply. What this test is
      // about is what happens on the way there.
      void manager.handleUserMessage(submit());
      return new Promise<void>((r) => setTimeout(r, TEST_HORIZON_MS * 4));
    });

    expect(errorsWithSite(emitted, "send_ready_timeout")).toEqual([]);
    expect(errorsWithSite(emitted, "send_respawn_timeout")).toEqual([]);
    // The clean no-op is the point: the submit reached claude's stdin.
    expect(handle.writes.length).toBeGreaterThan(0);
  });
});

describe("send-path horizon — the respawn gate", () => {
  test("a respawn gate that never clears ends the submit in send_respawn_timeout", async () => {
    const manager = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // The readiness gate is satisfied, so this is the second wait alone.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeReadyPromise = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).respawnGate = new Promise<void>(() => {});

    const emitted = await captureIpc(async () => {
      await manager.handleUserMessage(submit());
    });

    const frames = errorsWithSite(emitted, "send_respawn_timeout");
    expect(frames).toHaveLength(1);
    // The two waits are distinguishable after the fact, which is the whole
    // reason they have separate slugs.
    expect(errorsWithSite(emitted, "send_ready_timeout")).toEqual([]);
    expect(handle.writes).toEqual([]);
  });

  test("a gate that keeps being replaced still ends at one horizon", async () => {
    // The shape a per-iteration timeout would miss: each pass sees a gate
    // that settles well inside the bound, so a fresh horizon per pass would
    // buy time forever. One deadline covers the loop.
    const manager = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeReadyPromise = Promise.resolve();

    let replacing = true;
    const replaceGate = (): void => {
      if (!replacing) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).respawnGate = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
          replaceGate();
        }, Math.floor(TEST_HORIZON_MS / 4));
      });
    };
    replaceGate();

    const started = Date.now();
    const emitted = await captureIpc(async () => {
      await manager.handleUserMessage(submit());
    });
    const elapsed = Date.now() - started;
    replacing = false;

    expect(errorsWithSite(emitted, "send_respawn_timeout")).toHaveLength(1);
    expect(elapsed).toBeLessThan(TEST_HORIZON_MS * 20);
    expect(handle.writes).toEqual([]);
  });

  test("a gate that clears inside the horizon lets the submit through", async () => {
    const manager = makeManager();
    const handle = mockClaudeChild();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeProcess = handle.child;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).claudeReadyPromise = Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).respawnGate = new Promise<void>((resolve) => {
      setTimeout(() => {
        // The real `respawn()` clears the field in its `finally` before it
        // releases; the loop reads the field, so the test must do both.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (manager as any).respawnGate = null;
        resolve();
      }, Math.floor(TEST_HORIZON_MS / 4));
    });

    const emitted = await captureIpc(() => {
      void manager.handleUserMessage(submit());
      return new Promise<void>((r) => setTimeout(r, TEST_HORIZON_MS * 4));
    });

    expect(errorsWithSite(emitted, "send_respawn_timeout")).toEqual([]);
    expect(handle.writes.length).toBeGreaterThan(0);
  });
});

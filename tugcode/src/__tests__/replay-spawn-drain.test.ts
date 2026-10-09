/**
 * Step R1e — active stdout drain.
 *
 * Tests targeting the drain task's contract:
 *
 *   1. Drain forwards `system:init` between turns (no active turn).
 *   2. handleUserMessage completes when drain dispatches `turn_complete`
 *      into the active turn.
 *   3. handleUserMessage handles claude EOF mid-turn by emitting
 *      `turn_cancelled` once (drain owns this branch post-R1e; pre-R1e
 *      it lived inside handleUserMessage's own loop).
 *   4. No active turn when claude emits between turns — drain handles
 *      inter-turn events without throwing.
 *
 * The drain takes ownership of claude's stdout reader at the spawn
 * boundary; tests inject a mock child whose stdout is a controllable
 * `ReadableStream` so the drain can read scripted bytes at-rate.
 *
 * Failure-first verified at the end of this file's checkpoint comment:
 * before R1e shipped, the drain was a no-op stub and these tests
 * failed with the diagnostic shapes documented inline.
 */

import { ClaudeHome } from "../claude-home.ts";
import { describe, expect, test } from "bun:test";

import {
  type JsonlReadResult,
  SessionManager,
} from "../session.ts";
import type { OutboundMessage } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock claude stdout backed by a ReadableStream we drive from inside
 * the test. `feed(line)` enqueues one JSON-line; `close()` ends the
 * stream (drain observes EOF). Encoding is a single chunk per call so
 * the drain's line-splitter sees one complete line at a time.
 */
interface MockClaudeStdout {
  stream: ReadableStream<Uint8Array>;
  feed(obj: unknown): void;
  close(): void;
}

function makeMockClaudeStdout(): MockClaudeStdout {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controllerRef = c;
    },
  });
  const enc = new TextEncoder();
  return {
    stream,
    feed(obj: unknown): void {
      if (controllerRef === null) {
        throw new Error("MockClaudeStdout: feed() called before stream start");
      }
      controllerRef.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
    },
    close(): void {
      if (controllerRef === null) {
        throw new Error("MockClaudeStdout: close() called before stream start");
      }
      controllerRef.close();
    },
  };
}

interface DrainTestRig {
  manager: SessionManager;
  stdout: MockClaudeStdout;
  emitted: OutboundMessage[];
  /**
   * The stdout mocks handed to every spawn after the first, newest last —
   * one per respawn the manager performed. Empty until something respawns.
   */
  respawns: MockClaudeStdout[];
  /**
   * Make the NEXT `spawnClaude` throw instead of returning a child, so a
   * test can drive the "nothing to reattach to" half of the recovery.
   */
  failNextSpawn(): void;
  /** Yield to microtasks so the drain task can read pending chunks. */
  flush(): Promise<void>;
  /** Restore Bun.write etc. */
  cleanup(): void;
}

/**
 * Build a SessionManager with the drain wired up to a controllable
 * mock stdout. Captures every IPC frame written via `writeLine`
 * (i.e., `Bun.write(Bun.stdout, ...)`) into `emitted` for assertion.
 *
 * The manager is in resume mode so the spawn-time `prepareSession`
 * synthesizes the `session_init`; tests don't need to care about
 * pre-spawn IPC for the drain-specific assertions and can `splice`
 * those out of `emitted` if they want a clean view.
 */
function makeDrainRig(opts?: {
  jsonlReader?: (path: string) => Promise<JsonlReadResult>;
}): DrainTestRig {
  const stdout = makeMockClaudeStdout();
  // One per child, never shared: `startStderrReader` locks the stream it is
  // given, so a respawn handed the retired child's stderr fails the whole
  // respawn with "ReadableStream is locked".
  const makeMockStderr = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });

  const sessionId = crypto.randomUUID();
  const projectDir = `/tmp/r1e-drain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const manager = new SessionManager(
    projectDir,
    sessionId,
    "resume",
    undefined,
    {
      claudeHome: ClaudeHome.at("/tmp/r1e-drain-fixtures"),
      jsonlReader:
        opts?.jsonlReader ??
        (async () => ({ kind: "missing" as const, message: "fixture" })),
      replayTimeoutMs: 10_000,
    },
  );

  // Inject the mock claude child. The drain calls `getReader()` on
  // `claudeProcess.stdout` itself — single-owner invariant.
  //
  // `exited` settles only once the manager ENDS the child (stdin EOF or a
  // signal), which is the honest shape: a claude nobody has torn down has
  // not exited, so the early-exit watcher stays quiet for the tests that
  // never tear one down — and `killAndCleanup` still returns promptly for
  // the one test that does, rather than waiting out its whole grace.
  const makeMockChild = (out: MockClaudeStdout) => {
    let markExited: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      markExited = resolve;
    });
    return {
      stdout: out.stream,
      stderr: makeMockStderr(),
      stdin: {
        write: () => {},
        end: () => markExited(0),
        flush: () => {},
      },
      exited,
      kill: () => markExited(0),
    };
  };

  const respawns: MockClaudeStdout[] = [];
  let spawned = 0;
  let failNext = false;
  (manager as any).spawnClaude = () => {
    if (failNext) {
      failNext = false;
      throw new Error("claude CLI not found (PATH or ~/.local/bin)");
    }
    if (spawned++ === 0) return makeMockChild(stdout);
    // Every respawn gets its own stdout, because the first one is closed by
    // the time anything respawns and a reused stream would EOF instantly.
    const next = makeMockClaudeStdout();
    respawns.push(next);
    return makeMockChild(next);
  };

  // Capture IPC output.
  const emitted: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as any).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      let text = "";
      if (typeof data === "string") text = data;
      else if (data instanceof Uint8Array) text = decoder.decode(data);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            emitted.push(JSON.parse(trimmed) as OutboundMessage);
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

  // Stub process.exit so tests don't kill the runner.
  const originalExit = process.exit;
  (process as any).exit = (_code?: number) => {};

  return {
    manager,
    stdout,
    emitted,
    respawns,
    failNextSpawn() {
      failNext = true;
    },
    async flush() {
      // Two microtask spins is enough to give the drain task a chance
      // to read whatever's been enqueued and call writeLine. The
      // drain awaits reader.read() then awaits writeLine's
      // Bun.write — both microtask boundaries.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    cleanup() {
      (Bun as any).write = originalWrite;
      (process as any).exit = originalExit;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Step R1e — runStdoutDrain inter-turn forwarding", () => {
  test("drain forwards claude's `system:init` to tugcast immediately, with no active turn", async () => {
    const rig = makeDrainRig();
    try {
      rig.manager.prepareSession();
      await rig.manager.runReplay();
      await rig.manager.spawnClaudeAndWatch();

      // No active turn — handleUserMessage hasn't been called.
      // Claude emits its real session_init line; the drain should
      // forward it as a `session_init` IPC frame to tugcast.
      rig.stdout.feed({ type: "system", subtype: "init", session_id: "claude-from-drain" });
      await rig.flush();

      // Filter to only session_init frames the drain emitted —
      // there will also be a synthetic one from prepareSession().
      const inits = rig.emitted.filter((e) => e.type === "session_init");
      expect(inits.length).toBeGreaterThanOrEqual(2);
      // The drain-forwarded one carries claude's id, distinct from
      // the synthetic prepareSession() init.
      const fromDrain = inits.find(
        (e) => (e as { session_id: string }).session_id === "claude-from-drain",
      );
      expect(fromDrain).toBeDefined();
    } finally {
      rig.cleanup();
    }
  });
});

describe("Step R1e — handleUserMessage completion via drain", () => {
  test("handleUserMessage resolves when drain dispatches turn_complete", async () => {
    const rig = makeDrainRig();
    try {
      rig.manager.prepareSession();
      await rig.manager.runReplay();
      await rig.manager.spawnClaudeAndWatch();

      // Kick off handleUserMessage; the drain will see the script
      // below and dispatch into its active turn.
      const turnPromise = rig.manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "hi" }],
      });

      // Give handleUserMessage a microtask so it can install the
      // ActiveTurn before the drain reads the next chunk.
      await rig.flush();

      // Script: a result event ends the turn.
      rig.stdout.feed({ type: "result", subtype: "success", result: "" });
      await rig.flush();

      // handleUserMessage should resolve now.
      await turnPromise;

      const turnCompletes = rig.emitted.filter(
        (e) => e.type === "turn_complete",
      );
      expect(turnCompletes.length).toBe(1);
    } finally {
      rig.cleanup();
    }
  });

  test("handleUserMessage emits exactly one turn_cancelled when claude EOFs mid-turn", async () => {
    const rig = makeDrainRig();
    try {
      rig.manager.prepareSession();
      await rig.manager.runReplay();
      await rig.manager.spawnClaudeAndWatch();

      const turnPromise = rig.manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "hi" }],
      });
      await rig.flush();

      // Mark the turn interrupted (the user pressed cancel) so the
      // EOF branch emits `turn_cancelled` rather than `error`.
      rig.manager.handleInterrupt();

      // Now claude's stdout closes mid-turn — no terminal `result`
      // arrives. Pre-R1e the EOF was caught in handleUserMessage's
      // pull-loop; post-R1e it's caught in the drain's EOF branch
      // (`signalEofToActiveTurn`). Either path must emit exactly
      // one `turn_cancelled` frame and resolve the awaiting turn.
      rig.stdout.close();
      await rig.flush();

      await turnPromise;

      const cancelled = rig.emitted.filter(
        (e) => e.type === "turn_cancelled",
      );
      expect(cancelled.length).toBe(1);
    } finally {
      rig.cleanup();
    }
  });
});

describe("Step R1e — drain robustness", () => {
  test("drain dispatches a non-init inter-turn event without throwing (no active turn)", async () => {
    const rig = makeDrainRig();
    try {
      rig.manager.prepareSession();
      await rig.manager.runReplay();
      await rig.manager.spawnClaudeAndWatch();

      // An arbitrary non-init line (currently the inter-turn
      // handler is permissive — drops anything that isn't
      // system:init). Behavior under test: the drain task survives
      // the line without throwing or exiting.
      rig.stdout.feed({ type: "some_unhandled_inter_turn_shape", foo: 1 });
      await rig.flush();

      // The drain task is still healthy: feeding a result-shaped
      // line in a follow-up turn must still complete a handleUserMessage.
      const turnPromise = rig.manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "hi" }],
      });
      await rig.flush();
      rig.stdout.feed({ type: "result", subtype: "success", result: "" });
      await rig.flush();
      await turnPromise;

      expect(
        rig.emitted.filter((e) => e.type === "turn_complete").length,
      ).toBe(1);
    } finally {
      rig.cleanup();
    }
  });

  test("EOF before handleUserMessage reattaches a fresh claude instead of refusing the send", async () => {
    const rig = makeDrainRig();
    try {
      rig.manager.prepareSession();
      await rig.manager.runReplay();
      await rig.manager.spawnClaudeAndWatch();

      // Drain observes EOF before any handleUserMessage call — the claude
      // was killed out from under tugcode, which is still alive and serving.
      rig.stdout.close();
      await rig.flush();

      // The submit is the request to have a turn, so it is the moment to put
      // a live claude back: `--resume`, same id, and the turn runs on it.
      const turnPromise = rig.manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "hi" }],
      });
      await rig.flush();

      expect(rig.respawns.length).toBe(1);
      rig.respawns[0].feed({ type: "result", subtype: "success", result: "" });
      await rig.flush();
      await turnPromise;

      // The dead end is gone: no `send_after_eof`, and the turn bracketed.
      const errors = rig.emitted.filter((e) => e.type === "error") as Array<{
        site?: string;
      }>;
      expect(errors.some((e) => e.site === "send_after_eof")).toBe(false);
      expect(
        rig.emitted.filter((e) => e.type === "turn_complete").length,
      ).toBe(1);
    } finally {
      rig.cleanup();
    }
  });

  test("a reattach that cannot spawn still surfaces the canonical error, once", async () => {
    const rig = makeDrainRig();
    try {
      rig.manager.prepareSession();
      await rig.manager.runReplay();
      await rig.manager.spawnClaudeAndWatch();

      rig.stdout.close();
      await rig.flush();

      // Nothing to reattach to. The send falls back to the frame it always
      // emitted, and the card is the user's to close.
      rig.failNextSpawn();
      await rig.manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "hi" }],
      });

      const errors = rig.emitted.filter((e) => e.type === "error");
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const last = errors[errors.length - 1] as { message: string };
      expect(last.message).toContain("stream ended unexpectedly");

      // And the failed attempt is not retried per submit — a spawn that
      // failed once fails the same way on the next keystroke, so the second
      // send answers from the latch without touching the spawn path.
      const spawnsBefore = rig.respawns.length;
      await rig.manager.handleUserMessage({
        type: "user_message",
        content: [{ type: "text", text: "again" }],
      });
      expect(rig.respawns.length).toBe(spawnsBefore);
    } finally {
      rig.cleanup();
    }
  });
});

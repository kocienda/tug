// tugcode/src/__tests__/replay-runner.test.ts
//
// `ReplayRunner` driven directly through a fake `ReplayHost`: the bracket it
// writes, its re-entrancy guard, the in-flight turn it adopts, and the
// background-agent rewind it asks for once the bracket closes. The wire-level
// replay contract through `SessionManager` stays in `replay-spawn.test.ts`.

import { describe, expect, test } from "bun:test";

import { ActiveTurn } from "../active-turn.ts";
import { ClaudeHome } from "../claude-home.ts";
import { drainPendingWrites } from "../ipc.ts";
import type { JsonlReadResult } from "../journal.ts";
import { ReplayRunner, type ReplayHost } from "../replay-runner.ts";
import type { OutboundMessage, ReplayComplete } from "../types.ts";
import { unwrapReplayBatches } from "./capture-ipc.ts";

/** Capture every frame written to IPC stdout while `fn` runs. */
async function captureIpc(fn: () => Promise<void>): Promise<OutboundMessage[]> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as unknown as { write: unknown }).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      const text =
        typeof data === "string" ? data : data instanceof Uint8Array ? decoder.decode(data) : "";
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.length > 0) captured.push(JSON.parse(t) as OutboundMessage);
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
    (Bun as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
  return unwrapReplayBatches(captured);
}

interface HostRecord {
  snapshots: Array<{ turn: ActiveTurn; suppressedAtEmit: boolean }>;
  tailerResets: number;
}

function fakeHost(opts: {
  readJsonl: (path: string) => Promise<JsonlReadResult>;
  activeTurn?: ActiveTurn | null;
}): ReplayHost & HostRecord {
  const host: ReplayHost & HostRecord = {
    snapshots: [],
    tailerResets: 0,
    sessionId: () => "replay-runner-session",
    resumeSessionId: () => null,
    projectDir: () => "/tmp/replay-runner-project-does-not-exist",
    claudeHome: () => ClaudeHome.at("/tmp/replay-runner-fixtures"),
    readJsonl: opts.readJsonl,
    relocation: () => null,
    claudeProcess: () => null,
    activeTurn: () => opts.activeTurn ?? null,
    stderrClassification: () => null,
    emitInflightTurnFromActiveTurn: (turn) => {
      host.snapshots.push({ turn, suppressedAtEmit: turn.suppressEmit });
    },
    resetSubagentTailersForReplay: () => {
      host.tailerResets += 1;
    },
  };
  return host;
}

describe("ReplayRunner", () => {
  test("a missing JSONL writes one bracket closed with jsonl_missing, then rewinds the tailers", async () => {
    const host = fakeHost({
      readJsonl: async () => ({ kind: "missing", message: "no such file" }),
    });
    const runner = new ReplayRunner(host, { sessionsDbPath: null });

    const emitted = await captureIpc(() => runner.runReplay());

    expect(emitted.map((m) => m.type)).toEqual(["replay_started", "replay_complete"]);
    const complete = emitted[1] as ReplayComplete;
    expect(complete.error?.kind).toBe("jsonl_missing");
    expect(runner.replayActive).toBe(false);
    expect(host.tailerResets).toBe(1);
  });

  test("a request landing while a replay is in flight is dropped", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const host = fakeHost({
      readJsonl: async () => {
        await held;
        return { kind: "missing", message: "no such file" };
      },
    });
    const runner = new ReplayRunner(host, { sessionsDbPath: null });

    const emitted = await captureIpc(async () => {
      const first = runner.runReplay();
      expect(runner.replayActive).toBe(true);
      // Dropped at the entry: it resolves without reading anything.
      await runner.runReplay();
      release();
      await first;
    });

    expect(emitted.filter((m) => m.type === "replay_started").length).toBe(1);
    expect(emitted.filter((m) => m.type === "replay_complete").length).toBe(1);
    expect(runner.replayActive).toBe(false);
  });

  test("an open turn is snapshotted inside the bracket with its emit gate held, and released after", async () => {
    const turn = new ActiveTurn(0, []);
    const host = fakeHost({
      readJsonl: async () => ({ kind: "missing", message: "no such file" }),
      activeTurn: turn,
    });
    const runner = new ReplayRunner(host, { sessionsDbPath: null });

    await captureIpc(() => runner.runReplay());

    expect(host.snapshots).toEqual([{ turn, suppressedAtEmit: true }]);
    expect(turn.suppressEmit).toBe(false);
  });

  test("a turn that already finished is not adopted", async () => {
    const turn = new ActiveTurn(0, []);
    turn.gotResult = true;
    const host = fakeHost({
      readJsonl: async () => ({ kind: "missing", message: "no such file" }),
      activeTurn: turn,
    });
    const runner = new ReplayRunner(host, { sessionsDbPath: null });

    await captureIpc(() => runner.runReplay());

    expect(host.snapshots).toEqual([]);
  });

  test("cancelReplay with no replay running is a no-op", () => {
    const runner = new ReplayRunner(
      fakeHost({ readJsonl: async () => ({ kind: "missing", message: "none" }) }),
      { sessionsDbPath: null },
    );
    expect(() => runner.cancelReplay()).not.toThrow();
    expect(runner.replayActive).toBe(false);
  });
});

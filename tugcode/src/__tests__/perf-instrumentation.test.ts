// tugcode/src/__tests__/perf-instrumentation.test.ts
//
// Pins the replay perf instrumentation: `runReplay()` emits the
// session-lifecycle stage splits (`perf.replay_requested`,
// `perf.replay_read`, `perf.replay_translate`) with plausible
// (>0 where the fixture guarantees it) values. The lines ride
// `logSessionLifecycle` → `console.log`, captured here with a spy;
// IPC stdout is stubbed the same way replay-spawn.test.ts does so
// the replay actually runs end to end against a real fixture.

import { ClaudeHome } from "../claude-home.ts";
import { describe, expect, test } from "bun:test";

import { SessionManager, type JsonlReadResult } from "../session.ts";

function twoTurnJsonl(): string {
  const lines = [
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "assistant",
      message: {
        id: "msg_one",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hi back" }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "second prompt" }],
      },
    },
    {
      type: "assistant",
      message: {
        id: "msg_two",
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "second reply" }],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** Parse a `[dev::session-lifecycle] event=... k=v ...` line into fields. */
function parseLifecycleLine(line: string): Record<string, string> | null {
  const prefix = "[dev::session-lifecycle] ";
  const idx = line.indexOf(prefix);
  if (idx === -1) return null;
  const fields: Record<string, string> = {};
  for (const part of line.slice(idx + prefix.length).split(" ")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return fields;
}

async function runReplayCapturingLifecycle(opts: {
  jsonlReader: (path: string) => Promise<JsonlReadResult>;
}): Promise<Array<Record<string, string>>> {
  const sessionId = crypto.randomUUID();
  const manager = new SessionManager(
    `/tmp/perf-instr-${Date.now()}`,
    sessionId,
    "resume",
    undefined,
    {
      claudeHome: ClaudeHome.at("/tmp/perf-instr-fixtures"),
      jsonlReader: opts.jsonlReader,
      replayTimeoutMs: 10_000,
    },
  );

  const lifecycle: Array<Record<string, string>> = [];
  const originalLog = console.log;
  const originalWrite = Bun.write;
  console.log = (...args: unknown[]) => {
    const joined = args.map(String).join(" ");
    const parsed = parseLifecycleLine(joined);
    if (parsed !== null) lifecycle.push(parsed);
  };
  // Swallow IPC stdout — the wire contract is covered by the
  // replay-spawn suite; this test only reads the lifecycle stream.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Bun as any).write = (_dest: unknown, data: unknown) =>
    Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  try {
    await manager.runReplay();
  } finally {
    console.log = originalLog;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bun as any).write = originalWrite;
  }
  return lifecycle;
}

describe("runReplay perf instrumentation", () => {
  test("emits requested / read / translate splits with plausible values", async () => {
    const jsonl = twoTurnJsonl();
    const lifecycle = await runReplayCapturingLifecycle({
      jsonlReader: async () => ({ kind: "ok" as const, jsonl }),
    });

    const events = lifecycle.map((f) => f.event);
    expect(events).toContain("perf.replay_requested");
    expect(events).toContain("perf.replay_read");
    expect(events).toContain("perf.replay_translate");

    const read = lifecycle.find((f) => f.event === "perf.replay_read")!;
    expect(Number(read.ms)).toBeGreaterThanOrEqual(0);
    expect(Number(read.bytes)).toBe(jsonl.length);
    // The fixture has 4 content lines + trailing newline = 4 newlines.
    expect(Number(read.lines)).toBe(4);

    const translate = lifecycle.find(
      (f) => f.event === "perf.replay_translate",
    )!;
    expect(Number(translate.ms)).toBeGreaterThanOrEqual(0);
    // At minimum: replay_started, per-turn frames, replay_complete.
    expect(Number(translate.messages)).toBeGreaterThan(2);
    expect(Number(translate.turns)).toBe(2);
  });

  test("missing JSONL still emits the read split with zero bytes/lines", async () => {
    const lifecycle = await runReplayCapturingLifecycle({
      jsonlReader: async () => ({
        kind: "missing" as const,
        message: "no session JSONL on disk",
      }),
    });

    const read = lifecycle.find((f) => f.event === "perf.replay_read")!;
    expect(read).toBeDefined();
    expect(Number(read.bytes)).toBe(0);
    expect(Number(read.lines)).toBe(0);

    const translate = lifecycle.find(
      (f) => f.event === "perf.replay_translate",
    )!;
    expect(Number(translate.turns)).toBe(0);
  });
});

// Prompt retraction (`interrupt{retract:true}` — the client's CASE A
// pull-down).
//
// A retracted prompt must leave claude's history entirely: the SDK's
// `interrupt` verb keeps the prompt in the session JSONL (appending an
// `"[Request interrupted by user]"` marker), so once the aborted turn
// closes, tugcode truncates the JSONL at the prompt's own record and
// silently respawns `--resume` — the in-place conversation-rewind leg,
// anchored at the retracted prompt. These tests cover the flag capture,
// the close-hook trigger, the truncation + respawn, the silence of the
// respawn (no rewind_result / replay frames), and every degrade guard.
//
// Reuses `rewind-bridge.test.ts`'s manager pattern: canned JSONL in,
// captured writes out, spawn/kill stubbed.

import { describe, test, expect } from "bun:test";
import { ActiveTurn, SessionManager } from "../session.ts";
import type { JsonlReadResult } from "../session.ts";
import { respondingProcess } from "./responding-process.ts";

async function captureIpcOutput(fn: () => void | Promise<void>): Promise<any[]> {
  const captured: any[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as any).write = (dest: unknown, data: unknown) => {
    let text: string | null = null;
    if (dest === Bun.stdout && typeof data === "string") text = data;
    else if (dest === Bun.stdout && data instanceof Uint8Array)
      text = decoder.decode(data);
    if (text !== null) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            captured.push(JSON.parse(trimmed));
          } catch {
            // ignore non-JSON lines
          }
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  };
  try {
    await fn();
    const { drainPendingWrites } = await import("../ipc.ts");
    await drainPendingWrites();
  } finally {
    (Bun as any).write = originalWrite;
  }
  return captured;
}

// A three-turn session JSONL shaped like claude's on-disk record after a
// CASE A pull-back: ALPHA committed, then the retracted BETA prompt
// followed by the SDK's interrupt marker and a synthetic assistant stop.
function buildRetractJsonl(): {
  jsonl: string;
  alphaUuid: string;
  betaUuid: string;
} {
  const alphaUuid = "alpha-prompt-uuid";
  const betaUuid = "beta-prompt-uuid";
  const records = [
    { type: "user", uuid: alphaUuid, permissionMode: "auto", message: { role: "user", content: [{ type: "text", text: "Remember ALPHA" }] } },
    { type: "assistant", uuid: "alpha-a1", parentUuid: alphaUuid, message: { role: "assistant", content: [{ type: "text", text: "ALPHA" }] } },
    { type: "last-prompt", lastPrompt: "Remember ALPHA", leafUuid: "alpha-a1" },
    { type: "user", uuid: betaUuid, permissionMode: "auto", parentUuid: "alpha-a1", message: { role: "user", content: [{ type: "text", text: "Remember BETA" }] } },
    { type: "user", uuid: "beta-marker", parentUuid: betaUuid, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
    { type: "assistant", uuid: "beta-synth", parentUuid: "beta-marker", message: { role: "assistant", model: "<synthetic>", content: [] } },
    { type: "last-prompt", lastPrompt: "Remember BETA", leafUuid: "beta-marker" },
  ];
  return {
    jsonl: records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    alphaUuid,
    betaUuid,
  };
}

function retractManager(jsonl: string | null) {
  const writes: { path: string; content: string }[] = [];
  const spawns: { id: string | null; mode: string }[] = [];
  let killCalls = 0;
  const manager = new SessionManager(
    "/tmp/tugcode-retract-" + Date.now() + "-" + Math.floor(performance.now()),
    crypto.randomUUID(),
    "resume",
    "live-claude-id",
    {
      jsonlReader: async (): Promise<JsonlReadResult> =>
        jsonl === null
          ? { kind: "missing", message: "no jsonl" }
          : { kind: "ok", jsonl },
      jsonlWriter: async (path: string, content: string) => {
        writes.push({ path, content });
      },
      sessionsDbPath: null,
    },
  );
  (manager as any).claudeProcess = { stdin: { write: () => {}, flush: () => {} } };
  (manager as any).spawnClaude = (id: string | null, mode: string) => {
    spawns.push({ id, mode });
    return respondingProcess(manager);
  };
  (manager as any).startStdoutDrain = () => {};
  (manager as any).killAndCleanup = async () => {
    killCalls++;
    (manager as any).claudeProcess = null;
  };
  return { manager, writes, spawns, killCalls: () => killCalls };
}

/** Await the setTimeout(0)-scheduled retraction and its async body. */
async function settleRetraction(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe("handleInterrupt retract flag", () => {
  test("handleInterrupt(true) latches retractRequested on the active turn", () => {
    const { manager } = retractManager("");
    const turn = new ActiveTurn(0, [{ type: "text", text: "Remember BETA" }]);
    (manager as any).activeTurn = turn;
    manager.handleInterrupt(true);
    expect(turn.interrupted).toBe(true);
    expect(turn.retractRequested).toBe(true);
    // This synthetic turn's completion never resolves; dispose the
    // escalation timer handleInterrupt armed so it can't fire later.
    (manager as any).clearInterruptEscalation();
  });

  test("a plain handleInterrupt() does NOT latch retractRequested", () => {
    const { manager } = retractManager("");
    const turn = new ActiveTurn(0, [{ type: "text", text: "keep me" }]);
    (manager as any).activeTurn = turn;
    manager.handleInterrupt();
    expect(turn.interrupted).toBe(true);
    expect(turn.retractRequested).toBe(false);
    // Dispose the armed escalation timer (synthetic turn never completes).
    (manager as any).clearInterruptEscalation();
  });
});

describe("retraction on turn close", () => {
  test("the result close truncates the JSONL at the retracted prompt and respawns the same id, silently", async () => {
    const { jsonl, betaUuid } = buildRetractJsonl();
    const { manager, writes, spawns } = retractManager(jsonl);

    const turn = new ActiveTurn(0, [{ type: "text", text: "Remember BETA" }]);
    turn.interrupted = true;
    turn.retractRequested = true;
    turn.promptUuid = betaUuid;
    (manager as any).activeTurn = turn;

    const out = await captureIpcOutput(async () => {
      // claude's terminal result for the aborted turn — the drain's
      // close hook fires maybeScheduleRetraction.
      (manager as any).handleClaudeLine(
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
      );
      await settleRetraction();
    });

    // In-place truncation of the live session's own file: the retracted
    // prompt, the SDK's marker, and the synthetic stop all leave; the
    // committed ALPHA turn stays.
    expect(writes.length).toBe(1);
    expect(writes[0].path).toContain("live-claude-id");
    expect(writes[0].content).toContain("Remember ALPHA");
    expect(writes[0].content).not.toContain("Remember BETA");
    expect(writes[0].content).not.toContain("[Request interrupted by user]");
    expect(spawns).toEqual([{ id: "live-claude-id", mode: "resume" }]);

    // Silent: same session id, so no rewind ack, no rebind init, and no
    // replay frames — the client already pulled the row down locally.
    const types = out.map((m) => m.type);
    expect(types).not.toContain("rewind_result");
    expect(types).not.toContain("session_init");
    expect(types).not.toContain("replay_started");
    expect(types).not.toContain("add_user_message");
  });

  test("a plain (non-retract) interrupted close never touches the JSONL", async () => {
    const { jsonl, betaUuid } = buildRetractJsonl();
    const { manager, writes, spawns } = retractManager(jsonl);

    const turn = new ActiveTurn(0, [{ type: "text", text: "Remember BETA" }]);
    turn.interrupted = true;
    turn.promptUuid = betaUuid;
    (manager as any).activeTurn = turn;

    await captureIpcOutput(async () => {
      (manager as any).handleClaudeLine(
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
      );
      await settleRetraction();
    });

    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
  });
});

describe("retraction degrade guards", () => {
  test("no captured promptUuid → skipped (nothing on disk to truncate)", async () => {
    const { jsonl } = buildRetractJsonl();
    const { manager, writes, spawns, killCalls } = retractManager(jsonl);
    const turn = new ActiveTurn(0, [{ type: "text", text: "Remember BETA" }]);
    turn.interrupted = true;
    turn.retractRequested = true;
    (manager as any).activeTurn = turn;

    await captureIpcOutput(async () => {
      (manager as any).handleClaudeLine(
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
      );
      await settleRetraction();
    });

    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(killCalls()).toBe(0);
  });

  test("a follow-on turn already running when the timer fires → skipped", async () => {
    const { jsonl, betaUuid } = buildRetractJsonl();
    const { manager, writes, spawns, killCalls } = retractManager(jsonl);
    const turn = new ActiveTurn(0, [{ type: "text", text: "Remember BETA" }]);
    turn.interrupted = true;
    turn.retractRequested = true;
    turn.promptUuid = betaUuid;
    (manager as any).activeTurn = turn;

    await captureIpcOutput(async () => {
      (manager as any).handleClaudeLine(
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
      );
      // A queued steering send opened a fresh turn before the scheduled
      // retraction ran — retraction must never kill a live turn.
      (manager as any).activeTurn = new ActiveTurn(1, [
        { type: "text", text: "follow-on" },
      ]);
      await settleRetraction();
    });

    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(killCalls()).toBe(0);
  });

  test("retracting the session's FIRST prompt → skipped (would leave an unresumable session)", async () => {
    const { jsonl, alphaUuid } = buildRetractJsonl();
    const { manager, writes, spawns, killCalls } = retractManager(jsonl);
    const turn = new ActiveTurn(0, [{ type: "text", text: "Remember ALPHA" }]);
    turn.interrupted = true;
    turn.retractRequested = true;
    turn.promptUuid = alphaUuid;
    (manager as any).activeTurn = turn;

    await captureIpcOutput(async () => {
      (manager as any).handleClaudeLine(
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
      );
      await settleRetraction();
    });

    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(killCalls()).toBe(0);
  });

  test("a missing JSONL (prompt never persisted) → skipped without killing", async () => {
    const { manager, writes, spawns, killCalls } = retractManager(null);
    const turn = new ActiveTurn(0, [{ type: "text", text: "Remember BETA" }]);
    turn.interrupted = true;
    turn.retractRequested = true;
    turn.promptUuid = "beta-prompt-uuid";
    (manager as any).activeTurn = turn;

    await captureIpcOutput(async () => {
      (manager as any).handleClaudeLine(
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
      );
      await settleRetraction();
    });

    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(killCalls()).toBe(0);
  });
});

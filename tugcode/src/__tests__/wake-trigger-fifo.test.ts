/**
 * Wake-trigger FIFO — labeling Cohort B wakes with what scheduled them.
 *
 * The harness's fire signal is a bare re-init with no id, so the only
 * way to label a wake is to remember the `ScheduleWakeup` / `CronCreate`
 * calls observed earlier on the main lane. These tests pin the FIFO's
 * registration rules (stop clears wakeups, CronDelete clears crons,
 * bounded growth, subagent lanes ignored) and the drain semantics: a
 * wakeup entry is consumed by its fire, a cron entry persists, and the
 * emitted `wake_started.wake_trigger.summary` carries the label.
 *
 * Shapes mirror the /loop capture in `tugcode/probes/goal-loop/`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";
import type { OutboundMessage, ToolUse, WakeStarted } from "../types.ts";

const SESSION_ID = "session-wake-fifo";

function toolUseFrame(
  name: string,
  id: string,
  input: Record<string, unknown>,
): ToolUse {
  return {
    type: "tool_use",
    msg_id: "m1",
    seq: 1,
    tool_name: name,
    tool_use_id: id,
    input,
    ipc_version: 2,
  };
}

function initLine(): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
  });
}

async function captureIpc(fn: () => void): Promise<OutboundMessage[]> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
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
        if (line.trim().length > 0) captured.push(JSON.parse(line));
      }
      return Promise.resolve(text.length);
    }
    return (originalWrite as (d: unknown, x: unknown) => Promise<number>)(
      dest,
      data,
    );
  };
  try {
    fn();
    await drainPendingWrites();
  } finally {
    (Bun as any).write = originalWrite;
  }
  return captured;
}

describe("SessionManager — wake-trigger FIFO", () => {
  let projectDir: string;
  let manager: SessionManager;
  const note = (frames: OutboundMessage[], lane: string | null = null) =>
    (manager as any).noteScheduledTriggerFrames(frames, lane);
  const pending = () => (manager as any).pendingScheduledTriggers as Array<{
    toolUseId: string;
    kind: string;
    label: string;
  }>;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wake-fifo-"));
    manager = new SessionManager(projectDir, SESSION_ID, "new", undefined, {
      sessionsDbPath: null,
    });
  });
  afterEach(() => {
    void manager.shutdown();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("ScheduleWakeup and CronCreate register; labels prefer reason/prompt", () => {
    note([
      toolUseFrame("ScheduleWakeup", "tu1", {
        delaySeconds: 60,
        reason: "loop pacing",
        prompt: "tick",
      }),
      toolUseFrame("CronCreate", "tu2", { cron: "*/5 * * * *", prompt: "check CI" }),
    ]);
    expect(pending()).toEqual([
      { toolUseId: "tu1", kind: "wakeup", label: "loop pacing" },
      { toolUseId: "tu2", kind: "cron", label: "check CI" },
    ]);
  });

  test("ScheduleWakeup {stop:true} clears pending wakeups; CronDelete clears crons", () => {
    note([
      toolUseFrame("ScheduleWakeup", "tu1", { delaySeconds: 60, reason: "r" }),
      toolUseFrame("CronCreate", "tu2", { cron: "* * * * *", prompt: "p" }),
    ]);
    note([toolUseFrame("ScheduleWakeup", "tu3", { stop: true })]);
    expect(pending().map((t) => t.kind)).toEqual(["cron"]);
    note([toolUseFrame("CronDelete", "tu4", { id: "whatever" })]);
    expect(pending()).toEqual([]);
  });

  test("subagent-lane scheduling is ignored", () => {
    note(
      [toolUseFrame("ScheduleWakeup", "tu1", { delaySeconds: 60, reason: "r" })],
      "subagent-lane",
    );
    expect(pending()).toEqual([]);
  });

  test("the FIFO is bounded", () => {
    for (let i = 0; i < 12; i++) {
      note([toolUseFrame("ScheduleWakeup", `tu${i}`, { delaySeconds: 60, reason: `r${i}` })]);
    }
    expect(pending().length).toBe(8);
    expect(pending()[0].label).toBe("r4");
  });

  test("a wake drains the wakeup label into wake_started and consumes it; crons persist", async () => {
    note([
      toolUseFrame("ScheduleWakeup", "tu1", { delaySeconds: 60, reason: "loop pacing" }),
    ]);
    // First init = session start; second init between turns = the wake.
    (manager as any).handleClaudeLine(initLine());
    const frames = await captureIpc(() => {
      (manager as any).handleClaudeLine(initLine());
    });
    const wake = frames.find((f) => f.type === "wake_started") as WakeStarted;
    expect(wake).toBeDefined();
    expect(wake.wake_trigger.summary).toBe("loop pacing");
    expect(wake.wake_trigger.tool_use_id).toBe("tu1");
    expect(pending()).toEqual([]);

    // A cron label persists across fires.
    (manager as any).isInWake = false;
    (manager as any).activeTurn = null;
    note([toolUseFrame("CronCreate", "tu2", { cron: "* * * * *", prompt: "check CI" })]);
    const frames2 = await captureIpc(() => {
      (manager as any).handleClaudeLine(initLine());
    });
    const wake2 = frames2.find((f) => f.type === "wake_started") as WakeStarted;
    expect(wake2.wake_trigger.summary).toBe("check CI");
    expect(pending().length).toBe(1);
  });

  test("with nothing pending the wake keeps the generic summary", async () => {
    (manager as any).handleClaudeLine(initLine());
    const frames = await captureIpc(() => {
      (manager as any).handleClaudeLine(initLine());
    });
    const wake = frames.find((f) => f.type === "wake_started") as WakeStarted;
    expect(wake.wake_trigger.summary).toBe("scheduled wake");
  });
});

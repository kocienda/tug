/**
 * The `<task-notification>` envelope on the **live** path ([P03]).
 *
 * tugcode has always recognised this envelope on the replay path, because
 * claude persists the envelope to its JSONL and does not persist the
 * `system/task_notification` that produced it. The live path was the one tier
 * that could meet the envelope and say nothing — and a wake tugcode does not
 * announce is a turn the arc runner reads as prompt-opened, which is the
 * counting error the whole of [P02] is about.
 *
 * `tugcode/probes/background-bash-wake/FINDINGS.md` (SDK 0.2.141, claude
 * 2.1.258) records that a backgrounded Bash completion emits the typed
 * `system/task_notification` and that the envelope reaches tugcode's stdout as
 * nothing at all. So the recognizer fires for nothing on today's wire, and
 * that is the point of pinning it: a wire that stops emitting the typed event
 * would otherwise take the busy latch down silently.
 *
 * The envelope text below is verbatim from that capture's `.jsonl`, ids
 * replaced.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, routeTopLevelEvent } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";
import type { OutboundMessage, WakeStarted } from "../types.ts";

const SESSION_ID = "session-wake-envelope";
const TASK_ID = "b7p4flzut";

/** Verbatim from `capture-bgbash-2026-09-04T15-36-06-376Z.jsonl`. */
const ENVELOPE =
  "<task-notification>\n" +
  `<task-id>${TASK_ID}</task-id>\n` +
  "<tool-use-id>toolu_01Hgc</tool-use-id>\n" +
  "<output-file>/private/tmp/claude-501/proj/sess/tasks/b7p4flzut.output</output-file>\n" +
  "<status>completed</status>\n" +
  '<summary>Background command "Sleep then echo in background" completed (exit code 0)</summary>\n' +
  "</task-notification>";

function envelopeEvent(): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: ENVELOPE },
    uuid: "8f2a1c3e-0000-4000-8000-000000000001",
    session_id: SESSION_ID,
  };
}

/** The typed event the same completion emits on today's wire. */
function taskNotificationEvent(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: TASK_ID,
    tool_use_id: "toolu_01Hgc",
    status: "completed",
    output_file: "/private/tmp/claude-501/proj/sess/tasks/b7p4flzut.output",
    summary: 'Background command "Sleep then echo in background" completed (exit code 0)',
    session_id: SESSION_ID,
  };
}

async function captureIpc(fn: () => void): Promise<OutboundMessage[]> {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Bun as any).write = originalWrite;
  }
  return captured;
}

describe("SessionManager — the <task-notification> envelope on the live path", () => {
  let projectDir: string;
  let manager: SessionManager;
  const drain = (event: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).handleInterTurnEvent(event);

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wake-envelope-"));
    manager = new SessionManager(projectDir, SESSION_ID, "new", undefined, {
      sessionsDbPath: null,
    });
  });
  afterEach(() => {
    void manager.shutdown();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("the envelope alone opens one wake bracket carrying its task id", async () => {
    const frames = await captureIpc(() => drain(envelopeEvent()));
    const wakes = frames.filter((f) => f.type === "wake_started");
    expect(wakes.length).toBe(1);
    const wake = wakes[0] as WakeStarted;
    expect(wake.wake_trigger.task_id).toBe(TASK_ID);
    expect(wake.wake_trigger.status).toBe("completed");
    expect(wake.wake_trigger.summary.startsWith("Background command")).toBe(
      true,
    );
    // The bracket is open and a turn is seated, so the wake's own content
    // routes through `dispatchEventToTurn` rather than falling into the drain.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).isInWake).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).activeTurn).not.toBeNull();
  });

  test("the typed event and the envelope together open exactly one", async () => {
    const frames = await captureIpc(() => {
      drain(taskNotificationEvent());
      drain(envelopeEvent());
    });
    expect(frames.filter((f) => f.type === "wake_started").length).toBe(1);
  });

  test("a plain user submission opens none", async () => {
    const frames = await captureIpc(() =>
      drain({
        type: "user",
        message: { role: "user", content: "walk step 5, please" },
        uuid: "8f2a1c3e-0000-4000-8000-000000000002",
      }),
    );
    expect(frames.filter((f) => f.type === "wake_started").length).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).isInWake).toBe(false);
  });
});

describe("routeTopLevelEvent — the envelope is not a submission", () => {
  const CTX = { msgId: "m1", openerId: "t-1", seq: 1, rev: 0 };

  test("an envelope latches no /rewind anchor", () => {
    const out = routeTopLevelEvent(envelopeEvent(), CTX);
    expect(out.promptUuid).toBeUndefined();
    expect(out.messages.length).toBe(0);
  });

  test("a real submission still latches one", () => {
    const out = routeTopLevelEvent(
      {
        type: "user",
        message: { role: "user", content: "/status" },
        uuid: "8f2a1c3e-0000-4000-8000-000000000003",
      },
      CTX,
    );
    expect(out.promptUuid).toBe("8f2a1c3e-0000-4000-8000-000000000003");
  });
});

// Live `ai-title` capture: claude's auto-generated session title reaches
// tugcast the moment it is written, instead of waiting for the next external
// scan to read it back out of the JSONL.
//
// The record arrives turn-free and carries no `uuid`, so `handleClaudeLine`
// catches it ahead of turn routing, emits `session_title`, and consumes the
// line. A blank title carries no signal and emits nothing.

import { describe, test, expect } from "bun:test";
import { SessionManager } from "../session.ts";

// Capture writeLine() output (routes through Bun.write(Bun.stdout)).
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

function manager(): SessionManager {
  return new SessionManager(
    "/tmp/tugcode-ai-title-" + Date.now() + "-" + Math.floor(performance.now()),
    crypto.randomUUID(),
  );
}

const SESSION = "11111111-2222-3333-4444-555555555555";

describe("ai-title forwarding", () => {
  test("an ai-title record becomes one session_title frame", async () => {
    const m = manager();
    const frames = await captureIpcOutput(() => {
      (m as any).handleClaudeLine(
        JSON.stringify({
          type: "ai-title",
          aiTitle: "Parser bug investigation",
          sessionId: SESSION,
        }),
      );
    });
    const titles = frames.filter((f) => f.type === "session_title");
    expect(titles).toEqual([
      { type: "session_title", title: "Parser bug investigation" },
    ]);
  });

  test("the title is trimmed, and a blank one emits nothing", async () => {
    const m = manager();
    const frames = await captureIpcOutput(() => {
      (m as any).handleClaudeLine(
        JSON.stringify({ type: "ai-title", aiTitle: "  padded  ", sessionId: SESSION }),
      );
      (m as any).handleClaudeLine(
        JSON.stringify({ type: "ai-title", aiTitle: "   ", sessionId: SESSION }),
      );
      (m as any).handleClaudeLine(
        JSON.stringify({ type: "ai-title", sessionId: SESSION }),
      );
    });
    expect(frames.filter((f) => f.type === "session_title")).toEqual([
      { type: "session_title", title: "padded" },
    ]);
  });

  test("the record is consumed — it never reaches turn routing", async () => {
    const m = manager();
    const frames = await captureIpcOutput(() => {
      (m as any).handleClaudeLine(
        JSON.stringify({ type: "ai-title", aiTitle: "A title", sessionId: SESSION }),
      );
    });
    // Exactly one frame: the title. No unknown_event, no turn machinery woken.
    expect(frames.map((f) => f.type)).toEqual(["session_title"]);
    expect((m as any).activeTurn).toBeNull();
  });
});

/**
 * effort-respawn-handshake — an effort respawn is a full spawn.
 *
 * Applying an effort is a respawn, and the claude it seats has to come up the
 * way every other spawn does: with the `initialize` handshake sent. The ack is
 * what moves the process phase out of `spawning`, and it is what writes the
 * `session_capabilities` frame the deck compares its own level against. A
 * respawn that skipped the handshake left the phase at `spawning` for the life
 * of the process and left the capabilities naming the old level, so the deck
 * sent the same effort again.
 *
 * The fake claude records every control request written to its stdin; the
 * test answers the handshake the way claude would, through the real line
 * handler.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";
import { fakeSpawner } from "./fake-spawner.ts";

const SID = "99999999-9999-9999-9999-999999999999";

const realWrite = Bun.write;

/** Every JSON line written to stdout since the last reset, in write order. */
let emitted: any[] = [];

/** A claude that records the control requests written to it. */
function fakeClaude(requests: any[]): any {
  let close: () => void = () => {};
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
  });
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((res) => {
    resolveExit = res;
  });
  const die = () => {
    close();
    resolveExit(0);
  };
  return {
    stdin: {
      write: (data: unknown) => {
        for (const line of String(data).split("\n")) {
          if (line.trim().length === 0) continue;
          try {
            requests.push(JSON.parse(line));
          } catch {
            // not a control request
          }
        }
      },
      flush: () => {},
      end: () => die(),
    },
    stdout,
    exited,
    exitCode: null,
    kill: () => die(),
    pid: 9999,
  };
}

beforeEach(() => {
  emitted = [];
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
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          emitted.push(JSON.parse(trimmed));
        } catch {
          // non-JSON lines are not IPC
        }
      }
    }
    return Promise.resolve(0);
  };
});

afterEach(() => {
  (Bun as any).write = realWrite;
});

/**
 * A manager whose every spawn is a recording fake claude, with a first claude
 * live and its drain running. `requests` holds what the respawned claudes were
 * sent; the first claude's requests are not part of it.
 */
function manager(sessionMode: "new" | "resume"): { m: any; requests: any[] } {
  const requests: any[] = [];
  const m = new SessionManager(
    "/tmp/tugcode-effort-handshake-" + SID,
    SID,
    sessionMode,
    sessionMode === "resume" ? SID : undefined,
    {
      sessionsDbPath: null,
      spawner: fakeSpawner(() => fakeClaude(requests)),
    },
  ) as any;
  m.claudeCodeVersion = "2.1.195";
  // Made-up pid: keep the group signal off the OS ("gone" signals the child).
  m.claude.signalProcessGroup = () => "gone";
  m.claudeProcess = fakeClaude([]);
  m.startStdoutDrain(m.claudeProcess);
  return { m, requests };
}

async function respawnsSettled(m: any): Promise<void> {
  while (m.respawnGate !== null) await m.respawnGate;
  await drainPendingWrites();
}

/** The `initialize` control request among `requests`, if one was sent. */
function initializeRequest(requests: any[]): any | undefined {
  return requests.find(
    (r) => r?.type === "control_request" && r?.request?.subtype === "initialize",
  );
}

/** Answer `request` the way claude does, through the manager's line handler. */
async function ack(m: any, request: any): Promise<void> {
  m.handleClaudeLine(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.request_id,
        response: { models: [], commands: [], agents: [] },
      },
    }),
  );
  await drainPendingWrites();
}

describe("an effort respawn", () => {
  test("on a fresh session sends the handshake, and its capabilities carry the new effort", async () => {
    const { m, requests } = manager("new");

    await m.handleEffortChange("medium");
    await respawnsSettled(m);

    const request = initializeRequest(requests);
    expect(request).toBeDefined();
    expect(m.claude.phase).not.toBe("spawning");

    await ack(m, request);

    const caps = emitted.filter((e) => e?.type === "session_capabilities");
    expect(caps).toHaveLength(1);
    expect(caps[0].effort).toBe("medium");
    expect(m.claude.phase).toBe("running");
  });

  test("on a session with history resumes, and the handshake follows the resume health gate", async () => {
    const { m, requests } = manager("new");
    // A turn has landed: the conversation is on disk, so the respawn resumes.
    m.claudeReceivedInput = true;
    // The resume path holds its handshake behind a health gate; fire the
    // gate's timer as soon as it is armed rather than waiting it out.
    const setTimer = m.timers.setTimeout.bind(m.timers);
    m.timers.setTimeout = (key: string, fn: () => void, ms: number, opts?: unknown) => {
      if (key === "resume-handshake") {
        fn();
        return;
      }
      setTimer(key, fn, ms, opts);
    };

    await m.handleEffortChange("high");
    await respawnsSettled(m);

    // Recorded as a resume, as every `--resume` spawn is.
    expect(m.sessionMode).toBe("resume");
    expect(m.claudeReceivedInput).toBe(false);

    const request = initializeRequest(requests);
    expect(request).toBeDefined();
    await ack(m, request);

    const caps = emitted.filter((e) => e?.type === "session_capabilities");
    expect(caps).toHaveLength(1);
    expect(caps[0].effort).toBe("high");
    expect(m.claude.phase).toBe("running");
  });
});

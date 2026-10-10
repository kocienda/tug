// tugcode/src/__tests__/process-phase.test.ts
//
// The claude process's phase, read off the session-lifecycle log a real
// `SessionManager` writes ([B03]). A first spawn handshakes and acks; a
// conversation rewind then tears it down and respawns a fork that handshakes
// and acks in turn. Every phase move lands as `tugcode.process_phase`, and the
// test pins how those lines interleave with the `tugcode.initialize_handshake`
// events the manager already wrote: the story the handshake-ack flag used to
// tell, now told by the phase.

import { describe, expect, test } from "bun:test";

import { ClaudeHome } from "../claude-home.ts";
import { drainPendingWrites } from "../ipc.ts";
import { SessionManager } from "../session.ts";
import { fakeSpawner } from "./fake-spawner.ts";

const PROMPT_1 = "phase-prompt-one";
const PROMPT_2 = "phase-prompt-two";
const SESSION_JSONL =
  [
    { type: "user", uuid: PROMPT_1, parentUuid: null, message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "assistant", uuid: "asst-1", parentUuid: PROMPT_1, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", uuid: PROMPT_2, parentUuid: "asst-1", message: { role: "user", content: [{ type: "text", text: "second" }] } },
    { type: "assistant", uuid: "asst-2", parentUuid: PROMPT_2, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n";

/**
 * A claude that answers every control request with a correlated success
 * `control_response`, and exits — closing its stdout — when its stdin closes.
 */
function ackingChild(manager: SessionManager) {
  let exit!: (code: number) => void;
  let closeStdout!: () => void;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStdout = () => controller.close();
    },
  });
  const exited = new Promise<number>((r) => {
    exit = r;
  });
  const handleClaudeLine = (line: string): void =>
    (manager as unknown as { handleClaudeLine: (l: string) => void }).handleClaudeLine(line);
  return {
    stdout,
    stdin: {
      write: (data: unknown) => {
        const request = JSON.parse(String(data).replace(/\n$/, "")) as { request_id: string };
        queueMicrotask(() =>
          handleClaudeLine(
            JSON.stringify({
              type: "control_response",
              response: { subtype: "success", request_id: request.request_id, response: {} },
            }),
          ),
        );
      },
      flush: () => {},
      end: () => {
        closeStdout();
        exit(0);
      },
    },
    exited,
    exitCode: null,
    kill: () => exit(0),
  };
}

/** Run `fn` with IPC stdout swallowed and the session-lifecycle log captured. */
async function captureLifecycle(fn: () => Promise<void>): Promise<Array<Record<string, string>>> {
  const events: Array<Record<string, string>> = [];
  const originalLog = console.log;
  const originalWrite = Bun.write;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    const prefix = "[dev::session-lifecycle] ";
    if (!line.startsWith(prefix)) return;
    const fields: Record<string, string> = {};
    for (const part of line.slice(prefix.length).split(" ")) {
      const eq = part.indexOf("=");
      if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    events.push(fields);
  };
  (Bun as unknown as { write: unknown }).write = (dest: unknown, data: unknown) =>
    dest === Bun.stdout
      ? Promise.resolve(data instanceof Uint8Array ? data.length : String(data).length)
      : originalWrite(dest as never, data as never);
  try {
    await fn();
    await drainPendingWrites();
  } finally {
    console.log = originalLog;
    (Bun as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
  return events;
}

describe("process phase", () => {
  test("a handshake, a teardown and a respawn log the phase in step with the handshake events", async () => {
    let manager!: SessionManager;
    manager = new SessionManager(
      `/tmp/process-phase-${Date.now()}`,
      crypto.randomUUID(),
      "resume",
      undefined,
      {
        claudeHome: ClaudeHome.at("/tmp/process-phase-fixtures"),
        sessionsDbPath: null,
        jsonlReader: async () => ({ kind: "ok" as const, jsonl: SESSION_JSONL }),
        jsonlWriter: async () => {},
        spawner: fakeSpawner(() => ackingChild(manager)),
      },
    );
    // Private seams: seat the first child and send its handshake the way the
    // spawn path does, so the test owns the timing.
    const m = manager as unknown as {
      claudeProcess: unknown;
      startStdoutDrain(child: unknown): void;
      dispatchInitializeHandshake(child: unknown): void;
      claude: { phase: string; signalProcessGroup: () => string };
    };
    m.claude.signalProcessGroup = () => "gone";

    const events = await captureLifecycle(async () => {
      const first = ackingChild(manager);
      m.claudeProcess = first;
      m.startStdoutDrain(first);
      m.dispatchInitializeHandshake(first);
      await new Promise((r) => setTimeout(r, 0));
      expect(m.claude.phase).toBe("running");

      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: PROMPT_2,
        scope: "conversation",
      });
    });

    const story = events
      .filter((e) => e.event === "tugcode.process_phase" || e.event === "tugcode.initialize_handshake")
      .map((e) => (e.event === "tugcode.process_phase" ? `${e.from}→${e.to}` : "initialize_handshake"));
    expect(story).toEqual([
      "dead→spawning",
      "initialize_handshake",
      "spawning→handshaking",
      "handshaking→running",
      "running→terminating",
      "terminating→dead",
      "dead→spawning",
      "initialize_handshake",
      "spawning→handshaking",
      "handshaking→running",
    ]);
    expect(m.claude.phase).toBe("running");
  });
});

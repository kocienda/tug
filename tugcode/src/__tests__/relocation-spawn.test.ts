/**
 * relocation-spawn.test.ts — how a session that changed its project directory
 * spawns claude.
 *
 * A directory change forks the card's conversation into the target directory:
 * `claude --resume <parent> --fork-session --session-id <new>`. Claude writes
 * the fork's JSONL only when the first user message arrives, so until
 * `<new>.jsonl` exists under the target's folder every spawn must be that fork
 * — `--session-id <new>` would start empty and `--resume <new>` would exit
 * "No conversation found". Once the file exists the session is an ordinary
 * one. The decision lives in `claudeSessionFlags`, the one method every spawn
 * reads, so the initial spawn and every live-setting respawn take it alike.
 */

import { ClaudeHome } from "../claude-home.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, jsonlPathFor } from "../session.ts";
import { drainPendingWrites } from "../ipc.ts";

const SID = "11111111-1111-1111-1111-111111111111";
const PARENT_ID = "33333333-3333-3333-3333-333333333333";
const PARENT_DIR = "/tmp/relocation-parent-dir";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(opts?: { relocation?: boolean }): {
  manager: any;
  ownJsonl: string;
} {
  const root = mkdtempSync(join(tmpdir(), "relocation-root-"));
  const projectDir = mkdtempSync(join(tmpdir(), "relocation-target-"));
  scratch.push(root, projectDir);
  const manager = new SessionManager(projectDir, SID, "new", undefined, {
    sessionsDbPath: null,
    claudeHome: ClaudeHome.at(root),
    relocation:
      opts?.relocation === false
        ? undefined
        : { parentClaudeId: PARENT_ID, parentProjectDir: PARENT_DIR },
  });
  // Claude names its folder after the resolved cwd (`/tmp` → `/private/tmp`).
  const ownJsonl = jsonlPathFor(ClaudeHome.at(root), realpathSync(projectDir), SID);
  return { manager, ownJsonl };
}

function writeOwnJsonl(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
}

const FORK = {
  sessionId: PARENT_ID,
  forkSession: true,
  sessionIdOverride: SID,
};

describe("relocationForkPending", () => {
  test("true with no fork JSONL, false once it exists", () => {
    const { manager, ownJsonl } = fixture();
    expect(manager.relocationForkPending()).toBe(true);
    writeOwnJsonl(ownJsonl);
    expect(manager.relocationForkPending()).toBe(false);
  });

  test("false for a session that did not move", () => {
    const { manager } = fixture({ relocation: false });
    expect(manager.relocationForkPending()).toBe(false);
  });
});

describe("claudeSessionFlags", () => {
  test("while pending, every spawn mode answers the fork", () => {
    const { manager } = fixture();
    expect(manager.claudeSessionFlags(SID, "session-id")).toEqual(FORK);
    expect(manager.claudeSessionFlags(SID, "resume")).toEqual(FORK);
    // The live-setting respawn path (effort, model, permission, add-dir).
    const mode = manager.liveRespawnMode();
    expect(manager.claudeSessionFlags(manager.liveRespawnId(mode), mode)).toEqual(FORK);
  });

  test("once the fork is written, it answers what an unmoved session answers", () => {
    const moved = fixture();
    const plain = fixture({ relocation: false });
    writeOwnJsonl(moved.ownJsonl);
    for (const mode of ["session-id", "resume"] as const) {
      expect(moved.manager.claudeSessionFlags(SID, mode)).toEqual(
        plain.manager.claudeSessionFlags(SID, mode),
      );
    }
    expect(moved.manager.claudeSessionFlags(SID, "resume")).toEqual({
      sessionId: SID,
      sessionIdOverride: undefined,
    });
  });
});

/** Run `fn`, capturing every IPC line tugcode writes to stdout. */
async function captureIpc(fn: () => Promise<void>): Promise<any[]> {
  const captured: any[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as any).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      const text = typeof data === "string" ? data : decoder.decode(data as Uint8Array);
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          captured.push(JSON.parse(line));
        } catch {
          // ignore non-JSON
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
    (Bun as any).write = originalWrite;
  }
  return captured;
}

function silentChild() {
  const closed = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  return {
    stdout: closed(),
    stderr: closed(),
    stdin: { write: () => {}, end: () => {}, flush: () => {} },
    exited: new Promise<number>(() => {}),
    kill: () => {},
  };
}

describe("initialize() in new mode", () => {
  test("a pending relocation announces the relocate edge, then the init", async () => {
    const { manager } = fixture();
    manager.spawnClaude = () => silentChild();
    const lines = await captureIpc(() => manager.initialize());
    const kinds = lines
      .filter((l) => l.type === "session_segment" || l.type === "session_init")
      .map((l) => l.type);
    expect(kinds).toEqual(["session_segment", "session_init"]);
    const segment = lines.find((l) => l.type === "session_segment");
    expect(segment).toMatchObject({
      kind: "relocate",
      parentSessionId: PARENT_ID,
      newSessionId: SID,
    });
    expect(lines.find((l) => l.type === "session_init").session_id).toBe(SID);
  });

  test("a written fork announces nothing", async () => {
    const { manager, ownJsonl } = fixture();
    writeOwnJsonl(ownJsonl);
    manager.spawnClaude = () => silentChild();
    const lines = await captureIpc(() => manager.initialize());
    expect(lines.some((l) => l.type === "session_segment")).toBe(false);
    expect(lines.find((l) => l.type === "session_init").session_id).toBe(SID);
  });
});

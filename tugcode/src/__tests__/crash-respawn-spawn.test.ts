/**
 * crash-respawn-spawn.test.ts — how a crash respawn spawns claude when the
 * session it resumes was never written to disk.
 *
 * tugcast respawns a tugcode whose child died with `--crash-respawn`, in
 * resume mode, naming the claude id the dead child was running. Claude writes
 * a session's JSONL only when the first user message arrives, so a segment
 * killed before its first message — a rotation's fresh claude, or a new
 * session — has nothing on disk, and `--resume <id>` exits "No conversation
 * found", which tugcode reports as `resume_failed` and the card answers by
 * unbinding to its picker. Nothing was lost, so the respawn re-creates the
 * segment under its own id instead. A first spawn's resume of a missing
 * conversation is still a resume, and still refused.
 */

import { ClaudeHome } from "../claude-home.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, jsonlPathFor } from "../session.ts";
import { fakeSpawner, spawnedAs } from "./fake-spawner.ts";

/** The card's tug session id. */
const SID = "11111111-1111-1111-1111-111111111111";
/** The segment the dead child was running: a rotation's fresh claude. */
const SEGMENT = "44444444-4444-4444-4444-444444444444";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function fixture(opts: { crashRespawn: boolean; written: boolean }): {
  manager: any;
  spawned: string[][];
} {
  const root = mkdtempSync(join(tmpdir(), "crash-respawn-root-"));
  const projectDir = mkdtempSync(join(tmpdir(), "crash-respawn-project-"));
  scratch.push(root, projectDir);
  const spawned: string[][] = [];
  const manager = new SessionManager(projectDir, SID, "resume", SEGMENT, {
    sessionsDbPath: null,
    claudeHome: ClaudeHome.at(root),
    crashRespawn: opts.crashRespawn,
    spawner: fakeSpawner((args) => {
      spawned.push(args);
      return silentChild();
    }),
  });
  if (opts.written) {
    // Claude names its folder after the resolved cwd (`/tmp` → `/private/tmp`).
    const path = jsonlPathFor(ClaudeHome.at(root), realpathSync(projectDir), SEGMENT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n");
  }
  return { manager, spawned };
}

function spawn(manager: any): void {
  manager.prepareSession();
  void manager.spawnClaudeAndWatch();
}

describe("a crash respawn's claude spawn", () => {
  test("re-creates a segment claude never wrote, and is a fresh session after", () => {
    const { manager, spawned } = fixture({ crashRespawn: true, written: false });
    spawn(manager);
    expect(spawned.map(spawnedAs)).toEqual([{ id: SEGMENT, mode: "session-id" }]);
    expect(manager.sessionMode).toBe("new");
  });

  test("resumes a segment claude wrote", () => {
    const { manager, spawned } = fixture({ crashRespawn: true, written: true });
    spawn(manager);
    expect(spawned.map(spawnedAs)).toEqual([{ id: SEGMENT, mode: "resume" }]);
    expect(manager.sessionMode).toBe("resume");
  });

  test("a first spawn still resumes a missing conversation, so it is refused", () => {
    const { manager, spawned } = fixture({ crashRespawn: false, written: false });
    spawn(manager);
    expect(spawned.map(spawnedAs)).toEqual([{ id: SEGMENT, mode: "resume" }]);
  });
});

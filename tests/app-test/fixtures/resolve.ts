/**
 * resolve.ts — seed a COMMITTED, sanitized session fixture into the
 * real `~/.claude/projects/` tree so an app-test can resume it through
 * the production picker → spawn → reveal path.
 *
 * Parallel to `corpus/resolve.ts`'s `seedSnapshot`, but the source is a
 * committed fixture under `fixtures/sessions/` — not a gitignored
 * harvested snapshot. So these legs run **everywhere** (CI, any
 * machine) and never touch the user's private live archive.
 *
 * Each record's top-level `cwd` is rewritten to the fresh temp project
 * dir: the external-session scanner excludes a session whose first
 * `cwd` doesn't match its project dir, so the rewrite is what makes the
 * fixture listable from the picker (the at0182 pattern).
 *
 * `opts.sessionId` seeds the copy under a different session id: every
 * record's top-level `sessionId` is rewritten to it and the file is named
 * `<sessionId>.jsonl`. Two cards cannot resume one id, and `claude --resume`
 * refuses an id that is not a UUID, so a test that resumes one fixture into
 * several cards seeds one copy per card, each under a fresh
 * `crypto.randomUUID()`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { onTestRunEnd } from "../_harness/test-cleanup";

export const FIXTURES_DIR = import.meta.dir;
export const SESSIONS_DIR = join(FIXTURES_DIR, "sessions");

/** Mirror of claude's project-dir encoding (`/` and `.` → `-`). */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[/.]/g, "-");
}

/** Absolute path of a committed fixture by name (no `.jsonl` suffix). */
export function fixturePath(name: string): string {
  return join(SESSIONS_DIR, `${name}.jsonl`);
}

export interface SeededFixtureSession {
  /** Fixture name (file stem) that was seeded. */
  fixture: string;
  /** Session id as recorded in the fixture's records. */
  sessionId: string;
  /** Decoded project path the picker's recents list is seeded with. */
  projectDir: string;
  /** `~/.claude/projects/<encoded>` dir holding the seeded JSONL. */
  seededClaudeDir: string;
  jsonlPath: string;
  cleanup(): void;
}

/**
 * Seed committed fixture `name` into `~/.claude/projects/` under a
 * fresh temp project dir, rewriting each record's `cwd`. The seeded
 * file is named `<sessionId>.jsonl` (the picker keys a session by its
 * filename stem), where `sessionId` is `opts.sessionId` when given —
 * every record's `sessionId` rewritten to match — and otherwise read
 * from the fixture records.
 * Fixtures are small committed files, so this reads the whole file.
 */
export async function seedFixtureSession(
  name: string,
  label: string,
  opts: { sessionId?: string } = {},
): Promise<SeededFixtureSession> {
  const source = fixturePath(name);
  if (!existsSync(source)) {
    throw new Error(`fixture not found: ${source}`);
  }
  const lines = readFileSync(source, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  let sessionId = name;
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as { sessionId?: unknown };
      if (typeof r.sessionId === "string" && r.sessionId.length > 0) {
        sessionId = r.sessionId;
        break;
      }
    } catch {
      // skip
    }
  }
  if (opts.sessionId !== undefined) sessionId = opts.sessionId;

  const projectDir = realpathSync(
    mkdtempSync(join(tmpdir(), `tug-scratch-fixture-${label}-`)),
  );
  const seededClaudeDir = join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectDir(projectDir),
  );
  mkdirSync(seededClaudeDir, { recursive: true });
  const jsonlPath = join(seededClaudeDir, `${sessionId}.jsonl`);

  const rewritten = lines.map((line) => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record !== null && typeof record === "object") {
        if ("cwd" in record) record.cwd = projectDir;
        if (opts.sessionId !== undefined && "sessionId" in record) {
          record.sessionId = opts.sessionId;
        }
        return JSON.stringify(record);
      }
    } catch {
      // Committed fixtures are never torn; pass through defensively.
    }
    return line;
  });
  writeFileSync(jsonlPath, rewritten.join("\n") + "\n", "utf8");

  // The seeded copy has served its purpose when the test run ends, whichever
  // way it ends; `cleanup()` releases it sooner. Anything a SIGKILL strands is
  // swept by the janitor (`tugcore::janitor::sweep_seeded_transcripts`).
  const release = (): void => {
    rmSync(seededClaudeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  };
  const dropTask = onTestRunEnd(release);

  return {
    fixture: name,
    sessionId,
    projectDir,
    seededClaudeDir,
    jsonlPath,
    cleanup() {
      dropTask();
      release();
    },
  };
}

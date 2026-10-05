/**
 * resolve.ts — corpus resolution and seeding for app-test legs.
 *
 * Locates the harvested corpus (manifest + snapshots) next to this
 * module, and seeds a selected snapshot into the REAL
 * `~/.claude/projects/` under a fresh temp project dir (the at0182
 * pattern) with every record's `cwd` rewritten to that dir — the
 * external-session scanner excludes a session whose first `cwd`
 * doesn't match its project dir, so the rewrite is what makes the
 * snapshot listable from the picker.
 *
 * Corpus legs `skipIf` cleanly when no manifest exists: a machine
 * without a harvested corpus still gates on the always-runnable
 * real-shape generator legs.
 *
 * `seedSnapshot`'s `opts.sessionId` seeds the copy under a different id,
 * rewriting every record's top-level `sessionId` and naming the file
 * `<sessionId>.jsonl`, for the reason `fixtures/resolve.ts` gives: one
 * snapshot resumed into several cards needs one UUID per copy.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Manifest, SelectedSnapshot } from "./harvest";

export type { Manifest, SelectedSnapshot };

export const CORPUS_DIR = import.meta.dir;
export const MANIFEST_PATH = join(CORPUS_DIR, "manifest.json");

/** Mirror of claude's project-dir encoding (`/` and `.` → `-`). */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[/.]/g, "-");
}

export function loadManifest(): Manifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf8"),
    ) as Manifest;
    if (manifest.dryRun) return null;
    return manifest;
  } catch {
    return null;
  }
}

/**
 * The on-disk file backing a snapshot. Copies and hardlinks live under
 * `snapshots/`; a `reference` strategy points at the live source path
 * — callers get a drift warning when its size/mtime moved since
 * harvest.
 */
export function snapshotSource(snap: SelectedSnapshot): {
  path: string;
  drifted: boolean;
} {
  if (snap.snapshotPath !== null && existsSync(snap.snapshotPath)) {
    return { path: snap.snapshotPath, drifted: false };
  }
  const st = statSync(snap.sourcePath);
  const drifted =
    st.size !== snap.bytes || Math.round(st.mtimeMs) !== snap.mtimeMs;
  return { path: snap.sourcePath, drifted };
}

export interface SeededCorpusSession {
  snap: SelectedSnapshot;
  sessionId: string;
  /** Decoded project path the picker's recents list is seeded with. */
  projectDir: string;
  /** `~/.claude/projects/<encoded>` dir holding the seeded JSONL. */
  seededClaudeDir: string;
  jsonlPath: string;
  cleanup(): void;
}

/**
 * Seed `snap` into `~/.claude/projects/` under a fresh temp project
 * dir, rewriting each record's top-level `cwd` — and, with
 * `opts.sessionId`, its `sessionId`. Streams line by line — whale
 * snapshots never exist in memory whole.
 */
export async function seedSnapshot(
  snap: SelectedSnapshot,
  label: string,
  opts: { sessionId?: string } = {},
): Promise<SeededCorpusSession> {
  const source = snapshotSource(snap);
  const projectDir = realpathSync(
    mkdtempSync(join(tmpdir(), `corpus-${label}-`)),
  );
  const seededClaudeDir = join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectDir(projectDir),
  );
  mkdirSync(seededClaudeDir, { recursive: true });
  const sessionId = opts.sessionId ?? snap.id;
  const jsonlPath = join(seededClaudeDir, `${sessionId}.jsonl`);

  const out = createWriteStream(jsonlPath);
  const rl = createInterface({
    input: createReadStream(source.path),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    let rewritten = line;
    const rewriteId = opts.sessionId !== undefined && line.includes('"sessionId":');
    if (line.includes('"cwd":') || rewriteId) {
      try {
        const record = JSON.parse(line);
        if (record !== null && typeof record === "object") {
          if ("cwd" in record) record.cwd = projectDir;
          if (rewriteId && "sessionId" in record) record.sessionId = sessionId;
          rewritten = JSON.stringify(record);
        }
      } catch {
        // Torn line — pass through verbatim, the scanner skips it.
      }
    }
    if (!out.write(`${rewritten}\n`)) await once(out, "drain");
  }
  out.end();
  await once(out, "close");

  return {
    snap,
    sessionId,
    projectDir,
    seededClaudeDir,
    jsonlPath,
    cleanup() {
      rmSync(seededClaudeDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

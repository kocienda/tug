/**
 * harvest.ts — real-session corpus harvester.
 *
 * Surveys every `~/.claude/projects/<dir>/<id>.jsonl`, computes
 * per-session statistics through the streaming classifier
 * (`classify.ts`), assigns each session a size class and shape tags,
 * and materializes a representative snapshot set under
 * `tests/app-test/corpus/snapshots/` with a `manifest.json` describing
 * the whole population. The manifest and snapshots are gitignored —
 * session content never reaches git; only this tool and its README are
 * committed.
 *
 * Materialization strategy is per-class: typical and heavy snapshots
 * are copied (stable against the live file changing underfoot);
 * whale-class snapshots are hardlinked (falling back to an in-place
 * reference when linking fails, e.g. across filesystems), with
 * `{strategy, sourcePath, size, mtime}` recorded so a runner can
 * detect a drifted reference and re-harvest.
 *
 * Sessions a terminal currently holds (per the `~/.claude/sessions/`
 * registry) are skipped, and torn final lines parse as one skipped
 * record — both are normal while sessions are live.
 *
 * Usage:
 *   bun run tests/app-test/corpus/harvest.ts [--dry-run]
 *     [--projects-root <dir>] [--sessions-dir <dir>] [--out <dir>]
 *     [--pin <id-prefix>]... [--quiet]
 */

import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

import { claudeHomeFromEnv } from "../_harness/claude-home";
import {
  accumulateLine,
  classifySize,
  createStatsAccumulator,
  percentile,
  primaryShape,
  shapeTags,
  type SessionStats,
  type ShapeTag,
  type SizeClass,
} from "./classify";

export const MANIFEST_SCHEMA = 1;

/** Session ids always snapshotted, matched by prefix. */
export const DEFAULT_PINS = ["763cd1d8"];

/**
 * Project dirs seeded by the app-test harness (and leaked by wedged
 * runs): the at0NNN fixture seeds, the corpus runner's own
 * `corpus-<label>-XXXXXX` seeds, and tugcode's hmr-mid-stream test
 * dirs — all anchored to a temp-dir encoding (`-T-` / `-tmp-`) so a
 * real project that merely contains one of these words never
 * matches. Harness content must never enter the corpus; worse, a
 * leaked seed shares its session id with the REAL session it copied,
 * so it can shadow the genuine file in id-keyed selection.
 */
export const SEEDED_PROJECT_DIR_PATTERN =
  /(-T-|-tmp-)(at0\d{3}-|corpus-|hmr-mid-stream-test)/;

export interface SurveyedSession {
  id: string;
  projectDir: string;
  sourcePath: string;
  bytes: number;
  mtimeMs: number;
  class: SizeClass;
  shapes: ShapeTag[];
  primaryShape: ShapeTag;
  stats: SessionStats;
}

export type Strategy = "copy" | "hardlink" | "reference";

export interface SelectedSnapshot extends SurveyedSession {
  pinned: boolean;
  /** True when this is the single largest session in the population. */
  largest: boolean;
  strategy: Strategy;
  /** Absolute path of the materialized snapshot; null for references. */
  snapshotPath: string | null;
}

export interface Manifest {
  schema: number;
  harvestedAtMs: number;
  dryRun: boolean;
  projectsRoot: string;
  survey: {
    sessions: number;
    projects: number;
    skippedLive: number;
    skippedSeeded: number;
    unreadable: number;
    totalBytes: number;
    sizePercentiles: { p50: number; p90: number; p99: number; max: number };
    classes: Record<SizeClass, { count: number; bytes: number }>;
    shapes: Record<ShapeTag, number>;
  };
  sessions: SurveyedSession[];
  selected: SelectedSnapshot[];
}

export interface HarvestOptions {
  projectsRoot?: string;
  sessionsDir?: string;
  outDir?: string;
  pins?: string[];
  dryRun?: boolean;
  log?: (line: string) => void;
}

async function statsForFile(path: string): Promise<SessionStats> {
  const acc = createStatsAccumulator();
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of rl) accumulateLine(acc, line);
  return acc.stats;
}

/** Session ids currently held by a live terminal. */
export function liveSessionIds(sessionsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(sessionsDir)) return ids;
  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(sessionsDir, entry), "utf8"));
      if (typeof raw?.sessionId === "string") ids.add(raw.sessionId);
    } catch {
      // A registry entry mid-write reads as absent.
    }
  }
  return ids;
}

/**
 * Pick the snapshot set: per class × primary shape the newest surveyed
 * session (those with at least one committed turn), every pin-prefix
 * match, and the single largest session in the population (the whale
 * policy's worst case).
 */
export function selectRepresentatives(
  sessions: SurveyedSession[],
  pins: string[],
): { session: SurveyedSession; pinned: boolean; largest: boolean }[] {
  const cells = new Map<string, SurveyedSession>();
  for (const s of sessions) {
    if (s.stats.turns < 1) continue;
    const key = `${s.class}/${s.primaryShape}`;
    const cur = cells.get(key);
    if (cur === undefined || s.mtimeMs > cur.mtimeMs) cells.set(key, s);
  }
  const picked = new Map<
    string,
    { session: SurveyedSession; pinned: boolean; largest: boolean }
  >();
  const add = (
    s: SurveyedSession,
    flags: { pinned?: boolean; largest?: boolean },
  ) => {
    const cur = picked.get(s.id) ?? { session: s, pinned: false, largest: false };
    picked.set(s.id, {
      session: s,
      pinned: cur.pinned || (flags.pinned ?? false),
      largest: cur.largest || (flags.largest ?? false),
    });
  };
  for (const s of cells.values()) add(s, {});
  for (const pin of pins) {
    // Several files can share a pinned id (a leaked harness seed is a
    // COPY of the real session, husks included) — snapshot only the
    // best candidate: most committed turns, then most bytes, and
    // never a zero-turn husk.
    let best: SurveyedSession | null = null;
    for (const s of sessions) {
      if (!s.id.startsWith(pin)) continue;
      if (s.stats.turns < 1) continue;
      if (
        best === null ||
        s.stats.turns > best.stats.turns ||
        (s.stats.turns === best.stats.turns && s.bytes > best.bytes)
      ) {
        best = s;
      }
    }
    if (best !== null) add(best, { pinned: true });
  }
  let biggest: SurveyedSession | null = null;
  for (const s of sessions) {
    if (biggest === null || s.bytes > biggest.bytes) biggest = s;
  }
  if (biggest !== null) add(biggest, { largest: true });
  return [...picked.values()].sort(
    (a, b) => a.session.bytes - b.session.bytes,
  );
}

export async function harvest(options: HarvestOptions = {}): Promise<Manifest> {
  const claudeHome = claudeHomeFromEnv();
  const projectsRoot = options.projectsRoot ?? claudeHome.projectsDir();
  const sessionsDir = options.sessionsDir ?? claudeHome.sessionsDir();
  const outDir = options.outDir ?? join(import.meta.dir);
  const pins = options.pins ?? DEFAULT_PINS;
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? (() => {});

  const live = liveSessionIds(sessionsDir);
  const sessions: SurveyedSession[] = [];
  let projects = 0;
  let skippedLive = 0;
  let skippedSeeded = 0;
  let unreadable = 0;

  const projectDirs = existsSync(projectsRoot)
    ? readdirSync(projectsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

  for (const dir of projectDirs) {
    if (SEEDED_PROJECT_DIR_PATTERN.test(dir)) {
      skippedSeeded += 1;
      continue;
    }
    const dirPath = join(projectsRoot, dir);
    let entries: string[];
    try {
      entries = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      unreadable += 1;
      continue;
    }
    if (entries.length > 0) projects += 1;
    for (const file of entries) {
      const id = basename(file, ".jsonl");
      if (live.has(id)) {
        skippedLive += 1;
        continue;
      }
      const sourcePath = join(dirPath, file);
      try {
        const st = statSync(sourcePath);
        const stats = await statsForFile(sourcePath);
        const tags = shapeTags(stats);
        sessions.push({
          id,
          projectDir: dir,
          sourcePath,
          bytes: st.size,
          mtimeMs: Math.round(st.mtimeMs),
          class: classifySize(st.size),
          shapes: tags,
          primaryShape: primaryShape(tags),
          stats,
        });
      } catch {
        unreadable += 1;
      }
    }
  }

  const sizes = sessions.map((s) => s.bytes);
  const classes: Manifest["survey"]["classes"] = {
    typical: { count: 0, bytes: 0 },
    heavy: { count: 0, bytes: 0 },
    whale: { count: 0, bytes: 0 },
  };
  const shapes: Manifest["survey"]["shapes"] = {
    "tool-heavy": 0,
    "thinking-heavy": 0,
    "image-bearing": 0,
    prose: 0,
  };
  for (const s of sessions) {
    classes[s.class].count += 1;
    classes[s.class].bytes += s.bytes;
    for (const tag of s.shapes) shapes[tag] += 1;
  }

  const snapshotsDir = join(outDir, "snapshots");
  const picked = selectRepresentatives(sessions, pins);
  const selected: SelectedSnapshot[] = [];
  if (!dryRun) {
    rmSync(snapshotsDir, { recursive: true, force: true });
    mkdirSync(snapshotsDir, { recursive: true });
  }
  for (const { session, pinned, largest } of picked) {
    let strategy: Strategy = session.class === "whale" ? "hardlink" : "copy";
    let snapshotPath: string | null = join(
      snapshotsDir,
      `${session.id}.jsonl`,
    );
    if (dryRun) {
      snapshotPath = null;
    } else if (strategy === "copy") {
      copyFileSync(session.sourcePath, snapshotPath);
    } else {
      try {
        linkSync(session.sourcePath, snapshotPath);
      } catch {
        strategy = "reference";
        snapshotPath = null;
      }
    }
    selected.push({ ...session, pinned, largest, strategy, snapshotPath });
  }

  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    harvestedAtMs: Date.now(),
    dryRun,
    projectsRoot,
    survey: {
      sessions: sessions.length,
      projects,
      skippedLive,
      skippedSeeded,
      unreadable,
      totalBytes: sizes.reduce((a, b) => a + b, 0),
      sizePercentiles: {
        p50: percentile(sizes, 50),
        p90: percentile(sizes, 90),
        p99: percentile(sizes, 99),
        max: sizes.length === 0 ? 0 : Math.max(...sizes),
      },
      classes,
      shapes,
    },
    sessions,
    selected,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const mb = (n: number) => `${(n / 1_000_000).toFixed(1)}MB`;
  const kb = (n: number) => `${(n / 1_000).toFixed(0)}KB`;
  log(
    `SURVEY sessions=${sessions.length} projects=${projects} ` +
      `totalBytes=${mb(manifest.survey.totalBytes)} skippedLive=${skippedLive} ` +
      `skippedSeeded=${skippedSeeded} unreadable=${unreadable}`,
  );
  log(
    `SIZES p50=${kb(manifest.survey.sizePercentiles.p50)} ` +
      `p90=${kb(manifest.survey.sizePercentiles.p90)} ` +
      `p99=${mb(manifest.survey.sizePercentiles.p99)} ` +
      `max=${mb(manifest.survey.sizePercentiles.max)}`,
  );
  for (const cls of ["typical", "heavy", "whale"] as const) {
    log(
      `CLASS ${cls}: count=${classes[cls].count} bytes=${mb(classes[cls].bytes)}`,
    );
  }
  for (const tag of Object.keys(shapes) as ShapeTag[]) {
    log(`SHAPE ${tag}: count=${shapes[tag]}`);
  }
  for (const s of selected) {
    log(
      `SELECTED ${s.id} class=${s.class} shape=${s.primaryShape} ` +
        `bytes=${s.bytes} turns=${s.stats.turns} strategy=${s.strategy}` +
        `${s.pinned ? " pinned" : ""}${s.largest ? " largest" : ""}`,
    );
  }
  return manifest;
}

function parseArgs(argv: string[]): HarvestOptions {
  const options: HarvestOptions = { pins: [...DEFAULT_PINS] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--projects-root":
        options.projectsRoot = argv[++i];
        break;
      case "--sessions-dir":
        options.sessionsDir = argv[++i];
        break;
      case "--out":
        options.outDir = argv[++i];
        break;
      case "--pin":
        options.pins!.push(argv[++i]);
        break;
      case "--quiet":
        options.log = () => {};
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (options.log === undefined) options.log = (line) => console.log(line);
  await harvest(options);
}

/**
 * at0749-body-evict-rebuild-reading.test.ts — what an evicted body costs to
 * bring back, by the length of its session.
 *
 * The body lifecycle brief wants bodies the deck can let go of while their
 * sessions work on, and brought back on reveal by the restore path: a new
 * page, `spawn_session(mode=resume)` on the live entry, and tugcode's replay
 * of the JSONL. Nobody has recorded what that costs for a long session. This
 * file does, three session lengths in three launches:
 *
 *  1. A JSONL of N turns of prose markdown is seeded where tugcode reads it,
 *     and a Session card resumes it — the first bind's replay, timed.
 *  2. The body's WebContent process is killed. The host reloads the view
 *     (`webContentProcessDidTerminate`), the body re-binds, the restore pass
 *     resumes the same session and the replay runs again: the kill to the
 *     body's `ready`, to its `visible`, and to the replay's completion, each
 *     timed, with the replay's own counters.
 *  3. Resident size of the body's process before the kill and after the
 *     rebuild, and of every WebContent process the app holds.
 *
 * The numbers are noted, not barred: the thresholds they inform are written
 * in the brief. What is asserted is that the arm runs end to end: the
 * rebuilt body comes back ready, visible and settled, and its replay
 * ingested the same number of frames the first one did.
 *
 * The body's process is found by its growth: the one WebContent whose
 * resident size grew most across the first replay. A kill that misses it is
 * caught, since A's body would never leave `ready`.
 *
 * `TUG_READING_TURNS` names the lengths, comma-separated (default
 * `50,200,500`).
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/body/body-main.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import { claudeProjectDir } from "../_harness/claude-home";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "../_harness/shapes";
import { pollFor, webContentProcesses, type WebContentProcess } from "../session-body-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const LENGTHS = (process.env.TUG_READING_TURNS ?? "50,200,500").split(",").map((s) => Number(s.trim()));

/** The body's first bind, a resume and a replay of up to 500 turns. */
const REPLAY_MS = 90_000;

interface ReplayPerf {
  startedAtMs: number;
  completedAtMs: number | null;
  frames: number;
  folds: number;
  commits: number;
  reduceMs: number;
  dispatchMs: number;
}

/** A paragraph of prose plus a list and a fence: the shape of a reply. */
function turnMarkdown(i: number): string {
  return [
    `### Turn ${i + 1}: the read on the ${["ledger", "router", "placer", "pacer"][i % 4]}`,
    "",
    `The ${i % 7 === 0 ? "second" : "first"} branch reads the cached value and returns early when it is fresh; the other walks the segment list, which is where the time went in the last reading. Nothing here is surprising, but the counts are worth writing down before the next change moves them.`,
    "",
    `- \`segments\`: ${120 + (i * 37) % 900} rows, ${3 + (i % 5)} dirty`,
    `- \`parsed\`: ${(i * 13) % 50} of them twice`,
    `- the walk: ${(i * 7) % 23 + 1} ms`,
    "",
    "```ts",
    `const fresh = cache.get(key${i});`,
    "if (fresh !== undefined) return fresh;",
    "return walk(segments).then(store);",
    "```",
    "",
    "The next step is to stop the second parse, which the row cache was meant to do and does not when the key is rebuilt per frame.",
  ].join("\n");
}

/** A session JSONL of `turns` turns, in claude's own line shape. */
function sessionJsonl(cwd: string, sessionId: string, turns: number): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const t0 = Date.now() - turns * 20_000 - 600_000;
  const lines: unknown[] = [];
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const user = uuid(i * 2 + 1);
    const assistant = uuid(i * 2 + 2);
    lines.push({
      ...base,
      parentUuid: parent,
      type: "user",
      uuid: user,
      timestamp: new Date(t0 + i * 20_000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `Read the ${["ledger", "router", "placer", "pacer"][i % 4]} again, turn ${i + 1}.` }] },
    });
    lines.push({
      ...base,
      parentUuid: user,
      type: "assistant",
      uuid: assistant,
      timestamp: new Date(t0 + i * 20_000 + 9_000).toISOString(),
      message: {
        id: `msg-at0749-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: turnMarkdown(i) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1_000 + i * 300,
          output_tokens: 220,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    parent = assistant;
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** The pid of the WebContent process that grew most from `before` to `after`. */
function grewMost(before: WebContentProcess[], after: WebContentProcess[]): WebContentProcess | null {
  const was = new Map(before.map((p) => [p.pid, p.rssKb]));
  let best: WebContentProcess | null = null;
  let growth = -Infinity;
  for (const p of after) {
    const g = p.rssKb - (was.get(p.pid) ?? 0);
    if (g > growth) {
      growth = g;
      best = p;
    }
  }
  return best;
}

const mb = (kb: number): number => Math.round(kb / 1024);
const totalMb = (ps: WebContentProcess[]): number => mb(ps.reduce((s, p) => s + p.rssKb, 0));

/** The replay the card's store finished last, or null while none has. */
const LAST_REPLAY_JS = `(function () {
  try {
    var p = window.__tug.getSessionPerf("A");
    var r = p.lastReplay || (p.replay && p.replay.completedAtMs !== null ? p.replay : null);
    return r && r.completedAtMs !== null && window.__tug.sessionSettled("A") ? r : null;
  } catch (e) { return null; }
})()`;

async function replayDone(app: App): Promise<ReplayPerf> {
  return app.body("A").waitForCondition<ReplayPerf>(LAST_REPLAY_JS, { timeoutMs: REPLAY_MS });
}

async function bodyA(app: App) {
  return (await app.bodies()).find((b) => b.cardId === "A") ?? null;
}

let projectDir = "";
let fixtureDir = "";
const sessionIds = new Map<number, string>();

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0749-proj-")));
  fixtureDir = claudeProjectDir(projectDir);
  mkdirSync(fixtureDir, { recursive: true });
  for (const turns of LENGTHS) {
    const sid = `a7c0d1ea-0749-4000-8000-${turns.toString().padStart(12, "0")}`;
    sessionIds.set(turns, sid);
    writeFileSync(join(fixtureDir, `${sid}.jsonl`), sessionJsonl(projectDir, sid, turns));
  }
});

afterAll(() => {
  for (const dir of [projectDir, fixtureDir]) {
    if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!SHOULD_RUN)("at0749 — an evicted body's rebuild, by session length", () => {
  for (const turns of LENGTHS) {
    test(
      `${turns} turns: the body comes back ready, visible and settled after its process is killed`,
      async () => {
        const app = await launchTugApp({ testName: `at0749-evict-${turns}` });
        try {
          const sid = sessionIds.get(turns)!;
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
          await pollFor(() => bodyA(app), (b) => b !== null && b.state === "ready", 30_000);

          // The first bind's replay.
          const beforeResume = webContentProcesses();
          const t0 = performance.now();
          await app.spawnSessionResume("A", { tugSessionId: sid, projectDir });
          const first = await replayDone(app);
          const firstMs = performance.now() - t0;
          const afterResume = webContentProcesses();
          const body = grewMost(beforeResume, afterResume);
          expect(body, "a WebContent process grew across the replay").not.toBeNull();
          note(
            `${turns} turns, first replay: resume→settled ${Math.round(firstMs)} ms; replay wall ${Math.round(
              (first.completedAtMs ?? 0) - first.startedAtMs,
            )} ms, frames ${first.frames}, folds ${first.folds}, commits ${first.commits}, reduce ${first.reduceMs.toFixed(1)} ms, dispatch ${first.dispatchMs.toFixed(1)} ms; body ${mb(body!.rssKb)} MB (pid ${body!.pid}); WebContent ${afterResume.length} processes, ${totalMb(afterResume)} MB`,
          );

          // The kill, and the rebuild.
          const pidsBeforeKill = new Set(afterResume.map((p) => p.pid));
          process.kill(body!.pid, "SIGKILL");
          const t1 = performance.now();
          const left = await pollFor(() => bodyA(app), (b) => b !== null && b.state !== "ready", 5_000);
          expect(left?.state, "A's body left ready: the kill hit its process").not.toBe("ready");
          const ready = await pollFor(() => bodyA(app), (b) => b !== null && b.state === "ready", 60_000);
          const readyMs = performance.now() - t1;
          const visible = await pollFor(() => bodyA(app), (b) => b !== null && b.visible, 10_000);
          const visibleMs = performance.now() - t1;
          let second: ReplayPerf | null = null;
          try {
            second = await replayDone(app);
          } catch {
            // Noted below as never settled; the assertion names it.
          }
          const settledMs = performance.now() - t1;
          const afterRebuild = webContentProcesses();
          const rebuilt = afterRebuild.find((p) => !pidsBeforeKill.has(p.pid)) ?? null;
          const replay =
            second === null
              ? "replay never settled"
              : `replay wall ${Math.round((second.completedAtMs ?? 0) - second.startedAtMs)} ms, frames ${second.frames}, folds ${second.folds}, commits ${second.commits}, reduce ${second.reduceMs.toFixed(1)} ms, dispatch ${second.dispatchMs.toFixed(1)} ms`;
          note(
            `${turns} turns, rebuild: kill→ready ${Math.round(readyMs)} ms (${ready?.state ?? "no body"}), →visible ${Math.round(
              visibleMs,
            )} ms (${String(visible?.visible)}, painted ${String(visible?.painted)}), →settled ${Math.round(settledMs)} ms; ${replay}; body ${
              rebuilt === null ? "(no new process)" : `${mb(rebuilt.rssKb)} MB (pid ${rebuilt.pid})`
            }; WebContent ${afterRebuild.length} processes, ${totalMb(afterRebuild)} MB`,
          );
          expect(ready?.state, "the rebuilt body is ready").toBe("ready");
          expect(visible?.visible, "the rebuilt body is visible").toBe(true);
          expect(second?.frames, "the rebuild replayed what the first bind did").toBe(first.frames);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});

/**
 * row-37-terminated.test.ts — a body whose process dies comes back ready,
 * shown and settled, with its draft and its last turns.
 *
 * The path stage 2's eviction rides, held green on its own. A Session card
 * resumes a transcript of plain turns, and a draft is typed in its composer
 * and saved to the run's tugbank file. Its WebContent process is killed. The
 * host reloads the view (`webContentProcessDidTerminate`), the body binds
 * again, the restore pass resumes the same session and the replay runs: the
 * body is back `ready` and `visible`, its transcript settled with the last
 * turn in it, and its composer holds the draft — all within the rebuild
 * bound, from the kill.
 *
 * The body's process is found by its growth: the one WebContent whose
 * resident size grew most across the resume. A kill that missed it is caught
 * at once, since the body would never leave `ready`.
 *
 * @foreground activation
 * @covers tugdeck/src/lib/session-restore.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { claudeProjectDir } from "../_harness/claude-home";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead } from "../_harness/tugbank-helpers";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { webContentProcesses, type WebContentProcess } from "../session-body-fixture";
import { bodyOf, composerText, focusBody, pollFor, sessionPane } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const A = "r37-a";
const TURNS = 50;
const DRAFT = "row37 draft before the kill";
/** The last turn's heading: in the transcript only once the replay has brought the end back. */
const LAST_TURN = `Turn ${TURNS}: the last reading`;
const CARDSTATE = "dev.tugapp.deck.cardstate";
/**
 * Kill to settled. The reading that set it (`at0749`) measured 470–500 ms at
 * 50, 200 and 500 turns; the bound doubles it.
 */
const REBUILD_BOUND_MS = 1_000;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** A session JSONL of `turns` plain turns, in claude's own line shape. */
function sessionJsonl(cwd: string, sessionId: string, turns: number): string {
  const base = { isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.105", gitBranch: "main" };
  const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const t0 = Date.now() - turns * 20_000 - 600_000;
  const lines: unknown[] = [];
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const user = uuid(i * 2 + 1);
    const assistant = uuid(i * 2 + 2);
    const heading = i === turns - 1 ? LAST_TURN : `Turn ${i + 1}: a reading`;
    lines.push({
      ...base,
      parentUuid: parent,
      type: "user",
      uuid: user,
      timestamp: new Date(t0 + i * 20_000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `Read it again, turn ${i + 1}.` }] },
    });
    lines.push({
      ...base,
      parentUuid: user,
      type: "assistant",
      uuid: assistant,
      timestamp: new Date(t0 + i * 20_000 + 9_000).toISOString(),
      message: {
        id: `msg-r37-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `### ${heading}\n\nThe walk took ${(i * 7) % 23 + 1} ms, and the cache held ${120 + ((i * 37) % 900)} rows.` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1_000 + i * 300, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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

/** In the body: whether its transcript is settled with the last turn in it. */
const SETTLED_WITH_LAST = `(function () {
  try {
    if (!window.__tug.sessionSettled(${JSON.stringify(A)})) return false;
    var t = document.querySelector('[data-testid="session-card-transcript"]');
    return t !== null && (t.textContent || "").indexOf(${JSON.stringify(LAST_TURN)}) >= 0;
  } catch (e) { return false; }
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 37: the terminated body", () => {
  test(
    "a Session body whose process is killed comes back ready, visible and settled, with its draft and its last turns",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r37-project-")));
      const fixtureDir = claudeProjectDir(projectDir);
      mkdirSync(fixtureDir, { recursive: true });
      onTestRunEnd(() => {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(fixtureDir, { recursive: true, force: true });
      });
      const sid = "a7c0d1ea-0037-4000-8000-000000000050";
      writeFileSync(join(fixtureDir, `${sid}.jsonl`), sessionJsonl(projectDir, sid, TURNS));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "body-grounding-row-37-terminated",
        foreground: true,
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready", 30_000);

        // ---- A resumed transcript and a draft, saved ----
        const beforeResume = webContentProcesses();
        await app.spawnSessionResume(A, { tugSessionId: sid, projectDir });
        await app.body(A).waitForCondition<boolean>(SETTLED_WITH_LAST, { timeoutMs: 30_000 });
        const victim = grewMost(beforeResume, webContentProcesses());
        expect(victim, "a WebContent process grew across the resume").not.toBeNull();
        await focusBody(app, A, { composer: true });
        await app.nativeType(DRAFT);
        await pollFor(() => app.body(A).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        const saved = await pollFor(
          async () => JSON.stringify(tugbankRead<unknown>(tugbankPath, CARDSTATE, A)?.value ?? null),
          (bag) => bag.includes(DRAFT),
          10_000,
        );
        expect(saved, "the draft is in the card's bag on disk before the kill").toContain(DRAFT);

        // ---- The kill, and the rebuild ----
        process.kill(victim!.pid, "SIGKILL");
        const killedAt = performance.now();
        const left = await pollFor(() => bodyOf(app, A), (b) => b !== null && b.state !== "ready", 5_000);
        expect(left?.state, "the body left ready: the kill hit its process").not.toBe("ready");
        const back = await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 10_000);
        const visibleMs = performance.now() - killedAt;
        await app.body(A).waitForCondition<boolean>(SETTLED_WITH_LAST, { timeoutMs: 10_000 });
        const settledMs = performance.now() - killedAt;
        const draft = await pollFor(() => app.body(A).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        note(`rebuild: kill → ready and visible ${Math.round(visibleMs)} ms, → settled with the last turn ${Math.round(settledMs)} ms (bound ${REBUILD_BOUND_MS} ms)`);
        expect(back, "the rebuilt body is ready and visible").toMatchObject({ state: "ready", visible: true });
        expect(draft, "the rebuilt body's composer holds the draft").toContain(DRAFT);
        expect(settledMs, "the rebuilt body settled with its last turn within the rebuild bound").toBeLessThan(REBUILD_BOUND_MS);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

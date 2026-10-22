/**
 * row-35-dormancy-open-bracket.test.ts — a body that sleeps inside a replay
 * bracket finishes that bracket when it is shown, rather than being reset.
 *
 * A Session card resumes a thirty-turn session and reads its last ten, with
 * twenty older behind them. Its workspace is parked, the body goes dormant,
 * and while it sleeps it pages five older turns in: the ask reaches tugcode,
 * the bracket opens on the page, and the rest of the bracket — sent while the
 * body's subscription is gone — never reaches it. Shown again, the body must
 * ask for that same page and take the answer as the open bracket's
 * completion: the five older turns stand above the ten, each once, and the
 * card is settled. A body reset to idle on its reveal instead asks only for
 * what follows its newest turn, and the page it asked for never lands.
 *
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/card-services-store.ts
 * @covers tugdeck/src/body/body-dormancy.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { claudeProjectDir } from "../_harness/claude-home";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, pollFor, settleFor, promptPhase, sessionPane } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r35b-a";
const CODE_OUTPUT_FEED = 0x40;
/** The body's delay before dormancy, shortened from a minute for the row. */
const DORMANT_AFTER_MS = 800;
const TURNS = 30;
/** The cold read's window, `DEFAULT_REPLAY_WINDOW_TURNS`. */
const COLD_WINDOW = 10;
/** The page the sleeping body asks for. */
const PAGE = 5;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

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
        id: `msg-r35b-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `Turn ${i + 1}: a reading — done.` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1_000 + i * 300, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    parent = assistant;
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** The oldest turn the cold read loads, the oldest the page loads, and the newest. */
const COLD_FIRST = TURNS - COLD_WINDOW + 1;
const PAGE_FIRST = COLD_FIRST - PAGE;

/**
 * How many times turn `n` (1-based) is in the card's transcript, read from the
 * store rather than the DOM: the list renders only the rows in view.
 */
const countOf = (n: number): string => `ids.filter(function (id) { return id === "msg-r35b-${n - 1}"; }).length`;

const READ = `(function () {
  var d = window.__tug.bodyDormancy();
  var ids = [];
  try { ids = window.__tug.inkRestoreFacts(${JSON.stringify(A)}).order.map(function (t) { return t.msgId; }); } catch (e) {}
  return { dormant: d.dormant, phase: ${promptPhase}, turns: ids.length, newest: ${countOf(TURNS)}, coldFirst: ${countOf(COLD_FIRST)}, pageFirst: ${countOf(PAGE_FIRST)}, beforePage: ${countOf(PAGE_FIRST - 1)}, firstHeld: ids[0] || null };
})()`;

interface Read {
  dormant: boolean;
  phase: string | null;
  turns: number;
  newest: number;
  coldFirst: number;
  pageFirst: number;
  beforePage: number;
  firstHeld: string | null;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 35: a bracket open at sleep", () => {
  test(
    "a body that sleeps inside a bracket completes it when shown, and is not reset",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r35b-project-")));
      const fixtureDir = claudeProjectDir(projectDir);
      mkdirSync(fixtureDir, { recursive: true });
      onTestRunEnd(() => {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(fixtureDir, { recursive: true, force: true });
      });
      const sid = "a7c0d1ea-0035-4000-8000-0000000000b5";
      writeFileSync(join(fixtureDir, `${sid}.jsonl`), sessionJsonl(projectDir, sid, TURNS));
      const app = await launchTugApp({ testName: "body-grounding-row-35-dormancy-open-bracket" });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.spawnSessionResume(A, { tugSessionId: sid, projectDir });
        const body = app.body(A);
        const read = await settleFor(() => body.evalJS<Read>(READ), (r) => r.newest === 1 && r.coldFirst === 1 && r.phase === "idle", 30_000);
        expect(read, "the cold read holds the last ten turns and nothing older").toMatchObject({ turns: COLD_WINDOW, newest: 1, coldFirst: 1, pageFirst: 0 });
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS });

        // ---- Parked; asleep, it pages older turns in, and the bracket opens ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        await pollFor(() => body.evalJS<Read>(READ), (r) => r.dormant, 5_000);
        await body.driveSession({ op: "loadPrevious", amount: PAGE });
        // The bracket's opener reached the page before its subscription went.
        await body.driveSession({ op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded: { tug_session_id: sid, type: "replay_started" } });
        await Bun.sleep(1_000);
        const asleep = await body.evalJS<Read>(READ);
        note(`asleep inside the bracket: ${JSON.stringify(asleep)}`);
        expect(asleep, "the page's answer, sent while the body slept, never reached it").toMatchObject({ dormant: true, pageFirst: 0 });

        // ---- Shown again: the page is asked again and completes the bracket ----
        const revealAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        const done = await settleFor(
          () => body.evalJS<Read>(READ),
          (r) => !r.dormant && r.phase === "idle" && r.pageFirst > 0,
          10_000,
        );
        note(`settled ${Date.now() - revealAt} ms after the switch: ${JSON.stringify(done)}`);
        expect(done, "the revealed body finished the page: awake, settled, the page's turns above the cold read's, each once").toMatchObject({
          dormant: false,
          phase: "idle",
          turns: COLD_WINDOW + PAGE,
          newest: 1,
          coldFirst: 1,
          pageFirst: 1,
          beforePage: 0,
          firstHeld: `msg-r35b-${PAGE_FIRST - 1}`,
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

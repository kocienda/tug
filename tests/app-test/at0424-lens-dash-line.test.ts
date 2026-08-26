/**
 * at0424-lens-dash-line.test.ts — dash progress rides the session's row at its
 * fixed height: the title cluster and the step ring, never a fourth line.
 *
 * The Cards section is organized by CARDS, so a dash's place in it is inside
 * the session that is on it. The row used to grow a fourth line when bound —
 * which made row height a function of binding state and broke consistency
 * with the masthead — and that line is retired ([D141]). What replaced it:
 *
 *  - The TITLE carries the progress cluster after the identity's own
 *    `^<dash>` run: the lifecycle track (`TugDashTrack`), whose cells are the
 *    dash's whole life from its brief to its join, and the `i/N` count
 *    (`TugStepFraction`) once step counters exist.
 *  - The INDICATOR stays the bare phase dot, whatever the dash is doing. It
 *    used to become a segmented step ring once counters existed; with the
 *    track on the title line that was two marks drawing one step count in two
 *    geometries. A dash says its progress in the track and nowhere else on
 *    this row, and the segmented ring now uniquely means a task list that is
 *    not a dash.
 *
 * The structural claims are pinned from both sides: binding never grows the
 * list by a cell or the row by a line, the retired dash-line slot never
 * renders, and the title says the dash's name exactly once.
 *
 * The counters' arrival is driven rather than assumed: the fixture dash
 * adopts a plan with no step started — the cluster then shows the stage glyph
 * alone — and a real `tugutil dash step … start` through the shell route is
 * what makes the fraction and the ring appear.
 *
 * Everything is real. `tugutil dash bind` runs through the card's own `$`
 * shell route (the route that stamps `TUG_SESSION_ID`), and the marks appear
 * because `bound_sessions` moved in the account-global aggregate the row's
 * own subscription reads. `dash unbind` takes them away the same way.
 *
 * @covers tugdeck/src/components/lens/sections/cards-data-source.ts
 * @covers tugdeck/src/components/lens/sections/cards-section.tsx
 * @covers tugdeck/src/components/lens/sections/cards-session-cell.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.css
 * @covers tugdeck/src/components/tugways/tug-step-ring.tsx
 * @covers tugdeck/src/components/tugways/tug-step-ring.css
 * @covers tugdeck/src/components/tugways/tug-dash-track.tsx
 * @covers tugdeck/src/components/tugways/tug-dash-track.css
 * @covers tugdeck/src/lib/dash-session-index.ts
 * @covers tugdeck/src/components/tugways/tug-session-row.tsx
 * @covers tugdeck/src/components/tugways/tug-session-row.css
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createDash,
  makeDashScratchRepo,
  recordAdoptedPlan,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugutilPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000424";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const CARDS = '.lens-section[data-lens-section="cards"]';
const SESSION_ROW = `${CARDS} [data-session-id="${SID}"]`;
const SESSION_ROW_DASH = `${SESSION_ROW} [data-slot="session-identity-dash"]`;
const DASH_NAME = "at0424-line";
/** The retired fourth line — pinned at zero forever. */
const DASH_LINE = `${SESSION_ROW} [data-slot="tug-session-row-dashline"]`;
const PROGRESS = `${SESSION_ROW} [data-slot="session-identity-row-progress"]`;
const TRACK = `${PROGRESS} [data-slot="tug-dash-track"]`;
const FRACTION = `${PROGRESS} [data-slot="tug-step-fraction"]`;
const RING = `${SESSION_ROW} [data-slot="tug-step-ring"]`;
const LIST_CELLS = `${CARDS} .tug-list-view-cell`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0424", checkout: CHECKOUT });
  const dash = createDash(projectDir(), DASH_NAME, "at0424 fixture", scratch.cli);
  // A plan adopted and no step started — the cluster shows the stage glyph
  // alone, and the counters replace nothing until a step opens.
  // Three rows, so the run this test declares below can cover only part of
  // the document — which is the shape where the numerals and the ring's band
  // answer different questions.
  recordAdoptedPlan(projectDir(), DASH_NAME, dash.worktree, {
    ...scratch.cli,
    rows: 3,
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const dashRunsOnSessionRow = (app: App): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(SESSION_ROW_DASH)}).length`,
  );

const listCellCount = (app: App): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(LIST_CELLS)}).length`,
  );

const count = (app: App, selector: string): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );

describe.skipIf(!SHOULD_RUN)("AT0424: dash progress on the session's row", () => {
  test(
    "binding grows the title by a cluster, not the row by a line",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0424-lens-dash-line",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so its dash reaches the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(await count(app, PROGRESS)).toBe(0);
        expect(await count(app, RING)).toBe(0);
        const bareCells = await listCellCount(app);

        // ── Bind, for real ────────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash bind ${DASH_NAME}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROGRESS)}) !== null`,
          { timeoutMs: 30000 },
        );

        const cluster = await app.evalJS<{
          insideSessionRow: boolean;
          onTitleLine: boolean;
          stage: string | null;
          stageWord: string | null;
          fractions: number;
          rings: number;
        }>(
          `(() => {
             const cluster = document.querySelector(${JSON.stringify(PROGRESS)});
             const session = document.querySelector(${JSON.stringify(SESSION_ROW)});
             const track = document.querySelector(${JSON.stringify(TRACK)});
             return {
               // The structural claim: the cluster is INSIDE the session's
               // row, on the title's own line.
               insideSessionRow: session.contains(cluster),
               onTitleLine:
                 cluster.closest(".tug-session-row-name-line") !== null,
               stage: track?.getAttribute("data-phase") ?? null,
               stageWord:
                 track
                   ?.querySelector('[data-state="active"]')
                   ?.getAttribute("data-phase") ?? null,
               fractions: document.querySelectorAll(${JSON.stringify(FRACTION)}).length,
               rings: document.querySelectorAll(${JSON.stringify(RING)}).length,
             };
           })()`,
        );
        note("at0424 cluster", JSON.stringify(cluster));
        expect(cluster.insideSessionRow).toBe(true);
        expect(cluster.onTitleLine).toBe(true);
        // The fixture's plan is adopted but no step has opened, so the track
        // reads `review` — the phase between a plan existing and a walk
        // beginning. The point is that the cluster says something at all here:
        // the stage glyph it replaced could only name what GIT had reached,
        // and drew nothing until a branch had rounds on it.
        expect(cluster.stage).toBe("review");
        // Exactly one cell is active, and it is that phase's.
        expect(cluster.stageWord).toBe("review");
        // No step started: no counters, so no fraction and no ring yet —
        // the dot stays a bare dot.
        expect(cluster.fractions).toBe(0);
        expect(cluster.rings).toBe(0);

        // The retired fourth line never renders, and the list did not grow a
        // row: same cells, same three lines, whatever the binding state.
        expect(await count(app, DASH_LINE)).toBe(0);
        expect(await listCellCount(app)).toBe(bareCells);

        // The row says the dash's name exactly once, in the title's identity
        // run — the sigil rides the session's name wherever it is named.
        expect(await dashRunsOnSessionRow(app)).toBe(1);
        note("at0424 lens with the cluster", (await app.screenshot()).path);

        // ── The step opens: the fraction and the ring arrive ──────────────
        await shellAndSettle(
          app,
          `${tugutilPath(CHECKOUT)} dash step ${DASH_NAME} start 1 --through 2`,
          1,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRACTION)}) !== null`,
          { timeoutMs: 30000 },
        );

        const stepped = await app.evalJS<{
          fraction: string;
          rings: number;
          phase: string | null;
          ticks: number;
          ticksActive: number;
          ticksDone: number;
          monitorDots: number;
        }>(
          `(() => {
             const fraction = document.querySelector(${JSON.stringify(FRACTION)});
             const track = document.querySelector(${JSON.stringify(TRACK)});
             const steps = track?.querySelector('[data-phase="implement"][data-steps="true"]');
             const ticks = steps ? Array.from(steps.children) : [];
             const state = (s) => ticks.filter((el) => el.getAttribute("data-state") === s).length;
             return {
               fraction: (fraction?.textContent ?? "").trim(),
               // The segmented ring is gone from a dash row entirely.
               rings: document.querySelectorAll(${JSON.stringify(RING)}).length,
               phase: track?.getAttribute("data-phase") ?? null,
               ticks: ticks.length,
               ticksActive: state("active"),
               ticksDone: state("done"),
               // ONE mark on the row, and it is the bare phase dot.
               monitorDots: document.querySelectorAll(
                 ${JSON.stringify(`${SESSION_ROW} .tug-session-row-dot [data-slot="tug-progress-indicator"]`)},
               ).length,
             };
           })()`,
        );
        note("at0424 with the step", JSON.stringify(stepped));
        // The numerals count the RUN — steps 1–2 were asked for, so the first
        // of them is `1/2`. They are real, selectable text, and they say
        // nothing about the three-row document behind them.
        expect(stepped.fraction).toBe("1/2");
        // The track says what the numerals cannot: the walk has begun, and the
        // plan holds three steps with the first of them open. That is the
        // document's whole shape, wordlessly — and it is the ONLY place this
        // row draws the step count now.
        expect(stepped.phase).toBe("implement");
        expect(stepped.ticks).toBe(3);
        expect(stepped.ticksActive).toBe(1);
        expect(stepped.ticksDone).toBe(0);
        // The step ring never appears on a dash row: two marks counting one
        // walk in two geometries is the thing this retired.
        expect(stepped.rings).toBe(0);
        // One dot on the row, and no ring around it.
        expect(stepped.monitorDots).toBe(1);
        // Still no fourth line, still the same cells.
        expect(await count(app, DASH_LINE)).toBe(0);
        expect(await listCellCount(app)).toBe(bareCells);
        note("at0424 lens with the walk begun", (await app.screenshot()).path);

        // ── Unbind, for real ──────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash unbind`, 2);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(PROGRESS)}).length === 0`,
          { timeoutMs: 30000 },
        );
        expect(await count(app, RING)).toBe(0);
        expect(await listCellCount(app)).toBe(bareCells);
        expect(await dashRunsOnSessionRow(app)).toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

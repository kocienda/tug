/**
 * at0484-dash-z2-instrument.test.ts — the Z2 DASH cell as an INSTRUMENT: two
 * dots, numbers before words, and a row that never moves.
 *
 * The cell is authored as STATE is — a dot pinned to each edge of the value
 * wrap and a reading centred between them — rather than as TASKS is, whose
 * glyphs and count live inside one indicator. That difference is the design,
 * so its shape is asserted structurally: three children in the wrap, an
 * indicator at each end, the reading in the middle.
 *
 * What it reads is a precedence, walked here in the order the code states it:
 *
 *  - **Numbers whenever there are numbers.** A reviewed plan nobody has
 *    started reads `0/4`, not a word — the plan's own pair, because no run is
 *    declared yet.
 *  - **The declared run wins** over the plan's pair once one exists: `1/2` on
 *    that same four-row plan ([D148]).
 *  - **The word is the lifecycle PHASE**, Title Case: `Brief` for a dash whose
 *    git stage is `created`, which is the half of a dash's life this cell used
 *    to draw a fallback glyph for.
 *  - **A poke says `Poke`**, not `Implement`: it has no plan and never will,
 *    so a phase word would name a stage of a lifecycle it does not have.
 *
 * **The widths are the row's promise, and they are read as the cells' own
 * `--tugx-session-status-cell-width`.** Binding takes the DASH cell from 14ch
 * to 18ch — STATE's width, for the word — and JOBS gives back exactly that,
 * 14ch to 10ch, so the five cells still sum to 80ch and nothing to the left of
 * the dash moves under the reader's eye. The custom property is what
 * `tug-status-cell.css` authors, it is un-animated, and it is what the
 * `@container` rungs are measured against; `offsetWidth` would fold in the
 * endcap wings and the 10px font and measure the wrong thing.
 *
 * The sum alone would be a vacuous assertion. `tug-status-cell.css` ends in
 * three `@container` rungs that hide cells with `display: none`, and a custom
 * property computes perfectly well on a hidden element — so a card narrow
 * enough to have dropped a cell would still sum to 80 while the row had
 * plainly moved. The pane is therefore fixed at 900×680, and every reading
 * also asserts each of the five cells computes a `display` other than `none`.
 * That check is what makes the sum a statement about the ROW.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/tug-status-cell.tsx
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 * @covers tugdeck/src/components/tugways/dash-lifecycle-mark.tsx
 * @covers tugdeck/src/components/tugways/tug-dash-track.tsx
 * @covers tugdeck/src/lib/dash-meta-facts.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindDash,
  createDash,
  dashBriefPath,
  dashPlanPath,
  makeDashScratchRepo,
  recordAdoptedPlan,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugutil,
  tugutilPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000484";

/** A four-row plan, reviewed and stamped, with no step started. */
const PLAN_DASH = "at0484-plan";
/** A brief and nothing else. */
const BRIEF_DASH = "at0484-brief";
/** No documents and no arc — the definition of a poke. */
const POKE_DASH = "at0484-poke";

const CARD = '[data-card-id="A"]';
const ROW = `${CARD} [data-slot="session-telemetry-status-row"]`;
const cell = (priority: string): string =>
  `${CARD} [data-slot="tug-status-cell"][data-priority="${priority}"]`;
const WRAP = `${cell("tasks")} .session-telemetry-status-value-wrap`;
const VALUE = `${cell("tasks")} [data-slot="session-telemetry-dash-value"]`;

/** The five cells, left to right, and the widths they hold with no dash up. */
const PRIORITIES = ["state", "time", "context", "tasks", "jobs"] as const;
/** The row's whole width, in `ch`. It is the same number in every reading. */
const ROW_WIDTH_CH = 80;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0484", checkout: CHECKOUT });
  // A plan adopted and stamped, with NO step started: no run is declared, so
  // the cell has only the plan's own pair to count — which is the reading that
  // proves numbers come before words.
  const plan = createDash(projectDir(), PLAN_DASH, "at0484 plan", scratch.cli);
  recordAdoptedPlan(projectDir(), PLAN_DASH, plan.worktree, {
    ...scratch.cli,
    rows: 4,
  });
  tugutil(["plan", "stamp", dashPlanPath(projectDir(), PLAN_DASH)], {
    cwd: projectDir(),
    binaryRoot: CHECKOUT,
    env: scratch.cli.env,
  });
  // A brief at its own address and nothing else: a lifecycle phase with no git
  // stage behind it.
  createDash(projectDir(), BRIEF_DASH, "at0484 brief", scratch.cli);
  writeFileSync(
    dashBriefPath(projectDir(), BRIEF_DASH),
    "# at0484 brief\n\nThe idea, before there is a plan for it.\n",
  );
  // A poke: a worktree and rounds, no documents, no arc. Nothing is written
  // for it beyond the dash itself, which is the whole point.
  createDash(projectDir(), POKE_DASH, "at0484 poke", scratch.cli);
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
        // Load-bearing, not incidental: below this the `@container` rungs in
        // `tug-status-cell.css` start hiding cells, and a hidden cell still
        // computes a width.
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

interface RowWidths {
  dash: string | null;
  cells: Record<string, { width: string; display: string }>;
}

/** Every cell's authored width and its computed display, plus the row's flag. */
const widths = (app: App): Promise<RowWidths> =>
  app.evalJS<RowWidths>(
    `(() => {
       const cells = {};
       for (const p of ${JSON.stringify(PRIORITIES)}) {
         const el = document.querySelector(
           '${CARD} [data-slot="tug-status-cell"][data-priority=' + JSON.stringify(p) + ']',
         );
         cells[p] = el === null
           ? { width: "", display: "" }
           : {
               width: getComputedStyle(el)
                 .getPropertyValue("--tugx-session-status-cell-width")
                 .trim(),
               display: getComputedStyle(el).display,
             };
       }
       const row = document.querySelector(${JSON.stringify(ROW)});
       return { dash: row === null ? null : row.getAttribute("data-dash"), cells };
     })()`,
  );

/** The row's total width in `ch`, from the same five reads. */
const sumCh = (reading: RowWidths): number =>
  PRIORITIES.reduce((total, p) => total + parseFloat(reading.cells[p].width), 0);

/** Every cell still stands — which is what makes the sum mean the ROW. */
const expectWholeRow = (reading: RowWidths): void => {
  for (const p of PRIORITIES) {
    expect(reading.cells[p].display).not.toBe("none");
  }
  expect(sumCh(reading)).toBe(ROW_WIDTH_CH);
};

const readingText = (app: App): Promise<string> =>
  app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(VALUE)})?.textContent ?? "").trim()`,
  );

/** Wait for the DASH face to say a given word. The cell reads TASKS for a
 *  beat after a bind, so every reading is preceded by one of these. */
const awaitReading = (app: App, text: string): Promise<boolean> =>
  app.waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(VALUE)})?.textContent ?? "").trim()
       === ${JSON.stringify(text)}`,
    { timeoutMs: 30000 },
  );

describe.skipIf(!SHOULD_RUN)("AT0484: the Z2 DASH instrument", () => {
  test(
    "two dots and a reading: numbers before words, and a row that never moves",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0484-dash-z2-instrument",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 20000 },
        );

        // ── With no dash up, the cell is TASKS at its own width ───────────
        const bare = await widths(app);
        note("at0484 bare row", JSON.stringify(bare));
        expect(bare.dash).toBeNull();
        expect(bare.cells.tasks.width).toBe("14ch");
        expect(bare.cells.jobs.width).toBe("14ch");
        expectWholeRow(bare);

        // ── A reviewed plan nobody has started: numbers, not a word ───────
        bindDash(projectDir(), PLAN_DASH, SID, {
          binaryRoot: CHECKOUT,
          env: scratch?.cli.env,
        });
        await awaitReading(app, "0/4");

        // The instrument's SHAPE, taken once — it does not change with the
        // reading, and asserting it four times would say nothing new.
        const shape = await app.evalJS<{
          children: number;
          first: string | null;
          middle: string | null;
          last: string | null;
        }>(
          `(() => {
             const wrap = document.querySelector(${JSON.stringify(WRAP)});
             const kids = wrap === null ? [] : Array.from(wrap.children);
             const slot = (n) => kids[n]?.getAttribute("data-slot") ?? null;
             return {
               children: kids.length,
               first: slot(0),
               middle: slot(1),
               last: slot(2),
             };
           })()`,
        );
        note("at0484 instrument shape", JSON.stringify(shape));
        // STATE's construction, not TASKS': a dot pinned to each edge with the
        // reading centred between them, as three siblings — never one
        // indicator carrying a label.
        expect(shape.children).toBe(3);
        expect(shape.first).toBe("tug-progress-indicator");
        expect(shape.middle).toBe("session-telemetry-dash-value");
        expect(shape.last).toBe("tug-progress-indicator");

        const bound = await widths(app);
        note("at0484 bound row", JSON.stringify(bound));
        // The cell takes STATE's 18ch for the word, and JOBS gives back
        // exactly that much — so nothing left of the dash moves.
        expect(bound.dash).toBe("true");
        expect(bound.cells.tasks.width).toBe("18ch");
        expect(bound.cells.jobs.width).toBe("10ch");
        expect(bound.cells.state.width).toBe(bare.cells.state.width);
        expect(bound.cells.time.width).toBe(bare.cells.time.width);
        expect(bound.cells.context.width).toBe(bare.cells.context.width);
        expectWholeRow(bound);

        // ── The label rule is centred over the value it names ─────────────
        // Every cell stacks two rows — the endcap-rule legend and the value —
        // and the two have to be the same box, or the legend sits off-centre
        // over its own reading. They used to be sized independently to one
        // `ch` budget, which held only while the reading fit that budget:
        // `None` between two dots does not fit the 10ch JOBS wears while a
        // dash is up, so it spilled out from under a rule that stayed put.
        // The budget is the CELL's `min-width` now and both rows stretch to
        // it, which cannot come apart ([D168]).
        const stacks = await app.evalJS<
          ReadonlyArray<{ priority: string; rule: number; value: number; cell: number; overflow: number }>
        >(
          `Array.from(document.querySelectorAll(${JSON.stringify(`${CARD} [data-slot="tug-status-cell"]`)})).map((el) => {
             const rule = el.querySelector(".session-telemetry-endcap-rule");
             const value = el.querySelector(".session-telemetry-status-value-wrap");
             const round = (n) => Math.round(n * 100) / 100;
             return {
               priority: el.getAttribute("data-priority") ?? "",
               rule: round(rule?.getBoundingClientRect().width ?? 0),
               value: round(value?.getBoundingClientRect().width ?? 0),
               cell: round(el.getBoundingClientRect().width),
               overflow: (value?.scrollWidth ?? 0) - (value?.clientWidth ?? 0),
             };
           })`,
        );
        note("at0484 stacks", JSON.stringify(stacks));
        expect(stacks.length).toBe(PRIORITIES.length);
        for (const stack of stacks) {
          expect(
            stack.rule,
            `${stack.priority}: the legend and the value are one box`,
          ).toBe(stack.value);
          expect(
            stack.value,
            `${stack.priority}: neither row is wider than the cell`,
          ).toBeLessThanOrEqual(stack.cell);
          expect(
            stack.overflow,
            `${stack.priority}: the reading does not spill out of its box`,
          ).toBeLessThanOrEqual(0);
        }

        // ── A declared run wins over the plan's own pair ──────────────────
        await shellAndSettle(
          app,
          `${tugutilPath(CHECKOUT)} dash step ${PLAN_DASH} start 1 --through 2`,
        );
        await awaitReading(app, "1/2");
        note("at0484 declared run", await readingText(app));

        // ── A dash with only a brief says the PHASE, not the git stage ────
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash bind ${BRIEF_DASH}`, 1);
        await awaitReading(app, "Brief");

        // ── A poke says Poke ─────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash bind ${POKE_DASH}`, 2);
        await awaitReading(app, "Poke");
        note("at0484 z2 at the poke reading", (await app.screenshot()).path);

        // ── Unbinding gives the width back ───────────────────────────────
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash unbind`, 3);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(VALUE)}) === null`,
          { timeoutMs: 30000 },
        );
        const unbound = await widths(app);
        note("at0484 unbound row", JSON.stringify(unbound));
        expect(unbound.dash).toBeNull();
        expect(unbound.cells.tasks.width).toBe("14ch");
        expect(unbound.cells.jobs.width).toBe("14ch");
        expectWholeRow(unbound);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0484-arc-z2-instrument.test.ts — the Z2 ARC cell as an INSTRUMENT: two
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
 *  - **A zero numerator is a word, never `0/N`.** A reviewed plan nobody has
 *    started reads `Review` — where the arc actually is, in the cell's short
 *    form of the line's `Awaiting review` — because a pair with nothing in
 *    hand counts work that has not begun ([B03]).
 *  - **The declared run wins** once a step is in hand: `1/2` on that same
 *    four-row plan ([D148]).
 *  - **The word is the lifecycle PHASE**, in the grammar the line reads in:
 *    `Briefed` for an arc whose git stage is `created`, which is the half of
 *    an arc's life this cell used to draw a fallback glyph for.
 *  - **A cut says `Cut`**, not `Implement`: it has no plan and never will,
 *    so a phase word would name a stage of a lifecycle it does not have.
 *
 * **The two dots are one reading, so they breathe as one.** The pair only
 * phase-locks by mounting in the same commit — the loops take their start
 * time from the style flush that gates them on. An unkeyed fragment let React
 * reconcile the ARC branch positionally against the TASKS indicator that was
 * in the same slot and carry its left glyph across, already breathing on an
 * older clock, while the right one started fresh. So the bare glyphs are
 * marked before the bind and neither may survive it.
 *
 * **The widths are the row's promise, and the promise is that the ROW does not
 * move.** Binding takes the ARC cell from 13ch to 17ch and the give-back comes
 * from JOBS as far as JOBS can go and from CONTEXT for the rest, so the five
 * cells and their gaps occupy the same row they did and nothing outside them
 * moves under the reader's eye.
 *
 * **And once bound, no reading moves a cell.** Every word-bearing cell is sized
 * from a widest reading declared beside the table that produces it — a hidden
 * face under the live text — so the box is the widest reading's from the first
 * paint and the reading swaps inside it ([D168]). This test walks the bound
 * session through every reading the ARC cell can show from the CLI and the
 * arc log alone — `Review`, `Reviewing`, `Executing`, a declared `1/2`,
 * `Auditing`, `Stopped`, `Briefed`, `Cut` — and asserts the five rendered
 * boxes are the same five numbers at each. Both nine-letter words are walked
 * because letters are not a width: `Reviewing` renders 2.69px wider than
 * `Executing` and is what the box is declared from, and only a rendered box
 * can say which of a tie is the tie-breaker. `Ready` is the one reading not
 * walked here; it
 * needs a joinable scratch and `at0559-ready-folded-form` owns it. This is the
 * assertion that would have caught `Implementing` widening the cell.
 *
 * The authored `--tugx-session-status-cell-width` is read alongside, because
 * it is what `tug-status-cell.css` states and what the `@container` rungs are
 * measured against — but it is not what the row is asserted in. A budget is a
 * `min-width` on two stretched rows, so a cell whose reading outgrows it
 * renders wider than it declares: JOBS's `None` between two dots does exactly
 * that at every budget it has ever held, which is how a `ch` sum that balanced
 * perfectly sat over a row 16px wider than the box holding it. The cells'
 * RENDERED boxes are the reading, and the row's own content box is what they
 * are held against.
 *
 * The fit alone would be a vacuous assertion. `tug-status-cell.css` ends in
 * three `@container` rungs that hide cells with `display: none`, and a hidden
 * cell occupies nothing — so a card narrow enough to have dropped a cell would
 * fit comfortably while the row had plainly moved. The pane is therefore fixed
 * at 900×680, and every reading also asserts each of the five cells computes a
 * `display` other than `none`. That check is what makes the fit a statement
 * about the ROW.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/tug-status-cell.tsx
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 * @covers tugdeck/src/components/tugways/arc-lifecycle-mark.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugdeck/src/lib/arc-meta-facts.ts
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
  appendArcLogLine,
  arcLogPath,
  bindArc,
  createArc,
  arcBriefPath,
  arcPlanPath,
  makeArcScratchRepo,
  recordAdoptedPlan,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000484";

/** A four-row plan, reviewed and stamped, with no step started. */
const PLAN_ARC = "at0484-plan";
/** A brief and nothing else. */
const BRIEF_ARC = "at0484-brief";
/** No documents and no arc — a direct arc with nothing to count. */
const LISTLESS_ARC = "at0484-listless";

const CARD = '[data-card-id="A"]';
const ROW = `${CARD} [data-slot="session-telemetry-status-row"]`;
const cell = (priority: string): string =>
  `${CARD} [data-slot="tug-status-cell"][data-priority="${priority}"]`;
const WRAP = `${cell("tasks")} .session-telemetry-status-value-wrap`;
const VALUE = `${cell("tasks")} [data-slot="session-telemetry-arc-value"]`;

/** The five cells, left to right, and the widths they hold with no arc up. */
const PRIORITIES = ["state", "time", "context", "tasks", "jobs"] as const;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0484", checkout: CHECKOUT });
  // A plan adopted and stamped, with NO step started: no run is declared, so
  // the cell has only the plan's own pair to count — which is the reading that
  // proves numbers come before words.
  const plan = createArc(projectDir(), PLAN_ARC, "at0484 plan", scratch.cli);
  recordAdoptedPlan(projectDir(), PLAN_ARC, plan.worktree, {
    ...scratch.cli,
    rows: 4,
  });
  tugtool(["plan", "stamp", arcPlanPath(projectDir(), PLAN_ARC)], {
    cwd: projectDir(),
    binaryRoot: CHECKOUT,
    env: scratch.cli.env,
  });
  // A brief at its own address and nothing else: a lifecycle phase with no git
  // stage behind it.
  createArc(projectDir(), BRIEF_ARC, "at0484 brief", scratch.cli);
  writeFileSync(
    arcBriefPath(projectDir(), BRIEF_ARC),
    "# at0484 brief\n\nThe idea, before there is a plan for it.\n",
  );
  // A worktree and nothing else: no documents, no arc, no task list. This is
  // the only shape left that shows the Z2 cell's word rather than a fraction.
  createArc(projectDir(), LISTLESS_ARC, "at0484 listless", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
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
  arc: string | null;
  cells: Record<string, { width: string; display: string; box: number }>;
  /** The gap between two cells, and the row's own content box. */
  gap: number;
  rowContent: number;
}

/**
 * Every cell's authored width, its computed display and its RENDERED box,
 * plus the row's own content box.
 *
 * The rendered box is what the claim is actually about. An authored budget is
 * a `min-width` on two stretched rows, so a cell whose reading is wider than
 * its budget renders wider than it declares — which is exactly JOBS, whose
 * `None` between two dots outgrows every budget it has ever been given. A
 * reading measured only in `ch` therefore says the row held still while the
 * row moved.
 */
const widths = (app: App): Promise<RowWidths> =>
  app.evalJS<RowWidths>(
    `(() => {
       const cells = {};
       for (const p of ${JSON.stringify(PRIORITIES)}) {
         const el = document.querySelector(
           '${CARD} [data-slot="tug-status-cell"][data-priority=' + JSON.stringify(p) + ']',
         );
         cells[p] = el === null
           ? { width: "", display: "", box: -1 }
           : {
               width: getComputedStyle(el)
                 .getPropertyValue("--tugx-session-status-cell-width")
                 .trim(),
               display: getComputedStyle(el).display,
               box: el.getBoundingClientRect().width,
             };
       }
       const row = document.querySelector(${JSON.stringify(ROW)});
       const rowStyle = row === null ? null : getComputedStyle(row);
       return {
         arc: row === null ? null : row.getAttribute("data-arc"),
         cells,
         gap: rowStyle === null ? -1 : parseFloat(rowStyle.gap),
         rowContent: row === null || rowStyle === null
           ? -1
           : row.getBoundingClientRect().width -
             parseFloat(rowStyle.paddingLeft) -
             parseFloat(rowStyle.paddingRight),
       };
     })()`,
  );

const readingText = (app: App): Promise<string> =>
  app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(VALUE)})?.textContent ?? "").trim()`,
  );

/** Wait for the ARC face to say a given word. The cell reads TASKS for a
 *  beat after a bind, so every reading is preceded by one of these. */
const awaitReading = (app: App, text: string): Promise<boolean> =>
  app.waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(VALUE)})?.textContent ?? "").trim()
       === ${JSON.stringify(text)}`,
    { timeoutMs: 30000 },
  );

describe.skipIf(!SHOULD_RUN)("AT0484: the Z2 ARC instrument", () => {
  test(
    "two dots and a reading: numbers before words, and a row that never moves",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0484-arc-z2-instrument",
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

        // ── With no arc up, the cell is TASKS at its own width ───────────
        const bare = await widths(app);
        note("at0484 bare row", JSON.stringify(bare));
        expect(bare.arc).toBeNull();

        // ── A reviewed plan nobody has started: the stage's word, not 0/4 ─
        // Mark the TASKS glyphs first: what makes the pair below a PAIR is
        // that both of them are new (see the header). The cell reads `—`
        // while the replay is inert, and that reading has no glyphs at all —
        // so wait for the pair that the ARC branch will displace.
        const TASKS_GLYPHS = `${cell("tasks")} [data-slot="tug-progress-pulsing-dot"]`;
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(TASKS_GLYPHS)}).length === 2`,
          { timeoutMs: 30000 },
        );
        const markedBefore = await app.evalJS<number>(
          `(() => {
             const dots = Array.from(document.querySelectorAll(${JSON.stringify(TASKS_GLYPHS)}));
             dots.forEach((el) => { el.dataset.at0484Before = "1"; });
             return dots.length;
           })()`,
        );
        expect(markedBefore).toBe(2);
        bindArc(projectDir(), PLAN_ARC, SID, {
          binaryRoot: CHECKOUT,
          env: scratch?.cli.env,
        });
        // No wheel drives this arc and no step is open, so the plan's own
        // pair would read `0/4` — the zero numerator Z2 never shows. The
        // track model places an unstarted plan at review, and that is the
        // word — in the cell's short form of the line's `Awaiting review`.
        await awaitReading(app, "Review");

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
        expect(shape.middle).toBe("session-telemetry-arc-value");
        expect(shape.last).toBe("tug-progress-indicator");

        // ── …and the two dots are welded ─────────────────────────────────
        // A glyph carried over from the TASKS indicator would be breathing on
        // whatever clock it started under, against a partner that started at
        // the bind — the pair reading as two mechanisms rather than one
        // status. Identity is the assertion that does not depend on catching
        // motion mid-cycle; the phases are compared too, whenever both dots
        // are actually breathing when the read lands.
        const pair = await app.evalJS<{
          count: number;
          inherited: number;
          progress: ReadonlyArray<number | null>;
        }>(
          `(() => {
             const dots = Array.from(document.querySelectorAll(${JSON.stringify(TASKS_GLYPHS)}));
             const breath = (el) => {
               const anim = el
                 .getAnimations({ subtree: true })
                 .find((a) => (a.animationName ?? "").includes("breathe"));
               const p = anim?.effect?.getComputedTiming().progress;
               return typeof p === "number" ? Math.round(p * 1000) / 1000 : null;
             };
             return {
               count: dots.length,
               inherited: dots.filter((el) => el.dataset.at0484Before === "1").length,
               progress: dots.map(breath),
             };
           })()`,
        );
        note("at0484 arc pair", JSON.stringify(pair));
        expect(pair.count).toBe(2);
        expect(pair.inherited, "neither dot outlived the TASKS reading").toBe(0);
        const [left, right] = pair.progress;
        if (left !== null && right !== null) {
          const gap = Math.abs(left - right);
          expect(
            Math.min(gap, 1 - gap),
            "the two dots breathe as one",
          ).toBeLessThan(0.05);
        }

        const bound = await widths(app);
        note("at0484 bound row", JSON.stringify(bound));
        // The cell takes what its widest face measures — `Executing` between
        // two dots — and the width comes back out of JOBS and CONTEXT, the two
        // cells with wings to spend. JOBS alone could not pay it: it is already
        // standing on its own reading, so four characters off its budget buy
        // 2px.
        expect(bound.arc).toBe("true");
        // Every bound reading below is held against this one: the five boxes
        // at `Review` are the five boxes at every other word and fraction.
        const boxesAt = (w: RowWidths): Record<string, number> =>
          Object.fromEntries(PRIORITIES.map((p) => [p, Math.round(w.cells[p].box * 100) / 100]));
        const boundBoxes = boxesAt(bound);
        const holdStill = async (reading: string): Promise<void> => {
          const now = await widths(app);
          note(`at0484 boxes at ${reading}`, JSON.stringify(boxesAt(now)));
          expect(now.arc, `${reading} is a bound row`).toBe("true");
          for (const p of PRIORITIES) {
            expect(now.cells[p].display, `${p} is drawn at ${reading}`).not.toBe("none");
          }
          expect(boxesAt(now), `the five boxes at ${reading}`).toEqual(boundBoxes);
        };

        // ── The label rule is centred over the value it names ─────────────
        // Every cell stacks two rows — the endcap-rule legend and the value —
        // and the two have to be the same box, or the legend sits off-centre
        // over its own reading. They used to be sized independently to one
        // `ch` budget, which held only while the reading fit that budget:
        // `None` between two dots does not fit the 10ch JOBS wears while a
        // arc is up, so it spilled out from under a rule that stayed put.
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

        // ── The review stage seated: the widest word the cell renders ─────
        // `Reviewing` and `Executing` are both nine letters, and letters are
        // not a width: in the cell's proportional face `Reviewing` is 2.69px
        // the wider, which is why `ARC_CELL_WIDEST_WORD` is declared from it
        // and not from its tie. The unit test's character count cannot see
        // that difference; this box can, and it is the assertion that found
        // it.
        const logPath = arcLogPath(scratch!.dataRoot);
        appendArcLogLine(logPath, PLAN_ARC, "arc-stage", `review ${SID} -`);
        await awaitReading(app, "Reviewing");
        await holdStill("Reviewing");

        // ── The implement stage seated, no step open: the phase's word ────
        // The stage line is the wheel's own record of seating the stage on
        // this card's session; with no step in hand there is no fraction, so
        // the cell says what the stage is doing, in the line's own verb.
        appendArcLogLine(logPath, PLAN_ARC, "arc-stage", `implement ${SID} -`);
        await awaitReading(app, "Executing");
        await holdStill("Executing");

        // ── A declared run wins over the plan's own pair ──────────────────
        await shellAndSettle(
          app,
          `${tugtoolPath(CHECKOUT)} arc step ${PLAN_ARC} start 1 --through 2`,
        );
        await awaitReading(app, "1/2");
        note("at0484 declared run", await readingText(app));
        await holdStill("1/2");

        // ── The audit stage seated: the audit's word, not the walk's count ─
        appendArcLogLine(logPath, PLAN_ARC, "arc-stage", `audit ${SID} -`);
        await awaitReading(app, "Auditing");
        await holdStill("Auditing");

        // ── A stop is one word on the cell ────────────────────────────────
        appendArcLogLine(logPath, PLAN_ARC, "arc-stop", "audit the audit did not mark");
        await awaitReading(app, "Stopped");
        await holdStill("Stopped");

        // ── An arc with only a brief says the PHASE, not the git stage ────
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} arc bind ${BRIEF_ARC}`, 1);
        await awaitReading(app, "Briefed");
        await holdStill("Briefed");

        // ── An arc with no documents at all says Cut ──────────────────────
        // The word is the last resort: a direct arc that wrote a task list
        // has a fraction to show, so only an arc with nothing to count — this
        // one, freshly created — ever reaches it.
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} arc bind ${LISTLESS_ARC}`, 2);
        await awaitReading(app, "Cut");
        await holdStill("Cut");
        note("at0484 z2 at the listless reading", (await app.screenshot()).path);

        // ── Unbinding gives the width back ───────────────────────────────
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} arc unbind`, 3);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(VALUE)}) === null`,
          { timeoutMs: 30000 },
        );
        const unbound = await widths(app);
        note("at0484 unbound row", JSON.stringify(unbound));
        expect(unbound.arc).toBeNull();
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

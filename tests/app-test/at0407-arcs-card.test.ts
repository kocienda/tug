/**
 * at0407-arcs-card.test.ts — the marks the Arcs card paints, over real
 * arcs.
 *
 * The card holds EVERY arc in every state ([D141]), and every row is one
 * `ArcLifecycleBlock`. Its eyebrow carries the arc atom, the hairline, and one
 * worker atom per bound session, and nothing else — an unbound arc shows no
 * worker atom and no phase dot anywhere on the row, because an arc with a
 * phase to report has a session bound to it and that session's atom is what
 * would carry the dot. The row's controls — the transport and the fold cue —
 * stand at the trailing edge of the LINE beneath it, in the block's
 * `lineTrailing` slot: they rode the eyebrow's end for a while, and at the
 * sidebar's width the two names paid for them in characters.
 *
 * Beneath the eyebrow, the lifecycle line says what the arc is DOING: the
 * track, the phase glyph, the fraction while a step is open, the phase in a
 * word, and the divergence facts. The track is the whole reading — an arc
 * driving a stepped plan stands at `implement` with one tick per plan row.
 * The step's TITLE is not on the line at all: it is the fraction's hover
 * sentence ([D168]).
 *
 * Two decisions of [D141] are pinned as absences: the arc pill wears no
 * review tint here (that yellow means WAITING, and an arc is not waiting for
 * anyone), and the doc+clock review glyph is retired from these rows —
 * review speaks through the identity run's tint and the join gates instead.
 *
 * The stage ordering rides along, because it needs two arcs at different
 * stages and this is the file that has them.
 *
 * And the row FOLDS: the cue at the line's end opens the block over the
 * plan's own ledger, rendered by the very component the `ARC` placard mounts,
 * so the row and the placard cannot disagree about one arc's steps. A row with
 * no steps draws the cue disabled — present, never absent — and a press on it
 * picks no row and fronts no card, which is the one claim about it that no
 * pure test can make.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.css
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.css
 * @covers tugdeck/src/components/tugways/arc-step-list.tsx
 * @covers tugdeck/src/components/tugways/arc-step-list.css
 * @covers tugdeck/src/components/tugways/body-kinds/affordances/block-fold-cue.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.css
 * @covers tugdeck/src/components/tugways/tug-step-fraction.tsx
 * @covers tugdeck/src/lib/changeset-all-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/arc-meta-facts.ts
 * @covers tugdeck/src/lib/arc-review.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  appendArcLogLine,
  arcBriefPath,
  arcLogPath,
  arcTasksPath,
  fixturePlanDocument,
  makeArcScratchRepo,
  recordStampedPlan,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000407";

const SECTION = '.arcs-section';
const ARC_NAME = "at0407-arc";
const ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${ARC_NAME}"]`;

/** The stepped arc — a second one, so the bare-arc assertions above keep
 *  reading an arc with no plan at all. */
const PLAN_ARC = "at0407-plan";
const PLAN_ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${PLAN_ARC}"]`;

/** A third arc, whose eight-row plan the run WALKED and whose seventh step it
 *  withdrew — the one shape where the closed rows are not a prefix. */
const SKIPPED_ARC = "at0407-skipped";
const SKIPPED_ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${SKIPPED_ARC}"]`;

/**
 * Two more, differing only in the kind their logs recorded.
 *
 * Both wear the shape their door actually leaves behind — a brief, a ledger,
 * and a run record — because that shape is the whole point. It used to be
 * read for the kind, on the premise that only the planned route wrote a
 * brief; both doors write one now, so the reading marked every arc planned
 * and drew a plain one the two cells it never had. The recorded kind is the
 * fact, and these two rows are where the card is asked to prove it reads it.
 */
const PLANNED_ARC = "at0407-planned";
const PLANNED_ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${PLANNED_ARC}"]`;
const PLAIN_ARC = "at0407-plain";
const PLAIN_ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${PLAIN_ARC}"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0407", checkout: CHECKOUT });
  createArc(projectDir(), ARC_NAME, "at0407 fixture", scratch.cli);
  const planned = createArc(projectDir(), PLAN_ARC, "at0407 plan fixture", scratch.cli);
  // A three-row plan whose declared run covers only the first two, so the
  // Arcs row's numerals and its ring answer different questions.
  recordStampedPlan(projectDir(), PLAN_ARC, planned.worktree, {
    ...scratch.cli,
    rows: 3,
    through: 2,
  });

  // An eight-row plan walked to the end, with step 7 withdrawn. Driven through
  // the real verbs rather than written into the ledger's cells, so what the
  // track paints is what `arc step withdraw` actually wrote — the whole chain
  // from the verb through the feed to the tick, in one fixture.
  const skipped = createArc(projectDir(), SKIPPED_ARC, "at0407 withdrawal fixture", scratch.cli);
  recordStampedPlan(projectDir(), SKIPPED_ARC, skipped.worktree, {
    ...scratch.cli,
    rows: 8,
    through: 8,
  });
  // Captured out of the closure: `scratch` is a module-level `let`, so the
  // narrowing this function body sits inside does not reach into a callback.
  const cli = scratch.cli;
  const step = (...args: string[]): void => {
    tugtool(["arc", "step", SKIPPED_ARC, ...args], {
      cwd: projectDir(),
      binaryRoot: cli.binaryRoot,
      env: cli.env,
    });
  };
  // `recordStampedPlan` already opened step 1 and declared the selection.
  // The commit cell is the branch tip, taken by omitting `--commit`: the verb
  // refuses a sha that resolves to nothing in the arc worktree, and a fixture
  // that makes no round has no sha of its own to name.
  step("done", "1");
  for (const n of [2, 3, 4, 5, 6]) {
    step("start", String(n), "--through", "8");
    step("done", String(n));
  }
  step("withdraw", "7");
  step("start", "8", "--through", "8");
  step("done", "8");

  // ── The two kinds, each as its own door leaves it ──────────────────────
  // The log line is appended rather than driven through `arc run`, which is
  // what writes it in life: the runner would seat a stage and start rotating
  // this arc, and the fixture wants the record without the machinery. It is
  // the same route `at0503` and `at0510` take, for the same reason.
  const log = arcLogPath(scratch.dataRoot);

  const planned2 = createArc(projectDir(), PLANNED_ARC, "at0407 planned fixture", cli);
  writeFileSync(arcBriefPath(projectDir(), PLANNED_ARC), "# at0407 planned brief\n");
  recordStampedPlan(projectDir(), PLANNED_ARC, planned2.worktree, {
    ...cli,
    rows: 2,
    through: 2,
  });
  appendArcLogLine(log, PLANNED_ARC, "arc-start", `.tug/arcs/${PLANNED_ARC}/plan.md`);
  appendArcLogLine(log, PLANNED_ARC, "arc-kind", "planned");

  // The plain arc carries a brief AND a run record — every clause the old
  // derivation read for `direct` is false here, so before the kind was on the
  // wire this row drew six cells. Its ledger is a task list, which is what
  // the plain door writes.
  createArc(projectDir(), PLAIN_ARC, "at0407 plain fixture", cli);
  writeFileSync(arcBriefPath(projectDir(), PLAIN_ARC), "# at0407 plain brief\n");
  writeFileSync(arcTasksPath(projectDir(), PLAIN_ARC), fixturePlanDocument(2));
  appendArcLogLine(log, PLAIN_ARC, "arc-start", `.tug/arcs/${PLAIN_ARC}/tasks.md`);
  appendArcLogLine(log, PLAIN_ARC, "arc-kind", "plain");

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

describe.skipIf(!SHOULD_RUN)("AT0407: the Arcs card", () => {
  test(
    "an unbound arc wears the eyebrow's verbs and never a dot",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-arcs-card",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning is what registers the
        // scratch repo as a workspace, so its arcs reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // ── The section is there, and the arc's row is in it ─────────────
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SECTION)}) !== null`,
          { timeoutMs: 15000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        const unbound = await app.evalJS<{
          atomText: string;
          reviewTinted: boolean;
          reviewGlyphs: number;
          glyphs: number;
          eyebrowGlyphs: number;
          workers: number;
          dots: number;
          bound: string | null;
          phase: string | null;
          note: string;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const atom = row.querySelector('[data-slot="tug-arc-lifecycle-name"]');
             const track = row.querySelector('[data-slot="tug-arc-track"]');
             const note = row.querySelector('[data-slot="tug-arc-lifecycle-note"]');
             return {
               atomText: (atom?.textContent ?? "").trim(),
               // The pill never wears the review tint here — that yellow
               // means WAITING, and an arc is not waiting for anyone.
               reviewTinted: atom?.hasAttribute("data-review") === true,
               reviewGlyphs: row.querySelectorAll('[data-slot="arcs-review"]').length,
               glyphs: row.querySelectorAll('[data-slot="tug-arc-phase-mark"]').length,
               eyebrowGlyphs: row.querySelectorAll(
                 '[data-slot="tug-arc-lifecycle-eyebrow"] [data-slot="tug-arc-phase-mark"]',
               ).length,
               workers: row.querySelectorAll('[data-slot="tug-arc-lifecycle-worker"]').length,
               dots: row.querySelectorAll('[data-slot="tug-progress-indicator"]').length,
               bound: row.getAttribute("data-bound"),
               phase: track?.getAttribute("data-phase") ?? null,
               note: (note?.textContent ?? "").trim(),
             };
           })()`,
        );
        note("at0407 unbound row", JSON.stringify(unbound));
        expect(unbound.atomText).toBe(`^${ARC_NAME}`);
        expect(unbound.reviewTinted).toBe(false);
        expect(unbound.reviewGlyphs).toBe(0);
        // The phase glyph is on the LINE and only there: the eyebrow is the
        // identities alone, and the verbs are on the row's right-click rather
        // than behind an opener that spent the eyebrow's right end.
        expect(unbound.glyphs).toBe(1);
        expect(unbound.eyebrowGlyphs).toBe(0);
        expect(unbound.workers).toBe(0);
        // No phase dot on a row nobody works: an arc with a phase to report
        // has a session bound to it, and that session's atom carries the dot.
        expect(unbound.dots).toBe(0);
        expect(unbound.bound).toBeNull();
        // A freshly created arc has no documents and no arc, so the track
        // reads it as direct: nothing has happened to it yet but the work
        // itself. With no step open the line is the phase clause and nothing
        // more — the line has no empty state.
        expect(unbound.phase).toBe("implement");
        // The clause is the phase said as a verb in progress, never the enum
        // key the field above carries — spelled out rather than derived from
        // it, which is the whole point of the two being different words.
        expect(unbound.note).toBe("Executing");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a stepped plan fills the meta line, and stage rank orders the rows",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-arcs-meta",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // The scratch repo enters the aggregate only as a registered
        // workspace, and spawning a session on it is what registers it.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLAN_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        const meta = await app.evalJS<{
          phase: string | null;
          fraction: string;
          tracks: number;
          ticks: string[];
          noteText: string;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(PLAN_ROW)});
             const track = row.querySelector('[data-slot="tug-arc-track"]');
             const fraction = row.querySelector('[data-slot="tug-step-fraction"]');
             const note = row.querySelector('[data-slot="tug-arc-lifecycle-note"]');
             const cell = track?.querySelector(
               '[data-slot="tug-arc-track-cell"][data-phase="implement"]',
             );
             return {
               phase: track?.getAttribute("data-phase") ?? null,
               fraction: (fraction?.textContent ?? "").trim(),
               tracks: row.querySelectorAll('[data-slot="tug-arc-track"]').length,
               ticks: cell
                 ? Array.from(cell.querySelectorAll(".tug-arc-track-tick")).map(
                     (el) => el.getAttribute("data-state"),
                   )
                 : [],
               noteText: (note?.textContent ?? "").trim(),
             };
           })()`,
        );
        note("at0407 stepped meta line", JSON.stringify(meta));
        // A step is open on this arc, so the strip stands at `implement`.
        expect(meta.phase).toBe("implement");
        expect(meta.tracks).toBe(1);
        // The numerals count the PLAN — the step in progress over the rows the
        // plan holds. The track draws that same plan as ticks, one per row, so
        // the two readings cannot disagree.
        expect(meta.fraction).toBe("1/3");
        expect(meta.ticks).toEqual(["active", "pending", "pending"]);
        // The clause is the PHASE, not the step's title: the title rode this
        // slot until it elided mid-word in every host that was not the
        // placard, and it is the fraction's hover sentence now ([D168]).
        expect(meta.noteText).toBe("Executing");
        note("at0407 meta line", await app.screenshot().then((s) => s.path));

        // ── A withdrawn step paints its own tick, and the count agrees ────
        // The one shape a prefix reading cannot draw: step 7 of 8 withdrawn
        // and step 8 done, so the closed rows are not a run of the first N.
        // Nothing pure can see this — the tooltip's fraction and the ticks
        // beside it have to agree ON SCREEN, which is [P03]'s whole promise.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SKIPPED_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        const skippedTicks = await app.evalJS<string[]>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(SKIPPED_ROW)});
             const cell = row
               .querySelector('[data-slot="tug-arc-track"]')
               ?.querySelector('[data-slot="tug-arc-track-cell"][data-phase="implement"]');
             return cell
               ? Array.from(cell.querySelectorAll(".tug-arc-track-tick")).map(
                   (el) => el.getAttribute("data-state"),
                 )
               : [];
           })()`,
        );
        note("at0407 withdrawn ticks", JSON.stringify(skippedTicks));
        expect(skippedTicks).toEqual([
          "done",
          "done",
          "done",
          "done",
          "done",
          "done",
          "withdrawn",
          "done",
        ]);
        note("at0407 withdrawn tick", await app.screenshot().then((s) => s.path));

        // ── The block's two lines are related by their centre ─────────────
        // The eyebrow anchors an identity to each edge; the line under it
        // centres its whole run — track, then glyph, fraction, word, facts —
        // as one unit. The line used to hang under the arc's NAME instead,
        // which was the right rule while it packed everything against its
        // leading edge.
        //
        // The line shares its row with the controls now — the transport and
        // the fold cue stand at the row's trailing edge, in the block's
        // `lineTrailing` slot — so the box this measures is the line's own,
        // which is the width left of the controls, and the claim is that the
        // run is centred INSIDE it. That is the seat's rule: the reading
        // keeps its relation to the eyebrow's centre, and the controls stand
        // in a fixed column beside it.
        //
        // Measured as the air on either side of the run rather than against a
        // constant, so retuning the row's density or the atom's padding moves
        // the expectation with it, and so the claim is the UNIT's centring
        // rather than the track's. A pixel of tolerance: an odd width has to
        // round somewhere.
        const stack = await app.evalJS<{
          lead: number;
          tail: number;
          fontSize: string;
          readScale: string;
          leadInset: number;
          tailInset: number;
          gestures: number;
          blocks: number[][];
        }>(
          `(() => {
             const rows = Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION} [data-slot="arcs-row"]`)}));
             const first = rows[0];
             const line = first.querySelector('[data-slot="tug-arc-lifecycle-line"]');
             const box = line.getBoundingClientRect();
             const track = line.querySelector('[data-slot="tug-arc-track"]').getBoundingClientRect();
             const read = line.querySelector('[data-slot="tug-arc-lifecycle-reading"]').getBoundingClientRect();
             const rowBox = first.getBoundingClientRect();
             const block = first.querySelector('[data-slot="tug-arc-lifecycle-block"]').getBoundingClientRect();
             const R = (n) => Math.round(n * 10) / 10;
             return {
               lead: R(track.left - box.left),
               tail: R(box.right - read.right),
               fontSize: getComputedStyle(line).fontSize,
               readScale: getComputedStyle(document.body).getPropertyValue("--tug-font-size-sm").trim(),
               leadInset: R(block.left - rowBox.left),
               tailInset: R(rowBox.right - block.right),
               gestures: document.querySelectorAll('[data-slot="lens-plans-gesture"]').length,
               blocks: rows.map((r) => {
                 const b = r.getBoundingClientRect();
                 return [Math.round(b.top), Math.round(b.bottom)];
               }),
             };
           })()`,
        );
        note("at0407 stack", JSON.stringify(stack));
        // The card shows a whole arc, so it shows it at the scale every other
        // whole-arc surface uses — the placard's, the shade's. There is no
        // second scale to select any more, so the measured type size IS the
        // claim: a block that had drifted off the reading token would say so
        // here, and an attribute could only have said which name was set.
        expect(
          stack.fontSize,
          "the line is sized to the reading scale's token",
        ).toBe(stack.readScale);
        // The block's two identities are held apart by a hairline, so the air
        // outside them has to be even: `TugListRow` reserves a leading focus
        // gutter the trailing edge does not, and the pair read as leaning
        // toward the row's right edge. The BLOCK's box is the measure, so the
        // claim holds for an unbound arc too, whose eyebrow ends in the
        // hairline rather than in a worker atom. What the reader sees on a
        // BOUND row — the arc pill's leading margin against the worker
        // atom's trailing one — is at0438's, which has one.
        expect(
          Math.abs(stack.leadInset - stack.tailInset),
          "the block's inline air is even at both ends",
        ).toBeLessThanOrEqual(1);
        // And no plan row wears a next-gesture button: it read as a label
        // rather than a control, and the row reports rather than acts.
        // The slot keeps its retired spelling deliberately: it is the name the
        // button was emitted under, and a guard against re-introduction has to
        // name what would come back.
        expect(stack.gestures, "no next-gesture button survives").toBe(0);
        expect(
          Math.abs(stack.lead - stack.tail),
          "the run — track then reading — is centred in the line",
        ).toBeLessThanOrEqual(1);
        expect(
          stack.lead,
          "and it is a centred run, not a line filled edge to edge",
        ).toBeGreaterThan(1);

        // And one arc is separated from the next by a real step, not a
        // hairline. At 2px of block padding the two-line blocks touched, and
        // the second line of one arc sat as close to the eyebrow of the next
        // as to its own — which is what makes a block stop reading as a unit.
        if (stack.blocks.length >= 2) {
          const gap = stack.blocks[1]![0]! - stack.blocks[0]![1]!;
          const height = stack.blocks[0]![1]! - stack.blocks[0]![0]!;
          // Rows are flush, so the air lives inside them: what has to hold is
          // that a block is tall enough to carry a full step of padding around
          // its two lines.
          expect(gap, "rows are flush; the air is the block's own").toBe(0);
          expect(height, "each block carries a step of air").toBeGreaterThan(48);
        }

        // ── The ordering, in the DOM ──────────────────────────────────────
        // Both fixtures are unbound, so the stage rank decides: this arc is
        // `implementing` (a step is open on it), the other is `created`.
        const order = await app.evalJS<string[]>(
          `Array.from(
             document.querySelectorAll(${JSON.stringify(`${SECTION} [data-slot="arcs-row"]`)}),
           ).map((el) => el.getAttribute("data-arc"))`,
        );
        expect(order.indexOf(PLAN_ARC)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(ARC_NAME)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(PLAN_ARC)).toBeLessThan(order.indexOf(ARC_NAME));

        // ── The fraction beside those ticks says `closed`, not `done` ─────
        // A tooltip, so it has to be hovered — and it is read last, because a
        // Radix bubble does not close for a synthetic `pointerleave` and a
        // test that waited for it to would be waiting on nothing.
        await app.evalJS<null>(
          `(function(){
             const cell = document
               .querySelector(${JSON.stringify(SKIPPED_ROW)})
               .querySelector('[data-slot="tug-arc-track-cell"][data-phase="implement"]');
             cell.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
             cell.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
             return null;
           })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-tooltip-content') !== null`,
          { timeoutMs: 5000 },
        );
        const closedTip = await app.getElementText(".tug-tooltip-content");
        note("at0407 withdrawn tip", closedTip);
        // Eight ticks and eight closed, agreeing on screen — a reader is never
        // told 7 of 8 beside eight filled ticks. This is [P03]'s whole promise
        // and the one thing no pure test can see. A closed cell says its
        // count as the participle's object — `Executed · 8 steps` ([B09]).
        expect(closedTip).toContain("Executed · 8 steps");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the recorded kind picks the track's cells and puts no word on the line",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-arcs-kind",
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
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLANNED_ROW)}) !== null &&
           document.querySelector(${JSON.stringify(PLAIN_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        // One reader over both rows, so the two are compared rather than
        // asserted apart: what matters is the DIFFERENCE the kind makes, and
        // a claim read off one row alone cannot show it.
        const read = (selector: string): string =>
          `(() => {
             const row = document.querySelector(${JSON.stringify(selector)});
             const track = row.querySelector('[data-slot="tug-arc-track"]');
             return {
               phases: Array.from(
                 track.querySelectorAll('[data-slot="tug-arc-track-cell"]'),
               ).map((el) => el.getAttribute("data-phase")),
               facts: Array.from(
                 row.querySelectorAll('[data-slot="tug-arc-lifecycle-fact"]'),
               ).map((el) => ({
                 key: el.getAttribute("data-fact"),
                 tone: el.getAttribute("data-tone"),
                 label: (el.textContent ?? "").trim(),
               })),
             };
           })()`;
        type Row = {
          phases: string[];
          facts: Array<{ key: string; tone: string; label: string }>;
        };
        const planned = await app.evalJS<Row>(read(PLANNED_ROW));
        const plain = await app.evalJS<Row>(read(PLAIN_ROW));
        note("at0407 planned row", JSON.stringify(planned));
        note("at0407 plain row", JSON.stringify(plain));

        // ── The word ──────────────────────────────────────────────────────
        // There is none. The kind is the cell set, and the fact that carries
        // the word is dropped by the line — a planned row's note used to
        // trail `planned` with nothing between them, so a stopped audit read
        // `stopped · audit did not mark planned`. Asserted over the whole
        // fact list on both rows, so the kind under any spelling is caught.
        const kindFact = (row: Row) => row.facts.find((f) => f.key === "kind");
        expect(kindFact(planned)).toBeUndefined();
        expect(planned.facts.map((f) => f.label)).not.toContain("planned");
        expect(plain.facts.map((f) => f.label)).not.toContain("plain");
        expect(kindFact(plain)).toBeUndefined();

        // ── The cells ─────────────────────────────────────────────────────
        // The two sets differ by devise and review alone, and the plain row is
        // the one that moved: it carries a brief and a run record, so every
        // clause of the old derivation was false and it drew all six.
        expect(planned.phases).toEqual([
          "brief",
          "devise",
          "review",
          "implement",
          "audit",
          "join",
        ]);
        expect(plain.phases).toEqual(["brief", "implement", "audit", "join"]);
        // The audit cell is drawn on both routes deliberately — what a run
        // does after its last commit is the same work whoever asked for it.
        expect(plain.phases).toContain("audit");
        note("at0407 kind rows", await app.screenshot().then((s) => s.path));
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the row folds open to the plan's own ledger, and the press picks nothing",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-arcs-fold",
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
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLAN_ROW)}) !== null &&
           document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        // ── The cue is on the arc with a ledger, and on no other ──────────
        // Every row draws the cue, at the same edge of its line — a row with nothing to
        // fold draws it disabled rather than dropping it, so the column of
        // chevrons never goes ragged. `at0407-arc` was created and never
        // planned, so it is that row.
        const cues = await app.evalJS<{
          planned: number;
          bare: number;
          bareDisabled: boolean | null;
          label: string | null;
          expanded: string | null;
          lists: number;
        }>(
          `(() => {
             const planned = document.querySelector(${JSON.stringify(PLAN_ROW)});
             const bare = document.querySelector(${JSON.stringify(ROW)});
             const cue = planned.querySelector('[data-slot="arcs-steps-fold"]');
             const bareCue = bare.querySelector('[data-slot="arcs-steps-fold"]');
             return {
               planned: planned.querySelectorAll('[data-slot="arcs-steps-fold"]').length,
               bare: bare.querySelectorAll('[data-slot="arcs-steps-fold"]').length,
               bareDisabled: bareCue === null ? null : bareCue.hasAttribute("disabled"),
               label: cue?.getAttribute("aria-label") ?? null,
               expanded: cue?.getAttribute("aria-expanded") ?? null,
               lists: planned.querySelectorAll('[data-slot="arcs-steps"]').length,
             };
           })()`,
        );
        note("at0407 fold cues", JSON.stringify(cues));
        expect(cues.planned, "an arc with a ledger carries the cue").toBe(1);
        expect(cues.bare, "an arc with no steps carries one too").toBe(1);
        expect(cues.bareDisabled, "and it is disabled, having nothing to fold").toBe(true);
        // The cue names its arc, because a card full of rows offers a screen
        // reader a great many chevrons that would otherwise read alike.
        expect(cues.label).toContain(PLAN_ARC);
        // Every row starts collapsed: the card stays a list at a glance.
        expect(cues.expanded).toBe("false");
        expect(cues.lists, "and nothing is mounted beneath it yet").toBe(0);

        // What the row would disturb if the press reached it — read BEFORE,
        // so the claim below is that neither moved rather than that both hold
        // some remembered constant.
        const focusedBefore = await app.getFocusedCardId();
        const selectedBefore = await app.evalJS<string[]>(
          `Array.from(
             document.querySelectorAll(${JSON.stringify(`${SECTION} [data-selected="true"]`)}),
           ).map((el) => el.getAttribute("data-arc") ?? el.className)`,
        );

        // ── The press ────────────────────────────────────────────────────
        await app.click(`${PLAN_ROW} [data-slot="arcs-steps-fold"]`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${PLAN_ROW} [data-slot="arcs-steps"]`)}) !== null`,
          { timeoutMs: 10000 },
        );

        const opened = await app.evalJS<{
          rows: Array<{ status: string | null; dot: string | null; text: string }>;
          expanded: string | null;
          ticks: string[];
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(PLAN_ROW)});
             const list = row.querySelector('[data-slot="arcs-steps"]');
             const cue = row.querySelector('[data-slot="arcs-steps-fold"]');
             const cell = row
               .querySelector('[data-slot="tug-arc-track"]')
               ?.querySelector('[data-slot="tug-arc-track-cell"][data-phase="implement"]');
             return {
               rows: Array.from(list.querySelectorAll('[data-slot="arc-step"]')).map((el) => ({
                 status: el.getAttribute("data-status"),
                 dot: el
                   .querySelector('[data-slot="tug-progress-indicator"]')
                   ?.getAttribute("data-state") ?? null,
                 text: (el.textContent ?? "").trim(),
               })),
               expanded: cue?.getAttribute("aria-expanded") ?? null,
               ticks: cell
                 ? Array.from(cell.querySelectorAll(".tug-arc-track-tick")).map(
                     (el) => el.getAttribute("data-state"),
                   )
                 : [],
             };
           })()`,
        );
        note("at0407 folded open", JSON.stringify(opened));
        expect(opened.expanded).toBe("true");
        // One row per ledger line, each carrying its ordinal and its title —
        // the plan's own spelling, nothing derived. This fixture's plan holds
        // three rows with the first one open.
        expect(opened.rows.map((r) => r.text)).toEqual([
          "1.The only step",
          "2.The second step",
          "3.The third step",
        ]);
        // And the status the entry carries, which is the same fact the track
        // beside it paints: the row and its ticks read one ledger.
        expect(opened.rows.map((r) => r.status)).toEqual([
          "in progress",
          "pending",
          "pending",
        ]);
        expect(opened.ticks).toEqual(["active", "pending", "pending"]);

        // And nothing on this row breathes. `in progress` is a cell somebody
        // wrote into a document, and this fixture's arc has no wheel running
        // it and no holder working — so the ledger says step 1 is under way
        // and the glyph declines to claim it is happening right now. The tick
        // above still paints `active`, because where the walk stands and
        // whether anybody is walking it are two different facts.
        expect(opened.rows.map((r) => r.dot)).toEqual([
          "stopped",
          "stopped",
          "stopped",
        ]);

        // ── And the press picked nothing ─────────────────────────────────
        // The list commits selection at pointerdown and excuses any
        // descendant that refuses focus, so a control inside a row never
        // reaches the delegate. Nothing was fronted and nothing was selected —
        // the claim that needs the real app, since the excusing happens in the
        // list's own pointer handling.
        const focusedAfter = await app.getFocusedCardId();
        const selectedAfter = await app.evalJS<string[]>(
          `Array.from(
             document.querySelectorAll(${JSON.stringify(`${SECTION} [data-selected="true"]`)}),
           ).map((el) => el.getAttribute("data-arc") ?? el.className)`,
        );
        expect(focusedAfter, "the press fronted no card").toBe(focusedBefore);
        expect(selectedAfter, "and picked no row").toEqual(selectedBefore);
        note("at0407 folded row", await app.screenshot().then((s) => s.path));

        // ── Folding again unmounts it ────────────────────────────────────
        // Structure, not appearance: an arc nobody has opened costs no ledger
        // DOM at all, which is why this is a presence claim rather than a
        // visibility one.
        await app.click(`${PLAN_ROW} [data-slot="arcs-steps-fold"]`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${PLAN_ROW} [data-slot="arcs-steps"]`)}) === null`,
          { timeoutMs: 10000 },
        );
        const closedCue = await app.evalJS<string | null>(
          `document
             .querySelector(${JSON.stringify(`${PLAN_ROW} [data-slot="arcs-steps-fold"]`)})
             ?.getAttribute("aria-expanded") ?? null`,
        );
        expect(closedCue).toBe("false");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

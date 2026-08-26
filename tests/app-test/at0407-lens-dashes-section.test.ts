/**
 * at0407-lens-dashes-section.test.ts — the marks the Lens's Dashes section
 * paints, over real dashes.
 *
 * The section holds EVERY dash in every state ([D141]), and every row is one
 * `DashLifecycleBlock`. Its eyebrow carries the dash atom, the hairline, one
 * worker atom per bound session, and the row's menu opener — an unbound dash
 * shows no worker atom and no phase dot anywhere on the row, because a dash
 * with a phase to report has a session bound to it and that session's atom is
 * what would carry the dot.
 *
 * Beneath the eyebrow, the lifecycle line says what the dash is DOING: the
 * track, the fraction while a step is open, the note, and the divergence
 * facts. The track is the whole reading — a dash driving a stepped plan
 * stands at `implement` with one tick per plan row, and the note is that
 * step's title.
 *
 * Two decisions of [D141] are pinned as absences: the dash pill wears no
 * review tint here (that yellow means WAITING, and a dash is not waiting for
 * anyone), and the doc+clock review glyph is retired from these rows —
 * review speaks through the identity run's tint and the join gates instead.
 *
 * The stage ordering rides along, because it needs two dashes at different
 * stages and this is the file that has them.
 *
 * @covers tugdeck/src/components/lens/sections/dashes-section.tsx
 * @covers tugdeck/src/components/lens/sections/dashes-section.css
 * @covers tugdeck/src/components/tugways/dash-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/dash-lifecycle-block.css
 * @covers tugdeck/src/components/tugways/dash-lifecycle-line.tsx
 * @covers tugdeck/src/components/tugways/dash-lifecycle-line.css
 * @covers tugdeck/src/components/tugways/tug-dash-track.tsx
 * @covers tugdeck/src/components/tugways/tug-dash-track.css
 * @covers tugdeck/src/components/tugways/tug-step-fraction.tsx
 * @covers tugdeck/src/lib/changeset-all-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/dash-review.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createDash,
  makeDashScratchRepo,
  recordStampedPlan,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000407";

const SECTION = '.lens-section[data-lens-section="dashes"]';
const DASH_NAME = "at0407-lens";
const ROW = `${SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH_NAME}"]`;

/** The stepped dash — a second one, so the bare-dash assertions above keep
 *  reading a dash with no plan at all. */
const PLAN_DASH = "at0407-plan";
const PLAN_ROW = `${SECTION} [data-slot="lens-dashes-row"][data-dash="${PLAN_DASH}"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0407", checkout: CHECKOUT });
  createDash(projectDir(), DASH_NAME, "at0407 fixture", scratch.cli);
  const planned = createDash(projectDir(), PLAN_DASH, "at0407 plan fixture", scratch.cli);
  // A three-row plan whose declared run covers only the first two, so the
  // Dashes row's numerals and its ring answer different questions.
  recordStampedPlan(projectDir(), PLAN_DASH, planned.worktree, {
    ...scratch.cli,
    rows: 3,
    through: 2,
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

describe.skipIf(!SHOULD_RUN)("AT0407: the Lens Dashes section", () => {
  test(
    "an unbound dash wears the eyebrow's verbs and never a dot",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-lens-dashes-section",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning is what registers the
        // scratch repo as a workspace, so its dashes reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // ── The section is there, and the dash's row is in it ─────────────
        await app.dispatchControlAction("toggle-lens");
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
          menus: number;
          workers: number;
          dots: number;
          bound: string | null;
          phase: string | null;
          note: string;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const atom = row.querySelector('[data-slot="tug-dash-lifecycle-name"]');
             const track = row.querySelector('[data-slot="tug-dash-track"]');
             const note = row.querySelector('[data-slot="tug-dash-lifecycle-note"]');
             return {
               atomText: (atom?.textContent ?? "").trim(),
               // The pill never wears the review tint here — that yellow
               // means WAITING, and a dash is not waiting for anyone.
               reviewTinted: atom?.hasAttribute("data-review") === true,
               reviewGlyphs: row.querySelectorAll('[data-slot="lens-dashes-review"]').length,
               menus: row.querySelectorAll('[data-slot="lens-dashes-row-menu-open"]').length,
               workers: row.querySelectorAll('[data-slot="tug-dash-lifecycle-worker"]').length,
               dots: row.querySelectorAll('[data-slot="tug-progress-indicator"]').length,
               bound: row.getAttribute("data-bound"),
               phase: track?.getAttribute("data-phase") ?? null,
               note: (note?.textContent ?? "").trim(),
             };
           })()`,
        );
        note("at0407 unbound row", JSON.stringify(unbound));
        expect(unbound.atomText).toBe(`^${DASH_NAME}`);
        expect(unbound.reviewTinted).toBe(false);
        expect(unbound.reviewGlyphs).toBe(0);
        // The row's verbs live behind one opener, on every row — the standing
        // Bind and Discard buttons are gone, and the shade's grammar is here.
        expect(unbound.menus).toBe(1);
        expect(unbound.workers).toBe(0);
        // No phase dot on a row nobody works: a dash with a phase to report
        // has a session bound to it, and that session's atom carries the dot.
        expect(unbound.dots).toBe(0);
        expect(unbound.bound).toBeNull();
        // A freshly created dash has no documents and no arc, so the track
        // reads it as the poke it is indistinguishable from: nothing has
        // happened to it yet but the work itself. With no step open the note
        // is the phase word and nothing more — the line has no empty state.
        expect(unbound.phase).toBe("implement");
        expect(unbound.note).toBe(unbound.phase);
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
        testName: "at0407-lens-dashes-meta",
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
        await app.dispatchControlAction("toggle-lens");
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
             const track = row.querySelector('[data-slot="tug-dash-track"]');
             const fraction = row.querySelector('[data-slot="tug-step-fraction"]');
             const note = row.querySelector('[data-slot="tug-dash-lifecycle-note"]');
             const cell = track?.querySelector(
               '[data-slot="tug-dash-track-cell"][data-phase="implement"]',
             );
             return {
               phase: track?.getAttribute("data-phase") ?? null,
               fraction: (fraction?.textContent ?? "").trim(),
               tracks: row.querySelectorAll('[data-slot="tug-dash-track"]').length,
               ticks: cell
                 ? Array.from(cell.querySelectorAll(".tug-dash-track-tick")).map(
                     (el) => el.getAttribute("data-state"),
                   )
                 : [],
               noteText: (note?.textContent ?? "").trim(),
             };
           })()`,
        );
        note("at0407 stepped meta line", JSON.stringify(meta));
        // A step is open on this dash, so the strip stands at `implement`.
        expect(meta.phase).toBe("implement");
        expect(meta.tracks).toBe(1);
        // The numerals count the PLAN — the step in progress over the rows the
        // plan holds. The track draws that same plan as ticks, one per row, so
        // the two readings cannot disagree.
        expect(meta.fraction).toBe("1/3");
        expect(meta.ticks).toEqual(["active", "pending", "pending"]);
        // The note is the current step's title, straight off the declaration.
        expect(meta.noteText).toBe("The only step");
        note("at0407 meta line", await app.screenshot().then((s) => s.path));

        // ── The block is two lines on ONE left margin ─────────────────────
        // The metadata line hangs under the dash's NAME, not under the pill
        // that holds it. The distinction is the whole reason this assertion
        // exists: the atom keeps its text 8px in from its own edge, and a
        // metadata line indented by a space token that merely resembles that
        // number lands a pixel or two short — near enough that the two lines
        // read as a mistake rather than as a second column. It shipped that
        // way once because nothing here could tell the difference.
        //
        // Measured against the rendered name rather than against a constant,
        // so retuning the atom's padding moves the expectation with it.
        const stack = await app.evalJS<{
          name: number;
          mark: number;
          blocks: number[][];
        }>(
          `(() => {
             const rows = Array.from(document.querySelectorAll(${JSON.stringify(`${SECTION} [data-slot="lens-dashes-row"]`)}));
             const L = (el) => Math.round(el.getBoundingClientRect().left * 10) / 10;
             const first = rows[0];
             return {
               name: L(first.querySelector('[data-slot="tug-dash-lifecycle-name"]')),
               mark: L(first.querySelector('[data-slot="tug-dash-lifecycle-line"] > *')),
               blocks: rows.map((r) => {
                 const b = r.getBoundingClientRect();
                 return [Math.round(b.top), Math.round(b.bottom)];
               }),
             };
           })()`,
        );
        note("at0407 stack", JSON.stringify(stack));
        expect(stack.mark, "line 2 starts on the dash name's own margin").toBe(
          stack.name,
        );

        // And one dash is separated from the next by a real step, not a
        // hairline. At 2px of block padding the two-line blocks touched, and
        // the second line of one dash sat as close to the eyebrow of the next
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
        // Both fixtures are unbound, so the stage rank decides: this dash is
        // `implementing` (a step is open on it), the other is `created`.
        const order = await app.evalJS<string[]>(
          `Array.from(
             document.querySelectorAll(${JSON.stringify(`${SECTION} [data-slot="lens-dashes-row"]`)}),
           ).map((el) => el.getAttribute("data-dash"))`,
        );
        expect(order.indexOf(PLAN_DASH)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(DASH_NAME)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(PLAN_DASH)).toBeLessThan(order.indexOf(DASH_NAME));
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

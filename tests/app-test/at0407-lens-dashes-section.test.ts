/**
 * at0407-lens-dashes-section.test.ts — the marks the Lens's dash section
 * paints, over real dashes.
 *
 * Every dash in this section has no live session mated to it — that is the
 * membership rule, not a property of the row — and the row says so with the
 * register its name is in: monospace in the atom pill, which is what the
 * Changes shade means by the same form. "Nobody is working this" is not a
 * state of work, and a pulsing dot on an abandoned dash is the lie this pins
 * against.
 *
 * There used to be a dashed-circle glyph ahead of every name saying the same
 * thing, under a header already reading "Unbound Dashes", over rows that are
 * unbound by construction. The register replaced it.
 *
 * The bind/unbind round trip is NOT here. Under the partition, binding removes
 * the row from this section entirely rather than changing its mark, so the
 * transition is a fact about the two sections together and belongs to
 * at0438-lens-unbound-dashes.test.ts, which drives it from both directions.
 * What is left here is what only this file asserts: the register and the
 * review mark themselves.
 *
 * A second dash carries the review mark. Its plan is real, recorded by the
 * real `dash step start --plan` and stamped by the real `plan stamp`, and it
 * goes stale the way a plan actually goes stale: somebody edits it after the
 * review. Reviewed paints nothing — a mark that is always present is not a
 * mark — so the transition, not the presence, is what this asserts.
 *
 * The stage ordering rides along with it, because it needs two dashes at
 * different stages and this is the file that has them.
 *
 * @covers tugdeck/src/components/lens/sections/dashes-section.tsx
 * @covers tugdeck/src/lib/changeset-all-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/dash-review.ts
 * @covers tugdeck/src/components/tugways/tug-dash-name.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createDash,
  makeDashScratchRepo,
  makePlanStale,
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

/** The review mark's own dash — a second one, so the mark test above
 *  keeps reading a dash with no plan at all (which paints nothing, ever). */
const PLAN_DASH = "at0407-plan";
const PLAN_ROW = `${SECTION} [data-slot="lens-dashes-row"][data-dash="${PLAN_DASH}"]`;
const PLAN_MARK = `${PLAN_ROW} [data-slot="lens-dashes-review"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
let planPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0407", checkout: CHECKOUT });
  createDash(projectDir(), DASH_NAME, "at0407 fixture", scratch.cli);
  const planned = createDash(projectDir(), PLAN_DASH, "at0407 plan fixture", scratch.cli);
  planPath = recordStampedPlan(projectDir(), PLAN_DASH, planned.worktree, scratch.cli);
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
    "an unbound dash names itself in the unbound register and never wears a dot",
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

        // ── The section is there, and the dash in it is unbound ───────────
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
          text: string;
          register: string | null;
          dots: number;
          flag: string | null;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             return {
               text: (row.textContent ?? "").trim(),
               register:
                 row.querySelector(".tug-dash-name")?.getAttribute("data-register") ?? null,
               dots: row.querySelectorAll('[data-slot="tug-progress-indicator"]').length,
               flag: row.getAttribute("data-unbound"),
             };
           })()`,
        );
        expect(unbound.text).toContain(DASH_NAME);
        // A freshly created dash with no round and no dirt is `created`.
        expect(unbound.text).toContain("created");
        // The register is the state channel. Every row in this section is
        // unbound by construction, so a `bound` one here would mean the
        // partition leaked rather than that a name was painted wrong.
        expect(unbound.register).toBe("unbound");
        // A row in this section can never carry a phase dot either, because a
        // dash with a phase to report has a session bound to it and a bound
        // dash is not in this section at all.
        expect(unbound.dots).toBe(0);
        expect(unbound.flag).toBe("true");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a plan edited past its stamp grows the stale mark on its dash's row",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0407-lens-dashes-review",
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

        // Reviewed reads as nothing at all: a mark that is always present is
        // not a mark. The ledger row `dash step start` flipped is outside the
        // hashed content, which is what makes this assertion meaningful rather
        // than accidental.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(PLAN_MARK)}).length`,
          ),
        ).toBe(0);

        // One appended line moves the document past its stamp. Touching a
        // tracked project file is what wakes the aggregate for the recompose
        // that carries the new state onto the entry.
        makePlanStale(planPath);
        const nudge = join(projectDir(), "at0407-nudge.txt");
        writeFileSync(nudge, "at0407 recompose nudge\n");
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PLAN_MARK)}) !== null`,
            { timeoutMs: 30000 },
          );
        } finally {
          rmSync(nudge, { force: true });
        }

        const mark = await app.evalJS<{ review: string | null; label: string | null }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(PLAN_MARK)});
             return {
               review: el.getAttribute("data-review"),
               label: el.getAttribute("aria-label"),
             };
           })()`,
        );
        expect(mark.review).toBe("stale");
        expect(mark.label).toContain("changed since");
        note("at0407 stale mark", await app.screenshot().then((s) => s.path));

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

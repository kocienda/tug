/**
 * at0473-dash-cockpit.test.ts — the Lens Dashes section is the dash cockpit:
 * it lists the *waiting paperwork* beside the live dashes, and every plan row
 * carries its next gesture.
 *
 * The back half of the dash arc was already machine-visible — a dash reads
 * `implementing (i/N)`, the join arms itself, the shade summons the user. The
 * front half was not: a plan document devised and reviewed sat in the docs
 * directory as a file only `ls` could find, and the only way to act on it was
 * to know to type the command. This is what changed, driven end to end against
 * the real app: a plan file on disk in a project's declared docs directory,
 * scanned by the changeset feed, riding `CHANGESET_ALL`, projected into a row,
 * wearing the affordance its review state calls for.
 *
 * A plan row is waiting paperwork **by filter, not by construction** — which
 * the first cut of this section got wrong, and which this file now pins from
 * both ends. A document whose ledger is wholly `done` is finished work and
 * never reaches the wire. A document a live dash has adopted stays sitting in
 * the docs directory for the dash's whole life, committed, clean, ledger
 * frozen at all-`pending` ([D139]) — so nothing about the file says a dash
 * owns it, and only the dash's own recorded plan path can.
 *
 * Four facts this pins that nothing else can:
 *
 * 1. **A project with plans and no dashes renders plan rows**, not the empty
 *    state. The body derives one `populated` flag and spends it twice — on the
 *    band's navigability and on the empty-state early return — so a flag left
 *    counting dashes alone would render "No dashes" over rows that never
 *    mounted. That failure is invisible to every pure test, because both halves
 *    are correct in isolation.
 * 2. **Every open project's plans are listed**, exactly as its dashes are. A
 *    listing scoped to the followed card would change as the reader moved
 *    between cards, which is the coming-and-going wart this section already
 *    retired. Two scratch projects are open here, and both contribute rows.
 * 3. **A refusal is a sentence on the control itself** ([L31]). A plan path is
 *    relative to one project root, so a row whose project is not the followed
 *    one cannot be handed to the followed session — and it says so, by name,
 *    rather than presenting a dead button.
 * 4. **A dash adopting a plan takes its row away**, with the file still sitting
 *    on disk. The dedup is a producer-side join between two lists that arrive
 *    on one frame, so nothing short of the real feed over a real adoption can
 *    show it holding — and the row it is standing in for is asserted present,
 *    because hiding the work entirely would be a worse lie than listing it
 *    twice.
 *
 * **The press itself is deliberately not driven here.** Every affordance in
 * this section submits a `/tugplug:…` prompt into a real session, and an
 * app-test session is a genuine tugcode `--resume` — so a press would start a
 * real model turn against the network. What the press *would* send is asserted
 * instead: the control carries the composed line on itself, rendered by the
 * same function the click hands to the store. Where that line goes, and every
 * rung that can refuse it, are table-tested in
 * `tugdeck/src/lib/__tests__/dash-prompts.test.ts`.
 *
 * The plans live in scratch repositories this file owns. The checkout's own
 * paperwork is suppressed in an app-test instance for the reason its dashes
 * are — a fixture's subject is never the tree somebody is working in, and this
 * repository carries several real plans, so any assertion here would otherwise
 * be an assertion about whatever was devised that week.
 *
 * @covers tugdeck/src/components/lens/sections/dashes-section.tsx
 * @covers tugdeck/src/components/lens/sections/dashes-section.css
 * @covers tugdeck/src/components/lens/sections/dashes-start-sheet.tsx
 * @covers tugdeck/src/components/lens/sections/dashes-start-sheet.css
 * @covers tugdeck/src/components/lens/sections/dash-prompt-target.ts
 * @covers tugdeck/src/lib/dash-prompts.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.css
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 * @covers tugdeck/src/lib/code-session-store/indicator-liveness.ts
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugrust/crates/tugcast/src/feeds/changeset_all.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindDash,
  createDash,
  discardDash,
  fixturePlanDocument,
  dashBriefPath,
  dashPlanPath,
  makeDashScratchRepo,
  recordStampedPlan,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugutil,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The followed card's session, on project A. */
const SID_A = "a7c0d1ea-0000-4000-8000-000000000473";
/** A session on project B, open but not followed — the cross-project row. */
const SID_B = "a7c0d1ea-0000-4000-8000-000000000474";

const SECTION = '.lens-section[data-lens-section="dashes"]';
const PLAN_ROWS = `${SECTION} [data-slot="lens-document-dash-row"]`;
const EMPTY = `${SECTION} [data-slot="lens-dashes-empty"]`;
const planRow = (name: string): string => `${PLAN_ROWS}[data-dash="${name}"]`;
const gesture = (name: string): string =>
  `${planRow(name)} [data-slot="lens-plans-gesture"]`;

/** The band's `+` — `headerActions`' first consumer anywhere in the Lens. */
const BAND_START = `${SECTION} [data-slot="lens-dashes-start"][data-placement="band"]`;
const SHEET = '[data-slot="lens-start-dash"]';
const IDEA = `${SHEET} [data-slot="lens-start-dash-idea"]`;
const SUBMIT = `${SHEET} [data-slot="lens-start-dash-submit"]`;

/** The Z2 work cell — TASKS or DASH, one `data-priority` either way. */
const CELL =
  '[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="tasks"]';
const DASH_PLACARD = '[data-slot="session-dash-popover-body"]';
const DASH_NAME = "at0473-cockpit";

/** This checkout — the build under test, and never a tree a fixture writes in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

// Every dash's documents live at its own address, so a document-only dash IS
// its name — there is no path to name it by.
const REVIEWED = "settled";
const FRESH = "unread";
const OTHER = "elsewhere";
/** A dash a run stopped short of: one row done, one open, one waiting. */
const BEGUN = "underway";
/** A dash with a brief and no plan yet — the planning phase before devise. */
const BRIEFED = "sketched";

/** The dash whose branch turns its document row into a live one. */
const ADOPTER = "unread";

let projectA: DashScratchRepo | null = null;
let projectB: DashScratchRepo | null = null;
let fixtureA = "";
let fixtureB = "";
const dirA = (): string => projectA?.repo ?? "";
const dirB = (): string => projectB?.repo ?? "";

/** One dash's plan: the dash's name, the plan's size, its ledger. */
interface PaperworkPlan {
  name: string;
  rows: number;
  /** Ledger statuses from the first row forward; the rest stay `pending`. */
  statuses?: readonly string[];
}

/**
 * A scratch project whose dashes hold plans at their own addresses, unstamped.
 *
 * The documents are written **after** the scratch repo's first commit, and
 * never through its `files` map: `.tug/` is not tracked, and a fixture that
 * committed a plan would be testing a world this plan deleted. The stamping is
 * a separate act too, because a review stamp is computed rather than authored —
 * the fixture runs the real verb rather than writing a hash it cannot compute.
 */
function makePaperworkProject(
  prefix: string,
  plans: readonly PaperworkPlan[],
): DashScratchRepo {
  const project = makeDashScratchRepo({ prefix, checkout: CHECKOUT });
  for (const plan of plans) {
    writeFileSync(
      dashPlanPath(project.repo, plan.name),
      fixturePlanDocument(plan.rows, plan.statuses),
    );
  }
  return project;
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // Distinct step counts so the row's size cue is worth asserting on.
  projectA = makePaperworkProject("at0473a", [
    { name: REVIEWED, rows: 1 },
    { name: FRESH, rows: 2 },
    { name: BEGUN, rows: 3, statuses: ["done", "in progress"] },
  ]);
  // A brief and no plan: the planning phase before devise has run.
  writeFileSync(dashBriefPath(dirA(), BRIEFED), "# A sketch\n\nProse.\n");
  projectB = makePaperworkProject("at0473b", [{ name: OTHER, rows: 1 }]);
  // One of A's dashes gets a real review stamp, so the rows differ in exactly
  // the fact the next-gesture ladder reads. Stamped **by name**, which is the
  // address every plan verb now takes.
  tugutil(["plan", "stamp", REVIEWED], {
    cwd: dirA(),
    binaryRoot: CHECKOUT,
    env: projectA.cli.env,
  });
  fixtureA = seedScratchSession(dirA(), SID_A);
  fixtureB = seedScratchSession(dirB(), SID_B);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // Before the repo goes: the dash's worktree lives beside it, and a discard
  // is the verb that takes branch and worktree together.
  if (projectA !== null) {
    for (const name of [DASH_NAME, ADOPTER]) {
      discardDash(dirA(), name, {
        binaryRoot: CHECKOUT,
        env: projectA.cli.env,
      });
    }
  }
  rmDashScratchRepo(projectA);
  rmDashScratchRepo(projectB);
  rmScratchSession(fixtureA);
  rmScratchSession(fixtureB);
});

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session A", closable: true },
      { id: "B", componentId: "session", title: "Session B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

interface PlanRowReading {
  dash: string | null;
  review: string | null;
  name: string;
  facts: string;
  label: string;
  prompt: string | null;
  disabled: boolean;
  title: string | null;
}

const readPlanRows = (app: App): Promise<PlanRowReading[]> =>
  app.evalJS<PlanRowReading[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(PLAN_ROWS)})).map((row) => {
       const button = row.querySelector('[data-slot="lens-plans-gesture"]');
       return {
         dash: row.getAttribute("data-dash"),
         review: row.getAttribute("data-review"),
         name: (row.querySelector('[data-slot="lens-plans-name"]')?.textContent ?? "").trim(),
         facts: (row.querySelector('[data-slot="lens-plans-facts"]')?.textContent ?? "").trim(),
         label: (button?.textContent ?? "").trim(),
         prompt: button?.getAttribute("data-prompt") ?? null,
         disabled: button?.hasAttribute("disabled") ?? false,
         title: button?.getAttribute("title") ?? null,
       };
     })`,
  );

describe.skipIf(!SHOULD_RUN)("AT0473: the dash cockpit lists waiting plans", () => {
  test(
    "plan rows render with their next gesture, across every open project",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0473-dash-cockpit",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: projectA?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // Spawning is what registers a scratch repo as a workspace, which is
        // what puts its project on the aggregate at all. Both projects are
        // opened; only A is followed.
        await app.spawnSessionResume("B", { tugSessionId: SID_B, projectDir: dirB() });
        await app.awaitEngineReady("B", { timeoutMs: 15000 });
        await app.spawnSessionResume("A", { tugSessionId: SID_A, projectDir: dirA() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-lens");
        // Opening the Lens makes the *Lens* the key card, and the followed
        // card is the last key card that is not it — tracked from the moment
        // `LensContent` mounts, so a focus that happened before the Lens
        // existed is not history it has. Raising A is the real gesture that
        // gives the Lens something to be about, and without it every
        // affordance here correctly refuses with "Focus a session card".
        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
        // Five rows: A's four dashes — three with plans, one with only a
        // brief — plus B's one. Every one of them is a dash that exists
        // without a branch, which is the planning phase made visible.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(PLAN_ROWS)}).length === 5`,
          { timeoutMs: 40000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(gesture(REVIEWED))})?.hasAttribute("disabled") === false`,
          { timeoutMs: 20000 },
        );

        const rows = await readPlanRows(app);
        note("at0473 plan rows", JSON.stringify(rows, null, 2));

        // ── Neither project has a dash, and the section is NOT empty ──────
        // The `populated` flag counts both kinds; counting dashes alone would
        // render the empty state over rows that never mounted.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(EMPTY)}).length`,
          ),
        ).toBe(0);

        // ── Every open project contributes ────────────────────────────────
        expect(rows.map((r) => r.dash).sort()).toEqual(
          [REVIEWED, FRESH, BEGUN, BRIEFED, OTHER].sort(),
        );

        // ── Work in flight first, then nearest to starting ────────────────
        // A plan a run stopped short of outranks even a reviewed one nobody
        // has touched: it is nearer done, the same principle the dash rows
        // encode.
        expect(rows[0]!.dash).toBe(BEGUN);
        expect(rows[1]!.review).toBe("reviewed");
        expect(rows[1]!.dash).toBe(REVIEWED);

        const settled = rows.find((r) => r.dash === REVIEWED)!;
        const unread = rows.find((r) => r.dash === FRESH)!;
        const underway = rows.find((r) => r.dash === BEGUN)!;
        const sketched = rows.find((r) => r.dash === BRIEFED)!;
        const elsewhere = rows.find((r) => r.dash === OTHER)!;

        // ── The next-gesture ladder, in the DOM ───────────────────────────
        expect(settled.name).toBe(REVIEWED);
        expect(settled.label).toBe("Implement");
        // Every gesture names the dash, never a path: the skills resolve the
        // address, so a prompt cannot point at the wrong file.
        expect(settled.prompt).toBe(`/tugplug:dash-implement ${REVIEWED}`);
        expect(settled.facts).toBe("plan · reviewed · 1 step");
        expect(settled.disabled).toBe(false);

        expect(unread.review).toBe("never-reviewed");
        expect(unread.label).toBe("Review");
        expect(unread.prompt).toBe(`/tugplug:dash-review ${FRESH}`);
        expect(unread.facts).toBe("plan · never-reviewed · 2 steps");
        expect(unread.disabled).toBe(false);

        // A brief and no plan is the planning phase before devise: the row
        // says what it has, and points at the arc's front door.
        expect(sketched.label).toBe("Devise");
        expect(sketched.prompt).toBe(`/tugplug:dash ${BRIEFED}`);
        expect(sketched.facts).toBe("brief");
        expect(sketched.disabled).toBe(false);

        // A begun plan states how far it got, and wants resuming whatever its
        // review says — `dash-implement` re-enters at the first row that is
        // not done, and its own setup gate owns the review question.
        expect(underway.review).toBe("never-reviewed");
        expect(underway.label).toBe("Resume");
        expect(underway.prompt).toBe(`/tugplug:dash-implement ${BEGUN}`);
        expect(underway.facts).toBe("plan · never-reviewed · 1 of 3 done");
        expect(underway.disabled).toBe(false);

        // ── A cross-project row refuses by name, never silently ───────────
        expect(elsewhere.disabled).toBe(true);
        expect(elsewhere.title).toContain("belongs to");
        note("at0473 cockpit", (await app.screenshot()).path);

        // ── Cutting the branch turns the row live; it never doubles ───────
        // One dash, one row, before and after `create`. The documents do not
        // move — they are already at the dash's own address — so what changes
        // is only which list the name is on. Driven with the real verbs.
        const adopter = createDash(dirA(), ADOPTER, "at0473 adopter", projectA!.cli);
        tugutil(["dash", "step", ADOPTER, "start", "1", "--through", "2"], {
          cwd: dirA(),
          binaryRoot: CHECKOUT,
          env: projectA!.cli.env,
        });
        note("at0473 adopter worktree", adopter.worktree);
        // The plan stayed exactly where it was — nothing transplanted it.
        expect(existsSync(dashPlanPath(dirA(), ADOPTER))).toBe(true);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(PLAN_ROWS)}).length === 4`,
          { timeoutMs: 40000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(gesture(FRESH))}).length`,
          ),
        ).toBe(0);
        // And the work is not gone from the section — it moved to the row that
        // tells the truth about it, which carries the live step counter.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${SECTION} [data-slot="lens-dashes-row"][data-dash="${ADOPTER}"]`)}) !== null`,
          { timeoutMs: 40000 },
        );

        // ── The way in is on the band, and it opens the sheet ─────────────
        // The band's control is `headerActions`' first consumer, so nothing
        // else proves the hook renders at all.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BAND_START)}) !== null`,
          { timeoutMs: 10000 },
        );
        await app.click(BAND_START);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 10000 },
        );

        // Start refuses an empty idea by name — there is no sentence to send,
        // and a control that declines without saying why is what this whole
        // surface exists to retire ([L31]).
        const empty = await app.evalJS<{
          disabled: boolean;
          title: string | null;
          where: string;
        }>(
          `(() => {
             const button = document.querySelector(${JSON.stringify(SUBMIT)});
             return {
               disabled: button?.hasAttribute("disabled") ?? false,
               title: button?.getAttribute("title") ?? null,
               where: (document.querySelector('[data-slot="lens-start-dash-where"]')?.textContent ?? "").trim(),
             };
           })()`,
        );
        note("at0473 sheet, empty", JSON.stringify(empty));
        expect(empty.disabled).toBe(true);
        expect(empty.title).toBe("Describe the work to start a dash");
        // And it names where the prompt would land, before it lands there.
        expect(empty.where).toContain("Asks the focused session, in ");

        // A described idea arms it. The press itself is not driven: it would
        // submit a real prompt into a real tugcode session and start a model
        // turn against the network. What it *would* send is table-tested.
        await app.type(IDEA, "make the cockpit list waiting plans");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SUBMIT)})?.hasAttribute("disabled") === false`,
          { timeoutMs: 10000 },
        );
        note("at0473 start sheet", (await app.screenshot()).path);
        await app.click(`${SHEET} [data-slot="lens-start-dash-cancel"]`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 10000 },
        );

        // ── Z2: the fourth cell reads DASH, in the box TASKS held ─────────
        // The TASKS reading first, so the geometry assertion has something
        // to compare against.
        const tasksBox = await app.evalJS<{ label: string; width: number }>(
          `(() => {
             const cell = document.querySelector(${JSON.stringify(CELL)});
             return {
               label: (cell?.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim(),
               width: cell?.getBoundingClientRect().width ?? 0,
             };
           })()`,
        );
        note("at0473 Z2 as TASKS", JSON.stringify(tasksBox));
        expect(tasksBox.label).toBe("TASKS");
        expect(tasksBox.width).toBeGreaterThan(0);

        // The cell's value, its stage glyph, its fraction, and the pose of the
        // two dots flanking them — read the same way at both readings below.
        const PROBE_DASH_CELL = `(() => {
             const cell = document.querySelector(${JSON.stringify(CELL)});
             const value = cell?.querySelector('[data-slot="session-telemetry-dash-value"]');
             return {
               label: (cell?.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim(),
               width: cell?.getBoundingClientRect().width ?? 0,
               text: (value?.textContent ?? "").trim(),
               stage: value?.querySelector('[data-slot="tug-dash-stage-mark"]')?.getAttribute("data-stage") ?? null,
               fraction: (value?.querySelector(".session-telemetry-status-dash-fraction")?.textContent ?? "").trim(),
               aria: value?.getAttribute("aria-label") ?? null,
               dots: Array.from(cell?.querySelectorAll('.session-telemetry-status-dash-row [data-slot="tug-progress-indicator"]') ?? [])
                 .map((d) => d.getAttribute("data-state")),
             };
           })()`;
        interface DashCellProbe {
          label: string;
          width: number;
          text: string;
          stage: string | null;
          fraction: string;
          aria: string | null;
          dots: Array<string | null>;
        }

        // A real dash on project A, bound to the followed card's session — the
        // fixture runs the same verbs a run does. No plan yet, which is the
        // half of the arc the glyph is for: with no step count to show, the
        // stage IS the value.
        const dash = createDash(dirA(), DASH_NAME, "at0473 fixture", projectA!.cli);
        bindDash(dirA(), DASH_NAME, SID_A, {
          binaryRoot: CHECKOUT,
          env: projectA!.cli.env,
        });
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CELL)})?.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim() === "DASH"`,
          { timeoutMs: 60000 },
        );
        const glyphOnly = await app.evalJS<DashCellProbe>(PROBE_DASH_CELL);
        note("at0473 Z2 as DASH, no count", JSON.stringify(glyphOnly));
        expect(glyphOnly.label).toBe("DASH");
        expect(glyphOnly.stage).toBe("created");
        expect(glyphOnly.fraction).toBe("");
        // Both dots, and both quiet: a dash nobody has worked yet is not work
        // in flight, and a dot pulsing over it would say it was.
        expect(glyphOnly.dots).toEqual(["stopped", "stopped"]);

        // Now a real plan and a real step declaration — and the count takes
        // the value over.
        recordStampedPlan(dirA(), DASH_NAME, dash.worktree, {
          rows: 3,
          through: 3,
          binaryRoot: CHECKOUT,
          env: { ...projectA!.cli.env, TUG_SESSION_ID: SID_A },
        });
        // Real work in the worktree, so the placard has a divergence fact to
        // state. The plan is not one: it lives at the dash's own address,
        // outside every tree git watches, so a run's whole ledger walk leaves
        // the worktree clean.
        writeFileSync(join(dash.worktree, "in-flight.txt"), "mid-round\n");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CELL)})?.querySelector(".session-telemetry-status-dash-fraction")?.textContent ?? "").trim() === "1/3"`,
          { timeoutMs: 60000 },
        );

        const dashBox = await app.evalJS<DashCellProbe>(PROBE_DASH_CELL);
        note("at0473 Z2 as DASH", JSON.stringify(dashBox));
        expect(dashBox.label).toBe("DASH");
        expect(dashBox.fraction).toBe("1/3");
        // **The glyph yields to the count.** Both at once put three circles in
        // a ~96px cell and read as clutter; the position in the run is the
        // fact that moves while somebody watches, so it takes the box alone.
        // The stage is still here — as the accessible label's step phrasing,
        // and as the placard's own reading a click away.
        expect(dashBox.stage).toBeNull();
        expect(dashBox.dots.length).toBe(2);
        // And the *name is not in the cell at all*. A name is the one fact
        // here that can be arbitrarily long, and in a ~110px box it elided
        // away the facts that actually move. Nothing left in the cell can be
        // truncated, because nothing left in it would still be true truncated.
        expect(dashBox.text).not.toContain(DASH_NAME);
        // Which dash it is lives in the accessible label, in full.
        expect(dashBox.aria).toBe(`dash ${DASH_NAME}, step 1 of 3`);
        // **The box did not move.** The reading changed; the geometry is the
        // measured width table's, keyed on a `data-priority` this change
        // deliberately left alone.
        expect(dashBox.width).toBe(tasksBox.width);

        // ── And the click opens the cockpit detail ────────────────────────
        await app.click(CELL);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASH_PLACARD)}) !== null`,
          { timeoutMs: 10000 },
        );
        const placard = await app.evalJS<{
          text: string;
          rows: Array<{ text: string; status: string | null }>;
          headMark: number;
          rowMark: number;
        }>(
          `(() => {
             const body = document.querySelector(${JSON.stringify(DASH_PLACARD)});
             const steps = Array.from(body?.querySelectorAll('[data-slot="session-dash-popover-step"]') ?? []);
             const centre = (el) => {
               if (el === null || el === undefined) return -1;
               const box = el.getBoundingClientRect();
               return box.left + box.width / 2;
             };
             return {
               text: (body?.textContent ?? "").trim(),
               rows: steps.map((row) => ({
                 text: (row.querySelector(".tug-popup-list-item-primary")?.textContent ?? "").trim(),
                 status: row.getAttribute("data-status"),
               })),
               headMark: centre(body?.querySelector('[data-slot="tug-dash-meta-line"]')?.firstElementChild),
               rowMark: centre(steps[0]?.querySelector(".tug-popup-list-item-lead")?.firstElementChild),
             };
           })()`,
        );
        note("at0473 dash placard", JSON.stringify(placard));
        // The cockpit detail: the dash's own atom, the run fraction, the step
        // it is on, and the divergence facts — every mark composed from the
        // same components the Lens row and the Changes shade render, so the
        // three readings of one dash cannot disagree.
        expect(placard.text).toContain(DASH_NAME);
        expect(placard.text).toContain("1/3");
        expect(placard.text).toContain("uncommitted");
        // **The list is the plan's ledger**, not the [D100] task list it used
        // to be. This session is a real `--resume` and has written no tasks at
        // all, so under the old reading the placard said "None" over a dash
        // three steps deep — the fraction above it counting a walk the list
        // below it denied existed. The ledger has no way to be silent about a
        // plan it is the ledger of.
        expect(placard.rows.map((r) => r.text)).toEqual([
          "1.The only step",
          "2.The second step",
          "3.The third step",
        ]);
        // And it says where the walk actually is: `dash step start 1` flipped
        // row one and nothing else.
        expect(placard.rows.map((r) => r.status)).toEqual([
          "in progress",
          "pending",
          "pending",
        ]);
        expect(placard.text).not.toContain("None");
        // One lead column, measured. The head's ring and the rows' dots are
        // different sizes, so sharing an inline padding left them off centre
        // from each other by the difference — a shared left edge is not a
        // shared column.
        expect(placard.headMark).toBeGreaterThan(0);
        expect(
          Math.abs(placard.headMark - placard.rowMark),
          "the head's mark is centred in the column the step dots sit in",
        ).toBeLessThanOrEqual(1);
        note("at0473 Z2 dash placard", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

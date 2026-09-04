/**
 * at0473-arc-cockpit.test.ts — the Arcs card is the arc cockpit:
 * it lists the *waiting paperwork* beside the live arcs, in the same
 * two-line block a live arc wears.
 *
 * The back half of the arc run was already machine-visible — an arc reads
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
 * never reaches the wire. A document a live arc has adopted stays sitting in
 * the docs directory for the arc's whole life, committed, clean, ledger
 * frozen at all-`pending` ([D139]) — so nothing about the file says an arc
 * owns it, and only the arc's own recorded plan path can.
 *
 * Three facts this pins that nothing else can:
 *
 * 1. **A project with plans and no arcs renders plan rows**, not the empty
 *    state. The body derives one `populated` flag and spends it twice — on the
 *    band's navigability and on the empty-state early return — so a flag left
 *    counting arcs alone would render "No arcs" over rows that never
 *    mounted. That failure is invisible to every pure test, because both halves
 *    are correct in isolation.
 * 2. **Every open project's plans are listed**, exactly as its arcs are. A
 *    listing scoped to the followed card would change as the reader moved
 *    between cards, which is the coming-and-going wart this section already
 *    retired. Two scratch projects are open here, and both contribute rows.
 * 3. **An arc adopting a plan takes its row away**, with the file still sitting
 *    on disk. The dedup is a producer-side join between two lists that arrive
 *    on one frame, so nothing short of the real feed over a real adoption can
 *    show it holding — and the row it is standing in for is asserted present,
 *    because hiding the work entirely would be a worse lie than listing it
 *    twice.
 *
 * **A plan row carries no control.** It wore its next gesture — Devise,
 * Review, Implement — for a while, and the label was retired: it read as a
 * label rather than a control, and it made a row about the followed card when
 * the section is about every open project. What is left is the reading, and
 * the reading is what this file asserts.
 *
 * The plans live in scratch repositories this file owns. The checkout's own
 * paperwork is suppressed in an app-test instance for the reason its arcs
 * are — a fixture's subject is never the tree somebody is working in, and this
 * repository carries several real plans, so any assertion here would otherwise
 * be an assertion about whatever was devised that week.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/lib/document-arc-entry.ts
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.css
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
  appendArcLogLine,
  arcLogPath,
  bindArc,
  bindArcAtTheDoor,
  createArc,
  discardArc,
  fixturePlanDocument,
  arcBriefPath,
  arcPlanPath,
  makeArcScratchRepo,
  recordStampedPlan,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The followed card's session, on project A. */
const SID_A = "a7c0d1ea-0000-4000-8000-000000000473";
/** A session on project B, open but not followed — the cross-project row. */
const SID_B = "a7c0d1ea-0000-4000-8000-000000000474";

const SECTION = ".arcs-section";
const PLAN_ROWS = `${SECTION} [data-slot="arc-document-row"]`;
const EMPTY = `${SECTION} [data-slot="arcs-empty"]`;
const planRow = (name: string): string => `${PLAN_ROWS}[data-arc="${name}"]`;

/** The Z2 work cell — TASKS or ARC, one `data-priority` either way. */
const CELL =
  '[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="tasks"]';
const ARC_PLACARD = '[data-slot="session-arc-popover-body"]';
const ARC_NAME = "at0473-cockpit";

/** This checkout — the build under test, and never a tree a fixture writes in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

// Every arc's documents live at its own address, so a document-only arc IS
// its name — there is no path to name it by.
const REVIEWED = "settled";
const FRESH = "unread";
const OTHER = "elsewhere";
/** An arc a run stopped short of: one row done, one open, one waiting. */
const BEGUN = "underway";
/** An arc with a brief and no plan yet — the planning phase before devise. */
const BRIEFED = "sketched";

/** The arc whose branch turns its document row into a live one. */
const ADOPTER = "unread";

let projectA: ArcScratchRepo | null = null;
let projectB: ArcScratchRepo | null = null;
let fixtureA = "";
let fixtureB = "";
const dirA = (): string => projectA?.repo ?? "";
const dirB = (): string => projectB?.repo ?? "";

/** One arc's plan: the arc's name, the plan's size, its ledger. */
interface PaperworkPlan {
  name: string;
  rows: number;
  /** Ledger statuses from the first row forward; the rest stay `pending`. */
  statuses?: readonly string[];
}

/**
 * A scratch project whose arcs hold plans at their own addresses, unstamped.
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
): ArcScratchRepo {
  const project = makeArcScratchRepo({ prefix, checkout: CHECKOUT });
  for (const plan of plans) {
    writeFileSync(
      arcPlanPath(project.repo, plan.name),
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
  writeFileSync(arcBriefPath(dirA(), BRIEFED), "# A sketch\n\nProse.\n");
  projectB = makePaperworkProject("at0473b", [{ name: OTHER, rows: 1 }]);
  // One of A's arcs gets a real review stamp, so the rows differ in exactly
  // the fact the next-gesture ladder reads. Stamped **by name**, which is the
  // address every plan verb now takes.
  tugtool(["plan", "stamp", REVIEWED], {
    cwd: dirA(),
    binaryRoot: CHECKOUT,
    env: projectA.cli.env,
  });
  fixtureA = seedScratchSession(dirA(), SID_A);
  fixtureB = seedScratchSession(dirB(), SID_B);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // Before the repo goes: the arc's worktree lives beside it, and a discard
  // is the verb that takes branch and worktree together.
  if (projectA !== null) {
    for (const name of [ARC_NAME, ADOPTER]) {
      discardArc(dirA(), name, {
        binaryRoot: CHECKOUT,
        env: projectA.cli.env,
      });
    }
  }
  rmArcScratchRepo(projectA);
  rmArcScratchRepo(projectB);
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
  arc: string | null;
  review: string | null;
  name: string;
  phase: string | null;
  fraction: string;
  ticks: (string | null)[];
}

const readPlanRows = (app: App): Promise<PlanRowReading[]> =>
  app.evalJS<PlanRowReading[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(PLAN_ROWS)})).map((row) => {
       const track = row.querySelector('[data-slot="tug-arc-track"]');
       const cell = track?.querySelector(
         '[data-slot="tug-arc-track-cell"][data-phase="implement"]',
       );
       return {
         arc: row.getAttribute("data-arc"),
         review: row.getAttribute("data-review"),
         name: (row.querySelector('[data-slot="tug-arc-lifecycle-name"]')?.textContent ?? "").trim(),
         phase: track?.getAttribute("data-phase") ?? null,
         fraction: (row.querySelector('[data-slot="tug-step-fraction"]')?.textContent ?? "").trim(),
         ticks: cell
           ? Array.from(cell.querySelectorAll(".tug-arc-track-tick")).map(
               (el) => el.getAttribute("data-state"),
             )
           : [],
       };
     })`,
  );

describe.skipIf(!SHOULD_RUN)(
  "AT0473: the arc cockpit lists waiting plans",
  () => {
    test(
      "plan rows render their whole reading, across every open project",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
        const app = await launchTugApp({
          testName: "at0473-arc-cockpit",
          env: {
            TUGBANK_PATH: tugbankPath,
            TUG_DATA_DIR: projectA?.dataRoot ?? "",
          },
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
          await app.spawnSessionResume("B", {
            tugSessionId: SID_B,
            projectDir: dirB(),
          });
          await app.awaitEngineReady("B", { timeoutMs: 15000 });
          await app.spawnSessionResume("A", {
            tugSessionId: SID_A,
            projectDir: dirA(),
          });
          await app.awaitEngineReady("A", { timeoutMs: 15000 });

          await app.dispatchControlAction("toggle-arcs");
          // Opening the rail makes the *Arcs card* the key card, and the
          // followed card is the last key card that is not it — tracked from the
          // moment the card mounts, so a focus that happened before it existed is
          // not history it has. Raising A is the real gesture that gives the card
          // something to be about, and without it every affordance here correctly
          // refuses with "Focus a session card".
          await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
          // Five rows: A's four arcs — three with plans, one with only a
          // brief — plus B's one. Every one of them is an arc that exists
          // without a branch, which is the planning phase made visible.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(PLAN_ROWS)}).length === 5`,
            { timeoutMs: 40000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(planRow(REVIEWED))}) !== null`,
            { timeoutMs: 20000 },
          );

          const rows = await readPlanRows(app);
          note("at0473 plan rows", JSON.stringify(rows, null, 2));

          // ── Neither project has an arc, and the section is NOT empty ──────
          // The `populated` flag counts both kinds; counting arcs alone would
          // render the empty state over rows that never mounted.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(EMPTY)}).length`,
            ),
          ).toBe(0);

          // ── Every open project contributes ────────────────────────────────
          expect(rows.map((r) => r.arc).sort()).toEqual(
            [REVIEWED, FRESH, BEGUN, BRIEFED, OTHER].sort(),
          );

          // ── Work in flight first, then nearest to starting ────────────────
          // A plan a run stopped short of outranks even a reviewed one nobody
          // has touched: it is nearer done, the same principle the arc rows
          // encode.
          expect(rows[0]!.arc).toBe(BEGUN);
          expect(rows[1]!.review).toBe("reviewed");
          expect(rows[1]!.arc).toBe(REVIEWED);

          const settled = rows.find((r) => r.arc === REVIEWED)!;
          const unread = rows.find((r) => r.arc === FRESH)!;
          const underway = rows.find((r) => r.arc === BEGUN)!;
          const sketched = rows.find((r) => r.arc === BRIEFED)!;
          const elsewhere = rows.find((r) => r.arc === OTHER)!;

          // ── The plan's own reading, in the DOM ────────────────────────────
          // The row wears the same lifecycle grammar a live arc does: the atom
          // names the arc with its sigil, and the track says where in its life
          // it stands. A plan nobody has touched stands at `review`, whatever
          // the review verdict is — the phase is how far the WORK got, and the
          // verdict rides the row's own `data-review`.
          expect(settled.name).toBe(`^${REVIEWED}`);
          expect(settled.phase).toBe("review");
          expect(settled.review).toBe("reviewed");

          expect(unread.review).toBe("never-reviewed");
          expect(unread.phase).toBe("review");

          // A brief and no plan is the planning phase before devise: the track
          // stands at `brief`, which is the whole of what the row claims.
          expect(sketched.phase).toBe("brief");

          // A begun plan is being IMPLEMENTED, branch or no branch — and the
          // ticks are the plan's own ledger rows, one done, one open, one to go.
          // The counts are the wire's; nothing here invents a step.
          expect(underway.review).toBe("never-reviewed");
          expect(underway.phase).toBe("implement");
          expect(underway.ticks).toEqual(["done", "active", "pending"]);
          expect(underway.fraction).toBe("2/3");

          // ── A row from a project that is not the followed one is a row ────
          // Not an inert one, and not one wearing a refusal: the section is
          // about every open project, and a plan row reports rather than acts.
          expect(elsewhere.name).toBe(`^${OTHER}`);
          note("at0473 cockpit", (await app.screenshot()).path);

          // ── Cutting the branch turns the row live; it never doubles ───────
          // One arc, one row, before and after `create`. The documents do not
          // move — they are already at the arc's own address — so what changes
          // is only which list the name is on. Driven with the real verbs.
          const adopter = createArc(
            dirA(),
            ADOPTER,
            "at0473 adopter",
            projectA!.cli,
          );
          tugtool(["arc", "step", ADOPTER, "start", "1", "--through", "2"], {
            cwd: dirA(),
            binaryRoot: CHECKOUT,
            env: projectA!.cli.env,
          });
          note("at0473 adopter worktree", adopter.worktree);
          // The plan stayed exactly where it was — nothing transplanted it.
          expect(existsSync(arcPlanPath(dirA(), ADOPTER))).toBe(true);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(PLAN_ROWS)}).length === 4`,
            { timeoutMs: 40000 },
          );
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(planRow(FRESH))}).length`,
            ),
          ).toBe(0);
          // And the work is not gone from the section — it moved to the row that
          // tells the truth about it, which carries the live step counter.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${SECTION} [data-slot="arcs-row"][data-arc="${ADOPTER}"]`)}) !== null`,
            { timeoutMs: 40000 },
          );

          // ── Z2: the fourth cell reads ARC while an arc is up ─────────────
          // The TASKS reading first, so the switch has something to be a switch
          // FROM. The box is not the same one: a ARC reading takes STATE's
          // width and JOBS gives exactly that back ([D168]).
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

          // The cell's reading, whether it fits its box, and the pose of the two
          // dots flanking it — read the same way at every reading below. The
          // cell is an INSTRUMENT ([D168]): a dot pinned to each edge of the
          // value wrap and a word or a pair of numbers between them. The strip
          // that used to live in this box is on the placard one press away.
          const PROBE_ARC_CELL = `(() => {
             const cell = document.querySelector(${JSON.stringify(CELL)});
             const value = cell?.querySelector('[data-slot="session-telemetry-arc-value"]');
             return {
               label: (cell?.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim(),
               width: cell?.getBoundingClientRect().width ?? 0,
               authored: cell === null
                 ? ""
                 : getComputedStyle(cell).getPropertyValue("--tugx-session-status-cell-width").trim(),
               text: (value?.textContent ?? "").trim(),
               tracks: cell?.querySelectorAll('[data-slot="tug-arc-track"]').length ?? 0,
               fractions: value?.querySelectorAll('[data-slot="tug-step-fraction"]').length ?? 0,
               // The fit, as the box itself reports it: a reading wider than
               // its span would be clipped, and a clipped instrument reading
               // is a number with a digit missing.
               scrollWidth: value?.scrollWidth ?? 0,
               clientWidth: value?.clientWidth ?? 0,
               aria: value?.getAttribute("aria-label") ?? null,
               dots: Array.from(cell?.querySelectorAll('[data-slot="tug-progress-indicator"]') ?? [])
                 .map((d) => d.getAttribute("data-state")),
             };
           })()`;
          interface ArcCellProbe {
            label: string;
            width: number;
            authored: string;
            text: string;
            tracks: number;
            fractions: number;
            scrollWidth: number;
            clientWidth: number;
            aria: string | null;
            dots: Array<string | null>;
          }

          // ── Z2 before the door's turn ends ([B02]) ────────────────────────
          // The door's first act binds the session to an arc that has nothing
          // yet but an empty documents directory — no branch, no brief. The
          // cell reads ARC from that first command, not from the door's last.
          bindArcAtTheDoor(dirA(), ARC_NAME, SID_A, {
            binaryRoot: CHECKOUT,
            env: projectA!.cli.env,
          });
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(CELL)})?.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim() === "ARC"`,
            { timeoutMs: 60000 },
          );
          const atTheDoor = await app.evalJS<ArcCellProbe>(PROBE_ARC_CELL);
          note("at0473 Z2 as ARC, at the door", JSON.stringify(atTheDoor));
          expect(atTheDoor.label).toBe("ARC");
          expect(atTheDoor.text).not.toMatch(/\d+\/\d+/);

          // A real arc on project A, bound to the followed card's session — the
          // fixture runs the same verbs a run does. No documents and no arc, so
          // the cell reads it as the direct arc it is — a word, because an arc
          // with no task list has nothing to count.
          const arc = createArc(
            dirA(),
            ARC_NAME,
            "at0473 fixture",
            projectA!.cli,
          );
          bindArc(dirA(), ARC_NAME, SID_A, {
            binaryRoot: CHECKOUT,
            env: projectA!.cli.env,
          });
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(`${CELL} [data-slot="session-telemetry-arc-value"]`)})?.textContent ?? "").trim() === "Working"`,
            { timeoutMs: 60000 },
          );
          const bare = await app.evalJS<ArcCellProbe>(PROBE_ARC_CELL);
          note("at0473 Z2 as ARC, no plan", JSON.stringify(bare));
          expect(bare.label).toBe("ARC");
          // No strip in this box: the cell is an instrument, and the whole
          // track lives on its placard ([D168]).
          expect(bare.tracks).toBe(0);
          expect(bare.text).toBe("Working");
          expect(bare.fractions).toBe(0);
          // TWO dots, one pinned to each edge of the reading — STATE's own
          // construction — and both quiet: an arc nobody has worked yet is not
          // work in flight, and a dot pulsing over it would say it was.
          expect(bare.dots).toEqual(["stopped", "stopped"]);
          // The cell took STATE's width when the arc came up, and JOBS gave
          // exactly that back — the row's own total never moved ([D168], and
          // `at0484-arc-z2-instrument` pins the whole sum).
          expect(bare.authored).toBe("18ch");
          expect(bare.scrollWidth).toBeLessThanOrEqual(bare.clientWidth);

          // ── Z2 before step 1 ([B03]) ──────────────────────────────────────
          // The wheel seats the implement stage over a plan nobody has opened
          // a step of. The honest reading is the stage's word, not `0/3`: a
          // zero numerator counts work that has not started. And the dots run,
          // idle session or not — under the wheel the idle edge is the arc's
          // busiest moment ([B01]).
          //
          // The stage is seated on the card's own session. The runner compares
          // the stage line's session with the claude session the card is
          // running, and a stage seated on any other id — with no stage label
          // on the card to say a rotation put it there — reads as the card
          // having been taken: the arc stops, and the cell says `Stopped`.
          // A resumed session's claude id is the tug session id it resumed.
          const logPath = arcLogPath(projectA!.dataRoot);
          writeFileSync(arcPlanPath(dirA(), ARC_NAME), fixturePlanDocument(3));
          appendArcLogLine(logPath, ARC_NAME, "arc-start", "tasks.md");
          appendArcLogLine(
            logPath,
            ARC_NAME,
            "arc-stage",
            "implement " + SID_A + " -",
          );
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(`${CELL} [data-slot="session-telemetry-arc-value"]`)})?.textContent ?? "").trim() === "Implement"`,
            { timeoutMs: 60000 },
          );
          const seated = await app.evalJS<ArcCellProbe>(PROBE_ARC_CELL);
          note(
            "at0473 Z2 as ARC, seated before step 1",
            JSON.stringify(seated),
          );
          expect(seated.text).toBe("Implement");
          expect(seated.aria).toBe(`arc ${ARC_NAME}, in implement`);
          expect(seated.dots).toEqual(["running", "running"]);

          // Now a real step declaration — and the count takes the value over.
          recordStampedPlan(dirA(), ARC_NAME, arc.worktree, {
            rows: 3,
            through: 3,
            binaryRoot: CHECKOUT,
            env: { ...projectA!.cli.env, TUG_SESSION_ID: SID_A },
          });
          // Real work in the worktree, so the placard has a divergence fact to
          // state. The plan is not one: it lives at the arc's own address,
          // outside every tree git watches, so a run's whole ledger walk leaves
          // the worktree clean.
          writeFileSync(join(arc.worktree, "in-flight.txt"), "mid-round\n");
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(`${CELL} [data-slot="session-telemetry-arc-value"]`)})?.textContent ?? "").trim() === "1/3"`,
            { timeoutMs: 60000 },
          );

          const arcBox = await app.evalJS<ArcCellProbe>(PROBE_ARC_CELL);
          note("at0473 Z2 as ARC", JSON.stringify(arcBox));
          expect(arcBox.label).toBe("ARC");
          // **Numbers whenever there are numbers.** A declared step turns the
          // word into the pair, which is the one reading that changes while
          // somebody watches. Plain text, not a `TugStepFraction`: this cell is
          // an instrument row and its four neighbours are plain values too.
          expect(arcBox.text).toBe("1/3");
          expect(arcBox.tracks).toBe(0);
          expect(arcBox.fractions).toBe(0);
          expect(arcBox.dots).toEqual(["running", "running"]);
          // ── The fit, at the first of two plan lengths ([P10]) ─────────────
          expect(
            arcBox.scrollWidth,
            "the reading fits its box on a three-step plan",
          ).toBeLessThanOrEqual(arcBox.clientWidth);
          // And the *name is not in the cell at all*. A name is the one fact
          // here that can be arbitrarily long, and in a ~110px box it elided
          // away the facts that actually move. Nothing left in the cell can be
          // truncated, because nothing left in it would still be true truncated.
          expect(arcBox.text).not.toContain(ARC_NAME);
          // Which arc it is lives in the accessible label, in full.
          expect(arcBox.aria).toBe(
            `arc ${ARC_NAME}, step 1 of 3, in implement`,
          );
          // **The box did not move between readings.** A word and a pair of
          // numbers are the same 18ch box: the width is authored per
          // `data-priority`, never sized to what the cell happens to say, so a
          // reading that ticks never shoves the cells beside it.
          expect(arcBox.width).toBe(bare.width);
          expect(arcBox.authored).toBe("18ch");

          // ── And the click opens the cockpit detail ────────────────────────
          await app.click(CELL);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(ARC_PLACARD)}) !== null`,
            { timeoutMs: 10000 },
          );
          const placard = await app.evalJS<{
            text: string;
            rows: Array<{ text: string; status: string | null }>;
            blocks: number;
            tracks: number;
          }>(
            `(() => {
             const body = document.querySelector(${JSON.stringify(ARC_PLACARD)});
             const steps = Array.from(body?.querySelectorAll('[data-slot="session-arc-popover-step"]') ?? []);

             return {
               text: (body?.textContent ?? "").trim(),
               rows: steps.map((row) => ({
                 text: (row.querySelector(".tug-popup-list-item-primary")?.textContent ?? "").trim(),
                 status: row.getAttribute("data-status"),
               })),
               blocks: body?.querySelectorAll('[data-slot="tug-arc-lifecycle-block"]').length ?? 0,
               tracks: body?.querySelectorAll('[data-slot="tug-arc-track"]').length ?? 0,
             };
           })()`,
          );
          note("at0473 arc placard", JSON.stringify(placard));
          // The cockpit detail heads with the same block the rail row and the
          // Changes shade wear: the atom, the track, the run fraction, the step
          // it is on — every mark composed from the same components, so the
          // three readings of one arc cannot disagree.
          expect(placard.blocks).toBe(1);
          expect(placard.tracks).toBe(1);
          expect(placard.text).toContain(ARC_NAME);
          expect(placard.text).toContain("1/3");
          // **The list is the plan's ledger**, not the [D100] task list it used
          // to be. This session is a real `--resume` and has written no tasks at
          // all, so under the old reading the placard said "None" over an arc
          // three steps deep — the fraction above it counting a walk the list
          // below it denied existed. The ledger has no way to be silent about a
          // plan it is the ledger of.
          expect(placard.rows.map((r) => r.text)).toEqual([
            "1.The only step",
            "2.The second step",
            "3.The third step",
          ]);
          // And it says where the walk actually is: `arc step start 1` flipped
          // row one and nothing else.
          expect(placard.rows.map((r) => r.status)).toEqual([
            "in progress",
            "pending",
            "pending",
          ]);
          expect(placard.text).not.toContain("None");
          note("at0473 Z2 arc placard", (await app.screenshot()).path);

          // ── The fit again, on a plan four times as long ([P10]) ───────────
          // A constant-width claim tested at one length is not tested. Two more
          // digits is the widest a counted reading ever gets, and the box is the
          // same 18ch — the cell never has to clip. Last, because re-stamping
          // the plan replaces the ledger the placard just read.
          recordStampedPlan(dirA(), ARC_NAME, arc.worktree, {
            rows: 12,
            through: 12,
            binaryRoot: CHECKOUT,
            env: { ...projectA!.cli.env, TUG_SESSION_ID: SID_A },
          });
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(`${CELL} [data-slot="session-telemetry-arc-value"]`)})?.textContent ?? "").trim() === "1/12"`,
            { timeoutMs: 60000 },
          );
          const longBox = await app.evalJS<ArcCellProbe>(PROBE_ARC_CELL);
          note("at0473 Z2 as ARC, twelve steps", JSON.stringify(longBox));
          expect(longBox.text).toBe("1/12");
          expect(
            longBox.scrollWidth,
            "the reading fits its box on a twelve-step plan too",
          ).toBeLessThanOrEqual(longBox.clientWidth);
          expect(longBox.width).toBe(bare.width);

          // ── Z2 during the audit ([B03], [B04]) ────────────────────────────
          // The walk is over and the audit stage is seated. The step in hand is
          // still row 1 by the ledger, and the cell no longer counts it: the
          // numerals are the implement stage's reading and no other's. The
          // strip beneath keeps its `check` key and says the same word.
          appendArcLogLine(
            logPath,
            ARC_NAME,
            "arc-stage",
            "audit " + SID_A + " -",
          );
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(`${CELL} [data-slot="session-telemetry-arc-value"]`)})?.textContent ?? "").trim() === "Audit"`,
            { timeoutMs: 60000 },
          );
          const audited = await app.evalJS<ArcCellProbe>(PROBE_ARC_CELL);
          note("at0473 Z2 as ARC, under audit", JSON.stringify(audited));
          expect(audited.text).toBe("Audit");
          expect(audited.aria).toBe(`arc ${ARC_NAME}, in audit`);
          expect(audited.dots).toEqual(["running", "running"]);
          expect(audited.scrollWidth).toBeLessThanOrEqual(audited.clientWidth);
          // The placard is still up from the click above; a second click
          // would close it. Open it only if something closed it meanwhile.
          if (
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(ARC_PLACARD)}) === null`,
            )
          ) {
            await app.click(CELL);
          }
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${ARC_PLACARD} [data-slot="tug-arc-track"][data-phase="check"]`)}) !== null`,
            { timeoutMs: 10000 },
          );
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

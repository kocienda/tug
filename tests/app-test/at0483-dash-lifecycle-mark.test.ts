/**
 * at0483-dash-lifecycle-mark.test.ts — the COMPACT register of the dash
 * lifecycle grammar, on both surfaces that wear it.
 *
 * One grammar has two registers. Where the dash is the SUBJECT — the Dashes
 * card, the Changes shade's dash lane, the DASH placard — it draws as the
 * track. Where the dash is one FACT ABOUT A SESSION it draws as the mark:
 * `DashPhaseMark` · one pill · `TugStepFraction`, riding the title run after
 * the identity's own `^<dash>` sigil. Both of the mark's hosts come from one
 * component, `SessionIdentityRow`, so this file drives one session and reads
 * the masthead and the Cards card's session row from the same beat — a register
 * that disagreed with itself between two surfaces would be the drift that
 * pinning it is for.
 *
 * Three bindings, three facts the mark has to be able to say:
 *
 *  - A dash with a **declared run** over a longer plan reads `1/3`, not
 *    `1/10`. The numerals count the run somebody asked for; the plan's own
 *    pair is the track's to draw ([D148]).
 *  - A dash with **only a brief** reads `brief` — the LIFECYCLE phase, in a
 *    Title-Case-free `data-phase`, not the git stage. It has no branch and so
 *    no stage at all, which is the half of a dash's life the mark's
 *    predecessor drew blank.
 *  - A **stopped arc** paints `data-stopped` on the mark and its glyph and
 *    turns the pill's state to `stopped`. That attribute is what the CSS keys
 *    the pill's breathing off, and it is asserted rather than the animation:
 *    a background app-test window runs no rAF.
 *
 * Everything is real. The dashes are real dashes in a scratch repository, the
 * rebind runs through the card's own `$` shell route, and the stopped arc is
 * three real dash-log lines the feed folds into `entry.arc` on its next beat.
 *
 * @covers tugdeck/src/components/tugways/dash-lifecycle-mark.tsx
 * @covers tugdeck/src/components/tugways/dash-lifecycle-mark.css
 * @covers tugdeck/src/components/tugways/dash-phase-mark.tsx
 * @covers tugdeck/src/components/tugways/dash-phase-mark.css
 * @covers tugdeck/src/components/tugways/tug-step-fraction.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.css
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/lib/dash-session-index.ts
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
  appendDashLogLine,
  bindDash,
  createDash,
  dashBriefPath,
  dashLogPath,
  makeDashScratchRepo,
  recordStampedPlan,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugtoolPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000483";

/** A ten-row plan with a run declared over its first three steps. */
const RUN_DASH = "at0483-run";
/** A dash that is only a brief: no plan, and no branch behind it. */
const BRIEF_DASH = "at0483-brief";

const CARDS = '.cards-card';
const SESSION_ROW = `${CARDS} [data-session-id="${SID}"]`;

/** The mark on each of its two hosts, reached the way each host composes it. */
// The masthead renders in the PANE TITLE BAR, above the card host — it is not
// inside `[data-card-id]`, so it is addressed bare. The deck this file seeds
// holds one card, which is what makes that unambiguous.
const MASTHEAD_MARK =
  `[data-slot="session-masthead"] [data-slot="session-identity-row-progress"]` +
  ` [data-slot="tug-dash-lifecycle-mark"]`;
const CARDS_MARK =
  `${SESSION_ROW} [data-slot="session-identity-row-progress"]` +
  ` [data-slot="tug-dash-lifecycle-mark"]`;
/** The identity's own `^<dash>` run, inside the masthead's row. */
const MASTHEAD_DASH_RUN =
  `[data-slot="session-masthead"] [data-slot="session-identity-dash"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
let logPath = "";
let briefPath = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0483", checkout: CHECKOUT });
  // Ten rows with a run declared over the first three: the one shape where the
  // run's numerals and the plan's own pair answer different questions, so a
  // mark reading `1/10` would be reading the wrong one.
  const run = createDash(projectDir(), RUN_DASH, "at0483 declared run", scratch.cli);
  recordStampedPlan(projectDir(), RUN_DASH, run.worktree, {
    ...scratch.cli,
    rows: 10,
    through: 3,
  });
  // A dash that never got a branch: a brief at its own address and nothing
  // else. Writing the file is the whole act — a dash HAS a brief when one is
  // at its address.
  createDash(projectDir(), BRIEF_DASH, "at0483 brief only", scratch.cli);
  briefPath = dashBriefPath(projectDir(), BRIEF_DASH);
  writeFileSync(briefPath, "# at0483 brief\n\nThe idea, before there is a plan for it.\n");
  logPath = dashLogPath(scratch.dataRoot);
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

interface MarkReading {
  present: boolean;
  phase: string | null;
  glyphPhase: string | null;
  pillPhase: string | null;
  pillState: string | null;
  stopped: string | null;
  glyphStopped: string | null;
  fraction: string | null;
  label: string;
}

/** One mark, read whole — every attribute this file asserts, from one beat. */
const readMark = (app: App, selector: string): Promise<MarkReading> =>
  app.evalJS<MarkReading>(
    `(() => {
       const mark = document.querySelector(${JSON.stringify(selector)});
       if (mark === null) {
         return {
           present: false, phase: null, glyphPhase: null, pillPhase: null,
           pillState: null, stopped: null, glyphStopped: null,
           fraction: null, label: "",
         };
       }
       const glyph = mark.querySelector('[data-slot="tug-dash-phase-mark"]');
       const pill = mark.querySelector('[data-slot="tug-dash-lifecycle-mark-pill"]');
       const fraction = mark.querySelector('[data-slot="tug-step-fraction"]');
       return {
         present: true,
         phase: mark.getAttribute("data-phase"),
         glyphPhase: glyph?.getAttribute("data-phase") ?? null,
         pillPhase: pill?.getAttribute("data-phase") ?? null,
         pillState: pill?.getAttribute("data-state") ?? null,
         stopped: mark.getAttribute("data-stopped"),
         glyphStopped: glyph?.getAttribute("data-stopped") ?? null,
         fraction: fraction === null ? null : (fraction.textContent ?? "").trim(),
         label: mark.getAttribute("aria-label") ?? "",
       };
     })()`,
  );

const count = (app: App, selector: string): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );

/** Wait until BOTH hosts have drawn a mark, so every reading is one beat. */
const awaitBothMarks = (app: App): Promise<boolean> =>
  app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MASTHEAD_MARK)}) !== null &&
     document.querySelector(${JSON.stringify(CARDS_MARK)}) !== null`,
    { timeoutMs: 30000 },
  );

describe.skipIf(!SHOULD_RUN)("AT0483: the compact dash register", () => {
  test(
    "one grammar on the masthead and the Cards row: the run's numerals, the phase word, and a stopped arc",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0483-dash-lifecycle-mark",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so its dashes reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-cards");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );

        // ── Before any binding, neither host draws anything ───────────────
        expect(await count(app, MASTHEAD_MARK)).toBe(0);
        expect(await count(app, CARDS_MARK)).toBe(0);
        expect(await count(app, MASTHEAD_DASH_RUN)).toBe(0);

        // ── A declared run over a longer plan ─────────────────────────────
        bindDash(projectDir(), RUN_DASH, SID, {
          binaryRoot: CHECKOUT,
          env: scratch?.cli.env,
        });
        await awaitBothMarks(app);

        const masthead = await readMark(app, MASTHEAD_MARK);
        const cardsRow = await readMark(app, CARDS_MARK);
        note("at0483 implement · masthead", JSON.stringify(masthead));
        note("at0483 implement · cards row", JSON.stringify(cardsRow));
        for (const reading of [masthead, cardsRow]) {
          expect(reading.phase).toBe("implement");
          // The glyph and the pill name the same phase as the mark around
          // them: one reading, three elements, never three opinions.
          expect(reading.glyphPhase).toBe("implement");
          expect(reading.pillPhase).toBe("implement");
          expect(reading.pillState).toBe("active");
          // The declared run, not the plan's own ten rows.
          expect(reading.fraction).toBe("1/3");
          expect(reading.stopped).toBeNull();
        }
        // The row names the dash exactly once: one `^<dash>` run, one mark.
        // The masthead's identity is HANDED the binding its row already read,
        // so a second subscription cannot draw a second run beneath it.
        expect(await count(app, MASTHEAD_DASH_RUN)).toBe(1);
        note("at0483 masthead at the implement reading", (await app.screenshot()).path);

        // ── A dash that is only a brief ───────────────────────────────────
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} dash bind ${BRIEF_DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD_MARK)})
             ?.getAttribute("data-phase") === "brief"`,
          { timeoutMs: 30000 },
        );

        const briefMasthead = await readMark(app, MASTHEAD_MARK);
        const briefCards = await readMark(app, CARDS_MARK);
        note("at0483 brief · masthead", JSON.stringify(briefMasthead));
        note("at0483 brief · cards row", JSON.stringify(briefCards));
        for (const reading of [briefMasthead, briefCards]) {
          // The LIFECYCLE phase, which this dash has, and not the git stage,
          // which it does not: `dash create` cut no rounds and the brief is
          // the whole of what exists.
          expect(reading.phase).toBe("brief");
          expect(reading.glyphPhase).toBe("brief");
          // No plan, so no pair to count and no fraction element at all.
          expect(reading.fraction).toBeNull();
        }

        // ── A stopped arc, written as the engine writes it ────────────────
        appendDashLogLine(logPath, BRIEF_DASH, "arc-start", briefPath);
        appendDashLogLine(logPath, BRIEF_DASH, "arc-stage", "devise claude-at0483 opus");
        appendDashLogLine(logPath, BRIEF_DASH, "arc-stop", "devise you took the card back");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD_MARK)})
             ?.getAttribute("data-stopped") === "true"`,
          { timeoutMs: 30000 },
        );

        const stopped = await readMark(app, MASTHEAD_MARK);
        const stoppedCards = await readMark(app, CARDS_MARK);
        note("at0483 stopped · masthead", JSON.stringify(stopped));
        note("at0483 stopped · cards row", JSON.stringify(stoppedCards));
        for (const reading of [stopped, stoppedCards]) {
          // `data-stopped` on the mark AND on the glyph inside it. This is
          // what the CSS keys the breathing off, and it is the attribute
          // rather than the animation because a background window runs no
          // rAF and would report whatever frame it never drew.
          expect(reading.stopped).toBe("true");
          expect(reading.glyphStopped).toBe("true");
          expect(reading.pillState).toBe("stopped");
        }
        // The whole reading, in words, for a reader who cannot see the marks.
        expect(stopped.label.startsWith(`dash ${BRIEF_DASH} — stopped ·`)).toBe(true);
        note("at0483 masthead at the stopped reading", (await app.screenshot()).path);

        // ── Unbind takes both marks away ──────────────────────────────────
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} dash unbind`, 1);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(MASTHEAD_MARK)}).length === 0 &&
           document.querySelectorAll(${JSON.stringify(CARDS_MARK)}).length === 0`,
          { timeoutMs: 30000 },
        );
        expect(await count(app, MASTHEAD_DASH_RUN)).toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

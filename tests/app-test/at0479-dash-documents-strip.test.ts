/**
 * at0479-dash-documents-strip.test.ts — the Changes shade shows a dash's own
 * documents, and opens them.
 *
 * A dash's brief and its plan were readable because they were files in the
 * working tree the reader could open. They are still files — at
 * `.tug/dashes/<name>/`, untracked — and the card must not have made them
 * harder to reach by moving them. This drives the whole of that claim through
 * the real app: a real dash whose documents the real CLI addresses by name,
 * bound to a real session, with the strip read out of the shade's DOM and one
 * of its rows clicked to prove the open lands on the absolute path the server
 * handed over.
 *
 * Both shapes of dash are driven, because they are different renders:
 *
 *  - A **branchless** dash — documents written, no `dash create` yet — is the
 *    planning phase in flight. It fronts the lane on its own row, with the
 *    strip and no diff, join, or discard affordances: there is no branch for
 *    any of them to act on.
 *  - A **live** dash carries the same strip inside its fold, above the rounds.
 *
 * The plan row's facts come from the server's own reading of the document, so
 * an unreviewed plan two steps long says exactly that — which is the fact a
 * reader would otherwise have opened the file to learn.
 *
 * The project is a scratch repository this file owns, registered as a
 * workspace by spawning a real session on it: no fixture ever writes a dash
 * document into the checkout under test.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-documents.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-documents.css
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/dash-lifecycle-block.tsx
 * @covers tugdeck/src/lib/document-dash-entry.ts
 * @covers tugdeck/src/lib/changes-route-controller.ts
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 * @covers tugrust/crates/tugdash-core/src/ops.rs
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
  bindDash,
  createDash,
  dashBriefPath,
  dashPlanPath,
  fixturePlanDocument,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000479";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

/** The dash under test — branchless first, then given a branch. */
const DASH_NAME = "at0479-strip";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH_NAME}"]`;
const DOCUMENTS = `${ROW} [data-slot="session-dash-document"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

const BRIEF_TITLE = "The strip brief";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0479", checkout: CHECKOUT });
  // Written straight to the dash's own address, and never through the scratch
  // repo's `files` map: a document is not a tracked file, and a fixture that
  // committed one would be testing a world this plan deleted.
  writeFileSync(
    dashBriefPath(projectDir(), DASH_NAME),
    `# ${BRIEF_TITLE}\n\nProse the arc would open on.\n`,
  );
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

interface DocumentReading {
  role: string | null;
  review: string | null;
  title: string;
  facts: string;
}

const readDocuments = (
  app: Awaited<ReturnType<typeof launchTugApp>>,
): Promise<DocumentReading[]> =>
  app.evalJS<DocumentReading[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENTS)})).map((row) => ({
       role: row.getAttribute("data-role"),
       review: row.getAttribute("data-review"),
       title: (row.querySelector('[data-slot="session-dash-document-title"]')?.textContent ?? "").trim(),
       facts: (row.querySelector('[data-slot="session-dash-document-facts"]')?.textContent ?? "").trim(),
     }))`,
  );

describe.skipIf(!SHOULD_RUN)("AT0479: the dash's documents on the shade", () => {
  test(
    "a bound dash shows its brief and plan, and a row opens the file",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0479-dash-documents-strip",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", {
          tugSessionId: SID,
          projectDir: projectDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // Bound before any branch exists — the whole point of the branchless
        // shape. The binding is the real verb, so the owner key the lane
        // fronts on is the one the engine composes.
        bindDash(projectDir(), DASH_NAME, SID, {
          binaryRoot: CHECKOUT,
          env: scratch!.cli.env,
        });

        // ── Raise the changes shade ────────────────────────────────────────
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );

        // ── A dash that is only a brief is still a dash, and it fronts ─────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROW}[data-branchless="true"]`)}) !== null`,
          { timeoutMs: 40000 },
        );
        const briefOnly = await readDocuments(app);
        note("at0479 brief only", JSON.stringify(briefOnly));
        expect(briefOnly).toHaveLength(1);
        expect(briefOnly[0]!.role).toBe("brief");
        // The title is the document's own first heading, read on the server —
        // the card has no filesystem to read it with.
        expect(briefOnly[0]!.title).toBe(BRIEF_TITLE);

        // None of the branch-shaped affordances stand: there is no branch.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(`${ROW} [data-slot="session-changes-dash-fold"]`)}).length`,
          ),
        ).toBe(0);
        note("at0479 branchless", (await app.screenshot()).path);

        // ── The plan arrives, unstamped and two steps long ─────────────────
        writeFileSync(
          dashPlanPath(projectDir(), DASH_NAME),
          fixturePlanDocument(2),
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(DOCUMENTS)}).length === 2`,
          { timeoutMs: 40000 },
        );
        const withPlan = await readDocuments(app);
        note("at0479 with plan", JSON.stringify(withPlan));
        const plan = withPlan.find((row) => row.role === "plan")!;
        expect(plan.review).toBe("never-reviewed");
        // The facts are what a reader would otherwise open the file to learn.
        expect(plan.facts).toBe("never-reviewed · 2 steps");

        // ── Clicking a row opens that document in a Text card ──────────────
        // The proof is the document's own bytes on screen: a Text card
        // carrying the brief's heading is the file, opened, and nothing else
        // in the deck could be showing it.
        const briefPath = dashBriefPath(projectDir(), DASH_NAME);
        await app.nativeClickAtElement(
          `${ROW} [data-slot="session-dash-document"][data-role="brief"]`,
        );
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll('[data-slot="text-card"]'))
             .some((card) => (card.textContent ?? "").includes(${JSON.stringify(BRIEF_TITLE)}))`,
          { timeoutMs: 20000 },
        );
        note("at0479 opened brief", briefPath);

        // ── The same strip rides a live dash's fold ───────────────────────
        // Cutting the branch moves the dash to a dash row; the documents do
        // not move, because they were never inside the worktree.
        createDash(projectDir(), DASH_NAME, "at0479 strip", scratch!.cli);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROW} [data-slot="session-changes-dash-fold"]`)}) !== null`,
          { timeoutMs: 40000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(DOCUMENTS)}).length === 2`,
          { timeoutMs: 40000 },
        );
        const live = await readDocuments(app);
        note("at0479 live dash", JSON.stringify(live));
        expect(live.map((row) => row.role)).toEqual(["brief", "plan"]);
        expect(live.find((row) => row.role === "plan")!.facts).toBe(
          "never-reviewed · 2 steps",
        );
        note("at0479 live", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

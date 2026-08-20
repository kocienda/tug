/**
 * at0417-join-mode.test.ts — `/dash-join` opens the join editor instead of
 * spending a turn.
 *
 * ## Why this exists
 *
 * The gesture used to submit a `tugplug:dash-join` skill turn: the model
 * shelled out, read the output, and reported back in prose. That works, but it
 * puts the preview in the transcript instead of in front of the button and
 * gives the join message no editor. This asserts the seam is closed — the verb
 * enters a mode and the composer becomes the join-message editor over the
 * dash's draft row.
 *
 * The route group is INVARIANT: two segments, bound or unbound. *Changes* names
 * the room and the Z5 land button names the act, so what proves join mode here
 * is the button reading `Join` while the route reads `changes` — not a third
 * segment appearing under the pointer.
 *
 * The retired `/join` spelling is the one part of the rename a user can hit by
 * accident, so it is the part that gets an assertion: it runs the same handler
 * and says the new name once. A verb that simply stopped matching would submit
 * the user's line to Claude as a prompt, which is worse than either.
 *
 * ## Test matrix
 *
 *   1. Bare `/dash-join` on a bound card: the route reads `changes`, the land
 *      button reads `Join`, and the shade is up.
 *   2. `/dash-join <name> <message>` seeds the message as an edited draft.
 *   3. Escape returns to Prompt, and re-entering resumes that message from the
 *      dash's draft row — the same read that opens a run's maintained join
 *      draft. (Seeding it from the card is what puts the row in this
 *      instance's own ledger; a CLI-written draft belongs to another one.)
 *   4. The retired `/join` enters the same mode and raises the bulletin.
 *
 * The unbound case (two segments, bare `/dash-join` cautions) runs first,
 * before the card is bound to anything — and the segment count is asserted
 * again after the bind, because staying two is the whole point.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/landing-mode.ts
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createDash,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type DashScratchRepo,
} from "./dash-fixture";
import { readDashRowMenu } from "./dash-row-menu-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000417";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const BULLETIN = ".tug-pane-bulletin";
// The dash marker on the masthead's title line — the identity's own run
// since the masthead badge was retired. Scoped to the masthead, because a
// line-tier identity anywhere else (a Lens row, a picker row) wears it too.
const CHIP =
  '[data-slot="session-masthead"] [data-slot="session-identity-dash"]';
/** What that run reads: the identity's dash grammar, sigil included. */
const chipText = (dash: string): string => `^${dash}`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
const DASH = "at0417-join";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0417", checkout: CHECKOUT });
  const created = createDash(projectDir(), DASH, "at0417 fixture", scratch.cli);
  // A round, so the dash is not empty — an empty dash has no join to preview.
  writeFileSync(join(created.worktree, "at0417.txt"), "at0417\n");
  commitRound(projectDir(), DASH, "at0417 round", scratch.cli);
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

async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  // Dismiss the slash completion popup so Enter submits rather than accepting.
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

/** The Z5 land button, whose accessible name is the landing's own verb. */
const LAND_BUTTON = `${CARD} .tug-prompt-entry-commit-button`;

/** The value of the selected route segment: "prompt" | "changes" | "". */
async function selectedRoute(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(ROUTE_GROUP)} + ' [data-state="active"]');
      return el ? (el.getAttribute("data-choice-value") || "") : "";
    })()`,
  );
}

async function waitForRoute(app: App, value: string, where: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      // waitForRoute: ${where}
      var el = document.querySelector(${JSON.stringify(ROUTE_GROUP)} + ' [data-state="active"]');
      return el !== null && el.getAttribute("data-choice-value") === ${JSON.stringify(value)};
    })()`,
    { timeoutMs: 12000 },
  );
}

/**
 * Wait for the land button to name a given act. With the route group invariant
 * this is what tells a join apart from a commit.
 */
async function waitForLandWord(app: App, word: string, where: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      // waitForLandWord: ${where}
      var el = document.querySelector(${JSON.stringify(LAND_BUTTON)});
      return el !== null && el.getAttribute("aria-label") === ${JSON.stringify(word)};
    })()`,
    { timeoutMs: 12000 },
  );
}

/** Every route segment's value, in render order. */
async function routeValues(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(
       document.querySelectorAll(${JSON.stringify(ROUTE_GROUP)} + ' [data-choice-value]')
     ).map(function(el){ return el.getAttribute("data-choice-value"); })`,
  );
}

async function composerText(app: App): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent || "")`,
  );
}

async function bulletinText(app: App): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(BULLETIN)})?.textContent || "").trim()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0417: /dash-join enters join mode", () => {
  test(
    "the verb opens the join editor on the dash's draft, the land button says Join, and the retired spelling still lands",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0417-join-mode",
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

        // ── Unbound: two segments, and the bare verb cautions ─────────────
        // Asserted before the bind, which is the only moment this card is
        // honestly unbound.
        expect(await routeValues(app)).toEqual(["prompt", "changes"]);
        await runCommand(app, "/dash-join");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BULLETIN)}) !== null`,
          { timeoutMs: 8000 },
        );
        expect(await bulletinText(app)).toContain("/dash-join");
        expect(await selectedRoute(app)).toBe("prompt");

        // ── Wait for the aggregate, then bind ─────────────────────────────
        // Before the first compose the dash name misses every snapshot match,
        // so `/dash-bind <name>` would fall through to the create path.
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector('${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LENS_SECTION)}) === null`,
          { timeoutMs: 8000 },
        );
        await runCommand(app, `/dash-bind ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)})?.textContent.trim() === ${JSON.stringify(chipText(DASH))}`,
          { timeoutMs: 20000 },
        );

        // ── Bound: the group is still two segments ────────────────────────
        // The bind must not move the chrome. This is the assertion that would
        // have caught a third segment growing back.
        expect(await routeValues(app)).toEqual(["prompt", "changes"]);

        // ── Bare `/dash-join` opens the editor over the shade ─────────────
        await runCommand(app, "/dash-join");
        await waitForRoute(app, "changes", "after bare /dash-join");
        // The route names the room; the button names the act.
        await waitForLandWord(app, "Join", "after bare /dash-join");
        // The landing happens over the shade, exactly as commit's does.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("Escape");
        await waitForRoute(app, "prompt", "after Escape");

        // ── A named dash plus a message seeds the message ─────────────────
        const seeded = "at0417 seeded from the command line";
        await runCommand(app, `/dash-join ${DASH} ${seeded}`);
        await waitForRoute(app, "changes", "after the seeded form");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent || "").indexOf(${JSON.stringify(seeded)}) !== -1`,
          { timeoutMs: 12000 },
        );

        // ── Escape returns to Prompt; re-entry resumes the message ────────
        // The seed was written into the dash's draft row as an edited draft, so
        // the message that comes back is the *persisted* one — the same read
        // that opens a run's maintained join draft.
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("Escape");
        await waitForRoute(app, "prompt", "after the seeded form's Escape");
        await runCommand(app, "/dash-join");
        await waitForRoute(app, "changes", "after re-entry");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent || "").indexOf(${JSON.stringify(seeded)}) !== -1`,
          { timeoutMs: 12000 },
        );
        note(`composer on re-entry: ${JSON.stringify(await composerText(app))}`);
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("Escape");
        await waitForRoute(app, "prompt", "after the second Escape");

        // ── The retired `/join` runs, and says the new name ───────────────
        await app.evalJS<boolean>(
          `(function(){
             var b = document.querySelector(${JSON.stringify(BULLETIN)});
             if (b === null) return true;
             var x = b.querySelector('button');
             if (x !== null) x.click();
             return true;
           })()`,
        );
        await settle(400);
        await runCommand(app, "/join");
        await waitForRoute(app, "changes", "after the retired /join");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(BULLETIN)})?.textContent || "").indexOf("/dash-join") !== -1`,
          { timeoutMs: 8000 },
        );
        const retired = await bulletinText(app);
        expect(retired).toContain("/join is now /dash-join");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dash joined by name fronts, even though the card is bound to nothing",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0417-join-mode-named",
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
        // Deliberately no dash binding: `/dash-join <name>` aims without
        // binding, and this is the state the gap lived in.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(CHIP)}).length === 0`,
          { timeoutMs: 10000 },
        );
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector('${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-lens");

        await runCommand(app, `/dash-join ${DASH}`);
        await waitForRoute(app, "changes", "after a named join on an unbound card");
        // Aimed but unbound is still a join, and the button is what says so.
        await waitForLandWord(app, "Join", "after a named join on an unbound card");

        // The landing face lives on the fronted row alone. Before the fix this
        // row never fronted, so a named join came up live in the composer with
        // nothing in the room to explain a refusal — a disabled button and no
        // way to learn why.
        const FRONTED = `${SHEET} [data-slot="session-changes-dash-lane-fronted-label"]`;
        const ROW = `${SHEET} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRONTED)}) !== null`,
          { timeoutMs: 15000 },
        );
        const face = await app.evalJS<{ fronted: string | null; landing: number }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const rows = document.querySelectorAll(${JSON.stringify(`${SHEET} [data-slot="session-changes-dash-row"]`)});
             return {
               fronted: (rows[0] ?? null)?.getAttribute("data-dash") ?? null,
               landing: row === null ? -1 : row.querySelectorAll('[data-slot="session-changes-dash-join"]').length,
             };
           })()`,
        );
        note(`at0417 named-join face: ${JSON.stringify(face)}`);
        expect(face.fronted).toBe(DASH);
        // Fronted is not bound: the card never adopted this dash, so its menu
        // offers to take it on rather than to put it down. Asked of the menu,
        // because that is where the verbs live now ([P08]).
        const verbs = await readDashRowMenu(app, ROW);
        expect(verbs.bind.present).toBe(true);
        expect(verbs.unbind.present).toBe(false);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

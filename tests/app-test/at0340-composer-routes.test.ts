/**
 * at0340-composer-routes.test.ts — the composer's two routes and the ways in
 * and out of them ([AT0340]).
 *
 * ## Why this exists
 *
 * A route is a mode that owns the composer's whole document ([D122]), and the
 * Z4A group is a *view* of `CommitModeController` rather than a second home
 * for the selection. That claim is only worth anything if every door moves the
 * visible tab — so this drives the doors, not the control: a chord, a typed
 * command, and a click each have to agree with the mode.
 *
 * The stash-and-restore case is the one that proves "owns the document":
 * a typed prompt draft must survive a round trip through Changes verbatim.
 *
 * ## Test matrix
 *
 *   1. ⌃⌘C enters Changes (shade up, tab selected) and leaves it again.
 *   2. ⌃⌘P selects Prompt from Changes — and is a no-op while already on
 *      Prompt, since it names a route rather than toggling.
 *   3. A one-shot verb (`/btw`) leaves the route where it was. Neither route
 *      has a typeable name at all — a slash command is a verb that returns you
 *      where you were, a route is a mode you stay in — so the doors are the
 *      chords, the tab, and Escape.
 *   4. Draft stash-and-restore: a typed prompt survives Prompt → Changes →
 *      Prompt verbatim, and the composer holds the commit message in between.
 *   5. The same door on a card mated to a dash opens the *other* landing:
 *      ⌃⌘C raises the shade with the route reading `changes` and the Z5 button
 *      reading `Join`. One room, two acts.
 *
 * Case 5 is why the group is invariant. The door is the same gesture in both,
 * and the card's binding — not a segment the user has to find — decides which
 * landing it opens.
 *
 * The two-segment rendering and the click path are at0215's; this suite is
 * about the non-click doors agreeing with them.
 *
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchTugApp, type App } from "./_harness";
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

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "at0340";

const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const ENTRY_ROOT = `${CARD} [data-slot="tug-prompt-entry"]`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const CHANGES_ACTIVE = `${CARD} .session-view-slot[data-active-view="changes"]`;

const DRAFT = "explain the parser to me";

/** The Z5 land button — its accessible name is the landing's own verb. */
const LAND_BUTTON = `${CARD} .tug-prompt-entry-commit-button`;

/** The bound case needs a real dash, so it runs against the real repo. */
/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const DASH = "at0340-changes-door";
const DASHES_CARD = '.dashes-section';
const BOUND_SID = "a7c0d1ea-0000-4000-8000-000000000340";

/** The scratch repository the dash case owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

let dir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0340-"));
  scratch = makeDashScratchRepo({ prefix: "at0340", checkout: CHECKOUT });
  const created = createDash(projectDir(), DASH, "at0340 changes-door fixture", scratch.cli);
  // A round, so the dash is not empty — the landing face needs something to
  // land, and an empty dash's answer is release rather than join.
  writeFileSync(join(created.worktree, "at0340.txt"), "at0340\n");
  commitRound(projectDir(), DASH, "at0340 round", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), BOUND_SID);
});

afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
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

/** Synthetic chord at the active element (the at0088 / at0221 precedent — a
 *  posted ⌘ chord can be eaten by macOS before it reaches the WebView). */
async function chord(
  app: App,
  code: string,
  key: string,
  mods: { meta?: boolean; shift?: boolean; ctrl?: boolean } = {},
): Promise<void> {
  await app.evalJS<boolean>(
    `(function(){
      var t = document.activeElement || document;
      return t.dispatchEvent(new KeyboardEvent("keydown", {
        code: ${JSON.stringify(code)},
        key: ${JSON.stringify(key)},
        metaKey: ${mods.meta === true},
        shiftKey: ${mods.shift === true},
        ctrlKey: ${mods.ctrl === true},
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    })()`,
  );
}

/**
 * A chord aimed at the composer. Both mode flips move focus (commit mode
 * re-focuses the editor in a layout effect), so a chord fired into whatever
 * `activeElement` happens to be mid-transition is a flake; landing the caret
 * first makes each press a real gesture from a settled surface.
 */
async function pressChord(
  app: App,
  code: string,
  key: string,
  mods: { meta?: boolean; shift?: boolean; ctrl?: boolean } = {},
): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await new Promise((r) => setTimeout(r, 150));
  await chord(app, code, key, mods);
}

/** The value of the selected route segment: "prompt" | "changes" | "". */
async function selectedRoute(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(ROUTE_GROUP)} + ' [data-state="active"]');
      return el ? (el.getAttribute("data-choice-value") || "") : "";
    })()`,
  );
}

/** `where` rides into the script as a comment so a timeout names its own
 *  call site — every wait here polls the same selector otherwise. */
async function waitForRoute(
  app: App,
  value: string,
  where: string,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      // waitForRoute: ${where}
      var el = document.querySelector(${JSON.stringify(ROUTE_GROUP)} + ' [data-state="active"]');
      return el !== null && el.getAttribute("data-choice-value") === ${JSON.stringify(value)};
    })()`,
    { timeoutMs: 8000 },
  );
}

/** The composer's document text. */
async function composerText(app: App): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent || "")`,
  );
}

/** Focus the editor, type `line`, settle, and force-submit with ⌘Return. */
async function submitLine(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
}

/**
 * Submit a slash command, dismissing the completion popup first.
 *
 * {@link submitLine} is enough for a verb the picker does not offer a match
 * for, but with the popup up ⌘Return accepts the completion instead of
 * submitting the line — so a command typed that way silently never runs.
 */
async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await new Promise((r) => setTimeout(r, 200));
  await app.nativeKey("Escape");
  await new Promise((r) => setTimeout(r, 200));
  await app.nativeKey("Return", ["cmd"]);
}

/** Empty the draft, whatever it holds. The emptiness gate is the entry root's
 *  `data-empty` bridge — an empty editor still renders placeholder text. */
async function clearDraft(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeKey("a", ["cmd"]);
  await app.nativeKey("Backspace");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ENTRY_ROOT)}).getAttribute("data-empty") === "true"`,
    { timeoutMs: 4000 },
  );
}

async function seedSession(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
  await app.bindSession("A", { tugSessionId: SID, projectDir: dir });
  await app.awaitEngineReady("A");

  // One committed turn so the card is in its resting state.
  await app.driveSession("A", { op: "send", text: "hello" });
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: {
      tug_session_id: SID,
      type: "assistant_text",
      msg_id: "m1",
      text: "hi there",
      is_partial: false,
      rev: 0,
      seq: 0,
    },
  });
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, type: "turn_complete", msg_id: "m1", result: "success" },
  });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ROUTE_GROUP)}) !== null`,
    { timeoutMs: 8000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0340: the composer's two routes", () => {
  test(
    "⌃⌘C and ⌃⌘P agree with the tab, a verb leaves it alone, and a draft survives the round trip",
    async () => {
      const app = await launchTugApp({ testName: "at0340-composer-routes" });
      try {
        await seedSession(app);

        expect(await selectedRoute(app), "Prompt at rest").toBe("prompt");

        // --- 1. ⌃⌘C enters Changes and leaves again. ---
        await pressChord(app, "KeyC", "c", { meta: true, ctrl: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHANGES_ACTIVE)}) !== null`,
          { timeoutMs: 8000 },
        );
        await waitForRoute(app, "changes", "ctrl-cmd-c enters");
        // An unbound card lands by committing, and the Z5 button says so. The
        // segment cannot: it reads `changes` in both landings.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${LAND_BUTTON}[aria-label="Commit"]`)}) !== null`,
          { timeoutMs: 8000 },
        );
        // This card's project is a bare temp directory, so the shade has no
        // dashes to list — and a lane with nothing in it renders nothing at
        // all, not an empty group label.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(`${CARD} [data-slot="session-changes-dash-lane"]`)}).length`,
          ),
          "a project with no dashes renders no lane",
        ).toBe(0);

        await pressChord(app, "KeyC", "c", { meta: true, ctrl: true });
        await waitForRoute(app, "prompt", "ctrl-cmd-c exits");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHANGES_ACTIVE)}) === null`,
          { timeoutMs: 8000 },
        );

        // --- 2. ⌃⌘P names Prompt: it returns from Changes, and while already
        //        on Prompt it is a no-op rather than a flip. ---
        await pressChord(app, "KeyC", "c", { meta: true, ctrl: true });
        await waitForRoute(app, "changes", "ctrl-cmd-c re-enters");
        await pressChord(app, "KeyP", "p", { meta: true, ctrl: true });
        await waitForRoute(app, "prompt", "ctrl-cmd-p returns");

        await pressChord(app, "KeyP", "p", { meta: true, ctrl: true });
        await new Promise((r) => setTimeout(r, 600));
        expect(
          await selectedRoute(app),
          "⌃⌘P on Prompt is a no-op, not a toggle into Changes",
        ).toBe("prompt");

        // --- 3. A one-shot verb leaves the route alone. ---
        await submitLine(app, "/btw what did I just say");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-slot="side-question-body"]') !== null`,
          { timeoutMs: 8000 },
        );
        expect(
          await selectedRoute(app),
          "a one-shot verb leaves the route where it was",
        ).toBe("prompt");
        await app.nativeKey("Escape");

        // --- 4. The draft stash-and-restore — the "owns the document" proof. ---
        await clearDraft(app);
        await app.nativeClickAtElement(EDITOR);
        await app.nativeType(DRAFT);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent || "").indexOf(${JSON.stringify(DRAFT)}) !== -1`,
          { timeoutMs: 4000 },
        );

        await pressChord(app, "KeyC", "c", { meta: true, ctrl: true });
        await waitForRoute(app, "changes", "draft stash enters");
        // In Changes the composer is the commit-message editor — the prompt
        // draft is stashed, not merely hidden.
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent || "").indexOf(${JSON.stringify(DRAFT)}) === -1`,
          { timeoutMs: 6000 },
        );

        await pressChord(app, "KeyP", "p", { meta: true, ctrl: true });
        await waitForRoute(app, "prompt", "draft restore returns");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent || "").indexOf(${JSON.stringify(DRAFT)}) !== -1`,
          { timeoutMs: 6000 },
        );
        expect(
          (await composerText(app)).includes(DRAFT),
          "the prompt draft returns verbatim",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the same door on a dash-bound card opens the join landing",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0340-composer-routes-bound",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15_000 },
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace (so the dash reaches the aggregate) and writes
        // the live ledger row `/dash-bind`'s CONTROL frame resolves the
        // calling session through.
        await app.spawnSessionResume("A", {
          tugSessionId: BOUND_SID,
          projectDir: projectDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // Wait for the dash to reach the aggregate before binding: before the
        // first compose `/dash-bind <name>` misses every snapshot match and
        // falls through to the create path.
        await app.dispatchControlAction("toggle-dashes");
        await app.waitForCondition<boolean>(
          `document.querySelector('${DASHES_CARD} [data-slot="dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-dashes");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASHES_CARD)}) === null`,
          { timeoutMs: 8000 },
        );
        await runCommand(app, `/dash-bind ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-slot="session-masthead"] [data-slot="session-identity-dash"]')?.textContent.trim() === ${JSON.stringify(`^${DASH}`)}`,
          { timeoutMs: 20000 },
        );

        // The group did not grow a segment under the bind.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(ROUTE_GROUP)} + ' [data-choice-value]').length`,
          ),
          "the bind leaves the route group at two segments",
        ).toBe(2);

        // The same chord as case 1, on a mated card: same room, other act.
        await pressChord(app, "KeyC", "c", { meta: true, ctrl: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHANGES_ACTIVE)}) !== null`,
          { timeoutMs: 8000 },
        );
        await waitForRoute(app, "changes", "ctrl-cmd-c on a bound card");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${LAND_BUTTON}[aria-label="Join"]`)}) !== null`,
          { timeoutMs: 12000 },
        );

        // And the chord still closes what it opened — the exit branch has to
        // test the join controller too, not only commit mode.
        await pressChord(app, "KeyC", "c", { meta: true, ctrl: true });
        await waitForRoute(app, "prompt", "ctrl-cmd-c exits a join");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHANGES_ACTIVE)}) === null`,
          { timeoutMs: 8000 },
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    240_000,
  );
});

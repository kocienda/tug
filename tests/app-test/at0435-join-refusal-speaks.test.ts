/**
 * at0435-join-refusal-speaks.test.ts — a refused land press says why, on
 * screen, in the real app ([L31]).
 *
 * The corpus had never pressed a land button. `at0417` asserts the button's
 * *word* and `at0418` asserts that the affordance opens the editor; nothing
 * walked submit → gate → refusal, which is precisely where the dash-join dead
 * press lived. The refusal was computed, discarded, and shown nowhere, so days
 * of investigation had nothing to read.
 *
 * What this drives is the mechanism, not a hypothesis about which condition
 * fires: an empty message over an otherwise landable dash is the cheapest
 * deterministic refusal there is. The press produces a bulletin carrying the
 * gate's own sentence, the mode stays up, and nothing goes on the wire.
 *
 * It is driven both ways, because only one of them was ever broken. A submit
 * CHORD reaches `land()` whatever the button looks like; a CLICK on the button
 * did not, because the button was HTML-disabled on the gate and
 * `pointer-events: none` on an empty message. Pressing it with a mouse
 * produced no act and no sentence — the refusal was computed and hung where no
 * gesture could reach it. The button dims now without going numb.
 *
 * Safe by construction: the gate refuses, so no join is ever executed against
 * any branch.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/landing-mode.ts
 * @covers tugdeck/src/lib/landing-notice.ts
 * @covers tugdeck/src/components/tugways/cards/landing-notice-controller.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.css
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type JoinScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000435";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-toolbar .tug-prompt-entry-route-group`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;

/** The checkout whose built binaries the fixture drives — never the project. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const FILE = "subject.txt";

/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";
const DASH = "at0435-work";
let fixtureDir = "";
let tugbankPath = "";
let dashId = "";

const row = (dash: string): string =>
  `${LANE} [data-slot="session-changes-dash-row"][data-dash="${dash}"]`;
const landing = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join"]`;
const verdict = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join-verdict"]`;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // A repository of the fixture's own. The refusal under test is the *last* one
  // in the gate's order, so everything before it has to pass — including the
  // verdict, which means this dash gets resolved and verified for real when
  // join mode opens ([P03]). Aimed at the developer's checkout that would be
  // the project's own declared checks, run because somebody opened a composer.
  scratch = makeJoinScratchRepo({
    prefix: "at0435",
    dash: DASH,
    description: "at0435 fixture (a round to land)",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0435 the dash's file\n",
    base: "at0435 SENTINEL the base's own file\n",
    dashBody: "at0435 SENTINEL the dash rewrote it\n",
    cleanMerge: true,
    verifyTier0: `grep -q SENTINEL ${FILE}`,
    resolver: "#!/bin/sh\nexit 0\n",
  });
  dashId = scratch.dashId;

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The repository IS the teardown: branch, worktree, config, and dash all go
  // with the directory.
  rmJoinScratchRepo(scratch);
  rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
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

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Click `target` until `expected` matches, re-aiming between attempts (at0418). */
async function clickUntil(app: App, target: string, expected: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await app.evalJS<null>(
      `(() => {
         const el = document.querySelector(${JSON.stringify(target)});
         if (el !== null) el.scrollIntoView({ block: "center" });
         return null;
       })()`,
    );
    await settle();
    await app.nativeClickAtElement(target);
    try {
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(expected)}) !== null`,
        { timeoutMs: 3000 },
      );
      return;
    } catch {
      note(`at0435 click on ${target} did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(`at0435: ${expected} never appeared after clicking ${target}`);
}

/**
 * Put the composer back on the prompt route.
 *
 * Load-bearing before any typed command. `raiseShade` leaves the composer in
 * **commit mode**, where the editor *is* the commit message — so a `/dash-join`
 * typed there is message text, not a command, and submitting it does nothing a
 * route assertion can see. A slash command has to be typed from the prompt
 * route, which is where every one of them is read. at0418 and at0436 record the
 * same trap.
 */
async function returnToPrompt(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await settle();
  await app.nativeKey("Escape");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="prompt"][data-state="active"]`)}) !== null`,
    { timeoutMs: 8000 },
  );
}

/** Enter join mode on a dash by its named route — the row offers no control. */
async function enterJoinMode(app: App, dash: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(`/dash-join ${dash}`);
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

async function raiseShade(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType("/commit");
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 8000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(LANE)}) !== null`,
    { timeoutMs: 40000 },
  );
}

async function settledOutcome(app: App, dash: string): Promise<string> {
  const read = `(document.querySelector(${JSON.stringify(landing(dash))})?.getAttribute("data-outcome") ?? "")`;
  await app.waitForCondition<boolean>(
    `(() => { const o = ${read}; return o !== ""; })()`,
    { timeoutMs: 40000 },
  );
  return app.evalJS<string>(read);
}

/** Every bulletin currently on screen, as text. */
const BULLETIN_TEXTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map(function(e){ return e.textContent || ""; })`;

describe.skipIf(!SHOULD_RUN)("AT0435: a refused land press speaks", () => {
  test(
    "submitting a join with no message says what is missing and sends nothing",
    async () => {
      tugbankPath = mkTempTugbank();
      // The source tree is where the app finds `tugdeck/dist` to serve, so it
      // stays the checkout; the *project* is the scratch repo.
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0435-join-refusal-speaks",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A real session spawn, not a bind: the scratch repo reaches the
        // server the only way a project ever does — by a session registering
        // its workspace.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await raiseShade(app);
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: dashId,
          dash_name: DASH,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landing(DASH))}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(await settledOutcome(app, DASH), "the fixture must be landable").toBe("clean");

        // The landable row states its route rather than offering a control,
        // and this is that route. Entering it resolves the dash and verifies
        // what that built ([P03]) — the refusal under test is the last one in
        // the gate's order, so every earlier one has to be clear first.
        //
        // Back to the prompt route first: `raiseShade` left the composer in
        // commit mode, and a slash command typed there is message text.
        await returnToPrompt(app);
        await enterJoinMode(app, DASH);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`)}) !== null`,
          { timeoutMs: 12000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Wait out the verdict before pressing. Entering join mode resolved the
        // dash and started the project's declared checks over what that built
        // ([P03]), and an unfinished verdict is its own refusal — "Verify the
        // joined tree first" — which fires *ahead* of the empty message in the
        // gate's order. Pressing early therefore measures the wrong refusal.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(verdict(DASH))})?.getAttribute("data-verdict") === "green"`,
          { timeoutMs: 180000 },
        );

        // The editor opens empty: a fixture dash has no maintained join draft,
        // and nothing here writes one. Nothing clears it either — `⌘A` is a
        // menu chord and menu chords die in a background window (at0043 takes
        // the screen for exactly that reason), so the fixture supplies
        // the empty document instead of a keystroke pretending to.
        await app.nativeClickAtElement(EDITOR);
        await settle();
        // Emptiness is `.cm-placeholder`, never `textContent`: CM6 renders the
        // placeholder inside `.cm-content` when the document length is 0, so
        // an empty join editor reads as "Write the join message, or use
        // Auto-Message." to anyone asking the DOM for its text (at0043).
        const opening = await app.evalJS<{ text: string; empty: boolean }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(EDITOR)});
             return {
               text: el?.textContent ?? "",
               empty: el !== null && el.querySelector(".cm-placeholder") !== null,
             };
           })()`,
        );
        note(`at0435 join editor opened with: ${JSON.stringify(opening)}`);
        expect(opening.empty, "the refusal under test is the empty message").toBe(true);
        const buttonDisabled = await app.evalJS<boolean>(
          `(() => {
             const b = document.querySelector(${JSON.stringify(JOIN_BUTTON)});
             return b !== null && (b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true");
           })()`,
        );
        note(`at0435 land button disabled with an empty message: ${buttonDisabled}`);

        // The press. Submit reaches `land()` whatever the button looks like —
        // which is the whole reason the refusal has to speak for itself.
        await app.nativeKey("Return", ["cmd"]);

        // Wait for the channel to say *something*, and report whatever it said
        // before asserting on the words. A bare wait for the exact sentence
        // times out identically whether the refusal was silent or merely
        // reworded, and those are different bugs.
        await app.waitForCondition<boolean>(`${BULLETIN_TEXTS}.length > 0`, {
          timeoutMs: 10000,
        });
        const texts = await app.evalJS<string[]>(BULLETIN_TEXTS);
        note(`at0435 bulletins after the refused press: ${JSON.stringify(texts)}`);
        expect(
          texts.some((t) => t.includes("Write a join message")),
          "the refusal names what is missing",
        ).toBe(true);
        expect(
          texts.some((t) => t.includes("Join not sent")),
          "the bulletin names the act that was refused",
        ).toBe(true);

        // The refusal is not a dismissal: the mode is still up, so the user is
        // one keystroke from the landing they asked for.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          ),
          "join mode survives a refused press",
        ).toBe(true);

        // A second press speaks again rather than going quiet on a repeat.
        //
        // The wait for the first bulletin to fade is the test, not a delay: a
        // gate refusal is a caution and cautions auto-dismiss, so by the time
        // someone presses again the previous sentence is gone and a surface
        // that compared wording — rather than the refusal's `seq` — would sit
        // silent on exactly the press where the user is asking louder. The
        // fade is observed rather than forced; removing the node by hand would
        // leave the bulletin channel believing it was still up.
        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.every(function(t){ return t.indexOf("Write a join message") === -1; })`,
          { timeoutMs: 30000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.some(function(t){ return t.indexOf("Write a join message") !== -1; })`,
          { timeoutMs: 10000 },
        );
        note("at0435 the second press spoke again after the first bulletin faded");

        // And the same refusal, reached by CLICKING the button rather than by
        // the submit chord — which is the half of this that was dead.
        //
        // Every press above rides `⌘Return`, and that path was never the
        // broken one: a keystroke reaches `performSubmit` no matter what the
        // button looks like. A CLICK does not. The land button was
        // HTML-disabled on the gate and `pointer-events: none` on an empty
        // message, so a mouse press on it landed on nothing at all — no act,
        // no sentence, no bulletin — which is exactly what a developer
        // reported after clicking it and watching the app do nothing. The
        // button now dims without going numb, so the click refuses out loud
        // like the keystroke does.
        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.every(function(t){ return t.indexOf("Write a join message") === -1; })`,
          { timeoutMs: 30000 },
        );
        await app.nativeClickAtElement(JOIN_BUTTON);
        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.some(function(t){ return t.indexOf("Write a join message") !== -1; })`,
          { timeoutMs: 10000 },
        );
        note("at0435 clicking the dimmed land button refused out loud");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

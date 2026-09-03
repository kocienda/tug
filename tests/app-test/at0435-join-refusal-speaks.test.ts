/**
 * at0435-join-refusal-speaks.test.ts — a refused land press says why, on
 * screen, in the real app ([L31]).
 *
 * The corpus had never pressed a land button. Nothing walked
 * submit → gate → refusal, which is precisely where the arc-join dead press
 * lived. The refusal was computed, discarded, and shown nowhere, so days
 * of investigation had nothing to read.
 *
 * What this drives is the mechanism, not a hypothesis about which condition
 * fires: an empty message over an otherwise landable arc is the cheapest
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
  bindArc,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  silenceJoinPrompt,
  type JoinScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000435";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-toolbar .tug-prompt-entry-route-group`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;

/** The checkout whose built binaries the fixture drives — never the project. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const FILE = "subject.txt";

/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";
const ARC = "at0435-work";
let fixtureDir = "";
let tugbankPath = "";
let arcId = "";

const row = (arc: string): string =>
  `${LANE} [data-slot="session-changes-arc-row"][data-arc="${arc}"]`;
const landing = (arc: string): string =>
  `${row(arc)} [data-slot="session-changes-arc-join"]`;
// Card-scoped, not row-scoped: the register that reports a join in progress is
// the composer's live-edge one, not a copy inside the lane row. One arc is
// bound here, so the card's register is this arc's.
const CANDIDATE = `${CARD} [data-slot="arc-join-register"][data-word="ready"]`;
const landsAs = (arc: string): string =>
  `${row(arc)} [data-slot="session-changes-arc-lands-as"]`;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // A repository of the fixture's own. The refusal under test is the *last* one
  // in the gate's order, so everything before it has to pass — which means
  // this arc gets resolved for real when join mode opens ([P03]). Aimed at
  // the developer's checkout that would be a reconcile of their own work,
  // run because somebody opened a composer.
  scratch = makeJoinScratchRepo({
    prefix: "at0435",
    arc: ARC,
    description: "at0435 fixture (a round to land)",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0435 the arc's file\n",
    base: "at0435 SENTINEL the base's own file\n",
    arcBody: "at0435 SENTINEL the arc rewrote it\n",
    cleanMerge: true,
    resolver: "#!/bin/sh\nexit 0\n",
  });
  arcId = scratch.arcId;

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The repository IS the teardown: branch, worktree, config, and arc all go
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

/** Click `target` until `expected` matches, re-aiming between attempts. */
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
        // The join face is what the pilot found, and the pilot works only a
        // arc somebody holds ([D147]) — a client-side `bind_arc_ok` writes
        // no ledger row for it to read. The prompt that follows a standing
        // candidate is answered in advance: this file is about the shade.
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        silenceJoinPrompt(projectDir(), ARC);

        await raiseShade(app);
        await app.dispatchControlAction("bind_arc_ok", {
          tug_session_id: SID,
          arc_id: arcId,
          arc_name: ARC,
        });
        // A landable arc publishes its OFFER — the `lands as` line — so that
        // is what says the fixture is ready. The report fold is NOT a
        // readiness signal and cannot be waited on here: a clean join has no
        // conflict, blocker, question or account to show, and the section
        // renders nothing it cannot say. Its silence is the clean case's own
        // shape, so it is asserted rather than waited for.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landsAs(ARC))}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(landing(ARC))}) === null`,
          ),
          "a clean arc shows no report — the fold speaks only with evidence",
        ).toBe(true);

        // `/commit` raised the shade in COMMIT mode, and one composer holds one
        // landing — so commit has to go before the join can have the document.
        // Escape is that exit, and it is the whole gesture: a bound arc with
        // work ready to join enters join mode BY ITSELF once the composer is
        // free. Nothing types `/arc-join`, which would only open by name a
        // mode the binding opens on its own.
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 60000 },
        );

        // Wait for the candidate before pressing. Entering join mode resolved
        // the arc ([P03]), and the CANDIDATE standing is that resolution
        // anchoring — a press before it measures the outcome refusal rather
        // than the empty-message one under test. The resolver's account is not
        // the signal: a clean join resolves nothing and files no account.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CANDIDATE)}) !== null`,
          { timeoutMs: 180000 },
        );

        // The editor opens empty: a fixture arc has no maintained join draft,
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

/**
 * at0753-join-hand-door-press-stays-closed.test.ts — a room opened by hand
 * while the reveal was holding stays closed after its Join press, until the
 * join's receipt lands.
 *
 * ## What this gates
 *
 * at0496's variant, for the shape at0496 cannot reach. at0496 opens the room
 * with `/arc-join` on an open card, where the passive reveal may well have
 * fired first and spent the offer — so a press there is a press on a room whose
 * work is already remembered as shown. The field report was the other case:
 * the room opened by a **hand door while the reveal's gate was holding**, so
 * nothing remembered the offer as shown, and the Join press — which exits the
 * mode and hides the shade — left every other gate input clear in the very next
 * commit. The passive reveal re-entered join mode there, raised the shade back
 * over the join the user had just pressed, and the progress row sat behind it
 * until the join finished and took the shade down by itself.
 *
 * So this file holds the reveal with the fold (the gate's `folded` input), lets
 * the offer stand behind it, opens the room by the Changes toggle (the door
 * ⌃⌘C and the Session menu post), and presses Join. Two holds keep the room
 * shut now, and either alone would: the entry into join mode spends the offer
 * whichever door made it, and a landing in flight holds the reveal until the
 * join settles.
 *
 * ## Why these assertions
 *
 * The room is watched by a sampler installed in the card's page before the
 * press, not by a wait: a wait for "the sheet is gone" passes on the first
 * frame it is gone and says nothing about it coming back, which is exactly
 * the defect. Every sample between the shade first leaving the DOM and the
 * join's receipt row landing must find the sheet absent, and once the
 * progress row is first in view it must stay in view until the receipt.
 * "Gone" is the sheet absent from the DOM, because `TugSheet` unmounts on
 * hide; "in view" is geometric, against the transcript scroller's rect.
 *
 * The fixture is at0496's — a scratch repository with one landable arc and
 * a no-op resolver — so the join settles at git speed.
 *
 * @covers tugdeck/src/lib/join-offer-reveal.ts
 * @covers tugdeck/src/components/tugways/cards/staged-landing.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
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
  type JoinScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** Minted per run, for the reason at0496 gives: no stale row may answer for it. */
const SID = randomUUID();
const PANE_ID = "p1";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-route-group`;
/** The standing-offer dot rides this attribute ([L06]). */
const OFFER_DOT = `${ROUTE_GROUP}[data-join-offer]`;
const TRANSCRIPT = `${CARD} .session-view-pane[data-view="transcript"] [data-slot="tug-list-view"]`;
const PROGRESS_ROW = `${CARD} [data-slot="session-landing-progress-row"]`;
/** The settled join's boundary row — the receipt this file waits for. */
const JOIN_RECEIPT = `${CARD} [data-boundary="join"]`;
const CANDIDATE = `${CARD} [data-slot="arc-join-register"][data-word="ready"]`;

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const ARC = "at0753-work";
const FILE = "subject.txt";

let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";
let fixtureDir = "";
let tugbankPath = "";
let arcId = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeJoinScratchRepo({
    prefix: "at0753",
    arc: ARC,
    description: "at0753 fixture (a round to land)",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0753 the arc's file\n",
    base: "at0753 SENTINEL the base's own file\n",
    arcBody: "at0753 SENTINEL the arc rewrote it\n",
    cleanMerge: true,
    resolver: "#!/bin/sh\nexit 0\n",
  });
  arcId = scratch.arcId;
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
  rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Flip the fold through the one command every fold door reaches. */
async function toggleFolded(app: App, want: boolean): Promise<void> {
  await app.evalJS<null>(`(window.__tug.dispatchControlAction("toggle-card-fold"), null)`);
  await app.waitForCondition<boolean>(
    `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).folded === ${want}`,
    { timeoutMs: 8000 },
  );
  await app.body("A").waitForCondition<boolean>(
    `(function () {
       var card = document.querySelector(${JSON.stringify(CARD)} + " .session-card");
       if (card === null) return false;
       return card.getAttribute("data-fold") === ${want ? '"settled"' : "null"};
     })()`,
    { timeoutMs: 8000 },
  );
}

/**
 * The sampler: every 16 ms, from install until stopped, it reads whether the
 * sheet is in the DOM, whether the progress row is inside the transcript
 * scroller's rect, and whether the join's receipt row has landed. It keeps
 * only the verdict-shaped facts, so the reading is one object at the end.
 */
const SAMPLER_INSTALL = `(function () {
  var SHEET = ${JSON.stringify(SHEET)};
  var ROW = ${JSON.stringify(PROGRESS_ROW)};
  var SCROLLER = ${JSON.stringify(TRANSCRIPT)};
  var RECEIPT = ${JSON.stringify(JOIN_RECEIPT)};
  var r = {
    samples: 0,
    closedAt: -1,
    reopenedSamples: 0,
    rowFirstInViewAt: -1,
    rowOutOfViewSamples: 0,
    receiptAt: -1,
  };
  var t0 = performance.now();
  function inView() {
    var el = document.querySelector(ROW);
    var s = document.querySelector(SCROLLER);
    if (el === null || s === null) return false;
    var a = el.getBoundingClientRect();
    var b = s.getBoundingClientRect();
    return a.height > 0 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  }
  function tick() {
    var now = Math.round(performance.now() - t0);
    r.samples += 1;
    if (r.receiptAt >= 0) return;
    if (document.querySelector(RECEIPT) !== null) { r.receiptAt = now; return; }
    var sheet = document.querySelector(SHEET) !== null;
    if (r.closedAt < 0) { if (!sheet) r.closedAt = now; }
    else if (sheet) r.reopenedSamples += 1;
    var seen = inView();
    if (r.rowFirstInViewAt < 0) { if (seen) r.rowFirstInViewAt = now; }
    else if (!seen) r.rowOutOfViewSamples += 1;
  }
  window.__at0753 = { r: r, id: setInterval(tick, 16) };
  return null;
})()`;

const SAMPLER_READ = `(function () {
  var w = window.__at0753;
  if (w === undefined) return JSON.stringify({ installed: false });
  clearInterval(w.id);
  return JSON.stringify(Object.assign({ installed: true }, w.r));
})()`;

describe.skipIf(!SHOULD_RUN)("AT0753: a hand-opened room stays closed after its Join press", () => {
  test(
    "the reveal held by the fold, the room opened by the toggle, and after the press the sheet stays gone until the receipt with the register in view",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0753-join-hand-door-press-stays-closed",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // Folded first: the offer this card meets is held by the fold, so the
        // passive reveal never fires and nothing spends the offer before the
        // hand door does.
        await toggleFolded(app, true);
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        const bindOk = { tug_session_id: SID, arc_id: arcId, arc_name: ARC };
        await app.dispatchControlAction("bind_arc_ok", bindOk);
        await app.body("A").evalJS<null>(
          `(window.__tug.dispatchControlAction("bind_arc_ok", ${JSON.stringify(bindOk)}), null)`,
        );

        // The offer stands, on a closed room: the dot is up and no sheet is.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OFFER_DOT)}) !== null`,
          { timeoutMs: 15000 },
        );
        expect(
          await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(SHEET)}) !== null`),
          "precondition: the fold held the reveal, so the room is closed under a standing offer",
        ).toBe(false);

        // The hand door. `toggle-changes-view` is what ⌃⌘C and the Session
        // menu post; on a folded card it unfolds and enters join mode.
        await app.dispatchControlAction("toggle-changes-view");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null &&
           document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 15000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CANDIDATE)}) !== null`,
          { timeoutMs: 15000 },
        );

        await app.body("A").nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.nativeType("at0753: land this arc");
        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf("land this arc") !== -1`,
          { timeoutMs: 5000 },
        );

        await app.body("A").evalJS<null>(SAMPLER_INSTALL);
        await app.nativeKey("Return", ["cmd"]);

        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_RECEIPT)}) !== null`,
          { timeoutMs: 15000 },
        );
        // One more sampling beat, so the receipt's own sample is taken.
        await settle(100);
        const reading = JSON.parse(await app.body("A").evalJS<string>(SAMPLER_READ)) as {
          installed: boolean;
          samples: number;
          closedAt: number;
          reopenedSamples: number;
          rowFirstInViewAt: number;
          rowOutOfViewSamples: number;
          receiptAt: number;
        };
        note(`at0753 sampler: ${JSON.stringify(reading)}`);

        expect(reading.installed, "the sampler ran").toBe(true);
        expect(reading.closedAt, "the press closed the room").toBeGreaterThanOrEqual(0);
        expect(reading.receiptAt, "the sampler saw the join's receipt land").toBeGreaterThanOrEqual(0);
        expect(
          reading.reopenedSamples,
          "the room did not come back between the press and the receipt",
        ).toBe(0);
        expect(
          reading.rowFirstInViewAt,
          "the join's progress row was in view before the receipt",
        ).toBeGreaterThanOrEqual(0);
        expect(
          reading.rowOutOfViewSamples,
          "and it stayed in view until the receipt landed",
        ).toBe(0);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0753] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

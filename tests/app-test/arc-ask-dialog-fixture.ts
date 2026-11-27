/**
 * arc-ask-dialog-fixture.ts — one arc stopped on its question, on a real
 * card, and the reads every `at0910` file makes of it.
 *
 * Each file is one gesture against the ask receipt's question dialog: a
 * choice answers and resumes, a typed reply answers and resumes, Keep
 * Stopped leaves the arc stopped, and the card's composer answers while the
 * question is up. They share the setup and the reads, so the four claims are
 * made of one ask, the same way.
 *
 * The ask is a real `tugtool arc ask`, typed through the card's own `$` shell
 * route — the route that stamps `TUG_SESSION_ID`, so the server resolves the
 * card that asked — chained after the `arc run` that opens the arc, so the
 * question lands before the runner's first tick seats a stage.
 */

import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { App } from "./_harness";
import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  arcBriefPath,
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";
import { CARD, openCard, shellUntil } from "./arc-stop-resume-fixture";

/** This checkout — the build under test, and never the tree an arc is cut in. */
export const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

export const QUESTION = "Which cover hides the band?";
export const NEIGHBOUR = "the neighbour";
export const NEW_ONE = "a new one";

/** The receipt's ask, and the question dialog it hosts. */
export const ASK = `${CARD} [data-slot="arc-receipt-ask"]`;
export const DIALOG = `${ASK} [data-slot="session-question-dialog"]`;
/** The card's own composer, never the dialog's free-text field. */
export const COMPOSER = `${CARD} [data-slot="tug-prompt-entry"] .cm-content`;
/** The dialog's free-text field. */
export const FREE_TEXT = `${DIALOG} [data-slot="session-question-dialog-freetext"] .cm-content`;
/** The line toward the join the asking card shows while the question is up. */
export const ROUTE = `${ASK} [data-slot="arc-receipt-ask-route"]`;
/** The card's Z2 ARC cell reading. */
export const ARC_CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="arc"] [data-slot="session-telemetry-arc-value"]`;

/** Wait until `selector`'s text holds `needle`, and return the text. */
export async function textOnceItHolds(app: App, selector: string, needle: string): Promise<string> {
  await app.body("A").waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "").indexOf(${JSON.stringify(
      needle,
    )}) !== -1`,
    { timeoutMs: 10_000 },
  );
  return app.body("A").evalJS<string>(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`,
  );
}

/** One arc in its own scratch repo, opened on its own brief. */
export interface AskScene {
  scratch: ArcScratchRepo;
  fixtureDir: string;
  arc: string;
  sid: string;
}

export function makeAskScene(prefix: string, sid: string): AskScene {
  const scratch = makeArcScratchRepo({ prefix, checkout: CHECKOUT });
  const arc = `${prefix}-ask`;
  createArc(scratch.repo, arc, `${prefix} ask fixture`, scratch.cli);
  writeFileSync(arcBriefPath(scratch.repo, arc), "# A brief\n\nSome prose the arc opens on.\n");
  return { scratch, fixtureDir: seedScratchSession(scratch.repo, sid), arc, sid };
}

export function dropAskScene(scene: AskScene | null): void {
  if (scene === null) return;
  rmArcScratchRepo(scene.scratch);
  rmScratchSession(scene.fixtureDir);
}

/** Launch the app on the scene's card, run `body`, and always close. */
export async function withAskCard(
  scene: AskScene,
  testName: string,
  body: (app: App) => Promise<void>,
): Promise<void> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
  const app = await launchTugApp({
    testName,
    env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scene.scratch.dataRoot },
  });
  try {
    await openCard(app, scene.sid, scene.scratch.repo);
    await body(app);
  } finally {
    await app.close();
    rmTempTugbank(tugbankPath);
  }
}

/**
 * Open the arc and stop it on its question, with the whole decision: a
 * described choice, a recommended one, and a verified fact apart from a guess.
 * Waits until the receipt's question dialog is up.
 */
export async function askOnTheCard(app: App, scene: AskScene): Promise<void> {
  const cli = tugtoolPath(CHECKOUT);
  await shellUntil(
    app,
    `${cli} arc run ${scene.arc} && ${cli} arc ask ${scene.arc} "${QUESTION}"` +
      ` --choice "${NEIGHBOUR}" --choice "${NEW_ONE}"` +
      ` --does "widens the neighbour over the band" --does "adds a cover of its own"` +
      ` --recommend "${NEW_ONE}"` +
      ` --found "the neighbour reaches the band" --guess "the flash is the band"`,
    // The evidence lead only the receipt paints; the typed line carries the
    // question itself, so the question is no marker.
    "Verified",
  );
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
    { timeoutMs: 30_000 },
  );
}

/** What the arc's record says about its question and its stop. */
export interface AskRecord {
  stopped: [string, string] | null;
  answer: string | null;
  lastNote: string | null;
}

export function askRecord(scene: AskScene): AskRecord {
  const out = JSON.parse(
    tugtool(["arc", "record", scene.arc, "--json"], {
      cwd: scene.scratch.repo,
      binaryRoot: CHECKOUT,
      env: scene.scratch.cli.env,
    }),
  ) as {
    data: {
      arc: {
        stopped: [string, string] | null;
        answer: string | null;
        notes: string[];
      } | null;
    };
  };
  const arc = out.data.arc;
  return {
    stopped: arc?.stopped ?? null,
    answer: arc?.answer ?? null,
    lastNote: arc?.notes[arc.notes.length - 1] ?? null,
  };
}

/** Read `probe` until `settled` accepts it, or give up and return the last read. */
export async function pollRecord(
  scene: AskScene,
  settled: (record: AskRecord) => boolean,
  timeoutMs = 6_000,
): Promise<AskRecord> {
  const deadline = Date.now() + timeoutMs;
  let last = askRecord(scene);
  while (!settled(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    last = askRecord(scene);
  }
  return last;
}

/**
 * Click the dialog's button that reads `label`. The wizard's buttons carry no
 * slot of their own, so the one wanted is tagged by its text and clicked by
 * the tag — a real click on the element the user sees.
 */
export async function clickDialogButton(app: App, label: string, scope = DIALOG): Promise<void> {
  const tag = `at-ask-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  await app.body("A").waitForCondition<boolean>(
    `(function(){
       var root = document.querySelector(${JSON.stringify(scope)}) ?? document;
       var hit = Array.from(root.querySelectorAll('button')).find(function(b){
         return (b.textContent ?? "").trim() === ${JSON.stringify(label)} && !b.disabled;
       });
       if (hit === undefined) return false;
       hit.setAttribute("data-at-target", ${JSON.stringify(tag)});
       // The transcript follows its bottom, so a tall receipt's dialog sits
       // with its action bar under the entry's sticky header, and a field that
       // grows as it is typed into pulls it back there. Scroll it to the
       // middle, as a reader would, and only report ready once the button is
       // what a click at its centre would hit.
       var r = hit.getBoundingClientRect();
       var under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
       if (under !== null && (under === hit || hit.contains(under))) return true;
       hit.scrollIntoView({ block: "center" });
       return false;
     })()`,
    { timeoutMs: 10_000 },
  );
  await app.body("A").nativeClickAtElement(`[data-at-target="${tag}"]`);
}

/** Click into `field`, wait for its focus to settle, and type `text`. */
export async function typeInto(app: App, field: string, text: string): Promise<void> {
  await app.body("A").evalJS<boolean>(
    `(function(){ var el = document.querySelector(${JSON.stringify(field)}); if (el === null) return false; el.scrollIntoView({ block: "center" }); return true; })()`,
  );
  await app.body("A").nativeClickAtElement(field);
  await app.body("A").waitForCondition<boolean>(
    `document.hasFocus() && document.activeElement === document.querySelector(${JSON.stringify(field)})`,
    { timeoutMs: 5_000 },
  );
  await new Promise((r) => setTimeout(r, 300));
  await app.nativeType(text);
  await app.body("A").waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(field)})?.textContent ?? "").indexOf(${JSON.stringify(
      text,
    )}) !== -1`,
    { timeoutMs: 5_000 },
  );
}

/** Whether the dialog is gone from the receipt. */
export async function dialogGone(app: App): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DIALOG)}) === null`,
    { timeoutMs: 20_000 },
  );
}

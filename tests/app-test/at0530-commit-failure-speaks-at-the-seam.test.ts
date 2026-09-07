/**
 * at0530-commit-failure-speaks-at-the-seam.test.ts — **a commit git actually
 * refuses, reported where the commit happened.**
 *
 * ## What this is
 *
 * The incident this file pins is a real one from 2026-09-05: a `/commit` on a
 * repository whose `index.lock` another git process was holding. Git said
 * "fatal: Unable to create '…/.git/index.lock': File exists."; the app said
 * "Commit failed", verbatim stderr as the body, in the top-right bulletin lane
 * — as far from the pressed button as the card allows, and *dimmed*, because
 * the Changes shade raises a pane scrim over the transcript region the lane
 * lives in. The refusal was legible only to somebody who already knew where to
 * look for it.
 *
 * So this file holds a real lock over a real press. Nothing is published, no
 * frame is faked, and the error it asserts on is git's own: the lock file goes
 * down between the message being typed and Z5 being clicked, `git add --`
 * inside `stage_and_commit` fails on it, and tugcast relays the stderr as
 * `changeset_commit_err`.
 *
 * ## The four things it proves
 *
 *   1. **The failure is named, not quoted.** The notice's title is the cause in
 *      the user's frame — "Another git process is holding the repository lock"
 *      — and git's own words are kept, one disclosure away, inside the fold.
 *   2. **It is at the seam.** The strip's box sits below the shade's and above
 *      the editor's, which is what "inside the gesture" means geometrically.
 *      Nothing landing-shaped reaches the corner lane.
 *   3. **Z5 wears the word.** While the refusal stands, the land button reads
 *      "Retry commit" — the strip's Retry and the button are one act.
 *   4. **Retry lands.** With the lock gone, the strip's Retry button produces
 *      the commit the first press asked for, and the notice goes with it.
 *
 * ## Why the lock is held for as short a window as possible
 *
 * `performCommit` re-checks the land gate a beat after the press, and that gate
 * reads the changeset off a feed git itself drives. A lock held across the
 * whole fixture could empty the changeset and turn the press into a *gate*
 * refusal — still red, but for a reason no failure message here would name. So
 * the lock goes down after the file row is on screen and the message is typed,
 * and comes up the moment the notice is asserted. The tell that it reached the
 * feed anyway would be a strip with `data-channel="refusal"`; the assertions
 * below are written on `data-channel="error"` so that case cannot pass quietly.
 *
 * ## What this file deliberately does not declare
 *
 * `tug-prompt-entry.tsx` and `session-card.tsx` are both at the selection
 * budget's ceiling, and naming them here would push each past it — a one-line
 * edit to either would then turn `app-test-changed` into a sweep. The Z5
 * relabel and the strip's mount site are corroborating details of a file whose
 * subject is the strip; at0435 already declares the prompt entry and at0436
 * declares the card, and both now declare the strip, so an edit to either hub
 * still selects a test that drives this surface.
 *
 * @covers tugdeck/src/components/tugways/cards/session-landing-notice-strip.tsx
 * @covers tugdeck/src/lib/landing-notice.ts
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 * @covers tugrust/crates/tugchanges-core/src/commit.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000530";
const DIRTY_FILE = "at0530-work.txt";
const SUBJECT = "at0530 land this after the lock is gone";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
const COMMIT_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const FILE_ROW = `${CARD} [data-slot="tug-changes-list-file-ref"]`;
const STRIP = `${CARD} [data-slot="session-landing-notice-strip"]`;
const ERROR_STRIP = `${STRIP}[data-channel="error"]`;
const RETRY = `${CARD} [data-testid="session-landing-notice-retry"]`;
const CLAIM_ALL = `${CARD} [data-testid="tug-changes-list-claim-all-unattributed"]`;
const BULLETIN_TEXTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map(function(e){ return e.textContent || ""; })`;

/** This checkout — the build under test, never the tree the fixture dirties. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir: string | null = null;
const projectDir = (): string => scratch?.repo ?? "";
const lockPath = (): string => join(projectDir(), ".git", "index.lock");

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0530", checkout: CHECKOUT });
  // A **tracked** file for the card to dirty. An untracked one lands in the
  // unattributed bucket, which has no session entry behind it — and the entry
  // is what Z5's gate counts files from.
  writeFileSync(join(projectDir(), DIRTY_FILE), "at0530 baseline\n");
  execFileSync("git", ["add", DIRTY_FILE], { cwd: projectDir() });
  execFileSync("git", ["commit", "-m", "at0530: seed the file the card will dirty"], {
    cwd: projectDir(),
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  if (fixtureDir !== null) rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 980, height: 720 },
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

const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(`/shell ${command}`);
  await settle(150);
  await app.nativeKey("Enter", ["cmd"]);
}

/** Raise the Changes shade in commit mode: type, dismiss the popup, ⌘⏎. */
async function openCommitShade(app: App): Promise<void> {
  await app.nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType("/commit");
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(COMMIT_SHEET)}) !== null &&
     document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`,
    { timeoutMs: 20_000 },
  );
}

/** `git log -1 --format=%s` on the scratch repo. */
function gitSubject(repo: string): string {
  return execFileSync("git", ["log", "-1", "--format=%s"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

describe.skipIf(!SHOULD_RUN)("AT0530: a commit failure speaks at the seam", () => {
  test(
    "a held index.lock refuses the commit in the seam, and Retry lands it",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0530-commit-failure-speaks-at-the-seam",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        // ── Work on the card's line, so the shade has a changeset ────────
        //
        // Through `file run`, which fingerprints the tree before and after and
        // receipts what moved — a bare `sh -c 'echo >> f'` names no path
        // anything can read. The receipt is not attribution, though: the change
        // arrives in the shade's **unattributed** bucket ("no session claims
        // these"), and Z5's gate counts only what this card's entry carries. So
        // the shade's own Claim all is the gesture that puts it there, which is
        // also the gesture a user makes for exactly this reason.
        await shell(app, `${cli} file run -- sh -c 'echo at0530 >> ${DIRTY_FILE}'`);
        await settle(4_000);
        note(
          `at0530 the scratch repo's dirt: ${JSON.stringify(
            execFileSync("git", ["status", "--porcelain"], {
              cwd: projectDir(),
              encoding: "utf8",
            }).trim(),
          )}`,
        );

        await openCommitShade(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CLAIM_ALL)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.nativeClickAtElement(CLAIM_ALL);

        // The gate, not a row count, is the readiness signal: `data-land-blocked`
        // is absent exactly when `canLandIgnoringMessage` holds, which is where
        // the attributed file count is read. Waiting on it means a press below
        // can only be refused by git, never by the gate.
        await app.waitForCondition<boolean>(
          `(function(){
             const b = document.querySelector(${JSON.stringify(COMMIT_BUTTON)});
             return b !== null && !b.hasAttribute("data-land-blocked");
           })()`,
          { timeoutMs: 30_000 },
        );
        note(
          `at0530 the shade's file rows: ${await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(FILE_ROW)}).length`,
          )}`,
        );

        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType(SUBJECT);
        await settle(1_500);

        // ── The lock, and the press ──────────────────────────────────────
        //
        // Held for exactly this window. `git status` takes `index.lock` only to
        // write a refreshed index and skips that write silently when it cannot,
        // so the feed survives; the first step that actually fails is
        // `git add --` inside `stage_and_commit`, whose stderr is the string
        // the cause table matches on.
        writeFileSync(lockPath(), "");
        await app.nativeClickAtElement(COMMIT_BUTTON);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ERROR_STRIP)}) !== null`,
          { timeoutMs: 30_000 },
        );
        rmSync(lockPath(), { force: true });

        const notice = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(ERROR_STRIP)})?.textContent ?? "")`,
        );
        note(`at0530 the notice at the seam: ${JSON.stringify(notice)}`);
        note("at0530 the refusal is at the seam", (await app.screenshot()).path);

        // 1. The failure is named, not quoted.
        expect(notice, "the title names the cause in the user's frame").toContain(
          "Another git process is holding the repository lock",
        );
        // And git's own words are kept — inside the fold, which is closed until
        // somebody asks. Opening it is what proves the evidence is really there
        // rather than paraphrased away.
        const evidence = await app.evalJS<string>(
          `(function(){
             const d = document.querySelector(${JSON.stringify(ERROR_STRIP)} + ' details');
             if (d === null) return "(no fold)";
             d.open = true;
             return d.textContent || "";
           })()`,
        );
        note(`at0530 the evidence behind the fold: ${JSON.stringify(evidence)}`);
        expect(evidence, "git's own words are kept, one disclosure away").toContain(
          "index.lock",
        );

        // 2. It is at the seam — below the shade, above the editor — and the
        //    corner lane carries nothing landing-shaped.
        //
        // Measured at rest. The failure re-enters the mode, so the shade slides
        // back in under the notice; a rect read on the way there is the
        // animation's, not the layout's.
        await settle(1_500);
        const boxes = await app.evalJS<{
          shadeBottom: number;
          stripTop: number;
          stripBottom: number;
          editorTop: number;
        }>(
          `(function(){
             const r = function(sel){ const e = document.querySelector(sel); return e === null ? null : e.getBoundingClientRect(); };
             const shade = r(${JSON.stringify(COMMIT_SHEET)});
             const strip = r(${JSON.stringify(ERROR_STRIP)});
             const editor = r(${JSON.stringify(PROMPT_INPUT)});
             return {
               shadeBottom: shade === null ? -1 : shade.bottom,
               stripTop: strip === null ? -1 : strip.top,
               stripBottom: strip === null ? -1 : strip.bottom,
               editorTop: editor === null ? -1 : editor.top,
             };
           })()`,
        );
        note(`at0530 the seam's geometry: ${JSON.stringify(boxes)}`);
        expect(
          boxes.stripTop >= boxes.shadeBottom,
          "the notice sits below the shade's bottom edge",
        ).toBe(true);
        expect(
          boxes.stripBottom <= boxes.editorTop,
          "the notice sits above the composer's editor",
        ).toBe(true);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(COMMIT_SHEET)}) !== null`,
          ),
          "the mode re-entered — the shade is back with the failure",
        ).toBe(true);
        const corner = await app.evalJS<string[]>(BULLETIN_TEXTS);
        note(`at0530 corner bulletins after the failure: ${JSON.stringify(corner)}`);
        expect(
          corner.every((t) => !t.includes("Commit failed") && !t.includes("index.lock")),
          "the corner lane carries nothing landing-shaped",
        ).toBe(true);

        // 3. Z5 wears the word while the refusal stands.
        const label = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(COMMIT_BUTTON)})?.getAttribute("aria-label") ?? "(no button)"`,
        );
        note(`at0530 the land button's label with a failure standing: ${JSON.stringify(label)}`);
        expect(label, "the land button and the strip's Retry are one act").toBe(
          "Retry commit",
        );

        // 4. Retry lands. The lock is already gone, and the message survived
        //    the failure in the draft store, so this is the same press again.
        expect(
          gitSubject(projectDir()),
          "nothing was committed while the lock was held",
        ).not.toBe(SUBJECT);
        await app.nativeClickAtElement(RETRY);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(STRIP)}) === null`,
          { timeoutMs: 30_000 },
        );
        await settle(4_000);
        const head = gitSubject(projectDir());
        note(`at0530 HEAD after Retry: ${JSON.stringify(head)}`);
        expect(head, "Retry landed the commit the first press asked for").toBe(SUBJECT);
      } finally {
        if (existsSync(lockPath())) rmSync(lockPath(), { force: true });
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

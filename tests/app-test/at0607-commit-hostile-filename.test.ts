/**
 * at0607-commit-hostile-filename.test.ts — **a file whose name git would quote,
 * committed through the real commit sheet.**
 *
 * ## The incident
 *
 * A 60-file commit of scanned Polish records could not be made. Every path Tug
 * held had come back from a line-oriented `git status`, where git prints a
 * non-ASCII byte as an octal escape — `01_Stanisław_…jpg` arrives as
 * `"01_Stanis\305\202aw_…jpg"` — and handing that string back to git earns
 * `pathspec … did not match any file(s) known to git`, beside a Retry button
 * that could never do anything but fail again. Every listing now goes through
 * one `-z` door, and this is the end-to-end proof: the failure was only ever
 * visible at the seam between the listing and the commit, so that seam is what
 * gets driven.
 *
 * ## What it drives
 *
 * A scratch repository, a file written into it under a name holding `ł`, and
 * then the gestures a person makes: `/commit`, Claim all, a message, Z5. The
 * name is written by the test process rather than typed into the card, because
 * what is under test is the path's round trip through git and not the keyboard.
 *
 * ## What it asserts
 *
 *   1. **The shade names it.** The changes row's `data-path` is the file's real
 *      name — not the octal spelling, which is what a line-oriented listing
 *      would have put there.
 *   2. **The commit lands.** `git log` names the subject and `git show` names
 *      the file, so the pathspec git was handed was a path git knew.
 *   3. **The receipt names it.** The `/commit` row's frozen file list carries
 *      the same real name, which is the S02 summary's typed `files:` line
 *      making it all the way to the deck.
 *
 * A green run on today's build and a red one on the build before it differ at
 * (2): the press would have been refused with git's pathspec error.
 *
 * @covers tugrust/crates/tugchanges-core/src/git.rs
 * @covers tugrust/crates/tugcore/src/git_cmd.rs
 * @covers tugrust/crates/tugcore/src/hostile_repo.rs
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
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
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000607";

/** The eucit name, shortened. `ł` is U+0142 — C5 82, which git writes as
 *  `\305\202` in every listing that is not `-z`. */
const HOSTILE = "01_Stanisław_Kocienda_Form_B.jpg";
const SUBJECT = "at0607 commit the file git would have quoted";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
const COMMIT_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const CLAIM_ALL = `${CARD} [data-testid="tug-changes-list-claim-all-unattributed"]`;
const SHADE_ROW =
  `${COMMIT_SHEET} [data-testid="tug-changes-list-file-block"]` +
  `[data-path="${HOSTILE}"]`;
const RECEIPT_ROW =
  `${CARD} [data-slot="tug-commit-changes-list"] ` +
  `[data-testid="tug-changes-list-file-block"][data-path="${HOSTILE}"]`;

/** This checkout — the build under test, never the tree the fixture dirties. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir: string | null = null;
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0607", checkout: CHECKOUT });
  // Written by the test process, so the bytes on disk are exactly the bytes
  // this file spells. An untracked file lands in the shade's unattributed
  // bucket, which is what Claim all is for.
  writeFileSync(join(projectDir(), HOSTILE), "a scan of a record\n");
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

/** `git` on the scratch repo, stdout trimmed. */
function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectDir(),
    encoding: "utf8",
  }).trim();
}

describe.skipIf(!SHOULD_RUN)("AT0607: a hostile filename commits", () => {
  test(
    "a file named with ł lists, commits, and is named back by its real bytes",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0607-commit-hostile-filename",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        note(
          `at0607 the scratch repo's dirt, as git prints it line-oriented: ${JSON.stringify(
            git("status", "--porcelain"),
          )}`,
        );

        // ── 1. The shade names the file by its real bytes ─────────────────
        await openCommitShade(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHADE_ROW)}) !== null`,
          { timeoutMs: 30_000 },
        );
        const shadePaths = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(
            `${COMMIT_SHEET} [data-testid="tug-changes-list-file-block"]`,
          )})).map(function (e) { return e.getAttribute("data-path") || ""; })`,
        );
        note(`at0607 the shade's rows: ${JSON.stringify(shadePaths)}`);
        expect(shadePaths, "the shade lists the file under its real name").toContain(
          HOSTILE,
        );
        expect(
          shadePaths.some((p) => p.includes("\\305")),
          "no row carries git's octal display form",
        ).toBe(false);

        // ── 2. The commit lands ───────────────────────────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CLAIM_ALL)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.nativeClickAtElement(CLAIM_ALL);
        await app.waitForCondition<boolean>(
          `(function(){
             const b = document.querySelector(${JSON.stringify(COMMIT_BUTTON)});
             return b !== null && !b.hasAttribute("data-land-blocked");
           })()`,
          { timeoutMs: 30_000 },
        );

        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType(SUBJECT);
        await settle(1_500);
        await app.nativeClickAtElement(COMMIT_BUTTON);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RECEIPT_ROW)}) !== null`,
          { timeoutMs: 60_000 },
        );

        const subject = git("log", "-1", "--format=%s");
        note(`at0607 HEAD's subject: ${JSON.stringify(subject)}`);
        expect(subject, "the press produced the commit it asked for").toBe(SUBJECT);

        // `-z` here too, so the assertion reads the name rather than the
        // spelling — a line-oriented read would quote it back at this test.
        const committed = git("show", "--name-only", "--format=", "-z", "HEAD")
          .split("\0")
          .filter((p) => p !== "");
        note(`at0607 the commit's files: ${JSON.stringify(committed)}`);
        expect(committed, "the file git was handed was a path git knew").toEqual([
          HOSTILE,
        ]);
        expect(
          git("status", "--porcelain"),
          "nothing of the file is left behind",
        ).toBe("");

        // ── 3. The receipt names it ───────────────────────────────────────
        const receiptPaths = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(
            `${CARD} [data-slot="tug-commit-changes-list"] [data-testid="tug-changes-list-file-block"]`,
          )})).map(function (e) { return e.getAttribute("data-path") || ""; })`,
        );
        note(`at0607 the receipt's file rows: ${JSON.stringify(receiptPaths)}`);
        expect(
          receiptPaths,
          "the receipt's frozen file list carries the real name",
        ).toEqual([HOSTILE]);
        note("at0607 the receipt naming the file", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0360-project-diff-card.test.ts — `/diff` opens the Project Diff card:
 * the repo-wide `git diff HEAD` in its own descriptor-keyed card.
 *
 * `/diff` no longer opens a card-scoped sheet; it dispatches `OPEN_DIFF` with
 * an unscoped head descriptor for the card's bound project, which lands in
 * the standalone Diff card ([P20]). In that repo-wide guise the card
 * publishes "Project Diff" as its pane title via `cardTitleStore`, and the
 * body is the shared `TugDiffDocument` over a REAL tugcast git round-trip —
 * this checkout, really dirtied with a scratch file.
 *
 * What one launch drives:
 *
 * - `/diff` from the composer opens a Diff card whose pane title reads
 *   "Project Diff";
 * - the document renders the real working-tree diff, scratch file included,
 *   under the "Uncommitted changes (git diff HEAD)" label;
 * - a second `/diff` reuses the already-open card (descriptor-keyed reuse)
 *   rather than stacking a duplicate.
 *
 * Has teeth: before the repoint, `/diff` opened a sheet and no diff card
 * would ever appear; without the `cardTitleStore` publish the pane title
 * stays the registry's "Diff"; without descriptor-keyed reuse the second run
 * yields two cards.
 *
 * @covers tugdeck/src/components/tugways/cards/diff-card.tsx
 * @covers tugdeck/src/lib/open-diff-in-card.ts
 * @covers tugdeck/src/lib/diff-card-open-registry.ts
 * @covers tugdeck/src/lib/git-diff-store.ts
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/components/tugways/tug-diff-document.tsx
 * @covers tugdeck/src/components/tugways/tug-diff-document.css
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0360-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SUBMIT_BTN = `${CARD} .tug-prompt-entry-submit-button`;
const DIFF_CARD = '[data-slot="diff-card"]';
const DIFF_FILE = `${DIFF_CARD} [data-testid="diff-file"]`;

// The diff must be real, so the project is this checkout — the workspace
// tugcast registers at boot (its bootstrap `--source-tree`) — dirtied with a
// scratch file that is removed afterwards.
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const DIRTY_FILE = "at0360-scratch.txt";
const scratchPath = join(PROJECT_DIR, DIRTY_FILE);

beforeAll(() => {
  if (!SHOULD_RUN) return;
  writeFileSync(scratchPath, "at0360 scratch\n");
});

afterAll(() => {
  if (existsSync(scratchPath)) rmSync(scratchPath, { force: true });
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function runDiff(app: Awaited<ReturnType<typeof launchTugApp>>): Promise<void> {
  await app.body("A").nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType("/diff");
  await settle();
  await app.body("A").nativeClickAtElement(SUBMIT_BTN);
}

describe.skipIf(!SHOULD_RUN)("AT0360: /diff opens the Project Diff card", () => {
  test(
    "the card opens titled Project Diff, renders the real repo diff, and a re-run reuses it",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0360-project-diff-card",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // ── /diff opens the Project Diff card ──────────────────────────────
        await runDiff(app);
        await kindBody(app, "diff").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIFF_CARD)}) !== null`,
          { timeoutMs: 10000 },
        );

        // Its pane's chrome reads the published name, not the registry's
        // "Diff". A document card wears a masthead, and the masthead REPLACES
        // the bar's icon-and-title pair — so the name is on the masthead's
        // lead line rather than in `tug-pane-title`, which no longer renders
        // on this pane at all.
        //
        // The pane and its masthead are the shell's; the card is its own page.
        // So the pane is found through the deck's record of which pane holds
        // the diff card, and the title is waited for: the shell's chrome
        // commits on its own clock, a beat after the body's document stands.
        // card-dom: shell
        const paneTitle = await app.waitForCondition<string>(
          `(() => {
             const s = window.tugdeck.diag.getDeckState();
             const diffCard = s.cards.find((c) => c.componentId === "diff");
             const diffPane = diffCard === undefined ? undefined : s.panes.find((p) => p.cardIds.includes(diffCard.id));
             const mastheadTitle = diffPane === undefined
               ? null
               : document.querySelector('.tug-pane[data-pane-id="' + diffPane.id + '"] [data-testid="card-masthead-title"]');
             return mastheadTitle === null || mastheadTitle.textContent === "" ? false : mastheadTitle.textContent;
           })()`,
          { timeoutMs: 10000 },
        );
        expect(paneTitle).toBe("Project Diff");

        // The document resolves the REAL git round-trip: the scratch file is
        // in the rendered file list under the repo-wide label.
        await kindBody(app, "diff").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(DIFF_FILE)}).length >= 1`,
          { timeoutMs: 15000 },
        );
        const doc = await kindBody(app, "diff").evalJS<{ label: string | null; hasScratch: boolean }>(
          `(() => {
             const card = document.querySelector(${JSON.stringify(DIFF_CARD)});
             const label = card.querySelector(".tug-diff-document-header-label");
             const paths = Array.from(
               card.querySelectorAll(".tug-diff-document-file-path"),
               (el) => el.textContent ?? "",
             );
             return {
               label: label === null ? null : label.textContent,
               hasScratch: paths.includes(${JSON.stringify(DIRTY_FILE)}),
             };
           })()`,
        );
        expect(doc.label).toBe("Uncommitted changes (git diff HEAD)");
        expect(doc.hasScratch).toBe(true);

        // ── A second /diff reuses the open card ([P20]) ────────────────────
        await runDiff(app);
        await settle(600);
        // One card, read off the deck: each card is its own page, so a page's
        // document can only ever hold one.
        const cardCount = await app.evalJS<number>(
          `window.tugdeck.diag.getDeckState().cards.filter((c) => c.componentId === "diff").length`,
        );
        expect(cardCount).toBe(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

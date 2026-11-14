/**
 * row-11-lifecycle-session.test.ts — no Session body outlives its card,
 * every body saves before a reload and a quit, and the saves are on disk.
 *
 * A piece of row 11's lifecycle ([B02] row 11; the row is `_row-11.ts`'s),
 * a test to a file so each launch fits its own budget: three Session cards
 * and a Text card, taken away by close, close all, reload and quit in turn.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @family row-11-lifecycle
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, composerText, focusBody, settleFor, spawnStub, waitForBody } from "./_bodies";
import { sessionUnderTest } from "./_kinds";
import {
  A,
  B,
  CARD_IDS,
  D,
  DRAFT_BEFORE_QUIT,
  DRAFT_BEFORE_RELOAD,
  READY_GEN,
  SETTLE_MS,
  SHOULD_RUN,
  T,
  TEST_NAME,
  TEST_TIMEOUT_MS,
  bagOnDisk,
  boundBodies,
  closeThrough,
  deck,
  expectBodiesMatchCards,
  typeDraft,
} from "./_row-11";

describe.skipIf(!SHOULD_RUN)("body-grounding row 11: close, close all, reload and quit", () => {
  test.skipIf(!sessionUnderTest(11))(
    "no body outlives its card, every body saves before a reload and a quit, and the saves are on disk",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: TEST_NAME,
        // Test mode holds every card-state write back and starts every
        // boot empty; the two hatches let the bodies' saves reach the run's
        // own tugbank file, which is the disk this row reads, and let the
        // reloaded shell restore its deck from it, which is the pass that
        // makes the bodies again.
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        for (const id of [A, B, D]) await spawnStub(app, id, stubDir, 2);
        for (const id of [A, B, D]) await waitForBody(app, id);
        await expectBodiesMatchCards(app, "at the start", [A, B, D, T]);

        // ---- Close: A holds a draft, so the shell asks; Close, and A goes with its body ----
        await typeDraft(app, A, "row11 draft in A");
        await focusBody(app, A, { composer: false });
        await closeThrough(app, A, "file.closeCard", 3, "close A", true);
        expect(await settleFor(() => bodyOf(app, A), (b) => b === null, SETTLE_MS), "the host holds no body for A after the close").toBeNull();
        await expectBodiesMatchCards(app, "after closing A", [B, D, T]);

        // ---- Close all: B holds a draft, so the shell asks; B's pane empties, the text card and the body card together ----
        await typeDraft(app, B, "row11 draft in B");
        await focusBody(app, B, { composer: false });
        await closeThrough(app, B, "file.closeAllCardTabs", 1, "close all in B's pane", true);
        expect(await settleFor(() => bodyOf(app, B), (b) => b === null, SETTLE_MS), "the host holds no body for B after close all").toBeNull();
        await expectBodiesMatchCards(app, "after close all", [D]);

        // ---- Reload: only the shell reloads; D's page stays, and its draft with it ----
        await typeDraft(app, D, DRAFT_BEFORE_RELOAD);
        await app.body(D).evalJS<boolean>(`(window.__row11Kept = true)`);
        const genBefore = await app.evalJS<number>(READY_GEN);
        await app.nativeKey("r", ["cmd", "shift"]);
        // Across the navigation: D's body is bound in every host sample.
        let goneSamples = 0;
        let samples = 0;
        const genAfter = await settleFor(
          async () => {
            samples += 1;
            if (!(await boundBodies(app)).includes(D)) goneSamples += 1;
            return app.evalJS<number>(READY_GEN).catch(() => genBefore);
          },
          (gen) => gen > genBefore,
          20_000,
        );
        note(`reload: ready generation ${genBefore} → ${genAfter}; ${samples} host samples across it, ${goneSamples} without D's body`);
        expect(genAfter, "the shell reloaded").toBeGreaterThan(genBefore);
        expect(goneSamples, "D's body stayed bound across the shell's reload").toBe(0);
        // Kept, and still saved: a reload leaves the card's bag on disk.
        const bagAfterReload = await settleFor(async () => bagOnDisk(tugbankPath, D), (bag) => bag?.includes(DRAFT_BEFORE_RELOAD) === true, SETTLE_MS);
        expect(bagAfterReload, "D's bag is on tugbank disk after the reload").not.toBeNull();
        expect(bagAfterReload, "and it carries the draft typed in the body before the reload").toContain(DRAFT_BEFORE_RELOAD);
        const cardsAfterReload = await settleFor(() => app.evalJS<string[]>(CARD_IDS), (ids) => ids.includes(D), SETTLE_MS);
        note(`after the reload the shell lists ${JSON.stringify(cardsAfterReload)}; bodies ${JSON.stringify((await app.bodies()).map((b) => [b.cardId, b.state, b.visible]))}`);
        expect(cardsAfterReload, "the reloaded shell restored D").toContain(D);
        await waitForBody(app, D);
        await expectBodiesMatchCards(app, "after the reload", [D]);
        expect(await app.body(D).evalJS<boolean>(`window.__row11Kept === true`), "D's body is the page it was before the reload").toBe(true);
        const restored = await settleFor(() => app.body(D).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT_BEFORE_RELOAD) === true, SETTLE_MS);
        expect(restored, "D's kept body still shows the draft").toContain(DRAFT_BEFORE_RELOAD);

        // ---- Quit: D saves under the termination pipeline ----
        await typeDraft(app, D, DRAFT_BEFORE_QUIT);
        await app.quitGracefully({ timeoutMs: 20_000 });
        const bagAfterQuit = bagOnDisk(tugbankPath, D);
        expect(bagAfterQuit, "D's bag is on tugbank disk after the quit").not.toBeNull();
        expect(bagAfterQuit, "and it carries the draft typed before the quit").toContain(DRAFT_BEFORE_QUIT);
        const log = app.tugappLog();
        const verdict = log.split("\n").filter((line) => line.includes("termination verdicts")).pop() ?? "";
        note(`quit: ${verdict.trim() || "no verdict line in the log"}`);
        expect(verdict, "the termination pipeline reported a verdict").not.toBe("");
        expect(verdict, "the verdict names D's body").toContain(`body:${D}:`);
        expect(verdict, "and D's body saved ok").toMatch(new RegExp(`body:${D}: ok=true`));
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

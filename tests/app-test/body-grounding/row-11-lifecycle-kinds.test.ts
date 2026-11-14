/**
 * row-11-lifecycle-kinds.test.ts — every other kind's body outlives no card,
 * is kept across a shell reload, and saves before a quit.
 *
 * A piece of row 11's lifecycle ([B02] row 11; the row is `_row-11.ts`'s),
 * a test to a file so each launch fits its own budget: a card of each other
 * kind beside a Session card, closed, made again, reloaded and quit.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @family row-11-lifecycle
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import { bodyOf, settleFor } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { kindsUnderTest } from "./_kinds";
import {
  A,
  CARD_IDS,
  READY_GEN,
  SETTLE_MS,
  SHOULD_RUN,
  TEST_NAME,
  TEST_TIMEOUT_MS,
  boundBodies,
  closeThrough,
  expectBodiesMatchCards,
} from "./_row-11";

describe.skipIf(!SHOULD_RUN)("body-grounding row 11: close, close all, reload and quit", () => {
  for (const kind of kindsUnderTest(11)) {
    if (kind.componentId === "session") continue;
    test(
      `${kind.componentId}: no body outlives its card, and its body is made again by a reload and saves before a quit`,
      async () => {
        const K = `row11-${kind.componentId}`;
        const K2 = `row11-${kind.componentId}-again`;
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: `${TEST_NAME}-${kind.componentId}`,
          persistInTestMode: true,
          restoreInTestMode: true,
          env: { TUGBANK_PATH: tugbankPath },
        });
        try {
          // ---- close ----
          // The Session card A beside it is a body too: every card is one.
          await app.seedDeckState({ state: kindDeck(kind, K, { sessions: [A] }), focusCardId: K });
          await standUpKind(app, kind, K);
          await expectBodiesMatchCards(app, "at the start", [K, A]);
          await app.dispatchControlAction("focus-session-card", { cardId: K });
          await closeThrough(app, K, "file.closeCard", 1, `close ${K}`, kind.rail);
          expect(await settleFor(() => bodyOf(app, K), (b) => b === null, SETTLE_MS), "the host holds no body for the card after the close").toBeNull();
          await expectBodiesMatchCards(app, "after the close", [A]);

          // ---- reload ----
          await app.seedDeckState({ state: kindDeck(kind, K2, { sessions: [A] }), focusCardId: K2 });
          const k = await standUpKind(app, kind, K2);
          const draft = "row11 kind draft before reload";
          if (kind.field !== undefined) {
            await k.nativeClickAtElement(kind.field);
            await app.nativeType(draft);
            const typed = await settleFor(() => k.evalJS<string>(`(document.querySelector(${JSON.stringify(kind.field)}) || { textContent: "" }).textContent`), (t) => t.includes(draft), SETTLE_MS);
            expect(typed, "its field holds the draft").toContain(draft);
          }
          const genBefore = await app.evalJS<number>(READY_GEN);
          // The page itself is kept: a mark set in it before is in it after.
          await k.evalJS<boolean>(`(window.__row11Kept = true)`);
          await app.nativeKey("r", ["cmd", "shift"]);
          let goneSamples = 0;
          const genAfter = await settleFor(
            async () => {
              if (!(await boundBodies(app)).includes(K2)) goneSamples += 1;
              return app.evalJS<number>(READY_GEN).catch(() => genBefore);
            },
            (gen) => gen > genBefore,
            20_000,
          );
          expect(genAfter, "the shell reloaded").toBeGreaterThan(genBefore);
          expect(goneSamples, "the card's body stayed bound across the shell's reload").toBe(0);
          const listed = await settleFor(() => app.evalJS<string[]>(CARD_IDS), (ids) => ids.includes(K2), SETTLE_MS);
          expect(listed, "the reloaded shell restored the card").toContain(K2);
          const again = await standUpKind(app, kind, K2);
          await expectBodiesMatchCards(app, "after the reload", [K2, A]);
          expect(await again.evalJS<boolean>(`window.__row11Kept === true`), "the body is the page it was before the reload").toBe(true);
          if (kind.field !== undefined) {
            const restored = await settleFor(() => again.evalJS<string>(`(document.querySelector(${JSON.stringify(kind.field)}) || { textContent: "" }).textContent`), (t) => t.includes(draft), SETTLE_MS);
            expect(restored, "the kept body still shows the draft").toContain(draft);
          }

          // ---- quit ----
          await app.quitGracefully({ timeoutMs: 20_000 });
          const log = app.tugappLog();
          const verdict = log.split("\n").filter((line) => line.includes("termination verdicts")).pop() ?? "";
          note(`quit: ${verdict.trim() || "no verdict line in the log"}`);
          expect(verdict, "the verdict names the card's body").toContain(`body:${K2}:`);
          expect(verdict, "and its body saved ok").toMatch(new RegExp(`body:${K2}: ok=true`));
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});

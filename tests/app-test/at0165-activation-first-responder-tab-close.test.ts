/**
 * at0165-activation-first-responder-tab-close.test.ts — Bug B: closing a tab
 * leaves the survivor first responder, and Cmd-W closes it ([P21]).
 *
 * One of the at0165-activation-first-responder split, a test to a file so
 * each launch fits its own budget. Why the active card always owns
 * first-responder-routed accelerators, and the shared decks and key helpers,
 * are `activation-first-responder-fixture.ts`.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/responder-chain.ts
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/components/tugways/chrome/session-permission-dialog.tsx
 * @family at0165-activation-first-responder
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  CARD,
  TAB,
  twoCards,
  frWithin,
  exists,
  cmdKey,
  settle,
} from "./activation-first-responder-fixture";

describe.skipIf(!SHOULD_RUN)("AT0165: activation restores the first responder", () => {
  test(
    "Bug B — closing a tab leaves the survivor first responder; Cmd-W closes it",
    async () => {
      const app = await launchTugApp({ testName: "at0165-bugB" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: twoCards("gallery-input"), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
        );
        await app.body("A").waitForCondition<boolean>(exists(TAB("B")), { timeoutMs: 6000 });

        // Activate B (it becomes first responder), then close it. The bar is
        // A's page's while A is the active card.
        await app.body("A").nativeClickAtElement(TAB("B"));
        await settle();
        expect(await app.evalJS<boolean>(frWithin(CARD("B"))), "B holds first responder").toBe(true);
        await cmdKey(app, "KeyW", "w");
        await app.waitForCondition<boolean>(`${exists(CARD("B"))} === false`, { timeoutMs: 6000 });

        // A is the surviving active card. The fix: its context took the first
        // responder on activation (no focusin needed).
        await settle();
        expect(await app.evalJS<boolean>(frWithin(CARD("A"))), "survivor holds first responder").toBe(true);

        // A second Cmd-W must now reach A and close it (the dropped-action bug).
        await cmdKey(app, "KeyW", "w");
        await app.waitForCondition<boolean>(`${exists(CARD("A"))} === false`, { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(exists(CARD("A"))), "Cmd-W closes the survivor").toBe(false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0165-bugB] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

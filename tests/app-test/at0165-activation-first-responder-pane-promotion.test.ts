/**
 * at0165-activation-first-responder-pane-promotion.test.ts — Bug C: a pane
 * promoted to frontmost on close takes the first responder ([P21]).
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
  twoPanes,
  frWithin,
  exists,
  cmdKey,
  settle,
} from "./activation-first-responder-fixture";

describe.skipIf(!SHOULD_RUN)("AT0165: activation restores the first responder", () => {
  test(
    "Bug C — a pane promoted to frontmost on close takes the first responder",
    async () => {
      const app = await launchTugApp({ testName: "at0165-bugC" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: twoPanes(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
        );
        // A was focused first (its context gets a key view); then activate p2/B.
        await app.waitForCondition<boolean>(`${exists(CARD("B"))} && ${exists(CARD("A"))}`, { timeoutMs: 6000 });
        await app.body("B").nativeClickAtElement(`${CARD("B")} input`);
        await settle();
        expect(await app.evalJS<boolean>(frWithin(CARD("B"))), "B (frontmost pane) holds first responder").toBe(true);

        // Close B → p2 is destroyed and p1 (card A) is promoted to frontmost. No
        // card-level activation / focusin fires for A. The fix: setKeyCard (the
        // universal activation signal) restores A's first responder.
        await cmdKey(app, "KeyW", "w");
        await app.waitForCondition<boolean>(`${exists(CARD("B"))} === false`, { timeoutMs: 6000 });
        await settle();
        expect(
          await app.evalJS<boolean>(frWithin(CARD("A"))),
          "promoted pane's card holds the first responder",
        ).toBe(true);

        // And a Cmd-W now reaches A and closes it (the stranded-pane bug).
        await cmdKey(app, "KeyW", "w");
        await app.waitForCondition<boolean>(`${exists(CARD("A"))} === false`, { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(exists(CARD("A"))), "Cmd-W closes the promoted pane's card").toBe(false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0165-bugC] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

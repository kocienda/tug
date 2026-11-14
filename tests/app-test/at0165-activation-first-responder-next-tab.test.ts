/**
 * at0165-activation-first-responder-next-tab.test.ts — Bug D: closing a tab
 * in a multi-card pane lets the next tab take Cmd-W ([P21]).
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
  frWithin,
  exists,
  cmdKey,
  settle,
} from "./activation-first-responder-fixture";

describe.skipIf(!SHOULD_RUN)("AT0165: activation restores the first responder", () => {
  test(
    "Bug D — closing a tab in a multi-card pane lets the next tab take Cmd-W",
    async () => {
      // Cmd-W routing through the responder chain needs a real key window,
      // which pid mode's harness window is.
      const app = await launchTugApp({ testName: "at0165-bugD" });
      try {
        await app.enableDeckTrace(true);
        const state = {
          cards: [
            { id: "A", componentId: "gallery-label", title: "A", closable: true },
            { id: "B", componentId: "gallery-label", title: "B", closable: true },
            { id: "C", componentId: "gallery-label", title: "C", closable: true },
          ],
          panes: [{ id: "p1", position: { x: 40, y: 40 }, size: { width: 700, height: 560 }, cardIds: ["A", "B", "C"], activeCardId: "A", title: "", acceptsFamilies: ["maker"] }],
          activePaneId: "p1",
          hasFocus: true,
        };
        await app.seedDeckState({ state, focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.body("A").waitForCondition<boolean>(exists(TAB("A")), { timeoutMs: 6000 });

        // Click into card A so it (its card responder) is first responder.
        await app.body("A").nativeClickAtElement(CARD("A"));
        await settle();
        const d0 = await app.evalJS<string>(`'fr=' + (document.querySelector('[data-first-responder]')||{getAttribute:function(){return 'NONE'}}).getAttribute('data-first-responder')`);
        process.stderr.write(`\n[DIAG bugD after click A] ${d0}\n`);

        // Close A → B activates in the same pane.
        await cmdKey(app, "KeyW", "w");
        await app.waitForCondition<boolean>(`${exists(CARD("A"))} === false`, { timeoutMs: 6000 });
        await settle();
        const d1 = await app.evalJS<string>(`'fr=' + (document.querySelector('[data-first-responder]')||{getAttribute:function(){return 'NONE'}}).getAttribute('data-first-responder') + ' frInB=' + (${frWithin(CARD("B"))})`);
        process.stderr.write(`\n[DIAG bugD after close A] ${d1}\n`);

        expect(await app.evalJS<boolean>(frWithin(CARD("B"))), "next tab holds first responder").toBe(true);
        await cmdKey(app, "KeyW", "w");
        await app.waitForCondition<boolean>(`${exists(CARD("B"))} === false`, { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(exists(CARD("B"))), "Cmd-W closes the next tab").toBe(false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0165-bugD] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

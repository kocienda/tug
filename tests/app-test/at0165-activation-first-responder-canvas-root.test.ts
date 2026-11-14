/**
 * at0165-activation-first-responder-canvas-root.test.ts — Bug E: when the
 * first responder is the canvas root, Cmd-W still closes the active card
 * ([P21]).
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
  exists,
} from "./activation-first-responder-fixture";

describe.skipIf(!SHOULD_RUN)("AT0165: activation restores the first responder", () => {
  test(
    "Bug E — when the first responder is the canvas root, Cmd-W still closes the active card",
    async () => {
      const app = await launchTugApp({ testName: "at0165-bugE" });
      try {
        await app.enableDeckTrace(true);
        const state = {
          cards: [
            { id: "A", componentId: "gallery-label", title: "A", closable: true },
            { id: "B", componentId: "gallery-label", title: "B", closable: true },
          ],
          panes: [{ id: "p1", position: { x: 40, y: 40 }, size: { width: 600, height: 480 }, cardIds: ["A", "B"], activeCardId: "A", title: "", acceptsFamilies: ["maker"] }],
          activePaneId: "p1",
          hasFocus: true,
        };
        await app.seedDeckState({ state });
        await app.waitForCondition<boolean>(`(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`);
        await app.waitForCondition<boolean>(exists(CARD("A")), { timeoutMs: 6000 });

        // Pin the first responder to the canvas root — the stranded state the bug
        // leaves behind (a card/pane closed, nothing re-promoted a card) — and
        // dispatch Cmd-W in the SAME synchronous tick so the pin holds at dispatch
        // (the deck otherwise re-focuses the active card asynchronously). Assert
        // FR is the canvas at dispatch, proving the close routes via the canvas
        // last-resort handler, not normal card routing.
        const frAtDispatch = await app.evalJS<string>(
          `(function(){
            window.__tug.setFirstResponder("deck-canvas");
            var fr = document.querySelector('[data-first-responder]');
            var frId = fr ? fr.getAttribute('data-first-responder') : 'NONE';
            document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", key: "w", metaKey: true, bubbles: true, cancelable: true }));
            return frId;
          })()`,
        );
        expect(frAtDispatch, "first responder is the canvas root at Cmd-W dispatch").toBe("deck-canvas");
        await app.waitForCondition<boolean>(`${exists(CARD("A"))} === false`, { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(exists(CARD("A"))), "active card A closed").toBe(false);
        expect(await app.evalJS<boolean>(exists(CARD("B"))), "sibling B and the pane remain").toBe(true);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0165-bugE] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

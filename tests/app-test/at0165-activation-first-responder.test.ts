/**
 * at0165-activation-first-responder.test.ts — the active card always owns
 * first-responder-routed accelerators ([P21]).
 *
 * Cmd-W (`close`) routes to the chain's single first responder; Escape runs the
 * engine's Escape ladder (reads the active card's context directly). When a card
 * or pane closes, the next active card must take the first responder so Cmd-W
 * isn't dropped. The first responder otherwise rides DOM `focusin`, which doesn't
 * fire when the activated card has no focus-accepting element (a static card) or
 * when the activation `.focus()` is idempotency-skipped — leaving the first
 * responder fallen up on the `deck-canvas` root, where `close` has no handler.
 *
 * Two complementary fixes, both exercised here:
 *  1. `FocusManager.setKeyCard` (the universal activation signal) restores the
 *     first responder to the activated card on every key-card change, including
 *     pane-frontmost promotion (Bugs A–D pin the post-activation invariant).
 *  2. `DeckCanvas` is the `canHandle` root; its last-resort `close` handler
 *     routes to the active pane, so Cmd-W closes the frontmost card even when the
 *     first responder is stranded on `deck-canvas` (Bug E — the literal repro of
 *     the reported drop, pinned red→green).
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/responder-chain.ts
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/components/tugways/chrome/session-permission-dialog.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const SID = "at0165-session";
const FEED_CODE_OUTPUT = 0x40;
const REQUEST_ID = "at0165-perm-1";

const CARD = (id: string) => `[data-card-id="${id}"]`;
/** A tab in a pane's bar, which the pane's active card draws in its own page. */
const TAB = (id: string) => `[data-testid="tug-tab-${id}"]`;
const DIALOG = `${CARD("A")} [data-slot="session-permission-dialog"]`;

// Two separate panes, each one card. p2 (card B) is the active/frontmost pane.
// Closing B destroys p2 and promotes p1 (card A) to frontmost — a pane
// activation that fires no card-level focus claim and no `focusin`.
function twoPanes() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 560, y: 40 },
        size: { width: 460, height: 520 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

function twoCards(aComponent: string) {
  return {
    cards: [
      { id: "A", componentId: aComponent, title: "Card A", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 860, height: 620 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

function controlRequestForward(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: REQUEST_ID,
    is_question: false,
    tool_name: "Bash",
    input: { command: "tokei" },
    permission_suggestions: [
      { behavior: "allow", destination: "project", type: "addRules", rules: [{ toolName: "Bash" }] },
    ],
  };
}

const frWithin = (cardSel: string) =>
  `(function(){
    var fr = document.querySelector('[data-first-responder]');
    var card = document.querySelector(${JSON.stringify(cardSel)});
    return fr !== null && card !== null && card.contains(fr);
  })()`;

const exists = (sel: string) => `document.querySelector(${JSON.stringify(sel)}) !== null`;

/** Synthetic capture-phase ⌘ keydown — a posted ⌘ chord can be swallowed by
 *  macOS before the WebView; the synthetic event drives the same capture-phase
 *  keybinding pipeline (matchKeybinding → sendToFirstResponder). */
async function cmdKey(app: App, code: string, key: string): Promise<void> {
  await app.evalJS<void>(
    `document.dispatchEvent(new KeyboardEvent("keydown", { code: ${JSON.stringify(code)}, key: ${JSON.stringify(key)}, metaKey: true, bubbles: true, cancelable: true }))`,
  );
}

const settle = () => new Promise((r) => setTimeout(r, 350));

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

  test(
    "Bug A — a card-modal dialog stays Cmd-.-dismissable after a tab round-trip",
    async () => {
      const app = await launchTugApp({ testName: "at0165-bugA" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: twoCards("session"), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // Present a card-modal permission dialog on A. The request rides in
        // on the replay as a turn blocked on a permission — the session
        // card renders the dialog from its own (body) page's transcript. A
        // frame ingested after `replay_complete` opens no turn, and a `send`
        // would go out on the wire for a session tugcast never spawned,
        // whose `session_unknown` reply errors the card's body.
        const ingestA = (decoded: Record<string, unknown>) =>
          app.driveSession("A", { op: "ingestFrame", feedId: FEED_CODE_OUTPUT, decoded });
        await ingestA({ type: "replay_started", tug_session_id: SID });
        await ingestA({
          type: "add_user_message",
          tug_session_id: SID,
          content: [{ type: "text", text: "count lines with tokei" }],
        });
        await ingestA(controlRequestForward());
        await ingestA({
          type: "replay_complete",
          tug_session_id: SID,
          count: 1,
          firstLoadedTurnIndex: 0,
          totalTurns: 1,
          hasOlder: false,
        });
        await app.body("A").waitForCondition<boolean>(exists(DIALOG), { timeoutMs: 8000 });

        // Switch to B (displaces the chain's first responder), then back to A.
        // The dialog survives ([P20]/[P21]); the question is whether Cmd-. still
        // reaches it.
        // Switch to B (displaces the chain's first responder onto B), then back
        // to A. The dialog survives ([P20]/[P21]).
        await app.body("A").nativeClickAtElement(TAB("B"));
        await settle();
        expect(
          await app.evalJS<boolean>(frWithin(CARD("A"))),
          "switching to B moves the first responder off A",
        ).toBe(false);
        await app.body("B").nativeClickAtElement(TAB("A"));
        await app.body("A").waitForCondition<boolean>(exists(DIALOG), { timeoutMs: 6000 });
        await settle();

        // The fix: reactivating A restores its first responder (the per-card FR
        // axis), so a first-responder-routed accelerator reaches the card again
        // instead of being dropped on B / a dead node. Without it FR stayed off
        // A after the round-trip (the dropped-Cmd-. bug); Escape kept working
        // because the engine ladder reads A's context directly.
        expect(
          await app.evalJS<boolean>(frWithin(CARD("A"))),
          "reactivating A restores its first responder",
        ).toBe(true);

        // And Escape (the engine ladder) still dismisses the dialog — the axis
        // that always worked, confirming the surface itself is healthy.
        await cmdKey(app, "Period", ".");
        await app.evalJS<void>(
          `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }))`,
        );
        await app.body("A").waitForCondition<boolean>(`${exists(DIALOG)} === false`, { timeoutMs: 6000 });
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0165-bugA] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

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

/**
 * at0165-activation-first-responder-dialog-round-trip.test.ts — Bug A: a
 * card-modal dialog stays Cmd-.-dismissable after a tab round-trip ([P21]).
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
  SID,
  FEED_CODE_OUTPUT,
  CARD,
  TAB,
  DIALOG,
  twoCards,
  controlRequestForward,
  frWithin,
  exists,
  cmdKey,
  settle,
} from "./activation-first-responder-fixture";

describe.skipIf(!SHOULD_RUN)("AT0165: activation restores the first responder", () => {
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
});

/**
 * at0777-quit-work-ends — the work ending under the Quit alert takes it down and
 * quits, with nobody pressing a button.
 *
 * A short turn comes to its end while the alert is up. That takes the question
 * back across the bus, the overlay's alert closes, and the quit goes on.
 *
 * @family at0777
 * @covers tugapp/Sources/BridgeHandler.swift
 * @covers tugdeck/src/lib/quit-guard-store.ts
 * @covers tugdeck/src/lib/overlay-shell.ts
 * @covers tugdeck/src/overlay/overlay-root.tsx
 * @covers tugdeck/src/components/tugways/tug-alert.tsx
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { overlayReady } from "./overlay-fixture";
import { EXIT_WITHIN_MS, launchStreaming, present, pressQuit, quitReasons } from "./quit-guard-fixture";
import { BODY_READY_MS } from "./session-body-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
/** Long enough to raise the alert over the turn, and short enough to end under it. */
const SHORT_TURN_MESSAGES = 1;

describe.skipIf(!SHOULD_RUN)("at0777: the work ending under the alert", () => {
  test(
    "takes it down and quits",
    async () => {
      const app = await launchStreaming("at0777-work-ends", SHORT_TURN_MESSAGES);
      try {
        const overlay = await overlayReady(app);
        pressQuit(app);
        await overlay.waitForCondition<boolean>(present('[data-slot="tug-alert"]'), { timeoutMs: BODY_READY_MS });

        expect(await app.awaitExit(EXIT_WITHIN_MS), "the quit goes on with no button pressed").toBe(true);

        const why = quitReasons(app);
        note(`the host: ${why.join(" / ")}`);
        expect(why.at(-1), "the guard is what sent it on").toContain("the quit guard confirmed it");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

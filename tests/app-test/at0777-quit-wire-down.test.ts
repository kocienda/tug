/**
 * at0777-quit-wire-down — with tugcast gone, ⌘Q over a live turn quits and asks
 * nothing.
 *
 * The bus is tugcast's feed, so neither a body's request nor the overlay's alert
 * could cross it. The body asks the host instead, and the shell answers the
 * host's call that it will not ask.
 *
 * @family at0777
 * @covers tugapp/Sources/QuitGate.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BridgeHandler.swift
 * @covers tugdeck/src/lib/quit-guard-store.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { EXIT_WITHIN_MS, launchStreaming, present, pressQuit, quitReasons } from "./quit-guard-fixture";
import { PLACED_MS, pollFor } from "./session-body-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
/** Minutes of stream at the fixture's pace: longer than this file runs. */
const LONG_TURN_MESSAGES = 40;
const DISCONNECTED = '.tug-banner[data-visible="true"]';

describe.skipIf(!SHOULD_RUN)("at0777: ⌘Q with tugcast gone", () => {
  test(
    "quits and asks nothing",
    async () => {
      const app = await launchStreaming("at0777-wire-down", LONG_TURN_MESSAGES);
      try {
        await app.stopTugcast();
        const disconnected = await pollFor(
          () => app.evalJS<boolean>(present(DISCONNECTED)),
          (shown) => shown,
          PLACED_MS,
        );
        expect(disconnected, "the shell has seen the wire go").toBe(true);
        pressQuit(app);
        expect(await app.awaitExit(EXIT_WITHIN_MS), "⌘Q exits with the wire down").toBe(true);

        const why = quitReasons(app);
        note(`the host: ${why.join(" / ")}`);
        expect(why.at(-1), "the shell said it would not ask").toContain("nothing to ask");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

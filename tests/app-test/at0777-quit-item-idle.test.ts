/**
 * at0777-quit-item-idle — the Quit item with nothing active exits and asks
 * nothing.
 *
 * The item asks the shell under the host's deadline. The app's log says why it
 * went: "nothing to ask" is the page's answer, which a page that timed out or
 * failed the call could not have given. Nobody here answers an alert, so an exit
 * is the proof none went up.
 *
 * @family at0777
 * @covers tugapp/Sources/QuitGate.swift
 * @covers tugapp/Sources/MenuBarBuilder.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugdeck/src/lib/quit-guard-store.ts
 * @covers tugdeck/src/host/declarations/lifecycle.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
/** Above the termination pipeline's own deadlines, so a stuck quit fails here. */
const EXIT_WITHIN_MS = 15_000;

describe.skipIf(!SHOULD_RUN)("at0777: the Quit item and the quit guard", () => {
  test(
    "with nothing active it exits and asks nothing",
    async () => {
      const tugbankPath = mkTempTugbank();
      onTestRunEnd(() => rmTempTugbank(tugbankPath));
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({ testName: "at0777-item-idle", env: { TUGBANK_PATH: tugbankPath } });
      try {
        await overlayReady(app);
        // The item may end the process before the verb's reply gets back.
        void app.performMenuItem("app.quit").catch(() => {});
        expect(await app.awaitExit(EXIT_WITHIN_MS), "the item exits the app").toBe(true);

        const why = app.tugappLog().split("\n").filter((line) => line.includes("the Quit item goes on"));
        note(`the host: ${why.join(" / ")}`);
        expect(why.at(-1), "the page answered that there was nothing to ask").toContain("nothing to ask");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

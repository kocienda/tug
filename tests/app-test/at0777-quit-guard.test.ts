/**
 * at0777-quit-guard — a quit asks first when a turn is in flight, and only then.
 *
 * Both doors, because they reach the guard differently. `nativeKey` posts ⌘Q as
 * a real key event, and with a page holding the keyboard its funnel takes the
 * chord ahead of AppKit: the shell asks its guard directly, and a body sends the
 * request to the host, as the Quit item does. `performMenuItem` is the Quit item,
 * which asks the shell under the host's deadline. The app's log tells the shell's
 * funnel from the item when nothing is active: the funnel posts its own go-ahead
 * ("the quit guard confirmed it"), and the item hears "nothing to ask".
 *
 * Each launch ends in the exit that is its verdict:
 *
 * - With a body card streaming, ⌘Q raises the alert in the overlay. Cancel takes
 *   it down, the app stays up and the turn keeps streaming. The Quit item asks
 *   again, since the host never hears a Cancel, and Quit exits.
 * - With nothing active, ⌘Q exits. Nobody here answers an alert, so an exit is
 *   the proof none went up. `at0777-quit-item-idle` is the same case by the item.
 *
 * @family at0777
 * @covers tugapp/Sources/QuitGate.swift
 * @covers tugapp/Sources/MenuBarBuilder.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BridgeHandler.swift
 * @covers tugdeck/src/lib/quit-guard-store.ts
 * @covers tugdeck/src/components/tugways/tug-quit-guard.tsx
 * @covers tugdeck/src/host/declarations/lifecycle.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import { overlayReady } from "./overlay-fixture";
import { BODY_READY_MS, PLACED_MS, column, pollFor, promptPhase, spawnStub } from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
/** Above the termination pipeline's own deadlines, so a stuck quit fails here. */
const EXIT_WITHIN_MS = 15_000;
const CARD = "at0777-card";
/** Minutes of stream at the fixture's pace: longer than this file runs. */
const STREAM_MESSAGES = 40;

const ALERT = '[data-slot="tug-alert"]';
const ALERT_TITLE = `${ALERT} .tug-alert-title`;
const ALERT_MESSAGE = `${ALERT} .tug-alert-message`;
const ALERT_CANCEL = `${ALERT} .tug-alert-actions [data-slot="tug-push-button"]:first-child`;
const ALERT_QUIT = `${ALERT} .tug-alert-actions [data-slot="tug-push-button"]:last-child`;

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const text = (selector: string): string => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "").trim()`;
const transcriptLength = `(document.querySelector('[data-testid="session-card-transcript"]')?.textContent ?? "").length`;

/** The chord or the item may end the process before the verb's reply gets back. */
function pressQuit(app: App): void {
  void app.nativeKey("q", ["cmd"]).catch(() => {});
}

function chooseQuitItem(app: App): void {
  void app.performMenuItem("app.quit").catch(() => {});
}

function launch(testName: string, env: Record<string, string> = {}): Promise<App> {
  const tugbankPath = mkTempTugbank();
  onTestRunEnd(() => rmTempTugbank(tugbankPath));
  seedTugbankForLaunch(tugbankPath);
  return launchTugApp({ testName, env: { TUGBANK_PATH: tugbankPath, ...env } });
}

describe.skipIf(!SHOULD_RUN)("at0777: ⌘Q and the quit guard", () => {
  test(
    "with a turn in flight it asks: Cancel leaves the turn going, and Quit exits",
    async () => {
      const stubDir = stubDirectory();
      const app = await launch("at0777-turn", { [STUB_TRANSCRIPT_DIR_ENV]: stubDir });
      try {
        await app.seedDeckState({ state: column([CARD]), focusCardId: CARD });
        await spawnStub(app, CARD, stubDir, STREAM_MESSAGES);
        const readyBody = await pollFor(
          async () => (await app.bodies()).find((b) => b.cardId === CARD) ?? null,
          (b) => b !== null && b.state === "ready" && b.visible,
          BODY_READY_MS,
        );
        expect(readyBody, "the card's body is ready").not.toBeNull();
        const body = app.body(CARD);
        await body.waitForCondition<boolean>(present('[data-testid="session-card-transcript"]'), {
          timeoutMs: BODY_READY_MS,
        });
        await body.driveSession({ op: "send", text: "Walk the module and report each pass." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: BODY_READY_MS });
        const overlay = await overlayReady(app);

        pressQuit(app);
        await overlay.waitForCondition<boolean>(present(ALERT), { timeoutMs: BODY_READY_MS });
        expect(await overlay.evalJS<string>(text(ALERT_TITLE))).toBe("Quit Tug?");
        const message = await overlay.evalJS<string>(text(ALERT_MESSAGE));
        note(`the alert says: ${message}`);
        expect(message, "it says what a quit would stop").toContain("is still working");

        // Never press the wrong one: guard each click on the button's own words.
        expect(await overlay.evalJS<string>(text(ALERT_CANCEL))).toBe("Cancel");
        const streamedBefore = await body.evalJS<number>(transcriptLength);
        await overlay.nativeClickAtElement(ALERT_CANCEL);
        await overlay.waitForCondition<boolean>(`!(${present(ALERT)})`, { timeoutMs: PLACED_MS });
        await body.waitForCondition<boolean>(`${transcriptLength} > ${streamedBefore}`, { timeoutMs: PLACED_MS });
        expect(await body.evalJS<string | null>(promptPhase), "Cancel leaves the turn going").toBe("streaming");

        chooseQuitItem(app);
        await overlay.waitForCondition<boolean>(present(ALERT), { timeoutMs: BODY_READY_MS });
        expect(await overlay.evalJS<string>(text(ALERT_QUIT))).toBe("Quit");
        await overlay.nativeClickAtElement(ALERT_QUIT);
        expect(await app.awaitExit(EXIT_WITHIN_MS), "Quit exits the app").toBe(true);

        const why = app.tugappLog().split("\n").filter((line) => line.includes("the Quit item goes on"));
        note(`the host: ${why.join(" / ")}`);
        expect(why.at(-1), "the guard's answer is what quit it").toContain("the quit guard confirmed it");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with nothing active it exits and asks nothing",
    async () => {
      const app = await launch("at0777-idle");
      try {
        await overlayReady(app);
        pressQuit(app);
        expect(await app.awaitExit(EXIT_WITHIN_MS), "⌘Q exits the app").toBe(true);

        const why = app.tugappLog().split("\n").filter((line) => line.includes("the Quit item goes on"));
        note(`the host: ${why.join(" / ")}`);
        expect(why.at(-1), "the page sent it on, and no deadline had to").toContain("the quit guard confirmed it");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

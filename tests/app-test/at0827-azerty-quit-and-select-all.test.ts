/**
 * at0827-azerty-quit-and-select-all — on French (AZERTY), ⌘Q and ⌘A go by
 * the letter the key types, not by where the key sits on a US keyboard.
 *
 * AZERTY swaps A and Q: the key at `KeyA` types `q` and the key at `KeyQ`
 * types `a`. The reported bug was the deck matching chords by position, so
 * ⌘ plus the key labelled A quit the app. Chord matching now reads the
 * letter the keydown carries (`effectiveCode` in `chord-format.ts`), and this
 * file pins both halves against a real AZERTY layout in a lab guest:
 *
 * - ⌘ at `KeyQ` (labelled A) selects all the composer's text, and asks
 *   nothing about quitting.
 * - ⌘ at `KeyA` (labelled Q) reaches Quit.
 *
 * Quit is read through the app's own quit path, without letting the app
 * exit: a stub turn is streaming in the card's body, so the quit guard
 * stops to ask "Quit Tug?" in the overlay, and Cancel takes it down with the
 * app still up. The select-all comes first, while nothing is asking, so the
 * one alert the file sees can only be the second press's.
 *
 * It selects an input source, which changes the machine's keyboard, so it
 * runs only in a lab guest (`just lab-app-test`).
 *
 * @lab
 * @covers tugdeck/src/components/tugways/chord-format.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import { overlayReady } from "./overlay-fixture";
import {
  BODY_READY_MS,
  PLACED_MS,
  PROMPT_INPUT,
  composerFocused,
  oneSlot,
  pollFor,
  promptPhase,
  spawnStub,
} from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const IN_LAB = process.env.TUG_LAB === "1";
const TEST_TIMEOUT_MS = 60_000;
const CARD = "at0827-card";
/** Minutes of stream at the fixture's pace: longer than this file runs. */
const STREAM_MESSAGES = 40;
const AZERTY = "com.apple.keylayout.French";
const TYPED = "bonjour azerty";

const ALERT = '[data-slot="tug-alert"]';
const ALERT_TITLE = `${ALERT} .tug-alert-title`;
const ALERT_CANCEL = `${ALERT} .tug-alert-actions [data-slot="tug-push-button"]:first-child`;
const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const text = (selector: string): string => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "").trim()`;
/** The overlay's claim on the window (`overlay/overlay-claim.ts`); see at0777 for why a click waits on it. */
const CLAIM = `document.documentElement.getAttribute("data-overlay-claim-state")`;
const ALERT_STANDS = `${present(ALERT)} && ${CLAIM} === "all"`;
const ALERT_GONE = `!(${present(ALERT)}) && ${CLAIM} !== "all"`;
const SELECTED = `(window.getSelection()?.toString() ?? "")`;

function launch(testName: string, env: Record<string, string>): Promise<App> {
  const tugbankPath = mkTempTugbank();
  onTestRunEnd(() => rmTempTugbank(tugbankPath));
  seedTugbankForLaunch(tugbankPath);
  return launchTugApp({ testName, env: { TUGBANK_PATH: tugbankPath, ...env } });
}

describe.skipIf(!SHOULD_RUN || !IN_LAB)("at0827: AZERTY ⌘Q and ⌘A", () => {
  test(
    "the key labelled A selects all, and the key labelled Q reaches Quit",
    async () => {
      const stubDir = stubDirectory();
      const app = await launch("at0827-azerty", { [STUB_TRANSCRIPT_DIR_ENV]: stubDir });
      try {
        await app.seedDeckState({ state: oneSlot([CARD]), focusCardId: CARD });
        await spawnStub(app, CARD, stubDir, STREAM_MESSAGES);
        const readyBody = await pollFor(
          async () => (await app.bodies()).find((b) => b.cardId === CARD) ?? null,
          (b) => b !== null && b.state === "ready" && b.visible,
          BODY_READY_MS,
        );
        expect(readyBody, "the card's body is ready").not.toBeNull();
        const body = app.body(CARD);
        await body.waitForCondition<boolean>(present(PROMPT_INPUT), { timeoutMs: BODY_READY_MS });
        await body.driveSession({ op: "send", text: "Walk the module and report each pass." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: BODY_READY_MS });
        const overlay = await overlayReady(app);

        // Text to select, typed while the layout is still the guest's own.
        await body.nativeClickAtElement(PROMPT_INPUT);
        await body.waitForCondition<boolean>(composerFocused, { timeoutMs: PLACED_MS });
        await app.nativeType(TYPED);
        await body.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent ?? "").includes(${JSON.stringify(TYPED)})`,
          { timeoutMs: PLACED_MS },
        );

        const selected = await app.selectInputSource(AZERTY);
        expect(selected.current, "AZERTY is the current layout").toBe(AZERTY);
        await app.setKeyboardType("iso");

        // ⌘ + the key labelled A, at the US Q position.
        await app.nativeKeyCode("KeyQ", ["cmd"]);
        await body.waitForCondition<boolean>(`${SELECTED}.includes(${JSON.stringify(TYPED)})`, { timeoutMs: PLACED_MS });
        expect(await overlay.evalJS<boolean>(present(ALERT)), "selecting all asks nothing about quitting").toBe(false);
        expect(await app.awaitExit(0), "the app is still running").toBe(false);

        // ⌘ + the key labelled Q, at the US A position.
        await app.nativeKeyCode("KeyA", ["cmd"]);
        await overlay.waitForCondition<boolean>(ALERT_STANDS, { timeoutMs: BODY_READY_MS });
        expect(await overlay.evalJS<string>(text(ALERT_TITLE)), "the quit guard asks").toBe("Quit Tug?");
        note("⌘ at KeyA under AZERTY raised the quit guard's alert");

        expect(await overlay.evalJS<string>(text(ALERT_CANCEL))).toBe("Cancel");
        await overlay.nativeClickAtElement(ALERT_CANCEL);
        await overlay.waitForCondition<boolean>(ALERT_GONE, { timeoutMs: PLACED_MS });
        expect(await body.evalJS<string | null>(promptPhase), "Cancel leaves the turn going").toBe("streaming");
        expect(await app.awaitExit(0), "Cancel leaves the app running").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * quit-guard-fixture.ts — a streaming body card with the keyboard in it, for the
 * at0777 files whose ⌘Q nobody answers. Such a ⌘Q goes to the host rather than
 * across the bus to the shell, and an exit is the verdict.
 *
 * Not a test: no `describe` here.
 */

import { expect } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import { BODY_READY_MS, oneSlot, pollFor, promptPhase, spawnStub } from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

/** Above the termination pipeline's own deadlines, so a stuck quit fails here. */
export const EXIT_WITHIN_MS = 15_000;

const CARD = "at0777-card";

export const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;

/** A body card streaming a turn of `messages`, about three seconds each. */
export async function launchStreaming(testName: string, messages: number): Promise<App> {
  const tugbankPath = mkTempTugbank();
  onTestRunEnd(() => rmTempTugbank(tugbankPath));
  seedTugbankForLaunch(tugbankPath);
  const stubDir = stubDirectory();
  const app = await launchTugApp({ testName, env: { TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
  await app.seedDeckState({ state: oneSlot([CARD]), focusCardId: CARD });
  await spawnStub(app, CARD, stubDir, messages);
  const readyBody = await pollFor(
    async () => (await app.bodies()).find((b) => b.cardId === CARD) ?? null,
    (b) => b !== null && b.state === "ready" && b.visible,
    BODY_READY_MS,
  );
  expect(readyBody, "the card's body is ready").not.toBeNull();
  const body = app.body(CARD);
  await body.waitForCondition<boolean>(present('[data-testid="session-card-transcript"]'), { timeoutMs: BODY_READY_MS });
  await body.driveSession({ op: "send", text: "Walk the module and report each pass." });
  await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: BODY_READY_MS });
  expect(await body.evalJS<boolean>("document.hasFocus()"), "the keyboard is in the body").toBe(true);
  return app;
}

/** The chord may end the process before the verb's reply gets back. */
export function pressQuit(app: App): void {
  void app.nativeKey("q", ["cmd"]).catch(() => {});
}

/** Why the host went on with the quit, as its log says, oldest first. */
export function quitReasons(app: App): string[] {
  return app.tugappLog().split("\n").filter((line) => line.includes("the Quit item goes on"));
}

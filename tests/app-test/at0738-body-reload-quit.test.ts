/**
 * at0738-body-reload-quit.test.ts — a body card returns as a body on its
 * session after a shell reload, and reaches disk on a quit mid-turn.
 *
 * Part of the gate for the body path, split from `at0738-session-body` one
 * leg per file (see `at0738-body-placement` for the list). The app launches
 * with bodies on; shared helpers live in `session-body-fixture.ts`.
 *
 * **Reload and quit.** A shell reload keeps every body: the card's page stays
 * bound to the same session, and the reloaded shell re-adopts it, ready and
 * shown. A quit with the body card mid-turn prepares every view under
 * one deadline: the body's card reaches disk with the draft typed into it, and
 * the teardown fires no forced kill.
 *
 * @family at0738-body
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-facts-store.ts
 * @covers tugdeck/src/lib/body-command-route.ts
 * @covers tugdeck/src/components/chrome/card-placement-beacon.tsx
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-intent.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyGeometry.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { BodyViewSnapshot } from "./_harness/client";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead } from "./_harness/tugbank-helpers";
import {
  BODY_READY_MS,
  PLACED_MS,
  PROMPT_INPUT,
  column,
  composerFocused,
  pollFor,
  spawnStub,
} from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!SHOULD_RUN)("at0738: a Session card's body", () => {
  test(
    "returns as a body on its session after a reload, and reaches disk on a quit mid-turn",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      onTestRunEnd(() => rmTempTugbank(tugbankPath));
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "at0738-body-reload-quit",
        env: { TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      const SAFE = "at0738-safe";
      const DRAFT = "at0738 draft survives the quit";
      let quit = false;
      try {
        await app.seedDeckState({ state: column([SAFE]), focusCardId: SAFE });
        const tugSessionId = await spawnStub(app, SAFE, stubDir);
        const readyBody = (b: BodyViewSnapshot | null): boolean => b !== null && b.state === "ready" && b.visible;
        const safeBody = async () => (await app.bodies()).find((b) => b.cardId === SAFE) ?? null;
        expect(readyBody(await pollFor(safeBody, readyBody, BODY_READY_MS)), "the card's body is ready").toBe(true);

        // ---- A reload: the body stays, and the reloaded shell re-adopts it ----

        await app.appReload({ timeoutMs: 20_000 });
        const back = await pollFor(safeBody, readyBody, BODY_READY_MS);
        const boundTo = await pollFor(
          () =>
            // card-dom: shell — the binding is the shell's record of the card.
            app.evalJS<string | null>(
              `(function () { try { return window.__tug.cardLineFacts(${JSON.stringify(SAFE)}).tugSessionId; } catch (e) { return null; } })()`,
            ),
          (id) => id !== null,
          BODY_READY_MS,
        );
        const placeholder = await app.evalJS<boolean>(
          `document.querySelector('[data-body-placeholder][data-card-id="${SAFE}"]') !== null`,
        );
        note(`after the reload: body ${JSON.stringify(back)}, bound to ${boundTo} (spawned ${tugSessionId})`);
        expect(readyBody(back), "the card's body is ready and shown after the reload").toBe(true);
        expect(placeholder, "the reloaded shell stands a placeholder for it").toBe(true);
        expect(boundTo, "bound to the same session").toBe(tugSessionId);

        // ---- A quit mid-turn: the body's card reaches disk ----

        const body = app.body(SAFE);
        /** Run one stage of the quit's set-up, naming it if it throws. */
        const stage = async (label: string, run: () => Promise<unknown>): Promise<void> => {
          try {
            await run();
          } catch (error) {
            throw new Error(`${label}: ${String(error)}`);
          }
        };
        // A body reports ready at its bound even before a resume lands, so
        // the session is driven once the card shows its transcript.
        await stage("the reloaded body binds its session", () =>
          body.waitForCondition<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null`, {
            timeoutMs: BODY_READY_MS,
          }),
        );
        await stage("a prompt is sent in the body", () =>
          body.driveSession({ op: "send", text: "Walk the module and report each pass." }),
        );
        await stage("the body's turn streams", () =>
          body.waitForCondition<boolean>(
            `(function () {
              var entry = document.querySelector('[data-slot="tug-prompt-entry"]');
              return entry !== null && entry.getAttribute("data-phase") === "streaming";
            })()`,
            { timeoutMs: BODY_READY_MS },
          ),
        );
        await stage("the composer takes the click", async () => {
          await body.nativeClickAtElement(PROMPT_INPUT);
          await body.waitForCondition<boolean>(composerFocused, { timeoutMs: PLACED_MS });
        });
        await stage("the draft is typed", async () => {
          await app.nativeType(DRAFT);
          await body.waitForCondition<boolean>(
            `(function () {
              var input = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
              return input !== null && input.textContent.indexOf(${JSON.stringify(DRAFT)}) >= 0;
            })()`,
            { timeoutMs: PLACED_MS },
          );
        });
        await app.quitGracefully({ timeoutMs: 30_000 });
        quit = true;
        const report = app.quiesceReport();
        const bag = tugbankRead<unknown>(tugbankPath, "dev.tugapp.deck.cardstate", SAFE);
        const bagText = JSON.stringify(bag?.value ?? null);
        note(`quiesce: ${JSON.stringify(report)}; bag holds the draft: ${bagText.includes(DRAFT)}`);
        expect(report, "the app wrote its shutdown report").not.toBeNull();
        expect(report!.sigkills, "the teardown forced no kill").toEqual([]);
        expect(bag, "the body's card has a bag on disk").not.toBeNull();
        expect(bagText.includes(DRAFT), "the bag on disk holds the draft typed mid-turn").toBe(true);
      } finally {
        if (!quit) await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

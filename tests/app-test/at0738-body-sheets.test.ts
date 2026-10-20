/**
 * at0738-body-sheets.test.ts — a body card's in-card sheets open in the body
 * through the shell's menu path.
 *
 * Part of the gate for the body path, split from `at0738-session-body` one
 * leg per file (see `at0738-body-placement` for the list); this leg was the
 * tail of the turn leg (`at0738-body-turn`) and is its own launch so neither
 * is over budget. The app launches with bodies on; shared helpers live in
 * `session-body-fixture.ts`.
 *
 * **The sheets.** With the card key, the history and Changes sheets are
 * opened through the shell's menu path (`toggle-history-view`,
 * `toggle-changes-view`) and must stand in the body's own document, then
 * close the same way. A composite of each is kept for the look the clipping
 * question is deferred to.
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

import { describe, test } from "bun:test";
import { copyFileSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import type { BodyViewSnapshot } from "./_harness/client";
import { BODY_READY_MS, PLACED_MS, column, firstResponderJs, pollFor, spawnStub } from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!SHOULD_RUN)("at0738: a Session card's body", () => {
  test(
    "opens the history and Changes sheets in the body through the shell's menu path",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: "at0738-body-sheets",
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      const SHEETS = "at0738-sheets";
      try {
        await app.seedDeckState({ state: column([SHEETS]), focusCardId: SHEETS });
        const readyBody = (all: BodyViewSnapshot[]) =>
          all.some((b) => b.cardId === SHEETS && b.state === "ready" && b.visible);
        await spawnStub(app, SHEETS, stubDir);
        await pollFor(() => app.bodies(), readyBody, BODY_READY_MS);
        const body = app.body(SHEETS);
        await body.waitForCondition<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null`, {
          timeoutMs: BODY_READY_MS,
        });

        await app.dispatchControlAction("focus-session-card", { cardId: SHEETS });
        await pollFor(() => app.getFocusedCardId(), (id) => id === SHEETS, PLACED_MS);
        const sheets = [
          { action: "toggle-history-view", selector: '[data-slot="session-history-view"]', keep: "/tmp/at0738-history-sheet.png" },
          {
            action: "toggle-changes-view",
            selector: '.session-view-pane[data-view="changes"] [data-slot="tug-sheet"]',
            keep: "/tmp/at0738-changes-sheet.png",
          },
        ];
        for (const sheet of sheets) {
          await app.dispatchControlAction(sheet.action);
          try {
            await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(sheet.selector)}) !== null`, {
              timeoutMs: PLACED_MS,
            });
          } catch (error) {
            note(
              `${sheet.action} never stood: shell responder ${await app.evalJS<string | null>(firstResponderJs)}, ` +
                `body responder ${await body.evalJS<string | null>(firstResponderJs)}, ` +
                `body key card ${await body.evalJS<string | null>(`window.__tug.getKeyCardId()`)}`,
            );
            throw error;
          }
          await Bun.sleep(500);
          const capture = await app.captureWindow();
          copyFileSync(capture.path, sheet.keep);
          note(`${sheet.action}: composite kept at ${sheet.keep}`);
          await app.dispatchControlAction(sheet.action);
          await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(sheet.selector)}) === null`, {
            timeoutMs: PLACED_MS,
          });
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

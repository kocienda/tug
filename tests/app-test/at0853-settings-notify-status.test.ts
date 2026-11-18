/**
 * at0853-settings-notify-status.test.ts — Settings ▸ General ▸ Session
 * Notifications says what macOS will do with a notification ([AT0853]).
 *
 * Scenario:
 *
 *   Open the Settings card the way ⌘, does. With both "Post macOS
 *   notification" switches off there is no status line: a user who never
 *   turns one on is told nothing about macOS. Turn the first switch on with a
 *   trusted click. Then:
 *
 *   - the status line stands under the rows, which is the proof that the card
 *     page's `notifyCheck` reached the host and the host's `onNotifyStatus`
 *     came back to that page and not the shell;
 *   - it names one of the three actions, and its button carries that action's
 *     label, so the sentence and the button cannot disagree;
 *   - no test line stands, because no test was sent.
 *
 *   Turn the switch off again and the line is gone.
 *
 * Which of the three actions it names is the machine's to say — whether macOS
 * has been asked about the app-test bundle, and what the user answered — so
 * the test reads the pairing and not the verdict. An app-test instance only
 * ever reads macOS's settings: the host answers `authorize` and `test` as a
 * plain status read there, so turning the switch on raises no permission
 * prompt on the machine the suite runs on.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs without
 * `TUGAPP_APP_TEST=1` skip every test.
 *
 * @covers tugdeck/src/components/tugways/cards/settings-general-body.tsx
 * @covers tugdeck/src/lib/notify-status.ts
 * @covers tugapp/Sources/SessionNotifier.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type BodyApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const NO_AX = { skipAccessibilityPreflight: true } as const;

const SWITCH = '[data-testid="settings-notify-complete-notification"]';
const STATUS = '[data-testid="settings-notify-status"]';
const ACTION = '[data-testid="settings-notify-status-action"]';
const TEST_LINE = '[data-testid="settings-notify-test"]';

const LABELS: Record<string, string> = {
  authorize: "Ask Now",
  settings: "Open System Settings",
  test: "Send Test",
};

/**
 * Flip the switch with a trusted click at its centre and wait for `state`.
 * The group is the panel's last, so the switch is brought into view first and
 * its rect is read on a later turn, once the scroll has landed.
 */
async function flip(page: BodyApp, state: "checked" | "unchecked"): Promise<void> {
  await page.evalJS<null>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(SWITCH)});
       if (el !== null) el.scrollIntoView({ block: "center" });
       return null;
     })()`,
  );
  await page.waitForCondition<boolean>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(SWITCH)});
       if (el === null) return false;
       var box = el.getBoundingClientRect();
       return box.top >= 0 && box.bottom <= window.innerHeight;
     })()`,
    { timeoutMs: 5000 },
  );
  const point = JSON.parse(
    await page.evalJS<string>(
      `(function () {
         var el = document.querySelector(${JSON.stringify(SWITCH)});
         if (el === null) return "null";
         var box = el.getBoundingClientRect();
         return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
       })()`,
    ),
  ) as { x: number; y: number } | null;
  if (point === null) throw new Error("[at0853] the notification switch was not found");
  await page.nativeClick(point);
  try {
    await page.waitForCondition<boolean>(
      `document.querySelector(${JSON.stringify(SWITCH)}).getAttribute("data-state") === ${JSON.stringify(state)}`,
      { timeoutMs: 5000 },
    );
  } catch (error) {
    const where = await page.evalJS<string>(
      `(function () {
         var el = document.querySelector(${JSON.stringify(SWITCH)});
         var box = el.getBoundingClientRect();
         var hit = document.elementFromPoint(${point.x}, ${point.y});
         return JSON.stringify({
           clicked: [${point.x}, ${point.y}],
           box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
           viewport: [window.innerWidth, window.innerHeight],
           hit: hit === null ? null : hit.tagName + "." + hit.className,
           state: el.getAttribute("data-state"),
           disabled: el.disabled === true,
         });
       })()`,
    );
    throw new Error(`[at0853] the switch did not reach ${state}: ${where}`, { cause: error });
  }
}

describe.skipIf(!SHOULD_RUN)(
  "at0853: Settings ▸ General ▸ Session Notifications says what macOS will do",
  () => {
    test("a switch turned on raises the status line with its one action, and off takes it away", async () => {
      const app = await launchTugApp({ ...NO_AX, testName: "at0853-settings-notify-status" });
      try {
        await app.evalJS(`window.__tug.dispatchControlAction("show-card", { component: "settings" })`);
        const page = kindBody(app, "settings");
        await page.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(SWITCH)}) !== null`, {
          timeoutMs: 10000,
        });

        expect(
          await page.evalJS<string | null>(`document.querySelector(${JSON.stringify(SWITCH)}).getAttribute("data-state")`),
          "an unset notification switch is off",
        ).toBe("unchecked");
        expect(
          await page.evalJS<boolean>(`document.querySelector(${JSON.stringify(STATUS)}) === null`),
          "with both switches off there is no status line",
        ).toBe(true);

        await flip(page, "checked");
        await page.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(STATUS)}) !== null`, {
          timeoutMs: 8000,
        });
        const line = await page.evalJS<{ action: string | null; label: string | null; text: string; test: boolean }>(
          `(function () {
             var row = document.querySelector(${JSON.stringify(STATUS)});
             var button = document.querySelector(${JSON.stringify(ACTION)});
             return {
               action: row.getAttribute("data-notify-action"),
               label: button && button.textContent.trim(),
               text: row.firstElementChild.textContent.trim(),
               test: document.querySelector(${JSON.stringify(TEST_LINE)}) !== null,
             };
           })()`,
        );
        expect(Object.keys(LABELS), "the line names one of the three actions").toContain(line.action as string);
        expect(line.label, "and its button carries that action's label").toBe(LABELS[line.action as string]);
        expect(line.text.length, "beside a sentence saying what macOS will do").toBeGreaterThan(0);
        expect(line.test, "no test line stands before a test is sent").toBe(false);

        await flip(page, "unchecked");
        await page.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(STATUS)}) === null`, {
          timeoutMs: 5000,
        });
      } finally {
        await app.close();
      }
    });
  },
);

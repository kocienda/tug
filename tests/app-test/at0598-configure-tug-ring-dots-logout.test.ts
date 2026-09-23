/**
 * at0598-configure-tug-ring-dots-logout.test.ts — the on-demand ConfigureTug
 * wizard rings the button Return presses, keeps a waiting row's dot still, and
 * offers a way out of a login.
 *
 * Three shapes, all read off the real wizard opened through Tug ▸ Configure
 * Tug… on a set-up, logged-in machine:
 *   1. **One ring, on the row that wants the user.** The wizard names one
 *      Return home per render: the first `active`/`error` row's button wears
 *      the double ring (`data-default-ring`), and Done does not. On an
 *      on-demand visit the project-directory row reopens, so its Choose is
 *      the home.
 *   2. **The pulse means activity.** An `active` row is the user's turn, not
 *      work in flight, so its dot is `paused` — full, blue, and animating
 *      nothing.
 *   3. **Log Out… on the logged-in row.** A ghost button beside the green
 *      check raises TugLogout's "Log Out of Claude?" confirm over the still-open
 *      wizard. The test presses **Cancel** — never the confirm, which would log
 *      the test machine out — and the wizard is still there, still logged in.
 *
 * Reached through `dispatchControlAction("configure-tug")`, the exact action
 * the menu item posts, because the blocking wizard is suppressed under the
 * harness.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/configure-tug.tsx
 * @covers tugdeck/src/components/tugways/tug-step-row.tsx
 * @covers tugdeck/src/components/tugways/configure-tug-copy.ts
 * @covers tugdeck/src/lib/logout-store.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0598-configure-tug-ring-dots-logout";
const SETUP = '[data-slot="configure-tug"]';
const ACTIVE_ROW = `${SETUP} .configure-tug-step[data-status="active"]`;
const ACTIVE_DOT = `${ACTIVE_ROW} [data-state]`;
const SIGNIN_ROW = `${SETUP} .configure-tug-step[data-step="signin"]`;
const SIGNIN_BUTTON = `${SIGNIN_ROW} [data-slot="tug-push-button"]`;
const SETUP_DONE = `${SETUP} .tug-alert-actions [data-slot="tug-push-button"]`;
const ALERT = '[data-slot="tug-alert"]';
const ALERT_TITLE = `${ALERT} .tug-alert-title`;
const ALERT_CANCEL = `${ALERT} .tug-alert-actions [data-slot="tug-push-button"]`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 660 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["work"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

function text(selector: string): string {
  return `(function () {
    var node = document.querySelector(${JSON.stringify(selector)});
    return node === null ? "" : node.textContent;
  })()`;
}

function present(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)}) !== null`;
}

function attr(selector: string, name: string): string {
  return `(function () {
    var node = document.querySelector(${JSON.stringify(selector)});
    return node === null ? null : node.getAttribute(${JSON.stringify(name)});
  })()`;
}

describe.skipIf(!SHOULD_RUN)("AT0598: ConfigureTug's ring, dots, and Log Out…", () => {
  test(
    "rings the active row, keeps its dot still, and offers a cancellable logout",
    async () => {
      const app = await launchTugApp({ testName: "at0598-configure-tug-ring-dots-logout" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("configure-tug", {}), null)`,
        );
        await app.waitForCondition<boolean>(present(SETUP), { timeoutMs: 8000 });
        await app.waitForCondition<boolean>(present(ACTIVE_ROW), { timeoutMs: 8000 });
        await app.waitForCondition<boolean>(present(SETUP_DONE), { timeoutMs: 8000 });

        // 1. One ring, on the active row's button, and not on Done.
        await app.waitForCondition<boolean>(
          present(`${SETUP} [data-default-ring]`),
          { timeoutMs: 8000 },
        );
        const ringed = JSON.parse(
          await app.evalJS<string>(`JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
            `${SETUP} [data-default-ring]`,
          )})).map(function (n) {
            var row = n.closest(".configure-tug-step");
            return (row === null ? "done-button" : row.getAttribute("data-step")) + ":" + n.textContent;
          }))`),
        ) as string[];
        const activeStep = await app.evalJS<string | null>(attr(ACTIVE_ROW, "data-step"));
        note(`at0598 ringed: ${JSON.stringify(ringed)}; active row: ${activeStep}`);
        expect(ringed.length, "exactly one button wears the ring").toBe(1);
        expect(ringed[0].startsWith(`${activeStep}:`), "the active row's button wears it").toBe(true);
        expect(
          await app.evalJS<string | null>(attr(SETUP_DONE, "data-default-ring")),
          "Done does not wear the ring while a row wants the user",
        ).toBeNull();

        // 2. The active row's dot is still: paused, animating nothing.
        expect(
          await app.evalJS<string | null>(attr(ACTIVE_DOT, "data-state")),
          "the active row's dot is paused, not running",
        ).toBe("paused");
        const runningAnimations = await app.evalJS<number>(`(function () {
          var dot = document.querySelector(${JSON.stringify(ACTIVE_DOT)});
          var count = 0;
          [dot].concat(Array.from(dot.querySelectorAll("*"))).forEach(function (n) {
            count += n.getAnimations().filter(function (a) { return a.playState === "running"; }).length;
          });
          return count;
        })()`);
        expect(runningAnimations, "the active row's dot animates nothing").toBe(0);

        // 3. Log Out… raises the confirm over the wizard; Cancel returns to it.
        expect(
          await app.evalJS<string | null>(attr(SIGNIN_ROW, "data-status")),
          "this test needs a logged-in machine",
        ).toBe("done");
        expect((await app.evalJS<string>(text(SIGNIN_BUTTON))).trim()).toBe("Log Out…");
        await app.nativeClickAtElement(SIGNIN_BUTTON);
        await app.waitForCondition<boolean>(present(ALERT), { timeoutMs: 8000 });
        expect((await app.evalJS<string>(text(ALERT_TITLE))).trim()).toBe("Log Out of Claude?");
        expect(
          await app.evalJS<boolean>(present(SETUP)),
          "the confirm stacks over the wizard rather than replacing it",
        ).toBe(true);

        // Never press the confirm: guard the click on the button's own words.
        const cancelLabel = (await app.evalJS<string>(text(ALERT_CANCEL))).trim();
        if (cancelLabel !== "Cancel") {
          throw new Error(`refusing to click ${JSON.stringify(cancelLabel)} in the logout confirm`);
        }
        await app.nativeClickAtElement(ALERT_CANCEL);
        await app.waitForCondition<boolean>(`!(${present(ALERT)})`, { timeoutMs: 8000 });
        expect(await app.evalJS<boolean>(present(SETUP)), "Cancel returns to the wizard").toBe(true);
        expect(
          await app.evalJS<string | null>(attr(SIGNIN_ROW, "data-status")),
          "Cancel leaves the login alone",
        ).toBe("done");

        await app.nativeClickAtElement(SETUP_DONE);
        await app.waitForCondition<boolean>(`!(${present(SETUP)})`, { timeoutMs: 8000 });
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0598-configure-tug-ring-dots-logout] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

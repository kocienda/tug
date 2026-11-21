/**
 * at0866-logout-confirm-names-console-profile.test.ts — the signed-in row and
 * the "Log Out of Claude?" confirm name the login's source when a Console
 * profile is involved.
 *
 * Two fixture auth states, injected as `claude_auth_result` frames into the
 * overlay page after the real probe has landed:
 *   1. **A profile beneath the subscription.** The confirm says that logging
 *      out leaves Claude Code on the `ant` CLI's profile, and drops the
 *      promise of having to log in again, which would be false.
 *   2. **The profile is the login.** The row's label names the profile, its
 *      detail says it is not the subscription, and the row offers the `ant`
 *      CLI's own logout command rather than a Log Out… whose confirm would
 *      promise a logout Tug can't perform (that offer is at0867's subject).
 *
 * Every press of Log Out… is answered with **Cancel** — guarded on the
 * button's own words — so the test machine's real login is never touched.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/configure-tug-copy.ts
 * @covers tugdeck/src/components/tugways/configure-tug.tsx
 * @covers tugdeck/src/components/chrome/logout.tsx
 * @covers tugdeck/src/lib/auth-store.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0866-logout-confirm-names-console-profile";
const SETUP = '[data-slot="configure-tug"]';
const SIGNIN_ROW = `${SETUP} .configure-tug-step[data-step="signin"]`;
const SIGNIN_LABEL = `${SIGNIN_ROW} .tug-step-row-label`;
const SIGNIN_DETAIL = `${SIGNIN_ROW} .tug-step-row-detail`;
const SIGNIN_BUTTON = `${SIGNIN_ROW} [data-slot="tug-push-button"]`;
const SETUP_DONE = `${SETUP} .tug-alert-actions [data-slot="tug-push-button"]`;
const ALERT = '[data-slot="tug-alert"]';
const ALERT_MESSAGE = `${ALERT} .tug-alert-message`;
const ALERT_CANCEL = `${ALERT} .tug-alert-actions [data-slot="tug-push-button"]`;

const PROFILE = {
  name: "default",
  configDir: "/Users/user/.config/anthropic",
  authType: "user_oauth",
  organizationId: "org-1",
  workspaceId: "ws-1",
};

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

describe.skipIf(!SHOULD_RUN)("AT0866: the logout confirm names a Console profile", () => {
  test(
    "names a profile beneath the subscription, and a profile that is the login",
    async () => {
      const app = await launchTugApp({ testName: SID });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        const overlay = await overlayReady(app);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("configure-tug", {}), null)`,
        );
        await overlay.waitForCondition<boolean>(present(SETUP), { timeoutMs: 8000 });
        // Let the real probe land first, or it overwrites the injected frame.
        await overlay.waitForCondition<boolean>(
          `(function () {
            var row = document.querySelector(${JSON.stringify(SIGNIN_ROW)});
            return row !== null && row.getAttribute("data-status") === "done";
          })()`,
          { timeoutMs: 20_000 },
        );

        // Each page keeps its own `authStore`: the wizard's row reads the
        // overlay's, and the Logout orchestrator that composes the confirm
        // reads the deck page's. A real result reaches both, so the fixture
        // does too.
        const inject = async (payload: Record<string, unknown>) => {
          const frame = `(window.tugdeck.lab.dispatch("claude_auth_result", ${JSON.stringify({
            loggedIn: true,
            reason: null,
            ...payload,
          })}), null)`;
          await app.evalJS<null>(frame);
          await overlay.evalJS<null>(frame);
        };

        /** Press Log Out…, read the confirm's message, and Cancel it. */
        const confirmMessage = async (): Promise<string> => {
          await overlay.nativeClickAtElement(SIGNIN_BUTTON);
          await overlay.waitForCondition<boolean>(present(ALERT_MESSAGE), { timeoutMs: 8000 });
          const message = (await overlay.evalJS<string>(text(ALERT_MESSAGE))).trim();
          const cancelLabel = (await overlay.evalJS<string>(text(ALERT_CANCEL))).trim();
          if (cancelLabel !== "Cancel") {
            throw new Error(`refusing to click ${JSON.stringify(cancelLabel)} in the logout confirm`);
          }
          await overlay.nativeClickAtElement(ALERT_CANCEL);
          await overlay.waitForCondition<boolean>(`!(${present(ALERT)})`, { timeoutMs: 8000 });
          return message;
        };

        // 1. A subscription with a profile beneath it.
        await inject({
          email: "user@example.com",
          subscriptionType: "max",
          authMethod: "claude.ai",
          loginSource: "subscription",
          subscriptionStored: true,
          profile: PROFILE,
        });
        await overlay.waitForCondition<boolean>(
          `${text(SIGNIN_LABEL)} === "Logged in as user@example.com"`,
          { timeoutMs: 5000 },
        );
        const fallback = await confirmMessage();
        note(`at0866 fallback confirm: ${fallback}`);
        expect(fallback).toContain(`fall back to the ant CLI's "default" Console profile`);
        expect(fallback, "a logout that leaves a login does not promise a re-login").not.toContain(
          "log in again",
        );

        // 2. The profile is the login: no email, and no subscription.
        await inject({
          email: null,
          authMethod: "oauth_token",
          loginSource: "console_profile",
          subscriptionStored: false,
          profile: PROFILE,
        });
        await overlay.waitForCondition<boolean>(
          `${text(SIGNIN_LABEL)} === 'Logged in through the "default" Console profile'`,
          { timeoutMs: 5000 },
        );
        const detail = (await overlay.evalJS<string>(text(SIGNIN_DETAIL))).trim();
        note(`at0866 profile row detail: ${detail}`);
        expect(detail).toContain("This is not your Claude subscription");
        expect(detail).toContain(PROFILE.configDir);
        // Never pressed: the copy button writes the test machine's clipboard.
        expect((await overlay.evalJS<string>(text(SIGNIN_BUTTON))).trim()).toBe(
          "Copy Logout Command",
        );

        await overlay.nativeClickAtElement(SETUP_DONE);
        await overlay.waitForCondition<boolean>(`!(${present(SETUP)})`, { timeoutMs: 8000 });
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[${SID}] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

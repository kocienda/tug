/**
 * at0867-logout-per-source.test.ts — Log Out acts on the source it can clear,
 * and a logout that leaves a login behind says so.
 *
 * Three fixture auth states, injected as `claude_auth_result` frames into both
 * pages after the real probe has landed:
 *   1. **The login is a Console profile.** The signed-in row offers the `ant`
 *      CLI's own logout command to copy, not a Log Out that would run
 *      `claude auth logout` and change nothing, and its detail names the step.
 *   2. **The login is an API key in Claude Code's settings.** The row has no
 *      button at all, and its detail says where the key is set.
 *   3. **A logout left a profile in place.** A `claude_logout_result` that
 *      succeeded with `stillLoggedIn` raises an alert naming the profile and
 *      its step, rather than leaving the user in silence.
 *
 * No logout is ever run: the remaining-login report is driven by a fixture
 * result frame, the copy button is never pressed (it would write the test
 * machine's clipboard), and the one alert pressed is dismissed by a button
 * whose label is checked to be "OK" first.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/chrome/logout.tsx
 * @covers tugdeck/src/components/tugways/configure-tug.tsx
 * @covers tugdeck/src/components/tugways/configure-tug-copy.ts
 * @covers tugdeck/src/lib/auth-store.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0867-logout-per-source";
const SETUP = '[data-slot="configure-tug"]';
const SIGNIN_ROW = `${SETUP} .configure-tug-step[data-step="signin"]`;
const SIGNIN_LABEL = `${SIGNIN_ROW} .tug-step-row-label`;
const SIGNIN_DETAIL = `${SIGNIN_ROW} .tug-step-row-detail`;
const SIGNIN_BUTTON = `${SIGNIN_ROW} [data-slot="tug-push-button"]`;
const SETUP_DONE = `${SETUP} .tug-alert-actions [data-slot="tug-push-button"]`;
const ALERT = '[data-slot="tug-alert"]';
const ALERT_TITLE = `${ALERT} .tug-alert-title`;
const ALERT_MESSAGE = `${ALERT} .tug-alert-message`;
const ALERT_BUTTON = `${ALERT} .tug-alert-actions [data-slot="tug-push-button"]`;

const PROFILE = {
  name: "default",
  configDir: "/Users/user/.config/anthropic",
  authType: "user_oauth",
  organizationId: "org-1",
  workspaceId: "ws-1",
};

const PROFILE_LOGIN = {
  email: null,
  authMethod: "oauth_token",
  loginSource: "console_profile",
  subscriptionStored: false,
  profile: PROFILE,
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

describe.skipIf(!SHOULD_RUN)("AT0867: Log Out acts per source and reports what remains", () => {
  test(
    "offers the ant command, explains a settings key, and names a remaining profile",
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
        // overlay's, and the Logout orchestrator reads the deck page's.
        const dispatchBoth = async (action: string, payload: Record<string, unknown>) => {
          const frame = `(window.tugdeck.lab.dispatch(${JSON.stringify(action)}, ${JSON.stringify(payload)}), null)`;
          await app.evalJS<null>(frame);
          await overlay.evalJS<null>(frame);
        };
        const inject = (payload: Record<string, unknown>) =>
          dispatchBoth("claude_auth_result", { loggedIn: true, reason: null, ...payload });

        // 1. A Console profile: the row offers the ant CLI's command.
        await inject(PROFILE_LOGIN);
        await overlay.waitForCondition<boolean>(
          `${text(SIGNIN_LABEL)} === 'Logged in through the "default" Console profile'`,
          { timeoutMs: 5000 },
        );
        const profileButton = (await overlay.evalJS<string>(text(SIGNIN_BUTTON))).trim();
        const profileDetail = (await overlay.evalJS<string>(text(SIGNIN_DETAIL))).trim();
        note(`at0867 profile row: [${profileButton}] ${profileDetail}`);
        expect(profileButton, "a profile is not offered a logout Tug can't perform").toBe(
          "Copy Logout Command",
        );
        expect(profileDetail).toContain("To log out of it, run ant auth logout in a terminal.");

        // 2. An API key in Claude Code's settings: no button, and where it is set.
        await inject({
          email: null,
          authMethod: "api_key",
          apiKeySource: "ANTHROPIC_API_KEY",
          loginSource: "environment_key",
          subscriptionStored: false,
          profile: null,
        });
        await overlay.waitForCondition<boolean>(
          `${text(SIGNIN_LABEL)} === "Logged in with an API key"`,
          { timeoutMs: 5000 },
        );
        const keyDetail = (await overlay.evalJS<string>(text(SIGNIN_DETAIL))).trim();
        note(`at0867 key row: ${keyDetail}`);
        expect(await overlay.evalJS<boolean>(present(SIGNIN_BUTTON)), "a settings key has no Log Out").toBe(
          false,
        );
        expect(keyDetail).toContain(
          "remove ANTHROPIC_API_KEY from the env block of Claude Code's settings.json",
        );

        // 3. A logout that succeeded but left the profile in place. The state
        // the re-probe found lands first, then the result that names it.
        await inject(PROFILE_LOGIN);
        await dispatchBoth("claude_logout_result", { ok: true, error: null, stillLoggedIn: true });
        await overlay.waitForCondition<boolean>(present(ALERT_MESSAGE), { timeoutMs: 8000 });
        const title = (await overlay.evalJS<string>(text(ALERT_TITLE))).trim();
        const message = (await overlay.evalJS<string>(text(ALERT_MESSAGE))).trim();
        note(`at0867 remaining report: ${title} — ${message}`);
        expect(title).toBe("Still Logged In");
        expect(message).toContain(
          `Claude Code is still signed in through the ant CLI's "default" Console profile`,
        );
        expect(message).toContain("run ant auth logout in a terminal");
        const okLabel = (await overlay.evalJS<string>(text(ALERT_BUTTON))).trim();
        if (okLabel !== "OK") {
          throw new Error(`refusing to click ${JSON.stringify(okLabel)} in the report`);
        }
        await overlay.nativeClickAtElement(ALERT_BUTTON);
        await overlay.waitForCondition<boolean>(`!(${present(ALERT)})`, { timeoutMs: 8000 });

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

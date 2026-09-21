/**
 * at0440-configure-tug-version-row.test.ts — ConfigureTug's install row reports a
 * real Claude Code version, and offers the update only when it is genuinely
 * behind.
 *
 * The row used to say "Claude Code is ready." and stop there. It now carries
 * the whole life of the install: which version is on this machine, what the
 * stable channel is offering, and an Update button when the two differ. All of
 * that comes off the wire — `check_claude_version` → `claude_version_result`,
 * `claude --version` locally plus the release channel — so this drives the real
 * probe against the real `claude` on the machine running the test rather than
 * asserting a fixture.
 *
 * What is pinned:
 *   1. The row settles on a version line, not the version-less fallback: the
 *      probe answered and the deck rendered its answer.
 *   2. The row's two settled readings are consistent with their affordance —
 *      "up to date." shows the success check and NO Update button; "is
 *      available." shows the Update button and no check. Whichever the machine
 *      is in, the other is unreachable, so both branches are asserted against
 *      the reading the row actually took.
 *   3. The rest of the wizard reads in the current vocabulary — the project
 *      directory and session rows, whose copy is the same edit.
 *   4. A `claude_auth_result` carrying `loggedIn: null, reason: "probe_failed"`
 *      — the frame tugcast sends when the auth probe ran out its deadline —
 *      reaches the login row as the offline reading rather than as "logged
 *      out", the wizard stays dismissible, and the deck behind it takes a
 *      click. Whether that reading *releases* the wizard's claim on the app
 *      is a pure derivation, pinned in `configure-tug-copy.test.ts`; what
 *      this adds is that the wire carries it and the row says it.
 *
 * Reached through Tug ▸ Configure Tug… (`dispatchControlAction("configure-tug")`,
 * the exact action the menu item posts), because the blocking wizard is
 * suppressed under the harness — an on-demand open is the only way it appears.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/configure-tug.tsx
 * @covers tugdeck/src/components/tugways/configure-tug-copy.ts
 * @covers tugdeck/src/lib/claude-version-store.ts
 * @covers tugrust/crates/tugcast/src/feeds/claude_auth.rs
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { keyboardIsInCard } from "./_harness/selectors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0440-configure-tug-version-row";
const SETUP = '[data-slot="configure-tug"]';
const INSTALL_ROW = `${SETUP} .configure-tug-step[data-step="install"]`;
const INSTALL_DETAIL = `${INSTALL_ROW} .configure-tug-step-detail`;
const INSTALL_CTA = `${INSTALL_ROW} [data-slot="tug-push-button"]`;
const INSTALL_CHECK = `${INSTALL_ROW} .configure-tug-step-check`;
const STEP_LABEL = `${SETUP} .configure-tug-step-label`;
const SETUP_DONE = `${SETUP} .tug-alert-actions [data-slot="tug-push-button"]`;
const SIGNIN_ROW = `${SETUP} .configure-tug-step[data-step="signin"]`;
const SIGNIN_LABEL = `${SIGNIN_ROW} .configure-tug-step-label`;
const SIGNIN_DETAIL = `${SIGNIN_ROW} .configure-tug-step-detail`;
const SIGNIN_CTA = `${SIGNIN_ROW} [data-slot="tug-push-button"]`;

/** `Version 2.1.222`, `… — up to date.`, `… — 2.1.226 is available.` */
const VERSION_LINE = /^Version \d+\.\d+\.\d+/;

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

describe.skipIf(!SHOULD_RUN)("AT0440: the install row reports its version", () => {
  test(
    "settles on a real version, and offers Update only when behind",
    async () => {
      const app = await launchTugApp({ testName: "at0440-configure-tug-version-row" });
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

        // The version pair is a round trip — a local `claude --version` and a
        // network lookup — so the row starts on the version-less fallback and
        // settles when the frame lands. Waiting for the line IS the assertion
        // that the wire works end to end.
        await app.waitForCondition<boolean>(
          `/^Version \\d+\\.\\d+\\.\\d+/.test(${text(INSTALL_DETAIL)})`,
          { timeoutMs: 20_000 },
        );
        const detail = await app.evalJS<string>(text(INSTALL_DETAIL));
        note(`at0440 install row: ${JSON.stringify(detail)}`);
        expect(detail, "the install row names the installed version").toMatch(
          VERSION_LINE,
        );

        const cta = await app.evalJS<string>(text(INSTALL_CTA));
        const hasCheck = await app.evalJS<boolean>(present(INSTALL_CHECK));
        if (/is available\./.test(detail)) {
          // Behind the channel: the offer takes the success check's slot.
          expect(cta.trim(), "a behind row offers the update").toBe("Update");
          expect(hasCheck, "the offer replaces the check").toBe(false);
        } else {
          expect(detail, "a settled row is either current or behind").toMatch(
            /up to date\.$|^Version \d+\.\d+\.\d+$/,
          );
          expect(cta.trim(), "a current row has nothing to press").toBe("");
          expect(hasCheck, "a current row keeps its check").toBe(true);
        }

        // The rest of the wizard speaks the same vocabulary as this edit.
        const labels = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
              STEP_LABEL,
            )})).map(function (n) { return n.textContent; }))`,
          ),
        ) as string[];
        note(`at0440 steps: ${JSON.stringify(labels)}`);
        expect(
          labels.filter((label) => /projects folder|Claude Code session/i.test(label)),
          "retired wording is still on screen",
        ).toEqual([]);

        await app.waitForCondition<boolean>(present(SETUP_DONE), { timeoutMs: 8000 });
        await app.nativeClickAtElement(SETUP_DONE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SETUP)}) === null`,
          { timeoutMs: 8000 },
        );
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0440-configure-tug-version-row] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a probe that could not answer reads as unknown, and the wizard lets go",
    async () => {
      const app = await launchTugApp({ testName: "at0440-configure-tug-probe-failed" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: `${SID}-probe-failed` });

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("configure-tug", {}), null)`,
        );
        await app.waitForCondition<boolean>(present(SETUP), { timeoutMs: 8000 });
        // Wait for the REAL probe to answer before injecting, or the answer
        // lands afterwards and overwrites the injected frame — which is what
        // a first version of this waited into: any label satisfied it,
        // including the un-probed "Log in to Claude" the row starts on. The
        // settled logged-in label is the probe's own answer arriving, and
        // this machine's `claude` is logged in.
        await app.waitForCondition<boolean>(
          `/^Logged in/.test(${text(SIGNIN_LABEL)})`,
          { timeoutMs: 30_000 },
        );

        // The frame tugcast sends when `claude auth status` ran past
        // AUTH_PROBE_TIMEOUT, through the same dispatch a real frame takes.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("claude_auth_result", { loggedIn: null, reason: "probe_failed" }), null)`,
        );

        // Promptly, not after the probing deadline: `probe_failed` is an
        // answer, so the wizard must not go back to "Looking for Claude
        // Code…" on it. An earlier revision did exactly that for twelve
        // seconds, which is what this tight budget holds the line on.
        await app.waitForCondition<boolean>(
          `${text(SIGNIN_LABEL)}.indexOf("Can't check your login") !== -1`,
          { timeoutMs: 5000 },
        );
        const label = await app.evalJS<string>(text(SIGNIN_LABEL));
        const detail = await app.evalJS<string>(text(SIGNIN_DETAIL));
        const cta = await app.evalJS<string>(text(SIGNIN_CTA));
        note(`at0440 offline login row: ${JSON.stringify({ label, detail, cta })}`);

        // The claim Tug does not have must not be on screen.
        expect(label, "the row says what it does not know").toContain(
          "Can't check your login",
        );
        expect(
          `${label} ${detail}`.toLowerCase(),
          "an unanswered probe never reads as a signed-out user",
        ).not.toContain("logged out");
        // The button stays: it is the user's only retry when the network
        // comes back.
        expect(cta.trim().length, "the row keeps a button to press").toBeGreaterThan(0);

        // And the wizard is still the user's to close — an unanswered probe
        // takes nothing away.
        await app.waitForCondition<boolean>(present(SETUP_DONE), { timeoutMs: 8000 });
        await app.nativeClickAtElement(SETUP_DONE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SETUP)}) === null`,
          { timeoutMs: 8000 },
        );

        // The deck behind it is reachable, which is the whole point of
        // letting go: a user who cannot sign in can still read their work.
        //
        // The composer, not the bare card container: a click has to land on
        // something that takes it, and the card element is a region rather
        // than a control.
        const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
        await app.waitForCondition<boolean>(present(COMPOSER), { timeoutMs: 8000 });
        await app.nativeClickAtElement(COMPOSER);
        await app.waitForCondition<boolean>(keyboardIsInCard("A"), { timeoutMs: 8000 });
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0440-configure-tug-probe-failed] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

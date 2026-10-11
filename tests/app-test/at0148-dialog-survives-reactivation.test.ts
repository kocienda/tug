/**
 * at0148-dialog-survives-reactivation.test.ts — a pending card-modal dialog is
 * the card's focus destination across re-activation ([P20]/[P21], focus-language
 * Step 7.7).
 *
 * ## Why this exists
 *
 * The reported bug: a `PermissionDialog` is card-modal, but switching away from
 * the card (to another app) and back did NOT restore the focus scope — on return
 * the dialog was inert (its default ring gone, the trap not felt). The root cause
 * was a single deck-wide focus-mode stack + an activation-focus path that always
 * refocused the editor with no awareness of a pending dialog. Per-card focus
 * contexts ([P21]) make each card own its mode stack + key view, and the
 * activation channel adopts the key card and lands focus on its pushed
 * destination ([P20]) — so a pending dialog survives re-activation by
 * construction.
 *
 * This is the C boundary (switch away/back) in its RPC-drivable form: the
 * permission dialog is presented over the wire (no native input), and the
 * app-switch round-trip is driven by `simulateAppResign` /
 * `simulateAppBecomeActive` (the same window blur→focus path the bug was
 * reported against). Survival is asserted on the engine's projected DOM marks
 * (`data-key-view-kbd` on the seeded default, `data-focus-mode` for the trap,
 * `data-inline-dialog-pending` for the scrim) — set by the engine regardless of
 * real OS window-key state, so the assertion needs no native event.
 *
 * Like the rest of the focus suite this drives `simulateAppResign` /
 * `simulateAppBecomeActive`, which require the app to actually be the active
 * application — so it must run with the Tug window frontmost (a real display /
 * CI session), not headless-backgrounded. The on-open assertions validate the
 * per-card seed regardless; the round-trip is the survival regression.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/chrome/session-permission-dialog.tsx
 * @covers tugdeck/src/components/tugways/chrome/session-question-dialog.tsx
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/default-focus.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0148-session";
const FEED_CODE_OUTPUT = 0x40;
const REQUEST_ID = "at0148-perm-1";

const CARD = '[data-card-id="A"]';
const CARD_ROOT = `${CARD} [data-slot="session-card"]`;
const DIALOG = `${CARD} [data-slot="session-permission-dialog"]`;
const ALLOW = `${DIALOG} .tug-inline-dialog-actions .tug-button-primary-action`;

function controlRequestForward(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: REQUEST_ID,
    is_question: false,
    tool_name: "Bash",
    input: { command: "tokei" },
    permission_suggestions: [
      {
        behavior: "allow",
        destination: "project",
        type: "addRules",
        rules: [{ toolName: "Bash" }],
      },
    ],
  };
}

function hasAttr(app: App, selector: string, attr: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function(){var el=document.querySelector(${JSON.stringify(selector)});return el!==null && el.hasAttribute(${JSON.stringify(attr)});})()`,
  );
}

function exists(app: App, selector: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
  );
}

async function presentPermission(app: App): Promise<void> {
  await app.driveSession("A", { op: "send", text: "count lines with tokei" });
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: {
      type: "assistant_text",
      status: "partial",
      tug_session_id: SID,
      msg_id: "at0148-msg-1",
      text: "Running tokei…",
      is_partial: true,
      rev: 0,
      seq: 0,
    },
  });
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: controlRequestForward(),
  });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
    { timeoutMs: 6000 },
  );
}

/** The dialog is present, modal (trap mode), scrimmed, with Allow seeded+ringed. */
async function assertDialogModalSeeded(app: App, when: string): Promise<void> {
  expect(await exists(app, DIALOG), `${when}: dialog present`).toBe(true);
  expect(
    await hasAttr(app, CARD_ROOT, "data-inline-dialog-pending"),
    `${when}: card carries the scrim signal`,
  ).toBe(true);
  expect(
    await app.evalJS<boolean>(
      `document.documentElement.hasAttribute("data-focus-mode")`,
    ),
    `${when}: a trapped focus mode is current`,
  ).toBe(true);
  expect(
    await hasAttr(app, ALLOW, "data-key-view-kbd"),
    `${when}: Allow (the recommended default) holds the keyboard ring`,
  ).toBe(true);
}

describe.skipIf(!SHOULD_RUN)(
  "AT0148: a pending card-modal dialog survives re-activation ([P20]/[P21])",
  () => {
    test(
      "permission dialog stays modal + seeded across app resign → become-active",
      async () => {
        const app = await launchTugApp({
    // Foreground: drives a real app resign / hide / become-active cycle,
    // which only happens to an app that is actually active (pid-mode default
    // never activates).
    foreground: true,
          testName: "at0148-dialog-survives-reactivation",
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A", { tugSessionId: SID });
          await app.awaitEngineReady("A");

          await presentPermission(app);
          // On open the dialog is modal and Allow is seeded — the baseline the
          // round-trip must preserve.
          await app.waitForCondition<boolean>(
            `(function(){var el=document.querySelector(${JSON.stringify(ALLOW)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
            { timeoutMs: 4000 },
          );
          await assertDialogModalSeeded(app, "on open");

          // Switch to another app and back. The reported bug: on return the
          // dialog went inert. With per-card contexts the card's context still
          // owns the dialog's trap + seeded key view, and the activation channel
          // re-establishes it on become-active.
          await app.simulateAppResign();
          await app.simulateAppBecomeActive();
          await assertDialogModalSeeded(app, "after app resign → become-active");

          // A second round-trip is idempotent — the dialog is still the card's
          // destination, never the resting editor.
          await app.simulateAppResign();
          await app.simulateAppBecomeActive();
          await assertDialogModalSeeded(app, "after a second round-trip");
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(
              `\n[at0148-dialog-survives-reactivation] log tail:\n${tail}\n`,
            );
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

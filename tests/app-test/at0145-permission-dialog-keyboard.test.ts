/**
 * at0145-permission-dialog-keyboard.test.ts — the PermissionDialog is
 * **card-modal**: inline display, trapped focus, archetype-decomposed controls,
 * a scrimmed surround, and no wide-ring dead-zone ([P16]/[P17]/[P18]/[P19]).
 *
 * ## Why this exists
 *
 * The old dialog was a modal-for-keys trap that registered the whole dialog as
 * ONE full-width `tabIndex=0` item-container with a flat `[Deny, Allow,
 * …options]` cursor. That caused four defects: arrows wandered off both buttons,
 * the scope options weren't a reachable group, the buttons had no resting
 * recommended-default affordance, and a click on the full-width wrapper painted
 * a meaningless "wide ring." The redesign keeps the dialog inline + trapped but
 * decomposes its controls into focus-language archetypes and scrims the card
 * around it.
 *
 * The test seeds a pending Bash permission request carrying one allow-scoped
 * suggestion (so the scope choices render "Allow once" + "Allow for this
 * project"), then asserts the target behavior:
 *   - the dead-zone is gone (the old `session-permission-dialog-scope` wrapper does
 *     not exist);
 *   - the card root carries the `data-inline-dialog-pending` scrim signal;
 *   - on open the key view is seeded on Allow (the recommended default), so it
 *     reads filled+ring;
 *   - Tab moves the key view onto the scope group (a single radio item-group
 *     stop), and Allow's engine-owned persistent default ring lights while the
 *     keyboard is on that non-button stop;
 *   - arrows in the scope group move the ring WITHOUT committing, and **Space**
 *     commits the ringed scope ([P24], explicit commit — reverts the 7.7-era
 *     selection-follows-cursor);
 *   - the trap holds — Tab cycles Deny / Allow / scope group and never lands on
 *     the (deactivated) editor;
 *   - Escape denies and the dialog dismisses.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/chrome/session-permission-dialog.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/lib/permission-mode.ts
 * @covers tugdeck/src/components/tugways/tug-radio-group.css
 * @covers tugdeck/src/components/tugways/tug-radio-group.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0145-session";
const FEED_CODE_OUTPUT = 0x40;
const REQUEST_ID = "at0145-perm-1";

const CARD = '[data-card-id="A"]';
const CARD_ROOT = `${CARD} [data-slot="session-card"]`;
const DIALOG = `${CARD} [data-slot="session-permission-dialog"]`;
const ALLOW = `${DIALOG} .tug-inline-dialog-actions .tug-button-primary-action`;
const DENY = `${DIALOG} .tug-inline-dialog-actions .tug-button-outlined-danger`;
const SCOPE = `${DIALOG} [data-slot="tug-radio-group"]`;
// The checked radio row (a `TugRadioItem` only wraps its label in
// `.tug-radio-item-label` when it carries a description, so match the row itself
// and assert on its text).
const SCOPE_CHECKED = `${SCOPE} [data-slot="tug-radio-item"][data-state="checked"]`;
// The scope row currently wearing the movement cursor (the ring), checked or not.
const SCOPE_CURSOR = `${SCOPE} [data-slot="tug-radio-item"][data-key-cursor]`;
const OLD_DEADZONE = `${CARD} [data-slot="session-permission-dialog-scope"]`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

function controlRequestForward(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: REQUEST_ID,
    is_question: false,
    tool_name: "Bash",
    input: { command: "tokei" },
    // One allow-scoped suggestion → buildPermissionOptions yields
    // ["Allow once", "Allow for this project"].
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

function textOf(app: App, selector: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){var el=document.querySelector(${JSON.stringify(selector)});return el?el.textContent:null;})()`,
  );
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0145: PermissionDialog is card-modal", () => {
  test(
    "decomposed controls in a trap; seeded Allow; scope group; scrim; Escape denies",
    async () => {
      // Foreground: this suite gates on `document.hasFocus()`, which
      // WebKit ties to application activation.
      const app = await launchTugApp({ testName: "at0145-permission-dialog-keyboard", foreground: true });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // Drive a turn, start a live assistant turn (so the transcript has a
        // live cell to host the inline permission slot), then ingest the
        // permission request → pendingApproval.
        await app.driveSession("A", { op: "send", text: "count lines with tokei" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: FEED_CODE_OUTPUT,
          decoded: {
            type: "assistant_text",
            status: "partial",
            tug_session_id: SID,
            msg_id: "at0145-msg-1",
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
        await app.waitForCondition<boolean>(`document.hasFocus()`, { timeoutMs: 10000 });

        // (1) The wide-ring dead-zone is gone — no full-width focusable wrapper
        // ([P18]).
        expect(await exists(app, OLD_DEADZONE), "old scope dead-zone is gone").toBe(false);

        // (2) The card root carries the scrim signal ([P19]).
        expect(
          await hasAttr(app, CARD_ROOT, "data-inline-dialog-pending"),
          "card root carries the scrim signal while pending",
        ).toBe(true);

        // (3) On open the key view is seeded on Allow (the recommended default),
        // so Allow reads filled+ring ([P17]). Allow is a button, so the
        // engine-owned persistent ring stands down to the live key view.
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(ALLOW)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );
        expect(await exists(app, SCOPE), "scope choice group renders").toBe(true);

        // The ring must be VISIBLE on open — not just the attribute. The card's
        // `[data-cycling="false"]` suppression must NOT reach the card-modal
        // dialog (the bug: Allow rang only after the first Tab).
        const allowOutlineOpen = await app.evalJS<number>(
          `(function(){var el=document.querySelector(${JSON.stringify(ALLOW)});return el?parseFloat(getComputedStyle(el).outlineWidth)||0:0;})()`,
        );
        expect(allowOutlineOpen, "Allow shows a visible ring on open").toBeGreaterThan(0);

        // (3b) Spatial arrow navigation ([P22] / [P23], the declared order): the ring
        // is seeded on Allow. **Left** moves it to Deny (the reported case); **Right**
        // wraps back to Allow (closed button ring); **Down** crosses the seam into the
        // scope group; **Up** returns to Allow. Arrows move the ring only — they never
        // commit (the checked scope is asserted unchanged in (5)). Ends on Allow so the
        // Tab assertions below still hold (seed = Allow).
        await app.nativeKey("ArrowLeft");
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(DENY)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );
        expect(await hasAttr(app, DENY, "data-key-view-kbd"), "Left from Allow rings Deny").toBe(true);
        await app.nativeKey("ArrowRight");
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(ALLOW)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );
        expect(await hasAttr(app, ALLOW, "data-key-view-kbd"), "Right wraps back to Allow").toBe(true);
        await app.nativeKey("ArrowDown");
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(SCOPE)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );
        expect(await hasAttr(app, SCOPE, "data-key-view-kbd"), "Down crosses the seam into the scope group").toBe(true);
        await app.nativeKey("ArrowUp");
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(ALLOW)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );
        expect(await hasAttr(app, ALLOW, "data-key-view-kbd"), "Up from the scope group returns to Allow").toBe(true);

        // (3c) Liveliness ([P23]): no arrow ever dead-ends or beeps. From Deny, Up
        // loops into the scope group (nothing sits above the button row); Up from the
        // top of the group returns to Allow. (Ends on Allow so the Tab assertions
        // below still hold.)
        await app.nativeKey("ArrowLeft"); // Allow → Deny (button ring)
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(DENY)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );
        await app.nativeKey("ArrowUp"); // Deny → scope group (loops up into it)
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(SCOPE)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );
        expect(await hasAttr(app, SCOPE, "data-key-view-kbd"), "Up from Deny loops into the scope group (no beep)").toBe(true);
        await app.nativeKey("ArrowUp"); // scope top → Allow
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(ALLOW)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );

        // (4) Tab order is Allow → Deny → scope group. The seed is Allow, so the
        // first Tab lands on Deny.
        await app.nativeKey("Tab");
        await sleep(150);
        expect(await hasAttr(app, DENY, "data-key-view-kbd"), "first Tab goes Allow → Deny").toBe(true);

        // Next Tab(s) → the scope group (a standard TugRadioGroup, one item-group
        // stop). With the keyboard on a non-button, Allow's engine-owned
        // persistent default ring lights ("Return's home").
        let onScope = false;
        for (let i = 0; i < 4 && !onScope; i += 1) {
          await app.nativeKey("Tab");
          await sleep(150);
          onScope = await hasAttr(app, SCOPE, "data-key-view-kbd");
        }
        expect(onScope, "Tab lands the key view on the scope radio group").toBe(true);
        expect(
          await hasAttr(app, ALLOW, "data-default-ring"),
          "Allow shows its persistent default ring while the keyboard is on the scope group",
        ).toBe(true);

        // (5) Explicit commit ([P24]): the scope group opens checked on "Allow
        // once". ArrowDown moves the cursor/ring onto "Allow for this project" but
        // does NOT commit — the checked row stays "Allow once". **Space** then
        // commits the ringed row. The group never consumes Enter — Return falls
        // through to the ringed Allow.
        expect(
          (await textOf(app, SCOPE_CHECKED)) ?? "",
          "scope group opens checked on Allow once",
        ).toContain("Allow once");
        await app.nativeKey("ArrowDown");
        await sleep(150);
        expect(
          (await textOf(app, SCOPE_CURSOR)) ?? "",
          "ArrowDown rings the next scope",
        ).toContain("Allow for this project");
        expect(
          (await textOf(app, SCOPE_CHECKED)) ?? "",
          "ArrowDown does NOT commit — the checked row is unchanged ([P24])",
        ).toContain("Allow once");
        await app.nativeKey(" ");
        await sleep(150);
        expect(
          (await textOf(app, SCOPE_CHECKED)) ?? "",
          "Space commits the ringed scope",
        ).toContain("Allow for this project");

        // (6) The trap holds: keep Tabbing and the key view never lands on the
        // editor — it cycles Deny / Allow / scope group only.
        let editorReached = false;
        for (let i = 0; i < 5; i += 1) {
          await app.nativeKey("Tab");
          await sleep(120);
          if (await hasAttr(app, EDITOR, "data-key-view-kbd")) {
            editorReached = true;
            break;
          }
        }
        expect(editorReached, "Tab never escapes the trap to the editor").toBe(false);

        // (7) Escape denies and the dialog dismisses (Escape / Cmd-. → Deny via
        // the scope's CANCEL_DIALOG responder).
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) === null`,
          { timeoutMs: 4000 },
        );
        expect(await exists(app, DIALOG), "Escape dismisses the dialog (Deny)").toBe(false);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0145-permission-dialog-keyboard] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

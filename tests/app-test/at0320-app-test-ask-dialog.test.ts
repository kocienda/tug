/**
 * at0320-app-test-ask-dialog.test.ts — a question raised from outside the turn
 * stream reaches the Session card, and the answer reaches the blocked caller.
 *
 * ## Why this exists
 *
 * `tugtool host ask` exists so a command-line tool can get the developer's
 * consent before doing something they will feel — an app-test run that seizes
 * the screen being the case it was built for. The whole value is in the round
 * trip: a real process blocks, a real dialog appears in the real app, a real
 * click releases it. Each half is unit-tested on its own side (`/api/ask`
 * against a live socket in `server.rs`, the store's routing in
 * `pending-ask-store.test.ts`), but only this test proves they meet.
 *
 * The properties under test:
 *   - the question reaches the focused session's card with no `sessionId`
 *     given, which is the terminal case;
 *   - a question with three or more options renders as the radio stack: the
 *     caller's text renders, and the app's own statement of where the question
 *     came from is the dialog root's accessible description, so a question
 *     arriving over loopback cannot pose as an app prompt;
 *   - that shape is answerable from the keyboard: the ring seeds on Continue,
 *     arrows cross into the options and move the selection, and Return commits;
 *   - answering it releases the caller with the chosen option's value;
 *   - the session reads **Awaiting** in Z2 while the question is up, the same
 *     as the permission and question dialogs — a dialog holding the user's
 *     answer says so, whichever of the three it is;
 *   - but Z5 is untouched — Awaiting here is a reading, not a turn phase, so a
 *     session with no turn must not end up showing a Stop button with nothing
 *     to stop;
 *   - a **two-option** question is a different shape entirely: a pair of
 *     buttons on the header row, no radio stack, and the caller's description
 *     dropped even though they sent one — the slimness is the component's as
 *     much as the caller's;
 *   - a question carrying `--unattended` answers itself, and says so without a
 *     sentence: the countdown is a rule whose `data-remaining` and progressbar
 *     value carry the seconds, the rule lies on the frame's own bottom edge
 *     rather than beside it, the ring rests on the option the count will
 *     commit, and an untouched dialog releases the caller with that value.
 *     This is the difference between a prompt that asks permission and one
 *     that offers a chance to intervene — the second must never park a run
 *     because nobody was at the keyboard;
 *   - the entry pane stands down while the dialog is up. This is the one that
 *     bites: `TugTextEditor`'s Return defers to the pane's default button,
 *     which while this dialog is up is one of its own. If the composer stayed
 *     live, a Return meant for a prompt would answer a question the developer
 *     was not looking at.
 *
 * This test runs in the background like everything else — it takes no screen,
 * so it carries no `@foreground`.
 *
 * @covers tugdeck/src/lib/pending-ask-store.ts
 * @covers tugdeck/src/components/tugways/chrome/session-app-test-ask-dialog.tsx
 * @covers tugdeck/src/components/tugways/chrome/session-app-test-ask-dialog.css
 * @covers tugdeck/src/lib/code-session-store/lifecycle-state.ts
 * @covers tugdeck/src/lib/code-session-store/session-phase-visual.ts
 * @covers tugrust/crates/tugcast/src/server.rs
 * @covers tugrust/crates/tugtool/src/commands/ask.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0320-session";
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TUGTOOL = resolve(REPO_ROOT, "tugrust/target/debug/tugtool");

const DIALOG = '[data-slot="session-app-test-ask-dialog"]';
const OPTION_GROUP = `${DIALOG} [data-slot="tug-radio-group"]`;
const OPTION_ITEMS = `${DIALOG} [data-slot="tug-radio-item"]`;
// The frame's trailing cluster. In the radio shape it holds one button —
// Continue — and in the button shape it holds the pair that IS the question.
const ACTIONS = `${DIALOG} [data-slot="tug-inline-dialog-actions"] button`;
const COUNTDOWN = `${DIALOG} [data-slot="session-app-test-ask-dialog-countdown"]`;

/** Whether the element matched by `selector` carries `attr`. */
function hasAttr(app: App, selector: string, attr: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
      `return el!==null && el.hasAttribute(${JSON.stringify(attr)});})()`,
  );
}

/**
 * Z2 — the status row's STATE-cell value text. Same selector `at0084` reads
 * for the lifecycle matrix, so the two tests agree on what the cell is.
 */
function stateCellLabel(app: App, cardId: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){
      var cell = document.querySelector(
        '[data-card-id="${cardId}"] [data-priority="state"] .session-telemetry-status-value');
      return cell ? cell.textContent : null;
    })()`,
  );
}

/** Wait for `selector` to carry `attr`, then assert it does. */
async function expectRing(app: App, selector: string, attr: string): Promise<boolean> {
  try {
    await app.waitForCondition<boolean>(
      `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
        `return el!==null && el.hasAttribute(${JSON.stringify(attr)});})()`,
      { timeoutMs: 4000 },
    );
  } catch {
    // Fall through to the assertion so the failure names the selector.
  }
  return hasAttr(app, selector, attr);
}

/** The `value` of the currently checked option. */
function checkedOption(app: App): Promise<string | null> {
  return app.evalJS<string | null>(`(function(){
    var items = Array.prototype.slice.call(
      document.querySelectorAll(${JSON.stringify(OPTION_ITEMS)}));
    var on = items.filter(function (el) {
      return el.getAttribute("aria-checked") === "true";
    });
    return on.length === 1 ? (on[0].textContent || "") : null;
  })()`);
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

/**
 * Start `tugtool host ask` without waiting for it. The process blocks until the
 * dialog is answered, which is the whole point — awaiting it here would
 * deadlock the test against itself.
 */
function startAsk(instanceId: string) {
  return Bun.spawn(
    [
      TUGTOOL,
      "host",
      "ask",
      "--instance",
      instanceId,
      "--title",
      "2 of 5 app-tests will take over the screen",
      "--description",
      "at0145-permission-dialog-keyboard, at0165-activation-first-responder",
      "--option",
      "run-all:Run all 5:Includes the 2 that take the screen",
      "--option",
      "background:Run the 3 background tests:Skips the 2 that take the screen",
      "--option",
      "cancel:Cancel:Run nothing",
      "--timeout-secs",
      "60",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      cwd: REPO_ROOT,
      // How the real caller runs: the session id comes from the environment
      // the Session card's shell already exports.
      env: { ...process.env, TUG_SESSION_ID: SID },
    },
  );
}

/**
 * The same question, but as a chance to intervene rather than a request for
 * permission: `--unattended` names the answer silence means, and the dialog
 * counts `--timeout-secs` down to it.
 */
function startCountdownAsk(instanceId: string, secs: number) {
  return Bun.spawn(
    [
      TUGTOOL,
      "host",
      "ask",
      "--instance",
      instanceId,
      "--title",
      "1 app-test wants to take over the screen",
      "--description",
      "at0349-stack-picker-foreground",
      "--option",
      "run-all:Run them:The other 2 are running now either way",
      "--option",
      "background:Skip them:Keeps the screen yours",
      "--timeout-secs",
      String(secs),
      "--unattended",
      "run-all",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      cwd: REPO_ROOT,
      env: { ...process.env, TUG_SESSION_ID: SID },
    },
  );
}

describe.skipIf(!SHOULD_RUN)("at0320 — ask dialog round trip", () => {
  let app: App;

  beforeAll(async () => {
    app = await launchTugApp();
    await app.enableDeckTrace(true);
    await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    );
    await app.bindSession("A", { tugSessionId: SID });
    await app.awaitEngineReady("A");
  });

  afterAll(async () => {
    await app?.close();
  });

  test(
    "a question reaches the card, and the answer reaches the caller",
    async () => {
      const proc = startAsk(app.instanceId);

      // --- it arrives -------------------------------------------------
      try {
        await app.waitForCondition<boolean>(
          `!!document.querySelector('${DIALOG}')`,
          { timeoutMs: 15_000 },
        );
      } catch (error) {
        // The CLI's own diagnostics say far more about why a question never
        // landed than "the selector never matched" does.
        proc.kill();
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`dialog never appeared; tugtool host ask said: ${stderr}`, {
          cause: error,
        });
      }

      const rendered = await app.evalJS<{
        title: string;
        provenance: string;
        detail: string;
        options: string[];
      }>(`(() => {
        const root = document.querySelector('${DIALOG}');
        const opts = [...root.querySelectorAll('[data-slot="tug-radio-item"]')];
        return {
          title: root.querySelector('.tug-inline-dialog-title')?.textContent ?? '',
          provenance: root.getAttribute('aria-description') ?? '',
          detail: root.querySelector('.tug-inline-dialog-description')?.textContent ?? '',
          options: opts.map((b) => b.textContent ?? ''),
        };
      })()`);

      expect(
        rendered.title,
        "ARRIVES: the caller's title is the dialog's title",
      ).toContain("2 of 5 app-tests");
      expect(
        rendered.detail,
        "ARRIVES: the caller's detail text renders",
      ).toContain("at0145-permission-dialog-keyboard");
      // The impersonation guard. It never rested on a rendered line — it rests
      // on the frame, the app's own caution-tinted icon, and the title being a
      // plain string from the wire. What the line said is now the dialog
      // root's accessible description, where it costs no height and a screen
      // reader still gets it.
      expect(
        rendered.provenance,
        "PROVENANCE: the dialog's accessible description names the question's origin",
      ).toContain("command on this machine");
      expect(rendered.options, "ARRIVES: all three choices render").toHaveLength(3);

      // --- the session reads Awaiting ---------------------------------
      // Every dialog that holds the user's answer says so in Z2, and this one
      // is no exception: a question on screen IS the session awaiting input.
      // The permission and question dialogs reach this cell through the
      // reducer's `phase`; this one has no turn to put a phase on, so it
      // reaches the same cell through `sessionSessionPhaseKey`'s own
      // `pendingAsk` axis.
      expect(
        await stateCellLabel(app, "A"),
        "AWAITING: the Z2 STATE cell reads Awaiting while the question is up",
      ).toBe("Awaiting");

      // --- without masquerading as a turn -----------------------------
      // The other half of that. Awaiting is a *reading*, not a phase change:
      // routing the ask through `awaiting_approval` proper — the obvious way to
      // reuse the existing plumbing — would flip Z5 to the disabled
      // `awaiting-user` button on a session with no turn running at all,
      // leaving a dead composer and a Stop button with nothing to stop. So Z2
      // says Awaiting and Z5 stays exactly where the real turn state left it.
      const submitMode = await app.evalJS<string | null>(
        `(function(){
          var el = document.querySelector(
            '[data-card-id="A"] .tug-prompt-entry-submit-button');
          return el === null ? null : el.getAttribute("data-mode");
        })()`,
      );
      expect(
        submitMode,
        "AWAITING: Z5 stays an enabled Submit — the reading is not a turn phase",
      ).toBe("submit");

      // --- but it IS modal for keys -----------------------------------
      // The other half of the same coin. Z5's *mode* is untouched, and the
      // entry pane still stands down — because `TugTextEditor` defers Return to
      // the pane's default button, which is this dialog's Continue. A live
      // composer here would mean a Return meant for a prompt silently answers
      // the question with whatever is preselected.
      expect(
        await hasAttr(app, '[data-card-id="A"] .session-card', "data-inline-dialog-pending"),
        "MODAL: the card is card-modal while the question is up",
      ).toBe(true);
      const entryInert = await app.evalJS<boolean>(`(function(){
        var el = document.querySelector('[data-card-id="A"] .session-card-entry-pane');
        return el !== null && getComputedStyle(el).pointerEvents === "none";
      })()`);
      expect(
        entryInert,
        "MODAL: the entry pane is inert, so Return cannot reach the composer",
      ).toBe(true);

      // --- and it is answerable from the keyboard ---------------------
      // The safe option is preselected and the ring seeds on Continue, so the
      // routine answer is one keystroke and a reflexive Return declines.
      expect(
        await checkedOption(app),
        "SAFE DEFAULT: the declining option (last) starts checked",
      ).toContain("Cancel");
      expect(
        await expectRing(app, ACTIONS, "data-key-view-kbd"),
        "SEED: the ring opens on Continue, so Return commits",
      ).toBe(true);

      // Down crosses the seam into the options; Up returns. Neither commits.
      await app.nativeKey("ArrowDown");
      expect(
        await expectRing(app, OPTION_GROUP, "data-key-view-kbd"),
        "ARROWS: Down crosses from Continue into the option group",
      ).toBe(true);

      // Inside the group the cursor moves and Space checks the cursor row —
      // a bog-standard TugRadioGroup. Walk up to "Run the 3 background tests".
      await app.nativeKey("ArrowUp");
      // Space, spelled as the character — `VirtualKeyMap` has no "Space" name.
      await app.nativeKey(" ");
      await app.waitForCondition<boolean>(
        `(function(){
          var items = Array.prototype.slice.call(
            document.querySelectorAll(${JSON.stringify(OPTION_ITEMS)}));
          return items.some(function (el) {
            return el.getAttribute("aria-checked") === "true"
              && (el.textContent || "").indexOf("background") >= 0;
          });
        })()`,
        { timeoutMs: 4000 },
      );
      expect(
        await checkedOption(app),
        "ARROWS: the cursor moved and Space checked the row under it",
      ).toContain("Run the 3 background tests");

      // --- answering it releases the caller ---------------------------
      // Return, from the option group — the persistent default ring means
      // Return is Continue's wherever the keyboard rests inside the dialog.
      await app.nativeKey("Return");

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      expect(proc.exitCode, "RELEASED: the caller exits 0").toBe(0);
      expect(
        stdout.trim(),
        "RELEASED: stdout carries exactly the chosen option's value",
      ).toBe("background");

      // --- and the dialog goes away -----------------------------------
      await app.waitForCondition<boolean>(
        `!document.querySelector('${DIALOG}')`,
        { timeoutMs: 5_000 },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a two-option countdown question is a button pair, and answers itself",
    async () => {
      const proc = startCountdownAsk(app.instanceId, 3);

      try {
        await app.waitForCondition<boolean>(
          `!!document.querySelector('${COUNTDOWN}')`,
          { timeoutMs: 15_000 },
        );
      } catch (error) {
        proc.kill();
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`countdown never appeared; tugtool host ask said: ${stderr}`, {
          cause: error,
        });
      }

      // Two options is a pair of buttons on the header row and nothing else.
      // The caller sent a `--description` and a description on each option;
      // none of it renders, which is the point — the slimness is the
      // component's doing as much as the caller's.
      const shape = await app.evalJS<{
        buttons: Array<{ label: string; ring: boolean }>;
        radioItems: number;
        description: number;
      }>(`(() => {
        const root = document.querySelector('${DIALOG}');
        const btns = [...root.querySelectorAll('[data-slot="tug-inline-dialog-actions"] button')];
        return {
          buttons: btns.map((b) => ({
            label: b.textContent ?? '',
            ring: b.hasAttribute("data-key-view-kbd"),
          })),
          radioItems: root.querySelectorAll('[data-slot="tug-radio-item"]').length,
          description: root.querySelectorAll('.tug-inline-dialog-description').length,
        };
      })()`);

      expect(
        shape.buttons.length,
        "BUTTONS: a two-option question is a pair of buttons",
      ).toBe(2);
      // Declining first, affirming second — the caller orders the declining
      // option last, and the row reverses that so the primary sits outermost.
      expect(
        shape.buttons[0].label,
        "BUTTONS: the declining option leads the pair",
      ).toContain("Skip them");
      expect(
        shape.buttons[1].label,
        "BUTTONS: the affirming option is the trailing, primary one",
      ).toContain("Run them");
      expect(
        shape.radioItems,
        "BUTTONS: no radio stack — the buttons ARE the question",
      ).toBe(0);
      expect(
        shape.description,
        "BUTTONS: the caller's description does not render in this shape",
      ).toBe(0);

      // No resting lie: with no selection to move, what the count will commit
      // is what the ring rests on — the caller's `--unattended`, not the
      // declining option this dialog otherwise opens on.
      expect(
        shape.buttons[1].ring,
        "COUNTDOWN: the ring rests on the option the count will commit",
      ).toBe(true);
      expect(
        shape.buttons[0].ring,
        "COUNTDOWN: and on nothing else",
      ).toBe(false);

      // The number left the screen; it must not have left the DOM. The rule's
      // width is what a reader sees, and `at0320` has no business asserting on
      // a CSS width — so the same tick writes the seconds where both a test
      // and the accessibility tree can read them.
      const count = await app.evalJS<{
        role: string | null;
        max: string | null;
        remaining: string | null;
      }>(`(() => {
        const el = document.querySelector('${COUNTDOWN}');
        return {
          role: el.getAttribute('role'),
          max: el.getAttribute('aria-valuemax'),
          remaining: el.getAttribute('data-remaining'),
        };
      })()`);
      expect(count.role, "COUNTDOWN: the rule reads as a progressbar").toBe("progressbar");
      expect(count.max, "COUNTDOWN: its maximum is the caller's duration").toBe("3");
      expect(
        count.remaining,
        "COUNTDOWN: the seconds are on `data-remaining`, not in a sentence",
      ).toMatch(/^[0-3]$/);

      // And it is the frame's bottom edge, not a bar floating near it. The
      // frame is centered inside its own max width and carries a margin, so a
      // rule positioned against the dialog root instead spans the whole pane
      // and sits below the frame entirely — visible, wrong, and invisible to
      // every assertion above.
      const edge = await app.evalJS<{ dx: number; dy: number; dw: number }>(
        `(() => {
          const frame = document.querySelector('${DIALOG} [data-slot="tug-inline-dialog"]');
          const rule = document.querySelector('${COUNTDOWN}');
          const f = frame.getBoundingClientRect();
          const r = rule.getBoundingClientRect();
          return { dx: r.left - f.left, dy: f.bottom - r.bottom, dw: f.width - r.width };
        })()`,
      );
      expect(
        Math.abs(edge.dy) <= 2,
        `PLACEMENT: the rule sits on the frame's bottom edge (off by ${edge.dy}px)`,
      ).toBe(true);
      expect(
        Math.abs(edge.dx) <= 2 && Math.abs(edge.dw) <= 4,
        `PLACEMENT: and spans the frame, not the pane (left off by ${edge.dx}px, ` +
          `${edge.dw}px narrower)`,
      ).toBe(true);

      // Nobody touches anything. The dialog commits, the caller is released,
      // and the answer is the one silence was declared to mean — the point of
      // the whole change: a developer who stepped away no longer parks the run.
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.exitCode, "COUNTDOWN: an unanswered question exits 0").toBe(0);
      expect(
        stdout.trim(),
        "COUNTDOWN: silence answers with the caller's unattended choice",
      ).toBe("run-all");

      await app.waitForCondition<boolean>(
        `!document.querySelector('${DIALOG}')`,
        { timeoutMs: 5_000 },
      );
    },
    TEST_TIMEOUT_MS,
  );
});

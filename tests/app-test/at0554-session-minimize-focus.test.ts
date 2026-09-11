/**
 * at0554-session-minimize-focus.test.ts — the keyboard in the minimized form.
 *
 * ## What this gates
 *
 * A minimized Session card folds away everything the keyboard used to live in:
 * the transcript, the find bar and the composer are all `inert` while the form
 * is worn ([P03]), and the browser strips focus from anything inside an inert
 * subtree. So the fold is a focus event as much as a geometry one — without a
 * destination of its own the card would come out reachable and unfocused, the
 * caretless-void failure Risk R01 names. [P08] gives it one: the minimize
 * control at Z2's trailing edge is the minimized card's key view AND its
 * Return-home.
 *
 * The control stands in BOTH forms now ([B03]) — the Show Transcript bar it
 * replaced existed only while minimized — so what the fold changes is which
 * verb the one seat wears and whether it carries the scope's default ring,
 * not whether it is in the DOM. Every "the bar has gone" reading below is
 * therefore a reading of the FLAG and of the control's own label instead.
 *
 * Two tests, because the mouse path and the keyboard path prove different
 * halves and mixing them would prove neither.
 *
 *   1. **The caret round-trip.** With a live caret in the composer, minimizing
 *      moves the card's key view to the bar and leaves the folded editor
 *      holding no keyboard position at all; showing the transcript again lands
 *      the caret back in the composer. Nothing here presses ⌥⇥, because the
 *      whole point is the path a person takes with the mouse.
 *   2. **The walk.** ⌥⇥ engages keyboard-focus mode and lights the control
 *      exactly where the fold already put it — one placement, not two. Tab
 *      from there reaches the STATE cell (the control's order, 18, is the last
 *      live stop, so Tab wraps to the first Z2 cell at 13), ⇧⇥ comes back,
 *      and Return on the control shows the transcript.
 *
 * The RING is deliberately read as the key view's own (`data-key-view-kbd`)
 * rather than as `data-default-ring`. `persistentDefaultRing` does two things,
 * and only one of them is visible here: it registers the bar as the scope's
 * default button — the substantive half, and what makes Return mean Show
 * Transcript — and it lights a ring while the keyboard rests on a NON-button
 * stop. In the minimized form there is no such stop: the only other live stops
 * are the Z2 cells, which are buttons and wear the mark themselves. So the
 * engine's one-mark-per-scope rule is what these tests read, and the count is
 * one either way.
 *
 * The `@covers` lines name the bar and the focus engine, not
 * `session-card.tsx` — the card stands at the selection budget's recorded
 * ceiling (at0522 took the last slot), and its half of this behavior is the
 * reclaim gate, which no other file can be broken without breaking the bar's
 * ring too. A declaration is a claim about what a test would CATCH first
 * rather than about every file it reaches.
 *
 * @covers tugdeck/src/components/tugways/cards/session-minimize-control.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0554-session";
const PANE_ID = "p1";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const STATUS_BAR = `${CARD} [data-slot="session-card-status-bar"]`;
const BAR_ROOT = `${STATUS_BAR} [data-slot="session-minimize-control"]`;
const BAR = `${BAR_ROOT} button`;
/**
 * The seat turned back over to the open card's verb. It is what "the bar has
 * gone" used to mean: the control stands in both forms, so what a show
 * changes is the label rather than the node ([B03]).
 */
const CONTROL_READS_MINIMIZE = `(function () {
  var el = document.querySelector(${JSON.stringify(BAR)});
  return el !== null && el.getAttribute("aria-label") === "Minimize";
})()`;
const STATE_CELL = `${STATUS_BAR} [data-slot="tug-status-cell"]`;
const JOBS_CELL = `${STATUS_BAR} [data-slot="tug-status-cell"][data-priority="jobs"]`;
const DIALOG = `${CARD} [data-slot="session-permission-dialog"]`;
const ALLOW = `${DIALOG} .tug-inline-dialog-actions .tug-button-primary-action`;

/** The feed a session's code output arrives on. */
const FEED_CODE_OUTPUT = 0x40;

/** One Session card, wide enough that nothing is folded by geometry. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: PANE_ID,
    hasFocus: true,
  };
}

/**
 * The card's keyboard, read off the DOM rather than off the engine: what wears
 * the key-view ring, what wears the Return mark, and how many of each the card
 * holds. The counts are the invariant — one lit control, whichever mark it is.
 */
async function keyboardMarks(app: App): Promise<{
  keyView: string | null;
  defaultRing: string | null;
  keyViewCount: number;
  ringCount: number;
}> {
  return app.evalJS(
    `(function () {
       var card = document.querySelector(${JSON.stringify(CARD)});
       if (card === null) return { keyView: null, defaultRing: null, keyViewCount: 0, ringCount: 0 };
       var name = function (el) {
         if (el === null) return null;
         if (el.closest(${JSON.stringify(BAR_ROOT)}) !== null) return "minimize-control";
         if (el.closest(${JSON.stringify(STATUS_BAR)}) !== null) return "status-cell";
         var slotted = el.closest("[data-slot]");
         return slotted === null ? el.tagName.toLowerCase() : slotted.getAttribute("data-slot");
       };
       var kv = card.querySelectorAll("[data-key-view-kbd]");
       var ring = card.querySelectorAll("[data-default-ring]");
       return {
         keyView: name(kv[0] || null),
         defaultRing: name(ring[0] || null),
         keyViewCount: kv.length,
         ringCount: ring.length,
       };
     })()`,
  );
}

/** at0148's forward, verbatim — the wire shape a real permission arrives as. */
function permissionForward(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: "at0554-perm-1",
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

/** Whether `selector` carries `attr` right now. */
function hasAttr(app: App, selector: string, attr: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       return el !== null && el.hasAttribute(${JSON.stringify(attr)});
     })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0554: the keyboard in the minimized form", () => {
  test(
    "the fold takes the keyboard off the folded editor and the show gives it back",
    async () => {
      const app = await launchTugApp({ testName: "at0554-minimize-caret" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // Put the keyboard where a working card keeps it: in the composer.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.closest(".cm-content") !== null`,
          { timeoutMs: 6000 },
        );

        // ── The fold moves the keyboard to the bar ──
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-minimized"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === true`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `(function () {
             var bar = document.querySelector(${JSON.stringify(BAR)});
             return bar !== null && bar.hasAttribute("data-key-view");
           })()`,
          { timeoutMs: 8000 },
        );
        expect(
          await hasAttr(app, PROMPT_INPUT, "data-key-view"),
          "the folded editor keeps no keyboard position",
        ).toBe(false);
        note(`folded: bar holds the key view, editor holds none`);

        // ── …and the show gives it back ──
        // No ⌥⇥ anywhere in this test: the caret was live the whole time, so
        // this is the path a person takes with the mouse, and what it proves
        // is the reclaim gate in both directions rather than the walk.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-minimized"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === false`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          CONTROL_READS_MINIMIZE,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.closest(".cm-content") !== null`,
          { timeoutMs: 8000 },
        );
        note("shown: the caret is back in the composer");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "⌥⇥ lights the bar where the fold left it, Tab reaches STATE, Return shows the transcript",
    async () => {
      const app = await launchTugApp({ testName: "at0554-minimize-walk" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.closest(".cm-content") !== null`,
          { timeoutMs: 6000 },
        );
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-minimized"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === true`,
          { timeoutMs: 8000 },
        );

        // The POSITION is the bar the instant the fold lands; the PAINT waits
        // on KBF, which is the app's universal rule rather than anything this
        // form does — a live caret stands the mode's whole visual vocabulary
        // down, and the caret was live in the composer a moment ago. ⌥⇥ is the
        // manual engage, and it parks at the key view the fold already chose:
        // the bar lights where it already stood, with no second placement.
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(
          `(function () {
             var bar = document.querySelector(${JSON.stringify(BAR)});
             return bar !== null && bar.hasAttribute("data-key-view-kbd");
           })()`,
          { timeoutMs: 8000 },
        );
        const folded = await keyboardMarks(app);
        note(`folded: keyView=${folded.keyView} x${folded.keyViewCount}, ring=${folded.defaultRing} x${folded.ringCount}`);
        expect(folded.keyView, "the bar holds the card's keyboard").toBe(
          "minimize-control",
        );
        expect(folded.keyViewCount, "exactly one lit stop in the card").toBe(1);
        // The engine strips the persistent ring while its own button holds the
        // key view — one filled+ring per scope, never two.
        expect(folded.ringCount, "no second mark beside the key view").toBe(0);

        // ── ⇧⇥ reaches the Z2 cells, which stay leaf stops. The control is
        // the row's last stop, so the cell before it is JOBS. ──
        await app.nativeKey("Tab", ["shift"]);
        await app.waitForCondition<boolean>(
          `(function () {
             var cell = document.querySelector(${JSON.stringify(JOBS_CELL)});
             return cell !== null && cell.hasAttribute("data-key-view-kbd");
           })()`,
          { timeoutMs: 8000 },
        );
        const tabbed = await keyboardMarks(app);
        note(`after Tab: keyView=${tabbed.keyView} x${tabbed.keyViewCount}, ring=${tabbed.defaultRing} x${tabbed.ringCount}`);
        expect(tabbed.keyViewCount, "still one lit stop").toBe(1);
        expect(tabbed.keyView, "⇧⇥ from the bar reaches the Z2 row").toBe(
          "status-cell",
        );

        // ── Return on the bar shows the transcript ──
        // Back onto the bar first. A Z2 cell is a leaf stop that consumes
        // Return to open its own popover (at0140), which is exactly why the
        // engine's one-mark rule holds here without a second ring: every other
        // live stop in the minimized form is itself a button, so the mark is
        // always worn by whoever holds the keyboard and the persistent ring
        // never has a non-button key view to stand beside. What
        // `persistentDefaultRing` buys is the registration underneath it —
        // the bar IS the scope's default button — and Tab is the same walk read
        // forwards.
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `(function () {
             var bar = document.querySelector(${JSON.stringify(BAR)});
             return bar !== null && bar.hasAttribute("data-key-view-kbd");
           })()`,
          { timeoutMs: 8000 },
        );
        await app.nativeKey("Return");
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === false`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          CONTROL_READS_MINIMIZE,
          { timeoutMs: 8000 },
        );
        // Showing the transcript ends the cycle: the stop the user pressed has
        // gone away under them, so a retained mode would be a walk with a
        // stale key view and nothing ringed. The caret lands in the composer,
        // the same place the mouse path leaves it.
        await app.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.closest(".cm-content") !== null`,
          { timeoutMs: 8000 },
        );
        const shown = await keyboardMarks(app);
        note(`after Return: keyView=${shown.keyView} x${shown.keyViewCount}`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a pending permission folds away with the transcript and leaves one mark",
    async () => {
      const app = await launchTugApp({ testName: "at0554-minimize-dialog" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // A session waiting for permission is the wall's most common state, so
        // minimizing one is allowed rather than blocked (Risk R05). The dialog
        // owns the card's pushed key destination while it is up.
        await app.driveSession("A", { op: "send", text: "count lines with tokei" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: FEED_CODE_OUTPUT,
          decoded: permissionForward(),
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
          { timeoutMs: 8000 },
        );

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-minimized"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === true`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `(function () {
             var bar = document.querySelector(${JSON.stringify(BAR)});
             return bar !== null && bar.hasAttribute("data-key-view");
           })()`,
          { timeoutMs: 8000 },
        );

        // The dialog is still PENDING — minimizing answers nothing — but it is
        // folded away inside the inert transcript, so it is not where the
        // keyboard is and not what wears the mark. One mark, on the bar.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
          ),
          "the request is still pending",
        ).toBe(true);
        const marks = await keyboardMarks(app);
        note(`with a dialog pending: keyView=${marks.keyView} x${marks.keyViewCount}, ring=${marks.defaultRing} x${marks.ringCount}`);
        expect(marks.keyView, "the bar, not the folded dialog").toBe(
          "minimize-control",
        );
        expect(
          marks.keyViewCount + marks.ringCount,
          "exactly one mark in the card, never the dialog's and the bar's both",
        ).toBe(1);

        // Showing the transcript hands the card back to the dialog through the
        // ordinary reclaim — `adoptKeyCard` is the gate, and the pending trap
        // is what it adopts. What comes back is the dialog's own Return-home:
        // Allow wearing `data-default-ring`, the single mark in the card. The
        // key view itself is NOT re-seeded, and that is the engine's rule
        // rather than this form's: a trapped mode seeds its default once, on
        // open, and `assertKeyboardDestination` heals a stale key view only by
        // popping UNtrapped modes. So Return comes home and the first Tab
        // re-enters the walk — which is the same place a person who never
        // minimized would be after clicking the transcript.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-minimized"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).minimized === false`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `(function () {
             var allow = document.querySelector(${JSON.stringify(ALLOW)});
             return allow !== null && allow.hasAttribute("data-default-ring");
           })()`,
          { timeoutMs: 8000 },
        );
        const back = await keyboardMarks(app);
        note(`after the show: keyView=${back.keyView} x${back.keyViewCount}, ring=${back.defaultRing} x${back.ringCount}`);
        expect(
          back.keyViewCount + back.ringCount,
          "still exactly one mark in the card",
        ).toBe(1);
        expect(
          await hasAttr(app, `${CARD} [data-slot="session-card"]`, "data-inline-dialog-pending"),
          "the card is modal to the dialog again",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * AT0612: the update pill and its popover, driven entirely from the bridge.
 *
 * ## What this pins
 *
 * Tug's update presentation is a pill in the upper right of the deck canvas
 * and a popover behind it, and the only thing that moves either of them is a
 * snapshot arriving on `window.__tugBridge.onUpdateState`. That is the whole
 * contract with the host: state in, one action name out. So this test speaks
 * the host's side of it directly — no Sparkle, no updater, no feed, and no
 * network anywhere [B12] [F10]. Every stage the driver can report is injected
 * as a snapshot and the deck is required to draw it.
 *
 * Three claims are worth naming, because they are the ones the arc rests on
 * and the ones a plausible refactor would quietly lose:
 *
 * 1. **Nothing announces itself by taking focus.** An update found by a
 *    scheduled check lights the pill and does nothing else, and even the one
 *    permitted self-open — a check the *user* started reaching its answer —
 *    leaves the caret where it was. The answer to a check can land seconds
 *    after it was asked for, by which time the user is typing somewhere else,
 *    so an open nobody asked for must not move the keyboard [B06].
 * 2. **Progress never reaches React.** The percent is written onto the DOM as
 *    a custom property from a direct store subscription, so the bar moves
 *    while the rendered tree stands still [B05] [L06].
 * 3. **Absent release notes never block an update.** A feed item with no
 *    description leaves the version, the heading and every control exactly
 *    where they were [B11].
 *
 * The actions are read back through a recorder standing in for the host's
 * `updateAction` message handler — which is also what keeps the test from
 * driving a real install: no click here reaches Sparkle.
 *
 * @covers tugdeck/src/components/chrome/update-overlay.tsx
 * @covers tugdeck/src/components/chrome/update-overlay.css
 * @covers tugdeck/src/lib/update-store.ts
 * @covers tugdeck/src/lib/update-relaunch-warning.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const PILL = `[data-testid="update-pill"]`;
const POPOVER = `[data-testid="update-popover"]`;
/**
 * The popover's chrome — the element Radix focuses and dismisses, one level
 * out from the body {@link POPOVER} names. Focus questions are asked against
 * this, because "focus is inside the popover" includes the frame.
 */
const POPOVER_FRAME = `[data-slot="tug-popover"]`;
const CONTROLS = `${POPOVER} .tugx-update-controls button`;
const NOTES = `[data-testid="update-release-notes"]`;
const PROGRESS = `[data-testid="update-progress"]`;
const ERROR_MESSAGE = `[data-testid="update-error-message"]`;

/** A snapshot in the shape `UpdateSnapshot.jsonObject` emits, host-side. */
interface Payload {
  stage: string;
  version?: string;
  build?: string;
  releaseNotes?: string | null;
  releaseNotesFailed?: boolean;
  userInitiated?: boolean;
  percent?: number | null;
  message?: string;
  cancellable?: boolean;
}

function snapshot(stage: string, over: Partial<Payload> = {}): Payload {
  return {
    stage,
    version: "0.9.0",
    build: "900",
    releaseNotes: null,
    releaseNotesFailed: false,
    userInitiated: false,
    percent: null,
    message: "",
    cancellable: false,
    ...over,
  };
}

/** Push one snapshot the way `MainWindow.bridgeUpdateState` does. */
async function push(app: App, payload: Payload): Promise<void> {
  await app.evalJS<null>(
    `(window.__tugBridge.onUpdateState(${JSON.stringify(payload)}), null)`,
  );
}

/**
 * Stand a recorder in front of the host's `updateAction` handler.
 *
 * Two jobs, and the second is the load-bearing one: it is how the posted
 * action names are read back, and it is what guarantees no click in this file
 * reaches the real updater. Returns the name of the mechanism that took, so a
 * WebKit that refuses the override fails here rather than by silently
 * recording nothing.
 */
async function installActionRecorder(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
       var w = window;
       w.__at0612 = { posted: [] };
       // Patch postMessage on the handler's PROTOTYPE, not the handler.
       //
       // window.webkit is unconfigurable and its messageHandlers hands back a
       // fresh handler object, so a stub written over one of them is there on
       // the write and gone on the read — which shows up as an action that
       // posted nothing, indistinguishable from a dead button. Every handler
       // shares one prototype, so patching the method there is the one seam
       // that holds.
       //
       // Recording is by value: the seven action names are the whole of what
       // the update surface posts, and no other message the deck sends is one
       // of those bare strings. Anything else is forwarded to the host
       // untouched, so the rest of the deck keeps working; an action name is
       // swallowed, which is what keeps a click in this file from reaching
       // Sparkle.
       var ACTIONS = ["install","later","skip","cancel","retry","dismiss","check"];
       var handler = w.webkit.messageHandlers.updateAction;
       var proto = Object.getPrototypeOf(handler);
       var orig = proto.postMessage;
       proto.postMessage = function (v) {
         if (typeof v === "string" && ACTIONS.indexOf(v) !== -1) {
           w.__at0612.posted.push(v);
           return;
         }
         return orig.apply(this, arguments);
       };
       // Self-verify: the read path the deck actually takes has to land in
       // the recorder, here, rather than midway through the run.
       w.webkit.messageHandlers.updateAction.postMessage("check");
       var ok = w.__at0612.posted.length === 1
         && w.__at0612.posted[0] === "check";
       w.__at0612.posted.length = 0;
       return ok ? "prototype-patched" : "FAILED";
     })()`,
  );
}

async function postedActions(app: App): Promise<string[]> {
  return app.evalJS<string[]>(`window.__at0612.posted.slice()`);
}

async function clearPosted(app: App): Promise<void> {
  await app.evalJS<null>(`(window.__at0612.posted.length = 0, null)`);
}

async function elementCount(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

/** The popover's control labels, in the order they are laid out. */
async function controlLabels(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(CONTROLS)}),
       function (b) { return (b.textContent || "").trim(); }
     )`,
  );
}

/**
 * Wait until `selector` is a thing a click can actually land on.
 *
 * Present in the DOM is not the same as ready: the popover is positioned by a
 * collision-aware layout pass and animates in, so a click dispatched the
 * instant the content mounts can land where the content is no longer — which
 * Radix reads as a pointer-down *outside* and answers by dismissing. The
 * symptom is a popover that vanishes with no action posted, and it is a race
 * rather than a defect, so the answer is to wait for the thing the click needs
 * rather than to click again and hope.
 *
 * Ready means two polls agree on the element's box AND the centre of that box
 * hit-tests back to the element itself — the box has stopped moving and
 * nothing is over it.
 */
async function waitForClickable(app: App, selector: string): Promise<void> {
  await app.evalJS<null>(`(window.__at0612.box = null, null)`);
  await app.waitForCondition<boolean>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) { window.__at0612.box = null; return false; }
       var r = el.getBoundingClientRect();
       if (r.width === 0 || r.height === 0) { window.__at0612.box = null; return false; }
       var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
       if (hit === null || !el.contains(hit)) { window.__at0612.box = null; return false; }
       var key = [r.left, r.top, r.width, r.height].join(",");
       var settled = window.__at0612.box === key;
       window.__at0612.box = key;
       return settled;
     })()`,
    { timeoutMs: 15_000, pollMs: 50 },
  );
}

async function waitForPill(app: App, stage: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var p = document.querySelector(${JSON.stringify(PILL)});
       return p !== null && p.getAttribute("data-stage") === ${JSON.stringify(stage)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

async function waitForNoPill(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PILL)}) === null`,
    { timeoutMs: 10_000 },
  );
}

async function openPopover(app: App): Promise<void> {
  await waitForPopoverGone(app);
  await waitForClickable(app, PILL);
  await app.click(PILL);
  await waitForPopoverOpen(app);
}

/**
 * Wait until the popover is *open*, which is not the same as present.
 *
 * Radix keeps the content mounted through its exit animation, so an element
 * matching {@link POPOVER} can be one React has already unmounted from its
 * tree — the DOM node lingers, `__reactProps$` and all, and a click on a
 * button inside it reaches no handler and posts nothing. `data-state` is the
 * fact: `open` while the popover is live, `closed` while it is leaving.
 */
async function waitForPopoverOpen(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var f = document.querySelector(${JSON.stringify(`${POPOVER_FRAME}[data-state="open"]`)});
       return f !== null && f.querySelector(${JSON.stringify(POPOVER)}) !== null;
     })()`,
    { timeoutMs: 10_000 },
  );
  await waitForClickable(app, POPOVER);
}

/** Wait until the popover has finished leaving and nothing of it is left. */
async function waitForPopoverGone(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(POPOVER_FRAME)}) === null`,
    { timeoutMs: 10_000 },
  );
}

/** True only while the popover is live — never while it is animating out. */
async function popoverIsOpen(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(`${POPOVER_FRAME}[data-state="open"]`)}) !== null`,
  );
}

/** Put the deck back to having nothing to say, so the panel remounts clean. */
async function goIdle(app: App): Promise<void> {
  await push(app, snapshot("idle"));
  await waitForNoPill(app);
}

/**
 * True once `ms` have passed in the page, polled rather than slept — the
 * shape for "and it is *still* there", which no single condition expresses.
 */
async function letTimePass(app: App, ms: number): Promise<void> {
  await app.evalJS<null>(`(window.__at0612.mark = Date.now(), null)`);
  await app.waitForCondition<boolean>(
    `Date.now() - window.__at0612.mark >= ${ms}`,
    { timeoutMs: ms + 10_000, pollMs: 250 },
  );
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "gallery-input", title: "Card A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 600 },
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

describe.skipIf(!SHOULD_RUN)("AT0612: the update pill and popover", () => {
  test(
    "every stage draws, every control posts its action, and nothing takes focus",
    async () => {
      const app = await launchTugApp({ testName: "at0612-update-pill-popover" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.waitForCondition<boolean>(
          `typeof window.__tugBridge !== "undefined"
             && typeof window.__tugBridge.onUpdateState === "function"`,
          { timeoutMs: 20_000 },
        );

        const recorder = await installActionRecorder(app);
        note("at0612 action recorder", recorder);
        expect(recorder).not.toBe("FAILED");

        // ---- Idle says nothing at all ----------------------------------
        await goIdle(app);
        expect(await elementCount(app, PILL)).toBe(0);
        expect(await elementCount(app, POPOVER)).toBe(0);

        // ---- Every stage the driver reports puts a pill up -------------
        const labels: Array<[string, string]> = [
          ["checking", "Checking…"],
          ["available", "0.9.0"],
          ["downloading", "0.9.0"],
          ["extracting", "0.9.0"],
          ["readyToInstall", "Ready to install"],
          ["installing", "Installing…"],
          ["error", "Update failed"],
        ];
        for (const [stage, label] of labels) {
          await push(app, snapshot(stage));
          await waitForPill(app, stage);
          expect(await app.getElementText(PILL)).toContain(label);
        }
        note("at0612 pill labels", JSON.stringify(labels.map((l) => l[0])));

        // ---- The controls each stage allows, and what they post --------
        const controlCases: Array<{
          stage: string;
          expected: string[];
          actions: string[];
        }> = [
          { stage: "checking", expected: ["Cancel"], actions: ["cancel"] },
          {
            stage: "available",
            expected: ["Install and Relaunch", "Later", "Skip This Version"],
            actions: ["install", "later", "skip"],
          },
          { stage: "downloading", expected: ["Cancel"], actions: ["cancel"] },
          {
            stage: "readyToInstall",
            expected: ["Install and Relaunch", "Later"],
            actions: ["install", "later"],
          },
          {
            stage: "error",
            expected: ["Retry", "Dismiss"],
            actions: ["retry", "dismiss"],
          },
          { stage: "extracting", expected: [], actions: [] },
          { stage: "installing", expected: [], actions: [] },
        ];

        for (const { stage, expected, actions } of controlCases) {
          await goIdle(app);
          await push(app, snapshot(stage, { message: "the feed did not answer" }));
          await waitForPill(app, stage);
          await openPopover(app);

          expect(await controlLabels(app)).toEqual(expected);

          // Each control in turn: click it, read what the host would have
          // been sent, and re-open for the next one.
          for (let i = 0; i < actions.length; i++) {
            if (!(await popoverIsOpen(app))) await openPopover(app);
            await clearPosted(app);
            const target = `${POPOVER} .tugx-update-controls button:nth-child(${i + 1})`;
            await waitForClickable(app, target);
            await app.click(target);
            try {
              await app.waitForCondition<boolean>(
                `window.__at0612.posted.length > 0`,
                { timeoutMs: 10_000 },
              );
            } catch (err) {
              // Enough context to tell a dead control from a popover that was
              // not open when the click landed — the two failures this loop
              // can produce, and they want different answers.
              note(
                `at0612 no post from ${stage}/${actions[i]}`,
                await app.evalJS<string>(
                  `(function () {
                     var frame = document.querySelector(${JSON.stringify(POPOVER_FRAME)});
                     var t = document.querySelector(${JSON.stringify(target)});
                     return JSON.stringify({
                       frameState: frame === null ? null : frame.getAttribute("data-state"),
                       targetFound: t !== null,
                       targetText: t === null ? null : (t.textContent || "").trim(),
                       targetDisabled: t === null ? null : t.disabled,
                     });
                   })()`,
                ),
              );
              throw err;
            }
            note(`at0612 posted`, `${stage}/${actions[i]}`);
            expect(await postedActions(app)).toEqual([actions[i]!]);
          }
          note(`at0612 controls for ${stage}`, JSON.stringify(expected));
        }

        // ---- An error says what went wrong, and does not leave on a timer
        await goIdle(app);
        await push(
          app,
          snapshot("error", { message: "the feed did not answer" }),
        );
        await waitForPill(app, "error");
        await openPopover(app);
        expect(await app.getElementText(ERROR_MESSAGE)).toContain(
          "the feed did not answer",
        );
        await clearPosted(app);
        // Longer than the `upToDate` self-dismiss, which is the only timer in
        // the component. An error that cleared itself would be gone by now.
        await letTimePass(app, 8_000);
        expect(await elementCount(app, PILL)).toBe(1);
        expect(await postedActions(app)).toEqual([]);

        // ---- `upToDate` is an answer with nothing left to decide --------
        //
        // It clears itself after a few seconds, and that half is deliberately
        // NOT asserted here: the dismissal rides a `window.setTimeout`, and an
        // app-test's harness window can be occluded, where WebKit throttles
        // timers hard enough that a four-second timer has not fired a minute
        // later. Asserting it would be asserting the window manager. What is
        // asserted is what the stage draws — the pill, and a popover offering
        // nothing to press, because there is no decision left to make.
        await goIdle(app);
        await clearPosted(app);
        await push(app, snapshot("upToDate"));
        await waitForPill(app, "upToDate");
        expect(await app.getElementText(PILL)).toContain("Up to date");
        await openPopover(app);
        expect(await app.getElementText(POPOVER)).toContain("Tug is up to date");
        expect(await controlLabels(app)).toEqual([]);

        // ---- Release notes render, and their absence changes nothing ----
        await goIdle(app);
        await push(
          app,
          snapshot("available", {
            releaseNotes: "## What changed\n\nA `notable` thing.\n",
          }),
        );
        await waitForPill(app, "available");
        await openPopover(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(NOTES)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const notesText = await app.getElementText(NOTES);
        note("at0612 rendered notes", notesText);
        expect(notesText).toContain("What changed");
        expect(notesText).toContain("notable");

        // The same update with no notes at all — B11's floor. The version,
        // the heading and every control stand exactly as they did.
        await goIdle(app);
        await push(app, snapshot("available", { releaseNotes: null }));
        await waitForPill(app, "available");
        await openPopover(app);
        expect(await elementCount(app, NOTES)).toBe(0);
        expect(await app.getElementText(POPOVER)).toContain("Tug 0.9.0 is available");
        expect(await controlLabels(app)).toEqual([
          "Install and Relaunch",
          "Later",
          "Skip This Version",
        ]);

        // ---- Progress is appearance, never a render [B05] [L06] ---------
        await goIdle(app);
        await push(
          app,
          snapshot("downloading", { percent: null, cancellable: true }),
        );
        await waitForPill(app, "downloading");
        await openPopover(app);
        // No total yet: no property, no attribute, and so no bar claiming a
        // progress nobody has reported.
        expect(await app.getElementAttribute(PROGRESS, "data-progress")).toBeNull();

        for (const percent of [7, 42, 99]) {
          await push(
            app,
            snapshot("downloading", { percent, cancellable: true }),
          );
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(PROGRESS)})
                ?.getAttribute("data-progress")) === ${JSON.stringify(String(percent))}`,
            { timeoutMs: 10_000 },
          );
          // The property, not the rendered width: the fill transitions, so a
          // width read the instant the property moves is still the old one.
          const property = await app.getComputedStyleValue(
            PROGRESS,
            "--tugx-update-progress",
          );
          note(`at0612 progress ${percent}%`, property.trim());
          expect(property.trim()).toBe(`${percent}%`);
        }
        // The popover has not been re-rendered out from under itself: the
        // element that was there at 7% is the element that is there at 99%.
        expect(await elementCount(app, PROGRESS)).toBe(1);
        expect(await app.getElementAttribute(PILL, "data-progress")).toBe("99");

        // ---- Nothing takes focus ----------------------------------------
        // First the unsolicited case: an update found by a scheduled check
        // lights the pill and opens nothing.
        await goIdle(app);
        const before = await app.getActiveElement();
        await push(app, snapshot("available", { userInitiated: false }));
        await waitForPill(app, "available");
        expect(await elementCount(app, POPOVER)).toBe(0);
        expect(await app.getActiveElement()).toEqual(before);

        // Then the one permitted self-open: a check the user started reaching
        // its answer. The popover opens — and the caret stays where it was.
        await goIdle(app);
        await push(app, snapshot("available", { userInitiated: true }));
        await waitForPopoverOpen(app);
        const afterSelfOpen = await app.getActiveElement();
        note("at0612 focus after self-open", JSON.stringify(afterSelfOpen));
        const focusInsidePopover = await app.evalJS<boolean>(
          `(function () {
             var pop = document.querySelector(${JSON.stringify(POPOVER_FRAME)});
             var active = document.activeElement;
             return pop !== null && active !== null
               && (pop === active || pop.contains(active));
           })()`,
        );
        expect(focusInsidePopover).toBe(false);

        await goIdle(app);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0612] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

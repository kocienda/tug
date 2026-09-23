/**
 * AT0612: the update surface — badge and dialog — driven entirely from the bridge.
 *
 * ## What this pins
 *
 * Tug's update presentation is one surface with two sizes on one anchor at the
 * top centre of the window: a badge collapsed, a dialog expanded. The only thing that
 * moves what it *says* is a snapshot arriving on
 * `window.__tugBridge.onUpdateState`, and the only things that move its *size*
 * are a click on the badge and a click on the collapse control. That is the
 * whole contract with the host: state in, one action name out. So this test
 * speaks the host's side of it directly — no Sparkle, no updater, no feed, and
 * no network anywhere. Every stage the driver can report is injected as a
 * snapshot and the deck is required to draw it.
 *
 * Two briefs decided this surface and both are cited below. Bare `[B##]`/`[F##]`
 * are `briefs/update-surface-brief.md`, which decided the two sizes; the host
 * flow underneath them is `briefs/non-modal-app-updates-brief.md`, cited by
 * name where it is the one that answers.
 *
 * Six claims are worth naming, because they are the ones the arc rests on and
 * the ones a plausible refactor would quietly lose:
 *
 * 1. **Arrival size follows who asked.** A scheduled check that finds something
 *    arrives collapsed — the badge lights and nothing else moves. A check the
 *    *user* started arrives expanded on its answer, because being shown the
 *    answer is what they asked for [B02].
 * 2. **Nothing else changes the size, ever.** Not a stage transition, not the
 *    `upToDate` timer, not a decision button. Collapsing an update is how a
 *    decision waits for a convenient moment, and a surface that re-expanded
 *    itself would take that back [B01].
 * 3. **Nothing announces itself by taking focus.** The answer to a check can
 *    land seconds after it was asked for, by which time the user is typing
 *    somewhere else, so even the one permitted self-expansion must not move the
 *    keyboard (non-modal-app-updates [B06]).
 * 4. **Progress never reaches React.** The percent is written onto the download
 *    row's own span from a direct store subscription, so the words move while
 *    the rendered tree stands still ([L06]; non-modal-app-updates [B05]). There
 *    is no progress bar; the wizard standard is a dot and a detail line, and a
 *    bar was tried and rejected [F04] [B05].
 * 5. **Every size sits on one anchor, and the anchor is the window's.** The
 *    surface is centred horizontally on the window and dropped just below the
 *    chrome, so expanding changes its size around a fixed point rather than
 *    moving it (update-surface-anchor [B01] [B02] [B03]). It used to be pinned
 *    to the window's upper right, which is where the Workspaces sidebar lives
 *    — a regression back to any corner is what the centre assertions catch.
 * 6. **The badge's `x` hides and hides only.** It is the third size, and it
 *    answers Sparkle nothing: no action crosses the bridge, the host's stage
 *    is untouched, and the update stays as live as it was
 *    (update-surface-anchor [B04] [B05]). A hidden surface stays hidden across
 *    a stage transition and comes back with the next flow.
 *
 * Absent release notes still never block an update: a feed item with no
 * description leaves the version, the heading and every control exactly where
 * they were [B07].
 *
 * The actions are read back through a recorder standing in for the host's
 * `updateAction` message handler — which is also what keeps the test from
 * driving a real install: no click here reaches Sparkle. The recorder swallows
 * the action rather than forwarding it, so nothing ever pushes the deck back to
 * `idle` on its own; every stage this test stands in, it stands in until the
 * next snapshot is pushed.
 *
 * @covers tugdeck/src/components/chrome/update-overlay.tsx
 * @covers tugdeck/src/components/chrome/update-overlay.css
 * @covers tugdeck/src/components/tugways/tug-step-row.tsx
 * @covers tugdeck/src/lib/update-store.ts
 * @covers tugdeck/src/lib/update-relaunch-warning.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The surface itself — whichever size it is wearing. */
const OVERLAY = `.tugx-update-overlay`;
/** The collapsed form. */
const BADGE = `[data-testid="update-badge"]`;
/** The badge's `x`: takes the surface off the screen, and nothing else. */
const HIDE = `[data-testid="update-hide"]`;
/** The expanded form. */
const DIALOG = `[data-testid="update-dialog"]`;
/** The one control in the dialog's header slot: it collapses to the badge. */
const COLLAPSE = `[data-testid="update-collapse"]`;
/** The bottom row, in DOM order: the rare action first, then the decision pair. */
const DECISIONS = `${DIALOG} .tugx-update-decisions button`;
/** One decision button, addressed by the action it posts. */
const decision = (action: string): string =>
  `${DIALOG} [data-testid="update-action-${action}"]`;
const STEPS = `[data-testid="update-steps"]`;
const STEP_ROWS = `${STEPS} [data-slot="tug-step-row"]`;
/** The download row's detail line — the whole of what progress is now. */
const PROGRESS_DETAIL = `[data-testid="update-progress-detail"]`;
const NOTES = `[data-testid="update-release-notes"]`;
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
  revealCount?: number;
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
    revealCount: 0,
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

/** One element's box, with the window it is anchored against. */
interface AnchoredBox {
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
}

/** Measure `selector`'s box against the window it is centred on. */
async function anchoredBox(app: App, selector: string): Promise<AnchoredBox> {
  return app.evalJS<AnchoredBox>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return null;
       var r = el.getBoundingClientRect();
       return {
         left: r.left,
         top: r.top,
         width: r.width,
         height: r.height,
         windowWidth: window.innerWidth,
         windowHeight: window.innerHeight,
       };
     })()`,
  );
}

/** The horizontal centre of a measured box. */
function centreX(b: AnchoredBox): number {
  return b.left + b.width / 2;
}

/** The bottom row's labels, in the order they are laid out. */
async function decisionLabels(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(DECISIONS)}),
       function (b) { return (b.textContent || "").trim(); }
     )`,
  );
}

/**
 * Wait until `selector` is a thing a click can actually land on.
 *
 * Present in the DOM is not the same as ready: the surface is laid out and
 * transitions in, so a click dispatched the instant it mounts can land where
 * the element is no longer. Ready means two polls agree on the element's box
 * AND the centre of that box hit-tests back to the element itself — the box has
 * stopped moving and nothing is over it.
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

/** Wait until the collapsed form is up, on `stage`. */
async function waitForBadge(app: App, stage: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var b = document.querySelector(${JSON.stringify(BADGE)});
       return b !== null && b.getAttribute("data-stage") === ${JSON.stringify(stage)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

/** Wait until the expanded form is up, on `stage`. */
async function waitForDialog(app: App, stage: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var d = document.querySelector(${JSON.stringify(DIALOG)});
       return d !== null && d.getAttribute("data-stage") === ${JSON.stringify(stage)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

/** Click the badge, which is the one gesture that expands the surface. */
async function expand(app: App, stage: string): Promise<void> {
  await waitForClickable(app, BADGE);
  await app.click(BADGE);
  await waitForDialog(app, stage);
  await waitForClickable(app, DIALOG);
}

/** Click the collapse control, which is the one gesture that collapses it. */
async function collapse(app: App, stage: string): Promise<void> {
  await waitForClickable(app, COLLAPSE);
  await app.click(COLLAPSE);
  await waitForBadge(app, stage);
}

/** Put the deck back to having nothing to say, so the surface remounts clean. */
async function goIdle(app: App): Promise<void> {
  await push(app, snapshot("idle"));
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(BADGE)}) === null
       && document.querySelector(${JSON.stringify(DIALOG)}) === null`,
    { timeoutMs: 10_000 },
  );
}

/**
 * Push a stage and get to the expanded form, whatever size it arrived at.
 *
 * A scheduled snapshot arrives collapsed, which is the point of [B02] and is
 * asserted on its own below; here it is only the road to the dialog.
 */
async function showDialog(app: App, payload: Payload): Promise<void> {
  await goIdle(app);
  await push(app, payload);
  await waitForBadge(app, payload.stage);
  await expand(app, payload.stage);
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

describe.skipIf(!SHOULD_RUN)("AT0612: the update badge and dialog", () => {
  test(
    "every stage draws, the size is the user's, every control posts its action, and nothing takes focus",
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
        expect(await elementCount(app, BADGE)).toBe(0);
        expect(await elementCount(app, DIALOG)).toBe(0);

        // ---- Every stage the driver reports puts a badge up -------------
        //
        // The badge stands alone on the window's top edge with nothing
        // around it, so every label names its subject rather than assuming
        // the reader has the context the dialog supplies
        // (update-surface-anchor [B08]). `Ready to install` did not say what
        // was ready and the bare version said nothing at all; a label that
        // drops back to either is what these strings catch.
        const labels: Array<[string, string]> = [
          ["checking", "Checking for updates…"],
          ["available", "Tug 0.9.0 available"],
          ["downloading", "Downloading Tug 0.9.0…"],
          ["extracting", "Unpacking Tug 0.9.0…"],
          ["readyToInstall", "Ready to install update"],
          ["installing", "Installing Tug 0.9.0…"],
          ["upToDate", "Tug is up to date"],
          ["error", "Tug update failed"],
        ];
        for (const [stage, label] of labels) {
          await push(app, snapshot(stage));
          await waitForBadge(app, stage);
          expect(await app.getElementText(BADGE)).toContain(label);
        }
        note("at0612 badge stages", JSON.stringify(labels.map((l) => l[0])));
        await clearPosted(app);

        // ---- Arrival size follows who asked [B02] -----------------------
        //
        // A scheduled check lights the badge and moves nothing else. This is
        // the whole reason the surface is not a dialog that opens itself.
        await goIdle(app);
        await push(app, snapshot("available", { userInitiated: false }));
        await waitForBadge(app, "available");
        expect(await elementCount(app, DIALOG)).toBe(0);

        // A stage transition under a collapsed surface changes the words and
        // not the size [B01].
        await push(app, snapshot("downloading", { userInitiated: false }));
        await waitForBadge(app, "downloading");
        expect(await elementCount(app, DIALOG)).toBe(0);

        // The badge expands, and the collapse control is its inverse.
        await expand(app, "downloading");
        expect(await elementCount(app, BADGE)).toBe(0);
        await collapse(app, "downloading");
        expect(await elementCount(app, DIALOG)).toBe(0);
        note("at0612 size", "badge expands, collapse control collapses");

        // ---- One anchor, top centre of the window ----------------------
        //
        // The surface was pinned to the window's upper right, which is where
        // the Workspaces sidebar lives: the badge landed on the sidebar's
        // filter row and the 600px panel spilled across it onto the canvas.
        // Both sizes now sit on one window-centred anchor, so expanding
        // changes the size around a fixed point instead of moving the surface
        // (update-surface-anchor [B01] [B02] [B03]).
        //
        // Measured rather than read off the CSS: `width: fit-content` under
        // auto margins is the whole mechanism, and a rule that computes to
        // anything else — a stray `right:`, a transform, a `flex-end` — shows
        // up here as a centre that is not the window's.
        // The *surface* is what is anchored, so the surface is what is
        // measured: the collapsed form is a row — the badge and its `x` — and
        // the badge alone sits off-centre inside it by half that control.
        const collapsedBox = await anchoredBox(app, OVERLAY);
        await expand(app, "downloading");
        const expandedBox = await anchoredBox(app, OVERLAY);
        note(
          "at0612 anchor",
          JSON.stringify({ collapsed: collapsedBox, expanded: expandedBox }),
        );

        // Each size is centred on the window. One pixel of slack, for the
        // subpixel rounding an odd-width window leaves behind.
        const windowCentre = collapsedBox.windowWidth / 2;
        expect(Math.abs(centreX(collapsedBox) - windowCentre)).toBeLessThanOrEqual(1);
        expect(Math.abs(centreX(expandedBox) - windowCentre)).toBeLessThanOrEqual(1);

        // And they are centred on the *same* point, which is the claim the
        // user's complaint was actually about: the surface must not appear to
        // jump when it changes size.
        expect(
          Math.abs(centreX(expandedBox) - centreX(collapsedBox)),
        ).toBeLessThanOrEqual(1);

        // The dialog is the wide size and it is genuinely wider than the
        // badge, so the centre agreement above is not two boxes of the same
        // width agreeing by accident.
        expect(expandedBox.width).toBeGreaterThan(collapsedBox.width);

        // Dropped from the top edge, not parked a fifth of the way down like
        // Open Quickly's 22vh: the surface reads as arriving from the top.
        expect(collapsedBox.top).toBeGreaterThanOrEqual(0);
        expect(collapsedBox.top).toBeLessThan(collapsedBox.windowHeight * 0.15);
        expect(Math.abs(expandedBox.top - collapsedBox.top)).toBeLessThanOrEqual(1);

        await collapse(app, "downloading");

        // ---- The badge's `x` hides, and hides only ----------------------
        //
        // The third size. Hiding answers Sparkle nothing — no action crosses
        // the bridge — so the update stays as live as it was and the host's
        // stage is untouched (update-surface-anchor [B04] [B05]). `dismiss`
        // could not have done this job: it is already a Sparkle reply, and it
        // ends the session.
        await clearPosted(app);
        await waitForClickable(app, HIDE);
        await app.click(HIDE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BADGE)}) === null
             && document.querySelector(${JSON.stringify(DIALOG)}) === null`,
          { timeoutMs: 10_000 },
        );
        expect(await elementCount(app, OVERLAY)).toBe(0);
        expect(await postedActions(app)).toEqual([]);
        note("at0612 hide", "x removes the surface and posts nothing");

        // A hidden surface stays hidden across a stage transition: a hide the
        // next transition undid would be worth nothing at the stages a user
        // reaches for it.
        await push(app, snapshot("readyToInstall", { userInitiated: false }));
        await letTimePass(app, 500);
        expect(await elementCount(app, OVERLAY)).toBe(0);
        expect(await postedActions(app)).toEqual([]);

        // And the host saying there is nothing to say, then something new,
        // brings the surface back: hidden belongs to this flow, not to the
        // deck.
        await goIdle(app);
        await push(app, snapshot("available", { userInitiated: false }));
        await waitForBadge(app, "available");

        // ---- The host's reveal is a count, acted on once ----------------
        //
        // The Tug menu item — and Sparkle's `showUpdateInFocus` behind it —
        // asks for the surface by bumping `revealCount` on the snapshot, not
        // by firing an event across the bridge. So the deck compares the
        // number against the last one it acted on: a replay after a reload
        // re-reads the same count and does nothing, a new count opens the
        // surface expanded, in the state it was left
        // (update-surface-anchor [B06] [B07]).
        //
        // From hidden, which is the case the menu door exists for.
        await waitForClickable(app, HIDE);
        await app.click(HIDE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(OVERLAY)}) === null`,
          { timeoutMs: 10_000 },
        );

        await push(app, snapshot("available", { revealCount: 1 }));
        await waitForDialog(app, "available");
        note("at0612 reveal", "a bumped count opens the surface expanded");

        // The same count again is the replay a reload gets, and it is inert:
        // the user's own collapse stands.
        await collapse(app, "available");
        await push(app, snapshot("available", { revealCount: 1 }));
        await letTimePass(app, 500);
        expect(await elementCount(app, DIALOG)).toBe(0);
        expect(await elementCount(app, BADGE)).toBe(1);

        // A count the deck has not seen opens it again.
        await push(app, snapshot("available", { revealCount: 2 }));
        await waitForDialog(app, "available");

        // And a reveal posts nothing back: it is the host asking to be
        // looked at, not a decision.
        expect(await postedActions(app)).toEqual([]);

        // A check the user started arrives expanded on its answer.
        await goIdle(app);
        await push(app, snapshot("available", { userInitiated: true }));
        await waitForDialog(app, "available");
        expect(await elementCount(app, BADGE)).toBe(0);

        // And a transition inside that same flow does not resize it either —
        // the surface the user is looking at stays the surface they are
        // looking at.
        await push(app, snapshot("downloading", { userInitiated: true }));
        await waitForDialog(app, "downloading");
        expect(await elementCount(app, BADGE)).toBe(0);

        // ---- The controls each stage allows, and what they post --------
        //
        // In DOM order: the rare left-hand action first, then the quiet one
        // and the primary. A click posts and changes nothing else — the
        // recorder swallows the action, so the surface stays exactly as it is
        // and the next control is ready to click.
        const controlCases: Array<{
          stage: string;
          expected: string[];
          actions: string[];
        }> = [
          { stage: "checking", expected: ["Cancel"], actions: ["cancel"] },
          {
            stage: "available",
            expected: ["Skip This Version", "Later", "Download"],
            actions: ["skip", "later", "install"],
          },
          { stage: "downloading", expected: ["Cancel"], actions: ["cancel"] },
          {
            stage: "readyToInstall",
            expected: ["Later", "Install and Relaunch"],
            actions: ["later", "install"],
          },
          {
            stage: "error",
            expected: ["Dismiss", "Retry"],
            actions: ["dismiss", "retry"],
          },
          { stage: "extracting", expected: [], actions: [] },
          { stage: "installing", expected: [], actions: [] },
        ];

        for (const { stage, expected, actions } of controlCases) {
          await showDialog(
            app,
            snapshot(stage, { message: "the feed did not answer" }),
          );

          expect(await decisionLabels(app)).toEqual(expected);

          for (let i = 0; i < actions.length; i++) {
            await clearPosted(app);
            const target = decision(actions[i]!);
            await waitForClickable(app, target);
            await app.click(target);
            try {
              await app.waitForCondition<boolean>(
                `window.__at0612.posted.length > 0`,
                { timeoutMs: 10_000 },
              );
            } catch (err) {
              note(
                `at0612 no post from ${stage}/${actions[i]}`,
                await app.evalJS<string>(
                  `(function () {
                     var d = document.querySelector(${JSON.stringify(DIALOG)});
                     var t = document.querySelector(${JSON.stringify(target)});
                     return JSON.stringify({
                       dialogStage: d === null ? null : d.getAttribute("data-stage"),
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
            // A decision posts and nothing more: the surface it was pressed on
            // is still the surface, at the size it was pressed at [B01].
            expect(await elementCount(app, DIALOG)).toBe(1);
          }
          note(`at0612 decisions for ${stage}`, JSON.stringify(expected));
        }

        // ---- The flow is a step list, not a bar [B05] [F04] -------------
        //
        // Three rows, whatever the stage, and the dot says where the flow has
        // got to. `checking`, `upToDate` and `error` show none: the first two
        // have no flow, and `error` has lost one — the snapshot never says
        // which step failed, so a red dot anywhere would assert something
        // nobody reported.
        const stepCases: Array<[string, number, string[]]> = [
          ["available", 3, ["active", "pending", "pending"]],
          ["downloading", 3, ["busy", "pending", "pending"]],
          ["extracting", 3, ["done", "busy", "pending"]],
          ["readyToInstall", 3, ["done", "done", "active"]],
          ["installing", 3, ["done", "done", "busy"]],
          ["checking", 0, []],
          ["upToDate", 0, []],
          ["error", 0, []],
        ];
        for (const [stage, count, statuses] of stepCases) {
          await showDialog(app, snapshot(stage, { message: "no answer" }));
          expect(await elementCount(app, STEP_ROWS)).toBe(count);
          const read = await app.evalJS<string[]>(
            `Array.prototype.map.call(
               document.querySelectorAll(${JSON.stringify(STEP_ROWS)}),
               function (r) { return r.getAttribute("data-status"); }
             )`,
          );
          note(`at0612 steps ${stage}`, JSON.stringify(read));
          expect(read).toEqual(statuses);
        }
        // No bar survived the rewrite, in any stage.
        expect(await elementCount(app, `[role="progressbar"]`)).toBe(0);

        // ---- An error says what went wrong, and does not leave on a timer
        await showDialog(
          app,
          snapshot("error", { message: "the feed did not answer" }),
        );
        expect(await app.getElementText(ERROR_MESSAGE)).toContain(
          "the feed did not answer",
        );
        await clearPosted(app);
        // Longer than the `upToDate` self-dismiss, which is the only timer in
        // the component. An error that cleared itself would be gone by now.
        await letTimePass(app, 8_000);
        expect(await elementCount(app, DIALOG)).toBe(1);
        expect(await postedActions(app)).toEqual([]);

        // ---- `upToDate` is an answer with nothing left to decide --------
        //
        // It clears itself after a few seconds, and that half is deliberately
        // NOT asserted: the dismissal rides a `window.setTimeout`, and an
        // app-test's harness window can be occluded, where WebKit throttles
        // timers hard enough that a four-second timer has not fired a minute
        // later. Asserting it would be asserting the window manager.
        //
        // What IS asserted is that the timer never touches the size. A user
        // who expanded the answer is still looking at it, expanded, well past
        // the moment the timer would have fired [B01] [B08].
        await showDialog(app, snapshot("upToDate"));
        expect(await app.getElementText(DIALOG)).toContain("Tug is up to date");
        expect(await decisionLabels(app)).toEqual(["OK"]);
        await letTimePass(app, 6_000);
        expect(await elementCount(app, DIALOG)).toBe(1);
        expect(await elementCount(app, BADGE)).toBe(0);
        await clearPosted(app);

        // ---- Release notes render, and their absence changes nothing ----
        await showDialog(
          app,
          snapshot("available", {
            releaseNotes: "## What changed\n\nA `notable` thing.\n",
          }),
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(NOTES)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const notesText = await app.getElementText(NOTES);
        note("at0612 rendered notes", notesText);
        expect(notesText).toContain("What changed");
        expect(notesText).toContain("notable");

        // The same update with no notes at all — [B07]'s floor. The version,
        // the heading and every control stand exactly as they did.
        await showDialog(app, snapshot("available", { releaseNotes: null }));
        expect(await elementCount(app, NOTES)).toBe(0);
        expect(await app.getElementText(DIALOG)).toContain("Tug 0.9.0 is available");
        expect(await decisionLabels(app)).toEqual([
          "Skip This Version",
          "Later",
          "Download",
        ]);

        // ---- Progress is words, and never a render [B05] [L06] ----------
        await showDialog(
          app,
          snapshot("downloading", { percent: null, cancellable: true }),
        );
        // No total yet: no attribute, and a phrase rather than a number,
        // because `null` is not zero.
        expect(
          await app.getElementAttribute(PROGRESS_DETAIL, "data-progress"),
        ).toBeNull();
        expect(await app.getElementText(PROGRESS_DETAIL)).toContain("Starting");

        for (const percent of [7, 42, 99]) {
          await push(
            app,
            snapshot("downloading", { percent, cancellable: true }),
          );
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(PROGRESS_DETAIL)})
                ?.getAttribute("data-progress")) === ${JSON.stringify(String(percent))}`,
            { timeoutMs: 10_000 },
          );
          const text = await app.getElementText(PROGRESS_DETAIL);
          note(`at0612 progress ${percent}%`, text);
          expect(text).toContain(`${percent}%`);
        }
        // The dialog has not been re-rendered out from under itself: the span
        // that was there at 7% is the span that is there at 99%, and the
        // surface never changed size while the percent moved.
        expect(await elementCount(app, PROGRESS_DETAIL)).toBe(1);
        expect(await elementCount(app, DIALOG)).toBe(1);

        // ---- Nothing takes focus ----------------------------------------
        // First the unsolicited case: an update found by a scheduled check
        // lights the badge and expands nothing.
        await goIdle(app);
        const before = await app.getActiveElement();
        await push(app, snapshot("available", { userInitiated: false }));
        await waitForBadge(app, "available");
        expect(await elementCount(app, DIALOG)).toBe(0);
        expect(await app.getActiveElement()).toEqual(before);

        // Then the one permitted self-expansion: a check the user started
        // reaching its answer. The dialog opens — and the caret stays put.
        await goIdle(app);
        await push(app, snapshot("available", { userInitiated: true }));
        await waitForDialog(app, "available");
        const afterSelfOpen = await app.getActiveElement();
        note("at0612 focus after self-open", JSON.stringify(afterSelfOpen));
        const focusInsideDialog = await app.evalJS<boolean>(
          `(function () {
             var d = document.querySelector(${JSON.stringify(DIALOG)});
             var active = document.activeElement;
             return d !== null && active !== null
               && (d === active || d.contains(active));
           })()`,
        );
        expect(focusInsideDialog).toBe(false);

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

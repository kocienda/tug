/**
 * AT0612: the update feature — one pill and one wizard — driven entirely from the bridge.
 *
 * ## What this pins
 *
 * Tug's update presentation is exactly two things. A **pill** at the window's top
 * centre that says an update exists and nothing else, and **UpdateTug**, an
 * app-modal wizard walking Check / Download / Stop work in flight / Install and
 * relaunch. There is no badge, no inline dialog, no collapsed and expanded size,
 * and no collapse control: this file is the rewrite that followed their
 * deletion, and the old surface's claims are gone from it rather than relaxed.
 *
 * The contract with the host is unchanged and is still the whole of what this
 * test speaks: state in on `window.__tugBridge.onUpdateState`, one action name
 * out on `updateAction`. No Sparkle, no updater, no feed, no network. Every
 * stage the driver can report is injected as a snapshot and the deck is required
 * to draw it.
 *
 * `[B##]` and `[F##]` are `briefs/update-tug-brief.md`, which decided the
 * replacement; `update-surface-anchor [B##]` is the arc that put the anchor at
 * the top centre, and the anchor is the one thing this rewrite inherits intact.
 *
 * Six claims are worth naming, because they are what the arc rests on and what a
 * plausible refactor would quietly lose:
 *
 * 1. **A scheduled find opens nothing.** An update that arrives without anybody
 *    asking lights the pill and stops there. Nothing takes the app modal, and
 *    nothing takes focus [B03].
 * 2. **The pill says one thing.** *Tug v0.9.0 is available*, in every live stage —
 *    it never narrates the flow it is standing next to [B02] [F08]. It shows for
 *    `available` through `installing` and for nothing else: not for a check in
 *    flight, not for a check that found nothing, not for a failure.
 * 3. **Two doors, both only raising.** A pill click opens the wizard; a bumped
 *    `revealCount` opens it in every stage, `idle` included, and the same count
 *    replayed opens nothing [B01] [B06].
 * 4. **Closing is pause.** Close posts nothing, the host's stage is untouched,
 *    and reopening lands on the step the flow is actually on — the wizard holds
 *    no flow state of its own [B04]. The two terminal stages are the exception,
 *    and about Sparkle rather than about the wizard: `upToDate` and `error`
 *    acknowledge with `dismiss`.
 * 5. **Four rows, always, and the dot says where the flow is** [B02]. Unpacking
 *    is the download row's detail phase rather than a row of its own, and a
 *    failure lands on the row that was waiting rather than on a row the
 *    snapshot never named.
 * 6. **Progress is words on one span, never a render** [L06]. The span that is
 *    there at 7% is the span that is there at 99%.
 *
 * The actions are read back through a recorder standing in for the host's
 * `updateAction` message handler — which is also what keeps this file from
 * driving a real install: no click here reaches Sparkle. The recorder swallows
 * the action rather than forwarding it, so nothing ever pushes the deck back to
 * `idle` on its own; every stage this test stands in, it stands in until the
 * next snapshot is pushed.
 *
 * The one thing deliberately not pinned here is the with-turns branch of the
 * *Stop work in flight* row. The row derives from the deck, and this deck has
 * no session mid-turn — so what this file pins is the other half, which is the
 * common one: the row reads done, and *Install and Relaunch* is there and posts
 * `install` with no confirm in the way. That the install button is absent while
 * a turn exists, and comes back when the last one ends, is pinned on
 * `deriveUpdateRows` in `tugdeck/src/components/tugways/__tests__/update-tug-rows.test.ts`,
 * where the deck's answer is an argument [B08].
 *
 * @covers tugdeck/src/components/tugways/update-tug.tsx
 * @covers tugdeck/src/components/tugways/update-tug-rows.tsx
 * @covers tugdeck/src/components/tugways/update-tug.css
 * @covers tugdeck/src/components/chrome/update-pill.tsx
 * @covers tugdeck/src/components/chrome/update-pill.css
 * @covers tugdeck/src/components/tugways/tug-step-row.tsx
 * @covers tugdeck/src/lib/live-turns-store.ts
 * @covers tugdeck/src/lib/update-store.ts
 * @covers tugdeck/src/lib/update-tug-request-store.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/**
 * The host's reveal is a monotonic count that rides *every* snapshot, so the
 * test has to carry one too. Every push below sends the standing count unless
 * it is deliberately bumping it — a push that let the number fall back to zero
 * would read to the deck as a count it had not seen, and open the wizard by
 * accident in the middle of an assertion about something else.
 */
let reveal = 0;
const nextReveal = (): number => (reveal += 1);

/** The modeless notice: the whole row, badge and `x` together. */
const PILL_ANCHOR = `[data-slot="update-pill"]`;
/** The pressable part of the pill — clicking it opens the wizard. */
const PILL = `[data-testid="update-pill"]`;
/** The pill's `x`: takes the pill off the screen, and nothing else. */
const PILL_HIDE = `[data-testid="update-pill-hide"]`;
/** The wizard's panel. Absent from the DOM entirely while it is closed. */
const WIZARD = `[data-testid="update-tug"]`;
/** The four step rows, in the order they are walked. */
const STEP_ROWS = `${WIZARD} .update-tug-steps [data-slot="tug-step-row"]`;
/** One row's CTA, addressed by the action it posts. */
const cta = (action: string): string =>
  `${WIZARD} [data-testid="update-tug-action-${action}"]`;
/** The one bottom button: Close, or Done / Dismiss on a terminal stage. */
const CLOSE = `[data-testid="update-tug-close"]`;
/** The download row's detail line — the whole of what progress is. */
const PROGRESS = `[data-testid="update-tug-progress"]`;

/** A snapshot in the shape `UpdateSnapshot.jsonObject` emits, host-side. */
interface Payload {
  stage: string;
  version?: string;
  build?: string;
  currentVersion?: string;
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
    currentVersion: "0.8.10",
    releaseNotes: null,
    releaseNotesFailed: false,
    userInitiated: false,
    percent: null,
    message: "",
    cancellable: false,
    revealCount: reveal,
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
 * Two jobs, and the second is the load-bearing one: it is how the posted action
 * names are read back, and it is what guarantees no click in this file reaches
 * the real updater. Returns the name of the mechanism that took, so a WebKit
 * that refuses the override fails here rather than by silently recording
 * nothing.
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
       // the update feature posts, and no other message the deck sends is one
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

/**
 * Wait until `selector` is a thing a click can actually land on.
 *
 * Present in the DOM is not the same as ready: both surfaces are laid out and
 * transition in, so a click dispatched the instant one mounts can land where the
 * element is no longer. Ready means two polls agree on the element's box AND the
 * centre of that box hit-tests back to the element itself — the box has stopped
 * moving and nothing is over it.
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

/** Wait until the wizard is up, on `stage`. */
async function waitForWizard(app: App, stage: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var d = document.querySelector(${JSON.stringify(WIZARD)});
       return d !== null && d.getAttribute("data-stage") === ${JSON.stringify(stage)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

/** Wait until the wizard is gone. Radix animates the close, so this is a wait. */
async function waitForWizardGone(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(WIZARD)}) === null`,
    { timeoutMs: 10_000 },
  );
}

/** Wait until the pill is up, on `stage`. */
async function waitForPill(app: App, stage: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var p = document.querySelector(${JSON.stringify(PILL)});
       return p !== null && p.getAttribute("data-stage") === ${JSON.stringify(stage)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

/** The rows' statuses, in layout order. */
async function stepStatuses(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(STEP_ROWS)}),
       function (r) { return r.getAttribute("data-status"); }
     )`,
  );
}

/** The rows' step keys — Check / Download / Stop work / Relaunch. */
async function stepKeys(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(STEP_ROWS)}),
       function (r) { return r.getAttribute("data-step"); }
     )`,
  );
}

/** The check row's detail line — the one that names the versions. */
async function checkDetail(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
       var row = document.querySelector(
         ${JSON.stringify(STEP_ROWS)} + '[data-step="check"]'
       );
       var el = row && row.querySelector(".tug-step-row-detail");
       return el ? (el.textContent || "").trim() : "";
     })()`,
  );
}

/** The rows' labels, which are the same four in every stage. */
async function stepLabels(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(STEP_ROWS)} + " .tug-step-row-label"),
       function (s) { return (s.textContent || "").trim(); }
     )`,
  );
}

/**
 * Put the deck back to having nothing to say: no wizard, no pill.
 *
 * The wizard is closed by hand first, because pushing `idle` only closes it
 * when the stage actually *moves*. A wizard raised by a reveal at `idle` is
 * already standing on the snapshot this function pushes, so the push is a no-op
 * and the panel would still be there — which is exactly the state the reveal
 * loop below leaves behind. On the two terminal stages that close posts
 * `dismiss`, so every caller that reads the recorder clears it after this.
 */
async function goIdle(app: App): Promise<void> {
  if ((await elementCount(app, WIZARD)) > 0) {
    await waitForClickable(app, CLOSE);
    await app.click(CLOSE);
    await waitForWizardGone(app);
  }
  await push(app, snapshot("idle"));
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PILL_ANCHOR)}) === null
       && document.querySelector(${JSON.stringify(WIZARD)}) === null`,
    { timeoutMs: 10_000 },
  );
}

/**
 * True once `ms` have passed in the page, polled rather than slept — the shape
 * for "and it is *still* there", which no single condition expresses.
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

describe.skipIf(!SHOULD_RUN)("AT0612: the update pill and the UpdateTug wizard", () => {
  test(
    "a find only lights the pill, both doors only raise the wizard, closing is pause, and every control posts its action",
    async () => {
      const app = await launchTugApp({ testName: "at0612-update-tug-wizard" });
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

        // ---- The old surface is gone, not hidden ------------------------
        //
        // The badge, the inline dialog and the collapse control were deleted
        // rather than suppressed, so their test ids must not resolve in any
        // state. A re-mount of the old component behind a flag would pass
        // every behavioural assertion below and fail here.
        await goIdle(app);
        for (const gone of [
          `[data-testid="update-badge"]`,
          `[data-testid="update-dialog"]`,
          `[data-testid="update-collapse"]`,
          `.tugx-update-overlay`,
        ]) {
          expect(await elementCount(app, gone)).toBe(0);
        }

        // ---- Idle says nothing at all -----------------------------------
        expect(await elementCount(app, PILL_ANCHOR)).toBe(0);
        expect(await elementCount(app, WIZARD)).toBe(0);

        // ---- A scheduled find lights the pill and opens nothing [B03] ----
        //
        // This is the claim the whole feature is built around: an update that
        // nobody asked for never takes the app modal. It is asserted for the
        // unsolicited case AND for the user-initiated one, because
        // `userInitiated` used to be the flag that opened the old surface by
        // itself, and the wizard deliberately does not read it — the menu item
        // bumps the reveal count instead [B06].
        const beforeFocus = await app.getActiveElement();
        for (const userInitiated of [false, true]) {
          await goIdle(app);
          await push(app, snapshot("available", { userInitiated }));
          await waitForPill(app, "available");
          expect(await elementCount(app, WIZARD)).toBe(0);
          expect(await postedActions(app)).toEqual([]);
        }
        // And nothing took focus on the way in.
        expect(await app.getActiveElement()).toEqual(beforeFocus);
        note("at0612 scheduled find", "pill only, wizard closed, focus unmoved");

        // ---- The pill shows for a live update, and for nothing else [B02]
        //
        // `checking` has found nothing yet, `upToDate` found nothing at all,
        // and `error` has no update to say is available. Each of the three is
        // reached from idle so the previous stage's pill cannot linger into
        // the assertion.
        const pillStages: Array<[string, boolean]> = [
          ["checking", false],
          ["available", true],
          ["downloading", true],
          ["extracting", true],
          ["readyToInstall", true],
          ["installing", true],
          ["upToDate", false],
          ["error", false],
        ];
        for (const [stage, lit] of pillStages) {
          await goIdle(app);
          await push(app, snapshot(stage, { message: "the feed did not answer" }));
          if (lit) {
            await waitForPill(app, stage);
            // One sentence, and it is the same sentence in every live stage:
            // which update exists, never what is happening to it [F08].
            expect(await app.getElementText(PILL)).toContain(
              "Tug v0.9.0 is available",
            );
          } else {
            await letTimePass(app, 400);
            expect(await elementCount(app, PILL_ANCHOR)).toBe(0);
          }
        }
        note(
          "at0612 pill stages",
          JSON.stringify(pillStages.filter((p) => p[1]).map((p) => p[0])),
        );

        // ---- One anchor, top centre of the window -----------------------
        //
        // Inherited from the update-surface-anchor arc and the one thing this
        // rewrite keeps intact. Measured rather than read off the CSS:
        // `width: fit-content` under auto margins is the whole mechanism, and
        // a rule that computes to anything else — a stray `right:`, a
        // transform, a `flex-end` — shows up here as a centre that is not the
        // window's.
        await goIdle(app);
        await push(app, snapshot("available"));
        await waitForPill(app, "available");
        const pillBox = await anchoredBox(app, PILL_ANCHOR);
        note("at0612 anchor", JSON.stringify(pillBox));
        expect(
          Math.abs(centreX(pillBox) - pillBox.windowWidth / 2),
        ).toBeLessThanOrEqual(1);
        // Pinned to the top edge, not dropped below it. Pinned down to the
        // pixel on purpose: the offset this replaced was `--tug-chrome-height`
        // plus a gap, which is a *card's* title-bar height applied to an
        // overlay root that covers the whole window and has no chrome above it
        // — so the pill cleared a bar that was not there and floated in the
        // canvas gap. A tolerance band is what let that read as passing, and an
        // exact zero is the only assertion that says "against the edge".
        expect(pillBox.top).toBe(0);

        // The label is not clipped. `.tug-badge` sets `line-height: 1`, which
        // makes the line box exactly the font size while the descenders fall
        // below it, and `.tug-badge-text` hides its overflow — so the bottom of
        // the `g` in *Tug* was being cut off. Measured as overflow rather than
        // read off the line-height, because what matters is whether any ink is
        // outside the box that clips it, and that is the thing a later change
        // to the font, the size rung or the badge's own metrics would break.
        const labelOverflow = await app.evalJS<{
          scrollHeight: number;
          clientHeight: number;
        }>(
          `(function () {
             var el = document.querySelector('${PILL} .tug-badge-text');
             if (el === null) return null;
             return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
           })()`,
        );
        note("at0612 pill label", JSON.stringify(labelOverflow));
        expect(labelOverflow.scrollHeight).toBeLessThanOrEqual(
          labelOverflow.clientHeight,
        );

        // ---- Door one: the pill opens the wizard [B01] -------------------
        //
        // And the pill goes away while it is open, because the two say the
        // same thing and the wizard says it better.
        await clearPosted(app);
        await waitForClickable(app, PILL);
        await app.click(PILL);
        await waitForWizard(app, "available");
        expect(await elementCount(app, PILL_ANCHOR)).toBe(0);
        // Opening is not a decision: nothing crossed the bridge.
        expect(await postedActions(app)).toEqual([]);
        note("at0612 pill door", "click opens the wizard, pill stands down");

        // ---- Closing is pause [B04] -------------------------------------
        //
        // Close posts nothing on a non-terminal stage, the host's stage is
        // untouched — so the pill comes straight back, still saying an update
        // is available.
        await waitForClickable(app, CLOSE);
        expect(await app.getElementText(CLOSE)).toContain("Close");
        await app.click(CLOSE);
        await waitForWizardGone(app);
        await waitForPill(app, "available");
        expect(await postedActions(app)).toEqual([]);

        // ---- Door two: a bumped reveal opens it in EVERY stage [B06] -----
        //
        // `idle` included. That is not a curiosity: the Tug-menu item is
        // enabled in every stage and opens the wizard on its Check row when
        // there is no flow at all, which is the whole of what the menu item
        // does now.
        for (const stage of [
          "idle",
          "checking",
          "available",
          "downloading",
          "extracting",
          "readyToInstall",
          "installing",
          "upToDate",
          "error",
        ]) {
          await goIdle(app);
          await clearPosted(app);
          await push(
            app,
            snapshot(stage, {
              message: "the feed did not answer",
              revealCount: nextReveal(),
            }),
          );
          await waitForWizard(app, stage);
          // A reveal posts nothing back: it is the host asking to be looked
          // at, not a decision.
          expect(await postedActions(app)).toEqual([]);
        }
        note("at0612 reveal door", `opened in 9 stages, last count ${reveal}`);

        // The same count again is the replay a reload gets, and it is inert:
        // a wizard the user closed stays closed.
        await goIdle(app);
        await push(app, snapshot("available", { revealCount: nextReveal() }));
        await waitForWizard(app, "available");
        await waitForClickable(app, CLOSE);
        await app.click(CLOSE);
        await waitForWizardGone(app);
        // No bump: `snapshot` carries the standing count, which is exactly the
        // number the deck has already acted on.
        await push(app, snapshot("available", { userInitiated: true }));
        await letTimePass(app, 500);
        expect(await elementCount(app, WIZARD)).toBe(0);
        note("at0612 replay", "the same count re-read opens nothing");

        // ---- Four rows, always, and the dot says where the flow is [B02]
        //
        // Unpacking is the download row's detail phase rather than a fourth
        // row: the user named four steps, and "Verifying the signature…" is a
        // sentence about the download rather than a step anybody can act on.
        //
        // The third column is the deck's row, and on this deck it has one
        // answer: nothing is mid-turn, so it is pending until the download
        // lands and done from there. Its other branch is a unit test.
        const stepCases: Array<[string, string[]]> = [
          ["idle", ["active", "pending", "pending", "pending"]],
          ["checking", ["busy", "pending", "pending", "pending"]],
          ["available", ["done", "active", "pending", "pending"]],
          ["downloading", ["done", "busy", "pending", "pending"]],
          ["extracting", ["done", "busy", "pending", "pending"]],
          ["readyToInstall", ["done", "done", "done", "active"]],
          ["installing", ["done", "done", "done", "busy"]],
          ["upToDate", ["done", "pending", "pending", "pending"]],
          // A failure lands on the row that was waiting. Reached from idle,
          // that row is Check — the snapshot never says which step failed, so
          // a red dot anywhere else would assert something nobody reported.
          ["error", ["error", "pending", "pending", "pending"]],
        ];
        for (const [stage, statuses] of stepCases) {
          await goIdle(app);
          await push(
            app,
            snapshot(stage, {
              message: "the feed did not answer",
              revealCount: nextReveal(),
            }),
          );
          await waitForWizard(app, stage);
          expect(await elementCount(app, STEP_ROWS)).toBe(4);
          expect(await stepKeys(app)).toEqual([
            "check",
            "download",
            "stop-work",
            "relaunch",
          ]);
          // The labels are the same four in every stage and carry no version:
          // the panel's title says which update this is, and a label that grew
          // and shrank with the version number was the one row that reflowed.
          expect(await stepLabels(app)).toEqual([
            "Check for an update",
            "Download the update",
            "Stop work in flight",
            "Install and relaunch",
          ]);
          const read = await stepStatuses(app);
          note(`at0612 steps ${stage}`, JSON.stringify(read));
          expect(read).toEqual(statuses);
        }
        // No bar survived the rewrite, in any stage. Addressed by variant
        // rather than by `role="progressbar"`: every step row's dot is a
        // `TugProgressIndicator` and carries that role too, so the role alone
        // would be counting the very rows the bar was replaced by.
        expect(await elementCount(app, `[data-variant="bar"]`)).toBe(0);
        expect(
          await elementCount(app, `${WIZARD} [data-variant="pulsing-dot"]`),
        ).toBe(4);

        // ---- The check row says which Tug you are running ---------------
        //
        // The one fact the panel could not otherwise give them: the title says
        // which flow they are in, never which version is on disk. Same sentence
        // shape at every stage that has something to say — what you have, then
        // what that means for you.
        const detailCases: Array<[string, string]> = [
          ["idle", "You have Tug v0.8.10. Look for a newer version."],
          ["available", "You have Tug v0.8.10. Tug v0.9.0 is available."],
          ["upToDate", "You have the latest version, Tug v0.8.10."],
        ];
        for (const [stage, detail] of detailCases) {
          await goIdle(app);
          await push(app, snapshot(stage, { revealCount: nextReveal() }));
          await waitForWizard(app, stage);
          const read = await checkDetail(app);
          note(`at0612 check detail ${stage}`, read);
          expect(read).toBe(detail);
        }

        // ---- Close then reopen lands on the same step [B04] --------------
        //
        // The wizard holds no flow state of its own: it is a reading of the
        // host's snapshot, so what it shows after a close and a reopen is
        // whatever the flow has reached — here, unchanged, which is the case
        // a wizard with its own step counter would get wrong.
        await goIdle(app);
        await push(app, snapshot("readyToInstall", { revealCount: nextReveal() }));
        await waitForWizard(app, "readyToInstall");
        const beforeClose = await stepStatuses(app);
        await clearPosted(app);
        await waitForClickable(app, CLOSE);
        await app.click(CLOSE);
        await waitForWizardGone(app);
        // Paused, not dismissed: Sparkle was answered nothing and the pill is
        // back, so the update is exactly as live as it was.
        expect(await postedActions(app)).toEqual([]);
        await waitForPill(app, "readyToInstall");
        await waitForClickable(app, PILL);
        await app.click(PILL);
        await waitForWizard(app, "readyToInstall");
        expect(await stepStatuses(app)).toEqual(beforeClose);
        note("at0612 reopen", JSON.stringify(beforeClose));

        // And a stage that moved while the wizard was shut is where it lands.
        await waitForClickable(app, CLOSE);
        await app.click(CLOSE);
        await waitForWizardGone(app);
        await push(app, snapshot("installing", { revealCount: nextReveal() }));
        await waitForWizard(app, "installing");
        expect(await stepStatuses(app)).toEqual(["done", "done", "done", "busy"]);

        // ---- The controls each stage offers, and what they post ---------
        //
        // A click posts and changes nothing else — the recorder swallows the
        // action, so the wizard stays exactly as it is and the next control is
        // ready to press.
        //
        // `install` appears twice and means two different presses: Download at
        // `available`, Install and Relaunch at `readyToInstall`. Only the
        // second one waits on the Stop-work row, and with nothing running in
        // this deck that row is already done — so the install press is offered
        // and posts `install` with nothing in the way, which is the branch
        // asserted here [B04].
        const controlCases: Array<{
          stage: string;
          over?: Partial<Payload>;
          actions: string[];
        }> = [
          { stage: "idle", actions: ["check"] },
          { stage: "checking", over: { cancellable: true }, actions: ["cancel"] },
          { stage: "available", actions: ["install"] },
          { stage: "downloading", over: { cancellable: true }, actions: ["cancel"] },
          { stage: "readyToInstall", actions: ["install"] },
          { stage: "error", over: { message: "the feed did not answer" }, actions: ["retry"] },
          { stage: "extracting", actions: [] },
          { stage: "installing", actions: [] },
        ];

        for (const { stage, over, actions } of controlCases) {
          await goIdle(app);
          await push(
            app,
            snapshot(stage, { ...over, revealCount: nextReveal() }),
          );
          await waitForWizard(app, stage);

          if (actions.length === 0) {
            // A stage with nothing to decide offers nothing to press: the two
            // stages the user can only wait through.
            expect(
              await elementCount(app, `${WIZARD} .update-tug-step button`),
            ).toBe(0);
            note(`at0612 controls ${stage}`, "none");
            continue;
          }

          for (const action of actions) {
            await clearPosted(app);
            const target = cta(action);
            await waitForClickable(app, target);
            await app.click(target);
            try {
              await app.waitForCondition<boolean>(
                `window.__at0612.posted.length > 0`,
                { timeoutMs: 10_000 },
              );
            } catch (err) {
              note(
                `at0612 no post from ${stage}/${action}`,
                await app.evalJS<string>(
                  `(function () {
                     var d = document.querySelector(${JSON.stringify(WIZARD)});
                     var t = document.querySelector(${JSON.stringify(target)});
                     return JSON.stringify({
                       wizardStage: d === null ? null : d.getAttribute("data-stage"),
                       targetFound: t !== null,
                       targetText: t === null ? null : (t.textContent || "").trim(),
                       targetDisabled: t === null ? null : t.disabled,
                     });
                   })()`,
                ),
              );
              throw err;
            }
            note(`at0612 posted`, `${stage}/${action}`);
            expect(await postedActions(app)).toEqual([action]);
            // A press posts and nothing more: the wizard it was pressed in is
            // still open, on the stage it was pressed on [B04].
            expect(await elementCount(app, WIZARD)).toBe(1);
          }
        }

        // ---- Retry survives the host's `idle` waypoint ------------------
        //
        // The host answers `retry` by acknowledging the old notice, publishing
        // `dismissed` — a real `idle` snapshot, which the deck really receives
        // — and only then starting the check that lands on `checking`. The
        // wizard closes itself on `idle`, because `idle` is normally the flow
        // being over; read literally that rule takes the whole surface away in
        // answer to the one press that asked for the opposite, and nothing
        // brings it back, since the pill does not show for `checking`.
        //
        // Nothing above catches this: the recorder swallows the action, so no
        // test that only presses Retry ever sees the snapshots the host would
        // have sent. This one plays them.
        await goIdle(app);
        await clearPosted(app);
        await push(
          app,
          snapshot("error", {
            message: "the feed did not answer",
            revealCount: nextReveal(),
          }),
        );
        await waitForWizard(app, "error");
        await waitForClickable(app, cta("retry"));
        await app.click(cta("retry"));
        await app.waitForCondition<boolean>(
          `window.__at0612.posted.length > 0`,
          { timeoutMs: 10_000 },
        );
        expect(await postedActions(app)).toEqual(["retry"]);

        // The waypoint, then the check it was on the way to.
        await push(app, snapshot("idle"));
        await letTimePass(app, 400);
        expect(await elementCount(app, WIZARD)).toBe(1);
        await push(app, snapshot("checking", { cancellable: true }));
        await waitForWizard(app, "checking");
        note("at0612 retry", "survives the idle waypoint and lands on checking");

        // And the suppression is spent: the next `idle` is the flow ending,
        // and it closes the wizard the way every other `idle` does.
        await push(app, snapshot("idle"));
        await waitForWizardGone(app);

        // ---- The two terminal stages acknowledge, and only those ---------
        //
        // Sparkle will not finish its session without a reply to a notice, so
        // `upToDate` and `error` send `dismiss` on the way out. Every other
        // stage's Close sends nothing, which is what makes closing a pause.
        for (const [stage, label] of [
          ["upToDate", "Done"],
          ["error", "Dismiss"],
        ] as Array<[string, string]>) {
          await goIdle(app);
          await clearPosted(app);
          await push(
            app,
            snapshot(stage, {
              message: "the feed did not answer",
              revealCount: nextReveal(),
            }),
          );
          await waitForWizard(app, stage);
          expect(await app.getElementText(CLOSE)).toContain(label);
          await waitForClickable(app, CLOSE);
          await app.click(CLOSE);
          await waitForWizardGone(app);
          expect(await postedActions(app)).toEqual(["dismiss"]);
          note(`at0612 terminal ${stage}`, `${label} posts dismiss`);
        }

        // ---- Progress is words, and never a render [L06] ----------------
        await goIdle(app);
        await push(
          app,
          snapshot("downloading", {
            percent: null,
            cancellable: true,
            revealCount: nextReveal(),
          }),
        );
        await waitForWizard(app, "downloading");
        // No total yet: no attribute, and a phrase rather than a number,
        // because `null` is not zero.
        expect(
          await app.getElementAttribute(PROGRESS, "data-progress"),
        ).toBeNull();
        expect(await app.getElementText(PROGRESS)).toContain("Starting");

        for (const percent of [7, 42, 99]) {
          await push(app, snapshot("downloading", { percent, cancellable: true }));
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(PROGRESS)})
                ?.getAttribute("data-progress")) === ${JSON.stringify(String(percent))}`,
            { timeoutMs: 10_000 },
          );
          const text = await app.getElementText(PROGRESS);
          note(`at0612 progress ${percent}%`, text);
          expect(text).toContain(`${percent}%`);
        }
        // The panel has not been re-rendered out from under itself: the span
        // that was there at 7% is the span that is there at 99%.
        expect(await elementCount(app, PROGRESS)).toBe(1);
        expect(await elementCount(app, WIZARD)).toBe(1);

        // ---- The pill's `x` hides, and hides only -----------------------
        //
        // It answers Sparkle nothing — no action crosses the bridge — so the
        // update stays as live as it was and the host's stage is untouched.
        // `dismiss` could not have done this job: it is already a Sparkle
        // reply, and it ends the session.
        await goIdle(app);
        await push(app, snapshot("available"));
        await waitForPill(app, "available");
        await clearPosted(app);
        await waitForClickable(app, PILL_HIDE);
        await app.click(PILL_HIDE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PILL_ANCHOR)}) === null`,
          { timeoutMs: 10_000 },
        );
        expect(await postedActions(app)).toEqual([]);

        // A hidden pill stays hidden across a stage transition: a hide the
        // next transition undid would be worth nothing at the stages a user
        // reaches for it.
        await push(app, snapshot("readyToInstall"));
        await letTimePass(app, 500);
        expect(await elementCount(app, PILL_ANCHOR)).toBe(0);
        expect(await postedActions(app)).toEqual([]);

        // The menu door still works over a hidden pill — which is the case
        // hiding has to leave intact, since the pill is the only other way in.
        await push(app, snapshot("readyToInstall", { revealCount: nextReveal() }));
        await waitForWizard(app, "readyToInstall");
        await waitForClickable(app, CLOSE);
        await app.click(CLOSE);
        await waitForWizardGone(app);

        // And the host saying there is nothing to say, then something new,
        // brings the pill back: hidden belongs to this flow, not to the deck.
        await goIdle(app);
        await push(app, snapshot("available"));
        await waitForPill(app, "available");
        note("at0612 hide", "x hides for this flow, posts nothing, survives the next stage");

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

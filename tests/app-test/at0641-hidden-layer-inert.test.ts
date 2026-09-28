/**
 * at0641 — a hidden workspace is laid out, and inert.
 *
 * `space-layer.css` no longer hides a parked workspace with `display: none`.
 * The wrapper is `visibility: hidden` with `content-visibility: hidden` over
 * its contents, so the subtree keeps its layout and its render state and the
 * re-show is not a rebuild ([B02]). That trade is only sound if everything
 * `display: none` used to give for free is still true, and none of it is true
 * by construction any more — so each one is a leg here, read off the live deck
 * rather than off the stylesheet.
 *
 * ## The four things a hidden workspace must still not do
 *
 *  1. **Paint.** Every pane under a hidden layer has a real box — that is the
 *     point, and it is asserted positively — and every one of them reports
 *     `checkVisibility()` false. A box that is laid out and not painted is the
 *     whole shape.
 *  2. **Take the pointer.** `document.elementFromPoint` over the centre and
 *     the title bar of every hidden pane never answers with an element inside
 *     a hidden layer. `visibility: hidden` and `content-visibility: hidden`
 *     each say so on their own; the reading is what says they said so here.
 *  3. **Take focus.** After a switch nothing in a hidden layer is the active
 *     element, and a hidden editor `.focus()`ed by hand does not become one —
 *     the composer in a parked workspace cannot be typed into by a script
 *     that found it.
 *  4. **Move.** A loop on an element under a hidden layer is `paused` and the
 *     same loop under the shown layer is `running`. `display: none` stilled a
 *     hidden workspace's loops for free; what does it now is
 *     `space-layer-loops.ts`, from the canvas's switch effect and a delegated
 *     `animationstart` listener, and this is its proof on the live deck. The
 *     loop is a probe installed by the test AFTER the switch — so the hidden
 *     one starts in the dark, which is the listener's case rather than the
 *     effect's — because the fixture's Text cards carry no loop of their own
 *     and the claim is about the mechanism rather than about any component.
 *
 * And the one that was never about geometry:
 *
 *  5. **Answer a broadcast.** A `Workspaces` card stands in every mounted
 *     workspace, and a Delete Workspace request is a broadcast rather than a
 *     chain dispatch. `useSpaceLayerShown()` in `cards-card.tsx` is what keeps
 *     the parked one quiet, and it reads a React context rather than the
 *     stylesheet — so it is unaffected by the CSS change in principle and
 *     asserted anyway: exactly one confirm, and the workspace count unchanged.
 *
 * ## What is deliberately not here
 *
 * The first-mount fade — a Session card mounted into a hidden layer and then
 * shown, with no inline `opacity` and a computed 1 — is `at0589`'s subject,
 * and `at0589` passing UNEDITED under the new hiding rule is that leg re-run
 * against the new mechanism. Restating it here would be a second copy of one
 * claim, and it would name `session-card.tsx`, which sits at the fan-out
 * ceiling in `select-tests.ts` for exactly this reason.
 *
 * ## Why boxes are asserted rather than tolerated
 *
 * `at0587`'s leg 4 used to assert that hidden panes had no client rects. That
 * was a pin on `display: none`'s side-effect, not on [B06]'s decision — which
 * was that a visited workspace stays MOUNTED and is not rebuilt. Leg 1 here is
 * the replacement: laid out, and not painted. If a future change hides the
 * layer with `display: none` again, leg 1 goes red on the box count, which is
 * the right thing — the render state [B02] keeps would have been thrown away.
 *
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tugdeck/src/components/chrome/space-layer-loops.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SPACE_ONE = "at0641-one";
const SPACE_TWO = "at0641-two";

const SHOWN_LAYER = "[data-space-layer][data-space-shown]";
const HIDDEN_LAYER = "[data-space-layer]:not([data-space-shown])";
const SHOWN_FRAMES = `${SHOWN_LAYER} .tug-pane[data-pane-id]`;
const CONFIRM = '[data-slot="tug-confirm-popover"]';

/** The probe loop leg 4 installs. Named so a leaked one is recognisable. */
const PROBE_CLASS = "at0641-probe-spin";
const PROBE_STYLE_ID = "at0641-probe-style";

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The fixture — at0640's shape, under its own ids
// ---------------------------------------------------------------------------

const railPane = (id: string, cardId: string): Record<string, unknown> => ({
  id,
  position: { x: 0, y: 0 },
  size: { width: 420, height: 900 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: [] as string[],
});

const contentPane = (
  id: string,
  cardId: string,
  y: number,
): Record<string, unknown> => ({
  id,
  position: { x: 60, y },
  size: { width: 700, height: 360 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: ["standard"],
});

/**
 * Two workspaces, each with a Workspaces rail and two Text cards. The Text
 * cards are what give leg 3 an editor to try to focus in the dark, and the two
 * Workspaces cards are what leg 5 is about.
 */
function twoSpaceBlob(): Record<string, unknown> {
  const deck = (
    cardsId: string,
    railId: string,
    textIds: readonly string[],
    paneBase: string,
  ): Record<string, unknown> => ({
    cards: [
      { id: cardsId, componentId: "cards", title: "Workspaces", closable: true },
      ...textIds.map((id) => ({
        id,
        componentId: "text",
        title: id,
        closable: true,
      })),
    ],
    panes: [
      railPane(railId, cardsId),
      ...textIds.map((id, i) => contentPane(`${paneBase}${i}`, id, 40 + i * 300)),
    ],
    activePaneId: `${paneBase}0`,
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  });
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      {
        id: SPACE_ONE,
        name: "One",
        deck: deck("at0641-c1", "at0641-pc1", ["at0641-t1a", "at0641-t1b"], "at0641-pa"),
      },
      {
        id: SPACE_TWO,
        name: "Two",
        deck: deck("at0641-c2", "at0641-pc2", ["at0641-t2a", "at0641-t2b"], "at0641-pb"),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The readings
// ---------------------------------------------------------------------------

interface LayoutReading {
  layers: number;
  hiddenLayers: number;
  hiddenPanes: number;
  hiddenPanesWithBoxes: number;
  hiddenPanesVisible: number;
  shownPanes: number;
  shownPanesVisible: number;
  /** The hidden wrapper's computed display / visibility / content-visibility. */
  hiddenWrapper: string[];
}

const LAYOUT_READ = `(function () {
  var layers = Array.prototype.slice.call(document.querySelectorAll("[data-space-layer]"));
  var hidden = layers.filter(function (l) { return !l.hasAttribute("data-space-shown"); });
  var shown = layers.filter(function (l) { return l.hasAttribute("data-space-shown"); });
  var panesIn = function (els) {
    var out = [];
    els.forEach(function (l) {
      out = out.concat(Array.prototype.slice.call(l.querySelectorAll(".tug-pane[data-pane-id]")));
    });
    return out;
  };
  var hp = panesIn(hidden);
  var sp = panesIn(shown);
  var visible = function (el) { return el.checkVisibility ? el.checkVisibility() : null; };
  var cs = hidden.length > 0 ? window.getComputedStyle(hidden[0]) : null;
  return {
    layers: layers.length,
    hiddenLayers: hidden.length,
    hiddenPanes: hp.length,
    hiddenPanesWithBoxes: hp.filter(function (p) { return p.getClientRects().length > 0; }).length,
    hiddenPanesVisible: hp.filter(function (p) { return visible(p) === true; }).length,
    shownPanes: sp.length,
    shownPanesVisible: sp.filter(function (p) { return visible(p) === true; }).length,
    hiddenWrapper: cs === null ? [] : [cs.display, cs.visibility, cs.contentVisibility, cs.pointerEvents]
  };
})()`;

interface PointerReading {
  probes: number;
  hitsInsideHidden: number;
  hitsInsideShown: number;
  hitsOnWrapper: number;
}

const POINTER_READ = `(function () {
  var hidden = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(HIDDEN_LAYER)}));
  var shown = document.querySelector(${JSON.stringify(SHOWN_LAYER)});
  var r = { probes: 0, hitsInsideHidden: 0, hitsInsideShown: 0, hitsOnWrapper: 0 };
  hidden.forEach(function (l) {
    var panes = l.querySelectorAll(".tug-pane[data-pane-id]");
    for (var i = 0; i < panes.length; i++) {
      var b = panes[i].getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      var points = [
        [b.left + b.width / 2, b.top + b.height / 2],
        [b.left + b.width / 2, b.top + 10]
      ];
      for (var p = 0; p < points.length; p++) {
        var x = points[p][0], y = points[p][1];
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
        r.probes += 1;
        var hit = document.elementFromPoint(x, y);
        if (hit === null) continue;
        if (hidden.some(function (h) { return h === hit; })) r.hitsOnWrapper += 1;
        else if (hidden.some(function (h) { return h.contains(hit); })) r.hitsInsideHidden += 1;
        else if (shown !== null && shown.contains(hit)) r.hitsInsideShown += 1;
      }
    }
  });
  return r;
})()`;

interface FocusReading {
  activeInHiddenBefore: boolean;
  hiddenEditorFound: boolean;
  activeInHiddenAfterFocus: boolean;
  activeTagAfterFocus: string | null;
}

const FOCUS_READ = `(function () {
  var hidden = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(HIDDEN_LAYER)}));
  var inHidden = function (el) {
    return el !== null && hidden.some(function (h) { return h.contains(el); });
  };
  var before = inHidden(document.activeElement);
  var editor = null;
  for (var i = 0; i < hidden.length && editor === null; i++) {
    editor = hidden[i].querySelector(".cm-content, textarea, [contenteditable=true], button");
  }
  if (editor !== null) editor.focus();
  var after = document.activeElement;
  return {
    activeInHiddenBefore: before,
    hiddenEditorFound: editor !== null,
    activeInHiddenAfterFocus: inHidden(after),
    activeTagAfterFocus: after === null ? null : after.tagName
  };
})()`;

interface MotionReading {
  installed: number;
  hiddenStates: string[];
  shownStates: string[];
  hiddenTransition: string | null;
  shownTransition: string | null;
}

/** Install one infinite CSS loop on the first pane of every layer. */
const PROBE_INSTALL = `(function () {
  var style = document.getElementById(${JSON.stringify(PROBE_STYLE_ID)});
  if (style === null) {
    style = document.createElement("style");
    style.id = ${JSON.stringify(PROBE_STYLE_ID)};
    style.textContent =
      "@keyframes " + ${JSON.stringify(PROBE_CLASS)} + " { from { outline-offset: 0px } to { outline-offset: 1px } }" +
      "." + ${JSON.stringify(PROBE_CLASS)} + " { animation: " + ${JSON.stringify(PROBE_CLASS)} + " 1s linear infinite }";
    document.head.appendChild(style);
  }
  var layers = document.querySelectorAll("[data-space-layer]");
  var n = 0;
  for (var i = 0; i < layers.length; i++) {
    var pane = layers[i].querySelector(".tug-pane[data-pane-id]");
    if (pane !== null) { pane.classList.add(${JSON.stringify(PROBE_CLASS)}); n += 1; }
  }
  return n;
})()`;

const MOTION_READ = `(function () {
  var hidden = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(HIDDEN_LAYER)}));
  var shown = document.querySelector(${JSON.stringify(SHOWN_LAYER)});
  var r = { installed: 0, hiddenStates: [], shownStates: [], hiddenTransition: null, shownTransition: null };
  document.getAnimations().forEach(function (a) {
    var t = a.effect && a.effect.target;
    if (!t || !t.classList || !t.classList.contains(${JSON.stringify(PROBE_CLASS)})) return;
    r.installed += 1;
    if (hidden.some(function (h) { return h.contains(t); })) r.hiddenStates.push(a.playState);
    else if (shown !== null && shown.contains(t)) r.shownStates.push(a.playState);
  });
  var hp = hidden.length > 0 ? hidden[0].querySelector(".tug-pane[data-pane-id]") : null;
  var sp = shown === null ? null : shown.querySelector(".tug-pane[data-pane-id]");
  if (hp !== null) r.hiddenTransition = window.getComputedStyle(hp).transitionProperty;
  if (sp !== null) r.shownTransition = window.getComputedStyle(sp).transitionProperty;
  return r;
})()`;

const PROBE_REMOVE = `(function () {
  var style = document.getElementById(${JSON.stringify(PROBE_STYLE_ID)});
  if (style !== null) style.remove();
  var marked = document.querySelectorAll("." + ${JSON.stringify(PROBE_CLASS)});
  for (var i = 0; i < marked.length; i++) marked[i].classList.remove(${JSON.stringify(PROBE_CLASS)});
  return marked.length;
})()`;

async function activate(app: App, spaceId: string): Promise<void> {
  await app.evalJS<null>(
    `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(spaceId)}`,
    { timeoutMs: 15_000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0641 — a hidden workspace is laid out, and inert",
  () => {
    test(
      "laid out and unpainted; no pointer, no focus, no motion, no broadcast answered",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(twoSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: "at0641-hidden-layer-inert",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 3`,
            { timeoutMs: 30_000 },
          );
          await settle(800);

          // Visit the parked workspace once so both are mounted, then come
          // back. Every reading below is taken with ONE shown and TWO hidden.
          await activate(app, SPACE_TWO);
          await settle(800);
          await activate(app, SPACE_ONE);
          await settle(800);

          // ---- 1. Laid out, and not painted. ------------------------------
          const layout = await app.evalJS<LayoutReading>(LAYOUT_READ);
          note(`at0641 layout: ${JSON.stringify(layout)}`);
          expect(layout.layers, "both workspaces are mounted").toBe(2);
          expect(layout.hiddenLayers, "exactly one is hidden").toBe(1);
          expect(
            layout.hiddenWrapper,
            "the hidden wrapper is a box, hidden, with its contents skipped and no pointer",
          ).toEqual(["block", "hidden", "hidden", "none"]);
          expect(layout.hiddenPanes, "the hidden workspace's panes are standing").toBeGreaterThan(0);
          expect(
            layout.hiddenPanesWithBoxes,
            "every hidden pane keeps its box — the render state [B02] keeps",
          ).toBe(layout.hiddenPanes);
          expect(
            layout.hiddenPanesVisible,
            "and none of them reports itself visible",
          ).toBe(0);
          expect(layout.shownPanes).toBeGreaterThan(0);
          expect(
            layout.shownPanesVisible,
            "every shown pane reports itself visible — the reading is not vacuous",
          ).toBe(layout.shownPanes);

          // ---- 2. The pointer never reaches it. ---------------------------
          const pointer = await app.evalJS<PointerReading>(POINTER_READ);
          note(`at0641 pointer: ${JSON.stringify(pointer)}`);
          expect(pointer.probes, "hidden panes were probed").toBeGreaterThan(0);
          expect(
            pointer.hitsInsideHidden,
            "no probe over a hidden pane answered with an element inside a hidden layer",
          ).toBe(0);
          expect(
            pointer.hitsOnWrapper,
            "and none answered with the hidden wrapper itself — its box is not a target",
          ).toBe(0);

          // ---- 3. Focus cannot land in it. --------------------------------
          const focus = await app.evalJS<FocusReading>(FOCUS_READ);
          note(`at0641 focus: ${JSON.stringify(focus)}`);
          expect(
            focus.activeInHiddenBefore,
            "after the switch the active element is not in a hidden layer",
          ).toBe(false);
          expect(focus.hiddenEditorFound, "a hidden editor was there to try").toBe(true);
          expect(
            focus.activeInHiddenAfterFocus,
            "a hidden editor focused by hand does not become the active element",
          ).toBe(false);

          // ---- 4. Nothing moves in the dark. ------------------------------
          const installed = await app.evalJS<number>(PROBE_INSTALL);
          expect(installed, "one probe loop per layer").toBe(2);
          await settle(150);
          const motion = await app.evalJS<MotionReading>(MOTION_READ);
          note(`at0641 motion: ${JSON.stringify(motion)}`);
          await app.evalJS<number>(PROBE_REMOVE);
          expect(motion.installed, "both probe loops were seen by the engine").toBe(2);
          expect(
            motion.hiddenStates,
            "the loop under the hidden layer is paused",
          ).toEqual(["paused"]);
          expect(
            motion.shownStates,
            "the same loop under the shown layer runs — the pause is the layer's, not the page's",
          ).toEqual(["running"]);

          // ---- 5. A broadcast is answered once. ---------------------------
          await app.dispatchControlAction("delete-space");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
            { timeoutMs: 15_000 },
          );
          await settle(300);
          const confirms = await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(CONFIRM)}).length`,
          );
          const spaces = await app.evalJS<number>(
            `window.tugdeck.diag.getSpaces().spaces.length`,
          );
          note(`at0641 broadcast: confirms=${confirms} spaces=${spaces}`);
          expect(
            confirms,
            "exactly one Workspaces card answered the Delete request — the shown one",
          ).toBe(1);
          expect(spaces, "the confirm is a question, not a receipt").toBe(2);
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
            { timeoutMs: 8_000 },
          );
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

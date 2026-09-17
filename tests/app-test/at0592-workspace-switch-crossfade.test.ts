/**
 * at0592-workspace-switch-crossfade.test.ts — a workspace switch is not an
 * arrangement change, and it dissolves rather than crossfades.
 *
 * Crossing from one workspace to another used to blink through a blank canvas.
 * Not because anything was slow: because of one word. The switch commit landed
 * `"cross"`, the canvas's spelling for an ordinary arrangement change, and the
 * settle gave it the treatment that spelling earns — a departure ghost for
 * every pane of the workspace being left, then every incoming frame held at
 * `opacity: 0` for its arrive beat. But the panes do not move across a switch.
 * Both sets of frames are already drawn exactly where the commit puts them,
 * which is what `"cut"` means, and a `"cut"` arm takes the new arrangement as
 * its baseline and launches no settle at all.
 *
 * What replaces the blink is one DISSOLVE — and the difference between that
 * and a crossfade is the second thing this file is for. A crossfade dips both
 * layers through partial opacity at once, so for the middle of the beat every
 * pixel is part one workspace, part the other, and part canvas ground showing
 * between them. Anything the two workspaces have in common — the same rail in
 * the same place, the same card at the same seat — went translucent on its way
 * to being itself again. A dissolve moves one layer: the workspace being left
 * is painted OVER the one arriving, at `--tug-z-space-crossing`, and only its
 * own opacity is tweened, 1 to 0. The arriving workspace is opaque underneath
 * from the first frame and is never touched, so a pixel the same on both sides
 * is `t·C + (1−t)·C` — which is `C`, at every instant of the beat.
 *
 * For that beat, and only that beat, the outgoing wrapper carries
 * `data-space-crossing`: a box of its own (the canvas container's own box, so
 * nothing under it moves), one z-index above every rail the arriving workspace
 * owns, one opacity for the whole departing picture, and `pointer-events:
 * none`. The wrapper is `display: none` at rest, so the beat is a debt, and
 * `[L32]` is the law it is held to — one owner writes both states, and the
 * hand-back carries a deadline rather than resting on a completion handler
 * that a mid-beat unmount would never fire.
 *
 * The legs, in the order the test walks them. The first reads the decision out
 * of the trace — `landing: "cut"`, `outcome: "declined"`. The rest read the
 * canvas itself, sampling on a timer rather than on `requestAnimationFrame`
 * because a covered harness window suspends rAF and a sampler that never runs
 * would report a clean switch no matter what happened: no ghost was minted;
 * no shown frame was ever held at an inline `opacity` of `"0"`; both layers
 * carried painted boxes at some sample; the ARRIVING workspace computed a full
 * opacity at every sample of the beat and the departing layer stood above it;
 * the crossing layer was inert to the pointer at every sample it was seen; the
 * attribute was gone inside a bound; a beat interrupted by a second switch
 * still landed and left no inline residue; and with motion off the attribute
 * is never written at all.
 *
 * The opaque-arrival leg is the dissolve's own. A crossfade passes this file's
 * other legs unchanged — it too paints both layers, inertly, for a bounded
 * beat — and fails only that one, because a crossfade's arriving frames are
 * mid-tween and read back a computed opacity between zero and one.
 *
 * The held-at-zero leg is the one that says which of the two shapes is on
 * screen. A crossfade animates FROM zero with `fill: "none"` and writes no
 * inline style at all, so an inline `opacity: "0"` on a shown frame is the
 * blank this arc removed rather than the beat it added.
 *
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tugdeck/src/components/chrome/space-layer.css
 *
 * Two files this test genuinely exercises are deliberately NOT declared here:
 * `deck-canvas.tsx`, which owns the settle arm the first leg reads, and
 * `deck-manager.ts`, which owns the commit that spells the landing. Both sit
 * at the selection ratchet's accepted width already (22 and 21 tests), and
 * that ratchet pays down only — a line here would push one of them past its
 * budget and turn `app-test-changed` into a sweep for anybody editing it. The
 * `space-layer` pair is declared instead, and both of those move in the
 * crossfade work this file is written to carry, so the selector still reaches
 * this test from the change that would break it.
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SPACE_ONE = "at0592-one";
const SPACE_TWO = "at0592-two";

/** The panes on screen — the shown layer's, and only those. */
const SHOWN_FRAMES =
  '[data-space-layer][data-space-shown] .tug-pane[data-pane-id]';
const GHOST = ".tug-pane-exit-ghost";
/** The wrapper wearing the crossfade's one beat. */
const CROSSING_LAYERS = ".tug-space-layer[data-space-crossing]";
/** The wrapper the switch is arriving in — the one that must never fade. */
const SHOWN_LAYER = "[data-space-layer][data-space-shown]";
/** Every pane frame in the document, crossing layer included. */
const ALL_FRAMES = ".tug-pane[data-pane-id]";

/**
 * How long the attribute may stand. The beat is `divide-join` at 0.6× the
 * settle nominal — a few hundred ms — plus the deadline's own margin, so this
 * is generous by several multiples and still catches the failure it is for: a
 * beat that never lands leaves the attribute on forever.
 */
const CROSSING_BOUND_MS = 1_500;

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface ArmRecord {
  kind: string;
  landing: string;
  outcome: string;
  panes: number;
}

interface Sample {
  samples: number;
  ghosts: number;
  zero: number;
  /** The most layers seen carrying `data-space-crossing` at one sample. */
  crossing: number;
  /** Samples at which any layer was crossing. */
  crossLive: number;
  /** Of those, the ones where every crossing layer computed `pointer-events: none`. */
  crossInert: number;
  /** Of those, the ones where a crossing layer's pane had a box with area. */
  crossPainted: number;
  /**
   * Of those, the ones where the ARRIVING workspace was fully opaque — every
   * shown frame and the shown wrapper computing `opacity: 1`. The dissolve's
   * own reading: a crossfade would have been mid-tween here.
   */
  crossOpaqueArrival: number;
  /** Of those, the ones where the crossing layer's z stood over every shown frame's. */
  crossAbove: number;
  /** Of those, the ones where the crossing layer had actually begun to dissolve. */
  crossFading: number;
  /** First and last sample times the attribute was seen, in ms. */
  firstCross: number;
  lastCross: number;
}

/**
 * The sampler, installed before the switch and read after it.
 *
 * `setInterval` rather than `requestAnimationFrame`: a covered harness window
 * suspends rAF, and a sampler that never ran would report zero ghosts and zero
 * held frames whatever the switch actually did — a green that measures
 * nothing. The sample count is asserted for the same reason.
 */
const SAMPLER_START = `(function () {
  var s = {
    samples: 0, ghosts: 0, zero: 0,
    crossing: 0, crossLive: 0, crossInert: 0, crossPainted: 0,
    crossOpaqueArrival: 0, crossAbove: 0, crossFading: 0,
    firstCross: 0, lastCross: 0,
  };
  window.__at0592 = s;
  s.timer = setInterval(function () {
    s.samples += 1;
    var ghosts = document.querySelectorAll(${JSON.stringify(GHOST)}).length;
    if (ghosts > s.ghosts) s.ghosts = ghosts;
    var frames = document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)});
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].style.opacity === "0") s.zero += 1;
    }
    var crossing = document.querySelectorAll(${JSON.stringify(CROSSING_LAYERS)});
    if (crossing.length > s.crossing) s.crossing = crossing.length;
    if (crossing.length === 0) return;
    var now = Date.now();
    if (s.firstCross === 0) s.firstCross = now;
    s.lastCross = now;
    s.crossLive += 1;
    var inert = true;
    var painted = false;
    for (var j = 0; j < crossing.length; j++) {
      // The wrapper itself, not its panes: the rule sets the property here and
      // inheritance carries it, and a pane that set its own would be a
      // different finding than the one this leg is for.
      if (getComputedStyle(crossing[j]).pointerEvents !== "none") inert = false;
      var panes = crossing[j].querySelectorAll(${JSON.stringify(ALL_FRAMES)});
      for (var k = 0; k < panes.length; k++) {
        var r = panes[k].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) painted = true;
      }
    }
    if (inert) s.crossInert += 1;
    if (painted) s.crossPainted += 1;
    // ---- The dissolve's own three readings. ------------------------------
    // The arriving workspace is not animated at all, so every frame of it —
    // and the wrapper over them — computes a flat 1 for the whole beat. A
    // crossfade reads back a fraction here and nowhere else in this sampler.
    var opaque = true;
    if (getComputedStyle(document.querySelector(${JSON.stringify(SHOWN_LAYER)}) || document.body).opacity !== "1") {
      opaque = false;
    }
    for (var m = 0; m < frames.length; m++) {
      if (getComputedStyle(frames[m]).opacity !== "1") opaque = false;
    }
    if (opaque) s.crossOpaqueArrival += 1;
    // Over, not under: the departing picture has to cover the arriving one's
    // rails too, or the rail strip would cut while the rest dissolved.
    var ceiling = -Infinity;
    for (var n = 0; n < frames.length; n++) {
      var fz = parseInt(getComputedStyle(frames[n]).zIndex, 10);
      if (!isNaN(fz) && fz > ceiling) ceiling = fz;
    }
    var above = true;
    var fading = false;
    for (var p = 0; p < crossing.length; p++) {
      var cs = getComputedStyle(crossing[p]);
      var cz = parseInt(cs.zIndex, 10);
      if (isNaN(cz) || cz <= ceiling) above = false;
      if (parseFloat(cs.opacity) < 1) fading = true;
    }
    if (above) s.crossAbove += 1;
    if (fading) s.crossFading += 1;
  }, 8);
  return null;
})()`;

const SAMPLER_READ = `(function () {
  var s = window.__at0592;
  clearInterval(s.timer);
  return {
    samples: s.samples, ghosts: s.ghosts, zero: s.zero,
    crossing: s.crossing, crossLive: s.crossLive,
    crossInert: s.crossInert, crossPainted: s.crossPainted,
    crossOpaqueArrival: s.crossOpaqueArrival,
    crossAbove: s.crossAbove, crossFading: s.crossFading,
    firstCross: s.firstCross, lastCross: s.lastCross,
  };
})()`;

/**
 * Every inline `opacity` residue on a layer wrapper or a pane frame, anywhere
 * in the document.
 *
 * The dissolve takes an `inlineRestorer` on the departing WRAPPER before it
 * tweens, so the value the animator commits on completion is owed back
 * whichever way the beat ends. That wrapper is where the residue would now be,
 * and it is what this reads. The frames are swept too, still: they are where
 * the residue used to be, and a sweep that stopped looking there would stop
 * reporting a regression to the shape this file just left.
 */
const OPACITY_RESIDUE = `(function () {
  var out = [];
  var layers = document.querySelectorAll("[data-space-layer]");
  for (var j = 0; j < layers.length; j++) {
    var lv = layers[j].style.opacity;
    if (lv !== "") out.push(layers[j].getAttribute("data-space-layer") + "=" + lv);
  }
  var frames = document.querySelectorAll(${JSON.stringify(ALL_FRAMES)});
  for (var i = 0; i < frames.length; i++) {
    var v = frames[i].style.opacity;
    if (v !== "") out.push(frames[i].getAttribute("data-pane-id") + "=" + v);
  }
  return out;
})()`;

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
 * Two workspaces, each holding several panes.
 *
 * Several rather than one on purpose: the defect is a MASS departure and a
 * mass arrival, so a fixture with one pane a side could report zero ghosts by
 * accident of timing. Each workspace stands its own Workspaces card, so the
 * card is on screen whichever one the switch lands in.
 */
function twoSpaceBlob(): Record<string, unknown> {
  const deck = (
    cardsId: string,
    railId: string,
    texts: string[],
    paneBase: string,
  ): Record<string, unknown> => ({
    cards: [
      { id: cardsId, componentId: "cards", title: "Workspaces", closable: true },
      ...texts.map((id) => ({
        id,
        componentId: "text",
        title: id,
        closable: true,
      })),
    ],
    panes: [
      railPane(railId, cardsId),
      ...texts.map((id, i) => contentPane(`${paneBase}${i}`, id, 40 + i * 60)),
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
        deck: deck("C1", "pc1", ["A1", "A2", "A3"], "pa"),
      },
      {
        id: SPACE_TWO,
        name: "Two",
        deck: deck("C2", "pc2", ["B1", "B2", "B3"], "pb"),
      },
    ],
  };
}

describe.skipIf(!SHOULD_RUN)(
  "at0592 — a workspace switch lands as a cut, and crosses as one fade",
  () => {
    test(
      "the settle declines the switch, the canvas never blanks, and the crossfade lands",
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
          testName: "at0592-workspace-switch-crossfade",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 4`,
            { timeoutMs: 25_000 },
          );
          await settle();

          const mark = await app.evalJS<number>(
            `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
          );
          await app.evalJS<null>(SAMPLER_START);
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_TWO)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_TWO)}`,
            { timeoutMs: 10_000 },
          );
          // ---- The window is bounded. --------------------------------------
          // Asserted by waiting rather than by measuring afterwards: a beat
          // that never lands leaves the attribute standing, and this wait is
          // what turns that into a red instead of a reading nobody takes.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(CROSSING_LAYERS)}).length === 0`,
            { timeoutMs: CROSSING_BOUND_MS },
          );
          // Past any beat the switch could have launched — the settle's own
          // recipes are well under this — so the sampler has seen whatever
          // there was to see.
          await settle(900);
          const sample = await app.evalJS<Sample>(SAMPLER_READ);
          // Noted before any assertion, so a failure in the trace leg below
          // still carries what the canvas actually did across the switch.
          note(`at0592 sampler across the switch: ${JSON.stringify(sample)}`);

          // ---- 1. The settle declined. ------------------------------------
          const arms = await app.evalJS<ArmRecord[]>(
            `window.__deckTrace.since(${mark})
               .filter(function (e) { return e.kind === "settle-arm"; })
               .map(function (e) {
                 return { kind: e.kind, landing: e.landing, outcome: e.outcome, panes: e.panes };
               })`,
          );
          note(`at0592 settle arms across the switch: ${JSON.stringify(arms)}`);
          const cut = arms.filter((a) => a.landing === "cut");
          expect(
            cut.length,
            "the switch commit reached the canvas spelled as a cut",
          ).toBeGreaterThan(0);
          for (const arm of cut) {
            expect(
              arm.outcome,
              "and a cut arm takes the new arrangement as its baseline rather than carrying it",
            ).toBe("declined");
          }
          // Nothing in this gesture landed as an arrangement change, which is
          // the claim: a switch is not one.
          expect(
            arms.filter((a) => a.landing === "cross" && a.outcome === "carried"),
            "no part of the switch was carried as an arrangement change",
          ).toEqual([]);

          // ---- 2. No ghost was ever minted. -------------------------------
          expect(
            sample.samples,
            "the sampler ran at all — otherwise the two readings below mean nothing",
          ).toBeGreaterThan(10);
          expect(
            sample.ghosts,
            "no departure ghost was minted for the workspace being left",
          ).toBe(0);

          // ---- 3. No frame was held at zero. ------------------------------
          // The leg a crossfade has to keep true: a fade animates FROM zero,
          // it does not rest there, so an inline `opacity: "0"` on a frame is
          // the blank this arc is removing rather than the beat it wants.
          expect(
            sample.zero,
            "no incoming frame was held at opacity 0 waiting for an arrive beat",
          ).toBe(0);

          // ---- 4. Both layers were painted, briefly. ----------------------
          // The crossfade's whole claim: for one beat the workspace being left
          // is still on screen, with boxes, over the one arriving.
          expect(
            sample.crossPainted,
            "the outgoing layer carried painted pane boxes while it crossed",
          ).toBeGreaterThan(0);
          expect(
            sample.crossing,
            "and exactly one layer crossed at a time — the shown one never wears it",
          ).toBe(1);

          // ---- 4b. The arriving one was never faded. ----------------------
          // The dissolve's own leg, and the only one a crossfade fails. One
          // layer is animated; the workspace arriving stands opaque underneath
          // it from the first frame, which is what makes a card in the same
          // seat in both workspaces appear not to move at all.
          expect(
            sample.crossOpaqueArrival,
            "the arriving workspace computed a full opacity at every sample of the beat",
          ).toBe(sample.crossLive);
          // And underneath: the departing picture covers the arriving one's
          // rails as well as its cards, or the rail strip would cut while the
          // rest of the canvas dissolved.
          expect(
            sample.crossAbove,
            "the crossing layer stood above every shown frame at every sample",
          ).toBe(sample.crossLive);
          // A cut would pass both of the above by doing nothing. This is what
          // says a dissolve actually ran.
          expect(
            sample.crossFading,
            "and the crossing layer was seen part-way through its own dissolve",
          ).toBeGreaterThan(0);

          // ---- 5. And inert the whole time. -------------------------------
          // Two workspaces are on screen and only one of them is the one a
          // click belongs to, so the departing wrapper takes no pointer at any
          // sample it was seen at — not most of them.
          expect(
            sample.crossInert,
            "the crossing layer computed pointer-events: none at every sample",
          ).toBe(sample.crossLive);

          // The attribute is off, and the debt with it.
          const residue = await app.evalJS<string[]>(OPACITY_RESIDUE);
          note(
            `at0592 after one switch: crossing window ${
              sample.lastCross - sample.firstCross
            }ms, residue ${JSON.stringify(residue)}`,
          );
          expect(
            residue,
            "every frame's inline opacity was handed back when the beat landed",
          ).toEqual([]);

          // The switch itself did what it says: the other workspace's cards
          // are the ones on screen.
          const cards = await app.evalJS<string[]>(
            `window.tugdeck.diag.listCardIds()`,
          );
          expect(cards).toContain("B1");
          expect(cards).not.toContain("A1");

          // ---- 6. An interrupted beat still lands. ------------------------
          // [B09]'s hard case, and the one a generation counter exists for: a
          // second switch arrives while the first beat is mid-flight, and the
          // landing the first beat still has coming must not take the second
          // one's attribute off — nor leave its own standing.
          await app.evalJS<null>(SAMPLER_START);
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_ONE)} }), null)`,
          );
          // Inside the beat: `divide-join` at 0.6× the settle nominal is a few
          // hundred ms, so this lands on a crossing that is still running.
          await settle(60);
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_TWO)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_TWO)}`,
            { timeoutMs: 10_000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(CROSSING_LAYERS)}).length === 0`,
            { timeoutMs: CROSSING_BOUND_MS },
          );
          await settle(900);
          const interrupted = await app.evalJS<Sample>(SAMPLER_READ);
          const interruptedResidue = await app.evalJS<string[]>(OPACITY_RESIDUE);
          note(
            `at0592 across an interrupted beat: ${JSON.stringify(
              interrupted,
            )} residue ${JSON.stringify(interruptedResidue)}`,
          );
          expect(
            interrupted.crossPainted,
            "the interrupted pass crossed at all — otherwise nothing below was interrupted",
          ).toBeGreaterThan(0);
          expect(
            interrupted.crossing,
            "and still only one layer at a time, with two beats overlapping",
          ).toBe(1);
          expect(
            interruptedResidue,
            "an interrupted beat owes its inline opacity back too",
          ).toEqual([]);
          expect(
            interrupted.zero,
            "and holds no shown frame at zero on the way through",
          ).toBe(0);

          // ---- 7. Reduced motion is a cut. --------------------------------
          // Not a shorter fade: the attribute is never written at all, so a
          // deck with motion off has nothing to hand back and no second
          // workspace painted over the first for even one frame.
          await app.evalJS<null>(
            `(document.documentElement.style.setProperty("--tug-motion", "0"), null)`,
          );
          try {
            await app.evalJS<null>(SAMPLER_START);
            await app.evalJS<null>(
              `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_ONE)} }), null)`,
            );
            await app.waitForCondition<boolean>(
              `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_ONE)}`,
              { timeoutMs: 10_000 },
            );
            await settle(900);
            const still = await app.evalJS<Sample>(SAMPLER_READ);
            note(`at0592 with motion off: ${JSON.stringify(still)}`);
            expect(
              still.samples,
              "the sampler ran across the motion-off switch as well",
            ).toBeGreaterThan(10);
            expect(
              still.crossing,
              "with motion off the crossing attribute is never written",
            ).toBe(0);
            const stillCards = await app.evalJS<string[]>(
              `window.tugdeck.diag.listCardIds()`,
            );
            expect(
              stillCards,
              "and the switch still happened — a cut is the whole of it",
            ).toContain("A1");
          } finally {
            await app
              .evalJS<null>(
                `(document.documentElement.style.removeProperty("--tug-motion"), null)`,
              )
              .catch(() => undefined);
          }
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

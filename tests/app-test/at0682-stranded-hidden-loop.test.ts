/**
 * at0682 — a loop paused in the dark runs again once its workspace is shown.
 *
 * `space-layer-loops.ts` pauses every infinite loop under a hidden workspace
 * layer through the Web Animations API, and `at0641` leg 4 is the proof that
 * it does. The converse is this test's subject: a loop the module paused must
 * run again once its layer is shown, however it came to be shown. A pause
 * taken through the API outranks the stylesheet, so a loop the resume pass
 * misses is never resumed by anything — on the live deck that was a Session
 * card's wave and an Overview session dot standing still over a working turn
 * until the user switched workspaces by hand.
 *
 * ## The two legs
 *
 *  1. **Started in the dark, then shown.** A loop installed under the hidden
 *     layer is paused as it starts (the delegated `animationstart` listener),
 *     and switching to that workspace runs it (the switch effect's pass). This
 *     is the path the module was written for, asserted end to end.
 *  2. **Demoted across the switch.** The same loop, paused in the dark, carries
 *     `data-tug-offscreen` at the moment its workspace is shown — the mark the
 *     off-screen observer writes, and the same knob the understudy election
 *     and the motion switch turn: `--tug-loop-iterations: 0`. Under that mark
 *     the engine does not report the animation, so the switch pass cannot see
 *     it. When the mark lifts, the engine brings the SAME animation object
 *     back — still paused through the API — and no pass ever looks at it
 *     again. The leg asserts it runs.
 *
 * Each leg is its own launch, so neither reads a deck the other has driven.
 * Leg 2 is the one that was red: the resume pass read only the engine's list,
 * which leaves out a demoted loop. The pass now walks the module's own record
 * of what it paused as well.
 *
 * The loop is a probe installed by the test, written as every shipped loop is
 * (`var(--tug-loop-iterations, infinite)`, the form `audit-motion.ts` rule 3
 * enforces), because the claim is about the mechanism rather than about any one
 * component — `at0641`'s reasoning, and its fixture shape.
 *
 * `deck-canvas.tsx`, which calls the resume pass, is deliberately not in the
 * `@covers` list: it sits at its accepted fan-out in `select-tests.ts`, and
 * the contract under test is the module's, as `at0641`'s is.
 *
 * @covers tugdeck/src/components/chrome/space-layer-loops.ts
 * @covers tugdeck/src/lib/motion-guard/offscreen.ts
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

const SPACE_ONE = "at0682-one";
const SPACE_TWO = "at0682-two";

const SHOWN_LAYER = "[data-space-layer][data-space-shown]";
const SHOWN_FRAMES = `${SHOWN_LAYER} .tug-pane[data-pane-id]`;

/** The probe loop. Named so a leaked one is recognisable. */
const PROBE_CLASS = "at0682-probe-spin";
const PROBE_STYLE_ID = "at0682-probe-style";

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The fixture — at0641's shape, under its own ids
// ---------------------------------------------------------------------------

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

/** Two workspaces, one Text card each — a pane per layer to carry the probe. */
function twoSpaceBlob(): Record<string, unknown> {
  const deck = (textId: string, paneId: string): Record<string, unknown> => ({
    cards: [{ id: textId, componentId: "text", title: textId, closable: true }],
    panes: [contentPane(paneId, textId, 40)],
    activePaneId: paneId,
    imposition: { kind: "one-up", sidebars: {} },
    hasFocus: true,
  });
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      { id: SPACE_ONE, name: "One", deck: deck("at0682-t1", "at0682-p1") },
      { id: SPACE_TWO, name: "Two", deck: deck("at0682-t2", "at0682-p2") },
    ],
  };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** Install the probe loop on the first pane of the named workspace's layer. */
const probeInstall = (spaceId: string): string => `(function () {
  var style = document.getElementById(${JSON.stringify(PROBE_STYLE_ID)});
  if (style === null) {
    style = document.createElement("style");
    style.id = ${JSON.stringify(PROBE_STYLE_ID)};
    style.textContent =
      "@keyframes " + ${JSON.stringify(PROBE_CLASS)} + " { from { outline-offset: 0px } to { outline-offset: 1px } }" +
      "." + ${JSON.stringify(PROBE_CLASS)} + " { animation: " + ${JSON.stringify(PROBE_CLASS)} +
      " 1s linear var(--tug-loop-iterations, infinite) }";
    document.head.appendChild(style);
  }
  var layer = document.querySelector('[data-space-layer=' + JSON.stringify(${JSON.stringify(spaceId)}) + ']');
  var pane = layer === null ? null : layer.querySelector(".tug-pane[data-pane-id]");
  if (pane === null) return false;
  pane.classList.add(${JSON.stringify(PROBE_CLASS)});
  return true;
})()`;

/** Set or lift the off-screen mark on the probe's element. */
const probeOffscreen = (on: boolean): string => `(function () {
  var el = document.querySelector("." + ${JSON.stringify(PROBE_CLASS)});
  if (el === null) return false;
  if (${on}) el.setAttribute("data-tug-offscreen", "");
  else el.removeAttribute("data-tug-offscreen");
  return true;
})()`;

interface ProbeReading {
  /** Whether the probe's element is under the shown layer. */
  shown: boolean | null;
  /** The playState of every animation the engine reports on the probe. */
  states: string[];
}

const PROBE_READ = `(function () {
  var el = document.querySelector("." + ${JSON.stringify(PROBE_CLASS)});
  if (el === null) return { shown: null, states: [] };
  var layer = el.closest("[data-space-layer]");
  return {
    shown: layer === null ? null : layer.hasAttribute("data-space-shown"),
    states: el.getAnimations().map(function (a) { return a.playState; })
  };
})()`;

const PROBE_REMOVE = `(function () {
  var style = document.getElementById(${JSON.stringify(PROBE_STYLE_ID)});
  if (style !== null) style.remove();
  var marked = document.querySelectorAll("." + ${JSON.stringify(PROBE_CLASS)});
  for (var i = 0; i < marked.length; i++) {
    marked[i].classList.remove(${JSON.stringify(PROBE_CLASS)});
    marked[i].removeAttribute("data-tug-offscreen");
  }
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

/** Launch on the two-space fixture, both workspaces mounted, ONE shown. */
async function launchMounted(testName: string): Promise<{ app: App; tugbankPath: string }> {
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
    testName,
    env: { TUGBANK_PATH: tugbankPath },
    skipAccessibilityPreflight: true,
    persistInTestMode: true,
    restoreInTestMode: true,
  });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 1`,
    { timeoutMs: 30_000 },
  );
  await settle(800);
  // Visit the parked workspace once so both are mounted, then come back.
  await activate(app, SPACE_TWO);
  await settle(800);
  await activate(app, SPACE_ONE);
  await settle(800);
  return { app, tugbankPath };
}

/** Install the probe under the hidden workspace and read it paused as it starts. */
async function installInTheDark(app: App, label: string): Promise<void> {
  expect(
    await app.evalJS<boolean>(probeInstall(SPACE_TWO)),
    "the probe found a pane in the hidden workspace",
  ).toBe(true);
  await settle(150);
  const dark = await app.evalJS<ProbeReading>(PROBE_READ);
  note(`at0682 ${label}, in the dark: ${JSON.stringify(dark)}`);
  expect(dark.shown, "the probe is under the hidden layer").toBe(false);
  expect(dark.states, "the loop is paused as it starts").toEqual(["paused"]);
}

async function teardown(app: App, tugbankPath: string): Promise<void> {
  await app.evalJS<number>(PROBE_REMOVE).catch(() => 0);
  await app.close().catch(() => undefined);
  rmTempTugbank(tugbankPath);
}

describe.skipIf(!SHOULD_RUN)(
  "at0682 — a loop paused in the dark runs again once its workspace is shown",
  () => {
    test(
      "leg 1: started in the dark, then shown — the switch runs it",
      async () => {
        const { app, tugbankPath } = await launchMounted("at0682-stranded-hidden-loop-1");
        try {
          await installInTheDark(app, "leg 1");
          await activate(app, SPACE_TWO);
          await settle(400);
          const lit = await app.evalJS<ProbeReading>(PROBE_READ);
          note(`at0682 leg 1, shown: ${JSON.stringify(lit)}`);
          expect(lit.shown, "the probe's workspace is shown").toBe(true);
          expect(lit.states, "the switch runs the loop again").toEqual(["running"]);
        } finally {
          await teardown(app, tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "leg 2: demoted across the switch — the loop runs once the mark lifts",
      async () => {
        const { app, tugbankPath } = await launchMounted("at0682-stranded-hidden-loop-2");
        try {
          await installInTheDark(app, "leg 2");

          expect(await app.evalJS<boolean>(probeOffscreen(true))).toBe(true);
          await settle(150);
          const demoted = await app.evalJS<ProbeReading>(PROBE_READ);
          note(`at0682 leg 2, demoted in the dark: ${JSON.stringify(demoted)}`);

          await activate(app, SPACE_TWO);
          await settle(400);
          const shownDemoted = await app.evalJS<ProbeReading>(PROBE_READ);
          note(`at0682 leg 2, shown while demoted: ${JSON.stringify(shownDemoted)}`);
          expect(shownDemoted.shown, "the probe's workspace is shown").toBe(true);

          expect(await app.evalJS<boolean>(probeOffscreen(false))).toBe(true);
          await settle(400);
          const lifted = await app.evalJS<ProbeReading>(PROBE_READ);
          note(`at0682 leg 2, mark lifted: ${JSON.stringify(lifted)}`);
          expect(
            lifted.states,
            "the loop runs once the mark lifts — a pause the switch could not see is not a pause forever",
          ).toEqual(["running"]);
        } finally {
          await teardown(app, tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

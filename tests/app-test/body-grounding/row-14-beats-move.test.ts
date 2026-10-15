/**
 * row-14-beats-move.test.ts — a gesture that only moves its frames carries
 * the bodies in them with the chrome, on the host.
 *
 * The bar's fourteenth row. A settle that moves body cards without
 * changing their size posts the host a beat plan — each body's rect at the
 * start and end of each beat, the curve the chrome beat was built from, and
 * the settle's start on the clock both sides read — and the host runs each
 * body's container as Core Animation on it (`lib/body-beat-plan.ts`,
 * `BodyViewController.runPlan`). Both of the settle's planning sites are
 * driven: the flow strip's prelaunched slide (Go to slot, out and back, in
 * a four-up flow band holding two body cards) and the Last pass's move
 * beat (a cross-column stack move in a two-up).
 *
 * On each gesture: the placer planned every body card the gesture moved;
 * on every composited frame where the chrome moves the shell's record has
 * the lid lifted, the body's content box shows no more floor than two
 * frames of travel would uncover, and no frame shows the bare window; the
 * host's presented container stands within two frames of travel of the
 * placeholder on every reading taken while the chrome moved; the host's
 * display link sees the container's presentation advance on at least 95 %
 * of its ticks across the span it moved; the host says the body landed;
 * and at rest the container — presented and placed — stands on the
 * placeholder to the pixel.
 *
 * A gesture that also changes a body's size is a crossing and is not this
 * row's: ⌘N's neighbours ride a fused beat carrying their sizes, and the
 * crossing is read in row 17.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-beat-plan.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, test } from "bun:test";

import { launchTugApp } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { carryLeg, standUp } from "./_motion";

const TEST_NAME = "body-grounding-row-14-beats-move";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SETTLE_MS = 6_000;

/** Six session cards in a four-up flow, body cards in slots 1 and 2. */
function flowDeck(bodies: readonly string[]): Record<string, unknown> {
  const ids = ["r14-n0", bodies[0], bodies[1], "r14-n3", "r14-n4", "r14-n5"];
  return {
    cards: ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: ids.map((id, slot) => sessionPane(id, slot)),
    activePaneId: `${bodies[0]}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/** Two session cards, one per column of a two-up, both body cards. */
function twoUpDeck(bodies: readonly string[]): Record<string, unknown> {
  return {
    cards: bodies.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: bodies.map((id, slot) => ({ ...sessionPane(id, slot), size: { width: 675, height: 620 } })),
    activePaneId: `${bodies[0]}-pane`,
    imposition: { kind: "two-up" },
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 14: move beats carry the bodies", () => {
  test(
    "the flow slide out and back carries both body cards with their chrome",
    async () => {
      const stubDir = stubDirectory();
      const bodies = ["r14-a", "r14-b"];
      const app = await launchTugApp({
        testName: `${TEST_NAME}-flow`,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: flowDeck(bodies), focusCardId: bodies[0] });
        for (const id of bodies) await spawnStub(app, id, stubDir, 2);
        for (const id of bodies) await waitForBody(app, id);
        await focusBody(app, bodies[0], { composer: false });
        await Bun.sleep(400);
        const { standing, crop } = await standUp(app, bodies[0]);
        await carryLeg(app, bodies[0], bodies, "go to slot 2", `window.__tug.dispatchControlAction("go-to-slot", { value: 2 })`, standing, crop);
        await carryLeg(app, bodies[0], bodies, "go to slot 1", `window.__tug.dispatchControlAction("go-to-slot", { value: 1 })`, standing, crop);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a cross-column stack move carries the body card with its chrome",
    async () => {
      const stubDir = stubDirectory();
      const bodies = ["r14-s", "r14-m"];
      const mover = bodies[1];
      const app = await launchTugApp({
        testName: `${TEST_NAME}-stack`,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: twoUpDeck(bodies), focusCardId: mover });
        for (const id of bodies) await spawnStub(app, id, stubDir, 2);
        for (const id of bodies) await waitForBody(app, id);
        // Slot 0 stacks, so the mover crosses into it as one move beat.
        await app.evalJS<null>(`(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "stack" }), null)`);
        await pollFor(
          () => app.evalJS<boolean>(`document.querySelector("[data-deck-canvas-background]")?.hasAttribute("data-imposer-settling") ?? false`),
          (v) => !v,
          SETTLE_MS,
        );
        await focusBody(app, mover, { composer: false });
        await Bun.sleep(400);
        const { standing, crop } = await standUp(app, mover);
        await carryLeg(
          app,
          mover,
          [mover],
          "stack move",
          `window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(mover)}, slot: 0 })`,
          standing,
          crop,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

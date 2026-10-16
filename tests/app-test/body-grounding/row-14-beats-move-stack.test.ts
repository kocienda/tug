/**
 * row-14-beats-move-stack.test.ts — a cross-column stack move carries the
 * Session body card with its chrome.
 *
 * A piece of row 14 ([B02] row 14; the row is `_row-14.ts`'s): two body
 * cards, one per column of a two-up; slot 0 stacks, so the mover crosses into
 * it as one move beat, the Last pass's.
 *
 * @foreground
 * @family row-14-beats-move
 * @covers tugdeck/src/lib/body-beat-plan.ts
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, test } from "bun:test";

import { launchTugApp } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { sessionUnderTest } from "./_kinds";
import { carryLeg, standUp } from "./_motion";
import { SHOULD_RUN, TEST_TIMEOUT_MS, action } from "./_row-14";

const SETTLE_MS = 6_000;

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

describe.skipIf(!SHOULD_RUN)("body-grounding row 14: a stack move", () => {
  test.skipIf(!sessionUnderTest(14))(
    "a cross-column stack move carries the body card with its chrome",
    async () => {
      const stubDir = stubDirectory();
      const bodies = ["r14-s", "r14-m"];
      const mover = bodies[1];
      const app = await launchTugApp({
        testName: "body-grounding-row-14-beats-move-stack",
        foreground: true,
        bodies: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: twoUpDeck(bodies), focusCardId: mover });
        for (const id of bodies) await spawnStub(app, id, stubDir, 2);
        for (const id of bodies) await waitForBody(app, id);
        // Slot 0 stacks, so the mover crosses into it as one move beat.
        await app.evalJS<null>(`(${action("set-column-mode", { slot: 0, mode: "stack" })}, null)`);
        await pollFor(
          () => app.evalJS<boolean>(`document.querySelector("[data-deck-canvas-background]")?.hasAttribute("data-imposer-settling") ?? false`),
          (v) => !v,
          SETTLE_MS,
        );
        await focusBody(app, mover, { composer: false });
        await Bun.sleep(400);
        const { standing, crop } = await standUp(app, mover);
        await carryLeg(app, mover, [mover], "stack move", action("assign-slot", { cardId: mover, slot: 0 }), standing, crop);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

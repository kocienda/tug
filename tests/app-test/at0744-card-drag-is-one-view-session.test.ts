/**
 * at0744-card-drag-is-one-view-session.test.ts — a Session card dragged by its
 * title bar: its chrome and content stand the chrome's height apart on every
 * frame.
 *
 * One of the at0744-card-drag-is-one-view split, a test to a file so each
 * launch fits its own budget. Why a card is one view, and the shared
 * constants, are `card-drag-is-one-view-fixture.ts`.
 *
 * @visible
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugdeck/src/lib/chrome-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/CardGeometry.swift
 * @family at0744-card-drag-is-one-view
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";
import { pollFor } from "./body-grounding/_frames";
import { BODY_READY_MS, cardAtRest, sessionPaneDeck, spawnWithTranscript, viewOf } from "./one-view-fixture";
import { expectDragsAsOneView } from "./one-view-drag";
import { SHOULD_RUN, TEST_TIMEOUT_MS, A } from "./card-drag-is-one-view-fixture";

describe.skipIf(!SHOULD_RUN)("at0744: a card is one view", () => {
  test(
    "dragged by its title bar, the card's chrome and content stand the chrome's height apart on every frame",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "at0744-drag", visible: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: sessionPaneDeck([A]), focusCardId: A });
        await spawnWithTranscript(app, stubDir, A);
        const placed = await pollFor(() => viewOf(app, A), (v) => v !== null, BODY_READY_MS);
        if (placed === null) {
          // card-dom: shell
          const placer = await app.evalJS<unknown>(`window.tugdeck.diag.getBodyPlacement()?.lastPosted ?? null`);
          note(`never placed visible; host bodies ${JSON.stringify(await app.bodies())}; placer posted ${JSON.stringify(placer)}`);
        }
        expect(placed, "the card's view is placed visible").not.toBeNull();
        const body = await cardAtRest(app, A);
        await expectDragsAsOneView(app, body, {
          card: A,
          press: ".tug-pane-title-bar .tug-pane-grab-handle",
          chromeRowPx: 10,
          reading: "bands",
          standIn: ".tug-pane",
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

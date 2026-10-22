/**
 * row-44-switch-evicted.test.ts — a workspace switch onto Session cards
 * whose bodies the clock evicted shows each card's title from the first
 * switched frame, and never the floor through a pane.
 *
 * The app launches on two workspaces: two Session cards side by side, shown,
 * and a Text card's, parked. The Text card's workspace is shown, which parks
 * the Session cards'; past the reader's `evictAfterMs`, shortened here, both
 * Session bodies are evicted by the clock. Then the Session workspace is
 * shown again and read frame by frame until both new bodies have painted.
 * Each card comes back under the face the shell stands in for it, which
 * already stands in the parked workspace so the first switched frame shows
 * it, and under the last frame the host kept at its eviction where that has
 * not aged out: the host drops a cover older than `evictAfterMs`, which the
 * row shortens, so either may be what stands.
 *
 * @family row-44-switch
 * @covers tugdeck/src/components/chrome/body-stand-in.tsx
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/body-stand-in-store.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { bodyOf, pollFor, sessionPane, spawnStub } from "./_bodies";
import { activate, readSwitch, SHOULD_RUN, TEST_TIMEOUT_MS, textDeck } from "./_row-44";

const A = "r44e-a";
const B = "r44e-b";
const T = "r44e-text";
const SESSION_SPACE = "r44e-session";
const TEXT_SPACE = "r44e-text-space";
const EVICT_AFTER_MS = 1_500;

const LAYOUT = {
  version: 5,
  activeSpaceId: SESSION_SPACE,
  spaces: [
    {
      id: SESSION_SPACE,
      name: "Sessions",
      deck: {
        cards: [
          { id: A, componentId: "session", title: "A", closable: true },
          { id: B, componentId: "session", title: "B", closable: true },
        ],
        panes: [sessionPane(A, 0), sessionPane(B, 1)],
        activePaneId: `${A}-pane`,
        imposition: { kind: "two-up", layout: "fit", sidebars: {} },
        hasFocus: true,
      },
    },
    { id: TEXT_SPACE, name: "Text", deck: textDeck([T]) },
  ],
};

describe.skipIf(!SHOULD_RUN)("body-grounding row 44: a workspace switch onto evicted cards", () => {
  test(
    "each evicted card's title is on screen from the first switched frame, and no pane shows the floor",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      tugbankWrite(tugbankPath, "dev.tugapp.body-dormancy", "evictAfterMs", "int", String(EVICT_AFTER_MS));
      const app = await launchTugApp({
        testName: "body-grounding-row-44-switch-evicted",
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        // ---- Two Session cards, each with a session, shown ----
        await Promise.all([spawnStub(app, A, stubDir, 2), spawnStub(app, B, stubDir, 2)]);
        for (const id of [A, B]) {
          const up = await pollFor(() => bodyOf(app, id), (b) => b?.state === "ready" && b.painted && b.visible, 30_000);
          expect(up?.visible, `${id}: its body is ready and shown`).toBe(true);
        }

        // ---- Parked, and evicted by the clock ----
        await activate(app, TEXT_SPACE);
        const gone = await pollFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === A || b.cardId === B), EVICT_AFTER_MS + 6_000);
        expect(gone.some((b) => b.cardId === A || b.cardId === B), "both parked bodies are evicted").toBe(false);

        // ---- The switch back, read frame by frame ----
        const bad = await readSwitch(app, SESSION_SPACE, [A, B], "row-44-switch-evicted");
        expect(bad, "every switched frame shows each card's title, and none shows the floor through a pane").toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * row-44-switch-first-visit.test.ts — the first visit to a workspace whose
 * cards have never had a page shows each card's chrome from the first
 * switched frame, and never the floor through a pane.
 *
 * The app launches on two workspaces: one Text card's, shown, and two Text
 * cards side by side, never shown, so they have no pages and the host holds
 * no last frame for either. Their workspace is shown and read frame by frame
 * until both new pages have painted. For those frames each card's face is
 * the one the shell stands in for it: its own chrome, drawn from the facts
 * the shell sends its page, and its content box in the pane's surface. Its
 * title is its page's to compute — a Text card with no file names itself —
 * so it lands with the page; what the bar holds is that no frame shows the
 * canvas where a card stands, in its title band, or in its box beyond what
 * the settled frame shows. The home card's view stood over both panes, and
 * the host hides it in the transaction that stands its own face for each
 * arriving card, drawn from the shell's stand-in, so the first switched
 * frame shows those faces where the home card stood; the switch's
 * hand-over lands, and no face is left standing once both pages have
 * painted.
 *
 * @family row-44-switch
 * @covers tugdeck/src/components/chrome/body-stand-in.tsx
 * @covers tugdeck/src/lib/body-stand-in-store.ts
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyHandOver.swift
 * @covers tugapp/Sources/BodyFaceHandOver.swift
 * @covers tugdeck/src/lib/face-draw.ts
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "./_bodies";
import { readSwitch, SHOULD_RUN, TEST_TIMEOUT_MS, textDeck } from "./_row-44";

const H = "r44f-home";
const W1 = "r44f-w1";
const W2 = "r44f-w2";
const HOME = "r44f-home-space";
const AWAY = "r44f-away-space";

const LAYOUT = {
  version: 5,
  activeSpaceId: HOME,
  spaces: [
    { id: HOME, name: "Home", deck: textDeck([H]) },
    { id: AWAY, name: "Away", deck: textDeck([W1, W2]) },
  ],
};

describe.skipIf(!SHOULD_RUN)("body-grounding row 44: the first visit to a workspace", () => {
  test(
    "each never-shown card's chrome is on screen from the first switched frame, and no pane shows the floor",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-44-switch-first-visit",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const home = await settleFor(() => bodyOf(app, H), (b) => b?.state === "ready" && b.painted && b.visible, 30_000);
        expect(home?.visible, "the shown workspace's card is a body, shown").toBe(true);
        expect(await bodyOf(app, W1), "a never-shown card has no page").toBeNull();

        // ---- The first visit, read frame by frame ----
        const bad = await readSwitch(app, AWAY, [W1, W2], "row-44-switch-first-visit", "chrome");
        expect(bad, "every switched frame shows each card's chrome, and none shows the floor through a pane").toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

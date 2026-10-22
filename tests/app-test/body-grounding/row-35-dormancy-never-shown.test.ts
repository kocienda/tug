/**
 * row-35-dormancy-never-shown.test.ts — a body hidden before it was ever shown
 * is not shown, so it goes dormant and is evicted like any hidden body.
 *
 * The app launches on two workspaces, each holding a Text card, the second
 * never shown. The second is visited and left again two frames later, before
 * its card's body has painted: the visit makes the body, and it is parked
 * before the user ever sees it. A body not yet shown once is hidden by
 * opacity rather than `isHidden`, so it keeps painting the frame a showing
 * would reveal — and the host must still report it as not shown, because
 * shown is what the user can see, not whether the container paints. Its page
 * is told so, its dormant clock runs, and the time trigger's eviction is
 * armed: past the delays, shortened here, it is dormant and then evicted,
 * while the shown workspace's card keeps its body.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/body/body-dormancy.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor } from "./_bodies";
import { intoTier } from "./_tiers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const HOME = "r35n-home";
const AWAY = "r35n-away";
const H = "r35n-h";
const W = "r35n-w";
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

function textDeck(cardId: string): Record<string, unknown> {
  return {
    cards: [{ id: cardId, componentId: "text", title: cardId, closable: true }],
    panes: [
      {
        id: `${cardId}-pane`,
        position: { x: 60, y: 60 },
        size: { width: 700, height: 500 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: `${cardId}-pane`,
    imposition: { kind: "one-up", sidebars: {} },
    hasFocus: true,
  };
}

const LAYOUT = {
  version: 5,
  activeSpaceId: HOME,
  spaces: [
    { id: HOME, name: "Home", deck: textDeck(H) },
    { id: AWAY, name: "Away", deck: textDeck(W) },
  ],
};

describe.skipIf(!SHOULD_RUN)("body-grounding row 35: a body never shown", () => {
  test(
    "a body parked before its first showing is not shown, and goes dormant and is evicted",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-35-dormancy-never-shown",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await pollFor(() => bodyOf(app, H), (b) => b?.visible === true, 30_000);

        // ---- Visited and left before its card's body paints ----
        await app.evalJS<null>(`(function () {
          var lab = window.tugdeck.lab;
          lab.dispatch("activate-space", { spaceId: ${JSON.stringify(AWAY)} });
          requestAnimationFrame(function () {
            requestAnimationFrame(function () { lab.dispatch("activate-space", { spaceId: ${JSON.stringify(HOME)} }); });
          });
          return null;
        })()`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === HOME, 5_000);
        let seen = false;
        const made = await pollFor(
          async () => {
            const b = await bodyOf(app, W);
            if (b?.visible === true) seen = true;
            return b;
          },
          (b) => b?.state === "ready" && b.painted,
          30_000,
        );
        note(`the parked card's body: ${JSON.stringify({ state: made?.state, painted: made?.painted, visible: made?.visible, shown: made?.shown, opacity: made?.opacity })}`);
        expect(made, "the visit made the card a body, which painted placed hidden").toMatchObject({ state: "ready", painted: true, visible: false });
        expect(seen, "the body was never placed visible").toBe(false);
        expect(made?.shown, "a body the user has never seen is not shown, though it paints").toBe(false);
        expect(await app.body(W).evalJS<boolean>("window.__tug.bodyDormancy().shown"), "its page is told it is not shown").toBe(false);
        expect((await bodyOf(app, H))?.shown, "the shown workspace's card is shown").toBe(true);

        // ---- Past the delays it sleeps, and the clock evicts it ----
        const tiered = await intoTier(app, "evicted", "never shown");
        expect(tiered, "the never-shown body is the one hidden body, and it went dormant, then was evicted").toEqual([W]);
        expect(await bodyOf(app, H), "the shown card keeps its body, shown").toMatchObject({ state: "ready", shown: true });
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

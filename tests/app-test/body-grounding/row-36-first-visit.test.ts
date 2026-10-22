/**
 * row-36-first-visit.test.ts — a parked workspace's cards become bodies on its
 * first visit, and go dormant when it is parked again.
 *
 * The app launches on two workspaces, each holding a Text card, the second
 * never shown. Nothing warms the second ahead of a visit: once the shown
 * workspace's body has painted, and well past the moment the old warming ran,
 * the host holds no body for the parked card. The first visit makes it one,
 * as any card arrives; the row records what that costs, from the switch to the
 * body shown. Parked again, the body is hidden, and past its delay — shortened
 * here through the harness's `bodyDelays` — it goes dormant and stays a body.
 * The return shows it and wakes it.
 *
 * @covers tugdeck/src/spaces-store.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-dormancy.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const HOME = "r36-home";
const AWAY = "r36-away";
const H = "r36-h";
const W = "r36-w";
/** The body's delay before dormancy, shortened from a minute for the row. */
const DORMANT_AFTER_MS = 800;
/** How long the row waits, with the home body painted, for a parked body that should never come. */
const NO_WARM_MS = 2_000;
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

async function activate(app: App, spaceId: string): Promise<void> {
  await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`);
  await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === spaceId, 5_000);
}

interface Dormancy {
  shown: boolean;
  dormant: boolean;
}

const dormancyOf = (app: App, cardId: string): Promise<Dormancy> =>
  app.body(cardId).evalJS<Dormancy>(`(function () { var d = window.__tug.bodyDormancy(); return { shown: d.shown, dormant: d.dormant }; })()`);

describe.skipIf(!SHOULD_RUN)("body-grounding row 36: a parked workspace's first visit", () => {
  test(
    "a never-shown workspace has no bodies; its first visit makes them, and parking it again puts them to sleep",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-36-first-visit",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS });
        // ---- Home stands; the parked workspace has no body ----
        const home = await settleFor(() => bodyOf(app, H), (b) => b?.visible === true, 30_000);
        expect(home?.visible, "the shown workspace's card is a body, shown").toBe(true);
        await Bun.sleep(NO_WARM_MS);
        expect(await bodyOf(app, W), "the never-shown workspace's card has no body").toBeNull();

        // ---- The first visit makes it a body ----
        const visitAt = Date.now();
        await activate(app, AWAY);
        const arrived = await settleFor(() => bodyOf(app, W), (b) => b?.visible === true, 30_000);
        const firstVisitMs = Date.now() - visitAt;
        note(`first visit: the parked card's body shown ${firstVisitMs} ms after the switch (start ${arrived?.start}, ready ${arrived?.readyMs?.toFixed(1)} ms)`);
        expect(arrived?.visible, "the first visit's card arrives as a body, shown").toBe(true);
        expect((await bodyOf(app, H))?.shown, "the home body is hidden while away").toBe(false);

        // ---- Parked again, it sleeps and stays a body ----
        await activate(app, HOME);
        const hidden = await settleFor(() => bodyOf(app, W), (b) => b?.shown === false, 5_000);
        expect(hidden?.shown, "the re-parked body is hidden").toBe(false);
        const asleep = await settleFor(() => dormancyOf(app, W), (d) => d.dormant, 5_000);
        expect(asleep, "the re-parked body is dormant past its delay").toEqual({ shown: false, dormant: true });
        expect(await bodyOf(app, W), "the dormant body is still a body").not.toBeNull();

        // ---- The return shows and wakes it ----
        const returnAt = Date.now();
        await activate(app, AWAY);
        const back = await settleFor(() => bodyOf(app, W), (b) => b?.visible === true, 5_000);
        const returnMs = Date.now() - returnAt;
        const awake = await settleFor(() => dormancyOf(app, W), (d) => !d.dormant, 5_000);
        note(`return: the dormant body shown ${returnMs} ms after the switch`);
        expect(back?.visible, "the return shows the body").toBe(true);
        expect(awake, "the returned body is awake").toEqual({ shown: true, dormant: false });
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

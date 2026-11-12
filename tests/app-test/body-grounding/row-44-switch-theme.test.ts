/**
 * row-44-switch-theme.test.ts — a switch between two awake workspaces that
 * wear different themes shows the arriving cards in their own theme, lit as
 * they were left, from the first switched frame.
 *
 * The app launches on two workspaces of two Text cards each, one dark
 * (`ironclad`) and one light (`sloop`). The light one is visited, so its
 * pages are made and painted, and left, so they are parked awake behind the
 * dark one. Then it is switched to again and read frame by frame by row 44's
 * judge (`readGesture`) with two bars asked for beside its own: after the
 * first switched frame no pane's content changes its dominant colour — a
 * parked body that wore the departed workspace's tint, or was drawn receded
 * because it was told it lost focus at park, would — and no revealed content
 * box goes surface-blank. A parked workspace is a finished picture: what was
 * hidden keeps its own theme and its own focus, so the switch shows it
 * rather than remaking it. The judge also notes what the first frame after
 * the host unhid each view showed.
 *
 * @family row-44-switch
 * @motion
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, settleFor } from "./_bodies";
import { asRgbJs } from "./_frames";
import { activate, readSwitch, SHOULD_RUN, TEST_TIMEOUT_MS, textDeck } from "./_row-44";

const H1 = "r44t-h1";
const H2 = "r44t-h2";
const W1 = "r44t-w1";
const W2 = "r44t-w2";
const HOME = "r44t-home-space";
const AWAY = "r44t-away-space";

const LAYOUT = {
  version: 5,
  activeSpaceId: HOME,
  spaces: [
    { id: HOME, name: "Home", theme: "ironclad", deck: textDeck([H1, H2]) },
    { id: AWAY, name: "Away", theme: "sloop", deck: textDeck([W1, W2]) },
  ],
};

const CANVAS = asRgbJs(`getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')`);

describe.skipIf(!SHOULD_RUN)("body-grounding row 44: a switch between two themes", () => {
  test(
    "the arriving cards wear their own theme and their own focus from the first switched frame",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-44-switch-theme",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      const shown = (id: string) => settleFor(() => bodyOf(app, id), (b) => b?.state === "ready" && b.painted && b.visible, 15_000);
      try {
        for (const id of [H1, H2]) expect((await shown(id))?.visible, `${id}: the shown workspace's card is a body, shown`).toBe(true);
        const homeCanvas = await app.evalJS<string>(CANVAS);

        // ---- The light workspace's pages are made, painted, and parked awake ----
        await activate(app, AWAY);
        for (const id of [W1, W2]) expect((await shown(id))?.painted, `${id}: its page painted on the first visit`).toBe(true);
        const awayCanvas = await app.evalJS<string>(CANVAS);
        note(`row-44-switch-theme: canvas home ${homeCanvas}, away ${awayCanvas}`);
        expect(awayCanvas, "the two workspaces wear different themes").not.toBe(homeCanvas);
        await activate(app, HOME);
        for (const id of [H1, H2]) await shown(id);
        // Long enough for a parked page to hear the home theme go on screen.
        await Bun.sleep(300);
        const parked = await bodyOf(app, W1);
        expect(parked !== null && parked.state === "ready" && !parked.visible, "the light workspace's card is parked awake").toBe(true);

        // ---- The switch back, read frame by frame ----
        // Awake pages are on screen inside the first hundred ms, so the burst reads under a second.
        const bad = await readSwitch(app, AWAY, [W1, W2], "row-44-switch-theme", "title", { burstMs: 700, holdsColour: true, revealsPainted: true });
        expect(bad, "every switched frame shows each card in its own theme and focus, its content whole, and none shows the floor").toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

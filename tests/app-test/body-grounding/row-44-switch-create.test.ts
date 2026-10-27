/**
 * row-44-switch-create.test.ts — New Workspace is one cut onto the finished
 * arrangement: the rail stands in the first switched frame, faced, and
 * nothing of the canvas or the departing card shows over it.
 *
 * A create is a switch onto cards that have never had a page — the new
 * workspace's factory rail, five cards on its two sides — so it is read by
 * row 44's judge (`readGesture`), with the cards' ids taken from the deck
 * once the gesture has made them. The app launches on one workspace holding
 * one Text card, shown; New Workspace is performed through its control
 * action, and every frame is read until each rail card's page has painted.
 * The departing card's view must hand over to the arriving cards' faces in
 * the switch's one host transaction, and no rail pane's box or title band
 * may show the canvas.
 *
 * Beside the frames, the deck's own trace: the gesture commits the
 * arrangement once — one `store-notify` from the activation, spelled
 * `"cut"`, and no rail standing behind it as a second commit — and the
 * canvas arms on one arrangement and carries no settle, so no pane moves
 * after the cut.
 *
 * @family row-44-switch
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/components/chrome/body-stand-in.tsx
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugapp/Sources/BodyHandOver.swift
 * @covers tugapp/Sources/BodyFaceHandOver.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, settleFor } from "./_bodies";
import { ACTIVE_SPACE, readGesture, SHOULD_RUN, TEST_TIMEOUT_MS, textDeck } from "./_row-44";

const H = "r44c-home";
const HOME = "r44c-home-space";

const LAYOUT = {
  version: 5,
  activeSpaceId: HOME,
  spaces: [{ id: HOME, name: "Home", deck: textDeck([H]) }],
};

/**
 * Five cold rail pages, two at a time through the host's lane, paint inside
 * about a second; the burst reads past the last of them. Two display frames
 * apart, since every frame is judged once per rail card.
 */
const BURST = { burstMs: 1_600, intervalMs: 33 };

interface TraceRow {
  kind: string;
  caller?: string;
  landing?: string;
  signature?: string;
  outcome?: string;
  reason?: string;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 44: New Workspace", () => {
  test(
    "the new workspace lands in one cut, its rail faced from the first switched frame",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-44-switch-create",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const home = await settleFor(() => bodyOf(app, H), (b) => b?.state === "ready" && b.painted && b.visible, 30_000);
        expect(home?.visible, "the shown workspace's card is a body, shown").toBe(true);

        const mark = await app.evalJS<number>("(window.__deckTrace.enable(true), window.__deckTrace.mark())");
        // The stand-ins standing once the gesture has run. The control action is dispatched with no
        // dwell after it, so the read lands while the rail's pages are still being made.
        let standIns = { faces: -1 };
        // The faces the host was posted.
        let posted: string[] = [];
        const bad = await readGesture(
          app,
          () => app.evalJS<null>(`(window.__tug.dispatchControlAction("new-space"), null)`),
          async () => {
            standIns = await app.evalJS<{ faces: number }>(
              `({ faces: document.querySelectorAll('[data-body-stand-in]').length })`,
            );
            posted = await app.evalJS<string[]>(
              `(window.tugdeck.diag.getBodyPlacement()?.lastPosted?.bodies ?? []).filter(function (b) {
                 return b.face === true && b.faceDraw !== undefined;
               }).map(function (b) {
                 return b.cardId;
               })`,
            );
            const active = await app.evalJS<string>(ACTIVE_SPACE);
            if (active === HOME) return [];
            return app.evalJS<string[]>("window.tugdeck.diag.getDeckState().cards.map(function (c) { return c.id; })");
          },
          "row-44-switch-create",
          "chrome",
          BURST,
        );

        const trace = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(window.__deckTrace.since(${mark}).filter(function (e) {
               return e.kind === "store-notify" || e.kind === "settle-arm";
             }).map(function (e) {
               return { kind: e.kind, caller: e.caller, landing: e.landing, signature: e.signature, outcome: e.outcome, reason: e.reason };
             }))`,
          ),
        ) as TraceRow[];
        const notifies = trace.filter((e) => e.kind === "store-notify");
        const arms = trace.filter((e) => e.kind === "settle-arm");
        note(`row-44-switch-create: store-notify ${notifies.map((e) => `${e.caller}:${e.landing}`).join(", ") || "none"}`);
        note(`row-44-switch-create: settle-arm ${arms.map((e) => `${e.outcome}${e.reason !== undefined ? `/${e.reason}` : ""}`).join(", ") || "none"}`);

        const activations = notifies.filter((e) => e.caller === "activateSpace");
        const rails = notifies.filter((e) => e.caller === "_createFactoryRail" || e.caller === "claimFactoryRail");
        const carried = arms.filter((e) => e.outcome === "carried");
        const signatures = new Set(arms.map((e) => e.signature));

        note(`row-44-switch-create: ${standIns.faces} stand-ins standing after the gesture`);
        note(`row-44-switch-create: host faces posted ${posted.join("; ") || "none"}`);

        expect(bad, "every frame from the cut shows each rail card's chrome, none shows the floor through a pane, and the departing card hands over").toEqual([]);
        expect(standIns.faces, "a rail page is still being made once the gesture has run").toBeGreaterThan(0);
        expect(posted.length, "the host was posted a face for the rail's cards").toBeGreaterThan(0);
        expect(activations.map((e) => e.landing), "the activation commits once, spelled a cut").toEqual(["cut"]);
        expect(rails.map((e) => e.caller), "no rail stands behind the cut as a second commit").toEqual([]);
        expect(carried.length, "no settle carries a pane after the cut").toBe(0);
        expect(signatures.size, "the canvas arms on one arrangement, so no pane moves after the cut").toBeLessThanOrEqual(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

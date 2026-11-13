/**
 * row-44-switch-create.test.ts — New Workspace is one cut onto the finished
 * arrangement: the window's rail stands in every frame of it, and nothing of
 * the canvas or the departing card shows over it.
 *
 * The rail is the window's, so a new workspace mints no rail of its own: the
 * create cuts onto an empty workspace beside the rail already standing. It is
 * read by row 44's judge (`readGesture`) over the rail's five cards. The app
 * launches on one workspace holding one Text card beside the window rail,
 * every page painted; the create is performed through the deck's direct
 * `createSpace` verb, and every frame is read from the gesture on.
 *
 * The direct verb, not New Workspace's control action: New asks the name in
 * an app-modal first (`row-44-switch-create-modal.test.ts` judges that
 * gesture). A create with no modal is still the deck's to land in one cut,
 * and `createSpace` is the verb that lands it.
 *
 * No rail pane's box or title band may show the canvas in any frame: the
 * cut leaves the rail's pages where they stand.
 *
 * Beside the frames, the deck's own trace: the gesture commits the
 * arrangement once — one `store-notify` from the activation, spelled
 * `"cut"`, and no rail standing behind it as a second commit — and the
 * canvas arms on one arrangement and carries no settle, so no pane moves
 * after the cut.
 *
 * @family row-44-switch
 * @motion
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/components/chrome/body-stand-in.tsx
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugapp/Sources/BodyStages.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, settleFor } from "./_bodies";
import { ACTIVE_SPACE, readGesture, SHOULD_RUN, TEST_TIMEOUT_MS, textDeck } from "./_row-44";
import { railOf, space } from "../readings/_workspace-deck";

const H = "r44c-home";
const HOME = "r44c-home-space";
/** The window's rail: five cards on its two sides, every workspace's. */
const RAIL_SPACE = space("r44c", "home", ["text"]);

const LAYOUT = {
  version: 5,
  activeSpaceId: HOME,
  spaces: [{ id: HOME, name: "Home", deck: textDeck([H]) }],
  rail: railOf(RAIL_SPACE),
};

/** Two display frames apart, since every frame is judged once per rail card. */
const BURST = { burstMs: 1_000, intervalMs: 33 };

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
    "the new workspace lands in one cut, its rail pictured from the first switched frame",
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
        for (const id of RAIL_SPACE.rail) {
          const b = await settleFor(() => bodyOf(app, id), (x) => x?.state === "ready" && x.painted && x.visible, 30_000);
          expect(b?.painted, `${id}: the window rail's card is painted before the create`).toBe(true);
        }

        const mark = await app.evalJS<number>("(window.__deckTrace.enable(true), window.__deckTrace.mark())");
        // The stand-ins standing once the gesture has run. The create is called with no dwell after
        // it, so the read lands while the rail's pages are still being made.
        let standIns = { faces: -1 };
        // The rail cards the host stood a picture for.
        let pictured: string[] = [];
        const bad = await readGesture(
          app,
          () => app.evalJS<null>(`(window.tugdeck.lab.createSpace(), null)`),
          async () => {
            standIns = await app.evalJS<{ faces: number }>(
              `({ faces: document.querySelectorAll('[data-body-stand-in]').length })`,
            );
            pictured = (await app.stages()).rail
              .filter((c) => c.picture === "skeleton" || c.picture === "lastFrame")
              .map((c) => c.cardId);
            const active = await app.evalJS<string>(ACTIVE_SPACE);
            if (active === HOME) return [];
            return [...RAIL_SPACE.rail];
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
        note(`row-44-switch-create: host pictures over the rail ${pictured.join("; ") || "none"}`);

        expect(bad, "every frame from the cut shows each rail card's chrome, and none shows the floor through a pane").toEqual([]);
        expect(pictured, "the rail's pages stand live across the create: no picture stood over them").toEqual([]);
        const created = await app.evalJS<string[]>("window.tugdeck.diag.getDeckState().cards.map(function (c) { return c.id; })");
        expect([...created].sort(), "the new workspace holds no card of its own: only the window's rail").toEqual([...RAIL_SPACE.rail].sort());
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

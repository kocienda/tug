/**
 * at0544-resize-sidebars-to-fit.test.ts — the one verb that resizes a rail,
 * run once, in both of the regimes it has.
 *
 * *Resize Sidebars to Fit* stands each card at the height its content asks
 * for and shares out whatever the run has over or under that ([B08]). Two
 * regimes fall out of one formula, and this file puts a rail in each of them
 * at the same time:
 *
 *   - **The LEFT rail's naturals fit.** An empty Arcs card and a Jots card
 *     with a few rows ask for a fraction of the run between them. Every card
 *     must end up showing all of its content and then some, with the slack
 *     out in proportion — so nothing is left clipped, and the card with more
 *     in it gets more of the room left over.
 *   - **The RIGHT rail's naturals do not.** Overview asks for three quarters
 *     of the run on its own ([B10]) and the Layout card is a long column of
 *     settings, so between them they ask for well over the rail. Nobody can
 *     have their natural, so everyone stands at their floor plus a share of
 *     what is left in proportion to what they asked for above it: the long
 *     card is still clipped, neither is squeezed under its floor, and the
 *     rail is exactly full either way.
 *
 * Then the half the verb's whole design rests on: it runs ONCE ([B07]). A jot
 * is written, which grows the Jots card's content by a row, and no sash
 * moves. The division the verb wrote is the hand's from the moment it is
 * written, exactly as a drag's is, and nothing re-runs it.
 *
 * Both regimes are read against the CONTENT ELEMENTS' own heights rather than
 * against numbers computed here, because the content element is the verb's
 * one input ([B09]) and a test that recomputed the arithmetic would agree
 * with a wrong implementation as readily as a right one.
 *
 * @covers tugdeck/src/lib/rail-fit.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Geometry tolerance, in px: sub-pixel rounding, never a real disagreement. */
const EPSILON = 3;
/** Room past the settle attribute clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 900;
/** Every sidebar card's floor, `getStackSizePolicy(…).min.height`. */
const CARD_FLOOR_PX = 240;

const RAIL_WIDTH = 420;
const LEFT_MEMBERS = ["dashes", "jots"] as const;
const RIGHT_MEMBERS = ["layout", "overview"] as const;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** One card standing on each rail, two a side, and no stored division. */
function deckShape() {
  const pane = (id: string, cardId: string, title: string) => ({
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  });
  return {
    cards: [
      { id: "D", componentId: "dashes", title: "Arcs", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
      { id: "O", componentId: "overview", title: "Overview", closable: true },
    ],
    panes: [
      pane("pArcs", "D", "Arcs"),
      pane("pJots", "J", "Jots"),
      pane("pLayout", "L", "Layout"),
      pane("pOverview", "O", "Overview"),
    ],
    activePaneId: "pLayout",
    imposition: {
      kind: "three-up",
      sidebars: {
        dashes: { side: "left" },
        jots: { side: "left" },
        layout: { side: "right" },
        overview: { side: "right" },
      },
      rails: {
        left: { order: [...LEFT_MEMBERS] },
        right: { order: [...RIGHT_MEMBERS] },
      },
    },
    hasFocus: true,
  };
}

/** What one rail member's pane stands at, and what its content asks for. */
interface MemberRead {
  readonly pane: number;
  readonly content: number;
}

/**
 * Every member of `side`, keyed by componentId: the pane's own border-box
 * height, and the border-box height of the content element the verb reads.
 */
function railRead(
  app: App,
  side: "left" | "right",
): Promise<Record<string, MemberRead>> {
  return app.evalJS<Record<string, MemberRead>>(
    `(function () {
      var out = {};
      document.querySelectorAll('.tug-pane[data-rail-side="${side}"]').forEach(function (el) {
        var content = el.querySelector("[data-card-content]");
        out[el.getAttribute("data-rail-member")] = {
          pane: el.getBoundingClientRect().height,
          content: content === null ? 0 : content.getBoundingClientRect().height,
        };
      });
      return out;
    })()`,
  );
}

const paneHeights = (read: Record<string, MemberRead>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(read).map(([id, member]) => [id, member.pane]),
  );

const totalPane = (read: Record<string, MemberRead>): number =>
  Object.values(read).reduce((sum, member) => sum + member.pane, 0);

async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

/** Wait until both rails are up with two members each, and nothing is moving. */
async function awaitRails(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length === 2 &&
     document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 2`,
    { timeoutMs: 15_000 },
  );
  await settled(app);
}

describe.skipIf(!SHOULD_RUN)(
  "at0544 — Resize Sidebars to Fit, in both of its regimes",
  () => {
    test(
      "the verb fills each rail from its cards' own content, once",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);
          const app = await launchTugApp({
            testName: "at0544-resize-sidebars-to-fit",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({ state: deckShape(), focusCardId: "L" });
            await awaitRails(app);

            const leftBefore = await railRead(app, "left");
            const rightBefore = await railRead(app, "right");
            note(`left, equally divided: ${JSON.stringify(leftBefore)}`);
            note(`right, equally divided: ${JSON.stringify(rightBefore)}`);

            // The verb, once — the same frame the Window row and ⌃⇧⌘S send.
            await app.dispatchControlAction("resize-sidebars-to-fit");
            await settled(app);

            const left = await railRead(app, "left");
            const right = await railRead(app, "right");
            note(`left, fitted: ${JSON.stringify(left)}`);
            note(`right, fitted: ${JSON.stringify(right)}`);

            // ── The LEFT rail: the naturals fit. ──
            //
            // An empty Arcs card and a Jots card with a few rows ask for a
            // fraction of the run between them, so every card ends up showing
            // all of its content — which is the whole of what "fit" means,
            // read off the content element the verb read — and the slack goes
            // out in proportion, so the card with more in it gets more room.
            for (const componentId of LEFT_MEMBERS) {
              const member = left[componentId];
              expect(member, `${componentId} stands on the left rail`).toBeDefined();
              expect(
                member.pane,
                `${componentId} shows all ${member.content.toFixed(1)}px of its content`,
              ).toBeGreaterThanOrEqual(member.content - EPSILON);
            }
            expect(
              left.jots.content,
              "the Jots card is the one with something in it",
            ).toBeGreaterThan(left.dashes.content + EPSILON);
            expect(
              left.jots.pane,
              "and the slack went out in proportion to that",
            ).toBeGreaterThan(left.dashes.pane + EPSILON);

            // ── The RIGHT rail: they do not. ──
            //
            // Overview asks for three quarters of the run on its own ([B10])
            // and the Layout card is a long column of settings, so between
            // them they ask for well over the whole rail. Nobody gets their
            // natural. What the regime promises instead is that nobody goes
            // under their floor, that the room above the floors goes to
            // whoever asked for it, and that the long card is still clipped —
            // it scrolls inside itself, as a split pane does anywhere.
            expect(
              right.layout.pane,
              `the Layout card is still short of its ${right.layout.content.toFixed(1)}px of content`,
            ).toBeLessThan(right.layout.content - EPSILON);
            for (const componentId of RIGHT_MEMBERS) {
              expect(
                right[componentId].pane,
                `${componentId} stands at or above its floor`,
              ).toBeGreaterThanOrEqual(CARD_FLOOR_PX - EPSILON);
            }
            expect(
              right.overview.pane,
              "the card asking for more of the room gets more of it",
            ).toBeGreaterThan(right.layout.pane + EPSILON);
            // And it actually MOVED: the equal division is what the rail
            // stood at a moment ago, and a verb that did nothing would leave
            // it there.
            expect(
              Math.abs(right.layout.pane - rightBefore.layout.pane),
              "the verb moved the right rail's sash",
            ).toBeGreaterThan(EPSILON * 4);

            // ── Both rails are exactly full. ──
            //
            // The run does not change under the verb, so the members' heights
            // still sum to what they summed to when the rail was equally
            // divided — the fit regime's slack and the squeeze regime's
            // shortfall both land inside the same run.
            expect(
              Math.abs(totalPane(left) - totalPane(leftBefore)),
              "the left rail is exactly as full as it was",
            ).toBeLessThanOrEqual(EPSILON);
            expect(
              Math.abs(totalPane(right) - totalPane(rightBefore)),
              "the right rail is exactly as full as it was",
            ).toBeLessThanOrEqual(EPSILON);

            // ── And it runs ONCE ([B07]). ──
            //
            // A jot is a row the Jots card did not have, so its content grows
            // under a division that was written before the row existed. The
            // division is the hand's from the moment the verb wrote it, so
            // the sash does not move for it — the card scrolls inside itself,
            // exactly as it would after a drag.
            const heightsAfterVerb = paneHeights(left);
            await app.dispatchControlAction("new-jot");
            await settled(app);
            const grown = await railRead(app, "left");
            note(`left, after a jot: ${JSON.stringify(grown)}`);
            expect(
              grown.jots.content,
              "the jot actually grew the card's content",
            ).toBeGreaterThan(left.jots.content + EPSILON);
            for (const componentId of LEFT_MEMBERS) {
              expect(
                Math.abs(grown[componentId].pane - heightsAfterVerb[componentId]),
                `${componentId} stands where the verb left it`,
              ).toBeLessThanOrEqual(EPSILON);
            }
          } finally {
            await app.close().catch(() => undefined);
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

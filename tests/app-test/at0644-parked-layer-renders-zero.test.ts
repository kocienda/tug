/**
 * at0644 — a workspace that stays parked across a switch renders zero times.
 *
 * `LayerPanes` in `deck-canvas.tsx` is `memo`'d, and a workspace that is parked
 * before and after a switch bails out of the switch's render only because every
 * prop reaching it keeps its identity — its deck, its cached arrangement, the
 * store singleton, and no handler a hidden pane could reach. That boundary was
 * established by reading the fiber tree on a three-workspace deck
 * (`briefs/workspace-switch-cheap-readings.md`), and until this file it was
 * guarded by nothing: one new prop that changes on a switch undoes it, and the
 * last time that happened it was found by profiling rather than by a red test.
 *
 * ## What is asserted, and why zero
 *
 * Three workspaces are mounted. The test switches between two of them and
 * reads the `layer-render` trace rows the third's `LayerPanes` wrote across the
 * switch. **That count is zero.** Not "small", not "under a budget" — zero is
 * the one number that says the memo boundary held, and it is a bar that cannot
 * flap, because a machine under load renders no more often than an idle one.
 *
 * The instrument is proven in the same reading: the two layers a switch changes
 * hands between DO render — `shown` flips on both — so their counts are
 * asserted to be at least one. A counter that never fires would report zero
 * for every layer and read as a perfect switch; the switching pair's non-zero
 * counts are what say the counter was live when the parked one stayed still.
 *
 * ## The row is a COMMIT, not a render call
 *
 * `LayerPanes` records from a layout effect with no dependency list, which runs
 * once per commit of that component and never for a commit the memo skipped.
 * A render React started and threw away is not counted, and does not need to
 * be: the cost the boundary removes is the committed render of every pane and
 * card host under a parked layer, and a commit is what that costs.
 *
 * ## Armed by kind
 *
 * `deckTrace.enable(true)` alone records nothing here; the `layer-render` kind
 * is armed by name, the door `space-switch-frames` uses and for the same
 * reason — an instrument a test reads is armed by that test and no neighbour
 * pays for it. Disarmed again before the assertions, so a failure leaves
 * nothing behind on the app instance.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/deck-trace.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SPACE_A = "at0644-a";
const SPACE_B = "at0644-b";
const SPACE_C = "at0644-c";

const SHOWN_FRAMES =
  "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]";
/** The epoch's mark, on the canvas container. Gone means the switch is over. */
const SWITCHING_MARK = "[data-space-switching]";

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The fixture: three workspaces, each with a rail and two text cards
// ---------------------------------------------------------------------------

const railPane = (id: string, cardId: string): Record<string, unknown> => ({
  id,
  position: { x: 0, y: 0 },
  size: { width: 420, height: 900 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: [] as string[],
});

const contentPane = (
  id: string,
  cardId: string,
  y: number,
): Record<string, unknown> => ({
  id,
  position: { x: 60, y },
  size: { width: 700, height: 360 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: ["standard"],
});

/**
 * Text cards rather than session cards: this file measures the memo boundary
 * around a layer, and a layer's card weight has no bearing on whether the
 * boundary holds. Each workspace carries a Workspaces rail because that is the
 * one card whose content DOES change on every switch (its slot chips and row
 * flags churn in every mounted copy, as the readings paper measured) — and it
 * re-renders through its own store subscription, below the boundary, which is
 * exactly the case the zero has to survive.
 */
function threeSpaceBlob(): Record<string, unknown> {
  const deck = (
    tag: string,
    textIds: readonly string[],
  ): Record<string, unknown> => ({
    cards: [
      {
        id: `at0644-cards-${tag}`,
        componentId: "cards",
        title: "Workspaces",
        closable: true,
      },
      ...textIds.map((id) => ({
        id,
        componentId: "text",
        title: id,
        closable: true,
      })),
    ],
    panes: [
      railPane(`at0644-rail-${tag}`, `at0644-cards-${tag}`),
      ...textIds.map((id, i) =>
        contentPane(`at0644-pane-${tag}-${i}`, id, 40 + i * 260),
      ),
    ],
    activePaneId: `at0644-pane-${tag}-0`,
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  });
  return {
    version: 5,
    activeSpaceId: SPACE_A,
    spaces: [
      { id: SPACE_A, name: "A", deck: deck("a", ["at0644-ta0", "at0644-ta1"]) },
      { id: SPACE_B, name: "B", deck: deck("b", ["at0644-tb0", "at0644-tb1"]) },
      { id: SPACE_C, name: "C", deck: deck("c", ["at0644-tc0", "at0644-tc1"]) },
    ],
  };
}

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

/** `layer-render` rows since a mark, folded to a count per workspace. */
const renderCountsSince = (mark: number): string =>
  `JSON.stringify(window.__deckTrace.since(${mark}).reduce(function (acc, e) {
     if (e.kind === "layer-render") acc[e.spaceId] = (acc[e.spaceId] || 0) + 1;
     return acc;
   }, {}))`;

type RenderCounts = Record<string, number>;

async function activate(app: App, spaceId: string): Promise<void> {
  await app.evalJS<null>(
    `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(spaceId)}`,
    { timeoutMs: 20_000 },
  );
}

/**
 * Switch to `toSpaceId`, let the epoch close, and return every layer's commit
 * count across the whole of it.
 *
 * The read waits for the epoch mark to leave the canvas and then settles past
 * it, so a commit the epoch's close might make — a late re-arm, the settle's
 * own release — is inside the window. The boundary has to hold across all of
 * that, not only across the swap commit.
 */
async function countSwitch(
  app: App,
  label: string,
  toSpaceId: string,
): Promise<RenderCounts> {
  const mark = await app.evalJS<number>(`window.__deckTrace.mark()`);
  await activate(app, toSpaceId);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SWITCHING_MARK)}) === null`,
    { timeoutMs: 20_000 },
  );
  await settle(600);
  const counts = JSON.parse(
    await app.evalJS<string>(renderCountsSince(mark)),
  ) as RenderCounts;
  note(`at0644 ${label}: layer commits ${JSON.stringify(counts)}`);
  return counts;
}

describe.skipIf(!SHOULD_RUN)(
  "at0644 — a parked workspace layer renders zero times across a switch",
  () => {
    test(
      "three workspaces mounted, switching between two: the third's LayerPanes commits zero times, the pair's commit at least once",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(threeSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: "at0644-parked-layer-renders-zero",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 3`,
            { timeoutMs: 30_000 },
          );
          await settle(1200);

          // ---- Mount all three. -----------------------------------------
          //
          // A workspace nobody has visited has no layer, so the first switch
          // to it is a MOUNT rather than a re-show and renders whatever it
          // must. Visit every workspace once and come back to A, so that every
          // switch measured below is between layers that already stand.
          await activate(app, SPACE_B);
          await settle(1500);
          await activate(app, SPACE_C);
          await settle(1500);
          await activate(app, SPACE_A);
          await settle(1500);

          const mounted = await app.evalJS<number>(
            `document.querySelectorAll("[data-space-layer]").length`,
          );
          expect(
            mounted,
            `all three workspaces stand as layers before the measured switches ` +
              `(${mounted} layers)`,
          ).toBe(3);

          // ---- Arm, by kind. --------------------------------------------
          await app.evalJS<null>(
            `(window.__deckTrace.enable(true),
              window.__deckTrace.enableKind("layer-render", true), null)`,
          );

          const runs: Array<[string, string, string, RenderCounts]> = [];
          for (const [label, from, to] of [
            ["A->B", SPACE_A, SPACE_B],
            ["B->A", SPACE_B, SPACE_A],
          ] as const) {
            runs.push([label, from, to, await countSwitch(app, label, to)]);
            await settle(600);
          }

          // Disarm before asserting, so a red leaves nothing armed behind it.
          await app.evalJS<null>(
            `(window.__deckTrace.enableKind("layer-render", false), null)`,
          );

          for (const [label, from, to, counts] of runs) {
            const parked = counts[SPACE_C] ?? 0;
            const leaving = counts[from] ?? 0;
            const arriving = counts[to] ?? 0;

            // The instrument first: the pair that changed hands rendered, so
            // a zero for the parked layer below is a zero the counter saw.
            expect(
              leaving,
              `${label}: the departing layer committed at least once ` +
                `(\`shown\` flipped on it) — ${leaving} commit(s); zero here ` +
                `means the counter was not live, not that the switch was free`,
            ).toBeGreaterThanOrEqual(1);
            expect(
              arriving,
              `${label}: the arriving layer committed at least once ` +
                `(\`shown\` flipped on it) — ${arriving} commit(s)`,
            ).toBeGreaterThanOrEqual(1);

            // The claim.
            expect(
              parked,
              `${label}: the workspace that stayed parked (${SPACE_C}) ` +
                `committed ZERO times across the switch — measured ${parked}. ` +
                `LayerPanes is memo'd and a parked layer bails out only while ` +
                `every prop reaching it keeps its identity; a non-zero here is ` +
                `a prop that now changes on a switch, and the readings paper ` +
                `says which one did it last time`,
            ).toBe(0);
          }
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

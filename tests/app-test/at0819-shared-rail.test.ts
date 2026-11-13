/**
 * at0819-shared-rail.test.ts — the rail is the window's, and a switch never
 * touches it.
 *
 * A five-workspace layout written while each workspace kept its own rail —
 * five copies of each rail kind — boots onto one window rail: one card per
 * rail kind, the active workspace's. Then ten switches from the Window menu's
 * rows walk every workspace twice, and after each the rail's bodies are the
 * same cards, at the same frames, on the same pages: no rail card was
 * remade, moved or swapped for another workspace's copy.
 *
 * @covers tugdeck/src/lib/window-rail.ts
 * @covers tugdeck/src/layout-persistence.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "./body-grounding/_bodies";
import { deckOf, RAIL, railOf, space, type Space } from "./readings/_workspace-deck";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const SWITCHES = 10;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const RAIL_KINDS = new Set<string>(RAIL.map((r) => r.kind));

const TAGS = ["one", "two", "three", "four", "five"];
const SPACES: Space[] = TAGS.map((t) => space("g819", t, ["text"]));
/** Each workspace's own copy of the rail, as a layout written before the window rail kept it. */
const ownRail = (tag: string): string[] => RAIL.map((r) => `g819-${tag}-own-${r.kind}`);

/** The layout before the window rail: every workspace's deck holding its own five rail cards. */
function perWorkspaceLayout(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACES[0].id,
    spaces: SPACES.map((s, i) => {
      const deck = deckOf(s) as { cards: unknown[]; panes: unknown[]; imposition: Record<string, unknown> };
      const rail = railOf({ ...s, rail: ownRail(TAGS[i]) }) as { cards: unknown[]; panes: unknown[]; imposition: Record<string, unknown> };
      return {
        id: s.id,
        name: `Space ${i + 1}`,
        deck: { ...deck, cards: [...rail.cards, ...deck.cards], panes: [...rail.panes, ...deck.panes], imposition: { ...deck.imposition, ...rail.imposition } },
      };
    }),
  };
}

describe.skipIf(!SHOULD_RUN)("at0819 — the shared rail", () => {
  test(
    "a per-workspace layout boots onto one rail, which ten switches never touch",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(perWorkspaceLayout()));
      const app = await launchTugApp({
        testName: "at0819-shared-rail",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const kept = ownRail(TAGS[0]);
        for (const id of kept) {
          const b = await settleFor(() => bodyOf(app, id), (x) => x?.state === "ready" && x.painted === true, 30_000);
          expect(b?.painted, `${id}: the active workspace's rail card is ready and painted`).toBe(true);
        }
        const railBodies = async () =>
          (await app.bodies())
            .filter((b) => b.componentId !== null && RAIL_KINDS.has(b.componentId) && b.cardId !== null)
            .map((b) => `${b.cardId} ${Math.round(b.frame.x)},${Math.round(b.frame.y)} ${Math.round(b.frame.width)}x${Math.round(b.frame.height)} page ${b.page}`)
            .sort();
        const before = await railBodies();
        note(`rail before: ${before.join("; ")}`);
        expect(before.map((r) => r.split(" ")[0]), "one card per rail kind, the active workspace's").toEqual([...kept].sort());

        for (let n = 1; n <= SWITCHES; n++) {
          const row = n % SPACES.length;
          const to = SPACES[row];
          await app.performMenuItem(`window.space.${row}`);
          const active = await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === to.id, 10_000);
          expect(active, `switch ${n} reaches ${to.id}`).toBe(to.id);
          await Bun.sleep(250);
          const after = await railBodies();
          expect(after, `after switch ${n}, the rail's cards, frames and pages are unchanged`).toEqual(before);
        }
        note(`ten switches: the rail's ${before.length} bodies stood unchanged`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

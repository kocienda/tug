/**
 * at0542-rail-vertical-allocation.test.ts — a rail divides its run when its
 * members fit in it, and builds a strip out of them when they do not.
 *
 * A rail used to stop dividing at three members, whatever the room, and every
 * member of an overflowing rail used to be the same fixed fraction of the run,
 * whatever it asked for. Both were proxies for a question neither could see
 * ([P01], [B07]): is there room, and how much does this member want. One
 * allocator answers both now, from the members' own floors, comfort heights and
 * stored weights, and a rail and a column stand under it alike.
 *
 * What this file pins, against a live deck:
 *
 *   1. **Three modest cards divide a tall run.** Their floors and seams fit, so
 *      the rail SHARES: three frames tile the run exactly, the first flush with
 *      the run's top, the last flush with its bottom, nothing overhanging. The
 *      retired count rule would have stacked them down a scrolling strip.
 *   2. **Six do not, and the rail says so by standing differently.** Their
 *      floors no longer fit at any division, so the rail overflows: every member
 *      stands at or above its own floor, the strip they make is longer than the
 *      run, and its foot hangs past the run's bottom.
 *   3. **Which of the two it is comes from the floors against the run**, not
 *      from counting members. The assertions are written as that rule rather
 *      than as a fixed standing, so a harness window of any height exercises
 *      whichever branch its own run puts the fixture in — and `note()` says
 *      which one that was.
 *   4. **A sash stands between every pair of members, in both standings, and
 *      the drag is zero-sum.** On the overflowing rail a real pointer drags one
 *      sash down a hundred pixels: the two members either side of it change by
 *      `+100` and `−100`, every other frame holds, and the strip keeps its
 *      length — so no member the hand did not touch is resized by one it did.
 *      The rail's offset does not move either: a drag divides, it does not
 *      scroll.
 *   5. **What a card declares is what the rail divides by.** The Jots card's
 *      list grows past the share it was standing at, and the Layout card —
 *      which asks for one size and means it — hands the room back and stands
 *      at exactly its natural, while the Cards card — which asks for less than
 *      its floor — stands at that floor. `DeckState.appetites` carries the
 *      declarations, which is the settle having run.
 *
 * The standing is read off the CANVAS rather than out of the store: a shared
 * rail publishes seam fractions and an overflowing one publishes strip
 * coordinates, exclusively, and the frames' `calc()`s read nothing else. A pass
 * therefore says the deck published what it allocated, which a store read alone
 * would not.
 *
 * The floors are the fixture for parts 1–4: every sidebar card declares a 240px
 * floor, and the arithmetic there is stated in that one number rather than in a
 * table of them. Those parts assert against the floor and the standing, which
 * no appetite above it can move. Part 5 is the one about the tiers ABOVE the
 * floor, so it alone names the numbers the two cards it exercises declare.
 *
 * Deliberately declaring the allocator and the selectors alone. The canvas
 * (`deck-canvas.tsx`) and the pane (`tug-pane.tsx`) are both at the selection
 * budget's fan-out ceiling — at0456 and at0537 decline to name them for the
 * same reason — and the rule under test here is the allocation's.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/deck-store-selectors.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  RAIL_EDGE_INSET_PX,
  RAIL_SEAM_PX,
} from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const AFTER_LAND_MS = 900;
/** Geometry tolerance: the strip coordinates are published rounded to the
 *  pixel, so every frame's edge carries that rounding. */
const EPSILON = 2;
/** The floor every sidebar card declares, which is also its comfort height —
 *  none of them declares any other appetite yet. */
const FLOOR = 240;
const RAIL_WIDTH = 420;
/** How far the sash drag travels, in px — well past the move threshold, and
 *  small enough that both divided members stay above their floors. */
const DRAG_PX = 100;
/**
 * The gap a rail keeps at the canvas's foot: `railGapBottomPx()` resolved for
 * the profile under test. That function reads a module-level number the HOST
 * settles at boot, and this test process is not the host — its copy still holds
 * the maker default, which would put the run 26px short. The app-test harness
 * always reports maker mode OFF (`AppDelegate.makerModeEnabled`), and a release
 * rail's bottom gap is its edge inset, so the geometry under test is this.
 */
const RAIL_GAP_BOTTOM = RAIL_EDGE_INSET_PX;

// ---- What the cards declare (part 5) ----

/**
 * `LAYOUT_NATURAL_HEIGHT_PX` in `layout-card.tsx`. The Layout card's content is
 * a picture of the deck, and a picture is one size: this is both what it asks
 * for and the height past which it wants nothing more.
 */
const LAYOUT_NATURAL = 300;

/** `JOTS_HEADER_PX` and `JOTS_ROW_HEIGHT_PX` in `jots-card.tsx` — the Jots
 *  card's natural height is its whole list, a row at a time. */
const JOTS_HEADER = 69;
const JOTS_ROW = 28;

/**
 * How many jots the fixture opens with, and how many it then adds.
 *
 * Chosen so the pair straddles the one interesting boundary. At 15 the run has
 * more room than every member's natural asks for, so the leftover is shared out
 * and Layout stands ABOVE its natural. At 20, Jots's own natural has grown past
 * its share, the leftover is gone, and every capped member falls back to
 * exactly what it asked for. Two decks, two divisions, and the rule is legible
 * in the difference.
 */
const JOTS_FEW = 15;
const JOTS_MANY = 20;

/** One deck's reading, for the pair part 5 compares. */
interface Reading {
  rects: Rect[];
  run: { top: number; bottom: number; height: number };
  settled: Record<string, { comfort: number; natural: number }> | null;
  standing: string;
}

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** The three that fit, and the three that put them past the run. */
const MODEST = ["cards", "jots", "layout"];
const REST = ["overview", "tripwires", "dashes"];

const paneOf = (componentId: string): string => `p-${componentId}`;

interface Rect {
  top: number;
  bottom: number;
  height: number;
}

/**
 * A deck holding `components` as split members of the right rail, in order,
 * under `shares` — the weights a seam drag would have stored.
 *
 * The weights are how a member gets room above its floor here. A sidebar card
 * declares a floor and nothing else, so an overflowing member with no stored
 * weight stands at exactly its floor and has nothing to trade with a neighbour
 * standing at exactly its own — which is a correct division, and a useless
 * fixture for a drag.
 */
function deckShape(
  components: readonly string[],
  shares?: Readonly<Record<string, number>>,
): Record<string, unknown> {
  const rail = (componentId: string) => ({
    id: paneOf(componentId),
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [componentId.toUpperCase()],
    activeCardId: componentId.toUpperCase(),
    title: componentId,
    acceptsFamilies: [],
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      ...components.map((componentId) => ({
        id: componentId.toUpperCase(),
        componentId,
        title: componentId,
        closable: true,
      })),
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 400, height: 400 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
      ...components.map(rail),
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: Object.fromEntries(
        components.map((componentId) => [componentId, { side: "right" }]),
      ),
      rails: {
        right: {
          mode: "split",
          order: [...components],
          ...(shares === undefined ? {} : { shares }),
        },
      },
    },
    hasFocus: true,
  };
}

/**
 * The run the right rail's members stand in, in viewport coordinates — the
 * canvas less the rail's own edge inset at the top and the rail's own bottom
 * gap. Read off the canvas the deck actually painted, so the test measures the
 * run the deck measured rather than a number it agreed with itself about.
 */
async function railRun(
  app: App,
): Promise<{ top: number; bottom: number; height: number }> {
  return app.evalJS<{ top: number; bottom: number; height: number }>(
    `(function () {
      var box = document
        .querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      return {
        top: box.top + ${RAIL_EDGE_INSET_PX},
        bottom: box.bottom - ${RAIL_GAP_BOTTOM},
        height: box.height - ${RAIL_EDGE_INSET_PX} - ${RAIL_GAP_BOTTOM},
      };
    })()`,
  );
}

/** Every named member's live frame, top to bottom, in viewport coordinates. */
async function memberRects(
  app: App,
  components: readonly string[],
): Promise<Rect[]> {
  return app.evalJS<Rect[]>(
    `${JSON.stringify(components.map(paneOf))}.map(function (id) {
      var r = document
        .querySelector('.tug-pane[data-pane-id="' + id + '"]')
        .getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    })`,
  );
}

/**
 * How the right rail stands, as the CANVAS says it: a shared rail publishes a
 * seam fraction and no strip coordinate, an overflowing one the reverse. The
 * two are exclusive by construction, and a rail publishing both or neither
 * answers with what it published so the failure names the fault.
 */
async function standing(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
      var style = getComputedStyle(
        document.querySelector("[data-deck-canvas-background]"),
      );
      var seam = style.getPropertyValue("--tug-rail-right-seam-0").trim();
      var strip = style.getPropertyValue("--tug-rail-right-strip-0").trim();
      if (seam !== "" && strip === "") return "shared";
      if (strip !== "" && seam === "") return "overflow";
      return "seam=" + JSON.stringify(seam) + " strip=" + JSON.stringify(strip);
    })()`,
  );
}

/** The strip's own end, as the canvas published it — coordinate `n`, which is
 *  the number the offset clamp reads. `null` when the rail publishes none. */
async function stripEnd(app: App, count: number): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var raw = getComputedStyle(
        document.querySelector("[data-deck-canvas-background]"),
      ).getPropertyValue("--tug-rail-right-strip-${count}").trim();
      return raw === "" ? null : parseFloat(raw);
    })()`,
  );
}

/** How many sash handles the right rail is offering. */
async function seamCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll('[data-rail-seam^="right:"]').length`,
  );
}

/** The right rail's live offset, in px — how far its strip has slid up behind
 *  the run. A sash drag must not move it. */
async function railOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `((window.tugdeck.diag.getDeckState().railOffsets || {}).right || 0)`,
  );
}

/** Seed `components` onto the right rail and wait for every frame to stand. */
async function seed(
  app: App,
  components: readonly string[],
  shares?: Readonly<Record<string, number>>,
): Promise<void> {
  await app.seedDeckState({
    state: deckShape(components, shares),
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === ${components.length}`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)("at0542 — a rail allocates its run", () => {
  test(
    "the floors against the run decide the standing, and the members decide their own heights",
    async () => {
      const app = await launchTugApp({
        testName: "at0542-rail-vertical-allocation",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );

        // ── 1. Three modest cards. ──
        await seed(app, MODEST);
        const run = await railRun(app);
        const three = await memberRects(app, MODEST);
        const required =
          MODEST.length * FLOOR + (MODEST.length - 1) * RAIL_SEAM_PX;
        const shares = required <= run.height;
        note(
          `three members: run ${run.height.toFixed(1)}px against ${required}px of floors — the rail ${
            shares ? "SHARES" : "OVERFLOWS"
          }; heights ${three.map((r) => Math.round(r.height)).join(" / ")}`,
        );

        // Whichever branch this window's run puts the fixture in, no member ever
        // stands below the height it said it could not go below.
        for (const [index, rect] of three.entries()) {
          expect(
            rect.height,
            `${MODEST[index]} stands at or above its own floor`,
          ).toBeGreaterThanOrEqual(FLOOR - EPSILON);
        }

        if (shares) {
          expect(await standing(app)).toBe("shared");
          // Three frames tile the run exactly: the first flush with the run's
          // top, the last flush with its bottom, a seam between each pair, and
          // nothing hanging past either end.
          expect(
            Math.abs(three[0].top - run.top),
            "the top member is flush with the run's top",
          ).toBeLessThan(EPSILON);
          expect(
            Math.abs(three[2].bottom - run.bottom),
            "the bottom member is flush with the run's bottom — nothing overhangs",
          ).toBeLessThan(EPSILON);
          for (const index of [1, 2]) {
            expect(
              Math.abs(
                three[index].top - three[index - 1].bottom - RAIL_SEAM_PX,
              ),
              "each member stands a seam below the one above it",
            ).toBeLessThan(EPSILON);
          }
          const tiled =
            three.reduce((sum, rect) => sum + rect.height, 0) +
            (MODEST.length - 1) * RAIL_SEAM_PX;
          expect(
            Math.abs(tiled - run.height),
            "the heights and the seams add up to the run itself",
          ).toBeLessThan(1);
          expect(
            await seamCount(app),
            "and a sash stands between each pair of members",
          ).toBe(MODEST.length - 1);
          expect(
            await stripEnd(app, MODEST.length),
            "a sharing rail publishes no strip to slide",
          ).toBeNull();

          // A sash cannot starve the member it is dragged into: the clamp is the
          // allocator's own, so the height a drag can write is a height the
          // allocator will give back. Dragged hard up, the top member stops at
          // the shortest it says it may be, and the sash is still there to drag
          // back.
          const sash = await app.getElementBounds(`[data-rail-seam="right:0"]`);
          // Aimed at the run's own top, which is as far up as a sash can be
          // asked to go and still be a coordinate inside the window. The top
          // member's floor is well below where it stands, so the travel is more
          // than enough to reach the clamp and overshoot it.
          await app.nativeDragElement(`[data-rail-seam="right:0"]`, {
            x: Math.round(sash.x + sash.width / 2),
            y: Math.round(run.top + 1),
          });
          await wait(AFTER_LAND_MS);
          const clamped = await memberRects(app, MODEST);
          note(
            `after dragging right:0 hard up: ${clamped
              .map((r, i) => `${MODEST[i]} ${Math.round(r.height)}`)
              .join(", ")}`,
          );
          expect(
            Math.abs(clamped[0].height - FLOOR),
            "the top member stops at the shortest it says it may be",
          ).toBeLessThan(EPSILON);
          expect(
            await seamCount(app),
            "and the sash is still there to drag back",
          ).toBe(MODEST.length - 1);
          expect(
            await standing(app),
            "a drag divides the run; it does not change how the place stands",
          ).toBe("shared");
        } else {
          expect(await standing(app)).toBe("overflow");
          expect(
            three[2].bottom,
            "the strip overhangs the run rather than being squeezed into it",
          ).toBeGreaterThan(run.bottom + EPSILON);
        }

        // ── 2. All six, which no run this harness opens can fit. ──
        // The Layout card carries a stored weight of 2, which is what a seam
        // drag would have left behind. It is what gives the strip a member with
        // room above its floor, and it is read: an overflowing member's height
        // is `max(floor, comfort · weight)`.
        const all = [...MODEST, ...REST];
        const last = all.length - 1;
        const HEAVY = "layout";
        await seed(app, all, { [HEAVY]: 2 });
        const runNow = await railRun(app);
        const six = await memberRects(app, all);
        const requiredNow = all.length * FLOOR + (all.length - 1) * RAIL_SEAM_PX;
        const overflows = requiredNow > runNow.height;
        note(
          `six members: run ${runNow.height.toFixed(1)}px against ${requiredNow}px of floors — the rail ${
            overflows ? "OVERFLOWS" : "SHARES"
          }; heights ${six.map((r) => Math.round(r.height)).join(" / ")}`,
        );
        expect(
          await standing(app),
          "the standing is the floors against the run, whichever way they fall",
        ).toBe(overflows ? "overflow" : "shared");
        for (const [index, rect] of six.entries()) {
          expect(
            rect.height,
            `${all[index]} stands at or above its own floor`,
          ).toBeGreaterThanOrEqual(FLOOR - EPSILON);
        }
        // And the stored weight is READ rather than merely kept: the member the
        // record makes heavier is taller in the strip. Under the retired rule
        // every overflowing member was the same fraction of the run and this
        // record made no difference to anything drawn.
        expect(
          six[all.indexOf(HEAVY)].height,
          "the member carrying a stored weight stands taller than its neighbours",
        ).toBeGreaterThan(FLOOR + EPSILON);

        if (overflows) {
          // The strip the frames make, read off the frames themselves: the last
          // member's bottom less the first member's top. It is longer than the
          // run, which is what overflowing MEANS, and its foot hangs past the
          // run's bottom, which is the affordance saying so.
          const drawn = six[last].bottom - six[0].top;
          const published = await stripEnd(app, all.length);
          note(
            `strip ${drawn.toFixed(1)}px drawn, ${published}px published, against a run of ${runNow.height.toFixed(1)}px`,
          );
          expect(
            drawn,
            "the strip the members make is longer than the run they stand in",
          ).toBeGreaterThan(runNow.height + EPSILON);
          expect(
            six[last].bottom,
            "so its foot hangs past the run's bottom edge",
          ).toBeGreaterThan(runNow.bottom + EPSILON);
          // And the number the frames pinned to is the number the canvas
          // published, not a second account of the same strip.
          expect(published).not.toBeNull();
          expect(
            Math.abs((published as number) - drawn),
            "the published strip length is the one the frames drew",
          ).toBeLessThan(EPSILON);

          // ── 3. A sash between every pair, and the drag is zero-sum. ──
          //
          // The overflowing rail used to offer no handle at all, on the reading
          // that a place which had stopped dividing had no division to drag.
          // Its members still stand against one another, so it offers one per
          // gap now, and the drag trades px between the two either side of it.
          expect(
            await seamCount(app),
            "an overflowing rail offers a sash between every pair of members",
          ).toBe(all.length - 1);
          // Between the two the weight separates: `jots` at its floor above,
          // `layout` with room to spare below. Dragging down grows the upper
          // one, which is the direction that has anywhere to go.
          const offsetBefore = await railOffset(app);
          const sash = await app.getElementBounds(`[data-rail-seam="right:1"]`);
          await app.nativeDragElement(`[data-rail-seam="right:1"]`, {
            x: Math.round(sash.x + sash.width / 2),
            y: Math.round(sash.y + sash.height / 2 + DRAG_PX),
          });
          await wait(AFTER_LAND_MS);
          const after = await memberRects(app, all);
          note(
            `after dragging right:1 down ${DRAG_PX}px: ${after
              .map((r, i) => `${all[i]} ${Math.round(r.height)}`)
              .join(", ")}`,
          );
          // The two the sash divides trade the drag between them, and nobody
          // else moves a pixel. Four untouched members either side of the pair
          // is what makes this a claim about zero-sum rather than about one
          // lucky neighbour.
          expect(
            Math.abs(after[1].height - six[1].height - DRAG_PX),
            "the member above the sash took the drag",
          ).toBeLessThan(EPSILON);
          expect(
            Math.abs(after[2].height - six[2].height + DRAG_PX),
            "and the member below it gave exactly that up",
          ).toBeLessThan(EPSILON);
          for (const index of [0, 3, 4, 5]) {
            expect(
              Math.abs(after[index].height - six[index].height),
              `${all[index]} was not touched by a drag on a sash it does not sit at`,
            ).toBeLessThan(EPSILON);
          }
          // And the strip is exactly as long as it was: a drag divides, it does
          // not lengthen. The offset holds for the same reason — dividing is not
          // scrolling.
          const strippedAfter = await stripEnd(app, all.length);
          expect(
            Math.abs((strippedAfter as number) - (published as number)),
            "the strip kept its length through the drag",
          ).toBeLessThan(EPSILON);
          expect(
            await railOffset(app),
            "and the strip did not slide",
          ).toBe(offsetBefore);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── 5. What the cards declare is what the rail divides by. ──
  //
  // Two apps rather than one, because the fixture is a jots FILE: the Jots
  // card's natural height is its list, and the list is what the store loads at
  // boot. The pair straddles one boundary and the difference between them is
  // the whole claim.
  test(
    "a card's declared appetite is what the rail divides by, and a natural is a ceiling",
    async () => {
      const heightsFor = async (jots: number): Promise<Reading> => {
        const dir = mkdtempSync(join(tmpdir(), "tug-at0542-"));
        const jotsPath = join(dir, "jots.json");
        writeFileSync(
          jotsPath,
          `${JSON.stringify(
            {
              version: 1,
              jots: Array.from({ length: jots }, (_, i) => ({
                id: `j${i}`,
                text: `jot ${i}`,
              })),
            },
            null,
            2,
          )}\n`,
        );
        const app = await launchTugApp({
          testName: `at0542-appetites-${jots}`,
          env: { TUG_JOTS_PATH: jotsPath },
        });
        try {
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
          );
          await seed(app, MODEST);
          const run = await railRun(app);
          const rects = await memberRects(app, MODEST);
          const settled = await app.evalJS<Record<
            string,
            { comfort: number; natural: number }
          > | null>(
            `(window.tugdeck.diag.getDeckState().appetites || null)`,
          );
          const how = await standing(app);
          note(
            `${jots} jots: ${rects
              .map((r, i) => `${MODEST[i]} ${Math.round(r.height)}`)
              .join(", ")} — the rail stands ${how}, run ${run.height.toFixed(1)}px`,
          );
          return { rects, run, settled, standing: how };
        } finally {
          await app.close();
          rmSync(dir, { recursive: true, force: true });
        }
      };

      const few = await heightsFor(JOTS_FEW);
      const many = await heightsFor(JOTS_MANY);

      // The declarations reached the layout at all. `appetites` is the SETTLED
      // mirror of `cardAppetiteStore` ([P05]), so a populated one is the whole
      // publish → quiet period → deck state → allocator path having run — the
      // one claim about the settle that does not depend on catching it in the
      // act.
      expect(
        many.settled?.layout,
        "the Layout card's declaration reached deck state",
      ).toEqual({ comfort: LAYOUT_NATURAL, natural: LAYOUT_NATURAL });
      expect(
        many.settled?.jots.natural,
        "and the Jots card's is its whole list, a row at a time",
      ).toBe(JOTS_HEADER + JOTS_MANY * JOTS_ROW);

      // Both stand the same way — this is about how a shared run is divided,
      // not about which standing it takes.
      expect(few.standing).toBe("shared");
      expect(many.standing).toBe("shared");

      // With few jots nobody's natural is binding, so the room left over once
      // every ask is met is shared out and the Layout card stands taller than
      // the picture it draws actually wants. That is [Q01]'s answer, and it is
      // what makes the other reading a change rather than a coincidence.
      expect(
        few.rects[2].height,
        "with room to spare, the leftover is shared out past every natural",
      ).toBeGreaterThan(LAYOUT_NATURAL + EPSILON);

      // With enough jots the Jots card's own natural has grown past its share,
      // there is no leftover, and the card that asked for one size gets exactly
      // that size.
      expect(
        Math.abs(many.rects[2].height - LAYOUT_NATURAL),
        "and the card that asked for one size stands at exactly that size",
      ).toBeLessThan(EPSILON);
      expect(
        many.rects[1].height,
        "the card whose content wants the room takes it",
      ).toBeGreaterThan(few.rects[1].height + EPSILON);
      expect(
        many.rects[2].height,
        "which is less room than it had when nobody else wanted it",
      ).toBeLessThan(few.rects[2].height - EPSILON);
      // The Cards card declares less than its floor, so it stands at the floor
      // and asks for nothing more — the third reading that makes the other two
      // a division rather than a coincidence.
      expect(
        Math.abs(many.rects[0].height - FLOOR),
        "and the card that asked for nothing stands at its floor",
      ).toBeLessThan(EPSILON);

      // Whatever moved, the rail is still a division of its run.
      for (const reading of [few, many]) {
        const tiled =
          reading.rects.reduce((sum, rect) => sum + rect.height, 0) +
          (MODEST.length - 1) * RAIL_SEAM_PX;
        expect(
          Math.abs(tiled - reading.run.height),
          "the heights and the seams add up to the run itself",
        ).toBeLessThan(1);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

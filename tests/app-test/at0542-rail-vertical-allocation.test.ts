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
 *      a flowing drag takes from nobody.** On the overflowing rail a real
 *      pointer drags one sash down a hundred pixels: the member above it grows
 *      by `+100`, every other frame holds at the height it declared, and the
 *      strip lengthens by exactly that ([B08]) — flow divides nothing, so
 *      there is nothing for a drag to trade. The rail's offset does not move:
 *      a drag resizes, it does not scroll.
 *   5. **What a card declares is what the rail divides by.** Each declaration
 *      is read against the content it claims to measure: the Jots card's
 *      natural is its list a row at a time, and the two decks differ by exactly
 *      the five jots between them; the Layout card's is its plate plus a pitch
 *      for every control row it actually drew. No member is pushed past what it
 *      asked for, and the Cards card — which asks for less than its floor —
 *      stands at that floor. `DeckState.appetites` carries the declarations,
 *      which is the settle having run.
 *   6. **And what a card declares is TRUE of the card.** Parts 1–5 all ask
 *      whether the allocator honours the declarations; this one asks whether
 *      the declarations are honest. Standing at exactly its natural height,
 *      each card's scroll container has nothing left to scroll —
 *      `scrollHeight ≤ clientHeight + 1`, which is what a natural height MEANS
 *      and what nothing has ever checked. Nothing is arranged to stand them
 *      there: a flowing member's height is `max(floor, natural · weight)`, so
 *      an undragged rail already stands each card at what it asked for.
 *   7. **Run left over past every natural goes whole to the greediest card.**
 *      Two cards whose declarations both fit in the run leave slack, and the
 *      slack is not smeared across them: the one the registry ranks less
 *      greedy stands at exactly the height it asked for, so the seam between
 *      them sits on a content boundary, and the single stretch of empty space
 *      is at the foot of the greedier one. The greedier card is SECOND in the
 *      rail, so a pass is about the rank rather than about position.
 *   8. **The layout is the user's, on the doors a place already has.** The
 *      stack badge's menu offers Fit and Flow as a checked pair; choosing Flow
 *      puts the rail on a strip whatever its run, with every member at its own
 *      `natural · weight`; and a double-click on the seam clears the weights,
 *      which under flow means every member standing at exactly the height its
 *      content asked for.
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
 * same reason — and the rule under test here is the allocation's. Part 8
 * presses the pane's badge menu and so runs its code, and still does not
 * declare it: naming it puts `tug-pane.tsx` at 21 tests and turns
 * `app-test-changed` into a sweep, which the budget check refuses. What part 8
 * is about is the layout the press SETS, which is the allocator's and the
 * selectors' — at0347 and at0359 are the badge menu's own tests.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/lib/card-appetite-store.ts
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/tripwires/tripwires-card.tsx
 * @covers tugdeck/src/components/overview/overview-card.tsx
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
 * `LAYOUT_ROW_PITCH_PX` in `layout-card.tsx` — one control row's 28px control
 * against `.layouts-section-rows`'s `row-gap: 6px`. The Layout card's natural
 * is its plate plus one of these for every row it draws, which is what part 5
 * checks against the rows on screen.
 */
const LAYOUT_ROW_PITCH = 34;

/** `JOTS_HEADER_PX` and `JOTS_ROW_HEIGHT_PX` in `jots-card.tsx` — the Jots
 *  card's natural height is its whole list, a row at a time, under the pane's
 *  title bar and the card's own toolbar. */
const JOTS_HEADER = 76;
const JOTS_ROW = 28;

/**
 * How many jots the fixture opens with, and how many it then adds.
 *
 * Five rows apart, which is the whole point of the pair: the Jots card's
 * declaration has to grow by exactly five row heights and by nothing else, and
 * two decks are what makes that a reading rather than an arithmetic identity.
 *
 * The pair used to straddle a boundary in the ALLOCATION — at 15 the run had
 * more room than every natural asked for and Layout stood above its own, at 20
 * it did not. No run this harness opens straddles that boundary any more: the
 * Layout card's natural counts its control rows now, so three members' naturals
 * exceed the run at either count and neither deck reaches the surplus stage.
 */
const JOTS_FEW = 15;
const JOTS_MANY = 20;

/**
 * How many extra maker cards part 6's fixture stands in its floating pane.
 *
 * The Cards card's natural is the deck's own cards, a row apiece under a group
 * header, and the ordinary fixture holds one — which asks for less than the
 * 240px floor, so the card would be measured with more room than it asked for
 * and the reading would be of the floor rather than of the declaration. Ten
 * puts its natural clear of the floor, which is what makes part 6 a reading of
 * what the Cards card actually says.
 */
const EXTRA_MAKER_CARDS = 10;

/** One deck's reading, for the pair part 5 compares. */
interface Reading {
  rects: Rect[];
  run: { top: number; bottom: number; height: number };
  settled: Record<string, { comfort: number; natural: number }> | null;
  standing: string;
  /** How many control rows the Layout card drew — the count its own natural
   *  height is a function of. */
  layoutRows: number;
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
  extraMakerCards = 0,
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
  const makerCardIds = [
    "A",
    ...Array.from({ length: extraMakerCards }, (_, i) => `A${i + 2}`),
  ];
  return {
    cards: [
      ...makerCardIds.map((id) => ({
        id,
        componentId: "gallery-accordion",
        title: `Card ${id}`,
        closable: true,
      })),
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
        cardIds: makerCardIds,
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
  extraMakerCards = 0,
): Promise<void> {
  await app.seedDeckState({
    state: deckShape(components, shares, extraMakerCards),
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === ${components.length}`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/**
 * What every card in the deck declared, as `DeckState.appetites` holds it —
 * `natural: null` where the card declares none.
 *
 * `Infinity` is what a stream publishes and no JSON value can carry it, so the
 * read below projects it to `null` rather than letting the RPC refuse the whole
 * object. Part 5 never met this because its three cards all declare a finite
 * natural.
 */
type Declarations = Record<string, { comfort: number; natural: number | null }>;

/** The settled mirror of what the cards declared, read off the deck's own
 *  diagnostic surface — the publish → quiet period → deck state path having
 *  run, which is the one claim about the settle that does not depend on
 *  catching it in the act. */
async function readAppetites(app: App): Promise<Declarations | null> {
  return app.evalJS<Declarations | null>(
    `(function () {
      var live = window.tugdeck.diag.getDeckState().appetites;
      if (!live) return null;
      var out = {};
      Object.keys(live).forEach(function (key) {
        out[key] = {
          comfort: live[key].comfort,
          natural: Number.isFinite(live[key].natural) ? live[key].natural : null,
        };
      });
      return out;
    })()`,
  );
}

/** One card's scroll container as the DOM has it — the two numbers part 6 asks
 *  its question of, and enough of the element to name it in a failure. */
interface Scroller {
  scrollHeight: number;
  clientHeight: number;
  label: string;
}

/**
 * The card's own scroll container: the first element in document order inside
 * the card's host whose computed `overflow-y` lets it scroll.
 *
 * Found by the property rather than by a per-card selector, because the whole
 * claim is about a card's content against the height it asked for, and a table
 * of six selectors would be six more things to keep true. Every sidebar card
 * hands its overflow to exactly one such element — the list's own scroller for
 * the list cards, the content column for Layout.
 *
 * `null` when a card has none, which a card with an empty list really does not:
 * an empty roster draws its placeholder and no scroller, and there is then
 * nothing that could have overflowed. That is a skip with a `note()` rather
 * than a pass or a failure — the claim is about a scroller that does not fit,
 * and a card with no scroller has not made one.
 */
async function cardScroller(app: App, cardId: string): Promise<Scroller | null> {
  return app.evalJS<Scroller | null>(
    `(function () {
      var host = document.querySelector(
        '[data-card-host][data-card-id="${cardId}"]',
      );
      if (host === null) return null;
      var all = host.querySelectorAll("*");
      for (var i = 0; i < all.length; i += 1) {
        var overflow = getComputedStyle(all[i]).overflowY;
        if (overflow !== "auto" && overflow !== "scroll") continue;
        return {
          scrollHeight: all[i].scrollHeight,
          clientHeight: all[i].clientHeight,
          label:
            all[i].tagName.toLowerCase() +
            "." +
            String(all[i].getAttribute("class") || "—"),
        };
      }
      return null;
    })()`,
  );
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
          // Dragging down grows the member above the sash, which is the whole
          // of what a flowing drag does.
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
          // The member above the sash takes the drag and NOBODY gives it up:
          // in flow every other member is standing at a height it declared,
          // and a hand lengthening one card is not a reason to shorten its
          // neighbour ([B08]). Five untouched members is what makes this a
          // claim about the rule rather than about one lucky neighbour.
          expect(
            Math.abs(after[1].height - six[1].height - DRAG_PX),
            "the member above the sash took the drag",
          ).toBeLessThan(EPSILON);
          expect(
            Math.abs(after[2].height - six[2].height),
            "and the member below it gave up nothing",
          ).toBeLessThan(EPSILON);
          for (const index of [0, 3, 4, 5]) {
            expect(
              Math.abs(after[index].height - six[index].height),
              `${all[index]} was not touched by a drag on a sash it does not sit at`,
            ).toBeLessThan(EPSILON);
          }
          // And the strip is exactly the drag longer than it was, which is the
          // other side of nobody giving anything up. The offset holds all the
          // same: resizing a member is not scrolling the strip.
          const strippedAfter = await stripEnd(app, all.length);
          expect(
            Math.abs((strippedAfter as number) - (published as number) - DRAG_PX),
            "the strip grew by exactly the drag",
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
          const layoutRows = await app.evalJS<number>(
            `document.querySelectorAll(".layouts-section-row").length`,
          );
          note(
            `${jots} jots: ${rects
              .map((r, i) => `${MODEST[i]} ${Math.round(r.height)}`)
              .join(", ")} — the rail stands ${how}, run ${run.height.toFixed(1)}px`,
          );
          return { rects, run, settled, standing: how, layoutRows };
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
      //
      // Each declaration is then read against the content it claims to measure.
      // The Jots card's is its list, a row at a time, and the two decks differ
      // by exactly the five jots between them. The Layout card's is its plate
      // plus a pitch for every control row it drew — counted off the card's own
      // rendered rows, so the declaration is checked against the picture rather
      // than against a second copy of the formula.
      expect(
        many.settled?.jots.natural,
        "the Jots card's natural is its whole list, a row at a time",
      ).toBe(JOTS_HEADER + JOTS_MANY * JOTS_ROW);
      expect(
        few.settled?.jots.natural,
        "and a shorter list asks for exactly the rows it has",
      ).toBe(JOTS_HEADER + JOTS_FEW * JOTS_ROW);
      const layout = many.settled?.layout;
      expect(
        layout,
        "the Layout card's declaration reached deck state",
      ).toBeDefined();
      const declaredLayout = layout as { comfort: number; natural: number };
      note(
        `layout declared comfort ${declaredLayout.comfort}, natural ${declaredLayout.natural}, over ${many.layoutRows} control rows`,
      );
      expect(
        many.layoutRows,
        "the Layout card drew control rows to count",
      ).toBeGreaterThan(0);
      expect(
        declaredLayout.natural - declaredLayout.comfort,
        "and its natural is its comfort plus a pitch for every row it drew",
      ).toBe(LAYOUT_ROW_PITCH * many.layoutRows);

      // Both stand the same way — this is about how a shared run is divided,
      // not about which standing it takes.
      expect(few.standing).toBe("shared");
      expect(many.standing).toBe("shared");

      // A natural is a CEILING. The naturals no longer fit in a run this
      // harness opens, so no member reaches its own — and the claim that
      // matters is that none is pushed PAST it either, which is what makes the
      // declaration a statement the allocator obeys rather than a hint. A
      // member whose natural falls below its floor asks for the floor, which is
      // what the allocator reads it as.
      for (const reading of [few, many]) {
        for (const [index, componentId] of MODEST.entries()) {
          const declared = reading.settled?.[componentId];
          expect(
            declared,
            `${componentId} declared an appetite at all`,
          ).toBeDefined();
          expect(
            reading.rects[index].height,
            `${componentId} is not pushed past the height it asked for`,
          ).toBeLessThanOrEqual(
            Math.max(FLOOR, (declared as { natural: number }).natural) + EPSILON,
          );
        }
      }

      // The Cards card declares less than its floor in this fixture, so it
      // stands at the floor and asks for nothing more — the reading that makes
      // the others a division rather than a coincidence.
      expect(
        Math.abs(many.rects[0].height - FLOOR),
        "and the card that asked for less than it may have stands at its floor",
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

  // ── 6. What a card declares is a claim about the card's own content. ──
  //
  // Parts 1–5 ask whether the allocator honours the declarations. This asks
  // the other question, which nothing has ever asked: are the declarations
  // true. A natural height MEANS "at this height my content has nothing left
  // to scroll", and that is one reading of one element.
  //
  // Nothing has to be arranged for a member to stand at its natural: a flowing
  // place's heights ARE `max(floor, natural · weight)` ([B08]), so a rail
  // nobody has dragged stands every member at exactly what it declared. This
  // used to need a stored weight of `natural / comfort` and a second app to
  // seed it into, because the tier was comfort. The declarations come out of
  // the deck's own settled mirror rather than being recomputed here, so the
  // height under test is the height the card asked for rather than one this
  // file agreed with itself about.
  //
  // Two members are not askable, and both are skipped by RULE rather than by
  // name, with a `note()` each so a skip is visible rather than silent:
  // Overview declares `Infinity` — a stream is never finished — and a card
  // whose natural falls below the 240px floor cannot be stood at it, so it is
  // measured at the floor, which is more room than it asked for and therefore
  // a weaker reading of the same claim.
  //
  // The shortfalls are collected and asserted once at the end rather than
  // thrown one at a time, because the interesting failure is WHICH cards are
  // short, and a loop that stops at the first names only the first.
  test(
    "a card standing at its declared natural has nothing left to scroll",
    async () => {
      // The two list cards whose rows this fixture supplies: the Jots card's
      // natural is its list, and the Cards card's is the deck's own cards. An
      // empty one of either asks for less than its floor, and a card measured
      // at the floor is measured with room it never asked for.
      const dir = mkdtempSync(join(tmpdir(), "tug-at0542-natural-"));
      const jotsPath = join(dir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          {
            version: 1,
            jots: Array.from({ length: JOTS_MANY }, (_, i) => ({
              id: `j${i}`,
              text: `jot ${i}`,
            })),
          },
          null,
          2,
        )}\n`,
      );
      const all = [...MODEST, ...REST];

      /**
       * One app, launched, seeded once, and handed to `read`. The seed is the
       * only one it gets, so its settled appetites are the cards' own and its
       * heights are the ones those appetites allocate.
       */
      const withDeck = async <T>(
        name: string,
        read: (app: App) => Promise<T>,
      ): Promise<T> => {
        const app = await launchTugApp({
          testName: name,
          env: { TUG_JOTS_PATH: jotsPath },
        });
        try {
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
          );
          await seed(app, all, undefined, EXTRA_MAKER_CARDS);
          return await read(app);
        } finally {
          await app.close();
        }
      };

      try {
        // One deck, read twice over: what the six cards declare, and what they
        // are standing at — which under flow's heights is the same number, so
        // there is nothing to seed a second time for.
        const seen = await withDeck("at0542-natural-fits", async (app) => {
          const appetites = await readAppetites(app);
          const how = await standing(app);
          const rects = await memberRects(app, all);
          const scrollers: (Scroller | null)[] = [];
          for (const componentId of all) {
            scrollers.push(await cardScroller(app, componentId.toUpperCase()));
          }
          return { appetites, how, rects, scrollers };
        });
        const appetites = seen.appetites;
        expect(
          appetites,
          "the cards' declarations reached deck state",
        ).not.toBeNull();
        const declared = appetites as Declarations;
        note(
          `declared: ${all
            .map((componentId) => {
              const appetite = declared[componentId];
              return `${componentId} comfort ${appetite?.comfort} natural ${appetite?.natural ?? "none"}`;
            })
            .join("; ")}`,
        );

        expect(
          seen.how,
          "the six overflow, which is the standing whose heights are each member's own",
        ).toBe("overflow");
        note(
          `stood: ${all
            .map((componentId, i) => `${componentId} ${Math.round(seen.rects[i].height)}`)
            .join(", ")}`,
        );

        const short: string[] = [];
        for (const [index, componentId] of all.entries()) {
          const appetite = declared[componentId];
          expect(
            appetite,
            `${componentId} declared an appetite at all`,
          ).toBeDefined();
          if (appetite.natural === null) {
            note(
              `${componentId}: declares no natural — a stream is never finished, so there is no height to check it at`,
            );
            continue;
          }
          const stood = Math.max(FLOOR, appetite.natural);
          expect(
            Math.abs(seen.rects[index].height - stood),
            `${componentId} stands at the height its own declaration puts it at`,
          ).toBeLessThan(EPSILON);
          const scroller = seen.scrollers[index];
          if (scroller === null) {
            note(
              `${componentId}: natural ${Math.round(appetite.natural)}, stood ${Math.round(
                seen.rects[index].height,
              )}, no scroll container — nothing it draws could have overflowed`,
            );
            continue;
          }
          const box = scroller;
          const left = box.scrollHeight - box.clientHeight;
          const floored =
            appetite.natural < FLOOR
              ? " (measured at the floor, which is more room than it asked for)"
              : "";
          note(
            `${componentId}: natural ${Math.round(appetite.natural)}, stood ${Math.round(
              seen.rects[index].height,
            )}, ${box.label} ${box.scrollHeight}/${box.clientHeight} — ${
              left > 1 ? `${Math.round(left)}px LEFT TO SCROLL` : "fits"
            }${floored}`,
          );
          if (left > 1) short.push(`${componentId} (${Math.round(left)}px)`);
        }

        expect(
          short,
          "every card at its declared natural has nothing left to scroll — a natural height its own content does not fit inside is a declaration the rail cannot honour",
        ).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── 7. Slack goes whole to the greediest, never spread. ──
  //
  // Every part above stands the rail where its members want more run than
  // there is. This is the other edge: two cards whose naturals both fit, with
  // run left over. The old ladder divided that leftover by weight, so every
  // card held a little empty space and no seam sat on a content boundary. It
  // goes to one card now, and the one is chosen by the registry's greed rank.
  //
  // The Arcs card — componentId `dashes`, which is the tugbank spelling
  // [D141] kept — ranks greedier than the Tripwires card and stands BELOW it,
  // so a pass cannot be position falling out the same way. Both cards are
  // empty in this fixture, which is what makes their declarations small enough
  // to leave slack in a run this harness opens.
  test(
    "run left over past every natural stands in the greediest card alone",
    async () => {
      const app = await launchTugApp({
        testName: "at0542-rail-vertical-allocation",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        const SLACK = ["tripwires", "dashes"];
        await seed(app, SLACK);
        const run = await railRun(app);
        const declared = await readAppetites(app);
        const rects = await memberRects(app, SLACK);
        // A declaration below the floor asks for the floor, which is what the
        // allocator reads it as and therefore what "at its natural" means here.
        const wanted = SLACK.map((componentId) => {
          const appetite = declared?.[componentId];
          expect(
            appetite?.natural,
            `${componentId} declared a finite natural to be satisfied at`,
          ).not.toBeNull();
          return Math.max(FLOOR, appetite?.natural ?? FLOOR);
        });
        const asked = wanted[0] + wanted[1] + RAIL_SEAM_PX;
        note(
          `two members: run ${run.height.toFixed(1)}px against ${asked}px asked for — heights ${rects
            .map((r) => Math.round(r.height))
            .join(" / ")}`,
        );
        expect(await standing(app), "the two floors fit, so the rail shares").toBe(
          "shared",
        );
        expect(
          asked,
          "the fixture leaves run over past both naturals, which is the case under test",
        ).toBeLessThan(run.height - 1);

        // The less greedy member stands at exactly what it asked for, so the
        // seam between the two sits on a content boundary.
        expect(
          Math.abs(rects[0].height - wanted[0]),
          "tripwires, the less greedy of the two, stands at exactly its natural",
        ).toBeLessThan(EPSILON);
        // And every pixel of the leftover is at the foot of the other one.
        expect(
          Math.abs(rects[1].height - (run.height - RAIL_SEAM_PX - wanted[0])),
          "and the Arcs card, the greedier, holds the whole of what is left over",
        ).toBeLessThan(EPSILON);
        expect(
          rects[1].height - wanted[1],
          "which is more than it asked for — the one stretch of empty space in the rail",
        ).toBeGreaterThan(1);
        // Still a division of the run: slack going to one member is not slack
        // going missing.
        expect(
          Math.abs(
            rects[0].height + rects[1].height + RAIL_SEAM_PX - run.height,
          ),
          "the heights and the seam add up to the run itself",
        ).toBeLessThan(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the badge menu offers the layout, and equalize means natural under flow",
    async () => {
      const app = await launchTugApp({
        testName: "at0542-rail-vertical-allocation",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        // The same two-card fixture part 7 uses, with a weight on the first
        // member so flow has something to forget when equalize is asked for.
        const PAIR = ["tripwires", "dashes"];
        const DRAGGED = 1.5;
        await seed(app, PAIR, { tripwires: DRAGGED, dashes: 1 });
        const declared = await readAppetites(app);
        const natural = PAIR.map((componentId) =>
          Math.max(FLOOR, declared?.[componentId]?.natural ?? FLOOR),
        );

        // ── The badge menu is the second door, and it states the present. ──
        //
        // A split place's menu offers Stack, then the layout as a checked
        // pair, then Equalize. Checked rather than a toggling row: a menu row
        // states a choice among answers, and the Layout card's mark is where
        // the present answer toggles.
        const front = await app.evalJS<string | null>(
          `(function () {
            var members = Array.from(
              document.querySelectorAll('.tug-pane[data-rail-side="right"]'),
            );
            if (members.length === 0) return null;
            var zOf = function (el) {
              var z = parseInt(window.getComputedStyle(el).zIndex, 10);
              return Number.isNaN(z) ? 0 : z;
            };
            return members
              .slice()
              .sort(function (a, b) { return zOf(a) - zOf(b); })
              .pop()
              .getAttribute("data-pane-id");
          })()`,
        );
        expect(front, "the rail has a member whose badge is reachable").not.toBeNull();
        await app.nativeClickAtElement(
          `.tug-pane[data-pane-id="${front}"] [data-testid="tug-pane-title-bar-stack-badge"]`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="tug-pane-title-bar-stack-menu"]') !== null`,
          { timeoutMs: 8_000 },
        );
        const rows = await app.evalJS<{ label: string; checked: boolean }[]>(
          `Array.from(document.querySelectorAll('[data-testid="tug-pane-title-bar-stack-menu"] [role="menuitem"], [data-testid="tug-pane-title-bar-stack-menu"] [role="menuitemradio"]'))
            .map(function (el) {
              return {
                label: (el.textContent || "").trim(),
                checked: el.getAttribute("aria-checked") === "true" ||
                  el.getAttribute("data-selected") === "true",
              };
            })`,
        );
        note(
          `badge menu: ${rows.map((r) => `${r.label}${r.checked ? " ✓" : ""}`).join(" · ")}`,
        );
        const fit = rows.find((r) => r.label === "Fit");
        const flow = rows.find((r) => r.label === "Flow");
        expect(fit, "the menu offers Fit").toBeDefined();
        expect(flow, "and Flow beside it").toBeDefined();
        expect(fit!.checked, "and the check says which one the place is on").toBe(
          true,
        );
        expect(flow!.checked, "which is not the other one").toBe(false);

        // ── Choosing Flow puts the rail on a strip, and nobody is stretched. ──
        await app.evalJS<null>(
          `(function () {
            var rows = Array.from(document.querySelectorAll('[data-testid="tug-pane-title-bar-stack-menu"] [role="menuitem"], [data-testid="tug-pane-title-bar-stack-menu"] [role="menuitemradio"]'));
            var row = rows.filter(function (el) {
              return (el.textContent || "").trim() === "Flow";
            })[0];
            if (row) row.click();
            return null;
          })()`,
        );
        await wait(AFTER_LAND_MS);
        expect(
          await standing(app),
          "the rail flows by choice, whatever its run",
        ).toBe("overflow");
        const flowing = await memberRects(app, PAIR);
        note(
          `flowing at natural × weight: ${flowing.map((r) => Math.round(r.height)).join(" / ")} against naturals ${natural.join(" / ")}`,
        );
        expect(
          Math.abs(flowing[0].height - natural[0] * DRAGGED),
          "the weighted member stands at its own natural times what the hand stored",
        ).toBeLessThan(EPSILON);
        expect(
          Math.abs(flowing[1].height - natural[1]),
          "and the undragged one at exactly its natural — flow stretches nobody",
        ).toBeLessThan(EPSILON);

        // ── The third door, and the meaning the layout gives it. ──
        //
        // A double-click on the seam clears the stored weights. Under fit that
        // is an equal division of the discretionary pool; under flow it is
        // every member standing at exactly the height its own content asked
        // for, which is the same sentence answered by the layout the place is
        // on.
        await app.nativeDoubleClickAtElement(`[data-rail-seam="right:0"]`);
        await wait(AFTER_LAND_MS);
        const equalized = await memberRects(app, PAIR);
        note(
          `after equalize under flow: ${equalized.map((r) => Math.round(r.height)).join(" / ")}`,
        );
        for (let i = 0; i < PAIR.length; i += 1) {
          expect(
            Math.abs(equalized[i].height - natural[i]),
            `${PAIR[i]} stands at exactly its natural once the weights are forgotten`,
          ).toBeLessThan(EPSILON);
        }
        expect(
          await app.evalJS<unknown>(
            `((window.tugdeck.diag.getDeckState().imposition.rails || {}).right || {}).shares || null`,
          ),
          "and the record is gone rather than rewritten to ones",
        ).toBeNull();
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

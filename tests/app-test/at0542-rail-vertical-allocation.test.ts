/**
 * at0542-rail-vertical-allocation.test.ts — a rail divides its run when its
 * members fit in it, and builds a strip out of them when they do not.
 *
 * A rail used to stop dividing at three members, whatever the room, and every
 * member of an overflowing rail used to be the same fixed fraction of the run,
 * whatever it asked for. Both were proxies for a question neither could see
 * ([P01], [B07]): is there room, and how much does this member want. One
 * allocator answers both now, from the members' own floors, natural heights and
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
 *      is read against the content it claims to measure — the same content,
 *      off the screen: a card's natural is its content element's border-box
 *      height plus the pane's title bar, which is the one part of the member's
 *      box that element cannot see ([B01]). And the two decks differ by
 *      exactly the five jots between them, at a row pitch read off each deck's
 *      own list rather than named here, because no card carries that number
 *      any more. No member is pushed past what it asked for, and the Cards
 *      card — which asks for less than its floor — stands at that floor.
 *      `DeckState.appetites` carries the declarations, which is the settle
 *      having run.
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
 *      `natural · weight`; and a double-click on the seam means Fit to
 *      Content, which under flow clears the weights so every member stands at
 *      exactly the height its content asked for.
 *   9. **A control pressed inside a fitting card stays where it was pressed.**
 *      Collapsing the FILES group in the Cards card and folding the Layout
 *      card's mixer are both appetite changes, and a seam that follows content
 *      answers each by moving — carrying the control the user just pressed off
 *      the edge it stood at. A fitting place divides its run by shares that
 *      only the hand may write, so the press changes the card's content and
 *      moves no seam: the cue's rect holds, the header stays inside its card,
 *      and every member's frame is where it was. The declarations still move
 *      — the appetite is read at the hand's moments, not ignored — and the
 *      case asserts that too, so a pass says the seam held AGAINST a change
 *      rather than in the absence of one. The third case is the other edge
 *      of the same rule: content that OUTGROWS a fitting card's share moves
 *      no seam either, and the card scrolls inside itself, until the user
 *      asks for Fit to Content — which re-seeds the division from the
 *      naturals as they stand, so the card that grew has no internal scroll
 *      and the others stand at what they asked for or less.
 *  10. **A content card's content element cannot see its pane.** Every part
 *      above reads a card's height as a number the card DECLARED. This one is
 *      about the element that number is going to be MEASURED from ([B01]):
 *      each content card names one in-flow column holding everything it draws,
 *      inside the card's one scroller with nothing stretched between them, and
 *      at a fixed rail width that column's border-box height is the SAME at a
 *      short pane and at a tall one. That is the whole safety argument for
 *      measuring at all ([B02]): a height that cannot move with the run it
 *      feeds has only one leg of the loop the no-measurement rule was written
 *      against, and cannot oscillate. A card that cannot pass it is a stream
 *      and says so in the registry ([B07]); Overview, the one stream today, is
 *      not asked.
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
 * @covers tugdeck/src/card-registry.ts
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
  RESIZE_RETUNE_QUIET_MS,
} from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const AFTER_LAND_MS = 900;
/** Geometry tolerance: the strip coordinates are published rounded to the
 *  pixel, so every frame's edge carries that rounding. */
const EPSILON = 2;
/** The floor every sidebar card declares. */
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
 * `CARD_TITLE_BAR_HEIGHT` in `tug-pane.tsx` — the pane chrome standing above
 * every card's scroller.
 *
 * The one number part 5 still names, and it is not a card's: a card's natural
 * is its content element MEASURED plus this, because the title bar is the
 * piece of the member's own box the column below the scroller cannot see
 * ([B01]). Every per-card pixel constant this file used to carry — a jot row,
 * a control row's pitch — is gone from the cards, so naming one here would be
 * naming a number nothing states any more.
 */
const CARD_TITLE_BAR_PX = 36;

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

/**
 * How many extra maker cards part 9's fixture stands, and the file card beside
 * them.
 *
 * Part 9 needs the Cards card ABOVE its floor and AT its natural — the one
 * arrangement where an allocator that follows content has something to take
 * back when a row goes away. Two maker cards in a stack draw a pane row and
 * two subrows, the one file draws a header and a row, and with the tools
 * header that puts the card's census a row or so past the 240px floor: small
 * enough that the run this harness opens satisfies it in full, large enough
 * that a collapse would shrink the card rather than leave it at the floor. The
 * case asserts that arrangement as a precondition rather than assuming it.
 */
const PINNED_MAKER_CARDS = 1;
/** The Text card part 9 opens in a floating pane, so the Cards card draws a
 *  FILES group with one file — and a fold cue on its header to press. */
const FILE_CARD_ID = "F";

/** One deck's reading, for the pair part 5 compares. */
interface Reading {
  rects: Rect[];
  run: { top: number; bottom: number; height: number };
  settled: Record<string, { natural: number }> | null;
  standing: string;
  /** How many control rows the Layout card drew — the count its own natural
   *  height is a function of. */
  layoutRows: number;
  /** Each content card's content element, measured off the screen — the
   *  border-box height its declaration is now made of ([B01]). */
  contents: Record<string, number>;
  /** The Jots list's own height and the rows in it, which is where the five
   *  jots between the two decks have to show up. */
  jotsList: number;
  jotsRows: number;
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
  withFileCard = false,
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
      ...(withFileCard
        ? [
            {
              id: FILE_CARD_ID,
              componentId: "text",
              title: "File",
              closable: true,
            },
          ]
        : []),
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
      ...(withFileCard
        ? [
            {
              id: "p2",
              position: { x: 480, y: 40 },
              size: { width: 400, height: 300 },
              cardIds: [FILE_CARD_ID],
              activeCardId: FILE_CARD_ID,
              title: "",
              acceptsFamilies: ["standard"],
              slot: 1,
            },
          ]
        : []),
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

/** Seed `components` onto the right rail and wait for every frame to stand.
 *  `filePath` also opens a Text card on that file in a floating pane, which
 *  is what gives the Cards card a FILES group. */
async function seed(
  app: App,
  components: readonly string[],
  shares?: Readonly<Record<string, number>>,
  extraMakerCards = 0,
  filePath?: string,
): Promise<void> {
  await app.seedDeckState({
    state: deckShape(components, shares, extraMakerCards, filePath !== undefined),
    ...(filePath === undefined
      ? {}
      : {
          cardStates: {
            [FILE_CARD_ID]: {
              content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 },
            },
          },
        }),
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
 * absent where the card declares nothing at all, which is what a stream does
 * ([B05]).
 *
 * `natural: null` stands for an endless one: no JSON value carries `Infinity`,
 * so the read below projects it rather than letting the RPC refuse the whole
 * object. Nothing publishes an endless natural today — the selector reads one
 * from the registry — but the projection stays, because a store that could
 * carry the value once could carry it again.
 */
type Declarations = Record<string, { natural: number | null }>;

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
 * hands its overflow to exactly one such element: its own root, which is the
 * card's one scroller and holds nothing but the content element part 10
 * measures ([B01]).
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

/**
 * The content cards and the element each one names as its content element
 * ([B01]): the in-flow column of everything it draws, from its toolbar to its
 * last row, standing inside the card's one scroller.
 *
 * Overview is deliberately absent. Its transcript is virtualized against its
 * own viewport, so its rendered height IS a function of the height it would
 * feed — the stream carve-out ([B05]/[B06]), and the one card the invariant
 * below cannot be asked of.
 *
 * A per-card selector rather than a shared class, because naming the element
 * is the point: the card decides which of its boxes is the one to measure, and
 * a class every card wears would let a card pass by wearing it on the wrong
 * box.
 */
const CONTENT_CARDS: readonly { componentId: string; selector: string }[] = [
  { componentId: "layout", selector: "[data-testid='layout-card-content']" },
  { componentId: "jots", selector: "[data-testid='jots-card-content']" },
  { componentId: "cards", selector: "[data-testid='cards-card-content']" },
  { componentId: "dashes", selector: "[data-testid='arcs-card-content']" },
  {
    componentId: "tripwires",
    selector: "[data-testid='tripwires-card-content']",
  },
];

/**
 * The share the card under test takes of the fitting rail in the TALL reading;
 * the SHORT one is its complement, so one seed pair gives both extremes.
 *
 * Not nearer the ends than this: a share that puts either member under its
 * 240px floor stops the rail sharing at all, and the pair would then be two
 * readings of the same overflowing standing.
 */
const CONTENT_TALL_SHARE = 0.68;

/** How far apart the two pane heights must stand for the reading to mean
 *  anything, in px. Asserted rather than assumed — equal content measured at
 *  one pane height twice is a vacuous pass. */
const CONTENT_PANE_SPREAD = 200;

/** One content card's two numbers: the border-box height of its content
 *  element, and the height of the pane that element is standing in. */
interface ContentReading {
  content: number;
  pane: number;
}

/**
 * The card's content element and its pane, measured together so the pair is
 * read from one layout rather than from two.
 *
 * `null` when the card is not on screen or names no content element, which the
 * caller asserts against: a card with no content element is a card nothing can
 * measure, and that is a failure rather than a skip.
 */
async function contentReading(
  app: App,
  card: { componentId: string; selector: string },
): Promise<ContentReading | null> {
  return app.evalJS<ContentReading | null>(
    `(function () {
      var host = document.querySelector(
        '[data-card-host][data-card-id="${card.componentId.toUpperCase()}"]',
      );
      if (host === null) return null;
      var el = host.querySelector(${JSON.stringify(card.selector)});
      if (el === null) return null;
      var pane = document.querySelector(
        '.tug-pane[data-pane-id="${paneOf(card.componentId)}"]',
      );
      if (pane === null) return null;
      return {
        content: el.getBoundingClientRect().height,
        pane: pane.getBoundingClientRect().height,
      };
    })()`,
  );
}

/** One element's box in viewport coordinates — what part 9 records before a
 *  press and reads back after the settle. `null` when nothing matches. */
interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

async function elementBox(app: App, selector: string): Promise<Box | null> {
  return app.evalJS<Box | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    })()`,
  );
}

/** Every named edge of `after` within tolerance of `before`'s — the element
 *  did not move. Each edge is its own assertion so a failure names the edge. */
function expectSameBox(
  before: Box,
  after: Box,
  what: string,
  edges: readonly (keyof Box)[] = ["top", "bottom", "left", "right"],
): void {
  for (const edge of edges) {
    expect(
      Math.abs(after[edge] - before[edge]),
      `${what}: its ${edge} edge is where it was`,
    ).toBeLessThan(EPSILON);
  }
}

/** Every member's frame within tolerance of where it stood. */
function expectSameRects(
  before: readonly Rect[],
  after: readonly Rect[],
  components: readonly string[],
  why: string,
): void {
  for (const [index, componentId] of components.entries()) {
    expect(
      Math.abs(after[index].top - before[index].top),
      `${componentId}'s top edge did not move — ${why}`,
    ).toBeLessThan(EPSILON);
    expect(
      Math.abs(after[index].bottom - before[index].bottom),
      `${componentId}'s bottom edge did not move — ${why}`,
    ).toBeLessThan(EPSILON);
  }
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
        // is `max(floor, natural · weight)`.
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
            { natural: number }
          > | null>(
            `(window.tugdeck.diag.getDeckState().appetites || null)`,
          );
          const how = await standing(app);
          const layoutRows = await app.evalJS<number>(
            `document.querySelectorAll(".layouts-section-row").length`,
          );
          // The content elements, off the screen: this is what the cards are
          // now measuring, so the declarations are read against it rather than
          // against a second copy of a formula the cards no longer carry.
          const contents = await app.evalJS<Record<string, number>>(
            `(function () {
              var out = {};
              ${JSON.stringify(
                CONTENT_CARDS.map((card) => [card.componentId, card.selector]),
              )}.forEach(function (pair) {
                var el = document.querySelector(pair[1]);
                if (el !== null) out[pair[0]] = el.getBoundingClientRect().height;
              });
              return out;
            })()`,
          );
          const jotsList = await app.evalJS<number>(
            `(function () {
              var el = document.querySelector(".tug-list-view.jots-list");
              return el === null ? 0 : el.getBoundingClientRect().height;
            })()`,
          );
          const jotsRows = await app.evalJS<number>(
            `document.querySelectorAll(".jot-row-content[data-jot-id]").length`,
          );
          note(
            `${jots} jots: ${rects
              .map((r, i) => `${MODEST[i]} ${Math.round(r.height)}`)
              .join(", ")} — the rail stands ${how}, run ${run.height.toFixed(1)}px`,
          );
          return {
            rects,
            run,
            settled,
            standing: how,
            layoutRows,
            contents,
            jotsList,
            jotsRows,
          };
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
      // Each declaration is then read against the content it claims to measure
      // — and it is the SAME content, off the screen, rather than a second copy
      // of a formula. A card's natural is its content element's border-box
      // height plus the pane's title bar, which is the only part of the
      // member's box the column below the scroller cannot see ([B01]).
      for (const componentId of MODEST) {
        const content = many.contents[componentId];
        expect(
          content,
          `${componentId} drew a content element to measure`,
        ).toBeGreaterThan(0);
        note(
          `${componentId}: content element ${content.toFixed(1)}px, declared ${many.settled?.[componentId]?.natural}`,
        );
        expect(
          Math.abs(
            (many.settled?.[componentId]?.natural ?? 0) -
              (CARD_TITLE_BAR_PX + content),
          ),
          `${componentId} asks for the height its content element actually stands at, under the pane's title bar`,
        ).toBeLessThan(EPSILON);
      }

      // And the five jots between the two decks are five rows of the list, so
      // the declaration moved by the content and by nothing else. The pitch is
      // read off each deck's own list rather than named here — a row whose
      // padding is retuned moves both readings together, which is the whole
      // reason the cards stopped carrying the number.
      const pitchOf = (reading: Reading): number =>
        reading.jotsList / reading.jotsRows;
      expect(many.jotsRows, "the Jots card drew its rows").toBe(JOTS_MANY);
      expect(few.jotsRows, "and the shorter deck drew its own").toBe(JOTS_FEW);
      note(
        `jots row pitch: ${pitchOf(few).toFixed(2)}px at ${JOTS_FEW} rows, ${pitchOf(many).toFixed(2)}px at ${JOTS_MANY}`,
      );
      expect(
        Math.abs(pitchOf(many) - pitchOf(few)),
        "the two decks agree on what a jot row is tall",
      ).toBeLessThan(1);
      expect(
        Math.abs(
          (many.settled?.jots.natural ?? 0) -
            (few.settled?.jots.natural ?? 0) -
            (JOTS_MANY - JOTS_FEW) * pitchOf(many),
        ),
        "and the Jots card's declaration grew by exactly the five jots between them",
      ).toBeLessThan(EPSILON);

      expect(
        many.settled?.layout,
        "the Layout card's declaration reached deck state",
      ).toBeDefined();
      expect(
        many.layoutRows,
        "the Layout card drew control rows to count",
      ).toBeGreaterThan(0);

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
  // used to need a stored weight and a second app to seed it into, because
  // flow's tier was a rung below natural. The declarations come out of
  // the deck's own settled mirror rather than being recomputed here, so the
  // height under test is the height the card asked for rather than one this
  // file agreed with itself about.
  //
  // Two members are not askable, and both are skipped by RULE rather than by
  // name, with a `note()` each so a skip is visible rather than silent:
  // Overview declares nothing at all — it is a stream, and a stream is never
  // measured ([B05]) — and a card
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
              return `${componentId} natural ${
                appetite === undefined ? "none — a stream" : (appetite.natural ?? "endless")
              }`;
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
          // A card that declared NOTHING is a stream: the registry says so and
          // the card publishes nothing at all ([B05]), so there is no height
          // to check it at. Overview is the one today, and it is skipped by
          // that rule rather than by name.
          if (appetite === undefined || appetite.natural === null) {
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
        // A double-click on the seam means Fit to Content. Under fit that
        // re-seeds the division from the naturals; under flow it clears the
        // stored weights, which is every member standing at exactly the height
        // its own content asked for — the same sentence answered by the layout
        // the place is on.
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
          "and the record is gone rather than rewritten — under flow, fit to content is no record at all",
        ).toBeNull();
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── 9. A seam belongs to the hand. ──
  //
  // Parts 1–8 ask how a rail divides its run. This asks what the division may
  // NOT do: move while the user is pressing something inside it. Collapsing
  // the FILES group in the Cards card takes a row out of its census, and
  // folding the Layout card's mixer drops its natural to its plate; both are
  // appetite changes, and an allocation that follows content answers each by
  // moving a seam — which carries the control that was just pressed off the
  // edge it stood at, and is the complaint this part exists to pin. A fitting
  // place divides its run by stored shares that only a seam drag, a membership
  // change or Fit to Content may write, so a press inside a card changes the
  // card's content and nothing else.
  //
  // The fixture stands the Cards card above its floor and at its natural,
  // which is the arrangement where a content-following allocator has
  // something to take back: an empty jots file leaves the Jots card at its
  // floor with nothing to grow into, and two maker cards plus one file put the
  // Cards card's census a row or so past the floor. The case asserts that
  // arrangement before it presses anything, because a Cards card standing at
  // its floor would hold still under either rule and prove nothing.
  //
  // Each press is followed by a read of the declarations, and the case asserts
  // that they MOVED — the collapse asks for less, the fold asks for its plate.
  // Without that, a pass could be an appetite that never changed rather than a
  // seam that held against one.
  test(
    "collapsing a group inside a fitting card moves no seam, and the cue stays put",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tug-at0542-pinned-"));
      const jotsPath = join(dir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: [] }, null, 2)}\n`,
      );
      const filePath = join(dir, "alpha.txt");
      writeFileSync(filePath, "alpha\nbeta\n", "utf8");
      const app = await launchTugApp({
        testName: "at0542-pinned-control",
        env: { TUG_JOTS_PATH: jotsPath },
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await seed(app, MODEST, undefined, PINNED_MAKER_CARDS, filePath);
        // Past the settle's own quiet period and the deck's landing, so a
        // re-allocation the press provoked has had every chance to commit.
        const settleMs = RESIZE_RETUNE_QUIET_MS + AFTER_LAND_MS;

        // ── The arrangement under test. ──
        expect(
          await standing(app),
          "the three fit, which is the standing whose seams are a division",
        ).toBe("shared");
        const declared = await readAppetites(app);
        expect(declared, "the cards' declarations reached deck state").not.toBeNull();
        const cardsNatural = (declared as Declarations).cards.natural;
        expect(
          cardsNatural,
          "the Cards card declared a finite natural",
        ).not.toBeNull();
        const before = await memberRects(app, MODEST);
        note(
          `pinned fixture: run ${(await railRun(app)).height.toFixed(1)}px; ${MODEST.map(
            (componentId, i) =>
              `${componentId} ${Math.round(before[i].height)} (natural ${
                (declared as Declarations)[componentId].natural ?? "none"
              })`,
          ).join(", ")}`,
        );
        expect(
          cardsNatural as number,
          "the fixture stands the Cards card's natural above its floor",
        ).toBeGreaterThan(FLOOR + EPSILON);
        expect(
          before[0].height,
          "and the card at or above that natural — a content-following allocator has a smaller natural to re-run its ladder on",
        ).toBeGreaterThan((cardsNatural as number) - EPSILON);

        // ── Collapsing FILES. ──
        const filesHeader = `.tug-pane[data-pane-id="${paneOf(
          "cards",
        )}"] .cards-header[data-cards-group="files"]`;
        const filesCue = `${filesHeader} [data-slot="block-fold-cue"]`;
        const cueBefore = await elementBox(app, filesCue);
        expect(cueBefore, "the FILES header offers its fold cue").not.toBeNull();
        const headerBefore = await elementBox(app, filesHeader);
        expect(
          (headerBefore as Box).bottom,
          "and the header stands inside the Cards card before the press",
        ).toBeLessThanOrEqual(before[0].bottom + EPSILON);
        await app.nativeClickAtElement(filesCue);
        await app.waitForCondition<boolean>(
          `document.querySelector('${filesHeader}').getAttribute("data-group-collapsed") === "true"`,
          { timeoutMs: 8_000 },
        );
        await wait(settleMs);

        const collapsed = await readAppetites(app);
        const collapsedNatural = (collapsed as Declarations).cards.natural;
        const afterCollapse = await memberRects(app, MODEST);
        const cueAfter = await elementBox(app, filesCue);
        const headerAfter = await elementBox(app, filesHeader);
        note(
          `after collapsing FILES: cards natural ${cardsNatural} → ${collapsedNatural}; heights ${afterCollapse
            .map((r, i) => `${MODEST[i]} ${Math.round(r.height)}`)
            .join(", ")}; cue top ${Math.round((cueBefore as Box).top)} → ${
            cueAfter === null ? "gone" : Math.round(cueAfter.top)
          }`,
        );
        expect(
          collapsedNatural as number,
          "the collapse shrank what the Cards card asks for — the declaration still moves",
        ).toBeLessThan(cardsNatural as number);
        expect(cueAfter, "the fold cue is still on screen").not.toBeNull();
        expectSameBox(
          cueBefore as Box,
          cueAfter as Box,
          "the fold cue stands exactly where it was pressed",
        );
        expect(headerAfter, "the FILES header is still drawn").not.toBeNull();
        expect(
          (headerAfter as Box).bottom,
          "and the header is still on screen, inside its own card",
        ).toBeLessThanOrEqual(afterCollapse[0].bottom + EPSILON);
        expect(
          (headerAfter as Box).top,
          "not scrolled out past the card's top either",
        ).toBeGreaterThanOrEqual(afterCollapse[0].top - EPSILON);
        expectSameRects(
          before,
          afterCollapse,
          MODEST,
          "content changed and no seam did",
        );
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The same question of the Layout card's own fold. The mixer folding is the
  // larger of the two appetite changes — a folded card asks for its plate and
  // nothing below it — and the cue that folds it is the control the user is
  // pressing. The plate stands over the run it was given until the hand says
  // otherwise; the declared natural still falls, by exactly one pitch per row
  // the fold took away, so a later re-seed reads the folded card correctly.
  test(
    "folding the Layout mixer inside a fitting rail moves no seam, and the cue stays put",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tug-at0542-pinned-fold-"));
      const jotsPath = join(dir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: [] }, null, 2)}\n`,
      );
      const filePath = join(dir, "alpha.txt");
      writeFileSync(filePath, "alpha\nbeta\n", "utf8");
      const app = await launchTugApp({
        testName: "at0542-pinned-fold",
        env: { TUG_JOTS_PATH: jotsPath },
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await seed(app, MODEST, undefined, PINNED_MAKER_CARDS, filePath);
        const settleMs = RESIZE_RETUNE_QUIET_MS + AFTER_LAND_MS;
        expect(
          await standing(app),
          "the three fit, which is the standing whose seams are a division",
        ).toBe("shared");
        const declared = await readAppetites(app);
        expect(declared, "the cards' declarations reached deck state").not.toBeNull();
        const layoutDeclared = (declared as Declarations).layout;
        // The rows the fold is about to take away. The plate — what the card
        // asks for once they are gone — is not arithmetic here any more: it is
        // the content element MEASURED after the fold, read below. The card
        // carries no sum to restate.
        const foldRows = await app.evalJS<number>(
          `document.querySelectorAll(".layouts-section-row").length`,
        );
        expect(
          foldRows,
          "the mixer stands open over rows the fold can take away",
        ).toBeGreaterThan(0);
        const layoutContent = async (): Promise<number> =>
          app.evalJS<number>(
            `(function () {
              var el = document.querySelector("[data-testid='layout-card-content']");
              return el === null ? 0 : el.getBoundingClientRect().height;
            })()`,
          );
        const contentBefore = await layoutContent();
        expect(
          Math.abs(
            (layoutDeclared.natural ?? 0) - (CARD_TITLE_BAR_PX + contentBefore),
          ),
          "the open card asks for the height its content element stands at",
        ).toBeLessThan(EPSILON);
        const before = await memberRects(app, MODEST);
        note(
          `fold fixture: run ${(await railRun(app)).height.toFixed(1)}px; ${MODEST.map(
            (componentId, i) => `${componentId} ${Math.round(before[i].height)}`,
          ).join(", ")}; layout natural ${
            layoutDeclared.natural
          } over ${foldRows} rows, content element ${contentBefore.toFixed(1)}px`,
        );

        const mixerCue = `.tug-pane[data-pane-id="${paneOf(
          "layout",
        )}"] [data-slot="layout-card-mixer-cue"]`;
        expect(
          await app.evalJS<string | null>(
            `(function () {
              var el = document.querySelector('${mixerCue}');
              return el === null ? null : el.getAttribute("aria-expanded");
            })()`,
          ),
          "the Layout card's mixer stands open, with its cue offering to fold it",
        ).toBe("true");
        const cueBefore = await elementBox(app, mixerCue);
        await app.nativeClickAtElement(mixerCue);
        await app.waitForCondition<boolean>(
          `document.querySelector('${mixerCue}').getAttribute("aria-expanded") === "false"`,
          { timeoutMs: 8_000 },
        );
        await wait(settleMs);

        const folded = await readAppetites(app);
        const contentAfter = await layoutContent();
        // The plate: what the folded card actually draws, measured. Nothing
        // reconstructs it from a pitch any more, on either side.
        const plate = CARD_TITLE_BAR_PX + contentAfter;
        const after = await memberRects(app, MODEST);
        const cueAfter = await elementBox(app, mixerCue);
        note(
          `after folding the mixer: layout natural ${layoutDeclared.natural} → ${
            (folded as Declarations).layout.natural
          }; heights ${after
            .map((r, i) => `${MODEST[i]} ${Math.round(r.height)}`)
            .join(", ")}; cue top ${Math.round((cueBefore as Box).top)} → ${
            cueAfter === null ? "gone" : Math.round(cueAfter.top)
          }`,
        );
        expect(
          Math.abs(((folded as Declarations).layout.natural ?? 0) - plate),
          "the folded card asks for the plate it now draws — the declaration still moves, and it moves to what is on screen",
        ).toBeLessThan(EPSILON);
        expect(
          plate,
          "and the fold really took the rows away, so the ask fell",
        ).toBeLessThan((layoutDeclared.natural ?? 0) - EPSILON);
        expect(
          before[2].height,
          "the Layout card stood above its plate, so the fold had something to hand back",
        ).toBeGreaterThan(plate + EPSILON);
        expect(cueAfter, "the fold cue is still on screen").not.toBeNull();
        expectSameBox(
          cueBefore as Box,
          cueAfter as Box,
          "the fold cue stands exactly where it was pressed",
          // The vertical edges are the seam's; the horizontal ones are the
          // card's own, and a fold that empties the card's scroller can move
          // the header's trailing edge by a scrollbar's width without any
          // seam having moved.
          ["top", "bottom"],
        );
        expectSameRects(
          before,
          after,
          MODEST,
          "the plate stands over the run it was given until the hand says otherwise",
        );
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The other edge of the same rule. Parts 9's first two cases press a control
  // that makes a card ask for LESS; this one makes the Cards card ask for MORE
  // than its share, one new file at a time, and asserts the seam holds and the
  // card scrolls inside itself — the honest fit answer, and the one every
  // editor's split pane gives. Then it asks for Fit to Content, the one verb
  // that re-seeds on request, and asserts the division is the naturals' again.
  //
  // The seed put the slack under the Cards card, which is the greediest of the
  // finite cards, so the presses first fill that slack and then run past it;
  // the loop reads the declaration after each press rather than counting on a
  // row pitch, and the case asserts the natural crossed the share before it
  // reads anything else, so a pass says the seam held AGAINST content that
  // wanted more.
  test(
    "content outgrowing a fitting card's share moves no seam, and Fit to Content re-seeds on request",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tug-at0542-fit-to-content-"));
      const jotsPath = join(dir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: [] }, null, 2)}\n`,
      );
      const filePath = join(dir, "alpha.txt");
      writeFileSync(filePath, "alpha\nbeta\n", "utf8");
      const app = await launchTugApp({
        testName: "at0542-fit-to-content",
        env: { TUG_JOTS_PATH: jotsPath },
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await seed(app, MODEST, undefined, PINNED_MAKER_CARDS, filePath);
        const settleMs = RESIZE_RETUNE_QUIET_MS + AFTER_LAND_MS;
        expect(
          await standing(app),
          "the three fit, which is the standing whose seams are a division",
        ).toBe("shared");
        const before = await memberRects(app, MODEST);
        const share = before[0].height;
        const seeded = await readAppetites(app);
        expect(seeded, "the cards' declarations reached deck state").not.toBeNull();
        note(
          `fit-to-content fixture: run ${(await railRun(app)).height.toFixed(1)}px; ${MODEST.map(
            (componentId, i) =>
              `${componentId} ${Math.round(before[i].height)} (natural ${
                (seeded as Declarations)[componentId].natural ?? "none"
              })`,
          ).join(", ")}`,
        );

        // ── ⌥⌘N until the Cards card asks for more than it holds. ──
        const MAX_PRESSES = 16;
        const textCards = `window.tugdeck.diag.getDeckState().cards.filter(function (c) { return c.componentId === "text"; }).length`;
        const textCardsBefore = await app.evalJS<number>(textCards);
        let declared = seeded as Declarations;
        let presses = 0;
        while (
          presses < MAX_PRESSES &&
          (declared.cards.natural ?? 0) <= share + EPSILON
        ) {
          await app.nativeKey("n", ["alt", "cmd"]);
          presses += 1;
          await app.waitForCondition<boolean>(
            `${textCards} === ${textCardsBefore + presses}`,
            { timeoutMs: 8_000 },
          );
          await wait(settleMs);
          declared = (await readAppetites(app)) as Declarations;
        }
        note(
          `after ${presses} new file${presses === 1 ? "" : "s"}: cards natural ${
            (seeded as Declarations).cards.natural
          } → ${declared.cards.natural} against a share of ${Math.round(share)}`,
        );
        expect(
          presses,
          "the loop pressed at all — a fixture whose Cards card already outgrew its share proves nothing about growth",
        ).toBeGreaterThan(0);
        expect(
          declared.cards.natural as number,
          "the Cards card now asks for more than its share",
        ).toBeGreaterThan(share + EPSILON);

        const grown = await memberRects(app, MODEST);
        expectSameRects(
          before,
          grown,
          MODEST,
          "content that outgrew its share moved no seam",
        );
        const overgrown = await cardScroller(app, "CARDS");
        expect(overgrown, "the Cards card has a scroll container").not.toBeNull();
        const left = (overgrown as Scroller).scrollHeight - (overgrown as Scroller).clientHeight;
        note(
          `cards ${(overgrown as Scroller).label} ${(overgrown as Scroller).scrollHeight}/${
            (overgrown as Scroller).clientHeight
          } — ${Math.round(left)}px left to scroll inside the card`,
        );
        expect(
          left,
          "and the card scrolls inside itself — the honest fit answer",
        ).toBeGreaterThan(1);

        // ── Fit to Content, from the badge menu. ──
        await app.nativeClickAtElement(
          `.tug-pane[data-pane-id="${paneOf(
            "cards",
          )}"] [data-testid="tug-pane-title-bar-stack-badge"]`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="tug-pane-title-bar-stack-menu"]') !== null`,
          { timeoutMs: 8_000 },
        );
        const menuRows = `Array.from(document.querySelectorAll('[data-testid="tug-pane-title-bar-stack-menu"] [role="menuitem"], [data-testid="tug-pane-title-bar-stack-menu"] [role="menuitemradio"]'))`;
        const labels = await app.evalJS<string[]>(
          `${menuRows}.map(function (el) { return (el.textContent || "").trim(); })`,
        );
        note(`badge menu: ${labels.join(" · ")}`);
        expect(
          labels.indexOf("Fit to Content"),
          "the menu offers Fit to Content, beside Equalize Heights",
        ).toBe(labels.indexOf("Equalize Heights") + 1);
        await app.evalJS<null>(
          `(function () {
            var row = ${menuRows}.filter(function (el) {
              return (el.textContent || "").trim() === "Fit to Content";
            })[0];
            if (row) row.click();
            return null;
          })()`,
        );
        await wait(settleMs);

        const fitted = await memberRects(app, MODEST);
        const record = await app.evalJS<Record<string, number> | null>(
          `((window.tugdeck.diag.getDeckState().imposition.rails || {}).right || {}).shares || null`,
        );
        note(
          `after Fit to Content: heights ${fitted
            .map((r, i) => `${MODEST[i]} ${Math.round(r.height)}`)
            .join(", ")}; naturals ${MODEST.map(
            (componentId) => `${componentId} ${declared[componentId].natural}`,
          ).join(", ")}; record ${JSON.stringify(record)}`,
        );
        expect(
          await standing(app),
          "the rail still fits — the re-seed divides, it does not overflow",
        ).toBe("shared");
        expect(record, "the re-seed wrote a record").not.toBeNull();
        expect(
          Object.keys(record as Record<string, number>).sort(),
          "naming exactly the rail's members",
        ).toEqual([...MODEST].sort());
        expect(
          fitted[0].height,
          "the Cards card stands at or above the natural it declared",
        ).toBeGreaterThan((declared.cards.natural as number) - EPSILON);
        const refitted = await cardScroller(app, "CARDS");
        const leftAfter =
          refitted === null
            ? 0
            : refitted.scrollHeight - refitted.clientHeight;
        expect(
          leftAfter,
          "and has nothing left to scroll inside itself",
        ).toBeLessThanOrEqual(1);
        for (const [i, componentId] of MODEST.entries()) {
          if (i === 0) continue;
          const asked = Math.max(FLOOR, declared[componentId].natural ?? FLOOR);
          expect(
            fitted[i].height,
            `${componentId} stands at what it asked for or less — the slack went to the card that grew, not to it`,
          ).toBeLessThan(asked + EPSILON);
        }
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── 10. A content card's content element cannot see its pane. ──
  //
  // The claim every part above rests on is that a card's declared height is
  // true of the card. This one is about the element the declaration is about
  // to be MEASURED from, and it is asked BEFORE any observer is wired ([B02]):
  // a content element whose height moves with the pane's would close the loop
  // the no-measurement rule was written against, and no ResizeObserver may be
  // put on one until this passes.
  //
  // The two pane heights come from the fitting rail's own stored shares — the
  // weights a seam drag writes — so the card is read at two heights it really
  // stands at rather than at two the test arranged. The spread between them is
  // asserted as a precondition: two readings at the same pane height would
  // pass this vacuously.
  //
  // One test per card, so a failure names the card that cannot be measured —
  // which is the verdict that admits a card as `"content"` or sends it to the
  // registry as a stream ([B07]).
  for (const card of CONTENT_CARDS) {
    test(
      `the ${card.componentId} card's content element measures the same at a short pane and a tall one`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "tug-at0542-content-"));
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
        const app = await launchTugApp({
          testName: `at0542-content-element-${card.componentId}`,
          env: { TUG_JOTS_PATH: jotsPath },
        });
        try {
          // The fixed rail width the invariant is stated at: a content
          // element's height IS a function of its width, so a reading at two
          // widths would be a different claim.
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
          );
          // Overview is the partner because it is the one card this part does
          // not ask about — a stream, never measured — so whatever the shares
          // do to it is not a reading.
          const pair = [card.componentId, "overview"];
          const readings: ContentReading[] = [];
          for (const share of [CONTENT_TALL_SHARE, 1 - CONTENT_TALL_SHARE]) {
            await seed(
              app,
              pair,
              { [card.componentId]: share, overview: 1 - share },
              EXTRA_MAKER_CARDS,
            );
            const reading = await contentReading(app, card);
            expect(
              reading,
              `the ${card.componentId} card names a content element and stands in a pane`,
            ).not.toBeNull();
            readings.push(reading as ContentReading);
          }
          const [tall, short] = readings;
          note(
            `${card.componentId}: pane ${Math.round(tall.pane)} → content ${
              Math.round(tall.content)
            }; pane ${Math.round(short.pane)} → content ${Math.round(short.content)}`,
          );
          expect(
            Math.abs(tall.pane - short.pane),
            `the two shares really did stand the ${card.componentId} card at two different heights — equal content at one pane height proves nothing`,
          ).toBeGreaterThan(CONTENT_PANE_SPREAD);
          expect(
            Math.abs(tall.content - short.content),
            `the ${card.componentId} card's content element measures the same in both — a column that grows with its pane measures the height it feeds, which is the loop the no-measurement rule was written against ([B02])`,
          ).toBeLessThan(EPSILON);
        } finally {
          await app.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  // ── 11. A stream declares by being registered as one. ──
  //
  // A fitting rail's division is SEEDED once, into a stored record, and every
  // settle afterwards reads that record rather than the naturals — which is
  // what "a seam belongs to the hand" comes to in code. The seed waits until
  // every member has said what it wants of the run, because a seed taken at
  // the first card's publish would stand every card still to come at an
  // endless natural.
  //
  // A stream never publishes anything: it says what it wants at REGISTRATION
  // and the selector reads its natural as endless from there ([B05]). So a
  // wait for a published entry is a wait that never ends, and a rail carrying
  // the Overview would go unseeded for the life of the app — its record
  // dropped at every membership change and never written back, leaving every
  // later settle to re-derive the division from whatever the other cards'
  // content had grown to. The case is the pair that shows it: the stream
  // publishes nothing, the content card publishes, and the record is written
  // all the same.
  test(
    "a fitting rail carrying the one stream still seeds its division",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tug-at0542-stream-seed-"));
      const jotsPath = join(dir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          {
            version: 1,
            jots: Array.from({ length: JOTS_FEW }, (_, i) => ({
              id: `j${i}`,
              text: `jot ${i}`,
            })),
          },
          null,
          2,
        )}\n`,
      );
      const app = await launchTugApp({
        testName: "at0542-stream-seed",
        env: { TUG_JOTS_PATH: jotsPath },
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        // No shares: the record is absent, which is exactly the state the seed
        // exists to fill. Two members, so there is a division to write at all.
        const pair = ["jots", "overview"];
        await seed(app, pair);
        await wait(RESIZE_RETUNE_QUIET_MS + AFTER_LAND_MS);
        expect(
          await standing(app),
          "the two fit, which is the standing whose division is a stored record",
        ).toBe("shared");

        // The premise, asserted rather than assumed: the stream really did
        // publish nothing, and the content card really did publish. Without
        // both halves the case would pass on a rail where nothing was being
        // waited for.
        const declared = await readAppetites(app);
        expect(declared, "the settle ran at all").not.toBeNull();
        note(`declared: ${JSON.stringify(declared)}`);
        expect(
          (declared as Declarations).overview,
          "the Overview is a stream and publishes no appetite ([B05])",
        ).toBeUndefined();
        expect(
          (declared as Declarations).jots,
          "and the Jots card, which is measured, published one",
        ).toBeDefined();

        const record = await app.evalJS<Record<string, number> | null>(
          `((window.tugdeck.diag.getDeckState().imposition.rails || {}).right || {}).shares || null`,
        );
        note(`seeded record: ${JSON.stringify(record)}`);
        expect(
          record,
          "the rail's division was seeded — a stream's silence is a declaration, not a card the seed is still waiting on",
        ).not.toBeNull();
        expect(
          Object.keys(record as Record<string, number>).sort(),
          "and the record names exactly the members standing on the rail",
        ).toEqual([...pair].sort());
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

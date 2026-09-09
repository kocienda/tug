/**
 * at0469-layout-places.test.ts — the deck's picture, wearing its places.
 *
 * The Layout section draws the deck at scale and now marks every arrangeable
 * place on that drawing: a slot's mark says whether the slot is stacked or
 * split, a side's mark says the same for its rail. What makes the marks worth
 * having — and what this file is for — is that they read the STORED
 * arrangement rather than the drawn one.
 *
 * The two come apart at exactly one card. Membership churn preserves an
 * arrangement (`columnDrawsSplit` in `deck-store-selectors.ts`), so a slot set
 * to split and standing one card deep renders as one undivided card. Before the
 * overlay that stored split was invisible on every surface and unreachable from
 * the Layout card, because the section's column rows were gated on `members.length > 1`
 * — so it sat there until a second card arrived and it resurfaced as a surprise.
 *
 *   1. **Every slot the kind defines is marked**, occupied or not, and each
 *      mark says that slot's own stored arrangement.
 *   2. **A one-card split is visible**, drawn split: the arrangement is real,
 *      there is just nothing standing under it yet.
 *   3. **The marks land on the picture.** Each one is inside the block it
 *      belongs to, which is what makes it a mark on a place rather than a row
 *      of icons under a drawing.
 *   4. **A rail is a place too**, and wears the same vocabulary.
 *   5. **A mark is a button.** It answers a hand and does not audition, and
 *      every mark rests at one weight — the picture states arrangements, not
 *      how many cards stand under them.
 *   6. **A place wears ONE mark, and the note says which thing scrolls.** The
 *      mark says stack or split and nothing more — the layout glyph it wore
 *      for a while is gone — and a rail put on flow through its mixer row
 *      draws as a strip in the miniature while the plan's note names the rail
 *      as the thing that scrolls.
 *   7. **A place's arrangement is a row in the mixer**, `Stack | Fit | Flow`
 *      per rail side and per slot with something to arrange. Stack writes the
 *      mode alone and the layout is remembered; Fit and Flow write the mode
 *      and the layout together. A rail row is disabled, never absent, while
 *      its side holds fewer than two cards; a column row is absent, never
 *      disabled, while its slot does.
 *
 * Read from live `getBoundingClientRect()` and `data-` attributes. Nothing here
 * reads back a declared style value.
 *
 * @covers tugdeck/src/components/layout/layout-places.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/components/layout/layout-card.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const PLACES = '[data-testid="layout-card-places"]';
const mark = (key: string): string => `[data-testid="layout-card-place-${key}"]`;

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** What a place's mark is saying, and where it stands. */
interface MarkFacts {
  mode: string | null;
  rect: Rect | null;
}

/**
 * Three-up with the Layout card on the right: slot 0 shared by two cards, slot 1 held
 * by ONE card — and the imposition stores slot 1 as split.
 *
 * That is the trap, seeded as the state it is. A deck reaches it by splitting a
 * shared slot and then losing a member (at0455 covers that geometry); what
 * matters here is only that the arrangement outlives the membership, which is
 * the deck's deliberate behavior and not an edge case to be reproduced by a
 * dance of three actions.
 */
function deckShape() {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  const members: [string, number, string][] = [
    ["p1", 0, "A"],
    ["p2", 0, "B"],
    ["p3", 1, "C"],
  ];
  return {
    cards: [
      ...members.map(([, , cardId]) => ({
        id: cardId,
        componentId: "hello",
        title: `Card ${cardId}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => pane(id, slot, cardId)),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { layout: { side: "right" } },
      // Slot 1 is SET to split and holds one card. Slot 0 is shared and
      // stacked, which is what an untouched shared slot is.
      columns: { 1: { mode: "split" } },
    },
    hasFocus: true,
  };
}

/**
 * Rest a pointer on an element the way the section would hear one.
 *
 * The harness has no hover verb, and a `pointerover` bubbles — so dispatching
 * it on the element itself and letting it rise is exactly what a real pointer
 * produces (`revealPaneControls` does the same). Every use of this below is
 * asking the section to answer a pointer and expecting it not to.
 */
async function hover(app: App, selector: string): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) throw new Error("nothing at " + ${JSON.stringify(selector)});
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      return null;
    })()`,
  );
}

/** Tab until `selector` is the group carrying the keyboard ring — the walk the
 *  sidebar ladder is actually navigated by (at0277 and at0455 use the same one). */
async function tabUntilKbd(app: App, selector: string): Promise<void> {
  const reached = (): Promise<boolean> =>
    app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(`${selector}[data-key-view-kbd]`)}) !== null`,
    );
  for (let i = 0; i < 24; i += 1) {
    if (await reached()) return;
    await app.nativeKey("Tab");
    await wait(200);
  }
  if (await reached()) return;
  throw new Error(`Tab never reached ${selector}`);
}

/**
 * Stand the KEYBOARD CURSOR on one segment of one of the section's rows — the
 * only gesture that raises an audition in the plan.
 *
 * Tab carries the ring to the row; the arrows move the cursor within it, which
 * is what a segmented group's walk is. The loop is direction-agnostic because
 * where the cursor starts is the row's committed answer, which the deck's
 * state decides rather than this test.
 */
async function cursorOnto(app: App, row: string, value: string): Promise<void> {
  const target = `[data-testid="${row}"] [data-key-cursor][data-choice-value="${value}"]`;
  const there = (): Promise<boolean> =>
    app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(target)}) !== null`,
    );
  await app.dispatchControlAction("toggle-layout");
  await wait(300);
  await tabUntilKbd(app, `[data-testid="${row}"]`);
  for (let i = 0; i < 8; i += 1) {
    if (await there()) return;
    await app.nativeKey("ArrowRight");
    await wait(150);
  }
  if (await there()) return;
  throw new Error(`the cursor never reached ${row}/${value}`);
}

/** Take the ring off the rows and put it on the picture, whose marks audition
 *  nothing — the keyboard's way of ending an audition without pressing. */
async function cursorOffTheRows(app: App): Promise<void> {
  await tabUntilKbd(app, `[data-testid="layout-card-places"]`);
  await wait(300);
}

/**
 * Every ARRANGEMENT mark the overlay is drawing, by place key.
 *
 * Scoped to `.layout-places-mark`, which is the stack/split kind. A sidebar
 * member is a place too and carries `data-place` as well, but what is
 * arrangeable about it is which edge it holds rather than how it stacks — a
 * different question, read by its own test below.
 */
function readMarks(app: App): Promise<Record<string, MarkFacts>> {
  return app.evalJS<Record<string, MarkFacts>>(
    `(function () {
      var out = {};
      var nodes = document.querySelectorAll('${PLACES} .layout-places-mark[data-place]');
      Array.prototype.forEach.call(nodes, function (el) {
        var r = el.getBoundingClientRect();
        out[el.getAttribute("data-place")] = {
          mode: el.getAttribute("data-mode"),
          rect: {
            top: r.top, bottom: r.bottom, left: r.left, right: r.right,
            width: r.width, height: r.height,
          },
        };
      });
      return out;
    })()`,
  );
}

/** The drawn block for a slot, in the committed drawing. */
function blockRect(app: App, slot: number): Promise<Rect | null> {
  return app.evalJS<Rect | null>(
    `(function () {
      var layer = document.querySelector('.layouts-plan-layer[data-plan-layer="committed"]');
      if (layer === null) return null;
      var blocks = layer.querySelectorAll(".layout-mini-field .layout-mini-block");
      var el = blocks[${slot}];
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return {
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        width: r.width, height: r.height,
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0469 — the drawing wears its places", () => {
  test(
    "every occupied place is marked with what it is SET to",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const marks = await readMarks(app);
        note(
          `marks: ${Object.keys(marks)
            .sort()
            .map((k) => `${k}=${marks[k].mode}`)
            .join(", ")}`,
        );

        // ── Every drawn slot is marked, the empty one included. ──
        //
        // The drawing draws all three of three-up's blocks, and an arrangement
        // outlives its membership all the way to zero — an empty slot can
        // still store a split — so every drawn block wears a mark. Slot 2 is
        // empty in this fixture, and marked at its default.
        expect(
          Object.keys(marks).sort(),
          "every slot the kind defines, and no rail",
        ).toEqual(["col-0", "col-1", "col-2"]);
        expect(marks["col-2"].mode, "the empty slot reads its default").toBe(
          "stack",
        );

        // ── The shared, untouched slot reads stacked. ──
        expect(marks["col-0"].mode).toBe("stack");

        // ── THE TRAP, VISIBLE. ──
        //
        // Slot 1 stores a split and holds one card. The drawing beneath shows
        // one undivided block, honestly — and the mark says the slot is set to
        // split, which is the fact that had nowhere to live.
        expect(
          marks["col-1"].mode,
          "slot 1 is SET to split, and says so even standing one card deep",
        ).toBe("split");

        // ── And every mark rests at ONE weight. ──
        //
        // An earlier cut whispered the places with fewer than two cards under
        // them. Two tints in one picture read as a rendering fault before they
        // read as a distinction, and the distinction was about membership,
        // which is not what a mark is for. Read as computed opacity across the
        // whole set — a declared value would prove only that the rule exists.
        const weights = await app.evalJS<number[]>(
          `Array.prototype.map.call(
            document.querySelectorAll('${PLACES} [data-testid^="layout-card-place-"]'),
            function (el) { return Number(getComputedStyle(el).opacity); }
          )`,
        );
        note(`resting weights: ${weights.join(", ")}`);
        expect(
          new Set(weights).size,
          "every mark rests at the same weight, whatever stands under it",
        ).toBe(1);
        expect(weights[0], "and that weight is full").toBe(1);

        // And the drawing is still telling its own truth: one block per
        // occupied slot, slot 1 undivided.
        const splitMembers = await app.evalJS<number>(
          `document.querySelectorAll('.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-block[data-column-member]').length`,
        );
        expect(
          splitMembers,
          "the picture draws what is on screen: no divided column",
        ).toBe(0);

        // ── A rail is NOT one of the marked places. ──
        //
        // It is always divided ([B01]), so there is no arrangement of its own
        // for a mark to state. The Layout card holds the right edge here and
        // the picture still leaves that side its width — it just wears nothing.
        expect(
          Object.keys(marks).filter((key) => key.startsWith("rail-")),
          "no rail is marked",
        ).toEqual([]);

        // ── The rows are fixed, and the count does not move. ──
        //
        // The per-place rows are gone: the section asks the deck-wide
        // questions in words — plus one boot-fixed row per registered sidebar
        // card — and every per-place question on the drawing. What this pins
        // is not tidiness but a height: a section whose row count tracked the
        // deck made everything below it jump as cards moved.
        const rows = await app.evalJS<string[]>(
          `Array.prototype.map.call(
            document.querySelectorAll('[data-testid="layout-card-section"] [data-slot="tug-choice-group"]'),
            function (el) { return el.getAttribute("data-testid"); }
          )`,
        );
        note(`rows: ${rows.join(", ")}`);
        expect(
          rows.slice(0, 3),
          "the three deck-wide rows lead, in a fixed order",
        ).toEqual([
          "layout-card-kind",
          "layout-card-layout",
          "layout-card-width",
        ]);
        // Under them, the place rows — one per slot with something to arrange
        // (part 7); a rail gets none, because it is always divided — and under
        // those, one row per REGISTERED sidebar card: the show/hide + side
        // question the picture cannot ask, because a hidden card is exactly
        // what the picture does not draw. The registry is a boot step, so that
        // count is fixed too.
        const placeRows = rows
          .slice(3)
          .filter((id) => /^layout-card-column-/.test(id));
        expect(
          rows.filter((id) => /^layout-card-rail-/.test(id)),
          "a rail has no arrangement row",
        ).toEqual([]);
        const sidebarRows = rows.slice(3 + placeRows.length);
        expect(
          sidebarRows.length,
          "every remaining row is a sidebar card's",
        ).toBeGreaterThanOrEqual(1);
        for (const id of sidebarRows) {
          expect(id).toMatch(/^layout-card-sidebar-/);
        }
        expect(sidebarRows).toContain("layout-card-sidebar-layout");
        const retired = await app.evalJS<number>(
          `document.querySelectorAll(
            '[data-testid^="layout-card-side-"]'
          ).length`,
        );
        expect(retired, "the old per-card side rows are gone, not hidden").toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mark stands on the place it names",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${mark("col-0")}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const marks = await readMarks(app);
        // The overlay replicates the drawing's flex row rather than computing
        // fractions of the frame, and this is the claim that says so: a mark
        // whose geometry drifted by the drawing's padding or its 2px gap would
        // sit outside the block it belongs to, or over its neighbour.
        for (const slot of [0, 1, 2]) {
          const block = await blockRect(app, slot);
          const m = marks[`col-${slot}`];
          expect(block, `slot ${slot} is drawn`).not.toBeNull();
          expect(m, `slot ${slot} is marked`).toBeDefined();
          const r = m.rect!;
          const center = (r.left + r.right) / 2;
          expect(
            center >= block!.left && center <= block!.right,
            `slot ${slot}'s mark stands within slot ${slot}'s block ` +
              `(mark ${Math.round(r.left)}–${Math.round(r.right)}, ` +
              `block ${Math.round(block!.left)}–${Math.round(block!.right)})`,
          ).toBe(true);
          // At the foot of it, which is where the marks line up as one legend.
          expect(
            r.bottom <= block!.bottom + 2 && r.bottom > block!.top,
            `slot ${slot}'s mark sits at the foot of its block`,
          ).toBe(true);
        }

        const b0 = await blockRect(app, 0);
        note(
          `mark col-0 at ${Math.round(marks["col-0"].rect!.left)}–` +
            `${Math.round(marks["col-0"].rect!.right)} over block ` +
            `${Math.round(b0!.left)}–${Math.round(b0!.right)}`,
        );

        // Every mark is a real target, not a speck on a picture. Sixteen
        // pixels square is the floor a press can actually find at this scale.
        const targets = await app.evalJS<Record<string, [number, number]>>(
          `(function () {
            var out = {};
            var nodes = document.querySelectorAll('${PLACES} [data-testid^="layout-card-place-"]');
            Array.prototype.forEach.call(nodes, function (el) {
              var r = el.getBoundingClientRect();
              out[el.getAttribute("data-testid")] = [r.width, r.height];
            });
            return out;
          })()`,
        );
        note(
          `hit targets: ${Object.keys(targets)
            .sort()
            .map(
              (k) =>
                `${k.replace("layout-card-place-", "")} ` +
                `${Math.round(targets[k][0])}×${Math.round(targets[k][1])}`,
            )
            .join(", ")}`,
        );
        for (const [id, [w, h]] of Object.entries(targets)) {
          expect(w, `${id} is wide enough to press`).toBeGreaterThanOrEqual(16);
          expect(h, `${id} is tall enough to press`).toBeGreaterThanOrEqual(16);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mark is a button: it answers a hand, and it does not audition",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${mark("col-0")}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── Hovering a mark changes the MARK, and nothing else. ──
        //
        // A mark is a two-state toggle whose effect is the glyph it wears, so
        // there is nothing an audition could show that the mark is not already
        // showing — and the marks stand close enough together that raising a
        // layer per crossing made the whole section strobe as the hand moved.
        // What a hover does instead is what it does on any button: the control
        // answers, and the plan stays where it is.
        await hover(app, mark("col-0"));
        await wait(300);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('[data-testid="layout-card-plan"]').hasAttribute("data-previewing")`,
          ),
          "hovering a mark does not swap the plan out from under the reader",
        ).toBe(false);
        // And there is no layer standing by to be raised: a preview nothing can
        // reach is dead weight in the DOM, not a spare.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(
              '[data-plan-preview-id^="columnmode:"], [data-plan-preview-id^="railmode:"]'
            ).length`,
          ),
          "the arrangement layers are gone, not merely unreachable",
        ).toBe(0);

        // ── THE TRAP, CLOSED. ──
        //
        // Slot 1 kept a split nobody could see and nobody could reach. Press
        // its mark and the stored arrangement goes back to stack — which is the
        // gesture the membership-gated column row denied outright, because it
        // refused to exist for a slot standing one card deep.
        await app.click(mark("col-1"));
        await wait(AFTER_LAND_MS);
        const afterFix = await readMarks(app);
        expect(
          afterFix["col-1"].mode,
          "pressing the one-card split's mark put the slot back to stack",
        ).toBe("stack");

        // ── And the same press works the other way, with real geometry. ──
        //
        // Slot 0 is genuinely shared, so splitting it must divide the run: two
        // frames, tiling, which is what `at0455` measures in full. Here the
        // claim is only that the mark reached the column command at all.
        const before = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-column-split]').length`,
        );
        expect(before, "nothing is split to begin with").toBe(0);
        await app.click(mark("col-0"));
        await wait(AFTER_LAND_MS);
        const after = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-column-split]').length`,
        );
        expect(
          after,
          "pressing slot 0's mark divided the slot its two cards share",
        ).toBe(2);
        const nowMarks = await readMarks(app);
        expect(
          nowMarks["col-0"].mode,
          "and the mark now reads what the slot is set to",
        ).toBe("split");
        note(
          `after presses: ${Object.keys(nowMarks)
            .sort()
            .map((k) => `${k}=${nowMarks[k].mode}`)
            .join(", ")}`,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sidebar's row moves the real card; the picture carries no side arrows",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-sidebar-layout"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // Placement is the ROW's question, not the picture's: the schematic's
        // marks say only stack versus split, and the picture carries no
        // side-move affordance at all. The row can also say Off, which is the
        // answer no mark on a drawing of the open deck could offer.
        const arrows = await app.evalJS<number>(
          `document.querySelectorAll('[data-testid^="layout-card-place-side-"]').length`,
        );
        expect(
          arrows,
          "the picture carries no side-move affordance — the rows own placement",
        ).toBe(0);

        const railBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().left`,
        );
        const cardBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        expect(
          railBefore,
          "the Layout card starts to the right of the content cards",
        ).toBeGreaterThan(cardBefore);

        await app.click(
          `[data-testid="layout-card-sidebar-layout"] [data-choice-value="left"]`,
        );
        await wait(AFTER_LAND_MS);

        const railAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().left`,
        );
        const cardAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        // The real card moved, not just the row: the press went through the
        // section's own `set-sidebar-side` route.
        expect(
          railAfter,
          "pressing Left on the Layout card's row moved the real Layout card to the left edge",
        ).toBeLessThan(cardAfter);
        note(
          `rail ${Math.round(railBefore)} → ${Math.round(railAfter)}, ` +
            `card ${Math.round(cardBefore)} → ${Math.round(cardAfter)}`,
        );

        // And the row now reads the side it holds.
        const activeNow = await app.evalJS<string | null>(
          `(function () {
            var el = document.querySelector('[data-testid="layout-card-sidebar-layout"] [data-choice-value][data-state="active"]');
            return el === null ? null : el.getAttribute("data-choice-value");
          })()`,
        );
        expect(activeNow, "the row reads the move").toBe("left");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the picture is one stop: arrows audition, Space commits",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── One stop for the whole picture. ──
        //
        // Tab reaches the overlay itself, not a mark inside it: the marks are
        // items the cursor walks, exactly as a segmented row's segments are.
        // A stop per mark would make Tab crawl the drawing.
        // Seed the ring into the Layout card before walking it, exactly as at0454
        // does — Tab moves the ring within the key card, and without this the
        // walk starts wherever the deck happened to leave it.
        await app.dispatchControlAction("toggle-layout");
        await wait(300);
        await tabUntilKbd(app, '[data-testid="layout-card-kind"]');
        const walk: string[] = [];
        for (let i = 0; i < 16; i += 1) {
          await app.nativeKey("Tab");
          await wait(150);
          const at = await app.evalJS<string | null>(
            `(function () {
              var all = document.querySelectorAll('[data-key-view-kbd][data-testid]');
              var el = all[all.length - 1];
              return el ? el.getAttribute("data-testid") : null;
            })()`,
          );
          if (at === null || walk[walk.length - 1] === at) break;
          walk.push(at);
          // Stop on arrival: the claim is that the walk REACHES the picture,
          // and stopping here leaves the ring on it for the arrows below.
          if (at === "layout-card-places") break;
        }
        note(`ladder below Cards: ${walk.join(" -> ")}`);
        expect(
          walk,
          "the picture is a rung on the ladder, not a control only a mouse can reach",
        ).toContain("layout-card-places");
        const stops = await app.evalJS<number>(
          `document.querySelectorAll('${PLACES}[data-tug-focusable]').length`,
        );
        expect(stops, "the drawing registers exactly one focusable").toBe(1);

        // ── The cursor lands on a mark, and wears the mark's own hover face. ──
        //
        // Tab-into parks the cursor on the group's first item; an arrow steps
        // it along the run. Standing on a mark does not audition — a mark is a
        // button — so what says where the cursor is standing is the appearance
        // the mark gives a pointer, which the cursor takes as its own. That is
        // read as the accent the glyph carries, not as a declared value: the
        // resting stroke is the drawing's neutral ink and the reached-for one
        // is the control accent, so the two are simply different colours.
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES} [data-key-cursor]') !== null`,
          { timeoutMs: 4_000 },
        );
        await app.nativeKey("ArrowRight");
        await wait(400);
        const cursorFacts = await app.evalJS<{
          testid: string | null;
          cursorStroke: string;
          restStroke: string;
          previewing: boolean;
        }>(
          `(function () {
            var el = document.querySelector('${PLACES} [data-key-cursor]');
            var strokeOf = function (node) {
              return node === null
                ? ""
                : getComputedStyle(node)
                    .getPropertyValue("--tugx-column-badge-stroke")
                    .trim();
            };
            var others = Array.prototype.filter.call(
              document.querySelectorAll('${PLACES} [data-testid^="layout-card-place-"]'),
              function (n) { return !n.hasAttribute("data-key-cursor"); }
            );
            return {
              testid: el === null ? null : el.getAttribute("data-testid"),
              cursorStroke: strokeOf(el),
              restStroke: strokeOf(others[0] || null),
              previewing: document
                .querySelector('[data-testid="layout-card-plan"]')
                .hasAttribute("data-previewing"),
            };
          })()`,
        );
        expect(cursorFacts.testid, "an arrow put the cursor on a mark").not.toBeNull();
        expect(
          cursorFacts.previewing,
          "and standing there auditions nothing — a mark is a button",
        ).toBe(false);
        expect(
          cursorFacts.cursorStroke,
          "the cursored mark is drawn differently from the ones at rest",
        ).not.toBe(cursorFacts.restStroke);
        note(
          `cursor on ${cursorFacts.testid}: ${cursorFacts.cursorStroke} ` +
            `vs ${cursorFacts.restStroke} at rest`,
        );

        // ── Space commits what the cursor is standing on. ──
        //
        // The mark carries the arrangement NOT in force, so what Space does is
        // exactly what a press does: it sets the other thing, and the glyph
        // under the cursor turns over to say so.
        const key = (cursorFacts.testid ?? "").replace(
          "layout-card-place-",
          "",
        );
        const before = (await readMarks(app))[key]?.mode;
        // Space, spelled as the character — `VirtualKeyMap` has no "Space" name.
        await app.nativeKey(" ");
        await wait(AFTER_LAND_MS);

        const after = (await readMarks(app))[key]?.mode;
        expect(
          after,
          `Space set ${key} to the arrangement its mark was offering`,
        ).toBe(before === "split" ? "stack" : "split");
        note(`Space committed ${key}: ${before} → ${after}`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sidebar row shows, moves, and hides the real card",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-sidebar-jots"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const activeOf = (id: string): Promise<string | null> =>
          app.evalJS<string | null>(
            `(function () {
              var el = document.querySelector('[data-testid="${id}"] [data-choice-value][data-state="active"]');
              return el === null ? null : el.getAttribute("data-choice-value");
            })()`,
          );

        // ── The rows read what stands: Layout open on the right, Jots off. ──
        expect(
          await activeOf("layout-card-sidebar-layout"),
          "the Layout card's row reads the side it holds",
        ).toBe("right");
        expect(
          await activeOf("layout-card-sidebar-jots"),
          "a hidden card's row reads Off",
        ).toBe("off");

        // ── And the drawing draws what stands: no rail for a hidden card. ──
        //
        // Membership is a live read of the OPEN cards. A registered-but-hidden
        // Jots is not on the deck, so its side is not drawn at all — the row
        // above is its one door. Read off the committed drawing rather than off
        // a mark: a rail wears none ([B01]).
        const drawnRails = async (): Promise<number> =>
          app.evalJS<number>(
            `document.querySelectorAll(
              '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-rail'
            ).length`,
          );
        expect(await drawnRails(), "only the occupied right side is drawn").toBe(1);

        // ── Pressing a side on a hidden card's row shows it THERE. ──
        await app.click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="left"]`,
        );
        await wait(AFTER_LAND_MS);
        expect(
          await activeOf("layout-card-sidebar-jots"),
          "the row now reads the side it was shown on",
        ).toBe("left");
        const jotsLeft = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length`,
        );
        expect(jotsLeft, "the real Jots card stands on the left edge").toBe(1);
        // The drawing follows: a left rail appears beside the right one.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(
            '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-rail'
          ).length === 2`,
          { timeoutMs: 4_000 },
        );
        expect(await drawnRails(), "both edges now carry a rail").toBe(2);

        // ── Off hides it again, and everything retracts together. ──
        await app.click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="off"]`,
        );
        await wait(AFTER_LAND_MS);
        expect(await activeOf("layout-card-sidebar-jots")).toBe("off");
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length`,
          ),
          "the real card left the deck",
        ).toBe(0);
        expect(await drawnRails(), "and its rail left the drawing").toBe(1);
        note("jots: off → left → off, with the deck and the drawing in step");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a preview carries the marks with it",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── A row's preview restates the marks, at the LAYER's geometry. ──
        //
        // The rows audition under the KEYBOARD cursor; the marks do not, and
        // neither does a pointer. So a preview moves the deck out from under a
        // legend that would otherwise stay at the committed positions, and the
        // ghost is what keeps the two together: it draws every mark again,
        // inert, on the arrangement being auditioned. The live overlay steps
        // back while it speaks, or two mark sets overlap — one of them at the
        // wrong geometry.
        await cursorOnto(app, "layout-card-width", "wide");
        await wait(400);
        const ghostFacts = await app.evalJS<{
          ghostMode: string | null;
          liveOpacity: string;
        } | null>(
          `(function () {
            var layer = document.querySelector('.layouts-plan-layer[data-plan-active]');
            if (layer === null) return null;
            var ghostMark = layer.querySelector('[data-testid="layout-card-places-ghost"] .layout-places-mark[data-place="col-1"]');
            var live = document.querySelector('${PLACES} .layout-places-mark[data-place="col-1"]');
            return {
              ghostMode: ghostMark === null ? null : ghostMark.getAttribute("data-mode"),
              liveOpacity: live === null ? "" : getComputedStyle(live).opacity,
            };
          })()`,
        );
        expect(ghostFacts, "an active layer is showing").not.toBeNull();
        expect(
          ghostFacts!.ghostMode,
          "the ghost restates what each place is set to — slot 1's stored split",
        ).toBe("split");
        expect(
          Number(ghostFacts!.liveOpacity),
          "the live marks step back while a preview shows",
        ).toBe(0);
        note(
          `width preview: ghost restates col-1 as split, live marks at opacity ${ghostFacts!.liveOpacity}`,
        );

        // And they land on the PREVIEWED drawing's blocks rather than the
        // committed ones — the marks travel with what they annotate.
        const carried = await app.evalJS<{
          layerId: string | null;
          inside: boolean;
        }>(
          `(function () {
            var layer = document.querySelector('.layouts-plan-layer[data-plan-active]');
            if (layer === null) return { layerId: null, inside: false };
            var block = layer.querySelectorAll(".layout-mini-field .layout-mini-block")[0];
            var ghostMark = layer.querySelector('[data-testid="layout-card-places-ghost"] .layout-places-mark[data-place="col-0"]');
            if (!block || ghostMark === null) return { layerId: layer.getAttribute("data-plan-preview-id"), inside: false };
            var b = block.getBoundingClientRect();
            var m = ghostMark.getBoundingClientRect();
            var c = (m.left + m.right) / 2;
            return {
              layerId: layer.getAttribute("data-plan-preview-id"),
              inside: c >= b.left && c <= b.right && m.bottom <= b.bottom + 2,
            };
          })()`,
        );
        expect(carried.layerId).toBe("width:wide");
        expect(
          carried.inside,
          "the ghost's mark stands inside the PREVIEWED drawing's block",
        ).toBe(true);

        // ── A rail is drawn divided, in the committed layer and every
        //    proposal alike. ──
        //
        // There is one picture for a rail now ([B01]): a member per card the
        // side holds, in both layers, so a preview cannot make the side look
        // like a different kind of place.
        await app.click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="right"]`,
        );
        await wait(AFTER_LAND_MS);
        await cursorOnto(app, "layout-card-width", "wide");
        await wait(400);
        const railDrawing = await app.evalJS<{
          committed: number;
          preview: number;
        }>(
          `(function () {
            var count = function (scope) {
              var layer = document.querySelector(scope);
              return layer === null
                ? -1
                : layer.querySelectorAll('.layout-mini-rail .layout-mini-rail-member').length;
            };
            return {
              committed: count('.layouts-plan-layer[data-plan-layer="committed"]'),
              preview: count('.layouts-plan-layer[data-plan-active]'),
            };
          })()`,
        );
        note(
          `rail members: committed ${railDrawing.committed}, preview ${railDrawing.preview}`,
        );
        expect(
          railDrawing.committed,
          "the committed drawing divides the side between its two cards",
        ).toBe(2);
        expect(
          railDrawing.preview,
          "and so does the proposal — a rail has one picture",
        ).toBe(2);

        // ── Taking the cursor off the rows brings the live marks back. ──
        //
        // The audition raised for the silhouette count is still standing, so
        // this reads the drop rather than staging one.
        await cursorOffTheRows(app);
        await wait(400);
        const after = await app.evalJS<{ previewing: boolean; liveOpacity: string }>(
          `(function () {
            var plan = document.querySelector('[data-testid="layout-card-plan"]');
            var live = document.querySelector('${PLACES} .layout-places-mark[data-place="col-0"]');
            return {
              previewing: plan !== null && plan.hasAttribute("data-previewing"),
              liveOpacity: live === null ? "" : getComputedStyle(live).opacity,
            };
          })()`,
        );
        expect(after.previewing, "the preview cleared").toBe(false);
        expect(
          Number(after.liveOpacity),
          "and the live marks stand again",
        ).toBe(1);

        // ── A POINTER auditions nothing, wherever it rests. ──
        //
        // A hover once raised the segment's layer, on an intent clock meant to
        // keep a pointer crossing the rows from strobing the picture. The clock
        // could not fix what was under it: a hand travelling to the control it
        // means to press passes over three or four others on the way, and the
        // drawing answered every one — the section's largest element restating
        // itself while the reader was only moving their hand. So the pointer
        // states nothing and presses instead, and this is the claim that keeps
        // it that way. Rest on a segment for longer than any clock and read.
        await hover(
          app,
          `[data-testid="layout-card-width"] [data-choice-value="wide"]`,
        );
        await wait(600);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('[data-testid="layout-card-plan"]').hasAttribute("data-previewing")`,
          ),
          "a pointer resting on a segment does not swap the drawing",
        ).toBe(false);
        note("pointer rests on a segment: the drawing does not move");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a place wears one mark, and the note says which thing scrolls",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── One mark per place, whatever its layout. ──
        //
        // Slot 1 is SET to split and slot 0 is stacked, and each wears exactly
        // one affordance: the layout glyph that once stood beside a split
        // place's mark is gone, and nothing on the picture says fit or flow.
        const affordances = await app.evalJS<Record<string, number>>(
          `(function () {
            var out = {};
            Array.prototype.forEach.call(
              document.querySelectorAll('${PLACES} .layout-places-mark[data-place]'),
              function (el) {
                out[el.getAttribute("data-place")] =
                  el.querySelectorAll('[data-testid^="layout-card-place-"]').length;
              },
            );
            return out;
          })()`,
        );
        note(`affordances per mark: ${JSON.stringify(affordances)}`);
        expect(affordances["col-1"], "the split slot wears one mark").toBe(1);
        expect(affordances["col-0"], "and so does the stacked one").toBe(1);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('${PLACES} [data-place-layout], ${PLACES} [data-testid$="-layout"]').length`,
          ),
          "no mark carries a layout — glyph or attribute",
        ).toBe(0);

        // ── A rail wears NO mark at all. ──
        //
        // It is always divided ([B01], [B02]), so there is nothing about its
        // arrangement for a glyph to state or a press to change. The picture
        // still leaves the side its width; the marks over the field are the
        // slots' alone.
        await app.click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="right"]`,
        );
        await wait(AFTER_LAND_MS);
        const railMarks = await app.evalJS<number>(
          `document.querySelectorAll('${PLACES} .layout-places-mark[data-place^="rail-"]').length`,
        );
        note(`rail marks on the picture: ${railMarks}`);
        expect(railMarks, "no mark stands over either rail").toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── 7. The arrangement is a row in the mixer. ──
  //
  // The picture's marks state and toggle; a row states a choice among answers,
  // and this is the row: `Stack | Split` per SLOT, under Card Width and above
  // the per-card rows, told from the deck's own LAYOUT row by the caption
  // naming the place. A rail gets no row at all — it is always divided ([B01]),
  // so there is nothing to choose. Every press below is read back from the
  // STORED record rather than from the row, so a pass says the deck changed
  // and not that the segment lit.
  test(
    "a slot's arrangement is a Stack | Split row, and each segment writes the record it names",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const columnRow = (slot: number) => `[data-testid="layout-card-column-${slot}"]`;
        const rowFacts = async (
          selector: string,
        ): Promise<{ present: boolean; disabled: boolean; value: string | null }> =>
          app.evalJS<{ present: boolean; disabled: boolean; value: string | null }>(
            `(function () {
              var row = document.querySelector('${selector}');
              if (row === null) return { present: false, disabled: false, value: null };
              var active = row.querySelector('[data-choice-value][data-state="active"]');
              return {
                present: true,
                disabled: row.hasAttribute("data-disabled"),
                value: active === null ? null : active.getAttribute("data-choice-value"),
              };
            })()`,
          );
        const stored = async (): Promise<{ mode: string | null }> =>
          app.evalJS<{ mode: string | null }>(
            `(function () {
              var imp = window.tugdeck.diag.getDeckState().imposition;
              var column = (imp.columns || {})[0] || {};
              return { mode: column.mode || null };
            })()`,
          );

        // ── The rows stand where the brief puts them. ──
        //
        // No rail row on either side. Slot 0 holds two cards and gets a row,
        // slot 1 holds one and gets none. The column rows come directly after
        // Card Width, and the per-card rows last.
        const order = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll('.layouts-section-row [data-testid^="layout-card-"]'))
            .map(function (el) { return el.getAttribute("data-testid"); })`,
        );
        note(`mixer rows: ${order.join(" · ")}`);
        expect(
          order.filter((id) => id.startsWith("layout-card-rail-")),
          "a rail has no arrangement row: it is always divided",
        ).toEqual([]);
        expect(order.indexOf("layout-card-column-0"), "Column 1 follows Card Width").toBe(
          order.indexOf("layout-card-width") + 1,
        );
        expect(
          order.indexOf("layout-card-column-1"),
          "a slot with one card has no row — absent, not disabled",
        ).toBe(-1);
        expect(
          order.indexOf("layout-card-sidebar-layout"),
          "and the per-card rows come after every place row",
        ).toBeGreaterThan(order.indexOf("layout-card-column-0"));

        // ── Split writes the slot's mode; Stack writes it back. ──
        const columnAtRest = await rowFacts(columnRow(0));
        expect(columnAtRest.present, "slot 0's row is there").toBe(true);
        expect(columnAtRest.disabled, "enabled — two cards stand in it").toBe(false);
        expect(columnAtRest.value, "reading Stack, which an untouched shared slot is").toBe("stack");

        await app.click(`${columnRow(0)} [data-choice-value="split"]`);
        await wait(AFTER_LAND_MS);
        let record = await stored();
        note(`after Split on Column 1: ${JSON.stringify(record)}`);
        expect(record.mode, "Split divided the slot").toBe("split");
        expect((await rowFacts(columnRow(0))).value, "and the row says Split").toBe("split");

        await app.click(`${columnRow(0)} [data-choice-value="stack"]`);
        await wait(AFTER_LAND_MS);
        record = await stored();
        note(`after Stack on Column 1: ${JSON.stringify(record)}`);
        expect(record.mode, "Stack stacks the slot").toBe("stack");
        expect((await rowFacts(columnRow(0))).value, "and the row says Stack").toBe("stack");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

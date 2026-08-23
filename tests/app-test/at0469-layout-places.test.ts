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
 * the Lens, because the section's column rows were gated on `members.length > 1`
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
 *
 * Read from live `getBoundingClientRect()` and `data-` attributes. Nothing here
 * reads back a declared style value.
 *
 * @covers tugdeck/src/components/lens/layout-places.tsx
 * @covers tugdeck/src/components/lens/layout-miniature.tsx
 * @covers tugdeck/src/components/lens/sections/layouts-section.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const LENS_WIDTH = 420;
const PANE_WIDTH = 420;
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const PLACES = '[data-testid="lens-layouts-places"]';
const mark = (key: string): string => `[data-testid="lens-layouts-place-${key}"]`;

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
 * Three-up with the Lens on the right: slot 0 shared by two cards, slot 1 held
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
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => pane(id, slot, cardId)),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: LENS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { lens: { side: "right" } },
      // Slot 1 is SET to split and holds one card. Slot 0 is shared and
      // stacked, which is what an untouched shared slot is.
      columns: { 1: { mode: "split" } },
    },
    hasFocus: true,
  };
}

/**
 * Rest a pointer on an element the way the section hears one.
 *
 * The preview switch listens for React's `onPointerOver`, which is a bubbling
 * `pointerover` — so the hover has to be dispatched on the element itself and
 * allowed to rise to the figure, exactly as a real pointer's would. The harness
 * has no hover verb; `revealPaneControls` dispatches its own `PointerEvent` for
 * the same reason.
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
 *  Lens ladder is actually navigated by (at0277 and at0455 use the same one). */
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
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
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
          "every slot the kind defines, and the occupied side",
        ).toEqual(["col-0", "col-1", "col-2", "rail-right"]);
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
            document.querySelectorAll('${PLACES} [data-testid^="lens-layouts-place-"]'),
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

        // ── The rail is a place too, wearing the same vocabulary. ──
        //
        // Which sides are marked is a live read of what is standing: `railsFor`
        // in `layouts-section.tsx` counts the OPEN sidebar cards, so a card
        // that is registered but hidden is not drawn and not marked. Here the
        // Lens holds the right edge and the left is empty.
        expect(marks["rail-right"].mode).toBe("stack");

        // ── The rows are fixed, and the count does not move. ──
        //
        // The per-place rows are gone: the section asks the deck-wide
        // questions in words — plus one boot-fixed row per registered sidebar
        // card — and every per-place question on the drawing. What this pins
        // is not tidiness but a height: a section whose row count tracked the
        // deck made everything below it jump as cards moved.
        const rows = await app.evalJS<string[]>(
          `Array.prototype.map.call(
            document.querySelectorAll('[data-testid="lens-layouts-section"] [data-slot="tug-choice-group"]'),
            function (el) { return el.getAttribute("data-testid"); }
          )`,
        );
        note(`rows: ${rows.join(", ")}`);
        expect(
          rows.slice(0, 4),
          "the four deck-wide rows lead, in a fixed order",
        ).toEqual([
          "lens-layouts-kind",
          "lens-layouts-layout",
          "lens-layouts-width",
          // The last of the four is the odd one — it states how the Lens's own
          // rows draw a place rather than anything about the deck — and it is
          // seated here rather than below because the rows below are named for
          // the cards they place. Among them it would read as a fourth sidebar
          // card called Slot Window.
          "lens-layouts-slot-window",
        ]);
        // Under them, one row per REGISTERED sidebar card — the show/hide +
        // side question the picture cannot ask, because a hidden card is
        // exactly what the picture does not draw. The registry is a boot
        // step, so this count is fixed too.
        const sidebarRows = rows.slice(4);
        expect(
          sidebarRows.length,
          "every remaining row is a sidebar card's",
        ).toBeGreaterThanOrEqual(1);
        for (const id of sidebarRows) {
          expect(id).toMatch(/^lens-layouts-sidebar-/);
        }
        expect(sidebarRows).toContain("lens-layouts-sidebar-lens");
        const retired = await app.evalJS<number>(
          `document.querySelectorAll(
            '[data-testid^="lens-layouts-side-"], [data-testid^="lens-layouts-rail-"], [data-testid^="lens-layouts-column-"]'
          ).length`,
        );
        expect(retired, "the per-place rows are gone, not hidden").toBe(0);
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
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
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
            var nodes = document.querySelectorAll('${PLACES} [data-testid^="lens-layouts-place-"]');
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
                `${k.replace("lens-layouts-place-", "")} ` +
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
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
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
            `document.querySelector('[data-testid="lens-layouts-plan"]').hasAttribute("data-previewing")`,
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
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="lens-layouts-sidebar-lens"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // Placement is the ROW's question, not the picture's: the schematic's
        // marks say only stack versus split, and the picture carries no
        // side-move affordance at all. The row can also say Off, which is the
        // answer no mark on a drawing of the open deck could offer.
        const arrows = await app.evalJS<number>(
          `document.querySelectorAll('[data-testid^="lens-layouts-place-side-"]').length`,
        );
        expect(
          arrows,
          "the picture carries no side-move affordance — the rows own placement",
        ).toBe(0);

        const lensBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pLens"]').getBoundingClientRect().left`,
        );
        const cardBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        expect(
          lensBefore,
          "the Lens starts to the right of the content cards",
        ).toBeGreaterThan(cardBefore);

        await app.click(
          `[data-testid="lens-layouts-sidebar-lens"] [data-choice-value="left"]`,
        );
        await wait(AFTER_LAND_MS);

        const lensAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pLens"]').getBoundingClientRect().left`,
        );
        const cardAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        // The real card moved, not just the row: the press went through the
        // section's own `set-sidebar-side` route.
        expect(
          lensAfter,
          "pressing Left on the Lens's row moved the real Lens card to the left edge",
        ).toBeLessThan(cardAfter);
        note(
          `lens ${Math.round(lensBefore)} → ${Math.round(lensAfter)}, ` +
            `card ${Math.round(cardBefore)} → ${Math.round(cardAfter)}`,
        );

        // And the row now reads the side it holds.
        const activeNow = await app.evalJS<string | null>(
          `(function () {
            var el = document.querySelector('[data-testid="lens-layouts-sidebar-lens"] [data-choice-value][data-state="active"]');
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
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
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
        // Seed the ring into the Lens before walking it, exactly as at0454
        // does — Tab moves the ring within the key card, and without this the
        // walk starts wherever the deck happened to leave it.
        await app.dispatchControlAction("focus-lens");
        await wait(300);
        await tabUntilKbd(app, '[data-testid="lens-layouts-kind"]');
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
          if (at === "lens-layouts-places") break;
        }
        note(`ladder below Cards: ${walk.join(" -> ")}`);
        expect(
          walk,
          "the picture is a rung on the ladder, not a control only a mouse can reach",
        ).toContain("lens-layouts-places");
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
              document.querySelectorAll('${PLACES} [data-testid^="lens-layouts-place-"]'),
              function (n) { return !n.hasAttribute("data-key-cursor"); }
            );
            return {
              testid: el === null ? null : el.getAttribute("data-testid"),
              cursorStroke: strokeOf(el),
              restStroke: strokeOf(others[0] || null),
              previewing: document
                .querySelector('[data-testid="lens-layouts-plan"]')
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
          "lens-layouts-place-",
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
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="lens-layouts-sidebar-jots"]') !== null`,
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

        // ── The rows read what stands: the Lens open on the right, Jots off. ──
        expect(
          await activeOf("lens-layouts-sidebar-lens"),
          "the Lens's row reads the side it holds",
        ).toBe("right");
        expect(
          await activeOf("lens-layouts-sidebar-jots"),
          "a hidden card's row reads Off",
        ).toBe("off");

        // ── And the drawing draws what stands: no rail for a hidden card. ──
        //
        // Membership is a live read of the OPEN cards. A registered-but-hidden
        // Jots is not on the deck, so its side is neither drawn nor marked —
        // the row above is its one door.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('${PLACES} .layout-places-mark[data-place="rail-left"]') !== null`,
          ),
          "an empty side has no rail to mark",
        ).toBe(false);

        // ── Pressing a side on a hidden card's row shows it THERE. ──
        await app.click(
          `[data-testid="lens-layouts-sidebar-jots"] [data-choice-value="left"]`,
        );
        await wait(AFTER_LAND_MS);
        expect(
          await activeOf("lens-layouts-sidebar-jots"),
          "the row now reads the side it was shown on",
        ).toBe("left");
        const jotsLeft = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-lens="left"]').length`,
        );
        expect(jotsLeft, "the real Jots card stands on the left edge").toBe(1);
        // The drawing follows: a left rail appears, wearing its own mark.
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES} .layout-places-mark[data-place="rail-left"]') !== null`,
          { timeoutMs: 4_000 },
        );
        const railMarksNow = await app.evalJS<string[]>(
          `Array.prototype.map.call(
            document.querySelectorAll('${PLACES} .layout-places-mark[data-place^="rail-"]'),
            function (el) { return el.getAttribute("data-place"); }
          ).sort()`,
        );
        expect(
          railMarksNow,
          "both edges now carry a rail, and both are marked",
        ).toEqual(["rail-left", "rail-right"]);

        // ── Off hides it again, and everything retracts together. ──
        await app.click(
          `[data-testid="lens-layouts-sidebar-jots"] [data-choice-value="off"]`,
        );
        await wait(AFTER_LAND_MS);
        expect(await activeOf("lens-layouts-sidebar-jots")).toBe("off");
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('.tug-pane[data-lens="left"]').length`,
          ),
          "the real card left the deck",
        ).toBe(0);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('${PLACES} .layout-places-mark[data-place="rail-left"]') !== null`,
          ),
          "and its rail left the drawing",
        ).toBe(false);
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
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── A row's preview restates the marks, at the LAYER's geometry. ──
        //
        // The rows audition; the marks do not. So a preview moves the deck out
        // from under a legend that would otherwise stay at the committed
        // positions, and the ghost is what keeps the two together: it draws
        // every mark again, inert, on the arrangement being auditioned. The
        // live overlay steps back while it speaks, or two mark sets overlap —
        // one of them at the wrong geometry.
        await hover(
          app,
          `[data-testid="lens-layouts-width"] [data-choice-value="wide"]`,
        );
        await wait(400);
        const ghostFacts = await app.evalJS<{
          ghostMode: string | null;
          liveOpacity: string;
        } | null>(
          `(function () {
            var layer = document.querySelector('.layouts-plan-layer[data-plan-active]');
            if (layer === null) return null;
            var ghostMark = layer.querySelector('[data-testid="lens-layouts-places-ghost"] .layout-places-mark[data-place="col-1"]');
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
            var ghostMark = layer.querySelector('[data-testid="lens-layouts-places-ghost"] .layout-places-mark[data-place="col-0"]');
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

        // ── A proposal draws a stacked rail as ONE silhouette. ──
        //
        // The stack peek is a solid-paint idiom: hollow members cannot occlude
        // each other, so the offsets that read as a paper stack in the
        // committed drawing read as spurious slivers at the strip's top and
        // bottom in a proposal. Stand two cards on the right rail, raise any
        // preview, and count.
        await app.click(
          `[data-testid="lens-layouts-sidebar-jots"] [data-choice-value="right"]`,
        );
        await wait(AFTER_LAND_MS);
        await hover(
          app,
          `[data-testid="lens-layouts-width"] [data-choice-value="wide"]`,
        );
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
                : layer.querySelectorAll('.layout-mini-rail[data-rail-mode="stack"] .layout-mini-rail-member').length;
            };
            return {
              committed: count('.layouts-plan-layer[data-plan-layer="committed"]'),
              preview: count('.layouts-plan-layer[data-plan-active]'),
            };
          })()`,
        );
        note(
          `stacked rail members: committed ${railDrawing.committed}, preview ${railDrawing.preview}`,
        );
        expect(
          railDrawing.committed,
          "the committed drawing peeks the buried card",
        ).toBe(2);
        expect(
          railDrawing.preview,
          "a proposal draws the stacked rail as one silhouette",
        ).toBe(1);

        // ── A pointer merely CROSSING a row raises nothing. ──
        //
        // The rows have air between them, and every crossing of that air
        // resolves to no preview — so a switch that answered the raw pointer
        // raised a layer, dropped to committed for the width of a gap, and
        // raised the next: a flicker per traverse. Raising from rest is on an
        // intent beat, and this is the claim that says so. Both events are
        // dispatched in ONE round trip, so the crossing is genuinely faster
        // than the beat rather than merely usually faster — no timing race in
        // the assertion, which comes after everything has settled.
        await hover(app, ".layouts-section-rows");
        await wait(400);
        await app.evalJS<null>(
          `(function () {
            var over = function (sel) {
              var el = document.querySelector(sel);
              if (el === null) throw new Error("nothing at " + sel);
              el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
            };
            over('[data-testid="lens-layouts-width"] [data-choice-value="wide"]');
            over(".layouts-section-rows");
            return null;
          })()`,
        );
        await wait(400);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('[data-testid="lens-layouts-plan"]').hasAttribute("data-previewing")`,
          ),
          "a pointer that crossed a segment without stopping asked for nothing",
        ).toBe(false);

        // ── And the gap between two segments does not drop the plan. ──
        //
        // A raised preview is HELD when the pointer stops resolving to one, for
        // longer than any traverse of the air between affordances, so the
        // committed layer is never shown for an instant on the way past. Read
        // immediately after the crossing — the hold is the point.
        await hover(
          app,
          `[data-testid="lens-layouts-width"] [data-choice-value="wide"]`,
        );
        await wait(400);
        const heldThrough = await app.evalJS<boolean>(
          `(function () {
            document.querySelector(".layouts-section-rows")
              .dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
            return document.querySelector('[data-testid="lens-layouts-plan"]').hasAttribute("data-previewing");
          })()`,
        );
        expect(
          heldThrough,
          "crossing the air between segments holds the audition rather than dropping it",
        ).toBe(true);
        note("hover intent: a crossing raises nothing, a gap drops nothing");

        // ── Clearing the hover brings the live marks back. ──
        await hover(app, ".layouts-section-rows");
        await wait(400);
        const after = await app.evalJS<{ previewing: boolean; liveOpacity: string }>(
          `(function () {
            var plan = document.querySelector('[data-testid="lens-layouts-plan"]');
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
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

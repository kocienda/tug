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
 *   1. **Every occupied slot is marked**, whatever its membership, and each
 *      mark says the slot's own stored arrangement.
 *   2. **A one-card split is visible**, drawn split and dimmed: the arrangement
 *      is real, there is just nothing standing under it yet.
 *   3. **The marks land on the picture.** Each one is inside the block it
 *      belongs to, which is what makes it a mark on a place rather than a row
 *      of icons under a drawing.
 *   4. **A rail is a place too**, and wears the same vocabulary.
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

/** What a place's mark is saying, and whether it is saying it quietly. */
interface MarkFacts {
  mode: string | null;
  dim: boolean;
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
          dim: el.hasAttribute("data-dim"),
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
            .map((k) => `${k}=${marks[k].mode}${marks[k].dim ? " (dim)" : ""}`)
            .join(", ")}`,
        );

        // ── Both occupied slots are marked, and the empty one is not. ──
        //
        // A slot nobody is standing in has no arrangement to report: there is
        // no card whose place it is. Slot 2 is empty in this fixture.
        expect(
          Object.keys(marks).sort(),
          "the two occupied slots and the occupied side, and nothing else",
        ).toEqual(["col-0", "col-1", "rail-right"]);

        // ── The shared, untouched slot reads stacked, at full weight. ──
        expect(marks["col-0"].mode).toBe("stack");
        expect(
          marks["col-0"].dim,
          "two cards share slot 0, so there is something to arrange",
        ).toBe(false);

        // ── THE TRAP, VISIBLE. ──
        //
        // Slot 1 stores a split and holds one card. The drawing beneath shows
        // one undivided block, honestly — and the mark says the slot is set to
        // split, which is the fact that had nowhere to live. Dimmed, because
        // nothing is standing under the arrangement yet.
        expect(
          marks["col-1"].mode,
          "slot 1 is SET to split, and says so even standing one card deep",
        ).toBe("split");
        expect(
          marks["col-1"].dim,
          "quietly: the arrangement is real, but it is arranging one card",
        ).toBe(true);

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
        // A side's membership is a live read of what is standing: `railsFor`
        // in `layouts-section.tsx` counts the OPEN sidebar cards, so a card
        // that is registered but hidden is not drawn and not counted — the
        // same count the drawing above it uses. The mark's weight follows
        // that count, so it is read from the drawing rather than predicted.
        const railMembers = await app.evalJS<number>(
          `document.querySelectorAll('.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-rail .layout-mini-rail-member').length`,
        );
        note(`the right rail draws ${railMembers} member(s)`);
        expect(marks["rail-right"].mode).toBe("stack");
        expect(
          marks["rail-right"].dim,
          "the rail's mark dims exactly when the side holds one card",
        ).toBe(railMembers < 2);

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
          rows.slice(0, 3),
          "the three deck-wide rows lead, in a fixed order",
        ).toEqual([
          "lens-layouts-kind",
          "lens-layouts-layout",
          "lens-layouts-width",
        ]);
        // Under them, one row per REGISTERED sidebar card — the show/hide +
        // side question the picture cannot ask, because a hidden card is
        // exactly what the picture does not draw. The registry is a boot
        // step, so this count is fixed too.
        const sidebarRows = rows.slice(3);
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
        for (const slot of [0, 1]) {
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
    "pressing a place's mark sets the place, and hovering it auditions the change",
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

        // ── Hovering a mark shows what pressing it would do. ──
        //
        // The mark carries the arrangement NOT in force, so the layer it
        // resolves to is always the change rather than a copy of what is
        // already true. Nothing new resolves it: the same `previewIdOf` the
        // mixer rows use reads the mark's own `data-preview-axis` ancestor and
        // its `data-choice-value`.
        await hover(app, mark("col-0"));
        await wait(300);
        const previewed = await app.evalJS<string | null>(
          `(function () {
            var el = document.querySelector('.layouts-plan [data-plan-active]');
            return el === null ? null : el.getAttribute("data-plan-preview-id");
          })()`,
        );
        expect(
          previewed,
          "hovering slot 0's stack mark auditions splitting slot 0",
        ).toBe("columnmode:0:split");
        const caption = await app.evalJS<string>(
          `(document.querySelector('.layouts-plan [data-plan-active] .layouts-plan-caption') || { textContent: "" }).textContent`,
        );
        note(`hover caption: ${caption}`);
        expect(caption).toContain("Column 1");

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
    "pressing a sidebar member sends that card to the other edge",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${mark("side-lens")}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // The Lens starts on the right, so its member affordance offers the
        // left edge — the only other destination there is, which is why a press
        // reaches it and a drag would only arrive at the same place slower.
        const offered = await app.getElementAttribute(
          mark("side-lens"),
          "data-choice-value",
        );
        expect(offered, "the Lens is on the right, so the offer is left").toBe(
          "left",
        );

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

        await app.click(mark("side-lens"));
        await wait(AFTER_LAND_MS);

        const lensAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pLens"]').getBoundingClientRect().left`,
        );
        const cardAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        // The real card moved, not just the drawing: the press went through the
        // section's own `set-sidebar-side` route, the same one the deleted row
        // used.
        expect(
          lensAfter,
          "pressing the Lens's member moved the real Lens card to the left edge",
        ).toBeLessThan(cardAfter);
        note(
          `lens ${Math.round(lensBefore)} → ${Math.round(lensAfter)}, ` +
            `card ${Math.round(cardBefore)} → ${Math.round(cardAfter)}`,
        );

        // And the affordance now offers the way back.
        const offeredBack = await app.getElementAttribute(
          mark("side-lens"),
          "data-choice-value",
        );
        expect(offeredBack, "the offer reverses with the card").toBe("right");
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

        // ── The cursor lands on a mark, and auditions from there. ──
        //
        // Tab-into parks the cursor on the group's first item; an arrow steps
        // it along the run. Either way, standing on a mark raises that mark's
        // proposal in the drawing, the same way resting a pointer on it does —
        // the mark carries the arrangement not in force, so the layer is always
        // the change rather than a copy of what is already true.
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES} [data-key-cursor]') !== null`,
          { timeoutMs: 4_000 },
        );
        await app.nativeKey("ArrowRight");
        await wait(400);
        const cursored = await app.evalJS<string | null>(
          `(function () {
            var el = document.querySelector('${PLACES} [data-key-cursor]');
            return el === null ? null : el.getAttribute("data-testid");
          })()`,
        );
        expect(cursored, "an arrow put the cursor on a mark").not.toBeNull();
        const auditioned = await app.evalJS<string | null>(
          `(function () {
            var el = document.querySelector('.layouts-plan [data-plan-active]');
            return el === null ? null : el.getAttribute("data-plan-preview-id");
          })()`,
        );
        expect(
          auditioned,
          "the cursored mark's proposal is showing in the drawing",
        ).not.toBeNull();
        note(`cursor on ${cursored}, auditioning ${auditioned}`);

        // ── Space commits what the cursor is standing on. ──
        //
        // The proposal the drawing was auditioning becomes the deck's stored
        // arrangement — and the audition clears, because there is nothing left
        // to propose.
        const [, axis, proposed] = (auditioned ?? "::").split(":");
        // Space, spelled as the character — `VirtualKeyMap` has no "Space" name.
        await app.nativeKey(" ");
        await wait(AFTER_LAND_MS);

        const marksNow = await readMarks(app);
        const committedKey =
          axis === "left" || axis === "right" ? `rail-${axis}` : `col-${axis}`;
        expect(
          marksNow[committedKey]?.mode,
          `Space committed the arrangement the cursor was auditioning ` +
            `(${committedKey} → ${proposed})`,
        ).toBe(proposed);
        note(`Space committed ${committedKey} = ${proposed}`);
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

        // ── And the drawing draws what stands: no mark for a hidden card. ──
        //
        // Membership is a live read of the OPEN cards. A registered-but-hidden
        // Jots is not on the deck, so it is neither drawn nor marked — the row
        // above is its one door.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('${mark("side-jots")}') !== null`,
          ),
          "a hidden card has no member arrow on the drawing",
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
        // The drawing follows: a left rail, a member arrow, and a rail mark.
        await app.waitForCondition<boolean>(
          `document.querySelector('${mark("side-jots")}') !== null`,
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
            `document.querySelector('${mark("side-jots")}') !== null`,
          ),
          "and its member arrow left the drawing",
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

        // ── Hovering a mark: the ghost states the PROPOSED arrangement. ──
        await hover(app, mark("col-0"));
        await wait(300);
        const ghostFacts = await app.evalJS<{
          previewing: boolean;
          ghostMode: string | null;
          ghostSubject: boolean;
          liveOpacity: string;
        } | null>(
          `(function () {
            var plan = document.querySelector('[data-testid="lens-layouts-plan"]');
            var layer = document.querySelector('.layouts-plan-layer[data-plan-active]');
            if (plan === null || layer === null) return null;
            var ghostMark = layer.querySelector('[data-testid="lens-layouts-places-ghost"] .layout-places-mark[data-place="col-0"]');
            var live = document.querySelector('${PLACES} .layout-places-mark[data-place="col-1"]');
            return {
              previewing: plan.hasAttribute("data-previewing"),
              ghostMode: ghostMark === null ? null : ghostMark.getAttribute("data-mode"),
              ghostSubject: ghostMark !== null && ghostMark.hasAttribute("data-subject"),
              liveOpacity: live === null ? "" : getComputedStyle(live).opacity,
            };
          })()`,
        );
        expect(ghostFacts, "an active layer is showing").not.toBeNull();
        expect(
          ghostFacts!.ghostMode,
          "the ghost's mark wears the PROPOSED mode — the one the press would set",
        ).toBe("split");
        expect(
          ghostFacts!.ghostSubject,
          "and it is the subject: the one place this preview is about",
        ).toBe(true);
        // The live overlay steps back while the ghost speaks — otherwise two
        // mark sets overlap, one of them at the wrong geometry.
        expect(
          Number(ghostFacts!.liveOpacity),
          "the live marks step back while a preview shows",
        ).toBe(0);
        note(
          `hover col-0: ghost says split (subject), live marks at opacity ${ghostFacts!.liveOpacity}`,
        );

        // ── Hovering a deck-wide row: the ghost's marks land on the layer's
        //    own blocks, not the committed ones. ──
        await hover(
          app,
          `[data-testid="lens-layouts-width"] [data-choice-value="wide"]`,
        );
        await wait(300);
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

        // ── Clearing the hover brings the live marks back. ──
        await hover(app, ".layouts-figure");
        await wait(300);
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

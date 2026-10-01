/**
 * at0662-miniature-rearrange.test.ts — a card dragged in the Layout miniature
 * rearranges the deck.
 *
 * A hand that travels from a target on the miniature drags the card that
 * target names. The canvas enumerates the zones it would offer that card, the
 * picture places each on the part that draws it, and the release commits
 * through the canvas's own commit. What this file pins:
 *
 *   (a) a block dropped on an empty slot moves its card there alone — and
 *       while the hand is down, the drawing carries the drag's ghost and
 *       offered place and the canvas says a card is in the air; the release
 *       takes all three away;
 *   (a′) a block dropped a quarter of the way down a lone sitter's block
 *       divides that column, the arriving card on top;
 *   (b) a drag released on its own block commits nothing;
 *   (c) a split member dragged to the top of its column goes first;
 *   (d) the lower of two rail members dragged to the top of the rail goes
 *       first;
 *   (f) Escape mid-drag retires the drag: the release that follows over
 *       another slot commits nothing and runs no press.
 *
 * Every gesture is native, and every read after a release waits on a
 * bubble-phase `pointerup` barrier — CGEvents and RPC reads are not ordered
 * under a parallel batch.
 *
 * The canvas's remote verbs live in `deck-canvas.tsx`, which this file
 * exercises but does not name: that module already fans out to the ceiling
 * `ACCEPTED_FANOUT` records, and the ratchet only pays down. The registry and
 * `drop-zones.ts` it names are the seam those verbs are declared on.
 *
 * @covers tugdeck/src/components/layout/use-miniature-gestures.ts
 * @covers tugdeck/src/components/layout/miniature-gestures.ts
 * @covers tugdeck/src/lib/drop-zone-host-registry.ts
 * @covers tugdeck/src/lib/drop-zones.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { effectiveColumnOrder } from "../../tugdeck/src/lib/layout-imposer";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const PLACES = '[data-testid="layout-card-places"]';
const COMMITTED_MINI =
  '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini';

interface Point {
  x: number;
  y: number;
}

interface Snapshot {
  panes: { id: string; slot?: number }[];
  imposition: {
    columns?: Record<string, { mode?: string; order?: string[] }>;
    rails?: Record<string, { order?: string[] }>;
  };
}

/** The Layout card and Jots stand on the right rail, Layout on top. */
function railPanes() {
  const pane = (id: string, cardId: string, title: string) => ({
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  });
  return [pane("pLayout", "L", "Layout"), pane("pJots", "J", "Jots")];
}

/** Three-up under fit, with the cards `[paneId, slot, cardId]` and the rail. */
function deck(
  members: [string, number, string][],
  columns?: Record<number, { mode: "split" }>,
) {
  return {
    cards: [
      ...members.map(([, , id]) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => ({
        id,
        position: { x: 40, y: 40 },
        size: { width: PANE_WIDTH, height: 400 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["maker"],
        slot,
      })),
      ...railPanes(),
    ],
    activePaneId: members[0][0],
    imposition: {
      kind: "three-up",
      sidebars: { layout: { side: "right" }, jots: { side: "right" } },
      rails: { right: { mode: "split", order: ["layout", "jots"] } },
      ...(columns === undefined ? {} : { columns }),
    },
    hasFocus: true,
  };
}

async function openDeck(
  app: App,
  state: Record<string, unknown>,
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
  await app.seedDeckState({ state, focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('${PLACES} .layout-places-target') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

function snapshot(app: App): Promise<Snapshot> {
  return app.evalJS<Snapshot>(`window.tugdeck.diag.getDeckState()`);
}

function panesInSlot(state: Snapshot, slot: number): string[] {
  return state.panes
    .filter((p) => p.slot === slot)
    .map((p) => p.id)
    .sort();
}

/** A target's rect, by selector inside the overlay. */
async function rectOf(
  app: App,
  selector: string,
): Promise<{ left: number; top: number; width: number; height: number }> {
  const rect = await app.evalJS<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(`${PLACES} ${selector}`)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`,
  );
  if (rect === null) throw new Error(`nothing at ${selector}`);
  return rect;
}

async function centerOf(app: App, selector: string): Promise<Point> {
  const r = await rectOf(app, selector);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** How many pointerups the window has heard — the barrier a release waits on. */
function pointerUps(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      if (window.__at0662Ups === undefined) {
        window.__at0662Ups = 0;
        window.addEventListener("pointerup", function () { window.__at0662Ups += 1; });
      }
      return window.__at0662Ups;
    })()`,
  );
}

async function afterPointerUp(app: App, before: number): Promise<void> {
  await app.waitForCondition<boolean>(`window.__at0662Ups > ${before}`, {
    timeoutMs: 8_000,
  });
}

/** A whole drag, from press to release, waiting until the release is handled. */
async function drag(app: App, from: Point, to: Point): Promise<void> {
  const before = await pointerUps(app);
  await app.nativeDrag(from, to);
  await afterPointerUp(app, before);
  await wait(AFTER_LAND_MS);
}

/** Whether the drag's three marks are on: ghost, offered place, carrying. */
function dragMarks(
  app: App,
): Promise<{ drag: boolean; zone: boolean; carrying: string | null }> {
  return app.evalJS(
    `(function () {
      var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
      var canvas = document.querySelector("[data-carrying]");
      return {
        drag: mini !== null && mini.hasAttribute("data-gauge-drag"),
        zone: mini !== null && mini.hasAttribute("data-gauge-zone"),
        carrying: canvas === null ? null : canvas.getAttribute("data-carrying"),
      };
    })()`,
  );
}

const BLOCK = (slot: number) => `[data-testid="layout-card-target-block-${slot}"]`;

describe.skipIf(!SHOULD_RUN)("at0662 — the miniature rearranges the deck", () => {
  test(
    "slot drops, divided drops, a drop at home, members, rails and Escape",
    async () => {
      const app = await launchTugApp({ testName: "at0662-miniature-rearrange" });
      try {
        // (a) A to the empty slot 2, held first to read the drag's marks.
        await openDeck(app, deck([["p1", 0, "A"], ["p2", 1, "B"]]));
        const fromA = await centerOf(app, BLOCK(0));
        const toEmpty = await centerOf(app, BLOCK(2));
        const ups = await pointerUps(app);
        await app.nativeDragWithoutRelease(fromA, toEmpty);
        await app.waitForCondition<boolean>(
          `(function () {
            var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
            return mini !== null && mini.hasAttribute("data-gauge-zone");
          })()`,
          { timeoutMs: 8_000 },
        );
        const held = await dragMarks(app);
        note(`held over the empty slot: ${JSON.stringify(held)}`);
        expect(held.drag, "the drawing carries the ghost").toBe(true);
        expect(held.zone, "and the offered place").toBe(true);
        expect(held.carrying, "and the canvas says a card is in the air").toBe(
          "card",
        );
        await app.nativeMouseUp(toEmpty);
        await afterPointerUp(app, ups);
        await wait(AFTER_LAND_MS);
        const released = await dragMarks(app);
        expect(released, "the release takes every mark away").toEqual({
          drag: false,
          zone: false,
          carrying: null,
        });
        let state = await snapshot(app);
        expect(panesInSlot(state, 2), "A stands alone in slot 2").toEqual(["p1"]);

        // (a′) A a quarter of the way down B's block: B is a lone sitter, so
        // the column divides with A on top.
        await openDeck(app, deck([["p1", 0, "A"], ["p2", 1, "B"]]));
        const b = await rectOf(app, BLOCK(1));
        await drag(app, await centerOf(app, BLOCK(0)), {
          x: b.left + b.width / 2,
          y: b.top + b.height / 4,
        });
        state = await snapshot(app);
        const order = effectiveColumnOrder(
          state.imposition as never,
          1,
          panesInSlot(state, 1),
        );
        note(`slot 1 after the divided drop: ${JSON.stringify(state.imposition.columns?.["1"])}, order ${order.join(",")}`);
        expect(state.imposition.columns?.["1"]?.mode, "slot 1 is split").toBe(
          "split",
        );
        expect(order, "A on top of B").toEqual(["p1", "p2"]);

        // (b) A released on its own block commits nothing.
        await openDeck(app, deck([["p1", 0, "A"], ["p2", 1, "B"]]));
        const home = await rectOf(app, BLOCK(0));
        // Slots by pane id: the press activates the Layout card on its way
        // down, which raises its pane and reorders the list without moving
        // anything.
        const slotsOf = (s: Snapshot) =>
          Object.fromEntries(s.panes.map((p) => [p.id, p.slot ?? null]));
        const before = await snapshot(app);
        await drag(
          app,
          { x: home.left + home.width / 2, y: home.top + home.height / 2 },
          { x: home.left + home.width / 2 + 6, y: home.top + home.height / 2 + 30 },
        );
        const after = await snapshot(app);
        expect(slotsOf(after), "a drop at home moves no card").toEqual(
          slotsOf(before),
        );
        expect(after.imposition, "and commits nothing").toEqual(
          before.imposition,
        );

        // (c) A split column of two: the lower member to the top goes first.
        await openDeck(
          app,
          deck([["p1", 0, "A"], ["p2", 0, "B"], ["p3", 1, "C"]], {
            0: { mode: "split" },
          }),
        );
        const top = await rectOf(app, '[data-target="member"][data-pane-id="p1"]');
        await drag(
          app,
          await centerOf(app, '[data-target="member"][data-pane-id="p2"]'),
          { x: top.left + top.width / 2, y: top.top + 2 },
        );
        state = await snapshot(app);
        const members = effectiveColumnOrder(
          state.imposition as never,
          0,
          panesInSlot(state, 0),
        );
        note(`split column after the member drag: ${members.join(",")}`);
        expect(members, "B goes first").toEqual(["p2", "p1"]);

        // (d) The lower rail member to the top of the rail goes first.
        const rail = await app.evalJS<{ left: number; top: number; width: number }>(
          `(function () {
            var r = document.querySelector('${PLACES} .layout-places-rail[data-side="right"]').getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width };
          })()`,
        );
        await drag(
          app,
          await centerOf(app, '[data-target="rail"][data-pane-id="pJots"]'),
          { x: rail.left + rail.width / 2, y: rail.top + 2 },
        );
        state = await snapshot(app);
        note(`right rail after the rail drag: ${JSON.stringify(state.imposition.rails?.right)}`);
        expect(state.imposition.rails?.right?.order?.[0], "Jots goes first").toBe(
          "jots",
        );

        // (f) Escape mid-drag: the release over another slot commits nothing
        // and runs no press.
        await openDeck(app, deck([["p1", 0, "A"], ["p2", 1, "B"]]));
        const fromEsc = await centerOf(app, BLOCK(0));
        const overEmpty = await centerOf(app, BLOCK(2));
        const beforeEsc = await snapshot(app);
        const upsEsc = await pointerUps(app);
        await app.nativeDragWithoutRelease(fromEsc, overEmpty);
        await app.waitForCondition<boolean>(
          `document.querySelector("[data-carrying]") !== null`,
          { timeoutMs: 8_000 },
        );
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector("[data-carrying]") === null`,
          { timeoutMs: 8_000 },
        );
        await app.nativeMouseUp(overEmpty);
        await afterPointerUp(app, upsEsc);
        await wait(AFTER_LAND_MS);
        const afterEsc = await snapshot(app);
        expect(panesInSlot(afterEsc, 0), "A stayed in slot 0").toEqual(["p1"]);
        expect(panesInSlot(afterEsc, 2), "nothing landed in slot 2").toEqual([]);
        expect(afterEsc.imposition, "nothing was committed").toEqual(
          beforeEsc.imposition,
        );
        expect(await dragMarks(app), "and no marks are left").toEqual({
          drag: false,
          zone: false,
          carrying: null,
        });
        expect(
          await app.getActiveCardId(),
          "the release after Escape ran no press",
        ).toBe("L");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

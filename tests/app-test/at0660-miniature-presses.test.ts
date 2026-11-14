/**
 * at0660-miniature-presses.test.ts — every part of the Layout miniature answers
 * a press.
 *
 * The drawing used to take no pointer, and only the stack/split marks at the
 * foot of each slot were live. The places overlay now stands an invisible
 * target on every column block, split member and rail member, and a press on
 * one goes to the card it names:
 *
 *   (a) a block goes to its slot and raises the card standing there;
 *   (b) a second press in succession on a stacked block brings up the stack's
 *       bottom-most card, so a stack three deep is ringed by three presses and
 *       the fourth comes home;
 *   (c) a split member raises its own card, and pressing it again changes
 *       nothing — members never cycle;
 *   (d) a rail member activates that sidebar card;
 *   (e) an empty slot raises nothing: the Layout card stays active;
 *   (f) under flow, a block off the band brings the band to it and raises it.
 *
 * Every press is a trusted native click on the target's LEADING edge. Under fit
 * the blocks lap, and the leading strip is the part of a lapped card that is
 * always visible — the part a reader would actually press.
 *
 * @covers tugdeck/src/components/layout/layout-places.tsx
 * @covers tugdeck/src/components/layout/layout-places.css
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/components/layout/use-miniature-gestures.ts
 * @covers tugdeck/src/components/layout/miniature-gestures.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
const SLIM_PX = 675;
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const PLACES = '[data-testid="layout-card-places"]';

/** The Layout card and Jots stand on the right rail, Layout on top. */
const RAIL_CARDS = [
  { id: "L", componentId: "layout", title: "Layout", closable: true },
  { id: "J", componentId: "jots", title: "Jots", closable: true },
];
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
const RAIL_IMPOSITION = {
  sidebars: { layout: { side: "right" }, jots: { side: "right" } },
  rails: { right: { mode: "split", order: ["layout", "jots"] } },
};

/**
 * Four-up under fit: slot 0 holds A alone, slot 1 a stack of B, C and D (D in
 * front — the last pane in the list), slot 2 is split between E and F, and
 * slot 3 is empty.
 */
function fitDeck() {
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
    ["p2", 1, "B"],
    ["p3", 1, "C"],
    ["p4", 1, "D"],
    ["p5", 2, "E"],
    ["p6", 2, "F"],
  ];
  return {
    cards: [
      ...members.map(([, , id]) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      ...RAIL_CARDS,
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => pane(id, slot, cardId)),
      ...railPanes(),
    ],
    activePaneId: "p1",
    imposition: {
      kind: "four-up",
      ...RAIL_IMPOSITION,
      slots: { 2: { mode: "split" } },
    },
    hasFocus: true,
  };
}

/** Five slim cards under flow — a strip longer than the band. */
function flowDeck() {
  const ids = ["A", "B", "C", "D", "E"];
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      ...RAIL_CARDS,
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: SLIM_PX, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
      ...railPanes(),
    ],
    activePaneId: "p1",
    imposition: { kind: "five-up", layout: "flow", ...RAIL_IMPOSITION },
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
  await app.body("L").waitForCondition<boolean>(
    `document.querySelector('${PLACES} .layout-places-target') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/**
 * How many pointerups the window has heard — the barrier a press waits on.
 *
 * A native click arrives through CGEvents and a read through the RPC, and the
 * two are not ordered: under a parallel batch the app's main thread can run a
 * read before the click it follows. A window-level listener in the BUBBLE
 * phase runs after the target's own pointerup handlers, so once the count has
 * moved, the press has done everything it does synchronously. The presses
 * land in the Layout card, so the window that hears them is its body's.
 */
function pointerUps(app: App): Promise<number> {
  return app.body("L").evalJS<number>(
    `(function () {
      if (window.__at0660Ups === undefined) {
        window.__at0660Ups = 0;
        window.addEventListener("pointerup", function () { window.__at0660Ups += 1; });
      }
      return window.__at0660Ups;
    })()`,
  );
}

/** Press a target at its leading edge, half way down, and wait until the
 *  press has been handled. */
async function press(app: App, selector: string): Promise<void> {
  const point = await app.body("L").evalJS<{ x: number; y: number } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(`${PLACES} ${selector}`)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left + Math.min(4, r.width / 2), y: r.top + r.height / 2 };
    })()`,
  );
  if (point === null) throw new Error(`no target at ${selector}`);
  const before = await pointerUps(app);
  // `point` is in the body's viewport, so the press is the body's.
  await app.body("L").nativeClick(point);
  await app.body("L").waitForCondition<boolean>(`window.__at0660Ups > ${before}`, {
    timeoutMs: 8_000,
  });
}

/** How long a press's raise may take to come back from the shell. */
const ROUND_TRIP_MS = 3_000;

/**
 * Wait until the press has come back: the shell's active card is `cardId`,
 * and — for a block press — the Layout card's own picture shows `frontPaneId`
 * at the front of the slot. Returns the active card the shell holds, which is
 * `cardId` unless the press reached something else.
 *
 * The pointerup alone is no longer the press's end. Since every card draws in
 * its own page (`7ee393cd9`), the raise a press asks for crosses the bus to
 * the shell, and the deck the Layout card reads comes back the same way, some
 * tens of milliseconds later. The press handler decides which card of a stack
 * a press reaches off THAT deck (`stackPressCardId`), so a press issued before
 * the last one's raise has come back is read off the picture before it: the
 * file once pressed four times in about as many milliseconds, read the stale
 * front every time, and saw `D → D → D → D`. A reader's presses are a hundred
 * milliseconds apart at the least; this is the wait that puts the file's on
 * the same footing.
 */
async function pressLanded(
  app: App,
  cardId: string,
  frontPaneId?: string,
): Promise<string | null> {
  const deadline = Date.now() + ROUND_TRIP_MS;
  let active = await app.getActiveCardId();
  while (active !== cardId && Date.now() < deadline) {
    await wait(20);
    active = await app.getActiveCardId();
  }
  if (active === cardId && frontPaneId !== undefined) {
    await app.body("L").waitForCondition<boolean>(
      `document.querySelector('.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-face[data-pane-id="${frontPaneId}"]') !== null`,
      { timeoutMs: ROUND_TRIP_MS },
    );
  }
  return active;
}

function committedOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0660 — the miniature's parts take presses", () => {
  test(
    "blocks, stacks, members, rails and empty slots under fit",
    async () => {
      const app = await launchTugApp({ testName: "at0660-miniature-presses" });
      try {
        await openDeck(app, fitDeck());

        const targets = await app.body("L").evalJS<string[]>(
          `Array.prototype.map.call(
            document.querySelectorAll('${PLACES} .layout-places-target'),
            function (el) { return el.getAttribute("data-testid"); }
          )`,
        );
        note(`targets: ${targets.join(", ")}`);

        // (a) A block goes to its slot and raises the card standing there.
        await press(app, '[data-testid="layout-card-target-block-0"]');
        expect(await pressLanded(app, "A", "p1"), "block 0 raises A").toBe("A");

        // (b) A stack three deep: three presses visit three cards, and the
        // fourth comes home. The ring is the one `stackPressCardId` names:
        // the front card first, then each press raises the stack's
        // bottom-most — B, then C — and the fourth brings D home.
        const ring: [string, string][] = [
          ["D", "p4"],
          ["B", "p2"],
          ["C", "p3"],
          ["D", "p4"],
        ];
        const visited: (string | null)[] = [];
        for (const [cardId, paneId] of ring) {
          await press(app, '[data-testid="layout-card-target-block-1"]');
          visited.push(await pressLanded(app, cardId, paneId));
        }
        note(`stack presses: ${visited.join(" → ")}`);
        expect(visited[0], "the first press reaches the front card").toBe("D");
        expect(new Set(visited.slice(0, 3)).size, "three distinct cards").toBe(3);
        expect(visited, "the ring: front, then bottom-most each time").toEqual(
          ring.map(([cardId]) => cardId),
        );
        expect(visited[3], "the fourth press comes home").toBe(visited[0]);

        // (c) A split member raises its own card, and never cycles.
        const member = '[data-target="member"][data-pane-id="p6"]';
        await press(app, member);
        expect(await pressLanded(app, "F"), "member F").toBe("F");
        await press(app, member);
        // A press that changes nothing has no arrival to wait on: give a raise
        // it should not make time to come back before reading.
        await wait(200);
        expect(await pressLanded(app, "F"), "member F again").toBe("F");

        // (d) A rail member activates that sidebar card.
        await press(app, '[data-target="rail"][data-pane-id="pJots"]');
        expect(await pressLanded(app, "J"), "the Jots rail member").toBe("J");

        // (e) An empty slot raises nothing: the press activated the Layout
        // card on its way down, and nothing moves activation off it.
        await press(app, '[data-testid="layout-card-target-block-3"]');
        await wait(200);
        expect(await pressLanded(app, "L"), "an empty slot leaves Layout").toBe(
          "L",
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "under flow, a block off the band brings the band to it",
    async () => {
      const app = await launchTugApp({ testName: "at0660-miniature-presses" });
      try {
        await openDeck(app, flowDeck());
        const before = await committedOffset(app);
        expect(
          await app.body("L").evalJS<boolean>(
            `document.querySelector('.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-window') !== null`,
          ),
          "the strip overflows its band, so the window is drawn",
        ).toBe(true);

        await press(app, '[data-testid="layout-card-target-block-4"]');
        // The travel is dispatched before the raise, on the same wire, so
        // once E is raised the offset has been committed too.
        const raised = await pressLanded(app, "E");
        const after = await committedOffset(app);
        note(`flow offset ${before} → ${after}`);
        expect(after, "the band travelled to the last slot").toBeGreaterThan(
          before,
        );
        expect(raised, "and its card is raised").toBe("E");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

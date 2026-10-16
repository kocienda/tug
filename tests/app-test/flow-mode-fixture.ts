/**
 * flow-mode-fixture.ts — the deck and the instruments the at0454 flow mode
 * files share: a five-slot deck beside a 420px Layout rail, the slot, band and
 * offset readers, the arrival sampler, and the cut record.
 *
 * Split out of `at0454-flow-mode.test.ts` when that file was cut into
 * `at0454-flow-mode-strip`, `-controls` and `-reveals` to keep each under the
 * 20 s budget.
 */

import { type App } from "./_harness";
import {
  IMPOSITION_GAP_PX,
  IMPOSITION_SETTLE_MS,
  RAIL_GUTTER_PX,
} from "../../tugdeck/src/lib/layout-imposer";
import { motionDurationMs } from "../../tugdeck/src/lib/imposer-motion";

/**
 * How long a card that has just landed stands there before the deck travels
 * to it — the ARRIVE BEAT's own window.
 *
 * This used to be a constant of its own, a number chosen to be about as long
 * as the entrance took. The entrance is a BEAT of the
 * settle now, the last one, and the deck travels on that beat's completion —
 * so the hold is the beat's window rather than a clock set beside it, and the
 * floor below is read off the same recipe the beat itself plays.
 */
export const ARRIVE_BEAT_MS = motionDurationMs("divide-join", IMPOSITION_SETTLE_MS);

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/** The settle window, with room for the tween to land. */
export const AFTER_LAND_MS = 900;
export const RAIL_WIDTH = 420;
export const PANE_WIDTH = 420;
/** Part 6's cards. Wide enough that the band — three 420s across — holds one
 *  and a bit, which is the crowding that leaves a neighbouring slot straddling
 *  its near edge. */
export const WIDE_PANE_WIDTH = 800;
export const SLOTS = 5;
export const KIND_TILES = '[data-testid="layout-card-kind"] [data-choice-value]';
export const LAYOUT_TILES = '[data-testid="layout-card-layout"] [data-choice-value]';
export const KIND_GROUP = '[data-testid="layout-card-kind"]';

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export interface CutRecord {
  paneId: string;
  kind: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Five cards in a six-up, plus the Layout card on the right — a strip comfortably
 *  longer than the band on any window this harness opens. */
export function deckShape(paneWidth: number = PANE_WIDTH) {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: paneWidth, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  const ids = ["A", "B", "C", "D", "E"];
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => pane(`p${index + 1}`, index, id)),
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
      kind: "six-up",
      // Fit explicitly: the deck's default is flow now, and every part below
      // starts from fit and moves to flow, so the fixture has to say so.
      layout: "fit",
      sidebars: { layout: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** Every imposed pane's frame in viewport coordinates, in slot order. */
export async function slotRects(
  app: App,
): Promise<{ paneId: string; left: number; right: number }[]> {
  return app.evalJS<{ paneId: string; left: number; right: number }[]>(
    `(function () {
      var state = window.tugdeck.diag.getDeckState();
      var out = [];
      state.panes.forEach(function (pane) {
        if (pane.slot === undefined) return;
        var el = document.querySelector('.tug-pane[data-pane-id="' + pane.id + '"]');
        if (el === null) return;
        var box = el.getBoundingClientRect();
        out.push({ paneId: pane.id, slot: pane.slot, left: box.left, right: box.right });
      });
      out.sort(function (a, b) { return a.slot - b.slot; });
      return out;
    })()`,
  );
}

/**
 * The band's edges in viewport coordinates — what `imposeStyle` measures
 * against.
 *
 * Measured off the rail's own painted frame rather than off the
 * `--tug-imposer-inset-*` properties, because those resolve to a `calc()` over
 * the rail width property and `parseFloat` of a calc is NaN. The band begins
 * one card gap in from the canvas edge and ends one rail gutter short of the
 * rail's near edge — which is the same arithmetic `resolveSpan` does, read
 * from pixels the deck actually drew.
 */
export async function band(app: App): Promise<{ left: number; right: number }> {
  return app.evalJS<{ left: number; right: number }>(
    `(function () {
      var el = document.querySelector("[data-deck-canvas-background]");
      var box = el.getBoundingClientRect();
      var rail = document
        .querySelector('.tug-pane[data-pane-id="pRail"]')
        .getBoundingClientRect();
      return { left: box.left + ${IMPOSITION_GAP_PX}, right: rail.left - ${RAIL_GUTTER_PX} };
    })()`,
  );
}

export async function flowOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

/** The ids of every Text card the deck holds, for catching the one an open
 *  adds. */
export const textCardIds = (app: App): Promise<string[]> =>
  app.evalJS<string[]>(
    `window.tugdeck.diag.getDeckState().cards
      .filter(function (c) { return c.componentId === "text"; })
      .map(function (c) { return c.id; })`,
  );

/** One reading of where the arriving card stood, and when. */
export interface ArrivalSample {
  t: number;
  left: number;
}

/**
 * Start recording where the card an open is about to add stands, from now
 * until {@link stopArrivalSampler}.
 *
 * A timer rather than `requestAnimationFrame`, which an occluded harness
 * window suspends — the reading itself is a `getBoundingClientRect`, which
 * resolves layout on demand and carries the settle's transform, so it answers
 * where the card IS whether or not this window is the one being looked at.
 *
 * `known` is the Text cards standing before the gesture; the sampler watches
 * for the one that is not among them.
 */
export const startArrivalSampler = (
  app: App,
  known: readonly string[],
): Promise<null> =>
  app.evalJS<null>(
    `(function () {
      var known = ${JSON.stringify(known)};
      window.__arrival = { samples: [] };
      window.__arrival.timer = setInterval(function () {
        var state = window.tugdeck.diag.getDeckState();
        var fresh = state.cards.filter(function (c) {
          return c.componentId === "text" && known.indexOf(c.id) === -1;
        })[0];
        if (fresh === undefined) return;
        var pane = state.panes.filter(function (p) {
          return p.cardIds.indexOf(fresh.id) !== -1;
        })[0];
        if (pane === undefined) return;
        var el = document.querySelector(
          '.tug-pane[data-pane-id="' + pane.id + '"]');
        if (el === null) return;
        window.__arrival.samples.push({
          t: performance.now(),
          left: el.getBoundingClientRect().left,
        });
      }, 8);
      return null;
    })()`,
  );

/** Stop the sampler and answer everything it saw, oldest first. */
export const stopArrivalSampler = (app: App): Promise<ArrivalSample[]> =>
  app.evalJS<ArrivalSample[]>(
    `(function () {
      clearInterval(window.__arrival.timer);
      return window.__arrival.samples;
    })()`,
  );

/** The painted frame of the pane holding `cardId`, in viewport coordinates. */
export const cardRect = (
  app: App,
  cardId: string,
): Promise<{ left: number; right: number }> =>
  app.evalJS<{ left: number; right: number }>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
        return p.cardIds.indexOf(${JSON.stringify(cardId)}) !== -1;
      });
      var box = document
        .querySelector('.tug-pane[data-pane-id="' + pane.id + '"]')
        .getBoundingClientRect();
      return { left: box.left, right: box.right };
    })()`,
  );

export async function setLayout(app: App, layout: "fit" | "flow"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: ${JSON.stringify(layout)} }), null)`,
  );
}

/** Tab until `selector` is the group carrying the keyboard ring — the walk the
 *  sidebar ladder is actually navigated by (at0277 uses the same one). */
export async function tabUntilKbd(app: App, selector: string): Promise<void> {
  const reached = (): Promise<boolean> =>
    app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(`${selector}[data-key-view-kbd]`)}) !== null`,
    );
  for (let i = 0; i < 20; i += 1) {
    if (await reached()) return;
    await app.nativeKey("Tab");
    await wait(200);
  }
  if (await reached()) return;
  throw new Error(`Tab never reached ${selector}`);
}

/** Which segment of the Layout row is the standing answer. */
export async function activeLayoutTile(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var el = document.querySelector(
        '[data-testid="layout-card-layout"] [data-choice-value][data-state="active"]',
      );
      return el === null ? null : el.getAttribute("data-choice-value");
    })()`,
  );
}

export async function takeCuts(app: App): Promise<CutRecord[]> {
  return app.evalJS<CutRecord[]>(`window.__tug.takeCutRecords()`);
}

export function summarize(records: readonly CutRecord[]): string {
  return records
    .map((r) =>
      r.kind === "appeared"
        ? `${r.paneId} appeared with nothing animating it`
        : `${r.paneId} jumped (${Math.round(r.dx)}, ${Math.round(r.dy)})`,
    )
    .join("; ");
}

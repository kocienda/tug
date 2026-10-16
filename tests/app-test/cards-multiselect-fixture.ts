/**
 * cards-multiselect-fixture.ts — the deck and the instruments the at0451
 * Cards multiselect files share: a deck of content cards beside the Cards
 * card, the selection and slot readers, and the Cards list's cursor, filter
 * and row gestures.
 *
 * Split out of `at0451-cards-multiselect.test.ts` when that file was cut into
 * `at0451-cards-multiselect-chords`, `-list` and `-escape` to keep each under
 * the 20 s budget.
 */

import { type App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const FRAMES = ".tug-pane[data-pane-id]";
export const CARDS_WIDTH = 675;
export const PANE_WIDTH = 420;
/** The settle window (`IMPOSITION_SETTLE_MS`) plus room for the tween to land. */
export const AFTER_LAND_MS = 900;

export interface CutRecord {
  kind: "jump" | "appeared";
  paneId: string;
}

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export function deckShape() {
  const card = (id: string, title: string) => ({
    id,
    componentId: "gallery-accordion",
    title,
    closable: true,
  });
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
  return {
    cards: [
      card("A", "Card A"),
      card("B", "Card B"),
      card("C", "Card C"),
      { id: "L", componentId: "cards", title: "Cards", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
      {
        id: "pCards",
        position: { x: 0, y: 0 },
        size: { width: CARDS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Cards",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "three-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  };
}

/** Every content pane's slot, keyed by the card it holds. */
export async function slotsByCard(app: App): Promise<Record<string, number | null>> {
  return app.evalJS<Record<string, number | null>>(
    `(function () {
      var deck = window.tugdeck.diag.getDeckState();
      var out = {};
      for (var i = 0; i < deck.panes.length; i += 1) {
        var pane = deck.panes[i];
        for (var j = 0; j < pane.cardIds.length; j += 1) {
          out[pane.cardIds[j]] = pane.slot === undefined ? null : pane.slot;
        }
      }
      return out;
    })()`,
  );
}

/** The card standing in front — the deck's composite first responder. */
export async function frontCard(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var deck = window.tugdeck.diag.getDeckState();
      var pane = deck.panes.find(function (p) { return p.id === deck.activePaneId; });
      return pane === undefined ? null : pane.activeCardId;
    })()`,
  );
}

export async function setSelection(app: App, cardIds: string[]): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setLayoutSelection(${JSON.stringify(cardIds)}), null)`,
  );
}

export async function getSelection(app: App): Promise<string[]> {
  return app.evalJS<string[]>(`window.__tug.getLayoutSelection()`);
}

/** The Cards row the movement cursor is standing on. */
export const CURSOR_ROW = ".cards-list .tug-list-view-cell[data-key-cursor]";

/** The Cards section's attached filter field. */
export const FILTER_INPUT =
  '.cards-card .tug-filter-field-input';

/** How many rows the Cards list is showing — headers included. */
export async function rowCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(".cards-list .tug-list-view-cell").length`,
  );
}

/** Put the caret in the Cards section's filter field. */
export async function clickFilterField(app: App): Promise<boolean> {
  const box = await app.evalJS<{ x: number; y: number } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  if (box === null) return false;
  await app.nativeClick(box, { activateFirst: false });
  return true;
}

/** The Cards section's live filter query. */
export async function filterQuery(app: App): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(FILTER_INPUT)})?.value ?? "")`,
  );
}

export async function cursorTitle(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(CURSOR_ROW)});
      return el === null ? "" : (el.textContent || "");
    })()`,
  );
}

/**
 * Park the cursor on the row whose text contains `title`.
 *
 * Home first, then down — never down from wherever the cursor happens to be.
 * The list's last row hands the arrow onward rather than clamping (the
 * liveliness net), so a walk that starts below its target
 * leaves the Cards list entirely and the cursor stops existing. Fails loudly
 * rather than walking forever: a cursor that will not move is the interesting
 * failure.
 */
export async function walkCursorTo(app: App, title: string): Promise<void> {
  await app.nativeKey("Home");
  await wait(150);
  for (let i = 0; i < 12; i += 1) {
    if ((await cursorTitle(app)).includes(title)) return;
    await app.nativeKey("ArrowDown");
    await wait(120);
  }
  throw new Error(
    `cursor never reached "${title}" (stopped on ${JSON.stringify(
      await cursorTitle(app),
    )})`,
  );
}

/**
 * Put the keyboard in the Cards list and wait until its cursor is painted.
 *
 * Called again after every slot chord, because assigning a slot RAISES the card
 * it moved and takes the keyboard with it — the Cards card's documented slot-assign
 * exit, pinned by at0278. That is deliberate behavior this test rides rather
 * than fights.
 */
export async function focusCardsList(app: App): Promise<void> {
  await app.dispatchControlAction("toggle-cards");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
    { timeoutMs: 8_000 },
  );
}

/** Click the Cards row whose text contains `title`, on its title text — never
 *  on a close box or a slot button, which act on the row rather than pick it. */
export async function clickRowTitled(app: App, title: string): Promise<boolean> {
  const box = await app.evalJS<{ x: number; y: number } | null>(
    `(function () {
      var rows = document.querySelectorAll(".cards-list .tug-list-view-cell");
      for (var i = 0; i < rows.length; i += 1) {
        if ((rows[i].textContent || "").indexOf(${JSON.stringify(title)}) === -1) continue;
        var label = rows[i].querySelector(".tug-list-row-content") || rows[i];
        var r = label.getBoundingClientRect();
        return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    })()`,
  );
  if (box === null) return false;
  await app.nativeClick(box, { activateFirst: false });
  return true;
}

export async function seedCardsPreferred(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.cards", "widthPx", { kind: "i64", value: ${CARDS_WIDTH} }), null)`,
  );
}

/**
 * card-slot-badge-fixture.ts — the deck and the readers the at0462 slot badge
 * files share: a deck of Session cards under a chosen imposition, the badge
 * reader, and the open-and-land the cases start from.
 *
 * Split out of `at0462-card-slot-badge.test.ts` when that file was cut into
 * `at0462-card-slot-badge-readout`, `-placement` and `-picker` to keep each
 * under the 20 s budget.
 */

import { type App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

/** The settle window, with room for the imposition's landing tween. */
export const AFTER_LAND_MS = 900;

export const BADGE = '[data-testid="card-slot-badge"]';
export const FRAME = '[data-slot="session-masthead"]';
export const CLUSTER = '[data-testid="tug-pane-title-bar-controls"]';
export const TRIGGER = '[data-testid="card-slot-badge-trigger"]';
export const POPUP = '[data-testid="card-slot-badge-popup"]';
export const PICKER = '[data-testid="card-slot-badge-picker"]';
export const PICKER_CHIPS = `${PICKER} [data-slot="tug-slot"]`;
/** The first card's pane in the shell, where the deck's facts about it stand. */
export const PANE_A = '.tug-pane[data-pane-id="p1"]';
/**
 * The first card's pane in its own page: a Session card draws its chrome
 * there, badge and all, and the page holds that one pane.
 */
export const PAGE_PANE = ".body-chrome-frame";

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * A deck of `count` session cards, one per slot, under the matching imposition.
 * Session cards because the badge lives in the masthead tier and a Session card
 * wears one from a bare seed — no fixture repo, no published payload.
 */
export function deckShape(count: number): Record<string, unknown> {
  const ids = ["A", "B", "C", "D"].slice(0, count);
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "session",
      title: `Session ${id}`,
      closable: true,
    })),
    panes: ids.map((id, index) => ({
      id: `p${index + 1}`,
      position: { x: 40 + index * 40, y: 40 },
      size: { width: 675, height: 520 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["standard"],
      slot: index,
    })),
    activePaneId: "p1",
    imposition: {
      kind: ["one-up", "two-up", "three-up", "four-up"][count - 1],
    },
    hasFocus: true,
  };
}

/** The badges in one page, each with the pane id that page names it by. */
const badgesInPage = (skipStandIns: boolean): string => `(function () {
  return Array.prototype.slice.call(
    document.querySelectorAll(${JSON.stringify(BADGE)})
  ).filter(function (el) {
    return !(${skipStandIns} && el.closest("[data-chrome-in-body]"));
  }).map(function (el) {
    var pane = el.closest("[data-pane-id]");
    var chip = el.querySelector('[data-slot="tug-slot"]');
    return {
      paneId: pane === null ? "" : pane.getAttribute("data-pane-id"),
      digit: chip === null ? "" : chip.textContent,
      state: chip === null ? "" : chip.getAttribute("data-state"),
    };
  });
})()`;

/**
 * The cards whose pane in the shell is a stand-in — they draw their own
 * chrome, so their badge is in their own page — by the shell's pane id.
 */
export async function chromeCards(app: App): Promise<Map<string, string>> {
  const pairs = await app.evalJS<Array<[string, string]>>(
    `(function () {
      var deck = window.tugdeck.diag.getDeckState();
      return Array.prototype.slice.call(document.querySelectorAll(".tug-pane[data-chrome-in-body]")).map(function (f) {
        var pane = deck.panes.find(function (p) { return p.id === f.getAttribute("data-pane-id"); });
        return [f.getAttribute("data-pane-id"), pane ? pane.activeCardId : ""];
      });
    })()`,
  );
  return new Map(pairs);
}

/**
 * Every badge on the deck, paired with the pane it stands in: the shell's own
 * panes' badges in the shell's document, and each card that draws its own
 * chrome's badge in that card's page, by the shell's pane id. In pane order.
 */
export async function readBadges(
  app: App,
): Promise<{ paneId: string; digit: string; state: string }[]> {
  type Badge = { paneId: string; digit: string; state: string };
  const out: Badge[] = [...(await app.evalJS<Badge[]>(badgesInPage(true)))];
  for (const [paneId, cardId] of await chromeCards(app)) {
    for (const b of await app.body(cardId).evalJS<Badge[]>(badgesInPage(false))) out.push({ ...b, paneId });
  }
  return out.sort((a, b) => a.paneId.localeCompare(b.paneId));
}

/**
 * Seed, bind, and wait for the deck to settle into the imposition.
 *
 * The binding is not decoration: an UNBOUND session card renders the project
 * picker and wears no masthead at all, so a badge that never mounted would read
 * as a badge that correctly declined. Every session card here is bound.
 */
export async function openDeck(
  app: App,
  state: Record<string, unknown>,
  focusCardId: string,
): Promise<void> {
  await app.seedDeckState({ state, focusCardId });
  const sessionCards = (state.cards as Record<string, unknown>[])
    .filter((card) => card.componentId === "session")
    .map((card) => card.id as string);
  for (const cardId of sessionCards) {
    await app.bindSession(cardId, {
      tugSessionId: `at0462-${cardId}`,
      projectDir: "/tmp/at0462",
    });
  }
  // A Session card draws its masthead in its own page.
  for (const cardId of sessionCards) {
    await app.body(cardId).waitForCondition<boolean>(
      `document.querySelector(${JSON.stringify(FRAME)}) !== null`,
      { timeoutMs: 15_000 },
    );
  }
  await wait(AFTER_LAND_MS);
}

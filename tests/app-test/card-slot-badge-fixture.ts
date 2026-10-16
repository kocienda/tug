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
/** The first card's pane, so a click lands on ITS badge and not a neighbour's. */
export const PANE_A = '.tug-pane[data-pane-id="p1"]';

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

/** Every badge on the deck, paired with the pane it stands in. */
export async function readBadges(
  app: App,
): Promise<{ paneId: string; digit: string; state: string }[]> {
  return app.evalJS(
    `(function () {
      return Array.prototype.slice.call(
        document.querySelectorAll(${JSON.stringify(BADGE)})
      ).map(function (el) {
        var pane = el.closest("[data-pane-id]");
        var chip = el.querySelector('[data-slot="tug-slot"]');
        return {
          paneId: pane === null ? "" : pane.getAttribute("data-pane-id"),
          digit: chip === null ? "" : chip.textContent,
          state: chip === null ? "" : chip.getAttribute("data-state"),
        };
      });
    })()`,
  );
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
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(FRAME)}).length === ${sessionCards.length}`,
    { timeoutMs: 15_000 },
  );
  await wait(AFTER_LAND_MS);
}

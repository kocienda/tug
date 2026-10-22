/**
 * rail-width-commit-fixture.ts — the deck the rail width commit and cancel
 * readings share (`at0677-rail-width-drag-commit`,
 * `at0677-rail-width-drag-cancel`): three sidebar cards on the left rail
 * beside a three-up chain whose first slot holds two panes, one buried, and
 * the readings each takes of it in the shell and in the host.
 */

import { expect } from "bun:test";

import type { App } from "./_harness";
import { chromePoint } from "./card-chrome-fixture";
import { PIXEL_TOL } from "./_harness/tolerances";
import { CARD_APRON_PX } from "./rail-width-fixture";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 90_000;

/** The width every rail member is seeded at. */
export const RAIL_WIDTH = 420;
/** How far the drag narrows the rail: well past the move threshold and well
 *  clear of the members' 320px floors, so the drag lands where it was aimed. */
export const NARROW_PX = 60;
/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
export const AFTER_LAND_MS = 900;
/** Long enough for a few animation frames to run after a pointer event. */
export const FRAMES_MS = 250;

export const MEMBERS = ["cards", "jots", "layout"] as const;
export const PANE_OF: Record<(typeof MEMBERS)[number], string> = {
  cards: "pCards",
  jots: "pJots",
  layout: "pLayout",
};
/** The member whose edge the hand drags: the middle one, so neither the
 *  first nor the last member stands in for "the rail". */
export const DRAGGED = "pJots";

export const frame = (paneId: string): string =>
  `.tug-pane[data-pane-id="${paneId}"]`;

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export function card(id: string, componentId: string, title: string) {
  return { id, componentId, title, closable: true };
}

export function chainPane(id: string, cardId: string, slot: number) {
  return {
    id,
    position: { x: 40, y: 40 },
    size: { width: 400, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  };
}

export function railPane(id: string, cardId: string, title: string) {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  };
}

/**
 * Three sidebar cards on the left rail, all at `RAIL_WIDTH`, beside a
 * three-up chain. Slot 0 holds TWO panes of equal width — `pBuried` behind
 * `pFront` — so the drag runs over a stack ([at0347]'s occluded shape).
 */
export function deckShape() {
  return {
    cards: [
      card("C", "cards", "Cards"),
      card("J", "jots", "Jots"),
      card("L", "layout", "Layout"),
      card("Z", "hello", "Card Z"),
      card("A", "hello", "Card A"),
      card("B", "hello", "Card B"),
    ],
    panes: [
      chainPane("pBuried", "Z", 0),
      chainPane("pFront", "A", 0),
      chainPane("pSecond", "B", 2),
      railPane("pCards", "C", "Cards"),
      railPane("pJots", "J", "Jots"),
      railPane("pLayout", "L", "Layout"),
    ],
    activePaneId: "pFront",
    imposition: {
      kind: "three-up",
      layout: "fit",
      sidebars: {
        cards: { side: "left" },
        jots: { side: "left" },
        layout: { side: "left" },
      },
      rails: { left: { order: [...MEMBERS] } },
    },
    hasFocus: true,
  };
}

// Every file's `seed` builds its own deck and waits on its own readiness;
// this one is the two at0677 files'.
export async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length === 3`,
    { timeoutMs: 15_000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  // The shell's frames standing is not the host's views shown: a reading of
  // the views at the press waits until the host shows every one it carries.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const shown = new Set((await app.bodies()).filter((b) => b.visible).map((b) => b.cardId));
    if ([...MEMBER_CARDS, CHAIN_FIRST].every((id) => shown.has(id))) break;
    if (Date.now() > deadline) throw new Error(`rail width seed: the host never showed every view (shown ${[...shown].join(", ")})`);
    await wait(50);
  }
  await wait(AFTER_LAND_MS);
}

/** Every left-rail member's rendered width, keyed by componentId. */
export function memberWidths(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(function () {
      var out = {};
      document.querySelectorAll('.tug-pane[data-rail-side="left"]').forEach(function (el) {
        out[el.getAttribute("data-rail-member")] = el.getBoundingClientRect().width;
      });
      return out;
    })()`,
  );
}

/** Every left-rail member's stored width, keyed by componentId — what the
 *  commit wrote, as the live store holds it. */
export function storedWidths(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(function () {
      var ids = ${JSON.stringify(PANE_OF)};
      var panes = window.tugdeck.diag.getDeckState().panes;
      var out = {};
      Object.keys(ids).forEach(function (member) {
        var pane = panes.filter(function (p) { return p.id === ids[member]; })[0];
        out[member] = pane === undefined ? -1 : pane.size.width;
      });
      return out;
    })()`,
  );
}

export function expectEveryMember(
  widths: Record<string, number>,
  expected: number,
  phase: string,
): void {
  for (const member of MEMBERS) {
    expect(
      Math.abs((widths[member] ?? 0) - expected),
      `${phase}: ${member} stands at ${expected}px (read ${widths[member]?.toFixed(1)})`,
    ).toBeLessThanOrEqual(PIXEL_TOL);
  }
}

/** The centre of the dragged member's deck-facing handle. */
export function grip(app: App): Promise<{ x: number; y: number }> {
  // The rail card draws its edge grip in its own page.
  return chromePoint(app, "J", ".tug-pane-resize-e");
}

/** The rail's members' cards and the chain's first card, whose views the host carries. */
export const MEMBER_CARDS = ["C", "J", "L"] as const;
export const CHAIN_FIRST = "A";

export type Frame = { x: number; y: number; width: number; height: number };

/** Each card's view as the host has it: placed, shown, and whether the hand holds it. */
export async function hostViews(app: App): Promise<Record<string, { frame: Frame; shown: Frame; inHand: boolean }>> {
  const out: Record<string, { frame: Frame; shown: Frame; inHand: boolean }> = {};
  for (const b of await app.bodies()) {
    if (b.visible && b.cardId !== null) out[b.cardId] = { frame: b.frame, shown: b.presentedFrame, inHand: b.inHand };
  }
  return out;
}

/**
 * The host carried the views and adopted the landing: every member's view
 * stands at `target` plus the apron each side, as placed and as shown, the
 * chain's first card's view stands on its stand-in's rest, and the hand
 * holds nothing.
 */
export async function expectHostLanded(app: App, target: number, phase: string): Promise<void> {
  const views = await hostViews(app);
  for (const cardId of MEMBER_CARDS) {
    for (const what of ["frame", "shown"] as const) {
      const rect = views[cardId]?.[what];
      expect(
        Math.abs((rect?.width ?? 0) - (target + 2 * CARD_APRON_PX)),
        `${phase}: ${cardId}'s view ${what} at the committed width (read ${rect?.width})`,
      ).toBeLessThanOrEqual(1);
    }
  }
  // card-dom: shell — the stand-in is where the commit put the card; the view must rest on it.
  const restX = await app.evalJS<number>(`document.querySelector('${frame("pFront")}').getBoundingClientRect().x`);
  for (const what of ["frame", "shown"] as const) {
    const x = views[CHAIN_FIRST]?.[what].x;
    expect(
      Math.abs((x ?? 0) - (restX - CARD_APRON_PX)),
      `${phase}: ${CHAIN_FIRST}'s view ${what} at its rest x ${restX - CARD_APRON_PX} (read ${x})`,
    ).toBeLessThanOrEqual(1);
  }
  expect(
    Object.entries(views).filter(([, v]) => v.inHand).map(([id]) => id),
    `${phase}: the hand holds nothing`,
  ).toEqual([]);
}

/** Every member's and the chain card's view stands, placed and shown, where it stood at the press, out of the hand. */
export async function expectHostAtPress(
  app: App,
  press: Record<string, { frame: Frame; shown: Frame; inHand: boolean }>,
  phase: string,
): Promise<void> {
  const views = await hostViews(app);
  for (const cardId of [...MEMBER_CARDS, CHAIN_FIRST]) {
    const was = press[cardId]?.frame;
    expect(was, `${cardId}'s view was read at the press`).toBeDefined();
    for (const what of ["frame", "shown"] as const) {
      const now = views[cardId]?.[what];
      const off = now === undefined ? Infinity : Math.max(Math.abs(now.x - was!.x), Math.abs(now.width - was!.width));
      expect(off, `${phase}: ${cardId}'s view ${what} back at its press frame (read ${JSON.stringify(now)}, was ${JSON.stringify(was)})`).toBeLessThanOrEqual(1);
    }
    expect(views[cardId]?.inHand, `${phase}: ${cardId} is out of the hand`).toBe(false);
  }
}

/** Mid-drag: the host has the dragged member in its hand, and every member's view still stands at its press frame — the hand moves only the ghost. */
export async function expectHostHoldingStill(
  app: App,
  press: Record<string, { frame: Frame; shown: Frame; inHand: boolean }>,
): Promise<void> {
  const views = await hostViews(app);
  expect(views.J?.inHand, "the host holds the dragged member").toBe(true);
  for (const cardId of MEMBER_CARDS) {
    const was = press[cardId]?.shown;
    const now = views[cardId]?.shown;
    const off = was === undefined || now === undefined ? Infinity : Math.max(Math.abs(now.x - was.x), Math.abs(now.width - was.width));
    expect(off, `mid-drag: ${cardId}'s view stands at its press frame (read ${JSON.stringify(now)}, was ${JSON.stringify(was)})`).toBeLessThanOrEqual(0.5);
  }
}

export function count(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

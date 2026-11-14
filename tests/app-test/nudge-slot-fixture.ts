/**
 * nudge-slot-fixture.ts — the deck, the chord and the readers the
 * at0452-nudge-slot-* files share.
 *
 * Split out of `at0452-nudge-slot.test.ts` when that file was cut, a test to a
 * file, into `at0452-nudge-slot-edges` and `at0452-nudge-slot-cards-cursor` so
 * each launch fits its own budget.
 *
 * ## What the files pin
 *
 * A nudge moves the selection sideways, or refuses to move any of it.
 *
 * ⌘1..9 name a slot; ⌥⇧⌘[ / ⌥⇧⌘] name a direction. That is the whole difference,
 * and it is the difference that makes the nudge the one slot verb able to run
 * off the end of the arrangement — which is where its interesting behavior
 * lives. A group nudged against the edge must not be clamped: clamping arrives
 * with every member stacked on the last slot, destroying the arrangement the
 * gesture exists to move. So the rule is all-or-nothing, and the refusal is
 * visible — the member that blocked it flashes its pane border, because a
 * refused gesture must produce the act or a reason and never silence.
 *
 * The two verbs resolve through the same ladder (`resolveLayoutSelection`), and
 * the files drive the nudge through three of its rungs so the two cannot
 * quietly disagree about what they are acting on: the first responder with no
 * selection, an explicit multi-card selection (both in `-edges`), and — the
 * rung the whole ladder was built for — the Cards list's cursor row while the
 * keyboard is in the Cards card, where the first responder is a rail and
 * reading it alone would refuse (`-cards-cursor`).
 *
 * The batch claim is held the way at0451 holds it, by the cut detector rather
 * than by geometry: both cards land in the right slots whether the mutator
 * committed once or twice, but a per-card commit re-arms the FLIP settle
 * mid-flight and the dropped frame reads as a jump. Zero cuts across a two-card
 * nudge is the assertion that the commit was single.
 *
 * The chord is deliberately unpromoted — no menu item — so it is JS-routed and
 * arrives in a background app-test like ⌘1..9 do, rather than needing the
 * foreground the way a menu key equivalent would.
 *
 * @module tests/app-test/nudge-slot-fixture
 */

import { type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const FRAMES = ".tug-pane[data-pane-id]";
export const RAIL_WIDTH = 675;
export const PANE_WIDTH = 420;
/** The settle window (`IMPOSITION_SETTLE_MS`) plus room for the tween to land. */
export const AFTER_LAND_MS = 900;

/**
 * ⌥⇧⌘[ / ⌥⇧⌘] — the nudge modifiers.
 *
 * Spelled as the chord rather than as the character the shift makes:
 * `nativeKey("}", ["cmd", "alt"])` posts the identical event, but `"]"` plus an
 * explicit shift is what `command-registry.ts` declares.
 *
 * That these arrive at all is half of what these files pin. ⌥⌘[/] one modifier
 * away are Window-menu key equivalents, and the natural way to check whether
 * AppKit claims the ⌥⇧⌘ press too — a page-level `keydown` listener — CANNOT
 * answer it: a chord the keymap matches is consumed with
 * `stopImmediatePropagation`, so "AppKit ate it" and "we handled it" read
 * identically. Pressing the chord and watching the slots move is the only
 * probe that separates them, which is what the assertions do.
 */
export const NUDGE = ["cmd", "alt", "shift"] as const;

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
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
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
    imposition: { kind: "three-up", sidebars: { layout: { side: "right" } } },
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

export async function setSelection(app: App, cardIds: string[]): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setLayoutSelection(${JSON.stringify(cardIds)}), null)`,
  );
}

/** The Cards row the movement cursor is standing on. */
export const CURSOR_ROW = ".cards-list .tug-list-view-cell[data-key-cursor]";

export async function cursorTitle(app: App): Promise<string> {
  return kindBody(app, "cards").evalJS<string>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(CURSOR_ROW)});
      return el === null ? "" : (el.textContent || "");
    })()`,
  );
}

/**
 * Park the cursor on the row whose text contains `title`.
 *
 * Home first, then down — never down from wherever the cursor happens to be:
 * the list's last row hands the arrow onward rather
 * than clamping, so a walk that starts below its target leaves the Cards list
 * and the cursor stops existing. Fails loudly rather than walking forever.
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

/** Put the keyboard in the Cards list and wait until its cursor is painted. */
export async function focusCardsList(app: App): Promise<void> {
  await app.dispatchControlAction("toggle-cards");
  await kindBody(app, "cards").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
    { timeoutMs: 8_000 },
  );
}

export async function seedRailPreferred(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
}

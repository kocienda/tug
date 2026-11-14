/**
 * _row-11.ts — what the pieces of row 11's lifecycle share: no body outlives
 * its card, and every body saves before it goes.
 *
 * The bar's eleventh row ([B02] row 11). Four gestures take a body card
 * away, and after each the host's snapshot holds no body for it:
 *
 * - **close** — File › Close on a body card holding a draft, so the shell's
 *   popover asks and Close is clicked; the shell's destruction notice sends
 *   `bodyDestroy` and the host removes the view. A rail asks too, and any
 *   other kind closes at once.
 * - **close all** — File › Close All Card Tabs on a pane holding a body
 *   card with a draft beside a text card; the shell asks, and both cards
 *   go, the body with them.
 * - **reload** — ⇧⌘R from inside a body; only the shell's page reloads.
 *   Every body stays bound to its card across it — the same page, never
 *   gone from the host's snapshot — and the reloaded shell re-adopts it,
 *   so the draft typed in the body before the reload is in it after; and
 *   each kept body still writes its card's state, so its bag is on tugbank
 *   disk.
 * - **quit** — the app's own termination path runs each body's
 *   `prepareForTermination` under the one deadline; the draft typed after
 *   the reload reaches disk, and the host's verdict line names the body's
 *   save as ok.
 *
 * The saves are read from the tugbank file the run was launched on, never
 * from the page that wrote them. And every bound body says which kind of
 * card it holds — at the start and after the reload — so a body the
 * reloaded shell re-adopts is bound to mount its card's kind, not a guess.
 *
 * Every other kind that is a body is closed, reloaded and quit the same
 * way; a rail holds no tabs, so Close All is the Session card's here. What
 * a rail kind types into its own field before the reload is in its field
 * after it, and its body's save is in the quit's verdict.
 *
 * A Text card holding unsaved edits is a body whose close guard the shell
 * cannot read in its own document. So two gestures that destroy it are read
 * against a dirty Text body: its pane's close puts the Save sheet up in the
 * body, and Cancel keeps the card; and a workspace delete confirmed in a
 * Cards body over the workspace holding it goes back to that workspace and
 * asks in the Text body, and Cancel keeps the workspace. Neither writes the
 * file.
 *
 * One launch per piece, a test to a file so each fits its own budget:
 * `row-11-lifecycle-session` for the Session cards, `row-11-lifecycle-kinds`
 * for every other kind, and `row-11-lifecycle-text-guard` for the dirty Text
 * body.
 */

import { expect } from "bun:test";

import { note, type App } from "../_harness";
import { tugbankRead } from "../_harness/tugbank-helpers";
import { closePopoverPage, closePopoverUp, composerText, focusBody, pollFor, settleFor, sessionPane } from "./_bodies";

export const TEST_NAME = "body-grounding-row-11-lifecycle";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 300_000;

export const A = "row11-a";
export const B = "row11-b";
export const T = "row11-text";
export const D = "row11-d";
const CARDSTATE = "dev.tugapp.deck.cardstate";
export const DRAFT_BEFORE_RELOAD = "row11 draft before reload";
export const DRAFT_BEFORE_QUIT = "row11 draft before quit";
export const SETTLE_MS = 8_000;
export const CARD_IDS = `window.tugdeck.diag.listCardIds()`;
export const X = "row11-x";
export const ORIGINAL = "alpha\nbeta\n";
export const TEXT_EDITOR = '[data-slot="tug-text-card-editor"] .cm-content';
export const SHEET_CANCEL = '[data-testid="file-save-sheet-cancel"]';
export const CONFIRM_OK = '[data-slot="tug-confirm-popover"] [data-slot="tug-confirm-confirm"]';
export const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
export const READY_GEN = `((typeof window.__tug !== "undefined" && typeof window.__tug.getReadyGen === "function") ? window.__tug.getReadyGen() : 0)`;

export function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
      { id: T, componentId: "text", title: "Text", closable: true },
      { id: D, componentId: "session", title: "D", closable: true },
    ],
    panes: [
      sessionPane(A, 0),
      {
        id: `${B}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [B, T],
        activeCardId: B,
        title: "",
        acceptsFamilies: ["standard"],
        slot: 1,
      },
      sessionPane(D, 2),
    ],
    activePaneId: `${A}-pane`,
    imposition: { kind: "three-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The cards the host holds a body for, spare excluded. */
export async function boundBodies(app: App): Promise<string[]> {
  return (await app.bodies()).map((b) => b.cardId).filter((id): id is string => id !== null).sort();
}

/** No body outlives its card: every bound body belongs to a card the shell lists. */
export async function expectBodiesMatchCards(app: App, label: string, expected: string[]): Promise<void> {
  const bound = await settleFor(() => boundBodies(app), (ids) => ids.join() === [...expected].sort().join(), SETTLE_MS);
  const cards = await app.evalJS<string[]>(CARD_IDS);
  note(`${label}: cards ${JSON.stringify(cards)}; bound bodies ${JSON.stringify(bound)}`);
  expect(bound, `${label}: the host holds a body for exactly the body cards left`).toEqual([...expected].sort());
  for (const id of bound) expect(cards, `${label}: ${id}'s body belongs to a card the shell lists`).toContain(id);
  // Each body holds its own card's kind: the shell's deck says which.
  const deckKinds = new Map(
    await app.evalJS<Array<[string, string]>>("window.tugdeck.diag.getDeckState().cards.map(function (c) { return [c.id, c.componentId]; })"),
  );
  for (const b of (await app.bodies()).filter((x) => x.cardId !== null)) {
    expect(b.componentId, `${label}: ${b.cardId}'s body holds its card's kind`).toBe(deckKinds.get(b.cardId!) ?? "a card the deck holds");
  }
}

/**
 * Perform a File-menu close and see it through to `want` cards. `asks` is
 * the close's one right outcome: a Session card holding a draft does not
 * waive the confirmation, a rail always asks (`tug-pane.tsx`'s
 * `paneConfirmClose`), and so does a pane of several tabs, so the shell's
 * popover rises and its confirm button is clicked; any other card closes at
 * once. The popover stands in `cardId`'s own page, where its pane's chrome
 * is drawn, and is read and pressed there.
 */
export async function closeThrough(app: App, cardId: string, identifier: string, want: number, label: string, asks: boolean): Promise<void> {
  const item = await app.performMenuItem(identifier);
  note(`${label}: ${identifier} ${JSON.stringify(item)}`);
  expect(item.found && item.performed, `${label}: ${identifier} performs`).toBe(true);
  const seen = await settleFor(
    async () => ({ popover: await closePopoverUp(app, cardId), cards: await app.evalJS<number>(`${CARD_IDS}.length`) }),
    (r) => r.popover || r.cards <= want,
    SETTLE_MS,
  );
  note(`${label}: popover ${seen.popover}, cards ${seen.cards}`);
  expect(seen.popover, asks ? `${label}: the close raises its Close popover` : `${label}: the close lands without asking`).toBe(asks);
  if (asks) {
    const page = await closePopoverPage(app, cardId);
    expect(page !== null && (await page.evalJS<boolean>(present(CONFIRM_OK))), `${label}: the popover has a confirm button`).toBe(true);
    await page!.nativeClickAtElement(CONFIRM_OK);
    await pollFor(() => closePopoverUp(app, cardId), (v) => !v, SETTLE_MS);
  }
  const cards = await settleFor(() => app.evalJS<number>(`${CARD_IDS}.length`), (n) => n <= want, SETTLE_MS);
  expect(cards, `${label}: the cards closed`).toBe(want);
}

/** Type `text` into `cardId`'s composer and see it there. */
export async function typeDraft(app: App, cardId: string, text: string): Promise<void> {
  await focusBody(app, cardId, { composer: true });
  await app.nativeType(text);
  const seen = await settleFor(() => app.body(cardId).evalJS<string | null>(composerText), (t) => t?.includes(text) === true, SETTLE_MS);
  expect(seen, `${cardId}'s composer holds the draft`).toContain(text);
}

/** The card's bag on tugbank disk, as one string to search. */
export function bagOnDisk(tugbankPath: string, cardId: string): string | null {
  const onDisk = tugbankRead<unknown>(tugbankPath, CARDSTATE, cardId);
  return onDisk === null ? null : JSON.stringify(onDisk.value);
}

/**
 * _row-06.ts — what the pieces of row 6 share: the decks, the sweep of a
 * menu's items with a body first responder, and the launches.
 *
 * Row 6 ([B02] row 6) holds that every Swift menu command works with a body
 * first responder. Its sweep performs every enabled item the way a menu
 * performs it — `performMenuItem` finds the real `NSMenuItem`, runs AppKit's
 * validation, and sends its action through `NSApp.sendAction` — and after
 * each one gives the card the keyboard back and asks whether its body took
 * it. One launch sweeping all five menus ran a minute and more, so each piece
 * sweeps one part of them (`row-06-menus-<part>-session`,
 * `row-06-menus-<part>-kinds`; the parts are `PARTS`, which between them take
 * every item), and the items whose effect the body can show are their own
 * pieces (`row-06-menus-session-shows`, `row-06-menus-kinds-shows`).
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { MenuItemSnapshot } from "../_harness/types";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { SETTLE_MS, bodyOf, escapeHasTaker, focusBody, foldedOf, pollFor, popoverPresent, responders, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { kindsUnderTest, sessionUnderTest, type CardKind } from "./_kinds";

export const TEST_NAME = "body-grounding-row-06-menus";
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const A = "row06-a";
export const B = "row06-b";

/** The parts the row's sweep is cut into, each one launch inside the budget. */
export type Part = "file-window" | "edit-clipboard" | "edit-text" | "view" | "view-themes" | "view-sidebars-1" | "view-sidebars-2" | "go";

const CLIPBOARD = /^edit\.(cut|copy|copyAsPlainText|paste|pasteAsPlainText|pasteAsQuote|delete|selectAll)$/;
const SIDEBARS_1 = /^view\.sidebar\.(dashes|jots|layout)\./;
const THEMES = /^view\.(theme\.|nextTheme$|applyThemeToAllWorkspaces$)/;

/**
 * Which items of the File, Edit, View, Go and Window menus each part takes,
 * by identifier. Every such item falls in exactly one part: each menu's
 * last part takes whatever the ones before it leave, so an item added to a
 * menu is swept without a change here.
 */
const PARTS: Readonly<Record<Part, (id: string) => boolean>> = {
  "file-window": (id) => /^(file|window)\./.test(id),
  "edit-clipboard": (id) => CLIPBOARD.test(id),
  "edit-text": (id) => id.startsWith("edit.") && !CLIPBOARD.test(id),
  view: (id) => id.startsWith("view.") && !id.startsWith("view.sidebar.") && !THEMES.test(id),
  "view-themes": (id) => THEMES.test(id),
  "view-sidebars-1": (id) => SIDEBARS_1.test(id),
  "view-sidebars-2": (id) => id.startsWith("view.sidebar.") && !SIDEBARS_1.test(id),
  go: (id) => id.startsWith("go."),
};

/**
 * Items read for validation but not performed: their action leaves the
 * app's own window, changes the workspace set, or closes the fixture.
 */
const NOT_PERFORMED =
  /^(file\.(openFile|openQuickly|openRecent|save|saveAs|saveACopy|exportTranscript|revertToSaved|reloadFromDisk|closeAllCardTabs|closeCard|newSessionCard|newTextCard|newJot)|view\.(enterFullScreen|keyboardFocus|nextKeyboardFocus|previousKeyboardFocus)|window\.(minimize|zoom|bringAllToFront|deleteWorkspace|newWorkspace|duplicateWorkspace|renameWorkspace|space\.|pane\.))/;

/** Two Session cards side by side in a four-up flow, A in front. */
function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
    ],
    panes: [sessionPane(A, 0), sessionPane(B, 1)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/** Every identified, non-separator, shown item `part` takes, anywhere in the menu tree. */
function itemsOf(snapshot: readonly MenuItemSnapshot[], part: Part): Array<{ id: string; title: string; enabled: boolean }> {
  const out: Array<{ id: string; title: string; enabled: boolean }> = [];
  const walk = (items: readonly MenuItemSnapshot[]): void => {
    for (const item of items) {
      if (item.separator || item.hidden) continue;
      if (item.submenu !== undefined) {
        walk(item.submenu);
        continue;
      }
      if (item.identifier === undefined || !PARTS[part](item.identifier)) continue;
      out.push({ id: item.identifier, title: item.title, enabled: item.enabled });
    }
  };
  walk(snapshot);
  return out;
}

/** What the shell and the host say about the keyboard, read only when the card's body did not take it back. */
async function keyboardFacts(app: App, card: string): Promise<string> {
  return (
    `shell focused card ${await app.getFocusedCardId()}, shell responder ${await app.evalJS<string>("String(window.__tug.getFirstResponderId())")}, ` +
    `shell active element ${await app.evalJS<string>(`document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "none"`)}, ` +
    `the card's pane ${await app.evalJS<string>(`JSON.stringify((function(){ var p = document.querySelector(${JSON.stringify(`.tug-pane[data-pane-id="${card}-pane"]`)}); if (!p) return null; var o = {}; for (var i = 0; i < p.attributes.length; i++) o[p.attributes[i].name] = p.attributes[i].value; return o; })())`)}, ` +
    `deck panes ${await app.evalJS<string>(`JSON.stringify((window.tugdeck.diag.getDeckState().panes || []).map(function (p) { return { id: p.id, slot: p.slot, cards: p.cardIds }; }))`)}, host ${await responders(app)}`
  );
}

/**
 * Dismiss whatever an item raised, if it raised anything, and give `card` the
 * keyboard again.
 * Returns whether its body took it back, with what the shell and the host
 * said when it did not.
 */
async function settleAfter(app: App, card: string): Promise<{ handedBack: boolean; facts: string }> {
  if (await escapeHasTaker(app)) {
    await app.nativeKey("Escape");
    await Bun.sleep(150);
    if (await app.evalJS<boolean>(popoverPresent)) await app.nativeKey("Escape");
  }
  // A surface the item raised or revealed may be settling onto the deck.
  await Bun.sleep(600);
  // An item that folded the card leaves its body hidden, and a hidden view holds
  // no keyboard: unfold it before asking. The shows pieces read the fold itself.
  if (await foldedOf(app, card)) {
    await app.performMenuItem("view.foldCard");
    await pollFor(() => foldedOf(app, card), (v) => !v, SETTLE_MS);
    await Bun.sleep(600);
  }
  await app.dispatchControlAction("focus-session-card", { cardId: card });
  const holder = await pollFor(() => bodyOf(app, card), (x) => x?.firstResponder === true, SETTLE_MS);
  if (holder?.firstResponder === true) return { handedBack: true, facts: "" };
  const facts = await keyboardFacts(app, card);
  // Put the keyboard back the way a click on the card would, so the sweep goes on.
  // The card's title bar is in its own page; the shell holds only its stand-in.
  const pane = `.tug-pane[data-pane-id="${card}-pane"]`;
  // card-dom: shell — whether the pane still stands.
  const stands = await app.evalJS<boolean>(`document.querySelector(${JSON.stringify(pane)}) !== null`);
  if (!stands) {
    return { handedBack: false, facts: `the card's pane is gone: ${facts}` };
  }
  await app.body(card).nativeClickAtElement('[data-testid="tug-pane-title-bar"]');
  await pollFor(() => bodyOf(app, card), (x) => x?.firstResponder === true, SETTLE_MS);
  return { handedBack: false, facts };
}

/**
 * Every item `part` takes, validated and, where it is this row's to, performed
 * with `card`'s body holding the keyboard. `ownItems` names the items that
 * close or re-seat the card under test itself — a rail's own View › Sidebar
 * rows — which are read for validation and not performed.
 */
export async function sweepMenu(app: App, card: string, part: Part, ownItems: RegExp | null = null): Promise<void> {
  const items = itemsOf(await app.menuSnapshot(), part);
  expect(items.length, `the menus carry items for ${part}`).toBeGreaterThan(0);
  const results: Array<{ id: string; enabled: boolean; performed: boolean | null; skipped: boolean; handedBack: boolean; facts: string }> = [];
  for (const item of items) {
    const state = await app.menuItemState(item.id);
    expect(state.found, `${item.title} (${item.id}) is a real item`).toBe(true);
    if (!state.found) continue;
    const notPerformed = NOT_PERFORMED.test(item.id) || (ownItems?.test(item.id) ?? false);
    if (!state.enabled || notPerformed) {
      results.push({ id: item.id, enabled: state.enabled, performed: null, skipped: notPerformed, handedBack: true, facts: "" });
      continue;
    }
    const done = await app.performMenuItem(item.id);
    const settled = await settleAfter(app, card);
    results.push({ id: item.id, enabled: state.enabled, performed: done.found ? done.performed : false, skipped: false, ...settled });
  }
  const performed = results.filter((r) => r.performed === true);
  const refused = results.filter((r) => r.performed === false);
  const kept = results.filter((r) => !r.handedBack);
  const dark = results.filter((r) => !r.enabled);
  const skipped = results.filter((r) => r.skipped && r.enabled);
  note(
    `${part}: ${items.length} items: ${performed.length} performed, ${dark.length} dark, ${skipped.length} enabled but not performed by this row ` +
      `(${skipped.map((r) => r.id).join(", ")}); dark: ${dark.map((r) => r.id).join(", ")}`,
  );
  if (refused.length > 0) note(`items AppKit validated enabled but whose action no responder took: ${refused.map((r) => r.id).join(", ")}`);
  if (kept.length > 0) note(`items after which the card's body did not get the keyboard back:\n${kept.map((r) => `${r.id}: ${r.facts}`).join("\n")}`);
  expect(refused.map((r) => r.id), "every enabled item's action is taken by a responder").toEqual([]);
  expect(kept.map((r) => r.id), "after every item the keyboard returns to the card's body").toEqual([]);
  expect((await bodyOf(app, card))?.visible, "the card's body stands after the sweep").toBe(true);
}

/**
 * Launch with two bound Session bodies, A and B, A holding the keyboard,
 * and run `body`. Both cards are empty: a stub plays only when prompted.
 */
export async function withSessions(name: string, body: (app: App) => Promise<void>): Promise<void> {
  const stubDir = stubDirectory();
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}`, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
  try {
    await app.seedDeckState({ state: deck(), focusCardId: A });
    await spawnStub(app, A, stubDir, 6);
    await spawnStub(app, B, stubDir, 2);
    await waitForBody(app, A);
    await waitForBody(app, B);
    await focusBody(app, A);
    note(`A focused: ${await responders(app)}`);
    await body(app);
  } finally {
    await app.close();
  }
}

/**
 * Launch with a body of `kind` holding the keyboard beside an unbound
 * Session card, and run `body` with the card's id.
 */
export async function withKind(kind: CardKind, name: string, body: (app: App, card: string) => Promise<void>): Promise<void> {
  const card = `row06-${kind.componentId}`;
  const app = await launchTugApp({ testName: `${TEST_NAME}-${name}-${kind.componentId}` });
  try {
    await app.seedDeckState({ state: kindDeck(kind, card, { sessions: [B] }), focusCardId: card });
    await standUpKind(app, kind, card);
    await app.dispatchControlAction("focus-session-card", { cardId: card });
    const holds = await pollFor(() => bodyOf(app, card), (x) => x?.firstResponder === true, SETTLE_MS);
    expect(holds?.firstResponder, `the ${kind.componentId} card's body holds the keyboard`).toBe(true);
    await body(app, card);
  } finally {
    await app.close();
  }
}

/** A rail's own View › Sidebar rows close or re-seat the card under test; a content kind has none. */
export const ownItemsOf = (kind: CardKind): RegExp | null => (kind.rail ? new RegExp(`^view\\.sidebar\\.${kind.componentId}\\.`) : null);

/** Register the Session card's sweep of `part`, which `what` names in prose. */
export function describeSessionSweep(part: Part, what: string): void {
  describe.skipIf(!SHOULD_RUN)(`body-grounding row 6: ${what}`, () => {
    test.skipIf(!sessionUnderTest(6))(
      `every item of ${what} performs with a Session body first responder`,
      () => withSessions(part, (app) => sweepMenu(app, A, part)),
      TEST_TIMEOUT_MS,
    );
  });
}

/** Register the sweep of `part` for every kind under test but the Session card. */
export function describeKindsSweep(part: Part, what: string): void {
  describe.skipIf(!SHOULD_RUN)(`body-grounding row 6: ${what}, every other kind`, () => {
    for (const kind of kindsUnderTest(6)) {
      if (kind.componentId === "session") continue;
      test(
        `${kind.componentId}: every item of ${what} performs with its body first responder`,
        () =>
          withKind(kind, part, async (app, card) => {
            await sweepMenu(app, card, part, ownItemsOf(kind));
          }),
        TEST_TIMEOUT_MS,
      );
    }
  });
}

/**
 * arc-row-menu-fixture.ts — driving an arc row's verb menu from an app-test.
 *
 * Bind, Unbind and Discard used to be buttons standing on the row, which made
 * them one `querySelector` away. They are menu items now ([P08]), and a menu
 * item exists only while its menu is open — so a test that asks "does this row
 * offer Discard?" has to open the menu to find out, and close it again so the
 * next assertion is not made through a modal layer.
 *
 * Four files were reading those buttons directly. One shared way to drive the
 * menu rather than four, because the interesting failures here are all timing
 * — a portal that has not mounted, a coordinate read between recomposes — and
 * four copies of a retry is three chances for one of them to be subtly wrong.
 *
 * The two surfaces open it differently, which {@link openArcRowMenu} hides:
 * the Changes shade's lane has a `⋯` opener, the Arcs card's rows have none
 * (their eyebrow is the identities alone) and answer a right-click on the row.
 * Same menu, same items, one way to drive it.
 *
 * The menu portals to `document.body`, so its items are queried globally
 * rather than under the row. That is not a leak in the selector: only one row
 * menu is ever open, because opening one dismisses the rest.
 */

import { expect } from "bun:test";

import type { App } from "./_harness";

/** One of the verbs the row menu can dispatch. */
export type ArcRowMenuAction =
  | "bind-arc"
  | "unbind-arc"
  | "request-discard-arc"
  | "request-replay-arc";

/**
 * The `⋯` opener on a row, for the surface that has one. `row` is the row's
 * own selector; the Arcs card's rows match nothing here and are right-clicked.
 */
export const arcRowMenuOpener = (row: string): string =>
  `${row} [data-slot="session-changes-arc-row-menu-open"]`;

/** The open menu itself, wherever the portal put it. */
export const ARC_ROW_MENU = '[data-slot="tug-editor-context-menu"]';

/**
 * One item in the open menu, by the action it dispatches.
 *
 * Keyed on the action rather than the label: the label carries the verb's
 * refusal when it has one ("Discard — a turn is running"), so matching on text
 * would make every disabled-state assertion a string comparison against prose
 * that is free to change.
 */
export const arcRowMenuItem = (
  action: ArcRowMenuAction,
): string => `${ARC_ROW_MENU} [data-item-action="${action}"]`;

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/**
 * Open a row's menu, retrying a missed press.
 *
 * The retry is the same one the lane's other affordances need: the shade's
 * last block sits over an aggregate that recomposes on its own schedule, so a
 * coordinate read can go stale between aiming and clicking. A missed click
 * opens nothing, which is what makes the retry a retry rather than a
 * double-open.
 *
 * A row with no opener is opened by its own right-click — the Arcs card's grammar.
 */
export async function openArcRowMenu(
  app: App,
  row: string,
  attempts = 5,
): Promise<void> {
  const opener = arcRowMenuOpener(row);
  for (let i = 0; i < attempts; i += 1) {
    const target = (await app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(opener)}) !== null`,
    ))
      ? opener
      : row;
    await app.evalJS<null>(
      `(() => {
         const el = document.querySelector(${JSON.stringify(target)});
         if (el !== null) el.scrollIntoView({ block: "center" });
         return null;
       })()`,
    );
    await settle(250);
    if (target === opener) await app.nativeClickAtElement(opener);
    else await app.nativeRightClickAtElement(row);
    try {
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(ARC_ROW_MENU)}) !== null`,
        { timeoutMs: 3000 },
      );
      return;
    } catch {
      // Fall through and aim again.
    }
  }
  throw new Error(`arc-row-menu: the menu never opened for ${row}`);
}

/**
 * Dismiss the open menu, so the next assertion is not read through it.
 *
 * A synthetic outside press rather than ⎋. The menu closes on either, but ⎋ is
 * a chord the whole card answers — the Changes shade takes it as "dismiss me" —
 * so a test that closed its menu that way would also close the surface it was
 * about to make its next assertion against. The press is dispatched at the
 * document body, which is exactly what the menu's own capture-phase
 * outside-press listener is watching for.
 */
export async function closeArcRowMenu(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function(){
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ARC_ROW_MENU)}) === null`,
    { timeoutMs: 5000 },
  );
}

/** What one item in the open menu is: present, and blocked or not. */
export interface ArcRowMenuVerbState {
  present: boolean;
  disabled: boolean;
  label: string;
}

/** Every verb the row is currently offering, read from one opening. */
export interface ArcRowMenuState {
  bind: ArcRowMenuVerbState;
  unbind: ArcRowMenuVerbState;
  discard: ArcRowMenuVerbState;
  replay: ArcRowMenuVerbState;
}

/**
 * Open the row's menu, read every verb, and close it again.
 *
 * One opening for all of them: the state of the menu is a fact about one
 * moment, and reading the verbs across separate openings would let the
 * aggregate recompose between them — which is precisely how a test comes to assert a
 * bind and a discard that were never on screen together.
 */
export async function readArcRowMenu(app: App, row: string): Promise<ArcRowMenuState> {
  await openArcRowMenu(app, row);
  const state = await app.evalJS<ArcRowMenuState>(
    `(() => {
       const read = (sel) => {
         const el = document.querySelector(sel);
         return {
           present: el !== null,
           disabled: el !== null && el.hasAttribute("data-disabled"),
           label: el === null ? "" : (el.textContent || ""),
         };
       };
       return {
         bind: read(${JSON.stringify(arcRowMenuItem("bind-arc"))}),
         unbind: read(${JSON.stringify(arcRowMenuItem("unbind-arc"))}),
         discard: read(${JSON.stringify(arcRowMenuItem("request-discard-arc"))}),
         replay: read(${JSON.stringify(arcRowMenuItem("request-replay-arc"))}),
       };
     })()`,
  );
  await closeArcRowMenu(app);
  return state;
}

/**
 * Open the row's menu and press one of its verbs.
 *
 * The press closes the menu itself — every item activation dismisses — so
 * there is no close here to pair with the open.
 */
export async function pressArcRowMenuItem(
  app: App,
  row: string,
  action: ArcRowMenuAction,
): Promise<void> {
  await openArcRowMenu(app, row);
  const item = arcRowMenuItem(action);
  expect(
    await app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(item)}) !== null`,
    ),
    `arc-row-menu: ${action} is not on this row's menu`,
  ).toBe(true);
  await app.nativeClickAtElement(item);
}

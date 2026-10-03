/**
 * arc-row-menu-fixture.ts — driving an arc row's housekeeping verbs from an
 * app-test.
 *
 * Bind, Unbind, Replay and Discard stand on every arc row's verb row, and the
 * Arcs card's rows answer a right-click with the same verbs as a menu — a
 * second door. This fixture reads and presses them through one API whichever
 * surface a test is on:
 *
 * - **A Changes shade's lane row** has no menu; its verbs are the row's own
 *   `arc-verb` buttons, read in place.
 * - **An Arcs card row** is driven through its right-click menu. A menu item
 *   exists only while its menu is open, so a reading opens it, reads, and
 *   closes it again so the next assertion is not made through a modal layer.
 *
 * One shared way to drive them rather than one per file, because the
 * interesting failures here are all timing — a portal that has not mounted, a
 * coordinate read between recomposes — and copies of a retry are chances for
 * one of them to be subtly wrong.
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
 * The menu verb each action names, as the verb row's `data-verb` spells it.
 */
const VERB_FOR: Record<ArcRowMenuAction, string> = {
  "bind-arc": "bind",
  "unbind-arc": "unbind",
  "request-discard-arc": "discard",
  "request-replay-arc": "replay",
};

/** One verb button on a row's verb row. */
export const arcRowVerb = (row: string, action: ArcRowMenuAction): string =>
  `${row} [data-slot="arc-verb"][data-verb="${VERB_FOR[action]}"]`;

/** Whether `row` is a Changes shade lane row — verbs in place, no menu. */
async function isLaneRow(app: App, row: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(row)})?.matches('[data-slot="session-changes-arc-row"]') === true`,
  );
}

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
 * Open an Arcs card row's menu with a right-click, retrying a missed press.
 *
 * The list recomposes on its own schedule, so a coordinate read can go stale
 * between aiming and clicking. A missed click opens nothing, which is what
 * makes the retry a retry rather than a double-open.
 */
export async function openArcRowMenu(
  app: App,
  row: string,
  attempts = 5,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await app.evalJS<null>(
      `(() => {
         const el = document.querySelector(${JSON.stringify(row)});
         if (el !== null) el.scrollIntoView({ block: "center" });
         return null;
       })()`,
    );
    await settle(250);
    await app.nativeRightClickAtElement(row);
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

/**
 * What one verb is: present, and refused or not. `label` is the bare word for
 * an available verb and carries the refusal when there is one ([L31]).
 */
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
 * Read every housekeeping verb the row offers, from one moment.
 *
 * One reading for all of them: reading the verbs across separate moments
 * would let the aggregate recompose between them — which is precisely how a
 * test comes to assert a bind and a discard that were never on screen
 * together. A lane row is read in place; an Arcs card row's menu is opened
 * once, read, and closed.
 */
export async function readArcRowMenu(app: App, row: string): Promise<ArcRowMenuState> {
  if (await isLaneRow(app, row)) {
    return app.evalJS<ArcRowMenuState>(
      `(() => {
         const read = (sel) => {
           const el = document.querySelector(sel);
           const refused = el !== null && el.getAttribute("data-refused") === "true";
           return {
             present: el !== null,
             disabled: refused,
             label:
               el === null
                 ? ""
                 : refused
                   ? (el.getAttribute("aria-label") || "")
                   : (el.textContent || ""),
           };
         };
         return {
           bind: read(${JSON.stringify(arcRowVerb(row, "bind-arc"))}),
           unbind: read(${JSON.stringify(arcRowVerb(row, "unbind-arc"))}),
           discard: read(${JSON.stringify(arcRowVerb(row, "request-discard-arc"))}),
           replay: read(${JSON.stringify(arcRowVerb(row, "request-replay-arc"))}),
         };
       })()`,
    );
  }
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
 * Press one of a row's housekeeping verbs.
 *
 * A lane row's verb is pressed in place. On an Arcs card row the menu is
 * opened first, and the press closes it — every item activation dismisses —
 * so there is no close here to pair with the open.
 */
export async function pressArcRowMenuItem(
  app: App,
  row: string,
  action: ArcRowMenuAction,
): Promise<void> {
  if (await isLaneRow(app, row)) {
    const verb = arcRowVerb(row, action);
    expect(
      await app.evalJS<boolean>(
        `(() => {
           const el = document.querySelector(${JSON.stringify(verb)});
           if (el === null) return false;
           el.scrollIntoView({ block: "center" });
           return true;
         })()`,
      ),
      `arc-row-menu: ${action} is not on this row`,
    ).toBe(true);
    await settle(250);
    await app.nativeClickAtElement(verb);
    return;
  }
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

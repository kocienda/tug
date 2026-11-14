/**
 * window-sidebar-rows-fixture.ts — the identifiers, launch and menu readers
 * the at0511-window-sidebar-* files read View ▸ ⟨Card⟩ with: the row says
 * where a sidebar card stands, and its submenu moves it.
 *
 * The row is the only menu route to a sidebar card, and it is a three-rung
 * ladder shown as three marks rather than a checkbox's two. What makes that
 * readable end to end is a chain of four facts that could each be right on
 * their own and still disagree: the deck's `sidebars` projection, the
 * registry entry's `state` and `dynamicTitle` predicates, the gate's widened
 * wire, and the Swift decode that turns the wire's `"mixed"` into an AppKit
 * `.mixed`. Only the built menu reads all four at once.
 *
 * Scenarios, one file each:
 *   1. **marks** — Hidden → showing → showing-and-focused → hidden, read off
 *      the live menu each time: the empty mark, the plain check, the mixed
 *      mark, the empty mark again. The parent row carries the same mark as
 *      the toggle inside it, which is its own assertion — AppKit never
 *      validates a submenu's parent, so the mark can only be there because
 *      `refreshSidebarParentMarks` put it there.
 *   2. **sides** — The side pair is dark while the card is hidden and live
 *      once it shows, with the standing side checked; moving the side moves
 *      the check.
 *   3. **chord** — The same three rungs driven by the CHORD (⌃⌘J) instead of
 *      the frame. The chord is `menuEligible`, so AppKit resolves it against
 *      the key equivalent the sweep wrote onto the toggle — an item two
 *      levels into a submenu — and fires that item's action. The leg proves
 *      the chord reaches the same three-rung ladder its row shows rather
 *      than a toggle of its own ([D172]); the middle rung is the one a plain
 *      open/close chord could not produce at all.
 *   4. **resize-row** — Resize Sidebars to Fit stands above the card rows,
 *      carrying ⌥⇧⌘S.
 *   5. **hide-row** — Hide Sidebars stands above the resize row, carrying
 *      ⌃⌘S, and names the press.
 *
 * The card is driven through the frames its own rows send — `toggle-jots`
 * for the toggle, `set-sidebar-side` for the pair — rather than by clicking
 * the items, which the harness cannot do. The menu is still what is read, so
 * everything downstream of the dispatch is under test.
 *
 * Each at0511-window-sidebar file launches its own app on its own tugbank.
 *
 * @module tests/app-test/window-sidebar-rows-fixture
 */

import { expect } from "bun:test";

import { type App } from "./_harness";
import type { MenuItemSnapshot, MenuItemState } from "./_harness/types";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 60_000;

/** The Jots card's rows. One card is enough: the five are one generated group. */
export const PARENT = "view.sidebar.jots";
export const TOGGLE = "view.sidebar.jots.show";
export const LEFT = "view.sidebar.jots.left";
export const RIGHT = "view.sidebar.jots.right";
/** The one verb that resizes the rails, above the five card rows ([B11]). */
export const RESIZE = "view.resizeSidebarsToFit";
/** The one verb that takes both rails away, directly above the resize row. */
export const TOGGLE_SIDEBARS = "view.toggleSidebars";

/** `NSEvent.ModifierFlags` as the snapshot reports them. */
export const SHIFT = 1 << 17;
export const CONTROL = 1 << 18;
export const OPTION = 1 << 19;
export const COMMAND = 1 << 20;

/**
 * `NSControl.StateValue` as the harness reports it. `.mixed` is -1, which is
 * the whole reason this family exists — a boolean wire could not carry it.
 */
export const OFF = 0;
export const ON = 1;
export const MIXED = -1;

/**
 * Poll until the item's mark matches, then return what it settled on.
 *
 * The push that carries a gate is coalesced onto a microtask and crosses to
 * the host asynchronously, so a read taken the instant a dispatch returns can
 * legitimately see the mark before last. Polling is the same accommodation
 * at0172 makes for the Session menu's live rows.
 */
export async function waitMenuMark(
  app: App,
  identifier: string,
  wantState: number,
  timeoutMs = 8000,
): Promise<{ found: boolean; state?: number; title?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; state?: number; title?: string } = {
    found: false,
  };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.state === wantState) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** Assert the toggle's mark and title, and that its parent wears the same mark. */
export async function expectRung(
  app: App,
  wantState: number,
  wantTitle: string,
): Promise<void> {
  const toggle = await waitMenuMark(app, TOGGLE, wantState);
  expect(toggle.found, `${TOGGLE} must exist`).toBe(true);
  expect(toggle.state, `${TOGGLE} mark`).toBe(wantState);
  expect(toggle.title, `${TOGGLE} title`).toBe(wantTitle);

  const parent = await waitMenuMark(app, PARENT, wantState);
  expect(parent.found, `${PARENT} must exist`).toBe(true);
  expect(parent.state, `${PARENT} carries the toggle's mark`).toBe(wantState);
}

/**
 * The item's snapshot, asserting it exists first. Reading a field off the raw
 * result does not type-check: `menuItemState` returns a discriminated union,
 * and a missing item carries no fields at all.
 */
export async function menuItem(
  app: App,
  identifier: string,
): Promise<{ enabled: boolean; state: number; title: string }> {
  const item = await app.menuItemState(identifier);
  expect(item.found, `${identifier} present in the menu`).toBe(true);
  if (!item.found) throw new Error(`${identifier} is not in the menu`);
  return { enabled: item.enabled, state: item.state, title: item.title };
}

/**
 * Poll until the item carries `keyEquivalent`, then return its snapshot. The
 * chord sweep crosses from the frontend after the menu is built, so a read
 * taken the instant the deck comes up can legitimately see the empty key
 * equivalent the item was constructed with.
 */
export async function waitMenuChord(
  app: App,
  identifier: string,
  keyEquivalent: string,
  timeoutMs = 8_000,
): Promise<MenuItemState> {
  const deadline = Date.now() + timeoutMs;
  let last = await app.menuItemState(identifier);
  while (Date.now() < deadline) {
    if (last.found && last.keyEquivalent === keyEquivalent) return last;
    await new Promise((r) => setTimeout(r, 100));
    last = await app.menuItemState(identifier);
  }
  return last;
}

/**
 * Poll until the item's title matches, then return what it settled on. The
 * title a gate rewrites arrives by the same coalesced push a mark does, so
 * this is {@link waitMenuMark}'s accommodation over the other field.
 */
export async function waitMenuTitle(
  app: App,
  identifier: string,
  wantTitle: string,
  timeoutMs = 8_000,
): Promise<{ found: boolean; title?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; title?: string } = await app.menuItemState(
    identifier,
  );
  while (Date.now() < deadline) {
    if (last.found && last.title === wantTitle) return last;
    await new Promise((r) => setTimeout(r, 100));
    last = await app.menuItemState(identifier);
  }
  return last;
}

/**
 * Where `identifier` stands in the View menu, top to bottom — the fact an
 * item's own state cannot answer, and the only way to say that one row is
 * above another.
 */
export async function viewRowOrder(app: App): Promise<(string | undefined)[]> {
  // Found by looking for the row list the Jots parent is in rather than by
  // the menu's title: the snapshot's top level is the menu BAR, whose items
  // carry the submenus, and which of the two levels holds the title is not
  // the thing under test here.
  const tree = await app.menuSnapshot();
  let rows: MenuItemSnapshot[] | undefined;
  const walk = (items: readonly MenuItemSnapshot[]): void => {
    if (items.some((item) => item.identifier === PARENT)) rows = [...items];
    for (const item of items) if (item.submenu) walk(item.submenu);
  };
  walk(tree);
  expect(rows, "the View menu's rows are in the snapshot").toBeDefined();
  return (rows ?? []).map((item) => item.identifier);
}

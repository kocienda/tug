/**
 * at0511-window-sidebar-rows.test.ts — Window ▸ ⟨Card⟩ says where a sidebar
 * card stands, and its submenu moves it.
 *
 * The row is the only menu route to a sidebar card, and it is a three-rung
 * ladder shown as three marks rather than a checkbox's two. What makes that
 * readable end to end is a chain of four facts that could each be right on
 * their own and still disagree: the deck's `sidebars` projection, the
 * registry entry's `state` and `dynamicTitle` predicates, the gate's widened
 * wire, and the Swift decode that turns the wire's `"mixed"` into an AppKit
 * `.mixed`. Only the built menu reads all four at once.
 *
 * Scenarios:
 *   1. Hidden → showing → showing-and-focused → hidden, read off the live
 *      menu each time: the empty mark, the plain check, the mixed mark, the
 *      empty mark again. The parent row carries the same mark as the toggle
 *      inside it, which is its own assertion — AppKit never validates a
 *      submenu's parent, so the mark can only be there because
 *      `refreshSidebarParentMarks` put it there.
 *   2. The side pair is dark while the card is hidden and live once it
 *      shows, with the standing side checked; moving the side moves the
 *      check.
 *
 * The card is driven through the frames its own rows send — `toggle-jots`
 * for the toggle, `set-sidebar-side` for the pair — rather than by clicking
 * the items, which the harness cannot do. The menu is still what is read, so
 * everything downstream of the dispatch is under test.
 *
 *   3. The same three rungs driven by the CHORD (⌃⌘J) instead of the frame.
 *      The chord is `menuEligible`, so AppKit resolves it against the key
 *      equivalent the sweep wrote onto the toggle — an item two levels into a
 *      submenu — and fires that item's action. The leg proves the chord
 *      reaches the same three-rung ladder its row shows rather than a toggle
 *      of its own ([D172]); the middle rung is the one a plain open/close
 *      chord could not produce at all.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/sidebar-toggle.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import type { MenuItemSnapshot, MenuItemState } from "./_harness/types";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

/** The Jots card's rows. One card is enough: the five are one generated group. */
const PARENT = "window.sidebar.jots";
const TOGGLE = "window.sidebar.jots.show";
const LEFT = "window.sidebar.jots.left";
const RIGHT = "window.sidebar.jots.right";
/** The one verb that resizes the rails, above the five card rows ([B11]). */
const RESIZE = "window.resizeSidebarsToFit";
/** The one verb that takes both rails away, directly above the resize row. */
const TOGGLE_SIDEBARS = "window.toggleSidebars";

/** `NSEvent.ModifierFlags` as the snapshot reports them. */
const SHIFT = 1 << 17;
const CONTROL = 1 << 18;
const OPTION = 1 << 19;
const COMMAND = 1 << 20;

/**
 * `NSControl.StateValue` as the harness reports it. `.mixed` is -1, which is
 * the whole reason this file exists — a boolean wire could not carry it.
 */
const OFF = 0;
const ON = 1;
const MIXED = -1;

/**
 * Poll until the item's mark matches, then return what it settled on.
 *
 * The push that carries a gate is coalesced onto a microtask and crosses to
 * the host asynchronously, so a read taken the instant a dispatch returns can
 * legitimately see the mark before last. Polling is the same accommodation
 * at0172 makes for the Session menu's live rows.
 */
async function waitMenuMark(
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
async function expectRung(
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
async function menuItem(
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
async function waitMenuChord(
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
async function waitMenuTitle(
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
 * Where `identifier` stands in the Window menu, top to bottom — the fact an
 * item's own state cannot answer, and the only way to say that one row is
 * above another.
 */
async function windowRowOrder(app: App): Promise<(string | undefined)[]> {
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
  expect(rows, "the Window menu's rows are in the snapshot").toBeDefined();
  return (rows ?? []).map((item) => item.identifier);
}

/** One free content card, so the keyboard has somewhere to be that is not the rail. */
function priorCardDeck() {
  return {
    cards: [
      {
        id: "A",
        componentId: "gallery-accordion",
        title: "Accordion",
        closable: true,
      },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at0511 — the Window menu's sidebar rows", () => {
  test(
    "the row's mark walks the toggle's three rungs and back",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-sidebar-marks",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Hidden: no instance, so no mark, and the row still says Show.
          await expectRung(app, OFF, "Show Jots");

          // Showing and holding the keyboard — the toggle both opens the card
          // and lands the keyboard in it, so one dispatch reaches the top rung.
          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, MIXED, "Hide Jots");

          // Showing without holding it: the keyboard goes back to the free
          // card and the mark drops to the plain check. This is the rung a
          // two-state check could not tell from the one above, and the title
          // says what the next click would now do instead.
          await app.dispatchControlAction("focus-session-card", { cardId: "A" });
          await expectRung(app, ON, "Activate Jots");

          // From the middle rung the toggle takes the keyboard rather than
          // the card, so the card is still showing.
          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, MIXED, "Hide Jots");

          // And only now does it hide.
          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, OFF, "Show Jots");
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the side pair is dark until the card shows, then checks where it stands",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-sidebar-sides",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Hidden: nothing is standing anywhere, so there is no side to set.
          // The default side is still marked — where the card WOULD go.
          const darkLeft = await menuItem(app, LEFT);
          expect(darkLeft.enabled, `${LEFT} is dark while the card is hidden`).toBe(false);
          const darkRight = await menuItem(app, RIGHT);
          expect(darkRight.enabled, `${RIGHT} is dark while the card is hidden`).toBe(false);

          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, MIXED, "Hide Jots");

          // Showing: the pair lights, and the right edge — the default a
          // sidebar takes when nobody has placed it — carries the check.
          const litRight = await waitMenuMark(app, RIGHT, ON);
          expect(litRight.state, `${RIGHT} checked at the default side`).toBe(ON);
          const litLeft = await menuItem(app, LEFT);
          expect(litLeft.enabled, `${LEFT} lights once the card shows`).toBe(true);
          expect(litLeft.state, `${LEFT} unchecked`).toBe(OFF);

          // Moving the card moves the check — the same frame the Left row
          // sends, and the same store the Layout card writes.
          await app.dispatchControlAction("set-sidebar-side", {
            componentId: "jots",
            side: "left",
          });
          const movedLeft = await waitMenuMark(app, LEFT, ON);
          expect(movedLeft.state, `${LEFT} checked after the move`).toBe(ON);
          const movedRight = await waitMenuMark(app, RIGHT, OFF);
          expect(movedRight.state, `${RIGHT} unchecked after the move`).toBe(OFF);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the chord walks the same three rungs as the row it is written on",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-sidebar-chord",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          await expectRung(app, OFF, "Show Jots");

          // ⌃⌘J. Nothing dispatches a frame here: AppKit matches the key
          // equivalent `applyCommandChords` wrote onto the toggle two levels
          // into the Window menu, and fires that item. A chord the sweep had
          // not reached would leave the mark exactly where it was.
          await app.nativeKey("j", ["cmd", "ctrl"]);
          await expectRung(app, MIXED, "Hide Jots");

          // The middle rung, which is the whole reason this is a ladder and
          // not a toggle: the keyboard goes elsewhere, and the SAME chord
          // brings it back rather than taking the card away.
          await app.dispatchControlAction("focus-session-card", { cardId: "A" });
          await expectRung(app, ON, "Activate Jots");

          await app.nativeKey("j", ["cmd", "ctrl"]);
          await expectRung(app, MIXED, "Hide Jots");

          // And only from the top rung does it hide.
          await app.nativeKey("j", ["cmd", "ctrl"]);
          await expectRung(app, OFF, "Show Jots");
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Resize Sidebars to Fit stands above the card rows, carrying ⌥⇧⌘S",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-resize-sidebars-row",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Built with an EMPTY key equivalent, like every row in this menu:
          // the chord below can only be here because `applyCommandChords`
          // wrote it from the frontend's registry, which is what keeps it
          // rebindable.
          const row = await waitMenuChord(app, RESIZE, "s");
          expect(row.found, `${RESIZE} present in the Window menu`).toBe(true);
          if (!row.found) throw new Error(`${RESIZE} is not in the menu`);
          expect(row.keyEquivalent, `${RESIZE} carries "s"`).toBe("s");
          expect(row.modifierMask, `${RESIZE} is ⌥⇧⌘`).toBe(
            COMMAND | OPTION | SHIFT,
          );
          // Ungated: the rails are the deck's geometry and no focused surface
          // declines a verb about them.
          expect(row.enabled, `${RESIZE} is live`).toBe(true);

          // Above the card rows it resizes, which is the placement the row
          // was given rather than one AppKit would arrive at ([B11]).
          const rows = await windowRowOrder(app);
          expect(
            rows.indexOf(RESIZE),
            `${RESIZE} stands above ${PARENT}`,
          ).toBeLessThan(rows.indexOf(PARENT));
          expect(rows.indexOf(RESIZE), `${RESIZE} is one of the rows`).toBeGreaterThanOrEqual(0);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Hide Sidebars stands above the resize row, carrying ⌃⌘S, and names the press",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0511-hide-sidebars-row",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Built with an EMPTY key equivalent like every row in this menu:
          // the chord is here only because `applyCommandChords` wrote it from
          // the registry, which is what keeps it rebindable.
          const row = await waitMenuChord(app, TOGGLE_SIDEBARS, "s");
          expect(row.found, `${TOGGLE_SIDEBARS} present`).toBe(true);
          if (!row.found) throw new Error(`${TOGGLE_SIDEBARS} is not in the menu`);
          expect(row.keyEquivalent, `${TOGGLE_SIDEBARS} carries "s"`).toBe("s");
          expect(row.modifierMask, `${TOGGLE_SIDEBARS} is ⌃⌘`).toBe(
            COMMAND | CONTROL,
          );
          // Ungated: with a rail standing there is one to hide, and with none
          // standing there is the last hide to put back.
          expect(row.enabled, `${TOGGLE_SIDEBARS} is live`).toBe(true);

          // The two verbs about the rails as rails stand together, above the
          // card rows they act on.
          const rows = await windowRowOrder(app);
          expect(
            rows.indexOf(TOGGLE_SIDEBARS),
            `${TOGGLE_SIDEBARS} stands directly above ${RESIZE}`,
          ).toBe(rows.indexOf(RESIZE) - 1);
          expect(
            rows.indexOf(TOGGLE_SIDEBARS),
            `${TOGGLE_SIDEBARS} stands above ${PARENT}`,
          ).toBeLessThan(rows.indexOf(PARENT));

          // Nothing standing yet: the row names the press that brings the
          // rails back rather than one that would take nothing away.
          expect(
            (await waitMenuTitle(app, TOGGLE_SIDEBARS, "Show Sidebars")).title,
            "with no rail standing the row says Show",
          ).toBe("Show Sidebars");

          // A card on a rail flips it, and the press takes that rail away —
          // read off the card's OWN row, which is the deck answering rather
          // than this row restating itself.
          await app.dispatchControlAction("toggle-jots");
          await expectRung(app, MIXED, "Hide Jots");
          expect(
            (await waitMenuTitle(app, TOGGLE_SIDEBARS, "Hide Sidebars")).title,
            "a rail standing makes the next press a hide",
          ).toBe("Hide Sidebars");

          await app.dispatchControlAction("toggle-sidebars");
          await expectRung(app, OFF, "Show Jots");
          expect(
            (await waitMenuTitle(app, TOGGLE_SIDEBARS, "Show Sidebars")).title,
            "and the row turns around with the deck",
          ).toBe("Show Sidebars");

          // And it is a toggle: the same frame puts back what it took, which
          // is the member the hide recorded rather than a default.
          await app.dispatchControlAction("toggle-sidebars");
          expect(
            (await menuItem(app, TOGGLE)).state,
            "the Jots card is back on its rail",
          ).toBe(ON);
          expect(
            (await waitMenuTitle(app, TOGGLE_SIDEBARS, "Hide Sidebars")).title,
            "and the row is a hide again",
          ).toBe("Hide Sidebars");
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

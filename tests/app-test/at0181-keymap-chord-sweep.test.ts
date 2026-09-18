/**
 * at0181-keymap-chord-sweep.test.ts — native key equivalents derived from
 * the keymap registry.
 *
 * `tugapp/Sources` holds no `performKeyEquivalent` override, no `NSEvent`
 * monitor and no `keyDown` override, so every native key claim in Tug is an
 * `NSMenuItem` key equivalent. That is what makes `applyCommandChords` — the
 * recursive sweep over `NSApp.mainMenu` that writes what the frontend's
 * command registry states — complete coverage of the native side rather than
 * a partial measure.
 *
 * What this pins, through the real validated menu:
 *
 *   - **Apply.** An item whose command states a chord carries the converted
 *     form, character *and* mask. The shifted-punctuation case (⌘+) is the
 *     one worth having: `Equal` + shift converts to the character `+` with
 *     shift dropped from the mask, and computing the two apart is exactly
 *     how ⌘+ renders as ⇧⌘= instead.
 *   - **Detach.** A command that claims its chord only while applicable
 *     publishes a release, and the item ends up with no key equivalent at
 *     all. A chord left on a dimmed item is eaten at the menu bar with a
 *     beep instead of falling through, so this is the difference between
 *     "inapplicable here" and "dead everywhere".
 *   - **Absent.** An item whose chord the registry does not state keeps the
 *     literal it was built with — the sweep is not a second author on chords
 *     the host already owns.
 *   - **Survival across a rebuild.** The View menu `removeAllItems()` and
 *     reconstructs from construction-time literals on every open, and the
 *     menu-state push only fires on a changed projection — so the sweep runs
 *     at the tail of the rebuild too, or a rebuilt item silently reverts and
 *     stays reverted until some unrelated state change comes along.
 *
 * The arrow and four-modifier conversions are unit-tested against the real
 * table (`codeToKeyEquivalent` round-trips every code the registry binds);
 * they belong to transcript-navigation commands that need a live session to
 * validate enabled, which is not something this harness can seed. What is
 * asserted here is that those items reach the gate at all — they detach.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/components/tugways/keymap-registry.ts
 * @covers tugdeck/src/components/tugways/chord-format.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** `NSEvent.ModifierFlags` raw values, so an expectation reads as a chord. */
const SHIFT = 1 << 17;
const CONTROL = 1 << 18;
const OPTION = 1 << 19;
const COMMAND = 1 << 20;

function card(id: string) {
  return { id, componentId: "gallery-input", title: `Card ${id}`, closable: true };
}

function singleCardDeck() {
  return {
    cards: [card("C0")],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 640, height: 480 },
        cardIds: ["C0"],
        activeCardId: "C0",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** Poll a menu item's key equivalent until it matches, then return it. */
async function waitKeyEquivalent(
  app: App,
  identifier: string,
  want: string,
  timeoutMs = 8000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const state = await app.menuItemState(identifier);
    last = state.found ? state.keyEquivalent : undefined;
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function expectChord(
  app: App,
  identifier: string,
  keyEquivalent: string,
  modifierMask: number,
): Promise<void> {
  expect(
    await waitKeyEquivalent(app, identifier, keyEquivalent),
    `${identifier} carries ${JSON.stringify(keyEquivalent)}`,
  ).toBe(keyEquivalent);
  const state = await app.menuItemState(identifier);
  expect(state.found, `${identifier} must exist`).toBe(true);
  expect(
    state.found ? state.modifierMask : undefined,
    `${identifier} mask`,
  ).toBe(modifierMask);
}

describe.skipIf(!SHOULD_RUN)("AT0181: the keymap drives the native key equivalents", () => {
  test(
    "chords are applied, released, and left alone as the registry says",
    async () => {
      const app = await launchTugApp({ testName: "at0181-sweep" });
      try {
        await app.seedDeckState({ state: singleCardDeck(), focusCardId: "C0" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0")`,
        );

        // Apply. Zoom In is the shifted-punctuation case: the character
        // carries the shift, so the mask must not carry it twice.
        await expectChord(app, "view.zoomIn", "+", COMMAND);
        await expectChord(app, "view.zoomOut", "-", COMMAND);
        await expectChord(app, "view.actualSize", "0", COMMAND);

        // Absent. Nothing in the table states these, so the literals stand.
        await expectChord(app, "edit.copyAsPlainText", "c", COMMAND | SHIFT | OPTION);
        await expectChord(app, "go.previousCardInStack", "[", COMMAND | OPTION);

        // Detach. Save As… claims ⇧⌘S only while a Text card is frontmost,
        // and a gallery card is not one — so the chord comes off rather than
        // sitting on a dark item and eating itself with a beep.
        await expectChord(app, "file.saveAs", "", 0);

        // Same rule, reached through the disabled-state gate instead: the
        // transcript-navigation items need a session card, so their chords
        // are released here and remain shadowable by whatever wants them.
        await expectChord(app, "go.previousTurn", "", 0);
        await expectChord(app, "go.firstTurn", "", 0);

        // Keep — the other answer to the same question, and the reason the
        // registry asks it per command. This deck holds one pane in no
        // column, so all five column items validate dark; they hold their
        // chords anyway (`disabledChord: "keep"`), because nothing in the JS
        // funnel wants ⌃⌘/ or the ⌃⌘ arrows and there is nothing for a
        // release to hand them back to. The two arrow conversions ride here
        // too: `NSUpArrowFunctionKey` and its ⇧ counterpart, written by the
        // sweep onto items built with no key equivalent at all.
        await expectChord(app, "window.columnSplit", "/", COMMAND | CONTROL);
        await expectChord(app, "window.columnMoveUp", "\u{F700}", COMMAND | CONTROL);
        await expectChord(app, "window.columnMoveDown", "\u{F701}", COMMAND | CONTROL);
        await expectChord(app, "window.columnMoveTop", "\u{F700}", COMMAND | CONTROL | SHIFT);
        await expectChord(
          app,
          "window.columnMoveBottom",
          "\u{F701}",
          COMMAND | CONTROL | SHIFT,
        );
        // The focus family rides the same answer, and it is the ⌥⌘ half of the
        // arrow bands: ⌃⌘ arrows move the furniture, ⌥⌘ arrows move the reader
        // through it ([D184]). One card in no column has nowhere to go in any
        // direction, so all four validate dark and all four keep their chords —
        // nothing in the JS funnel wants ⌥⌘ arrows either. The horizontal pair
        // is the conversion this adds to the two vertical ones above:
        // `NSLeftArrowFunctionKey` and its twin.
        await expectChord(app, "go.focusCardLeft", "\u{F702}", COMMAND | OPTION);
        await expectChord(app, "go.focusCardRight", "\u{F703}", COMMAND | OPTION);
        await expectChord(app, "go.focusCardAbove", "\u{F700}", COMMAND | OPTION);
        await expectChord(app, "go.focusCardBelow", "\u{F701}", COMMAND | OPTION);
        const focusLeft = await app.menuItemState("go.focusCardLeft");
        expect(
          focusLeft.found ? focusLeft.enabled : true,
          "a focus row is dark when the arrangement has nothing that way",
        ).toBe(false);
        const split = await app.menuItemState("window.columnSplit");
        expect(
          split.found ? split.enabled : true,
          "a column item is dark when there is no column",
        ).toBe(false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0181-sweep] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a rebuilt menu keeps the swept chord instead of reverting to its literal",
    async () => {
      const app = await launchTugApp({ testName: "at0181-rebuild" });
      try {
        await app.seedDeckState({ state: singleCardDeck(), focusCardId: "C0" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0")`,
        );

        await expectChord(app, "view.zoomIn", "+", COMMAND);

        // `menuSnapshot` runs each menu's `menuNeedsUpdate` before reading
        // it, exactly as AppKit does on open — so this really is the View
        // menu tearing itself down and rebuilding from its construction-time
        // literals, several times over.
        for (let i = 0; i < 3; i++) {
          const snapshot = await app.menuSnapshot();
          expect(snapshot.length, "the menu bar is readable").toBeGreaterThan(0);
        }

        await expectChord(app, "view.zoomIn", "+", COMMAND);
        await expectChord(app, "view.zoomOut", "-", COMMAND);
        await expectChord(app, "view.actualSize", "0", COMMAND);

        // The hidden ⌘= alias is a second item for the same command, so the
        // sweep says nothing about it — and it must keep both its literal and
        // the `allowsKeyEquivalentWhenHidden` that makes the alias work.
        const alias = await app.menuItemState("view.zoomInAlias");
        expect(alias.found, "the ⌘= alias survives the rebuild").toBe(true);
        expect(alias.found ? alias.keyEquivalent : undefined).toBe("=");
        expect(alias.found ? alias.hidden : undefined).toBe(true);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0181-rebuild] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

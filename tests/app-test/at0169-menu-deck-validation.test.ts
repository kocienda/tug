/**
 * at0169-menu-deck-validation.test.ts — deck-state-tier menu validation.
 *
 * The deck-state tier of `AppDelegate.validateMenuItem` is driven by
 * the `menuState` push's pane projection:
 *
 *   - `go.previousCard` / `go.nextCard` (⇧⌘[ / ⇧⌘]) — enabled
 *     when the deck's lateral card ring holds more than one position
 *     (every tab of every visible pane).
 *   - `go.previousCardInStack` / `go.nextCardInStack` (⌥⌘[ /
 *     ⌥⌘]) and `go.revealStack` (⌘R) — enabled when the focused
 *     pane's slot stack is deeper than one.
 *
 * (`maker.newCardInPane`, ⌘T, also rides this tier, but lives in the
 * debug-gated Maker menu and is absent from the apptest bundle, so it
 * isn't probed here.)
 *
 * Also covers the card-type tier's negative half with a non-dev
 * active card: every session-card command surface (`session.*`,
 * `edit.copyLastResponse`, `file.exportTranscript`, `help.shortcuts`)
 * validates disabled.
 *
 * Verified through `menuItemState` — the real validated state, not a
 * stored flag. Assertions by identifier only.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

function card(id: string) {
  return { id, componentId: "gallery-input", title: `Card ${id}`, closable: true };
}

/** One pane holding the given cards. Position staggers per index so
 *  multi-pane seeds don't overlap. */
function pane(id: string, cardIds: string[], index = 0) {
  return {
    id,
    position: { x: 60 + index * 80, y: 60 + index * 60 },
    size: { width: 640, height: 480 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["maker"],
  };
}

/** Deck with one single-card pane. */
function singlePaneSingleCard() {
  return {
    cards: [card("C0")],
    panes: [pane("p1", ["C0"])],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** Deck with one pane holding two cards. */
function singlePaneMultiCard() {
  return {
    cards: [card("C0"), card("C1")],
    panes: [pane("p1", ["C0", "C1"])],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** Deck with two single-card panes (p2 is last in z-order → focused). */
function twoPanes() {
  return {
    cards: [card("C0"), card("C1")],
    panes: [pane("p1", ["C0"], 0), pane("p2", ["C1"], 1)],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** Two panes sharing one slot — a stack the focused pane can switch within
 *  (`stackDepth` 2). Both panes carry `slot: 0`; the projection's depth is
 *  the length of the focused pane's slot stack. */
function stackedPanes() {
  return {
    cards: [card("C0"), card("C1")],
    panes: [
      { ...pane("p1", ["C0"], 0), slot: 0 },
      { ...pane("p2", ["C1"], 1), slot: 0 },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** Poll a menu item's key equivalent until it matches, then return it. */
async function waitMenuKeyEquivalent(
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

/** Poll the validated menu-item state until it matches `wantEnabled`. */
async function waitMenuEnabled(
  app: App,
  identifier: string,
  wantEnabled: boolean,
  timeoutMs = 8000,
): Promise<{ found: boolean; enabled?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === wantEnabled) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function expectEnabled(app: App, identifier: string, want: boolean): Promise<void> {
  const state = await waitMenuEnabled(app, identifier, want);
  expect(state.found, `${identifier} must exist`).toBe(true);
  expect(state.enabled, `${identifier} enabled=${want}`).toBe(want);
}

describe.skipIf(!SHOULD_RUN)("AT0169: deck-tier menu validation", () => {
  test(
    "single pane, single card: the whole navigation section is disabled",
    async () => {
      const app = await launchTugApp({ testName: "at0169-single" });
      try {
        await app.seedDeckState({ state: singlePaneSingleCard(), focusCardId: "C0" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0")`,
        );

        await expectEnabled(app, "go.previousCard", false);
        await expectEnabled(app, "go.nextCard", false);

        // The slot stack has nowhere to go, so the stack items validate
        // disabled — and Reveal Stack may not keep ⌘R. A chord on a disabled
        // item is eaten at the menu bar with a beep instead of falling
        // through to the web view, so leaving it attached would make ⌘R dead
        // rather than merely inapplicable.
        await expectEnabled(app, "go.previousCardInStack", false);
        await expectEnabled(app, "go.nextCardInStack", false);
        await expectEnabled(app, "go.revealStack", false);
        expect(
          await waitMenuKeyEquivalent(app, "go.revealStack", ""),
          "Reveal Stack drops ⌘R at depth ≤ 1",
        ).toBe("");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0169-single] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "multi-card pane: lateral navigation enabled, depth still disabled",
    async () => {
      const app = await launchTugApp({ testName: "at0169-multicard" });
      try {
        await app.seedDeckState({ state: singlePaneMultiCard(), focusCardId: "C0" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0") && window.__tug.assertHostRootRegistered("C1")`,
        );

        await expectEnabled(app, "go.previousCard", true);
        await expectEnabled(app, "go.nextCard", true);
        await expectEnabled(app, "go.nextCardInStack", false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0169-multicard] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "two free panes: the lateral ring crosses them; non-session card gates the dev-command surfaces off",
    async () => {
      const app = await launchTugApp({ testName: "at0169-twopanes" });
      try {
        await app.seedDeckState({ state: twoPanes(), focusCardId: "C1" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0") && window.__tug.assertHostRootRegistered("C1")`,
        );

        // Both panes are visible, so both cards are on the lateral ring —
        // Next Card is how the keyboard crosses a pane boundary now that
        // Cycle Panes is retired.
        await expectEnabled(app, "go.nextCard", true);
        await expectEnabled(app, "go.previousCard", true);

        // Card-type tier, negative half: the active card is a
        // gallery-input, so every session-card command surface is disabled.
        await expectEnabled(app, "session.focusPrompt", false);
        await expectEnabled(app, "session.stop", false);
        await expectEnabled(app, "session.ai", false);
        await expectEnabled(app, "session.permissionMode.cycle", false);
        await expectEnabled(app, "edit.copyLastResponse", false);
        await expectEnabled(app, "file.exportTranscript", false);
        await expectEnabled(app, "help.shortcuts", false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0169-twopanes] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stacked panes: the depth items light up, Reveal Stack takes ⌘R, and the lateral ring shrinks",
    async () => {
      const app = await launchTugApp({ testName: "at0169-stack" });
      try {
        await app.seedDeckState({ state: stackedPanes(), focusCardId: "C1" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C1")`,
        );

        await expectEnabled(app, "go.previousCardInStack", true);
        await expectEnabled(app, "go.nextCardInStack", true);
        await expectEnabled(app, "go.revealStack", true);
        const reveal = await waitMenuKeyEquivalent(app, "go.revealStack", "r");
        expect(reveal, "Reveal Stack re-attaches ⌘R once the stack is deep").toBe("r");

        // Two panes, one slot: only the front pane's card is visible, so the
        // lateral ring holds one position and the lateral pair dims — the
        // buried card is the depth axis's to reach, not the lateral one's.
        await expectEnabled(app, "go.nextCard", false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0169-stack] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

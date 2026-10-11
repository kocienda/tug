/**
 * at0167-file-menu-close-validation.test.ts — native File-menu
 * validation for Close Card and Close All Card Tabs.
 *
 * Both close items are state-gated by `AppDelegate.validateMenuItem`,
 * driven by the focused pane's cached card list (the frontend pushes
 * `{ focused, cardCount, closable }` per pane on every deck change):
 *
 *   - **Close Card** (`file.closeCard`, ⌘W) — enabled only when the
 *     focused pane's active card is closable. The label is the static
 *     "Close" whether ⌘W will close the card or the whole pane; the web
 *     layer makes that choice, so the menu never renames itself.
 *   - **Close All Card Tabs** (`file.closeAllCardTabs`, ⌥⌘W) — enabled only
 *     when the focused pane holds more than one card.
 *
 * Verified through the harness's native-menu introspection
 * (`menuItemState`), which reports each item's *validated* enabled state
 * the way AppKit resolves it at open / key-equivalent time — so this
 * exercises the real `NSMenuItemValidation` path, not a stored flag.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MenuBarBuilder.swift
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/action-dispatch.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CLOSE_CARD = "file.closeCard";
const CLOSE_ALL = "file.closeAllCardTabs";

/** One pane with `n` gallery-input cards; the active card's `closable`
 *  is overridable to exercise the non-closable branch. */
function paneOf(n: number, activeClosable = true) {
  const cards = Array.from({ length: n }, (_, i) => ({
    id: `C${i}`,
    componentId: "gallery-input",
    title: `Card ${i}`,
    closable: i === 0 ? activeClosable : true,
  }));
  return {
    cards,
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 820, height: 600 },
        cardIds: cards.map((c) => c.id),
        activeCardId: "C0",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** Poll the validated menu-item state until it matches `wantEnabled`,
 *  giving the async menuState push time to reach the Swift host. Returns
 *  the final observed state for further assertions. */
async function waitMenuEnabled(
  app: App,
  identifier: string,
  wantEnabled: boolean,
  timeoutMs = 8000,
): Promise<{ found: boolean; enabled?: boolean; title?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean; title?: string } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === wantEnabled) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe.skipIf(!SHOULD_RUN)(
  "AT0167: File-menu Close Card / Close All Card Tabs validation",
  () => {
    test(
      "single closable card: Close Card enabled, Close All Card Tabs disabled",
      async () => {
        const app = await launchTugApp({ testName: "at0167-single" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: paneOf(1), focusCardId: "C0" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0")`,
          );

          const closeCard = await waitMenuEnabled(app, CLOSE_CARD, true);
          expect(closeCard.found, "file.closeCard must exist").toBe(true);
          expect(closeCard.enabled, "Close Card enabled for a closable card").toBe(true);
          expect(closeCard.title, "label is the static 'Close'").toBe("Close");

          const closeAll = await waitMenuEnabled(app, CLOSE_ALL, false);
          expect(closeAll.found, "file.closeAllCardTabs must exist").toBe(true);
          expect(closeAll.enabled, "Close All Card Tabs disabled for a single-card pane").toBe(false);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0167-single] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "multi-card pane: Close Card AND Close All Card Tabs both enabled",
      async () => {
        const app = await launchTugApp({ testName: "at0167-multi" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: paneOf(2), focusCardId: "C0" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0") && window.__tug.assertHostRootRegistered("C1")`,
          );

          const closeCard = await waitMenuEnabled(app, CLOSE_CARD, true);
          expect(closeCard.enabled, "Close Card enabled in a multi-card pane").toBe(true);
          expect(closeCard.title, "label is the static 'Close'").toBe("Close");

          const closeAll = await waitMenuEnabled(app, CLOSE_ALL, true);
          expect(closeAll.enabled, "Close All Card Tabs enabled for a multi-card pane").toBe(true);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0167-multi] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "single non-closable card: both close items disabled",
      async () => {
        const app = await launchTugApp({ testName: "at0167-nonclosable" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: paneOf(1, false), focusCardId: "C0" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0")`,
          );

          const closeCard = await waitMenuEnabled(app, CLOSE_CARD, false);
          expect(closeCard.enabled, "Close item disabled when the active card is not closable").toBe(false);

          const closeAll = await waitMenuEnabled(app, CLOSE_ALL, false);
          expect(closeAll.enabled, "Close All Card Tabs disabled for a single-card pane").toBe(false);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0167-nonclosable] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "menuSnapshot exposes both File items with key equivalents",
      async () => {
        const app = await launchTugApp({ testName: "at0167-snapshot" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: paneOf(2), focusCardId: "C0" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0") && window.__tug.assertHostRootRegistered("C1")`,
          );

          // Let the menuState push settle so validation reflects the seed.
          await waitMenuEnabled(app, CLOSE_ALL, true);

          const tree = await app.menuSnapshot();
          const flat: { identifier?: string; keyEquivalent: string; modifierMask: number }[] = [];
          const walk = (items: typeof tree) => {
            for (const it of items) {
              flat.push(it);
              if (it.submenu) walk(it.submenu);
            }
          };
          walk(tree);

          const closeCard = flat.find((i) => i.identifier === CLOSE_CARD);
          const closeAll = flat.find((i) => i.identifier === CLOSE_ALL);
          expect(closeCard, "closeCard present in snapshot").toBeDefined();
          expect(closeAll, "closeAll present in snapshot").toBeDefined();
          expect(closeCard!.keyEquivalent, "Close Card is ⌘W").toBe("w");
          expect(closeAll!.keyEquivalent, "Close All Card Tabs is ⌥⌘W").toBe("w");
          // ⌥⌘W carries the Option bit; ⌘W does not.
          expect(
            closeAll!.modifierMask & closeCard!.modifierMask,
            "Close All's modifier mask is a superset of Close Card's (adds Option)",
          ).toBe(closeCard!.modifierMask);
          expect(
            closeAll!.modifierMask,
            "Close All carries more modifier bits than Close Card",
          ).toBeGreaterThan(closeCard!.modifierMask);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0167-snapshot] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

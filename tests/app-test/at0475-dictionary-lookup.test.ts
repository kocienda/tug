/**
 * at0475-dictionary-lookup.test.ts — Look Up in Dictionary is the text
 * surface's first context-menu row, and it dims with the selection.
 *
 * The verb reads the selection rather than moving it, so it leads the menu
 * above its own separator, the way it does in every native text view. Two
 * claims are worth pinning through the real app, and each is a way the row
 * can be wrong while the code reads right:
 *
 *   - **It leads, and a selection lights it.** A right-click over a ranged
 *     selection offers the row first, enabled — which also proves the
 *     secondary-click guard kept the selection alive long enough for the
 *     builder to sample it.
 *   - **A bare caret dims it.** With nothing selected there is nothing to
 *     define, so the row is present and dim rather than an enabled press
 *     that does nothing. The rest of the standard block is the control:
 *     Paste stays live at the same caret, so a dim Look Up is the
 *     selection gate and not a menu that went inert.
 *
 * What is deliberately NOT driven here: activating the row. Its handler
 * hands the selection to AppKit's `showDefinition`, which puts up a system
 * panel — a window this suite has no business summoning on a machine the
 * user is working on. The boundary the test can own is the row and its
 * payload gate; the panel is AppKit's.
 *
 * Selection is made with ⇧← rather than ⌘A: shift-arrows are the substrate's
 * own keys, while ⌘A is an Edit-menu key equivalent that AppKit resolves
 * against a key window this instance does not have.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/dictionary-lookup.ts
 * @covers tugdeck/src/components/tugways/text-editing-menu.ts
 * @covers tugdeck/src/components/tugways/use-text-surface-context-menu.tsx
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const EDITOR = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const LOOK_UP = "Look Up in Dictionary";

/** One pane holding one gallery card of the given component. */
function paneOf(component: string) {
  return {
    cards: [{ id: "A", componentId: component, title: "Card A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 720, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** One row of the open context menu, as the menu renders it. */
interface MenuRow {
  index: number;
  label: string;
  disabled: boolean;
}

/** Every actionable row of the open menu, in the order it shows them. */
async function menuRows(app: App): Promise<MenuRow[]> {
  return (
    (await app.evalJS<MenuRow[]>(
      `Array.from(document.querySelectorAll('.tug-menu-item')).map(function (n, i) {
        var label = n.querySelector('.tug-menu-item-label');
        return {
          index: i,
          label: ((label === null ? n.textContent : label.textContent) || '').trim(),
          disabled: n.hasAttribute('data-disabled'),
        };
      })`,
    )) ?? []
  );
}

/** Open the surface's context menu and read it. Closes any stale menu first. */
async function openMenu(app: App): Promise<MenuRow[]> {
  await app
    .waitForCondition<boolean>(
      `document.querySelectorAll('.tug-menu-item').length === 0`,
      { timeoutMs: 2000 },
    )
    .catch(() => {});
  await app.nativeRightClickAtElement(EDITOR);
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-menu-item').length > 0`,
    { timeoutMs: 4000 },
  );
  return menuRows(app);
}

/** Dismiss the open menu so the next right-click opens a clean one. */
async function closeMenu(app: App): Promise<void> {
  await app.nativeKey("Escape");
  await app
    .waitForCondition<boolean>(
      `document.querySelectorAll('.tug-menu-item').length === 0`,
      { timeoutMs: 2000 },
    )
    .catch(() => {});
}

describe.skipIf(!SHOULD_RUN)("AT0475: Look Up in Dictionary", () => {
  test(
    "the row leads the menu, lit by a selection and dim without one",
    async () => {
      const app = await launchTugApp({ testName: "at0475-dictionary-lookup" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({
          state: paneOf("gallery-text-editor"),
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.awaitEngineReady("A");

        await app.nativeClickAtElement(EDITOR);
        await app.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(EDITOR)})`,
          { timeoutMs: 2000 },
        );
        await app.nativeType("hello tug");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)}) || {}).textContent === "hello tug"`,
          { timeoutMs: 4000 },
        );

        // Select "tug" — three characters back from the caret.
        for (let i = 0; i < 3; i += 1) {
          await app.nativeKey("ArrowLeft", ["shift"]);
          await new Promise((r) => setTimeout(r, 30));
        }

        const withSelection = await openMenu(app);
        note(`menu with a selection: ${withSelection.map((r) => r.label).join(" | ")}`);
        const lit = withSelection.find((r) => r.label === LOOK_UP);
        expect(lit, `${LOOK_UP} must be in the menu`).toBeDefined();
        expect(lit?.index, `${LOOK_UP} leads the menu`).toBe(0);
        expect(lit?.disabled, `${LOOK_UP} is live over a selection`).toBe(false);

        await closeMenu(app);

        // Collapse the selection: same caret, nothing to define.
        await app.nativeKey("ArrowRight");
        await new Promise((r) => setTimeout(r, 150));

        const bareCaret = await openMenu(app);
        note(
          `menu at a bare caret: ${bareCaret
            .map((r) => `${r.label}${r.disabled ? " (dim)" : ""}`)
            .join(" | ")}`,
        );
        const dim = bareCaret.find((r) => r.label === LOOK_UP);
        expect(dim, `${LOOK_UP} stays in the menu with no selection`).toBeDefined();
        expect(dim?.disabled, `${LOOK_UP} dims with nothing selected`).toBe(true);
        // The control: the menu itself is live at this caret.
        expect(
          bareCaret.find((r) => r.label === "Paste")?.disabled,
          "Paste stays live at a bare caret",
        ).toBe(false);

        await closeMenu(app);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0475] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

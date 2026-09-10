/**
 * at0546-session-transcript-rows.test.ts — a bound Session card's title bar
 * says where its transcript verbs went.
 *
 * ## What this gates
 *
 * The turn family moved off the ⌥⌘ arrows and onto the bracket band ([D184]),
 * which buys the arrows for directional card focus and costs every hand that
 * had learned ⌥⌘↑. The payment for that cost is discoverability, and it is
 * this: the Session card publishes its four Go in Transcript verbs to
 * `paneTitleBarItemsStore` as `…` rows, so the card itself names the verb and
 * the chord that now runs it.
 *
 * What is worth proving here:
 *
 *   1. The `…` button exists on a Session card's pane at all. It renders only
 *      when some row has been published, so its presence is the publish.
 *   2. The four rows stand, in the family's order — Previous, Next, First,
 *      Last, the same order the native Session ▸ Go in Transcript submenu
 *      uses. A reader who learns one learns both.
 *   3. Each row carries the BRACKET chord, read from the command table
 *      through `commandShortcut` rather than authored here. An arrow glyph in
 *      any of these four is the regression this test exists to catch: it
 *      would mean the row is naming a chord the keymap no longer holds.
 *   4. All four read DISABLED on a card with no transcript. Enablement is
 *      `transcriptNavigable`'s answer, asked of the same chain the chord and
 *      the native item ask — a row that was live over an empty transcript
 *      would be a second opinion, and the wrong one.
 *
 * The rows come from `SessionCardBody`, which mounts once the card is bound —
 * so a card still on its project picker publishes nothing, and that is right:
 * a `…` holding four permanently dead rows over a picker would be worse than
 * no `…` at all.
 *
 * The `…` sits inside the pane's rollup row, which stays hidden until the
 * pointer is in the bar, so the row is pinned open with `revealPaneControls`
 * before the press — the same thing at0404 does, and for the same reason: a
 * native press lands on the bar behind a hidden row.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/session-transcript-title-bar-items.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/lib/pane-title-bar-items-store.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const PANE = '.tug-pane[data-pane-id="p1"]';
const MENU_BUTTON =
  `${PANE} [data-testid="tug-pane-title-bar-menu-button"]`;

/** The family, in the order the native submenu lists it. */
const EXPECTED_ROWS = [
  { id: "previous-turn", label: "Previous Turn", shortcut: "⌃⌘[" },
  { id: "next-turn", label: "Next Turn", shortcut: "⌃⌘]" },
  { id: "first-turn", label: "First Turn", shortcut: "⌃⌘{" },
  { id: "last-turn", label: "Last Turn", shortcut: "⌃⌘}" },
] as const;

interface Row {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string | null;
  readonly disabled: boolean;
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 860, height: 640 },
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

/**
 * Every row the open popup holds. The menu content is portaled out of the
 * pane, so the rows are found globally; `data-item-id` is the command id the
 * card published, which is what makes the reading an identity rather than a
 * label match.
 */
const readRowsScript = `(function () {
  return Array.prototype.map.call(
    document.querySelectorAll(".tug-menu-content .tug-menu-item[data-item-id]"),
    function (el) {
      var chip = el.querySelector(".tug-menu-item-shortcut");
      var label = el.querySelector(".tug-menu-item-label");
      return {
        id: el.getAttribute("data-item-id"),
        label: label === null ? "" : (label.textContent || "").trim(),
        shortcut: chip === null ? null : (chip.textContent || "").trim(),
        disabled:
          el.getAttribute("aria-disabled") === "true" ||
          el.hasAttribute("data-disabled"),
      };
    },
  );
})()`;

describe.skipIf(!SHOULD_RUN)(
  "AT0546: a Session card's title-bar menu names its transcript verbs",
  () => {
    test(
      "the four Go in Transcript rows stand, with their bracket chords",
      async () => {
        const app = await launchTugApp({ testName: "at0546-session-transcript-rows" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          // A BOUND card, because the rows come from `SessionCardBody` and a
          // card still on its picker has no transcript for them to be about.
          // Bound and never spoken to is exactly the posture case 4 wants: the
          // body stands, the rows stand, and there are no turns.
          await app.bindSession("A");
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content') !== null`,
            { timeoutMs: 8000 },
          );

          // The button's existence IS the publish: `tug-pane.tsx` renders it
          // only when the active card has contributed at least one `…` row.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU_BUTTON)}) !== null`,
            { timeoutMs: 8000 },
          );

          await app.revealPaneControls(PANE);
          await app.nativeClickAtElement(MENU_BUTTON);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(".tug-menu-content .tug-menu-item[data-item-id]").length > 0`,
            { timeoutMs: 8000 },
          );

          const rows = await app.evalJS<readonly Row[]>(readRowsScript);

          expect(
            rows.map((row) => row.id),
            "the family stands in the submenu's own order and nothing else is on the menu",
          ).toEqual(EXPECTED_ROWS.map((row) => row.id));

          for (const want of EXPECTED_ROWS) {
            const row = rows.find((candidate) => candidate.id === want.id)!;
            expect(row.label, `${want.id} wears the table's title`).toBe(want.label);
            // Read, not authored. An arrow here means the row is advertising a
            // chord the keymap no longer holds.
            expect(row.shortcut, `${want.id} reads its bracket chord`).toBe(
              want.shortcut,
            );
            expect(
              row.disabled,
              `${want.id} is dim over a card with no transcript`,
            ).toBe(true);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

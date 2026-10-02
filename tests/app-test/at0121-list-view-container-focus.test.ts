/**
 * at0121-list-view-container-focus.test.ts — TugListView container-stop shape.
 *
 * "One stop on the component, the whole mark on the row." When a list is
 * authored into a `focusGroup`, the scroll **container** registers as one
 * item-container engine stop ([P05]); cell wrappers drop out of the Tab order
 * entirely, so the list is one stop, not one-per-row. On Tab the movement
 * cursor lands on the first row (`data-key-cursor`) and carries the leading-edge
 * caret — the container itself paints nothing ([P01]/[P03]).
 *
 * The gallery `TugListView (focus)` card mounts a container-stop list. The test
 * proves:
 *   - **rows are not Tab stops:** no cell wrapper is a native Tab stop;
 *   - **Tab → one stop, and the container stays bare:** Tab lands the key view
 *     on the scroll container, which draws neither an outline nor a background
 *     layer in any state. The list wore a perimeter ring for a while — painted
 *     by a sticky `.tug-list-view-ring` overlay, because an outline on the
 *     scroller is painted before positioned descendants and got cut by selected
 *     rows and sticky group headers — and the machinery that took (a measured
 *     scrollport height, a scrollbar width, a two-layer band, a z-index lift)
 *     is part of why the mark was retired: the cursor caret already answers
 *     which container holds the keyboard by sitting in it;
 *   - **cursor lands on the first row, wearing the caret:** the first cell
 *     carries `data-key-cursor` and paints its leading-edge bar while the
 *     container holds the key view.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/tug-list-view.css
 * @covers tugdeck/src/components/tugways/tug-list-row.tsx
 * @covers tugdeck/src/components/tugways/tug-list-row.css
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/styles/focus-ring.css
 * @covers tugdeck/src/components/tugways/cards/gallery-list-view-focus.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { appIsActive } from "./_harness/selectors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const TITLE = `${CARD} [data-testid="lv-focus-container-title"]`;
const DEMO = `${CARD} [data-testid="lv-focus-container-demo"]`;
const CONTAINER = `${DEMO} [data-slot="tug-list-view"]`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "gallery-list-view-focus", title: "ListFocus", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 560, height: 620 },
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

// Container snapshot: the scroller's own (suppressed) marks, the keyboard
// marker, and the tab stop. Both `outline` and `backgroundImage` must stay bare
// in every state — those are the two forms the retired container mark took.
// `outline` is the PAINTED width: WebKit reports `outline-width` as specified
// even when `outline-style` is `none` (CSS UI 4 stopped zeroing it), so the
// width alone reads 3px on an element that paints no outline at all.
const CONTAINER_PROBE = `(function(){
  var el = document.querySelector(${JSON.stringify(CONTAINER)});
  if (!el) return null;
  var cs = getComputedStyle(el);
  return {
    outline: cs.outlineStyle === "none" ? "0px" : cs.outlineWidth,
    frameWidth: cs.borderLeftWidth,
    backgroundImage: cs.backgroundImage,
    keyboardReached: el.hasAttribute("data-key-view-kbd"),
    tabIndex: el.getAttribute("tabindex"),
    registered: el.hasAttribute("data-tug-focusable"),
  };
})()`;

// The cursor row's leading-edge caret — a `::before` on the cell, the element
// mark that is now the list's entire keyboard treatment.
const CURSOR_BAR = `(function(){
  var el = document.querySelector(${JSON.stringify(DEMO)} + " [data-tug-list-cell-index=\\"0\\"]");
  if (!el) return null;
  var cs = getComputedStyle(el, "::before");
  return {
    content: cs.content,
    width: cs.width,
    background: cs.backgroundColor,
    clipPath: cs.clipPath,
  };
})()`;

// Whether EVERY rendered cell wrapper in the demo is tabIndex=-1.
// "Not a native Tab stop" is the invariant; `tabindex="-1"` is only one way to
// spell it. Under the focus engine a cell wrapper renders NO tabindex at all
// (tug-list-view's no-tabindex rule) — a tabindex'd wrapper is still
// mouse-focusable and invites the mousedown focus churn the watchdog then has
// to park. Absent and "-1" both satisfy the contract; anything else is a stop.
const ALL_ROWS_NON_FOCUSABLE = `(function(){
  var rows = document.querySelectorAll(${JSON.stringify(`${DEMO} [data-tug-list-cell-index]`)});
  if (rows.length === 0) return false;
  for (var i = 0; i < rows.length; i++) {
    var ti = rows[i].getAttribute("tabindex");
    if (ti !== null && ti !== "-1") return false;
  }
  return true;
})()`;

interface ContainerProbe {
  outline: string;
  frameWidth: string;
  backgroundImage: string;
  keyboardReached: boolean;
  tabIndex: string | null;
  registered: boolean;
}
interface CursorBar {
  content: string;
  width: string;
  background: string;
  clipPath: string;
}

describe.skipIf(!SHOULD_RUN)("AT0121: list-view container is a single focus stop", () => {
  test(
    "rows are not Tab stops; Tab rings the container",
    async () => {
      const app = await launchTugApp({ testName: "at0121-list-view-container-focus" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TITLE)}) !== null`,
          { timeoutMs: 8000 },
        );
        // The container registers itself as the engine focusable.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${CONTAINER}[data-tug-focusable]`)}) !== null`,
          { timeoutMs: 6000 },
        );

        // (1) Rows are not Tab stops — the list is one stop, not one-per-row.
        const rowsInert = await app.evalJS<boolean>(ALL_ROWS_NON_FOCUSABLE);
        expect(rowsInert).toBe(true);

        // Activate the webview, then gate on the app-active projection — the bit
        // `focus-ring.css` suppresses every focus mark under. NOT
        // `document.hasFocus()`: a background-mode harness window never
        // activates, so that never becomes true (see `appIsActive`).
        await app.nativeClickAtElement(TITLE);
        await app.waitForCondition<boolean>(appIsActive(), { timeoutMs: 6000 });
        await new Promise((resolve) => setTimeout(resolve, 150));

        // (2) Tab → the container is the one stop: it takes the key view and
        // paints nothing. The global `[data-key-view-kbd]` rule would otherwise
        // ring it at full accent, so the zero is a live suppression, not an
        // absence — and `backgroundImage` covers the other form the mark took.
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONTAINER)}).hasAttribute("data-key-view-kbd")`,
          { timeoutMs: 6000 },
        );
        const onContainer = await app.evalJS<ContainerProbe>(CONTAINER_PROBE);
        expect(onContainer?.keyboardReached).toBe(true);
        expect(parseFloat(onContainer?.outline ?? "0")).toBe(0);
        expect(onContainer?.backgroundImage ?? "none").toBe("none");
        // "The list is one stop" is an ENGINE fact, not a tabindex fact. Once
        // the focus engine drives the card the container renders no tabindex
        // at all (tug-list-view's no-tabindex rule) — a tabindex'd container is
        // still mouse-focusable and invites the mousedown focus churn the
        // watchdog then has to park. The stop is the engine registration plus
        // the key view the Tab above landed, both asserted here. The tabindex
        // check states the invariant the same way ALL_ROWS_NON_FOCUSABLE does:
        // absent and "-1" both keep the container out of the native Tab order,
        // and a positive value is the only stop.
        expect(
          onContainer?.tabIndex === null || onContainer?.tabIndex === "-1",
        ).toBe(true);
        expect(onContainer?.registered).toBe(true);

        // (3) The movement cursor lands on the first row and PAINTS there —
        // the caret is the list's whole keyboard mark now, so a cursor
        // attribute with no visible bar would leave the focused list unmarked.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${DEMO} [data-tug-list-cell-index="0"]`)}).hasAttribute("data-key-cursor")`,
          { timeoutMs: 6000 },
        );
        const cursorOnFirst = await app.evalJS<boolean>(
          `document.querySelector(${JSON.stringify(`${DEMO} [data-tug-list-cell-index="0"]`)}).hasAttribute("data-key-cursor")`,
        );
        expect(cursorOnFirst).toBe(true);
        const bar = await app.evalJS<CursorBar>(CURSOR_BAR);
        expect(bar?.content).not.toBe("none");
        expect(parseFloat(bar?.width ?? "0")).toBeGreaterThan(0);
        expect(bar?.background).not.toBe("rgba(0, 0, 0, 0)");

        // The caret is a PLAIN RECTANGLE: one constant width, full row height,
        // no clip. It was briefly a tapered trapezoid, and the taper never read
        // as the pointer it was meant to be — at caret widths it is a couple of
        // pixels of bevel. Any clip here means that shape has come back.
        expect(bar?.clipPath ?? "none").toBe("none");
        // Narrow enough to stay a mark rather than a slab beside the content.
        expect(parseFloat(bar?.width ?? "0")).toBeLessThanOrEqual(6);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

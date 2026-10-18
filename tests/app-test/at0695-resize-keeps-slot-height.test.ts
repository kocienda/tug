/**
 * at0695-resize-keeps-slot-height.test.ts — a card alone in its slot takes a
 * height of its own from its bottom edge, stands at the top of its run at it,
 * and has a way back to filling the run.
 *
 * Under the deck's keep-slot rule:
 *
 *  1. The bottom edge is a handle and the top edge is not — the top of a card
 *     standing in its slot is the run's.
 *  2. Dragging the bottom edge up gives the card that height: its top stands,
 *     its bottom is under the hand, the height is stored on the pane, and the
 *     frame at pointer-up is the frame once settled.
 *  3. Dragging it to or past the run's end deletes the height rather than
 *     writing the run's — the card fills its run again.
 *  4. The width menu's Fill Height row does the same from a menu, and is
 *     checked exactly while the card fills its run.
 *  5. The card keeps its slot throughout.
 *
 * `tug-pane.tsx` and `action-dispatch.ts` are deliberately NOT named: both
 * stand at the selection budget. The rule this file holds — the run's end
 * clears the height — lives in the module below.
 *
 * @covers tugdeck/src/lib/keep-slot-resize.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Long enough for any settle a commit could arm to have run out. */
const SETTLE_MS = 900;

const PANE = '.tug-pane[data-pane-id="p1"]';
const WIDTH_BUTTON = '[data-testid="tug-pane-title-bar-width-button"]';
const WIDTH_MENU = '[data-testid="tug-pane-title-bar-width-menu"]';

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 560, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-accordion", title: "Card B", closable: true },
    ],
    panes: [pane("p1", 0, "A"), pane("p2", 1, "B")],
    activePaneId: "p1",
    imposition: { kind: "two-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

interface Rect {
  top: number;
  bottom: number;
}

async function rect(app: App): Promise<Rect> {
  return app.evalJS<Rect>(
    `(function () {
      var r = document.querySelector(${JSON.stringify(PANE)}).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    })()`,
  );
}

async function handles(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${PANE} > .tug-pane-resize`)}))
      .map(function (el) {
        var m = /tug-pane-resize-(\\w+)/.exec(el.className.replace("tug-pane-resize ", ""));
        return m ? m[1] : "?";
      })`,
  );
}

async function stored(
  app: App,
): Promise<{ slot: number | null; slotHeight: number | null }> {
  return app.evalJS(
    `(function () {
      var p = window.tugdeck.diag.getDeckState().panes.find(function (x) { return x.id === "p1"; });
      return { slot: p.slot ?? null, slotHeight: p.slotHeight ?? null };
    })()`,
  );
}

/**
 * Drag the bottom edge by `dy` — or, with `"window-end"`, to the window's last
 * row, which is past the run's end — reading the frame at pointer-up and
 * settled. The press lands on the handle's half inside the frame: the run
 * ends a gap above the window's bottom, so the handle's centre can sit on the
 * edge of what the pointer can reach.
 */
async function dragBottom(
  app: App,
  dy: number | "window-end",
): Promise<{ atUp: Rect; settled: Rect }> {
  const grip = await app.evalJS<{ x: number; y: number; end: number }>(
    `(function () {
      var r = document.querySelector(${JSON.stringify(`${PANE} > .tug-pane-resize-s`)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 1, end: window.innerHeight - 1 };
    })()`,
  );
  const to = { x: grip.x, y: dy === "window-end" ? grip.end : grip.y + dy };
  await app.nativeDragWithoutRelease(grip, to);
  await app.nativeMouseUp(to);
  const atUp = await rect(app);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return { atUp, settled: await rect(app) };
}

function expectSame(a: Rect, b: Rect, what: string): void {
  expect(Math.abs(a.top - b.top), `${what}: top`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(a.bottom - b.bottom), `${what}: bottom`).toBeLessThanOrEqual(0.5);
}

/** Open the width menu and read whether its Fill Height row is checked. */
async function openWidthMenu(app: App): Promise<{ present: boolean; checked: boolean }> {
  await app.revealPaneControls(PANE);
  await app.nativeClickAtElement(`${PANE} ${WIDTH_BUTTON}`);
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(WIDTH_MENU)}).length > 0`,
    { timeoutMs: 5_000 },
  );
  return app.evalJS(
    `(function () {
      var rows = Array.prototype.slice.call(
        document.querySelector(${JSON.stringify(WIDTH_MENU)}).querySelectorAll(".tug-menu-item"));
      var row = rows.find(function (el) {
        var label = el.querySelector(".tug-menu-item-label");
        return label !== null && label.textContent === "Fill Height";
      });
      if (!row) return { present: false, checked: false };
      row.setAttribute("data-at0695-fill", "");
      return { present: true, checked: row.getAttribute("aria-checked") === "true" };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0695 — a card's bottom edge sets its height in its slot",
  () => {
    test(
      "the bottom edge sets it, the run's end clears it, Fill Height clears it, the slot stands",
      async () => {
        const app = await launchTugApp({ testName: "at0695-resize-keeps-slot-height" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${PANE} > .tug-pane-resize-s`)}) !== null`,
            { timeoutMs: 8_000 },
          );

          // ── 1. The bottom edge, never the top. ──
          expect(await handles(app), "bottom and right; no top").toEqual(["s", "e"]);
          const full = await rect(app);

          // ── 2. Up by 200: the card stands at the top of its run at it. ──
          const up = await dragBottom(app, -200);
          note(`bottom ${full.bottom} → ${up.settled.bottom}; top ${full.top} → ${up.settled.top}`);
          expectSame(up.atUp, up.settled, "at pointer-up vs settled");
          expect(Math.abs(up.settled.top - full.top), "the top stands").toBeLessThanOrEqual(0.5);
          expect(Math.abs(up.settled.bottom - (full.bottom - 200)), "the bottom is under the hand").toBeLessThanOrEqual(1);
          const shorter = await stored(app);
          expect(shorter.slot, "the slot kept").toBe(0);
          expect(shorter.slotHeight, "the height is the card's own now").not.toBeNull();

          // ── 3. Down past the run's end: the height is deleted, not written. ──
          const back = await dragBottom(app, "window-end");
          expectSame(back.atUp, back.settled, "back at pointer-up vs settled");
          expectSame(back.settled, full, "back to filling the run");
          const filled = await stored(app);
          expect(filled.slotHeight, "a card dragged to the run's end has no height of its own").toBeNull();
          expect(filled.slot).toBe(0);

          // ── 4. Fill Height from the width menu. ──
          await dragBottom(app, -150);
          expect((await stored(app)).slotHeight).not.toBeNull();
          const menu = await openWidthMenu(app);
          expect(menu.present, "the width menu offers Fill Height").toBe(true);
          expect(menu.checked, "unchecked while the card stands short of its run").toBe(false);
          await app.nativeClickAtElement(`${WIDTH_MENU} [data-at0695-fill]`);
          await app.waitForCondition<boolean>(
            `(window.tugdeck.diag.getDeckState().panes.find(function (p) { return p.id === "p1"; }).slotHeight ?? null) === null`,
            { timeoutMs: 8_000 },
          );
          await new Promise((r) => setTimeout(r, SETTLE_MS));
          expectSame(await rect(app), full, "Fill Height restores the run's height");
          expect((await stored(app)).slot, "the slot stood throughout").toBe(0);
          const reopened = await openWidthMenu(app);
          expect(reopened.checked, "checked while the card fills its run").toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

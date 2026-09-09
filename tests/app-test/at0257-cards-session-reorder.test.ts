/**
 * at0257-cards-session-reorder.test.ts — drag-to-reorder for the session rows in
 * the Cards card, plus the new-session-lands-at-the-bottom overlay.
 *
 * The rows are fed by `cardSessionBindingStore` in bind order; the ROW ITSELF
 * is the handle — there is no grip — and a vertical drag from its own surface
 * drives the shared `useBlockReorder` FLIP, whose drop commits a persisted user
 * order (`dev.tugapp.cards/cardsRowOrder.sessions`) that the Cards projection
 * applies. Sessions absent from that order sort to the bottom, so a session
 * bound AFTER a reorder never disturbs the arrangement.
 *
 * Scenarios:
 *   1. Bind three session cards (A, B, C); drag C's row above A. Assert the
 *      DOM row order puts C first and `cardsRowOrder.sessions` persists C
 *      before A, and that the drag did NOT front a card — a carried row is not a picked one.
 *   2. Bind a fourth session (D) after the reorder; assert it lands LAST,
 *      leaving the reordered set intact.
 *   3. Drag a row far BELOW the list; assert the dragged row stays clamped
 *      within the list container instead of following the pointer out of it.
 *   4. Measure a row cell against the list's frame: it must reach it at both
 *      ends, with the row's own trailing content (the activity tape) standing a
 *      hair inside the trailing one — the column the grip used to hold, given
 *      back. The row divider is the cell's bottom border, so anything holding
 *      the cell off the frame — list padding, a reserved scrollbar gutter — is a
 *      divider that stops short at one end, and nothing about the end state says
 *      which.
 *
 * @covers tugdeck/src/components/cards/cards-card.css
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/tugways/block-reorder.ts
 * @covers tugdeck/src/components/cards/cards-store/
 * @covers tugdeck/src/components/tugways/tug-session-row.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const WRAP = ".cards-list-wrap";
const LIST = ".cards-list";
const ROWS = `${LIST} .session-row-content[data-session-id]`;
const DRAGGING = `${WRAP} .session-row-content[data-dragging="true"]`;
const rowSel = (sessionId: string): string =>
  `${LIST} .session-row-content[data-session-id="${sessionId}"]`;

/**
 * Four session cards, each in its OWN pane — which is what a user who opened
 * four sessions actually has, and what the Cards section reorders.
 *
 * This fixture used to stack all four cards in one pane, which the flat
 * Sessions list rendered as four independent rows. The Cards section is
 * pane-first, so that same deck is now correctly ONE stack row with four
 * subrows: one pane, one row. Four separately-carryable session rows require
 * four panes, and that is the arrangement this test is about.
 */
function sessionDeck() {
  const ids = ["A", "B", "C", "D"];
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "session",
      title: `Session ${id}`,
      closable: true,
    })),
    panes: ids.map((id, i) => ({
      id: `p${i + 1}`,
      position: { x: 40 + i * 24, y: 40 + i * 24 },
      size: { width: 560, height: 520 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
    })),
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function domOrder(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}))
      .map(function(el){ return el.getAttribute("data-session-id"); })`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0257 — Cards Sessions reorder + bottom-append", () => {
  test(
    "dragging a session above another persists the new order; a later session lands last",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0257-cards-session-reorder",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Three real bindings → three Sessions rows in bind order.
          await app.bindSession("A");
          await app.bindSession("B");
          await app.bindSession("C");

          await app.dispatchControlAction("toggle-cards");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 3`,
            { timeoutMs: 5_000 },
          );
          expect(await domOrder(app)).toEqual([
            "test-session-A",
            "test-session-B",
            "test-session-C",
          ]);

          // The fronted card before the drag — a carry must not change it (the
          // trailing click must never activate a row).
          const activeBefore = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );

          // Drag C's ROW to just below A's top edge → C lands at index 0. The
          // grab point is the row's own middle, which is the whole gesture
          // under test: no handle, just the row.
          const aBounds = await app.getElementBounds(rowSel("test-session-A"));
          await app.nativeDragElement(rowSel("test-session-C"), {
            x: Math.round(aBounds.x + aBounds.width / 2),
            y: Math.round(aBounds.y + 4),
          });

          await app.waitForCondition<boolean>(
            `(function(){
              var els = Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}));
              return els.length === 3 && els[0].getAttribute("data-session-id") === "test-session-C";
            })()`,
            { timeoutMs: 5_000 },
          );
          const after = await domOrder(app);
          expect(after.indexOf("test-session-C")).toBeLessThan(
            after.indexOf("test-session-A"),
          );

          // The carry reordered the rows but did NOT front the row under the
          // release point (the trailing click was swallowed).
          const activeAfter = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(activeAfter).toBe(activeBefore);

          // The reorder persisted to tugbank under the Cards card's own
          // domain. The order lives per-group under one record, and a
          // single-card session pane is keyed by its session id, so the
          // sessions group holds exactly what the old `sessionOrder` key did.
          const persisted = tugbankRead<Record<string, string[]>>(
            tugbankPath,
            "dev.tugapp.cards",
            "cardsRowOrder",
          );
          const order = persisted?.value?.sessions ?? [];
          expect(order.indexOf("test-session-C")).toBeLessThan(
            order.indexOf("test-session-A"),
          );

          // A session bound AFTER the reorder lands at the BOTTOM, leaving the
          // arranged set intact.
          await app.bindSession("D");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          const withNew = await domOrder(app);
          expect(withNew[withNew.length - 1]).toBe("test-session-D");
          // The previously-arranged rows keep their relative order.
          expect(withNew.indexOf("test-session-C")).toBeLessThan(
            withNew.indexOf("test-session-A"),
          );
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
    "a row dragged far below the list stays clamped within the list bounds",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0257-cards-session-clamp",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          await app.bindSession("A");
          await app.bindSession("B");

          await app.dispatchControlAction("toggle-cards");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 2`,
            { timeoutMs: 5_000 },
          );

          // Aim at the wrap's own foot — the furthest down the pointer can go
          // now that the card fills the rail. The row is grabbed at its middle,
          // so an unclamped translate puts its BOTTOM half a row past the
          // container; the clamp is what keeps it inside.
          const wrap = await app.getElementBounds(WRAP);
          await app.nativeDragElementWithoutRelease(rowSel("test-session-A"), {
            x: Math.round(wrap.x + wrap.width / 2),
            y: Math.round(wrap.y + wrap.height - 2),
          });

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DRAGGING)}) !== null`,
            { timeoutMs: 3_000 },
          );

          // The dragged row's bottom must not escape the list container's
          // bottom (a couple px of slack for the drag's scale transform / sub-
          // pixel rounding). Before the clamp it followed the pointer out.
          const escaped = await app.evalJS<number>(
            `(function(){
              var d = document.querySelector(${JSON.stringify(DRAGGING)});
              var w = document.querySelector(${JSON.stringify(WRAP)});
              if (!d || !w) return 99999;
              return d.getBoundingClientRect().bottom - w.getBoundingClientRect().bottom;
            })()`,
          );
          expect(escaped).toBeLessThanOrEqual(2);

          await app.nativeMouseUp({
            x: Math.round(wrap.x + wrap.width / 2),
            y: Math.round(wrap.y + wrap.height - 2),
          });
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
    "rows run to the list frame at both ends, and the tape sits at the trailing one",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0257-cards-session-row-edges",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: sessionDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          await app.bindSession("A");
          await app.bindSession("B");

          await app.dispatchControlAction("toggle-cards");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(ROWS)}).length === 2`,
            { timeoutMs: 5_000 },
          );

          // Measured against the list's own frame, INSIDE its border. A cell
          // carries the row divider on its bottom edge, so a cell held off the
          // frame is a divider that stops short — and it can be held off by
          // list padding or by a reserved scrollbar gutter, neither of which
          // any end-state screenshot distinguishes from the other.
          const edges = await app.evalJS<{
            leading: number;
            trailing: number;
            tapeInset: number;
            trailingInset: number;
          }>(
            `(function(){
              var list = document.querySelector(${JSON.stringify(LIST)});
              // The cell holding a SESSION row, not the group header above it —
              // headers are cells too, and the first one in the list is the
              // Sessions group's.
              var cell = list.querySelector(
                ".tug-list-view-cell:has(.session-row-content[data-session-id])"
              );
              var row = cell.querySelector(".tug-session-row");
              var tape = cell.querySelector(".tug-pulse-trailing .tug-sparkline");
              var cs = getComputedStyle(list);
              var lr = list.getBoundingClientRect();
              var cr = cell.getBoundingClientRect();
              var tr = tape.getBoundingClientRect();
              var declared = getComputedStyle(row)
                .getPropertyValue("--tugx-session-row-trailing-inset").trim();
              // The trailing frame is the SCROLLPORT's edge, not the border
              // box's: the list reserves its scrollbar's lane at all times
              // ([D182]), so under classic scrollbars the rows end one track
              // short of the border and that track is the lane, not an inset.
              var scrollportRight = lr.left + parseFloat(cs.borderLeftWidth) + list.clientWidth;
              return {
                leading: cr.left - (lr.left + parseFloat(cs.borderLeftWidth)),
                trailing: scrollportRight - cr.right,
                tapeInset: cr.right - tr.right,
                trailingInset: parseFloat(declared) || 0,
              };
            })()`,
          );
          note("at0257 row edges", JSON.stringify(edges));
          expect(edges.leading).toBeCloseTo(0, 0);
          expect(edges.trailing).toBeCloseTo(0, 0);
          // The row's trailing content stands at the trailing frame, a hair in
          // — not a whole row inset in from it, and not out past it. This is
          // the grip's old column, handed to the tape. The hair is the row's
          // own trailing-inset knob plus the cell's inline padding, so the
          // ceiling is read off that knob rather than written down here: the
          // design of record may retune the standoff, but the tape may never
          // drift a column away from the frame.
          expect(edges.tapeInset).toBeGreaterThan(0);
          expect(edges.tapeInset).toBeLessThanOrEqual(edges.trailingInset + 6);
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

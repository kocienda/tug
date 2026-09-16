/**
 * at0583-workspace-drop-block.test.ts — a workspace's whole block is the drop
 * target, and dropping on it does not go there.
 *
 * Moving a card between workspaces by hand used to mean aiming at one row: the
 * workspace's HEADER was the only element `useBlockReorder` would light. A
 * workspace is a place, and its rows are as much "over there" as its name is,
 * so the target is now the whole run — the header and every row filed under
 * it, all wearing the same `data-cards-space-run` ([B03], Spec S02).
 *
 * Two legs, and the second is the one the first could not have without:
 *
 *   1. **The block lights as one.** Two workspaces, both expanded. A pane row
 *      from workspace one is carried over a ROW of workspace two — not its
 *      header. Every element of workspace two's run wears
 *      `data-drop-target="true"`, workspace one's wears none, and the release
 *      moves the card. `activeSpaceId` is **unchanged**: sending a card
 *      somewhere is not going there ([B04]), and a move that dragged the user
 *      along would cost them the place they were working.
 *
 *   2. **The in-group reorder still lives.** Two cards in one group of ONE
 *      workspace; the lower row is carried above the upper. While the pointer
 *      is over the sibling row NOTHING wears `data-drop-target`, and the
 *      release commits the new order.
 *
 * Leg 2 is a regression test with a precise failure it guards: a pane row's
 * visible order is scoped to one group in one workspace, so that workspace's
 * own run key is never in it — which is the rule that normally keeps a block
 * from reading as a target. With a run selector and no `excludeKey`, every
 * sibling row the pointer passes reads as a hit, `moveTo` stands the reorder
 * down with `applyShift(dragIndex)`, and the release commits nothing. The
 * block lights over the row you are dragging past and the drag silently does
 * nothing. Leg 2 fails exactly that way without the fix.
 *
 * @covers tugdeck/src/components/tugways/block-reorder.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SPACE_ONE = "block-one";
const SPACE_TWO = "block-two";

const headerFor = (id: string): string =>
  `.cards-space-header[data-cards-space-id="${id}"]`;
/** Every element of a workspace's run — the header and its rows together. */
const runOf = (id: string): string =>
  `.cards-list [data-cards-space-run="${id}"]`;

const railPane = (id: string, cardId: string) => ({
  id,
  position: { x: 0, y: 0 },
  size: { width: 420, height: 900 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: [] as string[],
});
const contentPane = (id: string, cardId: string, y: number) => ({
  id,
  position: { x: 60, y },
  size: { width: 700, height: 400 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: ["standard"],
});

/**
 * Each workspace stands its own Workspaces card ([B02] — sidebars are per
 * workspace), so the surface under test is never off screen. Workspace one
 * holds two Text cards so leg 2 has a group with two rows to reorder inside.
 */
function twoSpaceBlob() {
  const deck = (
    railCard: string,
    railId: string,
    texts: string[],
    paneBase: string,
  ) => ({
    cards: [
      { id: railCard, componentId: "cards", title: "Workspaces", closable: true },
      ...texts.map((id) => ({
        id,
        componentId: "text",
        title: id,
        closable: true,
      })),
    ],
    panes: [
      railPane(railId, railCard),
      ...texts.map((id, i) => contentPane(`${paneBase}${i}`, id, 60 + i * 60)),
    ],
    activePaneId: `${paneBase}0`,
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  });
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      {
        id: SPACE_ONE,
        name: "Main",
        deck: deck("C1", "pc1", ["T1", "T2"], "pt"),
      },
      {
        id: SPACE_TWO,
        name: "Second",
        deck: deck("C2", "pc2", ["U1"], "pu"),
      },
    ],
  };
}

/**
 * The pointer script every leg runs. The mark it has to read exists only
 * while the pointer is down, so press, engage, hover and release all happen
 * in one `evalJS` — a poll from outside could only ever arrive after it.
 *
 * `fromSel`/`fromIndex` name the row to carry and `overSel`/`overIndex` what
 * to hover, **by index into the selector's matches** rather than by selector
 * alone: leg 2 carries one row of a pair over the other, and a bare
 * `querySelector` would resolve both halves to the same first match — a drag
 * that hovers itself, which exercises nothing. `readSel` is what to count
 * marks on at the hover.
 *
 * The hover lands on the far EDGE of the target row rather than its centre,
 * because a reorder's own target index is computed from the pointer and the
 * centre of the adjacent row is the boundary between two answers.
 */
const carryScript = (
  fromSel: string,
  fromIndex: number,
  overSel: string,
  overIndex: number,
  readSel: string,
): string => `(function(){
  var row = document.querySelectorAll(${JSON.stringify(fromSel)})[${fromIndex}];
  var over = document.querySelectorAll(${JSON.stringify(overSel)})[${overIndex}];
  if (row === undefined || over === undefined) throw new Error("no row or hover target");
  if (row === over) throw new Error("the carry would hover itself");
  var r = row.getBoundingClientRect();
  var o = over.getBoundingClientRect();
  var opts = function (cx, cy) {
    return { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, button: 0 };
  };
  var x = r.left + r.width / 2;
  var y = r.top + r.height / 2;
  row.dispatchEvent(new PointerEvent("pointerdown", opts(x, y)));
  window.dispatchEvent(new PointerEvent("pointermove", opts(x, y + 10)));
  var engaged = row.getAttribute("data-dragging") === "true";
  var ox = o.left + o.width / 2;
  var oy = o.top < r.top ? o.top + 2 : o.bottom - 2;
  window.dispatchEvent(new PointerEvent("pointermove", opts(ox, oy)));
  var read = Array.prototype.filter.call(
    document.querySelectorAll(${JSON.stringify(readSel)}),
    function (el) { return el.getAttribute("data-drop-target") === "true"; }
  ).length;
  var anyLit = document.querySelectorAll('[data-drop-target="true"]').length;
  window.dispatchEvent(new PointerEvent("pointerup", opts(ox, oy)));
  return { engaged: engaged, read: read, anyLit: anyLit };
})()`;

interface Carry {
  engaged: boolean;
  read: number;
  anyLit: number;
}

describe.skipIf(!SHOULD_RUN)(
  "at0583 — the drop target is the workspace's block",
  () => {
    test(
      "a row carried over another workspace's ROW lights that whole block, and the move does not follow",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(twoSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: "at0583-workspace-drop-block",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('[data-testid="cards-space-header"]').length === 2`,
            { timeoutMs: 20_000 },
          );
          // Both expanded is the default now ([B02]), so workspace two's rows
          // are on screen and can be hovered.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(runOf(SPACE_TWO))}).length > 1`,
            { timeoutMs: 8_000 },
          );

          // The row to carry: T2, in workspace one. The thing to hover: a row
          // of workspace two that is NOT its header — the whole point.
          const SOURCE_ROW = `.cards-list .cards-row[data-cards-space-run="${SPACE_ONE}"]`;
          const TARGET_ROW = `.cards-list .cards-row[data-cards-space-run="${SPACE_TWO}"]`;
          const targetRuns = await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(runOf(SPACE_TWO))}).length`,
          );
          note("at0583 elements in workspace two's run", String(targetRuns));
          expect(targetRuns).toBeGreaterThan(1);

          const carry = await app.evalJS<Carry>(
            carryScript(SOURCE_ROW, 0, TARGET_ROW, 0, runOf(SPACE_TWO)),
          );
          note("at0583 carry over the other workspace", JSON.stringify(carry));
          // The carry engaged at all — otherwise the count below would only be
          // reporting that nothing was dragged.
          expect(carry.engaged).toBe(true);
          // EVERY element of workspace two's run is marked, not just its
          // header: the block is one place to put the card down.
          expect(carry.read).toBe(targetRuns);
          // And nothing outside that run is: workspace one never lit.
          expect(carry.anyLit).toBe(targetRuns);

          // The release moved the card, and the user stayed put ([B04]).
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.filter(function (s) {
               return s.id === ${JSON.stringify(SPACE_TWO)};
             })[0].deck.cards.length === 3`,
            { timeoutMs: 8_000 },
          );
          expect(
            await app.evalJS<string>(
              `window.tugdeck.diag.getSpaces().activeSpaceId`,
            ),
          ).toBe(SPACE_ONE);
          // The mark did not outlive the gesture.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('[data-drop-target="true"]').length`,
            ),
          ).toBe(0);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a reorder inside one workspace lights nothing and still commits",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(twoSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: "at0583-workspace-drop-block-reorder",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.cards-list .cards-row[data-cards-space-run="${SPACE_ONE}"]').length >= 2`,
            { timeoutMs: 20_000 },
          );

          const ROWS = `.cards-list .cards-row[data-cards-space-run="${SPACE_ONE}"]`;
          const readOrder = (): Promise<string[]> =>
            app.evalJS<string[]>(
              `Array.prototype.map.call(
                 document.querySelectorAll(${JSON.stringify(ROWS)}),
                 function (el) { return el.getAttribute("data-cards-row-id"); }
               )`,
            );
          const before = await readOrder();
          note("at0583 row order before", JSON.stringify(before));
          expect(before.length).toBeGreaterThanOrEqual(2);

          // The LOWER row carried up over the UPPER one — index 1 over index
          // 0, so the pointer's whole path is over rows of the dragged row's
          // own workspace, which is exactly what `excludeKey` has to refuse.
          const carry = await app.evalJS<Carry>(
            carryScript(ROWS, 1, ROWS, 0, runOf(SPACE_ONE)),
          );
          note("at0583 in-workspace reorder", JSON.stringify(carry));
          expect(carry.engaged).toBe(true);
          // NOTHING lights. The origin workspace is not a place to put its own
          // card down, and a block that lit here would stand the reorder down.
          expect(carry.read).toBe(0);
          expect(carry.anyLit).toBe(0);

          // And the gesture was a live reorder rather than a dead one: the
          // caret ran, the FLIP shifted, and the release committed an order.
          // That the order CHANGED is the claim: a reorder stood down by a
          // spurious drop-target hit commits nothing at all, so the rows would
          // read back exactly as they did before.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('[data-drop-target="true"]').length === 0`,
            { timeoutMs: 8_000 },
          );
          const after = await readOrder();
          note("at0583 row order after", JSON.stringify(after));
          expect(after).toHaveLength(before.length);
          expect(after).not.toEqual(before);
          expect([...after].sort()).toEqual([...before].sort());
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * at0622-placard-z-order.test.ts — one Z2 placard at a time, and the frame
 * holding the most recently raised surface paints on top.
 *
 * Two folded Session cards running side by side could each hold an OPEN Z2
 * placard, and when they did, which one the reader saw whole was decided by
 * deck array order rather than by which they had just opened. Two separate
 * facts produced that:
 *
 *  - The placard's auto-dismiss watcher exempted anything matching a trigger
 *    SELECTOR, and the selector the Z2 caller passed matched every status cell
 *    in every card — so a pointerdown on card B's cell was not an outside
 *    pointerdown as far as card A's placard was concerned, and A's placard
 *    stayed up. The watcher is now handed the ONE cell its placard was opened
 *    from, so every other card's cell is outside.
 *  - The pane lift that lets a folded placard paint past its own frame landed
 *    on a flat `--tug-z-pane-sheet-open`, so two raised frames tied and paint
 *    order decided. `pane-raise.ts` now publishes each raised frame's position
 *    in the raise order and the lift rule adds it to the token.
 *
 * The two cases below are one per fact, and the second is the one the first
 * cannot reach: with only one placard ever open, two frames are raised at once
 * only when a pane-modal SHEET is up on one card and a folded placard on
 * another — the pair that shares the one attribute, rule and ref-count.
 *
 * **TASKS rather than ARC, deliberately.** The report arrived on the ARC cell,
 * but the Z2 surfaces are ONE `TugPlacard` toggled open on whichever cell was
 * activated, so every cell exercises the same watcher and the same lift. An
 * ARC cell exists only on a card bound to a live arc, and standing two of those
 * up in two scratch projects would make the arc machinery this test's subject
 * instead of its setup.
 *
 * **The clicks are native clicks, and that is load-bearing.** The dismissal
 * under test happens on a capture-phase `pointerdown` on the document; a
 * scripted `.click()` dispatches no pointer event at all, so the watcher would
 * never run and the case would pass without asking its question. A folded
 * card's Z2 row is on screen, so there is a real target to aim at.
 *
 * @covers tugdeck/src/components/tugways/tug-placard.tsx
 * @covers tugdeck/src/components/tugways/pane-raise.ts
 * @covers tugdeck/src/components/tugways/tug-status-cell.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const PLACARD = '[data-slot="tug-placard"]';
const SHEET = '[data-slot="tug-sheet"]';

/** The TASKS cell of one card's Z2 row — the placard trigger this test uses. */
function cellOf(cardId: string): string {
  return `[data-card-id="${cardId}"] [data-slot="tug-status-cell"][data-priority="tasks"]`;
}

const AI_CHIP = (cardId: string): string => `[data-card-id="${cardId}"] [data-slot="ai-chip"]`;

/**
 * Two cards, B's pane standing LATER in the deck's array than A's. Which of
 * them holds the higher z is the deck's FOCUS order rather than the array
 * order — activating a card sends its pane to the top of the map — so the
 * screenshot's shape is reached by activating the peer while a placard hangs off
 * the other card. The panes are close enough
 * vertically that a placard hanging off folded A reaches across folded B's
 * frame: without that overlap the z-order question is not being asked.
 */
function wallShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session A", closable: true },
      { id: "B", componentId: "session", title: "Session B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 600 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 40, y: 215 },
        size: { width: 900, height: 600 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

interface Reading {
  /** How many Z2 placards stand on the whole wall. */
  placards: number;
  /** The pane the one open placard's frame belongs to, `null` with none open. */
  placardPane: string | null;
  /** Its overlap with the OTHER pane's frame, in px — the question's premise. */
  overlapsPeerPx: number | null;
  /**
   * What actually paints at the middle of that crossing. The report read as a
   * SPLIT occlusion — the panel over the peer's masthead and under its
   * transcript text — so the settling question is whether anything of the peer
   * comes out on top anywhere in the crossing, and a hit test at the crossing's
   * centre is the direct answer. It is decisive for the whole panel rather than
   * for one point: the lift puts the placard's frame in its own stacking
   * context above the peer frame, so every descendant of the raised frame is
   * above every descendant of the peer. Either the panel wins the crossing
   * whole or it loses it whole.
   */
  topAtCrossing: { inPlacard: boolean; what: string | null } | null;
  panes: Record<string, { z: number; raised: boolean }>;
  sheets: number;
}

const READ = `(function(){
  var frameOf = function (id) { return document.querySelector('.tug-pane[data-pane-id="' + id + '"]'); };
  var p1 = frameOf("p1"), p2 = frameOf("p2");
  var placards = document.querySelectorAll(${JSON.stringify(PLACARD)});
  var one = placards.length === 1 ? placards[0] : null;
  var frame = one === null ? null : one.closest(".tug-pane");
  var peer = frame === null ? null : (frame === p1 ? p2 : p1);
  var r = function (x) { return Math.round(x * 10) / 10; };
  var overlap = null;
  var top = null;
  if (one !== null && peer !== null) {
    var pr = one.getBoundingClientRect();
    var qr = peer.getBoundingClientRect();
    overlap = r(Math.min(pr.bottom, qr.bottom) - Math.max(pr.top, qr.top));
    if (overlap > 0) {
      var x = Math.round((Math.max(pr.left, qr.left) + Math.min(pr.right, qr.right)) / 2);
      var y = Math.round((Math.max(pr.top, qr.top) + Math.min(pr.bottom, qr.bottom)) / 2);
      var hit = document.elementFromPoint(x, y);
      top = {
        inPlacard: hit !== null && one.contains(hit),
        what: hit === null ? null : (hit.getAttribute("data-slot") || String(hit.className) || hit.tagName),
      };
    }
  }
  var readPane = function (el) {
    return {
      z: Number(getComputedStyle(el).zIndex),
      raised: el.hasAttribute("data-sheet-open"),
    };
  };
  return {
    placards: placards.length,
    placardPane: frame === null ? null : frame.getAttribute("data-pane-id"),
    overlapsPeerPx: overlap,
    topAtCrossing: top,
    panes: { p1: readPane(p1), p2: readPane(p2) },
    sheets: document.querySelectorAll(${JSON.stringify(SHEET)}).length,
  };
})()`;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function seedWall(app: App): Promise<void> {
  // `isEngineReady` reads the deck trace, so the trace has to be on before the
  // engine mounts or the ready event is never recorded.
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: wallShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
  );
  // Both cards are bound, and both must be: an UNBOUND session card raises its
  // own `Choose Session` sheet as soon as it is activated, which would put an
  // entirely correct second raise on the wall and make the reading unusable.
  await app.bindSession("A", { tugSessionId: "at0622-a" });
  await app.awaitEngineReady("A");
  await app.bindSession("B", { tugSessionId: "at0622-b" });
  await app.awaitEngineReady("B");
}

async function fold(app: App, cardId: string, paneId: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(cardId)}, folded: true }), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.__tug.getPaneRecord(${JSON.stringify(paneId)}).folded === true`,
  );
  await wait(500);
}

/** Open the Z2 placard on one card by a real pointer press on its TASKS cell. */
async function pressCell(app: App, cardId: string): Promise<void> {
  await app.nativeClickAtElement(cellOf(cardId));
  await wait(700);
}

async function finishSheetAnimations(app: App): Promise<void> {
  await app.evalJS<null>(
    `(document.querySelectorAll(${JSON.stringify(SHEET)}).forEach(function (e) { e.getAnimations().forEach(function (a) { a.finish(); }); }), null)`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0622: one Z2 placard at a time, last raise on top", () => {
  test(
    "a placard opened on one folded card closes the one open on another, and outranks it",
    async () => {
      const app = await launchTugApp({ testName: "at0622-two-folded-placards" });
      try {
        await seedWall(app);
        await fold(app, "A", "p1");
        await fold(app, "B", "p2");

        const idle = await app.evalJS<Reading>(READ);
        note("at0622 folded wall, no placard", idle);
        expect(idle.placards).toBe(0);
        expect(idle.panes.p1.raised).toBe(false);
        expect(idle.panes.p2.raised).toBe(false);
        // Neither frame is in the raise band yet, so whatever the deck's focus
        // order says about the two of them, it is the lift that will decide.
        expect(idle.panes.p1.z).toBeLessThan(8900);
        expect(idle.panes.p2.z).toBeLessThan(8900);

        await pressCell(app, "A");
        const onA = await app.evalJS<Reading>(READ);
        note("at0622 placard on A", onA);
        expect(onA.placards).toBe(1);
        expect(onA.placardPane).toBe("p1");
        // The panel really does reach across the peer pane, so the z-order
        // below it is what decides which of them the reader sees.
        expect(onA.overlapsPeerPx as number).toBeGreaterThan(0);
        expect(onA.panes.p1.raised).toBe(true);
        expect(onA.panes.p1.z).toBeGreaterThan(onA.panes.p2.z);
        // The reported symptom in its own terms: nothing of the card beneath
        // blocks the panel anywhere in the crossing.
        expect(onA.topAtCrossing?.inPlacard, "the panel paints over the peer, whole").toBe(true);
        note("at0622 placard on A, over the peer", (await app.screenshot()).path);

        // The screenshot exactly: the OTHER card is the one the user goes on to
        // work in, so focus order hands it the higher z. The lift has to hold
        // the placard's frame above it anyway.
        await app.evalJS<null>(`(window.__tug.activateCard("B"), null)`);
        await wait(600);
        const peerFocused = await app.evalJS<Reading>(READ);
        note("at0622 placard on A, peer focused", peerFocused);
        expect(peerFocused.placards).toBe(1);
        expect(peerFocused.placardPane).toBe("p1");
        expect(peerFocused.panes.p1.z).toBeGreaterThan(peerFocused.panes.p2.z);
        expect(peerFocused.topAtCrossing?.inPlacard).toBe(true);

        // The reported gesture: the ARC/TASKS cell of the OTHER folded card.
        // Before the scoping, both placards stood and the array order decided.
        await pressCell(app, "B");
        const onB = await app.evalJS<Reading>(READ);
        note("at0622 placard moved to B", onB);
        expect(onB.placards, "A's placard is gone, B's is up").toBe(1);
        expect(onB.placardPane).toBe("p2");
        expect(onB.panes.p1.raised, "and A's frame let the lift go").toBe(false);
        expect(onB.panes.p2.raised).toBe(true);
        expect(onB.panes.p2.z).toBeGreaterThan(onB.panes.p1.z);

        // And back again — the survivor is whichever was opened last, in either
        // direction, which is what array order could never say.
        await pressCell(app, "A");
        const backOnA = await app.evalJS<Reading>(READ);
        note("at0622 placard back on A", backOnA);
        expect(backOnA.placards).toBe(1);
        expect(backOnA.placardPane).toBe("p1");
        expect(backOnA.panes.p2.raised).toBe(false);
        expect(backOnA.panes.p1.z).toBeGreaterThan(backOnA.panes.p2.z);

        // The exemption's own job survives the scoping: the cell a placard was
        // opened from still closes it. Without the exemption the pointerdown
        // would close the placard and the ensuing click would reopen it.
        await pressCell(app, "A");
        const toggled = await app.evalJS<Reading>(READ);
        note("at0622 toggled closed on its own cell", toggled);
        expect(toggled.placards, "its own cell still toggles it closed").toBe(0);
        expect(toggled.panes.p1.raised).toBe(false);
        expect(toggled.panes.p1.z).toBeLessThan(8900);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sheet and a folded placard on different cards are ordered by which was raised last",
    async () => {
      const app = await launchTugApp({ testName: "at0622-sheet-versus-placard" });
      try {
        await seedWall(app);
        // A folds; B stays open, because a sheet is what B is going to hold.
        await fold(app, "A", "p1");

        // B's sheet first, A's placard second. This is the discriminating
        // order: B stands later in the deck array, so on a flat lift the two
        // frames tied and B painted over A's panel — the case [B01] cannot
        // reach, because only one placard is ever open.
        await app.evalJS<null>(
          `(document.querySelector(${JSON.stringify(AI_CHIP("B"))}).click(), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );
        await wait(800);
        await finishSheetAnimations(app);

        const sheetOnly = await app.evalJS<Reading>(READ);
        note("at0622 sheet up on B", sheetOnly);
        expect(sheetOnly.sheets).toBe(1);
        expect(sheetOnly.panes.p2.raised).toBe(true);

        await pressCell(app, "A");
        const both = await app.evalJS<Reading>(READ);
        note("at0622 sheet on B, placard raised after it on A", both);
        expect(both.sheets, "the sheet is still up").toBe(1);
        expect(both.placards).toBe(1);
        expect(both.placardPane).toBe("p1");
        expect(both.overlapsPeerPx as number).toBeGreaterThan(0);
        expect(both.panes.p1.raised).toBe(true);
        expect(both.panes.p2.raised).toBe(true);
        // Both frames are in the raise band, and the one raised LAST is above —
        // against the array order, which is the whole of the fix.
        expect(both.panes.p1.z).toBeGreaterThanOrEqual(8900);
        expect(both.panes.p2.z).toBeGreaterThanOrEqual(8900);
        expect(both.panes.p1.z).toBeGreaterThan(both.panes.p2.z);
        expect(both.topAtCrossing?.inPlacard, "and the panel wins the crossing").toBe(true);
        note("at0622 sheet under a later-raised placard", (await app.screenshot()).path);

        // The other way round. Escape takes both surfaces down — it closes the
        // sheet and the placard alike — and the exit animation is what unmounts
        // the sheet, which an occluded harness window never advances on its own.
        // The sheet is pane-MODAL, so its own card has to be the active one for
        // Escape to reach it; with A active the key closes only A's placard and
        // the sheet stands there forever.
        await app.evalJS<null>(`(window.__tug.activateCard("B"), null)`);
        await wait(500);
        for (let i = 0; i < 4; i += 1) {
          await app.nativeKey("Escape");
          await wait(300);
          await finishSheetAnimations(app);
          await wait(400);
          const clear = await app.evalJS<Reading>(READ);
          if (clear.sheets === 0 && clear.placards === 0) break;
        }
        const down = await app.evalJS<Reading>(READ);
        note("at0622 both surfaces down", down);
        expect(down.sheets).toBe(0);
        expect(down.placards).toBe(0);
        expect(down.panes.p1.raised).toBe(false);
        expect(down.panes.p2.raised).toBe(false);

        // Placard first this time, sheet second: B's frame goes above A's, and
        // it is the RANK saying so rather than the array order it agrees with.
        await pressCell(app, "A");
        await app.evalJS<null>(
          `(document.querySelector(${JSON.stringify(AI_CHIP("B"))}).click(), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );
        await wait(800);
        await finishSheetAnimations(app);
        const reversed = await app.evalJS<Reading>(READ);
        note("at0622 sheet raised after the placard", reversed);
        expect(reversed.placards, "the placard is still up").toBe(1);
        expect(reversed.sheets).toBe(1);
        expect(reversed.panes.p1.raised).toBe(true);
        expect(reversed.panes.p2.raised).toBe(true);
        expect(reversed.panes.p1.z).toBeGreaterThanOrEqual(8900);
        expect(reversed.panes.p2.z).toBeGreaterThan(reversed.panes.p1.z);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

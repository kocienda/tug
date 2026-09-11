/**
 * at0558-sheet-visibility.test.ts — a pane-modal sheet is WHOLLY visible, in
 * every form a Session card takes.
 *
 * Three regressions, one surface. A sheet used to be sized and placed against
 * its own pane frame, so on a card whose composer had grown tall the panel was
 * taller than the room left above the rest line and its top went under the
 * masthead; on a folded card the rest line is `display: none` and the anchor
 * arithmetic ran on a zero box; and a peer pane standing later in focus order
 * painted straight over the panel. The panel is now measured against the
 * visible canvas — it grows down toward the canvas bottom first and then up
 * past its own frame's top if it must — it stands down to the top anchor when
 * the rest line has no box, and its pane is lifted above every peer for as
 * long as it is up.
 *
 * The modality those changes must not touch is pinned elsewhere:
 * `at0057-popup-in-sheet-stacking` and `at0100-sheet-pane-modal-focus`.
 *
 * Reading the geometry under this harness: the window is occluded, so the
 * document timeline never advances and the sheet's enter animation stays
 * parked on its first frame — the panel reads `opacity: 0` with the `rise`
 * resting `translateY(28px)` still applied, forever. Layout reads
 * (`offsetHeight`, computed `height`/`max-height`) are unaffected, but
 * `getBoundingClientRect` is displaced by that transform. Author styles cannot
 * reach it (`data-tug-motion="off"` loses to a running WAAPI animation), so
 * every case here FINISHES the sheet's animations before it measures, and
 * `fill: forwards` holds the presented geometry after that.
 *
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/tug-sheet.css
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0558-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const AI_CHIP = `${CARD} [data-slot="ai-chip"]`;
const SHEET = '[data-slot="tug-sheet"]';

/** Long enough that the composer grows and squeezes the modal rest line. */
const LONG = Array.from(
  { length: 28 },
  (_, i) =>
    `line ${i} of a long prompt that makes the composer grow tall enough to squeeze the modal rest line`,
).join(" ");

interface Measure {
  clip: { top: number; bottom: number; height: number; anchor: string | null };
  presentation: string | null;
  content: { top: number; bottom: number; height: number };
  frame: { top: number; bottom: number };
  canvas: { top: number; bottom: number };
  restLineHeight: number | null;
  /** How far the panel's top is cut off by its own clip. */
  topCutPx: number;
  /** How far the panel's bottom hangs past its own clip. */
  bottomOverflowPx: number;
}

const MEASURE = `(function(){
  var c = document.querySelector(${JSON.stringify(SHEET)});
  if (c === null) return null;
  var k = c.closest(".tug-sheet-clip");
  var frame = c.closest(".tug-pane");
  var canvas = frame.parentElement;
  var kr = k.getBoundingClientRect();
  var cr = c.getBoundingClientRect();
  var fr = frame.getBoundingClientRect();
  var vr = canvas.getBoundingClientRect();
  var slot = document.querySelector(${JSON.stringify(CARD)} + " .session-view-slot");
  var r = function (x) { return Math.round(x * 10) / 10; };
  return {
    clip: { top: r(kr.top), bottom: r(kr.bottom), height: r(kr.height), anchor: k.getAttribute("data-vertical-anchor") },
    presentation: c.getAttribute("data-tug-sheet-presentation"),
    content: { top: r(cr.top), bottom: r(cr.bottom), height: r(cr.height) },
    frame: { top: r(fr.top), bottom: r(fr.bottom) },
    canvas: { top: r(vr.top), bottom: r(vr.bottom) },
    restLineHeight: slot === null ? null : r(slot.getBoundingClientRect().height),
    topCutPx: r(kr.top - cr.top),
    bottomOverflowPx: r(cr.bottom - kr.bottom),
  };
})()`;

const STACKING = `(function(){
  var q = function (id) { return document.querySelector('.tug-pane[data-pane-id="' + id + '"]'); };
  var a = q("p1"), b = q("p2");
  var c = document.querySelector(${JSON.stringify(SHEET)});
  var r = function (x) { return Math.round(x * 10) / 10; };
  var panel = c === null ? null : c.getBoundingClientRect();
  var bBox = b.getBoundingClientRect();
  return {
    a: { z: Number(getComputedStyle(a).zIndex), sheetOpen: a.getAttribute("data-sheet-open"), folded: a.getAttribute("data-folded") },
    b: { z: Number(getComputedStyle(b).zIndex), sheetOpen: b.getAttribute("data-sheet-open") },
    // Does the panel actually reach over the peer pane? If it does not, the
    // stacking question this case exists to ask is not being asked.
    panelOverlapsPeerPx:
      panel === null ? null : r(Math.min(panel.bottom, bBox.bottom) - Math.max(panel.top, bBox.top)),
    sheetCount: document.querySelectorAll(${JSON.stringify(SHEET)}).length,
  };
})()`;

function deckShape(pane: { x: number; y: number; width: number; height: number }) {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: pane.x, y: pane.y },
        size: { width: pane.width, height: pane.height },
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

// [B03]: a folded card holding a sheet, with a peer card BELOW it in the deck's
// array — so the peer's focus-order z outranks the folded card's and, before
// the lift, painted over its panel.
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
        size: { width: 675, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 40, y: 400 },
        size: { width: 675, height: 600 },
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

async function finishAnimations(app: App): Promise<void> {
  await app.evalJS<null>(
    `(document.querySelectorAll(${JSON.stringify(SHEET)}).forEach(function (e) { e.getAnimations().forEach(function (a) { a.finish(); }); }), null)`,
  );
}

async function settle(app: App, ms: number): Promise<Measure> {
  await new Promise((r) => setTimeout(r, ms));
  await finishAnimations(app);
  return await app.evalJS<Measure>(MEASURE);
}

/** The whole panel is inside the visible canvas, and nothing of it is clipped. */
function expectWhollyVisible(m: Measure): void {
  expect(m.topCutPx).toBeLessThanOrEqual(0.5);
  expect(m.bottomOverflowPx).toBeLessThanOrEqual(0.5);
  expect(m.content.top).toBeGreaterThanOrEqual(m.canvas.top);
  expect(m.content.bottom).toBeLessThanOrEqual(m.canvas.bottom);
  expect(m.content.height).toBeGreaterThan(0);
}

async function seedOne(
  app: App,
  pane: { x: number; y: number; width: number; height: number },
): Promise<void> {
  // `isEngineReady` reads the deck trace, so the trace has to be on before
  // the engine mounts or the ready event is never recorded.
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(pane), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A");
}

async function openAiSheet(app: App): Promise<void> {
  await app.nativeClickAtElement(AI_CHIP);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 8000 },
  );
}

/**
 * The same opener, driven through the chip's own `onClick` rather than through
 * the window server. A fold takes the entry region's box away, and an unfold
 * under an occluded harness window does not settle it back, so on a card that
 * has been folded there is no on-screen target to aim a native click at.
 */
async function openAiSheetByScript(app: App): Promise<void> {
  await app.evalJS<null>(
    `(document.querySelector(${JSON.stringify(AI_CHIP)}).click(), null)`,
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 8000 },
  );
}

/**
 * Escape dismisses a pane-modal sheet — but the exit animation is what takes
 * the panel out of the DOM, and under an occluded harness window a running
 * animation never advances, so the dismissed sheet would stand there forever.
 * Finishing the animations after the key is what lets the unmount land.
 */
async function dismissSheet(app: App): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await app.nativeKey("Escape");
    await new Promise((r) => setTimeout(r, 300));
    await finishAnimations(app);
    await new Promise((r) => setTimeout(r, 500));
    const gone = await app.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(SHEET)}) === null`,
    );
    if (gone) return;
  }
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) === null`,
    { timeoutMs: 8000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0558: a pane-modal sheet is wholly visible", () => {
  // Two shapes for the tall-composer case. The first has plenty of canvas
  // BELOW the pane, so the clip's downward growth absorbs the whole shortfall.
  // The second sits low on the wall with almost nothing below it, which is the
  // only way to reach the upward branch — there the clip must hang above the
  // pane's own frame.
  const SHAPES = [
    { label: "room-below", pane: { x: 40, y: 40, width: 675, height: 680 } },
    { label: "room-above", pane: { x: 40, y: 460, width: 675, height: 560 } },
  ];

  for (const shape of SHAPES) {
    test(
      `the AI settings sheet is whole with a tall composer — ${shape.label}`,
      async () => {
        const app = await launchTugApp({ testName: `at0558-tall-composer-${shape.label}` });
        try {
          await seedOne(app, shape.pane);

          await app.nativeClickAtElement(PROMPT_INPUT);
          await app.nativeType(LONG);
          await app.waitForCondition<boolean>(
            `(function(){ var e = document.querySelector(${JSON.stringify(CARD)} + " .session-view-slot"); return e !== null && e.getBoundingClientRect().height < 200; })()`,
            { timeoutMs: 8000 },
          );

          await openAiSheet(app);
          const m = await settle(app, 1200);
          note(`measure-${shape.label}`, m);

          // The rest line really is squeezed — otherwise the panel fits
          // trivially and this case is not asking its question.
          expect(m.restLineHeight).not.toBeNull();
          expect(m.restLineHeight as number).toBeLessThan(200);
          expectWhollyVisible(m);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  // [B04]/[B05]: a folded card's rest line has no box, so it is no rest line —
  // a sheet raised there stands down to the top anchor and drops from the
  // masthead, and the same sheet on the same card unfolded rises from its line.
  //
  // The stand-down is decided when the sheet is raised, so each of the three
  // readings below raises its own. Folding a card with a sheet already up is a
  // different question and not one this harness can ask: the re-read rides a
  // `ResizeObserver`, whose callbacks are delivered in the rendering step, and
  // an occluded harness window never runs one.
  test(
    "a sheet on a folded card stands down to the top anchor, and rises again unfolded",
    async () => {
      const app = await launchTugApp({ testName: "at0558-folded-card" });
      try {
        await seedOne(app, { x: 40, y: 40, width: 675, height: 680 });

        await app.nativeClickAtElement(PROMPT_INPUT);
        await openAiSheet(app);
        const unfolded = await settle(app, 900);
        note("measure-unfolded", unfolded);
        expect(unfolded.presentation).toBe("rise");
        expect(unfolded.clip.anchor).toBe("bottom");
        expectWhollyVisible(unfolded);
        await dismissSheet(app);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord("p1").folded === true`,
          { timeoutMs: 8000 },
        );
        await new Promise((r) => setTimeout(r, 1200));
        await openAiSheetByScript(app);
        const folded = await settle(app, 900);
        note("measure-folded", folded);
        expect(folded.restLineHeight === null || folded.restLineHeight === 0).toBe(true);
        expect(folded.presentation).toBe("top");
        expect(folded.clip.anchor).toBeNull();
        expectWhollyVisible(folded);
        await dismissSheet(app);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord("p1").folded === false`,
          { timeoutMs: 8000 },
        );
        await new Promise((r) => setTimeout(r, 1200));
        await openAiSheetByScript(app);
        const again = await settle(app, 900);
        note("measure-unfolded-again", again);
        expect(again.presentation).toBe("rise");
        expect(again.clip.anchor).toBe("bottom");
        expectWhollyVisible(again);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // [B03]: the raise. A sheet's pane paints above every peer while the sheet is
  // up, and drops back the moment it closes.
  test(
    "a pane holding a sheet paints above a peer that outranks it in focus order",
    async () => {
      const app = await launchTugApp({ testName: "at0558-pane-raise" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: wallShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
        );
        await app.bindSession("A", { tugSessionId: "at0558-raise-a" });
        await app.awaitEngineReady("A");
        // B is bound too, and it must be: an UNBOUND session card raises its
        // own `Choose Session` sheet the moment it is activated, which would
        // put a second sheet — and a second, entirely correct, raise — on the
        // wall and make this case unreadable.
        await app.bindSession("B", { tugSessionId: "at0558-raise-b" });
        await app.awaitEngineReady("B");

        const before = await app.evalJS<{ a: { z: number }; b: { z: number } }>(STACKING);
        note("stacking-before-sheet", before);

        await app.nativeClickAtElement(PROMPT_INPUT);
        await openAiSheet(app);
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord("p1").folded === true`,
          { timeoutMs: 8000 },
        );
        await new Promise((r) => setTimeout(r, 1200));
        await finishAnimations(app);

        // The screenshot exactly: the OTHER card is the one the user is working
        // in, so focus order hands it the higher z. Before the lift this is
        // where the panel disappeared under its neighbour.
        await app.evalJS<null>(`(window.__tug.activateCard("B"), null)`);
        await new Promise((r) => setTimeout(r, 600));
        const raised = await app.evalJS<{
          a: { z: number; sheetOpen: string | null };
          b: { z: number; sheetOpen: string | null };
          panelOverlapsPeerPx: number | null;
          sheetCount: number;
        }>(STACKING);
        note("stacking-peer-focused", raised);

        expect(raised.sheetCount).toBe(1);
        expect(raised.a.sheetOpen).toBe("");
        expect(raised.b.sheetOpen).toBeNull();
        // The panel really does reach across the peer pane, so the z-order
        // below is the thing deciding which of them the user sees.
        expect(raised.panelOverlapsPeerPx as number).toBeGreaterThan(0);
        expect(raised.a.z).toBeGreaterThan(raised.b.z);

        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
        await new Promise((r) => setTimeout(r, 600));
        await dismissSheet(app);
        await new Promise((r) => setTimeout(r, 400));
        const after = await app.evalJS<{ a: { z: number; sheetOpen: string | null } }>(
          STACKING,
        );
        note("stacking-after-close", after);
        expect(after.a.sheetOpen).toBeNull();
        expect(after.a.z).toBeLessThan(8900);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

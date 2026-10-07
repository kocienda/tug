/**
 * at0712-zoom-overlays-anchor.test.ts — under View › Zoom an overlay opens
 * where its trigger is: a Radix popover, the editor's completion popup and a
 * pane sheet each sit at the 100 % placement scaled by the factor, inside the
 * window, at 50 %, 100 % and 200 %.
 *
 * | Test                  | What would break without it                        |
 * |-----------------------|----------------------------------------------------|
 * | popover offset × f    | an overlay root positioned in viewport px under a  |
 * |                       | scaled ancestor lands f× too far from its trigger  |
 * | completion offset × f | `coordsAtPos` (viewport) written as layout `left`  |
 * | popover, sheet inside | the clamp reading rects against layout margins, or |
 * |                       | a `vh` cap that is the real window, not the deck's |
 *
 * Each overlay's offset from its anchor is read at 1.0 first; at every other
 * factor the same offset, in viewport px, must be that times the factor —
 * the 100 % layout, scaled — within a couple of pixels.
 *
 * @covers tugdeck/src/lib/use-canvas-overlay.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const FACTORS = [1, 0.5, 2] as const;
/** Viewport-px slack on a scaled offset: one rounding at each end. */
const SLACK_PX = 2;

/** One pane that fits the deck's layout box at 200 % (about 830 × 525). */
function deckShape(componentId: string, title: string): Record<string, unknown> {
  return {
    cards: [{ id: "A", componentId, title, closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 560, height: 420 },
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

async function seed(app: App, componentId: string, title: string, ready: string): Promise<void> {
  await app.seedDeckState({ state: deckShape(componentId, title), cardStates: {}, focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(ready)}) !== null`, {
    timeoutMs: 5_000,
  });
  // A reseed keeps pane `p1`'s element, scroll and all, and the sheet
  // surface scrolls it to reach its trigger: start every surface at the top.
  await app.evalJS<void>(`(function () {
    var pane = document.querySelector(${JSON.stringify(PANE)});
    pane.querySelectorAll("*").forEach(function (el) { if (el.scrollTop !== 0) el.scrollTop = 0; });
  })()`);
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * `selector`'s rect once nothing on it or under it is moving. Looping
 * animations (a caret blink, a breathing dot) never finish and move nothing
 * this reads, so only finite ones are waited on; and a finished animation
 * held by `fill: forwards` is still listed by `getAnimations`, so it is
 * read by its play state rather than by its presence.
 */
async function settledRect(app: App, selector: string): Promise<Box> {
  try {
    await waitSettled(app, selector);
  } catch (err) {
    // Say what was there: every match's box and every animation under it.
    const seen = await app.evalJS<unknown>(`(function () {
      return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(function (el) {
        var r = el.getBoundingClientRect();
        return {
          width: r.width,
          height: r.height,
          animations: el.getAnimations({ subtree: true }).map(function (a) {
            var t = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
            return { name: a.animationName || a.id || a.constructor.name, state: a.playState, iterations: String(t.iterations), duration: String(t.duration) };
          }),
        };
      });
    })()`);
    throw new Error(`${selector} never settled: ${JSON.stringify(seen)} (${String(err)})`);
  }
  return app.evalJS<Box>(`(function () {
    var r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  })()`);
}

async function waitSettled(app: App, selector: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      return el !== null && el.getBoundingClientRect().width > 0 &&
        el.getAnimations({ subtree: true }).every(function (a) {
          if (a.playState === "finished") return true;
          var t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
          return t !== null && t.iterations === Infinity;
        });
    })()`,
    { timeoutMs: 5_000 },
  );
}

async function windowBox(app: App): Promise<{ width: number; height: number }> {
  return app.evalJS(`({ width: window.innerWidth, height: window.innerHeight })`);
}

function expectInside(box: Box, win: { width: number; height: number }, label: string): void {
  expect(box.left, `${label} left inside the window`).toBeGreaterThanOrEqual(-0.5);
  expect(box.top, `${label} top inside the window`).toBeGreaterThanOrEqual(-0.5);
  expect(box.right, `${label} right inside the window`).toBeLessThanOrEqual(win.width + 0.5);
  expect(box.bottom, `${label} bottom inside the window`).toBeLessThanOrEqual(win.height + 0.5);
}

const POPOVER_TRIGGER = '[data-at0712="popover-trigger"]';
const POPOVER = '[data-slot="tug-popover"]';
const EDITOR = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const COMPLETION = '[data-slot="tug-completion-menu"]';
const SHEET_TRIGGER = '[data-testid="gallery-sheet-trigger"]';
const SHEET = '[data-slot="tug-sheet"]';
const PANE = '.tug-pane[data-pane-id="p1"]';

/** Popover's offset from its trigger, viewport px. */
async function popoverOffset(app: App): Promise<{ dx: number; dy: number; box: Box }> {
  await seed(app, "gallery-popover", "Popover", '[data-testid="gallery-popover"]');
  // Tag the first "Open Popover" button so the native click can name it.
  await app.evalJS<void>(`(function () {
    var b = Array.from(document.querySelectorAll('[data-testid="gallery-popover"] button'))
      .find(function (x) { return x.textContent.trim() === "Open Popover"; });
    b.setAttribute("data-at0712", "popover-trigger");
  })()`);
  const trigger = await settledRect(app, POPOVER_TRIGGER);
  await app.nativeClickAtElement(POPOVER_TRIGGER);
  const box = await settledRect(app, POPOVER);
  await app.nativeKey("Escape");
  return { dx: box.left - trigger.left, dy: box.top - trigger.bottom, box };
}

/** Completion popup's offset from the editor's content box, viewport px. */
async function completionOffset(app: App): Promise<{ dx: number; dy: number; box: Box }> {
  await seed(app, "gallery-text-editor", "Editor", EDITOR);
  await app.awaitEngineReady("A");
  await app.nativeClickAtElement(EDITOR);
  await app.waitForCondition<boolean>(
    `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(EDITOR)})`,
    { timeoutMs: 2_000 },
  );
  await app.nativeType("/");
  await app.waitForCondition<boolean>(
    `(function () {
      var p = document.querySelector(${JSON.stringify(COMPLETION)});
      // Shown at once, placed in CM6's next measure cycle (before paint):
      // wait for the placement, which is what this reads.
      return p !== null && getComputedStyle(p).display === "block" && p.style.left !== "" &&
        p.querySelectorAll(".tug-completion-menu-item").length > 0;
    })()`,
    { timeoutMs: 4_000 },
  );
  const content = await settledRect(app, EDITOR);
  const box = await settledRect(app, COMPLETION);
  await app.nativeKey("Escape");
  return { dx: box.left - content.left, dy: box.top - content.top, box };
}

/** Sheet's offset from its pane frame, viewport px. */
async function sheetOffset(app: App): Promise<{ dx: number; dy: number; box: Box }> {
  await seed(app, "gallery-sheet", "Sheet", SHEET_TRIGGER);
  // The trigger sits deep in the gallery card, below the fold of a pane that
  // fits the 200 % deck; a native click is a point, so bring it into view.
  // Only the pane's own scroller moves (`scrollIntoView` would scroll the
  // deck too), by the rect delta in layout px.
  await app.evalJS<void>(`(function () {
    var t = document.querySelector(${JSON.stringify(SHEET_TRIGGER)});
    var root = document.getElementById("deck-container");
    var scale = root.getBoundingClientRect().width / root.offsetWidth;
    for (var s = t.parentElement; s !== null && !s.matches(".tug-pane"); s = s.parentElement) {
      var oy = getComputedStyle(s).overflowY;
      if ((oy === "auto" || oy === "scroll") && s.scrollHeight > s.clientHeight) {
        var tr = t.getBoundingClientRect(), sr = s.getBoundingClientRect();
        s.scrollTop += (tr.top - sr.top) / scale - s.clientHeight / 2;
        return;
      }
    }
  })()`);
  await settledRect(app, SHEET_TRIGGER);
  const pane = await settledRect(app, PANE);
  await app.nativeClickAtElement(SHEET_TRIGGER);
  let box: Box;
  try {
    box = await settledRect(app, SHEET);
  } catch (err) {
    // What the click was aimed at, and what stood at that point.
    const aim = await app.evalJS<unknown>(`(function () {
      var t = document.querySelector(${JSON.stringify(SHEET_TRIGGER)});
      var r = t.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var hit = document.elementFromPoint(x, y);
      return {
        trigger: { left: r.left, top: r.top, width: r.width, height: r.height },
        window: { width: innerWidth, height: innerHeight },
        hit: hit === null ? null : hit.tagName + "." + hit.className + " [" + (hit.getAttribute("data-testid") || hit.getAttribute("data-slot") || "") + "]",
        hitIsTrigger: hit !== null && t.contains(hit),
        rootTransform: document.getElementById("deck-container").style.transform,
        active: document.activeElement === null ? null : document.activeElement.tagName + "." + document.activeElement.className,
      };
    })()`);
    throw new Error(`${String(err)} — aim: ${JSON.stringify(aim)}`);
  }
  return { dx: box.left - pane.left, dy: box.top - pane.top, box };
}

describe.skipIf(!SHOULD_RUN)("AT0712: overlays open anchored under a zoom", () => {
  test(
    "a popover, the completion popup and a sheet at 50 %, 100 % and 200 %",
    async () => {
      const app = await launchTugApp({ testName: "at0712-zoom-overlays-anchor" });
      const readings: Record<string, unknown> = {};
      try {
        await app.enableDeckTrace(true);
        const surfaces = {
          popover: popoverOffset,
          completion: completionOffset,
          sheet: sheetOffset,
        } as const;
        const base: Record<string, { dx: number; dy: number }> = {};
        for (const f of FACTORS) {
          expect(await app.setPageZoom(f)).toBeCloseTo(f, 5);
          const win = await windowBox(app);
          for (const [name, read] of Object.entries(surfaces)) {
            const label = `${name} at ${f}`;
            let got: Awaited<ReturnType<typeof read>>;
            try {
              got = await read(app);
            } catch (err) {
              note("offsets by zoom (to the failure)", readings);
              throw new Error(`${label}: ${String(err)}`);
            }
            readings[label] = got;
            // The completion popup takes the roomier side of its caret and
            // never shortens itself, so in a deck as short as 200 % makes
            // this one (830 × 525) it may overrun the window bottom exactly
            // as it would at 100 % in a window that short. Its verdict is
            // the anchoring below; inside-the-window is the popover's
            // collision handling and the sheet's clamp.
            if (name !== "completion") expectInside(got.box, win, label);
            if (f === 1) {
              base[name] = { dx: got.dx, dy: got.dy };
              continue;
            }
            const at1 = base[name]!;
            expect(Math.abs(got.dx - at1.dx * f), `${label}: x offset is the 100 % offset × f`)
              .toBeLessThanOrEqual(SLACK_PX);
            expect(Math.abs(got.dy - at1.dy * f), `${label}: y offset is the 100 % offset × f`)
              .toBeLessThanOrEqual(SLACK_PX);
          }
        }
        note("offsets by zoom", readings);
        await app.setPageZoom(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

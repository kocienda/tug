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
 * Each surface is its own card: a card's body is its component's page, and
 * a seed that changes a card's component under the same id leaves the body
 * it has (`body-shell.ts`, `handOffMountKinds`), which is the product's rule
 * for a card whose component never changes. A seed that drops a card removes
 * it, body and all, so every visit starts from a fresh page.
 *
 * @covers tugdeck/src/lib/use-canvas-overlay.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App, type BodyApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const FACTORS = [1, 0.5, 2] as const;
/** Viewport-px slack on a scaled offset: one rounding at each end. */
const SLACK_PX = 2;

/** One pane that fits the deck's layout box at 200 % (about 830 × 525). */
function deckShape(cardId: string, componentId: string, title: string): Record<string, unknown> {
  return {
    cards: [{ id: cardId, componentId, title, closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 560, height: 420 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

// Kept local: every file's `seed` builds its own deck and waits on its own
// readiness, so the name is shared and the function is not.
async function seed(app: App, cardId: string, componentId: string, title: string, ready: string): Promise<void> {
  await app.seedDeckState({ state: deckShape(cardId, componentId, title), cardStates: {}, focusCardId: cardId });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(cardId)})`,
  );
  await app.body(cardId).waitForCondition<boolean>(`document.querySelector(${JSON.stringify(ready)}) !== null`, {
    timeoutMs: 5_000,
  });
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
 * read by its play state rather than by its presence. `page` is the page the
 * element lives in — card A's body for anything inside the card, the shell
 * for its pane frame — and the rect is in that page's viewport px.
 */
async function settledRect(page: App | BodyApp, selector: string): Promise<Box> {
  try {
    await waitSettled(page, selector);
  } catch (err) {
    // Say what was there: every match's box and every animation under it.
    const seen = await page.evalJS<unknown>(`(function () {
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
  return page.evalJS<Box>(`(function () {
    var r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  })()`);
}

async function waitSettled(page: App | BodyApp, selector: string): Promise<void> {
  await page.waitForCondition<boolean>(
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

/**
 * Where a card's body sits in the window: its placeholder's rect on the
 * shell, in viewport px. A rect read in the body is in the body's own
 * viewport, whose origin is this.
 */
async function bodyOrigin(app: App, cardId: string): Promise<{ left: number; top: number }> {
  return app.evalJS(`(function () {
    var r = document.querySelector('[data-body-placeholder][data-card-id=${JSON.stringify(cardId)}]').getBoundingClientRect();
    return { left: r.left, top: r.top };
  })()`);
}

/** A body-viewport rect in the window's viewport px. */
async function inWindow(app: App, cardId: string, box: Box): Promise<Box> {
  const o = await bodyOrigin(app, cardId);
  return { left: box.left + o.left, top: box.top + o.top, right: box.right + o.left, bottom: box.bottom + o.top };
}

function expectInside(box: Box, win: { width: number; height: number }, label: string): void {
  expect(box.left, `${label} left inside the window`).toBeGreaterThanOrEqual(-0.5);
  expect(box.top, `${label} top inside the window`).toBeGreaterThanOrEqual(-0.5);
  expect(box.right, `${label} right inside the window`).toBeLessThanOrEqual(win.width + 0.5);
  expect(box.bottom, `${label} bottom inside the window`).toBeLessThanOrEqual(win.height + 0.5);
}

const POPOVER_TRIGGER = '[data-at0712="popover-trigger"]';
const POPOVER = '[data-slot="tug-popover"]';
const EDITOR = '[data-card-id="editor"] [data-slot="tug-text-editor"] .cm-content';
const COMPLETION = '[data-slot="tug-completion-menu"]';
const SHEET_TRIGGER = '[data-testid="gallery-sheet-trigger"]';
const SHEET = '[data-slot="tug-sheet"]';
const PANE = '.tug-pane[data-pane-id="p1"]';

/** Popover's offset from its trigger, viewport px. */
async function popoverOffset(app: App): Promise<{ dx: number; dy: number; box: Box }> {
  await seed(app, "popover", "gallery-popover", "Popover", '[data-testid="gallery-popover"]');
  const body = app.body("popover");
  // Tag the first "Open Popover" button so the native click can name it.
  await body.evalJS<void>(`(function () {
    var b = Array.from(document.querySelectorAll('[data-testid="gallery-popover"] button'))
      .find(function (x) { return x.textContent.trim() === "Open Popover"; });
    b.setAttribute("data-at0712", "popover-trigger");
  })()`);
  const trigger = await settledRect(body, POPOVER_TRIGGER);
  await body.nativeClickAtElement(POPOVER_TRIGGER);
  const box = await settledRect(body, POPOVER);
  await app.nativeKey("Escape");
  return { dx: box.left - trigger.left, dy: box.top - trigger.bottom, box: await inWindow(app, "popover", box) };
}

/** Completion popup's offset from the editor's content box, viewport px. */
async function completionOffset(app: App): Promise<{ dx: number; dy: number; box: Box }> {
  await seed(app, "editor", "gallery-text-editor", "Editor", EDITOR);
  const body = app.body("editor");
  await app.awaitEngineReady("editor");
  await body.nativeClickAtElement(EDITOR);
  await body.waitForCondition<boolean>(
    `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(EDITOR)})`,
    { timeoutMs: 2_000 },
  );
  await app.nativeType("/");
  await body.waitForCondition<boolean>(
    `(function () {
      var p = document.querySelector(${JSON.stringify(COMPLETION)});
      // Shown at once, placed in CM6's next measure cycle (before paint):
      // wait for the placement, which is what this reads.
      return p !== null && getComputedStyle(p).display === "block" && p.style.left !== "" &&
        p.querySelectorAll(".tug-completion-menu-item").length > 0;
    })()`,
    { timeoutMs: 4_000 },
  );
  const content = await settledRect(body, EDITOR);
  const box = await settledRect(body, COMPLETION);
  await app.nativeKey("Escape");
  return { dx: box.left - content.left, dy: box.top - content.top, box: await inWindow(app, "editor", box) };
}

/** Sheet's offset from its pane frame, viewport px. */
async function sheetOffset(app: App): Promise<{ dx: number; dy: number; box: Box }> {
  await seed(app, "sheet", "gallery-sheet", "Sheet", SHEET_TRIGGER);
  const body = app.body("sheet");
  // The trigger sits deep in the gallery card, below the fold of a pane that
  // fits the 200 % deck; a native click is a point, so bring it into view.
  // Only the pane's own scroller moves (`scrollIntoView` would scroll the
  // deck too), by the rect delta in layout px.
  await body.evalJS<void>(`(function () {
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
  await settledRect(body, SHEET_TRIGGER);
  const pane = await settledRect(app, PANE);
  await body.nativeClickAtElement(SHEET_TRIGGER);
  let box: Box;
  try {
    box = await inWindow(app, "sheet", await settledRect(body, SHEET));
  } catch (err) {
    // What the click was aimed at, and what stood at that point.
    const aim = await body.evalJS<unknown>(`(function () {
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
      const app = await launchTugApp({ testName: "at0712-zoom-overlays-anchor", bodies: true });
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

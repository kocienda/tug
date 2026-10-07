/**
 * at0710-zoom-same-layout.test.ts — a View › Zoom step changes scale and
 * nothing else: the deck root is scaled by the factor and sized to the window
 * ÷ the factor, so it fills the window, lays out at its 100 % layout, and its
 * type actually shrinks and grows.
 *
 * | Test                   | What would break without it                      |
 * |------------------------|--------------------------------------------------|
 * | root fills the window  | a deck floating in the window, or overrunning it |
 * | Z2 cells at every zoom | a mechanism that reflows the strip (`pageZoom`'s  |
 * |                        | 9px font floor grew the cells below 90 %)        |
 * | type scales            | a zoom that stops shrinking the face at 90 %     |
 * | grid on the root       | a 1× grid under a scaled deck                    |
 * | readout names factor   | a chord with no feedback, the wrong number, or a |
 * |                        | readout that never lets go                       |
 *
 * The zoom is set through the harness's `setPageZoom`, which runs the host's
 * own `MainWindow.applyPageZoom` and resolves once the deck's apply has — so
 * nothing here waits on a ratio, and `devicePixelRatio` is asserted to stay
 * where it was: the transform is the deck's, not WebKit's.
 *
 * @covers tugdeck/src/lib/page-zoom-store.ts
 * @covers tugdeck/src/globals.css
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/TestHarness/TestHarnessConnection.swift
 * @covers tugdeck/src/components/chrome/zoom-readout.tsx
 * @covers tugdeck/src/components/chrome/zoom-readout.css
 * @covers tugdeck/src/components/tugways/tug-status-cell.tsx
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "at0710-A";

/** Wide enough that all five Z2 cells show at 100 %. */
const CARD_WIDTH = 700;

/** Every step View › Zoom can reach, 50 % to 200 % in 10 % steps, 100 %
 *  excepted as the baseline. */
const ZOOM_FACTORS = Array.from({ length: 16 }, (_, i) => (50 + i * 10) / 100).filter(
  (f) => f !== 1,
);

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: CARD_WIDTH, height: 700 },
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

/** One committed prompt → reply turn, so Z2 has its readings. */
async function seedTurn(app: App): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  const msgId = `${SID}-m0`;
  await app.driveSession("A", { op: "send", text: "prompt 0" });
  await frame({ type: "prompt_anchor", promptUuid: `${SID}-u0` });
  await frame({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
  await frame({
    type: "assistant_text",
    msg_id: msgId,
    block_index: 0,
    text: "reply 0",
    is_partial: false,
  });
  await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
}

async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  // `awaitEngineReady` reads the deck trace, which records only when enabled.
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  await seedTurn(app);
  try {
    await app.waitForCondition<boolean>(
      `document.querySelectorAll('[data-card-id="A"] [data-slot="session-card-status-bar"] [data-slot="tug-status-cell"]').length === 5`,
      { timeoutMs: 20_000 },
    );
  } catch (err) {
    note(
      "Z2 strip at timeout",
      await app.evalJS<string>(
        `(document.querySelector('[data-card-id="A"] [data-slot="session-card-status-bar"]') || {outerHTML: "no strip"}).outerHTML.slice(0, 1500)`,
      ),
    );
    throw err;
  }
  return app;
}

interface ZoomReading {
  /** The window, viewport px. */
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  /** The deck root: its screen rect (viewport px), its layout size, its
   *  computed transform. */
  rootRect: { left: number; top: number; width: number; height: number };
  rootLayout: { width: number; height: number };
  rootTransform: string;
  rootGrid: boolean;
  bodyGrid: boolean;
  /** Z2: the cells shown, by priority, and each one's layout width. */
  shown: string[];
  cells: Record<string, number>;
  /** How far the row's content runs past its box, layout px; 0 when it fits. */
  overflow: number;
  /** A Z2 value's face, layout px, and its text's screen height. */
  fontSize: number;
  textRectHeight: number;
}

function read(app: App): Promise<ZoomReading> {
  return app.evalJS<ZoomReading>(`(function () {
  var root = document.getElementById("deck-container");
  var r = root.getBoundingClientRect();
  var bar = document.querySelector('[data-card-id="A"] [data-slot="session-card-status-bar"]');
  var all = [].slice.call(bar.querySelectorAll('[data-slot="tug-status-cell"][data-priority]'))
    .filter(function (c) { return getComputedStyle(c).display !== "none"; });
  var cells = {};
  all.forEach(function (c) { cells[c.getAttribute("data-priority")] = c.offsetWidth; });
  var row = bar.firstElementChild;
  var cell = all[0];
  var range = document.createRange();
  range.selectNodeContents(cell);
  var round = function (n) { return Math.round(n * 100) / 100; };
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    rootRect: { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height) },
    rootLayout: { width: root.offsetWidth, height: root.offsetHeight },
    rootTransform: getComputedStyle(root).transform,
    rootGrid: getComputedStyle(root).backgroundImage !== "none",
    bodyGrid: getComputedStyle(document.body).backgroundImage !== "none",
    shown: all.map(function (c) { return c.getAttribute("data-priority"); }),
    cells: cells,
    overflow: row === null ? 0 : Math.max(0, row.scrollWidth - row.clientWidth),
    fontSize: parseFloat(getComputedStyle(cell).fontSize),
    textRectHeight: round(range.getBoundingClientRect().height),
  };
})()`);
}

describe.skipIf(!SHOULD_RUN)("AT0710: a zoom changes scale and nothing else", () => {
  test(
    "the root fills the window and Z2 keeps its cells at every factor from 50 % to 200 %",
    async () => {
      const app = await standUp("at0710-z2-cells");
      try {
        const baseline = await read(app);
        expect(baseline.shown.length).toBe(5);
        expect(baseline.rootTransform).toBe("none");
        expect(baseline.rootGrid, "the grid is painted on the root").toBe(true);
        expect(baseline.bodyGrid, "and not on body, where it would stay 1×").toBe(false);

        const readings: Record<string, ZoomReading> = { "1": baseline };
        for (const zoom of ZOOM_FACTORS) {
          const taken = await app.setPageZoom(zoom);
          expect(taken).toBeCloseTo(zoom, 5);
          readings[String(zoom)] = await read(app);
        }
        await app.setPageZoom(1);
        const back = await read(app);
        note("readings by zoom", readings);

        for (const zoom of ZOOM_FACTORS) {
          const at = readings[String(zoom)];
          const label = `at ${zoom}`;
          // The transform is the deck's: WebKit's ratio never moved.
          expect(at.devicePixelRatio, label).toBe(baseline.devicePixelRatio);
          expect(at.rootTransform, label).toBe(`matrix(${zoom}, 0, 0, ${zoom}, 0, 0)`);
          // The scaled root fills the window exactly…
          expect(at.rootRect.left, label).toBe(0);
          expect(at.rootRect.top, label).toBe(0);
          expect(Math.abs(at.rootRect.width - at.innerWidth), label).toBeLessThanOrEqual(1);
          expect(Math.abs(at.rootRect.height - at.innerHeight), label).toBeLessThanOrEqual(1);
          // …because it lays out in the window ÷ the factor.
          expect(Math.abs(at.rootLayout.width - at.innerWidth / zoom), label).toBeLessThanOrEqual(1);
          expect(Math.abs(at.rootLayout.height - at.innerHeight / zoom), label).toBeLessThanOrEqual(1);
          // Z2 is the 100 % strip: the same cells, the same boxes, no overrun.
          expect(at.shown, label).toEqual(baseline.shown);
          for (const [priority, width] of Object.entries(baseline.cells)) {
            expect(Math.abs(at.cells[priority] - width), `${priority} cell ${label}`).toBeLessThanOrEqual(1);
          }
          expect(at.overflow, `row overflow ${label}`).toBe(0);
          // The face is the same in layout px and scales on screen — below
          // 90 % too, where `pageZoom` stopped shrinking it.
          expect(at.fontSize, label).toBe(baseline.fontSize);
          expect(
            Math.abs(at.textRectHeight - baseline.textRectHeight * zoom),
            `text height ${label}`,
          ).toBeLessThanOrEqual(0.5);
        }
        // Back at 100 % the deck carries no transform at all.
        expect(back.rootTransform).toBe("none");
        expect(back.rootRect).toEqual(baseline.rootRect);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the readout names the factor in the task that writes the transform, and lets go once the step settles",
    async () => {
      const app = await standUp("at0710-readout");
      try {
        await app.evalJS<boolean>(`(function () {
  var bridge = window.__tugBridge;
  var log = [];
  var snap = function (kind) {
    var el = document.querySelector('[data-testid="zoom-readout"]');
    log.push({
      kind: kind,
      transform: document.getElementById("deck-container").style.transform,
      readout: el === null ? null : { state: el.getAttribute("data-state"), text: el.textContent },
    });
  };
  var apply = bridge.onPageZoomApply;
  bridge.onPageZoomApply = function (factor) {
    snap("before");
    var done = apply(factor);
    snap("applied");
    return done.then(function () { snap("settled"); });
  };
  window.__at0710 = { log: log, apply: apply };
  return true;
})()`);
        await app.setPageZoom(0.9);
        const log = await app.evalJS<
          Array<{
            kind: string;
            transform: string;
            readout: { state: string; text: string } | null;
          }>
        >(`(function () {
  var rec = window.__at0710;
  window.__tugBridge.onPageZoomApply = rec.apply;
  delete window.__at0710;
  return rec.log;
})()`);
        note("zoom step", log);

        // The RPC resolved after the deck's apply did.
        expect(log.map((e) => e.kind)).toEqual(["before", "applied", "settled"]);
        expect(log[0]).toEqual({
          kind: "before",
          transform: "",
          readout: { state: "hidden", text: "" },
        });
        // Up, naming the target, in the same task as the transform.
        expect(log[1]).toEqual({
          kind: "applied",
          transform: "scale(0.9)",
          readout: { state: "shown", text: "90%" },
        });
        // Leaving once the step settled; gone after its hold and fade.
        expect(log[2].readout?.state).toBe("leaving");
        await app.waitForCondition<boolean>(
          `getComputedStyle(document.querySelector('[data-testid="zoom-readout"]')).visibility === "hidden"`,
          { timeoutMs: 5_000 },
        );
        await app.setPageZoom(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

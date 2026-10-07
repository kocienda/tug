/**
 * at0710-zoom-same-layout.test.ts — a View › Zoom step changes scale and
 * nothing else, and the deck is told before and after it happens.
 *
 * | Test                  | What would break without it                       |
 * |-----------------------|---------------------------------------------------|
 * | Z2 cells at every zoom| a `@container` rung answered against the zoomed   |
 * |                       | width, hiding TIME at 90 % on a card with room    |
 * | before / after order  | the deck hearing of a zoom only after the relayout|
 * |                       | it was meant to announce, or never hearing "after"|
 * | readout names factor  | a chord with no feedback, or the wrong number, or |
 * |                       | a readout that never lets go                      |
 *
 * The zoom is set through the harness's `setPageZoom`, which runs the host's
 * own `MainWindow.applyPageZoom`, so the notices are the ones a View menu
 * step sends.
 *
 * @covers tugdeck/src/lib/width-rungs.ts
 * @covers tugdeck/src/components/tugways/tug-status-cell.tsx
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 * @covers tugdeck/src/lib/page-zoom-store.ts
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugdeck/src/components/chrome/zoom-readout.tsx
 * @covers tugdeck/src/components/chrome/zoom-readout.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "at0710-A";

/** Wide enough that all five Z2 cells show at 100 %, near enough slim that
 *  the zoomed container query hid TIME at 90 %. */
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

interface StripReading {
  width: number;
  rungs: string | null;
  shown: string[];
  /** Each shown cell's border-box width, CSS px, by priority. */
  cells: Record<string, number>;
  /** How far the row's content runs past its box; 0 when it fits. */
  overflow: number;
}

function readStrip(app: App): Promise<StripReading> {
  return app.evalJS<StripReading>(`(function () {
  var bar = document.querySelector('[data-card-id="A"] [data-slot="session-card-status-bar"]');
  var cs = getComputedStyle(bar);
  var box = bar.getBoundingClientRect().width
    - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
  var shown = [].slice.call(bar.querySelectorAll('[data-slot="tug-status-cell"][data-priority]'))
    .filter(function (c) { return getComputedStyle(c).display !== "none"; })
    .map(function (c) { return c.getAttribute("data-priority"); });
  var cells = {};
  [].slice.call(bar.querySelectorAll('[data-slot="tug-status-cell"][data-priority]'))
    .forEach(function (c) {
      if (getComputedStyle(c).display === "none") return;
      cells[c.getAttribute("data-priority")] = Math.round(c.getBoundingClientRect().width * 10) / 10;
    });
  var row = bar.firstElementChild;
  return {
    width: Math.round(box * 1000) / 1000,
    rungs: bar.getAttribute("data-width-rungs"),
    shown: shown,
    cells: cells,
    overflow: row === null ? 0 : Math.max(0, row.scrollWidth - row.clientWidth),
  };
})()`);
}

describe.skipIf(!SHOULD_RUN)("AT0710: a zoom changes scale and nothing else", () => {
  test(
    "Z2 shows the same cells at every factor from 50 % to 200 %",
    async () => {
      const app = await standUp("at0710-z2-cells");
      try {
        const baseline = await readStrip(app);
        expect(baseline.shown.length).toBe(5);

        const readings: Record<string, StripReading> = { "1": baseline };
        for (const zoom of ZOOM_FACTORS) {
          const before = await app.evalJS<number>("window.devicePixelRatio");
          await app.setPageZoom(zoom);
          await app.waitForCondition<boolean>(
            `Math.abs(window.devicePixelRatio - ${before}) > 1e-3`,
          );
          // Past the relayout and the strip's observer delivery.
          await new Promise((r) => setTimeout(r, 600));
          readings[String(zoom)] = await readStrip(app);
        }
        await app.setPageZoom(1);
        note("Z2 strip by zoom", readings);

        for (const zoom of ZOOM_FACTORS) {
          expect(readings[String(zoom)].shown).toEqual(baseline.shown);
          // The cells are the same boxes at every factor — a budget in a
          // unit the zoom moves (`ch` did: 90px at 100 %, 101.25px at 80 %)
          // grows the cells inside a strip that does not grow, and the row
          // runs out of its box.
          for (const [priority, width] of Object.entries(baseline.cells)) {
            expect(
              Math.abs(readings[String(zoom)].cells[priority] - width),
              `${priority} cell at ${zoom}`,
            ).toBeLessThanOrEqual(1);
          }
          expect(readings[String(zoom)].overflow, `row overflow at ${zoom}`).toBe(0);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the deck hears before at the old ratio and after at the new one, and the readout names the factor",
    async () => {
      const app = await standUp("at0710-notices");
      try {
        await app.evalJS<boolean>(`(function () {
  var bridge = window.__tugBridge;
  var log = [];
  var readout = function () {
    var el = document.querySelector('[data-testid="zoom-readout"]');
    return el === null ? null : { state: el.getAttribute("data-state"), text: el.textContent };
  };
  var will = bridge.onPageZoomWillChange;
  var did = bridge.onPageZoomDidApply;
  bridge.onPageZoomWillChange = function (report) {
    var before = readout();
    var result = will(report);
    log.push({ kind: "will", factor: report.factor, ratio: window.devicePixelRatio, before: before, readout: readout() });
    return result;
  };
  bridge.onPageZoomDidApply = function (factor) {
    log.push({ kind: "apply", factor: factor, ratio: window.devicePixelRatio, readout: readout() });
    return did(factor).then(function () {
      log.push({ kind: "after", factor: factor, ratio: window.devicePixelRatio, readout: readout() });
    });
  };
  window.__at0710 = { log: log, will: will, did: did };
  return true;
})()`);
        const startRatio = await app.evalJS<number>("window.devicePixelRatio");
        await app.setPageZoom(0.9);
        await app.waitForCondition<boolean>(
          `window.__at0710.log.some(function (e) { return e.kind === "after"; })`,
          { timeoutMs: 10_000 },
        );
        const log = await app.evalJS<
          Array<{
            kind: string;
            factor: number;
            ratio: number;
            before?: { state: string; text: string } | null;
            readout: { state: string; text: string } | null;
          }>
        >(`(function () {
  var rec = window.__at0710;
  window.__tugBridge.onPageZoomWillChange = rec.will;
  window.__tugBridge.onPageZoomDidApply = rec.did;
  delete window.__at0710;
  return rec.log;
})()`);
        await app.setPageZoom(1);
        note("zoom notices", { startRatio, log });

        expect(log.map((e) => e.kind)).toEqual(["will", "apply", "after"]);
        // Before is handled ahead of the zoom: the ratio is still the old one.
        expect(log[0].factor).toBeCloseTo(0.9, 5);
        expect(log[0].ratio).toBeCloseTo(startRatio, 5);
        // After resolves with the page at the new factor.
        expect(log[2].ratio).toBeCloseTo(startRatio * 0.9, 2);
        // The readout was not up before the chord, is up naming the target as
        // the "before" notice is handled — ahead of the relayout — holds
        // through the zoom, and starts to go on "after".
        expect(log[0].before?.state).toBe("hidden");
        expect(log[0].readout).toEqual({ state: "shown", text: "90%" });
        expect(log[1].readout).toEqual({ state: "shown", text: "90%" });
        expect(log[2].readout?.state).toBe("leaving");
        // And it is gone once its hold and fade have run.
        await app.waitForCondition<boolean>(
          `getComputedStyle(document.querySelector('[data-testid="zoom-readout"]')).visibility === "hidden"`,
          { timeoutMs: 5_000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

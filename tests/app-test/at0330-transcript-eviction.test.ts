/**
 * at0330-transcript-eviction.test.ts — the session transcript renders through
 * `evictOffscreen`: rows more than a viewport from the scrollport are
 * UNMOUNTED, their exact measured heights standing in the list's spacers.
 *
 * The mode's whole claim is that this is invisible, so the assertions are
 * about what the user would notice if it weren't:
 *
 * | Test                | What would break without it                          |
 * |---------------------|------------------------------------------------------|
 * | far-scroll fidelity | blank viewport, or content at the wrong scroll offset |
 * | Z0 stays topmost    | the permanent top row painted mid-transcript, because |
 * |                     | the top spacer grew underneath it                     |
 * | selection pin       | the row holding a selection unmounted out from under  |
 * |                     | it while the user scrolled elsewhere ([L23])          |
 * | tool-block expand   | a gesture on a row near the window edge losing its    |
 * |                     | block, or the document mis-sizing after the re-measure|
 * | no suspensions      | the mode silently falling back to mounting everything |
 * | hide/show ledger    | a `display:none` spell (an inactive card tab) firing  |
 * |                     | 0×0 ResizeObserver entries into the ledger and wiping |
 * |                     | it via the width invalidator — scroll geometry then   |
 * |                     | collapses and the position snaps until rows re-measure|
 * | turn stepping       | ⌥⌘↑/⌥⌘↓ dead on an evicted transcript (the pager     |
 * |                     | required every cell mounted and bailed on the first   |
 * |                     | unmounted row)                                        |
 * | hidden restore      | a restore completing behind a hidden card holding its |
 * |                     | batch freeze (and the card's save gate) until the tab |
 * |                     | is next shown, instead of releasing at the hidden     |
 * |                     | settle                                                |
 *
 * The transcript is seeded with COMPLETE TURNS, not with many messages in one
 * turn: consecutive assistant messages inside a turn coalesce into a single
 * assistant-run row, so row count comes from turns.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER as FIXTURE_SCROLLER,
  TRANSCRIPT as FIXTURE_TRANSCRIPT,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0330-A";
const TURNS = 60;
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 760 },
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

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n}. The band is measured from the canvas, not observed,`,
    "so the offset re-resolves on reflow and the row keeps its height.",
    "",
    `- marker ${n}`,
  ].join("\n");
}

/** Seed `turns` committed prompt→reply turns; every third one holds a tool
 *  block, so an expand gesture has something to open. */
async function seedTurns(app: App, turns: number): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  for (let n = 0; n < turns; n += 1) {
    const msgId = `${SID}-m${n}`;
    await app.driveSession("A", { op: "send", text: `prompt ${n}` });
    await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` });
    await frame({
      type: "content_block_start",
      msg_id: msgId,
      block_index: 0,
      kind: "text",
    });
    await frame({
      type: "assistant_text",
      msg_id: msgId,
      block_index: 0,
      text: replyText(n),
      is_partial: false,
    });
    if (n % 3 === 0) {
      const tuId = `${SID}-tu${n}`;
      await frame({
        type: "tool_use",
        msg_id: msgId,
        tool_use_id: tuId,
        tool_name: "Bash",
        input: { command: `echo step ${n}`, description: `step ${n}` },
      });
      await frame({
        type: "tool_result",
        tool_use_id: tuId,
        output: `step ${n} done`,
        is_error: false,
      });
    }
    await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
  }
}

/** Launch, seed, and wait until eviction has armed. */
async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  await seedTurns(app, TURNS);
  await app.waitForCondition<boolean>(
    `!!document.querySelector('${SCROLLER}[data-evict-active]')`,
    { timeoutMs: 30_000 },
  );
  return app;
}

/** Scroll to a fraction of the range and let the window settle. */
async function scrollTo(app: App, frac: number): Promise<void> {
  await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${frac});
  return el.scrollTop;
})()`);
  await new Promise((r) => setTimeout(r, 500));
}

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction", () => {
  test(
    "far scroll keeps the viewport populated, contiguous, and row-0-topped",
    async () => {
      const app = await standUp("at0330-far-scroll");
      try {
        // Mid-transcript: rows must cover the viewport with no hole.
        for (const frac of [0.5, 0.85, 0.15]) {
          await scrollTo(app, frac);
          const view = await app.evalJS<{
            cells: number;
            contiguous: boolean;
            coversViewport: boolean;
            evicting: boolean;
          }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var cells = Array.prototype.slice.call(el.querySelectorAll("[data-tug-list-cell-index]"));
  var ix = cells.map(function (c) { return Number(c.getAttribute("data-tug-list-cell-index")); });
  var contiguous = ix.every(function (v, i) { return i === 0 || v === ix[i - 1] + 1; });
  var box = el.getBoundingClientRect();
  var gap = parseFloat(getComputedStyle(el.querySelector(".tug-list-view-window")).rowGap) || 0;
  // Walk the mounted rows down the scrollport looking for a band nothing
  // covers. The inter-row gap is legitimately blank; anything wider is an
  // evicted row's spacer showing through where a row should be.
  var edge = box.top;
  var hole = 0;
  cells.forEach(function (c) {
    var r = c.getBoundingClientRect();
    if (r.bottom <= box.top || r.top >= box.bottom) return;
    hole = Math.max(hole, Math.max(0, Math.min(r.top, box.bottom) - edge));
    edge = Math.max(edge, Math.min(r.bottom, box.bottom));
  });
  hole = Math.max(hole, box.bottom - edge);
  return {
    cells: cells.length,
    contiguous: contiguous,
    noBlankBand: hole <= gap + 2,
    holePx: Math.round(hole),
    gapPx: Math.round(gap),
    evicting: el.hasAttribute("data-evict-active"),
  };
})()`);
          expect({ frac, ...view }).toMatchObject({
            evicting: true,
            contiguous: true,
            noBlankBand: true,
          });
        }

        // At the very top, row 0 is the first thing in the scroll content —
        // the top spacer never grows underneath it and buries it. This is a
        // NEW session, so there is no Z0 strip at all (it reports a load
        // window, and a new session has none); the resumed case, where the
        // strip is present and must top the content, is asserted in the
        // hidden-restore test below.
        await scrollTo(app, 0);
        const top = await app.evalJS<{
          hasLeading: boolean;
          firstCellTop: number;
          firstCellIndex: number;
          spacerTop: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var firstCell = el.querySelector("[data-tug-list-cell-index]");
  var box = el.getBoundingClientRect();
  return {
    hasLeading: el.querySelector(".tug-list-view-leading") !== null,
    firstCellTop: firstCell ? Math.round(firstCell.getBoundingClientRect().top - box.top) : -9999,
    firstCellIndex: firstCell ? Number(firstCell.getAttribute("data-tug-list-cell-index")) : -1,
    spacerTop: Math.round(parseFloat(el.querySelector(".tug-list-view-spacer--top").style.height) || 0),
  };
})()`);
        expect(top.hasLeading).toBe(false);
        expect(top.firstCellIndex).toBe(0);
        expect(top.spacerTop).toBe(0);
        // Row 0 sits at the top of the scrollport (under the list's own top
        // padding, which the strip's absence restores), not pushed below a
        // grown spacer.
        expect(top.firstCellTop).toBeLessThanOrEqual(24);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a selected row stays mounted while the viewport travels away ([L23])",
    async () => {
      const app = await standUp("at0330-selection-pin");
      try {
        await scrollTo(app, 0.9);
        // Select inside a row that is currently mounted near the bottom.
        const picked = await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var cells = Array.prototype.slice.call(el.querySelectorAll("[data-tug-list-cell-index]"));
  var box = el.getBoundingClientRect();
  var target = null;
  cells.forEach(function (c) {
    var r = c.getBoundingClientRect();
    if (target === null && r.top >= box.top && r.bottom <= box.bottom) target = c;
  });
  if (target === null) target = cells[Math.floor(cells.length / 2)];
  var range = document.createRange();
  range.selectNodeContents(target);
  var sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return Number(target.getAttribute("data-tug-list-cell-index"));
})()`);
        expect(picked).toBeGreaterThanOrEqual(0);
        // Selection changes are observed off `selectionchange`, which is
        // dispatched asynchronously.
        await new Promise((r) => setTimeout(r, 300));

        await scrollTo(app, 0);
        const held = await app.evalJS<{
          mounted: boolean;
          collapsed: boolean;
          evicting: boolean;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var sel = document.getSelection();
  return {
    mounted: !!el.querySelector('[data-tug-list-cell-index="${picked}"]'),
    collapsed: sel === null || sel.isCollapsed,
    evicting: el.hasAttribute("data-evict-active"),
  };
})()`);
        expect(held.collapsed).toBe(false);
        expect(held.mounted).toBe(true);
        // The pin widens the window; it does not switch eviction off.
        expect(held.evicting).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "expanding and collapsing a tool block round-trips the document height",
    async () => {
      const app = await standUp("at0330-expand-roundtrip");
      try {
        await scrollTo(app, 0.5);
        const before = await app.evalJS<{ h: number; headers: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    headers: el.querySelectorAll('.tool-call-header[data-collapsed="true"]').length,
  };
})()`,
        );
        expect(before.headers).toBeGreaterThan(0);

        // Bring a collapsed header INTO VIEW before toggling it. Expanding a
        // block that sits offscreen cannot move `scrollHeight`: eviction holds
        // it at its placeholder's exact measured height (the pixel-identical
        // constraint), so the growth asserted below never appears.
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var box = el.getBoundingClientRect();
  var headers = [].slice.call(el.querySelectorAll('.tool-call-header[data-collapsed="true"]'));
  var below = headers.map(function (h) {
    return { h: h, top: h.getBoundingClientRect().top };
  }).filter(function (r) { return r.top > box.top; });
  if (below.length === 0) return false;
  el.scrollTop += below[0].top - box.top - 40;
  return true;
})()`);
        await app.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  var box = el.getBoundingClientRect();
  return [].slice.call(el.querySelectorAll('.tool-call-header[data-collapsed="true"]')).some(function (h) {
    var b = h.getBoundingClientRect();
    return b.top >= box.top && b.bottom <= box.bottom;
  });
})()`,
          { timeoutMs: 5000 },
        );
        const before2 = await app.evalJS<number>(
          `document.querySelector('${SCROLLER}').scrollHeight`,
        );
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var box = el.getBoundingClientRect();
  var target = [].slice.call(el.querySelectorAll('.tool-call-header[data-collapsed="true"]')).filter(function (h) {
    var b = h.getBoundingClientRect();
    return b.top >= box.top && b.bottom <= box.bottom;
  })[0];
  // The disclosure cue owns the toggle, not the header strip.
  target.querySelector('[data-slot="tool-call-header-disclosure"]').click();
  return true;
})()`);
        // The expanded block's height reaches `scrollHeight` only once the
        // eviction ledger re-measures it, which a fixed sleep can miss — wait
        // for the growth instead of sampling at an arbitrary moment.
        await app.waitForCondition<boolean>(
          `document.querySelector('${SCROLLER}').scrollHeight > ${before2}`,
          { timeoutMs: 8000 },
        );
        const expanded = await app.evalJS<{ h: number; open: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    open: el.querySelectorAll('.tool-call-header:not([data-collapsed="true"])').length,
  };
})()`,
        );
        expect(expanded.open).toBeGreaterThan(0);
        expect(expanded.h).toBeGreaterThan(before.h);

        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.querySelector('.tool-call-header:not([data-collapsed="true"]) [data-slot="tool-call-header-disclosure"]').click();
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 600));
        const after = await app.evalJS<{ h: number; fallbacks: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
  };
})()`,
        );
        // Back to the height it had before the gesture: the re-measure
        // reached the ledger, so the spacers report the collapsed row again.
        expect(Math.abs(after.h - before.h)).toBeLessThanOrEqual(2);
        expect(after.fallbacks).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "turn stepping (⌥⌘↑ / ⌥⌘↓) pages across evicted rows one entry at a time",
    async () => {
      const app = await standUp("at0330-page-by-entry");
      try {
        const readState = (): Promise<{
          top: number;
          flush: number;
          flushIndex: number;
          mounted: string;
          atMax: boolean;
          active: boolean;
          fallbacks: number;
        }> =>
          app.evalJS(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var box = el.getBoundingClientRect();
  var flush = 9999;
  var flushIndex = -1;
  var ix = [];
  el.querySelectorAll("[data-tug-list-cell-index]").forEach(function (c) {
    var n = Number(c.getAttribute("data-tug-list-cell-index"));
    ix.push(n);
    var d = Math.abs(c.getBoundingClientRect().top - box.top);
    if (d < flush) { flush = d; flushIndex = n; }
  });
  return {
    top: el.scrollTop,
    flush: Math.round(flush),
    flushIndex: flushIndex,
    mounted: ix.length ? Math.min.apply(null, ix) + "-" + Math.max.apply(null, ix) : "none",
    atMax: el.scrollTop >= el.scrollHeight - el.clientHeight - 2,
    active: el.hasAttribute("data-evict-active"),
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
  };
})()`);

        // Step back turn by turn from the live bottom, far enough to cross
        // the mounted window into evicted territory. Each press must (a)
        // travel upward — the pre-fix defect was zero travel, because the
        // pager demanded every cell mounted and bailed on the first
        // unmounted row — and (b) land an entry top flush with the
        // scrollport top, including presses whose target was unmounted and
        // reached via the estimated-jump + post-commit-correction protocol.
        // The chord's real route is the keybinding map's `key-card` scope
        // (keybinding-map.ts, ⌥⌘↑ → PREVIOUS_TURN), read by the responder
        // chain's document-level CAPTURE listener. Two other drives were
        // tried and are wrong: `dispatchControlAction` registers key-card
        // adapters for a fixed list that excludes the turn steps (silent
        // no-op), and a native key needs the window to be key, which a
        // background app-test window is not. Dispatching the KeyboardEvent
        // on `document` enters the same capture listener a real chord does.
        const chord = (key: string): Promise<void> =>
          app.evalJS<void>(`(function () {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)},
    altKey: true, metaKey: true,
    bubbles: true, cancelable: true, composed: true,
  }));
})()`);
        const stepUp = (): Promise<void> => chord("ArrowUp");
        const stepDown = (): Promise<void> => chord("ArrowDown");

        // Stepping up off the pinned live edge is the user's own gesture.
        const atBottom = await readState();
        await stepUp();
        await new Promise((r) => setTimeout(r, 500));
        const afterFirst = await readState();
        if (afterFirst.top >= atBottom.top) {
          throw new Error(
            `stepping up off the live bottom did not move (${atBottom.top} → ${afterFirst.top}, mounted ${afterFirst.mounted})`,
          );
        }

        const tops: number[] = [afterFirst.top];
        const trace: string[] = [];
        for (let i = 0; i < 15; i += 1) {
          await stepUp();
          await new Promise((r) => setTimeout(r, 400));
          const s = await readState();
          tops.push(s.top);
          trace.push(
            `${i}:top=${s.top} flush=${s.flush}@${s.flushIndex} mounted=${s.mounted}`,
          );
          // A press whose target sits within the last viewport of content
          // clamps at the bottom instead of reaching flush — legitimate;
          // every interior landing must put an entry top at the scrollport
          // top (including estimated jumps into evicted territory, whose
          // post-commit correction reconciles the offset).
          if (s.flush > 3 && !s.atMax) {
            throw new Error(
              `press ${i}: no entry landed flush with the scrollport top (nearest ${s.flush}px, scrollTop ${s.top})`,
            );
          }
        }
        for (let i = 1; i < tops.length; i += 1) {
          if (tops[i] >= tops[i - 1]) {
            throw new Error(
              `press ${i} did not travel up (${tops[i - 1]} → ${tops[i]}); trace: ${trace.join(" | ")}`,
            );
          }
        }

        // And forward again: each press travels downward.
        const downTops: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          await stepDown();
          await new Promise((r) => setTimeout(r, 400));
          downTops.push((await readState()).top);
        }
        expect(downTops[0]).toBeGreaterThan(tops[tops.length - 1]);
        for (let i = 1; i < downTops.length; i += 1) {
          expect(downTops[i]).toBeGreaterThan(downTops[i - 1]);
        }

        const end = await readState();
        expect(end.active).toBe(true);
        expect(end.fallbacks).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a width-churn burst coalesces to one invalidation at settle",
    async () => {
      const app = await standUp("at0330-width-churn");
      try {
        await scrollTo(app, 0.5);
        const before = await app.evalJS<{ w: number; fallbacks: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    w: el.clientWidth,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
  };
})()`,
        );
        expect(before.w).toBeGreaterThan(300);

        // Drive several width changes in quick succession — a splitter
        // drag's shape. Each write must actually move the scroller's
        // box (the scroller is sized by its pane, so pin it with an
        // explicit width + flex none). Mid-burst, the ledger freeze
        // keeps coverage true, so eviction stays armed instead of
        // suspending per tick; mid-burst geometry is deliberately
        // stale (old width) and is NOT asserted here.
        const setWidth = (w: number): Promise<number> =>
          app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.style.flex = "0 0 auto";
  el.style.width = "${w}px";
  return el.clientWidth;
})()`);
        const burstWidths = [
          before.w - 40,
          before.w - 80,
          before.w - 120,
          before.w - 60,
        ];
        let lastClientWidth = before.w;
        for (const w of burstWidths) {
          lastClientWidth = await setWidth(w);
        }
        const midBurst = await app.evalJS<{ active: boolean; w: number }>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return { active: el.hasAttribute("data-evict-active"), w: el.clientWidth };
})()`,
        );
        // `style.width` is border-box, so the client width lands a
        // scrollbar short of the CSS value — compare against the
        // final write's own read-back, not the CSS number.
        expect(midBurst.w).toBe(lastClientWidth);
        expect(midBurst.w).toBeLessThan(before.w);
        // The freeze keeps eviction running through the burst.
        expect(midBurst.active).toBe(true);

        // Rest past the settle interval, then let the wipe → full
        // render → re-measure → re-arm cycle complete.
        await app.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return el.hasAttribute("data-evict-active");
})()`,
          { timeoutMs: 20_000, pollMs: 250 },
        );
        await new Promise((r) => setTimeout(r, 1500));

        const settled = await app.evalJS<{
          h: number;
          fallbacks: number;
          active: boolean;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
    active: el.hasAttribute("data-evict-active"),
  };
})()`);
        expect(settled.active).toBe(true);
        // One suspension per resize gesture, not one per tick.
        expect(settled.fallbacks - before.fallbacks).toBeLessThanOrEqual(1);

        // Exactness after settle: the evicted document is the same
        // height the fully-mounted one is at this width.
        await app.evalJS<boolean>(
          `(window.__tug.setTranscriptEvictionDisabled(true), true)`,
        );
        await app.waitForCondition<boolean>(
          `!document.querySelector('${SCROLLER}').hasAttribute("data-evict-active")`,
          { timeoutMs: 20_000, pollMs: 250 },
        );
        await new Promise((r) => setTimeout(r, 1000));
        const full = await app.evalJS<{ h: number }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return { h: el.scrollHeight };
})()`);
        expect(Math.abs(settled.h - full.h)).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a display:none spell round-trips the ledger and scroll geometry",
    async () => {
      const app = await standUp("at0330-hide-show");
      try {
        await scrollTo(app, 0.5);
        const before = await app.evalJS<{
          h: number;
          cells: number;
          fallbacks: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    cells: el.querySelectorAll("[data-tug-list-cell-index]").length,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
  };
})()`);
        expect(before.cells).toBeGreaterThan(0);
        expect(before.cells).toBeLessThan(TURNS * 2);

        // Hide the scroller the way an inactive card tab is hidden. Every
        // observed cell fires a 0×0 ResizeObserver entry, and the width
        // invalidator sees width 0 — both must leave the ledger alone.
        await app.evalJS<boolean>(`(function () {
  document.querySelector('${SCROLLER}').style.display = "none";
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        // While hidden, the held window must not balloon to a full mount.
        const hidden = await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return el.querySelectorAll("[data-tug-list-cell-index]").length;
})()`);
        expect(hidden).toBeLessThan(TURNS * 2);

        await app.evalJS<boolean>(`(function () {
  document.querySelector('${SCROLLER}').style.display = "";
  return true;
})()`);
        // The reveal re-measures; a fixed sleep samples mid-settle and reads a
        // transient height. Wait for the geometry to come back to rest.
        await app.waitForCondition<boolean>(
          `Math.abs(document.querySelector('${SCROLLER}').scrollHeight - ${before.h}) <= 2`,
          { timeoutMs: 8000 },
        );

        const after = await app.evalJS<{
          h: number;
          fallbacks: number;
          evicting: boolean;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    h: el.scrollHeight,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
    evicting: el.hasAttribute("data-evict-active"),
  };
})()`);
        // Geometry survives: zeroed measurements never reached the ledger,
        // and the width invalidator did not wipe it, so the document is the
        // same height it was and eviction re-armed without a suspension.
        expect(Math.abs(after.h - before.h)).toBeLessThanOrEqual(2);
        expect(after.fallbacks).toBe(before.fallbacks);
        expect(after.evicting).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a restore behind a hidden card releases its settle without waiting for reveal",
    async () => {
      // A real resumed session (picker → spawn → replay), with the card
      // hidden for the WHOLE restore. The batch-settle freeze exists to
      // protect visible layouts; a hidden card has none, so the freeze
      // must release while still hidden (0×0 ResizeObserver deliveries
      // are the hidden batch's settle) — otherwise `batchLoading` and
      // the card's save gate stay held until the tab is next shown.
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession(
        "session-transcript-basic",
        "at0330-hidden-restore",
      );
      // Point the picker's recents at ONLY the fixture dir so it never
      // surfaces the live archive (same isolation as the fixture runner's
      // other consumers).
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );
      const app = await launchTugApp({
        testName: "at0330-hidden-restore",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
      });
      try {
        await openFixtureSession(app, seeded);
        // Hide the card the moment Open is clicked — before the session
        // view or its transcript exist — so every phase of the restore
        // (spawn, replay, list mount, measurement) runs behind
        // `display:none`.
        await app.evalJS<boolean>(`(function () {
  var card = document.querySelector('[data-card-id="A"]');
  window.__at0330PrevDisplay = card.style.display;
  card.style.display = "none";
  return true;
})()`);

        // The settle release is observable as the card's one-shot settle
        // callback firing: it clears the freeze and logs
        // `transcript_settle` to the dev log. Wait for that entry while
        // the scroller is still boxless.
        await app.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${FIXTURE_SCROLLER}');
  if (el === null || el.offsetWidth !== 0) return false;
  return window.tugDevLog.getSnapshot().entries.some(function (e) {
    return e.message === "transcript_settle";
  });
})()`,
          { timeoutMs: 60_000, pollMs: 250 },
        );

        const hidden = await app.evalJS<{
          w: number;
          cells: number;
          replaying: boolean;
          anchor: string | null;
        }>(`(function () {
  var el = document.querySelector('${FIXTURE_SCROLLER}');
  var host = document.querySelector('${FIXTURE_TRANSCRIPT}');
  return {
    w: el.offsetWidth,
    cells: el.querySelectorAll("[data-tug-list-cell-index]").length,
    replaying: host.hasAttribute("data-replaying"),
    anchor: el.getAttribute("data-tug-scroll-state"),
  };
})()`);
        // Settled while genuinely hidden, with real mounted rows, and the
        // anchor writer stayed silent — a hidden scroller has no position
        // to serialize, so nothing was written across the hidden span.
        expect(hidden.w).toBe(0);
        expect(hidden.cells).toBeGreaterThan(0);
        expect(hidden.replaying).toBe(false);
        expect(hidden.anchor).toBeNull();

        // Reveal. The 0→real resize refires the cell observer with honest
        // values; the reveal commit's coverage check suspends at most once
        // over the rows left unmeasured, measures them, and re-arms.
        // Restore the card's ORIGINAL inline display (the deck's layout
        // styles live inline on the card element — clearing to "" would
        // clobber them and unconstrain the scroller).
        await app.evalJS<boolean>(`(function () {
  var card = document.querySelector('[data-card-id="A"]');
  card.style.display = window.__at0330PrevDisplay || "";
  return true;
})()`);
        await waitForTranscriptSettled(app);
        await app.waitForCondition<boolean>(
          `!!document.querySelector('${FIXTURE_SCROLLER}[data-evict-active]')`,
          { timeoutMs: 30_000, pollMs: 250 },
        );
        await new Promise((r) => setTimeout(r, 1500));

        const revealed = await app.evalJS<{
          h: number;
          fallbacks: number;
          anchor: string | null;
        }>(`(function () {
  var el = document.querySelector('${FIXTURE_SCROLLER}');
  return {
    h: el.scrollHeight,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
    anchor: el.getAttribute("data-tug-scroll-state"),
  };
})()`);
        // One suspension for the whole reveal, and the anchor writer
        // resumed once the scroller had a real box again.
        expect(revealed.fallbacks).toBeGreaterThanOrEqual(0);
        expect(revealed.fallbacks).toBeLessThanOrEqual(1);
        expect(revealed.anchor).not.toBeNull();

        // A RESUMED session keeps the Z0 strip: it reports the load window
        // ("Turns displayed X of Y" + "Load N more"), and it is the first
        // thing in the scroll content — above the top spacer, never buried
        // by it once the spacer grows for evicted rows.
        const z0 = await app.evalJS<{
          firstSlot: string | null;
          text: string;
        }>(`(function () {
  var el = document.querySelector('${FIXTURE_SCROLLER}');
  // The list renders a sticky top-spacer element as its first child — it
  // carries the top breathing room's height and is list chrome, not scroll
  // content — so "the first thing in the scroll content" is the child after it.
  var kids = Array.prototype.slice.call(el.children).filter(function (k) {
    return !k.classList.contains("tug-list-view-top-spacer");
  });
  var lead = el.querySelector(".tug-list-view-leading");
  return {
    firstSlot: kids.length ? kids[0].getAttribute("data-slot") || kids[0].className : null,
    text: lead ? lead.textContent.replace(/\\s+/g, " ").trim() : "",
  };
})()`);
        expect(z0.firstSlot).toBe("tug-list-view-leading");
        expect(z0.text).toContain("Turns displayed");

        // Exactness: the evicted document matches the fully-mounted one.
        await app.evalJS<boolean>(
          `(window.__tug.setTranscriptEvictionDisabled(true), true)`,
        );
        await app.waitForCondition<boolean>(
          `!document.querySelector('${FIXTURE_SCROLLER}').hasAttribute("data-evict-active")`,
          { timeoutMs: 20_000, pollMs: 250 },
        );
        await new Promise((r) => setTimeout(r, 1000));
        const full = await app.evalJS<number>(
          `document.querySelector('${FIXTURE_SCROLLER}').scrollHeight`,
        );
        expect(Math.abs(revealed.h - full)).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

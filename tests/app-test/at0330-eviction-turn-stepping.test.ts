/**
 * at0330-eviction-turn-stepping.test.ts — the session transcript renders
 * through `evictOffscreen`: rows more than a viewport from the scrollport are
 * UNMOUNTED, their exact measured heights standing in the list's spacers.
 *
 * The mode's whole claim is that this is invisible, so the assertions are
 * about what the user would notice if it weren't:
 *
 * | Test                | What would break without it                          |
 * |---------------------|------------------------------------------------------|
 * | turn stepping       | ⌃⌘[/⌃⌘] dead on an evicted transcript (the pager     |
 * |                     | required every cell mounted and bailed on the first   |
 * |                     | unmounted row)                                        |
 * | hide/show ledger    | a `display:none` spell (an inactive card tab) firing  |
 * |                     | 0×0 ResizeObserver entries into the ledger and wiping |
 * |                     | it via the width invalidator — scroll geometry then   |
 * |                     | collapses and the position snaps until rows re-measure|
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
 * `tug-list-view.tsx` and `session-card-transcript.tsx` stand at their
 * accepted fan-out, so one at0330-eviction file names each (reflow and
 * hidden-restore) and the rest are found through the list's internals.
 *
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 */

import { describe, expect, test } from "bun:test";

import {
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TURNS,
  scrollTo,
  settleOn,
  standUp,
} from "./eviction-fixture";

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — turn stepping", () => {
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
        // (keybinding-map.ts, ⌃⌘[ → PREVIOUS_TURN), read by the responder
        // chain's document-level CAPTURE listener. Two other drives were
        // tried and are wrong: `dispatchControlAction` registers key-card
        // adapters for a fixed list that excludes the turn steps (silent
        // no-op), and a native key needs the window to be key, which a
        // background app-test window is not. Dispatching the KeyboardEvent
        // on `document` enters the same capture listener a real chord does.
        const chord = (code: string, key: string): Promise<void> =>
          app.evalJS<void>(`(function () {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)},
    ctrlKey: true, metaKey: true,
    bubbles: true, cancelable: true, composed: true,
  }));
})()`);
        // A press has landed once the scroller has left `from`, an entry top
        // is flush with the scrollport top (or the press clamped at the
        // bottom), and the offset has held still across two polls — an
        // estimated jump's post-commit correction moves it again first.
        const landed = (from: number): Promise<boolean> =>
          settleOn(
            app,
            `(function () {
  var el = document.querySelector('${SCROLLER}');
  var box = el.getBoundingClientRect();
  var flush = 9999;
  el.querySelectorAll("[data-tug-list-cell-index]").forEach(function (c) {
    flush = Math.min(flush, Math.abs(c.getBoundingClientRect().top - box.top));
  });
  var atMax = el.scrollTop >= el.scrollHeight - el.clientHeight - 2;
  var top = el.scrollTop;
  var still = window.__at0330StepTop === top;
  window.__at0330StepTop = top;
  return top !== ${from} && (flush <= 3 || atMax) && still;
})()`,
            { timeoutMs: 3000, pollMs: 50 },
          );
        const stepUp = (): Promise<void> => chord("BracketLeft", "[");
        const stepDown = (): Promise<void> => chord("BracketRight", "]");

        // Stepping up off the pinned live edge is the user's own gesture.
        const atBottom = await readState();
        await stepUp();
        await landed(atBottom.top);
        const afterFirst = await readState();
        if (afterFirst.top >= atBottom.top) {
          throw new Error(
            `stepping up off the live bottom did not move (${atBottom.top} → ${afterFirst.top}, mounted ${afterFirst.mounted})`,
          );
        }

        const tops: number[] = [afterFirst.top];
        const trace: string[] = [];
        for (let i = 0; i < 7; i += 1) {
          await stepUp();
          await landed(tops[tops.length - 1]!);
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
          if (tops[i]! >= tops[i - 1]!) {
            throw new Error(
              `press ${i} did not travel up (${tops[i - 1]} → ${tops[i]}); trace: ${trace.join(" | ")}`,
            );
          }
        }

        // And forward again: each press travels downward.
        const downTops: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          await stepDown();
          await landed(downTops.length ? downTops[downTops.length - 1]! : tops[tops.length - 1]!);
          downTops.push((await readState()).top);
        }
        expect(downTops[0]).toBeGreaterThan(tops[tops.length - 1]!);
        for (let i = 1; i < downTops.length; i += 1) {
          expect(downTops[i]).toBeGreaterThan(downTops[i - 1]!);
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
});

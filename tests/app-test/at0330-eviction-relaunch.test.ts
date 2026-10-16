/**
 * at0330-eviction-relaunch.test.ts — the session transcript renders through
 * `evictOffscreen`: rows more than a viewport from the scrollport are
 * UNMOUNTED, their exact measured heights standing in the list's spacers.
 *
 * The mode's whole claim is that this is invisible, so the assertions are
 * about what the user would notice if it weren't:
 *
 * | Test                | What would break without it                          |
 * |---------------------|------------------------------------------------------|
 * | relaunch heights    | a relaunched transcript draining every row it had     |
 * |                     | measured before the quit, instead of windowing        |
 * |                     | against the persisted heights from its first commit   |
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
 * `tug-list-view.tsx` and `session-card-transcript.tsx` stand at their
 * accepted fan-out, so one at0330-eviction file names each (reflow and
 * hidden-restore) and the rest are found through the list's internals.
 *
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-persist.ts
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  SCROLLER,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  TURNS,
  scrollTo,
  seedTurns,
  standUp,
} from "./eviction-fixture";

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — relaunch", () => {
  test(
    "a relaunched transcript windows from its first commit",
    async () => {
      // Two processes. In test mode a relaunched card's bag goes back in
      // through `seedDeckState`'s `cardStates` whether or not it went by
      // disk, so phase A takes the bag in-page, as at0535 does, and phase B
      // re-injects it; the payload's tugbank round trip is at0728's relaunch
      // case. The relaunch has the cold path's shape: the turns arrive behind
      // a hidden card, with no box to measure them in, and the reveal is the
      // list's first look at them. Without persisted heights every row would
      // be pending there and drain; with them, every row windows against its
      // phase-A height at once.
      type Bag = {
        components?: Record<string, { entries?: unknown[] }> | null;
        regionScroll?: Record<string, { x: number; y: number; meta?: unknown }> | null;
      };
      const deck = sessionCardShape({ width: 900, height: 760 });
      /** The row under the scrollport top and its top edge's offset from it. */
      const readTopRow = (app: App): Promise<{ index: number; offset: number }> =>
        app.evalJS(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var top = el.getBoundingClientRect().top;
  var best = null;
  el.querySelectorAll("[data-tug-list-cell-index]").forEach(function (c) {
    var r = c.getBoundingClientRect();
    if (r.bottom <= top + 0.5) return;
    var i = Number(c.getAttribute("data-tug-list-cell-index"));
    if (best === null || i < best.index) best = { index: i, offset: r.top - top };
  });
  return best;
})()`);
      {
        // ── Phase A: seed, scroll to mid-transcript, take the bag. ──
        let phaseA: { index: number; offset: number };
        let bag: Bag;
        {
          const app = await standUp("at0330-relaunch-A");
          try {
            await scrollTo(app, 0.5);
            await app.waitForCondition<boolean>(
              `!document.querySelector('${SCROLLER}').hasAttribute("data-evict-stale")`,
              { timeoutMs: 10_000, pollMs: 100 },
            );
            await new Promise((r) => setTimeout(r, 500));
            phaseA = await readTopRow(app);
            bag = await app.evalJS<Bag>(`(function () {
  window.tugdeck.saveState();
  return JSON.parse(JSON.stringify(window.__tug.getCardStateBag("A")));
})()`);
          } finally {
            await app.close();
          }
        }

        // ── Phase A assertion: the heights are in the bag beside the scroll. ──
        const heightsKey = Object.keys(bag.components ?? {}).find((k) =>
          k.endsWith("session-card-transcript-heights"),
        );
        expect(heightsKey).toBeDefined();
        const recorded = bag.components![heightsKey!]!.entries?.length ?? 0;
        expect(recorded).toBeGreaterThan(TURNS);
        const saved = bag.regionScroll?.["session-card-transcript"];
        expect(saved).toBeDefined();

        // ── Phase B: re-inject the bag, re-seed behind a hidden card, reveal. ──
        {
          const app = await launchTugApp({ testName: "at0330-relaunch-B" });
          try {
            await app.enableDeckTrace(true);
            // Only the axes under test go back in: the heights and the scroll.
            // The card's own content would have it resume the phase-A session,
            // which this process does not have; the turns are re-seeded below.
            await app.seedDeckState({
              state: deck,
              cardStates: { A: { components: bag.components, regionScroll: bag.regionScroll } },
              focusCardId: "A",
            });
            await app.waitForCondition<boolean>(
              `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            );
            await app.bindSession("A", { tugSessionId: SID });
            await app.awaitEngineReady("A", { timeoutMs: 20_000 });
            await app.evalJS<boolean>(`(function () {
  var card = document.querySelector('[data-card-id="A"]');
  window.__at0330PrevDisplay = card.style.display;
  card.style.display = "none";
  return true;
})()`);
            note(
              "relaunch: live bag heights before the turns arrive",
              String(
                await app.evalJS<number>(`(function () {
  window.tugdeck && window.tugdeck.saveState && window.tugdeck.saveState();
  var bag = window.__tug.getCardStateBag("A");
  var c = (bag && bag.components) || {};
  var k = Object.keys(c).filter(function (x) { return /session-card-transcript-heights$/.test(x); })[0];
  return k === undefined || !c[k] ? -1 : (c[k].entries || []).length;
})()`),
              ),
            );
            await seedTurns(app, TURNS);
            const fallbacksBefore = await app.evalJS<number>(
              `Number(document.querySelector('${SCROLLER}').getAttribute("data-evict-fallbacks") || "0")`,
            );
            const atReveal = await app.evalJS<{ stale: string | null }>(`(function () {
  var card = document.querySelector('[data-card-id="A"]');
  card.style.display = window.__at0330PrevDisplay || "";
  return { stale: document.querySelector('${SCROLLER}').getAttribute("data-evict-stale") };
})()`);
            const firstSample = await app.evalJS<{ stale: string | null }>(
              `({ stale: document.querySelector('${SCROLLER}').getAttribute("data-evict-stale") })`,
            );
            note(
              `relaunch: ${recorded} heights recorded; data-evict-stale at the reveal ` +
                `${atReveal.stale ?? "absent"}, at the first sample after it ${firstSample.stale ?? "absent"}`,
            );
            // Every row was seeded fresh at an unchanged width: none is pending.
            expect(atReveal.stale).toBeNull();
            expect(firstSample.stale).toBeNull();

            await app.waitForCondition<boolean>(
              `!!document.querySelector('${SCROLLER}[data-evict-active]')`,
              { timeoutMs: 30_000, pollMs: 250 },
            );
            // A send pins the reader to the bottom, and so does a reveal of a
            // list that was following, so the restore is replayed once the
            // turns are in and the list has a box: CardHost's own cold-boot
            // event, carrying the saved anchor. It resolves against the
            // seeded heights, so it lands where phase A was without a drain.
            await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.dispatchEvent(new CustomEvent("tug-region-scroll-set", {
    detail: ${JSON.stringify({ top: saved!.y, left: saved!.x, meta: saved!.meta })},
    cancelable: true,
    bubbles: false,
  }));
  return true;
})()`);
            await new Promise((r) => setTimeout(r, 1500));
            const after = await app.evalJS<{ peak: number; fallbacks: number }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    peak: Number(el.getAttribute("data-evict-peak") || "-1"),
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
  };
})()`);
            const phaseB = await readTopRow(app);
            note(
              `relaunch: peak mounted ${after.peak}, fallbacks ${fallbacksBefore} → ${after.fallbacks}; ` +
                `top row ${phaseA.index} at ${phaseA.offset.toFixed(2)} → ${phaseB.index} at ${phaseB.offset.toFixed(2)}`,
            );
            expect(after.peak).toBeGreaterThan(0);
            expect(after.peak).toBeLessThan(TURNS);
            expect(after.fallbacks - fallbacksBefore).toBe(0);
            expect(phaseB.index).toBe(phaseA.index);
            expect(Math.abs(phaseB.offset - phaseA.offset)).toBeLessThanOrEqual(1);
          } finally {
            await app.close();
          }
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

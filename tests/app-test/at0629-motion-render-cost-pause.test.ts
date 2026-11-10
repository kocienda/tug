/**
 * at0629-motion-render-cost-pause.test.ts — pausing every loop in the bench
 * pauses every one of them, and the deck still measures its frame.
 *
 * The **pause leg** is the third reading of the render-cost claim and the one
 * that says the cost belongs to the loops: three hundred `pulsing-dot` glyphs
 * breathing on the bench card are priced quiet (`quietBench`), then
 * every animation inside the bench is paused through `__tugMotion.pause`, the
 * frame is priced again, and the loops are resumed. What is asserted is the
 * switch itself: every long-running loop the census counts inside the bench
 * is paused, the bench's play states read `paused` and nothing else, and the
 * resume brings back exactly what was paused. The paused reading is noted
 * beside the breathing one — the floor the quiet reading stands on.
 *
 * The paused count is derived from what `list()` reports long-running inside
 * the bench, never written down: three loops per glyph is what the CSS says
 * today, and a literal 900 would pin that reading into a test about neither
 * the count nor the CSS.
 *
 * ## Occlusion
 *
 * An occluded window suspends `requestAnimationFrame` outright, so every
 * reading would hang rather than read high. The launch is `visible: true`,
 * which keeps the web views rendering under cover without taking the screen,
 * and each reading is taken behind a bounded wait that fails saying so.
 *
 * ## The cut
 *
 * Cut from `at0629-motion-render-cost-stream`, which ran 16 s of its 17 s
 * file deadline with this leg last and lost its final reading to the cut
 * whenever the run was slower than its best. The two share the bench's
 * prologue (`quietBench` in `motion-render-cost-fixture.ts`).
 *
 * @family at0629-motion-render-cost
 *
 * @covers tugdeck/src/lib/motion-guard/registry.ts
 * @covers tugdeck/src/lib/motion-guard/render-cost-probe.ts
 * @covers tugdeck/src/lib/motion-guard/index.ts
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.css
 * @covers tugdeck/src/components/tugways/cards/gallery-motion-bench.tsx
 *
 * @visible — the probe measures a deck that is actually rendering, so the
 * launch asks for a rendering viewport (`visible: true`), not the screen.
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { BENCH, BENCH_LOOPS, SHOULD_RUN, TEST_TIMEOUT_MS, cost, quietBench } from "./motion-render-cost-fixture";

describe.skipIf(!SHOULD_RUN)("at0629 — the deck's own render cost, paused", () => {
  test(
    "the pause leg pauses every loop in the bench, and the resume brings back each one",
    async () => {
      const app = await launchTugApp({
        testName: "at0629-motion-render-cost-pause",
        visible: true,
      });
      try {
        const { quiet } = await quietBench(app);
        const longRunningInBench = await app.body("B").evalJS<number>(
          `window.__tugMotion.list({ within: ${JSON.stringify(BENCH)} }).longRunning`,
        );
        const paused = await app.body("B").evalJS<number>(
          `window.__tugMotion.pause(${JSON.stringify(BENCH_LOOPS)}).paused`,
        );
        const pausedStates = await app.body("B").evalJS<string[]>(
          `Array.from(new Set(
             window.__tugMotion.list({ within: ${JSON.stringify(BENCH)} })
               .entries.map(function (e) { return e.playState; })
           ))`,
        );
        const pausedCost = await cost(app.body("B"), "__at0629paused", 60);
        const resumed = await app.body("B").evalJS<number>(
          `window.__tugMotion.resume(${JSON.stringify(BENCH_LOOPS)}).resumed`,
        );
        note("at0629 pause leg", {
          longRunningInBench,
          paused,
          resumed,
          pausedStates,
          pausedP50: pausedCost.p50,
          breathingP50: quiet.p50,
        });
        expect(paused).toBeGreaterThanOrEqual(longRunningInBench);
        expect(pausedStates).toEqual(["paused"]);
        expect(resumed).toBe(paused);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * AT0631: the zoom rectangles between the update pill and the UpdateTug wizard.
 *
 * ## What this pins
 *
 * Clicking the pill grows a run of classic Mac OS outline rectangles from the
 * pill's rect down to the wizard's panel, and closing the wizard shrinks the
 * same run back up to the pill. The claim is about *motion*, and a motion claim
 * read from before-and-after states is not a claim about motion at all — a run
 * that planted every rectangle at the destination, or planted them in the wrong
 * order, or never planted them and left the panel to appear on its own, would
 * pass every end-state assertion the feature could carry. So this file
 * **samples**: it starts a `requestAnimationFrame` census, dispatches the
 * gesture in the same task, and reads the overlay every frame.
 *
 * Two cases, which are [B10]'s two:
 *
 * 1. **The sampled case, at timing 1.** The rectangles' geometry runs
 *    monotonically from the pill's rect to the panel's, none remain once the
 *    panel is visible, and the reverse holds on Close.
 * 2. **The reduced case, at timing 0.** No rectangle is ever planted, and the
 *    panel is fully visible on the first frame it is committed in, no later
 *    than the second frame after the click. This is the half that keeps [B09]
 *    honest: the run is decoration, the reveal is CSS keyed on `data-zoom`, and
 *    a run that plants nothing must also leave the attribute off — otherwise
 *    the delay applies with no rectangles to justify it and the surface simply
 *    arrives late.
 *
 *    Why the second frame and not the first: the click is a pointer gesture,
 *    and the gesture scope (`lib/gesture-scope.ts`) holds every React commit
 *    past the gesture's first painted frame, so the census's frame 0 — the
 *    rendering update of the click's own task — always predates the wizard's
 *    mount. That is a one-frame hold by design. A delay standing in for the
 *    run is a run's length (200 ms, about twelve frames), so the bar still
 *    catches it.
 *
 * The timing scale is **set by this file rather than inherited**, on both cases,
 * so neither depends on what the harness happens to default to.
 *
 * What is deliberately not pinned here is the look — trail depth, the ease
 * curve's bunching, stroke weight. Those are taste, they are settled by eye, and
 * an assertion on any of them would turn a tuning pass into a test edit. What is
 * pinned is the shape a tuning pass must not break: monotonic travel, a run that
 * cleans up after itself, and a reduced-motion path that plants nothing.
 *
 * `[B##]` and `[F##]` are the `update-pill-zoom-rects` arc's brief.
 *
 * @covers tugdeck/src/components/chrome/zoom-rects.ts
 * @covers tugdeck/src/components/chrome/zoom-rects.css
 * @covers tugdeck/src/components/chrome/update-pill.tsx
 * @covers tugdeck/src/components/chrome/update-pill.css
 * @covers tugdeck/src/components/tugways/update-tug.tsx
 * @covers tugdeck/src/components/tugways/update-tug.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** How long each census runs. The whole run is 200ms and the panel's fade ends
 *  at 350ms, so this is comfortably past the last thing either could do. */
const CENSUS_MS = 1200;

/**
 * How near the destination the leading rectangle has to get to count as
 * arrived. A couple of pixels of rounding, and no more: the last rectangle is
 * planted at the destination's measured rect exactly, so anything wider than
 * this is a coordinate the run got wrong rather than a rounding wobble.
 */
const ARRIVAL_PX = 2;

/** The pressable part of the pill. */
const PILL = `[data-testid="update-pill"]`;
/** The painted pill itself — the box the zoom measures and marks. */
const PILL_BOX = `.tugx-update-pill`;
/** The wizard's panel. Absent from the DOM entirely while it is closed. */
const WIZARD = `[data-testid="update-tug"]`;
/** The wizard's one bottom button; Close on a non-terminal stage. */
const CLOSE = `[data-testid="update-tug-close"]`;
/** The zoom layer. Its children are the rectangles, and it is removed with them. */
const LAYER = `[data-slot="zoom-rects"]`;

/** One frame of the census. */
interface Sample {
  /** ms since the gesture. */
  t: number;
  /** How many rectangles stand in the layer, lit or not. */
  planted: number;
  /** The widest rectangle currently painting anything, or -1 when none is. */
  maxWidth: number;
  /** The narrowest rectangle currently painting anything, or -1 when none is. */
  minWidth: number;
  /** How many are painting anything. */
  litCount: number;
  /** The panel's computed opacity, or -1 when it is not in the DOM. */
  panelOpacity: number;
  /** The pill's computed opacity, or -1 when it is not in the DOM. */
  pillOpacity: number;
}

/** A measured box. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function boxOf(app: App, selector: string): Promise<Box | null> {
  return app.evalJS<Box | null>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return null;
       var r = el.getBoundingClientRect();
       return { left: r.left, top: r.top, width: r.width, height: r.height };
     })()`,
  );
}

async function elementCount(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

/**
 * Run one census: start the per-frame sampler, dispatch the click on `selector`
 * **in the same task**, and hand back every frame.
 *
 * The gesture goes inside the same `evalJS` as the sampler on purpose. A click
 * driven over the bridge is a separate round trip, and the frames between the
 * two are exactly the frames the run's first rectangles paint in — so a census
 * armed by one call and fired by another is a census that reliably misses the
 * beginning of the thing it exists to watch.
 *
 * A rectangle counts as *lit* at computed opacity above 0.01. Every rectangle is
 * planted in one frame and holds at the stylesheet's `opacity: 0` until its own
 * delay elapses, so the lit set is the run's actual leading edge and trail, not
 * the set of elements that happen to exist.
 */
async function census(
  app: App,
  selector: string,
  wait: (ms: number) => Promise<void>,
): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
       window.__at0631 = { samples: [] };
       var t0 = performance.now();
       var tick = function () {
         var layer = document.querySelector(${JSON.stringify(LAYER)});
         var rects = layer === null
           ? []
           : Array.prototype.slice.call(layer.children);
         var maxWidth = -1;
         var minWidth = -1;
         var litCount = 0;
         for (var i = 0; i < rects.length; i += 1) {
           var o = parseFloat(getComputedStyle(rects[i]).opacity);
           if (!(o > 0.01)) continue;
           litCount += 1;
           var w = rects[i].getBoundingClientRect().width;
           if (w > maxWidth) maxWidth = w;
           if (minWidth < 0 || w < minWidth) minWidth = w;
         }
         var panel = document.querySelector(${JSON.stringify(WIZARD)});
         var pill = document.querySelector(${JSON.stringify(PILL_BOX)});
         window.__at0631.samples.push({
           t: performance.now() - t0,
           planted: rects.length,
           maxWidth: maxWidth,
           minWidth: minWidth,
           litCount: litCount,
           panelOpacity: panel === null
             ? -1
             : parseFloat(getComputedStyle(panel).opacity),
           pillOpacity: pill === null
             ? -1
             : parseFloat(getComputedStyle(pill).opacity),
         });
         if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
       };
       requestAnimationFrame(tick);
       document.querySelector(${JSON.stringify(selector)}).click();
       return null;
     })()`,
  );
  await wait(CENSUS_MS + 400);
  return app.evalJS<Sample[]>(`window.__at0631.samples`);
}

/**
 * The three readings that explain a run that did not happen: the two global
 * multipliers the module early-returns on, and whether the arriving surface
 * was marked. A census with no rectangles in it is one of these, and reading
 * them costs nothing next to guessing.
 */
async function conditions(
  app: App,
  arrived: string,
): Promise<{ motion: number; timing: number; marked: boolean }> {
  return app.evalJS(
    `(function () {
       var root = getComputedStyle(document.documentElement);
       var el = document.querySelector(${JSON.stringify(arrived)});
       return {
         motion: parseFloat(root.getPropertyValue("--tug-motion")),
         timing: parseFloat(root.getPropertyValue("--tug-timing")),
         marked: el !== null && el.hasAttribute("data-zoom"),
       };
     })()`,
  );
}

/** Set the global timing scale, and read back what the deck computes. */
async function setTiming(app: App, value: number): Promise<number> {
  return app.evalJS<number>(
    `(function () {
       document.documentElement.style.setProperty("--tug-timing", "${value}");
       return parseFloat(
         getComputedStyle(document.documentElement).getPropertyValue("--tug-timing"),
       );
     })()`,
  );
}

/**
 * The leading edge's width, frame by frame, over the frames where anything is
 * lit.
 *
 * Which extreme *is* the leading edge depends on which way the run travels, and
 * that is the whole reason both are recorded. Growing toward the panel, the
 * newest rectangle is the widest lit one and the trail behind it is narrower;
 * shrinking home to the pill, the newest is the narrowest and the trail is
 * wider. Reading the same extreme both ways reads the trail one of those times,
 * and a trail does not move — which is a green assertion over a run that never
 * travelled.
 *
 * Either way it is read from *geometry* rather than from the rectangles' own
 * index attribute: an index is the module's own bookkeeping, and a run that
 * planted its boxes in the wrong places while numbering them correctly is
 * exactly the defect this is for.
 */
function leadingWidths(samples: Sample[], growing: boolean): number[] {
  return samples
    .filter((s) => s.litCount > 0)
    .map((s) => (growing ? s.maxWidth : s.minWidth));
}

/** The largest backwards step in a series, 0 when it never goes backwards. */
function worstRegression(series: number[]): number {
  let worst = 0;
  for (let i = 1; i < series.length; i += 1) {
    const back = series[i - 1] - series[i];
    if (back > worst) worst = back;
  }
  return worst;
}

/**
 * The leading edge's travel, cut at the frame it arrives on.
 *
 * The run does not end when the leading edge lands — the trail is still
 * draining behind it for another two slots, and the leading rectangle is the
 * FIRST of those to go dark, because it is also the first whose own fade
 * started. So the frames after arrival read the trail, and the trail sits
 * behind the destination by construction. Measuring travel across them would
 * be measuring the run's own tail and calling it a retreat.
 *
 * Returns `null` when the edge never arrives, which is the failure worth
 * reporting on its own.
 */
function travelToArrival(
  series: number[],
  destination: number,
  tolerance: number,
): number[] | null {
  const arrived = series.findIndex(
    (w) => Math.abs(w - destination) <= tolerance,
  );
  return arrived < 0 ? null : series.slice(0, arrived + 1);
}

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
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
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** A snapshot in the shape `UpdateSnapshot.jsonObject` emits, host-side. */
function snapshot(stage: string): Record<string, unknown> {
  return {
    stage,
    version: "0.9.0",
    build: "900",
    currentVersion: "0.8.10",
    releaseNotes: null,
    releaseNotesFailed: false,
    userInitiated: false,
    percent: null,
    receivedBytes: 0,
    expectedBytes: 0,
    message: "",
    cancellable: false,
    revealCount: 0,
  };
}

describe.skipIf(!SHOULD_RUN)("AT0631: zoom rectangles between the pill and the wizard", () => {
  test(
    "the rectangles travel monotonically both ways and clean up after themselves, and timing zero plants none",
    async () => {
      const app = await launchTugApp({ testName: "at0631-update-pill-zoom-rects" });
      const wait = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.waitForCondition<boolean>(
          `typeof window.__tugBridge !== "undefined"
             && typeof window.__tugBridge.onUpdateState === "function"`,
          { timeoutMs: 20_000 },
        );

        // No action recorder is installed, and that is a claim rather than an
        // omission: nothing this file presses posts one. The pill's label and
        // the wizard's Close on a non-terminal stage both post nothing, and no
        // row CTA is ever touched — so no click here can reach Sparkle.
        await app.evalJS<null>(
          `(window.__tugBridge.onUpdateState(${JSON.stringify(snapshot("available"))}), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PILL)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // ---- 1. The zoom out: pill → panel, sampled -----------------------
        const timingOn = await setTiming(app, 1);
        expect(timingOn, "the timing scale is on for the sampled case").toBe(1);

        const pillBox = await boxOf(app, PILL_BOX);
        expect(pillBox, "the pill is measurable before the click").not.toBeNull();

        const out = await census(app, PILL, wait);
        const outWhy = await conditions(app, WIZARD);
        note(
          "at0631 out",
          `${out.length} frames, ${out.filter((s) => s.litCount > 0).length} with rectangles lit,` +
            ` max planted ${Math.max(...out.map((s) => s.planted))};` +
            ` motion=${outWhy.motion} timing=${outWhy.timing} data-zoom=${outWhy.marked}`,
        );
        expect(
          out.length,
          "the census caught frames at all — a stalled rAF is an occluded window, not a passing run",
        ).toBeGreaterThan(5);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(WIZARD)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const panelBox = await boxOf(app, WIZARD);
        expect(panelBox, "the panel is measurable after the click").not.toBeNull();
        if (pillBox === null || panelBox === null) throw new Error("unmeasurable");

        const outWidths = leadingWidths(out, true);
        expect(
          outWidths.length,
          "rectangles were lit on the way out",
        ).toBeGreaterThan(2);
        expect(
          Math.max(...out.map((s) => s.planted)),
          "the whole run was planted in one frame",
        ).toBeGreaterThan(1);
        note(
          "at0631 out travel",
          `pill=${pillBox.width.toFixed(1)} → panel=${panelBox.width.toFixed(1)};` +
            ` per-frame min/max ${out
              .filter((s) => s.litCount > 0)
              .map((s) => `${s.minWidth.toFixed(0)}/${s.maxWidth.toFixed(0)}`)
              .join(" ")}`,
        );

        // It runs the whole way: the leading edge starts at the pill's own
        // width and arrives on the panel's, rather than stopping somewhere
        // short of it — which is what a box measured through the panel's
        // entrance transform would do, and did.
        const outTravel = travelToArrival(outWidths, panelBox.width, ARRIVAL_PX);
        expect(
          outTravel,
          "the leading rectangle arrives on the panel's own edge",
        ).not.toBeNull();
        if (outTravel === null) throw new Error("no arrival");
        expect(
          Math.abs(outWidths[0] - pillBox.width),
          "the first rectangle is the pill's own box",
        ).toBeLessThan(ARRIVAL_PX);
        // Monotonic, to within a rounding wobble: the leading rectangle only
        // ever grows toward the panel. A run that tweened, or that lit its
        // frames out of order, regresses here.
        expect(
          worstRegression(outTravel),
          "the leading rectangle never travels back toward the pill",
        ).toBeLessThan(1);

        // Nothing is left standing once the panel is up. The panel's reveal is
        // delayed by the run's own length, so "visible" and "the run is over"
        // are the same instant by construction — which is the whole point of
        // [B06], and what this asserts rather than assumes.
        const outArrived = out.findIndex((s) => s.panelOpacity >= 0.99);
        expect(outArrived, "the panel became visible during the census").toBeGreaterThan(-1);
        expect(
          out.slice(outArrived).every((s) => s.planted === 0),
          "no rectangle outlives the panel's arrival",
        ).toBe(true);
        expect(
          await elementCount(app, `${LAYER} > *`),
          "the layer is empty once the run has landed",
        ).toBe(0);

        // ---- 2. The zoom home: panel → pill, sampled ----------------------
        const back = await census(app, CLOSE, wait);
        note(
          "at0631 home",
          `${back.length} frames, ${back.filter((s) => s.litCount > 0).length} with rectangles lit`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PILL)}) !== null`,
          { timeoutMs: 10_000 },
        );

        const backWidths = leadingWidths(back, false);
        expect(
          backWidths.length,
          "rectangles were lit on the way home",
        ).toBeGreaterThan(2);
        note(
          "at0631 home travel",
          `lead ran ${backWidths[0].toFixed(1)} → ${backWidths[backWidths.length - 1].toFixed(1)};` +
            ` per-frame min/max ${back
              .filter((s) => s.litCount > 0)
              .map((s) => `${s.minWidth.toFixed(0)}/${s.maxWidth.toFixed(0)}`)
              .join(" ")}`,
        );
        // The mirror of the claim above: reversed, so the regression to look
        // for is growth.
        const backTravel = travelToArrival(backWidths, pillBox.width, ARRIVAL_PX);
        expect(
          backTravel,
          "the leading rectangle arrives on the pill's own box",
        ).not.toBeNull();
        if (backTravel === null) throw new Error("no arrival");
        expect(
          Math.abs(backWidths[0] - panelBox.width),
          "the first rectangle home is the panel's own edge",
        ).toBeLessThan(ARRIVAL_PX);
        expect(
          worstRegression(backTravel.map((w) => -w)),
          "the leading rectangle never travels back toward the panel",
        ).toBeLessThan(1);

        const backArrived = back.findIndex((s) => s.pillOpacity >= 0.99);
        expect(backArrived, "the pill became visible during the census").toBeGreaterThan(-1);
        expect(
          back.slice(backArrived).every((s) => s.planted === 0),
          "no rectangle outlives the pill's return",
        ).toBe(true);

        // ---- 3. Timing zero plants nothing, and delays nothing [B09] ------
        const timingOff = await setTiming(app, 0);
        expect(timingOff, "the timing scale is off for the reduced case").toBe(0);

        const zero = await census(app, PILL, wait);
        note("at0631 zero", `${zero.length} frames sampled at timing 0`);
        expect(
          zero.length,
          "the census caught frames at timing zero too",
        ).toBeGreaterThan(5);
        expect(
          zero.every((s) => s.planted === 0),
          "no rectangle is ever planted when the timing scale is zero",
        ).toBe(true);

        // The panel is up by the second frame after the click — the first is
        // the gesture scope's held frame (see the header) — with no delay
        // standing in for the run that did not happen. If `data-zoom` were set
        // anyway, the reveal would be held off for a run's length and its
        // mount frame would read 0.
        const firstPanel = zero.findIndex((s) => s.panelOpacity >= 0);
        expect(firstPanel, "the panel mounted during the census").toBeGreaterThanOrEqual(0);
        expect(
          firstPanel,
          "the panel mounted no later than the gesture scope's one held frame",
        ).toBeLessThanOrEqual(1);
        expect(
          zero[firstPanel].panelOpacity,
          "the panel is fully visible on the first frame it is committed in",
        ).toBe(1);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(WIZARD)}).hasAttribute("data-zoom")`,
          ),
          "a run that planted nothing marks nothing",
        ).toBe(false);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0631] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

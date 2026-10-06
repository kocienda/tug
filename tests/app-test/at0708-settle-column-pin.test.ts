/**
 * at0708-settle-column-pin.test.ts — no transcript scrolls off its bottom in
 * a split or a stack.
 *
 * Putting a card into a split, or taking it out of one, changes the interior
 * geometry of the column's members, and a transcript that was following its
 * bottom must still be at its bottom on every frame the reader can see and at
 * the land. The pin used to ride the list view's container `ResizeObserver`;
 * the sealed-motion arc made that delivery gate-held, so a pin that rides it
 * lands after the motion, and the reader sees the transcript stand 441 px off
 * its bottom for the length of the motion or for three frames at the land
 * (`briefs/column-pin-at-the-set-up` — this file is its [B05]).
 *
 * The instrument is a per-animation-frame recorder armed BEFORE the gesture
 * is dispatched: on every tick it reads each shown frame's rect, its still
 * crossing mark, its card root's `data-still-anchor`, and its `.tug-list-view`
 * scroller's distance from bottom, and works out which frames are fully
 * covered by a higher-z frame — the cover choreography's own claim that a
 * covered member is not seen. The bar: a scroller that was following before
 * the gesture reads zero distance on every tick its frame is visible, and at
 * the land.
 *
 * Three findings, three tests, one launch per arm. The sampling is done once
 * in `beforeAll` — a split then a stack of slot 0 — and each finding is
 * asserted by its own test so a red on one does not hide the others, and so
 * the three doors that answer them can each turn one line green:
 *
 * - [F01] split: the revealed member is cut to its tile at the commit and
 *   left off its bottom for the whole motion, pinned only at the gate's
 *   release ([B02]: a settled still crossing at its tile).
 * - [F02] split: the survivor's shrink lands off its bottom and pins three
 *   to four frames later ([B03]: the land pays like the settled door).
 * - [F03] stack: the held member is laid out at the full run before its tile
 *   hold goes on, and the browser clamps its scroll ([B04]: the held member
 *   opens its still crossing at arm).
 *
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note } from "./_harness";
import type { App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  BAR_TIMEOUT_MS,
  SHOULD_RUN,
  SHOWN_FRAMES,
  type SettleLandRow,
  bandCensus,
  columnBlob,
  home,
  launch,
  settleLandRows,
  traceMark,
  traceWithSettleFrames,
  transcriptArms,
  wait,
} from "./settle-frames-fixture";

const TEST_NAME = "at0708-settle-column-pin";
const ARMS = transcriptArms();

/** Slot 0's two members on the column fixture. */
const REVEALED = "at0622-p1";
const SURVIVOR = "at0622-p2";

/**
 * How far from its bottom a following scroller may read and still count as
 * pinned. Sub-pixel: the findings read 441 px, and a scroller that is
 * genuinely at its bottom reads 0 or a fraction of a pixel of rounding.
 */
const PIN_EPSILON_PX = 1.5;

/** How long the recorder runs after the dispatch: past the land and the gate's release. */
const RECORD_MS = AFTER_LAND_MS + 300;

interface FrameSample {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly height: number;
  readonly z: number;
  /** `data-still-crossing`, or `""`. */
  readonly crossing: string;
  /** `data-still-settled` present. */
  readonly settled: boolean;
  /** The card root's `data-still-anchor`, or `""`. */
  readonly anchor: string;
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  /** `scrollHeight - scrollTop - clientHeight`; `-1` with no scroller. */
  readonly distance: number;
  /** Not fully covered by a shown frame with a higher z-index. */
  readonly visible: boolean;
}

interface Sample {
  /** ms after the recorder armed. */
  readonly t: number;
  readonly settling: boolean;
  readonly beat: string;
  readonly panes: Record<string, FrameSample>;
}

/**
 * The recorder, armed on `requestAnimationFrame` before the dispatch so the
 * first sample is the pre-gesture geometry and every frame of the motion is
 * in the record. Reads are rects and scroll metrics only: a sampler that
 * forced nothing new (every read is against geometry the frame already laid
 * out) is what makes its own reading believable.
 */
const armRecorder = (app: App): Promise<null> =>
  app.evalJS<null>(
    `(function () {
       var samples = [];
       window.__at0708 = samples;
       var t0 = performance.now();
       var tick = function () {
         var canvas = document.querySelector("[data-imposer-settling]");
         var sample = {
           t: performance.now() - t0,
           settling: canvas !== null,
           beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
           panes: {},
         };
         var frames = document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)});
         var rows = [];
         for (var i = 0; i < frames.length; i++) {
           var el = frames[i];
           var r = el.getBoundingClientRect();
           var z = parseInt(getComputedStyle(el).zIndex, 10);
           var root = el.querySelector("[data-slot='session-card']");
           var scroller = el.querySelector(".tug-list-view");
           var row = {
             id: el.getAttribute("data-pane-id"),
             top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height,
             z: isNaN(z) ? 0 : z,
             crossing: el.getAttribute("data-still-crossing") || "",
             settled: el.hasAttribute("data-still-settled"),
             anchor: root === null ? "" : (root.getAttribute("data-still-anchor") || ""),
             scrollTop: scroller === null ? -1 : scroller.scrollTop,
             clientHeight: scroller === null ? -1 : scroller.clientHeight,
             scrollHeight: scroller === null ? -1 : scroller.scrollHeight,
             distance: scroller === null ? -1 :
               scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
             visible: true,
           };
           rows.push(row);
         }
         for (var a = 0; a < rows.length; a++) {
           var me = rows[a];
           if (me.height <= 0) { me.visible = false; continue; }
           for (var b = 0; b < rows.length; b++) {
             if (a === b) continue;
             var other = rows[b];
             if (other.z <= me.z) continue;
             if (other.left <= me.left + 0.5 && other.top <= me.top + 0.5 &&
                 other.right >= me.right - 0.5 && other.bottom >= me.bottom - 0.5) {
               me.visible = false;
               break;
             }
           }
           sample.panes[me.id] = me;
         }
         samples.push(sample);
         if (performance.now() - t0 < ${RECORD_MS}) {
           window.__at0708Raf = requestAnimationFrame(tick);
         }
       };
       window.__at0708Raf = requestAnimationFrame(tick);
       return null;
     })()`,
  );

const readRecorder = (app: App): Promise<Sample[]> =>
  app.evalJS<Sample[]>(
    `(cancelAnimationFrame(window.__at0708Raf), window.__at0708)`,
  );

/** One gesture's record. */
interface Leg {
  readonly samples: Sample[];
  /** The panes whose scroller was following before the gesture. */
  readonly following: readonly string[];
  readonly before: string;
  readonly after: string;
  readonly landAtMs: number | null;
  /** The last `settle-land` row in the window, or `null`. */
  readonly land: SettleLandRow | null;
  /** The deck's commits, arms and gate edges across the leg, in order. */
  readonly sequence: readonly string[];
}

/** A frame whose transcript is pinned to its bottom and says so. */
const isFollowing = (p: FrameSample | undefined): boolean =>
  p !== undefined && p.anchor === "bottom" && p.distance >= 0 && p.distance <= PIN_EPSILON_PX;

async function sampleColumnMode(app: App, mode: "split" | "stack"): Promise<Leg> {
  const before = await bandCensus(app);
  const mark = await traceMark(app);
  await armRecorder(app);
  // A sample or two of the standing geometry before the gesture lands.
  await wait(60);
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-column-mode", ` +
      `{ slot: 0, mode: ${JSON.stringify(mode)} }), null)`,
  );
  await wait(RECORD_MS + 100);
  const samples = await readRecorder(app);
  const after = await bandCensus(app);
  const lands = await settleLandRows(app, mark);
  const sequence = await app.evalJS<readonly string[]>(
    `window.__deckTrace.since(${mark}).filter(function (e) {
       return e.kind === "store-notify" || e.kind === "settle-arm" ||
         e.kind === "settle-gate" || e.kind === "settle-release";
     }).map(function (e) {
       return Math.round(e.timestamp) + " " + e.kind + " " +
         (e.caller || e.outcome || e.phase || e.source || "") +
         (e.kind === "store-notify" ? " " + e.landing : "");
     })`,
  );
  const first = samples[0];
  const following =
    first === undefined
      ? []
      : Object.keys(first.panes).filter((id) => isFollowing(first.panes[id]));
  return {
    samples,
    following,
    before,
    after,
    landAtMs: lands.length === 0 ? null : lands[lands.length - 1].landAtMs,
    land: lands.length === 0 ? null : lands[lands.length - 1],
    sequence,
  };
}

interface PinReading {
  /** Ticks the pane was visible and off its bottom. */
  readonly offTicks: { t: number; distance: number; crossing: string; anchor: string; height: number }[];
  /** Ticks the pane was visible at all. */
  readonly visibleTicks: number;
  readonly maxDistance: number;
  /** Distance at the last sample — the deck at rest. */
  readonly atRest: number;
  /** Ticks on which the card root dropped its bottom anchor. */
  readonly anchorLostTicks: number;
}

/** Where, and by how much, one following pane stood off its bottom while seen. */
function readPin(leg: Leg, paneId: string): PinReading {
  const offTicks: PinReading["offTicks"] = [];
  let visibleTicks = 0;
  let maxDistance = 0;
  let anchorLostTicks = 0;
  for (const s of leg.samples) {
    const p = s.panes[paneId];
    if (p === undefined || p.distance < 0) continue;
    if (p.anchor !== "bottom") anchorLostTicks += 1;
    if (!p.visible) continue;
    visibleTicks += 1;
    maxDistance = Math.max(maxDistance, p.distance);
    if (p.distance > PIN_EPSILON_PX) {
      offTicks.push({
        t: Math.round(s.t),
        distance: Math.round(p.distance),
        crossing: p.crossing,
        anchor: p.anchor,
        height: Math.round(p.height),
      });
    }
  }
  const last = leg.samples[leg.samples.length - 1]?.panes[paneId];
  return {
    offTicks,
    visibleTicks,
    maxDistance,
    atRest: last === undefined ? -1 : last.distance,
    anchorLostTicks,
  };
}

/** The reading, by pane, in the report whatever the verdict. */
function report(label: string, leg: Leg): void {
  note(`${label}: before ${leg.before}`);
  note(`${label}: after  ${leg.after}`);
  note(
    `${label}: ${leg.samples.length} tick(s), following ${JSON.stringify(leg.following)}, ` +
      `land at ${leg.landAtMs === null ? "none" : `${leg.landAtMs.toFixed(0)}ms`}`,
  );
  // What ran in the motion and at the land, so a reading of "nothing beyond
  // the set-up's" is in the report beside the pin.
  const sites = (events: readonly { ms?: number; performed?: number; site: string }[] | null) =>
    events === null
      ? "not counted"
      : events.length === 0
        ? "none"
        : events
            .map((e) => `${e.site}${e.ms !== undefined ? ` ${e.ms.toFixed(1)}ms` : ` ${e.performed}`}`)
            .join(" | ");
  if (leg.land !== null) {
    note(
      `${label}: land ${leg.land.frameMs.toFixed(1)}ms / ${leg.land.frameFrames.toFixed(2)} frames; ` +
        `commits ${sites(leg.land.commits)}; forced layouts ${sites(leg.land.forcedLayouts)}; ` +
        `deliveries ${sites(leg.land.deliveries)}`,
    );
  }
  note(`${label}: sequence ${JSON.stringify(leg.sequence)}`);
  for (const id of leg.following) {
    const r = readPin(leg, id);
    const first = r.offTicks[0];
    const last = r.offTicks[r.offTicks.length - 1];
    note(
      `${label}: ${id} visible ${r.visibleTicks} tick(s), off its bottom on ` +
        `${r.offTicks.length} of them (max ${Math.round(r.maxDistance)}px` +
        `${first === undefined ? "" : `, from t=${first.t}ms to t=${last?.t}ms`}), ` +
        `anchor lost on ${r.anchorLostTicks} tick(s), at rest ${Math.round(r.atRest)}px`,
    );
    if (first !== undefined) {
      note(`${label}: ${id} first off tick ${JSON.stringify(first)}`);
    }
  }
}

/** The bar: pinned on every visible tick, and at the land. */
function expectPinned(label: string, leg: Leg, paneId: string): void {
  expect(
    leg.following,
    `${label}: ${paneId} was following before the gesture — a pane that was ` +
      `not pinned has nothing to keep, and the bar below would be about nothing`,
  ).toContain(paneId);
  const r = readPin(leg, paneId);
  expect(
    r.visibleTicks,
    `${label}: ${paneId} was seen at all — a frame covered on every tick is the ` +
      `cover's claim, not this bar's`,
  ).toBeGreaterThan(0);
  const first = r.offTicks[0];
  expect(
    r.offTicks.length,
    `${label}: ${paneId} stood off its bottom while visible on ${r.offTicks.length} ` +
      `of ${r.visibleTicks} tick(s) — first at t=${first?.t}ms, ${first?.distance}px ` +
      `from bottom (frame ${first?.height}px, crossing ${JSON.stringify(first?.crossing)}, ` +
      `anchor ${JSON.stringify(first?.anchor)}); max ${Math.round(r.maxDistance)}px`,
  ).toBe(0);
  expect(
    r.atRest,
    `${label}: ${paneId} is at its bottom at the land — ${Math.round(r.atRest)}px off`,
  ).toBeLessThanOrEqual(PIN_EPSILON_PX);
}

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0708 — the column pin, at the set-up [${arm.size}]`,
  () => {
    let app: App | null = null;
    let tugbankPath = "";
    let split: Leg | null = null;
    let stack: Leg | null = null;

    beforeAll(async () => {
      const launched = await launch(8, columnBlob(), TEST_NAME, { transcripts: arm.size });
      app = launched.app;
      tugbankPath = launched.tugbankPath;
      await traceWithSettleFrames(app);
      await home(app);
      split = await sampleColumnMode(app, "split");
      report(`split [${arm.size}]`, split);
      stack = await sampleColumnMode(app, "stack");
      report(`stack [${arm.size}]`, stack);
    }, BAR_TIMEOUT_MS);

    afterAll(async () => {
      if (app !== null) await app.close();
      if (tugbankPath !== "") rmTempTugbank(tugbankPath);
    });

    test("the fixture's slot 0 members were following before the split", () => {
      expect(split, "the split was sampled").not.toBeNull();
      expect(
        split?.following ?? [],
        `split: both of slot 0's members were pinned to their bottoms before ` +
          `the gesture — ${JSON.stringify(split?.following)}`,
      ).toEqual(expect.arrayContaining([REVEALED, SURVIVOR]));
      expect(
        split?.before === split?.after,
        `split: the gesture moved the band — before ${split?.before}, after ${split?.after}`,
      ).toBe(false);
    });

    test("[F01] split: the revealed member stays at its bottom on every visible tick", () => {
      expect(split, "the split was sampled").not.toBeNull();
      expectPinned(`split [${arm.size}]`, split as Leg, REVEALED);
    });

    test("[F02] split: the survivor's shrink lands at its bottom", () => {
      expect(split, "the split was sampled").not.toBeNull();
      expectPinned(`split [${arm.size}]`, split as Leg, SURVIVOR);
    });

    test("[F03] stack: the held member stays at its bottom, anchored, across the motion", () => {
      expect(stack, "the stack was sampled").not.toBeNull();
      const leg = stack as Leg;
      expectPinned(`stack [${arm.size}]`, leg, REVEALED);
      const r = readPin(leg, REVEALED);
      expect(
        r.anchorLostTicks,
        `stack: ${REVEALED}'s card root kept its bottom anchor on every tick — ` +
          `it dropped it on ${r.anchorLostTicks}, which is the clamp making the ` +
          `list view stop following`,
      ).toBe(0);
    });

    test("stack: the survivor's growth stays at its bottom", () => {
      expect(stack, "the stack was sampled").not.toBeNull();
      expectPinned(`stack [${arm.size}]`, stack as Leg, SURVIVOR);
    });
  },
);

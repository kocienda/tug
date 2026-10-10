/**
 * at0687 — a rail shown again while its hide is still carrying it out is a
 * show, and comes back by one continuous motion.
 *
 * Hiding the rails slides each rail frame off the edge it stands on, on the
 * depart beat, with the frame held by its depart target until the beat lands.
 * Showing them again inside that window finds the frame still owned by the
 * depart: it is parked, so `arm` measures no First rect for it, and the Last
 * pass has nothing but its arrival branch to read it with. Read as an arrival,
 * the frame is held at `opacity: 0` and launched from the edge while the
 * depart beat is still moving it out, and the depart's landing then runs the
 * restorers it captured before the hide — so the frame can vanish mid-slide,
 * jump between the two beats' poses, or land wearing neither's holds.
 *
 * The probe toggles the rails off and, once the rail is a quarter, half and
 * most of the way out, on again, sampling the rail frame's rect and opacity on
 * every animation frame through both. The re-show must be continuous: after
 * the second toggle the frame never moves further in a display frame than a
 * beat could carry it, never drops to invisible once it is coming back, and
 * stands at its home place, fully opaque and wearing no hold, once the deck
 * is quiet. Unfixed, the rail re-shown most of the way out cut 182 px in one
 * frame.
 *
 * @covers tugdeck/src/components/chrome/settle-plan.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/sidebar-toggle.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  launch,
  railBlob,
  wait,
} from "./settle-frames-fixture";

const TEST_NAME = "at0687-reshown-rail-is-not-an-arrival";
const PANE_ID = "at0622-pl1";
const FRAME = `.tug-pane[data-pane-id="${PANE_ID}"]`;
/**
 * How far out the rail has slid when the rails are shown again, as a fraction
 * of its width: early in the depart, mid-way, and nearly gone. Read off the
 * frame itself rather than a clock, because when the depart beat begins after
 * the toggle is the deck's to decide.
 */
const RESHOW_AT_FRACTION = [0.25, 0.5, 0.85] as const;
/**
 * The most a frame may move per display frame once it is coming back. The
 * depart and the show beats carry it at about 45 px a frame at their fastest;
 * a cut is the whole remaining travel, several hundred. Read per display
 * frame rather than per sample, so a frame the re-show's own commit drops is
 * a longer interval and not a jump.
 */
const STEP_BAR_PX = 60;
/** One display frame at 60 Hz, in ms. */
const FRAME_MS = 1000 / 60;
/** How long the sampler runs: both toggles and the settle after them. */
const SAMPLE_MS = 1_800;

interface Sample {
  t: number;
  left: number;
  width: number;
  opacity: number;
  inlineOpacity: string;
  inlineTransform: string;
  parked: boolean;
  departing: boolean;
}

interface Reading {
  samples: Sample[];
  reshownAt: number | null;
}

/** Hide the rails, and from inside the frame sampler show them again once the rail's left edge has slid out to `reshowAtLeft`. */
async function toggleTwice(app: App, reshowAtLeft: number): Promise<Reading> {
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__at0687 = { samples: [], reshownAt: null });
      var t0 = performance.now();
      var tick = function () {
        var t = performance.now() - t0;
        var frame = document.querySelector(${JSON.stringify(FRAME)});
        if (frame !== null) {
          var r = frame.getBoundingClientRect();
          rec.samples.push({
            t: t,
            left: r.left,
            width: r.width,
            opacity: Number(getComputedStyle(frame).opacity),
            inlineOpacity: frame.style.opacity,
            inlineTransform: frame.style.transform,
            parked: frame.hasAttribute("data-rail-parked"),
            departing: frame.hasAttribute("data-settle-departing"),
          });
        }
        if (rec.reshownAt === null && frame !== null && frame.getBoundingClientRect().left <= ${reshowAtLeft}) {
          rec.reshownAt = t;
          window.__tug.dispatchControlAction("toggle-sidebars", {});
        }
        if (t < ${SAMPLE_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__tug.dispatchControlAction("toggle-sidebars", {});
      return null;
    })()`,
  );
  await wait(SAMPLE_MS + 300);
  return app.evalJS<Reading>(`window.__at0687`);
}

describe.skipIf(!SHOULD_RUN)("at0687 — a rail re-shown inside its depart window is a show", () => {
  test(
    "hiding and re-showing the rails inside one depart window brings the rail back continuously",
    async () => {
      const { app, tugbankPath } = await launch(4, railBlob(), TEST_NAME);
      try {
        const home = await app.evalJS<{ left: number; width: number }>(
          `(function () { var r = document.querySelector(${JSON.stringify(FRAME)}).getBoundingClientRect(); return { left: r.left, width: r.width }; })()`,
        );
        for (const fraction of RESHOW_AT_FRACTION) {
          const label = `re-shown ${Math.round(fraction * 100)}% out`;
          const r = await toggleTwice(app, home.left - fraction * home.width);
          await wait(AFTER_LAND_MS);
          expect(r.reshownAt, `${label}: the rails were shown again`).not.toBeNull();
          const back = r.samples.filter((s) => s.t >= (r.reshownAt as number));
          let worstStep = 0;
          let worstAt = 0;
          for (let i = 1; i < back.length; i += 1) {
            const frames = Math.max(1, Math.round((back[i].t - back[i - 1].t) / FRAME_MS));
            const step = Math.abs(back[i].left - back[i - 1].left) / frames;
            if (step > worstStep) {
              worstStep = step;
              worstAt = back[i].t;
            }
          }
          const dimmest = Math.min(...back.map((s) => s.opacity));
          const last = r.samples[r.samples.length - 1];
          note(
            label,
            `worst step=${worstStep.toFixed(1)}px/frame at ${Math.round(worstAt)}ms dimmest=${dimmest.toFixed(2)} ` +
              `end: left=${last.left.toFixed(1)} (home ${home.left.toFixed(1)}) at ${Math.round(r.reshownAt ?? -1)}ms opacity=${last.opacity} ` +
              `parked=${last.parked} departing=${last.departing} inline opacity="${last.inlineOpacity}" transform="${last.inlineTransform}"`,
          );
          expect(worstStep, `${label}: the rail comes back without a cut`).toBeLessThanOrEqual(STEP_BAR_PX);
          expect(dimmest, `${label}: the rail never vanishes on its way back`).toBeGreaterThan(0.5);
          expect(
            {
              home: Math.abs(last.left - home.left) < 0.5,
              opacity: last.opacity,
              parked: last.parked,
              departing: last.departing,
              inlineOpacity: last.inlineOpacity,
              inlineTransform: last.inlineTransform,
            },
            `${label}: the rail stands at home, shown, wearing no hold`,
          ).toEqual({
            home: true,
            opacity: 1,
            parked: false,
            departing: false,
            inlineOpacity: "",
            inlineTransform: "",
          });
        }
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

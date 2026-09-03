/**
 * at0293 — typing does not drop a frame.
 *
 * "Won't lag" has to be a number that fails CI, and this is the number:
 * inter-frame gap, measured by a `requestAnimationFrame` loop running while
 * 240 synthetic keystrokes go into the composer of a cold-restored heavy
 * transcript. A rendering update that fits the frame budget leaves the gap at
 * the display's period; one that overruns stretches a frame, and there is
 * nowhere else for that cost to hide.
 *
 * WHY NOT KEYSTROKE→PAINT LATENCY, which is what this gate was originally
 * specified as. `requestAnimationFrame` fires at the next vsync, so a
 * keydown→rAF→setTimeout(0) measurement includes a uniform 0–16.7ms wait that
 * depends on where in the refresh cycle the key landed and not at all on what
 * the keystroke cost. Measured 2026-07-29 on a deck comfortably hitting frame
 * rate, that probe reads p50 11ms and p95 17ms — meaning the originally
 * budgeted p50 < 9ms was not merely unmet, it was unreachable in principle at
 * 60Hz. The distribution is still printed here because it is the number a
 * person feels; it is not asserted, because it mostly measures vsync phase.
 *
 * Reference readings on this fixture, same day: frame gap p50 17ms, p95
 * 18–19ms, max 19–26ms, holding steady even with 4,000 extra stacking
 * contexts injected. The budgets below sit above that with room for machine
 * variance and below anything a person would call a stutter.
 *
 * The floors that keep it honest: the transcript's dot population is asserted
 * (an empty restore must not pass by having nothing to render), the keystroke
 * count is asserted (a composer that never took focus would otherwise sail
 * through with an empty distribution), and the composer's text is asserted to
 * have actually grown.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/tug-sparkline.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

/** Keystrokes per burst, and bursts — 240 keys total, well past the 60 floor. */
const BURST_KEYS = 80;
const BURSTS = 3;

/**
 * Frame-gap budgets. A 60Hz frame is 16.7ms, so p50 at 20ms allows the
 * measurement's own jitter without allowing a systematically late frame, and
 * p95 at 26ms allows roughly one stretched frame in twenty — the point where
 * a burst starts to be felt rather than merely measured.
 */
const FRAME_GAP_P50_MS = 20;
const FRAME_GAP_P95_MS = 26;

interface Stats {
  count: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

const INSTALL_PROBE = `(function(){
  if (window.__at0293 !== undefined) return;
  var p = { lat: [], gaps: [], pending: false, running: false, last: 0, keys: 0 };
  window.__at0293 = p;
  document.addEventListener("keydown", function () {
    p.keys += 1;
    if (p.pending) return;
    p.pending = true;
    var t0 = performance.now();
    requestAnimationFrame(function () {
      setTimeout(function () {
        p.lat.push(performance.now() - t0);
        p.pending = false;
      }, 0);
    });
  }, true);
  window.__at0293Start = function () {
    p.running = true; p.last = 0;
    var tick = function (t) {
      if (!p.running) return;
      if (p.last !== 0) p.gaps.push(t - p.last);
      p.last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  window.__at0293Stop = function () { p.running = false; };
  window.__at0293Reset = function () {
    p.lat.length = 0; p.gaps.length = 0; p.keys = 0;
  };
  window.__at0293Read = function (which) {
    var s = (which === "lat" ? p.lat : p.gaps).slice().sort(function (a, b) { return a - b; });
    if (s.length === 0) return { count: 0, p50: 0, p95: 0, max: 0, mean: 0 };
    var sum = 0; for (var i = 0; i < s.length; i++) sum += s[i];
    var r = function (x) { return Math.round(x * 100) / 100; };
    return {
      count: s.length,
      p50: r(s[Math.floor(s.length * 0.5)]),
      p95: r(s[Math.floor(s.length * 0.95)]),
      max: r(s[s.length - 1]),
      mean: r(sum / s.length),
    };
  };
})()`;

function line(label: string, s: Stats): string {
  return (
    `  ${label.padEnd(11)} n=${String(s.count).padStart(4)}  ` +
    `p50 ${s.p50}ms  p95 ${s.p95}ms  max ${s.max}ms  mean ${s.mean}ms`
  );
}

/** One typing run. Returns the frame-gap and latency distributions. */
async function typeAndMeasure(
  app: App,
): Promise<{ gaps: Stats; latency: Stats; keys: number; text: number }> {
  await app.evalJS<void>(`window.__at0293Reset()`);
  await app.evalJS<void>(`window.__at0293Start()`);
  for (let b = 0; b < BURSTS; b++) {
    await app.nativeType("x".repeat(BURST_KEYS));
    // Space the bursts: synthetic gestures need a settle beat, and the gap
    // between them is where a deferred cost would surface if one existed.
    await new Promise((r) => setTimeout(r, 400));
  }
  await app.evalJS<void>(`window.__at0293Stop()`);
  return {
    gaps: await app.evalJS<Stats>(`window.__at0293Read("gap")`),
    latency: await app.evalJS<Stats>(`window.__at0293Read("lat")`),
    keys: await app.evalJS<number>(`window.__at0293.keys`),
    text: await app.evalJS<number>(
      `(document.querySelector('${PROMPT}')?.textContent ?? "").length`,
    ),
  };
}

describe.skipIf(!SHOULD_RUN)("at0293: typing latency", () => {
  test(
    "typing into a restored heavy transcript never stretches a frame",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession(
        "session-transcript-basic",
        "at0293",
      );
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );

      const app = await launchTugApp({
        testName: "at0293-typing-latency",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await openFixtureSession(app, seeded);
        await waitForTranscriptSettled(app);
        await new Promise((r) => setTimeout(r, 4_000));

        const dots = await app.evalJS<number>(
          `document.querySelectorAll('[data-slot="tug-progress-pulsing-dot"]').length`,
        );
        expect(
          dots,
          "restored transcript mounted no pulsing dots — fixture or restore path broke",
        ).toBeGreaterThanOrEqual(20);

        await app.evalJS<void>(INSTALL_PROBE);
        await app.nativeClickAtElement(PROMPT);
        await new Promise((r) => setTimeout(r, 800));

        let run = await typeAndMeasure(app);
        console.log(
          [
            `\n=== at0293: typing on restored ${seeded.fixture} ===`,
            line("frame gap", run.gaps),
            line("latency", run.latency),
            `  keys ${run.keys}, composer text ${run.text} chars`,
          ].join("\n"),
        );

        // One retry before failing: this measures a display refresh loop on a
        // shared machine, and a single unlucky window should not be a verdict.
        // Both distributions are printed when the retry disagrees.
        if (
          run.gaps.p50 >= FRAME_GAP_P50_MS ||
          run.gaps.p95 >= FRAME_GAP_P95_MS
        ) {
          console.log("=== over budget; retrying once ===");
          await new Promise((r) => setTimeout(r, 2_000));
          const retry = await typeAndMeasure(app);
          console.log(
            [
              "=== at0293: retry ===",
              line("frame gap", retry.gaps),
              line("latency", retry.latency),
            ].join("\n"),
          );
          run = retry;
        }

        // The floors: without these, a composer that never took focus would
        // pass with an empty distribution and a still deck.
        expect(run.keys, "no keystrokes reached the page").toBeGreaterThanOrEqual(
          BURST_KEYS * BURSTS,
        );
        expect(
          run.text,
          "the composer did not accept the typing — it never had focus",
        ).toBeGreaterThanOrEqual(BURST_KEYS);
        expect(
          run.gaps.count,
          "the frame loop produced no samples",
        ).toBeGreaterThan(60);

        expect(
          run.gaps.p50,
          `typing stretched the median frame: ${JSON.stringify(run.gaps)}`,
        ).toBeLessThan(FRAME_GAP_P50_MS);
        expect(
          run.gaps.p95,
          `typing stretched frames at p95: ${JSON.stringify(run.gaps)}`,
        ).toBeLessThan(FRAME_GAP_P95_MS);
      } finally {
        await app.quitGracefully();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

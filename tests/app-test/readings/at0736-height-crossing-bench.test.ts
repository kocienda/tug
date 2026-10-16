/**
 * at0736-height-crossing-bench.test.ts — what a height crossing costs inside
 * the motion and at its land.
 *
 * A settle that changes a frame's height crosses it on the main thread
 * ([D9]'s first standing hit, `tuglaws/animation-doctrine.md`): the frame's
 * own box tweens while the still crossing holds the card inside at one
 * definite size. This file reads that cost the way the user's deck is read,
 * with `tugtool deck motion settle`, on the two gesture families that carry a
 * height term: a fold beside a neighbour that grows into its room (and its
 * unfold), and a column's split and stack.
 *
 * Each family is read twice. `--quiet-instruments` is the reading of record
 * for frames: the motion's longest gap (from the gate's close to the land)
 * and the land's frame. `--frame-phases` (the Time Profiler at 1 ms over the
 * deck's WebContent process) prices every frame of the motion by phase, for
 * attribution only, since the sampler perturbs what it reads.
 *
 * Before the gestures it reads whether a `clip-path: inset()` tween runs off
 * the main thread on this engine: a rest window with a standing pane's clip
 * tweening, beside one with its transform tweening and one with nothing. A
 * compositor property reads the same busy samples as nothing at all.
 *
 * `TUG_AT0736_SHAPE` labels the notes with the crossing shape under test.
 * Benched behind a patch (`tugtool file probe`), the clip shape and the
 * two-frames-one-box shape read no better than the height crossing as built,
 * and the [D9] ruling stands on those numbers
 * (`briefs/engine-time-in-the-motion-readings.md`).
 *
 * Two bars. Every drive reads a motion and a land. And the clip's premise:
 * a `clip-path` tween costs main-thread style and compositing per frame that
 * a transform tween does not. That is the reading the clip shape lost on, so
 * a red there says the engine now composites the clip, and the ruling is to
 * be re-benched rather than the bar moved.
 *
 * It covers the crossing's own modules rather than the settle engine, which
 * already fans out to the selection ceiling.
 *
 * @motion
 * @foreground
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { note, type App } from "../_harness";
import { rmTempTugbank } from "../_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  columnBlob,
  home,
  launch,
  transcriptArms,
  wait,
} from "../settle-frames-fixture";

const TEST_NAME = "at0736-height-crossing-bench";
const ARMS = transcriptArms();
const SHAPE = process.env.TUG_AT0736_SHAPE ?? "as built";

/** The card the fold moves, and the neighbour that grows into its room. */
const SUBJECT = "at0622-c1";
const NEIGHBOUR = "at0622-c2";

/** Each family's drives: a fold and its unfold, a split and its stack. */
const COUNT = 2;

/** The rest windows of the clip check, in ms. */
const REST_WINDOW_MS = "2000";

/**
 * How many more main-thread style and compositing samples the clip's rest
 * window must read than the transform's, over its two seconds. The clip read
 * 244 against the transform's 0; one per display frame of the window is the
 * floor of a property the engine re-resolves every frame.
 */
const CLIP_MAIN_THREAD_FLOOR = 60;

const ARM_TIMEOUT_MS = 600_000;

const FAMILIES: readonly { name: string; flags: string[]; before?: string }[] = [
  { name: "fold", flags: ["--gesture", "fold", "--card", SUBJECT], before: "split" },
  { name: "split", flags: ["--gesture", "split", "--slot", "0"], before: "stack" },
];

function tugtoolPath(): string {
  const app = process.env.TUGAPP_DEBUG_PATH;
  if (app === undefined || app === "") {
    throw new Error("TUGAPP_DEBUG_PATH is unset; run this file through `just app-test`");
  }
  return join(dirname(app), "tugtool");
}

async function portOf(app: App): Promise<string> {
  const port = await app.evalJS<string>("location.port");
  if (!/^\d+$/.test(port)) throw new Error(`the page reports no tugcast port: '${port}'`);
  return port;
}

function deckMotion(
  port: string,
  args: string[],
): { exit: number; json: Record<string, unknown> | null; stderr: string } {
  const run = Bun.spawnSync([tugtoolPath(), "deck", "motion", ...args, "--port", port, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(run.stdout.toString()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { exit: run.exitCode ?? -1, json, stderr: run.stderr.toString() };
}

interface PhaseCount {
  readonly engine: number;
  readonly forced: number;
}

interface FrameReading {
  readonly frame: string;
  readonly t: number;
  readonly len: number;
  readonly samples: number;
  readonly phases: Record<string, PhaseCount>;
}

interface Reading {
  readonly gesture: string;
  readonly lead_ms: number | null;
  readonly longest_gap_ms: number | null;
  readonly motion: { at_ms: number; longest_gap_ms: number | null } | null;
  readonly land: { at_ms: number; frame_ms: number | null } | null;
  readonly frame_phases?: { frames: FrameReading[] } | null;
}

const PHASES = ["style", "layout", "compositing", "layer commit", "paint", "script", "rendering update"];

/** Phases summed over frames, `name engine/forced` for the busy ones. */
function phaseSum(frames: readonly FrameReading[]): string {
  const sum = new Map<string, [number, number]>();
  for (const f of frames) {
    for (const [name, c] of Object.entries(f.phases)) {
      const s = sum.get(name) ?? [0, 0];
      sum.set(name, [s[0] + c.engine, s[1] + c.forced]);
    }
  }
  const busy = [...sum.entries()].filter(([, [e, f]]) => e + f > 0);
  busy.sort((a, b) => PHASES.indexOf(a[0]) - PHASES.indexOf(b[0]));
  return busy.map(([n, [e, f]]) => `${n} ${e}/${f}`).join(", ") || "idle";
}

const ms = (x: number | null | undefined): string => (x == null ? "—" : `${x.toFixed(1)}`);

/** One rest window priced by phase, noted on one line; returns its style and compositing samples. */
function pricedRest(port: string, label: string): number {
  const run = deckMotion(port, ["rest", "--window", REST_WINDOW_MS, "--frame-phases"]);
  expect(run.exit, `rest --frame-phases (${label}): ${run.stderr}`).toBe(0);
  const data = (run.json?.data ?? null) as {
    rest: Record<string, unknown>;
    frame_phases: { samples: number; phases: Record<string, PhaseCount> };
  } | null;
  const rp = data!.frame_phases;
  const split = (p: string) => `${rp.phases[p]?.engine ?? 0}/${rp.phases[p]?.forced ?? 0}`;
  const total = (p: string) => (rp.phases[p]?.engine ?? 0) + (rp.phases[p]?.forced ?? 0);
  note(
    `at0736 [${SHAPE}] rest, ${label}: ${rp.samples} busy sample(s) over ${REST_WINDOW_MS} ms; ` +
      `style ${split("style")}, layout ${split("layout")}, compositing ${split("compositing")}; ` +
      `layer commit ${total("layer commit")}, paint ${total("paint")}, script ${total("script")}, ` +
      `rendering update ${total("rendering update")}; rest ${JSON.stringify(data!.rest)}`,
  );
  return total("style") + total("compositing");
}

/** Start an infinite tween of `property` on the first standing pane. */
async function tween(app: App, keyframes: string): Promise<void> {
  const ok = await app.evalJS<boolean>(
    `(() => { const el = document.querySelector('.tug-space-layer[data-space-shown] .tug-pane[data-imposed]');` +
      ` if (!el) return false;` +
      ` window.__at0736 = el.animate(${keyframes}, { duration: 600, iterations: Infinity, direction: "alternate", easing: "ease-in-out" });` +
      ` return true; })()`,
  );
  expect(ok, "a standing pane to tween").toBe(true);
  await wait(200);
}

async function stopTween(app: App): Promise<void> {
  await app.evalJS(`(window.__at0736?.cancel(), window.__at0736 = undefined, true)`);
  await wait(200);
}

async function columnMode(app: App, mode: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "${mode}" }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0736 — the height crossing, motion and land [${arm.size}]`,
  () => {
    test(
      "fold/unfold and split/stack each read a motion and a land, quiet and by phase",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob(), TEST_NAME, {
          transcripts: arm.size,
          whaleCards: [SUBJECT, NEIGHBOUR],
          foreground: true,
        });
        let port: string | null = null;
        try {
          await home(app);
          port = await portOf(app);
          const enable = deckMotion(port, ["enable"]);
          expect(enable.exit, `deck motion enable: ${enable.stderr}`).toBe(0);

          // Whether the clip runs off the main thread: nothing, a transform
          // (the compositor's own), a clip.
          pricedRest(port, "nothing tweening");
          await tween(app, `[{ transform: "translateY(0px)" }, { transform: "translateY(40px)" }]`);
          const transformCost = pricedRest(port, "a pane's transform tweening");
          await stopTween(app);
          await tween(app, `[{ clipPath: "inset(0px 0px 0px 0px)" }, { clipPath: "inset(0px 0px 200px 0px)" }]`);
          const clipCost = pricedRest(port, "a pane's clip-path tweening");
          await stopTween(app);
          expect(
            clipCost - transformCost,
            `a clip tween's style and compositing over a transform tween's (${clipCost} vs ${transformCost} samples): ` +
              `under ${CLIP_MAIN_THREAD_FLOOR} reads as a composited clip, so re-bench the height crossing's clip shape`,
          ).toBeGreaterThanOrEqual(CLIP_MAIN_THREAD_FLOOR);

          const missing: string[] = [];
          for (const family of FAMILIES) {
            for (const instrument of ["--quiet-instruments", "--frame-phases"]) {
              if (family.before !== undefined) await columnMode(app, family.before);
              const label = `${family.name} [${arm.size}] ${instrument === "--frame-phases" ? "instrumented" : "quiet"}`;
              const run = deckMotion(port, [
                "settle",
                ...family.flags,
                "--count",
                String(COUNT),
                "--streaming",
                "0",
                instrument,
              ]);
              expect(run.exit, `settle ${label} exited ${run.exit}: ${run.stderr}`).toBe(0);
              const readings = ((run.json?.data as Record<string, unknown> | null)?.readings ?? []) as Reading[];
              expect(readings.length, `${label}: every drive read`).toBe(COUNT);
              readings.forEach((r, i) => {
                const head =
                  `at0736 [${SHAPE}] ${label} #${i + 1} ${r.gesture}: lead ${ms(r.lead_ms)}, ` +
                  `longest gap ${ms(r.longest_gap_ms)}, motion ${ms(r.motion?.longest_gap_ms)}, ` +
                  `land ${ms(r.land?.frame_ms)} ms`;
                const frames = r.frame_phases?.frames ?? [];
                if (frames.length > 0 && r.motion !== null && r.land !== null) {
                  const motion = frames.filter((f) => f.t >= r.motion!.at_ms && f.t + f.len <= r.land!.at_ms);
                  const landFrames = frames.filter((f) => f.t + f.len > r.land!.at_ms);
                  const longest = motion.reduce((m, f) => Math.max(m, f.len), 0);
                  note(
                    `${head}\n  motion: ${motion.length} frame(s), longest ${longest.toFixed(0)} ms; ${phaseSum(motion)}` +
                      `\n  land: ${phaseSum(landFrames.slice(0, 2))}`,
                  );
                } else {
                  note(head);
                }
                if (r.motion === null || r.land === null) missing.push(`${label} #${i + 1} ${r.gesture}`);
              });
              await wait(AFTER_LAND_MS);
            }
          }
          expect(missing, `every drive reads a motion and a land: ${missing.join(", ")}`).toEqual([]);
        } finally {
          if (port !== null) deckMotion(port, ["disable"]);
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      ARM_TIMEOUT_MS,
    );
  },
);

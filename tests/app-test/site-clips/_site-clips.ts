/**
 * _site-clips.ts — what the site's capture drivers share.
 *
 * The Tug site (kocienda.com/tug) shows the app's behaviours as short clips,
 * and every clip is recorded through this harness rather than by hand, so a
 * clip can be re-cut from the same scene after the app changes. A driver is
 * an app-test file under `site-clips/`, named on the command line and never
 * swept into a tier (`scripts/select-tests.ts` enumerates the root,
 * `harness-smoke/` and `body-grounding/` only). It records ONE mode per
 * launch — the theme in force is chosen by `TUG_SITE_CLIPS_MODE` — and the
 * two frame sets of a clip are two runs of the same file:
 *
 *   TUG_SITE_CLIPS_OUT=/tmp/site-clips TUG_SITE_CLIPS_MODE=dark \
 *     TUG_APPTEST_FILE_BUDGET_SECS=120 just app-test site-clips/sc-bullseye.test.ts
 *
 * then again with `TUG_SITE_CLIPS_MODE=light`. The two site variables are the
 * gate: with either unset the file skips, so a path named by mistake never
 * launches the app. `TUGAPP_APP_TEST=1` is the runner's own export and is
 * never set by hand. The budget is raised because a driver boots the app and
 * runs a burst of up to ten seconds, which the default 20 s budget would stop.
 *
 * A launch seeds its theme the way `at0663-workspace-theme-switch.test.ts`
 * does — a temp tugbank holding a one-workspace layout blob whose `theme` is
 * Ironclad for `dark` and Sloop for `light` — so the first frame is already in
 * the mode being recorded. The frames come from `captureBurst`, the host's
 * composited window capture, at the window's backing scale (2× on Retina:
 * a crop of `w` content points is `2w` pixels). The harness reclaims burst
 * PNGs with the test's screenshots at teardown, so every frame is copied out
 * to `$TUG_SITE_CLIPS_OUT/<clip>/<mode>/frame-NNNN.png` before the driver
 * returns, with a `reading.json` beside them saying how to place the pixels.
 * The site's `tools/make-clip` encodes the run from there.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchTugApp, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { pollFor } from "../body-grounding/_frames";
import type { Rect } from "../one-view-fixture";
import { STUB_TRANSCRIPT_DIR_ENV } from "../streaming-stub-fixture";

export type ClipMode = "dark" | "light";

/** The runner's own export; a driver is an app-test and runs only under it. */
export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
/** Where the frames go: `$TUG_SITE_CLIPS_OUT/<clip>/<mode>/`. */
export const OUT = process.env.TUG_SITE_CLIPS_OUT;
/** The one mode this launch records. */
export const MODE: ClipMode | undefined =
  process.env.TUG_SITE_CLIPS_MODE === "dark" || process.env.TUG_SITE_CLIPS_MODE === "light"
    ? process.env.TUG_SITE_CLIPS_MODE
    : undefined;
/** The gate every driver's `describe.skipIf` reads. */
export const RUNS = SHOULD_RUN && OUT !== undefined && MODE !== undefined;

/** The theme each mode is captured in: the two skeletons the site's themes are laid over. */
export const THEME_FOR_MODE: Record<ClipMode, string> = { dark: "ironclad", light: "sloop" };

/** The capture interval every clip is recorded at: ~30 frames a second. */
export const CAPTURE_INTERVAL_MS = 33;
/** The host caps a burst here. */
export const BURST_CAP_MS = 10_000;

const SPACE_ID = "5c11a000-0000-4000-8000-000000000001";

/** `$TUG_SITE_CLIPS_OUT/<clip>/<mode>`, made if missing. */
export function outDirFor(clip: string): string {
  if (OUT === undefined || MODE === undefined) throw new Error("site clips: TUG_SITE_CLIPS_OUT and TUG_SITE_CLIPS_MODE must be set");
  const dir = join(OUT, clip, MODE);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Launch the app in the mode being recorded, with `deck` as the one
 * workspace's deck. The theme rides the workspace record in a temp tugbank,
 * so the boot paints in it; `stubDir` (from `stubDirectory()`) is where
 * tugcode finds the stub transcripts a scene's session cards are bound to.
 *
 * A scene whose cards need states (a Text card's file, a Diff card's
 * descriptor) launches with an EMPTY deck and seeds the real one afterwards
 * with `seedDeckState({ state, cardStates })`: a card's body reads its state
 * bag when it mounts, so a card the restore already mounted would not pick
 * up a bag seeded later. The wait below asks only for the cards the launch
 * deck carries.
 *
 * `extra.env` rides the launch environment — a scene with an arc redirects
 * `TUG_DATA_DIR` to its scratch root, one with jots names `TUG_JOTS_PATH` —
 * and `extra.contentSize` resizes the window after the boot, for a scene
 * wider than the harness's default.
 */
export async function launchForMode(
  testName: string,
  deck: unknown,
  stubDir?: string,
  extra: { env?: Record<string, string>; contentSize?: { width: number; height: number } } = {},
): Promise<App> {
  if (MODE === undefined) throw new Error("site clips: TUG_SITE_CLIPS_MODE must be dark or light");
  const cards = (deck as { cards?: unknown[] } | null)?.cards;
  const expected = Array.isArray(cards) ? cards.length : 0;
  const tugbankPath = mkTempTugbank();
  onTestRunEnd(() => rmTempTugbank(tugbankPath));
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.deck.layout",
    "layout",
    "json",
    JSON.stringify({
      version: 5,
      activeSpaceId: SPACE_ID,
      spaces: [{ id: SPACE_ID, name: "Site", theme: THEME_FOR_MODE[MODE], deck }],
    }),
  );
  const app = await launchTugApp({
    testName: `${testName}-${MODE}`,
    visible: true,
    env: {
      TUGBANK_PATH: tugbankPath,
      ...(stubDir === undefined ? {} : { [STUB_TRANSCRIPT_DIR_ENV]: stubDir }),
      ...extra.env,
    },
    persistInTestMode: true,
    restoreInTestMode: true,
    skipAccessibilityPreflight: true,
  });
  if (extra.contentSize !== undefined) await app.setWindowContentSize(extra.contentSize);
  await app.waitForCondition<boolean>(
    `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getDeckState().cards.length >= ${expected} && document.documentElement.dataset.themeMode === ${JSON.stringify(MODE)}`,
    { timeoutMs: 15_000 },
  );
  return app;
}

/** What `reading.json` records beside a run's frames. */
export interface FramesReading {
  clip: string;
  mode: ClipMode;
  theme: string;
  scale: number;
  crop: Rect | null;
  contentWidth: number;
  contentHeight: number;
  intervalMs: number;
  durationMs: number;
  frames: number;
}

const pad = (n: number): string => String(n).padStart(4, "0");

function writeFrames(reading: CaptureBurstReading, outDir: string): FramesReading {
  if (MODE === undefined) throw new Error("site clips: TUG_SITE_CLIPS_MODE must be dark or light");
  reading.frames.forEach((frame, i) => copyFileSync(frame.path, join(outDir, `frame-${pad(i)}.png`)));
  const facts: FramesReading = {
    clip: outDir.split("/").slice(-2, -1)[0] ?? "",
    mode: MODE,
    theme: THEME_FOR_MODE[MODE],
    scale: reading.scale,
    crop: reading.crop ?? null,
    contentWidth: reading.contentWidth,
    contentHeight: reading.contentHeight,
    intervalMs: reading.intervalMs,
    durationMs: reading.durationMs,
    frames: reading.frames.length,
  };
  writeFileSync(join(outDir, "reading.json"), JSON.stringify(facts, null, 2));
  return facts;
}

/**
 * Record `durationMs` of the window — the whole content area, or `crop` in
 * content points — into `outDir`, performing `act` once the burst is armed.
 * Resolves when every frame is written and copied out.
 */
export async function burstTo(
  app: App,
  crop: Rect | undefined,
  durationMs: number,
  outDir: string,
  act: () => Promise<void> = async () => {},
): Promise<FramesReading> {
  if (durationMs > BURST_CAP_MS) throw new Error(`site clips: a burst is at most ${BURST_CAP_MS} ms, not ${durationMs}`);
  await app.captureBurst({ op: "arm", durationMs, intervalMs: CAPTURE_INTERVAL_MS, ...(crop ? { crop } : {}) });
  await act();
  // The host writes its PNGs after the capture ends, and a whole-window
  // burst at a wide window is hundreds of multi-megabyte files, so the
  // grace after the burst is generous rather than tight.
  const reading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    durationMs + 90_000,
  );
  return writeFrames(reading, outDir);
}

/** One still of the window (or `crop`) as it stands, written to `outPath`. */
export async function stillTo(app: App, crop: Rect | undefined, outPath: string): Promise<{ scale: number }> {
  await app.captureBurst({ op: "arm", durationMs: 60, intervalMs: 30, ...(crop ? { crop } : {}) });
  const r = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (v) => v.done, 5_000);
  const last = r.frames[r.frames.length - 1];
  if (last === undefined) throw new Error("site clips: the still burst produced no frame");
  copyFileSync(last.path, outPath);
  return { scale: r.scale };
}

/**
 * Every card's pane rect in the shell's content, by card id, as the deck lays
 * them out now — the shell's stand-ins, read the way `at0747` reads them. A
 * scene reads these to crop its capture to the cards it is about.
 */
// card-dom: shell — the stand-ins are the shell's model of where each card stands.
export function standIns(app: App): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(`(function () {
    var out = {};
    document.querySelectorAll('.tug-pane:not([data-departing])').forEach(function (f) {
      var ph = f.querySelector('[data-body-placeholder][data-card-id]');
      if (!ph) return;
      var r = f.getBoundingClientRect();
      out[ph.getAttribute('data-card-id')] = { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    return out;
  })()`);
}

/** A crop in content points around `rects`, padded by `pad`, kept inside the content area. */
export function cropAround(rects: Rect[], pad: number, content: { width: number; height: number }): Rect {
  const x0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.y)) - pad));
  const x1 = Math.min(content.width, Math.ceil(Math.max(...rects.map((r) => r.x + r.width)) + pad));
  const y1 = Math.min(content.height, Math.ceil(Math.max(...rects.map((r) => r.y + r.height)) + pad));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The window's content size in points, read off the shell. */
export function contentSize(app: App): Promise<{ width: number; height: number }> {
  return app.evalJS<{ width: number; height: number }>(`({ width: window.innerWidth, height: window.innerHeight })`);
}

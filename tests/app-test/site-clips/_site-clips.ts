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
 * runs a burst of up to thirty seconds, which the default 20 s budget would
 * stop.
 *
 * A launch seeds its theme the way `at0663-workspace-theme-switch.test.ts`
 * does — a temp tugbank holding a one-workspace layout blob whose `theme` is
 * Ironclad for `dark` and Sloop for `light` — so the first frame is already in
 * the mode being recorded. The frames come from `captureBurst`, the host's
 * composited window capture, at the window's backing scale (2× on Retina:
 * a crop of `w` content points is `2w` pixels). The burst is armed with the
 * run's directory as its `outDir`, so the host writes every frame straight to
 * `$TUG_SITE_CLIPS_OUT/<clip>/<mode>/frame-NNNN.png` with a `reading.json`
 * beside them saying how to place the pixels and where the marks fell. The
 * site's `tools/make-clip` encodes the run from there.
 *
 * A scene is a timeline (`scene()`): acts at times from the burst's arming
 * and marks naming a frame, `loop-start` and `loop-end` among them, so the
 * clip's trim is the scene author's and the two modes share it. Its crop is
 * declared (`cropFor`): the cards it is about, the slot it ends at, and the
 * padding — the arithmetic from the stand-in, the body's view and the
 * element's rect is done once, through the deck's `elementRect` diag.
 */

import { expect } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { launchTugApp, type App } from "../_harness";
import { CAPTURE_BURST_CAP_MS, type CaptureBurstReading } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { pollFor } from "../body-grounding/_frames";
import type { Rect } from "../one-view-fixture";
import { STUB_TRANSCRIPT_DIR_ENV } from "../streaming-stub-fixture";
import { cropRect, runTimeline, timelineSpan, type TimelineEntry } from "./_scene";

export { cropAround } from "./_scene";

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
export const BURST_CAP_MS = CAPTURE_BURST_CAP_MS;
/** How long a burst runs past a scene's last entry, so what it set in motion lands in frame. */
export const SETTLE_MS = 1_000;

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
 * wider than the harness's default. `extra.spaces` adds parked workspaces
 * beside the active one, each with its own deck and theme, for a scene that
 * switches between them; the wait below still asks only for the active
 * deck's cards.
 */
export async function launchForMode(
  testName: string,
  deck: unknown,
  stubDir?: string,
  extra: {
    env?: Record<string, string>;
    contentSize?: { width: number; height: number };
    spaces?: { id: string; name: string; theme: string; deck: unknown }[];
  } = {},
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
      spaces: [{ id: SPACE_ID, name: "Site", theme: THEME_FOR_MODE[MODE], deck }, ...(extra.spaces ?? [])],
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
    // Every clip records under clip mode: `--tug-timing` pinned to 1 and the
    // caret held steady, so the two cuts of a scene have the same frames.
    clipMode: true,
    skipAccessibilityPreflight: true,
  });
  if (extra.contentSize !== undefined) await app.setWindowContentSize(extra.contentSize);
  await app.waitForCondition<boolean>(
    `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getDeckState().cards.length >= ${expected} && document.documentElement.dataset.themeMode === ${JSON.stringify(MODE)}`,
    { timeoutMs: 15_000 },
  );
  return app;
}

/** A run's reading: what the host answered when the burst was done, with `frames` as a count. */
export interface FramesReading {
  scale: number;
  crop: Rect | null;
  contentWidth: number;
  contentHeight: number;
  intervalMs: number;
  durationMs: number;
  frames: number;
  /** Each mark's name and the index of the frame it stamped. */
  marks: Record<string, number>;
  /** Where the host wrote the frames and its `reading.json`. */
  outDir: string;
}

/** The host's reading of a finished burst, with `frames` counted. The host wrote `reading.json` itself. */
function summarize(reading: CaptureBurstReading, outDir: string): FramesReading {
  return {
    scale: reading.scale,
    crop: reading.crop ?? null,
    contentWidth: reading.contentWidth,
    contentHeight: reading.contentHeight,
    intervalMs: reading.intervalMs,
    durationMs: reading.durationMs,
    frames: reading.frames.length,
    marks: reading.marks,
    outDir,
  };
}

/**
 * Arm a burst of `durationMs` into `outDir` — the whole content area, or
 * `crop` in content points — and wait for the host to finish writing it.
 * `run` performs the scene once the burst is armed.
 */
async function burst(app: App, crop: Rect | undefined, durationMs: number, outDir: string, run: () => Promise<void>): Promise<FramesReading> {
  if (durationMs > BURST_CAP_MS) throw new Error(`site clips: a burst is at most ${BURST_CAP_MS} ms, not ${durationMs}`);
  await app.captureBurst({ op: "arm", durationMs, intervalMs: CAPTURE_INTERVAL_MS, outDir, ...(crop ? { crop } : {}) });
  await run();
  // The host writes its PNGs after the capture ends, and a whole-window
  // burst at a wide window is hundreds of multi-megabyte files, so the
  // grace after the burst is generous rather than tight.
  const reading = await pollFor(
    () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
    (r) => r.done,
    durationMs + 90_000,
  );
  return summarize(reading, outDir);
}

/** What a scene records with: where the frames go, the crop (or the whole window), and the settle past its last entry. */
export interface RecordOptions {
  outDir: string;
  crop?: Rect;
  settleMs?: number;
}

/**
 * A scene: acts and marks on a timeline from the burst's arming. `at(ms,
 * act)` performs `act` at `ms`; `mark(name)` names the next frame captured
 * at the time of the latest entry (or at `ms`, when given), so
 * `.at(1_000, act).mark("loop-start")` stamps the frame the act lands on.
 * `record` arms the burst for the span plus settle and runs the timeline.
 */
export class Scene {
  private readonly entries: TimelineEntry[] = [];
  private cursor = 0;

  at(ms: number, act: () => Promise<unknown>): this {
    if (!(ms >= 0)) throw new Error(`site clips: a scene's entry is at a time from the start, not ${ms}`);
    this.entries.push({ at: ms, kind: "act", act });
    this.cursor = Math.max(this.cursor, ms);
    return this;
  }

  mark(name: string, ms: number = this.cursor): this {
    if (!(ms >= 0)) throw new Error(`site clips: a scene's mark is at a time from the start, not ${ms}`);
    if (this.entries.some((e) => e.kind === "mark" && e.name === name)) throw new Error(`site clips: the mark ${name} is already on the scene`);
    this.entries.push({ at: ms, kind: "mark", name });
    this.cursor = Math.max(this.cursor, ms);
    return this;
  }

  /** The time of the scene's last entry. */
  get span(): number {
    return timelineSpan(this.entries);
  }

  /**
   * Record the scene: arm the burst for the span plus `settleMs` (default
   * {@link SETTLE_MS}) into `outDir`, run the entries on schedule, placing
   * each mark through the host, and answer the reading with its marks once
   * the host has written every frame and its `reading.json`.
   */
  async record(app: App, opts: RecordOptions): Promise<FramesReading> {
    const durationMs = this.span + (opts.settleMs ?? SETTLE_MS);
    const clock = { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) };
    return burst(app, opts.crop, durationMs, opts.outDir, () =>
      runTimeline(this.entries, clock, async (name) => {
        await app.captureBurst({ op: "mark", name });
      }),
    );
  }
}

/** A new, empty scene. */
export function scene(): Scene {
  return new Scene();
}

/** The assertion every driver makes on its recording: frames landed, and `loop-start` and `loop-end` fell in order. */
export function expectRecorded(reading: FramesReading): void {
  expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
  expect(reading.marks["loop-start"], "the loop-start mark landed").toBeDefined();
  expect(reading.marks["loop-end"], "the loop-end mark landed").toBeGreaterThan(reading.marks["loop-start"]!);
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

/** What a scene's crop is declared with: the slot it ends at, and the padding around it. */
export interface CropOptions {
  /** The element whose top edge the crop starts at, `above` points higher — a card's first block, so the prompt above it is left out. */
  startAt?: { card: string; selector: string; above?: number };
  /** The element whose bottom edge the crop stops at — a card's status bar, so its composer is left out. */
  endAt?: { card: string; selector: string };
  /** Content points around the cards; 12 unless given. */
  pad?: number;
}

/**
 * The crop, in content points, of a scene about `cards`: their pane rects
 * as the deck lays them out now, cut at `startAt`'s top edge and `endAt`'s
 * bottom edge when given, padded and kept inside the window. The bounds'
 * rects come from the deck's `elementRect` diag — the card's view plus the
 * element's rect in its body — so no driver composes that sum itself.
 */
export async function cropFor(app: App, cards: string[], opts: CropOptions = {}): Promise<Rect> {
  const rest = await standIns(app);
  const rects = cards.map((id) => {
    const r = rest[id];
    if (r === undefined) throw new Error(`site clips: the card ${id} has no stand-in; the deck holds ${Object.keys(rest).join(", ") || "none"}`);
    return r;
  });
  const edge = async (at: { card: string; selector: string } | undefined): Promise<Rect | null> => {
    if (at === undefined) return null;
    const r = await app.elementRect(at.card, at.selector);
    if (r === null) throw new Error(`site clips: ${at.selector} is not mounted in ${at.card}`);
    return r;
  };
  const startEl = await edge(opts.startAt);
  const start = startEl === null ? null : { ...startEl, y: startEl.y - (opts.startAt?.above ?? 0) };
  const end = await edge(opts.endAt);
  return cropRect(rects, { start, end }, opts.pad ?? 12, await contentSize(app));
}

/** The window's content size in points, read off the shell. */
export function contentSize(app: App): Promise<{ width: number; height: number }> {
  return app.evalJS<{ width: number; height: number }>(`({ width: window.innerWidth, height: window.innerHeight })`);
}

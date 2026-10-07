/**
 * The settle bar — the one implementation of the clauses every settle is held
 * to, consulted by both of its readers.
 *
 * The app-tests judge a settle in the test process (`expectB09Bar` in
 * `tests/app-test/settle-frames-fixture.ts`) and `tugtool deck motion settle`
 * judges one on the user's deck through the eval door. They used to carry two
 * copies of the bar, a TypeScript one and a Rust one, and the copies drifted
 * twice: once over the per-leg bars and once over the arrived exemption, each
 * time leaving the verb reading RED on a leg the test reads green. So the
 * clauses live here, once. The fixture imports this module; the verb calls it
 * in the page through `window.__tugMotion.settleVerdict` and only prints what
 * it returns.
 *
 * The bar, from the motion's first frame on:
 *
 *   - **gap** — no gap over two display frames. The lead before the first
 *     frame is the set-up, noted and never barred.
 *   - **off-curve** — no shown frame painted a pose off its own curve, save
 *     the frames that arrived in the gesture (`arrivedIn`), which are held at
 *     inline `opacity: 0` across `room` and seen by nobody.
 *   - **sealed** — nothing ran inside the motion: no React commit that
 *     performed work, no forced layout but the bench probe's own read, no
 *     observer delivery.
 *   - **land** — the hand-back is one frame, unless a frame shrinks, which
 *     pays its land by the user's ruling.
 *
 * Every clause reads `pass: null` when the page could not count it — a census
 * that was not in the page is never a count of none. The fixture treats that
 * as a failure, because a harness deck always has its censuses; the verb
 * prints it as "not counted", because a release deck loaded without them is
 * a fact about the reading rather than about the motion.
 *
 * Pure: no DOM, no imports, so the test process and the page run the same
 * bytes.
 *
 * @module lib/motion-guard/settle-bar
 */

/** The motion's longest gap, in display frames. */
export const GAP_FRAMES_BAR = 2;

/**
 * The land's frame, in display periods: one frame. 1.5 rather than 1.0
 * because a live frame loop's gaps jitter around the period by a few
 * milliseconds; a land that costs one missed frame reads about 2.0 and is
 * caught with the same margin.
 */
export const LAND_FRAMES_BAR = 1.5;

/** The two numbers one settle is held to. */
export interface SettleBars {
  readonly gapFrames: number;
  readonly landFrames: number;
}

export const DEFAULT_SETTLE_BARS: SettleBars = {
  gapFrames: GAP_FRAMES_BAR,
  landFrames: LAND_FRAMES_BAR,
};

/**
 * The legs that carry their own number, by the user's rulings. Every other
 * leg is held to {@link DEFAULT_SETTLE_BARS}.
 *
 * - `fit` — resize-to-fit's gap, re-budgeted from 2 on 2026-10-03 after
 *   reading 2.06–2.18 frames on every run.
 * - `sidebar-show` — the sidebars' show land, re-budgeted from 1.5 on
 *   2026-10-06 after reading 1.47–1.88 frames.
 */
export const SETTLE_LEG_BARS = {
  fit: { gapFrames: 2.5 },
  "sidebar-show": { landFrames: 2.0 },
} as const satisfies Record<string, Partial<SettleBars>>;

export type SettleLeg = keyof typeof SETTLE_LEG_BARS;

/** The bar a leg is held to: the default, with the leg's own number over it. */
export function settleBarsFor(leg?: SettleLeg): SettleBars {
  return leg === undefined ? DEFAULT_SETTLE_BARS : { ...DEFAULT_SETTLE_BARS, ...SETTLE_LEG_BARS[leg] };
}

/**
 * The leg a `lab.drive(gesture, args)` drive is, for the verb: resize-to-fit
 * is `fit`, a sidebar drive with `open: true` is `sidebar-show`, and every
 * other drive carries no leg of its own.
 */
export function settleLegOfDrive(gesture: string, args?: { readonly open?: unknown } | null): SettleLeg | undefined {
  if (gesture === "fit") return "fit";
  if (gesture === "sidebar" && args?.open === true) return "sidebar-show";
  return undefined;
}

/**
 * The sealed clause's carve-outs, keyed on the gesture rather than on the
 * reading, so an exception is a named fact a leg reads rather than a site a
 * red happened to name.
 *
 * `swipe` — the hand-lift prelaunch: a swipe's settle launches from the hand
 * while the strip is still moving, so its gate closes in the arm and its own
 * React commit goes through the deferred notify, which tells React now and
 * bypasses the gate on purpose ([B06] of set-up-and-go-motion). Its commits
 * are noted, not counted; forced layouts and deliveries still are.
 */
export const SEALED_CARVE_OUTS = {
  swipe: {
    commits: true,
    reason:
      "the swipe's prelaunch commits under the gate by design ([B06] of set-up-and-go-motion)",
  },
} as const;

/** The gestures that carry a carve-out from the sealed clause. */
export type SealedGesture = keyof typeof SEALED_CARVE_OUTS;

/**
 * The site the sealed clause carves out of its forced layouts: the bench
 * probe's own rect read. While beats run, the frame owes the layout its
 * running animations dirty, and a sync read in the frame's rAF pays it early.
 * That is the frame's own layout paid by the instrument, not a layout the deck
 * forced; every other site, the in-product sampler's included, still counts.
 */
export const BENCH_PROBE_SITE = "[bench probe]";

/** One event a census recorded inside the motion or the land. */
export interface SettleBarEvent {
  readonly site: string;
  readonly ms?: number;
  readonly performed?: number;
}

/** The fields of a `settle-frames` row the bar reads. */
export interface SettleBarFrames {
  readonly motionLongestGapMs?: number;
  readonly motionLongestGapFrames?: number;
  readonly offCurveTicks?: number;
  readonly offCurvePaneIds?: readonly string[];
  readonly motionAtMs?: number;
  readonly motionCommits?: readonly SettleBarEvent[] | null;
  readonly motionForcedLayouts?: readonly SettleBarEvent[] | null;
  readonly motionDeliveries?: readonly SettleBarEvent[] | null;
  readonly firstPaintDelayMs?: number;
}

/** The fields of a `settle-land` row the bar reads. */
export interface SettleBarLand {
  readonly frameMs: number;
  readonly frameFrames: number;
}

export type SettleClauseName = "gap" | "off-curve" | "sealed" | "land";

/** One clause of the bar and how it read. */
export interface SettleClause {
  readonly name: SettleClauseName;
  /** `true` green, `false` red, `null` when the page could not count it. */
  readonly pass: boolean | null;
  readonly detail: string;
}

/** The bar over one settle. */
export interface SettleVerdict {
  readonly clauses: readonly SettleClause[];
  /** The set-up: the gesture to the first frame, noted and never barred. */
  readonly leadMs: number | null;
}

/** Each event by site, with its milliseconds or its performed-fiber count. */
export function settleSites(events: readonly SettleBarEvent[] | null | undefined): string {
  if (events === null || events === undefined) return "not counted";
  if (events.length === 0) return "none";
  return events
    .map((e) => `${e.site}${e.ms !== undefined ? ` ${e.ms.toFixed(1)}ms` : e.performed !== undefined ? ` ${e.performed}` : ""}`)
    .join(" | ");
}

function sizes(band: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const m of band.matchAll(/(\S+)@-?[\d.]+,-?[\d.]+\+([\d.]+)x([\d.]+)/g)) {
    out.set(m[1], [Number(m[2]), Number(m[3])]);
  }
  return out;
}

/**
 * Whether any frame standing on both sides of the band got smaller on either
 * axis — read off the band strings (`id@x,y+WxH`), so the leg says it rather
 * than the caller naming it.
 */
export function bandShrinks(before: string, after: string): boolean {
  const was = sizes(before);
  for (const [id, [w, h]] of sizes(after)) {
    const prior = was.get(id);
    if (prior !== undefined && (w < prior[0] - 0.5 || h < prior[1] - 0.5)) return true;
  }
  return false;
}

/**
 * The pane ids standing after the gesture that were not standing before it —
 * the frames that arrived in it.
 *
 * What the off-curve clause's exemption is computed from on a gesture that
 * brings frames in. Derived from the leg's own before-and-after band rather
 * than written down, so a gesture that stops bringing frames in exempts
 * nobody.
 */
export function arrivedIn(before: string, after: string): readonly string[] {
  const was = new Set(before.split(" ").map((s) => s.split("@")[0]));
  return after
    .split(" ")
    .map((s) => s.split("@")[0])
    .filter((id) => id !== "" && !was.has(id));
}

/** The motion's longest gap from the first frame on, against `gapFrames`. */
export function gapClause(frames: SettleBarFrames, gapFrames: number): SettleClause {
  const g = frames.motionLongestGapFrames;
  if (typeof g !== "number") return { name: "gap", pass: null, detail: "no gap in the row" };
  const ms = frames.motionLongestGapMs ?? -1;
  return {
    name: "gap",
    pass: g <= gapFrames,
    detail: `${ms.toFixed(0)} ms / ${g.toFixed(2)} frames against ${gapFrames}`,
  };
}

/** No shown frame off its own curve, save the panes in `exempt`. */
export function offCurveClause(frames: SettleBarFrames, exempt: readonly string[]): SettleClause {
  const all = frames.offCurvePaneIds ?? [];
  const off = all.filter((id) => !exempt.includes(id));
  const excused = all.filter((id) => exempt.includes(id));
  const note = excused.length === 0 ? "" : `; ${excused.join(", ")} exempt, arrived in the gesture`;
  return {
    name: "off-curve",
    pass: off.length === 0,
    detail:
      off.length === 0
        ? `no pane${note}`
        : `${frames.offCurveTicks ?? 0} tick(s) on ${off.join(", ")}${note}`,
  };
}

/** Nothing committed, forced layout or delivered between the first frame and the land. */
export function sealedClause(frames: SettleBarFrames, gesture?: SealedGesture): SettleClause {
  if ((frames.motionAtMs ?? -1) < 0) {
    return { name: "sealed", pass: false, detail: "the motion gate never closed behind the beats" };
  }
  const carved = gesture !== undefined && SEALED_CARVE_OUTS[gesture].commits;
  // A commit that performed no fiber rendered nothing — React's own empty
  // flush — and is kept in the row but not counted.
  const commits =
    frames.motionCommits === null || frames.motionCommits === undefined
      ? null
      : frames.motionCommits.filter((c) => (c.performed ?? 0) > 0);
  const forced = (frames.motionForcedLayouts ?? []).filter((e) => e.site !== BENCH_PROBE_SITE);
  const deliveries = frames.motionDeliveries ?? null;
  const red =
    (!carved && commits !== null && commits.length > 0) ||
    forced.length > 0 ||
    (deliveries !== null && deliveries.length > 0);
  // A carve-out excuses the commits, not the census: a page that could not
  // count them still could not count them.
  const unread = commits === null || deliveries === null;
  const commitsDetail = carved
    ? `${commits === null ? "uncounted" : commits.length} carved out — ${SEALED_CARVE_OUTS[gesture as SealedGesture].reason}` +
      (commits !== null && commits.length > 0 ? ` — ${settleSites(commits)}` : "")
    : settleSites(commits);
  return {
    name: "sealed",
    pass: red ? false : unread ? null : true,
    detail: `commits ${commitsDetail}; forced layouts ${settleSites(forced)}; deliveries ${settleSites(deliveries)}`,
  };
}

/** The land is one frame against `landFrames`, unless a frame shrinks. */
export function landClause(land: SettleBarLand | null | undefined, shrinks: boolean, landFrames: number): SettleClause {
  if (land === null || land === undefined) {
    return { name: "land", pass: false, detail: "the settle wrote no land" };
  }
  const ruling = shrinks ? ", a shrink pays its land by ruling" : "";
  const detail = `${land.frameMs.toFixed(1)} ms / ${land.frameFrames.toFixed(2)} frames against ${landFrames}${ruling}`;
  if (land.frameMs <= 0) {
    return { name: "land", pass: false, detail: `no frame followed the land — ${detail}` };
  }
  return { name: "land", pass: shrinks || land.frameFrames <= landFrames, detail };
}

/** What one settle hands the bar. */
export interface SettleBarInput {
  readonly frames: SettleBarFrames;
  readonly land: SettleBarLand | null | undefined;
  readonly before: string;
  readonly after: string;
}

/** How the bar is applied to one settle. */
export interface SettleBarOptions {
  readonly bars?: SettleBars;
  /** Panes the off-curve clause does not judge; `arrivedIn` by default. */
  readonly exempt?: readonly string[];
  readonly gesture?: SealedGesture;
}

/** Every clause of the bar over one settle. */
export function settleVerdict(input: SettleBarInput, options: SettleBarOptions = {}): SettleVerdict {
  const bars = options.bars ?? DEFAULT_SETTLE_BARS;
  const exempt = options.exempt ?? arrivedIn(input.before, input.after);
  return {
    clauses: [
      gapClause(input.frames, bars.gapFrames),
      offCurveClause(input.frames, exempt),
      sealedClause(input.frames, options.gesture),
      landClause(input.land, bandShrinks(input.before, input.after), bars.landFrames),
    ],
    leadMs: typeof input.frames.firstPaintDelayMs === "number" ? input.frames.firstPaintDelayMs : null,
  };
}

/** The deck's own rows over one drive, as the verb's page scripts gather them. */
export interface SettleEngineRows {
  readonly frames: readonly SettleBarFrames[];
  readonly lands: readonly SettleBarLand[];
  readonly before: string;
  readonly after: string;
}

/**
 * The verb's verdict over a drive's rows: the last `settle-frames` row and the
 * last land, the settle the drive ended on, against the drive's leg. `null`
 * when the drive wrote no `settle-frames` row.
 */
export function settleVerdictOfDrive(
  engine: SettleEngineRows,
  gesture?: string,
  args?: { readonly open?: unknown } | null,
): SettleVerdict | null {
  const frames = engine.frames[engine.frames.length - 1];
  if (frames === undefined) return null;
  const leg = gesture === undefined ? undefined : settleLegOfDrive(gesture, args);
  return settleVerdict(
    { frames, land: engine.lands[engine.lands.length - 1], before: engine.before, after: engine.after },
    { bars: settleBarsFor(leg) },
  );
}

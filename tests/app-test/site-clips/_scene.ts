/**
 * _scene.ts — the pure half of a site clip's scene: its timeline and its crop.
 *
 * A scene is a timeline — acts at times from the burst's arming, and marks
 * that name a frame — and the burst's length derives from it. Nothing here
 * touches the app: `_site-clips.ts` builds a timeline, arms the host's
 * burst for its span, and runs it through `runTimeline` with the real clock
 * and the host's `mark` op, so the scheduling can be checked over a fake
 * clock without a launch. The crop arithmetic is here for the same reason:
 * `cropFor` in `_site-clips.ts` reads the rects off the running app and
 * hands them to `cropRect`, which is checked over recorded rects.
 */

/** A rect in window content points, top-left origin. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One entry of a timeline: something to do at `at` ms, or a frame to name there. */
export type TimelineEntry =
  | { at: number; kind: "act"; act: () => Promise<unknown> }
  | { at: number; kind: "mark"; name: string };

/** The clock a timeline runs on — the real one in a driver, a fake one in a test. */
export interface TimelineClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The time of the timeline's last entry: how long the burst must run before its settle. */
export function timelineSpan(entries: ReadonlyArray<TimelineEntry>): number {
  return entries.reduce((span, e) => Math.max(span, e.at), 0);
}

/**
 * Run `entries` on schedule against `clock`, each at its `at` ms from the
 * call: an act is awaited, a mark is handed to `stamp`. Entries fire in
 * order of `at`, and two at the same time in the order they were added. An
 * act that runs past the next entry's time pushes it: the next fires as
 * soon as the act returns, so a scene's acts are expected to be short
 * (a menu item, a key, a click) with the time between them in the
 * schedule rather than inside them.
 */
export async function runTimeline(
  entries: ReadonlyArray<TimelineEntry>,
  clock: TimelineClock,
  stamp: (name: string) => Promise<void>,
): Promise<void> {
  const ordered = entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i);
  const start = clock.now();
  for (const { e } of ordered) {
    const wait = start + e.at - clock.now();
    if (wait > 0) await clock.sleep(wait);
    if (e.kind === "act") await e.act();
    else await stamp(e.name);
  }
}

/** A crop in content points around `rects`, padded by `pad`, kept inside the content area. */
export function cropAround(rects: ReadonlyArray<Rect>, pad: number, content: { width: number; height: number }): Rect {
  if (rects.length === 0) throw new Error("site clips: a crop needs at least one rect");
  const x0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.y)) - pad));
  const x1 = Math.min(content.width, Math.ceil(Math.max(...rects.map((r) => r.x + r.width)) + pad));
  const y1 = Math.min(content.height, Math.ceil(Math.max(...rects.map((r) => r.y + r.height)) + pad));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The crop of a scene about `cards` — their pane rects, in content points —
 * starting at `start`'s top edge and ending at `end`'s bottom edge when each
 * is given: rects, in content points, of the elements the crop runs between
 * (a card's first block, a status bar, so the composer below it is left
 * out), each replacing the cards' own edge where it lies inside it. The
 * union is padded by `pad` and kept inside the content area.
 */
export function cropRect(
  cards: ReadonlyArray<Rect>,
  bounds: { start?: Rect | null; end?: Rect | null },
  pad: number,
  content: { width: number; height: number },
): Rect {
  if (cards.length === 0) throw new Error("site clips: a crop needs at least one card");
  const start = bounds.start ?? null;
  const end = bounds.end ?? null;
  const top = start === null ? Math.min(...cards.map((r) => r.y)) : start.y;
  const bottom = end === null ? Math.max(...cards.map((r) => r.y + r.height)) : end.y + end.height;
  if (bottom <= top) throw new Error(`site clips: the crop's end (${bottom}) is above its start (${top})`);
  const cut = cards.map((r) => {
    const y = Math.max(r.y, top);
    const b = Math.min(r.y + r.height, bottom);
    return { x: r.x, y, width: r.width, height: Math.max(0, b - y) };
  });
  return cropAround(cut, pad, content);
}

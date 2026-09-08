/**
 * Cut detector — a diagnostic that answers "did a card move without moving?"
 *
 * A pane whose rect jumps between two consecutive frames while no animation is
 * running on it has CUT rather than travelled. That is the defect this module
 * finds: the deck's promise is that every layout change is animated, and a cut
 * is the promise broken. The imposer's settle animates a frame only when it can
 * measure a First rect for it and the frame is not under a pointer, so the ways
 * a cut can happen are structural (a frame the settle never saw) or accidental
 * (a commit that landed where the measurement could not reach).
 *
 * It is a BENCH PROBE, not a product surface. The animation doctrine bans
 * per-frame JS in shipping paths and requires a settled surface to hold zero
 * timers; both hold here because the loop exists only between `arm()` and
 * `disarm()`, and `disarm()` drops every sample it was keeping. Nothing arms it
 * on load — the app-test harness and the dev panel are the only doors.
 *
 * The classification is pure and lives apart from the DOM reader
 * ({@link classifySamples} over {@link PaneSample}), so the interesting half is
 * testable as data without a browser.
 */

import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

/**
 * How far a frame may move between two samples before it counts as a jump.
 *
 * Sub-pixel motion is the browser re-resolving a `calc()` against a fractional
 * container, not a card changing places, and the imposer's own FLIP floors its
 * terms at half a pixel for the same reason.
 */
export const CUT_THRESHOLD_PX = 2;

/** One pane's geometry and motion state at one sampling instant. */
export interface PaneSample {
  readonly paneId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** How many animations were running on the frame element at this instant. */
  readonly animations: number;
  /** Whether a pointer gesture owned the frame at this instant. */
  readonly gesture: boolean;
}

/**
 * How a frame broke the promise.
 *
 * `jump` — it was already on screen and changed places between two frames with
 * nothing animating it.
 *
 * `appeared` — it arrived already at its final geometry with nothing animating
 * it. This is not a jump and no rect delta describes it: there is no earlier
 * sample to subtract. It is still the promise broken, because a card that
 * materializes at full opacity in one frame has not entered, it has cut.
 */
export type CutKind = "jump" | "appeared";

/** A frame that changed geometry, or arrived, with no animation to carry it. */
export interface CutRecord {
  readonly kind: CutKind;
  readonly paneId: string;
  /** Zero for an `appeared` record — an arriving frame has nothing to move from. */
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
  /** Animations running on the frame at the later sample — always 0 for a cut. */
  readonly animations: number;
  /** Gesture state at the later sample — always false for a cut. */
  readonly gesture: boolean;
}

/**
 * Compare two sampling instants and name every pane that jumped or arrived
 * uncarried.
 *
 * A pane already on screen is reported as a `jump` when all of these hold:
 *
 * - some axis moved by more than {@link CUT_THRESHOLD_PX};
 * - **neither** sample had an animation running on it. Requiring both ends to
 *   be quiet is what keeps a tween's final frame from reading as a cut: an
 *   animation that finished between the two samples leaves the later one at
 *   zero, and only the earlier sample still remembers that something was
 *   carrying the motion;
 * - neither sample was under a pointer gesture, which owns its own geometry.
 *
 * A pane present only in the later sample is reported as `appeared` when
 * nothing is animating it — the enter question, which has no delta to measure
 * and so would be invisible to the jump rule above. A frame that arrives
 * already tweening (an enter effect, or the settle catching it) is carried and
 * says nothing here.
 *
 * A departing frame is not reported at all: once it is out of the DOM there is
 * nothing left to ask about, and whether its exit was carried is a question
 * about what replaced it rather than about the frame itself.
 */
export function classifySamples(
  prev: ReadonlyMap<string, PaneSample>,
  next: ReadonlyMap<string, PaneSample>,
): CutRecord[] {
  const records: CutRecord[] = [];
  for (const [paneId, after] of next) {
    const before = prev.get(paneId);
    if (before === undefined) {
      if (after.gesture || after.animations > 0) continue;
      records.push({
        kind: "appeared",
        paneId,
        dx: 0,
        dy: 0,
        dw: 0,
        dh: 0,
        animations: after.animations,
        gesture: after.gesture,
      });
      continue;
    }
    if (before.gesture || after.gesture) continue;
    if (before.animations > 0 || after.animations > 0) continue;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const dw = after.width - before.width;
    const dh = after.height - before.height;
    const moved =
      Math.abs(dx) > CUT_THRESHOLD_PX ||
      Math.abs(dy) > CUT_THRESHOLD_PX ||
      Math.abs(dw) > CUT_THRESHOLD_PX ||
      Math.abs(dh) > CUT_THRESHOLD_PX;
    if (!moved) continue;
    records.push({
      kind: "jump",
      paneId,
      dx,
      dy,
      dw,
      dh,
      animations: after.animations,
      gesture: after.gesture,
    });
  }
  return records;
}

/** Read the current geometry of every imposed frame under `root`. */
export function sampleFrames(root: ParentNode): Map<string, PaneSample> {
  const samples = new Map<string, PaneSample>();
  for (const frame of root.querySelectorAll<HTMLElement>(
    ".tug-pane[data-pane-id]",
  )) {
    const paneId = frame.getAttribute("data-pane-id");
    if (paneId === null) continue;
    const rect = frame.getBoundingClientRect();
    samples.set(paneId, {
      paneId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      animations: frame.getAnimations({ subtree: false }).length,
      // `data-pointer-owned`, not `data-gesture`: a frame under a press that
      // never travelled is still the settle's to carry, and a cut it suffers
      // there is a cut the detector exists to report.
      gesture: frame.hasAttribute("data-pointer-owned"),
    });
  }
  return samples;
}

/**
 * The armed sampler. One instance per document; `arm()` starts a frame loop and
 * `disarm()` ends it and forgets everything it collected.
 */
class CutDetector {
  private handle: number | null = null;
  private prev: Map<string, PaneSample> | null = null;
  private records: CutRecord[] = [];
  private root: ParentNode | null = null;

  get armed(): boolean {
    return this.handle !== null;
  }

  arm(root?: ParentNode): void {
    if (this.handle !== null) return;
    this.root = root ?? document;
    this.prev = null;
    this.records = [];
    const tick = (): void => {
      const scope = this.root;
      if (scope === null) return;
      const next = sampleFrames(scope);
      if (this.prev !== null) {
        const found = classifySamples(this.prev, next);
        if (found.length > 0) {
          this.records.push(...found);
          for (const record of found) {
            tugDevLogStore.warn(
              "cut-detector",
              record.kind === "appeared"
                ? `pane ${record.paneId} appeared with no animation`
                : `pane ${record.paneId} jumped with no animation`,
              record as unknown as Record<string, unknown>,
            );
          }
        }
      }
      this.prev = next;
      this.handle = requestAnimationFrame(tick);
    };
    this.handle = requestAnimationFrame(tick);
  }

  disarm(): void {
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle);
      this.handle = null;
    }
    this.prev = null;
    this.root = null;
  }

  /** Hand back everything recorded so far and clear the buffer. */
  take(): CutRecord[] {
    const out = this.records;
    this.records = [];
    return out;
  }
}

export const cutDetector = new CutDetector();

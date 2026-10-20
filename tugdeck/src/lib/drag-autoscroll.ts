/**
 * drag-autoscroll — the strips a card drag scrolls while the hand holds at
 * an edge.
 *
 * A zone drag held at a strip's edge advances that strip: a column or a rail
 * at a rate (`autoscrollDelta`), the flow band a slot at a click
 * (`flowStepDecision`, `flowStepTarget`, tweened over `FLOW_STEP_TWEEN_MS`).
 * The offset goes onto the strip's custom property through the canvas's
 * `applyScroll` and nowhere near the store, so the strip follows the hand at
 * no measuring cost; every strip the gesture scrolled commits once, at the
 * drop or the cancel, through `commitScroll`.
 *
 * The clock is the gesture's own frames ([D135]). A held hand posts no
 * moves, so whenever a strip is still advancing — or the hand is outboard of
 * a flow edge, or a click is in flight — {@link DragAutoscroll.advance} asks
 * for another frame through the `schedule` it was made with.
 *
 * The shell's own pane drag (`tug-pane.tsx`) carries the same arithmetic
 * inline; this is the half a drag the host tracks for a card's page runs
 * (`host-card-gesture.ts`).
 *
 * @module lib/drag-autoscroll
 */

import {
  FLOW_STEP_TWEEN_MS,
  autoscrollDelta,
  autoscrollKey,
  flowStepArmed,
  flowStepDecision,
  flowStepTarget,
  type AutoscrollTarget,
  type DropZoneHost,
  type FlowStepState,
} from "./drop-zones";

/** One strip a drag has scrolled, and where it left it. */
interface AutoscrollRun {
  target: AutoscrollTarget;
  offset: number;
}

/** A click in flight: the flow offset travelling from `from` to `to`. */
interface FlowStepTween {
  from: number;
  to: number;
  startedAt: number;
}

export interface DragAutoscroll {
  /** Advance whatever strip `pointer` (canvas layout px) holds at the edge of; whether anything moved. */
  advance(pointer: { x: number; y: number }): boolean;
  /** Stop the clock without committing: the next advance starts a fresh interval. */
  pause(): void;
  /** Commit every strip the gesture scrolled, one store write each, and forget them. */
  commit(): void;
}

export function createDragAutoscroll(opts: {
  host: () => DropZoneHost | null;
  paneId: string;
  schedule: () => void;
  now?: () => number;
}): DragAutoscroll {
  const now = opts.now ?? (() => performance.now());
  const runs = new Map<string, AutoscrollRun>();
  let clock: number | null = null;
  let flow: FlowStepState = flowStepArmed();
  let tween: FlowStepTween | null = null;

  const advanceFlowClick = (host: DropZoneHost, target: AutoscrollTarget, pointer: { x: number; y: number }, at: number): boolean => {
    const key = autoscrollKey(target);
    const standing = runs.get(key)?.offset ?? target.offset;
    const decided = flowStepDecision({ pointer: pointer.x, bandStart: target.bandStart, bandEnd: target.bandEnd, state: flow, now: at });
    flow = decided.state;
    if (decided.direction !== 0 && target.strip !== undefined) {
      const landing = tween?.to ?? standing;
      const named = flowStepTarget({ strip: target.strip, band: target.bandEnd - target.bandStart, offset: landing, direction: decided.direction });
      if (named !== null && named.offset !== landing) tween = { from: standing, to: named.offset, startedAt: at };
    }
    const outboard = pointer.x > target.bandEnd || pointer.x < target.bandStart;
    if (outboard || tween !== null) opts.schedule();
    if (tween === null) return false;
    const progress = Math.min(1, (at - tween.startedAt) / FLOW_STEP_TWEEN_MS);
    const eased = 1 - (1 - progress) ** 3;
    const next = Math.min(Math.max(0, tween.from + (tween.to - tween.from) * eased), target.maxOffset);
    if (progress >= 1) tween = null;
    if (next === standing) return false;
    runs.set(key, { target, offset: next });
    host.applyScroll(target, next);
    return true;
  };

  return {
    advance(pointer) {
      const host = opts.host();
      if (host === null) return false;
      const at = now();
      const last = clock;
      clock = at;
      const target = host.autoscrollTargetFor(pointer, opts.paneId);
      if (target === null) return false;
      if (target.kind === "flow") return advanceFlowClick(host, target, pointer, at);
      if (last === null) {
        // The first frame at the edge only starts the interval: ask for the next.
        opts.schedule();
        return false;
      }
      const key = autoscrollKey(target);
      const standing = runs.get(key)?.offset ?? target.offset;
      const delta = autoscrollDelta({
        pointer: target.axis === "y" ? pointer.y : pointer.x,
        bandStart: target.bandStart,
        bandEnd: target.bandEnd,
        elapsedMs: at - last,
      });
      if (delta === 0) return false;
      // The clock stays alive while the hand holds, whether or not the strip
      // still has anywhere to go, so a hand moving off the edge is noticed.
      opts.schedule();
      const next = Math.min(Math.max(0, standing + delta), target.maxOffset);
      if (next === standing) return false;
      runs.set(key, { target, offset: next });
      host.applyScroll(target, next);
      return true;
    },
    pause() {
      clock = null;
    },
    commit() {
      const host = opts.host();
      for (const run of runs.values()) host?.commitScroll(run.target, run.offset);
      runs.clear();
      clock = null;
      flow = flowStepArmed();
      tween = null;
    },
  };
}

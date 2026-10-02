/**
 * gesture-scope — the one door React's subscriptions and `flushSync` go through.
 *
 * A WAAPI tween created in a task is play-pending until that task's rendering
 * update, so every React commit that runs before the task ends lands in the
 * tween's first frame. The deck store already moves its notify past the next
 * paint ([D204]) and four other sites opt in through `scheduleAfterPaint`, but
 * every other store still tells React inline — and a sixth store would go
 * unnoticed. So every `useSyncExternalStore` and every `flushSync` in the
 * deck imports from here instead of from React, and this module sees every
 * store change React is told about.
 *
 * What it holds: while a gesture scope is pending, a store-change callback is
 * added to a held set instead of running, and the set is released together
 * after the next painted frame — through `scheduleAfterPaint`, which carries
 * the deadline that keeps an occluded window from holding forever ([L32]).
 * `afterGesture` queues other React-facing work into the same release.
 *
 * A gesture that opens while a scope is pending joins it only if the scope's
 * frame has not yet gone: joining a scope one task from its release would let
 * React into the new gesture's first frame, which is the thing the hold is
 * for. After the frame, an `open` re-arms the release past the next paint
 * instead — but never past the deadline counted from the hold's first `open`,
 * so a run of gestures holds React no longer than one gesture could.
 *
 * A throwing callback takes nothing with it. Every held tell and queued body
 * runs, guarded, and the first error is rethrown once all have run, so a
 * fault is still loud and no component is left stale behind it.
 *
 * Two bypasses. The wrapped `flushSync` is how code says "I need the DOM now":
 * it drains the held set and the queued `afterGesture` work inside react-dom's
 * flush and runs its body unheld — whether or not the drain threw — but leaves
 * the scope pending, so a `flushSync` early in a gesture does not end the hold
 * for the rest of it. `tellReactNow` runs its body unheld without a flush, for
 * the deck store's own deliberate inline tells.
 *
 * Why not a transition: react-dom enqueues every `useSyncExternalStore` change
 * at SyncLane whatever the transition context, and a transition-lane render
 * runs in the scheduler's message task, which is not ordered after the paint.
 *
 * With the lead recorder installed (`window.__tugLead`), each tell and each
 * render-phase snapshot read is reported to it, so the motion verb can give
 * every commit its cause and its React time. Without it none of that runs.
 */

import { useSyncExternalStore as reactUseSyncExternalStore } from "react";
import { flushSync as reactFlushSync } from "react-dom";

import { isTugMotionEnabled } from "@/components/tugways/scale-timing";

import {
  AFTER_PAINT_DEADLINE_MS,
  type AfterPaintOptions,
  type CancelAfterPaint,
  scheduleAfterPaint,
} from "./after-paint";

type Subscribe = (onStoreChange: () => void) => () => void;

/** How a scope schedules its release: `scheduleAfterPaint`'s shape. */
export type ScheduleRelease = (flush: () => void, opts: AfterPaintOptions) => CancelAfterPaint;

/**
 * Run every fn once, each guarded; rethrow the first error after all have run.
 * A later error is reported rather than dropped.
 */
function runGuarded(fns: ReadonlyArray<() => void>): void {
  let first: { error: unknown } | null = null;
  for (const fn of fns) {
    try {
      fn();
    } catch (error) {
      if (first === null) first = { error };
      else console.error("[gesture-scope] a further callback threw", error);
    }
  }
  if (first !== null) throw first.error;
}

/** The parts of the lead recorder (`tugdeck/index.html`) this module calls. */
export interface TugLeadRecorder {
  tell(kind: "store" | "flushSync", label: string): void;
  read(): void;
  telling(flag: boolean): void;
}

declare global {
  interface Window {
    __tugLead?: TugLeadRecorder;
  }
}

/** The recorder, read once: it is installed before the bundle evaluates or not at all. */
const LEAD: TugLeadRecorder | undefined = (() => {
  if (typeof window === "undefined") return undefined;
  const lead = window.__tugLead;
  return lead !== undefined && typeof lead.tell === "function" ? lead : undefined;
})();

export type GestureScopeReason = "pointer" | "prelaunch";

export class GestureScope {
  private pending = false;
  /** The pending scope's frame has fired; its release is one task away. */
  private frameFired = false;
  /** When the pending hold's first `open` ran, for the deadline it may not pass. */
  private openedAt = 0;
  private cancelRelease: CancelAfterPaint | null = null;
  private bypass = 0;
  private held = new Set<() => void>();
  private queue: Array<() => void> = [];
  private readonly schedule: ScheduleRelease;
  private readonly motionEnabled: () => boolean;
  private readonly now: () => number;

  constructor(
    schedule: ScheduleRelease = scheduleAfterPaint,
    motionEnabled: () => boolean = isTugMotionEnabled,
    now: () => number = () => performance.now(),
  ) {
    this.schedule = schedule;
    this.motionEnabled = motionEnabled;
    this.now = now;
  }

  /**
   * Hold React until after the next paint. No-op with motion off. Joins a
   * pending scope whose frame has not fired; after it has, re-arms the release
   * past the next paint, within the hold's deadline.
   */
  open(_reason: GestureScopeReason): void {
    if (!this.motionEnabled()) return;
    if (this.pending) {
      if (!this.frameFired) return;
      const remaining = AFTER_PAINT_DEADLINE_MS - (this.now() - this.openedAt);
      // The hold has had its budget: join, rather than let a run of gestures starve React.
      if (remaining <= 0) return;
      this.cancelRelease?.();
      this.arm(remaining);
      return;
    }
    this.pending = true;
    this.openedAt = this.now();
    this.arm(AFTER_PAINT_DEADLINE_MS);
  }

  private arm(deadlineMs: number): void {
    this.frameFired = false;
    this.cancelRelease = null;
    const cancel = this.schedule(() => this.release(), {
      deadlineMs,
      onFrame: () => {
        this.frameFired = true;
      },
    });
    // A schedule with no frame to wait for releases synchronously.
    if (this.pending) this.cancelRelease = cancel;
  }

  isPending(): boolean {
    return this.pending;
  }

  /** Called by the wrapped subscribe's callback. Holds or runs `cb`. */
  tell(cb: () => void): void {
    if (this.bypass > 0 || !this.pending) {
      cb();
      return;
    }
    this.held.add(cb);
  }

  /** Drop `cb` from the held set (the wrapped unsubscribe calls this). */
  forget(cb: () => void): void {
    this.held.delete(cb);
  }

  /** `afterGesture`'s body: queue into the pending release, or run now. */
  enqueue(fn: () => void): void {
    if (!this.pending) {
      fn();
      return;
    }
    this.queue.push(fn);
  }

  /** Run every held callback, then every queued fn, once; the scope stays pending. */
  drain(): void {
    this.runHeldAndQueued();
  }

  /** Run every held callback, then every queued fn, once, and end the scope. */
  release(): void {
    this.pending = false;
    this.frameFired = false;
    this.cancelRelease = null;
    this.runHeldAndQueued();
  }

  private runHeldAndQueued(): void {
    if (this.held.size === 0 && this.queue.length === 0) return;
    const fns = [...this.held, ...this.queue];
    this.held.clear();
    this.queue = [];
    this.withBypass(() => runGuarded(fns));
  }

  withBypass<R>(fn: () => R): R {
    this.bypass += 1;
    try {
      return fn();
    } finally {
      this.bypass -= 1;
    }
  }
}

/** The singleton the hook and the verbs use. */
export const gestureScope = new GestureScope();

/** Pure: the subscribe React is handed. */
export function wrapSubscribe(
  subscribe: Subscribe,
  scope: GestureScope = gestureScope,
): Subscribe {
  return (onStoreChange) => {
    const deliver = LEAD
      ? (): void => {
          LEAD.telling(true);
          try {
            onStoreChange();
          } finally {
            LEAD.telling(false);
          }
        }
      : onStoreChange;
    const tugTellReact = (): void => {
      LEAD?.tell("store", "");
      scope.tell(deliver);
    };
    const unsubscribe = subscribe(tugTellReact);
    return () => {
      scope.forget(deliver);
      unsubscribe();
    };
  };
}

const wrappedBySubscribe = new WeakMap<Subscribe, Subscribe>();

/** The hook's cached lookup of `wrapSubscribe(subscribe, gestureScope)`. */
export function wrappedSubscribeFor(subscribe: Subscribe): Subscribe {
  let wrapped = wrappedBySubscribe.get(subscribe);
  if (wrapped === undefined) {
    wrapped = wrapSubscribe(subscribe, gestureScope);
    wrappedBySubscribe.set(subscribe, wrapped);
  }
  return wrapped;
}

/** Drop-in for React's hook: same signature, same semantics, plus the hold. */
export function useSyncExternalStore<T>(
  subscribe: Subscribe,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  const readSnapshot = LEAD
    ? (): T => {
        LEAD.read();
        return getSnapshot();
      }
    : getSnapshot;
  return reactUseSyncExternalStore(wrappedSubscribeFor(subscribe), readSnapshot, getServerSnapshot);
}

/**
 * Drop-in for react-dom's: drains the held set and the queued work (the scope
 * stays pending), then runs `fn` unheld. `fn` runs even if the drain threw; the
 * drain's error is rethrown after it, and `fn`'s own error wins over it.
 */
export function flushSync<R>(fn: () => R): R {
  LEAD?.tell("flushSync", "");
  return reactFlushSync(() => flushThrough(gestureScope, fn));
}

/** Pure: the wrapped `flushSync`'s body inside react-dom's flush, against `scope`. */
export function flushThrough<R>(scope: GestureScope, fn: () => R): R {
  return scope.withBypass(() => {
    let drainError: { error: unknown } | null = null;
    try {
      scope.drain();
    } catch (error) {
      drainError = { error };
    }
    let result: R;
    try {
      result = fn();
    } catch (error) {
      if (drainError !== null) console.error("[gesture-scope] the flushSync drain threw", drainError.error);
      throw error;
    }
    if (drainError !== null) throw drainError.error;
    return result;
  });
}

/** Run `fn` with the hold bypassed and no flush. For the deck store's tells. */
export function tellReactNow(fn: () => void): void {
  gestureScope.withBypass(fn);
}

/** Queue React-facing work into the pending release; runs inline when no scope is pending. */
export function afterGesture(fn: () => void): void {
  gestureScope.enqueue(fn);
}

const POINTER_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const;

type ListenerTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Capture-phase listeners at `target` for the five pointer events; returns the remover. */
export function installGestureScope(target: ListenerTarget): () => void {
  const onPointer = (): void => gestureScope.open("pointer");
  for (const type of POINTER_EVENTS) target.addEventListener(type, onPointer, true);
  return () => {
    for (const type of POINTER_EVENTS) target.removeEventListener(type, onPointer, true);
  };
}

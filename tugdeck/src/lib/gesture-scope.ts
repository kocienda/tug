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
 * The motion gate is the second hold, and it is the settle's ([B05] of
 * set-up-and-go). Every gesture is store commit → React commit → plan →
 * beats → land, and nothing may commit between the first frame and the land.
 * The settle engine closes the gate when its beats launch and opens it after
 * the land; while it is closed every tell and every `afterGesture` body is
 * held exactly as a pending scope holds them, and the end of a scope releases
 * nothing the gate still holds. A gesture that arrives mid-motion is a
 * retarget: its arm opens the gate at once, so what was held joins the new
 * gesture's set-up rather than its motion. The gate has a cap, like the
 * session cards' hold, so a settle that never lands cannot hold React for
 * good; the engine's release is what normally ends it.
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
  /** Closed motion gates; the gate holds while any is closed. */
  private motionHolds = 0;
  /** Bumped at every close, so a caller can tell the gate it saw from a later one. */
  private motionEpoch = 0;
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

  /** Whether a settle's motion gate is closed. */
  isMotionHeld(): boolean {
    return this.motionHolds > 0;
  }

  /**
   * The closed gate's epoch, or `null` when the gate is open. Equal readings
   * either side of some work mean the same gate stood closed across it: no
   * settle opened it and closed another.
   */
  motionGate(): number | null {
    return this.motionHolds > 0 ? this.motionEpoch : null;
  }

  /**
   * Close the motion gate until the returned release runs, or `capMs`
   * passes. No-op with motion off. The release is idempotent; the last one
   * out runs everything held, unless a scope is still pending, whose own
   * release then does. `onCap` runs after a cap-fired release only, so a
   * holder can drop its handle and leave the state a normal release leaves.
   */
  holdMotion(capMs: number, onCap?: () => void): () => void {
    if (!this.motionEnabled()) return () => {};
    this.motionHolds += 1;
    this.motionEpoch += 1;
    let open = true;
    let cap: ReturnType<typeof setTimeout> | null = null;
    const release = (): void => {
      if (!open) return;
      open = false;
      if (cap !== null) clearTimeout(cap);
      this.motionHolds -= 1;
      if (this.motionHolds === 0 && !this.pending) this.runHeldAndQueued();
    };
    cap = setTimeout(() => {
      release();
      onCap?.();
    }, capMs);
    return release;
  }

  /** Whether a tell or a queued body waits now. */
  private holding(): boolean {
    return this.pending || this.motionHolds > 0;
  }

  /** Called by the wrapped subscribe's callback. Holds or runs `cb`. */
  tell(cb: () => void): void {
    if (this.bypass > 0 || !this.holding()) {
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
    if (!this.holding()) {
      fn();
      return;
    }
    this.queue.push(fn);
  }

  /** Run every held callback, then every queued fn, once; the scope stays pending. */
  drain(): void {
    this.runHeldAndQueued();
  }

  /**
   * End the scope, and run every held callback, then every queued fn, once —
   * unless the motion gate is closed, whose release then runs them.
   */
  release(): void {
    this.pending = false;
    this.frameFired = false;
    this.cancelRelease = null;
    if (this.motionHolds === 0) this.runHeldAndQueued();
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

/**
 * Pure: an observer callback that waits out a closed motion gate ([B05] of
 * set-up-and-go-fixups) — for `IntersectionObserver` and `ResizeObserver`
 * alike.
 *
 * The platform delivers both in the rendering update, after layout, and what
 * answers them is not ours to sequence: CodeMirror answers an intersection
 * with a synchronous `view.measure()`, and the pane chrome's observers re-read
 * and re-truncate at every width a tweening frame passes through. Each is a
 * read and a write mid-motion. While the gate is closed the deliveries are
 * kept, in order, and handed over once at its release, as one call carrying
 * every entry: both observers report changes, so the last entry for a target
 * is its standing state and nothing is lost.
 *
 * Returns the held callback and its release. The release drops what is kept
 * and makes the queued hand-over a no-op, and the observer built on the
 * callback calls it from `disconnect` ({@link observeHeld}): a card unmounting
 * under a settle disconnects its observers mid-motion, and a delivery kept for
 * it would otherwise run at the gate's release against a detached target.
 * The shape is `wrapSubscribe`'s `forget` ([L27]: every acquisition returns
 * its release). An observer observed again after a disconnect holds afresh.
 */
export function holdDeliveries<E, O>(
  cb: (entries: E[], observer: O) => void,
  scope: GestureScope = gestureScope,
  heldWhen: (entries: E[]) => boolean = () => true,
): HeldDelivery<E, O> {
  let kept: { entries: E[]; observer: O } | null = null;
  // Once a delivery is kept, every later one is kept behind it, so the
  // callback sees them in the order the platform made them.
  const holds = (entries: E[]): boolean =>
    scope.isMotionHeld() && (kept !== null || heldWhen(entries));
  const held = (entries: E[], observer: O): void => {
    if (!holds(entries)) {
      cb(entries, observer);
      return;
    }
    if (kept !== null) {
      kept.entries.push(...entries);
      return;
    }
    kept = { entries: [...entries], observer };
    scope.enqueue(() => {
      const due = kept;
      kept = null;
      if (due !== null) cb(due.entries, due.observer);
    });
  };
  HELD_CALLBACKS.set(held, holds as (entries: unknown[]) => boolean);
  return {
    callback: held,
    release: () => {
      kept = null;
    },
  };
}

/** What {@link holdDeliveries} returns: the callback the platform is handed, and its release. */
export interface HeldDelivery<E, O> {
  callback: (entries: E[], observer: O) => void;
  release: () => void;
}

/**
 * Construct `Native` on a held delivery whose `disconnect` releases what the
 * gate kept for it, before the platform's own disconnect.
 */
export function observeHeld<E, O, T extends { disconnect(): void }>(
  construct: (callback: (entries: E[], observer: O) => void) => T,
  delivery: HeldDelivery<E, O>,
): T {
  const observer = construct(delivery.callback);
  const disconnect = observer.disconnect;
  observer.disconnect = function (this: T): void {
    delivery.release();
    disconnect.call(this);
  };
  return observer;
}

const HELD_CALLBACKS = new WeakMap<object, (entries: unknown[]) => boolean>();

/**
 * Whether a delivery of `entries` to `callback` is being kept by the gate
 * right now — what the land record's delivery counter asks, so a delivery
 * the gate held is counted where it runs, at the release, and not where it
 * was offered.
 */
export function isDeliveryHeld(callback: object, entries: unknown[]): boolean {
  return HELD_CALLBACKS.get(callback)?.(entries) ?? false;
}

/**
 * Whether every entry's target stands inside a still-crossing pane's content
 * box — the held interior, which the crossing's own argument says delivers
 * nothing while the edge moves. What it does deliver is the interior meeting
 * the clip, a cell the growing box brings on screen, and that waits for the
 * land like the rest ([B05] of set-up-and-go-fixups).
 */
function insideHeldInterior(entries: unknown[]): boolean {
  return (
    entries.length > 0 &&
    entries.every((entry) => {
      const target = (entry as { target?: unknown }).target;
      return (
        target instanceof Element &&
        target.closest(".tug-pane[data-still-crossing] .tug-pane-content") !== null
      );
    })
  );
}

/**
 * A `ResizeObserver` whose deliveries wait out a closed motion gate — for an
 * observer that answers a size the settle tweens, and whose answer is a
 * read and a write that has no business landing mid-motion: the pane chrome
 * re-reading its accessory and re-truncating its activity line at every width
 * a bullseye passes through.
 *
 * Opt-in by site for an observer outside any held interior — the pane chrome
 * — which the constructor's own hold leaves alone, because the deck's layout
 * answers its observers mid-settle — a fold's height, a card host's
 * refinement — and holding those would hold the settle itself.
 */
export function heldResizeObserver(callback: ResizeObserverCallback): ResizeObserver {
  const delivery = holdDeliveries<ResizeObserverEntry, ResizeObserver>(callback);
  return observeHeld((cb) => new ResizeObserver(cb), delivery);
}

/**
 * Every `IntersectionObserver` constructed from here on is held by the gate.
 * Nothing in the deck's own layout answers an intersection, so the hold is
 * installed on the constructor rather than opted into by site.
 */
function installIntersectionHold(): void {
  if (typeof window === "undefined") return;
  const Native = window.IntersectionObserver;
  if (typeof Native !== "function") return;
  const Wrapped = function (
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ): IntersectionObserver {
    const delivery = holdDeliveries<IntersectionObserverEntry, IntersectionObserver>(callback);
    return observeHeld((cb) => new Native(cb, options), delivery);
  } as unknown as typeof IntersectionObserver;
  Wrapped.prototype = Native.prototype;
  window.IntersectionObserver = Wrapped;
}

installIntersectionHold();

/**
 * Every `ResizeObserver` constructed from here on holds the deliveries that
 * land wholly inside a held interior. One outside it — the deck's own
 * layout, a card host, the canvas — is delivered as the platform makes it,
 * because the settle answers those mid-motion. Installed when this module
 * evaluates, which `lib/land-frame-record.ts` guarantees comes first, so its
 * delivery counter wraps this one and counts a held delivery where it runs.
 */
function installInteriorResizeHold(): void {
  if (typeof window === "undefined") return;
  const Native = window.ResizeObserver;
  if (typeof Native !== "function") return;
  const Wrapped = function (callback: ResizeObserverCallback): ResizeObserver {
    const delivery = holdDeliveries<ResizeObserverEntry, ResizeObserver>(
      callback,
      gestureScope,
      insideHeldInterior,
    );
    return observeHeld((cb) => new Native(cb), delivery);
  } as unknown as typeof ResizeObserver;
  Wrapped.prototype = Native.prototype;
  window.ResizeObserver = Wrapped;
}

installInteriorResizeHold();

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

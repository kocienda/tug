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
 * Two bypasses. The wrapped `flushSync` is how code says "I need the DOM now":
 * it drains the held set inside react-dom's flush and runs its body unheld,
 * but leaves the scope pending, so a `flushSync` early in a gesture does not
 * end the hold for the rest of it. `tellReactNow` runs its body unheld without
 * a flush, for the deck store's own deliberate inline tells.
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

import { scheduleAfterPaint } from "./after-paint";

type Subscribe = (onStoreChange: () => void) => () => void;

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
  private bypass = 0;
  private held = new Set<() => void>();
  private queue: Array<() => void> = [];
  private readonly schedule: (flush: () => void) => void;
  private readonly motionEnabled: () => boolean;

  constructor(
    schedule: (flush: () => void) => void = scheduleAfterPaint,
    motionEnabled: () => boolean = isTugMotionEnabled,
  ) {
    this.schedule = schedule;
    this.motionEnabled = motionEnabled;
  }

  /** Hold React until after the next paint. No-op with motion off; joins a pending scope. */
  open(_reason: GestureScopeReason): void {
    if (!this.motionEnabled()) return;
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => this.release());
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

  /** Run every held callback once; the scope stays pending and the queue stays queued. */
  drainHeld(): void {
    if (this.held.size === 0) return;
    const held = [...this.held];
    this.held.clear();
    this.withBypass(() => {
      for (const cb of held) cb();
    });
  }

  /** Run every held callback and queued fn once, in insertion order, and end the scope. */
  release(): void {
    this.pending = false;
    if (this.held.size === 0 && this.queue.length === 0) return;
    const held = [...this.held];
    const queue = this.queue;
    this.held.clear();
    this.queue = [];
    this.withBypass(() => {
      for (const cb of held) cb();
      for (const fn of queue) fn();
    });
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

/** Drop-in for react-dom's: drains the held set (the scope stays pending), then runs `fn` unheld. */
export function flushSync<R>(fn: () => R): R {
  LEAD?.tell("flushSync", "");
  return reactFlushSync(() =>
    gestureScope.withBypass(() => {
      gestureScope.drainHeld();
      return fn();
    }),
  );
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

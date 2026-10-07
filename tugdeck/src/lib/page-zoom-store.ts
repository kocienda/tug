/**
 * page-zoom-store.ts — the host's page zoom, as the deck hears it.
 *
 * View › Zoom In / Zoom Out / Actual Size set `WKWebView.pageZoom` in the
 * host. A page zoom is transparent to CSS px — the deck's layout, its
 * measurements and every `getBoundingClientRect` are unchanged in kind — so
 * nothing here is a scale the deck applies or divides by. What the deck
 * needs is to *know* a zoom is happening, so it can say so: the factor it is
 * going to, from the moment the chord lands, until the page has painted at
 * it ([B04], [B05] of view-zoom-performance-and-feedback).
 *
 * The host speaks three times, all through `window.__tugBridge`
 * (`MainWindow.applyPageZoom` / `bridgePageZoom` — keep the names in
 * lockstep):
 *
 * - `onPageZoom({factor})` — the standing factor, on every `frontendReady`.
 *   No transition.
 * - `onPageZoomWillChange({factor, from})` — sent ahead of the `pageZoom`
 *   write on the same in-order IPC, so it lands before the relayout. The
 *   snapshot goes `zooming` with the target factor.
 * - `onPageZoomDidApply(factor)` — awaited by the host. Resolves once two
 *   frames have been delivered after the zoom (the first lays out at the new
 *   factor, the second is painted past it) **and** every hold has been
 *   released. A hold is how deck work that answers the zoom's resize — the
 *   canvas's settled-resize rail re-tune — keeps the "after" notice from
 *   arriving before it lands. Only the latest zoom's resolution settles the
 *   snapshot, so a double-tap stays `zooming` until its second step is done.
 *
 * [L02] — read through `useSyncExternalStore`. [P11] — no polling: the store
 * is fed by the host's pushes and by frames, and asks nothing at an interval.
 *
 * @module lib/page-zoom-store
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";

export interface PageZoomSnapshot {
  /**
   * The factor the page is at, or is going to while `zooming`. `null` before
   * the host has said anything — and forever outside Tug.app, where there is
   * no host to ask.
   */
  factor: number | null;
  phase: "settled" | "zooming";
}

const INITIAL: PageZoomSnapshot = { factor: null, phase: "settled" };

/** Schedules `cb` for the next frame; `requestAnimationFrame` in the deck. */
export type FrameScheduler = (cb: () => void) => void;

/** Frames delivered after the zoom before it counts as painted. */
const SETTLE_FRAMES = 2;

/** Zoom factors arrive as doubles (0.7999999…); the step grid is 1 %. */
export function normalizeFactor(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw * 100) / 100;
}

export class PageZoomStore {
  private _snapshot: PageZoomSnapshot = INITIAL;
  private _listeners: Array<() => void> = [];
  private _generation = 0;
  private _holds = 0;
  private _waiters: Array<() => void> = [];

  constructor(private readonly nextFrame: FrameScheduler) {}

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): PageZoomSnapshot => this._snapshot;

  /** The standing factor, with no transition. Ignored mid-zoom. */
  report(rawFactor: unknown): void {
    const factor = normalizeFactor(rawFactor);
    if (factor === null || this._snapshot.phase === "zooming") return;
    this.set({ factor, phase: "settled" });
  }

  /** The host is about to zoom to `rawFactor`. */
  willChange(rawFactor: unknown): void {
    const factor = normalizeFactor(rawFactor);
    if (factor === null) return;
    this._generation += 1;
    this.set({ factor, phase: "zooming" });
  }

  /**
   * The host has set the zoom; resolve once it is painted and nothing is
   * held. Settles the snapshot only if no later zoom has begun.
   */
  didApply(rawFactor: unknown): Promise<void> {
    const generation = this._generation;
    return new Promise<void>((resolve) => {
      let frames = 0;
      const tick = (): void => {
        frames += 1;
        if (frames < SETTLE_FRAMES) {
          this.nextFrame(tick);
          return;
        }
        this.whenUnheld(() => {
          if (generation === this._generation) {
            const factor = normalizeFactor(rawFactor) ?? this._snapshot.factor;
            this.set({ factor, phase: "settled" });
          }
          resolve();
        });
      };
      this.nextFrame(tick);
    });
  }

  /**
   * Hold the "after" notice while work answering the zoom is outstanding.
   * Returns the release; a hold taken while settled is a no-op, so callers
   * may take one unconditionally on any resize.
   */
  hold(): () => void {
    if (this._snapshot.phase !== "zooming") return () => {};
    this._holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._holds -= 1;
      if (this._holds === 0) this.drainWaiters();
    };
  }

  /** Whether a zoom is in flight. */
  isZooming(): boolean {
    return this._snapshot.phase === "zooming";
  }

  private whenUnheld(cb: () => void): void {
    if (this._holds === 0) {
      cb();
      return;
    }
    this._waiters.push(cb);
  }

  /** A release lands mid-frame; settle after the frame it painted in. */
  private drainWaiters(): void {
    const waiters = this._waiters;
    this._waiters = [];
    let frames = 0;
    const tick = (): void => {
      frames += 1;
      if (frames < SETTLE_FRAMES) {
        this.nextFrame(tick);
        return;
      }
      for (const w of waiters) w();
    };
    if (waiters.length > 0) this.nextFrame(tick);
  }

  private set(next: PageZoomSnapshot): void {
    if (
      next.factor === this._snapshot.factor &&
      next.phase === this._snapshot.phase
    ) {
      return;
    }
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }
}

export const pageZoomStore = new PageZoomStore((cb) => {
  requestAnimationFrame(() => cb());
});

/** React read of the host's page zoom ([L02]). */
export function usePageZoom(): PageZoomSnapshot {
  return useSyncExternalStore(pageZoomStore.subscribe, pageZoomStore.getSnapshot);
}

/** The host→web bridge object; only the zoom callbacks concern us here. */
interface TugBridge {
  onPageZoom?: (report: Record<string, unknown>) => void;
  onPageZoomWillChange?: (report: Record<string, unknown>) => void;
  onPageZoomDidApply?: (factor: unknown) => Promise<void>;
}

interface BridgeHost {
  __tugBridge?: TugBridge;
}

/**
 * Install the zoom receivers on `__tugBridge`. Called once from deck boot;
 * safe to call again. The bridge object is shared with other host callbacks,
 * so it is merged into with `??=`, never replaced.
 */
export function installPageZoomBridge(store: PageZoomStore = pageZoomStore): void {
  const w = globalThis as unknown as BridgeHost;
  const bridge = (w.__tugBridge ??= {});
  if (bridge.onPageZoomWillChange !== undefined) return;
  bridge.onPageZoom = (report) => store.report(report?.factor);
  bridge.onPageZoomWillChange = (report) => store.willChange(report?.factor);
  bridge.onPageZoomDidApply = (factor) => store.didApply(factor);
}

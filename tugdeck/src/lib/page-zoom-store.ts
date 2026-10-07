/**
 * page-zoom-store.ts — View › Zoom, applied by the deck to its own root.
 *
 * The host owns the factor: the View menu, the ⌘0 / ⌘+ / ⌘− chords, the
 * 50–200 % range and its persistence. The deck applies it, and this store is
 * where it does. A zoom is a `transform: scale(f)` with origin `0 0` on
 * `#deck-container`, which is sized to the window ÷ f, so the deck lays out
 * into the larger (or smaller) room at its 100 % layout and the picture of
 * that layout is scaled to fill the window. `WKWebView.pageZoom` stays at 1.0:
 * WebKit floors every face at 9 zoomed px under it (and under CSS `zoom`), so
 * below 90 % the type stopped shrinking while the boxes kept going.
 *
 * # Two coordinate spaces
 *
 * Under the transform the DOM speaks two spaces. A rect
 * (`getBoundingClientRect`, `getClientRects`, an `IntersectionObserver`
 * entry), a pointer (`clientX/Y`), `elementFromPoint` and
 * `window.innerWidth/innerHeight` are **viewport px**. Everything layout reads
 * or writes — `offset*`, `client*`, `scroll*`, a `ResizeObserver` size, a
 * computed style, an inline `left`/`width` — is **layout px**. Layout px are
 * viewport px ÷ the factor. A site that mixes them converts explicitly through
 * {@link layoutPxOf} / {@link viewportPxOf}; where a layout property answers
 * the same question (`offsetWidth` for a rect's width), reading it is better
 * than converting. Nothing patches a DOM prototype to hide the difference.
 *
 * # What one apply writes
 *
 * In one task: the root's inline `transform`, and on `:root` the two custom
 * properties `--tug-viewport-width` / `--tug-viewport-height` (`100vw / f`,
 * `100vh / f`). The root sizes itself from them (`globals.css`), and anything
 * that wants "the window, in the deck's px" reads them instead of `vw`/`vh`,
 * which still resolve against the real window. At 1.0 all three are removed,
 * so the 100 % deck carries no transform at all.
 *
 * # The host's two calls
 *
 * Both through `window.__tugBridge` (`MainWindow.applyPageZoom` /
 * `bridgePageZoom` — keep the names in lockstep):
 *
 * - `onPageZoom({factor})` — the standing factor, on every `frontendReady`,
 *   sent ahead of the reveal so a deck launched at a persisted factor never
 *   shows at 100 %. Applied with no transition.
 * - `onPageZoomApply(factor)` — a zoom step, awaited by the host. The store
 *   goes `zooming`, writes the transform, waits until two frames have been
 *   delivered after it (the first lays out at the new factor, the second is
 *   painted past it) and every hold has been released, then resolves. A hold
 *   is how deck work answering the root's resize — the canvas's
 *   settled-resize rail re-tune — keeps the step from reading as done before
 *   it lands. Only the latest step settles the snapshot, so a double-tap
 *   stays `zooming` until its second step is done.
 *
 * [L02] — read through `useSyncExternalStore`. [P11] — no polling: fed by the
 * host's calls and by frames, never by an interval.
 *
 * @module lib/page-zoom-store
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";

export interface PageZoomSnapshot {
  /** The factor the deck is at, or is going to while `zooming`. */
  factor: number;
  phase: "settled" | "zooming";
}

const INITIAL: PageZoomSnapshot = { factor: 1, phase: "settled" };

/** Schedules `cb` for the next frame; `requestAnimationFrame` in the deck. */
export type FrameScheduler = (cb: () => void) => void;

/** Puts `factor` on the page: the root's transform and size. */
export type DeckScaleWriter = (factor: number) => void;

/** Frames delivered after the zoom before it counts as painted. */
const SETTLE_FRAMES = 2;

/** The custom properties the root sizes itself from, set on `:root`. */
export const VIEWPORT_WIDTH_PROPERTY = "--tug-viewport-width";
export const VIEWPORT_HEIGHT_PROPERTY = "--tug-viewport-height";

/** Zoom factors arrive as doubles (0.7999999…); the step grid is 1 %. */
export function normalizeFactor(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw * 100) / 100;
}

/** A viewport-px length in layout px at `factor`. */
export function layoutPxAt(viewportPx: number, factor: number): number {
  return viewportPx / factor;
}

/** A layout-px length in viewport px at `factor`. */
export function viewportPxAt(layoutPx: number, factor: number): number {
  return layoutPx * factor;
}

/**
 * The deck's writer: the root's transform, and the window ÷ factor its size
 * reads. At 1.0 everything is removed, so the CSS fallbacks (the window
 * itself, no transform) hold.
 */
export function writeDeckScale(factor: number): void {
  const rootStyle = document.documentElement.style;
  const deck = document.getElementById("deck-container");
  if (factor === 1) {
    rootStyle.removeProperty(VIEWPORT_WIDTH_PROPERTY);
    rootStyle.removeProperty(VIEWPORT_HEIGHT_PROPERTY);
    if (deck !== null) deck.style.transform = "";
    return;
  }
  rootStyle.setProperty(VIEWPORT_WIDTH_PROPERTY, `calc(100vw / ${factor})`);
  rootStyle.setProperty(VIEWPORT_HEIGHT_PROPERTY, `calc(100vh / ${factor})`);
  if (deck !== null) deck.style.transform = `scale(${factor})`;
}

export class PageZoomStore {
  private _snapshot: PageZoomSnapshot = INITIAL;
  private _listeners: Array<() => void> = [];
  private _generation = 0;
  private _holds = 0;
  private _waiters: Array<() => void> = [];

  constructor(
    private readonly nextFrame: FrameScheduler,
    private readonly writeScale: DeckScaleWriter,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  getSnapshot = (): PageZoomSnapshot => this._snapshot;

  /** The factor the deck is drawn at — the one every conversion uses. */
  getFactor(): number {
    return this._snapshot.factor;
  }

  /** A viewport-px reading (a rect, a pointer) in layout px. */
  layoutPxOf(viewportPx: number): number {
    return layoutPxAt(viewportPx, this._snapshot.factor);
  }

  /** A layout-px value in viewport px. */
  viewportPxOf(layoutPx: number): number {
    return viewportPxAt(layoutPx, this._snapshot.factor);
  }

  /** The standing factor, applied with no transition. Ignored mid-step. */
  report(rawFactor: unknown): void {
    const factor = normalizeFactor(rawFactor);
    if (factor === null || this._snapshot.phase === "zooming") return;
    if (factor === this._snapshot.factor) return;
    this.writeScale(factor);
    this.set({ factor, phase: "settled" });
  }

  /**
   * A zoom step to `rawFactor`: written now, resolved once painted and
   * unheld. Settles the snapshot only if no later step has begun.
   */
  apply(rawFactor: unknown): Promise<void> {
    const factor = normalizeFactor(rawFactor);
    if (factor === null) return Promise.resolve();
    this._generation += 1;
    const generation = this._generation;
    // The snapshot first, then the write: a subscriber that answers the
    // step (the readout) and the root's new transform land in one task, so
    // the frame that paints the zoom paints its readout.
    this.set({ factor, phase: "zooming" });
    this.writeScale(factor);
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
            this.set({ factor: this._snapshot.factor, phase: "settled" });
          }
          resolve();
        });
      };
      this.nextFrame(tick);
    });
  }

  /**
   * Hold a step's resolution while work answering it is outstanding.
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

  /** Whether a zoom step is in flight. */
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
}, writeDeckScale);

/** A viewport-px reading in layout px, at the deck's current factor. */
export function layoutPxOf(viewportPx: number): number {
  return pageZoomStore.layoutPxOf(viewportPx);
}

/** A layout-px value in viewport px, at the deck's current factor. */
export function viewportPxOf(layoutPx: number): number {
  return pageZoomStore.viewportPxOf(layoutPx);
}

/** The factor the deck is drawn at. */
export function pageZoomFactor(): number {
  return pageZoomStore.getFactor();
}

/**
 * `el`'s border box in layout px, origin and all: its
 * `getBoundingClientRect` divided by the factor. For a module whose rects
 * only ever meet each other and the layout values they are written into — a
 * FLIP's First and Last, a rail's travel — converting at the read is the
 * whole of the conversion. At 1.0 it is the rect itself.
 */
export function layoutRectOf(el: Element): DOMRect {
  return layoutRectFrom(el.getBoundingClientRect());
}

/**
 * A viewport-px rect someone else measured — a `Range`'s, a caller's
 * `getRect` — in layout px. At 1.0 it is the rect itself.
 */
export function layoutRectFrom(rect: DOMRect): DOMRect {
  const f = pageZoomStore.getFactor();
  if (f === 1) return rect;
  return new DOMRect(rect.x / f, rect.y / f, rect.width / f, rect.height / f);
}

/**
 * The element everything visible lives in: `#deck-container`, the box the
 * zoom scales. An element appended to `document.body` instead draws at
 * 100 % whatever the zoom, and its `position: fixed` means the real window
 * rather than the deck's, so a fallback that would reach for `body` reaches
 * here. `body` only when there is no deck root at all (a unit test, a
 * standalone harness).
 */
export function deckRootElement(): HTMLElement {
  return document.getElementById("deck-container") ?? document.body;
}

/** React read of the deck's zoom ([L02]). */
export function usePageZoom(): PageZoomSnapshot {
  return useSyncExternalStore(pageZoomStore.subscribe, pageZoomStore.getSnapshot);
}

/**
 * The zoom levels, in order: what View › Zoom In and Zoom Out step along and
 * what the Layout card's Zoom row offers. Fine near 100 %, coarse toward the
 * ends, which are the bounds. The host owns them (`MainWindow.pageZoomLevels`
 * in `tugapp/Sources/MainWindow.swift` — keep the two in lockstep); only the
 * app-test harness ever sets a factor between them.
 */
export const PAGE_ZOOM_LEVELS: readonly number[] = [
  0.5, 0.67, 0.8, 0.9, 1, 1.25, 1.5, 2,
];

/** The level `factor` stands at, or null between levels (a harness factor). */
export function pageZoomLevelOf(factor: number): number | null {
  return PAGE_ZOOM_LEVELS.find((level) => Math.abs(level - factor) < 0.005) ?? null;
}

interface PageZoomMessageHost {
  webkit?: {
    messageHandlers?: {
      pageZoom?: { postMessage: (value: unknown) => void };
    };
  };
}

/**
 * Ask the host for a level. The host owns the factor and its persistence, so
 * this is a request: the factor arrives back through `onPageZoomApply`, which
 * is what moves the store, the readout and every surface that reads them. A
 * deck with no host (a browser tab) has nothing to ask, and nothing happens.
 */
export function requestPageZoom(factor: number): void {
  const w = globalThis as unknown as PageZoomMessageHost;
  w.webkit?.messageHandlers?.pageZoom?.postMessage({ factor });
}

/** The host→web bridge object; only the zoom callbacks concern us here. */
interface TugBridge {
  onPageZoom?: (report: Record<string, unknown>) => void;
  onPageZoomApply?: (factor: unknown) => Promise<void>;
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
  if (bridge.onPageZoomApply !== undefined) return;
  bridge.onPageZoom = (report) => store.report(report?.factor);
  bridge.onPageZoomApply = (factor) => store.apply(factor);
}

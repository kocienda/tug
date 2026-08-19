/**
 * pane-occlusion-controller.ts — sole authority for the `data-occluded` DOM
 * attribute on every `.tug-pane[data-pane-id]` element within the deck root.
 *
 * A pane whose frame rect is fully covered by a single opaque pane above it
 * in z-order gets `data-occluded="true"`; tug-pane.css turns that into
 * `visibility: hidden` across the frame's whole subtree, so WebKit drops the
 * pane's graphics tile backing while layout, scroll positions, editor state,
 * eviction ledgers, and running animations are all preserved (visibility
 * invalidates paint only — nothing is unmounted, nothing re-measures).
 *
 * Timing is asymmetric, by design:
 *
 *  - REVEALS are synchronous. The apply pass runs in `useLayoutEffect` after
 *    every store commit (and on canvas resize), so the visibility flip lands
 *    in the same paint as the z-order / geometry change that exposed the
 *    pane — the compositor never presents a frame with an exposed-but-hidden
 *    pane. Raise, close of a covering pane, deck restore, resize, and
 *    imposition changes all reach this path through the store snapshot.
 *
 *  - HIDES are lazy. Newly-covered panes are stamped only after a settle
 *    delay, and only while no pane frame carries a running animation or
 *    transition (the imposition FLIP tween, the collapse height transition
 *    — both live on the frame element), so a pane is never hidden while its
 *    coverer is still visually en route to the rect that covers it.
 *
 * Geometry is read as `offset*` — untransformed layout pixels in the shared
 * container space — so a mid-FLIP inverse transform never pollutes the
 * decision: occlusion always describes the committed arrangement. Z-order is
 * read back from each frame's inline `z-index`, which React renders from the
 * store's pane order in the same commit this controller's effect follows.
 *
 * Appearance-zone gestures (drag, resize, Lens resize) move frames without
 * store commits, so the three gesture machines in `tug-pane.tsx` bracket
 * their moves with `paneOcclusionGesture.begin()` / `.end()`: begin reveals
 * every pane immediately and blocks hides for the duration; end re-arms the
 * settle pass. The commit at gesture end then recomputes from final geometry.
 *
 * The occlusion test is honest about paint, conservatively:
 *  - a coverer counts only when its chrome's computed background alpha is 1
 *    and both frame and chrome have `opacity: 1`;
 *  - rounded corners are accounted for — a covered corner must either
 *    coincide with the coverer's corner (equal-or-smaller radius, so the
 *    rounding masks align) or clear the coverer's corner-rounding zone;
 *  - only single-coverer containment counts (no union coverage), and the
 *    active pane is never occluded.
 * When the test cannot prove coverage it leaves the pane visible — the
 * failure mode is a missed hide, never a hidden exposed pane. The one
 * accepted paint delta is the buried pane's own drop shadow (it paints
 * outside the covered rect); stacked identical shadows compose to a
 * near-identical ring, verified invisible in the live probe.
 *
 * Tuglaws: [L03] layout-effect registration; [L06] occlusion is appearance
 * state, written to the DOM, never React state; [L10] one responsibility;
 * [L22] store observation drives direct DOM mutation from geometry the deck
 * already owns; [L23] a hidden pane keeps every piece of user-observable
 * state and is restored by a paint-only flip.
 *
 * @module components/chrome/pane-occlusion-controller
 */

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { useDeckManager } from "@/deck-manager-context";

/** Settle delay before a newly-covered pane is actually hidden. Restarted by
 *  every apply pass and re-deferred while any frame is animating; this is a
 *  quiescence debounce, not a duration matched to any motion design. */
const HIDE_SETTLE_MS = 400;

/** Layout-pixel tolerance for containment and corner coincidence. `offset*`
 *  values are integers rounded from fractional layout, so exact-stacked
 *  panes can disagree by a rounding step. */
const EDGE_EPSILON_PX = 1;

interface PaneGeom {
  el: HTMLElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
  z: number;
}

/**
 * Alpha channel of a computed CSS color. WebKit emits whatever functional
 * form the token was authored in — the theme tokens resolve to `oklch(…)`,
 * legacy values to `rgb()`/`rgba()` — so this recognizes the CSS color
 * functions generally: alpha is the value after `/` (modern syntax), the
 * fourth comma component (legacy `rgba`/`hsla`), or 1 when omitted. Returns
 * 0 (treat as not opaque) for anything it cannot parse, so an unrecognized
 * format can never license a hide.
 */
const COLOR_FN_RE = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/;

function colorAlpha(color: string): number {
  const c = color.trim();
  if (!COLOR_FN_RE.test(c)) return 0;
  const slash = c.lastIndexOf("/");
  if (slash !== -1) {
    const a = parseFloat(c.slice(slash + 1));
    return Number.isFinite(a) ? a : 0;
  }
  if (c.startsWith("rgba(") || c.startsWith("hsla(")) {
    const last = c.slice(c.indexOf("(") + 1, -1).split(",").pop();
    const a = last === undefined ? NaN : parseFloat(last);
    return Number.isFinite(a) ? a : 0;
  }
  return 1;
}

/** A coverer's paint facts, resolved once per pass per pane. */
interface PaintFacts {
  opaque: boolean;
  radius: number;
}

function readPaintFacts(frame: HTMLElement): PaintFacts {
  const chrome = frame.querySelector<HTMLElement>(".tug-pane-chrome");
  if (chrome === null) return { opaque: false, radius: 0 };
  const chromeStyle = getComputedStyle(chrome);
  const frameStyle = getComputedStyle(frame);
  // No visibility term here, deliberately: pane-chrome visibility is only
  // ever hidden by THIS controller, and mid-pass a coverer's own hide is
  // stale state (the reveal loop runs after the compute). A pane hidden by
  // us still covers what it contains — its own hide was licensed by a
  // visible opaque pane containing it, and containment is transitive.
  const opaque =
    colorAlpha(chromeStyle.backgroundColor) >= 1 &&
    parseFloat(chromeStyle.opacity) >= 1 &&
    parseFloat(frameStyle.opacity) >= 1;
  // The chrome rounds all four corners with one token; take the largest
  // corner in case a future variant differs, staying conservative.
  const radius = Math.max(
    parseFloat(chromeStyle.borderTopLeftRadius) || 0,
    parseFloat(chromeStyle.borderTopRightRadius) || 0,
    parseFloat(chromeStyle.borderBottomLeftRadius) || 0,
    parseFloat(chromeStyle.borderBottomRightRadius) || 0,
  );
  return { opaque, radius };
}

/**
 * Whether coverer `c` (opaque, corner radius `cr`) fully covers the painted
 * region of buried pane `b` (corner radius `br`). Containment plus per-corner
 * honesty: each corner of `b` must either coincide with the matching corner
 * of `c` (rounding masks align when `br <= cr` is not required — equal radii
 * in practice, but a larger buried radius only shrinks `b`'s paint) or lie
 * inside `c` inset by `cr`, clear of every corner-rounding zone.
 */
function coversOpaquely(c: PaneGeom, b: PaneGeom, cr: number): boolean {
  const e = EDGE_EPSILON_PX;
  if (
    b.left < c.left - e ||
    b.top < c.top - e ||
    b.right > c.right + e ||
    b.bottom > c.bottom + e
  ) {
    return false;
  }
  const corners: Array<[number, number, number, number]> = [
    [b.left, b.top, c.left, c.top],
    [b.right, b.top, c.right, c.top],
    [b.left, b.bottom, c.left, c.bottom],
    [b.right, b.bottom, c.right, c.bottom],
  ];
  for (const [bx, by, cx, cy] of corners) {
    const coincides = Math.abs(bx - cx) <= e && Math.abs(by - cy) <= e;
    if (coincides) continue;
    const insetOk =
      bx >= c.left + cr - e &&
      bx <= c.right - cr + e &&
      by >= c.top + cr - e &&
      by <= c.bottom - cr + e;
    if (!insetOk) return false;
  }
  return true;
}

function paneFrames(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(".tug-pane[data-pane-id]"),
  );
}

/**
 * Compute the set of frames that are fully occluded right now. Pure read:
 * layout geometry, inline z-index, computed paint facts. Never includes the
 * active pane (it may hold browser focus, which must not sit in a hidden
 * subtree) or a frame whose z-index has not been rendered yet.
 */
function computeOccludedSet(
  root: HTMLElement,
  activePaneId: string | null,
): { frames: HTMLElement[]; occluded: Set<HTMLElement> } {
  const frames = paneFrames(root);
  const geoms: PaneGeom[] = [];
  for (const el of frames) {
    const z = parseInt(el.style.zIndex, 10);
    if (!Number.isFinite(z)) continue;
    const left = el.offsetLeft;
    const top = el.offsetTop;
    geoms.push({
      el,
      left,
      top,
      right: left + el.offsetWidth,
      bottom: top + el.offsetHeight,
      z,
    });
  }
  const occluded = new Set<HTMLElement>();
  const paintFacts = new Map<HTMLElement, PaintFacts>();
  for (const b of geoms) {
    if (b.el.dataset.paneId === activePaneId) continue;
    for (const c of geoms) {
      if (c === b || c.z <= b.z) continue;
      let facts = paintFacts.get(c.el);
      if (facts === undefined) {
        facts = readPaintFacts(c.el);
        paintFacts.set(c.el, facts);
      }
      if (!facts.opaque) continue;
      if (coversOpaquely(c, b, facts.radius)) {
        occluded.add(b.el);
        break;
      }
    }
  }
  return { frames, occluded };
}

/**
 * Whether the deck is mid-motion — a FLIP tween, a collapse transition, or a
 * settle window that has not closed yet.
 *
 * Hiding an occluded frame is a `visibility: hidden` on it and its whole
 * subtree, so stamping one while the arrangement is still moving is how a pane
 * flashes: the frame that was going to cover it has not arrived yet, and the
 * one underneath disappears in the meantime.
 *
 * Asking each frame whether it is animating is not enough to know that. The
 * settle is a sequence — frames finish at slightly different moments, a
 * cancelled tween leaves its frame quiet for a tick before its replacement
 * starts, and an entrance is running on a frame this set may not even contain
 * yet. Any of those instants reads as quiet frame-by-frame while the
 * arrangement as a whole is plainly still in motion. The container's
 * `data-imposer-settling` marks the whole window rather than any one frame's
 * share of it, so it is the honest question to ask.
 */
function anyFrameAnimating(
  frames: HTMLElement[],
  root: HTMLElement | null,
): boolean {
  // Both halves: the settle marks the frames' container, which may be the deck
  // root itself or a descendant of it depending on where the canvas mounted.
  if (
    root !== null &&
    (root.hasAttribute("data-imposer-settling") ||
      root.querySelector("[data-imposer-settling]") !== null)
  ) {
    return true;
  }
  for (const el of frames) {
    if (el.getAnimations().length > 0) return true;
  }
  return false;
}

interface ControllerInstance {
  revealAll: () => void;
  schedule: () => void;
}

let instance: ControllerInstance | null = null;
let gestureDepth = 0;

/**
 * Gesture bracket for the appearance-zone machines in `tug-pane.tsx`. A drag
 * or resize moves frames without store commits, so occlusion computed at the
 * last commit goes stale the moment the pointer moves: `begin()` reveals
 * every pane synchronously (before the frame's first moved paint — it is
 * called from the rAF tick that latches the gesture) and blocks hides;
 * `end()` re-arms the settle pass. Depth-counted so overlapping brackets
 * (belt-and-suspenders; gestures are pointer-capture-exclusive) compose.
 */
export const paneOcclusionGesture = {
  begin(): void {
    gestureDepth += 1;
    instance?.revealAll();
  },
  end(): void {
    gestureDepth = Math.max(0, gestureDepth - 1);
    if (gestureDepth === 0) instance?.schedule();
  },
};

export function usePaneOcclusionController(
  deckRootRef: React.RefObject<HTMLDivElement | null>,
): void {
  const store = useDeckManager();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activePaneId = snapshot.activePaneId ?? null;

  const hideTimerRef = useRef<number | null>(null);

  // Rewritten every render so the passes close over the current
  // `activePaneId` without re-registering listeners ([L07] idiom, same as
  // pane-focus-controller).
  const passesRef = useRef<{ apply: () => void; verifyHides: () => void }>({
    apply: () => {},
    verifyHides: () => {},
  });

  passesRef.current = {
    // The synchronous pass: reveal every pane that is no longer provably
    // covered, then (re)arm the settle timer for panes that newly are.
    // Runs post-commit in the layout effect below, so reveals share the
    // paint with the z-order / geometry change that exposed the pane.
    apply: () => {
      const root = deckRootRef.current;
      if (root === null) return;
      if (gestureDepth > 0) {
        // Mid-gesture: geometry is live in the appearance zone; keep
        // everything visible and let end() re-arm.
        for (const el of paneFrames(root)) delete el.dataset.occluded;
        return;
      }
      const { frames, occluded } = computeOccludedSet(root, activePaneId);
      let pendingHides = false;
      for (const el of frames) {
        if (occluded.has(el)) {
          if (el.dataset.occluded !== "true") pendingHides = true;
        } else if (el.dataset.occluded === "true") {
          delete el.dataset.occluded;
        }
      }
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (pendingHides) {
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null;
          passesRef.current.verifyHides();
        }, HIDE_SETTLE_MS);
      }
    },
    // The lazy pass: stamp the hides, but only into a quiescent deck —
    // recompute from scratch (geometry may have moved since the timer was
    // armed) and defer again while any frame is animating.
    verifyHides: () => {
      const root = deckRootRef.current;
      if (root === null || gestureDepth > 0) return;
      const { frames, occluded } = computeOccludedSet(root, activePaneId);
      if (anyFrameAnimating(frames, root)) {
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null;
          passesRef.current.verifyHides();
        }, HIDE_SETTLE_MS);
        return;
      }
      for (const el of frames) {
        if (occluded.has(el)) {
          el.dataset.occluded = "true";
        } else if (el.dataset.occluded === "true") {
          delete el.dataset.occluded;
        }
      }
    },
  };

  // Reactive pass: after each React commit whose snapshot changed — raise,
  // close, collapse, imposition change, deck restore all land here, in the
  // same commit as their rendered z-order / geometry.
  useLayoutEffect(() => {
    passesRef.current.apply();
  }, [snapshot, activePaneId, deckRootRef]);

  // Registration: the gesture bracket's instance hook, the canvas resize
  // observer (window resizes and Lens-inset changes move imposed frames
  // without a store notify), and unmount cleanup. [L03]
  useLayoutEffect(() => {
    instance = {
      revealAll: () => {
        const root = deckRootRef.current;
        if (root === null) return;
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
        for (const el of paneFrames(root)) delete el.dataset.occluded;
      },
      schedule: () => passesRef.current.apply(),
    };
    const root = deckRootRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (root !== null) {
      resizeObserver = new ResizeObserver(() => passesRef.current.apply());
      resizeObserver.observe(root);
    }
    // Theme swaps land as attribute changes on <body> and can change the
    // chrome's background alpha; recompute so a hide licensed under an
    // opaque theme is re-audited under the new one.
    const themeObserver = new MutationObserver(() => passesRef.current.apply());
    themeObserver.observe(document.body, { attributes: true });
    return () => {
      instance = null;
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      const r = deckRootRef.current;
      if (r !== null) {
        for (const el of paneFrames(r)) delete el.dataset.occluded;
      }
    };
  }, [deckRootRef]);
}

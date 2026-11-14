/**
 * imposer-flip-fixture.ts — the shared deck and instruments the
 * at0294-imposer-flip-* files read the imposer's FLIP settle through.
 *
 * An arrangement change moves every derived frame at once. The motion is no
 * longer a transition on `left`/`top`/`width` — that re-runs layout for every
 * moving frame on every frame of the motion — but FLIP: the new geometry is
 * committed in one layout pass and each moved frame is tweened by a transform
 * that starts at the inverse of the move and ends at nothing
 * (`settle-engine.ts`, `lib/pane-flip.ts`).
 *
 * Three things have to hold, and the third is the one with teeth.
 *
 * The transform tween must be transform-only, or it is not the cheap kind: a
 * keyframe touching a layout property puts the effect back on the main thread
 * and the whole point is lost
 * (`arc/jul30-perf-brief.md#i1-sparkline-exception`). A width change past
 * the smear cap crosses by real `width` keyframes, main-thread by design
 * ([D135]) — in a resize BEAT of its own, before or after the move beat, so
 * that no effect ever carries a size term and a translate together.
 *
 * The frames must land where the imposer says, which is hand-computable from
 * `imposeRect`'s rule: the band is the span inset by a gap at each end, and a
 * slot sits `slot / (count - 1)` of the way along whatever the band has left
 * over after the pane's own width.
 *
 * And no frame may keep an inline `transform` afterwards. TugAnimator commits
 * an animation's final value into `el.style` when it completes — whatever
 * `fill` says — and React never clears it, because `transform` is not a key
 * TugPane renders. A frame wearing any transform is a containing block for its
 * `position: fixed` descendants. The residue is still forbidden, and the settle file
 * asserts the inline style directly (the computed value of an untransformed
 * element is `none`, which would pass vacuously) and asserts it again after a
 * SECOND settle. What has changed is the REASON, and with it what the probe
 * there can prove.
 *
 * at0294 used to plant a `position: fixed` probe inside a frame and require
 * it to resolve against the VIEWPORT — a proxy for "no frame is a containing
 * block", which was the deck's rule when that was written. That rule is
 * retired ([B01], [B02]): `.tug-pane` now carries a standing
 * `will-change: transform`, so every frame is a containing block from mount,
 * by design and at rest, and a gesture can no longer create or destroy a
 * compositor layer. The probe is kept and its claim inverted, because the
 * inversion is the rule: a fixed-position descendant resolves against its
 * FRAME. What keeps that from breaking anything real is that nothing with
 * `position: fixed` lives inside a frame — viewport-positioned surfaces are
 * portaled to the canvas overlay root, and `audit:motion` fails the
 * lint on any selector that puts one back.
 *
 * Note what the probe no longer does: it cannot discriminate residue. A frame
 * is a containing block whether or not a stale `translate(0px, 0px)` is on it,
 * so the residue claim now rests entirely on the direct `inlineTransforms`
 * read — which is the better assertion anyway, and was always the one
 * doing the work.
 *
 * A slot assignment carries a fourth rule. It raises the card it slots, and
 * the raise is a precondition of the motion rather than its epilogue — a frame
 * that rose only at the end would spend the whole crossing underneath the
 * panes it is on its way to sitting in front of. The converse is asserted too:
 * z-order moves nothing, so a bare raise must arm no settle window.
 *
 * A width change reaches the settle at all only because the deck makes one of
 * them in ONE state change — `setContentWidth` resizes every content pane,
 * restamps the record, and re-solves the rails together. FLIP measures across a
 * single commit; a notify per pane would hand it a half-changed deck each time.
 * `deck-manager.ts` is deliberately NOT a `@covers` line here: it is at its
 * fan-out budget, and the width applier's own contract is `at0357`'s.
 *
 * Each at0294-imposer-flip file launches into its own deck; what they share is
 * this deck's shape and the readers below.
 *
 * @module tests/app-test/imposer-flip-fixture
 */

import type { App } from "./_harness";
import { flowBandEdges } from "../../tugdeck/src/lib/layout-imposer";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 90_000;

/** The widest a rail may stand (the slim content width). The fixture stands
 *  the Layout card here AND seeds it as the durable chosen width, which pins the
 *  allocator ([D136]) out of the picture for the settles below: this deck's
 *  two narrow cards leave the rails far more room than any rail may take, so
 *  the allocator's answer is the CEILING at every one of its moments — which
 *  is where the Layout card already stands. A settle here is therefore pure motion,
 *  and the transform-only census stays a claim about the settle rather than
 *  about the allocator.
 *
 *  The floor would not do the job: a rail's preference is where the fill
 *  starts and never a cap on it, so on a deck with room to give the rail grows
 *  whatever it was standing at. The bound that binds is the one the deck's
 *  slack runs into. */
export const RAIL_WIDTH = 675;
export const PANE_WIDTH = 420;
/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween to land. */
export const SETTLE_MS = 300;
export const AFTER_LAND_MS = 900;

export const FRAMES = ".tug-pane[data-pane-id]";

export function deckShape() {
  const card = (id: string, componentId: string, title: string) => ({
    id,
    componentId,
    title,
    closable: true,
  });
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      card("A", "gallery-accordion", "Card A"),
      card("B", "gallery-accordion", "Card B"),
      card("L", "layout", "Layout"),
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    // No `sidebars` entry: the rail is unplaced at seed and `setRailSide` is
    // what puts it on a side, which is the transition this file measures.
    imposition: { kind: "two-up", layout: "fit" },
    hasFocus: true,
  };
}

/**
 * Every animation currently running on a pane frame's own BOX, with its
 * keyframes' property names — the census the transform-only rule is read from.
 *
 * A pseudo-element effect reports the originating element as its `target`, so
 * a fade on `.tug-pane::after` would arrive here wearing the frame's identity
 * while animating nothing about the frame. The recede is exactly that: three
 * pseudo layers whose opacity fades on the settle's landing, which this file's
 * claims are not about and which `at0697` asserts on its own terms. The
 * subject of every claim below is the frame itself, so the census is too.
 *
 * A pane once wore a `clip-path` beat for the settle's length, the hole its
 * body showed through riding with it. The cards stand over the shell now and
 * nothing is cut for one, so no frame animates `clip-path`; the census still
 * leaves an effect animating nothing else out, which costs it nothing.
 */
export interface FrameAnimation {
  paneId: string;
  properties: string[];
  /** WAAPI's own phase: `"before"` for an effect still inside its delay. */
  phase: string;
}

export async function frameAnimations(app: App): Promise<FrameAnimation[]> {
  return app.evalJS<FrameAnimation[]>(
    `document.getAnimations()
      .map(function (a) {
        if (!a.effect || a.effect.pseudoElement) return null;
        var target = a.effect && a.effect.target;
        if (!target || !target.classList || !target.classList.contains("tug-pane")) return null;
        var props = {};
        (a.effect.getKeyframes() || []).forEach(function (kf) {
          Object.keys(kf).forEach(function (k) { props[k] = true; });
        });
        var animated = Object.keys(props).filter(function (k) {
          return k !== "offset" && k !== "computedOffset" && k !== "easing" && k !== "composite";
        });
        if (animated.length === 1 && animated[0] === "clipPath") return null;
        var timing = a.effect.getComputedTiming();
        return {
          paneId: target.getAttribute("data-pane-id") || "",
          properties: Object.keys(props).sort(),
          // A settle creates every one of its beats in one frame now, each
          // held off by the beats before it, so an effect EXISTING on a frame
          // no longer means it is running; the phase tells the two apart.
          // Read off localTime rather than off progress, because progress in
          // the before phase depends on the fill and this census must not:
          // it is null under a none fill and 0 under a backwards one, so a reader
          // that branched on it would answer a different question the moment
          // a beat's fill changed. localTime is the effect's time unadjusted
          // by its delay, so the before phase is everything below the delay.
          phase: (function () {
            var lt = timing.localTime;
            if (lt === null || lt === undefined) return "idle";
            var d = timing.delay || 0;
            if (lt < d) return "before";
            return lt < d + timing.activeDuration ? "active" : "after";
          })(),
        };
      })
      .filter(function (x) { return x !== null; })`,
  );
}

/** The inline (not computed) `transform` of every frame, by pane id. */
export async function inlineTransforms(app: App): Promise<Record<string, string>> {
  return app.evalJS<Record<string, string>>(
    `Array.from(document.querySelectorAll(${JSON.stringify(FRAMES)}))
      .reduce(function (out, el) {
        out[el.getAttribute("data-pane-id")] = el.style.transform || "";
        return out;
      }, {})`,
  );
}

/** The inline `transform-origin` of every frame, by pane id — the settle's to
 *  write while a frame is scaling and the settle's to take away after. */
export async function inlineTransformOrigins(app: App): Promise<Record<string, string>> {
  return app.evalJS<Record<string, string>>(
    `Array.from(document.querySelectorAll(${JSON.stringify(FRAMES)}))
      .reduce(function (out, el) {
        out[el.getAttribute("data-pane-id")] = el.style.transformOrigin || "";
        return out;
      }, {})`,
  );
}

/** Each frame's first keyframe transform value, by pane id — what the tween
 *  starts from, which is where the width delta shows up. */
export async function firstKeyframeTransforms(
  app: App,
): Promise<Record<string, string>> {
  return app.evalJS<Record<string, string>>(
    `document.getAnimations().reduce(function (out, a) {
      var target = a.effect && a.effect.target;
      if (!target || !target.classList || !target.classList.contains("tug-pane")) return out;
      var kfs = a.effect.getKeyframes() || [];
      if (kfs.length === 0 || kfs[0].transform === undefined) return out;
      out[target.getAttribute("data-pane-id") || ""] = String(kfs[0].transform);
      return out;
    }, {})`,
  );
}

/** Each frame's width-tween endpoints, by pane id — the real-geometry half of
 *  an over-cap width crossing ([D135]). Absent when no width tween runs. */
export async function widthKeyframeEndpoints(
  app: App,
): Promise<Record<string, { first: string; last: string }>> {
  return app.evalJS<Record<string, { first: string; last: string }>>(
    `document.getAnimations().reduce(function (out, a) {
      var target = a.effect && a.effect.target;
      if (!target || !target.classList || !target.classList.contains("tug-pane")) return out;
      var kfs = a.effect.getKeyframes() || [];
      if (kfs.length === 0 || kfs[0].width === undefined) return out;
      out[target.getAttribute("data-pane-id") || ""] = {
        first: String(kfs[0].width),
        last: String(kfs[kfs.length - 1].width),
      };
      return out;
    }, {})`,
  );
}

export async function settling(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector("[data-imposer-settling]") !== null`,
  );
}

/** Every `settle-release` record in the deck-trace ring, oldest first: which
 *  clock released the session stores' hold — the settle's own completion, the
 *  window sweep, or the unmount. */
export async function releaseSources(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `window.__deckTrace.dump()
      .filter(function (e) { return e.kind === "settle-release"; })
      .map(function (e) { return e.source; })`,
  );
}

/** Every retarget the trace ring saw: how the running tween ended, and which
 *  beat was up when the arm landed — the recipe its velocity was read off. */
export async function retargets(
  app: App,
): Promise<Array<{ mode: string; beat: string | null }>> {
  return app.evalJS<Array<{ mode: string; beat: string | null }>>(
    `window.__deckTrace.dump()
      .filter(function (e) { return e.kind === "settle-retarget"; })
      .map(function (e) { return { mode: e.mode, beat: e.beat }; })`,
  );
}

/** The beat the settle is running — `shrink`, `move` or `grow` — or null. */
export async function runningBeat(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var el = document.querySelector("[data-imposer-beat]");
      return el ? el.getAttribute("data-imposer-beat") : null;
    })()`,
  );
}

/** The inline (not computed) `width` of every frame, by pane id — where a
 *  growing axis is held at its First size until its grow beat runs. */
export async function inlineWidths(app: App): Promise<Record<string, string>> {
  return app.evalJS<Record<string, string>>(
    `Array.from(document.querySelectorAll(${JSON.stringify(FRAMES)}))
      .reduce(function (out, el) {
        out[el.getAttribute("data-pane-id")] = el.style.width || "";
        return out;
      }, {})`,
  );
}

export async function setRailSide(app: App, side: "left" | "right"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-sidebar-side", { componentId: "layout", side: ${JSON.stringify(
      side,
    )} }), null)`,
  );
}

export async function setContentWidth(app: App, preset: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-content-width", { preset: ${JSON.stringify(
      preset,
    )} }), null)`,
  );
}

export async function setImposition(app: App, kind: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-imposition", { kind: ${JSON.stringify(
      kind,
    )} }), null)`,
  );
}

export async function viewportWidth(app: App): Promise<number> {
  return app.evalJS<number>(`window.innerWidth`);
}

/**
 * Where `imposeRect` puts a slot's left edge, hand-computed: the span is the
 * canvas minus the rail's side, the band is the span inset by a gap at each
 * end, and the slot rides `slot / (count - 1)` of the leftover travel.
 *
 * `railWidth` is MEASURED rather than taken from the seed, and re-measured at
 * each assertion rather than once at rest. A pane renders at its stored width
 * raised to its stack's size floor, and an arrangement change re-runs the space
 * allocator, which may hand the rail a different width than the one seeded here
 * — so neither the seeded number nor an earlier reading is the number the band
 * is inset by. The slot arithmetic is what this checks; the width the rail
 * arrives at is `at0303`'s business, and the floor is `at0284`'s.
 */
export function expectedLeft(
  slot: number,
  count: number,
  viewport: number,
  railSide: "left" | "right",
  railWidth: number,
  paneWidth: number = PANE_WIDTH,
): number {
  // The band's edges are the PRODUCT's answer, not a second reading of it.
  // This used to take the inset as `railWidth + GAP`, which is only right
  // when the rail gutter equals the imposition gap — the gutter is the gap
  // plus `RAIL_GUTTER_EXTRA_PX`, so every pin here ran that much shy of the
  // imposer's.
  const railWidths =
    railSide === "left" ? { left: railWidth } : { right: railWidth };
  const edges = flowBandEdges(viewport, railWidths);
  const travel = Math.max(0, edges.end - edges.start - paneWidth);
  const fraction = count < 2 ? 0.5 : slot / (count - 1);
  return edges.start + fraction * travel;
}

export async function railWidth(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().width`,
  );
}

/** The resolved stacking order of a frame — the number `pane-stacking` derives
 *  from the pane's place in the store array. */
export async function frameZIndex(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `Number(getComputedStyle(document.querySelector('.tug-pane[data-pane-id="${paneId}"]')).zIndex)`,
  );
}

export async function frameLeft(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().left`,
  );
}

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Seed the rail's durable chosen width to the fixture's standing width — see
 *  the `RAIL_WIDTH` note. */
export async function seedRailPreferred(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
}

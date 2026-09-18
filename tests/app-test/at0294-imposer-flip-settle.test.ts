/**
 * at0294-imposer-flip-settle.test.ts — the imposer settles by FLIP, and leaves
 * nothing behind.
 *
 * An arrangement change moves every derived frame at once. The motion is no
 * longer a transition on `left`/`top`/`width` — that re-runs layout for every
 * moving frame on every frame of the motion — but FLIP: the new geometry is
 * committed in one layout pass and each moved frame is tweened by a transform
 * that starts at the inverse of the move and ends at nothing
 * (`deck-canvas.tsx`, `lib/pane-flip.ts`).
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
 * `position: fixed` descendants, and TugSheet portals into the frame while
 * completion popups, alerts, and banners all position from viewport
 * coordinates. The residue would offset all of them by the pane's origin, and
 * only after the FIRST arrangement change — so this test asserts the inline
 * style directly (the computed value of an untransformed element is `none`,
 * which would pass vacuously), asserts it again after a SECOND settle, and
 * then measures the consequence: a fixed-position probe planted inside a frame
 * must resolve against the viewport, not against the pane.
 *
 * A slot assignment carries a fourth rule. It raises the card it slots, and
 * the raise is a precondition of the motion rather than its epilogue — a frame
 * that rose only at the end would spend the whole crossing underneath the
 * panes it is on its way to sitting in front of. The converse is asserted too:
 * z-order moves nothing, so a bare raise must arm no settle window.
 *
 * Scenario:
 *   1. Seed a two-up deck with a pinned Layout card on the right.
 *   2. Flip the Layout card to the left. Mid-window: the container wears
 *      `data-imposer-settling` and every animation on a frame is transform-only.
 *   3. After land: no animations, no attribute, no inline transform, and the
 *      frames sit where `imposeRect` says.
 *   4. Flip back. Assert the no-residue rule a second time, then plant the
 *      fixed-position probe.
 *   5. A slot assignment: the frame is already on top when its tween starts,
 *      and a bare pane raise arms no window at all.
 *   6. The deck's content width: the frames scale to their new boxes on the
 *      settle's beats — the move beat transform-only with the width held, then
 *      the grow beat walking the real width — and keep neither the transform
 *      nor the origin it was anchored by.
 *   7. Retarget: a second change dispatched inside the first one's window.
 *      Tweens are replaced, not stacked, and the final geometry is still right.
 *
 * A width change reaches the settle at all only because the deck makes one of
 * them in ONE state change — `setContentWidth` resizes every content pane,
 * restamps the record, and re-solves the rails together. FLIP measures across a
 * single commit; a notify per pane would hand it a half-changed deck each time.
 * `deck-manager.ts` is deliberately NOT a `@covers` line here: it is at its
 * fan-out budget, and the width applier's own contract is `at0357`'s.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { flowBandEdges } from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

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
const RAIL_WIDTH = 675;
const PANE_WIDTH = 420;
/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween to land. */
const SETTLE_MS = 300;
const AFTER_LAND_MS = 900;

const FRAMES = ".tug-pane[data-pane-id]";

function deckShape() {
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

/** Every animation currently running on a pane frame, with its keyframes'
 *  property names — the census the transform-only rule is read from. */
interface FrameAnimation {
  paneId: string;
  properties: string[];
}

async function frameAnimations(app: App): Promise<FrameAnimation[]> {
  return app.evalJS<FrameAnimation[]>(
    `document.getAnimations()
      .map(function (a) {
        var target = a.effect && a.effect.target;
        if (!target || !target.classList || !target.classList.contains("tug-pane")) return null;
        var props = {};
        (a.effect.getKeyframes() || []).forEach(function (kf) {
          Object.keys(kf).forEach(function (k) { props[k] = true; });
        });
        return {
          paneId: target.getAttribute("data-pane-id") || "",
          properties: Object.keys(props).sort(),
        };
      })
      .filter(function (x) { return x !== null; })`,
  );
}

/** The inline (not computed) `transform` of every frame, by pane id. */
async function inlineTransforms(app: App): Promise<Record<string, string>> {
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
async function inlineTransformOrigins(app: App): Promise<Record<string, string>> {
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
async function firstKeyframeTransforms(
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
async function widthKeyframeEndpoints(
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

async function settling(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector("[data-imposer-settling]") !== null`,
  );
}

/** Every `settle-release` record in the deck-trace ring, oldest first: which
 *  clock released the session stores' hold — the settle's own completion, the
 *  window sweep, or the unmount. */
async function releaseSources(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `window.__deckTrace.dump()
      .filter(function (e) { return e.kind === "settle-release"; })
      .map(function (e) { return e.source; })`,
  );
}

/** Every retarget the trace ring saw: how the running tween ended, and which
 *  beat was up when the arm landed — the recipe its velocity was read off. */
async function retargets(
  app: App,
): Promise<Array<{ mode: string; beat: string | null }>> {
  return app.evalJS<Array<{ mode: string; beat: string | null }>>(
    `window.__deckTrace.dump()
      .filter(function (e) { return e.kind === "settle-retarget"; })
      .map(function (e) { return { mode: e.mode, beat: e.beat }; })`,
  );
}

/** The beat the settle is running — `shrink`, `move` or `grow` — or null. */
async function runningBeat(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var el = document.querySelector("[data-imposer-beat]");
      return el ? el.getAttribute("data-imposer-beat") : null;
    })()`,
  );
}

/** The inline (not computed) `width` of every frame, by pane id — where a
 *  growing axis is held at its First size until its grow beat runs. */
async function inlineWidths(app: App): Promise<Record<string, string>> {
  return app.evalJS<Record<string, string>>(
    `Array.from(document.querySelectorAll(${JSON.stringify(FRAMES)}))
      .reduce(function (out, el) {
        out[el.getAttribute("data-pane-id")] = el.style.width || "";
        return out;
      }, {})`,
  );
}

async function setRailSide(app: App, side: "left" | "right"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-sidebar-side", { componentId: "layout", side: ${JSON.stringify(
      side,
    )} }), null)`,
  );
}

async function setContentWidth(app: App, preset: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-content-width", { preset: ${JSON.stringify(
      preset,
    )} }), null)`,
  );
}

async function setImposition(app: App, kind: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-imposition", { kind: ${JSON.stringify(
      kind,
    )} }), null)`,
  );
}

async function viewportWidth(app: App): Promise<number> {
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
function expectedLeft(
  slot: number,
  count: number,
  viewport: number,
  railSide: "left" | "right",
  railWidth: number,
  paneWidth: number = PANE_WIDTH,
): number {
  // The band's edges are the PRODUCT's answer, not a second reading of it.
  // This used to take the inset as `railWidth + GAP`, which is only right
  // when the rail gutter equals the imposition gap — RAIL_GUTTER_PX is 12
  // against a 5px gap, so every pin here ran 2px shy of the imposer's.
  const railWidths =
    railSide === "left" ? { left: railWidth } : { right: railWidth };
  const edges = flowBandEdges(viewport, railWidths);
  const travel = Math.max(0, edges.end - edges.start - paneWidth);
  const fraction = count < 2 ? 0.5 : slot / (count - 1);
  return edges.start + fraction * travel;
}

async function railWidth(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().width`,
  );
}

/** The resolved stacking order of a frame — the number `deck-canvas` derives
 *  from the pane's place in the store array. */
async function frameZIndex(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `Number(getComputedStyle(document.querySelector('.tug-pane[data-pane-id="${paneId}"]')).zIndex)`,
  );
}

async function frameLeft(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().left`,
  );
}

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Seed the rail's durable chosen width to the fixture's standing width — see
 *  the `RAIL_WIDTH` note. */
async function seedRailPreferred(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0294 — the imposer settles by transform-only FLIP and leaves no residue",
  () => {
    test(
      "transform-only mid-window, correct geometry at land, and no inline transform after two settles",
      async () => {
        const app = await launchTugApp({
          testName: "at0294-imposer-flip-settle",
        });
        try {
          // The settle's own records — its arm and its release — ride the
          // deck-trace ring, which records them only while enabled.
          await app.enableDeckTrace(true);
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 3`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          const vp = await viewportWidth(app);

          // --- Settle one: the Layout card crosses to the left. -------------------
          const releasesBefore = (await releaseSources(app)).length;
          await setRailSide(app, "left");

          // Mid-window. The container marks the gesture, and every animation
          // running on a frame touches transform and nothing else — a single
          // layout property in this census is the whole regression.
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") !== null`,
            { timeoutMs: 2_000 },
          );
          {
            const census = await frameAnimations(app);
            expect(census.length).toBeGreaterThan(0);
            for (const anim of census) {
              expect(anim.properties.filter((p) => p !== "offset" &&
                p !== "computedOffset" && p !== "easing" && p !== "composite"))
                .toEqual(["transform"]);
            }
          }

          // --- After land. -------------------------------------------------
          await wait(AFTER_LAND_MS);
          expect(await settling(app)).toBe(false);
          expect(await frameAnimations(app)).toEqual([]);
          // THIS settle's release — the records since the flip was
          // dispatched — came off on the settle's own clock, after the last
          // tween finished, and never from the window timer, which is a
          // wedge guard rather than the release ([B04] of
          // `three-beat-settle`).
          {
            const sources = (await releaseSources(app)).slice(releasesBefore);
            expect(sources.length).toBeGreaterThan(0);
            expect(sources[sources.length - 1]).toBe("completion");
            expect(sources).not.toContain("sweep");
          }

          // The residue rule, read off the INLINE style. A frame that never
          // wore a transform computes to `none`, so the computed value would
          // pass here whatever happened.
          {
            const inline = await inlineTransforms(app);
            expect(Object.values(inline).every((v) => v === "")).toBe(true);
          }

          // And the frames are where the imposer says, not a tween's length
          // short of it.
          {
            const rail = await railWidth(app);
            expect(await frameLeft(app, "p1")).toBeCloseTo(
              expectedLeft(0, 2, vp, "left", rail),
              0,
            );
            expect(await frameLeft(app, "p2")).toBeCloseTo(
              expectedLeft(1, 2, vp, "left", rail),
              0,
            );
          }

          // --- Settle two: back to the right. ------------------------------
          // The residue only appears after a settle has completed, so a
          // first-gesture-only test would miss a clear that runs once.
          await setRailSide(app, "right");
          await wait(AFTER_LAND_MS);
          {
            const inline = await inlineTransforms(app);
            expect(Object.values(inline).every((v) => v === "")).toBe(true);
          }
          expect(await frameLeft(app, "p1")).toBeCloseTo(
            expectedLeft(0, 2, vp, "right", await railWidth(app)),
            0,
          );

          // The consequence the residue would actually cause: a frame wearing
          // a transform becomes the containing block for its fixed-position
          // descendants — which is what TugSheet portals into and what every
          // popup positions against. The probe resolves at the viewport
          // origin only if the frame is not one.
          {
            const probeOrigin = await app.evalJS<{ x: number; y: number }>(
              `(function () {
                var frame = document.querySelector('.tug-pane[data-pane-id="p2"]');
                var probe = document.createElement("div");
                probe.style.position = "fixed";
                probe.style.left = "0px";
                probe.style.top = "0px";
                probe.style.width = "1px";
                probe.style.height = "1px";
                frame.appendChild(probe);
                var r = probe.getBoundingClientRect();
                probe.remove();
                return { x: r.left, y: r.top };
              })()`,
            );
            expect(probeOrigin.x).toBeCloseTo(0, 0);
            expect(probeOrigin.y).toBeCloseTo(0, 0);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "assigning a slot raises the frame before it starts crossing, and a bare raise arms nothing",
      async () => {
        const app = await launchTugApp({
          testName: "at0294-imposer-flip-raise",
        });
        try {
          // Focus B, so p2 is the frame on top and a raise of p1 is
          // observable: without one, A crosses to p2's slot underneath it.
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "B" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 3`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          const vp = await viewportWidth(app);
          const rail = await railWidth(app);
          expect(await frameZIndex(app, "p1")).toBeLessThan(
            await frameZIndex(app, "p2"),
          );

          // A bare raise reorders the panes array and moves no frame, so it
          // must arm no settle window — one would hold every session card's
          // notifications for the length of a motion that never happens.
          // Raised and lowered again, so the assignment below still has a
          // raise to make.
          for (const paneId of ["p1", "p2"]) {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("focus-pane", { paneId: ${JSON.stringify(
                paneId,
              )} }), null)`,
            );
            await wait(120);
            expect(await settling(app)).toBe(false);
            expect(await frameAnimations(app)).toEqual([]);
          }
          expect(await frameZIndex(app, "p1")).toBeLessThan(
            await frameZIndex(app, "p2"),
          );

          // Now the gesture the rail's slot picker dispatches: put A at the
          // slot B already holds. A moves, so it tweens — and by the time it
          // does, it is already the frame on top.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("assign-slot", { cardId: "A", slot: 1 }), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") !== null`,
            { timeoutMs: 2_000 },
          );
          {
            const census = await frameAnimations(app);
            expect(census.map((a) => a.paneId)).toContain("p1");
            expect(await frameZIndex(app, "p1")).toBeGreaterThan(
              await frameZIndex(app, "p2"),
            );
          }

          await wait(AFTER_LAND_MS);
          expect(await settling(app)).toBe(false);
          expect(await frameLeft(app, "p1")).toBeCloseTo(
            expectedLeft(1, 2, vp, "right", rail),
            0,
          );
          expect(await frameZIndex(app, "p1")).toBeGreaterThan(
            await frameZIndex(app, "p2"),
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a deck-wide width change crosses too — over the cap, by real width rather than a smear",
      async () => {
        const app = await launchTugApp({
          testName: "at0294-imposer-flip-width",
        });
        try {
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 3`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          const vp = await viewportWidth(app);

          // The Layouts section's width row. Every content pane goes from the
          // seed's 420 to slim's 675, which moves the seams as well as the
          // boxes — the whole arrangement changes, and none of it may cut.
          await setContentWidth(app, "slim");

          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") !== null`,
            { timeoutMs: 2_000 },
          );
          {
            // 420 → 675 is over the smear cap ([D135]:
            // `MAX_FLIP_SCALE_DISTORTION`), so the width crosses as real
            // geometry — and a real size term never shares a beat with a
            // translate. The settle runs as beats, shrink then move then
            // grow; whatever the deck shrinks to make room runs first, and
            // the content frames are read at the move. Slot 0 anchors the
            // band's start, so p1's left never moves under a deck width
            // change and its whole crossing is the grow beat — through the
            // move it waits, its width held at 420 inline. p2's left shifts
            // with the width, so it moves, transform-only, at its First
            // width, and grows after.
            const effects = (
              census: FrameAnimation[],
              paneId: string,
            ): string[] =>
              census
                .filter((anim) => anim.paneId === paneId)
                .map((anim) =>
                  anim.properties
                    .filter((p) => p !== "offset" && p !== "computedOffset" &&
                      p !== "easing" && p !== "composite")
                    .join(","),
                )
                .sort();
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-imposer-beat='move']") !== null`,
              { timeoutMs: 2_000 },
            );
            expect(await runningBeat(app)).toBe("move");
            {
              const census = await frameAnimations(app);
              expect(effects(census, "p1")).toEqual([]);
              expect(effects(census, "p2")).toEqual(["transform"]);
            }
            // The transform tween carries no scale at all — the width delta
            // rides as real geometry, so nothing inside the frame is ever a
            // stretched raster. A zero vertical term comes back from the
            // engine as the one-argument `translate(0px)`, so the y is
            // optional here.
            const starts = await firstKeyframeTransforms(app);
            expect(starts["p2"]).toMatch(
              /^translate\(-?[\d.]+px(, -?[\d.]+px)?\)$/,
            );
            // Both frames hold their First width through the move: the
            // commit already gave them 675, and the hold is what keeps the
            // grow for the grow beat.
            {
              const held = await inlineWidths(app);
              expect(held["p1"]).toBe(`${PANE_WIDTH}px`);
              expect(held["p2"]).toBe(`${PANE_WIDTH}px`);
            }
            // The origin is the transform tween's to write, so only the frame
            // that carries one wears it.
            const origins = await inlineTransformOrigins(app);
            expect(origins["p1"]).toBe("");
            expect(origins["p2"]).toBe("0px 0px");
            // Then the grow beat: both frames' width tweens walk the real
            // endpoints, from the seed's width to the preset's, pinned at
            // both ends — and nothing translates.
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-imposer-beat='grow']") !== null`,
              { timeoutMs: 2_000 },
            );
            {
              const census = await frameAnimations(app);
              expect(effects(census, "p1")).toEqual(["width"]);
              expect(effects(census, "p2")).toEqual(["width"]);
            }
            const widths = await widthKeyframeEndpoints(app);
            for (const paneId of ["p1", "p2"]) {
              expect(widths[paneId]).toEqual({
                first: `${PANE_WIDTH}px`,
                last: "675px",
              });
            }
          }

          // After land: the boxes are the preset's, sitting where the imposer
          // puts a 675-wide pane, and no frame keeps either half of the pose
          // the tween wore.
          await wait(AFTER_LAND_MS);
          expect(await settling(app)).toBe(false);
          expect(await frameAnimations(app)).toEqual([]);
          {
            const inline = await inlineTransforms(app);
            expect(Object.values(inline).every((v) => v === "")).toBe(true);
            const origins = await inlineTransformOrigins(app);
            expect(Object.values(origins).every((v) => v === "")).toBe(true);
          }
          const rail = await railWidth(app);
          for (const [paneId, slot] of [
            ["p1", 0],
            ["p2", 1],
          ] as const) {
            expect(
              await app.evalJS<number>(
                `document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().width`,
              ),
            ).toBeCloseTo(675, 0);
            expect(await frameLeft(app, paneId)).toBeCloseTo(
              expectedLeft(slot, 2, vp, "right", rail, 675),
              0,
            );
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a second arrangement change inside the window replaces the tweens rather than stacking them",
      async () => {
        const app = await launchTugApp({
          testName: "at0294-imposer-flip-retarget",
        });
        try {
          await seedRailPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 3`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          const vp = await viewportWidth(app);
          await app.enableDeckTrace(true);

          // Two changes inside one window. The second measures each frame's
          // live visual rect — which includes the running tween's transform —
          // so the new motion starts where the eye is.
          await setRailSide(app, "left");
          await wait(Math.floor(SETTLE_MS / 3));
          await setImposition(app, "one-up");

          // At most one tween per frame at any moment: a stacked pair would
          // show the same pane id twice.
          {
            const census = await frameAnimations(app);
            const ids = census.map((a) => a.paneId);
            expect(new Set(ids).size).toBe(ids.length);
          }
          // The retarget was velocity-matched, and it read the velocity off
          // the beat that was running — a rail-side flip is a move-only
          // settle, so the interrupted beat is the move, and the crossing it
          // relaunched is the one beat the velocity is handed to.
          {
            const seen = await retargets(app);
            expect(seen.length).toBeGreaterThan(0);
            for (const r of seen) {
              expect(r.mode).toBe("matched");
              expect(r.beat).toBe("move");
            }
          }

          await wait(AFTER_LAND_MS);
          expect(await settling(app)).toBe(false);
          expect(await frameAnimations(app)).toEqual([]);
          {
            const inline = await inlineTransforms(app);
            expect(Object.values(inline).every((v) => v === "")).toBe(true);
          }

          // One-up puts every imposed frame at the same centred place, and the
          // Layout card now holds the left — so the retarget landed on the arrangement
          // the LAST change asked for, not the first.
          const centred = expectedLeft(0, 1, vp, "left", await railWidth(app));
          expect(await frameLeft(app, "p1")).toBeCloseTo(centred, 0);
          expect(await frameLeft(app, "p2")).toBeCloseTo(centred, 0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

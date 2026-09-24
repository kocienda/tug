/**
 * at0621-intra-workspace-slide.test.ts — an activation INSIDE a workspace
 * slides, and never fades.
 *
 * ## What the plain gesture owes
 *
 * Moving the reader from one card to another in the same workspace is an
 * ordinary arrangement change: the strip travels, every frame glides to where
 * the commit puts it, and nothing appears or disappears. A report said it had
 * regressed into a FADE — cards blinking in from nothing instead of sliding
 * into place — and this file is what that report was chased with.
 *
 * ## The mechanism this file went looking for
 *
 * One ref that can outlive the settle that filled it.
 * `pendingArrivalsRef` holds the pane ids a settle is keeping invisible until
 * their arrive beat comes round, and `arm`'s First pass skips every id in it:
 * a frame still arriving is not on screen as far as that settle is concerned,
 * so it has no First rect to measure. The Last pass then walks the shown
 * frames again and treats **any frame with no First rect as an arrival** —
 * held at inline `opacity: 0`, faded up as the chain's last beat.
 *
 * That is exactly right while the arrival is real, and exactly wrong once it
 * is not. The set is cleared in one place, `releaseSettle`, and `arm`'s
 * `"cut"` branch — the spelling a WORKSPACE SWITCH commits under — returns
 * before it ever reaches one. So a card caught mid-arrival when the user
 * crosses to another workspace leaves its pane id in the set.
 *
 * The settle's window timer does eventually collect it — about a second later,
 * from a wedge guard rather than from a correctness path — which is why this
 * is a hazard rather than the observed defect. See the second leg below.
 *
 * ## The sweep
 *
 * The answer to that hazard is in the crossfade layout effect in
 * `deck-canvas.tsx`, which
 * already runs on every change of `spacesSnapshot.activeSpaceId` and already
 * sweeps the document for the crossing attribute. It now also drops from
 * `pendingArrivalsRef` every pane id whose frame is no longer among
 * `SHOWN_PANE_FRAMES`, running that id's registered restorers first — the
 * restorers are what hand back the inline `opacity: "0"` the hold wrote, and
 * dropping the id without them would leave the frame invisible rather than
 * merely faded.
 *
 * It sits ABOVE the effect's early returns, because a stale pending arrival is
 * stale whether or not a dissolve is opening. Reduced motion, a deleted
 * outgoing workspace and an empty one are precisely the paths on which the id
 * would otherwise be stranded with its frame still held at zero.
 *
 * ## The two legs
 *
 * The first leg is the plain gesture with no history behind it: four cards in
 * a four-up flow deck, the reader walked from slot 1 to slot 4. It is held to
 * the whole bar — the strip travelled, and no frame anywhere dipped below full
 * opacity or wore an inline hold at any sample.
 *
 * The second stages the precondition — a card opened into the workspace so a
 * settle with a real arrival is in flight, a workspace switch landed during
 * that arrival, a switch back, then the same walk.
 *
 * **It used to record a mass fade, and the sweep was not what answered it.**
 * Every resident frame of the arriving workspace, the Layout rail included,
 * was held at inline `opacity: 0` on the switch back, with five departure
 * ghosts minted for the workspace being left. The trace said why, and it was
 * not a stale pending arrival: the switch's SECOND commit — `activateSpace`
 * step (7)'s `activateCard`, outside the swap batch — armed a `"cross"` settle
 * with `outcome: "carried"`, and that arm's First pass read the workspace
 * being left while its Last pass read the one arriving. Five panes with a
 * First rect and no survivor are five departures; six with no First rect are
 * six arrivals.
 *
 * That was a switch-epoch problem rather than a settle-registry one, and
 * `data-space-switching` is what closed it: the second commit's arm now reads
 * `landing: "cross", outcome: "declined"`, and both legs hold the same bar.
 *
 * **The claims are scoped to the RESIDENT frames** — the panes on screen
 * before the gesture began. The text card the precondition opens is a genuine
 * arrival and is genuinely supposed to fade in; a test that refused every hold
 * would pin the absence of a feature. What is pinned is that a frame which
 * never left the screen is never treated as arriving.
 *
 * Both legs also read the canvas **at rest** — no frame left wearing an inline
 * opacity, none computing below 1, no ghost still standing. That is the claim
 * the sweep itself can fail: an id dropped from `pendingArrivalsRef` without
 * running its restorers leaves its frame invisible for the life of the canvas,
 * which a mid-flight sampler cannot tell from a hold about to be handed back.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/space-layer.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SPACE_ONE = "at0621-one";
const SPACE_TWO = "at0621-two";

const RAIL_WIDTH = 420;
const SLIM_PX = 675;
/** The settle window, with room for a landing tween. */
const AFTER_LAND_MS = 900;

/**
 * The panes of workspace One that are on screen before any gesture in this
 * file — four content slots and the Layout rail. Nothing here ever leaves the
 * screen, so nothing here may ever be read as arriving.
 */
const RESIDENT = ["a-p1", "a-p2", "a-p3", "a-p4", "at0621-pl1"] as const;

/** Every pane frame in the document — hidden layers and crossing ones too. */
const ALL_FRAMES = ".tug-pane[data-pane-id]";
/** The panes on screen. */
const SHOWN_FRAMES =
  "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]";

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

interface Reading {
  samples: number;
  /** The lowest computed opacity a RESIDENT frame showed, and where. */
  minOpacity: number;
  minOpacityAt: string;
  /** The lowest any frame in the document showed — the new card included. */
  minOpacityAny: number;
  minOpacityAnyAt: string;
  /** Resident pane ids ever seen wearing an inline `opacity` of `"0"`. */
  heldResidents: string[];
  /** Every pane id ever seen wearing it, resident or not. */
  heldAny: string[];
  /** The millisecond a resident was first held, relative to the sampler. */
  heldResidentFirstMs: number;
  /** Shown pane ids whose rounded rect changed between two samples. */
  rectsMoved: string[];
  /** Exit ghosts seen at any one sample. */
  ghosts: number;
  offsetFirst: number;
  offsetLast: number;
  /** The offset at the instant the walk was about to begin. */
  offsetAtWalk: number;
}

const SAMPLER_START = `(function () {
  var RESIDENT = ${JSON.stringify(RESIDENT)};
  var s = {
    t0: Date.now(), samples: 0,
    minOpacity: 1, minOpacityAt: "-",
    minOpacityAny: 1, minOpacityAnyAt: "-",
    heldResident: {}, heldAny: {}, heldResidentFirstMs: -1,
    rects: {}, moved: {},
    ghosts: 0,
    offsetFirst: null, offsetLast: 0, offsetAtWalk: -1,
  };
  s.isResident = function (id) { return RESIDENT.indexOf(id) >= 0; };
  s.offsetNow = function () {
    try { return window.tugdeck.diag.getDeckState().flowOffset || 0; }
    catch (e) { return 0; }
  };
  window.__at0621 = s;
  s.timer = setInterval(function () {
    s.samples += 1;
    var ms = Date.now() - s.t0;

    // Every frame in the DOCUMENT, not only the shown ones: a fade that put a
    // pane of the workspace being left below full opacity is the same defect,
    // and scoping to the shown layer would look past it.
    var all = document.querySelectorAll(${JSON.stringify(ALL_FRAMES)});
    for (var i = 0; i < all.length; i++) {
      var id = all[i].getAttribute("data-pane-id");
      var o = parseFloat(getComputedStyle(all[i]).opacity);
      if (isNaN(o)) continue;
      if (o < s.minOpacityAny) {
        s.minOpacityAny = o;
        s.minOpacityAnyAt = id + " @" + ms + "ms";
      }
      if (s.isResident(id) && o < s.minOpacity) {
        s.minOpacity = o;
        s.minOpacityAt = id + " @" + ms + "ms";
      }
    }

    var shown = document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)});
    for (var j = 0; j < shown.length; j++) {
      var f = shown[j];
      var fid = f.getAttribute("data-pane-id");
      if (f.style.opacity === "0") {
        s.heldAny[fid] = true;
        if (s.isResident(fid)) {
          s.heldResident[fid] = true;
          if (s.heldResidentFirstMs < 0) s.heldResidentFirstMs = ms;
        }
      }
      var r = f.getBoundingClientRect();
      var key = Math.round(r.left) + "," + Math.round(r.top) + "," +
                Math.round(r.width) + "," + Math.round(r.height);
      if (s.rects[fid] === undefined) s.rects[fid] = key;
      else if (s.rects[fid] !== key) { s.moved[fid] = true; s.rects[fid] = key; }
    }

    var g = document.querySelectorAll(".tug-pane-exit-ghost").length;
    if (g > s.ghosts) s.ghosts = g;

    var off = s.offsetNow();
    if (s.offsetFirst === null) s.offsetFirst = off;
    s.offsetLast = off;
  }, 8);
  return null;
})()`;

/** Stamp the offset the walk is about to start from. */
const SAMPLER_MARK_WALK = `(function () {
  var s = window.__at0621;
  s.offsetAtWalk = s.offsetNow();
  return null;
})()`;

const SAMPLER_READ = `(function () {
  var s = window.__at0621;
  clearInterval(s.timer);
  function keys(o) {
    var out = [];
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) out.push(k); }
    return out;
  }
  return {
    samples: s.samples,
    minOpacity: s.minOpacity, minOpacityAt: s.minOpacityAt,
    minOpacityAny: s.minOpacityAny, minOpacityAnyAt: s.minOpacityAnyAt,
    heldResidents: keys(s.heldResident),
    heldAny: keys(s.heldAny),
    heldResidentFirstMs: s.heldResidentFirstMs,
    rectsMoved: keys(s.moved),
    ghosts: s.ghosts,
    offsetFirst: s.offsetFirst === null ? 0 : s.offsetFirst,
    offsetLast: s.offsetLast,
    offsetAtWalk: s.offsetAtWalk,
  };
})()`;

/**
 * The canvas at rest, read once everything has landed.
 *
 * This is the claim the sweep itself can fail. An id dropped from
 * `pendingArrivalsRef` without running its restorers leaves its frame wearing
 * `opacity: 0` for the life of the canvas — invisible rather than merely
 * faded, and invisible forever rather than for a beat. A mid-flight sampler
 * cannot tell that apart from a hold that is about to be handed back; a
 * reading taken at rest can, and that is the whole reason it is taken.
 */
interface Resting {
  /** Every frame still wearing an inline `opacity`, as `paneId=value`. */
  inlineOpacity: string[];
  /** Every frame not computing a flat 1, as `paneId=value`. */
  computed: string[];
  /** Exit ghosts still standing. */
  ghosts: number;
}

const RESTING_READ = `(function () {
  var out = {
    inlineOpacity: [], computed: [],
    ghosts: document.querySelectorAll(".tug-pane-exit-ghost").length,
  };
  var frames = document.querySelectorAll(${JSON.stringify(ALL_FRAMES)});
  for (var i = 0; i < frames.length; i++) {
    var id = frames[i].getAttribute("data-pane-id");
    if (frames[i].style.opacity !== "") {
      out.inlineOpacity.push(id + "=" + frames[i].style.opacity);
    }
    var o = getComputedStyle(frames[i]).opacity;
    if (o !== "1") out.computed.push(id + "=" + o);
  }
  return out;
})()`;

const TRACE_KINDS = ["settle-arm", "settle-release", "settle-retarget"];
const traceRead = (mark: number): string =>
  `JSON.stringify(window.__deckTrace.since(${mark}).filter(function (e) {
     return ${JSON.stringify(TRACE_KINDS)}.indexOf(e.kind) >= 0;
   }).map(function (e) {
     return e.kind + (e.landing ? ":" + e.landing : "") +
            (e.outcome ? "/" + e.outcome : "") +
            (e.source ? "/" + e.source : "") +
            (e.paneId ? "/" + e.paneId : "");
   }))`;

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * A four-up FLOW deck, so the band is narrower than the strip and walking the
 * reader to slot 4 actually has somewhere to travel to. Under `fit` every slot
 * is already in view and the activation would move nothing, which would make
 * the "it travelled" claim unfalsifiable.
 */
function flowDeck(
  prefix: string,
  railCardId: string,
  railPaneId: string,
): Record<string, unknown> {
  const ids = [1, 2, 3, 4].map((n) => `${prefix}-c${n}`);
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "hello",
        title: id,
        closable: true,
      })),
      { id: railCardId, componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `${prefix}-p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: SLIM_PX, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
      {
        id: railPaneId,
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: [railCardId],
        activeCardId: railCardId,
        title: "Layout",
        acceptsFamilies: [] as string[],
      },
    ],
    activePaneId: `${prefix}-p1`,
    imposition: {
      kind: "four-up",
      sidebars: { layout: { side: "right" } },
      layout: "flow",
    },
    hasFocus: true,
  };
}

function twoSpaceBlob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      { id: SPACE_ONE, name: "One", deck: flowDeck("a", "at0621-l1", "at0621-pl1") },
      { id: SPACE_TWO, name: "Two", deck: flowDeck("b", "at0621-l2", "at0621-pl2") },
    ],
  };
}

const activateSpace = (app: App, spaceId: string): Promise<null> =>
  app.evalJS<null>(
    `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`,
  );

/**
 * Walk the reader from slot 1 to slot 4 — three activations, each one a real
 * `focus-card` gesture rather than a store poke, dispatched raw so the sampler
 * sees the whole run rather than one settled step at a time.
 *
 * Home first, so the walk has the whole band to travel and the "it moved"
 * claim is falsifiable rather than already satisfied by wherever the strip
 * happened to be standing.
 */
const walkToSlotFour = async (app: App): Promise<void> => {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("go-to-slot", { value: 1 }), null)`,
  );
  await wait(AFTER_LAND_MS);
  await app.evalJS<null>(SAMPLER_MARK_WALK);
  for (let i = 0; i < 3; i += 1) {
    await app.evalJS<null>(
      `(window.__tug.dispatchControlAction("focus-card", { value: "right" }), null)`,
    );
    await wait(140);
  }
};

/**
 * The strip moved. First of the claims, deliberately: a change that cut all
 * motion would satisfy every opacity claim in this file by doing nothing at
 * all, and this is the one it could not satisfy.
 */
function expectTravelled(reading: Reading, leg: string): void {
  expect(
    reading.samples,
    `${leg}: the sampler ticked across the gesture`,
  ).toBeGreaterThan(10);
  expect(
    reading.offsetAtWalk === reading.offsetLast,
    `${leg}: the walk travelled the band — ${reading.offsetAtWalk} -> ` +
      `${reading.offsetLast}px, frames moved: ` +
      `${reading.rectsMoved.join(",") || "none"}`,
  ).toBe(false);
}

/** Nothing faded, at any sample of the window. The plain gesture's whole bar. */
function expectNoFade(reading: Reading, leg: string): void {
  expect(
    reading.minOpacity,
    `${leg}: no frame that never left the screen computed below full opacity ` +
      `(lowest resident: ${reading.minOpacity} on ${reading.minOpacityAt}; ` +
      `lowest anywhere: ${reading.minOpacityAny} on ${reading.minOpacityAnyAt})`,
  ).toBe(1);
  expect(
    reading.heldResidents,
    `${leg}: no resident frame was ever held at an inline opacity of zero ` +
      `(held anywhere: ${reading.heldAny.join(",") || "none"})`,
  ).toEqual([]);
}

/**
 * The canvas came to rest clean. Held by BOTH legs, because a hold that is
 * never handed back is a defect whatever launched it.
 */
function expectNoResidue(resting: Resting, leg: string): void {
  expect(
    resting.inlineOpacity,
    `${leg}: no frame was left wearing an inline opacity`,
  ).toEqual([]);
  expect(
    resting.computed,
    `${leg}: every frame came to rest fully opaque`,
  ).toEqual([]);
  expect(resting.ghosts, `${leg}: no exit ghost was left standing`).toBe(0);
}

describe.skipIf(!SHOULD_RUN)(
  "at0621 — an activation inside a workspace slides",
  () => {
    test(
      "the plain walk, and the same walk after an arrival a switch cut short",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(twoSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: "at0621-intra-workspace-slide",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 5`,
            { timeoutMs: 30_000 },
          );
          await wait(AFTER_LAND_MS);

          // ---- Leg 1: the plain walk. ------------------------------------
          const mark1 = await app.evalJS<number>(
            `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
          );
          await app.evalJS<null>(SAMPLER_START);
          await walkToSlotFour(app);
          await wait(AFTER_LAND_MS);
          const plain = await app.evalJS<Reading>(SAMPLER_READ);
          const restingPlain = await app.evalJS<Resting>(RESTING_READ);
          note(`at0621 plain walk: ${JSON.stringify(plain)}`);
          note(`at0621 plain walk at rest: ${JSON.stringify(restingPlain)}`);
          note(
            `at0621 plain walk trace: ${await app.evalJS<string>(traceRead(mark1))}`,
          );

          // ---- Leg 2: the arrival a switch cut short. ---------------------
          // One window over the whole thing — the card opening, the crossing
          // out and back, and the walk — because the defect lands on the
          // switch rather than on the activation that follows it, and a window
          // opened after the switch would look straight past it.
          const mark2 = await app.evalJS<number>(`window.__deckTrace.mark()`);
          await app.evalJS<null>(SAMPLER_START);
          // A card opened into this workspace: a settle with a real arrival,
          // whose held frame is registered in `pendingArrivalsRef`.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("new-text-card"), null)`,
          );
          // Inside the arrive beat, and deliberately short: the switch has to
          // land while the hold is still standing, which is the whole of the
          // precondition.
          await wait(70);
          await activateSpace(app, SPACE_TWO);
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_TWO)}`,
            { timeoutMs: 10_000 },
          );
          await activateSpace(app, SPACE_ONE);
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_ONE)}`,
            { timeoutMs: 10_000 },
          );
          await wait(AFTER_LAND_MS);
          await walkToSlotFour(app);
          await wait(AFTER_LAND_MS);
          const afterSwitch = await app.evalJS<Reading>(SAMPLER_READ);
          const restingAfter = await app.evalJS<Resting>(RESTING_READ);
          note(
            `at0621 cut-short arrival, then the walk: ${JSON.stringify(afterSwitch)}`,
          );
          note(`at0621 leg 2 at rest: ${JSON.stringify(restingAfter)}`);
          note(`at0621 leg 2 trace: ${await app.evalJS<string>(traceRead(mark2))}`);

          expectTravelled(plain, "plain");
          expectNoFade(plain, "plain");
          expectNoResidue(restingPlain, "plain");

          expectTravelled(afterSwitch, "after a cut-short arrival");
          expectNoFade(afterSwitch, "after a cut-short arrival");
          expectNoResidue(restingAfter, "after a cut-short arrival");
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

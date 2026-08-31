/**
 * at0450-imposer-cut-census.test.ts — every layout change travels; none of them
 * jump.
 *
 * The deck's motion promise is not "slot moves animate". It is that a card
 * never changes places without crossing the distance in view. The settle keeps
 * that promise for the changes it can see: `arrangementSignature` arms a First
 * measurement before the commit, and the layout effect tweens every frame whose
 * rect moved (`deck-canvas.tsx`, `lib/pane-flip.ts`). What this test is for is
 * the changes it CANNOT see — a frame that mounted with no First rect to
 * measure, a commit that landed inside a `flushSync` where the measurement
 * could not reach, a tween cancelled and re-baked mid-flight. Each of those
 * produces a card that is in one place on one frame and somewhere else on the
 * next, with nothing animating it. That is a cut, and a cut is the promise
 * broken.
 *
 * A cut is invisible to the kind of assertion `at0294` makes. Sampling geometry
 * before a gesture and after it cannot tell a 300ms glide from an instant jump —
 * both land in the same place. Only watching every frame in between can, so
 * that is what the detector does (`lib/cut-detector.ts`): armed, it samples
 * every imposed frame once per animation frame and records two shapes of broken
 * promise. A `jump` is a frame already on screen that changed places with
 * nothing animating it. An `appeared` is a frame that arrived already at its
 * final geometry with nothing animating it — no delta describes that one, since
 * there is no earlier sample to subtract from, which is exactly why the enter
 * defect needs its own shape rather than falling out of the jump rule.
 *
 * The census is therefore a LIST, and the list is the point. Each gesture below
 * declares how many panes may cut during it, and the count is an allowlist
 * entry rather than a tolerance: a zero says the gesture is fully carried, and
 * a non-zero names a defect this suite is holding still while it is fixed. The
 * entries start where the deck actually is and shrink as the enter/exit
 * treatments and the timing fixes land — a gesture that stops cutting must have
 * its entry taken to zero in the same change, or this test goes quiet about the
 * regression it exists to catch.
 *
 * Three classes are accepted permanently rather than fixed, and they are absent
 * from the gesture set for that reason: a theme swap and a chrome-tier change
 * move geometry from outside the store, and the settled-resize retune
 * deliberately re-arranges the rails after the hand stops. Those are recorded
 * in `tuglaws/animation-doctrine.md`, not here.
 *
 * Scenario: a three-up deck with a pinned Lens, then one gesture at a time —
 * slot move, deck width change, Lens side flip, bullseye in and out, raise,
 * card open, card close, and a retarget (a second slot move dispatched inside
 * the first one's settle window). The detector is drained after each so a cut
 * is attributed to the gesture that caused it.
 *
 * @covers tugdeck/src/lib/cut-detector.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/imposer-motion.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, expect, test } from "bun:test";

import {
  launchTugApp,
  note,
  summarizeMotionCensus,
  type App,
  type MotionCensusReading,
} from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const FRAMES = ".tug-pane[data-pane-id]";
const LENS_WIDTH = 675;
const PANE_WIDTH = 420;
/** The settle window (`IMPOSITION_SETTLE_MS`) plus room for the tween to land. */
const AFTER_LAND_MS = 900;

/**
 * How many panes may cut during each gesture, and why.
 *
 * Every non-zero entry is a defect held still, not a tolerance. Take an entry
 * to zero in the same change that fixes it.
 */
const ALLOWED_CUTS: Record<string, { max: number; why: string }> = {
  "slot-move": { max: 0, why: "carried by the settle" },
  "content-width": { max: 0, why: "carried by the settle" },
  "lens-side": { max: 0, why: "carried by the settle" },
  "bullseye-in": { max: 0, why: "carried by the settle" },
  "bullseye-out": { max: 0, why: "carried by the settle" },
  raise: { max: 0, why: "z-order only; nothing moves" },
  "card-open": {
    max: 0,
    why: "a new frame has no First rect, so it enters under its own fade-and-rise",
  },
  "card-close": {
    max: 0,
    why: "the closing frame unmounts; its ghost carries the departure, survivors are carried by the settle",
  },
  retarget: { max: 0, why: "the second settle starts from where the eye is" },
  "flow:enter": {
    max: 0,
    why: "the mode bit is a signature term of its own, so the toggle arms a settle",
  },
  "flow:leave": { max: 0, why: "and so is leaving it" },
  detach: {
    max: 0,
    why: "the detach commits inside flushSync; First must be measured before it lands",
  },
  "tab-switch": {
    max: 0,
    why: "display flips inside flushSync while the pane keeps its box",
  },
  imposition: { max: 0, why: "carried by the settle" },
  "column-split": {
    max: 0,
    why: "the column mode and its seams are signature terms, so the flip arms a settle",
  },
  "column-stack": { max: 0, why: "and so is re-stacking" },
  "column-overflow-reveal": {
    max: 0,
    why: "the column offset is a signature term, so a reveal arms the settle that carries the slide",
  },
  "drop-zone-commit": {
    max: 0,
    why: "a drop is an arrangement change; the dragged frame keeps data-gesture and every other frame the commit moves is carried",
  },
};

interface CutRecord {
  kind: "jump" | "appeared";
  paneId: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

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
      card("C", "gallery-accordion", "Card C"),
      card("L", "layout", "Layout"),
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: LENS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "three-up", lens: "right" },
    hasFocus: true,
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

async function armDetector(app: App): Promise<void> {
  await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
}

async function disarmDetector(app: App): Promise<void> {
  await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
}

async function takeCuts(app: App): Promise<CutRecord[]> {
  return app.evalJS<CutRecord[]>(`window.__tug.takeCutRecords()`);
}

/** Seed the Lens's durable chosen width so the allocator is not in the picture. */
async function seedLensPreferred(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
  );
}

/**
 * Run one gesture with the detector draining before and after, and hand back
 * whatever cut during it. The pre-drain discards anything still settling from
 * the previous gesture, so a record is always attributed to its own cause.
 */
async function census(
  app: App,
  gesture: () => Promise<void>,
): Promise<CutRecord[]> {
  await takeCuts(app);
  await gesture();
  await wait(AFTER_LAND_MS);
  return takeCuts(app);
}

function summarize(records: readonly CutRecord[]): string {
  return records
    .map((r) =>
      r.kind === "appeared"
        ? `${r.paneId} appeared with nothing animating it`
        : `${r.paneId} jumped (${Math.round(r.dx)}, ${Math.round(r.dy)}) and resized (${Math.round(r.dw)}, ${Math.round(r.dh)})`,
    )
    .join("; ");
}

describe.skipIf(!SHOULD_RUN)(
  "at0450 — every layout change is carried, and the census says which are not",
  () => {
    test(
      "the cut census across the deck's layout gestures",
      async () => {
        const app = await launchTugApp({
          testName: "at0450-imposer-cut-census",
        });
        try {
          await seedLensPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          await armDetector(app);

          // A deck at rest must produce nothing at all. If this fails, every
          // count below is noise and none of them mean anything.
          await takeCuts(app);
          await wait(AFTER_LAND_MS);
          const atRest = await takeCuts(app);
          expect(
            atRest.length,
            `a settled deck cut: ${summarize(atRest)}`,
          ).toBe(0);

          // ---- The gesture transaction ---------------------------------
          //
          // The store contract every release below depends on: a batch is
          // one notification however many mutations it holds, a nested
          // batch joins the outer one rather than closing early, a throw
          // still tells subscribers (a failed gesture must not leave them
          // looking at a state nobody announced), and a batch that mutates
          // nothing says nothing.
          //
          // Driven against the live `DeckManager` because that is the only
          // one there is: it is browser-coupled — window timers, tugbank,
          // the lifecycle registry — and no unit test constructs one.
          const batch = async (shape: string) =>
            app.evalJS<{ notifies: number; threw: boolean }>(
              `window.__tug.probeBatchGesture(${JSON.stringify(shape)})`,
            );
          expect(
            (await batch("single")).notifies,
            "two mutations in one batch tell subscribers once",
          ).toBe(1);
          expect(
            (await batch("nested")).notifies,
            "a nested batch joins the outer one rather than firing its own",
          ).toBe(1);
          const thrown = await batch("throws");
          expect(thrown.threw, "the exception escapes the batch").toBe(true);
          expect(
            thrown.notifies,
            "and the pending notification still fires on the way out",
          ).toBe(1);
          expect(
            (await batch("empty")).notifies,
            "a batch that mutates nothing notifies nobody",
          ).toBe(0);
          await takeCuts(app);

          const found: Record<string, CutRecord[]> = {};

          found["slot-move"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("assign-slot", { cardId: "A", slot: 2 }), null)`,
            );
          });

          found["content-width"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-content-width", { preset: "slim" }), null)`,
            );
          });

          found["lens-side"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-sidebar-side", { componentId: "layout", side: "left" }), null)`,
            );
          });

          found["bullseye-in"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-bullseye", { paneId: "p2" }), null)`,
            );
          });

          found["bullseye-out"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-bullseye", { paneId: "p2" }), null)`,
            );
          });

          found["raise"] = await census(app, async () => {
            await app.evalJS<null>(`(window.__tug.activateCard("C"), null)`);
          });

          found["card-open"] = await census(app, async () => {
            await app.dispatchControlAction("show-component-gallery");
          });

          // The close is the one gesture whose carrier the detector cannot see:
          // a departed frame is out of the DOM, so nothing about it can be
          // sampled and a zero here would be true no matter what happened. The
          // ghost is what makes the departure visible, so it is asserted
          // directly — present while the fade runs, gone afterwards.
          let ghostsMidFlight = 0;
          found["card-close"] = await census(app, async () => {
            await app.evalJS<null>(`(window.__tug.closePane("p3"), null)`);
            ghostsMidFlight = await app.evalJS<number>(
              `document.querySelectorAll(".tug-pane-exit-ghost").length`,
            );
          });
          expect(
            ghostsMidFlight,
            "a closing pane leaves a ghost to carry its departure",
          ).toBe(1);
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(".tug-pane-exit-ghost").length`,
            ),
            "the ghost is taken away when its fade lands ([D6] — nothing retained at rest)",
          ).toBe(0);

          // Retarget: a second arrangement change dispatched INSIDE the first
          // one's settle window. The second First measurement has to read the
          // running tween's transform, or the frame snaps back to its
          // untweened position before starting over.
          found["retarget"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("assign-slot", { cardId: "A", slot: 0 }), null)`,
            );
            await wait(80);
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("assign-slot", { cardId: "A", slot: 2 }), null)`,
            );
          });

          found["imposition"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-imposition", { kind: "two-up" }), null)`,
            );
          });

          // The two gestures that commit their geometry inside `flushSync`.
          // Both are here because a synchronous commit inside the notify chain
          // can put the DOM at its new geometry before `arm` has measured the
          // old one — and a First measured after the fact is no measurement at
          // all: the delta comes out zero and the frame cuts.
          //
          // A tab switch first, which needs a pane holding two cards.
          await app.dispatchControlAction("add-card-to-active-pane");
          await wait(AFTER_LAND_MS);
          const stacked = await app.evalJS<{ paneId: string; cardIds: string[] } | null>(
            `(function () {
              var panes = window.tugdeck.diag.getDeckState().panes;
              for (var i = 0; i < panes.length; i++) {
                if (panes[i].cardIds.length > 1) {
                  return { paneId: panes[i].id, cardIds: panes[i].cardIds };
                }
              }
              return null;
            })()`,
          );
          expect(
            stacked,
            "the tab-switch and detach cells need a pane holding two cards",
          ).not.toBeNull();
          const [firstCard, secondCard] = stacked?.cardIds ?? [];

          found["tab-switch"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.activateCard(${JSON.stringify(firstCard)}), null)`,
            );
          });

          // …then pulling one of them back out, which is the detach: the card
          // leaves the stack for a pane that did not exist a moment ago, and
          // `_detachCard` commits that inside `flushSync`.
          found["detach"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(secondCard)}, slot: 1 }), null)`,
            );
          });

          // ── The same battery again, in FLOW ─────────────────────────────
          // Flow moves every imposed frame's `left` onto a different
          // expression, so a gesture carried in fit is not thereby carried in
          // flow: the settle has to arm on the mode's own signature terms and
          // the strip has to be resolved before the Last measurement. The
          // gestures re-run are the ones that move the chain; the ones that
          // add or remove a frame are mode-blind and are not repeated.
          //
          // Entering the mode is itself a gesture, and it is the first cell —
          // the toggle moves every pane while every pre-flow signature term
          // holds still, which is precisely the cut this pass exists to catch.
          found["flow:enter"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: "flow" }), null)`,
            );
          });

          found["flow:slot-move"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("assign-slot", { cardId: "A", slot: 1 }), null)`,
            );
          });

          found["flow:content-width"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-content-width", { preset: "comfy" }), null)`,
            );
          });

          found["flow:raise"] = await census(app, async () => {
            await app.evalJS<null>(`(window.__tug.activateCard("B"), null)`);
          });

          found["flow:bullseye-in"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-bullseye", { paneId: "p1" }), null)`,
            );
          });

          found["flow:bullseye-out"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-bullseye", { paneId: "p1" }), null)`,
            );
          });

          found["flow:leave"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: "fit" }), null)`,
            );
          });

          // ── The column split, in fit ────────────────────────────────────
          // A mode flip moves every member's vertical pins while no pane
          // changes slot, width, or kind — so the pane terms of the signature
          // hold still throughout and the column terms are the only thing that
          // can arm the settle. The two cells below are what fails if those
          // terms are dropped, and they are here rather than only in at0455
          // because this file is the census the whole surface answers to.
          //
          // The gesture needs a slot with two cards in it, which the battery
          // above has already produced: `flow:slot-move` put A alongside B in
          // slot 1 and nothing since has separated them.
          found["column-split"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-column-mode", { slot: 1, mode: "split" }), null)`,
            );
          });
          // The cell has to have DONE something, or "no cuts" is the trivial
          // truth about a gesture that moved nothing. A slot that never gained
          // its second card would report a clean census forever.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(".tug-pane[data-column-split]").length`,
            ),
            "the column-split cell actually divided slot 1",
          ).toBeGreaterThan(1);

          found["column-stack"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-column-mode", { slot: 1, mode: "stack" }), null)`,
            );
          });
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(".tug-pane[data-column-split]").length`,
            ),
            "the column-stack cell actually re-stacked slot 1",
          ).toBe(0);

          // And once in flow, where a split member's `left` rides the strip
          // expression rather than the travel fraction.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-imposition-layout", { layout: "flow" }), null)`,
          );
          await wait(AFTER_LAND_MS);
          await takeCuts(app);
          found["flow:column-split"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.dispatchControlAction("set-column-mode", { slot: 1, mode: "split" }), null)`,
            );
          });
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(".tug-pane[data-column-split]").length`,
            ),
            "the flow:column-split cell actually divided slot 1",
          ).toBeGreaterThan(1);

          // A third member takes the column past dividing and into scrolling
          // ([P08]), and then raising the member below the run slides the
          // whole strip. The offset is a signature term ([P12]) for exactly
          // this reason: without it the raise would move every frame in the
          // column while the signature stood still, and the slide would cut.
          //
          // The arrival is outside the census — it is the overflow transition,
          // not the reveal — so its cuts are taken and discarded before the
          // cell arms.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("assign-slot", { cardId: "C", slot: 1 }), null)`,
          );
          await wait(AFTER_LAND_MS);
          // The column's members, top to bottom as they actually paint. The
          // arrival raised whichever member it raised and may have revealed it,
          // so the strip is brought home first — the cell has to be a slide
          // FROM rest, or a clean census would be the trivial truth about a
          // gesture that moved nothing.
          const members = await app.evalJS<string[]>(
            `(function () {
              var state = window.tugdeck.diag.getDeckState();
              return Array.prototype.slice
                .call(document.querySelectorAll(
                  '.tug-pane[data-column-split][data-imposed="1"]'
                ))
                .sort(function (a, b) {
                  return a.getBoundingClientRect().top
                       - b.getBoundingClientRect().top;
                })
                .map(function (el) {
                  var id = el.getAttribute("data-pane-id");
                  var pane = state.panes.find(function (p) { return p.id === id; });
                  return pane === undefined ? null : pane.activeCardId;
                })
                .filter(function (x) { return x !== null; });
            })()`,
          );
          await app.evalJS<null>(
            `(window.__tug.activateCard(${JSON.stringify(members[0])}), null)`,
          );
          await wait(AFTER_LAND_MS);
          expect(
            await app.evalJS<number>(
              `((window.tugdeck.diag.getDeckState().columnOffsets || {})[1] || 0)`,
            ),
            "the strip is at rest before the reveal cell",
          ).toBe(0);
          await takeCuts(app);
          found["flow:column-overflow-reveal"] = await census(app, async () => {
            await app.evalJS<null>(
              `(window.__tug.activateCard(${JSON.stringify(members[members.length - 1])}), null)`,
            );
          });
          // Engagement guard, in two parts: the column really did overflow, and
          // the raise really did slide it. A cell that revealed nothing would
          // report a clean census about a gesture that moved no frame.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(
                 '.tug-pane[data-column-split][data-imposed="1"]'
               ).length`,
            ),
            "the overflow cell actually took slot 1 past two members",
          ).toBeGreaterThanOrEqual(3);
          expect(
            await app.evalJS<number>(
              `((window.tugdeck.diag.getDeckState().columnOffsets || {})[1] || 0)`,
            ),
            "the overflow cell actually slid slot 1's strip",
          ).toBeGreaterThan(0);

          // ---- The drop-zone drag's commit ------------------------------
          //
          // The one gesture in this file driven by a real pointer rather than
          // a dispatch, because the thing being censused is the handoff at its
          // end: the dragged frame is parked at the zone and keeps
          // `data-gesture` (so the detector rightly exempts it), and every
          // OTHER frame the commit moves — the column it left closing up, the
          // slot it joined making room — must be carried by the settle like
          // any other arrangement change.
          const moverPane = await app.evalJS<string | null>(
            `(function () {
              var state = window.tugdeck.diag.getDeckState();
              var pane = state.panes.find(function (p) {
                return p.activeCardId === ${JSON.stringify(members[members.length - 1])};
              });
              return pane === undefined ? null : pane.id;
            })()`,
          );
          const targetPane = await app.evalJS<string | null>(
            `(function () {
              var el = document.querySelector('.tug-pane[data-imposed="0"]');
              return el === null ? null : el.getAttribute("data-pane-id");
            })()`,
          );
          expect(moverPane).not.toBeNull();
          expect(targetPane).not.toBeNull();
          // Driven as grab-then-release rather than as one atomic drag,
          // because the motion census below is about the RELEASE. The grab
          // raises the card, and that raise is its own arrangement change
          // at its own moment — folding it into the release's count would
          // be measuring two gestures and calling it one.
          const dropPoint = await app.evalJS<{ x: number; y: number }>(
            `(function () {
              var r = document.querySelector(
                '.tug-pane[data-pane-id="' + ${JSON.stringify(targetPane)} + '"]'
              ).getBoundingClientRect();
              return {
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
              };
            })()`,
          );
          let releaseMotion: MotionCensusReading | null = null;
          found["flow:drop-zone-commit"] = await census(app, async () => {
            await app.nativeDragElementWithoutRelease(
              `.tug-pane[data-pane-id="${moverPane}"] .tug-pane-title-bar`,
              dropPoint,
            );
            releaseMotion = await app.motionCensus(async () => {
              await app.nativeMouseUp(dropPoint);
            });
          });
          expect(
            await app.evalJS<number | null>(
              `(function () {
                var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
                  return p.id === ${JSON.stringify(moverPane)};
                });
                if (pane === undefined) return null;
                return pane.slot === undefined ? null : pane.slot;
              })()`,
            ),
            "the drop-zone cell actually moved the card it dragged",
          ).toBe(0);

          // The butter bar, in numbers. A release is one journey, so the
          // deck hears about it once; one telling arms the settle at most
          // once; and an arm that lands on no running tween has nothing to
          // retarget. Before the gesture transaction this read 3 notifies
          // (the imposition commit plus two first-responder flips).
          expect(releaseMotion).not.toBeNull();
          note(summarizeMotionCensus("drop-zone release", releaseMotion!));
          expect(
            releaseMotion!.notifies,
            "a release is one commit, so it is one notification",
          ).toBe(1);
          expect(
            releaseMotion!.arms,
            "one arrangement change arms the settle at most once",
          ).toBeLessThanOrEqual(1);
          expect(
            releaseMotion!.retargets.snap,
            "and nothing is snapped to its end mid-flight",
          ).toBe(0);

          await disarmDetector(app);

          const over: string[] = [];
          for (const [gesture, records] of Object.entries(found)) {
            // A flow cell answers to its fit twin's allowance: the mode may
            // change where a frame goes, never whether it is carried there.
            const allowed =
              ALLOWED_CUTS[gesture] ??
              ALLOWED_CUTS[gesture.replace(/^flow:/, "")];
            if (allowed === undefined) {
              over.push(`${gesture}: no allowlist entry`);
              continue;
            }
            note(
              `${gesture}: ${records.length} cut(s), allowed ${allowed.max} — ${allowed.why}`,
            );
            if (records.length > allowed.max) {
              over.push(
                `${gesture}: ${records.length} cut(s) > ${allowed.max} allowed (${allowed.why}) — ${summarize(records)}`,
              );
            }
          }

          expect(over.join("\n")).toBe("");

          // Disarming is not bookkeeping: a detector still sampling after the
          // run is a standing per-frame cost, which the quiet contract forbids.
          expect(
            await app.evalJS<number>(
              `(window.__tug.takeCutRecords(), 0)`,
            ),
          ).toBe(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

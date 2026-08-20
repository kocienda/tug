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
 * @covers tugdeck/src/lib/layout-imposer.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

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
      card("L", "lens", "Lens"),
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
              `(window.__tug.dispatchControlAction("set-sidebar-side", { componentId: "lens", side: "left" }), null)`,
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

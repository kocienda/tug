/**
 * at0576-close-during-arrival.test.ts — a card closed while another is still
 * arriving carries every frame beside it, and cuts none of them.
 *
 * ## What this gates
 *
 * A close is an arrangement change like any other, and the settle carries it:
 * the departing frame's ghost fades where the frame stood, and every survivor
 * glides into the room it gives up. `at0450` already holds that for a close
 * on a deck at rest.
 *
 * This file is about the close that lands while the deck is still MOVING —
 * open a card and close it right away, which is what a reader does the moment
 * they decide the card they just asked for is not the one they wanted. The arm
 * that carries the close has to read every frame's First rect through the
 * arrival tween still playing over it, and one of them came back wrong: the
 * frame's inline style still carried the START pose of that tween, an
 * accelerated transform is resolved on the compositor rather than in the style
 * the main thread hands `getBoundingClientRect`, and so First came back equal
 * to Last for exactly one frame per gesture. The Last pass planned no tween
 * for it, and it CUT a full card's width to its new place while every frame
 * beside it glided — the promise in [P08] broken in the plainest way there is.
 *
 * The repair is an ordering: `hold-at-current` is `commitStyles()`, which
 * resolves the animation's own current value into inline style, so the arm
 * HOLDS each frame before it measures it rather than after.
 *
 * The claim here is the census's claim, narrowed to this one gesture and read
 * per frame: across a run of open-then-close-immediately gestures, no frame
 * ever changes place by more than a glide's worth in a single animation frame.
 * A cut is what the detector sees as a step of hundreds of pixels between two
 * consecutive samples — the previous defect was a reproducible 479px — where a
 * carried frame's largest step is the fastest instant of its curve.
 *
 * The gesture is repeated, because the first one never cut: the frame that
 * read stale is whichever one the arm reaches while wearing a start-pose hold,
 * and a fresh deck has no settle behind it to leave one. Five of the six runs
 * cut before the fix; none do after.
 *
 * The fixture is a five-up FLOW band with its cards in slots 2–4, so the
 * Session card opens into the empty left of the strip and the cards to its
 * right are the ones that have to move — the shape the defect was reported
 * from (a new card in slot 1, an empty slot 2 beside it).
 *
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/components/tugways/tug-animator.ts
 */
import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The width each seeded card stands at. */
const SLIM_PX = 560;
/** How many open-then-close gestures the census runs. */
const GESTURES = 4;
/** How long after the open the close lands — inside the arrival's settle. */
const CLOSE_AFTER_MS = 400;
/** How long the per-frame sampler watches each gesture. */
const CENSUS_MS = 3_000;
/**
 * The largest single-frame step a CARRIED frame may take.
 *
 * A crossing moves a frame a few hundred pixels over its whole curve, so its
 * fastest instant is tens of pixels between two animation frames. The defect
 * this file gates was a 479px step — a full card's width in one frame — so the
 * bar sits far above the one and far below the other, and cannot be met by a
 * glide that merely ran fast.
 */
const CUT_PX = 100;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * A five-up FLOW band holding three cards in slots 2, 3 and 4.
 *
 * Slots 0 and 1 stand empty on purpose: the Session card added below opens
 * into the band's own middle, which puts it left of every seeded card, and the
 * three of them are what the arrival pushes right and the close lets back.
 */
function deckShape() {
  const ids = ["C", "D", "E"];
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "hello",
      title: `Card ${id}`,
      closable: true,
    })),
    panes: ids.map((id, index) => ({
      id: `p${index + 1}`,
      position: { x: 40, y: 40 },
      size: { width: SLIM_PX, height: 400 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
      slot: index + 2,
    })),
    activePaneId: "p3",
    imposition: { kind: "five-up", sidebars: {}, layout: "flow" },
    hasFocus: true,
  };
}

interface Sample {
  t: number;
  /** The beat the imposer named on this frame, `""` outside a beat. */
  beat: string;
  /** Every live frame's left edge, keyed by pane id. */
  x: Record<string, number>;
  /** Where the store says the flow strip stands, in px. */
  offset: number;
}

/**
 * Arm a per-frame sampler that records every imposed frame's left edge.
 *
 * On `requestAnimationFrame` and installed before the gesture, because a cut
 * is invisible to a before-and-after reading: the frame is in one place on one
 * frame and somewhere else on the next, and only a sampler watching every
 * frame in between can tell that from a glide that covered the same ground.
 */
async function startSampler(app: App, ms: number): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      window.__at0576 = [];
      var t0 = performance.now();
      var tick = function () {
        var canvas = document.querySelector("[data-imposer-settling]");
        var s = {
          t: Math.round(performance.now() - t0),
          beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
          offset: Math.round(window.tugdeck.diag.getDeckState().flowOffset || 0),
          x: {},
        };
        var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
        for (var i = 0; i < frames.length; i += 1) {
          var el = frames[i];
          s.x[el.getAttribute("data-pane-id")] = Math.round(
            el.getBoundingClientRect().left,
          );
        }
        window.__at0576.push(s);
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

/** Every pane id the store holds, with the slot it stands in. */
async function paneIds(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `window.tugdeck.diag.getDeckState().panes.map(function (p) { return p.id; })`,
  );
}

/** Press the picker's Cancel, which closes the host card ([D02] cascade). */
const CANCEL_PICKER = `(function () {
  var form = document.querySelector(".session-card-picker-form");
  if (form === null) return "no-picker";
  var buttons = form.querySelectorAll(".tug-sheet-actions button");
  for (var i = 0; i < buttons.length; i += 1) {
    if ((buttons[i].textContent || "").trim() === "Cancel") {
      buttons[i].click();
      return "clicked";
    }
  }
  return "no-cancel";
})()`;

/** Seed the deck and let the imposer settle. */
async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
  await app.waitForCondition<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(1_400);
}

/**
 * Open a Session card, close it mid-arrival, and hand back every frame's
 * biggest single-frame step over the whole gesture.
 */
async function gesture(
  app: App,
  index: number,
): Promise<{ paneId: string; dx: number; t: number; beat: string }[]> {
  await seed(app);
  const before = await paneIds(app);
  const mark = await app.evalJS<number>(
    `(function () { window.__deckTrace.enable(true); return window.__deckTrace.mark(); })()`,
  );
  await startSampler(app, CENSUS_MS);
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("show-card", { component: "session" }), null)`,
  );
  await wait(CLOSE_AFTER_MS);
  const after = await paneIds(app);
  const newPane = after.find((id) => !before.includes(id));
  expect(newPane, `gesture ${index}: the Session card opened`).toBeDefined();
  expect(
    await app.evalJS<string>(CANCEL_PICKER),
    `gesture ${index}: the picker's Cancel was there to press`,
  ).toBe("clicked");
  await wait(CENSUS_MS);

  const samples = await app.evalJS<Sample[]>(`window.__at0576`);
  // An occluded harness window suspends `requestAnimationFrame`, and a census
  // with no samples in it would pass this file's claim by having watched
  // nothing at all. The bar is the same one `at0566` sets on its own sampler.
  expect(
    samples.length,
    `gesture ${index}: the settle must be sampled mid-motion`,
  ).toBeGreaterThan(5);
  const trace = await app.evalJS<string[]>(
    `(function () {
      var events = window.__deckTrace.since(MARK);
      var out = [];
      for (var i = 0; i < events.length; i += 1) {
        var e = events[i];
        if (e.kind === "settle-arm") out.push("arm panes=" + e.panes + " armed=" + e.armed + " landing=" + e.landing + " outcome=" + e.outcome);
        else if (e.kind === "settle-retarget") out.push("retarget " + e.paneId + " " + e.mode + " " + e.beat);
      }
      return out;
    })()`.replace("MARK", String(mark)),
  );
  note(`gesture ${index} trace`, trace.join("\n"));
  const steps: { paneId: string; dx: number; t: number; beat: string }[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prior = samples[i - 1].x;
    const now = samples[i].x;
    for (const paneId of Object.keys(now)) {
      if (!(paneId in prior)) continue;
      const dx = Math.abs(now[paneId] - prior[paneId]);
      if (dx >= CUT_PX) {
        steps.push({
          paneId: paneId === newPane ? "(the closing card)" : paneId,
          dx,
          t: samples[i].t,
          beat: `${samples[i].beat}", strip at ${samples[i - 1].offset}→${samples[i].offset}px`,
        });
      }
    }
  }
  note(
    `gesture ${index}`,
    `${samples.length} frames sampled; ${steps.length === 0 ? "no cut" : `${steps.length} cut(s)`}`,
  );
  return steps;
}

describe.skipIf(!SHOULD_RUN)("AT0576: a close during an arrival", () => {
  test(
    "carries every surviving frame, and cuts none of them",
    async () => {
      const app = await launchTugApp({ testName: "at0576-close-arrival" });
      try {
        const cuts: string[] = [];
        for (let i = 1; i <= GESTURES; i += 1) {
          for (const step of await gesture(app, i)) {
            cuts.push(
              `gesture ${i}: ${step.paneId} jumped ${step.dx}px in one frame at ${step.t}ms (beat "${step.beat}")`,
            );
          }
        }
        if (cuts.length > 0) note("cuts", cuts.join("\n"));
        expect(
          cuts,
          "no frame changes place in a single animation frame while a close lands inside an arrival",
        ).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0563-session-fold-still-picture.test.ts — the fold is a clip over a still
 * interior, and Z2 rides the edge one way.
 *
 * ## What this gates
 *
 * The fold's frame was never the problem: one property animates, and the
 * imposer's critically damped spring animates it ([D185], at0555). What the
 * reader saw moving was everything INSIDE the card. Two separate causes, and
 * this file gates the answer to both.
 *
 * The first was an anchor on the moving edge. The interior was frozen at its
 * open HEIGHT and then anchored to the slot's bottom, which is Z2's top, which
 * is the closing edge — so the whole transcript translated at the edge's speed
 * while holding its size perfectly. A test asserting height alone passed
 * throughout. The remedy is that the card is laid out ONCE at its open height,
 * by a definite pixel height the imposer publishes, and the pane's content box
 * clips it: nothing inside is anchored to anything that moves, because nothing
 * inside moves.
 *
 * The second was a second clock. The entry region's `grid-template-rows` rode
 * a CSS transition that shared a duration with the frame's spring and nothing
 * else — 69% done where the spring was 94% — so on every unfold the frame
 * finished while the composer was still growing, and the growth pushed Z2 and
 * the picture back UP. The remedy is that the transition is gone: the row is
 * `1fr` in the picture and `0fr` at rest, a cut under Z2 where nothing is
 * visible, and Z2's ride is `position: sticky; bottom: 0` — an offset the
 * browser resolves against the shrinking box, which cannot reverse because the
 * spring cannot.
 *
 * So the claims are about POSITION, which is what the reader actually sees, and
 * every one of them is read over the frames the imposer itself marks as the
 * crossing:
 *
 *   1. **No top inside the card moves.** The transcript pane's top and the
 *      composer's top are the same number on every marked frame. This is the
 *      claim the height assertion it replaces could not make: an anchored
 *      picture holds its height and translates anyway.
 *   2. **Z2's top is monotonic in the fold's direction.** Never up on a fold
 *      in, never down on an unfold, frame to frame — which is the retrograde
 *      motion stated as something a sampler can refuse rather than as a
 *      tolerance. And it travels: a Z2 that never moved would satisfy
 *      monotonicity for free.
 *   3. **The frame's edge is the thing in motion.** Its height travels the
 *      full extent between the open box and the folded tier, so claims 1 and 2
 *      are read against a real fold rather than a cut. Either claim alone could
 *      be had by breaking this one.
 *   4. **The crossing is spent and cleared.** The mark and the held height are
 *      both gone at rest in each direction. A mark left on a settled card holds
 *      the interior at a height from some earlier fold and clips the pane for
 *      good.
 *   5. **A fold is a still crossing.** The general mark every held height
 *      tween carries (`data-still-crossing`) is on for exactly the frames the
 *      fold's is, and it and its held height clear with the fold's. The pane's
 *      hold keys on the general mark, so a fold that set only its own would be
 *      a fold with nothing holding it.
 *
 * The card is bound because an unbound one renders the project picker rather
 * than the card body, and the slot, its transcript pane and the composer are
 * in the body. The transcript's own length is deliberately not staged: what is
 * under test is whether the boxes hold their PLACES, which is a fact about the
 * cascade and the imposer rather than about how much text is in it.
 *
 * `@covers` names the module that owns the mark and the held height, and the
 * stylesheet that reads them. `deck-canvas.tsx`, which detects the crossing,
 * and `session-card.tsx`, which lands the terminal state on it, are
 * deliberately NOT named: both stand at their recorded fan-out of 21, and
 * recorded debt may be paid down but never refinanced — the same reason at0555
 * leaves them out. A break in either surfaces here, through the mark.
 *
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0563-session";
const PANE_ID = "p1";
const CARD = '[data-card-id="A"]';
const CARD_ROOT = `${CARD} .session-card`;
const FRAME = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const SLOT = `${CARD} .session-view-slot`;
const TRANSCRIPT = `${SLOT} .session-view-pane[data-view="transcript"]`;
const ENTRY = `${CARD} [data-slot="session-card-entry-region"]`;
const Z2 = `${CARD} .session-card-status-bar`;

/** How long the sampler runs — a beat and a half at the default tune. */
const CENSUS_MS = 700;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** One Session card, alone in a one-up. */
function deckShape() {
  return {
    cards: [
      {
        id: "A",
        componentId: "session",
        title: "Session A",
        closable: true,
      },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 800, height: 700 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
    ],
    activePaneId: PANE_ID,
    imposition: { kind: "one-up" },
    hasFocus: true,
  };
}

interface Sample {
  t: number;
  /** The imposer's own mark, or `""` when this frame is not in a crossing. */
  mark: string;
  /** The general still-crossing mark, read the same way. */
  still: string;
  frameHeight: number;
  transcriptTop: number;
  entryTop: number;
  z2Top: number;
}

/**
 * Arm a per-frame sampler, flip the flag, and hand back what it saw.
 *
 * Installed BEFORE the dispatch and reading on `requestAnimationFrame`, so the
 * first sample is the pre-motion geometry and every frame of the motion is in
 * the record.
 *
 * Every number is a `getBoundingClientRect()` read, which is the point: a top
 * is only a claim about what the reader sees if it is measured in the
 * viewport's own coordinates, where an ancestor's translate would show up.
 */
async function census(app: App, folded: boolean): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0563 = [];
      var frameSel = ${JSON.stringify(FRAME)};
      var transcriptSel = ${JSON.stringify(TRANSCRIPT)};
      var entrySel = ${JSON.stringify(ENTRY)};
      var z2Sel = ${JSON.stringify(Z2)};
      var t0 = performance.now();
      var topOf = function (sel) {
        var el = document.querySelector(sel);
        return el === null ? -1 : el.getBoundingClientRect().top;
      };
      var tick = function () {
        var frame = document.querySelector(frameSel);
        window.__at0563.push({
          t: performance.now() - t0,
          mark:
            frame === null
              ? ""
              : frame.getAttribute("data-fold-crossing") || "",
          still:
            frame === null
              ? ""
              : frame.getAttribute("data-still-crossing") || "",
          frameHeight: frame === null ? -1 : frame.getBoundingClientRect().height,
          transcriptTop: topOf(transcriptSel),
          entryTop: topOf(entrySel),
          z2Top: topOf(z2Sel),
        });
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", { cardId: "A", folded: ${folded} }), null)`,
  );
  await wait(CENSUS_MS + 300);
  const samples = await app.evalJS<Sample[]>(`window.__at0563`);
  return samples;
}

/**
 * The frames the crossing covered, by the IMPOSER's account.
 *
 * The mark is on the frame for exactly the length of the tween that carries
 * the fold, so this is the thing that owns the motion saying which frames
 * these claims are about — rather than the test inferring the window from the
 * geometry it is judging, and rather than the card's own `data-fold`, which is
 * downstream of this mark and would fold a reading of the card's clock into a
 * claim about the imposer's.
 */
function crossingFrames(samples: Sample[]): Sample[] {
  return samples.filter((s) => s.mark !== "");
}

/** The extent a picked series covered across the frames it was sampled in. */
function spread(frames: Sample[], pick: (s: Sample) => number): number {
  if (frames.length === 0) return 0;
  const values = frames.map(pick);
  return Math.max(...values) - Math.min(...values);
}

/**
 * The largest step a picked series took AGAINST `direction`, frame to frame.
 *
 * `direction` is `-1` when the series should only ever decrease and `+1` when
 * it should only ever increase. Zero means it never went the wrong way; any
 * positive number is retrograde motion, in pixels, and the largest one is
 * reported rather than a count so a failure names how far back it went.
 *
 * Sub-pixel is not retrograde: a `getBoundingClientRect()` top on a tweening
 * ancestor lands on fractional values, and two consecutive frames can differ
 * by a rounding hair in either direction without anything having moved.
 */
function worstReversal(
  frames: Sample[],
  pick: (s: Sample) => number,
  direction: -1 | 1,
): number {
  let worst = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const step = (pick(frames[i]) - pick(frames[i - 1])) * direction;
    if (step < -0.5) worst = Math.max(worst, -step);
  }
  return worst;
}

/** Bring a bound Session card up on a fresh app. */
async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A");
}

/** The crossing's own two marks: the frame's stamp and the held height. */
async function readCrossing(
  app: App,
): Promise<{
  mark: string | null;
  held: string;
  still: string | null;
  stillHeld: string;
}> {
  return app.evalJS(
    `(function () {
      var frame = document.querySelector(${JSON.stringify(FRAME)});
      var card = document.querySelector(${JSON.stringify(CARD_ROOT)});
      return {
        mark: frame === null ? null : frame.getAttribute("data-fold-crossing"),
        held:
          card === null
            ? ""
            : getComputedStyle(card)
                .getPropertyValue("--tugx-fold-held-height")
                .trim(),
        still: frame === null ? null : frame.getAttribute("data-still-crossing"),
        stillHeld:
          card === null
            ? ""
            : getComputedStyle(card)
                .getPropertyValue("--tugx-still-held-height")
                .trim(),
      };
    })()`,
  );
}

/**
 * The four claims, in one direction.
 *
 * `direction` is the way Z2's top must travel: `-1` folding in (it rises
 * toward the masthead) and `+1` unfolding (it comes back down).
 */
function assertStillClip(
  label: string,
  samples: Sample[],
  direction: -1 | 1,
): void {
  const frames = crossingFrames(samples);
  const frameTravel = spread(frames, (s) => s.frameHeight);
  const transcript = spread(frames, (s) => s.transcriptTop);
  const entry = spread(frames, (s) => s.entryTop);
  const z2Travel = spread(frames, (s) => s.z2Top);
  const z2Back = worstReversal(frames, (s) => s.z2Top, direction);
  note(
    label,
    `frames=${frames.length} frame travel=${Math.round(frameTravel)} transcript top spread=${transcript.toFixed(2)} composer top spread=${entry.toFixed(2)} z2 travel=${Math.round(z2Travel)} z2 worst reversal=${z2Back.toFixed(2)}`,
  );
  expect(
    frames.length,
    `${label}: the crossing must be sampled mid-motion`,
  ).toBeGreaterThan(5);

  // 5. A fold is a still crossing: the general mark is on for exactly the
  //    frames the fold's is, no more and no fewer.
  expect(
    samples.filter((s) => (s.mark !== "") !== (s.still !== "")).length,
    `${label}: the still mark is on for exactly the fold's frames`,
  ).toBe(0);

  // 3, first, because 1 and 2 are only claims if there was a real fold to
  // read them over. The frame's own height is the motion.
  expect(
    frameTravel,
    `${label}: the frame's edge travels its full extent`,
  ).toBeGreaterThan(300);

  // 1. No top inside the card moves. One pixel of slack for sub-pixel layout
  //    and no more: the point is that these boxes are not laid out again at
  //    all, so anything a reader could see as a shift is a failure here.
  expect(
    transcript,
    `${label}: the transcript's top does not move`,
  ).toBeLessThan(1.5);
  expect(
    entry,
    `${label}: the composer's top does not move`,
  ).toBeLessThan(1.5);

  // 2. Z2 travels, and only one way.
  expect(z2Travel, `${label}: Z2 rides the edge`).toBeGreaterThan(300);
  expect(
    z2Back,
    `${label}: Z2's top never goes back the way it came`,
  ).toBeLessThan(0.5);
}

describe.skipIf(!SHOULD_RUN)("AT0563: the fold's still picture", () => {
  test(
    "the interior holds its place for the length of the crossing, in both directions",
    async () => {
      const app = await launchTugApp({ testName: "at0563-fold-still" });
      try {
        await openCard(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 15_000 },
        );
        // ── The fold in: Z2 rises toward the masthead ────────────────────
        assertStillClip("fold", await census(app, true), -1);

        await wait(AFTER_LAND_MS);
        const settled = await readCrossing(app);
        note("settled crossing", JSON.stringify(settled));
        expect(settled.mark, "the mark is cleared once folded").toBeNull();
        expect(settled.held, "and so is the held height").toBe("");
        expect(settled.still, "the still mark clears with it").toBeNull();
        expect(settled.stillHeld, "and its held height").toBe("");

        // ── The unfold: Z2 comes back down ──────────────────────────────
        assertStillClip("show", await census(app, false), 1);

        await wait(AFTER_LAND_MS);
        const open = await readCrossing(app);
        note("open crossing", JSON.stringify(open));
        expect(open.mark, "the mark is cleared once open").toBeNull();
        expect(open.held, "and so is the held height").toBe("");
        expect(open.still, "the still mark clears with it").toBeNull();
        expect(open.stillHeld, "and its held height").toBe("");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

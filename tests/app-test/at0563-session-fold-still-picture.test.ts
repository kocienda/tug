/**
 * at0563-session-fold-still-picture.test.ts — the transcript holds still for
 * the length of the fold.
 *
 * ## What this gates
 *
 * The fold's frame was never the problem: one property animates and Z2 rides
 * the closing edge ([D185], at0555). What the reader actually saw moving was
 * the transcript INSIDE the card. `.session-view-slot` is `flex: 1 1 0` and
 * the column's floor stands down while folded, so the slot — and the
 * `TugListView` scroller in it — shrank continuously with the frame; the
 * list's container `ResizeObserver` answered every one of those deliveries
 * with `maybePinToBottom()` and `scrollTick()`, so for a reader at the live
 * edge the text slid upward by the amount the viewport lost, every frame, for
 * the whole 400ms, in both directions.
 *
 * The remedy is a picture: the fold effect measures the slot's child before
 * paint and freezes it at that height for the length of the motion, so the
 * scrollport's size never changes and the observer never fires. The card's
 * edge sweeps over a still image.
 *
 * Two claims, on a bound Session card:
 *
 *   1. **Nothing inside moves while the edge does.** Sampling every frame
 *      through a fold and then an unfold: the slot's own height travels its
 *      full extent — the frame's motion is untouched — while the transcript
 *      pane's height does not change at all. The assertion is on the CHILD's
 *      stillness against the SLOT's travel in the same series, because
 *      either one alone could be had by breaking the other.
 *   2. **The freeze is spent and cleared.** `data-fold-freeze` and
 *      `--session-fold-slot-height` are both gone at rest in each direction.
 *      A freeze left on a settled card would pin the transcript to the height
 *      it had at some earlier fold, and a card resized afterwards would wear
 *      it until the next motion.
 *
 * The card is bound because an unbound one renders the project picker rather
 * than the card body, and the slot and its transcript pane are in the body.
 * The transcript's own length is deliberately not staged: what is under test
 * is whether the box holds its size, which is a fact about the cascade and
 * the effect rather than about how much text is in it.
 *
 * `@covers` names the stylesheet that IS the freeze. `session-card.tsx`,
 * which owns the measure-and-write, is deliberately NOT named: it stands at
 * its recorded fan-out of 21, and recorded debt may be paid down but never
 * refinanced — the same reason at0555 leaves it out. A break in the effect
 * surfaces here through the cascade it feeds, and at0551 drives the same
 * effect's output from a narrower file.
 *
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
const SLOT = `${CARD} .session-view-slot`;
const TRANSCRIPT = `${SLOT} .session-view-pane[data-view="transcript"]`;

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
  fold: string;
  slot: number;
  transcript: number;
}

/**
 * Arm a per-frame sampler, flip the flag, and hand back what it saw.
 *
 * Installed BEFORE the dispatch and reading on `requestAnimationFrame`, so
 * the first sample is the pre-motion geometry and every frame of the motion
 * is in the record. A `-1` means the element was not in the tree for that
 * frame, which on the slot happens at rest in the folded form (`display:
 * none`) and is why the claims read the moving frames rather than the tails.
 */
async function census(app: App, folded: boolean): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0563 = [];
      var slotSel = ${JSON.stringify(SLOT)};
      var transcriptSel = ${JSON.stringify(TRANSCRIPT)};
      var rootSel = ${JSON.stringify(CARD_ROOT)};
      var t0 = performance.now();
      var tick = function () {
        var slot = document.querySelector(slotSel);
        var transcript = document.querySelector(transcriptSel);
        var root = document.querySelector(rootSel);
        window.__at0563.push({
          t: performance.now() - t0,
          fold: root === null ? "" : root.getAttribute("data-fold") || "",
          slot: slot === null ? -1 : slot.getBoundingClientRect().height,
          transcript:
            transcript === null ? -1 : transcript.getBoundingClientRect().height,
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
 * The frames in which the card was mid-motion, by the card's own account.
 * `data-fold="moving"` is on the root for exactly the length of the fold in
 * either direction, so this is the card saying which frames these claims are
 * about rather than the test inferring it from the geometry it is judging.
 */
function movingFrames(samples: Sample[]): Sample[] {
  return samples.filter((s) => s.fold === "moving");
}

/** The extent a picked series covered across the frames it was sampled in. */
function spread(frames: Sample[], pick: (s: Sample) => number): number {
  if (frames.length === 0) return 0;
  const values = frames.map(pick);
  return Math.max(...values) - Math.min(...values);
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

/** The freeze's own two marks on the card root. */
async function readFreeze(
  app: App,
): Promise<{ attr: string | null; height: string }> {
  return app.evalJS(
    `(function () {
      var root = document.querySelector(${JSON.stringify(CARD_ROOT)});
      if (root === null) return { attr: null, height: "" };
      return {
        attr: root.getAttribute("data-fold-freeze"),
        height: root.style.getPropertyValue("--session-fold-slot-height"),
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0563: the fold's still picture", () => {
  test(
    "the transcript holds its height for the length of the fold, in both directions",
    async () => {
      const app = await launchTugApp({ testName: "at0563-fold-still" });
      try {
        await openCard(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 15_000 },
        );
        // ── Claim 1, the fold in ────────────────────────────────────────
        const foldFrames = movingFrames(await census(app, true));
        const foldSlot = spread(foldFrames, (s) => s.slot);
        const foldTranscript = spread(foldFrames, (s) => s.transcript);
        note(
          "fold",
          `frames=${foldFrames.length} slot spread=${Math.round(foldSlot)} transcript spread=${Math.round(foldTranscript)}`,
        );
        expect(
          foldFrames.length,
          "the fold must be sampled mid-motion",
        ).toBeGreaterThan(5);
        expect(
          foldSlot,
          "the fold: the slot's own height still travels",
        ).toBeGreaterThan(100);
        // One pixel of slack for sub-pixel layout, and no more: the point of
        // the freeze is that the box is not resized at all, so anything a
        // `ResizeObserver` would call a delivery is a failure here.
        expect(
          foldTranscript,
          "the fold: the transcript does not move",
        ).toBeLessThan(1.5);

        await wait(AFTER_LAND_MS);
        const settled = await readFreeze(app);
        note("settled freeze", JSON.stringify(settled));
        expect(settled.attr, "the freeze is cleared once folded").toBeNull();
        expect(settled.height, "and so is its height").toBe("");

        // ── Claim 1, the unfold ─────────────────────────────────────────
        const showFrames = movingFrames(await census(app, false));
        const showSlot = spread(showFrames, (s) => s.slot);
        const showTranscript = spread(showFrames, (s) => s.transcript);
        note(
          "show",
          `frames=${showFrames.length} slot spread=${Math.round(showSlot)} transcript spread=${Math.round(showTranscript)}`,
        );
        expect(
          showFrames.length,
          "the unfold must be sampled mid-motion",
        ).toBeGreaterThan(5);
        expect(
          showSlot,
          "the unfold: the slot's own height still travels",
        ).toBeGreaterThan(100);
        expect(
          showTranscript,
          "the unfold: the transcript does not move",
        ).toBeLessThan(1.5);

        await wait(AFTER_LAND_MS);
        const open = await readFreeze(app);
        note("open freeze", JSON.stringify(open));
        expect(open.attr, "the freeze is cleared once open").toBeNull();
        expect(open.height, "and so is its height").toBe("");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

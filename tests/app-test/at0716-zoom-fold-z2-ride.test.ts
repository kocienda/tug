/**
 * at0716-zoom-fold-z2-ride.test.ts — under View › Zoom a Session card's fold
 * carries Z2 on the clip's closing edge, with no pop at either end.
 *
 * | Test                   | What would break without it                       |
 * |------------------------|---------------------------------------------------|
 * | Z2 rides the edge at   | Z2's fold ride was `position: sticky` against the |
 * | 0.8 and 0.5, fold and  | pane's content box. Inside the deck root's        |
 * | unfold                 | `transform: scale(f)` WebKit takes the            |
 * |                        | scrollport's edge as its height × f, so on the    |
 * |                        | first crossing frame Z2 jumped up by a third of   |
 * |                        | the card with the edge still where it was, then   |
 * |                        | trailed above it the whole way; the unfold was    |
 * |                        | the mirror, with a drop at the land               |
 *
 * The edge is the clip's bottom (`.tug-pane-content`), and Z2's rest bottom is
 * where it stands with the card open at the same factor. On every frame the
 * imposer marks as the crossing, Z2's bottom is the lesser of the two: it holds
 * its place until the closing edge reaches it, then rides the edge. And across
 * every consecutive pair of frames — the ones on either side of the crossing
 * included, which is where a pop lands — Z2 moves no further than the edge
 * did. The second claim is the one a pop cannot pass: the edge has not moved
 * on the first frame of a fold, so neither may Z2.
 *
 * 1.0 runs as the control. It is the factor at which the ride was always
 * right, so a red there is the assertion's fault rather than the zoom's.
 *
 * The fixture is at0715's, the shape the readings that found this came from:
 * an imposed four-up, a Session card in slot 0 with a transcript long enough
 * to scroll and a hello card beside it. Every number is a
 * `getBoundingClientRect()` read in viewport px, because what the reader sees
 * is the scaled picture.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/fold.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/cards/use-z2-seat-hold.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "at0716-A";
const TURNS = 40;

/** The control first, then the two factors the brief names. */
const FACTORS = [1, 0.8, 0.5];

const FRAME = '.tug-pane[data-pane-id="p1"]';
const CLIP = `${FRAME} .tug-pane-content`;
const Z2 = '[data-card-id="A"] [data-slot="session-card-status-bar"]';

/** Viewport-px slack: a rounding at each of the two edges compared. */
const SLACK_PX = 1.5;
/** How long the sampler runs — a beat and a half at the default tune. */
const CENSUS_MS = 700;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 675, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "hello", title: "B", closable: true },
    ],
    panes: [pane("p1", 0, "A"), pane("p2", 1, "B")],
    activePaneId: "p1",
    imposition: { kind: "four-up", layout: "flow" },
    hasFocus: true,
  };
}

async function standUp(): Promise<App> {
  const app = await launchTugApp({ testName: "at0716-zoom-fold-z2-ride" });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  for (let i = 0; i < TURNS; i++) {
    const msgId = `${SID}-m${i}`;
    await app.driveSession("A", { op: "send", text: `prompt ${i}\nline two\nline three` });
    await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${i}` });
    await frame({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
    await frame({
      type: "assistant_text",
      msg_id: msgId,
      block_index: 0,
      text: `reply ${i}\n\nmore text here\n\nand more`,
      is_partial: false,
    });
    await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
  }
  await app.waitForCondition<boolean>(
    `document.querySelector('${Z2} [data-slot="tug-status-cell"]') !== null`,
    { timeoutMs: 20_000 },
  );
  return app;
}

interface Sample {
  t: number;
  /** The imposer's own mark, or `""` when this frame is not in a crossing. */
  mark: string;
  clipBottom: number;
  z2Bottom: number;
}

/** Z2's bottom with the card open and still, at the current factor. */
function restBottom(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector(${JSON.stringify(Z2)}).getBoundingClientRect().bottom`,
  );
}

/**
 * Arm a per-frame sampler, flip the fold, and hand back what it saw.
 *
 * Installed BEFORE the dispatch and reading on `requestAnimationFrame`, so the
 * first samples are the pre-motion geometry and the frames after the land are
 * in the record too: a pop at either end is a step between two samples.
 */
async function census(app: App, folded: boolean): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0716 = [];
      var frameSel = ${JSON.stringify(FRAME)};
      var clipSel = ${JSON.stringify(CLIP)};
      var z2Sel = ${JSON.stringify(Z2)};
      var t0 = performance.now();
      var bottomOf = function (sel) {
        var el = document.querySelector(sel);
        return el === null ? -1 : el.getBoundingClientRect().bottom;
      };
      var tick = function () {
        var frame = document.querySelector(frameSel);
        window.__at0716.push({
          t: performance.now() - t0,
          mark:
            frame === null
              ? ""
              : frame.getAttribute("data-fold-crossing") || "",
          clipBottom: bottomOf(clipSel),
          z2Bottom: bottomOf(z2Sel),
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
  return app.evalJS<Sample[]>(`window.__at0716`);
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** The two claims, over one direction's census. */
function assertRide(label: string, samples: Sample[], rest: number): void {
  const crossing = samples.filter((s) => s.mark !== "");

  // Z2 is where the ride puts it: its rest bottom until the edge reaches it,
  // the edge after.
  let worstGap = 0;
  let worstGapAt = -1;
  for (const s of crossing) {
    const gap = Math.abs(s.z2Bottom - Math.min(rest, s.clipBottom));
    if (gap > worstGap) {
      worstGap = gap;
      worstGapAt = s.t;
    }
  }

  // Z2 never outruns the edge, frame to frame, across the whole census.
  let worstExcess = 0;
  let worstExcessAt = -1;
  for (let i = 1; i < samples.length; i += 1) {
    const z2Step = Math.abs(samples[i].z2Bottom - samples[i - 1].z2Bottom);
    const edgeStep = Math.abs(samples[i].clipBottom - samples[i - 1].clipBottom);
    const excess = z2Step - edgeStep;
    if (excess > worstExcess) {
      worstExcess = excess;
      worstExcessAt = samples[i].t;
    }
  }

  const edgeTravel =
    crossing.length === 0
      ? 0
      : Math.max(...crossing.map((s) => s.clipBottom)) -
        Math.min(...crossing.map((s) => s.clipBottom));
  note(
    label,
    `frames=${crossing.length} rest=${r1(rest)} edge travel=${r1(edgeTravel)} ` +
      `worst gap=${r1(worstGap)} at ${Math.round(worstGapAt)} ms ` +
      `worst step past the edge=${r1(worstExcess)} at ${Math.round(worstExcessAt)} ms ` +
      `z2=[${samples.map((s) => r1(s.z2Bottom)).join(" ")}] ` +
      `edge=[${samples.map((s) => r1(s.clipBottom)).join(" ")}]`,
  );

  expect(crossing.length, `${label}: the crossing is sampled mid-motion`).toBeGreaterThan(5);
  expect(edgeTravel, `${label}: the edge travels`).toBeGreaterThan(100);
  expect(worstGap, `${label}: Z2's bottom is min(rest, edge) on every crossing frame`).toBeLessThanOrEqual(
    SLACK_PX,
  );
  expect(worstExcess, `${label}: Z2 never moves further than the edge between frames`).toBeLessThanOrEqual(
    SLACK_PX,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0716: Z2 rides the fold's closing edge under View › Zoom", () => {
  test(
    "at 1.0, 0.8 and 0.5, folding and unfolding, Z2 holds until the edge reaches it and then rides it",
    async () => {
      const app = await standUp();
      try {
        for (const f of FACTORS) {
          expect(await app.setPageZoom(f)).toBeCloseTo(f, 5);
          await wait(AFTER_LAND_MS);
          const rest = await restBottom(app);
          assertRide(`fold at ${f}`, await census(app, true), rest);
          await wait(AFTER_LAND_MS);
          assertRide(`unfold at ${f}`, await census(app, false), rest);
          await wait(AFTER_LAND_MS);
        }
      } finally {
        await app.setPageZoom(1);
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

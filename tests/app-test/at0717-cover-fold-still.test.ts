/**
 * at0717-cover-fold-still.test.ts — folding a card under its Compacting cover
 * leaves the panel still until the cover's own exit lowers it.
 *
 * | Test                   | What would break without it                       |
 * |------------------------|---------------------------------------------------|
 * | The panel holds its    | The sheet clip's `bottom` is an inset from the    |
 * | height and place       | pane frame's bottom, so when the frame's height   |
 * | through the fold, at   | tweened the clip's band closed and the bottom-    |
 * | 1.0 and 0.6            | justified panel rode the closing edge up; once    |
 * |                        | the band was shorter than the panel it squeezed   |
 * |                        | it, and the content observer re-measured mid-     |
 * |                        | crossing, moving it again — a panel bouncing      |
 * |                        | through 589 → 106 → 170 → 106 → 154 on one fold   |
 *
 * The cover is raised the way an arc raises it: the wheel's `tug_notice`
 * carrying `/compact` (the at0492 recipe; no backend answers, so the run stays
 * in flight). Then the card folds through the one door the run's hold admits,
 * and a per-frame sampler reads the panel over the frames the imposer marks as
 * the crossing.
 *
 * Three claims, in viewport px where they are positions:
 *
 *   1. **The panel's height does not change.** A squeeze is a re-layout of
 *      the panel, and nothing about a fold asks for one.
 *   2. **Its top moves only by the `settle` exit.** That exit is a
 *      `translateY` from 0 to 48 layout px over the crossing's closing portion,
 *      read off the panel's computed transform on the same frame; the top must
 *      be the pre-fold top plus that translation, scaled by the zoom factor
 *      the panel's own box reports. Anything else is the panel riding the
 *      edge or being re-measured.
 *   3. **The exit runs inside the crossing.** At least half of that lowering
 *      is reached on the crossing's frames. The cover is closed from a React
 *      commit that lands partway into the fold, and an exit that started its
 *      own full duration from there lowered only after the land, with a
 *      translation of 0 on every crossing frame.
 *
 * 1.0 because the fault is not zoom's, 0.6 because the report was made under
 * zoom. The unfold between them re-raises the cover, since the cover is
 * derived from the run and the fold.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const CODE_OUTPUT_FEED = 0x40;
const SID = "at0717-session";

const FRAME = '.tug-pane[data-pane-id="p1"]';
const COMPACTION = '[data-slot="compaction-progress"]';
const PANEL = '.tug-sheet-content[data-tug-sheet-presentation="settle"]';

/** Viewport-px slack: a rounding at each of the two edges compared. */
const SLACK_PX = 1.5;
/** The `settle` exit's full lowering, in layout px (`SHEET_SETTLE_DROP_PX`). */
const SETTLE_DROP_PX = 48;
/** How long the sampler runs — past the land and the exit's unmount. */
const CENSUS_MS = 900;

const FACTORS = [1, 0.6];

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

interface Sample {
  t: number;
  /** The imposer's fold mark, or `""` when this frame is not in a crossing. */
  mark: string;
  /** `false` once the panel has unmounted. */
  present: boolean;
  top: number;
  height: number;
  /** The panel's own `translateY`, in layout px, off its computed transform. */
  ty: number;
  /** Viewport px per layout px, from the panel's own box. */
  scale: number;
}

/** Wait until the cover is up and its entrance has finished. */
async function coverAtRest(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
      var p = document.querySelector(${JSON.stringify(PANEL)});
      return p !== null && p.getAnimations().length === 0;
    })()`,
    { timeoutMs: 12_000 },
  );
  await wait(300);
}

/** Arm a per-frame sampler on the panel, fold the card, and hand back what it saw. */
async function census(app: App): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0717 = [];
      var frameSel = ${JSON.stringify(FRAME)};
      var panelSel = ${JSON.stringify(PANEL)};
      var t0 = performance.now();
      var tick = function () {
        var frame = document.querySelector(frameSel);
        var panel = document.querySelector(panelSel);
        var s = {
          t: performance.now() - t0,
          mark: frame === null ? "" : frame.getAttribute("data-fold-crossing") || "",
          present: panel !== null,
          top: -1,
          height: -1,
          ty: 0,
          scale: 1,
        };
        if (panel !== null) {
          var r = panel.getBoundingClientRect();
          s.top = r.top;
          s.height = r.height;
          s.scale = panel.offsetHeight > 0 ? r.height / panel.offsetHeight : 1;
          var m = getComputedStyle(panel).transform;
          if (m && m !== "none") s.ty = new DOMMatrixReadOnly(m).m42;
        }
        window.__at0717.push(s);
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("toggle-card-fold"), null)`,
  );
  await wait(CENSUS_MS + 300);
  return app.evalJS<Sample[]>(`window.__at0717`);
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

function assertStill(label: string, samples: Sample[]): void {
  const rest = samples[0];
  const crossing = samples.filter((s) => s.mark !== "" && s.present);

  let heightOff = 0;
  let topOff = 0;
  let topOffAt = -1;
  let lowered = 0;
  for (const s of crossing) {
    heightOff = Math.max(heightOff, Math.abs(s.height - rest.height));
    lowered = Math.max(lowered, s.ty);
    const expected = rest.top + s.ty * s.scale;
    const off = Math.abs(s.top - expected);
    if (off > topOff) {
      topOff = off;
      topOffAt = s.t;
    }
  }
  note(
    label,
    `frames=${crossing.length} rest top=${r1(rest.top)} height=${r1(rest.height)} scale=${r1(rest.scale * 100) / 100} ` +
      `worst height change=${r1(heightOff)} worst top off the exit=${r1(topOff)} at ${Math.round(topOffAt)} ms ` +
      `top=[${crossing.map((s) => r1(s.top)).join(" ")}] ` +
      `height=[${crossing.map((s) => r1(s.height)).join(" ")}] ` +
      `ty=[${crossing.map((s) => r1(s.ty)).join(" ")}]`,
  );

  expect(rest.present, `${label}: the cover is up before the fold`).toBe(true);
  expect(rest.mark, `${label}: the first sample precedes the crossing`).toBe("");
  expect(crossing.length, `${label}: the panel is sampled through the crossing`).toBeGreaterThan(5);
  expect(heightOff, `${label}: the panel's height holds`).toBeLessThanOrEqual(SLACK_PX);
  expect(topOff, `${label}: the panel's top moves only by the settle exit`).toBeLessThanOrEqual(
    SLACK_PX,
  );
  expect(
    lowered,
    `${label}: the settle exit lowers the panel over the crossing's closing portion, not after the land`,
  ).toBeGreaterThanOrEqual(SETTLE_DROP_PX / 2);
}

describe.skipIf(!SHOULD_RUN)("AT0717: the Compacting cover holds still through a fold", () => {
  test(
    "at 1.0 and 0.6 the panel keeps its height and moves only by its own exit",
    async () => {
      const app = await launchTugApp({ testName: "at0717-cover-fold-still" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        // The frame tugcast announces the wheel's prompt with (at0492).
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded: { type: "tug_notice", tug_session_id: SID, origin: "wheel", text: "/compact" },
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPACTION)}) !== null`,
          { timeoutMs: 8000 },
        );

        for (const f of FACTORS) {
          expect(await app.setPageZoom(f)).toBeCloseTo(f, 5);
          await coverAtRest(app);
          assertStill(`fold at ${f}`, await census(app));
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === true`,
            { timeoutMs: 8000 },
          );
          // The unfold re-raises the cover for the next factor.
          await app.evalJS<null>(`(window.__tug.dispatchControlAction("toggle-card-fold"), null)`);
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === false`,
            { timeoutMs: 8000 },
          );
        }
      } finally {
        await app.setPageZoom(1);
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

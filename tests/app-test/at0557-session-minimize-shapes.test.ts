/**
 * at0557-session-minimize-shapes.test.ts — the fold is one motion on a FREE
 * pane and in a stacked slot, frame included.
 *
 * ## What this gates
 *
 * at0555 gates the fold's clock on a split wall, and it passed for a release
 * in which two of the three shapes a card can stand in did not animate at all.
 * That is not a gap in its assertions; it is a gap in its fixture. The fold is
 * carried by the imposer's settle, the settle arms on a change to
 * `arrangementSignature`, and a pane's minimized state was not one of that
 * signature's terms. A split column's ALLOCATION changes when a member folds,
 * so the wall armed a settle by accident of what else moved. A free pane and a
 * card alone in a stacked slot moved nothing the signature read, so no settle
 * launched and nothing carried the frame:
 *
 *   - free, measured before the fix: the frame went 620 → 173 between 16ms and
 *     111ms — the `.tug-pane` window-shade ease ([D07], 100ms) — while the
 *     composer inside it collapsed over 412ms. A snap with a slow collapse
 *     happening inside it, under `overflow: hidden`.
 *   - stacked, measured before the fix: 1041 → 173 in ONE frame, because the
 *     imposer writes an imposed frame's height as geometry with no transition,
 *     so not even the shade ease applied.
 *
 * So this file censuses the two shapes at0555 cannot seed, and it samples the
 * FRAME rather than a neighbour: on a free pane there is no sibling to travel,
 * and the frame's own height is the subject either way — the claim is that the
 * frame and the interior it carries are one motion, not two clocks that happen
 * to overlap.
 *
 * The claims, per shape, in both directions:
 *
 *   1. **The frame travels.** Its height moves over a window, not in a frame.
 *      The band's floor is what separates a real tween from the one-frame cut
 *      the stacked slot used to take, and its ceiling from the 100ms snap the
 *      free pane used to take — both are BELOW half the declared beat, which
 *      is why the assertion is a floor on the window rather than on the travel.
 *   2. **One motion.** The frame's window and the composer's start together
 *      and end together, the same pair at0555 makes about the wall.
 *   3. **Nothing walks after the frame stops.** At the frame's last moving
 *      sample the entry region is already at its rest height — the user's own
 *      requirement, and the thing the old show got wrong by 300ms.
 *
 * `@covers` cannot name `deck-canvas.tsx`, which is where the signature term
 * lives: it stands at its recorded fan-out of 21 and recorded debt may be paid
 * down, never refinanced. It names the stylesheet that carries the frame's own
 * transition — the [D07] ease that had to stand down for the settle to own the
 * height — and the card stylesheet that declares the interior's clock.
 *
 * @covers tugdeck/styles/chrome.css
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CARD_ID = "S";
const PANE_ID = "p1";
const SID = "at0557-session";

const FRAME = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const ENTRY = `[data-card-id="${CARD_ID}"] [data-slot="session-card-entry-region"]`;

/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** How long the census samples for — a beat and a half at the default tune. */
const CENSUS_MS = 700;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * One Session card. `imposition` is what makes the two shapes differ and it is
 * the ONLY thing that does: free is no imposition and no slot, stacked is a
 * one-up with the pane in slot 0 and nothing beside it. Same card, same size,
 * same binding.
 */
function deckShape(stacked: boolean) {
  return {
    cards: [
      {
        id: CARD_ID,
        componentId: "session",
        title: "Session",
        closable: true,
      },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: [CARD_ID],
        activeCardId: CARD_ID,
        title: "",
        acceptsFamilies: ["maker"],
        ...(stacked ? { slot: 0 } : {}),
      },
    ],
    activePaneId: PANE_ID,
    ...(stacked ? { imposition: { kind: "one-up" } } : {}),
    hasFocus: true,
  };
}

interface Sample {
  t: number;
  /** The composer's own extent — the region that folds. */
  entry: number;
  /** The pane frame's height — the thing that used to cut. */
  frame: number;
}

/**
 * Arm a per-frame sampler, flip the flag, and hand back what it saw. Installed
 * BEFORE the dispatch and reading on `requestAnimationFrame`, so the first
 * sample is the pre-fold geometry and every frame of the motion is in the
 * record.
 */
async function census(app: App, value: boolean): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0557 = [];
      var entrySel = ${JSON.stringify(ENTRY)};
      var frameSel = ${JSON.stringify(FRAME)};
      var t0 = performance.now();
      var tick = function () {
        var entry = document.querySelector(entrySel);
        var frame = document.querySelector(frameSel);
        window.__at0557.push({
          t: performance.now() - t0,
          entry: entry === null ? -1 : entry.getBoundingClientRect().height,
          frame: frame === null ? -1 : frame.getBoundingClientRect().height,
        });
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-minimized", { cardId: ${JSON.stringify(CARD_ID)}, minimized: ${value} }), null)`,
  );
  await wait(CENSUS_MS + 300);
  return app.evalJS<Sample[]>(`window.__at0557`);
}

/**
 * The window a sampled series moved in: first frame that left its start, last
 * frame that changed at all. `null` when nothing moved — which is what a cut
 * in one frame reads as when the sampler never catches an intermediate value,
 * and is why claim 1 asserts on the window's width.
 */
function windowOf(
  samples: Sample[],
  pick: (s: Sample) => number,
): { start: number; end: number; travel: number } | null {
  if (samples.length < 3) return null;
  const start0 = pick(samples[0]);
  const moved = (v: number): boolean => Math.abs(v - start0) > 1;
  let start = -1;
  let end = -1;
  for (let i = 1; i < samples.length; i += 1) {
    if (start < 0 && moved(pick(samples[i]))) start = samples[i].t;
    if (Math.abs(pick(samples[i]) - pick(samples[i - 1])) > 0.5) {
      end = samples[i].t;
    }
  }
  if (start < 0 || end < 0) return null;
  return {
    start,
    end,
    travel: Math.abs(pick(samples[samples.length - 1]) - start0),
  };
}

/** The entry region's height at the frame's last moving sample ([B02]). */
function entryAtFrameStop(samples: Sample[]): { entry: number; rest: number } {
  const last = samples[samples.length - 1];
  let stopIndex = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (Math.abs(samples[i].frame - samples[i - 1].frame) > 0.5) stopIndex = i;
  }
  return { entry: samples[stopIndex].entry, rest: last.entry };
}

/** The declared clock both halves are supposed to read. */
async function declaredClock(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var entry = document.querySelector(${JSON.stringify(ENTRY)});
      var declared = getComputedStyle(entry).transitionDuration.split(",")[0].trim();
      return declared.endsWith("ms")
        ? parseFloat(declared)
        : parseFloat(declared) * 1000;
    })()`,
  );
}

function assertOneMotion(
  label: string,
  samples: Sample[],
  beatMs: number,
): void {
  const frame = windowOf(samples, (s) => s.frame);
  const entry = windowOf(samples, (s) => s.entry);
  note(
    label,
    `frame=${JSON.stringify(frame)} entry=${JSON.stringify(entry)}`,
  );
  expect(frame, `${label}: the frame travels`).not.toBeNull();
  expect(entry, `${label}: the composer travels`).not.toBeNull();
  if (frame === null || entry === null) return;

  // 1. A window, not a cut and not the 100ms shade ease. Half the declared
  //    beat is comfortably above both of the shapes this replaces (one frame,
  //    and ~95ms) and comfortably below the beat itself.
  expect(
    frame.end - frame.start,
    `${label}: the frame's height travels over a window`,
  ).toBeGreaterThan(0.5 * beatMs);
  expect(
    frame.end - frame.start,
    `${label}: the frame does not outrun its declared beat`,
  ).toBeLessThan(1.35 * beatMs);

  // 2. One motion: together at both ends. The same bands at0555 uses on the
  //    wall — 80ms at the start, an eased tail at the end, which a sampler
  //    reads early by construction because the last frames are sub-pixel.
  expect(
    Math.abs(frame.start - entry.start),
    `${label}: the frame and the composer start together`,
  ).toBeLessThan(80);
  expect(
    Math.abs(frame.end - entry.end),
    `${label}: the frame and the composer end together`,
  ).toBeLessThan(0.35 * beatMs);

  // 3. Nothing walks after the frame stops ([B02]).
  const { entry: atStop, rest } = entryAtFrameStop(samples);
  note(`${label} at the frame's stop`, `entry=${Math.round(atStop)} rest=${Math.round(rest)}`);
  expect(
    Math.abs(atStop - rest),
    `${label}: the composer is at rest height when the frame stops`,
  ).toBeLessThan(8);
}

async function runShape(app: App, stacked: boolean): Promise<void> {
  const label = stacked ? "stacked" : "free";
  await app.seedDeckState({ state: deckShape(stacked), focusCardId: CARD_ID });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD_ID)})`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession(CARD_ID, { tugSessionId: `${SID}-${label}` });
  await app.awaitEngineReady(CARD_ID);
  await wait(AFTER_LAND_MS);

  const beatMs = await declaredClock(app);
  note(`${label} clock`, `${beatMs}ms`);

  assertOneMotion(`${label} minimize`, await census(app, true), beatMs);
  await wait(AFTER_LAND_MS);
  assertOneMotion(`${label} show`, await census(app, false), beatMs);
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)("AT0557: the fold on every shape", () => {
  test(
    "a free pane and a stacked slot fold on the settle's clock, frame included",
    async () => {
      const app = await launchTugApp({ testName: "at0557-minimize-shapes" });
      try {
        await app.enableDeckTrace(true);
        await runShape(app, false);
        await runShape(app, true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

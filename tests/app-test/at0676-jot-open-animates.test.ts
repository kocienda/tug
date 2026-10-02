/**
 * at0676-jot-open-animates.test.ts — opening a jot is a visible slide, frame
 * by frame, the way closing one is.
 *
 * A rAF recorder is armed BEFORE the Return that opens the jot, so the frames
 * the open costs up front (the React commit, the CM6 mount, the focus claim)
 * are on the record rather than hidden behind a clock that starts late. Each
 * frame notes how much of the well is VISIBLE — its box clipped to the card's
 * scrollport, since a jot taller than the card slides only as far as the card
 * can show and releases the rest out of sight. The open passes when the well is seen at
 * several distinct in-between heights, no gap between the frames it moves in
 * swallows the slide, and it arrives at its final height rather than jumping
 * the last stretch.
 *
 * The mount's own expensive frame is allowed — the well is held shut through
 * it, so nothing is moving while it is paid. What is not allowed is the slide
 * running through it: that is what made the open read as a snap.
 *
 * Runs against an isolated jots file (`TUG_JOTS_PATH`) so the user's
 * machine-global jots.json is never touched.
 *
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/components/jots/jots-card.css
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const EDITOR = `.jots-list .jot-editor`;
const TARGET = "s6";
const TARGET_ROW = `[data-jot-id="${TARGET}"]`;

function priorCardDeck() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

interface Frame {
  t: number;
  h: number;
}

async function withJots(
  testName: string,
  targetText: string,
  run: (app: App) => Promise<void>,
): Promise<void> {
  const tugbankPath = mkTempTugbank();
  const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0676-"));
  const jotsPath = join(jotsDir, "jots.json");
  const jots = Array.from({ length: 12 }, (_, k) => ({
    id: `s${k + 1}`,
    text: `s${k + 1}` === TARGET ? targetText : `Jot number ${k + 1}`,
  }));
  writeFileSync(jotsPath, `${JSON.stringify({ version: 1, jots }, null, 2)}\n`);
  try {
    seedTugbankForLaunch(tugbankPath);
    const app = await launchTugApp({
      testName,
      env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
      persistInTestMode: true,
    });
    try {
      await run(app);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(jotsDir, { recursive: true, force: true });
    rmTempTugbank(tugbankPath);
  }
}

/** Open the Jots card, wait out its slide-in, and select the target row. */
async function selectTarget(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 5_000 },
  );
  await app.dispatchControlAction("toggle-jots");
  await app.waitForCondition<boolean>(
    `(() => {
       const c = document.querySelector('.jots-card');
       if (c === null || document.querySelector('${TARGET_ROW}') === null) return false;
       const box = c.getBoundingClientRect();
       const x = Math.round(box.left);
       const settled = window.__jotsCardX === x && box.right <= window.innerWidth;
       window.__jotsCardX = x;
       return settled;
     })()`,
    { timeoutMs: 5_000 },
  );
  await app.nativeClickAtElement(`${TARGET_ROW} .jot-row-label`);
  await app.waitForCondition<boolean>(
    `document.querySelector('.jots-card .jots-list[data-key-view-kbd]') !== null`,
    { timeoutMs: 3_000 },
  );
}

/** Arm the recorder, press Return, and hand back every frame of the open. */
async function recordOpen(app: App): Promise<Frame[]> {
  await app.evalJS(
    `(() => {
       const frames = [];
       window.__at0676Frames = frames;
       let settled = 0;
       let last = -2;
       const tick = (t) => {
         const w = document.querySelector('.jot-editor-well');
         const c = document.querySelector('.jots-card');
         let h = -1;
         if (w !== null && c !== null) {
           const r = w.getBoundingClientRect();
           const portTop = c.getBoundingClientRect().top + c.clientTop;
           const portBottom = portTop + c.clientHeight;
           const seen = Math.min(r.bottom, portBottom) - Math.max(r.top, portTop);
           h = Math.round(Math.max(0, seen) * 10) / 10;
         }
         frames.push({ t: Math.round(t * 10) / 10, h });
         settled = h > 0 && h === last ? settled + 1 : 0;
         last = h;
         if (settled < 20 && frames.length < 600) requestAnimationFrame(tick);
       };
       requestAnimationFrame(tick);
       return 1;
     })()`,
  );
  await app.nativeKey("Return");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
    { timeoutMs: 3_000 },
  );
  await new Promise((r) => setTimeout(r, 1_200));
  return app.evalJS<Frame[]>(`window.__at0676Frames`);
}

/** What the record says about the open: the heights it passed through and
 *  the longest gap between frames once the well began to move. */
function readOpen(frames: Frame[]): {
  finalH: number;
  between: number[];
  worstGapMs: number;
  lastStep: number;
} {
  const finalH = frames[frames.length - 1].h;
  // From the last frame the well stood shut — the slide's own first frame.
  let shut = 0;
  frames.forEach((f, i) => {
    if (f.h === 0) shut = i;
  });
  const open = frames.slice(shut);
  const between = [
    ...new Set(open.map((f) => f.h).filter((h) => h > 0.5 && h < finalH - 0.5)),
  ];
  let worstGapMs = 0;
  let lastStep = 0;
  for (let i = 1; i < open.length; i += 1) {
    worstGapMs = Math.max(worstGapMs, open[i].t - open[i - 1].t);
    const step = open[i].h - open[i - 1].h;
    if (step > 0) lastStep = step;
  }
  return { finalH, between, worstGapMs, lastStep };
}

describe.skipIf(!SHOULD_RUN)("at0676 — opening a jot animates", () => {
  for (const [label, text] of [
    ["a short jot", "A short jot\nsecond line\nthird line"],
    [
      "a tall jot",
      `A tall jot\n${Array.from({ length: 120 }, (_, k) => `body line ${k}`).join("\n")}`,
    ],
  ] as const) {
    test(
      `${label} slides open over several frames`,
      async () => {
        await withJots(`at0676-${label.replace(/ /g, "-")}`, text, async (app) => {
          await selectTarget(app);
          const frames = await recordOpen(app);
          const { finalH, between, worstGapMs, lastStep } = readOpen(frames);
          note(
            `at0676 ${label}: final ${finalH}px, ${between.length} in-between ` +
              `height(s) [${between.join(", ")}], worst frame gap ${worstGapMs}ms, ` +
              `last step ${lastStep}px`,
          );
          note(`at0676 ${label} frames: ${JSON.stringify(frames.slice(0, 40))}`);
          expect(finalH).toBeGreaterThan(0);
          expect(between.length).toBeGreaterThanOrEqual(5);
          expect(worstGapMs).toBeLessThan(50);
          // Landing, not jumping: the slide aims at the settled height, so its
          // last step is a sliver of the whole.
          expect(lastStep).toBeLessThan(finalH * 0.05);
        });
      },
      TEST_TIMEOUT_MS,
    );
  }
});

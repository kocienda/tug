/**
 * retarget-crossings-fixture.ts — the deck, the interrupted fold and the
 * crossing check the at0689 files share.
 *
 * `standUp` launches the eight-card column deck, turns the trace on, goes
 * home, splits slot 0 and reads where each direction lands off one clean fold
 * and unfold. `foldInterrupted` dispatches the fold and, from inside a frame
 * sampler, runs the interrupting act on the first frame the crossing stands a
 * third of the way through its travel; `expectEnded` asserts it was caught
 * mid-motion and that no crossing stands once the deck is quiet.
 *
 * Split out of `at0689-retarget-ends-crossings.test.ts` when that file was cut
 * into `at0689-retarget-ends-crossings-stack-fold`, `-stack-unfold`, `-sweep` and `-unmount` to keep
 * each under the 20 s budget.
 */

import { expect } from "bun:test";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  FOLD_CARD_ID,
  FOLD_PANE_ID,
  columnBlob,
  home,
  launch,
  traceWithSettleFrames,
  wait,
} from "./settle-frames-fixture";

export const FRAME = `[data-space-layer][data-space-shown] .tug-pane[data-pane-id="${FOLD_PANE_ID}"]`;
/** How long the sampler runs after the fold's dispatch: the fold, the gesture that interrupts it, and room after. */
export const SAMPLE_MS = 2_000;
/** The sweep leg's: the sweep is a wedge guard at twice the settle's window, floored at a second, behind the paused fold. */
export const SWEEP_SAMPLE_MS = 3_500;

/** What interrupts the fold, planted on the sampler's trigger frame. */
export const STACK_JS = `window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "stack" })`;
export const TEARDOWN_JS = `window.__tug.tearDownSettle()`;

/** The frame's laid-out height, unrounded. */
export const frameHeight = (app: App): Promise<number> =>
  app.evalJS<number>(
    `document.querySelector(${JSON.stringify(FRAME)}).getBoundingClientRect().height`,
  );

export const dispatch = (app: App, action: string, payload: Record<string, unknown>): Promise<null> =>
  app.evalJS<null>(
    `(window.__tug.dispatchControlAction(${JSON.stringify(action)}, ${JSON.stringify(payload)}), null)`,
  );

export const columnMode = (app: App, mode: "split" | "stack"): Promise<null> =>
  dispatch(app, "set-column-mode", { slot: 0, mode });

export interface Sample {
  t: number;
  height: number;
  fold: boolean;
  still: boolean;
  held: boolean;
}

export interface Reading {
  samples: Sample[];
  /** When the stack was dispatched, or `null` when the fold was never caught mid-travel. */
  triggeredAt: number | null;
  /** The frame's height when it was. */
  triggeredHeight: number | null;
}

/**
 * Dispatch the fold, and from inside the frame sampler run `act` on the first
 * frame the crossing stands with a third of the travel from `from` to `to`
 * covered.
 */
export async function foldInterrupted(
  app: App,
  folded: boolean,
  from: number,
  to: number,
  act: string = STACK_JS,
  sampleMs: number = SAMPLE_MS,
): Promise<Reading> {
  const third = Math.abs(to - from) / 3;
  // The frame, its crossing marks and the hold's targets under its card host
  // are the shell's own.
  // card-dom: shell
  await app.evalJS<null>(
    `(function () {
      var rec = (window.__at0685 = { samples: [], triggeredAt: null, triggeredHeight: null });
      var t0 = performance.now();
      var heldOn = function (frame) {
        var box = frame.querySelector(".tug-pane-content");
        if (box === null) return false;
        var roots = box.querySelectorAll("[data-card-host] > *");
        for (var i = 0; i < roots.length; i += 1) {
          var s = roots[i].style;
          if (s.getPropertyValue("--tugx-fold-held-height") !== "" ||
              s.getPropertyValue("--tugx-still-held-height") !== "") return true;
        }
        return false;
      };
      var tick = function () {
        var t = performance.now() - t0;
        var frame = document.querySelector(${JSON.stringify(FRAME)});
        if (frame !== null) {
          var height = frame.getBoundingClientRect().height;
          var fold = frame.hasAttribute("data-fold-crossing");
          var still = frame.hasAttribute("data-still-crossing");
          rec.samples.push({ t: t, height: height, fold: fold, still: still, held: heldOn(frame) });
          if (rec.triggeredAt === null && fold && Math.abs(height - ${from}) >= ${third}) {
            rec.triggeredAt = t;
            rec.triggeredHeight = height;
            ${act};
          }
        }
        if (t < ${sampleMs}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(FOLD_CARD_ID)}, folded: ${folded} });
      return null;
    })()`,
  );
  await wait(sampleMs + 300);
  return app.evalJS<Reading>(`window.__at0685`);
}

export function expectEnded(label: string, r: Reading): void {
  const marked = r.samples.filter((s) => s.fold);
  const last = r.samples[r.samples.length - 1];
  // The first sample of the run of marked samples the reading ends on.
  let standing = r.samples.length;
  while (
    standing > 0 &&
    (r.samples[standing - 1].fold || r.samples[standing - 1].still || r.samples[standing - 1].held)
  ) {
    standing -= 1;
  }
  note(
    label,
    `samples=${r.samples.length} marked=${marked.length} ` +
      `stacked=${r.triggeredAt === null ? "never" : `${Math.round(r.triggeredAt)}ms at ${r.triggeredHeight?.toFixed(1)}px`} ` +
      `last: fold=${last?.fold} still=${last?.still} held=${last?.held} ` +
      `standing from=${standing < r.samples.length ? `${Math.round(r.samples[standing].t)}ms` : "—"}`,
  );
  // The trigger fires only on a sample carrying the fold's mark a third of the
  // way through its travel, so a non-null one is the proof the crossing was
  // caught mid-motion.
  expect(
    r.triggeredAt,
    `${label}: the stack landed mid-fold, with the crossing standing`,
  ).not.toBeNull();
  expect(
    { fold: last.fold, still: last.still, held: last.held },
    `${label}: once the stack has landed, no crossing stands on the frame`,
  ).toEqual({ fold: false, still: false, held: false });
}

/**
 * Wait for a gesture on the fold frame to have landed: `ready` — an
 * expression over the frame's height `h` that is true only once the gesture
 * has moved it — and the deck quiet, with no settle window open
 * (`[data-imposer-settling]`) and no crossing on the frame. This replaces a
 * fixed 900 ms land where the destination is known; the
 * predicate on `h` is what keeps it from reading the quiet before the settle
 * has armed.
 */
export async function landed(app: App, ready: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
      var f = document.querySelector(${JSON.stringify(FRAME)});
      if (f === null) return false;
      if (document.querySelector("[data-imposer-settling]") !== null) return false;
      if (f.hasAttribute("data-fold-crossing") || f.hasAttribute("data-still-crossing")) return false;
      var h = f.getBoundingClientRect().height;
      return ${ready};
    })()`,
    { timeoutMs: 5_000 },
  );
}

export interface StoodUp {
  app: App;
  tugbankPath: string;
  /** The frame's height open, read off one clean unfold. */
  open: number;
  /** The frame's height folded, read off one clean fold. */
  folded: number;
}

/**
 * Launch the column deck, turn the trace on (the release rows the exit legs
 * read are the deck trace's), go home, split slot 0, and read where each
 * direction lands off one clean fold and unfold. The card is left open and
 * the column split.
 */
export async function standUp(testName: string): Promise<StoodUp> {
  const { app, tugbankPath } = await launch(8, columnBlob(), testName);
  try {
    await traceWithSettleFrames(app);
    await home(app);
    const stacked = await frameHeight(app);
    await columnMode(app, "split");
    await landed(app, `h < ${stacked} - 1`);
    const open = await frameHeight(app);
    await dispatch(app, "set-card-folded", { cardId: FOLD_CARD_ID, folded: true });
    await landed(app, `h < ${open} - 1`);
    const folded = await frameHeight(app);
    await dispatch(app, "set-card-folded", { cardId: FOLD_CARD_ID, folded: false });
    await landed(app, `h > ${folded} + 1`);
    note("heights", `open=${open} folded=${folded}`);
    return { app, tugbankPath, open, folded };
  } catch (e) {
    await app.close();
    rmTempTugbank(tugbankPath);
    throw e;
  }
}

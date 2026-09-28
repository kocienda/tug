/**
 * at0640 — a workspace switch is a cut, and the epoch closes on its own rule.
 *
 * `at0620` recorded the switch as it was, with the cover held and dissolved;
 * this is the same gesture with the cover gone ([B01]). The two are not
 * redundant: at0620 is the movement record — what moved, when, and how late —
 * and this is the CUT's own claim, which is a set of absences. An absence needs
 * its own test because nothing else fails when one of them quietly returns.
 *
 * ## What a cut has to be, stated as what is never seen
 *
 * Five things, and every one of them is sampled rather than reasoned about:
 *
 *  1. **No element ever carries the crossing attribute.** The retired third
 *     layer state, the frozen picture and the z tier above the canvas all hung
 *     off it, so one sample of it anywhere is the whole apparatus coming back.
 *  2. **The arriving layer is opaque from the first sample after the swap, and
 *     at every sample after that.** A cut has no fade on either side. Read as a
 *     computed opacity on the wrapper, because the wrapper is what the dissolve
 *     used to tween, and the arriving one was never the side that moved.
 *  3. **No pane frame under the shown layer is held at an inline `opacity: 0`.**
 *     That hold is the settle's arrive beat, and a switch must not mint one —
 *     the panes did not arrive, the workspace did.
 *  4. **The departing layer paints nothing from the swap onward.** A hidden
 *     layer keeps its layout now ([B02]) — its frames have real boxes — so the
 *     reading is `checkVisibility()`, which is false for a subtree hidden by
 *     `visibility` or by `content-visibility` alike. This is what says the
 *     departing workspace is GONE rather than merely transparent.
 *  5. **`data-space-switching` is present immediately after the swap and gone
 *     inside the bound plus its margin.** The epoch outlived the cover ([B05],
 *     [P05]), and it has to both stand and stand down: present is what makes
 *     late geometry silent, absent is [L32]'s debt paid.
 *
 * And one more that is a different shape — a switch INTERRUPTED by a second
 * switch leaves no mark and no inline residue. That is the case where the old
 * effect's unconditional entry teardown and its re-assertion could disagree,
 * and the case a generation counter exists for.
 *
 * ## `epochReason` is noted, never asserted
 *
 * The settled path's frame counter rides `requestAnimationFrame`, and a covered
 * harness window suspends rAF — so a test asserting `"settled"` is red on a busy
 * desktop for a reason that is the window manager rather than the product. The
 * rule's own proof is the unit suite over `spaceEpochClosed`, where no window is
 * involved. Here the reason is reported and the BOUND is what is held to.
 *
 * ## Why `setInterval` and not `requestAnimationFrame`
 *
 * The same reason at0620 gives and the retired at0592 gave before it: a covered
 * window suspends rAF, and a sampler that never ran would report a perfectly
 * still switch whatever happened. A timer keeps sampling under occlusion, and
 * the sample count is asserted so a run that did not sample cannot read as a
 * run that found nothing.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tugdeck/src/lib/space-settled.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SPACE_ONE = "at0640-one";
const SPACE_TWO = "at0640-two";

const SHOWN_FRAMES =
  "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]";
const SHOWN_LAYER = "[data-space-layer][data-space-shown]";
const HIDDEN_LAYER = "[data-space-layer]:not([data-space-shown])";
/**
 * The retired third state. One sample of it anywhere is a regression.
 *
 * This file is the one place in the corpus that names the attribute on purpose,
 * and it has to: a claim that something never appears cannot be written without
 * naming the thing. The only other mention left anywhere is `at0587`'s, which is
 * a wait that is now vacuously true.
 */
const CROSSING_ANY = "[data-space-crossing]";
/** The epoch's mark, on the canvas container. */
const SWITCHING_MARK = "[data-space-switching]";

/**
 * Mirrored from `SPACE_EPOCH_BOUND_MS` in `tugdeck/src/lib/space-settled.ts`,
 * plus the margin the canvas's deadline adds.
 *
 * Mirrored rather than imported for the reason every app-test constant is: this
 * is a separate program driving the built app over a bridge, with no module
 * graph in common with the deck. The assertion states the number in its own
 * message so a forgotten update reads as a wrong number rather than as a looser
 * test.
 */
const EPOCH_BOUND_MS = 400;
const EPOCH_MARGIN_MS = 120;
/** Timer skew under load. A `setTimeout` fires no sooner than its delay. */
const EPOCH_SLOP_MS = 150;

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

interface CutReading {
  samples: number;
  rafTicks: number;
  /** Samples at which ANY element carried the crossing attribute. */
  crossingSeen: number;
  /** Samples at which the canvas carried the epoch's mark. */
  markSeen: number;
  /** First and last sample offsets at which the mark stood, in ms. */
  markFirstMs: number;
  markLastMs: number;
  /** The lowest computed opacity the SHOWN wrapper held at any sample. */
  shownLayerMinOpacity: number;
  /** The lowest computed opacity any shown pane frame held. */
  frameMinOpacity: number;
  /** Shown pane frames seen holding an inline `opacity: 0`, with the sample. */
  inlineZero: string[];
  /** Samples at which some frame under a HIDDEN layer reported itself visible. */
  hiddenPainted: number;
  /** How many shown frames the sampler ever saw. */
  frameKeys: number;
}

/**
 * Install the sampler. One `setInterval` at 16ms and one rAF counter beside it.
 *
 * The rAF counter is not a sampler — it exists only so a reading can say
 * whether frames were being served at all, which is the difference between "the
 * switch was still" and "nothing was observed".
 */
const SAMPLER_START = `(function () {
  var s = {
    t0: Date.now(),
    samples: 0,
    rafTicks: 0,
    crossingSeen: 0,
    markSeen: 0,
    markFirstMs: -1,
    markLastMs: -1,
    shownLayerMinOpacity: 2,
    frameMinOpacity: 2,
    inlineZero: [],
    hiddenPainted: 0,
    frameKeys: {},
  };
  window.__at0640 = s;
  function ms() { return Date.now() - s.t0; }

  function tickRaf() {
    s.rafTicks += 1;
    s.rafId = window.requestAnimationFrame(tickRaf);
  }
  s.rafId = window.requestAnimationFrame(tickRaf);

  s.timer = setInterval(function () {
    try {
      s.samples += 1;

      if (document.querySelector(${JSON.stringify(CROSSING_ANY)}) !== null) {
        s.crossingSeen += 1;
      }
      if (document.querySelector(${JSON.stringify(SWITCHING_MARK)}) !== null) {
        s.markSeen += 1;
        if (s.markFirstMs < 0) s.markFirstMs = ms();
        s.markLastMs = ms();
      }

      var shown = document.querySelector(${JSON.stringify(SHOWN_LAYER)});
      if (shown !== null) {
        // A \`display: contents\` wrapper still computes an opacity, and that is
        // the value the dissolve used to tween — so it is the one that says
        // whether anything faded.
        var o = parseFloat(window.getComputedStyle(shown).opacity);
        if (!isNaN(o) && o < s.shownLayerMinOpacity) s.shownLayerMinOpacity = o;
      }

      var frames = document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)});
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var id = f.getAttribute("data-pane-id") || "?";
        s.frameKeys[id] = 1;
        var fo = parseFloat(window.getComputedStyle(f).opacity);
        if (!isNaN(fo) && fo < s.frameMinOpacity) s.frameMinOpacity = fo;
        // The settle's arrive-beat hold, which a switch must never mint. Read
        // off the INLINE style rather than the computed one: a computed zero
        // could come from a stylesheet, and the hold is specifically an inline
        // write the settle owes back.
        if (f.style && f.style.opacity === "0") {
          s.inlineZero.push(id + " @" + ms() + "ms");
        }
      }

      // The departing side. A hidden layer keeps its boxes now, so the
      // question is not whether a frame has a rect but whether it is being
      // rendered: \`checkVisibility()\` is false under \`visibility: hidden\`
      // and under \`content-visibility: hidden\` alike. This is what says the
      // departing workspace is GONE rather than merely transparent, which is
      // the difference the cut makes.
      var hidden = document.querySelectorAll(${JSON.stringify(HIDDEN_LAYER)});
      var painted = false;
      for (var h = 0; h < hidden.length; h++) {
        var kids = hidden[h].querySelectorAll(".tug-pane[data-pane-id]");
        for (var k = 0; k < kids.length; k++) {
          var kid = kids[k];
          var vis = kid.checkVisibility ? kid.checkVisibility() : kid.getClientRects().length > 0;
          if (vis) { painted = true; break; }
        }
        if (painted) break;
      }
      if (painted) s.hiddenPainted += 1;
    } catch (e) {
      s.err = String(e && e.message ? e.message : e);
    }
  }, 16);
  return null;
})()`;

const SAMPLER_READ = `(function () {
  var s = window.__at0640;
  clearInterval(s.timer);
  if (s.rafId !== undefined) window.cancelAnimationFrame(s.rafId);
  var keys = 0;
  for (var k in s.frameKeys) {
    if (Object.prototype.hasOwnProperty.call(s.frameKeys, k)) keys += 1;
  }
  return {
    samples: s.samples,
    rafTicks: s.rafTicks,
    crossingSeen: s.crossingSeen,
    markSeen: s.markSeen,
    markFirstMs: s.markFirstMs,
    markLastMs: s.markLastMs,
    shownLayerMinOpacity:
      s.shownLayerMinOpacity === 2 ? -1 : s.shownLayerMinOpacity,
    frameMinOpacity: s.frameMinOpacity === 2 ? -1 : s.frameMinOpacity,
    inlineZero: s.inlineZero,
    hiddenPainted: s.hiddenPainted,
    frameKeys: keys,
  };
})()`;

/** One `space-epoch` record, as the page serializes it. */
interface EpochRecord {
  kind: string;
  toSpaceId?: string;
  epochMs?: number;
  epochReason?: string;
}

const traceRead = (mark: number): string =>
  `JSON.stringify(window.__deckTrace.since(${mark}).filter(function (e) {
     return e.kind === "space-epoch";
   }).map(function (e) {
     return { kind: e.kind, toSpaceId: e.toSpaceId, epochMs: e.epochMs, epochReason: e.epochReason };
   }))`;

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

const railPane = (id: string, cardId: string): Record<string, unknown> => ({
  id,
  position: { x: 0, y: 0 },
  size: { width: 420, height: 900 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: [] as string[],
});

const contentPane = (
  id: string,
  cardId: string,
  y: number,
): Record<string, unknown> => ({
  id,
  position: { x: 60, y },
  size: { width: 700, height: 360 },
  cardIds: [cardId],
  activeCardId: cardId,
  title: "",
  acceptsFamilies: ["standard"],
});

/**
 * Two workspaces, each with a rail and two content cards.
 *
 * Text cards rather than session cards, and that is the one place this fixture
 * is deliberately lighter than at0620's: every claim here is about absences on
 * the LAYER — a crossing attribute, a wrapper opacity, a painted frame under a
 * hidden layer — and none of them needs a composer's line box or a transcript's
 * row window to be exercised. at0620 is the file that needs the heavy cards,
 * because its claims are about the late geometry those cards produce.
 */
function twoSpaceBlob(): Record<string, unknown> {
  const deck = (
    cardsId: string,
    railId: string,
    textIds: readonly string[],
    paneBase: string,
  ): Record<string, unknown> => ({
    cards: [
      { id: cardsId, componentId: "cards", title: "Workspaces", closable: true },
      ...textIds.map((id) => ({
        id,
        componentId: "text",
        title: id,
        closable: true,
      })),
    ],
    panes: [
      railPane(railId, cardsId),
      ...textIds.map((id, i) => contentPane(`${paneBase}${i}`, id, 40 + i * 300)),
    ],
    activePaneId: `${paneBase}0`,
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  });
  return {
    version: 5,
    activeSpaceId: SPACE_ONE,
    spaces: [
      {
        id: SPACE_ONE,
        name: "One",
        deck: deck("at0640-c1", "at0640-pc1", ["at0640-t1a", "at0640-t1b"], "at0640-pa"),
      },
      {
        id: SPACE_TWO,
        name: "Two",
        deck: deck("at0640-c2", "at0640-pc2", ["at0640-t2a", "at0640-t2b"], "at0640-pb"),
      },
    ],
  };
}

/**
 * Dispatch the switch and read the mark in the SAME eval, synchronously.
 *
 * This is the authoritative "the mark stood" reading, and the sampler's
 * `markSeen` is corroboration rather than the proof. `DeckManager` writes the
 * mark inside the swap batch and before its `notify`, so the attribute is on the
 * container by the time `dispatch` returns whatever React does next — and the
 * epoch can be shorter than one 16ms sample, which it was on this fixture (28ms
 * and 44ms, so one to three samples). A claim that load-bearing should not
 * depend on a timer winning a race with a settle.
 */
const activateAndReadMark = (spaceId: string): string =>
  `(function () {
     window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} });
     return document.querySelectorAll(${JSON.stringify(SWITCHING_MARK)}).length;
   })()`;

/**
 * One switch, sampled from before the gesture to well past the epoch's bound.
 *
 * The window has to outlast the bound plus its margin, or the mark-came-off
 * reading would be asserting that a timer had not fired yet.
 */
async function recordCut(
  app: App,
  label: string,
  toSpaceId: string,
): Promise<{
  reading: CutReading;
  epoch: EpochRecord | undefined;
  markAtSwap: number;
}> {
  const mark = await app.evalJS<number>(
    `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
  );
  await app.evalJS<null>(SAMPLER_START);
  const markAtSwap = await app.evalJS<number>(activateAndReadMark(toSpaceId));
  await app.waitForCondition<boolean>(
    `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(toSpaceId)}`,
    { timeoutMs: 15_000 },
  );
  await settle(EPOCH_BOUND_MS + EPOCH_MARGIN_MS + 500);

  const reading = await app.evalJS<CutReading>(SAMPLER_READ);
  const trace = await app.evalJS<string>(traceRead(mark));
  note(`at0640 ${label}: ${JSON.stringify(reading)}`);
  const records = JSON.parse(trace) as EpochRecord[];
  const epoch = records.filter((e) => e.toSpaceId === toSpaceId).at(-1);
  note(
    `at0640 ${label} epoch: ${epoch === undefined ? "NO RECORD" : `${epoch.epochMs}ms via ${epoch.epochReason}`}`,
  );
  return { reading, epoch, markAtSwap };
}

/** Every claim a cut makes, over one sampled switch. */
function assertCut(label: string, r: CutReading): void {
  expect(
    r.samples,
    `${label}: the sampler ticked across the switch`,
  ).toBeGreaterThan(10);
  expect(
    r.frameKeys,
    `${label}: the sampler saw the shown layer's frames`,
  ).toBeGreaterThan(0);

  // (1) The retired third state, gone.
  expect(
    r.crossingSeen,
    `${label}: no element carried the crossing attribute at any of ` +
      `${r.samples} samples`,
  ).toBe(0);

  // (2) Nothing faded, on either side. The wrapper is what the dissolve tweened.
  expect(
    r.shownLayerMinOpacity,
    `${label}: the arriving layer computed full opacity at every sample`,
  ).toBe(1);
  expect(
    r.frameMinOpacity,
    `${label}: every shown pane frame computed full opacity at every sample`,
  ).toBe(1);

  // (3) No arrive-beat hold minted by a switch.
  expect(
    r.inlineZero,
    `${label}: no shown pane frame was held at an inline opacity 0`,
  ).toEqual([]);

  // (4) The departing workspace is gone, not transparent.
  expect(
    r.hiddenPainted,
    `${label}: no frame under a hidden layer reported itself visible`,
  ).toBe(0);
}

describe.skipIf(!SHOULD_RUN)(
  "at0640 — the switch is a cut, and the epoch closes on its own rule",
  () => {
    test(
      "two switches and one interrupted switch: nothing fades, nothing is covered, the mark stands and stands down",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(twoSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: "at0640-workspace-switch-cut",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 3`,
            { timeoutMs: 30_000 },
          );
          await settle(800);

          // The first switch is also what mounts the parked workspace, so the
          // second is the ordinary case: two workspaces whose cards are both
          // already standing, which is the state [B06] leaves the deck in for
          // every switch but the first.
          const toB = await recordCut(app, "A->B", SPACE_TWO);
          await settle(600);
          const backA = await recordCut(app, "B->A", SPACE_ONE);
          await settle(600);

          const ceiling = EPOCH_BOUND_MS + EPOCH_MARGIN_MS + EPOCH_SLOP_MS;
          for (const [label, run] of [
            ["A->B", toB],
            ["B->A", backA],
          ] as const) {
            assertCut(label, run.reading);

            // (5) The epoch stood, and it stood down.
            //
            // Both halves, because each alone is satisfiable by the wrong
            // thing: a mark that was never written passes "gone by now"
            // vacuously, and a mark that stands forever passes "was present".
            // The first half is the one the mark-ownership correction is about
            // — an entry sweep would have stripped it in the commit that wrote
            // it, and this reading would be zero. Read synchronously with the
            // dispatch rather than from a sample, because the epoch can close
            // inside one sample interval — see `activateAndReadMark`.
            expect(
              run.markAtSwap,
              `${label}: the mark was on the canvas the instant the swap ` +
                `committed — the reading an entry sweep would zero`,
            ).toBeGreaterThan(0);
            // Corroboration from the sampler, which is allowed to have missed a
            // sub-16ms epoch and is noted above either way.
            note(
              `at0640 ${label} mark: ${run.markAtSwap} at the swap, seen in ` +
                `${run.reading.markSeen} sample(s)`,
            );
            expect(
              run.reading.markLastMs,
              `${label}: the epoch's mark was gone inside ${ceiling}ms ` +
                `(the bound is ${EPOCH_BOUND_MS}ms plus a ${EPOCH_MARGIN_MS}ms ` +
                `deadline margin and ${EPOCH_SLOP_MS}ms of timer slop)`,
            ).toBeLessThanOrEqual(ceiling);

            // And the record agrees with the samples. `epochReason` is NOTED
            // above rather than asserted — see the file header.
            expect(
              run.epoch,
              `${label}: the epoch recorded what closed it`,
            ).toBeDefined();
            expect(
              run.epoch?.epochMs ?? Number.POSITIVE_INFINITY,
              `${label}: the recorded span is inside ${ceiling}ms ` +
                `(via ${run.epoch?.epochReason ?? "no record"})`,
            ).toBeLessThanOrEqual(ceiling);
          }

          // ---- The interrupted switch. -----------------------------------
          //
          // Two activations inside one epoch, the second before the first's
          // bound could have fired. This is the case the generation counter is
          // for: the first epoch's gate and deadline must be dropped without
          // the second epoch's mark being stripped, and when the second closes
          // the canvas must be left with no mark and no inline residue.
          const mark = await app.evalJS<number>(
            `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
          );
          await app.evalJS<null>(SAMPLER_START);
          const firstMark = await app.evalJS<number>(
            activateAndReadMark(SPACE_TWO),
          );
          await settle(80);
          const secondMark = await app.evalJS<number>(
            activateAndReadMark(SPACE_ONE),
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_ONE)}`,
            { timeoutMs: 15_000 },
          );
          await settle(EPOCH_BOUND_MS + EPOCH_MARGIN_MS + 500);
          const interrupted = await app.evalJS<CutReading>(SAMPLER_READ);
          note(`at0640 interrupted: ${JSON.stringify(interrupted)}`);
          note(
            `at0640 interrupted epochs: ${await app.evalJS<string>(traceRead(mark))}`,
          );

          assertCut("interrupted", interrupted);
          // The interruption's own claim: the second swap's mark is standing when
          // the second switch commits. If the first epoch's teardown had raced it
          // — or if either run swept on entry — this is the reading that zeroes.
          expect(
            [firstMark, secondMark],
            `interrupted: both swaps left the mark standing`,
          ).toEqual([1, 1]);
          expect(
            interrupted.markLastMs,
            `interrupted: the mark was gone inside ${ceiling}ms of the last ` +
              `sample it was seen at, rather than stranded by the first ` +
              `epoch's teardown racing the second's`,
          ).toBeLessThanOrEqual(EPOCH_BOUND_MS + EPOCH_MARGIN_MS + 500);

          // The residue check the generation counter exists for, read after
          // everything has settled rather than from a sample.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(SWITCHING_MARK)}).length`,
            ),
            `interrupted: the mark was handed back`,
          ).toBe(0);
          // Inline OPACITY only, and the narrowing is a correction rather than a
          // weakening. Inline `left`/`top` are React's own: it renders all four
          // sides of every pane out of `modeStyle`, and a rail's `left` is a
          // `calc()` chain it writes on every commit — so "no inline position"
          // was never true of this deck and says nothing about the freeze. This
          // first ran asserting it and reported three frames wearing exactly what
          // React had put there.
          //
          // Opacity is the one that discriminates, because React renders none:
          // an inline opacity on a pane frame is always some writer's debt — the
          // settle's arrive hold, or the freeze that no longer exists — and after
          // everything has settled the correct answer is that nobody owes one.
          expect(
            await app.evalJS<string[]>(
              `Array.prototype.slice.call(
                 document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)})
               ).filter(function (f) {
                 return f.style.opacity !== "";
               }).map(function (f) {
                 return f.getAttribute("data-pane-id") + " [" + f.style.opacity + "]";
               })`,
            ),
            `interrupted: no shown pane frame was left wearing an inline ` +
              `opacity — the hold's residue, which after the cut has no writer ` +
              `on the switch path at all`,
          ).toEqual([]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

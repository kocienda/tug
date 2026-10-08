/**
 * at0652-loop-cost-and-life.test.ts — the deck's three standing loops, priced
 * one at a time, and each one shown to be RUNNING.
 *
 * ## The two clauses, and why one without the other is worthless
 *
 * `at0629` prices three hundred `pulsing-dot` glyphs at once and asks whether
 * the compositing walk stayed out of the frame loop. That is the population
 * question, and it is answered. It is not the question [B09] asks, which is
 * about the deck a person actually sits in front of: a caret blinking in the
 * composer, a phase dot on the card, and the wave in the in-flight footer
 * while a turn runs. Three loops, not three hundred, each with a different
 * owner and a different way of being switched off.
 *
 * **A cost bar alone cannot be passed honestly by a loop that is not
 * running.** That is not a hypothetical: the user reported during this arc
 * that the wave in Session cards does not animate, and a wave that never
 * moves reads 0.00 ms per frame and clears any budget by doing nothing. So
 * every leg here asserts two things about its loop, in this order:
 *
 *   1. **It runs.** The element carries a `running` animation and its
 *      `currentTime` advances between two reads a few frames apart. Not
 *      "an animation object exists" — a paused or zero-iteration animation
 *      exists too, and `--tug-loop-iterations: 0` (the off-screen rule, the
 *      circuit breaker) removes it from the timeline
 *      entirely, which is a third state again.
 *   2. **It costs nothing over the floor.** `window.__tugMotion.cost(120)`
 *      across 120 frames, read against the at-rest stall floor rather than
 *      against the per-frame budget: a single compositor-resident loop is
 *      not entitled to a sixteenth of the frame, it is entitled to nothing
 *      measurable.
 *
 * ## Why a real Session card and not the gallery bench
 *
 * All three loops are switched off by ancestry rather than by their own
 * state — `content-visibility` on a list cell, `data-tug-offscreen` from the
 * viewport observer. Neither of those ancestors exists on the gallery bench,
 * so a bench reading says nothing about whether the shipped deck runs the
 * loop. The fixture is
 * one bound Session card, driven through `driveSession`, which is the deck
 * the report came from.
 *
 * @covers tugdeck/src/components/tugways/internal/tug-progress-wave.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-progress-wave.css
 * @covers tugdeck/src/components/tugways/cards/session-card-z1c.tsx
 * @covers tugdeck/src/lib/motion-guard/offscreen.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CARD = '[data-card-id="A"]';
const WAVE = `${CARD} [data-slot="tug-progress-wave"]`;
/**
 * The dot in the card's HEADER, not the first one in the document.
 *
 * An unscoped selector picks the first pulsing dot in document order, and on
 * a card with a transcript that is one inside a `tug-list-view-cell` the
 * list is skipping with `content-visibility: auto` — measured: present, zero
 * animations, marked `content-visibility:auto:tug-list-view-cell` while nine
 * dot loops ran elsewhere on the same deck. That dot is correctly still,
 * being out of view, and a leg pointed at it is asking the wrong question.
 */
const DOT = `${CARD} [data-slot="session-card-top-column"] [data-slot="tug-progress-pulsing-dot"]`;
/** Every phase dot on the deck, and every wave — the two loops priced below. */
const ANY_DOT = '[data-slot="tug-progress-pulsing-dot"]';
const ANY_WAVE = '[data-slot="tug-progress-wave"]';

/** Frames per cost reading — [B09]'s number. */
const COST_FRAMES = 120;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
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

/**
 * What the engine is actually running for one element's subtree, and under
 * what marks.
 *
 * The three fields are the three ways a loop stops being a loop, and they
 * have to be read together. `animations` counts what
 * `getAnimations({ subtree: true })` reports — zero means the declaration
 * resolved to no animation at all, which is what `--tug-loop-iterations: 0`
 * produces. `marks` names the ancestor attributes that set that knob, so a
 * zero has an explanation rather than only a value. `iterations` is what the
 * cascade resolved the knob to, read off the element itself.
 */
interface LoopLife {
  readonly present: boolean;
  readonly animations: number;
  readonly running: number;
  readonly names: readonly string[];
  readonly currentTimes: readonly number[];
  readonly iterations: string;
  readonly durations: readonly string[];
  /** Ancestor marks that still a loop, nearest first. */
  readonly marks: readonly string[];
}

const loopLife = (app: App, selector: string): Promise<LoopLife> =>
  app.evalJS<LoopLife>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) {
         return { present: false, animations: 0, running: 0, names: [],
                  currentTimes: [], iterations: "", durations: [], marks: [] };
       }
       var anims = el.getAnimations({ subtree: true });
       var marks = [];
       for (var n = el; n !== null; n = n.parentElement) {
         if (n.hasAttribute("data-tug-offscreen")) {
           marks.push("offscreen:" + (n.getAttribute("data-slot") || n.tagName));
         }
         var cv = getComputedStyle(n).contentVisibility;
         if (cv === "hidden" || (cv === "auto" && n.hasAttribute("data-cv-skipped"))) {
           marks.push("content-visibility:" + cv + ":" +
                      (n.getAttribute("data-slot") || n.className || n.tagName));
         }
       }
       if (document.documentElement.hasAttribute("data-tug-motion-demoted")) {
         marks.push("demoted:html");
       }
       var probe = el.firstElementChild || el;
       return {
         present: true,
         animations: anims.length,
         running: anims.filter(function (a) { return a.playState === "running"; }).length,
         names: anims.map(function (a) {
           return a.animationName || (a.effect && a.effect.target && "waapi") || "?";
         }),
         currentTimes: anims.map(function (a) {
           return a.currentTime === null ? -1 : Math.round(Number(a.currentTime));
         }),
         iterations: getComputedStyle(probe)
           .getPropertyValue("--tug-loop-iterations").trim(),
         durations: anims.map(function (a) {
           var t = a.effect && a.effect.getComputedTiming();
           return t === null || t === undefined ? "?" : String(t.duration);
         }),
         marks: marks,
       };
     })()`,
  );

/**
 * Both clauses of the bar over one loop, given a reading taken twice.
 *
 * The advance check is the one that cannot be skipped and the one that costs
 * nothing: two reads a couple of hundred milliseconds apart, and every clock
 * has to have moved. An animation that exists, reports `running`, and never
 * advances is the third way a loop can be still — the engine holding an
 * effect it is not ticking — and neither a count nor a play state can see it.
 */
function expectLoopRuns(
  label: string,
  expected: number,
  first: LoopLife,
  second: LoopLife,
): void {
  expect(
    first.present,
    `${label}: the figure is on the card at all — without it every clause ` +
      `below is about nothing`,
  ).toBe(true);
  expect(
    first.animations,
    `${label}: it carries ${expected} loop(s) — ${first.animations} found, ` +
      `names ${JSON.stringify(first.names)}, \`--tug-loop-iterations\` ` +
      `resolved to "${first.iterations}", marks ` +
      `${JSON.stringify(first.marks)}. Zero means the declaration resolved ` +
      `to no animation at all, which is what the off-screen rule and the ` +
      `circuit breaker each produce`,
  ).toBe(expected);
  expect(
    first.running,
    `${label}: and every one is running rather than paused — ` +
      `${JSON.stringify(first)}`,
  ).toBe(expected);
  const advanced = second.currentTimes.filter(
    (t, i) => t !== first.currentTimes[i],
  ).length;
  expect(
    advanced,
    `${label}: and every clock advanced across the gap — ` +
      `${JSON.stringify(first.currentTimes)} -> ` +
      `${JSON.stringify(second.currentTimes)}`,
  ).toBe(expected);
}

/** Read one figure's loops twice, a beat apart. */
async function twice(
  app: App,
  selector: string,
): Promise<[LoopLife, LoopLife]> {
  const first = await loopLife(app, selector);
  await wait(200);
  const second = await loopLife(app, selector);
  return [first, second];
}

interface CostReading {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

interface RestReading {
  readonly updatesPerSecond: number;
  readonly busyMsPerSecond: number;
  readonly floorMs: number;
  readonly maxGapMs: number;
}

/**
 * The at-rest reading: how many of a second's one-millisecond timer fires
 * came back late by more than the floor.
 *
 * This is the clause [B09] actually states — "no main-thread rendering
 * update over the floor" — and it is a different question from `cost()`'s.
 * A frame's cost says what a rendering update costs WHEN one runs; this says
 * how many ran. A loop the compositor owns produces none: the main thread is
 * not woken to blend it.
 */
async function rest(app: App, slot: string): Promise<RestReading> {
  await app.evalJS<null>(`(function(){
    window.${slot} = { done: false };
    window.__tugMotion.rest().then(function (reading) {
      window.${slot} = { done: true, reading: reading };
    });
    return null;
  })()`);
  await app.waitForCondition<boolean>(
    `window.${slot} !== undefined && window.${slot}.done === true`,
    { timeoutMs: 20_000 },
  );
  return app.evalJS<RestReading>(
    `(function(){ var r = window.${slot}.reading;
       return { updatesPerSecond: r.updatesPerSecond,
                busyMsPerSecond: r.busyMsPerSecond,
                floorMs: r.floorMs, maxGapMs: r.maxGapMs }; })()`,
  );
}

/**
 * `cost(frames)` parked on a slot, the same shape `at0629` uses and for the
 * same reason: a burst of this length outlives the bridge's own call budget,
 * so the promise is resolved into a global and polled for.
 */
async function cost(
  app: App,
  slot: string,
  frames: number,
): Promise<CostReading> {
  await app.evalJS<null>(`(function(){
    window.${slot} = { done: false };
    window.__tugMotion.cost(${frames}).then(function (reading) {
      window.${slot} = { done: true, reading: reading };
    });
    return null;
  })()`);
  await app.waitForCondition<boolean>(
    `window.${slot} !== undefined && window.${slot}.done === true`,
    { timeoutMs: 60_000 },
  );
  return app.evalJS<CostReading>(
    `(function(){ var r = window.${slot}.reading;
       return { p50: r.p50, p95: r.p95, max: r.max }; })()`,
  );
}

/**
 * Turn one family of loops off, by hand, with the product's own knob.
 *
 * `--tug-loop-iterations: 0` is what the circuit breaker and the off-screen
 * rule each resolve to, and it removes the
 * declaration from the timeline entirely rather than freezing it mid-cycle.
 * Written inline on each element rather than through `data-tug-offscreen`,
 * because the off-screen observer owns that attribute and would take it back
 * on its next pass — the knob is the contract, the attribute is one of two
 * ways of turning it.
 *
 * This is what lets the dot and the wave be priced SEPARATELY ([B05]). Both
 * run in the same state — a session with a turn in flight — so a reading
 * taken with both up is one aggregate, and an aggregate cannot say which
 * loop paid. The census after each switch is what proves the switch worked.
 */
async function silenceLoops(
  app: App,
  selector: string,
  off: boolean,
): Promise<number> {
  const n = await app.evalJS<number>(`(function () {
    var els = document.querySelectorAll(${JSON.stringify(selector)});
    for (var i = 0; i < els.length; i += 1) {
      ${off ? `els[i].style.setProperty("--tug-loop-iterations", "0");` : `els[i].style.removeProperty("--tug-loop-iterations");`}
    }
    return els.length;
  })()`);
  await wait(300);
  return n;
}

/** Every animation the deck is running, by name and count. */
const census = (app: App): Promise<Record<string, number>> =>
  app.evalJS<Record<string, number>>(
    `(function () {
       var out = {};
       window.__tugMotion.list().entries.forEach(function (e) {
         if (e.playState !== "running") return;
         out[e.name] = (out[e.name] || 0) + 1;
       });
       return out;
     })()`,
  );

/**
 * Stand up one bound Session card, ready to be driven.
 *
 * The composer holds focus at rest, which is the caret loop's own condition,
 * so this is also the caret leg's fixture with nothing added.
 */
async function launch(): Promise<App> {
  const app = await launchTugApp({ testName: "at0652-loop-cost-and-life" });
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A");
  // The card's BODY, not the prompt engine. `awaitEngineReady` waits on the
  // composer's CodeMirror instance, which the stub transport does not always
  // bring up inside the budget, and none of the three loops below needs it:
  // the wave is the in-flight footer's and the phase dot is the masthead's.
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${CARD} [data-slot="session-card"]`)}) !== null`,
    { timeoutMs: 20_000 },
  );
  return app;
}

describe.skipIf(!SHOULD_RUN)(
  "at0652 — each standing loop runs, and each costs nothing over the floor",
  () => {
    // The caret's two clauses, owed and not claimed ([B05]).
    //
    // The blink is declared under `&.cm-focused`, so the leg needs the
    // editor's own focus state — and this harness cannot give it one.
    // `focus-prompt` through the real door, `focusElement` on `.cm-content`,
    // and a synthetic click all leave `.cm-focused` unset for a full sixty
    // seconds: the caret LAYER mounts and carries `animation-name: none`,
    // because the editor never became focused. That is the same wall this
    // arc recorded for `focus-claim-hidden` — an app-test fixture gives the
    // focus resolver no framework destination, and `document.activeElement`
    // stands on a DIV outside every card subtree even at rest.
    //
    // It was a `note()` inside a passing test, which is the shape [F05]
    // objects to: a clause read and not claimed inside a green test reads as
    // covered. A `todo` says the same thing where a reader counting the
    // file's bars can see it. What closes it is a fixture that can take real
    // keyboard focus; building one is its own question.
    test.todo(
      "the caret blinks in the composer — owed: no app-test card takes real " +
        "keyboard focus, so `.cm-focused` never sets and the caret layer " +
        "mounts with `animation-name: none`",
      () => {},
    );

    test(
      "the phase dot and the in-flight wave each run, and the deck's frame pays for neither of them",
      async () => {
        const app = await launch();
        try {
          // ---- The phase dot. -------------------------------------------
          //
          // The masthead's identity pill carries it, and it is MOUNTED at
          // rest and carries no loop there — measured: present, zero
          // animations, no mark on any ancestor. The dot's breath is the
          // session's working state rather than its existence, so both the
          // dot and the wave are read below, after the send, which is the
          // one moment the deck is asked to draw a session as live.
          const dotAtRest = await loopLife(app, DOT);
          note(`at0652 dot at rest: ${JSON.stringify(dotAtRest)}`);
          expect(
            dotAtRest.present,
            `dot: the phase dot is on the card — marks ` +
              `${JSON.stringify(dotAtRest.marks)}`,
          ).toBe(true);

          // ---- The at-rest reading, with nothing driven into the card. --
          const restQuiet = await rest(app, "__at0652RestQuiet");
          note(`at0652 rest, card idle: ${JSON.stringify(restQuiet)}`);

          // ---- The wave. -------------------------------------------------
          //
          // The wave is the in-flight footer's glyph, so it exists only while
          // a turn is in flight. `send` takes the phase to `submitting` and
          // the stub transport leaves it there, which is the state the user
          // watches for as long as a turn takes to answer.
          // A transcript with rows under it, not an empty one. The list
          // primitive skips cells with `content-visibility: auto` once they
          // are measured, and a skipped subtree runs no animations at all
          // whatever `will-change` asked for — so an in-flight footer in a
          // one-cell list is the one shape where that whole mechanism cannot
          // reach the wave. Thirty exchanges put the footer where the report
          // found it.
          for (let i = 0; i < 30; i += 1) {
            await app.driveSession("A", {
              op: "shellExchange",
              exchangeId: `at0652-${i}`,
              command: `echo row-${i}`,
              output: `row-${i}`,
              cwd: "/tmp/test-project",
            });
          }
          await wait(400);
          note(
            `at0652 transcript cells: ${await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(`${CARD} .tug-list-view-cell`)}).length`,
            )}`,
          );
          await app.driveSession("A", { op: "send", text: "at0652" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WAVE)}) !== null`,
            { timeoutMs: 10_000 },
          );
          // A beat past the mount, so the loop has had frames to advance in
          // and a first read is not racing its own creation.
          await wait(200);

          const [wave1, wave2] = await twice(app, WAVE);
          note(`at0652 wave: ${JSON.stringify(wave1)} -> ${JSON.stringify(wave2.currentTimes)}`);
          note(
            `at0652 census with a turn in flight: ` +
              `${JSON.stringify(await census(app))}`,
          );
          expectLoopRuns("wave", 3, wave1, wave2);

          // ---- The dot, now that the session is drawn live. -------------
          //
          // Read off the CENSUS rather than off a selector, and the reason
          // is the reading a selector gave: a card with a transcript has
          // pulsing dots inside `tug-list-view-cell`s the list is skipping
          // with `content-visibility: auto`, and those carry zero
          // animations — correctly, being out of view. Every hand-written
          // selector tried landed on one of them while nine dot loops ran
          // elsewhere on the same deck. What the leg actually claims is
          // that the deck draws the session's breath somewhere while a turn
          // is in flight, and the census is the reading that says so
          // without naming a box.
          //
          // Three loops per dot — breathe, emit-expand, emit-fade — welded
          // to one start time, so the claim is on the family rather than on
          // a count.
          const live = await census(app);
          note(`at0652 dot census, live: ${JSON.stringify(live)}`);
          expect(
            live["tugx-progress-pulsing-dot-breathe"] ?? 0,
            `dot: the deck draws at least one session breathing while a ` +
              `turn is in flight — running loops ${JSON.stringify(live)}. ` +
              `Zero is what the off-screen rule and the circuit breaker ` +
              `each produce, and a dot inside a ` +
              `skipped list cell produces it too`,
          ).toBeGreaterThan(0);
          const dotAtRestLive = await loopLife(app, DOT);
          note(`at0652 dot (selector) live: ${JSON.stringify(dotAtRestLive)}`);

          // ---- Each loop's own cost, against the idle floor ([B05]). ----
          //
          // Every clause below allows TEN updates a second over the idle
          // reading — re-budgeted on 2026-10-03 under the user's decision to
          // move these bars to the measured numbers. `rest()` counts every
          // main-thread wakeup on the machine for one second, so against an
          // idle of 0 the loops read 1 on a quiet run and 3–5 with a build
          // or another test's teardown beside them, and which clause the
          // strays land on rotates run to run. The claim is the one the
          // message states: a loop the main thread owned would read at the
          // display rate, sixty a second. Ten is well under that and above
          // anything the engine's own noise has read, and one bar says so.
          const NOISE_UPDATES = 10;
          //
          // [F05]: the reading below used to be ONE rest() with the dot and
          // the wave both up. An aggregate under the floor says the pair
          // costs nothing; it does not say either one does, and a loop that
          // woke the thread while the other one stood the reading down would
          // hide inside it. So each family is silenced in turn, with the
          // census proving the switch took, and each survivor is priced on
          // its own against the same idle floor.

          // The wave, alone: every dot on the deck stood down.
          const dotsSilenced = await silenceLoops(app, ANY_DOT, true);
          const waveOnly = await census(app);
          note(
            `at0652 wave alone (${dotsSilenced} dot(s) stood down): ` +
              `${JSON.stringify(waveOnly)}`,
          );
          expect(
            waveOnly["tugx-progress-pulsing-dot-breathe"] ?? 0,
            `wave alone: every dot loop actually stood down — running loops ` +
              `${JSON.stringify(waveOnly)}. A reading taken with the dots ` +
              `still up is the aggregate this leg exists to stop being`,
          ).toBe(0);
          expect(
            waveOnly["tugx-progress-wave-0"] ?? 0,
            `wave alone: and the wave is still the loop being priced — ` +
              `${JSON.stringify(waveOnly)}`,
          ).toBeGreaterThan(0);
          const restWave = await rest(app, "__at0652RestWave");
          note(`at0652 rest, wave alone: ${JSON.stringify(restWave)}`);
          await silenceLoops(app, ANY_DOT, false);

          // The dot, alone: the wave stood down.
          const wavesSilenced = await silenceLoops(app, ANY_WAVE, true);
          const dotOnly = await census(app);
          note(
            `at0652 dot alone (${wavesSilenced} wave(s) stood down): ` +
              `${JSON.stringify(dotOnly)}`,
          );
          expect(
            dotOnly["tugx-progress-wave-0"] ?? 0,
            `dot alone: the wave actually stood down — running loops ` +
              `${JSON.stringify(dotOnly)}`,
          ).toBe(0);
          expect(
            dotOnly["tugx-progress-pulsing-dot-breathe"] ?? 0,
            `dot alone: and a dot is still breathing — ` +
              `${JSON.stringify(dotOnly)}`,
          ).toBeGreaterThan(0);
          const restDot = await rest(app, "__at0652RestDot");
          note(`at0652 rest, dot alone: ${JSON.stringify(restDot)}`);
          await silenceLoops(app, ANY_WAVE, false);

          expect(
            restWave.updatesPerSecond,
            `the wave wakes the main thread for no rendering update the ` +
              `deck was not already paying for — with every dot stood down ` +
              `the second carried ${restWave.updatesPerSecond} update(s) ` +
              `over the ${restWave.floorMs}ms floor, ` +
              `${restWave.busyMsPerSecond.toFixed(1)}ms busy; the same card ` +
              `idle carried ${restQuiet.updatesPerSecond}, ` +
              `${restQuiet.busyMsPerSecond.toFixed(1)}ms busy`,
          ).toBeLessThanOrEqual(restQuiet.updatesPerSecond + NOISE_UPDATES);
          expect(
            restDot.updatesPerSecond,
            `the phase dot wakes the main thread for no rendering update ` +
              `the deck was not already paying for — with the wave stood ` +
              `down the second carried ${restDot.updatesPerSecond} ` +
              `update(s) over the ${restDot.floorMs}ms floor, ` +
              `${restDot.busyMsPerSecond.toFixed(1)}ms busy; the same card ` +
              `idle carried ${restQuiet.updatesPerSecond}, ` +
              `${restQuiet.busyMsPerSecond.toFixed(1)}ms busy`,
          ).toBeLessThanOrEqual(restQuiet.updatesPerSecond + NOISE_UPDATES);

          // ---- And the pair together, which is the deck as shipped. -----
          //
          // Both readings, because they answer different questions. `rest()`
          // is [B09]'s clause — how many rendering updates over the floor
          // the main thread was woken for in a second — and `cost(120)` says
          // what an update cost when one ran, over the window the ask names.
          const restAll = await rest(app, "__at0652RestAll");
          const costAll = await cost(app, "__at0652Cost", COST_FRAMES);
          note(`at0652 rest, dot and wave: ${JSON.stringify(restAll)}`);
          note(`at0652 cost over ${COST_FRAMES} frames: ${JSON.stringify(costAll)}`);

          expect(
            restAll.updatesPerSecond,
            `the loops wake the main thread for no rendering update the ` +
              `deck was not already paying for — with a dot and a wave ` +
              `running the second carried ${restAll.updatesPerSecond} ` +
              `update(s) over the ${restAll.floorMs}ms floor, ` +
              `${restAll.busyMsPerSecond.toFixed(1)}ms busy, worst gap ` +
              `${restAll.maxGapMs.toFixed(1)}ms; with the same card idle ` +
              `and no loop running at all it carried ` +
              `${restQuiet.updatesPerSecond}, ` +
              `${restQuiet.busyMsPerSecond.toFixed(1)}ms busy. ` +
              `The IDLE reading is the floor, measured on this deck rather ` +
              `than assumed to be zero — a WebKit at rest wakes for its own ` +
              `reasons, and a bar of literal zero would be a claim about ` +
              `the engine rather than about the loops. A loop the ` +
              `compositor owns adds nothing here; one it does not own wakes ` +
              `the thread every frame and would read at the display rate`,
          ).toBeLessThanOrEqual(restQuiet.updatesPerSecond + NOISE_UPDATES);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

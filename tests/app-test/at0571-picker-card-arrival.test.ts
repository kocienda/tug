/**
 * at0571-picker-card-arrival.test.ts — a Session card's arrival is three
 * steps, and only one thing moves in each.
 *
 * ## What this gates
 *
 * Opening a Session card into a split column used to be one commit's worth of
 * everything at once: the neighbour shrank, the new frame slid and faded in
 * over the same window, and the picker's sheet came up on a clock that had
 * been guessed at rather than measured — a card still travelling when its
 * sheet began to rise, and a sheet clamped against a frame whose height was
 * changing under it. What the reader saw was hitching, and a picker that
 * arrived at the wrong size in the wrong place.
 *
 * The arrival is now a SEQUENCE, and each step starts when the one before it
 * finishes. The neighbour shrinks to make the room; then the new frame fades
 * into the room that opened; then, and only then, the picker's sheet plays its
 * own enter. The first two are beats of one settle chain — `shrink` and
 * `arrive`, the outer beats the entrance and departure became — and the third
 * waits on `cardDidArrive`, an event the arrive beat's own completion fires,
 * rather than on a timer that was a second copy of the imposer's spring.
 *
 * The room the card opens into is a CONSTANT, not a measurement. An unbound
 * Session card is nothing but the picker it exists to raise, so it declares
 * what it is worth in that state and `addCard` pins its member at exactly that
 * height in the commit that appends the pane. A measured number would arrive a
 * commit after the card did and re-target a settle already in flight, which is
 * the judder the pin exists to remove.
 *
 * The claims are read over the frames the imposer itself marks, against the
 * beat it names on each one (`data-imposer-beat` on the canvas), which is what
 * `runBeat` writes the attribute for. Nothing here depends on a wall-clock
 * window:
 *
 *   1. **During the shrink beat the new frame is not visible.** Its computed
 *      `opacity` is `0` on every sample the imposer marks `shrink`. This is
 *      the claim the old overlap could not make at all: the frame was fading
 *      in while the neighbour was still shrinking, so there was no instant at
 *      which only one thing was moving.
 *   2. **During the arrive beat nothing changes size.** Between consecutive
 *      samples marked `arrive`, no frame's height moves by more than 1.5px.
 *      The room is already open by then; all that is left is the newcomer
 *      appearing in it.
 *   3. **The picker's panel is not present until the beats are over.** It is
 *      absent from the document on every sample carrying a beat, and present
 *      afterwards. A sheet that came up mid-settle is the one that clamped
 *      itself against a moving frame.
 *   4. **The shrink really shrank, and `addCard` really wrote the pin.** The
 *      sitting member's height travels the whole extent between the run it
 *      held alone and the run less the gap and the pinned height, and the pin
 *      is in the live deck state keyed by the new pane. Claims 1 to 3 are free
 *      for anything that breaks this one: a card that never arrived is
 *      invisible during a shrink that never happened. This is also the one
 *      place the PRODUCTION write is exercised — `at0569` seeds its pin
 *      because it seeds its deck, and says so; this file adds its card at run
 *      time through the same `show-card` action a menu item dispatches.
 *   5. **Nothing is left behind.** At rest no frame carries an inline
 *      `opacity`, the canvas carries neither `data-imposer-settling` nor
 *      `data-imposer-beat`, and no exit ghost is in the document. An opacity
 *      hold left on a settled frame is a card the reader cannot see.
 *
 * The second test is the departure, which is the same design read backwards:
 * cancelling the picker closes the card, the ghost standing at its last rect
 * fades out on its own beat while the survivor holds still, and only then does
 * the survivor grow back over the room.
 *
 * The sitting member is a `hello` card rather than a second Session card for
 * `at0569`'s reason: an unbound Session card raises its picker the moment it
 * activates, and a fixture with two of them has two pickers up and two claims
 * against one run.
 *
 * `@covers` names the planner that partitions a settle's terms into beats, the
 * lifecycle channel the sheet waits on, and the settle-end notice the clamp
 * measures from.
 *
 * Two modules this file is unmistakably about are deliberately NOT named, for
 * the same reason and by the same precedent. `deck-canvas.tsx`, which plans
 * and launches every beat asserted here, stands at its recorded fan-out of 21,
 * one past the selection budget; so does `session-card.tsx`, where the picker
 * waits. Recorded debt may be paid down but never refinanced, so naming either
 * would be refused outright on the commit that did it — which is exactly the
 * call `at0563` made about the same two modules, and `at0569` about the
 * second. What stands in their place are the seams each reaches this
 * choreography through: `pane-flip.ts` owns the beat order and the partition
 * the canvas launches, and `card-lifecycle.ts` owns the channel the picker
 * waits on. An edit that changes which beats run, or when a card is said to
 * have arrived, selects this file through one of those.
 *
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/card-lifecycle.ts
 * @covers tugdeck/src/lib/settle-notice.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { IMPOSITION_GAP_PX } from "../../tugdeck/src/lib/layout-imposer";
import {
  pickerPanelNaturalHeight,
  pointPickerAt,
  removePickerSessions,
  seedPickerSessions,
  type PickerSessionsFixture,
} from "./picker-sessions-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/**
 * `SESSION_UNBOUND_HEIGHT_PX` from `session-card-registration.tsx`, copied
 * rather than imported: that module is a `.tsx` and this project compiles
 * without `--jsx`, which is the same reason `at0569` and `at0552` carry their
 * own copies of the constants they measure against.
 *
 * A copy that drifts fails claim 4 rather than passing quietly.
 */
const SESSION_UNBOUND_HEIGHT_PX = 618;

/**
 * A project whose Sessions list stands at its 14.5rem cap, so the picker the
 * arriving card raises is the one a real project presents rather than the
 * one-row picker of a fresh instance.
 */
let fixture: PickerSessionsFixture | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  fixture = seedPickerSessions("at0571");
});

afterAll(() => {
  removePickerSessions(fixture);
});

/** The seeded panes. Everything else on the canvas arrived at run time. */
const SEEDED_PANES = ["p1", "p3"] as const;
/** The member that makes the room: slot 0's sitting `hello` card. */
const SITTER = "p1";

const PICKER_FORM = ".session-card-picker-form";
const EXIT_GHOST = ".tug-pane-exit-ghost";

/**
 * How long each sampler runs. The arrival at the default tune is a shrink beat
 * and an arrive beat, each 0.6× the 400ms nominal, and the sampler runs well
 * past the pair so the rest frames and the sheet's own enter are in the record.
 */
const CENSUS_MS = 1_600;
/** The whole choreography's window, with room for the last beat to land. */
const AFTER_LAND_MS = 1_800;
/** Geometry tolerance: sub-pixel layout rounding, never a real disagreement. */
const EPSILON = 1.5;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * A two-up whose slot 0 holds one `hello` card in a SPLIT column, and whose
 * slot 1 holds another so the arrangement is a real one.
 *
 * Slot 0 is split with a single member on purpose: splitting a slot that holds
 * one card is a legal committed state, and it is what makes the card added
 * below join as a second MEMBER rather than as a second card on a stack. A
 * stacked arrival moves nothing and would make every claim here vacuous.
 *
 * No `exactMemberHeights` here, and that is the point of this fixture against
 * `at0569`'s: the pin under test is the one `addCard` writes.
 */
function deckShape() {
  const pane = (id: string, cardId: string, slot: number) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 600, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "hello", title: "Card A", closable: true },
      { id: "C", componentId: "hello", title: "Card C", closable: true },
    ],
    panes: [pane("p1", "A", 0), pane("p3", "C", 1)],
    activePaneId: "p1",
    imposition: {
      kind: "two-up",
      sidebars: {},
      columns: { 0: { mode: "split", order: ["p1"] } },
    },
    hasFocus: true,
  };
}

interface Sample {
  t: number;
  /** Whether the canvas carried the settle mark on this frame. */
  settling: boolean;
  /** The beat the imposer named on this frame, `""` outside a beat. */
  beat: string;
  /** Every live frame's height, keyed by pane id. */
  heights: Record<string, number>;
  /** Every live frame's COMPUTED opacity, keyed by pane id. */
  opacity: Record<string, string>;
  /** Every live frame's INLINE opacity — a hold, or `""`. */
  inlineOpacity: Record<string, string>;
  /** Whether the picker's panel was in the document. */
  picker: boolean;
  /** How many exit ghosts stood on the canvas. */
  ghosts: number;
}

/**
 * Arm a per-frame sampler, run one gesture, and hand back what it saw.
 *
 * Installed BEFORE the gesture and reading on `requestAnimationFrame`, so the
 * first sample is the pre-motion geometry and every frame of the motion is in
 * the record. Frames are collected by walking `.tug-pane[data-pane-id]` rather
 * than by naming ids, because the frame under test is the one that did not
 * exist when the sampler was written: its pane id is a fresh UUID.
 *
 * Opacity is read twice on purpose. The COMPUTED value is what the reader sees
 * and is what claim 1 is about; the INLINE value is where the hold actually
 * lives, and claim 5's residue check is about that one.
 */
async function census(app: App, gesture: string): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0571 = [];
      var t0 = performance.now();
      var tick = function () {
        var canvas = document.querySelector("[data-imposer-settling]");
        var sample = {
          t: performance.now() - t0,
          settling: canvas !== null,
          beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
          heights: {},
          opacity: {},
          inlineOpacity: {},
          picker: document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null,
          ghosts: document.querySelectorAll(${JSON.stringify(EXIT_GHOST)}).length,
        };
        var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
        for (var i = 0; i < frames.length; i += 1) {
          var el = frames[i];
          var id = el.getAttribute("data-pane-id");
          sample.heights[id] = el.getBoundingClientRect().height;
          sample.opacity[id] = getComputedStyle(el).opacity;
          sample.inlineOpacity[id] = el.style.opacity;
        }
        window.__at0571.push(sample);
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(`(${gesture}, null)`);
  await wait(CENSUS_MS + 300);
  return app.evalJS<Sample[]>(`window.__at0571`);
}

/** The samples the imposer named a given beat on. */
function beatFrames(samples: Sample[], beat: string): Sample[] {
  return samples.filter((s) => s.beat === beat);
}

/** The beats the settle ran, in the order they were first seen. */
function beatOrder(samples: Sample[]): string[] {
  const seen: string[] = [];
  for (const s of samples) {
    if (s.beat !== "" && seen[seen.length - 1] !== s.beat) seen.push(s.beat);
  }
  return seen;
}

/** The pane ids the sampler saw that the fixture did not seed. */
function arrivedPanes(samples: Sample[]): string[] {
  const ids = new Set<string>();
  for (const s of samples) {
    for (const id of Object.keys(s.heights)) {
      if (!SEEDED_PANES.includes(id as (typeof SEEDED_PANES)[number])) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** The extent a picked series covered across the samples it was seen in. */
function spread(samples: Sample[], pick: (s: Sample) => number): number {
  const values = samples.map(pick).filter((v) => v > 0);
  if (values.length === 0) return 0;
  return Math.max(...values) - Math.min(...values);
}

/** The largest frame-to-frame height change any frame took across `samples`. */
function worstHeightStep(samples: Sample[]): { pane: string; step: number } {
  let worst = { pane: "", step: 0 };
  for (let i = 1; i < samples.length; i += 1) {
    const before = samples[i - 1].heights;
    const after = samples[i].heights;
    for (const pane of Object.keys(after)) {
      if (before[pane] === undefined) continue;
      const step = Math.abs(after[pane] - before[pane]);
      if (step > worst.step) worst = { pane, step };
    }
  }
  return worst;
}

/** The canvas's marks and the residue every frame carries, at rest. */
async function atRest(app: App): Promise<{
  settling: boolean;
  beat: string | null;
  inlineOpacities: string[];
  ghosts: number;
  picker: boolean;
}> {
  return app.evalJS(
    `(function () {
      var canvas = document.querySelector("[data-imposer-settling]");
      var withBeat = document.querySelector("[data-imposer-beat]");
      var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
      var inline = [];
      for (var i = 0; i < frames.length; i += 1) {
        if (frames[i].style.opacity !== "") inline.push(frames[i].style.opacity);
      }
      return {
        settling: canvas !== null,
        beat: withBeat === null ? null : withBeat.getAttribute("data-imposer-beat"),
        inlineOpacities: inline,
        ghosts: document.querySelectorAll(${JSON.stringify(EXIT_GHOST)}).length,
        picker: document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null,
      };
    })()`,
  );
}

/** The exact-height pins the live store holds, keyed by member. */
async function pins(app: App): Promise<Record<string, number> | null> {
  return app.evalJS<Record<string, number> | null>(
    `(window.tugdeck.diag.getDeckState().exactMemberHeights || null)`,
  );
}

/**
 * Point the open picker at the seeded project, let the list reach its cap,
 * and print the panel's natural height as it then stands.
 */
async function measureAtListCap(app: App, label: string): Promise<void> {
  if (fixture === null) throw new Error("the picker sessions fixture was not seeded");
  await pointPickerAt(app, fixture);
  await wait(AFTER_LAND_MS);
  const natural = await pickerPanelNaturalHeight(app);
  note(label, `panel natural ${natural ?? -1}px with the list at its cap`);
}

/** Seed the deck, wait for both frames, and let the imposer settle. */
async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/**
 * Add a Session card the way the app does: the `show-card` control action,
 * which is what a menu item dispatches and which routes to `addCard`.
 *
 * Under a two-up a card arriving from nowhere takes the arrangement's
 * centermost slot, cheating left — slot 0, which is the split column this
 * fixture set up for it.
 */
const addSessionCard = `window.__tug.dispatchControlAction("show-card", { component: "session" })`;

/** Press the picker's Cancel, which closes the host card ([D02] cascade). */
const cancelPicker = `(function () {
  var form = document.querySelector(${JSON.stringify(PICKER_FORM)});
  if (form === null) return null;
  var buttons = form.querySelectorAll(".tug-sheet-actions button");
  for (var i = 0; i < buttons.length; i += 1) {
    if ((buttons[i].textContent || "").trim() === "Cancel") {
      buttons[i].click();
      return null;
    }
  }
  return null;
})()`;

describe.skipIf(!SHOULD_RUN)("AT0571: the divided arrival", () => {
  test(
    "the neighbour makes room, then the card fades into it, then the picker comes up",
    async () => {
      const app = await launchTugApp({ testName: "at0571-arrival" });
      try {
        await seed(app);
        const runBefore = (
          await app.evalJS<number>(
            `document.querySelector('.tug-pane[data-pane-id="${SITTER}"]').getBoundingClientRect().height`,
          )
        );

        const samples = await census(app, addSessionCard);
        const arrived = arrivedPanes(samples);
        note("arrival", `panes arrived: ${JSON.stringify(arrived)}`);
        expect(arrived.length, "exactly one frame arrived").toBe(1);
        const newcomer = arrived[0];

        const order = beatOrder(samples);
        const shrink = beatFrames(samples, "shrink");
        const arrive = beatFrames(samples, "arrive");
        const withBeat = samples.filter((s) => s.beat !== "");
        note(
          "arrival beats",
          `order=${JSON.stringify(order)} shrink=${shrink.length}f arrive=${arrive.length}f run before=${runBefore.toFixed(2)}`,
        );
        expect(
          shrink.length,
          "the shrink beat must be sampled mid-motion",
        ).toBeGreaterThan(3);
        expect(
          arrive.length,
          "the arrive beat must be sampled mid-motion",
        ).toBeGreaterThan(3);

        // 4, first, because 1 to 3 are only claims if there was a real
        // arrival to read them over. The sitter's own height is the motion,
        // and the pin is the number it travelled to.
        const sitterTravel = spread(shrink, (s) => s.heights[SITTER] ?? 0);
        // Both resting heights are read from the LAST sample rather than from
        // the extreme of the shrink beat. The beat's last sampled frame is a
        // pixel or so short of where the spring finally lands, and reading the
        // minimum there would build that overshoot into the arithmetic — which
        // is what turned an exact claim into a tolerance on the first run of
        // this file.
        const last = samples[samples.length - 1];
        const sitterRest = last.heights[SITTER] ?? -1;
        const newcomerRest = last.heights[newcomer] ?? -1;
        const livePins = await pins(app);
        note(
          "arrival extent",
          `sitter travel=${sitterTravel.toFixed(2)} run before=${runBefore.toFixed(2)} at rest sitter=${sitterRest.toFixed(2)} newcomer=${newcomerRest.toFixed(2)} pins=${JSON.stringify(livePins)}`,
        );
        // The pin bit: the newcomer stands at the height it declared, not at
        // the 600px stack floor a Session card would otherwise claim and not
        // at a share of the run. This is the exact claim.
        expect(
          newcomerRest,
          "the arriving card stands at exactly the height it declared unbound",
        ).toBeCloseTo(SESSION_UNBOUND_HEIGHT_PX, 0);
        // And the sitter holds every pixel the pin did not take: the two
        // members and the gap between them are the run the sitter held alone.
        expect(
          sitterRest + IMPOSITION_GAP_PX + newcomerRest,
          "the sitter holds every pixel the pin did not take",
        ).toBeCloseTo(runBefore, 0);
        expect(
          sitterTravel,
          "and it travelled the whole extent to get there",
        ).toBeGreaterThan(SESSION_UNBOUND_HEIGHT_PX * 0.8);
        expect(
          livePins?.[newcomer],
          "addCard wrote the pin on the production path",
        ).toBe(SESSION_UNBOUND_HEIGHT_PX);

        // 1. The newcomer is invisible for the whole of the shrink.
        const visibleDuringShrink = shrink.filter(
          (s) => s.opacity[newcomer] !== undefined && s.opacity[newcomer] !== "0",
        );
        note(
          "arrival hold",
          `samples with the newcomer visible during shrink: ${visibleDuringShrink.length}`,
        );
        expect(
          visibleDuringShrink.length,
          "the arriving frame is held invisible for the whole shrink beat",
        ).toBe(0);

        // 2. Nothing resizes during the arrive beat.
        const worst = worstHeightStep(arrive);
        note(
          "arrive beat",
          `worst height step: ${worst.step.toFixed(2)}px on ${worst.pane || "nothing"}`,
        );
        expect(
          worst.step,
          "no frame changes size during the arrive beat",
        ).toBeLessThan(EPSILON);

        // 3. The picker waits for the beats to be over.
        const pickerDuringBeats = withBeat.filter((s) => s.picker);
        const pickerAfter = samples.filter((s) => s.beat === "" && s.picker);
        note(
          "picker",
          `present on ${pickerDuringBeats.length} beat sample(s), on ${pickerAfter.length} sample(s) after`,
        );
        expect(
          pickerDuringBeats.length,
          "the picker's panel is absent while a beat is running",
        ).toBe(0);
        expect(
          pickerAfter.length,
          "and present once the beats are over",
        ).toBeGreaterThan(0);

        // 5. Nothing is left behind.
        await wait(AFTER_LAND_MS);
        const rest = await atRest(app);
        note("arrival at rest", JSON.stringify(rest));
        expect(rest.settling, "the settle mark is off the canvas").toBe(false);
        expect(rest.beat, "and so is the beat attribute").toBeNull();
        expect(
          rest.inlineOpacities,
          "no frame keeps an inline opacity hold",
        ).toEqual([]);
        expect(rest.ghosts, "and no exit ghost stands").toBe(0);
        expect(rest.picker, "the picker is up at rest").toBe(true);

        // The picker over a project with more sessions than the list's cap
        // holds — the case a real project presents.
        await measureAtListCap(app, "arrival picker");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "cancelling the picker takes the card away before the survivor grows back",
    async () => {
      const app = await launchTugApp({ testName: "at0571-departure" });
      try {
        await seed(app);
        await app.evalJS<null>(`(${addSessionCard}, null)`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);
        await measureAtListCap(app, "departure picker");

        const samples = await census(app, cancelPicker);
        const order = beatOrder(samples);
        const depart = beatFrames(samples, "depart");
        const grow = beatFrames(samples, "grow");
        note(
          "departure beats",
          `order=${JSON.stringify(order)} depart=${depart.length}f grow=${grow.length}f`,
        );
        expect(
          depart.length,
          "the depart beat must be sampled mid-motion",
        ).toBeGreaterThan(3);
        expect(
          grow.length,
          "the grow beat must be sampled mid-motion",
        ).toBeGreaterThan(3);
        expect(
          order.indexOf("depart"),
          "the ghost fades before anything grows",
        ).toBeLessThan(order.indexOf("grow"));

        // The survivor holds still for the whole of the ghost's fade — the
        // departure's half of "one kind of thing at a time".
        const departStep = worstHeightStep(depart);
        note(
          "departure hold",
          `worst height step during depart: ${departStep.step.toFixed(2)}px on ${departStep.pane || "nothing"}`,
        );
        expect(
          departStep.step,
          "no frame changes size during the depart beat",
        ).toBeLessThan(EPSILON);

        // The ghost is the depart beat's whole subject, so it is gone by the
        // time the survivor starts growing over the room it stood in.
        const ghostsDuringGrow = grow.filter((s) => s.ghosts > 0);
        note(
          "ghost",
          `standing on ${depart.filter((s) => s.ghosts > 0).length} depart sample(s), ${ghostsDuringGrow.length} grow sample(s)`,
        );
        expect(
          ghostsDuringGrow.length,
          "the ghost is gone before the grow beat starts",
        ).toBe(0);

        // And the survivor really did grow back over the whole run.
        const growTravel = spread(grow, (s) => s.heights[SITTER] ?? 0);
        note("departure extent", `survivor travel=${growTravel.toFixed(2)}`);
        expect(
          growTravel,
          "the survivor grows back over the room the card left",
        ).toBeGreaterThan(SESSION_UNBOUND_HEIGHT_PX * 0.8);

        await wait(AFTER_LAND_MS);
        const rest = await atRest(app);
        note("departure at rest", JSON.stringify(rest));
        expect(rest.settling, "the settle mark is off the canvas").toBe(false);
        expect(rest.beat, "and so is the beat attribute").toBeNull();
        expect(
          rest.inlineOpacities,
          "no frame keeps an inline opacity hold",
        ).toEqual([]);
        expect(rest.ghosts, "and no exit ghost stands").toBe(0);
        expect(rest.picker, "the picker went with its card").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

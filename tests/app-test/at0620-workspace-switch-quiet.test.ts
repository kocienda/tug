/**
 * at0620-workspace-switch-quiet.test.ts — what a workspace switch actually
 * does to the canvas, frame by frame, BEFORE anything about it changes.
 *
 * ## Why a recording rather than an assertion
 *
 * The arc this file opens is about stillness: a switch should go from one
 * still screen to another with no extraneous movement after the transition
 * lands. The trouble with writing that as an assertion first is that nobody
 * yet knows WHICH movement there is. `briefs/workspaces-content-visibility-brief.md`
 * made "armed on the shown transition" the rule for every geometry a hidden
 * layer cannot take — a composer's line box, a pane bar's controls width, a
 * pane's accessory height, a sheet's two clamps, a transcript's row window —
 * and each of those is a candidate for a write that lands one or more frames
 * AFTER the swap commit, under a dissolve that is already running. So is the
 * activation's own second commit, which `activateSpace` step (7) produces by
 * calling `activateCard` outside the swap batch.
 *
 * Any of them could be the hop. Several of them could be. A test that guessed
 * would pin the guess.
 *
 * So this file began as a SAMPLER. It drives six real switches — three
 * conditions, each in both directions — with
 * an 8ms sampler installed before the gesture and read after the crossing
 * attribute is gone, and it emits every reading through `note()` so the
 * recipe's `Diagnostics:` section carries them.
 *
 * ## What it now gates
 *
 * Two claims, one out of the trace and one off the pixels.
 *
 * **The arriving deck is already solved.** In the resized-while-hidden
 * condition, the arriving workspace's rail comes up at the width the space
 * allocator solves for the canvas it is standing in — not the one it was
 * parked at — and no pane changes size for the rest of the window. A parked
 * deck carries the arrangement it was solved for at the switch away, and the
 * settled-resize re-tune only ever re-solves the ACTIVE workspace, so a rail
 * arrived at its remembered width and stayed there until the next resize.
 * `activateSpace` re-solves inside the swap commit instead.
 *
 * **Nothing animates under the switch epoch.**
 *
 * The readings said which of the candidates above actually move, and the
 * answer is in `briefs/workspace-switch-quiet-recording.md`. The claim that
 * came out of them is in the trace rather than in the pixels, and it is the
 * one leg of this file that fails:
 *
 * **From the swap commit onward, no arm carried.** A switch is not one commit.
 * The swap spells itself `"cut"` and `arm` has always declined that; every
 * commit after it — `activateCard`'s reveal, and each geometry the arriving
 * layer could not take while hidden — arrives spelled `"cross"` like any
 * ordinary arrangement change, and used to be carried. `data-space-switching`
 * on the canvas is what tells `arm` those are still the switch, and a refused
 * one records `landing: "cross", outcome: "unarmed", reason: "switching"` —
 * the commit's own word kept, the rule that answered it named beside it.
 *
 * **The switch lands still.** The four success criteria, over all six runs:
 * no pane frame in the shown layer moves or resizes after the beat; none ever
 * computes an opacity below 1 or carries an inline `opacity: 0`; the cover
 * records a `quietMs` inside `SPACE_QUIET_BOUND_MS`; and no scroller under
 * the shown layer moves.
 *
 * Two things stay notes on purpose, and both would otherwise be tests that
 * pass for the wrong reason. `quietReason` is noted rather than asserted —
 * the quiet path's frame counter rides `requestAnimationFrame` and a covered
 * window suspends it, so asserting `"quiet"` would be red on a busy desktop
 * for a reason that is not the product; the rule's proof is the unit test
 * over `spaceDissolveDue`. And the scroller criterion is VACUOUS on this
 * fixture — no transcript here overflows, so the sampler has never tracked a
 * scroller at all — which is noted beside the assertion rather than left for
 * a reader to discover.
 *
 * ## The three conditions
 *
 *  - **Plain.** Two settled workspaces, nothing streaming. The floor.
 *  - **Streamed while hidden.** A few hundred transcript rows appended to the
 *    session cards of the workspace being switched TO, while it is hidden, so
 *    the list view's hold-the-range-while-hidden branch has a real backlog to
 *    re-window against on the shown transition.
 *  - **Resized while hidden.** The canvas container's width changed while the
 *    target workspace was parked, and left to settle past the imposer's
 *    re-tune quiet. This is the one condition where the parked deck's stored
 *    offsets provably do not reveal the remembered pane under the current
 *    band — the case where the switch's second commit can land a CARRIED
 *    arrangement change one commit after the swap, with the settle animating
 *    it under the dissolve.
 *
 * ## Why `setInterval` and why a rAF counter beside it
 *
 * `setInterval` rather than `requestAnimationFrame`, for the reason
 * at0592 states: a covered harness window suspends rAF, and a sampler that
 * never ran would report a perfectly still switch whatever happened. The
 * sample count is asserted for the same reason.
 *
 * But whether rAF ticks here is itself a question this arc has to answer, so
 * a rAF-driven counter runs alongside the interval-driven one across the same
 * gesture and both counts are reported. The quiet rule this arc is heading
 * for counts silent ANIMATION FRAMES; if rAF is suspended in the harness, that
 * counter never advances, every switch under test releases on the bound
 * instead, and a later test may assert the bound and nothing about the reason.
 * The answer belongs in the findings paper either way.
 *
 * ## What the reading is
 *
 * Per sample the sampler reads, for the shown layer only:
 *
 *  - every pane frame's rect (rounded to integers), computed opacity, and
 *    inline opacity;
 *  - every scroller's `scrollTop` and `scrollHeight`, keyed by a stable path,
 *    which is the focus-scroll question's empirical half;
 *  - every element carrying an inline `max-height`, and every composer's
 *    published `--tugx-editor-line-box`, so a clamp or a line box that lands
 *    late shows up as a value that CHANGED after the switch.
 *
 * Nothing is kept per-sample: each tracked value is reduced to first, last,
 * how many times it changed, when it last changed, and how many of those
 * changes landed after the crossing attribute was gone. That last number is
 * the one the arc is for.
 *
 * `tugdeck/src/deck-manager.ts` is NOT declared here, and the omission is the
 * budget's rather than this file's. The resized-while-hidden claim exercises
 * `activateSpace`'s re-solve and nothing narrower, so the honest declaration
 * would name the manager — but that path already fans out to 21 tests, one
 * over `MAX_SELECTED`, and `ACCEPTED_FANOUT` records the debt on the rule that
 * it may be paid down and never refinanced. Adding a 22nd would be the edit
 * that widens a hub raising its own ceiling, which is the one thing that
 * ratchet exists to refuse. A manager change still selects `at0303` and
 * `at0453`, which drive the same allocator.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tugdeck/src/components/chrome/space-layer.css
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

const SPACE_ONE = "at0620-one";
const SPACE_TWO = "at0620-two";

/** The session cards, one pair per workspace — the re-arm table's subjects. */
const SESSIONS_ONE = ["at0620-sa", "at0620-sb"] as const;
const SESSIONS_TWO = ["at0620-sc", "at0620-sd"] as const;

/**
 * Every pane id each workspace stands, rail first — the subjects of the
 * arrives-at-its-solved-size claim.
 *
 * The rail is the one that matters and the others are its control: a content
 * pane's box is CSS over the band, so it re-resolves in the browser's own
 * reflow and was never going to be late. The rail's width is a NUMBER in
 * `deckState`, solved by the space allocator, and a parked deck carries the
 * number it was solved for at the switch away.
 */
const PANES_ONE = ["at0620-pc1", "at0620-pa0", "at0620-pa1", "at0620-pat"] as const;
const PANES_TWO = ["at0620-pc2", "at0620-pb0", "at0620-pb1", "at0620-pbt"] as const;

const sessionIdFor = (cardId: string): string => `at0620-session-${cardId}`;

/** `FeedId.CODE_OUTPUT` — the wire constant, mirrored from `protocol.ts`. */
const FEED_CODE_OUTPUT = 0x40;

/** Turns appended per session card while its workspace is hidden. */
const HIDDEN_TURNS = 60;

const SHOWN_FRAMES =
  "[data-space-layer][data-space-shown] .tug-pane[data-pane-id]";
const CROSSING_LAYERS = ".tug-space-layer[data-space-crossing]";
const SHOWN_LAYER = "[data-space-layer][data-space-shown]";
/** The element Spec S02 names as the canvas container. */
const CANVAS_CONTAINER = "[data-deck-canvas-background]";
/**
 * The React mount root, which is what `DeckManager` holds as `this.container`
 * and therefore what every solve in the manager MEASURES.
 *
 * The resized-while-hidden condition has to move this one. Setting a width on
 * the canvas background instead moves the picture — CSS lays the frames out
 * over the narrower box, and the sampler duly reports it — while leaving
 * `this.container.clientWidth` exactly where it was, so the space allocator
 * is asked the same question it was asked before and gives the same answer.
 * The condition then reproduces nothing, which is what it did until this was
 * found: see the findings paper.
 */
const DECK_CONTAINER = "#deck-container";
/** The switch epoch's mark, which is a debt from the frame it is written. */
const SWITCHING_MARK = "[data-space-switching]";

/**
 * How long the crossing attribute may stand before the wait gives up. Same
 * generosity as at0592's: the beat is a few hundred ms and this is several
 * multiples of it, so it catches only a beat that never lands.
 */
const CROSSING_BOUND_MS = 1_500;

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

/**
 * One tracked value's history, reduced. `afterCross` is the count of changes
 * that landed after the last sample at which any layer still carried
 * `data-space-crossing` — the movement this arc exists to remove.
 */
interface Tracked {
  first: string;
  last: string;
  changes: number;
  lastChangeMs: number;
  afterCross: number;
}

interface Summary {
  /** How many distinct values were tracked in this bucket. */
  keys: number;
  /** Every one that ever changed, rendered `key first -> last (xN, last @Mms)`. */
  moved: string[];
  /** Every one that changed after the crossing attribute was gone. */
  movedAfterCross: string[];
}

interface Reading {
  samples: number;
  rafTicks: number;
  /** Samples at which some layer carried `data-space-crossing`. */
  crossSeen: number;
  crossFirstMs: number;
  crossLastMs: number;
  /** The canvas container's width at the first and last sample. */
  containerWidth: string;
  /**
   * The lowest computed `opacity` any shown pane frame held at any sample,
   * and where — `-1` when no frame was ever sampled, which is itself a
   * finding rather than a pass.
   */
  minOpacity: number;
  minOpacityAt: string;
  /** Every shown pane id that ever carried an inline `opacity: 0`. */
  inlineZero: string[];
  /** Errors the sampler swallowed rather than throwing out of the tick. */
  errors: string[];
  panes: Summary;
  /**
   * Per pane id, its rect at the first sample it was ever seen at and at the
   * last — `left,top,width,height`, the same spelling `panes` tracks.
   *
   * Kept beside the reduced summary rather than derived from it because the
   * claim this file makes about a resized switch is about the VALUES: for a
   * pane of the ARRIVING workspace the first sample is the first frame after
   * the swap, since its id is not on the shown layer before then.
   */
  paneBoxes: Record<string, { first: string; last: string; changes: number }>;
  scrollers: Summary;
  clamps: Summary;
  lineBoxes: Summary;
}

/**
 * Candidate scrollers, named rather than swept. A blanket `querySelectorAll("*")`
 * with a `scrollHeight` read on every node would force a full layout every 8ms
 * over a transcript of several hundred rows — the sampler would then be the
 * thing perturbing what it measures.
 */
const SCROLLER_CANDIDATES = [
  ".cm-scroller",
  "[data-scroll-region]",
  ".tug-list-view",
  ".tug-list-view-scroller",
  ".session-card-transcript",
  ".tug-pane-content",
  "[class*='scroll']",
].join(", ");

const SAMPLER_START = `(function () {
  var s = {
    t0: Date.now(),
    samples: 0,
    rafTicks: 0,
    crossSeen: 0,
    crossFirstMs: -1,
    crossLastMs: -1,
    widthFirst: "",
    widthLast: "",
    minOpacity: 2,
    minOpacityAt: "-",
    inlineZero: [],
    errors: [],
    panes: {},
    scrollers: {},
    clamps: {},
    lineBoxes: {},
  };
  window.__at0620 = s;

  function ms() { return Date.now() - s.t0; }

  /** A key stable for the length of one run: the nearest card or pane, then
   *  tag + first class + sibling index the rest of the way down. */
  function pathOf(el) {
    var parts = [];
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < 14) {
      if (node.getAttribute && node.getAttribute("data-card-id")) {
        parts.unshift("card:" + node.getAttribute("data-card-id"));
        break;
      }
      if (node.getAttribute && node.getAttribute("data-pane-id")) {
        parts.unshift("pane:" + node.getAttribute("data-pane-id"));
        break;
      }
      var cls = (typeof node.className === "string" && node.className !== "")
        ? "." + node.className.split(/\\s+/)[0]
        : "";
      var idx = 0;
      var sib = node;
      while ((sib = sib.previousElementSibling) !== null) idx += 1;
      parts.unshift(node.tagName.toLowerCase() + cls + ":" + idx);
      node = node.parentElement;
      guard += 1;
    }
    return parts.join(">");
  }

  function track(bucket, key, value) {
    var rec = bucket[key];
    if (rec === undefined) {
      bucket[key] = {
        first: value, last: value, changes: 0, lastChangeMs: -1, afterCross: 0,
      };
      return;
    }
    if (rec.last === value) return;
    rec.changes += 1;
    rec.lastChangeMs = ms();
    rec.last = value;
    // The crossing bookkeeping runs FIRST in the tick, so during the beat
    // \`crossLastMs\` is this very sample and nothing counts as after it. One
    // sample interval of margin keeps the tick the attribute vanished in on
    // the beat's side of the line.
    if (s.crossLastMs >= 0 && ms() > s.crossLastMs + 16) rec.afterCross += 1;
  }

  s.timer = setInterval(function () {
    try {
      s.samples += 1;
      if (document.querySelectorAll(${JSON.stringify(CROSSING_LAYERS)}).length > 0) {
        s.crossSeen += 1;
        if (s.crossFirstMs < 0) s.crossFirstMs = ms();
        s.crossLastMs = ms();
      }

      var container = document.querySelector(${JSON.stringify(CANVAS_CONTAINER)});
      if (container !== null) {
        var cw = String(Math.round(container.getBoundingClientRect().width));
        if (s.widthFirst === "") s.widthFirst = cw;
        s.widthLast = cw;
      }

      var frames = document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)});
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var id = f.getAttribute("data-pane-id");
        var r = f.getBoundingClientRect();
        track(s.panes, id + "|rect",
          Math.round(r.left) + "," + Math.round(r.top) + "," +
          Math.round(r.width) + "," + Math.round(r.height));
        // The two halves of "the arriving workspace is never faded", kept as
        // VALUES rather than as a change count: a frame held at 0 for the
        // whole window never changes, so a change count would read it as
        // still. (No backticks in here: this comment lives inside a template
        // literal, and one would end the string.)
        var op = getComputedStyle(f).opacity;
        track(s.panes, id + "|opacity", op);
        var opN = parseFloat(op);
        if (opN === opN && opN < s.minOpacity) {
          s.minOpacity = opN;
          s.minOpacityAt = id + " @" + ms() + "ms";
        }
        var inline = f.style.opacity;
        track(s.panes, id + "|inline-opacity", inline);
        if (inline === "0" && s.inlineZero.indexOf(id) < 0) {
          s.inlineZero.push(id);
        }
      }

      var layer = document.querySelector(${JSON.stringify(SHOWN_LAYER)});
      if (layer === null) return;

      var scrollers = layer.querySelectorAll(${JSON.stringify(SCROLLER_CANDIDATES)});
      for (var j = 0; j < scrollers.length; j++) {
        var sc = scrollers[j];
        if (sc.scrollHeight - sc.clientHeight <= 1) continue;
        var key = pathOf(sc);
        track(s.scrollers, key + "|scrollTop", String(Math.round(sc.scrollTop)));
        track(s.scrollers, key + "|scrollHeight", String(sc.scrollHeight));
      }

      // Inline \`max-height\` is found by attribute substring rather than by a
      // style read over every node: the sheet's two clamps and the composer's
      // cap are all inline, and the selector costs one pass.
      var clamped = layer.querySelectorAll('[style*="max-height"]');
      track(s.clamps, "__count", String(clamped.length));
      for (var k = 0; k < clamped.length; k++) {
        track(s.clamps, pathOf(clamped[k]), clamped[k].style.maxHeight);
      }

      var editors = layer.querySelectorAll(".cm-editor");
      for (var m = 0; m < editors.length; m++) {
        track(s.lineBoxes, pathOf(editors[m]),
          editors[m].style.getPropertyValue("--tugx-editor-line-box"));
      }
    } catch (e) {
      if (s.errors.length < 4) s.errors.push(String(e && e.message ? e.message : e));
    }
  }, 8);

  // The rAF counter, beside the interval one and never in place of it. Its
  // whole purpose is to say whether rAF ticks in this harness at all.
  var pump = function () {
    s.rafTicks += 1;
    s.rafId = window.requestAnimationFrame(pump);
  };
  s.rafId = window.requestAnimationFrame(pump);
  return null;
})()`;

const SAMPLER_READ = `(function () {
  var s = window.__at0620;
  clearInterval(s.timer);
  if (s.rafId !== undefined) window.cancelAnimationFrame(s.rafId);
  function summarize(bucket) {
    var out = { keys: 0, moved: [], movedAfterCross: [] };
    for (var k in bucket) {
      if (!Object.prototype.hasOwnProperty.call(bucket, k)) continue;
      out.keys += 1;
      var r = bucket[k];
      if (r.changes > 0) {
        out.moved.push(
          k + " [" + r.first + "] -> [" + r.last + "] x" + r.changes +
          " last@" + r.lastChangeMs + "ms");
      }
      if (r.afterCross > 0) out.movedAfterCross.push(k + " x" + r.afterCross);
    }
    return out;
  }
  return {
    samples: s.samples,
    rafTicks: s.rafTicks,
    crossSeen: s.crossSeen,
    crossFirstMs: s.crossFirstMs,
    crossLastMs: s.crossLastMs,
    containerWidth: s.widthFirst + " -> " + s.widthLast,
    minOpacity: s.minOpacity === 2 ? -1 : s.minOpacity,
    minOpacityAt: s.minOpacityAt,
    inlineZero: s.inlineZero,
    errors: s.errors,
    panes: summarize(s.panes),
    paneBoxes: (function () {
      var out = {};
      for (var k in s.panes) {
        if (!Object.prototype.hasOwnProperty.call(s.panes, k)) continue;
        if (k.slice(-5) !== "|rect") continue;
        var r = s.panes[k];
        out[k.slice(0, -5)] = {
          first: r.first, last: r.last, changes: r.changes,
        };
      }
      return out;
    })(),
    scrollers: summarize(s.scrollers),
    clamps: summarize(s.clamps),
    lineBoxes: summarize(s.lineBoxes),
  };
})()`;

/** The trace records this arc reads back, serialized in-page. */
const TRACE_KINDS = [
  "settle-arm",
  "settle-retarget",
  "settle-release",
  "space-switch-timing",
  // The cover's own record ([P06]): how long it was held and what lifted it.
  "space-quiet",
];

const traceRead = (mark: number): string =>
  `JSON.stringify(window.__deckTrace.since(${mark}).filter(function (e) {
     return ${JSON.stringify(TRACE_KINDS)}.indexOf(e.kind) >= 0;
   }))`;

/** One `settle-arm` record, as the declined-arms leg reads it. */
interface ArmRecord {
  kind: string;
  landing?: string;
  outcome?: string;
  reason?: string;
}

/**
 * The arms a switch produced, in order, from the SWAP COMMIT onward.
 *
 * The swap commit is the one that spells itself `"cut"`, and it is where the
 * switch epoch opens. Everything from there to the end of the window read is
 * inside the switch as far as the canvas is concerned, and `[B03]` says none
 * of it may animate — so this is the slice the claim below is made over.
 *
 * An empty answer when no `"cut"` arm is present at all, which is itself a
 * finding: a switch that never reached the canvas as a cut is a different
 * defect and the caller says so rather than passing vacuously.
 */
function armsFromSwap(trace: string): ArmRecord[] {
  const events = JSON.parse(trace) as ArmRecord[];
  const arms = events.filter((e) => e.kind === "settle-arm");
  const swap = arms.findIndex((a) => a.landing === "cut");
  return swap < 0 ? [] : arms.slice(swap);
}

/**
 * How long the cover may be held before it dissolves over whatever the
 * arriving workspace has.
 *
 * Mirrored from `SPACE_QUIET_BOUND_MS` in `tugdeck/src/lib/space-quiet.ts`
 * rather than imported: an app-test is a separate program driving the built
 * app over a bridge, and it has no module graph in common with the deck. A
 * change to the constant that forgot this line would turn the assertion below
 * into a looser one, which is why the assertion states the number it is
 * holding to in its own message.
 */
const SPACE_QUIET_BOUND_MS = 200;

/**
 * How far past the bound a BOUND-path reading may land before it is a finding.
 *
 * The bound is a `setTimeout`, and a `setTimeout` fires no SOONER than its
 * delay — never earlier, routinely later. So a cover that came off on the
 * bound records a `quietMs` of 200-and-a-bit, and holding the bound path to
 * `<= 200` would be an assertion that is red exactly when the path it covers
 * is taken. That path is not a defect: a covered harness window suspends
 * `requestAnimationFrame`, the gate's frame counter rides it, and releasing on
 * the bound is the ruled behaviour ([B06]) rather than a failure.
 *
 * So the two paths are asserted at their own precisions. A `"quiet"` reading
 * is the product's own measurement and is held to the bound exactly. A
 * `"bound"` reading is a timer's, and what it has to show is that the cover
 * was BOUNDED at all — 50ms of slack for timer skew under load, which is far
 * short of the deadline that nets the whole beat.
 */
const SPACE_QUIET_BOUND_SLOP_MS = 50;

/** One `space-quiet` record — the cover's own account of itself ([P06]). */
interface QuietRecord {
  kind: string;
  toSpaceId?: string;
  quietMs?: number;
  quietReason?: string;
}

/**
 * The `space-quiet` record this switch wrote, or `undefined` when the gate
 * never fired at all — which is a failure rather than an absence, and the
 * caller says so.
 *
 * Matched on `toSpaceId` rather than taken as the last record in the window,
 * because the window is opened before the gesture and could in principle
 * still hold the tail of an earlier beat.
 */
function quietForSwitch(
  trace: string,
  toSpaceId: string,
): QuietRecord | undefined {
  const events = JSON.parse(trace) as QuietRecord[];
  return events
    .filter((e) => e.kind === "space-quiet" && e.toSpaceId === toSpaceId)
    .at(-1);
}

/** `left,top,width,height` reduced to the half this claim is about. */
function boxOf(rect: string): string {
  const [, , width, height] = rect.split(",");
  return `${width}x${height}`;
}

/**
 * Every named pane whose box CHANGED SIZE between the first frame it was seen
 * at and the last, rendered for a failure message — empty when the arriving
 * deck came up at the size it settled at.
 *
 * A pane the sampler never saw is reported too, because a claim made over an
 * id that was never on screen is a claim made over nothing.
 */
function paneSizeDrifts(
  reading: Reading,
  paneIds: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of paneIds) {
    const box = reading.paneBoxes[id];
    if (box === undefined) {
      out.push(`${id} was never sampled`);
      continue;
    }
    if (boxOf(box.first) !== boxOf(box.last)) {
      out.push(`${id} ${boxOf(box.first)} -> ${boxOf(box.last)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * One pane frame's painted width right now, or `-1` when it is not on screen.
 *
 * Read off the SHOWN layer between gestures rather than out of the sampler,
 * because the question it answers is about the state the deck has come to
 * rest in, not about anything that happened during a beat.
 */
const paneWidthNow = (app: App, paneId: string): Promise<number> =>
  app.evalJS<number>(
    `(function () {
       var el = document.querySelector(
         ${JSON.stringify(SHOWN_LAYER)} +
         ' .tug-pane[data-pane-id="' + ${JSON.stringify(paneId)} + '"]');
       return el === null ? -1 : Math.round(el.getBoundingClientRect().width);
     })()`,
  );

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
 * Two workspaces, each standing its own Workspaces card, two SESSION cards and
 * one text card.
 *
 * Session cards rather than text cards on both sides, and deliberately: the
 * composer's line box, the sheets' two clamps and the transcript's row window
 * are three of the seven re-arm sites the arc is looking for, and none of them
 * exists on a text card. The text card is the control — a pane with none of
 * that machinery in it, in the same switch.
 */
function twoSpaceBlob(): Record<string, unknown> {
  const deck = (
    cardsId: string,
    railId: string,
    sessions: readonly string[],
    textId: string,
    paneBase: string,
  ): Record<string, unknown> => ({
    cards: [
      { id: cardsId, componentId: "cards", title: "Workspaces", closable: true },
      ...sessions.map((id) => ({
        id,
        componentId: "session",
        title: id,
        closable: true,
      })),
      { id: textId, componentId: "text", title: textId, closable: true },
    ],
    panes: [
      railPane(railId, cardsId),
      ...sessions.map((id, i) => contentPane(`${paneBase}${i}`, id, 40 + i * 300)),
      contentPane(`${paneBase}t`, textId, 40 + sessions.length * 300),
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
        deck: deck("at0620-c1", "at0620-pc1", SESSIONS_ONE, "at0620-t1", "at0620-pa"),
      },
      {
        id: SPACE_TWO,
        name: "Two",
        deck: deck("at0620-c2", "at0620-pc2", SESSIONS_TWO, "at0620-t2", "at0620-pb"),
      },
    ],
  };
}

/**
 * Append `HIDDEN_TURNS` complete turns to each named card, in ONE page-side
 * loop.
 *
 * One `evalJS` rather than one per frame: three drives per turn across two
 * cards is several hundred round trips otherwise, and the wall clock of the
 * RPC would dominate a fixture step. `driveSession` on the surface is
 * synchronous and returns `void`, so the loop is exactly what the harness verb
 * would have done, without the transport between each step. Every drive is
 * guarded — a card whose services are not up yet reports rather than throwing
 * the whole fixture out, because this step must be green whatever it finds.
 */
const streamScript = (cardIds: readonly string[]): string =>
  `(function () {
  var ids = ${JSON.stringify(cardIds)};
  var out = { sent: 0, errors: [] };
  for (var c = 0; c < ids.length; c++) {
    var cardId = ids[c];
    var sid = "at0620-session-" + cardId;
    for (var i = 0; i < ${HIDDEN_TURNS}; i++) {
      var msgId = "m-" + cardId + "-" + i;
      try {
        window.__tug.driveSession(cardId, {
          op: "send", text: "hidden row " + i, suppress: true,
        });
        window.__tug.driveSession(cardId, {
          op: "ingestFrame", feedId: ${FEED_CODE_OUTPUT},
          decoded: {
            type: "assistant_text", tug_session_id: sid, msg_id: msgId,
            text: "a reply written while nobody was looking, number " + i,
            is_partial: false, rev: 0, seq: 0,
          },
        });
        window.__tug.driveSession(cardId, {
          op: "ingestFrame", feedId: ${FEED_CODE_OUTPUT},
          decoded: {
            type: "turn_complete", tug_session_id: sid, msg_id: msgId,
            result: "success",
          },
        });
        out.sent += 1;
      } catch (e) {
        if (out.errors.length < 3) {
          out.errors.push(cardId + ": " + String(e && e.message ? e.message : e));
        }
      }
    }
  }
  return out;
})()`;

/**
 * Set the mount root's width outright, and report what took on both boxes —
 * the root the manager measures, and the canvas background the picture is
 * drawn over, which follows it.
 */
const resizeScript = (width: number): string =>
  `(function () {
  var root = document.querySelector(${JSON.stringify(DECK_CONTAINER)});
  var canvas = document.querySelector(${JSON.stringify(CANVAS_CONTAINER)});
  if (root === null || canvas === null) return { ok: false };
  var before = Math.round(root.getBoundingClientRect().width);
  var canvasBefore = Math.round(canvas.getBoundingClientRect().width);
  root.style.width = ${JSON.stringify(`${width}px`)};
  return {
    ok: true, before: before,
    after: Math.round(root.getBoundingClientRect().width),
    canvas: canvasBefore + " -> " +
      Math.round(canvas.getBoundingClientRect().width),
  };
})()`;

const RESIZE_RESTORE = `(function () {
  var el = document.querySelector(${JSON.stringify(DECK_CONTAINER)});
  if (el !== null) el.style.width = "";
  return null;
})()`;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * One switch, sampled end to end: install, gesture, wait for the swap, wait
 * for the beat to hand its attribute back, then sit for well past any beat the
 * switch could have launched so the sampler has seen the late writes this file
 * is for.
 */
async function recordSwitch(
  app: App,
  label: string,
  toSpaceId: string,
): Promise<{ reading: Reading; trace: string }> {
  const mark = await app.evalJS<number>(
    `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
  );
  await app.evalJS<null>(SAMPLER_START);
  await app.evalJS<null>(
    `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(toSpaceId)} }), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(toSpaceId)}`,
    { timeoutMs: 15_000 },
  );
  // A beat that never lands leaves the attribute standing; waiting for it to
  // go is how that becomes visible rather than silently folded into the
  // 900ms below.
  try {
    await app.waitForCondition<boolean>(
      `document.querySelectorAll(${JSON.stringify(CROSSING_LAYERS)}).length === 0`,
      { timeoutMs: CROSSING_BOUND_MS },
    );
  } catch {
    note(`at0620 ${label}: the crossing attribute still stood after ${CROSSING_BOUND_MS}ms`);
  }
  await settle(900);

  const reading = await app.evalJS<Reading>(SAMPLER_READ);
  const trace = await app.evalJS<string>(traceRead(mark));
  note(`at0620 ${label} canvas: ${JSON.stringify(reading)}`);
  note(`at0620 ${label} trace: ${trace}`);
  // The debt is paid ([L32]). The mark stands from the swap commit to the
  // canvas's own layout-effect pass, and by now the switch is a second in the
  // past — a mark still standing here is a canvas on which nothing will ever
  // animate again, which is the failure mode a deferred reveal with no
  // deadline always has. Asserted inside the helper so every one of the six
  // runs is held to it rather than only the last.
  expect(
    await app.evalJS<number>(
      `document.querySelectorAll(${JSON.stringify(SWITCHING_MARK)}).length`,
    ),
    `${label}: the switch epoch was handed back`,
  ).toBe(0);
  // And the cover with it. The beat now starts LATER than it used to — the
  // hold runs first — so this is the reading that says the whole of it still
  // lands inside the window this helper waits out, rather than the crossing
  // attribute being left standing over the workspace the user is looking at.
  expect(
    await app.evalJS<number>(
      `document.querySelectorAll(${JSON.stringify(CROSSING_LAYERS)}).length`,
    ),
    `${label}: the cover came off`,
  ).toBe(0);
  return { reading, trace };
}

describe.skipIf(!SHOULD_RUN)(
  "at0620 — a workspace switch, recorded before it is changed",
  () => {
    test(
      "six switches across three conditions, sampled frame by frame",
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
          testName: "at0620-workspace-switch-quiet",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHOWN_FRAMES)}).length >= 4`,
            { timeoutMs: 30_000 },
          );
          await settle(800);

          // ---- Condition 1: plain. ---------------------------------------
          // First, so it is also what mounts the parked workspace — every
          // condition after this one crosses between two workspaces whose
          // cards are already standing, which is the state [B06] leaves the
          // deck in for every switch but the first.
          const plainTo = await recordSwitch(app, "plain A->B", SPACE_TWO);
          await settle(600);
          const plainBack = await recordSwitch(app, "plain B->A", SPACE_ONE);
          await settle(600);

          // ---- Condition 2: streamed while hidden. -----------------------
          const allSessions = [...SESSIONS_ONE, ...SESSIONS_TWO];
          for (const cardId of allSessions) {
            await app.bindSession(cardId, { tugSessionId: sessionIdFor(cardId) });
          }
          await settle(600);

          // Workspace Two is hidden here: fill ITS cards, then cross to it.
          const fillTwo = await app.evalJS<{ sent: number; errors: string[] }>(
            streamScript(SESSIONS_TWO),
          );
          note(`at0620 streamed into the hidden Two: ${JSON.stringify(fillTwo)}`);
          await settle(600);
          const streamTo = await recordSwitch(app, "streamed A->B", SPACE_TWO);
          await settle(600);

          // Now One is the hidden one. Same again, the other way.
          const fillOne = await app.evalJS<{ sent: number; errors: string[] }>(
            streamScript(SESSIONS_ONE),
          );
          note(`at0620 streamed into the hidden One: ${JSON.stringify(fillOne)}`);
          await settle(600);
          const streamBack = await recordSwitch(app, "streamed B->A", SPACE_ONE);
          await settle(600);

          // ---- Condition 3: resized while hidden. ------------------------
          // The band the parked deck's offsets were written against is gone.
          // `RESIZE_RETUNE_QUIET_MS` is 200; the wait is well past it, so the
          // re-tune has landed and settled before the gesture.
          const shrink = await app.evalJS<Record<string, unknown>>(
            resizeScript(900),
          );
          note(`at0620 canvas shrunk before A->B: ${JSON.stringify(shrink)}`);
          await settle(900);
          // What the allocator solves a rail to at THIS canvas, read off the
          // workspace that is standing in it. The two workspaces are the same
          // deck twice over — one rail of the same kind, the same content run
          // beside it — so the rail the outgoing workspace has come to rest at
          // is the width the incoming one is owed.
          const solvedAt900 = await paneWidthNow(app, "at0620-pc1");
          note(`at0620 rail solved at a 900px canvas: ${solvedAt900}px`);
          const resizedTo = await recordSwitch(app, "resized A->B", SPACE_TWO);
          await settle(600);

          const grow = await app.evalJS<Record<string, unknown>>(
            resizeScript(1_180),
          );
          note(`at0620 canvas grown before B->A: ${JSON.stringify(grow)}`);
          await settle(900);
          const solvedAt1180 = await paneWidthNow(app, "at0620-pc2");
          note(`at0620 rail solved at a 1180px canvas: ${solvedAt1180}px`);
          const resizedBack = await recordSwitch(app, "resized B->A", SPACE_ONE);
          await app.evalJS<null>(RESIZE_RESTORE);

          // ---- The arriving deck is already solved ([P04]). ---------------
          //
          // The resized-while-hidden condition's own claim, and the only one
          // in this file made off the pixels rather than out of the trace.
          //
          // A parked workspace's deck is solved against the canvas it was
          // parked from; the window moved while it was away. The rail's width
          // is a number in `deckState` rather than CSS over the band, so it
          // arrives at the remembered width — and NOTHING corrects it, which
          // is the half of this the reverse-diff probe had to teach: the
          // settled-resize re-tune answers only for the workspace that is
          // standing when a resize lands, so an arriving deck that is wrong is
          // wrong until the user resizes the window again.
          //
          // So the claim is made twice over. The rail must ARRIVE at the width
          // this canvas solves for — read off the outgoing workspace, which is
          // the same deck twice over and has just come to rest at it — and it
          // must not move afterwards.
          for (const { label, run, paneId, solved } of [
            { label: "resized A->B", run: resizedTo, paneId: "at0620-pc2", solved: solvedAt900 },
            { label: "resized B->A", run: resizedBack, paneId: "at0620-pc1", solved: solvedAt1180 },
          ]) {
            const box = run.reading.paneBoxes[paneId];
            expect(box, `${label}: the arriving rail was sampled`).toBeDefined();
            expect(
              Number(box?.first.split(",")[2]),
              `${label}: the arriving rail came up at the width this canvas ` +
                `solves for (${solved}px) rather than the one it was parked at`,
            ).toBe(solved);
          }

          // And nothing moved after it arrived.
          //
          // Width and height only. Position is expected to move: the crossing
          // layer is laid over the canvas and `left` follows the rail's own
          // re-solve, neither of which this claim is about.
          for (const [label, run, arriving] of [
            ["resized A->B", resizedTo, PANES_TWO],
            ["resized B->A", resizedBack, PANES_ONE],
          ] as const) {
            const boxes = Object.entries(run.reading.paneBoxes)
              .map(([id, b]) => `${id} ${boxOf(b.first)}->${boxOf(b.last)}`)
              .join(" | ");
            note(`at0620 ${label} pane boxes: ${boxes}`);
            expect(
              paneSizeDrifts(run.reading, arriving),
              `${label}: every arriving pane came up at the size it settled at`,
            ).toEqual([]);
          }

          // ---- The answer rAF owes this arc. -----------------------------
          //
          // Every run, with the workspace it arrived in — which is what the
          // `space-quiet` record is keyed by.
          const SWITCHES = [
            { label: "plain A->B", run: plainTo, to: SPACE_TWO },
            { label: "plain B->A", run: plainBack, to: SPACE_ONE },
            { label: "streamed A->B", run: streamTo, to: SPACE_TWO },
            { label: "streamed B->A", run: streamBack, to: SPACE_ONE },
            { label: "resized A->B", run: resizedTo, to: SPACE_TWO },
            { label: "resized B->A", run: resizedBack, to: SPACE_ONE },
          ];
          const runs = SWITCHES.map((s) => s.run);
          const readings = runs.map((r) => r.reading);
          const rafTotal = readings.reduce((n, r) => n + r.rafTicks, 0);
          const sampleTotal = readings.reduce((n, r) => n + r.samples, 0);
          note(
            `at0620 rAF across six switches: ${rafTotal} animation frames against ` +
            `${sampleTotal} interval samples — ${rafTotal === 0 ? "SUSPENDED" : "TICKING"}`,
          );
          const lateMoves = readings
            .map((r, i) => `${i}: ${r.panes.movedAfterCross.length} pane / ` +
              `${r.scrollers.movedAfterCross.length} scroll / ` +
              `${r.clamps.movedAfterCross.length} clamp / ` +
              `${r.lineBoxes.movedAfterCross.length} line-box`)
            .join(" | ");
          note(`at0620 changes landing after the beat, per run — ${lateMoves}`);

          // ---- Nothing animates under the switch epoch ([P02], [B03]). ----
          //
          // The claim the mark exists to make, read out of the trace rather
          // than off the pixels: from the SWAP COMMIT — the one arm that
          // spells itself `"cut"` — to the end of the window, no arm may have
          // CARRIED. `landing` still carries each commit's own word, so an arm
          // that asked to cross and was refused reads `landing: "cross",
          // outcome: "unarmed", reason: "switching"`, which is exactly the
          // record that says the epoch and not the commit answered it.
          //
          // Read from the swap rather than from the top of the window because
          // the window opens before the gesture: an arm recorded ahead of the
          // `"cut"` belongs to whatever the deck was doing beforehand, and it
          // is not this claim's to judge.
          for (const { label, run } of SWITCHES) {
            const arms = armsFromSwap(run.trace);
            const rendered = arms
              .map((a) => `${a.landing}/${a.outcome}${a.reason ? `:${a.reason}` : ""}`)
              .join(" ");
            note(`at0620 ${label} arms from the swap: ${rendered || "none"}`);
            expect(
              arms.length,
              `${label}: the switch reached the canvas as a cut`,
            ).toBeGreaterThan(0);
            expect(
              arms.filter((a) => a.outcome === "carried"),
              `${label}: no arm from the swap commit onward carried ` +
                `(arms: ${rendered})`,
            ).toEqual([]);
            // And the swap's own decline names the rule that answered it, so a
            // reader can tell the commit's word from the epoch's.
            expect(
              arms[0]?.reason,
              `${label}: the swap commit declined as a cut`,
            ).toBe("cut");
          }

          // ---- The switch lands still: the success criteria, asserted. ----
          //
          // These four were readings while nobody knew which of the seven
          // re-arm sites actually moved. They are assertions now, one per
          // criterion, over all six runs — the same six the recording took.
          for (const { label, run, to } of SWITCHES) {
            const r = run.reading;

            // Nothing measured is worth anything if the sampler never ran, so
            // this comes first and the rest are read as measurements.
            expect(
              r.samples,
              `${label}: the sampler ticked across the switch`,
            ).toBeGreaterThan(10);
            expect(
              r.panes.keys,
              `${label}: the sampler saw the shown layer's frames`,
            ).toBeGreaterThan(0);

            // (1) Nothing moves after the beat. `afterCross` counts changes
            // landing more than one sample interval past the last sample at
            // which any layer still carried the crossing attribute, and the
            // window runs ~900ms past that point — so this is the 400ms the
            // criterion asks for and then some. Rect keys only: opacity is
            // criterion (2)'s, and reading it here would conflate a fade with
            // a move.
            const movedRects = r.panes.movedAfterCross.filter((k) =>
              k.includes("|rect"),
            );
            expect(
              movedRects,
              `${label}: no pane frame moved or resized after the dissolve`,
            ).toEqual([]);

            // (2) The arriving workspace is never faded. Two halves, because
            // a frame held at zero for the whole window changes zero times: a
            // MINIMUM over computed opacity, and the inline hold the settle's
            // arrive beat writes.
            expect(
              r.minOpacity,
              `${label}: every shown pane frame stayed fully opaque ` +
                `(lowest at ${r.minOpacityAt})`,
            ).toBe(1);
            expect(
              r.inlineZero,
              `${label}: no shown pane frame was held at an inline opacity 0`,
            ).toEqual([]);

            // (3) The cover was held, and it was held inside the bound
            // ([P06]). `quietReason` is NOTED rather than asserted, and that
            // is deliberate: the quiet path's frame counter rides
            // `requestAnimationFrame`, a covered window suspends rAF, and a
            // test asserting `"quiet"` would be red on a busy desktop for a
            // reason that is the window manager rather than the product. The
            // rule's own proof is the unit test over `spaceDissolveDue`.
            //
            // But the two paths cannot be held to one number. A `"bound"`
            // reading is a `setTimeout`'s, and a `setTimeout` fires no sooner
            // than its delay — so `<= SPACE_QUIET_BOUND_MS` on that path is an
            // assertion that is red precisely when the occlusion the note
            // above describes actually happens. Each path is therefore held to
            // its own precision ({@link SPACE_QUIET_BOUND_SLOP_MS}).
            const quiet = quietForSwitch(run.trace, to);
            note(
              `at0620 ${label} cover: ${quiet === undefined ? "NO RECORD" : `${quiet.quietMs}ms via ${quiet.quietReason}`}`,
            );
            expect(
              quiet,
              `${label}: the cover recorded what lifted it`,
            ).toBeDefined();
            const quietCeiling =
              quiet?.quietReason === "bound"
                ? SPACE_QUIET_BOUND_MS + SPACE_QUIET_BOUND_SLOP_MS
                : SPACE_QUIET_BOUND_MS;
            expect(
              quiet?.quietMs ?? Number.POSITIVE_INFINITY,
              `${label}: the cover came off inside ${quietCeiling}ms ` +
                `(via ${quiet?.quietReason ?? "no record"}; the bound is ` +
                `${SPACE_QUIET_BOUND_MS}ms)`,
            ).toBeLessThanOrEqual(quietCeiling);

            // (4) No scroller under the shown layer moved ([Q02]).
            //
            // Read honestly: `scrollers.keys` is the count of overflowing
            // scrollers the sampler found, and it has been ZERO in every run
            // this fixture has ever taken — the session cards' transcripts do
            // not overflow at this size. So this assertion is vacuous on this
            // fixture, and the count is asserted alongside it so a reader can
            // see that rather than infer a proof. The gap is named in the
            // findings paper; closing it needs a fixture whose transcript
            // actually overflows.
            note(`at0620 ${label} scrollers tracked: ${r.scrollers.keys}`);
            expect(
              r.scrollers.moved.filter((k) => k.includes("|scrollTop")),
              `${label}: no scroller under the shown layer moved`,
            ).toEqual([]);
          }

          // And the switch completed.
          expect(
            await app.evalJS<string>(
              `window.tugdeck.diag.getSpaces().activeSpaceId`,
            ),
            "the last switch landed in workspace One",
          ).toBe(SPACE_ONE);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

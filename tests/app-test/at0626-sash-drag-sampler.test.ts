/**
 * at0626-sash-drag-sampler.test.ts — the instrument for a sash drag between
 * two loaded session cards, and the two things it holds the drag to.
 *
 * ## What this is for
 *
 * Dragging the sash between two split cards lags the pointer by several
 * frames and judders. The previous arc held the divided members' interiors
 * still for the gesture's length and measured that on a rail of two small
 * sidebar cards, where the cost that scales with a real deck — two Retina
 * repaints of two composited card layers per frame — is not paid. Its sampler
 * read the seam's rect inside a `requestAnimationFrame` tick, after the drag's
 * own rAF had already published the fraction, so the seam was always exactly
 * where the last event put it by construction, and the lag assertion could
 * not fail.
 *
 * This file is the instrument that can. It drives a real pointer down the
 * seam between two SESSION cards standing split in one column — the shape the
 * user's deck reproduces the defect on — with the trail posted at the
 * display's own interval rather than the harness's 20ms floor, and records:
 *
 *   - a `setTimeout` heartbeat, tick after tick, whose gap is how long the
 *     main thread was away from the task queue. A rendering update that
 *     overran its frame is a gap longer than the frame. Timer-driven rather
 *     than rAF-driven because a covered harness window suspends
 *     `requestAnimationFrame` and a rAF sampler then reads nothing at all.
 *     The gap overstates the block by up to the timer's own period — an
 *     idle heartbeat here runs about every 8ms — which is why the bar is
 *     1.5× the interval rather than the interval itself: a gap of one
 *     interval plus one timer period is a frame that fit; a gap of one and a
 *     half intervals is a frame that did not;
 *   - the frame's rendering cost, taken with the motion guard's own
 *     `sampleFrame` reading (`lib/motion-guard/render-cost-probe.ts`) — the
 *     interval from a rAF callback to the first task after it, which brackets
 *     style, layout and compositing. The same reading `tugtool deck motion
 *     cost` takes on a release deck, so the number here and the number the
 *     user takes on their own deck are one reading. It is taken in the page
 *     in `sampleFrame`'s own shape rather than through
 *     `window.__tugMotion.cost(1)`, because `cost` follows every burst with a
 *     one-second at-rest window, which would leave a drag of a few seconds
 *     with two or three samples;
 *   - every `pointermove` a capture listener of ours sees, against the number
 *     of `mouseDragged` events the trail posted — what WebKit's event merger
 *     coalesced, observed rather than avoided;
 *   - every `ResizeObserver` delivery and every DOM mutation inside the
 *     divided members, on the boxes a still crossing holds, carried over from
 *     the previous arc's instrument because the hold it proved is still the
 *     hold this drag rides.
 *
 * ## What it asserts
 *
 * **No overrun frame ([B06]).** Across the held window — from one display
 * interval after the mark goes on (the mark's own layout is a real delivery
 * and lands before the first held frame paints, `at0605`'s reason) to the last
 * tick the members are held — no heartbeat gap is longer than 1.5× the
 * display interval. A drag whose every frame lands is one whose seam is one
 * rendering update behind the hand and no more, which is the bar a DOM sash
 * can reach ([F01]).
 *
 * **Render cost under the interval ([B06]).** The p95 of the rendering costs
 * sampled inside the held window is under the display interval. This is the
 * gauge's own budget, stated against the display the run is on rather than
 * against the 60Hz constant.
 *
 * **The box is the pin.** On every held tick each member's laid-out height is
 * the inline px height the drag wrote on it. The pin is written in the
 * pointer handler; what the eye sees is the box, and anything animating
 * `height` — `chrome.css`'s window-shade transition, a settle beat — outranks
 * the inline value for as long as it runs and puts the box behind the hand.
 *
 * **The hold stands and every exit releases it.** The card roots take exactly
 * one layout, at the mark; nothing inside either transcript is resized or
 * committed while the hold is on; and none of a released drag, a press that
 * never travelled, or a cancel leaves a member marked ([B03], [L27]).
 *
 * The display interval is read off an idle `requestAnimationFrame` control
 * before the gesture and reported with every reading, because 16.7ms and
 * 8.3ms are different bars and the number is only meaningful beside its
 * interval.
 *
 * ## Why not the seam's position
 *
 * A rect read from inside the page sees the DOM, not the screen: the seam is
 * always where the last handled event put it, and the pipeline from there to
 * the display — the layer commit, the CoreAnimation transaction, the vsync —
 * is what the eye is actually behind. So this file does not assert "pinned";
 * it asserts the two things in the page that make the pipeline's residual the
 * whole of the lag, and reports the rest.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/styles/chrome.css
 * @covers tugdeck/src/lib/motion-guard/render-cost-probe.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

/** Room past the settle attribute clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 900;

/**
 * The session cards' width. A composited card layer whose bounds change is
 * repainted whole, so the per-frame cost of the drag scales with the card's
 * area ([F06]) — and a session card on a working deck is a wide one. 1000px
 * is a comfortable session card on this harness window, not a stretch.
 */
const PANE_WIDTH = 1000;
/**
 * The window content height asked for. A session card's floor is 600px, so
 * two of them standing split need a column run past 1200px before the seam
 * between them can move at all, and the harness's default 80%-of-screen
 * window is about 1050px tall on a 1800px-tall display. The ask is clamped to
 * the screen; what the window actually took is noted, and the fixture is
 * checked for room before the drag rather than read as a drag that did not
 * travel.
 */
const WINDOW_HEIGHT = 1700;

/**
 * The CSS height the column needs: two 600px floors, the drag and its 20px
 * margin, and the canvas's own insets, with a little to spare. A window that
 * takes less — the ask is clamped to the screen, and a laptop's built-in
 * display gives about 1250px — is zoomed out until its content holds this many
 * CSS px (`setPageZoom`, for this launch only). The cards are widened by the
 * same factor, so each still covers the screen area it would at 1.0: a
 * frame's repaint cost scales with that area ([F06]), and a zoomed-out card
 * that shrank with the zoom would be read against a cheaper drag. On a tall
 * enough display the zoom stays 1.0 and nothing here changes.
 */
const COLUMN_CSS_HEIGHT = 1400;

/** The two session cards, upper then lower, standing split in slot 0 — the
 *  members the seam divides, and the ones every reading is about. */
const DIVIDED = ["S1", "S2"] as const;
/** Every session card on the deck: the divided pair and a third standing
 *  alone in slot 1, so the deck around the seam is a working deck's. */
const SESSIONS = ["S1", "S2", "S3"] as const;
type SessionId = (typeof SESSIONS)[number];
const PANE_OF: Record<SessionId, string> = { S1: "pS1", S2: "pS2", S3: "pS3" };
const SLOT_OF: Record<SessionId, number> = { S1: 0, S2: 0, S3: 1 };
const RAIL_WIDTH = 420;
/** Jot rows seeded into an isolated `jots.json`, so the rail's Jots card is
 *  a real list rather than an empty one. */
const JOT_COUNT = 40;
/** Turns seeded into each transcript — enough that each card is a real,
 *  overflowing transcript with real rows rather than an empty session. */
const TURNS = 24;

/** How far the sash travels, px. Inside the floors either side of it, so the
 *  drag lands where it was aimed rather than against a clamp. */
const DRAG_PX = 120;
/** Trail steps. At one step per display interval this is a drag of about
 *  0.8s on a 120Hz display and 1.6s on a 60Hz one — long enough to hold
 *  dozens of frames and dozens of render-cost samples. */
const DRAG_STEPS = 96;

/** A session card's registered floor, px — `session-card-registration.tsx`. */
const SESSION_FLOOR_PX = 600;

/** An overrun frame is a heartbeat gap this many display intervals long. */
const OVERRUN_FACTOR = 1.5;

/**
 * How long after the mark goes on the asserted window opens. The mark's own
 * layout is a real delivery, and a windowed transcript answers it with a
 * commit or two of its own over the next frames — re-windowed rows, a
 * re-pinned bottom. Those are the mark's consequence, not a per-frame cost,
 * and the window the hold owes starts once they have landed.
 */
const MARK_SETTLE_MS = 60;

/** The refresh rates a display might run at, Hz, for snapping the idle
 *  control's median to the interval it is evidently measuring. */
const KNOWN_RATES_HZ = [120, 90, 60, 50, 30] as const;

/** The card ROOT a still crossing holds at a definite height — the pane-level
 *  rule is `[data-card-host] > *`, and for a session card that is this. */
const ROOT = '[data-slot="session-card"]';
const LIST = '[data-slot="tug-list-view"]';

const SEAM = `[data-column-seam="0:0"]`;

const sid = (card: SessionId): string => `at0626-session-${card}`;
const pane = (card: SessionId): string =>
  `.tug-pane[data-pane-id="${PANE_OF[card]}"]`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Two session cards sharing slot 0, split, with no stored shares; a third
 *  session card in slot 1; and a right rail of Cards, Jots and Layout — the
 *  deck a working session sits in, so the frame's cost is the deck's. */
function deckShape(paneWidth: number) {
  const railPane = (id: string, cardId: string, title: string) => ({
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  });
  return {
    cards: [
      ...SESSIONS.map((id) => ({
        id,
        componentId: "session",
        title: `Session ${id}`,
        closable: true,
      })),
      { id: "C", componentId: "cards", title: "Cards", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...SESSIONS.map((id) => ({
        id: PANE_OF[id],
        position: { x: 40, y: 40 },
        size: { width: paneWidth, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: SLOT_OF[id],
      })),
      railPane("pCards", "C", "Cards"),
      railPane("pJots", "J", "Jots"),
      railPane("pLayout", "L", "Layout"),
    ],
    activePaneId: PANE_OF.S1,
    imposition: {
      kind: "three-up",
      columns: { 0: { mode: "split" } },
      sidebars: {
        cards: { side: "right" },
        jots: { side: "right" },
        layout: { side: "right" },
      },
      rails: { right: { order: ["cards", "jots", "layout"] } },
    },
    hasFocus: true,
  };
}

/** A `jots.json` with enough rows that the Jots card is a real list. */
function seedJotsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "at0626-jots-"));
  const path = join(dir, "jots.json");
  const jots = Array.from({ length: JOT_COUNT }, (_, n) => ({
    id: `at0626-jot-${n}`,
    text:
      `Jot ${n} — a line of prose long enough to wrap in a rail-width card, ` +
      `so the row has a real intrinsic height.`,
  }));
  writeFileSync(path, `${JSON.stringify({ version: 1, jots }, null, 2)}\n`);
  return path;
}

async function seedTurn(app: App, card: SessionId, n: number): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession(card, {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: sid(card), ...decoded },
    });
  const msgId = `${sid(card)}-m${n}`;
  await app.driveSession(card, { op: "send", text: `prompt ${n}` });
  await frame({ type: "prompt_anchor", promptUuid: `${sid(card)}-u${n}` });
  await frame({
    type: "content_block_start",
    msg_id: msgId,
    block_index: 0,
    kind: "text",
  });
  await frame({
    type: "assistant_text",
    msg_id: msgId,
    block_index: 0,
    text:
      `## step ${n}\n\n` +
      `Reply number ${n}, long enough to take several lines in a card of ` +
      `this width, with a second paragraph so the row has real height.\n\n` +
      `- one thing it found\n- another thing it decided\n- a third it left ` +
      `open, stated at length so the list wraps too.\n\n` +
      "```\n$ some command\nsome output, a few lines of it\nand another\n```\n",
    is_partial: false,
  });
  await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
}

async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 12_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

/** Stand the column up, bind the sessions, load them, and let it all land. */
async function openColumn(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  const took = await app.setWindowContentSize({ height: WINDOW_HEIGHT });
  const zoom =
    took.height >= COLUMN_CSS_HEIGHT
      ? 1
      : await app.setPageZoom(Math.floor((took.height / COLUMN_CSS_HEIGHT) * 100) / 100);
  const paneWidth = Math.round(PANE_WIDTH / zoom);
  note(
    "at0626 window",
    `content ${took.width}×${took.height} (asked for a height of ${WINDOW_HEIGHT}); ` +
      `page zoom ${zoom.toFixed(2)}, so ${Math.round(took.height / zoom)} CSS px tall ` +
      `and session cards ${paneWidth}px wide`,
  );
  await app.seedDeckState({ state: deckShape(paneWidth), focusCardId: "S1" });
  for (const card of SESSIONS) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(card)})`,
      { timeoutMs: 30_000 },
    );
  }
  for (const card of SESSIONS) {
    await app.bindSession(card, { tugSessionId: sid(card) });
    await app.awaitEngineReady(card, { timeoutMs: 30_000 });
  }
  for (const card of SESSIONS) {
    for (let n = 0; n < TURNS; n += 1) await seedTurn(app, card, n);
  }
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(SEAM)}).length === 1`,
    { timeoutMs: 10_000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 3 &&
     document.querySelector('.jots-card .jot-row-label') !== null`,
    { timeoutMs: 20_000 },
  );
  await settled(app);
}

/** Both members' standing heights, and the room above their floors. */
async function columnRoom(app: App): Promise<{ heights: number[]; slack: number }> {
  const heights = await app.evalJS<number[]>(
    `${JSON.stringify(DIVIDED.map((c) => pane(c)))}.map(function (sel) {
      return document.querySelector(sel).getBoundingClientRect().height;
    })`,
  );
  return { heights, slack: heights.reduce((a, b) => a + b, 0) - SESSION_FLOOR_PX * heights.length };
}

/** One heartbeat tick, as the timer saw the page. */
interface Tick {
  /** `performance.now()` at the top of the tick. */
  t: number;
  /** Gap since the previous tick, ms — how long the thread was away. */
  gap: number;
  /** Whether the seam carried `data-gesture="seam"` on this tick. */
  gesture: boolean;
  /** How many of the divided members carried `data-still-crossing`. */
  marked: number;
  /**
   * The largest distance, over the divided members, between a member's
   * laid-out height and the inline px height the drag pinned on it — zero
   * on a tick where no member carries a px height. A box that reads other
   * than its pin is being animated by something that outranks inline style
   * in the cascade, which is the one way a pin can be written on time and
   * still be seen late.
   */
  lag: number;
}

/** One rendering-cost sample, from the gauge's own `sampleFrame`. */
interface Cost {
  t: number;
  costMs: number;
}

interface Event {
  t: number;
  member: string;
  box: string;
  /** What a mutation was — its type and target — for the record. */
  kind?: string;
}

interface Run {
  ticks: Tick[];
  costs: Cost[];
  /** `pointermove` events our capture listener saw, in time order. */
  moves: number[];
  deliveries: Event[];
  mutations: Event[];
  displacements: Record<string, number>;
}

/** The divided members' `data-scroll-displacements` counters, right now. */
function displacements(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(function () {
      var out = {};
      var panes = ${JSON.stringify(DIVIDED.map((c) => [c, pane(c)]))};
      panes.forEach(function (entry) {
        var el = document.querySelector(entry[1]);
        if (el === null) return;
        var list = el.querySelector(${JSON.stringify(LIST)});
        out[entry[0]] = list === null
          ? -1
          : Number(list.getAttribute("data-scroll-displacements") || "0");
      });
      return out;
    })()`,
  );
}

/**
 * The display interval, read off an idle `requestAnimationFrame` control.
 *
 * The one place this file uses rAF, because the display's own cadence is not
 * readable any other way from inside a page. Snapped to the nearest known
 * refresh rate: an idle 120Hz display reads 8.3ms with noise either side,
 * and the bar wants the interval, not the noise. Fails loudly, naming
 * occlusion, if the control reads nothing.
 */
async function displayInterval(
  app: App,
  ms: number,
): Promise<{ measuredMs: number; intervalMs: number; hz: number }> {
  await app.evalJS<null>(
    `(function () {
      var out = [];
      var t0 = performance.now();
      var last = t0;
      var tick = function () {
        var now = performance.now();
        out.push(now - last);
        last = now;
        if (now - t0 < ${ms}) requestAnimationFrame(tick);
      };
      window.__at0626idle = out;
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await wait(ms + 400);
  const gaps = await app.evalJS<number[]>(`window.__at0626idle.slice(1)`);
  if (gaps.length < 10) {
    throw new Error(
      `the idle control saw ${gaps.length} animation frame(s) in ${ms}ms. ` +
        `An occluded or minimised window suspends requestAnimationFrame ` +
        `outright — check the harness window is raised before reading this ` +
        `as a deck that stopped painting.`,
    );
  }
  const measuredMs = median(gaps);
  let hz: number = KNOWN_RATES_HZ[0];
  for (const rate of KNOWN_RATES_HZ) {
    if (Math.abs(1000 / rate - measuredMs) < Math.abs(1000 / hz - measuredMs)) {
      hz = rate;
    }
  }
  return { measuredMs, intervalMs: 1000 / hz, hz };
}

/**
 * Install the observers, the capture listener, the heartbeat and the cost
 * loop, and arm them.
 *
 * The `ResizeObserver` is installed and allowed its initial delivery BEFORE
 * the gesture — one always lands on `observe()` — and the record is armed
 * after them, so everything in it is a real size change.
 */
async function arm(app: App): Promise<void> {
  const observed = await app.evalJS<number>(
    `(function () {
      var panes = ${JSON.stringify(DIVIDED.map((c) => [c, pane(c)]))};
      var boxes = {
        content: ".tug-pane-content",
        root: ${JSON.stringify(ROOT)},
        list: ${JSON.stringify(LIST)},
      };
      var prior = window.__at0626;
      if (prior !== undefined) {
        prior.armed = false;
        if (prior.resize) prior.resize.disconnect();
        prior.mutators.forEach(function (m) { m.disconnect(); });
        document.removeEventListener("pointermove", prior.onMove, true);
      }
      var state = {
        ticks: [],
        costs: [],
        moves: [],
        deliveries: [],
        mutations: [],
        labels: new Map(),
        resize: null,
        mutators: [],
        onMove: null,
        armed: false,
        costLoopDone: false,
      };
      state.resize = new ResizeObserver(function (entries) {
        if (!state.armed) return;
        var now = performance.now();
        entries.forEach(function (entry) {
          var label = state.labels.get(entry.target);
          state.deliveries.push({ t: now, member: label.member, box: label.box });
        });
      });
      panes.forEach(function (entry) {
        var member = entry[0];
        var el = document.querySelector(entry[1]);
        if (el === null) return;
        Object.keys(boxes).forEach(function (box) {
          var target = el.querySelector(boxes[box]);
          if (target === null) return;
          state.labels.set(target, { member: member, box: box });
          state.resize.observe(target);
        });
        var list = el.querySelector(boxes.list);
        if (list === null) return;
        var mutator = new MutationObserver(function (records) {
          if (!state.armed) return;
          var r = records[0];
          var target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
          var kind = r.type === "attributes"
            ? "attr:" + r.attributeName
            : r.type + ":" + (r.addedNodes.length + r.removedNodes.length);
          state.mutations.push({
            t: performance.now(),
            member: member,
            box: "list",
            kind: kind + " on " + (target === null ? "?" : target.tagName.toLowerCase() +
              (target.className && typeof target.className === "string"
                ? "." + target.className.split(" ")[0]
                : "")),
          });
        });
        mutator.observe(list, { attributes: true, childList: true, subtree: true });
        state.mutators.push(mutator);
      });
      // Capture phase, on the document: the seam takes pointer capture, so the
      // events retarget to it, and a capture listener above it still sees
      // every one on its way down.
      state.onMove = function () {
        if (state.armed) state.moves.push(performance.now());
      };
      document.addEventListener("pointermove", state.onMove, true);
      window.__at0626 = state;
      return state.labels.size;
    })()`,
  );
  note("at0626 instrument", `observing ${observed} interior box(es)`);
  // The initial resize deliveries land on the next frame; let them, then arm.
  await wait(200);
  await app.evalJS<null>(
    `(function () {
      var state = window.__at0626;
      var seamSel = ${JSON.stringify(SEAM)};
      var panes = ${JSON.stringify(DIVIDED.map((c) => pane(c)))};
      state.armed = true;
      // The heartbeat. A nested timer clamps to 4ms after a few levels,
      // which is finer than any gap this file is about; what it records is
      // how long the thread was AWAY, and a rendering update that overran
      // its frame is exactly that.
      var last = performance.now();
      var beat = function () {
        if (!state.armed) return;
        var now = performance.now();
        var seam = document.querySelector(seamSel);
        var marked = 0;
        var lag = 0;
        panes.forEach(function (sel) {
          var el = document.querySelector(sel);
          if (el === null) return;
          if (el.hasAttribute("data-still-crossing")) marked += 1;
          // The box against its pin. A rect read here flushes layout at most
          // once per pointer move — the rendering update would have done the
          // same work a moment later — and it is the only reading that can
          // tell a pin written on time from a box that follows it late.
          if (/px$/.test(el.style.height)) {
            var box = el.getBoundingClientRect().height;
            lag = Math.max(lag, Math.abs(box - parseFloat(el.style.height)));
          }
        });
        state.ticks.push({
          t: now,
          gap: now - last,
          gesture: seam !== null && seam.getAttribute("data-gesture") === "seam",
          marked: marked,
          lag: lag,
        });
        last = now;
        setTimeout(beat, 0);
      };
      setTimeout(beat, 0);
      // The gauge's own reading, back to back for as long as the record is
      // armed: each sample is two frames and reports the second — the shape of
      // sampleFrame in render-cost-probe.ts, from a rAF callback to the first
      // task after it.
      var costLoop = function () {
        if (!state.armed) { state.costLoopDone = true; return; }
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            var start = performance.now();
            setTimeout(function () {
              state.costs.push({ t: performance.now(), costMs: performance.now() - start });
              costLoop();
            }, 0);
          });
        });
      };
      costLoop();
      return null;
    })()`,
  );
}

/** Disarm, let the cost loop finish its sample in flight, and read it all. */
async function harvest(app: App): Promise<Omit<Run, "displacements">> {
  await app.evalJS<null>(`(window.__at0626.armed = false, null)`);
  await app.waitForCondition<boolean>(`window.__at0626.costLoopDone === true`, {
    timeoutMs: 10_000,
  });
  return app.evalJS<Omit<Run, "displacements">>(
    `({
      ticks: window.__at0626.ticks,
      costs: window.__at0626.costs,
      moves: window.__at0626.moves,
      deliveries: window.__at0626.deliveries,
      mutations: window.__at0626.mutations,
    })`,
  );
}

/** How many of the divided members carry the still-crossing mark, right now. */
const markedCount = (app: App): Promise<number> =>
  app.evalJS<number>(
    `${JSON.stringify(DIVIDED.map((c) => pane(c)))}.filter(function (sel) {
      var el = document.querySelector(sel);
      return el !== null && el.hasAttribute("data-still-crossing");
    }).length`,
  );

const seamTop = (app: App): Promise<number> =>
  app.evalJS<number>(
    `document.querySelector(${JSON.stringify(SEAM)}).getBoundingClientRect().top`,
  );

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Nearest-rank percentile over a copy, the way the gauge's `summarize` does. */
const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};

const fmt = (x: number): string => x.toFixed(1);

describe.skipIf(!SHOULD_RUN)(
  "at0626 — a sash drag between two loaded session cards, held to the frame",
  () => {
    test(
      "no frame overruns and the render cost stays under the display interval",
      async () => {
        const jotsPath = seedJotsFile();
        const app = await launchTugApp({
          testName: "at0626-sash-drag-sampler",
          env: { TUG_JOTS_PATH: jotsPath },
        });
        try {
          await openColumn(app);

          const room = await columnRoom(app);
          note(
            "at0626 column",
            `members stand at ${room.heights.map(fmt).join(" / ")}px; ` +
              `${fmt(room.slack)}px of room above their floors`,
          );
          expect(
            room.slack,
            `the column has room for a ${DRAG_PX}px drag — a window too short ` +
              `for two session cards pins the seam where it stands`,
          ).toBeGreaterThanOrEqual(DRAG_PX + 20);

          const before = await displacements(app);
          const display = await displayInterval(app, 1_000);
          const { intervalMs } = display;
          const overrunMs = intervalMs * OVERRUN_FACTOR;
          note(
            "at0626 display",
            `idle animation frame median ${fmt(display.measuredMs)}ms, ` +
              `read as ${display.hz}Hz: interval ${fmt(intervalMs)}ms, ` +
              `overrun bar ${fmt(overrunMs)}ms`,
          );

          const box = await app.getElementBounds(SEAM);
          const from = {
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
          };
          const to = { x: from.x, y: from.y + DRAG_PX };
          const startTop = await seamTop(app);

          await arm(app);
          // One step per display interval: the trail arrives at a hand's rate.
          const stepMs = Math.round(intervalMs);
          await app.nativeDragElementWithoutRelease(SEAM, to, {
            interpolationSteps: DRAG_STEPS,
            interpolationDelayMs: stepMs,
          });
          await app.nativeMouseUp(to);
          await wait(1_000);

          const run: Run = {
            ...(await harvest(app)),
            displacements: await displacements(app),
          };
          const endTop = await seamTop(app);
          await settled(app);

          // ── The gesture's window, as the seam's own mark draws it ──────
          const held = run.ticks.filter((t) => t.gesture);
          expect(
            held.length,
            "the heartbeat recorded ticks while the seam was held",
          ).toBeGreaterThan(20);
          const opens = held[0].t;
          const closes = held[held.length - 1].t;
          const travel = endTop - startTop;
          note(
            "at0626 gesture",
            `${held.length} ticks over ${Math.round(closes - opens)}ms; ` +
              `trail posted ${DRAG_STEPS} moves ${stepMs}ms apart, ` +
              `the page saw ${run.moves.length}; ` +
              `seam travelled ${fmt(travel)}px of the ${DRAG_PX}px asked for`,
          );
          expect(
            travel,
            "the sash really travelled under the pointer",
          ).toBeGreaterThan(DRAG_PX / 2);

          // ── The held window ────────────────────────────────────────────
          //
          // From `MARK_SETTLE_MS` after the first tick both members are
          // marked to the last tick they are. The release takes the hold off
          // and the interior takes its one landing layout after that tick,
          // which is the hold ending rather than the hold failing.
          const marked = run.ticks.filter((t) => t.marked === DIVIDED.length);
          expect(
            marked.length,
            "both members are held for the length of the gesture",
          ).toBeGreaterThan(20);
          const markAt = marked[0].t;
          const holdOpens = markAt + MARK_SETTLE_MS;
          const holdCloses = marked[marked.length - 1].t;
          const inHold = <T extends { t: number }>(xs: T[]): T[] =>
            xs.filter((x) => x.t >= holdOpens && x.t <= holdCloses);

          // ── Overrun frames ─────────────────────────────────────────────
          const gaps = inHold(run.ticks).map((t) => t.gap);
          const overruns = gaps.filter((g) => g > overrunMs);
          const idleGaps = run.ticks
            .filter((t) => t.t > closes + 600)
            .map((t) => t.gap);
          note(
            "at0626 heartbeat",
            `held window ${Math.round(holdCloses - holdOpens)}ms, ${gaps.length} ticks: ` +
              `gap median ${fmt(median(gaps))}ms, p95 ${fmt(percentile(gaps, 0.95))}ms, ` +
              `max ${fmt(Math.max(...gaps))}ms; ` +
              `over the interval (${fmt(intervalMs)}ms): ` +
              `${gaps.filter((g) => g > intervalMs).length}/${gaps.length}; ` +
              `overruns (>${fmt(overrunMs)}ms): ${overruns.length}; ` +
              `after the release, idle gap median ${fmt(median(idleGaps))}ms ` +
              `max ${fmt(idleGaps.length === 0 ? 0 : Math.max(...idleGaps))}ms`,
          );

          // ── Render cost ────────────────────────────────────────────────
          const costs = inHold(run.costs).map((c) => c.costMs);
          const quiet = run.costs
            .filter((c) => c.t > closes + 600)
            .map((c) => c.costMs);
          expect(
            costs.length,
            "the gauge took render-cost samples inside the held window",
          ).toBeGreaterThan(8);
          note(
            "at0626 render cost",
            `inside the hold, ${costs.length} samples: ` +
              `p50 ${fmt(percentile(costs, 0.5))}ms, p95 ${fmt(percentile(costs, 0.95))}ms, ` +
              `max ${fmt(Math.max(...costs))}ms; ` +
              `after the release, ${quiet.length} samples: ` +
              `p50 ${fmt(percentile(quiet, 0.5))}ms, p95 ${fmt(percentile(quiet, 0.95))}ms`,
          );

          // ── Interior work ──────────────────────────────────────────────
          const inside = <T extends { t: number }>(xs: T[]): T[] =>
            xs.filter((x) => x.t >= opens && x.t <= closes);
          const deliveries = inside(run.deliveries);
          const mutations = inside(run.mutations);
          // Where the interior work landed, relative to the mark: the mark's
          // own consequence lands in its first frames, and anything later is
          // per-frame work the hold was meant to remove.
          const sinceMark = (xs: { t: number }[]): string =>
            xs.length === 0
              ? "none"
              : `${xs.length} at +${fmt(Math.min(...xs.map((x) => x.t)) - markAt)}…` +
                `+${fmt(Math.max(...xs.map((x) => x.t)) - markAt)}ms`;
          note(
            "at0626 since the mark",
            `root deliveries ${sinceMark(deliveries.filter((d) => d.box === "root"))}; ` +
              `list deliveries ${sinceMark(deliveries.filter((d) => d.box === "list"))}; ` +
              `transcript mutations ${sinceMark(mutations)}`,
          );
          const kinds = new Map<string, number>();
          for (const m of mutations) kinds.set(m.kind ?? "?", (kinds.get(m.kind ?? "?") ?? 0) + 1);
          note(
            "at0626 mutation kinds",
            Array.from(kinds.entries())
              .map(([k, n]) => `${n}× ${k}`)
              .join("; ") || "none",
          );
          for (const member of DIVIDED) {
            const d = deliveries.filter((x) => x.member === member);
            const m = mutations.filter((x) => x.member === member);
            const perBox = ["content", "root", "list"]
              .map((b) => `${b}=${d.filter((x) => x.box === b).length}`)
              .join(" ");
            // The transcript's displacement counter is noted rather than
            // held at zero: a bottom-following transcript re-pins its bottom
            // when its box is laid out — once at the mark, once at the
            // release — and that is the anchor working, not the drag
            // scrolling anything. What the hold owes is asserted below: no
            // commit and no resize inside the transcript while it is on.
            note(
              `at0626 ${member}`,
              `deliveries ${perBox} interior mutations=${m.length} ` +
                `displacements ${before[member]}→${run.displacements[member]}`,
            );
          }

          // ── The bar ────────────────────────────────────────────────────
          expect(
            overruns.length,
            `no animation frame in the held window runs longer than ` +
              `${fmt(overrunMs)}ms (1.5× the ${fmt(intervalMs)}ms display interval)`,
          ).toBe(0);
          expect(
            percentile(costs, 0.95),
            `the render cost p95 inside the held window is under the ` +
              `${fmt(intervalMs)}ms display interval`,
          ).toBeLessThan(intervalMs);
          // The box is where the pin says, on every tick. The pin is written
          // in the pointer handler and that is provable from the DOM alone;
          // what the eye sees is the laid-out box, and a running animation
          // on `height` — the window-shade `transition` in `chrome.css`, a
          // settle beat — outranks an inline value for as long as it runs.
          // The shade ease was exactly this: 100ms behind the hand on every
          // move, a gap opening under the seam and closing after it, with
          // every other bar in this file green.
          const lags = inHold(run.ticks).map((t) => t.lag);
          note(
            "at0626 box against pin",
            `inside the hold, max ${fmt(Math.max(0, ...lags))}px, ` +
              `p95 ${fmt(percentile(lags, 0.95))}px over ${lags.length} ticks`,
          );
          expect(
            Math.max(0, ...lags),
            "each member's laid-out height is its pinned height on every held tick",
          ).toBeLessThan(1);

          // The hold the previous arc proved, still standing under this one.
          const insideHold = run.deliveries.filter(
            (d) => d.t >= holdOpens && d.t < holdCloses,
          );
          for (const member of DIVIDED) {
            const mine = insideHold.filter((d) => d.member === member);
            expect(
              mine.filter((d) => d.box === "root").length,
              `${member}: the card root is not laid out again while the hold is on`,
            ).toBe(0);
            expect(
              mine.filter((d) => d.box === "list").length,
              `${member}: nothing inside the transcript is resized while the hold is on`,
            ).toBe(0);
            expect(
              deliveries.filter((d) => d.member === member && d.box === "root")
                .length,
              `${member}: the interior takes exactly one layout, at the mark`,
            ).toBe(1);
          }
          // A windowed transcript keeps a little housekeeping running under
          // any box that moves — a sticky pin's `data-stuck`, a cell's
          // content-visibility state, the list's eviction flag — driven by
          // intersection and visibility observers rather than by the hold.
          // Those are a handful of attribute writes a gesture, and the bar is
          // that they stay a handful: what the hold removes is the commit per
          // frame, and one per frame would be one per heartbeat tick here.
          const inHoldMutations = run.mutations.filter(
            (m) => m.t >= holdOpens && m.t < holdCloses,
          );
          note(
            "at0626 inside the hold",
            inHoldMutations.length === 0
              ? "no transcript mutation"
              : inHoldMutations
                  .map((m) => `${m.kind ?? "?"} at +${fmt(m.t - markAt)}ms`)
                  .join("; "),
          );
          expect(
            inHoldMutations.length,
            "no per-frame commit lands inside either transcript while the hold is on",
          ).toBeLessThan(Math.max(4, gaps.length * 0.05));

          // [B03]: the hold is an acquisition, and the release takes it off.
          const landed = run.ticks.filter((t) => t.t > closes);
          expect(
            landed.length === 0 ? 0 : Math.max(...landed.map((t) => t.marked)),
            "no member is left marked after the pointer is released",
          ).toBe(0);
          // And the pins come off with it: after the release every member
          // and every seam reads its geometry from the record again and
          // carries no px of the gesture's own. A member left with an inline
          // px height would hold it through every division the imposer wrote
          // afterwards, since its pins are top and bottom and a height
          // outranks the bottom. (A settle bakes `height: auto` and a top
          // into a frame it finished tweening; those are the settle's and are
          // not what is looked for here.)
          const residue = await app.evalJS<string[]>(
            `(function () {
              var out = [];
              ${JSON.stringify(DIVIDED.map((c) => pane(c)))}.forEach(function (sel) {
                var el = document.querySelector(sel);
                if (/px$/.test(el.style.height)) out.push(sel + " height=" + el.style.height);
              });
              var seam = document.querySelector(${JSON.stringify(SEAM)});
              if (seam.style.top.indexOf("calc(") !== 0) out.push("seam top=" + seam.style.top);
              return out;
            })()`,
          );
          expect(
            residue,
            "no member or seam carries the gesture's inline px after the release",
          ).toEqual([]);

          // ── The other two exits, [L27]'s "every path out" ──────────────
          //
          // A press that never travelled: the `finally` clears what the latch
          // never set, and nothing is committed.
          const box2 = await app.getElementBounds(SEAM);
          const at = {
            x: Math.round(box2.x + box2.width / 2),
            y: Math.round(box2.y + box2.height / 2),
          };
          await app.nativeMouseDown(at);
          await wait(120);
          await app.nativeMouseUp(at);
          await wait(400);
          expect(
            await markedCount(app),
            "a press that never travelled leaves no member marked",
          ).toBe(0);

          // And a cancel. The system takes a captured pointer away without an
          // `up`, which no native verb can post, so the event is dispatched at
          // the seam — the real listener, on the real gesture, reached the one
          // way a bench can reach it.
          await app.nativeDragElementWithoutRelease(SEAM, {
            x: at.x,
            y: at.y + 60,
          });
          expect(
            await markedCount(app),
            "a travelled drag holds both members",
          ).toBe(DIVIDED.length);
          await app.evalJS<null>(
            `(function () {
              var seam = document.querySelector(${JSON.stringify(SEAM)});
              seam.dispatchEvent(new PointerEvent("pointercancel", { bubbles: false }));
              return null;
            })()`,
          );
          await wait(400);
          expect(
            await markedCount(app),
            "a cancelled drag leaves no member marked",
          ).toBe(0);
          await app.nativeMouseUp({ x: at.x, y: at.y + 60 });
        } finally {
          await app.close().catch(() => undefined);
          rmSync(jotsPath, { force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * at0626-sash-drag-sampler.test.ts — the instrument for a rail sash drag,
 * and the reading it takes before anything is changed.
 *
 * ## What this is for
 *
 * Dragging the sash between two split sidebar cards judders, and the sash
 * trails the pointer. Nothing in the corpus samples that gesture:
 * `at0543-rail-sashes-are-the-hands.test.ts` drives a real pointer across a
 * sash and asserts the heights it leaves behind, which says nothing about what
 * the hand felt on the way. So the claim "it is smoother now" has no number
 * behind it, and the previous deck-motion arc records what that costs — a hop
 * report called verified on an impression, and not fixed.
 *
 * This file is that number. It drives a real pointer down a real sash on a
 * LOADED rail and records, per animation frame of the gesture:
 *
 *   - the pointer y the trail injected, read off a capture-phase
 *     `pointermove` listener of this test's own;
 *   - the seam's rendered `top`, read off its client rect;
 *   - the frame's own duration, from the gap between `requestAnimationFrame`
 *     callbacks;
 *   - every `ResizeObserver` delivery inside the divided members, on the
 *     boxes that can be delivered to — the pane's clipping box, the CARD ROOT
 *     inside it (the box a still crossing holds at a definite height), and
 *     `TugListView`'s scroll container below that;
 *   - every DOM mutation inside those scroll containers, which is the
 *     bench-readable trace of the React commit each delivery causes;
 *   - `TugListView`'s own `data-scroll-displacements` counter, across the
 *     gesture.
 *
 * All of it is this test's instrumentation on boxes the product already
 * observes, so nothing in the product is patched and nothing in the product
 * reads a rect per frame. An observer of ours on an element is delivered to
 * exactly when one of the product's on the same element would be.
 *
 * ## What it asserts
 *
 * **The still interior, which is what the hold buys.** Between the latch and
 * the release the divided members' card roots take exactly ONE layout — the
 * one at the mark, at the largest height the drag can reach — and nothing
 * inside them is delivered to or committed again while the frame's edge
 * travels over them. The window asserted empty is `at0605`'s, from the second
 * marked frame to the first unmarked one, for `at0605`'s reason: the mark's
 * own layout is a real delivery and lands before the first held frame paints.
 *
 * **The hold rides every exit ([B03], [L27]).** Three legs: a released drag,
 * a press that never travelled, and a cancel. None may leave a member marked,
 * because a hold that outlives its gesture is a card propped open for the rest
 * of the session.
 *
 * **The lag term, at this rig's resolution.** The seam stays within one
 * pointer sample of the pointer. See the note on the trail's rate below for
 * what that does and does not prove.
 *
 * **Not the frame-duration term.** `[B06]` also asks for no frame over the
 * display interval, and the drag does not meet it — with the hold and without
 * it. The file takes an IDLE control first for exactly this reason: an
 * undisturbed frame on this rig runs at 17.0ms, so the 16.7ms budget is under
 * the rig's own floor and "two frames in three over the interval" is half rig.
 * Read against the control, the drag costs about 2ms a frame, and a run under
 * a reverse patch of the hold reads the same — so the interior layouts this
 * file's other assertions pin were never the frame-duration cost. Asserting a
 * frame-duration bar here would land a red about the rig; the readings are in
 * the arc's findings paper instead.
 *
 * An empty rail reads clean on both sides of any change, which is how the last
 * deck-motion defect hid, so the rail here holds a Cards card listing real
 * bound sessions and a Jots card with real rows. The readings themselves go
 * out through `note()`.
 *
 * ## Which interior the cost was actually in
 *
 * The card root's, not the list view's. `TugListView`'s own container observer
 * is never delivered to here and its displacement counter never moves: the
 * Jots card's list sits inside an outer scrollport whose box the drag does not
 * change, and the Cards card's list is shorter than the card it is in. So the
 * per-frame React commit a session card's transcript pays under a height tween
 * — the cost `at0605` gates for the settle — is not what a sash drag on a
 * Cards-and-Jots rail pays. The layout is, and the hold is the same hold
 * either way. `.tug-pane-content`, the pane's clipping box, is delivered to
 * once per frame and goes on being: it is the box that shrinks under the hold.
 *
 * ## The trail's rate, honestly
 *
 * The harness posts its `mouseDragged` trail at a fixed 20ms gap — below that
 * windowserver coalesces the whole trail into one move — so the pointer
 * arrives at 50Hz against a rig the idle control measures at about 58.8Hz. A
 * real hand samples at display rate. The lag this file reads is therefore a
 * LOWER BOUND on the lag a hand feels: the drag loop is under-driven by about
 * one sample in six, and a one-frame difference hides inside one sample.
 * Frame durations are unaffected, since the sampler's own
 * `requestAnimationFrame` loop runs every frame whether a sample arrived or
 * not.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

/** Room past the settle attribute clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 900;

const RAIL_WIDTH = 420;
/** The rail's members, top to bottom. The seam under test is `right:0`,
 *  between the two loaded ones. */
const MEMBERS = ["cards", "jots", "layout"] as const;
/** The two members the seam divides — the ones the readings are about. */
const DIVIDED = ["cards", "jots"] as const;
/**
 * Each divided member's CARD ROOT — the box a still crossing holds at a
 * definite height, and the top of the subtree the hold makes still. It is the
 * `.tug-pane-content` box's child, but named per card rather than reached for
 * as a child selector: a pane's content box has overlays in it too, and the
 * first of them is not the card.
 */
const ROOT_OF: Record<string, string> = {
  cards: ".cards-card",
  jots: ".jots-card",
};

/** Session cards in the main area, so the Cards card lists real sessions
 *  rather than an empty workspace. */
const SESSIONS = ["S1", "S2", "S3"] as const;
type SessionId = (typeof SESSIONS)[number];
const TURNS = 6;

/** Jot rows seeded into an isolated `jots.json` — enough that the Jots card's
 *  list view overflows its scrollport several times over. */
const JOT_COUNT = 40;

/** How far the sash travels, px. Well inside the floors either side of it, so
 *  the drag lands where it was aimed rather than against a clamp. */
const DRAG_PX = 120;
/**
 * Trail steps. At the harness's fixed 20ms gap this is a 600ms drag, and
 * `DRAG_PX / DRAG_STEPS` is how far the pointer moves between samples — which
 * is also the finest lag this file can resolve, since a seam that is one
 * sample behind is exactly that far from where the pointer is. Fewer, longer
 * steps read lag better; more, shorter ones read frame durations better. 30
 * puts the resolution at 4px, well above the sub-pixel noise.
 */
const DRAG_STEPS = 30;

/** A 60Hz display's frame budget, ms. The bar's "no frame over the display
 *  interval" term is stated against this; it is reported, not asserted. */
const FRAME_BUDGET_MS = 1000 / 60;

const SEAM = `.tug-place-seam[data-rail-seam="right:0"]`;

const sid = (card: SessionId): string => `at0626-session-${card}`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Three sidebar cards on the right rail and three session cards in the main
 *  area, with no stored shares — a rail nobody has divided, standing equal. */
function deckShape() {
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
      { id: "C", componentId: "cards", title: "Cards", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
      ...SESSIONS.map((id) => ({
        id,
        componentId: "session",
        title: `Session ${id}`,
        closable: true,
      })),
    ],
    panes: [
      railPane("pCards", "C", "Cards"),
      railPane("pJots", "J", "Jots"),
      railPane("pLayout", "L", "Layout"),
      ...SESSIONS.map((id, i) => ({
        id: `p${id}`,
        position: { x: 40, y: 40 },
        size: { width: 600, height: 620 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: i,
      })),
    ],
    activePaneId: "pS1",
    imposition: {
      kind: "three-up",
      sidebars: {
        cards: { side: "right" },
        jots: { side: "right" },
        layout: { side: "right" },
      },
      rails: { right: { order: [...MEMBERS] } },
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
      `so the row has a real intrinsic height and the list has real work to ` +
      `do when its container is resized.`,
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
    text: `## step ${n}\n\nReply number ${n}, long enough to take a few lines.`,
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

/** Stand the rail up, bind the sessions, and let everything land. */
async function openRail(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="right"]').length === 3`,
    { timeoutMs: 20_000 },
  );
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
    `document.querySelector('.jots-card .jot-row-label') !== null`,
    { timeoutMs: 15_000 },
  );
  await settled(app);
}

/** One animation frame of the gesture, as the sampler saw it. */
interface Frame {
  /** `performance.now()` at the top of the callback. */
  t: number;
  /** Gap since the previous callback, ms — the frame's own duration. */
  dt: number;
  /** The most recent `pointermove` clientY, or -1 before the first. */
  pointerY: number;
  /** The seam's rendered top, px from the viewport. */
  seamTop: number;
  /** Whether the seam carried `data-gesture="seam"` on this frame. */
  gesture: boolean;
  /** How many of the divided members carried `data-still-crossing`. */
  marked: number;
}

interface Event {
  t: number;
  member: string;
  box: string;
}

interface Run {
  frames: Frame[];
  deliveries: Event[];
  mutations: Event[];
  displacements: Record<string, number>;
}


/** The divided members' `data-scroll-displacements` counters, right now. */
function displacements(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(function () {
      var out = {};
      ${JSON.stringify(DIVIDED)}.forEach(function (member) {
        var pane = document.querySelector('.tug-pane[data-rail-member="' + member + '"]');
        if (pane === null) return;
        var list = pane.querySelector('[data-slot="tug-list-view"]');
        out[member] = list === null
          ? -1
          : Number(list.getAttribute("data-scroll-displacements") || "0");
      });
      return out;
    })()`,
  );
}

/**
 * Install the observers and the per-frame sampler, and arm them.
 *
 * The `ResizeObserver` is installed and allowed its initial delivery BEFORE
 * the gesture — one always lands on `observe()` — and the record is armed
 * after them, so everything in it is a real size change.
 */
async function arm(app: App, durationMs: number): Promise<void> {
  const observed = await app.evalJS<number>(
    `(function () {
      var members = ${JSON.stringify(DIVIDED)};
      var roots = ${JSON.stringify(ROOT_OF)};
      var boxes = {
        // The pane's clipping box, which shrinks under the hold too, and the
        // card ROOT inside it, which is the box a still crossing holds at a
        // definite height. The list view is the expensive interior below it.
        content: ".tug-pane-content",
        list: '[data-slot="tug-list-view"]',
      };
      var prior = window.__at0626;
      if (prior !== undefined) {
        if (prior.resize) prior.resize.disconnect();
        prior.mutators.forEach(function (m) { m.disconnect(); });
        document.removeEventListener("pointermove", prior.onMove, true);
      }
      var state = {
        frames: [],
        deliveries: [],
        mutations: [],
        labels: new Map(),
        resize: null,
        mutators: [],
        onMove: null,
        pointerY: -1,
        armed: false,
      };
      state.resize = new ResizeObserver(function (entries) {
        if (!state.armed) return;
        var now = performance.now();
        entries.forEach(function (entry) {
          var label = state.labels.get(entry.target);
          state.deliveries.push({ t: now, member: label.member, box: label.box });
        });
      });
      members.forEach(function (member) {
        var pane = document.querySelector('.tug-pane[data-rail-member="' + member + '"]');
        if (pane === null) return;
        var mine = { content: boxes.content, root: roots[member], list: boxes.list };
        Object.keys(mine).forEach(function (box) {
          var el = pane.querySelector(mine[box]);
          if (el === null) return;
          state.labels.set(el, { member: member, box: box });
          state.resize.observe(el);
        });
        // The React commit each delivery causes is not observable from a
        // bench directly; what it always leaves behind is DOM written inside
        // the list — a re-windowed row set, a respaced spacer, a moved
        // scrollTop attribute. That is what is counted.
        var list = pane.querySelector(boxes.list);
        if (list === null) return;
        var mutator = new MutationObserver(function (records) {
          if (!state.armed) return;
          var now = performance.now();
          state.mutations.push({ t: now, member: member, box: "list" });
          void records;
        });
        mutator.observe(list, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        state.mutators.push(mutator);
      });
      // Capture phase, on the document: the seam takes pointer capture, so the
      // events retarget to it, and a capture listener above it still sees
      // every one on its way down.
      state.onMove = function (e) { state.pointerY = e.clientY; };
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
      state.armed = true;
      var seamSel = ${JSON.stringify(SEAM)};
      var members = ${JSON.stringify(DIVIDED)};
      var t0 = performance.now();
      var last = t0;
      var tick = function () {
        var now = performance.now();
        var seam = document.querySelector(seamSel);
        var marked = 0;
        members.forEach(function (member) {
          var pane = document.querySelector('.tug-pane[data-rail-member="' + member + '"]');
          if (pane !== null && pane.hasAttribute("data-still-crossing")) marked += 1;
        });
        state.frames.push({
          t: now,
          dt: now - last,
          pointerY: state.pointerY,
          seamTop: seam === null ? -1 : seam.getBoundingClientRect().top,
          gesture: seam !== null && seam.getAttribute("data-gesture") === "seam",
          marked: marked,
        });
        last = now;
        if (now - t0 < ${durationMs}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

const harvest = (app: App): Promise<Omit<Run, "displacements">> =>
  app.evalJS<Omit<Run, "displacements">>(
    `({
      frames: window.__at0626.frames,
      deliveries: window.__at0626.deliveries,
      mutations: window.__at0626.mutations,
    })`,
  );

/**
 * Frame durations over `ms` with nothing at all going on — this rig's own
 * floor, and the control every frame-duration reading here is against. A
 * `requestAnimationFrame` loop in a harness window is not a `rAF` loop on a
 * user's screen: the window can be occluded, the app is a debug build, and the
 * display the harness paints to is not necessarily the one the test's 16.7ms
 * budget names. Without this number, a drag's 20ms median reads as the drag's
 * fault when it may be the rig's.
 */
async function idleFrameDurations(app: App, ms: number): Promise<number[]> {
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
  return app.evalJS<number[]>(`window.__at0626idle.slice(1)`);
}

/** How many of the divided members carry the still-crossing mark, right now. */
const markedCount = (app: App): Promise<number> =>
  app.evalJS<number>(
    `${JSON.stringify(DIVIDED)}.filter(function (member) {
      var pane = document.querySelector('.tug-pane[data-rail-member="' + member + '"]');
      return pane !== null && pane.hasAttribute("data-still-crossing");
    }).length`,
  );

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe.skipIf(!SHOULD_RUN)(
  "at0626 — a sash drag, sampled frame by frame on a loaded rail",
  () => {
    test(
      "the sampler reads a real drag: frames, travel, and interior work",
      async () => {
        const jotsPath = seedJotsFile();
        const app = await launchTugApp({
          testName: "at0626-sash-drag-sampler",
          env: { TUG_JOTS_PATH: jotsPath },
        });
        try {
          await openRail(app);

          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SEAM)}).length === 1`,
            { timeoutMs: 10_000 },
          );
          const before = await displacements(app);
          const idle = await idleFrameDurations(app, 900);
          note(
            "at0626 idle",
            `an undisturbed frame on this rig: median ${median(idle).toFixed(1)}ms, ` +
              `max ${Math.max(...idle).toFixed(1)}ms, ` +
              `over ${FRAME_BUDGET_MS.toFixed(1)}ms: ` +
              `${idle.filter((d) => d > FRAME_BUDGET_MS + 1).length}/${idle.length}`,
          );

          // The trail takes `DRAG_STEPS * 20ms`; the sampler runs a little
          // past the release so the landing frames are in the record too.
          const trailMs = DRAG_STEPS * 20;
          await arm(app, trailMs + 1_200);

          const box = await app.getElementBounds(SEAM);
          const from = {
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
          };
          const to = { x: from.x, y: from.y + DRAG_PX };
          await app.nativeDragElementWithoutRelease(SEAM, to, {
            interpolationSteps: DRAG_STEPS,
          });
          await app.nativeMouseUp(to);
          await wait(1_400);

          const run: Run = {
            ...(await harvest(app)),
            displacements: await displacements(app),
          };
          await settled(app);

          // ── The gesture's window, as the seam's own mark draws it ──────
          const held = run.frames.filter((f) => f.gesture);
          expect(
            held.length,
            "the sampler recorded animation frames while the seam was held",
          ).toBeGreaterThan(10);
          const opens = held[0].t;
          const closes = held[held.length - 1].t;

          const travel =
            held[held.length - 1].seamTop - held[0].seamTop;
          note(
            "at0626 gesture",
            `frames=${held.length} over ${Math.round(closes - opens)}ms, ` +
              `seam travelled ${travel.toFixed(1)}px of the ${DRAG_PX}px asked for`,
          );
          const heldFrames = held.filter((f) => f.marked === DIVIDED.length);
          const landed = run.frames.filter((f) => f.t > closes);
          note(
            "at0626 hold",
            `both members marked on ${heldFrames.length}/${held.length} gesture frames; ` +
              `after the release, max marked on any of ${landed.length} frames = ` +
              `${landed.length === 0 ? "n/a" : Math.max(...landed.map((f) => f.marked))}`,
          );
          expect(
            travel,
            "the sash really travelled under the pointer",
          ).toBeGreaterThan(DRAG_PX / 2);

          // ── Lag: where the seam stands against where the pointer is ────
          // The grab offset is fixed for the gesture, so the seam's honest
          // position is `pointerY - offset`; anything else is lag.
          const tracked = held.filter((f) => f.pointerY >= 0);
          const offset = tracked[0].pointerY - tracked[0].seamTop;
          // Only the frames the pointer is still travelling on: at the ends
          // the seam catches up and the error goes to zero for reasons that
          // are not about lag.
          const moving = tracked.filter(
            (f, i) => i > 0 && f.pointerY !== tracked[i - 1].pointerY,
          );
          const errors = moving.map((f) =>
            Math.abs(f.pointerY - offset - f.seamTop),
          );
          const perFrame = median(
            moving.map((f, i) =>
              i === 0 ? 0 : Math.abs(f.pointerY - moving[i - 1].pointerY),
            ),
          );
          const inFrames = (px: number): string =>
            perFrame > 0 ? `${(px / perFrame).toFixed(2)} frames` : "n/a";
          note(
            "at0626 lag",
            `median ${median(errors).toFixed(1)}px (${inFrames(median(errors))}), ` +
              `max ${Math.max(...errors).toFixed(1)}px (${inFrames(Math.max(...errors))}), ` +
              `pointer travel ${perFrame.toFixed(1)}px/sample`,
          );

          // ── Frame durations ────────────────────────────────────────────
          const durations = held.slice(1).map((f) => f.dt);
          const long = durations.filter((d) => d > FRAME_BUDGET_MS + 1);
          note(
            "at0626 frames",
            `median ${median(durations).toFixed(1)}ms, ` +
              `max ${Math.max(...durations).toFixed(1)}ms, ` +
              `over ${FRAME_BUDGET_MS.toFixed(1)}ms: ${long.length}/${durations.length}; ` +
              `over the idle median (${median(idle).toFixed(1)}ms): ` +
              `${durations.filter((d) => d > median(idle) + 1).length}/${durations.length}`,
          );

          // ── Interior work, which is what the arc is about ──────────────
          const inside = <T extends { t: number }>(xs: T[]): T[] =>
            xs.filter((x) => x.t >= opens && x.t <= closes);
          const deliveries = inside(run.deliveries);
          const mutations = inside(run.mutations);
          note(
            "at0626 totals",
            `recorded over the whole sampler window: ` +
              `deliveries=${run.deliveries.length} mutations=${run.mutations.length}; ` +
              `inside the gesture: deliveries=${deliveries.length} mutations=${mutations.length}`,
          );
          for (const member of DIVIDED) {
            const d = deliveries.filter((x) => x.member === member);
            const m = mutations.filter((x) => x.member === member);
            const perBox = ["content", "root", "list"]
              .map((box) => `${box}=${d.filter((x) => x.box === box).length}`)
              .join(" ");
            note(
              `at0626 ${member}`,
              `deliveries ${perBox} ` +
                `interior mutations=${m.length} ` +
                `displacements ${before[member]}→${run.displacements[member]}`,
            );
          }

          // ── The bar the hold earns ─────────────────────────────────────
          //
          // The window that must be empty is `at0605`'s, for its reason: the
          // interior is laid out ONCE when the mark goes on, which is a real
          // delivery and lands before the first held frame is painted. So what
          // is asserted empty runs from the SECOND marked frame — the first
          // delivery opportunity after that paint — to the first unmarked one.
          expect(
            heldFrames.length,
            "both members are held for the length of the gesture",
          ).toBeGreaterThan(10);
          const holdOpens = heldFrames[1].t;
          const lastMarked = heldFrames[heldFrames.length - 1];
          // The window closes at the LAST held frame rather than at the first
          // unheld one: the release takes the hold off and the interior takes
          // its one landing layout there, which lands between those two frames
          // and is the hold ending rather than the hold failing.
          const holdCloses = lastMarked.t;
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
              `${member}: nothing inside the list view is resized while the hold is on`,
            ).toBe(0);
            expect(
              deliveries.filter(
                (d) => d.member === member && d.box === "root",
              ).length,
              `${member}: the interior takes exactly one layout, at the mark`,
            ).toBe(1);
            expect(
              run.displacements[member],
              `${member}: the drag displaced no scroll position`,
            ).toBe(before[member]);
          }
          expect(
            run.mutations.filter((m) => m.t >= holdOpens && m.t < holdCloses)
              .length,
            "no commit lands inside either list view while the hold is on",
          ).toBe(0);

          // The lag term of the bar, at this rig's resolution: the seam is
          // never more than one pointer sample behind where the hand is.
          expect(
            Math.max(...errors),
            "the sash stays within one pointer sample of the pointer",
          ).toBeLessThanOrEqual(DRAG_PX / DRAG_STEPS + 0.5);

          // [B03]: the hold is an acquisition, and the release takes it off.
          expect(
            landed.length === 0 ? 0 : Math.max(...landed.map((f) => f.marked)),
            "no member is left marked after the pointer is released",
          ).toBe(0);

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

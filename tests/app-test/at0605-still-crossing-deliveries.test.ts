/**
 * at0605-still-crossing-deliveries.test.ts — while a frame's height tweens,
 * nothing inside its card is resized.
 *
 * ## What this gates
 *
 * A frame whose settle carries a real height term used to lay its whole
 * subtree out again at every intermediate height. In a session card that is
 * the expensive case: the transcript's list view answers every
 * `ResizeObserver` delivery on its container with a re-pin and a render, so a
 * stack, a split or a join ran one whole-list-view commit per animation frame
 * for the life of the tween — inside the settle window, where commits and the
 * settle are superadditive. Which frames carry a height term is decided by the
 * gesture, which is why the judder was "sometimes".
 *
 * The remedy is the fold's, generalized: the imposer marks every frame with a
 * height term (`data-still-crossing`), the pane holds the card's root at the
 * larger of its two content heights and clips it, and only the frame's edge
 * moves. A subtree with a definite height that does not change delivers
 * nothing to observe.
 *
 * So the claim is about DELIVERIES, which is the thing that was expensive, and
 * it is read with the platform's own instrument: a `ResizeObserver` of this
 * test's, on the boxes inside each card that the product observes — the card
 * root (a size container), the transcript's scroller, the transcript pane and
 * the entry region. An observer of ours is delivered to exactly when one of
 * the product's on the same element would be, so nothing in the product is
 * patched.
 *
 *   1. **No delivery between the tween's first painted frame and its
 *      landing.** Not zero outright, which would fail correct code. On a
 *      GROWTH the interior already stands at the larger height when the mark
 *      goes on, so the scroller differs from what was last delivered and one
 *      delivery lands at launch, before the first paint. On a SHRINK the hold
 *      restores the larger height pre-paint and nothing is delivered until the
 *      hold comes off, at landing. The window in between is what is asserted
 *      empty: from the SECOND marked animation frame (the first delivery
 *      opportunity after the first paint) up to the first unmarked one.
 *   2. **The mark is on for the tween's life and off at landing.** Every frame
 *      on which a marked pane's height is between its two ends carries the
 *      mark, and none carries it at rest.
 *   3. **A following card's composer rides the frame's bottom edge** across
 *      the marked frames — the bottom anchor, which is what keeps the held
 *      picture from wiping the composer out under the clip.
 *
 * Two shapes, because they mark different sets of frames. A column MODE FLIP
 * gives exactly one frame a height term: the survivor grows over its covered
 * neighbours on a stack and shrinks back off them on a split. A JOIN into a
 * split column is not a mode flip — nothing is covered, and every member whose
 * tile resizes tweens its height — so two session cards shrink at once: the
 * one sitting alone in the column and the one arriving beside it. (A THIRD
 * card joining would shrink nobody but itself: a session card's floor is more
 * than half the harness window, so two sitting members are already at it.)
 *
 * The instrument is proven by running this file behind a reverse patch of the
 * pane's held-height rule, where claim 1 goes red.
 *
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;
const FEED_CODE_OUTPUT = 0x40;

const CARD_IDS = ["A", "B"] as const;
type CardId = (typeof CARD_IDS)[number];
const PANE_OF: Record<CardId, string> = { A: "p1", B: "p2" };
const SLOT_OF: Record<CardId, number> = { A: 0, B: 1 };
const TURNS = 24;

const CENSUS_MS = 1_600;
const AFTER_LAND_MS = 1_800;

const sid = (card: CardId): string => `at0605-session-${card}`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape() {
  return {
    cards: CARD_IDS.map((id) => ({
      id,
      componentId: "session",
      title: `Session ${id}`,
      closable: true,
    })),
    panes: CARD_IDS.map((id) => ({
      id: PANE_OF[id],
      position: { x: 40, y: 40 },
      size: { width: 675, height: 620 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
      slot: SLOT_OF[id],
    })),
    activePaneId: "p1",
    imposition: { kind: "two-up" },
    hasFocus: true,
  };
}

async function seedTurn(app: App, card: CardId, n: number): Promise<void> {
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
    text: `## step ${n}\n\nReply number ${n}, long enough to take a few lines of the transcript so that the whole of it overflows the scrollport several times over.\n\n- marker ${n}`,
    is_partial: false,
  });
  await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
}

async function openCards(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  for (const card of CARD_IDS) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(card)})`,
      { timeoutMs: 30_000 },
    );
  }
  for (const card of CARD_IDS) {
    await app.bindSession(card, { tugSessionId: sid(card) });
    await app.awaitEngineReady(card);
  }
  for (const card of CARD_IDS) {
    for (let n = 0; n < TURNS; n += 1) await seedTurn(app, card, n);
  }
  await wait(AFTER_LAND_MS);
}

interface PaneSample {
  /** The imposer's still-crossing mark, or `""`. */
  still: string;
  height: number;
  bottom: number;
  /** The entry region's bottom, or -1 when the card has none mounted. */
  entryBottom: number;
  /** Whether the card root declares a bottom anchor on this frame. */
  bottomAnchored: boolean;
}

interface Sample {
  t: number;
  panes: Record<string, PaneSample>;
}

interface Delivery {
  t: number;
  card: string;
  /** Which observed box inside the card was delivered. */
  box: string;
  height: number;
}

interface Census {
  samples: Sample[];
  deliveries: Deliveries;
}
type Deliveries = Delivery[];

/**
 * Observe the boxes inside every card, sample every animation frame, run the
 * gesture, and hand back both records on one clock.
 *
 * The observers are installed and allowed their initial deliveries BEFORE the
 * gesture — a `ResizeObserver` always delivers once on `observe()` — and the
 * record is cleared after them, so everything in it is a real size change.
 */
async function census(app: App, dispatch: string): Promise<Census> {
  await app.evalJS<null>(
    `(function () {
      var cards = ${JSON.stringify(CARD_IDS)};
      var boxes = {
        root: '[data-slot="session-card"]',
        scroller: '[data-tug-scroll-key="session-card-transcript"]',
        transcript: '.session-view-slot .session-view-pane[data-view="transcript"]',
        entry: '[data-slot="session-card-entry-region"]',
      };
      if (window.__at0605 && window.__at0605.observer) {
        window.__at0605.observer.disconnect();
      }
      var state = { samples: [], deliveries: [], labels: new Map(), observer: null, armed: false };
      state.observer = new ResizeObserver(function (entries) {
        if (!state.armed) return;
        var now = performance.now();
        entries.forEach(function (entry) {
          var label = state.labels.get(entry.target);
          state.deliveries.push({
            t: now,
            card: label.card,
            box: label.box,
            height: entry.contentRect.height,
          });
        });
      });
      cards.forEach(function (card) {
        Object.keys(boxes).forEach(function (box) {
          var el = document.querySelector('[data-card-id="' + card + '"] ' + boxes[box]);
          if (el === null) return;
          state.labels.set(el, { card: card, box: box });
          state.observer.observe(el);
        });
      });
      window.__at0605 = state;
      return null;
    })()`,
  );
  // The initial deliveries land on the next frame; let them, then arm.
  await wait(200);
  await app.evalJS<null>(
    `(function () {
      var state = window.__at0605;
      var panes = ${JSON.stringify(PANE_OF)};
      state.armed = true;
      var t0 = performance.now();
      var tick = function () {
        var sample = { t: performance.now(), panes: {} };
        Object.keys(panes).forEach(function (card) {
          var frame = document.querySelector('.tug-pane[data-pane-id="' + panes[card] + '"]');
          if (frame === null) return;
          var r = frame.getBoundingClientRect();
          var entry = document.querySelector('[data-card-id="' + card + '"] [data-slot="session-card-entry-region"]');
          var root = document.querySelector('[data-card-id="' + card + '"] [data-slot="session-card"]');
          sample.panes[card] = {
            still: frame.getAttribute("data-still-crossing") || "",
            height: r.height,
            bottom: r.bottom,
            entryBottom: entry === null ? -1 : entry.getBoundingClientRect().bottom,
            bottomAnchored: root !== null && root.getAttribute("data-still-anchor") === "bottom",
          };
        });
        state.samples.push(sample);
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(`(${dispatch}, null)`);
  await wait(CENSUS_MS + 400);
  return app.evalJS<Census>(
    `({ samples: window.__at0605.samples, deliveries: window.__at0605.deliveries })`,
  );
}

const setColumnMode = (mode: "split" | "stack"): string =>
  `window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: ${JSON.stringify(mode)} })`;

const assignSlot = (card: CardId, slot: number): string =>
  `window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(card)}, slot: ${slot} })`;

/**
 * The three claims over one gesture. Returns the cards that were held, so the
 * caller can say how many the shape is supposed to hold.
 */
function assertStill(label: string, run: Census): CardId[] {
  const held: CardId[] = [];
  note(
    `${label} heights`,
    CARD_IDS.map((card) => {
      const frames = run.samples.filter((s) => s.panes[card] !== undefined);
      if (frames.length === 0) return `${card}=none`;
      return `${card}=${Math.round(frames[0].panes[card].height)}→${Math.round(frames[frames.length - 1].panes[card].height)}`;
    }).join(" "),
  );
  for (const card of CARD_IDS) {
    const frames = run.samples.filter((s) => s.panes[card] !== undefined);
    const marked = frames.filter((s) => s.panes[card].still !== "");
    if (marked.length === 0) continue;
    held.push(card);

    const first = frames[0].panes[card].height;
    const last = frames[frames.length - 1].panes[card].height;
    const lastMarked = marked[marked.length - 1];
    const landed = frames.find((s) => s.t > lastMarked.t);
    const mine = run.deliveries.filter((d) => d.card === card);

    // The window that must be empty: from the second marked frame — the first
    // delivery opportunity after the first paint — to the first unmarked one.
    const opens = marked.length > 1 ? marked[1].t : Number.POSITIVE_INFINITY;
    const closes = landed === undefined ? Number.POSITIVE_INFINITY : landed.t;
    const inside = mine.filter((d) => d.t >= opens && d.t < closes);
    const atLaunch = mine.filter((d) => d.t < opens);
    const atRelease = mine.filter((d) => d.t >= closes);
    note(
      `${label} ${card}`,
      `${first < last ? "grows" : "shrinks"} ${Math.round(first)}→${Math.round(last)} marked frames=${marked.length} deliveries: launch=${atLaunch.length} inside=${inside.length} release=${atRelease.length}${inside.length > 0 ? ` (${[...new Set(inside.map((d) => d.box))].join(",")})` : ""}`,
    );

    expect(
      marked.length,
      `${label}: ${card}'s crossing must be sampled mid-motion`,
    ).toBeGreaterThan(5);
    expect(
      Math.abs(first - last),
      `${label}: ${card}'s frame really changes height`,
    ).toBeGreaterThan(50);

    // 1. Nothing inside the card is resized while the edge travels.
    expect(
      inside.length,
      `${label}: no ResizeObserver delivery inside ${card} between the first painted frame and landing`,
    ).toBe(0);

    // 2. The mark covers the tween: every frame on which the height is
    //    strictly between its two ends is marked, and the last frame is not.
    const lo = Math.min(first, last) + 1;
    const hi = Math.max(first, last) - 1;
    const unmarkedInMotion = frames.filter(
      (s) =>
        s.panes[card].height > lo &&
        s.panes[card].height < hi &&
        s.panes[card].still === "",
    );
    expect(
      unmarkedInMotion.length,
      `${label}: ${card} is marked on every frame its height is in motion`,
    ).toBe(0);
    expect(
      frames[frames.length - 1].panes[card].still,
      `${label}: ${card}'s mark is off at landing`,
    ).toBe("");

    // 3. A following card's composer rides the frame's bottom edge.
    const anchored = marked.filter((s) => s.panes[card].bottomAnchored);
    expect(
      anchored.length,
      `${label}: ${card} is following, so it is bottom-anchored throughout`,
    ).toBe(marked.length);
    const distances = marked.map(
      (s) => s.panes[card].bottom - s.panes[card].entryBottom,
    );
    expect(
      Math.max(...distances) - Math.min(...distances),
      `${label}: ${card}'s composer bottom rides its frame's bottom edge`,
    ).toBeLessThan(1.5);
  }
  return held;
}

describe.skipIf(!SHOULD_RUN)("AT0605: a still interior for every height crossing", () => {
  test(
    "a stack, a split and a two-card join deliver nothing inside a held session card mid-tween",
    async () => {
      const app = await launchTugApp({ testName: "at0605-still-deliveries" });
      try {
        await openCards(app);
        // A known start, whatever the column's default mode is.
        await app.evalJS<null>(`(${setColumnMode("split")}, null)`);
        await wait(AFTER_LAND_MS);

        // ── A join: every member whose tile resizes, at once ─────────────
        const joined = assertStill("join", await census(app, assignSlot("B", 0)));
        expect(
          joined.length,
          "a join into a split column shrinks the sitter and the arrival together",
        ).toBe(2);
        await wait(AFTER_LAND_MS);

        // ── A mode flip: one survivor, growing then shrinking ────────────
        const stacked = assertStill("stack", await census(app, setColumnMode("stack")));
        expect(stacked.length, "a stack holds its survivor").toBe(1);
        await wait(AFTER_LAND_MS);

        const split = assertStill("split", await census(app, setColumnMode("split")));
        expect(split, "the split shrinks the same survivor back").toEqual(stacked);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

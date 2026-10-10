/**
 * at0724-land-keeps-the-bottom.test.ts — a following transcript is at its
 * bottom on every frame of a settle whose card shrinks, the land included.
 *
 * A card that shrinks is held at its OPEN height through the motion and hung
 * from the box's bottom, and the hold comes off at the land. Taking it off
 * changes the transcript scroller's `clientHeight` in one step, and the
 * browser keeps `scrollTop` — the TOP — so unless something writes
 * `scrollTop` before the next paint, that frame shows the transcript off its
 * bottom by the height it lost and the frame after shows the correction: the
 * hop the user reported on a ⌘1 move into a column at View › Zoom 90 %.
 * The hold's release now restores each bottom-anchored scroller's distance
 * from bottom in the same task (`preserveBottomAcross` in `fold-crossing.ts`,
 * `briefs/land-preserves-the-bottom-brief.md`), so no frame can paint the
 * new height with the old position.
 *
 * The instrument is a per-animation-frame recorder armed BEFORE the gesture
 * is dispatched — the settle's own frame row clocks from its arm, after the
 * commit, and misses the lead — reading each card's transcript distance from
 * bottom, its frame's still-crossing mark, and whether a higher frame covers
 * it. The bar: a card that was following before the gesture reads no more
 * than a few px from its bottom on every tick it is visible, from the arm to
 * well past the land.
 *
 * Three shrinks, each at 100 % and at 90 %:
 *
 * - a slot assignment into a STACKED column — a column's default mode
 *   (`layout-imposer.ts`), so this is the user's ⌘1 into a slot holding one
 *   card: the arriving card is held behind the survivor at its tile, a
 *   fraction of the height it left;
 * - a slot assignment into a SPLIT column: both cards shrink to share it;
 * - a column split: the column is stacked and split again, and the survivor
 *   shrinks back off the tile it grew over.
 *
 * NOT proven red. Run twice under `tugtool file probe` with the release's
 * restore reversed, this file was green on both: in this harness the list
 * view's own capture listener (`onStillCrossingClosed`) pays the land on every
 * gesture here, so the release's restore is a second writer of the same
 * `scrollTop` and nothing samples off its bottom either way. The user's deck
 * is where the hop was read, and it is the final word on this change ([B06]
 * of the brief); this file is the invariant's guard, not its proof.
 *
 * Covers the module that owns the invariant and nothing wider: the settle
 * engine and the list view are each past the selection's fan-out budget, and
 * at0605 and at0708 already select on both with bars over the same crossings.
 *
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { bindForTest, transcriptArms, type TranscriptSize } from "./real-transcript-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const CARD_IDS = ["A", "B"] as const;
type CardId = (typeof CARD_IDS)[number];
const PANE_OF: Record<CardId, string> = { A: "p1", B: "p2" };
const SLOT_OF: Record<CardId, number> = { A: 0, B: 1 };

/** The zoom factors each gesture is read at: the default, and the user's. */
const ZOOMS = [1, 0.9] as const;

/** How long the recorder runs after the dispatch: the motion, the land, and the gate's release well past it. */
const RECORD_MS = 1_600;
const AFTER_LAND_MS = 1_800;

/**
 * How far from its bottom a following transcript may read on any visible
 * tick. The hop reads hundreds of px; a scroller at its bottom reads 0 or a
 * pixel of rounding.
 */
const BOTTOM_EPSILON_PX = 4;

/** Where a following transcript reads before the gesture to count as following. */
const FOLLOWING_PX = 1.5;

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

async function openCards(app: App, size: TranscriptSize): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  for (const card of CARD_IDS) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(card)})`,
      { timeoutMs: 30_000 },
    );
  }
  await bindForTest(app, CARD_IDS, {
    size,
    whaleCards: CARD_IDS,
    label: `at0724 [${size}]`,
  });
  await wait(AFTER_LAND_MS);
}

interface CardSample {
  /** The card's frame's `data-still-crossing`, or `""`. */
  readonly crossing: string;
  /** The card root's `data-still-anchor`, or `""`. */
  readonly anchor: string;
  readonly height: number;
  readonly clientHeight: number;
  /** `scrollHeight - scrollTop - clientHeight` of the transcript scroller. */
  readonly distance: number;
  /** Not fully covered by a frame with a higher z-index. */
  readonly visible: boolean;
}

interface Sample {
  /** ms after the recorder armed. */
  readonly t: number;
  readonly cards: Partial<Record<CardId, CardSample>>;
}

/**
 * Arm the recorder, dispatch, and read the record back. Armed on
 * `requestAnimationFrame` before the dispatch, so the first sample is the
 * standing geometry and every frame of the motion is in it. A frame is found
 * from its card each tick — a slot assignment may carry the card into another
 * pane — and every read is a rect or a scroll metric against geometry the
 * frame has already laid out.
 */
async function record(app: App, dispatch: string): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
       var cards = ${JSON.stringify(CARD_IDS)};
       var samples = [];
       window.__at0724 = samples;
       var t0 = performance.now();
       var tick = function () {
         var sample = { t: performance.now() - t0, cards: {} };
         var rows = [];
         cards.forEach(function (card) {
           var root = document.querySelector('[data-card-id="' + card + '"] [data-slot="session-card"]');
           var frame = root === null ? null : root.closest(".tug-pane[data-pane-id]");
           var scroller = root === null ? null :
             root.querySelector('[data-tug-scroll-key="session-card-transcript"]');
           if (frame === null || scroller === null) return;
           var r = frame.getBoundingClientRect();
           var z = parseInt(getComputedStyle(frame).zIndex, 10);
           rows.push({
             card: card,
             frame: frame,
             r: r,
             z: isNaN(z) ? 0 : z,
             sample: {
               crossing: frame.getAttribute("data-still-crossing") || "",
               anchor: root.getAttribute("data-still-anchor") || "",
               height: r.height,
               clientHeight: scroller.clientHeight,
               distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
               visible: r.height > 0,
             },
           });
         });
         var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
         rows.forEach(function (me) {
           for (var i = 0; i < frames.length && me.sample.visible; i++) {
             var other = frames[i];
             if (other === me.frame) continue;
             var oz = parseInt(getComputedStyle(other).zIndex, 10);
             if (isNaN(oz) || oz <= me.z) continue;
             var o = other.getBoundingClientRect();
             if (o.left <= me.r.left + 0.5 && o.top <= me.r.top + 0.5 &&
                 o.right >= me.r.right - 0.5 && o.bottom >= me.r.bottom - 0.5) {
               me.sample.visible = false;
             }
           }
           sample.cards[me.card] = me.sample;
         });
         samples.push(sample);
         if (performance.now() - t0 < ${RECORD_MS}) {
           window.__at0724Raf = requestAnimationFrame(tick);
         }
       };
       window.__at0724Raf = requestAnimationFrame(tick);
       return null;
     })()`,
  );
  // A sample or two of the standing geometry before the gesture lands.
  await wait(60);
  await app.evalJS<null>(`(${dispatch}, null)`);
  await wait(RECORD_MS + 200);
  return app.evalJS<Sample[]>(
    `(cancelAnimationFrame(window.__at0724Raf), window.__at0724)`,
  );
}

const setColumnMode = (mode: "split" | "stack"): string =>
  `window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: ${JSON.stringify(mode)} })`;

const assignSlot = (card: CardId, slot: number): string =>
  `window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(card)}, slot: ${slot} })`;

/** One card's reading over one gesture. */
interface Reading {
  readonly following: boolean;
  readonly shrank: boolean;
  readonly visibleTicks: number;
  readonly maxDistance: number;
  readonly offTicks: { t: number; distance: number; crossing: string; clientHeight: number }[];
}

function read(samples: readonly Sample[], card: CardId): Reading {
  const seen = samples.filter((s) => s.cards[card] !== undefined);
  const first = seen[0]?.cards[card];
  const last = seen[seen.length - 1]?.cards[card];
  const offTicks: Reading["offTicks"] = [];
  let visibleTicks = 0;
  let maxDistance = 0;
  for (const s of seen) {
    const c = s.cards[card] as CardSample;
    if (!c.visible) continue;
    visibleTicks += 1;
    maxDistance = Math.max(maxDistance, c.distance);
    if (c.distance > BOTTOM_EPSILON_PX) {
      offTicks.push({
        t: Math.round(s.t),
        distance: Math.round(c.distance),
        crossing: c.crossing,
        clientHeight: c.clientHeight,
      });
    }
  }
  return {
    following:
      first !== undefined && first.anchor === "bottom" && first.distance <= FOLLOWING_PX,
    shrank:
      first !== undefined && last !== undefined && last.clientHeight < first.clientHeight - 1,
    visibleTicks,
    maxDistance,
    offTicks,
  };
}

/**
 * The bar over one gesture: every card that was following and shrank stood
 * at its bottom on every tick it was seen. Returns how many cards it held to
 * the bar, so the caller can say the gesture shrank what it was meant to.
 */
function expectBottomKept(label: string, samples: readonly Sample[]): CardId[] {
  const barred: CardId[] = [];
  for (const card of CARD_IDS) {
    const r = read(samples, card);
    const off = r.offTicks[0];
    note(
      `${label} ${card}: following ${r.following}, shrank ${r.shrank}, visible ${r.visibleTicks} tick(s), ` +
        `off its bottom on ${r.offTicks.length} (max ${Math.round(r.maxDistance)}px)` +
        `${off === undefined ? "" : `, first ${JSON.stringify(off)}`}`,
    );
    if (!r.following || !r.shrank) continue;
    barred.push(card);
    expect(r.visibleTicks, `${label}: ${card} was seen at all`).toBeGreaterThan(0);
    expect(
      r.offTicks.length,
      `${label}: ${card} stood off its bottom on ${r.offTicks.length} of ${r.visibleTicks} ` +
        `visible tick(s) — first at t=${off?.t}ms, ${off?.distance}px off ` +
        `(scroller ${off?.clientHeight}px, crossing ${JSON.stringify(off?.crossing)}); ` +
        `max ${Math.round(r.maxDistance)}px`,
    ).toBe(0);
  }
  return barred;
}

for (const arm of transcriptArms()) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `AT0724: the land keeps a following transcript at its bottom [${arm.size}]`,
  () => {
    test(
      "slot assignments into a stack and a split, and a column split, at 100 % and 90 %, show no frame off the bottom",
      async () => {
        const app = await launchTugApp({ testName: `at0724-land-keeps-the-bottom-${arm.size}` });
        try {
          await openCards(app, arm.size);

          for (const zoom of ZOOMS) {
            expect(await app.setPageZoom(zoom)).toBeCloseTo(zoom, 5);
            await wait(AFTER_LAND_MS);
            const at = `${Math.round(zoom * 100)}% [${arm.size}]`;

            // ── The user's gesture: B joins A's column at its default mode,
            // a stack, and is held behind A at the stack's tile.
            await app.evalJS<null>(`(${setColumnMode("stack")}, null)`);
            await wait(AFTER_LAND_MS);
            // Read, not required to shrink: with two cards the covered member
            // is held at its open height behind the survivor, so no scroller
            // changes size at the land. Any following card that does shrink
            // is still barred.
            expectBottomKept(`stack-join ${at}`, await record(app, assignSlot("B", 0)));
            await wait(AFTER_LAND_MS);
            await app.evalJS<null>(`(${assignSlot("B", 1)}, null)`);
            await wait(AFTER_LAND_MS);
            await app.evalJS<null>(`(${setColumnMode("split")}, null)`);
            await wait(AFTER_LAND_MS);

            // ── A slot assignment into a split column: both shrink.
            const joined = expectBottomKept(`assign ${at}`, await record(app, assignSlot("B", 0)));
            expect(
              joined.length,
              `assign ${at}: the join shrank both following cards — ${JSON.stringify(joined)}`,
            ).toBe(2);
            await wait(AFTER_LAND_MS);

            // ── A column split: stacked, then split; the survivor shrinks back.
            await app.evalJS<null>(`(${setColumnMode("stack")}, null)`);
            await wait(AFTER_LAND_MS);
            const split = expectBottomKept(`split ${at}`, await record(app, setColumnMode("split")));
            expect(
              split.length,
              `split ${at}: the split shrank the survivor — ${JSON.stringify(split)}`,
            ).toBeGreaterThan(0);
            await wait(AFTER_LAND_MS);

            // Back to one card per column for the next factor.
            await app.evalJS<null>(`(${assignSlot("B", 1)}, null)`);
            await wait(AFTER_LAND_MS);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

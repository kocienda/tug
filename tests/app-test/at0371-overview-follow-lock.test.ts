/**
 * at0371-overview-follow-lock.test.ts — the Overview keeps its follow-lock
 * through the two things that used to take it away silently.
 *
 * at0370 pins what following IS. This pins what must not break it, and both
 * cases share a shape: something other than the reader moves the column, and
 * the card reads that movement as the reader leaving.
 *
 * **A late scroll event is not a gesture.** Pinning is a `scrollTop` write,
 * and the scroll event that write queues is delivered on a later frame —
 * against whatever the column has become by then. A row that settled taller
 * in between (markdown laying out, an annotator verdict turning a ref into an
 * atom, an image arriving) means the event's position reads as "away from the
 * bottom" though nobody scrolled. Read as a gesture, that disengages
 * following for good: nothing re-engages it, because the resize observer's
 * re-engage branch fires on geometry that brings the edge BACK, and content
 * growing never does. The column then sits one post below the live edge with
 * the jump button up, forever. Here the frame race is made deterministic —
 * grow the last row, then deliver the scroll event before the observer can
 * re-pin — because the whole defect is the order those two arrive in.
 *
 * **A restored position is not a gesture either.** `CardHost` saves this
 * scroller by its `data-tug-scroll-key` and replays the saved `scrollTop`
 * whenever the card is rebuilt, retrying on every subtree mutation until it
 * sticks. For a column that was resting on the live edge, the saved pixel is
 * the bottom AS IT WAS — the Overview grows while the bag sits, so replaying
 * it lands the reader mid-history and the retry re-lands them there on every
 * arriving post. The card claims that case through the real
 * `tug-region-scroll-set` contract and re-pins to the edge that exists now;
 * the position a reader CHOSE carries no such claim and is replayed verbatim.
 *
 * Real posts through the production publish path, the real event `CardHost`
 * dispatches, real rendered rows at real measured heights.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/chrome/card-host.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const TRANSCRIPT = '[data-testid="overview-transcript"]';
const POST = `${CARD} .overview-cell`;
const JUMP = `${CARD} .tug-jump-to-bottom-button`;

const AT_MS = 1_754_600_000_000;

/** How far the settling row grows, in px — more than the card's follow slack,
 *  so the stale scroll position is unambiguously "off the bottom". */
const SETTLE_GROWTH_PX = 120;

interface WirePost {
  id: number;
  at_ms: number;
  author: "observer";
  body: string;
  refs: never[];
}

function wirePost(id: number): WirePost {
  return {
    id,
    at_ms: AT_MS + id * 1_000,
    author: "observer",
    body: `Post ${id}: the session finished a turn and left a note about what it did, which is enough prose to give this row a height a reader has to scroll past.`,
    refs: [],
  };
}

async function publish(app: App, post: WirePost): Promise<boolean> {
  return app.evalJS<boolean>(
    `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
  );
}

/** What the column and its affordance say about where the reader is, plus the
 *  meta `captureRegionScrolls` would save with them. */
interface Edge {
  atBottom: boolean;
  scrollTop: number;
  visible: string | null;
  /** `data-tug-scroll-state`, verbatim — `null` when the card wrote none. */
  scrollState: string | null;
}

const EDGE_JS = `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var btn = document.querySelector(${JSON.stringify(JUMP)});
  return {
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2,
    scrollTop: Math.round(el.scrollTop),
    visible: btn === null ? null : btn.getAttribute("data-visible"),
    scrollState: el.getAttribute("data-tug-scroll-state"),
  };
})()`;

async function edge(app: App): Promise<Edge> {
  return app.evalJS<Edge>(EDGE_JS);
}

async function openWithPosts(app: App, count: number): Promise<void> {
  await app.nativeKey("o", ["cmd", "ctrl"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
    { timeoutMs: 10_000 },
  );
  for (let id = 20; id < 20 + count; id++) {
    expect(await publish(app, wirePost(id))).toBe(true);
  }
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(POST)}).length === ${count}`,
    { timeoutMs: 10_000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(JUMP)}).getAttribute("data-visible") === "false"`,
    { timeoutMs: 5_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0371 — the Overview's follow-lock holds", () => {
  test(
    "a row settling under a pin does not read as the reader leaving",
    async () => {
      const app = await launchTugApp({
        testName: "at0371-overview-settle-race",
      });
      try {
        await openWithPosts(app, 12);
        const opened = await edge(app);
        note("following the edge", JSON.stringify(opened));
        expect(opened.atBottom).toBe(true);

        // The race, in the order it really happens: the card has pinned
        // (`scrollTop` is the bottom), the last row then settles taller, and
        // the scroll event the pin queued is only now delivered — carrying a
        // position that is no longer the bottom. The observer that would
        // re-pin has not run yet; that is the entire window the defect lived
        // in, so the event is dispatched inside it deliberately.
        const raced = await app.evalJS<{ grew: number; top: number }>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            var cells = el.querySelectorAll(${JSON.stringify(POST)});
            var last = cells[cells.length - 1];
            var before = el.scrollHeight;
            last.style.minHeight =
              (last.getBoundingClientRect().height + ${SETTLE_GROWTH_PX}) + "px";
            var grew = el.scrollHeight - before;
            el.dispatchEvent(new Event("scroll"));
            return { grew: grew, top: Math.round(el.scrollTop) };
          })()`,
        );
        note("the row settled under the pin", JSON.stringify(raced));
        expect(
          raced.grew,
          "the settling row really did grow the column past the follow slack",
        ).toBeGreaterThan(24);

        // The observer gets its turn and re-pins — which it can only do if
        // the stale event left following engaged.
        await app.waitForCondition<boolean>(EDGE_JS + ".atBottom === true", {
          timeoutMs: 5_000,
        });
        const settled = await edge(app);
        note("after the observer's turn", JSON.stringify(settled));
        expect(
          settled.visible,
          "nobody scrolled, so the affordance stays down",
        ).toBe("false");
        expect(
          settled.scrollTop,
          "the card re-pinned past the height the row gained",
        ).toBeGreaterThan(raced.top);

        // The claim underneath the affordance: following is genuinely still
        // on, so the next post keeps the edge.
        expect(await publish(app, wirePost(32))).toBe(true);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length === 13`,
          { timeoutMs: 10_000 },
        );
        const after = await edge(app);
        note("a post after the settle", JSON.stringify(after));
        expect(
          after.atBottom,
          "the lock survived the settle, so the arriving post was followed",
        ).toBe(true);

        // And the reader's own gesture still disengages — the guard reads
        // whose act a scroll was, it does not stop reading.
        await app.evalJS<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            el.scrollTop = Math.max(0, el.scrollTop - 400);
            el.dispatchEvent(new Event("scroll"));
            return true;
          })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JUMP)}).getAttribute("data-visible") === "true"`,
          { timeoutMs: 5_000 },
        );
        const left = await edge(app);
        note("the reader scrolled up", JSON.stringify(left));
        expect(left.atBottom).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a restored at-bottom position re-pins to the live edge, not the saved pixel",
    async () => {
      const app = await launchTugApp({
        testName: "at0371-overview-region-restore",
      });
      try {
        await openWithPosts(app, 12);

        // What `captureRegionScrolls` would take right now. The meta is the
        // whole point: without it the bag carries a bare pixel, and a bare
        // pixel is a lie the moment another post lands.
        const following = await edge(app);
        note("saved while following", JSON.stringify(following));
        expect(
          following.scrollState,
          "a column on the live edge saves the fact, not just the pixel",
        ).toBe(JSON.stringify({ atBottom: true }));
        const savedTop = following.scrollTop;

        // Time passes with the bag on disk: the column grows.
        for (let id = 32; id <= 35; id++) {
          expect(await publish(app, wirePost(id))).toBe(true);
        }
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length === 16`,
          { timeoutMs: 10_000 },
        );
        const grown = await edge(app);
        expect(
          grown.scrollTop,
          "the live edge has moved well past the saved pixel",
        ).toBeGreaterThan(savedTop);

        // The rebuild beat, verbatim: the event `applyRegionScrolls`
        // dispatches before it would write `scrollTop` itself, carrying the
        // stale pixel and the at-bottom meta.
        const claimed = await app.evalJS<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            el.scrollTop = 0;
            var event = new CustomEvent("tug-region-scroll-set", {
              detail: { top: ${savedTop}, left: 0, meta: { atBottom: true } },
              cancelable: true,
              bubbles: false,
            });
            var handled = !el.dispatchEvent(event);
            // The host writes the saved pixel only when nobody claimed it.
            if (!handled) el.scrollTop = ${savedTop};
            return handled;
          })()`,
        );
        expect(
          claimed,
          "the card claims the at-bottom restore rather than letting the pixel land",
        ).toBe(true);
        const restored = await edge(app);
        note("after the restore beat", JSON.stringify(restored));
        expect(
          restored.atBottom,
          "restoring an at-bottom column lands it on the edge that exists NOW",
        ).toBe(true);
        expect(
          restored.visible,
          "and the affordance stays down, because there is nowhere to jump to",
        ).toBe("false");

        // The other half of the contract: a position the reader chose is not
        // claimed, so the host's own write is what lands it.
        await app.evalJS<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            el.scrollTop = Math.max(0, el.scrollTop - 500);
            el.dispatchEvent(new Event("scroll"));
            return true;
          })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JUMP)}).getAttribute("data-visible") === "true"`,
          { timeoutMs: 5_000 },
        );
        const parked = await edge(app);
        note("parked in history", JSON.stringify(parked));
        expect(
          parked.scrollState,
          "a chosen position saves no at-bottom claim, so it restores verbatim",
        ).toBeNull();

        const unclaimed = await app.evalJS<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            var event = new CustomEvent("tug-region-scroll-set", {
              detail: { top: ${parked.scrollTop}, left: 0 },
              cancelable: true,
              bubbles: false,
            });
            return !el.dispatchEvent(event);
          })()`,
        );
        expect(
          unclaimed,
          "no at-bottom meta, no claim — the raw restore path is left alone",
        ).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

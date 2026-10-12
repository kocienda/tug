/**
 * at0728-overview-window.test.ts — the Overview column mounts only the posts
 * near its scrollport, and nothing a reader can see or do tells.
 *
 * The column holds up to 150 posts. It mounts the ones within a viewport of
 * the scrollport (keeping them until they are two away), plus at most one
 * short run being measured, and stands spacers in for the rest at their
 * measured heights. The claim is that this is invisible, so every assertion
 * is about something a reader would notice if it were not:
 *
 * | Phase          | What would break without it                              |
 * |----------------|----------------------------------------------------------|
 * | live edge      | every post mounted anyway, or a document of the wrong    |
 * |                | height, so the scrollbar lies                            |
 * | far scroll     | the wrong post under the eye at a scroll position, or a  |
 * |                | blank band where a spacer stood in for a visible post    |
 * | selection pin  | the post holding a selection unmounted out from under it |
 * |                | when the reader scrolled away ([L23])                    |
 * | post stepping  | ⌃⌘[ stopping, or skipping, where the next post up had    |
 * |                | never been mounted                                       |
 * | follow         | a new post arriving under a following reader and not     |
 * |                | being followed                                           |
 *
 * **The reference.** The Overview has no switch to mount every post, so the
 * fully-mounted column is arithmetic rather than a second mode: one sweep of
 * the column measures every post's cell as it mounts, and the column a full
 * mount would make is `Σh + (n−1)·gap`, plus the first post's top margin, the
 * last child's bottom margin and the column's bottom padding. A read position
 * is checked against the post those heights place there.
 *
 * Posts go in one per `evalJS` call: a single call carrying a large script
 * is the shape that has hung the harness.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const CARD = '[data-testid="overview-card"]';
const TRANSCRIPT = '[data-testid="overview-transcript"]';
const CELL = `${CARD} .overview-cell`;
const FIELD = '[data-testid="overview-composer-field"]';

const POST_COUNT = 150;
const AT_MS = 1_754_600_000_000;

const SENTENCE =
  "The session finished a turn and left a note about what it did, long enough to wrap the rail.";

/** A post whose length varies with its id, so heights differ post to post. */
function wirePost(id: number): Record<string, unknown> {
  const repeats = 1 + (id % 4);
  const paragraphs = [`Post ${id}: ${Array(repeats).fill(SENTENCE).join(" ")}`];
  if (id % 7 === 0) paragraphs.push(`A second paragraph for post ${id}.`);
  return {
    id: 7_280_000 + id,
    at_ms: AT_MS + id * 1_000,
    author: "observer",
    body: paragraphs.join("\n\n"),
    refs: [],
  };
}

/** The number in a post's "Post N:" body, read off a mounted cell. */
const POST_NUMBER_JS = `function (cell) {
  var body = cell.querySelector(".overview-post-body");
  var m = /Post (\\d+):/.exec(body === null ? "" : body.textContent || "");
  return m === null ? -1 : Number(m[1]);
}`;

async function scrollToTop(app: App, top: number): Promise<void> {
  await app.evalJS<boolean>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  el.scrollTop = ${top};
  el.dispatchEvent(new Event("scroll"));
  return true;
})()`);
  // The scroll re-windows on the next commit; let a few frames land.
  await new Promise((r) => setTimeout(r, 400));
}

/** The geometry of the column as it stands. */
interface Column {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  mounted: number;
  /** The post number of the first mounted cell whose bottom is below the scrollport top. */
  firstVisible: number;
  /** Whether mounted cells cover the scrollport top to bottom with no hole wider than a gap. */
  covered: boolean;
}

const COLUMN_JS = `(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var port = el.getBoundingClientRect();
  var gap = parseFloat(getComputedStyle(el).rowGap) || 0;
  var cells = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .map(function (c) { return { n: postNumber(c), r: c.getBoundingClientRect() }; })
    .filter(function (c) { return c.r.bottom > port.top + 0.5 && c.r.top < port.bottom - 0.5; })
    .sort(function (a, b) { return a.r.top - b.r.top; });
  var covered = cells.length > 0;
  if (covered) {
    covered = cells[0].r.top <= port.top + gap + 1 + (el.scrollTop < 40 ? 40 : 0);
    for (var i = 1; i < cells.length && covered; i++) {
      if (cells[i].r.top - cells[i - 1].r.bottom > gap + 1) covered = false;
    }
    var last = cells[cells.length - 1].r.bottom;
    var atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    if (!atEnd && last < port.bottom - gap - 1) covered = false;
  }
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    mounted: document.querySelectorAll(${JSON.stringify(CELL)}).length,
    firstVisible: cells.length > 0 ? cells[0].n : -1,
    covered: covered,
  };
})()`;

async function column(app: App): Promise<Column> {
  return app.evalJS<Column>(COLUMN_JS);
}

/** The fully-mounted reference: every post's height, and the column's fixed parts. */
interface Reference {
  heights: number[];
  gap: number;
  firstMargin: number;
  lastMargin: number;
  padEnd: number;
}

/** Sweep the column top to bottom, measuring every post's cell as it mounts. */
async function measureReference(app: App, col: Column): Promise<Reference> {
  await app.evalJS<boolean>(`(window.__at0728Heights = {}, true)`);
  const step = Math.max(100, Math.floor(col.clientHeight / 2));
  for (let top = 0; top <= col.scrollHeight; top += step) {
    await scrollToTop(app, top);
    await app.evalJS<boolean>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  document.querySelectorAll(${JSON.stringify(CELL)}).forEach(function (c) {
    var n = postNumber(c);
    if (n >= 0) window.__at0728Heights[n] = c.getBoundingClientRect().height;
  });
  return true;
})()`);
  }
  return app.evalJS<Reference>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var cs = getComputedStyle(el);
  var heights = [];
  for (var i = 0; i < ${POST_COUNT}; i++) heights.push(window.__at0728Heights[i] === undefined ? -1 : window.__at0728Heights[i]);
  return {
    heights: heights,
    gap: parseFloat(cs.rowGap) || 0,
    firstMargin: parseFloat(getComputedStyle(el.firstElementChild).marginBlockStart) || 0,
    lastMargin: parseFloat(getComputedStyle(el.lastElementChild).marginBlockEnd) || 0,
    padEnd: parseFloat(cs.paddingBlockEnd) || 0,
  };
})()`);
}

/** The post a full mount would put at the scrollport top, at `scrollTop`. */
function postAt(ref: Reference, scrollTop: number): number {
  let top = ref.firstMargin;
  for (let i = 0; i < ref.heights.length; i++) {
    if (top + ref.heights[i]! > scrollTop + 0.5) return i;
    top += ref.heights[i]! + ref.gap;
  }
  return ref.heights.length - 1;
}

describe.skipIf(!SHOULD_RUN)("at0728 — the Overview column is windowed", () => {
  test(
    "the windowed column reads, scrolls, selects, steps and follows like a fully mounted one",
    async () => {
      const app = await launchTugApp({ testName: "at0728-overview-window" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );
        for (let id = 0; id < POST_COUNT; id++) {
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(id)))})`,
            ),
          ).toBe(true);
        }
        await app.waitForCondition<boolean>(
          `(window.__tug.overviewPosts() || []).length === ${POST_COUNT} &&
            Array.from(document.querySelectorAll(${JSON.stringify(`${CELL} .overview-post-body`)}))
              .some(function (b) { return (b.textContent || "").indexOf("Post ${POST_COUNT - 1}:") === 0; })`,
          { timeoutMs: 30_000 },
        );
        await new Promise((r) => setTimeout(r, 800));

        // ── Live edge: windowed, and the document is the full one's height.
        const edge = await column(app);
        note("at the live edge", JSON.stringify(edge));
        expect(edge.scrollHeight - edge.scrollTop - edge.clientHeight).toBeLessThanOrEqual(2);
        expect(edge.mounted).toBeLessThan(POST_COUNT);

        const ref = await measureReference(app, edge);
        const unmeasured = ref.heights.filter((h) => h < 0).length;
        expect(unmeasured, "the sweep mounted and measured every post").toBe(0);
        const fullHeight =
          ref.heights.reduce((a, b) => a + b, 0) +
          (POST_COUNT - 1) * ref.gap +
          ref.firstMargin +
          ref.lastMargin +
          ref.padEnd;
        await scrollToTop(app, edge.scrollHeight);
        const back = await column(app);
        note("reference", JSON.stringify({ fullHeight, gap: ref.gap, firstMargin: ref.firstMargin, lastMargin: ref.lastMargin, padEnd: ref.padEnd, scrollHeight: back.scrollHeight }));
        expect(Math.abs(back.scrollHeight - fullHeight)).toBeLessThanOrEqual(2);

        // ── Far scroll: the post a full mount would show, and no hole.
        for (const frac of [0.1, 0.5, 0.9]) {
          const top = Math.round((back.scrollHeight - back.clientHeight) * frac);
          await scrollToTop(app, top);
          const at = await column(app);
          note(`at ${frac}`, JSON.stringify({ ...at, expected: postAt(ref, at.scrollTop) }));
          expect(at.mounted).toBeLessThan(POST_COUNT);
          expect(at.covered).toBe(true);
          expect(at.firstVisible).toBe(postAt(ref, at.scrollTop));
        }

        // ── Selection pin: a selection in post 10 survives scrolling away.
        let post10Top = ref.firstMargin;
        for (let i = 0; i < 10; i++) post10Top += ref.heights[i]! + ref.gap;
        await scrollToTop(app, Math.round(post10Top));
        const selected = await app.evalJS<string>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  var cell = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .filter(function (c) { return postNumber(c) === 10; })[0];
  var body = cell.querySelector(".overview-post-body");
  var range = document.createRange();
  range.selectNodeContents(body);
  var sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return sel.toString();
})()`);
        expect(selected).toContain("Post 10:");
        await new Promise((r) => setTimeout(r, 300));
        await scrollToTop(app, back.scrollHeight);
        const kept = await app.evalJS<{ mounted: boolean; text: string }>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  return {
    mounted: Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
      .some(function (c) { return postNumber(c) === 10; }),
    text: document.getSelection().toString(),
  };
})()`);
        note("selection after scrolling to the bottom", JSON.stringify({ mounted: kept.mounted, same: kept.text === selected }));
        expect(kept.mounted).toBe(true);
        expect(kept.text).toBe(selected);
        await app.evalJS<boolean>(`(document.getSelection().removeAllRanges(), true)`);

        // ── Post stepping from the bottom, across posts never mounted there.
        await app.nativeClickAtElement(`${FIELD} .cm-content`);
        await app.waitForCondition<boolean>(
          `document.activeElement !== null
            && document.activeElement.closest(${JSON.stringify(FIELD)}) !== null`,
          { timeoutMs: 10_000 },
        );
        await scrollToTop(app, back.scrollHeight);
        const lowestMountedAtBottom = await app.evalJS<number>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  return Math.min.apply(null, Array.from(document.querySelectorAll(${JSON.stringify(CELL)})).map(postNumber));
})()`);
        const flushJs = `(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var portTop = el.getBoundingClientRect().top;
  var flush = -1;
  document.querySelectorAll(${JSON.stringify(CELL)}).forEach(function (c) {
    if (Math.abs(c.getBoundingClientRect().top - portTop) <= 2) flush = postNumber(c);
  });
  return { flush: flush, top: Math.round(el.scrollTop) };
})()`;
        let prev: { flush: number; top: number } | null = null;
        const steps: number[] = [];
        for (let press = 0; press < 60; press++) {
          const before = await app.evalJS<{ flush: number; top: number }>(flushJs);
          await app.nativeKey("[", ["cmd", "ctrl"]);
          await app.waitForCondition<boolean>(
            `Math.round(document.querySelector(${JSON.stringify(TRANSCRIPT)}).scrollTop) < ${before.top}`,
            { timeoutMs: 5_000 },
          );
          await new Promise((r) => setTimeout(r, 150));
          const now = await app.evalJS<{ flush: number; top: number }>(flushJs);
          steps.push(now.flush);
          expect(now.flush, "each press lands a post's top flush").toBeGreaterThanOrEqual(0);
          if (prev !== null) {
            expect(now.flush, "one post at a time").toBe(prev.flush - 1);
          }
          prev = now;
          if (now.flush < lowestMountedAtBottom - 2) break;
        }
        note("post stepping", JSON.stringify({ lowestMountedAtBottom, steps }));
        expect(prev!.flush).toBeLessThan(lowestMountedAtBottom);

        // ── Follow: back to the edge, and a new post keeps it.
        await scrollToTop(app, 1e9);
        await app.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
})()`,
          { timeoutMs: 5_000 },
        );
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(POST_COUNT)))})`,
          ),
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(`${CELL} .overview-post-body`)}))
            .some(function (b) { return (b.textContent || "").indexOf("Post ${POST_COUNT}:") === 0; })`,
          { timeoutMs: 10_000 },
        );
        await new Promise((r) => setTimeout(r, 500));
        const followed = await column(app);
        note("after a new post while following", JSON.stringify(followed));
        expect(followed.scrollHeight - followed.scrollTop - followed.clientHeight).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

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
 * | opening page   | a column that opens hidden mounting every post on the    |
 * |                | reveal, instead of draining its page under the follow pin|
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
 * | held post      | a post published under a settle's closed motion gate     |
 * |                | mounting under the beats ([D9]), or not being followed   |
 * |                | once the gate opens                                      |
 * | width change   | a reader up in history walked off the post they were     |
 * |                | reading as every post re-wraps and drains above them     |
 * | relaunch       | a relaunched column draining every post it had measured  |
 * |                | before the quit, instead of windowing against the        |
 * |                | persisted heights from its first commit                  |
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
 * @covers tugdeck/src/components/overview/use-overview-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-keyed-ledger.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-persist.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

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
        // ── Opening page: hidden before the first post, so the column has no
        // window to hold when the page arrives — the cold opening's shape.
        await app.evalJS<boolean>(`(function () {
  document.querySelector(${JSON.stringify(TRANSCRIPT)}).style.display = "none";
  return true;
})()`);
        for (let id = 0; id < POST_COUNT; id++) {
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(id)))})`,
            ),
          ).toBe(true);
        }
        await app.waitForCondition<boolean>(
          `(window.__tug.overviewPosts() || []).length === ${POST_COUNT}`,
          { timeoutMs: 30_000 },
        );
        await app.evalJS<boolean>(`(function () {
  document.querySelector(${JSON.stringify(TRANSCRIPT)}).style.display = "";
  return true;
})()`);
        await app.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  return el.hasAttribute("data-window-peak") && !el.hasAttribute("data-window-stale") &&
    Array.from(document.querySelectorAll(${JSON.stringify(`${CELL} .overview-post-body`)}))
      .some(function (b) { return (b.textContent || "").indexOf("Post ${POST_COUNT - 1}:") === 0; });
})()`,
          { timeoutMs: 30_000 },
        );
        await new Promise((r) => setTimeout(r, 800));
        const opening = await app.evalJS<{ peak: number; newestGap: number | null }>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var cs = getComputedStyle(el);
  var portBottom = el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
  var newest = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .filter(function (c) { return postNumber(c) === ${POST_COUNT - 1}; })[0];
  var newestGap = null;
  if (newest !== undefined) {
    var below = (parseFloat(getComputedStyle(newest).marginBlockEnd) || 0) + (parseFloat(cs.paddingBlockEnd) || 0);
    newestGap = portBottom - (newest.getBoundingClientRect().bottom + below);
  }
  return { peak: Number(el.getAttribute("data-window-peak") || "-1"), newestGap: newestGap };
})()`);
        note("opening page", JSON.stringify(opening));
        // A reveal that mounted the page whole would read the whole page.
        expect(opening.peak).toBeGreaterThan(0);
        expect(opening.peak).toBeLessThan(POST_COUNT);
        expect(opening.newestGap, "the newest post is mounted").not.toBeNull();
        expect(Math.abs(opening.newestGap!)).toBeLessThanOrEqual(1);

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
        // The drained opening's window was the one the reference places there.
        expect(edge.firstVisible).toBe(postAt(ref, edge.scrollTop));

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

        // ── Held post: published under a closed motion gate, it waits for the
        // gate to open, even when a commit reaches the column mid-hold.
        const heldPost = POST_COUNT + 1;
        const heldBody = `${CELL} .overview-post-body`;
        const heldMounted = `Array.from(document.querySelectorAll(${JSON.stringify(heldBody)}))
            .some(function (b) { return (b.textContent || "").indexOf("Post ${heldPost}:") === 0; })`;
        // A zero handle is a deck with motion off, where this would pass vacuously.
        const handle = await app.evalJS<number>(`window.__tug.holdMotion(20000)`);
        expect(handle).toBeGreaterThan(0);
        let released = false;
        try {
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(heldPost)))})`,
            ),
          ).toBe(true);
          await app.waitForCondition<boolean>(
            `(window.__tug.overviewPosts() || []).some(function (p) { return p.body.indexOf("Post ${heldPost}:") === 0; })`,
            { timeoutMs: 10_000 },
          );
          const delivered = await app.evalJS<number>(`window.__tug.deliverHeldUnderGate()`);
          expect(delivered).toBeGreaterThanOrEqual(1);
          await new Promise((r) => setTimeout(r, 300));
          expect(await app.evalJS<boolean>(heldMounted), "no cell for the held post while held").toBe(false);
          expect(await app.evalJS<boolean>(`window.__tug.releaseMotion(${handle})`)).toBe(true);
          released = true;
        } finally {
          if (!released) await app.evalJS<boolean>(`window.__tug.releaseMotion(${handle})`);
        }
        await app.waitForCondition<boolean>(heldMounted, { timeoutMs: 10_000 });
        await new Promise((r) => setTimeout(r, 500));
        const afterHeld = await column(app);
        note("after a post published under a held gate", JSON.stringify(afterHeld));
        expect(afterHeld.scrollHeight - afterHeld.scrollTop - afterHeld.clientHeight).toBeLessThanOrEqual(2);

        // ── Width change: a reader up in history, halfway into a post, stays
        // on that line while every post re-wraps and its height drains above
        // them. The column's own width is written, as a rail resize would.
        await scrollToTop(app, Math.round((afterHeld.scrollHeight - afterHeld.clientHeight) * 0.5));
        const readTopJs = (n: number): string => `(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var cell = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .filter(function (c) { return postNumber(c) === ${n}; })[0];
  return cell === undefined ? null : cell.getBoundingClientRect().top - el.getBoundingClientRect().top;
})()`;
        const reading = await column(app);
        expect(reading.firstVisible).toBeGreaterThanOrEqual(0);
        // Put the scrollport top halfway into that post.
        await app.evalJS<boolean>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var cell = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .filter(function (c) { return postNumber(c) === ${reading.firstVisible}; })[0];
  var r = cell.getBoundingClientRect();
  el.scrollTop += r.top - el.getBoundingClientRect().top + r.height / 2;
  el.dispatchEvent(new Event("scroll"));
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 400));
        const readTop = await app.evalJS<number | null>(readTopJs(reading.firstVisible));
        expect(readTop, "the post being read is mounted").not.toBeNull();
        const widths = await app.evalJS<{ before: number; after: number }>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var before = el.clientWidth;
  el.style.width = Math.round(before * 0.7) + "px";
  return { before: before, after: el.clientWidth };
})()`);
        // A width that did not move would pass with nothing held.
        expect(widths.before - widths.after).toBeGreaterThan(50);
        // The drain starts on the observer's delivery; give it a beat to begin.
        await new Promise((r) => setTimeout(r, 300));
        await app.waitForCondition<boolean>(
          `!document.querySelector(${JSON.stringify(TRANSCRIPT)}).hasAttribute("data-window-stale")`,
          { timeoutMs: 30_000 },
        );
        // The hold rides the settle tail past drain end.
        await new Promise((r) => setTimeout(r, 900));
        const heldTop = await app.evalJS<number | null>(readTopJs(reading.firstVisible));
        note(
          "width change",
          JSON.stringify({ post: reading.firstVisible, widths, readTop, heldTop }),
        );
        expect(heldTop, "the post being read is still mounted").not.toBeNull();
        expect(Math.abs(heldTop! - readTop!)).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a relaunched column windows from its first commit",
    async () => {
      // Two processes over one temp tugbank, as at0535 does for the Overview's
      // draft. Published posts are never persisted, so phase B re-publishes the
      // same 150 (the same ids give the same post keys) behind a hidden column,
      // and the reveal is the column's first look at them.
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const cardIdJs = `(function () {
  var el = document.querySelector(${JSON.stringify(CARD)});
  var host = el === null ? null : el.closest("[data-card-id]");
  return host === null ? "" : (host.getAttribute("data-card-id") || "");
})()`;
      /** The post under the scrollport top and its top edge's offset from it. */
      const readTopPost = (app: App): Promise<{ n: number; offset: number }> =>
        app.evalJS(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var top = el.getBoundingClientRect().top;
  var cells = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .map(function (c) { return { n: postNumber(c), r: c.getBoundingClientRect() }; })
    .filter(function (c) { return c.r.bottom > top + 0.5; })
    .sort(function (a, b) { return a.r.top - b.r.top; });
  return cells.length === 0 ? { n: -1, offset: 0 } : { n: cells[0].n, offset: cells[0].r.top - top };
})()`);
      const publishAll = async (app: App): Promise<void> => {
        for (let id = 0; id < POST_COUNT; id++) {
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(id)))})`,
            ),
          ).toBe(true);
        }
        await app.waitForCondition<boolean>(
          `(window.__tug.overviewPosts() || []).length === ${POST_COUNT}`,
          { timeoutMs: 30_000 },
        );
      };
      try {
        // ── Phase A: publish with the column visible, so each post is
        // measured as it lands; scroll to a mid-column post; quit.
        let cardId = "";
        let deckState: unknown = null;
        let phaseA: { n: number; offset: number };
        {
          const app = await launchTugApp({
            testName: "at0728-relaunch-A",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          await app.nativeKey("o", ["cmd", "ctrl"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await publishAll(app);
          await app.waitForCondition<boolean>(
            `!document.querySelector(${JSON.stringify(TRANSCRIPT)}).hasAttribute("data-window-stale")`,
            { timeoutMs: 30_000 },
          );
          const col = await column(app);
          await scrollToTop(app, Math.round((col.scrollHeight - col.clientHeight) * 0.5));
          await new Promise((r) => setTimeout(r, 500));
          phaseA = await readTopPost(app);
          cardId = await app.evalJS<string>(cardIdJs);
          expect(cardId).not.toBe("");
          deckState = await app.evalJS<unknown>(`window.tugdeck.diag.getDeckState()`);
          await app.quitGracefully();
        }

        // ── Phase A assertion: the heights are on disk. ──
        const onDisk = tugbankRead<{
          components?: Record<string, { entries?: unknown[] }> | null;
        }>(tugbankPath, "dev.tugapp.deck.cardstate", cardId);
        expect(onDisk?.type).toBe("json");
        const bag = onDisk!.value!;
        const heightsKey = Object.keys(bag.components ?? {}).find((k) => k.endsWith("overview-heights"));
        expect(heightsKey).toBeDefined();
        const recorded = bag.components![heightsKey!]!.entries?.length ?? 0;
        expect(recorded).toBe(POST_COUNT);

        // ── Phase B: re-inject the bag, re-publish behind a hidden column, reveal. ──
        {
          const app = await launchTugApp({
            testName: "at0728-relaunch-B",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({
              state: deckState as never,
              cardStates: { [cardId]: bag as Record<string, unknown> },
              focusCardId: cardId,
            });
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
              { timeoutMs: 15_000 },
            );
            await app.evalJS<boolean>(`(function () {
  document.querySelector(${JSON.stringify(TRANSCRIPT)}).style.display = "none";
  return true;
})()`);
            note(
              "relaunch: live bag heights before the posts arrive",
              String(
                await app.evalJS<number>(`(function () {
  window.tugdeck && window.tugdeck.saveState && window.tugdeck.saveState();
  var bag = window.__tug.getCardStateBag(${JSON.stringify(cardId)});
  var c = (bag && bag.components) || {};
  var k = Object.keys(c).filter(function (x) { return /overview-heights$/.test(x); })[0];
  return k === undefined || !c[k] ? -1 : (c[k].entries || []).length;
})()`),
              ),
            );
            await publishAll(app);
            const atReveal = await app.evalJS<{ stale: string | null }>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  el.style.display = "";
  return { stale: el.getAttribute("data-window-stale") };
})()`);
            const firstSample = await app.evalJS<{ stale: string | null }>(
              `({ stale: document.querySelector(${JSON.stringify(TRANSCRIPT)}).getAttribute("data-window-stale") })`,
            );
            note(
              `relaunch: ${recorded} heights recorded; data-window-stale at the reveal ` +
                `${atReveal.stale ?? "absent"}, at the first sample after it ${firstSample.stale ?? "absent"}`,
            );
            // Every post was seeded fresh at an unchanged width: none is pending.
            expect(atReveal.stale).toBeNull();
            expect(firstSample.stale).toBeNull();

            // The restore is CardHost's raw `scrollTop` replay, retried on
            // subtree mutation; against exact heights it lands on the post.
            await app.waitForCondition<boolean>(
              `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  return el.hasAttribute("data-window-peak") && el.scrollTop > 0;
})()`,
              { timeoutMs: 15_000 },
            );
            await new Promise((r) => setTimeout(r, 1500));
            const peak = await app.evalJS<number>(
              `Number(document.querySelector(${JSON.stringify(TRANSCRIPT)}).getAttribute("data-window-peak") || "-1")`,
            );
            const phaseB = await readTopPost(app);
            note(
              `relaunch: peak mounted ${peak}; top post ${phaseA.n} at ${phaseA.offset.toFixed(2)} → ` +
                `${phaseB.n} at ${phaseB.offset.toFixed(2)}`,
            );
            expect(peak).toBeGreaterThan(0);
            expect(peak).toBeLessThan(POST_COUNT);
            expect(phaseB.n).toBe(phaseA.n);
            expect(Math.abs(phaseB.offset - phaseA.offset)).toBeLessThanOrEqual(1);
          } finally {
            await app.quitGracefully();
          }
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

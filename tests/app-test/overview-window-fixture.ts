/**
 * overview-window-fixture.ts — the posts, the column readers and the
 * fully-mounted reference the at0728 Overview window files share.
 *
 * Split out of `at0728-overview-window.test.ts` when that file was cut into
 * `at0728-overview-window-read`, `-follow` and `-relaunch` to keep each under
 * the 20 s budget.
 *
 * Every reader and driver here takes the page holding the Overview card —
 * its body (`kindBody(app, "overview")`); the transcript is not in the
 * shell's document.
 */

import { type App, type BodyApp } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 240_000;

export const CARD = '[data-testid="overview-card"]';
export const TRANSCRIPT = '[data-testid="overview-transcript"]';
export const CELL = `${CARD} .overview-cell`;
export const FIELD = '[data-testid="overview-composer-field"]';

export const POST_COUNT = 150;
export const AT_MS = 1_754_600_000_000;

export const SENTENCE =
  "The session finished a turn and left a note about what it did, long enough to wrap the rail.";

/** A post whose length varies with its id, so heights differ post to post. */
export function wirePost(id: number): Record<string, unknown> {
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
export const POST_NUMBER_JS = `function (cell) {
  var body = cell.querySelector(".overview-post-body");
  var m = /Post (\\d+):/.exec(body === null ? "" : body.textContent || "");
  return m === null ? -1 : Number(m[1]);
}`;

export async function scrollToTop(page: BodyApp | App, top: number): Promise<void> {
  await page.evalJS<boolean>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  el.scrollTop = ${top};
  el.dispatchEvent(new Event("scroll"));
  return true;
})()`);
  // The scroll re-windows on the next commit; let a few frames land.
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Scroll the column to `top` and wait for the mounted cells to cover the
 * scrollport — the reference sweep's step. The sweep asserts nothing about
 * coverage; it only needs this position's posts mounted to measure them, so
 * it waits on that rather than on {@link scrollToTop}'s fixed beat (fifty
 * beats of 400 ms were most of the file's time).
 */
export async function scrollToTopCovered(page: BodyApp | App, top: number): Promise<void> {
  await page.evalJS<boolean>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  el.scrollTop = ${top};
  el.dispatchEvent(new Event("scroll"));
  return true;
})()`);
  await page.waitForCondition<boolean>(`(${COLUMN_JS}).covered`, { timeoutMs: 5_000 });
}

/** The geometry of the column as it stands. */
export interface Column {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  mounted: number;
  /** The post number of the first mounted cell whose bottom is below the scrollport top. */
  firstVisible: number;
  /** Whether mounted cells cover the scrollport top to bottom with no hole wider than a gap. */
  covered: boolean;
}

export const COLUMN_JS = `(function () {
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

export async function column(page: BodyApp | App): Promise<Column> {
  return page.evalJS<Column>(COLUMN_JS);
}

/** The fully-mounted reference: every post's height, and the column's fixed parts. */
export interface Reference {
  heights: number[];
  gap: number;
  firstMargin: number;
  lastMargin: number;
  padEnd: number;
}

/** Sweep the column top to bottom, measuring every post's cell as it mounts. */
export async function measureReference(page: BodyApp | App, col: Column): Promise<Reference> {
  await page.evalJS<boolean>(`(window.__at0728Heights = {}, true)`);
  const step = Math.max(100, Math.floor(col.clientHeight / 2));
  for (let top = 0; top <= col.scrollHeight; top += step) {
    await scrollToTopCovered(page, top);
    await page.evalJS<boolean>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  document.querySelectorAll(${JSON.stringify(CELL)}).forEach(function (c) {
    var n = postNumber(c);
    if (n >= 0) window.__at0728Heights[n] = c.getBoundingClientRect().height;
  });
  return true;
})()`);
  }
  return page.evalJS<Reference>(`(function () {
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
export function postAt(ref: Reference, scrollTop: number): number {
  let top = ref.firstMargin;
  for (let i = 0; i < ref.heights.length; i++) {
    if (top + ref.heights[i]! > scrollTop + 0.5) return i;
    top += ref.heights[i]! + ref.gap;
  }
  return ref.heights.length - 1;
}

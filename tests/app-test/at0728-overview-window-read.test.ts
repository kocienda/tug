/**
 * at0728-overview-window-read.test.ts — the Overview column mounts only the posts
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
 * Cut from `at0728-overview-window` to fit the 20 s budget. This file carries
 * the opening page, the live edge, far scroll, the selection pin and post
 * stepping; `at0728-overview-window-follow` carries follow, the held post and
 * the width change, and `-relaunch` the relaunch. The reference sweep waits
 * for each step's posts to cover the scrollport instead of a fixed beat. The
 * posts and the readers are `overview-window-fixture.ts`.
 *
 * @family at0728-overview-window
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-window.ts
 * @covers tugdeck/src/components/overview/use-overview-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-keyed-ledger.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-persist.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  CELL,
  FIELD,
  POST_COUNT,
  POST_NUMBER_JS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TRANSCRIPT,
  column,
  measureReference,
  postAt,
  scrollToTop,
  wirePost,
} from "./overview-window-fixture";
import { kindBody } from "./_harness/card-reach";

describe.skipIf(!SHOULD_RUN)("at0728 — the Overview column is windowed: reading it", () => {
  test(
    "the windowed column reads, scrolls, selects and steps like a fully mounted one",
    async () => {
      const app = await launchTugApp({ testName: "at0728-overview-window" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );
        // ── Opening page: hidden before the first post, so the column has no
        // window to hold when the page arrives — the cold opening's shape.
        await kindBody(app, "overview").evalJS<boolean>(`(function () {
  document.querySelector(${JSON.stringify(TRANSCRIPT)}).style.display = "none";
  return true;
})()`);
        for (let id = 0; id < POST_COUNT; id++) {
          expect(
            await kindBody(app, "overview").evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(id)))})`,
            ),
          ).toBe(true);
        }
        await kindBody(app, "overview").waitForCondition<boolean>(
          `(window.__tug.overviewPosts() || []).length === ${POST_COUNT}`,
          { timeoutMs: 30_000 },
        );
        await kindBody(app, "overview").evalJS<boolean>(`(function () {
  document.querySelector(${JSON.stringify(TRANSCRIPT)}).style.display = "";
  return true;
})()`);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  return el.hasAttribute("data-window-peak") && !el.hasAttribute("data-window-stale") &&
    Array.from(document.querySelectorAll(${JSON.stringify(`${CELL} .overview-post-body`)}))
      .some(function (b) { return (b.textContent || "").indexOf("Post ${POST_COUNT - 1}:") === 0; });
})()`,
          { timeoutMs: 30_000 },
        );
        await new Promise((r) => setTimeout(r, 800));
        const opening = await kindBody(app, "overview").evalJS<{ peak: number; newestGap: number | null }>(`(function () {
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
        const edge = await column(kindBody(app, "overview"));
        note("at the live edge", JSON.stringify(edge));
        expect(edge.scrollHeight - edge.scrollTop - edge.clientHeight).toBeLessThanOrEqual(2);
        expect(edge.mounted).toBeLessThan(POST_COUNT);

        const ref = await measureReference(kindBody(app, "overview"), edge);
        const unmeasured = ref.heights.filter((h) => h < 0).length;
        expect(unmeasured, "the sweep mounted and measured every post").toBe(0);
        const fullHeight =
          ref.heights.reduce((a, b) => a + b, 0) +
          (POST_COUNT - 1) * ref.gap +
          ref.firstMargin +
          ref.lastMargin +
          ref.padEnd;
        await scrollToTop(kindBody(app, "overview"),edge.scrollHeight);
        const back = await column(kindBody(app, "overview"));
        note("reference", JSON.stringify({ fullHeight, gap: ref.gap, firstMargin: ref.firstMargin, lastMargin: ref.lastMargin, padEnd: ref.padEnd, scrollHeight: back.scrollHeight }));
        expect(Math.abs(back.scrollHeight - fullHeight)).toBeLessThanOrEqual(2);
        // The drained opening's window was the one the reference places there.
        expect(edge.firstVisible).toBe(postAt(ref, edge.scrollTop));

        // ── Far scroll: the post a full mount would show, and no hole.
        for (const frac of [0.1, 0.5, 0.9]) {
          const top = Math.round((back.scrollHeight - back.clientHeight) * frac);
          await scrollToTop(kindBody(app, "overview"),top);
          const at = await column(kindBody(app, "overview"));
          note(`at ${frac}`, JSON.stringify({ ...at, expected: postAt(ref, at.scrollTop) }));
          expect(at.mounted).toBeLessThan(POST_COUNT);
          expect(at.covered).toBe(true);
          expect(at.firstVisible).toBe(postAt(ref, at.scrollTop));
        }

        // ── Selection pin: a selection in post 10 survives scrolling away.
        let post10Top = ref.firstMargin;
        for (let i = 0; i < 10; i++) post10Top += ref.heights[i]! + ref.gap;
        await scrollToTop(kindBody(app, "overview"),Math.round(post10Top));
        const selected = await kindBody(app, "overview").evalJS<string>(`(function () {
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
        await scrollToTop(kindBody(app, "overview"),back.scrollHeight);
        const kept = await kindBody(app, "overview").evalJS<{ mounted: boolean; text: string }>(`(function () {
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
        await kindBody(app, "overview").evalJS<boolean>(`(document.getSelection().removeAllRanges(), true)`);

        // ── Post stepping from the bottom, across posts never mounted there.
        await kindBody(app, "overview").nativeClickAtElement(`${FIELD} .cm-content`);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `document.activeElement !== null
            && document.activeElement.closest(${JSON.stringify(FIELD)}) !== null`,
          { timeoutMs: 10_000 },
        );
        await scrollToTop(kindBody(app, "overview"),back.scrollHeight);
        const lowestMountedAtBottom = await kindBody(app, "overview").evalJS<number>(`(function () {
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
          const before = await kindBody(app, "overview").evalJS<{ flush: number; top: number }>(flushJs);
          await app.nativeKey("[", ["cmd", "ctrl"]);
          await kindBody(app, "overview").waitForCondition<boolean>(
            `Math.round(document.querySelector(${JSON.stringify(TRANSCRIPT)}).scrollTop) < ${before.top}`,
            { timeoutMs: 5_000 },
          );
          await new Promise((r) => setTimeout(r, 150));
          const now = await kindBody(app, "overview").evalJS<{ flush: number; top: number }>(flushJs);
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
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

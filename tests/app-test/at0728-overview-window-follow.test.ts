/**
 * at0728-overview-window-follow.test.ts — the Overview column mounts only the posts
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
 * follow, the held post and the width change, on a column whose 150 posts
 * were published while it was visible; `at0728-overview-window-read` carries
 * the opening page through post stepping, and `-relaunch` the relaunch. The
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
  POST_COUNT,
  POST_NUMBER_JS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TRANSCRIPT,
  column,
  scrollToTop,
  wirePost,
} from "./overview-window-fixture";
import { kindBody } from "./_harness/card-reach";

describe.skipIf(!SHOULD_RUN)("at0728 — the Overview column is windowed: following it", () => {
  test(
    "a following column keeps the newest post, holds one published under a closed gate, and keeps the reader's line through a width change",
    async () => {
      const app = await launchTugApp({ testName: "at0728-overview-window-follow" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );
        // Every post published into the visible column, so each is measured
        // as it lands, and the window drained: the column the follow phase
        // starts from.
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
        await kindBody(app, "overview").waitForCondition<boolean>(
          `!document.querySelector(${JSON.stringify(TRANSCRIPT)}).hasAttribute("data-window-stale")`,
          { timeoutMs: 30_000 },
        );

        // ── Follow: back to the edge, and a new post keeps it.
        await scrollToTop(kindBody(app, "overview"),1e9);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
})()`,
          { timeoutMs: 5_000 },
        );
        expect(
          await kindBody(app, "overview").evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(POST_COUNT)))})`,
          ),
        ).toBe(true);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(`${CELL} .overview-post-body`)}))
            .some(function (b) { return (b.textContent || "").indexOf("Post ${POST_COUNT}:") === 0; })`,
          { timeoutMs: 10_000 },
        );
        await new Promise((r) => setTimeout(r, 500));
        const followed = await column(kindBody(app, "overview"));
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
            await kindBody(app, "overview").evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(heldPost)))})`,
            ),
          ).toBe(true);
          await kindBody(app, "overview").waitForCondition<boolean>(
            `(window.__tug.overviewPosts() || []).some(function (p) { return p.body.indexOf("Post ${heldPost}:") === 0; })`,
            { timeoutMs: 10_000 },
          );
          const delivered = await app.evalJS<number>(`window.__tug.deliverHeldUnderGate()`);
          expect(delivered).toBeGreaterThanOrEqual(1);
          await new Promise((r) => setTimeout(r, 300));
          expect(await kindBody(app, "overview").evalJS<boolean>(heldMounted), "no cell for the held post while held").toBe(false);
          expect(await app.evalJS<boolean>(`window.__tug.releaseMotion(${handle})`)).toBe(true);
          released = true;
        } finally {
          if (!released) await app.evalJS<boolean>(`window.__tug.releaseMotion(${handle})`);
        }
        await kindBody(app, "overview").waitForCondition<boolean>(heldMounted, { timeoutMs: 10_000 });
        await new Promise((r) => setTimeout(r, 500));
        const afterHeld = await column(kindBody(app, "overview"));
        note("after a post published under a held gate", JSON.stringify(afterHeld));
        expect(afterHeld.scrollHeight - afterHeld.scrollTop - afterHeld.clientHeight).toBeLessThanOrEqual(2);

        // ── Width change: a reader up in history, halfway into a post, stays
        // on that line while every post re-wraps and its height drains above
        // them. The column's own width is written, as a rail resize would.
        await scrollToTop(kindBody(app, "overview"),Math.round((afterHeld.scrollHeight - afterHeld.clientHeight) * 0.5));
        const readTopJs = (n: number): string => `(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var cell = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .filter(function (c) { return postNumber(c) === ${n}; })[0];
  return cell === undefined ? null : cell.getBoundingClientRect().top - el.getBoundingClientRect().top;
})()`;
        const reading = await column(kindBody(app, "overview"));
        expect(reading.firstVisible).toBeGreaterThanOrEqual(0);
        // Put the scrollport top halfway into that post.
        await kindBody(app, "overview").evalJS<boolean>(`(function () {
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
        const readTop = await kindBody(app, "overview").evalJS<number | null>(readTopJs(reading.firstVisible));
        expect(readTop, "the post being read is mounted").not.toBeNull();
        const widths = await kindBody(app, "overview").evalJS<{ before: number; after: number }>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var before = el.clientWidth;
  el.style.width = Math.round(before * 0.7) + "px";
  return { before: before, after: el.clientWidth };
})()`);
        // A width that did not move would pass with nothing held.
        expect(widths.before - widths.after).toBeGreaterThan(50);
        // The drain starts on the observer's delivery; give it a beat to begin.
        await new Promise((r) => setTimeout(r, 300));
        await kindBody(app, "overview").waitForCondition<boolean>(
          `!document.querySelector(${JSON.stringify(TRANSCRIPT)}).hasAttribute("data-window-stale")`,
          { timeoutMs: 30_000 },
        );
        // The hold rides the settle tail past drain end.
        await new Promise((r) => setTimeout(r, 900));
        const heldTop = await kindBody(app, "overview").evalJS<number | null>(readTopJs(reading.firstVisible));
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
});

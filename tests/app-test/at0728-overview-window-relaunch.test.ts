/**
 * at0728-overview-window-relaunch.test.ts — the Overview column mounts only the posts
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
 * the relaunch; `at0728-overview-window-read` carries the opening page through
 * post stepping, and `-follow` follow, the held post and the width change.
 * The posts and the readers are `overview-window-fixture.ts`.
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

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";
import {
  CARD,
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

describe.skipIf(!SHOULD_RUN)("at0728 — the Overview column is windowed: across a relaunch", () => {
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
        kindBody(app, "overview").evalJS(`(function () {
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
            await kindBody(app, "overview").evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(id)))})`,
            ),
          ).toBe(true);
        }
        // The Overview store the posts went into is the card's body's.
        await kindBody(app, "overview").waitForCondition<boolean>(
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
          await kindBody(app, "overview").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await publishAll(app);
          await kindBody(app, "overview").waitForCondition<boolean>(
            `!document.querySelector(${JSON.stringify(TRANSCRIPT)}).hasAttribute("data-window-stale")`,
            { timeoutMs: 30_000 },
          );
          const col = await column(kindBody(app, "overview"));
          await scrollToTop(kindBody(app, "overview"),Math.round((col.scrollHeight - col.clientHeight) * 0.5));
          await new Promise((r) => setTimeout(r, 500));
          phaseA = await readTopPost(app);
          cardId = await kindBody(app, "overview").evalJS<string>(cardIdJs);
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
            await kindBody(app, "overview").waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
              { timeoutMs: 15_000 },
            );
            await kindBody(app, "overview").evalJS<boolean>(`(function () {
  document.querySelector(${JSON.stringify(TRANSCRIPT)}).style.display = "none";
  return true;
})()`);
            note(
              "relaunch: live bag heights before the posts arrive",
              String(
                await (async () => {
                  await app.evalJS<boolean>(
                    `(window.tugdeck && window.tugdeck.saveState && window.tugdeck.saveState(), true)`,
                  );
                  // The live bag is the card's own, in its body.
                  return kindBody(app, "overview").evalJS<number>(`(function () {
  var bag = window.__tug.getCardStateBag(${JSON.stringify(cardId)});
  var c = (bag && bag.components) || {};
  var k = Object.keys(c).filter(function (x) { return /overview-heights$/.test(x); })[0];
  return k === undefined || !c[k] ? -1 : (c[k].entries || []).length;
})()`);
                })(),
              ),
            );
            await publishAll(app);
            const atReveal = await kindBody(app, "overview").evalJS<{ stale: string | null }>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  el.style.display = "";
  return { stale: el.getAttribute("data-window-stale") };
})()`);
            const firstSample = await kindBody(app, "overview").evalJS<{ stale: string | null }>(
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
            await kindBody(app, "overview").waitForCondition<boolean>(
              `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  return el.hasAttribute("data-window-peak") && el.scrollTop > 0;
})()`,
              { timeoutMs: 15_000 },
            );
            await new Promise((r) => setTimeout(r, 1500));
            const peak = await kindBody(app, "overview").evalJS<number>(
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

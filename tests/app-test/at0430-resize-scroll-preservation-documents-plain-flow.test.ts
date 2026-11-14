/**
 * at0430-resize-scroll-preservation-documents-plain-flow.test.ts — changing a
 * plain-flow card's width never moves what the reader is looking at.
 *
 * One of the at0430-resize-scroll-preservation split, a test to a file so each
 * launch fits its own budget (it was the first of the three document cases in
 * `at0430-resize-scroll-preservation-documents`; the others are
 * `-documents-codemirror` and `-documents-pdf`). The decks and instruments are
 * `resize-scroll-preservation-fixture.ts`. The gesture is asserted to have
 * raised a resize episode (the frame's `data-resize-episode` stamp), so a
 * card whose content happens not to reflow at that width cannot pass while
 * the mechanism is dead.
 *
 *  1. **The generic fallback on a plain-flow card.** A card that never took
 *     over its own scrolling owns no anchor semantics and never claims the
 *     episode, so it is held by the module's own element anchor in the PANE's
 *     content box — a different code path from the transcript's resolver, and
 *     the one every future card inherits by default.
 *
 * @covers tugdeck/src/lib/resize-episode.ts
 * @covers tugdeck/src/lib/cm6-scroll-anchor.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/cards/pdf-view.tsx
 * @covers tugdeck/src/lib/pdf-layout.ts
 * @family at0430-resize-scroll-preservation
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import {
  AFTER_LAND_MS,
  ANCHOR_TOLERANCE_PX,
  FRAME,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  armEpisodeWatch,
  claimSubject,
  episodeCount,
  galleryDeck,
  paneWidth,
  readSubject,
  wait,
  waitForEpisodesClosed,
} from "./resize-scroll-preservation-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0430 — a width change never moves what the reader is looking at",
  () => {
    test(
      "a plain-flow card is held by the generic element anchor",
      async () => {
        // A card that never took over its own scrolling scrolls in the PANE's
        // content box, owns no anchor semantics, and never claims the episode
        // — so the module's own element anchor holds it. That is the path
        // every card inherits without writing a line of code, and it is what
        // lets the invariant be stated for cards of all types rather than for
        // the ones that opted in.
        //
        // The gesture is the deck-wide Card Width, a third raise site and the
        // one that bypasses `movePane` entirely.
        const app = await launchTugApp({ testName: "at0430-plain-flow" });
        try {
          await app.seedDeckState({ state: galleryDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 1`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          // The card is its own page: the pane's content box it scrolls in
          // is the body's own — the page draws its pane's chrome and holds
          // that one pane. The pane frame, its width and its episode stamp
          // stay the shell's.
          const card = await waitForBodyReady(app, "A");
          const scroller = `.tug-pane-content`;
          await card.waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(scroller)});
              return el !== null && el.scrollHeight > el.clientHeight + 200;
            })()`,
            { timeoutMs: 10_000 },
          );
          await armEpisodeWatch(app, FRAME);

          await card.evalJS<null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(scroller)});
              el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * 0.4);
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(300);

          const before = await claimSubject(card, scroller);
          const widthBefore = await paneWidth(app, FRAME);
          const episodesBefore = await episodeCount(app);

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", { preset: "slim" }), null)`,
          );
          await waitForEpisodesClosed(app, FRAME, episodesBefore);

          const widthAfter = await paneWidth(app, FRAME);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await readSubject(card, scroller);
          expect(after).not.toBeNull();
          note(
            `plain flow: width ${widthBefore}→${widthAfter},` +
              ` subject delta ${before.delta}→${after!.delta},` +
              ` scrollTop ${before.scrollTop}→${after!.scrollTop}`,
          );
          expect(Math.abs(after!.delta - before.delta)).toBeLessThanOrEqual(
            ANCHOR_TOLERANCE_PX,
          );
          // Stated separately because it is the failure this leg actually
          // caught: a scroller the module could find no anchor element for
          // used to resolve to the TOP, so "we could not find your place"
          // was answered by throwing the reader back to the beginning of the
          // document — worse than the drift the module exists to prevent, and
          // invisible to a delta-only assertion on content that happens to
          // reflow. Zero is not a preserved position.
          expect(after!.scrollTop).toBeGreaterThan(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

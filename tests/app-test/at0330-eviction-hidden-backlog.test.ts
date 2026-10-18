/**
 * at0330-eviction-hidden-backlog.test.ts — the session transcript renders
 * through `evictOffscreen`: rows more than a viewport from the scrollport are
 * UNMOUNTED, their exact measured heights standing in the list's spacers.
 *
 * The mode's whole claim is that this is invisible, so the assertions are
 * about what the user would notice if it weren't:
 *
 * | Test                | What would break without it                          |
 * |---------------------|------------------------------------------------------|
 * | hidden backlog      | a hidden tab's backlog mounting whole on the reveal,  |
 * |                     | instead of draining a capped run per commit           |
 *
 * The held-append leg (a turn appended under the shell's held motion gate
 * waits to mount) was removed by [B29] of the bodies migration brief: a
 * body's connection is `NEVER_HELD` and streams through the shell's settles.
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
 * `tug-list-view.tsx` and `session-card-transcript.tsx` stand at their
 * accepted fan-out, so one at0330-eviction file names each (reflow and
 * hidden-restore) and the rest are found through the list's internals.
 *
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @family at0330-eviction
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TURNS,
  scrollTo,
  seedTurns,
  standUp,
} from "./eviction-fixture";

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — hidden backlog", () => {
  test(
    "a hidden tab's backlog drains on reveal",
    async () => {
      const app = await standUp("at0330-hidden-backlog");
      try {
        // Rest at the bottom, following: the file's eviction precondition.
        await scrollTo(app, 1);
        const before = await app.body("A").evalJS<{ fallbacks: number; following: boolean }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var state = el.getAttribute("data-tug-scroll-state");
  return {
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
    following: state !== null && JSON.parse(state).atBottom === true,
  };
})()`);
        expect(before.following).toBe(true);

        // Hide the scroller the way an inactive card tab is hidden, and let
        // a backlog of turns arrive behind it.
        await app.body("A").evalJS<boolean>(`(function () {
  document.querySelector('${SCROLLER}').style.display = "none";
  return true;
})()`);
        await seedTurns(app, TURNS, TURNS);

        // Reveal, and wait for the backlog to drain.
        await app.body("A").evalJS<boolean>(`(function () {
  document.querySelector('${SCROLLER}').style.display = "";
  return true;
})()`);
        await app.body("A").waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return el.hasAttribute("data-evict-active") && !el.hasAttribute("data-evict-stale");
})()`,
          { timeoutMs: 30_000, pollMs: 250 },
        );
        await app.body("A").waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
})()`,
          { timeoutMs: 8000, pollMs: 100 },
        );

        const after = await app.body("A").evalJS<{
          peak: number;
          fallbacks: number;
          following: boolean;
          gap: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var state = el.getAttribute("data-tug-scroll-state");
  return {
    peak: Number(el.getAttribute("data-evict-peak") || "-1"),
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
    following: state !== null && JSON.parse(state).atBottom === true,
    gap: el.scrollHeight - el.scrollTop - el.clientHeight,
  };
})()`);
        note(
          `hidden backlog: ${TURNS} turns behind the hide, peak mounted ${after.peak}, ` +
            `fallbacks ${before.fallbacks} → ${after.fallbacks}, bottom gap ${after.gap.toFixed(1)}`,
        );
        // The backlog alone is more rows than this: a reveal that mounted it
        // as one segment would read above the bound.
        expect(after.peak).toBeGreaterThan(0);
        expect(after.peak).toBeLessThan(TURNS);
        expect(after.fallbacks - before.fallbacks).toBe(0);
        expect(after.following).toBe(true);
        expect(after.gap).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

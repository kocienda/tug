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
 * | held append         | a row with no height mounting under a settle's beats  |
 * |                     | ([D9]), or a follower left behind once the gate opens |
 *
 * The seeded transcript and the instruments are `eviction-fixture.ts`.
 * `tug-list-view.tsx` and `session-card-transcript.tsx` stand at their
 * accepted fan-out, so one at0330-eviction file names each (reflow and
 * hidden-restore) and the rest are found through the list's internals.
 *
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  FEED_CODE_OUTPUT,
  SCROLLER,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  TURNS,
  readRowCount,
  replyText,
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
        const before = await app.evalJS<{ fallbacks: number; following: boolean }>(`(function () {
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
        await app.evalJS<boolean>(`(function () {
  document.querySelector('${SCROLLER}').style.display = "none";
  return true;
})()`);
        await seedTurns(app, TURNS, TURNS);

        // Reveal, and wait for the backlog to drain.
        await app.evalJS<boolean>(`(function () {
  document.querySelector('${SCROLLER}').style.display = "";
  return true;
})()`);
        await app.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return el.hasAttribute("data-evict-active") && !el.hasAttribute("data-evict-stale");
})()`,
          { timeoutMs: 30_000, pollMs: 250 },
        );
        await app.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
})()`,
          { timeoutMs: 8000, pollMs: 100 },
        );

        const after = await app.evalJS<{
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

  test(
    "a turn appended under a held motion gate mounts after the gate opens",
    async () => {
      const app = await standUp("at0330-held-append");
      try {
        // Rest at the bottom, following.
        const rows = await readRowCount(app);
        const mountedIndices = (): Promise<number[]> =>
          app.evalJS<number[]>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return Array.prototype.map.call(
    el.querySelectorAll("[data-tug-list-cell-index]"),
    function (c) { return Number(c.getAttribute("data-tug-list-cell-index")); }
  ).sort(function (a, b) { return a - b; });
})()`);
        const before = await mountedIndices();

        // Close the gate as a settle's beats do. A zero handle is a deck with
        // motion off, where nothing holds and this case would pass vacuously.
        const handle = await app.evalJS<number>(`window.__tug.holdMotion(20000)`);
        expect(handle).toBeGreaterThan(0);
        let released = false;
        try {
          // Drive the new turn. The connection parks the engine's batches
          // under the gate and the list's own subscription is held, so the
          // harness's settle wait would never return: drive without it, and
          // hand the parked data and the held notifications over under the
          // gate — the commit a parent re-render or an unheld update would
          // make over data that changed mid-motion.
          const drive = (action: Record<string, unknown>): Promise<null> =>
            app.evalJS<null>(
              `(window.__tug.driveSession("A", ${JSON.stringify(action)}), null)`,
            );
          const frame = (decoded: Record<string, unknown>): Promise<null> =>
            drive({
              op: "ingestFrame",
              feedId: FEED_CODE_OUTPUT,
              decoded: { tug_session_id: SID, ...decoded },
            });
          const msgId = `${SID}-m${TURNS}`;
          await drive({ op: "send", text: `prompt ${TURNS}` });
          await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${TURNS}` });
          await frame({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
          await frame({
            type: "assistant_text",
            seq: 0,
            rev: 0,
            status: "complete",
            msg_id: msgId,
            block_index: 0,
            text: replyText(TURNS),
            is_partial: false,
          });
          await frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" });
          await app.evalJS<boolean>(`(window.__at0330Delivered = 0, true)`);
          await app.waitForCondition<boolean>(
            `(window.__at0330Delivered += window.__tug.deliverHeldUnderGate(),
              window.__tug.sessionSettled("A"))`,
            { timeoutMs: 10_000, pollMs: 100 },
          );
          await new Promise((r) => setTimeout(r, 300));
          const delivered = await app.evalJS<number>(
            `(window.__at0330Delivered += window.__tug.deliverHeldUnderGate())`,
          );
          expect(delivered).toBeGreaterThanOrEqual(1);
          await new Promise((r) => setTimeout(r, 300));

          // Nothing mounted under the hold: the same cells, and none past them.
          const during = await mountedIndices();
          expect(during).toEqual(before);
          const heldGate = await app.evalJS<boolean>(
            `window.__tug.releaseMotion(${handle})`,
          );
          released = true;
          expect(heldGate).toBe(true);
        } finally {
          if (!released) await app.evalJS<boolean>(`window.__tug.releaseMotion(${handle})`);
        }

        // Once the gate opens the new turn mounts and the follower is on it.
        await app.waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${SCROLLER}');
  return !!el.querySelector('[data-tug-list-cell-index="${rows}"]') &&
    el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
})()`,
          { timeoutMs: 15_000, pollMs: 100 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

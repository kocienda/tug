/**
 * at0330-eviction-hidden-restore.test.ts — the session transcript renders
 * through `evictOffscreen`: rows more than a viewport from the scrollport are
 * UNMOUNTED, their exact measured heights standing in the list's spacers.
 *
 * The mode's whole claim is that this is invisible, so the assertions are
 * about what the user would notice if it weren't:
 *
 * | Test                | What would break without it                          |
 * |---------------------|------------------------------------------------------|
 * | hidden restore      | a restore completing behind a hidden card holding its |
 * |                     | batch freeze (and the card's save gate) until the tab |
 * |                     | is next shown, instead of releasing at the hidden     |
 * |                     | settle                                                |
 * | Z0 stays topmost    | the permanent top row painted mid-transcript, because |
 * |                     | the top spacer grew underneath it                     |
 *
 * The transcript here is a real resumed session from the fixture corpus, not
 * the seeded turns the other at0330-eviction files share.
 * `tug-list-view.tsx` and `session-card-transcript.tsx` stand at their
 * accepted fan-out, so one at0330-eviction file names each: this one the
 * card (its settle callback and Z0 strip are what this case reads), and
 * reflow the list.
 *
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/tugways/internal/list-view-height-index.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @family at0330-eviction
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { SHOULD_RUN, TEST_TIMEOUT_MS, readFullHeight } from "./eviction-fixture";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER as FIXTURE_SCROLLER,
  TRANSCRIPT as FIXTURE_TRANSCRIPT,
  waitForTranscriptSettled,
} from "./fixtures/runner";

describe.skipIf(!SHOULD_RUN)("AT0330: transcript DOM eviction — hidden restore", () => {
  test(
    "a restore behind a hidden card releases its settle without waiting for reveal",
    async () => {
      // A real resumed session (picker → spawn → replay), with the card
      // hidden for the WHOLE restore. The batch-settle freeze exists to
      // protect visible layouts; a hidden card has none, so the freeze
      // must release while still hidden (0×0 ResizeObserver deliveries
      // are the hidden batch's settle) — otherwise `batchLoading` and
      // the card's save gate stay held until the tab is next shown.
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession(
        "session-transcript-basic",
        "at0330-hidden-restore",
      );
      // Point the picker's recents at ONLY the fixture dir so it never
      // surfaces the live archive (same isolation as the fixture runner's
      // other consumers).
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );
      const app = await launchTugApp({
        testName: "at0330-hidden-restore",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
      });
      try {
        await openFixtureSession(app, seeded);
        // Hide the card the moment Open is clicked — before the session
        // view or its transcript exist — so every phase of the restore
        // (spawn, replay, list mount, measurement) runs behind
        // `display:none`.
        await app.evalJS<boolean>(`(function () {
  var card = document.querySelector('[data-card-id="A"]');
  window.__at0330PrevDisplay = card.style.display;
  card.style.display = "none";
  return true;
})()`);

        // The settle release is observable as the card's one-shot settle
        // callback firing: it clears the freeze and logs
        // `transcript_settle` to the dev log. Wait for that entry while
        // the scroller is still boxless.
        await app.body("A").waitForCondition<boolean>(
          `(function () {
  var el = document.querySelector('${FIXTURE_SCROLLER}');
  if (el === null || el.offsetWidth !== 0) return false;
  return window.tugDevLog.getSnapshot().entries.some(function (e) {
    return e.message === "transcript_settle";
  });
})()`,
          { timeoutMs: 60_000, pollMs: 250 },
        );

        const hidden = await app.body("A").evalJS<{
          w: number;
          cells: number;
          replaying: boolean;
          anchor: string | null;
        }>(`(function () {
  var el = document.querySelector('${FIXTURE_SCROLLER}');
  var host = document.querySelector('${FIXTURE_TRANSCRIPT}');
  return {
    w: el.offsetWidth,
    cells: el.querySelectorAll("[data-tug-list-cell-index]").length,
    replaying: host.hasAttribute("data-replaying"),
    anchor: el.getAttribute("data-tug-scroll-state"),
  };
})()`);
        // Settled while genuinely hidden, with real mounted rows, and the
        // anchor writer stayed silent — a hidden scroller has no position
        // to serialize, so nothing was written across the hidden span.
        expect(hidden.w).toBe(0);
        expect(hidden.cells).toBeGreaterThan(0);
        expect(hidden.replaying).toBe(false);
        expect(hidden.anchor).toBeNull();

        // Reveal. The 0→real resize refires the cell observer with honest
        // values, and the rows left unmeasured drain through measure
        // segments, a capped run per commit.
        // Restore the card's ORIGINAL inline display (the deck's layout
        // styles live inline on the card element — clearing to "" would
        // clobber them and unconstrain the scroller).
        await app.evalJS<boolean>(`(function () {
  var card = document.querySelector('[data-card-id="A"]');
  card.style.display = window.__at0330PrevDisplay || "";
  return true;
})()`);
        await waitForTranscriptSettled(app);
        await app.body("A").waitForCondition<boolean>(
          `!!document.querySelector('${FIXTURE_SCROLLER}[data-evict-active]')`,
          { timeoutMs: 30_000, pollMs: 250 },
        );
        // The exactness below holds once the drain has measured every row.
        await app.body("A").waitForCondition<boolean>(
          `!document.querySelector('${FIXTURE_SCROLLER}').hasAttribute("data-evict-stale")`,
          { timeoutMs: 30_000, pollMs: 250 },
        );

        const revealed = await app.body("A").evalJS<{
          h: number;
          fallbacks: number;
          anchor: string | null;
        }>(`(function () {
  var el = document.querySelector('${FIXTURE_SCROLLER}');
  return {
    h: el.scrollHeight,
    fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "-1"),
    anchor: el.getAttribute("data-tug-scroll-state"),
  };
})()`);
        // The reveal no longer suspends — no commit rendered every row — and
        // the anchor writer resumed once the scroller had a real box again.
        expect(revealed.fallbacks).toBe(0);
        expect(revealed.anchor).not.toBeNull();

        // A RESUMED session keeps the Z0 strip: it reports the load window
        // ("Turns displayed X of Y" + "Load N more"), and it is the first
        // thing in the scroll content — above the top spacer, never buried
        // by it once the spacer grows for evicted rows.
        const z0 = await app.body("A").evalJS<{
          firstSlot: string | null;
          text: string;
        }>(`(function () {
  var el = document.querySelector('${FIXTURE_SCROLLER}');
  // The list renders a sticky top-spacer element as its first child — it
  // carries the top breathing room's height and is list chrome, not scroll
  // content — so "the first thing in the scroll content" is the child after it.
  var kids = Array.prototype.slice.call(el.children).filter(function (k) {
    return !k.classList.contains("tug-list-view-top-spacer");
  });
  var lead = el.querySelector(".tug-list-view-leading");
  return {
    firstSlot: kids.length ? kids[0].getAttribute("data-slot") || kids[0].className : null,
    text: lead ? lead.textContent.replace(/\\s+/g, " ").trim() : "",
  };
})()`);
        expect(z0.firstSlot).toBe("tug-list-view-leading");
        expect(z0.text).toContain("Turns displayed");

        // Exactness: the evicted document matches the fully-mounted one.
        const full = await readFullHeight(app, FIXTURE_SCROLLER);
        expect(Math.abs(revealed.h - full)).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

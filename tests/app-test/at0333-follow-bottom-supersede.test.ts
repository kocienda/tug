/**
 * at0333-follow-bottom-supersede.test.ts — a user scroll voids a pending
 * turn-step correction: no deferred scroll write survives a user gesture.
 *
 * One piece of the at0333-follow-bottom split (formerly
 * at0333-follow-bottom-unattributed), a test to a file so each launch fits
 * its own budget. The scroll attribution doctrine these pin, the seeded
 * session and the readers are `follow-bottom-fixture.ts`.
 *
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/use-inline-dialog-scope.ts
 * @covers tugdeck/src/components/tugways/internal/scroller-context.tsx
 * @family at0333-follow-bottom
 */

import { describe, expect, test } from "bun:test";

import {
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  standUp,
} from "./follow-bottom-fixture";

describe.skipIf(!SHOULD_RUN)("AT0333: unattributed scroll attribution", () => {
  test(
    "a user scroll voids a pending turn-step correction — no late snap",
    async () => {
      const app = await standUp("at0333-supersede");
      try {
        // Arm a two-pass correction, then move before it can fire — all
        // in ONE synchronous block, so no commit can land in between.
        // The ⌃⌘[ chord dispatch enters the responder chain's document-
        // level capture listener exactly as a real chord does (the same
        // route at0330's turn stepping uses). Synchronous presses outrun
        // the async re-window, so the later presses target entries that
        // are still unmounted and take the estimated-jump + post-commit-
        // correction path; the final scrollTop assignment then drifts
        // well past the supersede band before any commit runs.
        const armed = await app.body("A").evalJS<{
          afterPresses: number;
          assigned: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  for (var i = 0; i < 8; i += 1) {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "[", code: "BracketLeft",
      ctrlKey: true, metaKey: true,
      bubbles: true, cancelable: true, composed: true,
    }));
  }
  var afterPresses = el.scrollTop;
  el.scrollTop = afterPresses + 300;
  return { afterPresses: afterPresses, assigned: el.scrollTop };
})()`);
        expect(armed.assigned - armed.afterPresses).toBeGreaterThan(8);

        // Let commits settle; the voided correction must never fire.
        // A negative, so the window is time, not a condition.
        await app.body("A").evalJS<boolean>(`(function () {
  window.__at0333 = { minSeen: Infinity, maxSeen: -Infinity };
  window.__at0333Timer = setInterval(function () {
    var e = document.querySelector('${SCROLLER}');
    if (e === null) return;
    if (e.scrollTop < window.__at0333.minSeen) window.__at0333.minSeen = e.scrollTop;
    if (e.scrollTop > window.__at0333.maxSeen) window.__at0333.maxSeen = e.scrollTop;
  }, 16);
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 1500));
        const result = await app.body("A").evalJS<{
          minSeen: number;
          maxSeen: number;
          finalTop: number;
        }>(`(function () {
  clearInterval(window.__at0333Timer);
  var el = document.querySelector('${SCROLLER}');
  return {
    minSeen: window.__at0333.minSeen,
    maxSeen: window.__at0333.maxSeen,
    finalTop: el.scrollTop,
  };
})()`);
        // The position the user chose holds: no write ever pulled
        // scrollTop back toward the stale step target (300px below the
        // band would show up in minSeen), and nothing moved it at all.
        expect(armed.assigned - result.minSeen).toBeLessThanOrEqual(50);
        expect(result.maxSeen - armed.assigned).toBeLessThanOrEqual(50);
        expect(Math.abs(result.finalTop - armed.assigned)).toBeLessThanOrEqual(
          50,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

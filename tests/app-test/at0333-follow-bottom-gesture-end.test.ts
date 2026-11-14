/**
 * at0333-follow-bottom-gesture-end.test.ts — a wheel nudge at the live edge
 * re-engages follow-bottom when the gesture ends, and the anchoring gate
 * stays closed while following.
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
  AT_LIVE_EDGE,
  BUTTON_HIDDEN,
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TURNS,
  awaitQuietly,
  readAnchoringGate,
  readFollowBottomTransitions,
  readSnap,
  seedTurn,
  settle,
  standUp,
} from "./follow-bottom-fixture";

describe.skipIf(!SHOULD_RUN)("AT0333: unattributed scroll attribution", () => {
  test(
    "a wheel nudge at the live edge re-engages when the gesture ends",
    async () => {
      const app = await standUp("at0333-gesture-end");
      try {
        // Following at stand-up, so the anchoring gate is closed.
        expect(await readAnchoringGate(app)).toBe("none");

        // A small upward wheel nudge that stays inside the at-bottom
        // band. The wheel disengage carries no band guard — a 20px
        // twitch releases follow-bottom — which is exactly why the
        // gesture-end route must exist: the gesture ends at the live
        // edge, and stranding the user disengaged there turns a twitch
        // into a transcript that silently stops arriving.
        await app.body("A").evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.dispatchEvent(new WheelEvent('wheel', {
    deltaY: -20, bubbles: true, cancelable: true,
  }));
  el.scrollTop = el.scrollTop - 20;
  return true;
})()`);

        // End the gesture the way at0335's wheel drive does: let the
        // queued scroll events drain, then pointerup — synthetic wheels
        // do not reliably produce a scrollend, and any that does arrive
        // early lands in the same gesture-end check.
        await settle(app);
        await app.body("A").evalJS<boolean>(`(function () {
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return true;
})()`);
        await awaitQuietly(
          app,
          `window.tugDevLog.getSnapshot().entries.some(function (e) {
  return e.source === "smart-scroll" && e.message === "follow-bottom" &&
    e.data.source === "gesture-end-at-bottom-reengage";
}) && ${BUTTON_HIDDEN}`,
        );

        // Re-engaged at gesture end through the at-bottom flavor: the
        // gesture was net-UPWARD, so the net-down path cannot claim
        // it — position inside the band is the whole statement.
        const transitions = await readFollowBottomTransitions(app);
        const wheelUp = transitions.findIndex(
          (t) => t.source === "wheel-up" && !t.following,
        );
        expect(wheelUp).toBeGreaterThanOrEqual(0);
        const reengage = transitions.findIndex(
          (t, i) =>
            i > wheelUp &&
            t.source === "gesture-end-at-bottom-reengage" &&
            t.following,
        );
        expect(reengage).toBeGreaterThan(wheelUp);
        expect((await readSnap(app)).buttonVisible).toBe("false");
        expect(await readAnchoringGate(app)).toBe("none");

        // And streaming still tracks the live edge.
        const before = (await readSnap(app)).scrollHeight;
        await seedTurn(app, TURNS);
        await settle(app, before);
        await awaitQuietly(app, AT_LIVE_EDGE);
        const pinned = await readSnap(app);
        expect(pinned.maxScroll - pinned.top).toBeLessThanOrEqual(4);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

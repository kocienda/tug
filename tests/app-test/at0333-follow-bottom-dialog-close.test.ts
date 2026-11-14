/**
 * at0333-follow-bottom-dialog-close.test.ts — an inline dialog's close
 * re-engages follow-bottom only for a user still at the bottom: a
 * machine-side close never re-engages a reader who left.
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
  AT_BOTTOM_PX,
  AT_LIVE_EDGE,
  BUTTON_HIDDEN,
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TURNS,
  awaitQuietly,
  presentQuestion,
  readFollowBottomTransitions,
  readSnap,
  seedTurn,
  settle,
  standUp,
  withdrawQuestion,
} from "./follow-bottom-fixture";

describe.skipIf(!SHOULD_RUN)("AT0333: unattributed scroll attribution", () => {
  test(
    "an inline dialog's close re-engages only a user still at the bottom",
    async () => {
      const app = await standUp("at0333-dialog");
      try {
        // A live question opens at the bottom: its scope releases
        // follow-bottom (a declared machine disengage) and reveals the
        // whole dialog. The user then scrolls away to read history
        // while the question waits.
        const first = await presentQuestion(app, "a");
        await settle(app);
        await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollTop - ${AT_BOTTOM_PX * 15};
  return el.scrollTop;
})()`);
        await settle(app);

        // The question is withdrawn under them. Case B: re-engagement
        // requires attributed arrival at the bottom, and this user is
        // parked mid-history — the close must NOT flip follow-bottom
        // back on. The negative source assertion is the pin: an
        // unconditional close-side engage would record
        // `inline-dialog / following: true` right here. A negative, so
        // the close gets time to have done it.
        await withdrawQuestion(app, first);
        await new Promise((r) => setTimeout(r, 500));
        const transitions = await readFollowBottomTransitions(app);
        expect(
          transitions.some(
            (t) => t.source === "inline-dialog" && t.following,
          ),
        ).toBe(false);
        expect((await readSnap(app)).buttonVisible).toBe("true");

        // Growth stays away from the parked reader.
        const beforeGrowth = (await readSnap(app)).scrollHeight;
        await seedTurn(app, TURNS);
        await settle(app, beforeGrowth);
        const held = await readSnap(app);
        expect(held.maxScroll - held.top).toBeGreaterThan(AT_BOTTOM_PX * 4);
        expect(held.buttonVisible).toBe("true");

        // Now the other polarity: return to the bottom the same silent
        // way — an unattributed scroll INTO the at-bottom band, the idle
        // re-engage — sit through a second question, and let it close
        // with the user still settled at the dialog's edge. Behavioral
        // assert only — the machine may legitimately re-engage this
        // parked-in-band user before the close does (growth-at-bottom),
        // and either route is a correct arrival.
        await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollHeight - el.clientHeight;
  return el.scrollTop;
})()`);
        await settle(app);
        await awaitQuietly(app, BUTTON_HIDDEN);
        expect((await readSnap(app)).buttonVisible).toBe("false");

        const second = await presentQuestion(app, "b");
        await settle(app);
        await withdrawQuestion(app, second);
        await settle(app);
        await awaitQuietly(app, BUTTON_HIDDEN);
        expect((await readSnap(app)).buttonVisible).toBe("false");

        // The next streamed turn tracks the live edge.
        const beforePin = (await readSnap(app)).scrollHeight;
        await seedTurn(app, TURNS + 1);
        await settle(app, beforePin);
        await awaitQuietly(app, `${AT_LIVE_EDGE} && ${BUTTON_HIDDEN}`);
        const pinned = await readSnap(app);
        expect(pinned.maxScroll - pinned.top).toBeLessThanOrEqual(4);
        expect(pinned.buttonVisible).toBe("false");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

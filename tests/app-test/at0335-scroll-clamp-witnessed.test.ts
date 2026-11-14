/**
 * at0335-scroll-clamp-witnessed.test.ts — the displacement counter reads zero,
 * and a clamp is witnessed loudly, never counter-written.
 *
 * One of the at0335-scroll split, a test to a file so each launch fits its own
 * budget (it was the first case of `at0335-scroll-clamp`; the others are
 * `at0335-scroll-clamp-no-flip` and `-clamp-idle-recovery`, and the
 * reader-side guarantees are `at0335-scroll-reader-held-*`). Why a clamp is
 * witnessed and never repaired, and the shared stand-up and readers, are
 * `transcript-scroll-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/deck-trace.ts
 * @family at0335-scroll
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { enableDeckTrace } from "./_harness/client";
import {
  AT_BOTTOM_PX,
  SCROLLER,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  awaitQuietly,
  devLogHasSource,
  expectZeroDisplacements,
  parkMidHistory,
  readDisplacementRecords,
  readFollowBottomSources,
  readSnap,
  standUp,
} from "./transcript-scroll-fixture";

describe.skipIf(!SHOULD_RUN)("AT0335: scroll clamp", () => {
  test(
    "the displacement counter reads zero, and a clamp is witnessed loudly, never counter-written",
    async () => {
      const app = await standUp("at0335-counter");
      try {
        const snap = await readSnap(app);
        // Present from mount, so the attribute is readable rather
        // than absent — an absent attribute would read the same as a
        // clean run.
        expect(snap.displacements).not.toBeNull();
        expect(
          await app.body("A").evalJS<number>(
            `window.__tug.getScrollDisplacementCount('${SCROLLER}')`,
          ),
        ).toBe(Number(snap.displacements));
        // A clamp only displaces when the shrink actually lowers the
        // scroll maximum below the live position, so the top spacer
        // must be carrying real evicted extent for the clamp below to
        // have room to happen.
        expect(snap.topSpacer).toBeGreaterThan(2_000);

        // And it reads zero. Standing up sixty turns evicts, swaps
        // windows, and settles the height ledger across commits — the
        // extent floor spans all of it, so nothing clamps and nothing
        // is recorded.
        await expectZeroDisplacements(app);

        // The dev log carries follow-bottom flips with no opt-in of any
        // kind. Driven with a wheel-up rather than read off the
        // stand-up: a transcript that mounts at the live edge mounts
        // ALREADY engaged, and `_setFollowingBottom` early-returns on a
        // no-op, so a clean stand-up has no transition to log.
        await app.body("A").evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
  el.scrollTop = Math.max(0, el.scrollTop - 400);
  return true;
})()`);
        await awaitQuietly(app, devLogHasSource("wheel-up"));
        const sources = await readFollowBottomSources(app);
        expect(sources).toContain("wheel-up");

        // Now the no-opt-in property itself, asserted rather than
        // assumed: switch deck-trace recording OFF, clear the ring,
        // and drive a displacement. Ordinary kinds are gated by that
        // flag; `scroll-displacement` and `follow-bottom` are not,
        // because the sessions that hold this evidence are the ones
        // nobody thought to instrument.
        await app.enableDeckTrace(false);
        await enableDeckTrace(app.body("A"), false);
        await app.body("A").evalJS<boolean>(
          `(function () { window.__tug.clearDeckTrace(); return true; })()`,
        );
        const parkedSnap = await readSnap(app);
        const parked = await parkMidHistory(app);
        // Parked deep in history with follow-bottom released — the
        // position is the user's, and parking is not a displacement.
        const beforeClamp = await readSnap(app);
        expect(beforeClamp.buttonVisible).toBe("true");
        await expectZeroDisplacements(app);

        await app.body("A").evalJS<boolean>(
          `(function () { window.__tug.forceCommitClamp('${SCROLLER}'); return true; })()`,
        );
        // Long enough for the clamp's deferred scroll event to be
        // delivered, which is what the "still released" check below
        // is about.
        await new Promise((r) => setTimeout(r, 600));
        const afterClamp = await readSnap(app);
        // The simulation only clamps when the shrink lowers the maximum
        // BELOW the live position, so the arithmetic it depends on is
        // worth printing: a run that records nothing should say whether
        // the clamp had room to happen at all.
        note("at0335-gated-clamp", {
          shrinkPx: 2_000,
          settled: `top=${parkedSnap.top} max=${parkedSnap.maxScroll} spacer=${parkedSnap.topSpacer}`,
          parked: `top=${beforeClamp.top} max=${beforeClamp.maxScroll} spacer=${beforeClamp.topSpacer}`,
          after: `top=${afterClamp.top} max=${afterClamp.maxScroll} disp=${afterClamp.displacements}`,
        });

        // Detected, on both surfaces, with recording off.
        expect(
          await app.body("A").evalJS<number>(
            `window.__tug.getScrollDisplacementCount('${SCROLLER}')`,
          ),
        ).toBeGreaterThan(0);
        const gated = await app.body("A").evalJS<{ displacement: number; other: number }>(
          `(function () {
  var rows = window.__deckTrace.dump();
  return {
    displacement: rows.filter(function (e) { return e.kind === "scroll-displacement"; }).length,
    other: rows.filter(function (e) { return e.kind === "commit-tick" || e.kind === "focus-call"; }).length,
  };
})()`,
        );
        expect(gated.displacement).toBeGreaterThan(0);
        expect(gated.other).toBe(0);

        // Upward: a clamp pulls the position down toward a shrunken
        // maximum, which in scroller coordinates is a smaller
        // `scrollTop` than the baseline.
        const records = await readDisplacementRecords(app);
        expect(records.length).toBeGreaterThan(0);
        expect(records[0]!.to).toBeLessThan(records[0]!.from);

        // The bracket asserts instead of repairing: the record names
        // the defect and the position stays exactly where the browser
        // put it. A counter-write here would hide the evidence — the
        // extent floor is the defense, and a record at all means the
        // floor has a hole (the simulation makes one deliberately by
        // taking the floor down for its synchronous window).
        const witnessed = records[records.length - 1]!;
        expect(witnessed.to).toBeLessThan(witnessed.from);
        expect(Math.abs(afterClamp.top - witnessed.to)).toBeLessThanOrEqual(4);
        expect(Math.abs(afterClamp.top - parked)).toBeGreaterThan(
          AT_BOTTOM_PX,
        );
        // Witnessing attributes the move (`noteExternalWrite`), so the
        // clamp's deferred scroll event is not read as the user
        // scrolling up and follow-bottom keeps the state the user gave
        // it: still released, still parked.
        expect(afterClamp.buttonVisible).toBe("true");

        // Loud means the dev log carries it at warn with no opt-in —
        // the defect record must exist in sessions nobody instrumented.
        const warned = await app.body("A").evalJS<number>(`(function () {
  return window.tugDevLog.getSnapshot().entries.filter(function (e) {
    return e.source === "list-view" && e.message === "scroll-displacement" &&
      e.level === "warn";
  }).length;
})()`);
        expect(warned).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

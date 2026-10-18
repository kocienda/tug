/**
 * `restoreSupersede` — who owns the scroll position while a restore is
 * pending.
 *
 * The rule decides whether a pending restore keeps writing or hands the
 * position to the user, and it has two customers with opposite needs: a
 * cold-boot restore, which must yield to a scrollbar drag it cannot see,
 * and a width-change restore, which must NOT read its own reflow as one.
 * The function is the whole policy, so it is the whole test.
 *
 * Constructing a `SmartScroll` needs `document`; that path is real-app
 * behavior and is proven by the app-test that drives actual width gestures.
 */

import { describe, expect, test } from "bun:test";

import { restoreSupersede } from "../lib/smart-scroll";

// The drift threshold is private to smart-scroll; these are chosen to sit
// well inside and well outside it rather than to equal it.
const WITHIN_THRESHOLD = 4;
const BEYOND_THRESHOLD = 200;

describe("a gesture always wins", () => {
  test("a visible user scroll supersedes a cold-boot restore", () => {
    expect(
      restoreSupersede({
        isUserScrolling: true,
        baselineTop: 1000,
        currentTop: 1000,
        suspendDriftSupersede: false,
      }),
    ).toBe("gesture");
  });

  test("a visible user scroll supersedes a width-change restore too", () => {
    // The waiver is only about drift. A user who grabs the scrollbar
    // mid-resize still takes the position.
    expect(
      restoreSupersede({
        isUserScrolling: true,
        baselineTop: 1000,
        currentTop: 1000,
        suspendDriftSupersede: true,
      }),
    ).toBe("gesture");
  });
});

describe("unattributable drift supersedes a cold-boot restore", () => {
  test("a scroller found far from the baseline was moved by someone else", () => {
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: 1000,
        currentTop: 1000 + BEYOND_THRESHOLD,
        suspendDriftSupersede: false,
      }),
    ).toBe("drift");
  });

  test("drift in either direction counts", () => {
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: 1000,
        currentTop: 1000 - BEYOND_THRESHOLD,
        suspendDriftSupersede: false,
      }),
    ).toBe("drift");
  });

  test("a scroller still at the baseline is the restore's own work", () => {
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: 1000,
        currentTop: 1000 + WITHIN_THRESHOLD,
        suspendDriftSupersede: false,
      }),
    ).toBeNull();
  });

  test("before the first heartbeat there is no baseline to drift from", () => {
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: null,
        currentTop: 4000,
        suspendDriftSupersede: false,
      }),
    ).toBeNull();
  });
});

describe("a width-change restore waives the drift rule", () => {
  test("a re-wrap above the viewport does not cancel the restore", () => {
    // This is the whole reason the flag exists. Content re-wrapping above
    // the viewport moves `scrollTop` by itself; the cold-boot rule's
    // premise — that content changes do not move it — is false here, and
    // unwaived this restore would cancel on its first delivery and the
    // preservation would silently do nothing.
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: 1000,
        currentTop: 1000 + BEYOND_THRESHOLD,
        suspendDriftSupersede: true,
      }),
    ).toBeNull();
  });

  test("even a very large reflow displacement is still not a gesture", () => {
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: 0,
        currentTop: 50_000,
        suspendDriftSupersede: true,
      }),
    ).toBeNull();
  });
});

describe("drift across a change of extent is the content's, not a hand's", () => {
  test("cells measuring in above the viewport do not cancel a cold-boot restore", () => {
    // A body page mounts its card before the page is laid out, so the
    // restore's first resolve is against estimated heights. As the cells
    // measure, `scrollHeight` grows and scroll anchoring carries
    // `scrollTop` with it: read as a drag, the restore was cancelled at
    // the stale estimate, 265 px off the anchor (at0083, at0331).
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: 823,
        currentTop: 865,
        suspendDriftSupersede: false,
        baselineHeight: 1905,
        currentHeight: 1991,
      }),
    ).toBeNull();
  });

  test("a move past the change of extent is a drag, even while content grows", () => {
    // A session streaming below the reader grows `scrollHeight` on every
    // heartbeat; a scrollbar drag during it moves farther than the growth.
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: 1000,
        currentTop: 1000 - BEYOND_THRESHOLD,
        suspendDriftSupersede: false,
        baselineHeight: 4000,
        currentHeight: 4030,
      }),
    ).toBe("drift");
  });

  test("a drag over content that kept its height still supersedes", () => {
    expect(
      restoreSupersede({
        isUserScrolling: false,
        baselineTop: 1000,
        currentTop: 1000 + BEYOND_THRESHOLD,
        suspendDriftSupersede: false,
        baselineHeight: 1991,
        currentHeight: 1991,
      }),
    ).toBe("drift");
  });
});

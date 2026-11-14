/**
 * smoke-native-session-tap.test.ts — pid mode: a key posted to the
 * session tap never reaches the app.
 *
 * One of the smoke-native split, a test to a file so each launch fits
 * its own budget. What the split pins, and the settle helper, are
 * `smoke-native-fixture.ts`.
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 * @family smoke-native
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "../_harness";
import { SHOULD_RUN, waitForPaintSettled } from "./smoke-native-fixture";

describe.skipIf(!SHOULD_RUN)("phase A native-gesture smoke", () => {
  test("pid mode: a key on the session tap never reaches the app", async () => {
    // A real key window in an inactive app must not pull the user's
    // keyboard. The host posts a Shift down/up to the session event tap —
    // the user's keyboard as WindowServer routes it — and reports what its
    // own event monitor saw, which must be nothing (measured 2026-10-21 in a
    // throwaway accessory app with the same override). If this ever goes
    // red the fake-active regime is wrong and the fallback is the
    // accessor-only override. `trusted` must read true first: the system
    // drops a post from an untrusted process, and a dropped post proves
    // nothing.
    const app = await launchTugApp({ testName: "smoke-native-session-tap" });
    try {
      await waitForPaintSettled(app);
      const before = await app.windowState();
      expect(before.isKeyWindow, `the probe is only meaningful under a real key window; saw ${JSON.stringify(before)}`).toBe(true);
      const probe = await app.sessionTapProbe();
      const seen = JSON.stringify(probe);
      expect(probe.trusted, `the post must be deliverable for the probe to prove anything; saw ${seen}`).toBe(true);
      expect(probe.received, `a session-tap key must not arrive in the inactive app; saw ${seen}`).toEqual([]);
      expect(probe.frontmost, `the user's frontmost app must not move; saw ${seen}`).toBe(before.frontmostAtLaunch);
    } finally {
      await app.close();
    }
  });
});

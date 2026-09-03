/**
 * at0282 — the `tug-quiesce` canary: a normal teardown fires no SIGKILL.
 *
 * The shutdown contract (arc/graceful-termination-plan.md, grounds in
 * [LR3]/[LR4]) says every Tug service gets a flush window before anything
 * forceful happens: on quiesce it stops accepting work, checkpoints its
 * ledgers, and exits 0 inside its own 2 s budget; the shutdown supervisor (Tug.app)
 * waits 4 s for the group to drain and only then escalates. A SIGKILL
 * that actually fires is a defect — it means some service was cut off
 * mid-flush, which is exactly how a WAL is left for the next process to
 * recover instead of being closed cleanly.
 *
 * So this test does the most ordinary thing possible — launch, then quit
 * through the real `applicationShouldTerminate` path — and reads the
 * app's own account of that shutdown (`quiesce-report.json`, written by
 * `ProcessManager.stop()`). The assertion is that `sigkills` is empty.
 *
 * @covers tugapp/Sources/ProcessManager.swift
 * @covers tugapp/Sources/InstanceConfig.swift
 * @covers tugcode/src/main.ts
 */

import { describe, expect, test } from "bun:test";
import { QUIESCE_DRAIN_DEADLINE_MS, launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!SHOULD_RUN)("at0282: quiesce teardown fires no SIGKILL", () => {
  test(
    "a graceful quit lets every service flush and exit on its own",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      try {
        const app = await launchTugApp({
          testName: "at0282",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
        });
        // No report exists until the app has actually torn down.
        expect(app.quiesceReport()).toBeNull();

        await app.quitGracefully();

        const report = app.quiesceReport();
        expect(report).not.toBeNull();
        // The supervisor's deadline is the shared one, not a local guess —
        // the harness constant is pinned by the Rust mirror test.
        expect(report!.drainDeadlineMs).toBe(QUIESCE_DRAIN_DEADLINE_MS);
        // The whole point: nothing had to be forced.
        expect(report!.sigkills).toEqual([]);
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

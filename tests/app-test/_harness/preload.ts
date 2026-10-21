/**
 * preload.ts — wired into `bunfig.toml` as the app-test suite's preload.
 *
 * Its only job is to give the harness an end-of-run hook that the bun
 * test runner actually calls. See `test-cleanup.ts` for why
 * `process.on("exit")` is not that hook.
 */
import { afterAll } from "bun:test";

import { caughtBeeps, formatBeepFailure } from "./beep-report";
import { runTestRunEndTasks } from "./test-cleanup";

afterAll(runTestRunEndTasks);

// A beep is a red (brief [B03]). Each teardown folds the app's beep tripwire
// into a per-file total; if the file beeped at all, fail it here so the run
// summary's `Failures:` section names what provoked each beep. Registered
// after the cleanup hook so cleanup still runs on a beeping file.
afterAll(() => {
  const beeps = caughtBeeps();
  if (beeps.length > 0) {
    throw new Error(formatBeepFailure(beeps));
  }
});

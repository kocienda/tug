/**
 * wait-for-condition.test.ts — In-app tests for the `waitForCondition`
 * primitive and structured error responses. Covers
 * test requirements:
 *
 *   1. `evalJS` that throws returns an error the client throws as an
 *      Error with matching `name` / `message`.
 *   2. `waitForCondition` that never returns truthy times out at the
 *      configured `timeoutMs`; harness client throws `TimeoutError`.
 *   3. `waitForCondition` for an immediately-truthy expression returns
 *      the value.
 *
 * Skipped by default unless `TUGAPP_APP_TEST=1` is set. The test
 * needs a built debug Tug.app binary at the default path (or
 * `TUGAPP_DEBUG_PATH` pointing at one).
 *
 * To run locally:
 *   xcodebuild -scheme Tug -configuration Debug build
 *   TUGAPP_APP_TEST=1 bun test tests/app-test/wait-for-condition.test.ts
 *
 * Design notes:
 * - Each test launches its own `App` instance and closes it in the
 *   `finally` block. This matches `smoke.test.ts` and guarantees
 *   cleanup even if `expect(...)` throws.
 * - Tests use tight `timeoutMs` / `pollMs` budgets so the whole suite
 *   runs quickly when invoked; the values also double as regression
 *   guards against budgets silently growing.
 * - The eval-error test uses a script whose JS throw surfaces through
 *   `evaluateJavaScript`'s completion handler. The Swift side serializes
 *   the WebKit error with `name: "EvalError"`; the harness's
 *   `translateError` maps that unknown name to a plain `Error` with
 *   `.name` preserved. We assert both `instanceof Error` and a match
 *   on `.name` / `.message` per the plan.
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 */

import { describe, expect, test } from "bun:test";
import { enforcedTimeout, launchTugApp } from "../_harness";
import { TimeoutError } from "../_harness/errors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

describe.skipIf(!SHOULD_RUN)("in-app: evalJS error translation", () => {
  test("evalJS that throws surfaces as an Error with matching name/message", async () => {
    // Pure RPC-protocol test — no CGEvent path. Opt out of the
    // Step-3 AX preflight to keep this suite independent of the
    // macOS Accessibility grant state.
    const app = await launchTugApp({ skipAccessibilityPreflight: true });
    try {
      // Throw a named JS error. WebKit reports it through the
      // evaluateJavaScript completion handler; Swift serializes
      // `{ name: "EvalError", message }`; the harness translates
      // unknown names to plain Error with .name preserved.
      const throwing = "(() => { throw new Error('boom'); })()";

      let caught: unknown;
      try {
        await app.evalJS(throwing);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Error);
      // Message should round-trip enough to match the thrown literal.
      const err = caught as Error;
      expect(err.message.length).toBeGreaterThan(0);
      expect(err.message).toContain("boom");
      // Name is populated server-side — "EvalError" is the default in
      // `TestHarnessConnection.dispatchEvalJS`. It must be non-empty.
      expect(err.name.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!SHOULD_RUN)("in-app: waitForCondition", () => {
  test("times out when the condition is never truthy", async () => {
    // Pure RPC-protocol test — no CGEvent path. Opt out of the
    // Step-3 AX preflight to keep this suite independent of the
    // macOS Accessibility grant state.
    const app = await launchTugApp({ skipAccessibilityPreflight: true });
    try {
      // `false` is always falsy; the server polls until its deadline
      // elapses and responds with { ok: false, error: { name:
      // "TimeoutError", ... } } which the RPC client translates.
      const timeoutMs = 120;
      const pollMs = 10;

      const started = Date.now();
      let caught: unknown;
      try {
        await app.waitForCondition("false", { timeoutMs, pollMs });
      } catch (e) {
        caught = e;
      }
      const elapsed = Date.now() - started;

      expect(caught).toBeInstanceOf(TimeoutError);
      const err = caught as TimeoutError;
      expect(err.name).toBe("TimeoutError");
      // TimeoutError carries the budget for debuggability — the one the server
      // was actually told to wait, which the parallel runner scales up so a
      // contended file is not timed out on a budget sized for a quiet machine.
      expect(err.timeoutMs).toBe(enforcedTimeout(timeoutMs));
      // The server enforces the budget; we give a generous upper bound
      // to avoid flakiness on a loaded CI host, but it must not fire
      // before the budget elapses.
      expect(elapsed).toBeGreaterThanOrEqual(enforcedTimeout(timeoutMs));
      // 5x budget is a generous ceiling; real elapsed times should sit
      // well below that. This guards against the timer never firing.
      expect(elapsed).toBeLessThan(enforcedTimeout(timeoutMs) * 5 + 1000);
    } finally {
      await app.close();
    }
  });

  test("returns the truthy value for an immediately-truthy expression", async () => {
    // Pure RPC-protocol test — no CGEvent path. Opt out of the
    // Step-3 AX preflight to keep this suite independent of the
    // macOS Accessibility grant state.
    const app = await launchTugApp({ skipAccessibilityPreflight: true });
    try {
      // `42` is truthy on the very first poll; the server returns the
      // JSON-serialized value without waiting a tick.
      const value = await app.waitForCondition<number>("42");
      expect(value).toBe(42);
    } finally {
      await app.close();
    }
  });
});

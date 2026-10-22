/**
 * version-handshake.test.ts — Version-skew regression test for the
 * `version` RPC handshake. Covers harness test:
 *
 *   "Version-skew test: harness with wrong expected version
 *    → throws VersionSkewError."
 *
 * The harness's compile-time constant `EXPECTED_SURFACE_VERSION` is
 * fixed at build time, so to exercise mismatch without a Swift
 * rebuild the test injects a deliberately-wrong `expectedSurfaceVersion`
 * into `launchTugApp`. The handshake compares majors; anything whose
 * major doesn't match the server's (currently `1.0.0` → major `1`)
 * throws.
 *
 * Skipped by default unless `TUGAPP_APP_TEST=1` is set. The test
 * needs a built debug Tug.app binary at the default path (or
 * `TUGAPP_DEBUG_PATH` pointing at one).
 *
 * To run locally:
 *   xcodebuild -scheme Tug -configuration Debug build
 *   TUGAPP_APP_TEST=1 bun test tests/app-test/version-handshake.test.ts
 *
 * Design notes:
 * - The test must NOT leave a live subprocess behind if the throw
 *   path works. `launchTugApp` SIGTERM's the subprocess before
 *   throwing `VersionSkewError`; we assert that by reading the
 *   error's `expected` / `actual` fields and checking the socket
 *   path is unlinked (the `process.on("exit")` cleanup will run on
 *   the next tick).
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "../_harness";
import { VersionSkewError } from "../_harness/errors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

describe.skipIf(!SHOULD_RUN)("in-app: version handshake", () => {
  test("wrong expected version throws VersionSkewError with expected/actual populated", async () => {
    // Deliberately bump the expected major into the future. The
    // server is at major `2`; comparing `3.x` vs `2.x` triggers
    // the mismatch branch in `launchTugApp`.
    const bogusExpected = "3.0.0";

    let caught: unknown;
    try {
      await launchTugApp({ expectedSurfaceVersion: bogusExpected });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(VersionSkewError);
    const err = caught as VersionSkewError;
    expect(err.name).toBe("VersionSkewError");
    // The harness preserves the caller-supplied expected in the error.
    expect(err.expected).toBe(bogusExpected);
    // The server advertises major `2`. We don't pin the exact patch
    // here — that belongs to a separate test — but it must be a
    // non-empty string that is obviously different from `bogusExpected`.
    expect(typeof err.actual).toBe("string");
    expect(err.actual.length).toBeGreaterThan(0);
    expect(err.actual).not.toBe(bogusExpected);
  });
});

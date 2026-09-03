/**
 * smoke-app-reload.test.ts — Layer-1 gate for the soft-reload
 * harness primitive for reload paths.
 *
 * ## What this file pins
 *
 * Three properties of `app.appReload()`:
 *
 *   1. **It actually reloads the WKWebView.** A pre-reload write to
 *      a `window`-scoped sentinel is cleared on the new page (fresh
 *      JS context). A pre-reload write to `sessionStorage` (which
 *      survives reload) is preserved.
 *   2. **`__tug` re-attaches.** The bun side awaits the new
 *      `__tug.getReadyGen()` returning a value strictly greater than
 *      the pre-reload read. If the wait succeeds, `__tug` is online.
 *   3. **Tug.app and tugcast survive the reload.** A key written via
 *      tugcast HTTP before the reload is readable via tugcast HTTP
 *      after the reload — same Tug.app process, same tugcast
 *      process.
 *
 * ## Why this exists as a smoke test, not an AT-tag test
 *
 * See also: `at0024-prompt-state-roundtrip.test.ts`,
 * which uses `app.appReload()` as one of its two reload triggers. If
 * `app.appReload()` itself is broken, the AT-tag tests cannot
 * possibly pass — the failure attribution would conflate "the
 * primitive is broken" with "the production save/restore path is
 * broken." A separate smoke gate keeps those clearly separated.
 *
 * ## Distinction from `smoke-cold-boot.test.ts`
 *
 * Cold-boot's smoke gate exercises `app.quitGracefully()` (full
 * process restart) + `tugbankRead` (disk-side read between two Tug
 * processes). This file exercises `app.appReload()` (in-process
 * reload, same Tug.app, same tugcast). They share the temp-tugbank
 * isolation primitive but are otherwise independent.
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "../_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "../_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!SHOULD_RUN)("app-reload harness smoke", () => {
  test(
    "appReload reloads WKWebView, __tug re-attaches, tugcast survives",
    async () => {
      const tugbankPath = mkTempTugbank();

      try {
        seedTugbankForLaunch(tugbankPath);

        const app = await launchTugApp({
          testName: "smoke-app-reload",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
        });

        try {
          // Plant two sentinels:
          //   - `window.__tugSmokeWindowSentinel`: cleared by reload
          //     (fresh JS context drops `window` properties).
          //   - `sessionStorage.smoke-session-sentinel`: preserved
          //     by reload (`sessionStorage` survives `location.reload()`).
          await app.evalJS<void>(
            `(function () {
              window.__tugSmokeWindowSentinel = "before-reload";
              sessionStorage.setItem("smoke-session-sentinel", "before-reload");
            })()`,
          );

          // Plant a tugcast key — written via the same synchronous
          // XHR path `saveAndFlushSync` uses on quit, so the value
          // hits sqlite before evalJS returns. Same Tug.app +
          // tugcast on both sides of the reload, so reading it back
          // proves both processes survived.
          const TUGCAST_VALUE = "tugcast-survives-reload";
          await app.evalJS<void>(
            `(function () {
              var xhr = new XMLHttpRequest();
              xhr.open('PUT', '/api/defaults/dev.tugapp.test/reload-key', false);
              xhr.setRequestHeader('Content-Type', 'application/json');
              xhr.send(JSON.stringify({ kind: 'string', value: ${JSON.stringify(TUGCAST_VALUE)} }));
              if (xhr.status !== 200) {
                throw new Error('PUT reload-key failed: HTTP ' + xhr.status);
              }
            })()`,
          );

          // Capture the pre-reload generation so the post-reload
          // assertion can prove the counter advanced.
          const preReloadGen = await app.evalJS<number>(
            `window.__tug.getReadyGen()`,
          );
          expect(preReloadGen).toBeGreaterThanOrEqual(1);

          // Fire the reload primitive under test. Resolves when
          // `__tug` is back online on the new page.
          await app.appReload();

          // ── Property 1: WKWebView actually reloaded. ──
          // The window sentinel is gone (fresh JS context).
          const windowSentinel = await app.evalJS<string | null>(
            `window.__tugSmokeWindowSentinel ?? null`,
          );
          expect(windowSentinel).toBeNull();

          // The sessionStorage sentinel survived (proves the reload
          // was a soft `location.reload()`, not a launch from scratch
          // — `sessionStorage` is per-tab and only cleared by tab close).
          const sessionSentinel = await app.evalJS<string | null>(
            `sessionStorage.getItem("smoke-session-sentinel")`,
          );
          expect(sessionSentinel).toBe("before-reload");

          // ── Property 2: __tug re-attached, generation advanced. ──
          const postReloadGen = await app.evalJS<number>(
            `window.__tug.getReadyGen()`,
          );
          expect(postReloadGen).toBeGreaterThan(preReloadGen);

          // ── Property 3: tugcast survived the reload. ──
          // GET the same key that was PUT before the reload. The
          // value is in sqlite via the synchronous XHR write above,
          // and tugcast's process group lived through the WKWebView
          // reload (only the page navigated, not Tug.app).
          const liveValue = await app.evalJS<string | null>(
            `(function () {
              var xhr = new XMLHttpRequest();
              xhr.open('GET', '/api/defaults/dev.tugapp.test/reload-key', false);
              xhr.send();
              if (xhr.status === 404) return null;
              if (xhr.status !== 200) {
                throw new Error('GET reload-key failed: HTTP ' + xhr.status);
              }
              return JSON.parse(xhr.responseText).value;
            })()`,
          );
          expect(liveValue).toBe(TUGCAST_VALUE);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

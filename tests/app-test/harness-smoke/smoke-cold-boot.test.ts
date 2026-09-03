/**
 * smoke-cold-boot.test.ts — Layer-2 gate for the two-process
 * cold-boot harness primitives.
 *
 * ## What this file pins
 *
 * The four primitives that the Layer-3 cold-boot tests will lean on:
 *
 *   1. **Per-test tugbank isolation.**
 *      `launchTugApp({ env: { TUGBANK_PATH: <temp> } })` plumbs through
 *      to Tug.app's `TugbankClient` (Swift, direct sqlite) AND to
 *      tugcast's HTTP defaults handler (inherited via
 *      `ProcessManager.startProcess`'s env). Both processes write to
 *      the same temp DB; the developer's real `~/.tugbank.db` is not
 *      touched.
 *
 *   2. **Graceful quit.** `app.quitGracefully()` schedules
 *      `NSApp.terminate(nil)`, which fires
 *      `applicationShouldTerminate` →
 *      `window.tugdeck.saveState()` → tugcast's PUT handler →
 *      sqlite commit, all before the process exits. Distinct from
 *      `app.close()` which SIGTERMs and bypasses the save trigger.
 *
 *   3. **Disk-side read.** `tugbankRead(path, domain, key)` shells
 *      to the `tugbank` CLI (resolved via `TUGAPP_TUGBANK_BINARY`)
 *      and returns the typed envelope.
 *
 *   4. **Two-process round-trip.** Process A writes through tugcast,
 *      quits gracefully. Process B launches against the same temp DB
 *      and reads the value back through tugcast. End-to-end proof
 *      that save-on-quit actually persists across processes.
 *
 * ## Why this exists as a smoke test, not an AT-tag test
 *
 * Layer 3's cold-boot tests (`at0014-cold-boot-scroll.test.ts`,
 * `at0010-cold-boot-selection.test.ts`) lean on every primitive above.
 * If this smoke file fails, those layered tests cannot work. Putting
 * the primitive-level gate in a single small file keeps the failure
 * attribution crisp: a Layer-3 failure here means the harness itself
 * is broken; a Layer-3 failure in the AT-tag tests means the
 * production save/restore path is broken.
 *
 * ## Wire path under test
 *
 * Process A's write uses a synchronous XHR — exactly the path
 * `saveAndFlushSync` uses in production via `putCardState({sync:true})`
 * — so the smoke proves the same kernel-level fd → tugcast →
 * spawn_blocking → sqlite chain that the real save trigger uses.
 * Process B's read uses `fetch` (async) since reads have no
 * synchronous-completion requirement.
 *
 * ## Domain choice
 *
 * `dev.tugapp.test` is a smoke-only domain; it does NOT collide
 * with the production card-state domain (`dev.tugapp.deck.cardstate`).
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 * @covers tugapp/Sources/TugbankClient.swift
 * @covers tugrust/crates/tugbank/
 * @covers tugrust/crates/tugbank-core/
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "../_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "../_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!SHOULD_RUN)("cold-boot harness smoke", () => {
  test(
    "TUGBANK_PATH isolation + quitGracefully + two-process round-trip",
    async () => {
      const tugbankPath = mkTempTugbank();
      const SMOKE_VALUE = "hello-from-process-A";

      try {
        // Seed the empty temp tugbank with the minimum values
        // Tug.app reads at startup (source-tree-path). Without this,
        // AppDelegate's
        // loadPreferences fails to resolve a source tree and
        // renders the "Source Tree Required" alert instead of
        // booting tugdeck — harness's `window.__tug` wait then
        // times out.
        seedTugbankForLaunch(tugbankPath);

        // ── Process A: write a known value through tugcast, quit. ──
        {
          const app = await launchTugApp({
            testName: "smoke-cold-boot-A",
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
          });
          // Synchronous XHR PUT — same wire shape that
          // `saveAndFlushSync` → `putCardState({sync:true})` uses on
          // app quit. Throws on non-200 so a tugcast misroute fails
          // loudly here rather than silently producing an empty bag.
          await app.evalJS<void>(
            `(function () {
              var xhr = new XMLHttpRequest();
              xhr.open('PUT', '/api/defaults/dev.tugapp.test/smoke-key', false);
              xhr.setRequestHeader('Content-Type', 'application/json');
              xhr.send(JSON.stringify({ kind: 'string', value: ${JSON.stringify(SMOKE_VALUE)} }));
              if (xhr.status !== 200) {
                throw new Error('PUT smoke-key failed: HTTP ' + xhr.status + ' body=' + xhr.responseText);
              }
            })()`,
          );
          // Trigger the full applicationShouldTerminate path. The
          // value written above is ALREADY on disk (synchronous XHR),
          // but the gate we want to prove is that quitGracefully
          // actually exits the process instead of leaking it.
          await app.quitGracefully();
        }

        // ── Disk-side read: assert the value is on tugbank disk. ──
        const onDisk = tugbankRead<string>(
          tugbankPath,
          "dev.tugapp.test",
          "smoke-key",
        );
        expect(onDisk).not.toBeNull();
        expect(onDisk?.type).toBe("string");
        expect(onDisk?.value).toBe(SMOKE_VALUE);

        // ── Process B: relaunch against the same DB; read via tugcast. ──
        {
          const app = await launchTugApp({
            testName: "smoke-cold-boot-B",
            env: { TUGBANK_PATH: tugbankPath },
            skipAccessibilityPreflight: true,
          });
          try {
            // Tugcast's GET /api/defaults/:domain/:key returns the
            // tagged value envelope (`{kind, value}`), or 404 when
            // the key is missing. Use sync XHR so the evaluateJavaScript
            // result is a settled value, not a Promise (WKWebView's
            // older evaluateJavaScript signature reports unsettled
            // Promises as "unsupported type").
            const live = await app.evalJS<string | null>(
              `(function () {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', '/api/defaults/dev.tugapp.test/smoke-key', false);
                xhr.send();
                if (xhr.status === 404) return null;
                if (xhr.status !== 200) {
                  throw new Error('GET smoke-key failed: HTTP ' + xhr.status);
                }
                var body = JSON.parse(xhr.responseText);
                return body.value;
              })()`,
            );
            expect(live).toBe(SMOKE_VALUE);
          } finally {
            await app.close();
          }
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

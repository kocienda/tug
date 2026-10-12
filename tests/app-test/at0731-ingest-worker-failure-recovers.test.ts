/**
 * at0731-ingest-worker-failure-recovers.test.ts — a failed ingest Worker is
 * named and recovered from, inside the shipped WebKit.
 *
 * The deck waits on the ingest Worker for every frame of every session. This
 * makes the Worker's host throw on a control through the eval door — the
 * uncaught-throw path a defect in the Worker takes — and watches the page:
 *
 *  - **it falls back**: `__tugIngest.host` turns from `"worker"` to `"main"`,
 *    the page now hosting the wire itself;
 *  - **it says so**: the session lifecycle trace carries one
 *    `connection.ingest_fallback`, naming the Worker's throw and that the
 *    fall-back is permanent;
 *  - **it recovers**: batches flow again through the new host after its
 *    reconnect (`__tugIngest.tasks` climbs past where the failure left it).
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/connection.ts
 * @covers tugdeck/src/lib/ingest/ingest-channel.ts
 * @covers tugdeck/src/lib/workers/ingest-worker.ts
 * @covers tugdeck/src/test-surface.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

interface FallbackEvent {
  detail?: unknown;
  permanent?: unknown;
}

describe.skipIf(!SHOULD_RUN)("at0731 — a failed ingest Worker is named and recovered from", () => {
  test(
    "the page falls back to its own host, says so, and the wire comes back",
    async () => {
      const app = await launchTugApp({ testName: "at0731-ingest-worker-failure-recovers" });
      try {
        await app.waitForCondition<boolean>(
          `!!window.__tug && !!window.__tugIngest && window.__tugIngest.host === "worker" && window.__tugIngest.tasks > 0`,
          { timeoutMs: 20_000 },
        );

        expect(await app.evalJS<boolean>(`window.__tug.ingestHostFail()`)).toBe(true);
        await app.waitForCondition<boolean>(`window.__tugIngest.host === "main"`, { timeoutMs: 10_000 });
        const atFailure = await app.evalJS<number>(`window.__tugIngest.tasks`);

        // The new host reconnects on its own and its batches reach the page.
        await app.waitForCondition<boolean>(`window.__tugIngest.tasks > ${atFailure}`, { timeoutMs: 20_000 });

        const fallbacks = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(window.__deckTrace.dump()
              .filter(function (e) { return e.kind === "session-lifecycle" && e.event === "connection.ingest_fallback"; })
              .map(function (e) { return e.fields; }))`,
          ),
        ) as FallbackEvent[];
        note(`at0731 fallback: ${JSON.stringify(fallbacks)}`);
        expect(fallbacks).toHaveLength(1);
        expect(String(fallbacks[0]!.detail)).toStartWith("the ingest Worker threw:");
        expect(fallbacks[0]!.permanent).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0726-ingest-worker-socket.test.ts — a module Worker holds tugcast's
 * socket inside the shipped WebKit.
 *
 * The ingest Worker moves the WebSocket, the framing, the decode and every
 * session's reducer off the page's main thread. All of it rests on one
 * platform fact: that this WebKit lets a dedicated module Worker open the
 * page's own `ws://<host>/ws` with the page's origin, complete tugcast's
 * text handshake, and transfer the binary frames it receives back to the
 * page. This file proves that fact first, and guards it after.
 *
 * Asserts, through `__tug.ingestSpike()`:
 *  - **the Worker loaded and opened the socket**: the spike resolves `ok`;
 *  - **the handshake is tugcast's**: the reply names `protocol: "tugcast"`
 *    and `version: 1`;
 *  - **a frame came back across the thread**: the transferred frame is
 *    non-empty and longer than the frame header.
 *
 * And, for the page's own connection:
 *  - **the page holds no socket**: `__tugIngest.host` is `"worker"`, and
 *    wire batches have reached the page through it after a live handshake
 *    (`__tugIngest.tasks` counts them).
 *
 * It notes whether the Worker's global scope has `requestAnimationFrame`,
 * a fact the pacer does not depend on.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/workers/ingest-worker.ts
 * @covers tugdeck/src/connection.ts
 * @covers tugdeck/src/lib/ingest/ingest-host.ts
 * @covers tugdeck/src/lib/ingest/ingest-channel.ts
 * @covers tugdeck/src/lib/ingest/wire-socket.ts
 * @covers tugdeck/src/lib/ingest/frame-peeler.ts
 * @covers tugdeck/src/lib/ingest/pacer.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** tugdeck's `HEADER_SIZE`: feed id, flags, and a 32-bit length. */
const FRAME_HEADER_BYTES = 6;

interface SpikeReport {
  ok: boolean;
  stage?: string;
  error?: string;
  handshake?: { protocol?: unknown; version?: unknown };
  firstFrameBytes?: number;
  firstFeedId?: number | null;
  hasRaf: boolean | null;
}

describe.skipIf(!SHOULD_RUN)("at0726 — a module Worker holds tugcast's socket", () => {
  test(
    "the Worker handshakes with tugcast and transfers a frame back",
    async () => {
      const app = await launchTugApp({ testName: "at0726-ingest-worker-socket" });
      try {
        await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
          timeoutMs: 20_000,
        });
        // The page's own connection lives in the ingest Worker, and its
        // handshake completed: frames have come back through it.
        await app.waitForCondition<boolean>(
          `!!window.__tugIngest && window.__tugIngest.host === "worker" && window.__tugIngest.tasks > 0`,
          { timeoutMs: 20_000 },
        );
        const ingest = await app.evalJS<string>(
          `JSON.stringify({ host: window.__tugIngest.host, tasks: window.__tugIngest.tasks })`,
        );
        note(`at0726 page ingest: ${ingest}`);
        expect((JSON.parse(ingest) as { host: string }).host).toBe("worker");

        // `evalJS` cannot return a promise's result: kick the spike off,
        // park its JSON on `window`, and wait for it.
        await app.evalJS<null>(
          `(window.__at0726spike = undefined,
            window.__tug.ingestSpike().then(
              function (r) { window.__at0726spike = JSON.stringify(r); },
              function (e) { window.__at0726spike = JSON.stringify({ ok: false, stage: "reject", error: String(e), hasRaf: null }); }
            ),
            null)`,
        );
        await app.waitForCondition<boolean>(`window.__at0726spike !== undefined`, {
          timeoutMs: 30_000,
        });
        const report = JSON.parse(await app.evalJS<string>(`window.__at0726spike`)) as SpikeReport;
        note(`at0726 spike: ${JSON.stringify(report)}`);

        expect(report.ok, `the spike failed at ${report.stage}: ${report.error}`).toBe(true);
        expect(report.handshake?.protocol).toBe("tugcast");
        expect(report.handshake?.version).toBe(1);
        expect(report.firstFrameBytes ?? 0).toBeGreaterThanOrEqual(FRAME_HEADER_BYTES);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0105-api-retry-banner.test.ts — claude's `api_retry` backoff surfaces as
 * a NON-blocking top-right pane bulletin, not a card-locking banner ([AT0105]).
 *
 * ## Why this exists
 *
 * Claude's SDK retries retryable API failures itself and announces each
 * attempt as a `system`/`api_retry` event. A retry is a self-healing
 * *notification*, not breakage — it must never lock the card. The old
 * behavior mirrored it into a `TugPaneBanner`, which sets `inert` on
 * `.tug-pane-body` (transcript + prompt), so the user couldn't type during a
 * benign retry. Now it routes to a `TransientNoticeController`-driven bulletin
 * in the card's top-right corner; the banner is reserved for genuine `error`
 * breakage.
 *
 * The pure halves (`classifyApiRetry`, `projectNotices`, `reconcileNotices`,
 * `deriveSessionCardBannerSpec`) are unit-tested. This drives the **live surface**
 * end to end without a real (rare) API failure: it injects synthetic frames
 * through the store's real `frameToEvent → dispatch` path
 * (`driveSession`/`ingestFrame`) and asserts (1) the pane body is never
 * `inert`, (2) a bulletin shows with the classified label + live attempt
 * count, (3) a new attempt updates it in place, (4) a likely-fatal category
 * escalates tone, and (5) a `cost_update` (turn boundary) dismisses it.
 *
 * The one classification that gets no bulletin is `connection`: a network
 * stall is the card's whole current condition rather than transient chatter,
 * so it is reported on the state strip as the `stalled` phase instead. The
 * categories driven here are deliberately not that one.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/api-retry.ts
 * @covers tugdeck/src/components/tugways/cards/transient-notice.ts
 * @covers tugdeck/src/components/tugways/tug-pane-bulletin.tsx
 * @covers tugdeck/src/lib/banner-lifecycle.ts
 * @covers tugcode/
 * @covers tugdeck/src/components/tugways/tug-pane-banner.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const PANE_BODY = ".tug-pane-body";
const BANNER = '[data-slot="tug-pane-banner"]';
const BULLETIN = ".tug-pane-bulletin";
const BULLETIN_TITLE = `${BULLETIN} [data-title]`;
const BULLETIN_DESC = `${BULLETIN} [data-description]`;
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const TUG_SESSION_ID = "test-session-A"; // bindSession default

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0105-api-retry-"));
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

function apiRetryFrame(fields: {
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error: string;
  error_status: number | null;
}) {
  return {
    op: "ingestFrame" as const,
    feedId: CODE_OUTPUT_FEED,
    decoded: {
      type: "api_retry",
      tug_session_id: TUG_SESSION_ID,
      ...fields,
    },
  };
}

/** True iff `.tug-pane-body` is NOT inert — i.e. the prompt is interactive. */
const PANE_BODY_NOT_INERT = `(function(){var b=document.querySelector(${JSON.stringify(
  PANE_BODY,
)});return b!==null && !b.hasAttribute("inert");})()`;

describe.skipIf(!SHOULD_RUN)(
  "AT0105: api_retry surfaces a non-blocking bulletin, never a locking banner",
  () => {
    test(
      "retry shows a live bulletin, leaves the prompt interactive, escalates on fatal, and clears at the turn boundary",
      async () => {
        const app = await launchTugApp({ testName: "at0105-api-retry-banner" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // Baseline: the pane body is interactive before any retry.
          expect(await app.evalJS<boolean>(PANE_BODY_NOT_INERT)).toBe(true);

          // ── transient category (rate_limit), attempt 3 ───────────────
          await app.driveSession(
            "A",
            apiRetryFrame({
              attempt: 3,
              max_retries: 10,
              retry_delay_ms: 8000,
              error: "rate_limit",
              error_status: 429,
            }),
          );

          // A bulletin mounts with caution tone (Sonner data-type="warning").
          await app.waitForCondition<boolean>(
            `(function(){var b=document.querySelector(${JSON.stringify(BULLETIN)});return b!==null && b.getAttribute("data-type")==="warning";})()`,
            { timeoutMs: 6000 },
          );
          // The classified label is the title; the live attempt count is the
          // description — no frozen countdown.
          expect(
            await app.evalJS<string>(
              `(document.querySelector(${JSON.stringify(BULLETIN_TITLE)})||{}).textContent || ""`,
            ),
          ).toContain("Rate limited");
          expect(
            await app.evalJS<string>(
              `(document.querySelector(${JSON.stringify(BULLETIN_DESC)})||{}).textContent || ""`,
            ),
          ).toContain("attempt 3 of 10");

          // CRITICAL: the card is NOT locked — no banner, pane body interactive.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(BANNER)}) === null || document.querySelector(${JSON.stringify(BANNER)}).getAttribute("data-visible") !== "true"`,
            ),
          ).toBe(true);
          expect(await app.evalJS<boolean>(PANE_BODY_NOT_INERT)).toBe(true);

          // ── a fresh attempt updates the SAME bulletin in place ───────
          await app.driveSession(
            "A",
            apiRetryFrame({
              attempt: 4,
              max_retries: 10,
              retry_delay_ms: 7000,
              error: "rate_limit",
              error_status: 429,
            }),
          );
          await app.waitForCondition<boolean>(
            `((document.querySelector(${JSON.stringify(BULLETIN_DESC)})||{}).textContent||"").indexOf("attempt 4 of 10") !== -1`,
            { timeoutMs: 6000 },
          );
          // Still exactly one bulletin (updated, not stacked).
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(BULLETIN)}).length`,
            ),
          ).toBe(1);

          // ── likely-fatal category escalates tone to danger ──────────
          await app.driveSession(
            "A",
            apiRetryFrame({
              attempt: 5,
              max_retries: 10,
              retry_delay_ms: 6000,
              error: "authentication_failed",
              error_status: 401,
            }),
          );
          await app.waitForCondition<boolean>(
            `(function(){var b=document.querySelector(${JSON.stringify(BULLETIN)});return b!==null && b.getAttribute("data-type")==="error";})()`,
            { timeoutMs: 6000 },
          );
          expect(
            await app.evalJS<string>(
              `(document.querySelector(${JSON.stringify(BULLETIN_TITLE)})||{}).textContent || ""`,
            ),
          ).toContain("Authentication failed");
          // Even a likely-fatal retry does not lock the card.
          expect(await app.evalJS<boolean>(PANE_BODY_NOT_INERT)).toBe(true);

          // ── a cost_update lands (turn boundary) → bulletin dismissed ─
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "cost_update",
              tug_session_id: TUG_SESSION_ID,
              total_cost_usd: 0.01,
            },
          });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(BULLETIN)}) === null`,
            { timeoutMs: 6000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0105] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

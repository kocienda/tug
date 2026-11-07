/**
 * at0784-overview-clear.test.ts — the Overview's `⋯` → Clear empties the
 * column, behind a confirm.
 *
 * The rail's title bar carries a `⋯` beside its place badge. Its one row,
 * Clear, raises a confirm popover off the `⋯`; Cancel leaves the column as it
 * was, and Clear empties it. A post written after the clear shows — the clear
 * is a mark on the view, not the end of the channel.
 *
 * Driven by real clicks in the Overview's own page, where the card draws its
 * pane's chrome: the menu, the confirm and the dispatch to the card's
 * card-content responder are all production.
 *
 * @covers tugdeck/src/components/chrome/card-title-bar.tsx
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/lib/overview-store.ts
 * @covers tugdeck/src/lib/pane-title-bar-items-store.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const CARD = '[data-testid="overview-card"]';
const POSTS = `${CARD} .overview-post-body`;
const MORE = '.body-chrome-frame [data-testid="tug-pane-title-bar-verb-menu-button"]';
const CLEAR_ROW = '.tug-menu-item[data-item-id="clear-overview"]';
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_CANCEL = `${CONFIRM} [data-slot="tug-confirm-cancel"]`;
const CONFIRM_CLEAR = `${CONFIRM} [data-slot="tug-confirm-confirm"]`;

function postJson(id: number, body: string): string {
  return JSON.stringify(
    JSON.stringify({ id, at_ms: 1_754_600_000_000 + id, author: "observer", body, refs: [] }),
  );
}

const POST_TEXTS = `Array.from(document.querySelectorAll(${JSON.stringify(POSTS)})).map(function(el){ return (el.textContent || "").trim(); })`;

describe.skipIf(!SHOULD_RUN)("at0784 — the Overview's ⋯ menu clears the column", () => {
  test(
    "Clear confirms, Cancel keeps the posts, Clear empties the column, a new post shows",
    async () => {
      const app = await launchTugApp({ testName: "at0784-overview-clear" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        const overview = kindBody(app, "overview");
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        for (const [id, body] of [[9201, "First report."], [9202, "Second report."]] as const) {
          expect(await overview.evalJS<boolean>(`window.__tug.publishOverviewPost(${postJson(id, body)})`)).toBe(true);
        }
        await overview.waitForCondition<boolean>(`${POST_TEXTS}.length === 2`, { timeoutMs: 10_000 });

        // ---- ⋯ → Clear raises the confirm; Cancel keeps everything ----
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MORE)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await overview.nativeClickAtElement(MORE);
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CLEAR_ROW)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await overview.nativeClickAtElement(CLEAR_ROW);
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 5_000 },
        );
        const message = await overview.evalJS<string>(
          `(document.querySelector(${JSON.stringify(CONFIRM)}) || {}).textContent || ""`,
        );
        note("confirm", message);
        expect(message).toContain("Clear the Overview?");

        await overview.nativeClickAtElement(CONFIRM_CANCEL);
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
          { timeoutMs: 5_000 },
        );
        expect(await overview.evalJS<string[]>(POST_TEXTS)).toEqual(["First report.", "Second report."]);

        // ---- ⋯ → Clear → Clear empties the column ----
        await overview.nativeClickAtElement(MORE);
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CLEAR_ROW)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await overview.nativeClickAtElement(CLEAR_ROW);
        await overview.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM_CLEAR)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await overview.nativeClickAtElement(CONFIRM_CLEAR);
        await overview.waitForCondition<boolean>(`${POST_TEXTS}.length === 0`, { timeoutMs: 5_000 });

        // ---- a post written after the clear shows ----
        expect(await overview.evalJS<boolean>(`window.__tug.publishOverviewPost(${postJson(9203, "After the clear.")})`)).toBe(true);
        await overview.waitForCondition<boolean>(`${POST_TEXTS}.length === 1`, { timeoutMs: 10_000 });
        expect(await overview.evalJS<string[]>(POST_TEXTS)).toEqual(["After the clear."]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

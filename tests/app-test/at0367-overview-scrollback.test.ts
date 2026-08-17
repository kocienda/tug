/**
 * at0367-overview-scrollback.test.ts — older history prepends without moving
 * the reader's line.
 *
 * The Overview pages backwards through its own ledger: near the top of the
 * transcript the store asks for the posts immediately older than the oldest
 * it holds, and they go in ABOVE what is on screen. Inserting rows above the
 * viewport moves everything below them down by exactly their height, so the
 * card compensates — `scrollTop` is pushed by the growth in `scrollHeight`,
 * measured against the previous layout pass — and the line being read stays
 * under the eye.
 *
 * That compensation is the claim here, because it is the half no unit test
 * can reach: it is a layout effect reading real measured heights of real
 * rendered markdown.
 *
 * The page is delivered through `publishOverviewPostsPage`, which hands a
 * `list_overview_posts_ok` body to the production CONTROL-response bus — the
 * same function `action-dispatch` calls with a wire response, entered one
 * step later. So the correlation (the echoed `before_id`), the dedupe, the
 * prepend, and the compensation are all production. Seeding the real ledger
 * was considered and is impossible: `publishOverviewPost` routes to the client
 * store and never reaches tugcast, so nothing it publishes is ever persisted.
 *
 * @covers tugdeck/src/lib/overview-store.ts
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/test-surface.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const TRANSCRIPT = '[data-testid="overview-transcript"]';
const POST = `${CARD} .overview-cell`;

interface WirePost {
  id: number;
  at_ms: number;
  author: "observer";
  body: string;
  refs: never[];
}

const AT_MS = 1_754_600_000_000;

/** A post whose body is long enough to give the column real height. */
function wirePost(id: number): WirePost {
  return {
    id,
    at_ms: AT_MS + id * 1_000,
    author: "observer",
    body: `Post ${id}: the session finished a turn and left a note about what it did, which is enough prose to give this row a height worth compensating for.`,
    refs: [],
  };
}

/** The scroll geometry the compensation is judged by. */
interface Geometry {
  scrollTop: number;
  scrollHeight: number;
  /** The first rendered row's own body text — which post leads the column. */
  firstBody: string;
  rows: number;
}

const GEOMETRY_JS = `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var first = document.querySelector(${JSON.stringify(`${POST} .overview-post-body`)});
  return {
    scrollTop: el === null ? -1 : el.scrollTop,
    scrollHeight: el === null ? -1 : el.scrollHeight,
    firstBody: first === null ? "" : (first.textContent || "").slice(0, 12),
    rows: document.querySelectorAll(${JSON.stringify(POST)}).length,
  };
})()`;

async function geometry(app: App): Promise<Geometry> {
  return app.evalJS<Geometry>(GEOMETRY_JS);
}

describe.skipIf(!SHOULD_RUN)("at0367 — the Overview pages backwards", () => {
  test(
    "an older page prepends above the reader and the reading line holds",
    async () => {
      const app = await launchTugApp({ testName: "at0367-overview-scrollback" });
      try {
        await app.nativeKey("g", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // Twelve posts, ids 20..31 — enough to overflow the rail so there is
        // a scroll position to hold in the first place.
        for (let id = 20; id <= 31; id++) {
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(id)))})`,
            ),
          ).toBe(true);
        }
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length === 12`,
          { timeoutMs: 10_000 },
        );

        // Put the reader partway up the column. Not at the very top: the
        // scroll-top trigger would fire a real `loadOlder`, and this test
        // delivers the page itself.
        await app.evalJS<unknown>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            el.scrollTop = Math.round(el.scrollHeight * 0.4);
            el.dispatchEvent(new Event("scroll"));
            return true;
          })()`,
        );

        const before = await geometry(app);
        note("before the page", JSON.stringify(before));
        expect(before.rows).toBe(12);
        expect(
          before.scrollTop,
          "the reader is somewhere in the middle, not pinned at either end",
        ).toBeGreaterThan(0);

        // The page: five older posts, echoing the `before_id` the store has
        // outstanding. The store correlates on that echo, so the delivery
        // must name the oldest post held.
        const page = {
          posts: [16, 17, 18, 19].map(wirePost),
          has_more: true,
          before_id: 20,
        };
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPostsPage(${JSON.stringify(JSON.stringify(page))})`,
          ),
        ).toBe(true);

        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length === 16`,
          { timeoutMs: 10_000 },
        );

        const after = await geometry(app);
        note("after the page", JSON.stringify(after));

        // The older posts went ABOVE: the column now leads with post 16.
        expect(after.firstBody).toContain("Post 16");
        expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight);

        // …and the reading line held. `scrollTop` moved by exactly what was
        // inserted above it, which is what keeps the reader's place; without
        // the compensation it would not have moved at all and the content
        // under the eye would have jumped down by the inserted height.
        const inserted = after.scrollHeight - before.scrollHeight;
        const drift = after.scrollTop - (before.scrollTop + inserted);
        note("inserted / drift", JSON.stringify({ inserted, drift }));
        expect(inserted).toBeGreaterThan(0);
        expect(
          Math.abs(drift),
          `the reading line drifted ${drift}px (inserted ${inserted}px)`,
        ).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

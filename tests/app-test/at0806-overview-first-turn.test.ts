/**
 * at0806-overview-first-turn.test.ts — Home and ⌃⇧⌘[ take the Overview to the
 * top of its loaded column, and an older page landing there holds the line.
 *
 * The Overview answers `FIRST_TURN` as the Session card does: the top of the
 * column, with follow-bottom released, the mirror of `LAST_TURN`'s live edge.
 * The chord is routed `key-card`, so it reaches this card from the composer;
 * bare Home reaches it through the engine's scroll-key route, which an
 * editable surface declines, so that press is made with the caret out of the
 * composer.
 *
 * The top is under `LOAD_OLDER_PX`, so it is the place an older page is asked
 * for and lands. The page here is delivered through `publishOverviewPostsPage`,
 * the production CONTROL-response bus one step after the wire, as at0367 does
 * for a reader mid-column. At the very top the engine's scroll anchoring has
 * nothing above the reader to anchor on, so the card's own push is the whole
 * compensation, and the post the reader was on has to stay where it was.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const TRANSCRIPT = '[data-testid="overview-transcript"]';
const POST = `${CARD} .overview-cell`;
const FIELD = '[data-testid="overview-composer-field"]';
const JUMP = '.overview-transcript-region [data-slot="tug-jump-to-bottom-button"]';
/** The column's own top inset: the oldest post at the top sits this far down. */
const TOP_INSET_MAX_PX = 16;

interface WirePost {
  id: number;
  at_ms: number;
  author: "observer";
  body: string;
  refs: never[];
}

const AT_MS = 1_754_600_000_000;

function wirePost(id: number): WirePost {
  return {
    id,
    at_ms: AT_MS + id * 1_000,
    author: "observer",
    body: `Post ${id}: the session finished a turn and left a note about what it did, which is enough prose to give this row a height a reader has to scroll past.`,
    refs: [],
  };
}

/** Where the column stands, and where one named post sits in the port. */
interface Standing {
  scrollTop: number;
  scrollHeight: number;
  atBottom: boolean;
  /** The jump-to-latest button's `data-visible`: "true" when not following. */
  jump: string | null;
  /** The first post the column holds (the store: the column is windowed). */
  firstBody: string;
  rows: number;
  /** The top of the post whose body begins with the probe, against the
   *  scrollport top, or null when that post is not mounted. */
  probeOffset: number | null;
}

function standingJs(probe: string): string {
  return `(function () {
    var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
    var posts = window.__tug.overviewPosts() || [];
    var jump = document.querySelector(${JSON.stringify(JUMP)});
    var portTop = el.getBoundingClientRect().top;
    var offset = null;
    Array.from(document.querySelectorAll(${JSON.stringify(POST)})).forEach(function (cell) {
      var body = cell.querySelector(".overview-post-body");
      if (body !== null && (body.textContent || "").indexOf(${JSON.stringify(probe)}) === 0) {
        offset = cell.getBoundingClientRect().top - portTop;
      }
    });
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2,
      jump: jump === null ? null : jump.getAttribute("data-visible"),
      firstBody: posts.length === 0 ? "" : posts[0].body.slice(0, 8),
      rows: posts.length,
      probeOffset: offset,
    };
  })()`;
}

async function standing(app: App, probe = "Post 20:"): Promise<Standing> {
  return kindBody(app, "overview").evalJS<Standing>(standingJs(probe));
}

const AT_TOP = `document.querySelector(${JSON.stringify(TRANSCRIPT)}).scrollTop <= 1`;
const AT_BOTTOM = `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
})()`;

describe.skipIf(!SHOULD_RUN)("at0806 — the Overview's first turn", () => {
  test(
    "⌃⇧⌘[ and Home reach the top, and a page landing there holds the line",
    async () => {
      const app = await launchTugApp({ testName: "at0806-overview-first-turn" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );

        for (let id = 20; id <= 31; id++) {
          expect(
            await kindBody(app, "overview").evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(id)))})`,
            ),
          ).toBe(true);
        }
        await kindBody(app, "overview").waitForCondition<boolean>(
          `(window.__tug.overviewPosts() || []).length === 12 &&
            Array.from(document.querySelectorAll(${JSON.stringify(`${POST} .overview-post-body`)}))
              .some(function (b) { return (b.textContent || "").indexOf("Post 31") === 0; })`,
          { timeoutMs: 10_000 },
        );

        // ── The chord, from the composer.
        await kindBody(app, "overview").nativeClickAtElement(`${FIELD} .cm-content`);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `document.activeElement !== null
            && document.activeElement.closest(${JSON.stringify(FIELD)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const opened = await standing(app);
        note("opened", JSON.stringify(opened));
        expect(opened.atBottom, "the column opens at the live bottom").toBe(true);

        await app.nativeKey("[", ["cmd", "ctrl", "shift"]);
        await kindBody(app, "overview").waitForCondition<boolean>(AT_TOP, { timeoutMs: 5_000 });
        const chordTop = await standing(app);
        note("after ⌃⇧⌘[", JSON.stringify(chordTop));
        expect(chordTop.scrollTop, "⌃⇧⌘[ lands at the top of the column").toBeLessThanOrEqual(1);
        expect(chordTop.jump, "and releases follow-bottom").toBe("true");
        expect(
          chordTop.probeOffset,
          "the oldest post held leads the port",
        ).not.toBeNull();
        expect(chordTop.probeOffset ?? -1).toBeGreaterThanOrEqual(0);
        expect(chordTop.probeOffset ?? 99).toBeLessThanOrEqual(TOP_INSET_MAX_PX);

        await app.nativeKey("]", ["cmd", "ctrl", "shift"]);
        await kindBody(app, "overview").waitForCondition<boolean>(AT_BOTTOM, { timeoutMs: 5_000 });
        expect((await standing(app)).jump, "⌃⇧⌘] follows again").toBe("false");

        // ── Bare Home, with the caret out of the composer: a click on a post
        // seats the card itself.
        expect(
          await kindBody(app, "overview").evalJS<boolean>(
            `(function () {
              var body = Array.from(document.querySelectorAll(${JSON.stringify(`${POST} .overview-post-body`)}))
                .find(function (b) { return (b.textContent || "").indexOf("Post 31") === 0; });
              if (body === undefined) return false;
              body.setAttribute("data-at0806-target", "");
              return true;
            })()`,
          ),
        ).toBe(true);
        await kindBody(app, "overview").nativeClickAtElement(
          "[data-at0806-target]",
        );
        const editable = await kindBody(app, "overview").evalJS<boolean>(
          `(function () {
            var a = document.activeElement;
            return a instanceof HTMLElement &&
              (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA");
          })()`,
        );
        expect(editable, "the caret has left the composer").toBe(false);

        await app.nativeKey("Home");
        await kindBody(app, "overview").waitForCondition<boolean>(AT_TOP, { timeoutMs: 5_000 });
        const before = await standing(app);
        note("after Home", JSON.stringify(before));
        expect(before.scrollTop, "Home lands at the top of the column").toBeLessThanOrEqual(1);
        expect(before.jump, "and releases follow-bottom").toBe("true");
        expect(before.rows).toBe(12);
        expect(before.probeOffset).not.toBeNull();

        // ── The page the top asks for lands above the reader.
        const page = {
          posts: [16, 17, 18, 19].map(wirePost),
          has_more: true,
          before_id: 20,
        };
        expect(
          await kindBody(app, "overview").evalJS<boolean>(
            `window.__tug.publishOverviewPostsPage(${JSON.stringify(JSON.stringify(page))})`,
          ),
        ).toBe(true);
        await kindBody(app, "overview").waitForCondition<boolean>(
          `(window.__tug.overviewPosts() || []).length === 16 &&
            document.querySelector(${JSON.stringify(TRANSCRIPT)}).scrollHeight > ${before.scrollHeight}`,
          { timeoutMs: 10_000 },
        );
        const after = await standing(app);
        note("after the page", JSON.stringify(after));
        expect(after.firstBody).toContain("Post 16");
        expect(after.probeOffset, "the post the reader was on is still mounted").not.toBeNull();
        const drift = (after.probeOffset ?? 0) - (before.probeOffset ?? 0);
        note("drift", JSON.stringify({ drift, inserted: after.scrollHeight - before.scrollHeight }));
        expect(
          Math.abs(drift),
          `the reading line drifted ${drift}px when the page landed at the top`,
        ).toBeLessThanOrEqual(2);
        expect(after.jump, "and the reader is still not following").toBe("true");

        // ── A second Home goes on to the new top.
        await app.nativeKey("Home");
        await kindBody(app, "overview").waitForCondition<boolean>(AT_TOP, { timeoutMs: 5_000 });
        const newTop = await standing(app, "Post 16:");
        note("after the second Home", JSON.stringify(newTop));
        expect(newTop.probeOffset, "the page's oldest post leads the port").not.toBeNull();
        expect(newTop.probeOffset ?? -1).toBeGreaterThanOrEqual(0);
        expect(newTop.probeOffset ?? 99).toBeLessThanOrEqual(TOP_INSET_MAX_PX);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

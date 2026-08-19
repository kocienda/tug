/**
 * at0370-overview-follow-bottom.test.ts — the Overview follows its live edge,
 * and says so.
 *
 * Two claims, and they are one mechanism seen from both sides.
 *
 * **Following.** While the reader is at the live edge, an arriving post keeps
 * them there — including the in-flight Operator wave, which is a row like any
 * other and pushes the edge down exactly as a post does. While the reader is
 * up in history, an arriving post must NOT yank them down; the line under the
 * eye is theirs until they ask for the bottom back.
 *
 * **Saying so.** The shared `TugJumpToBottomButton` floats over the column
 * whenever the reader is away from the edge, and clicking it jumps back and
 * re-engages following. Visibility is a `data-visible` attribute the card
 * writes ([L06]) — never React state — so the observable here is that
 * attribute on the real button, driven through the card's own follow-state
 * writer.
 *
 * **Resizing.** Follow-state is a reading of geometry, not a memory of a
 * gesture, so a change to the geometry re-reads it. A rail animating from
 * Stack to Split, a pane drag, the composer growing under the user's typing —
 * each moves the live edge with no scroll event to announce it, and one that
 * brings the edge back under the eye must re-engage. The composer drives that
 * here, and the reader is parked at exactly the distance where `scrollTop`
 * stays valid across the resize, so the browser clamps nothing and fires
 * nothing: the only thing that can re-engage following is the resize itself.
 *
 * Real geometry throughout: real posts through the production publish path,
 * real rendered markdown at real measured heights, real typing in the real
 * field, and the button clicked where it actually paints.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-card.css
 * @covers tugdeck/src/components/tugways/tug-jump-to-bottom-button.tsx
 * @covers tugdeck/src/components/tugways/tug-jump-to-bottom-button.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const TRANSCRIPT = '[data-testid="overview-transcript"]';
const POST = `${CARD} .overview-cell`;
const JUMP = `${CARD} .tug-jump-to-bottom-button`;
const COMPOSER = '[data-testid="overview-composer-field"]';

/** The composer's floor and ceiling, in rows — `overview-card.css` / `.tsx`. */
const COMPOSER_MIN_ROWS = 3;
const COMPOSER_MAX_ROWS = 8;

const AT_MS = 1_754_600_000_000;

interface WirePost {
  id: number;
  at_ms: number;
  author: "observer";
  body: string;
  refs: never[];
}

function wirePost(id: number): WirePost {
  return {
    id,
    at_ms: AT_MS + id * 1_000,
    author: "observer",
    body: `Post ${id}: the session finished a turn and left a note about what it did, which is enough prose to give this row a height a reader has to scroll past.`,
    refs: [],
  };
}

async function publish(app: App, post: WirePost): Promise<boolean> {
  return app.evalJS<boolean>(
    `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
  );
}

/** What the column and its affordance say about where the reader is. */
interface Edge {
  atBottom: boolean;
  scrollTop: number;
  /** The button's `data-visible`, verbatim — `null` when never written. */
  visible: string | null;
}

const EDGE_JS = `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var btn = document.querySelector(${JSON.stringify(JUMP)});
  return {
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2,
    scrollTop: Math.round(el.scrollTop),
    visible: btn === null ? null : btn.getAttribute("data-visible"),
  };
})()`;

async function edge(app: App): Promise<Edge> {
  return app.evalJS<Edge>(EDGE_JS);
}

/** The column's visible height — what a resize moves. */
async function viewport(app: App): Promise<number> {
  return app.evalJS<number>(
    `Math.round(document.querySelector(${JSON.stringify(TRANSCRIPT)}).clientHeight)`,
  );
}

/**
 * The composer's height in rows, measured against the field's own ROW —
 * `--tug-text-editor-row-height`, the height CM6 measured a `.cm-line` to
 * occupy. The 16 is the `cm-content` 8px top + 8px bottom padding, which the
 * three-row floor accounts for.
 */
const COMPOSER_ROWS_JS = `(function () {
  var field = document.querySelector(${JSON.stringify(COMPOSER)});
  if (field === null) return -1;
  var s = field.querySelector(".cm-scroller");
  if (s === null) return -1;
  var row = parseFloat(
    getComputedStyle(field).getPropertyValue("--tug-text-editor-row-height"),
  );
  return Math.round((s.getBoundingClientRect().height - 16) / row);
})()`;

/** The composer standing at its `maxRows` ceiling — the scroller clamped to the
 *  `max-height` the cap sets, with content past it. */
const COMPOSER_AT_CAP_JS = `(function () {
  var s = document.querySelector(${JSON.stringify(`${COMPOSER} .cm-scroller`)});
  if (s === null) return false;
  var cap = parseFloat(getComputedStyle(s).maxHeight);
  return Math.abs(s.getBoundingClientRect().height - cap) < 1;
})()`;

/**
 * Fill the composer to its `maxRows` ceiling and wait for the height to
 * settle. Grown by RETURNS rather than by wrapped text: the Overview's send
 * chord is ⇧⏎, so a bare Return is a newline, and a row count is exact where a
 * character count would depend on how wide the rail happens to be today.
 */
async function fillComposer(app: App): Promise<void> {
  for (let i = 0; i < COMPOSER_MAX_ROWS; i++) await app.nativeKey("Enter");
  await app.waitForCondition<boolean>(COMPOSER_AT_CAP_JS, {
    timeoutMs: 10_000,
  });
}

/**
 * Take the composer's rows back out and wait for the collapse. One Backspace
 * per Return typed, rather than ⌘A + delete: ⌘A is a chain-routed command and
 * the sweep cannot make an editor the chain's leaf, so it would be answered by
 * the card rather than the field.
 */
async function clearComposer(app: App): Promise<void> {
  for (let i = 0; i < COMPOSER_MAX_ROWS; i++) await app.nativeKey("Backspace");
  await app.waitForCondition<boolean>(
    `${COMPOSER_ROWS_JS} === ${COMPOSER_MIN_ROWS}`,
    { timeoutMs: 10_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0370 — the Overview's live edge", () => {
  test(
    "the column follows the edge, and the jump button says when it does not",
    async () => {
      const app = await launchTugApp({
        testName: "at0370-overview-follow-bottom",
      });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // The button is MOUNTED from the start ([L26]) — hidden by CSS, not
        // by a condition, so the show / hide is never a reconciliation.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(JUMP)}) !== null`,
          ),
          "the jump button is mounted before it is ever needed",
        ).toBe(true);

        for (let id = 20; id <= 31; id++) {
          expect(await publish(app, wirePost(id))).toBe(true);
        }
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length === 12`,
          { timeoutMs: 10_000 },
        );

        // ── 1. At the edge: followed there, and the affordance is down.
        const opened = await edge(app);
        note("after the first posts", JSON.stringify(opened));
        expect(opened.atBottom, "the arriving posts kept the edge").toBe(true);
        expect(
          opened.visible,
          "nothing to jump to — the button stays hidden",
        ).not.toBe("true");

        // ── 2. Up in history: the button appears. The target is a fraction
        // of the SCROLL RANGE, not of `scrollHeight` — a fraction of the
        // latter can exceed the range and clamp straight back to the bottom,
        // which would leave this test asserting nothing at all.
        await app.evalJS<unknown>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.3);
            el.dispatchEvent(new Event("scroll"));
            return true;
          })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JUMP)}).getAttribute("data-visible") === "true"`,
          { timeoutMs: 5_000 },
        );
        const away = await edge(app);
        note("scrolled up", JSON.stringify(away));
        expect(away.atBottom).toBe(false);

        // ── 3. A post arriving while the reader is up-column does NOT yank
        // them down. This is the half a naive "always scroll to the newest"
        // gets wrong, and the reader loses their place every time a session
        // finishes a turn.
        expect(await publish(app, wirePost(32))).toBe(true);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length === 13`,
          { timeoutMs: 10_000 },
        );
        const held = await edge(app);
        note("a post arrived while up-column", JSON.stringify(held));
        expect(
          held.scrollTop,
          "the reader's line held while a post arrived below them",
        ).toBe(away.scrollTop);
        expect(held.visible, "and the button is still offering the edge").toBe(
          "true",
        );

        // ── 4. The click: back to the edge, and following again. Clicked
        // where it actually paints — a control that is visible but not
        // clickable is the bug this catches.
        await app.nativeClickAtElement(JUMP);
        await app.waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
          })()`,
          { timeoutMs: 5_000 },
        );
        const jumped = await edge(app);
        note("after the click", JSON.stringify(jumped));
        expect(jumped.atBottom).toBe(true);
        expect(
          jumped.visible,
          "back at the edge, the button withdraws",
        ).toBe("false");

        // ── 5. And following is genuinely re-engaged: the next post keeps
        // the edge rather than being left below the fold.
        expect(await publish(app, wirePost(33))).toBe(true);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length === 14`,
          { timeoutMs: 10_000 },
        );
        const following = await edge(app);
        note("a post after the jump", JSON.stringify(following));
        expect(
          following.atBottom,
          "the jump re-engaged following, so the new post kept the edge",
        ).toBe(true);

        // ── 6. A RESIZE re-reads the edge.
        //
        // The column's height moves for reasons that are not scrolling — a
        // rail animating from Stack to Split, a pane drag, the composer
        // growing under the user's typing — and a resize that brings the live
        // edge back under the eye fires no scroll event to say so. Without
        // this the card goes on believing the reader is away: the jump button
        // hovers over the newest post offering to take them where they already
        // are, and the next post lands below the fold.
        //
        // The composer is the resize driven here because it is real typing in
        // the real field, and it moves exactly the geometry a rail animation
        // moves: the transcript's track is what the composer takes its rows
        // from. Eight rows of it, then two.
        await app.nativeClickAtElement(`${COMPOSER} .cm-content`);
        await app.waitForCondition<boolean>(
          `document.activeElement !== null
            && document.activeElement.closest(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 8_000 },
        );

        // Calibrate: how many pixels does clearing the composer give back to
        // the column? Measured, not derived — the field's line height is the
        // reader's editor font-size setting, and this test's whole point is
        // that a real number of real pixels moved.
        await fillComposer(app);
        const tall = await viewport(app);
        await clearComposer(app);
        const short = await viewport(app);
        const growth = short - tall;
        note("composer collapse gives the column back", `${growth}px`);
        expect(
          growth,
          "typing into the composer really does take height from the column",
        ).toBeGreaterThan(24);

        // And while the reader was AT the edge for all of that, the pin held
        // it there — the other direction of the same observer.
        const throughResize = await edge(app);
        expect(
          throughResize.atBottom,
          "a follower keeps the edge across a resize",
        ).toBe(true);

        // Now the real pass. Park the reader `growth + 12` from the bottom:
        // far enough to be away (past the 24px slack, so the button shows),
        // near enough that giving `growth` back lands them within it. The
        // window matters — at that distance `scrollTop` stays VALID after the
        // resize, so the browser has nothing to clamp and fires no scroll
        // event. What re-engages follow-bottom here can only be the resize.
        await fillComposer(app);
        await app.evalJS<unknown>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            el.scrollTop = el.scrollHeight - el.clientHeight - ${growth + 12};
            el.dispatchEvent(new Event("scroll"));
            return true;
          })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JUMP)}).getAttribute("data-visible") === "true"`,
          { timeoutMs: 5_000 },
        );
        const parked = await edge(app);
        note("parked just above the edge", JSON.stringify(parked));

        await clearComposer(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JUMP)}).getAttribute("data-visible") === "false"`,
          { timeoutMs: 5_000 },
        );
        const resized = await edge(app);
        note("after the resize", JSON.stringify(resized));
        // The reader was parked FARTHER from the bottom than the resize gives
        // back (`growth + 12` away, `growth` returned), so `scrollTop` stayed
        // valid across it and the browser had nothing to clamp — no scroll
        // event carried this news. What closed the last 12 pixels is the card
        // re-reading its own geometry, finding the edge inside the slack,
        // re-engaging, and pinning. That pin is why the final position is the
        // exact bottom rather than the 12-px-short one the reader left.
        expect(
          parked.scrollTop,
          "the park was inside the range the resize would leave — nothing to clamp",
        ).toBeLessThan(resized.scrollTop);
        expect(
          resized.atBottom,
          "the column got its rows back, and the edge is under the eye again",
        ).toBe(true);

        // Withdrawing the button is the visible half; the invisible half is
        // that following is genuinely on again.
        expect(await publish(app, wirePost(34))).toBe(true);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(POST)}).length === 15`,
          { timeoutMs: 10_000 },
        );
        const afterResize = await edge(app);
        note("a post after the resize", JSON.stringify(afterResize));
        expect(
          afterResize.atBottom,
          "the resize re-engaged following, so the new post kept the edge",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

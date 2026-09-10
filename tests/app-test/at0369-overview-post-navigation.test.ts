/**
 * at0369-overview-post-navigation.test.ts — ⌃⌘[ / ⌃⌘] step the Overview one
 * post at a time.
 *
 * The chord is the Session transcript's, read on this card's column, and it
 * is delivered the way that card's is: the registry's `PREVIOUS_TURN` /
 * `NEXT_TURN` are routed `key-card`, so the press goes to whichever card the
 * user is in and the card answers it on its `card-content` responder. That
 * routing is the whole claim no unit test can reach — the chord has to leave
 * AppKit's menu-bar scan (the Session menu's rows for these commands validate
 * disabled with no session card frontmost, and `disabledChord: "detach"`
 * releases the key equivalent for exactly that case), land in the web view,
 * resolve against the registry, and find this card's handler.
 *
 * The second claim is the step itself. The Overview shares the transcript's
 * selection rule (`computePageNavigation`), so a press lands a post's TOP
 * flush with the top of the column — not a fixed pixel amount, not a viewport
 * page. The assertion is therefore geometric: after each press, some post's
 * top edge is at the scrollport's top edge, and the post that is there is one
 * neighbor away from the one that was there before.
 *
 * The caret is put in the composer first, on purpose: `key-card` routing is
 * what makes the gesture work from anywhere in the rail, and the composer is
 * the surface most likely to swallow a bracket: CodeMirror's `defaultKeymap`
 * binds `Mod-[` / `Mod-]` to `indentLess` / `indentMore`, which is why the
 * family took the ⌃⌘ composition rather than plain ⌘ ([D184]). A CM6 editor
 * holding focus and the column still stepping is the routing working AND that
 * composition clearing the indent bindings.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/tugways/internal/list-view-page-navigation.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const TRANSCRIPT = '[data-testid="overview-transcript"]';
const POST = `${CARD} .overview-cell`;
const FIELD = '[data-testid="overview-composer-field"]';

const AT_MS = 1_754_600_000_000;

interface WirePost {
  id: number;
  at_ms: number;
  author: "observer";
  body: string;
  refs: never[];
}

/** A post long enough that several of them overflow the rail. */
function wirePost(id: number): WirePost {
  return {
    id,
    at_ms: AT_MS + id * 1_000,
    author: "observer",
    body: `Post ${id}: the session finished a turn and left a note about what it did, which is enough prose to give this row a height a reader has to scroll past.`,
    refs: [],
  };
}

/** Where the column stands: which post is flush at the top, and how far down. */
interface Standing {
  /** Index of the post whose top is at the scrollport top, or -1 if none is. */
  flushIndex: number;
  scrollTop: number;
  atBottom: boolean;
}

const STANDING_JS = `(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var cells = Array.from(document.querySelectorAll(${JSON.stringify(POST)}));
  var portTop = el.getBoundingClientRect().top;
  var flush = -1;
  cells.forEach(function (cell, i) {
    if (Math.abs(cell.getBoundingClientRect().top - portTop) <= 2) flush = i;
  });
  return {
    flushIndex: flush,
    scrollTop: Math.round(el.scrollTop),
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2,
  };
})()`;

async function standing(app: App): Promise<Standing> {
  return app.evalJS<Standing>(STANDING_JS);
}

describe.skipIf(!SHOULD_RUN)("at0369 — the Overview steps by post", () => {
  test(
    "⌃⌘[ / ⌃⌘] land a post's top flush at the top of the column",
    async () => {
      const app = await launchTugApp({
        testName: "at0369-overview-post-navigation",
      });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );

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

        // The caret goes in the composer — the surface an arrow would
        // otherwise belong to. Everything below is dispatched while a CM6
        // editor holds DOM focus.
        await app.nativeClickAtElement(`${FIELD} .cm-content`);
        await app.waitForCondition<boolean>(
          `document.activeElement !== null
            && document.activeElement.closest(${JSON.stringify(FIELD)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // The column follows the newest post, so it opens pinned at the
        // bottom — the position every press below is measured from.
        const opened = await standing(app);
        note("opened", JSON.stringify(opened));
        expect(opened.atBottom, "the column opens at the live bottom").toBe(
          true,
        );

        // ── Up. Each press pins one post's top to the top of the column,
        // and each pins the one before the last.
        await app.nativeKey("[", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            return el.scrollHeight - el.scrollTop - el.clientHeight > 2;
          })()`,
          { timeoutMs: 5_000 },
        );
        const firstUp = await standing(app);
        note("after one ⌃⌘[", JSON.stringify(firstUp));
        expect(
          firstUp.flushIndex,
          "a post's top is flush with the top of the column",
        ).toBeGreaterThanOrEqual(0);
        expect(
          firstUp.scrollTop,
          "and the column moved up off the bottom",
        ).toBeLessThan(opened.scrollTop);

        await app.nativeKey("[", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            return Math.round(el.scrollTop) < ${firstUp.scrollTop};
          })()`,
          { timeoutMs: 5_000 },
        );
        const secondUp = await standing(app);
        note("after two ⌃⌘[", JSON.stringify(secondUp));
        expect(
          secondUp.flushIndex,
          "the second press steps to the post before it, not by a pixel amount",
        ).toBe(firstUp.flushIndex - 1);

        // ── Down. The mirror: back to the post the first press had chosen.
        await app.nativeKey("]", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            return Math.round(el.scrollTop) > ${secondUp.scrollTop};
          })()`,
          { timeoutMs: 5_000 },
        );
        const back = await standing(app);
        note("after ⌃⌘]", JSON.stringify(back));
        expect(
          back.flushIndex,
          "⌃⌘] returns to the post ⌃⌘[ stepped off",
        ).toBe(firstUp.flushIndex);

        // ── And down past the last post is the live bottom: the gesture that
        // re-engages following rather than stopping one post short of it.
        for (let i = 0; i < 14; i++) {
          await app.nativeKey("]", ["cmd", "ctrl"]);
        }
        await app.waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
            return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
          })()`,
          { timeoutMs: 5_000 },
        );
        const bottom = await standing(app);
        note("walked to the end", JSON.stringify(bottom));
        expect(bottom.atBottom, "the column is back at the live bottom").toBe(
          true,
        );

        // The caret never left the composer — the routing is `key-card`, not
        // a listener on the column, so focus was never taken to scroll.
        expect(
          await app.evalJS<boolean>(
            `document.activeElement !== null
              && document.activeElement.closest(${JSON.stringify(FIELD)}) !== null`,
          ),
          "the caret stayed in the composer throughout",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

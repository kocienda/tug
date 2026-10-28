/**
 * at0760-help-card-find.test.ts — ⌘F finds in a help document.
 *
 * The guide and the glossary are long, and a help card used to be the one
 * long document in the app with no search. It mounts the shared find bar now,
 * over an engine that searches the rendered document's own text.
 *
 * Every gesture is the app's own: Help ▸ Tug Help from the menu, a trusted
 * click in the document, real ⌘F / ⌘G / ⇧⌘G / Escape keys and typed text.
 * The reads are the bar's count chip and the registered Custom Highlights.
 *
 * Legs:
 *   1. **⌘F opens the bar** under the document, its query field holding the
 *      caret.
 *   2. **A query counts and paints.** Typing a word the guide uses many times
 *      reads `1 of N` with N > 1, and the document carries one active
 *      highlight and N − 1 others.
 *   3. **⌘G and ⇧⌘G step.** ⌘G reads `2 of N`; ⇧⌘G reads `1 of N` again.
 *   4. **Escape dismisses.** The bar is gone and no find paint is left.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/help-card.tsx
 * @covers tugdeck/src/components/tugways/document-find-engine.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const DOC = '[data-slot="help-card"] [data-slot="tug-markdown-block"]';
const BAR = '[data-slot="help-card-find-bar"]';
const INPUT = `${BAR} [data-testid="help-card-find-input"] .cm-content`;
const CHIP = `${BAR} [data-slot="find-count"] [data-slot="find-count-value"]`;

/** A word the feature guide uses many times over. */
const QUERY = "card";

/** Perform Help ▸ Tug Help and return the help card it brought forward. */
async function openTugHelp(app: App): Promise<string> {
  const performed = await app.performMenuItem("help.tugHelp");
  expect(performed.found && performed.performed, "help.tugHelp performs").toBe(true);
  // card-dom: shell — the active card and its bag are the deck's record.
  return app.waitForCondition<string>(
    `(function () {
      var id = window.__tug.getActiveCardId();
      if (id === null) return null;
      var bag = window.__tug.getCardStateBag(id);
      var content = bag && bag.content;
      return content && content.doc === "features" ? id : null;
    })()`,
    { timeoutMs: 5_000 },
  );
}

/** The chip's `n of N`, once it reads one. */
const READ_CHIP = `(function(){
  var el = document.querySelector(${JSON.stringify(CHIP)});
  var m = el === null ? null : /^(\\d+) of (\\d+)/.exec((el.textContent || "").trim());
  return m === null ? null : { at: Number(m[1]), of: Number(m[2]) };
})()`;

/** The size of each find highlight, 0 when it is not registered. */
const READ_PAINT = `(function(){
  function size(name) { var h = CSS.highlights.get(name); return h ? h.size : 0; }
  return { match: size("document-find-match"), active: size("document-find-active") };
})()`;

describe.skipIf(!SHOULD_RUN)("at0760: ⌘F finds in a help document", () => {
  test(
    "⌘F opens the bar; a query counts and paints; ⌘G steps; Escape dismisses",
    async () => {
      const app = await launchTugApp({
        testName: "at0760-help-card-find",
        skipAccessibilityPreflight: true,
      });
      try {
        const cardId = await openTugHelp(app);
        const body = app.body(cardId);
        await body.waitForCondition<boolean>(
          `(function(){ var r = document.querySelector(${JSON.stringify(DOC)}); return r !== null && r.childElementCount > 3; })()`,
          { timeoutMs: 10_000 },
        );
        // The reader is in the document: a click on its first heading.
        await body.nativeClickAtElement(`${DOC} h1`);

        // ── Leg 1: ⌘F opens the bar, the caret in its field. ──
        await app.nativeKey("f", ["cmd"]);
        await body.waitForCondition<boolean>(
          `(function(){
            var input = document.querySelector(${JSON.stringify(INPUT)});
            return input !== null && document.activeElement !== null &&
              (input === document.activeElement || input.contains(document.activeElement));
          })()`,
          { timeoutMs: 4_000 },
        );

        // ── Leg 2: a query counts and paints. ──
        await app.nativeType(QUERY);
        // The search runs as the query is typed, so the chip and the paint are
        // read together, once the field holds the whole query: the chip's
        // count and the painted matches must be the same set.
        const typed = await body.waitForCondition<{
          chip: { at: number; of: number };
          paint: { match: number; active: number };
        }>(
          `(function(){
            var input = document.querySelector(${JSON.stringify(INPUT)});
            if (input === null || (input.textContent || "") !== ${JSON.stringify(QUERY)}) return null;
            var chip = ${READ_CHIP};
            var paint = ${READ_PAINT};
            if (chip === null || paint.active !== 1 || paint.match !== chip.of - 1) return null;
            return { chip: chip, paint: paint };
          })()`,
          { timeoutMs: 4_000 },
        );
        const first = typed.chip;
        note(`after typing "${QUERY}": ${first.at} of ${first.of}, paint ${JSON.stringify(typed.paint)}`);
        expect(first.at).toBe(1);
        expect(first.of, `"${QUERY}" should occur more than once`).toBeGreaterThan(1);

        // ── Leg 3: ⌘G and ⇧⌘G step through the matches. ──
        await app.nativeKey("g", ["cmd"]);
        const second = await body.waitForCondition<{ at: number; of: number }>(
          `(function(){ var c = ${READ_CHIP}; return c !== null && c.at === 2 ? c : null; })()`,
          { timeoutMs: 4_000 },
        );
        expect(second.of).toBe(first.of);
        await app.nativeKey("g", ["cmd", "shift"]);
        await body.waitForCondition<boolean>(
          `(function(){ var c = ${READ_CHIP}; return c !== null && c.at === 1; })()`,
          { timeoutMs: 4_000 },
        );

        // ── Leg 4: Escape dismisses, and takes the paint with it. ──
        await app.nativeKey("Escape", []);
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BAR)}) === null`,
          { timeoutMs: 4_000 },
        );
        const after = await body.evalJS<{ match: number; active: number }>(READ_PAINT);
        expect(after, "no find paint outlives the bar").toEqual({ match: 0, active: 0 });
      } finally {
        await app.quitGracefully();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

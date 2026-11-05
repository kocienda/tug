/**
 * at0780-overview-composer-replace.test.ts — find and replace in the
 * Overview card's composer ([AT0780]).
 *
 * ## Why this exists
 *
 * The Overview's composer had no find at all. It now has a bar of its own,
 * opened by ⌥⌘F with the caret in the field and docked under the composer,
 * on the same shared engine as every other editable surface, replace row
 * included.
 *
 * ## Test matrix
 *
 *   1. Edit ▸ Find ▸ Find and Replace… from the field opens the composer's
 *      bar under the composer, with the replace row and the caret in the
 *      query.
 *   2. Edit ▸ Find ▸ Find Next with the caret in the field steps the
 *      composer's own bar. Return in the replacement field is Replace: it
 *      swaps the match ⌘G landed on and moves on; All swaps the rest.
 *   3. Escape closes the bar and hands the caret back to the field.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/tugways/composer-find-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-testid="overview-card"]';
const COMPOSER = '[data-testid="overview-composer"]';
const FIELD = '[data-testid="overview-composer-field"] .cm-content';
const BAR = '[data-slot="overview-composer-find-bar"]';
const QUERY = `${BAR} [data-testid="overview-composer-find-input"] .cm-content`;
const REPLACEMENT = `${BAR} [data-testid="overview-composer-replace-input"] .cm-content`;
const CHIP = `${BAR} [data-slot="find-count"] [data-slot="find-count-value"]`;

const exists = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)}) !== null`;

const caretIn = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  return el !== null && document.activeElement !== null && el.contains(document.activeElement);
})()`;

describe.skipIf(!SHOULD_RUN)("AT0780: find and replace in the Overview composer", () => {
  test(
    "⌥⌘F opens the composer's bar; Return replaces one, All the rest, Escape goes home",
    async () => {
      const app: App = await launchTugApp({ testName: "at0780-overview-composer-replace" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        const body = kindBody(app, "overview");
        await body.waitForCondition<boolean>(exists(CARD), { timeoutMs: 10_000 });

        await body.nativeClickAtElement(FIELD);
        await body.waitForCondition<boolean>(caretIn(FIELD), { timeoutMs: 8000 });
        await app.nativeType("tide pool tide pool");
        const fieldText = (expected: string) =>
          body
            .waitForCondition<boolean>(
              `(() => {
                const el = document.querySelector(${JSON.stringify(FIELD)});
                return el !== null && el.textContent === ${JSON.stringify(expected)};
              })()`,
              { timeoutMs: 6000 },
            )
            .catch(async () => {
              // Name what the field, the replacement and the chip held, so a
              // red says which stage it stopped at without a second run.
              const seen = await body.evalJS<string>(
                `JSON.stringify({
                  field: document.querySelector(${JSON.stringify(FIELD)})?.textContent ?? null,
                  query: document.querySelector(${JSON.stringify(`${QUERY} .cm-line`)})?.textContent ?? null,
                  active: document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
                  replacement: document.querySelector(${JSON.stringify(`${REPLACEMENT} .cm-line`)})?.textContent ?? null,
                  chip: document.querySelector(${JSON.stringify(CHIP)})?.textContent ?? null,
                })`,
              );
              throw new Error(`the field never read ${JSON.stringify(expected)}; saw ${seen}`);
            });
        await fieldText("tide pool tide pool");

        // --- 1. The composer's bar, under the composer, with the row. ---
        const opened = await app.performMenuItem("edit.findAndReplace");
        expect(opened.found && opened.enabled, "Find and Replace… is enabled in the Overview composer").toBe(true);
        expect(opened.found && opened.performed, "Find and Replace… performs").toBe(true);
        await body.waitForCondition<boolean>(exists(REPLACEMENT), { timeoutMs: 4000 });
        const under = await body.evalJS<boolean>(
          `(() => {
            const composer = document.querySelector(${JSON.stringify(COMPOSER)});
            const bar = document.querySelector(${JSON.stringify(BAR)});
            return composer !== null && bar !== null &&
              Boolean(composer.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING);
          })()`,
        );
        expect(under, "the bar docks under the composer").toBe(true);
        await body.waitForCondition<boolean>(caretIn(QUERY), { timeoutMs: 4000 });

        // --- 2. ⌘G steps the bar; Return replaces one; All the rest. ---
        await app.nativeType("tide");
        // The whole query first: the count already reads 2 at "t", and a key
        // still in flight would land in whatever field is clicked next.
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${QUERY} .cm-line`)})?.textContent === "tide"`,
          { timeoutMs: 4000 },
        );
        await body.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(CHIP)});
            return el !== null && (el.textContent || '').trim() === "1 of 2";
          })()`,
          { timeoutMs: 6000 },
        );
        // ⌘G with the caret in the question steps its own bar, the Overview
        // having no other search. From the end of the text the first press
        // wraps to the first match and the second lands on the last, which
        // is the one Return replaces below.
        await body.nativeClickAtElement(FIELD);
        await body.waitForCondition<boolean>(caretIn(FIELD), { timeoutMs: 4000 });
        await app.nativeKey("End");
        for (let i = 0; i < 2; i++) {
          const stepped = await app.performMenuItem("edit.findNext");
          expect(stepped.found && stepped.enabled, "Find Next is enabled with the bar open").toBe(true);
          expect(stepped.found && stepped.performed, "Find Next performs").toBe(true);
          await body.waitForCondition<boolean>(
            `(() => {
              const el = document.querySelector(${JSON.stringify(CHIP)});
              return el !== null && (el.textContent || '').trim() === ${JSON.stringify(i === 0 ? "1 of 2" : "2 of 2")};
            })()`,
            { timeoutMs: 6000 },
          );
        }
        // The field seeds from the deck-wide remembered replacement, and a
        // click collapses the seed's selection, so clear it with bare keys.
        await body.nativeClickAtElement(REPLACEMENT);
        // The click's focus grant lands a beat later; a key sent before it
        // would edit the query field instead.
        await body.waitForCondition<boolean>(caretIn(REPLACEMENT), { timeoutMs: 4000 });
        for (let i = 0; i < 16; i++) await app.nativeKey("Backspace");
        for (let i = 0; i < 16; i++) await app.nativeKey("Delete");
        await app.nativeType("rock");
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${REPLACEMENT} .cm-line`)})?.textContent === "rock"`,
          { timeoutMs: 4000 },
        );
        await app.nativeKey("Return");
        await fieldText("tide pool rock pool");
        await body.click(`${BAR} [data-testid="find-replace-all"]`);
        await fieldText("rock pool rock pool");

        // --- 3. Escape closes the bar and the caret goes home. ---
        await body.nativeClickAtElement(REPLACEMENT);
        await app.nativeKey("Escape");
        await body.waitForCondition<boolean>(`!(${exists(BAR)})`, { timeoutMs: 4000 });
        await body.waitForCondition<boolean>(caretIn(FIELD), { timeoutMs: 4000 });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

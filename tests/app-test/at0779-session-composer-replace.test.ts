/**
 * at0779-session-composer-replace.test.ts — find and replace in the Session
 * card's composer ([AT0779]).
 *
 * ## Why this exists
 *
 * The composer is its own find surface: ⌥⌘F with the caret in it opens the
 * composer's bar, docked under the prompt entry, with the replace row, on the
 * same CM6 engine the Text card finds through. ⌘F keeps its meaning — the
 * transcript — even from the composer, and the two bars are different bars.
 *
 * ## Test matrix
 *
 *   1. Edit ▸ Find ▸ Find and Replace… from the composer opens the composer's
 *      bar under the prompt entry, with the replace row, and not the
 *      transcript's bar.
 *   2. A query counts the composer's matches; Replace swaps the first, All
 *      swaps the rest, and the composer holds the edited message.
 *   3. Escape closes the bar and hands the caret back to the composer.
 *   4. Edit ▸ Find… from the composer still opens the transcript's bar.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/composer-find-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/theme.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const SID = "c7c0d1ea-0000-4000-8000-000000000779";

const CARD = '[data-card-id="A"]';
const ENTRY = `${CARD} [data-slot="tug-prompt-entry"]`;
const EDITOR = `${ENTRY} [data-slot="tug-text-editor"] .cm-content`;
const BAR = `${CARD} [data-slot="session-composer-find-bar"]`;
const QUERY = `${BAR} [data-testid="session-composer-find-input"] .cm-content`;
const REPLACEMENT = `${BAR} [data-testid="session-composer-replace-input"] .cm-content`;
const CHIP = `${BAR} [data-slot="find-count"] [data-slot="find-count-value"]`;
const TRANSCRIPT_BAR = `${CARD} [data-slot="session-card-find-bar"]`;

const exists = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)}) !== null`;

const caretIn = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  return el !== null && document.activeElement !== null && el.contains(document.activeElement);
})()`;

async function waitForChip(app: App, expected: string): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(CHIP)});
      return el !== null && (el.textContent || '').trim() === ${JSON.stringify(expected)};
    })()`,
    { timeoutMs: 6000 },
  );
}

async function waitForComposer(app: App, expected: string): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(EDITOR)});
      return el !== null && el.textContent === ${JSON.stringify(expected)};
    })()`,
    { timeoutMs: 6000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0779: find and replace in the Session composer", () => {
  test(
    "⌥⌘F opens the composer's own bar; Replace and All edit the message; ⌘F stays the transcript's",
    async () => {
      const app = await launchTugApp({ testName: "at0779-session-composer-replace" });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        const body = app.body("A");
        await body.waitForCondition<boolean>(exists(EDITOR), { timeoutMs: 8000 });

        await body.nativeClickAtElement(EDITOR);
        await app.nativeType("red fish red fish red");
        await waitForComposer(app, "red fish red fish red");

        // --- 1. The composer's bar, under the entry, with the replace row. ---
        const opened = await app.performMenuItem("edit.findAndReplace");
        expect(opened.found && opened.enabled, "Find and Replace… is enabled in the composer").toBe(true);
        expect(opened.found && opened.performed, "Find and Replace… performs").toBe(true);
        await body.waitForCondition<boolean>(exists(REPLACEMENT), { timeoutMs: 4000 });
        expect(await body.evalJS<boolean>(exists(TRANSCRIPT_BAR)), "not the transcript's bar").toBe(false);
        const under = await body.evalJS<boolean>(
          `(() => {
            const entry = document.querySelector(${JSON.stringify(ENTRY)});
            const bar = document.querySelector(${JSON.stringify(BAR)});
            return entry !== null && bar !== null &&
              Boolean(entry.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING);
          })()`,
        );
        expect(under, "the bar docks under the prompt entry").toBe(true);
        await body.waitForCondition<boolean>(caretIn(QUERY), { timeoutMs: 4000 });

        // --- 2. Count, Replace, All. ---
        await app.nativeType("red");
        // The whole query first: the count already reads 3 at "r", and a key
        // still in flight would land in whatever field is clicked next.
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${QUERY} .cm-line`)})?.textContent === "red"`,
          { timeoutMs: 4000 },
        );
        await waitForChip(app, "1 of 3");
        // The field seeds from the deck-wide remembered replacement, and a
        // click collapses the seed's selection, so clear it with bare keys.
        await body.nativeClickAtElement(REPLACEMENT);
        // The click's focus grant lands a beat later; a key sent before it
        // would edit the query field instead.
        await body.waitForCondition<boolean>(caretIn(REPLACEMENT), { timeoutMs: 4000 });
        for (let i = 0; i < 16; i++) await app.nativeKey("Backspace");
        for (let i = 0; i < 16; i++) await app.nativeKey("Delete");
        await app.nativeType("blue");
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${REPLACEMENT} .cm-line`)})?.textContent === "blue"`,
          { timeoutMs: 4000 },
        );
        await body.click(`${BAR} [data-testid="find-replace-next"]`);
        await waitForComposer(app, "blue fish red fish red");
        await waitForChip(app, "1 of 2");
        await body.click(`${BAR} [data-testid="find-replace-all"]`);
        await waitForComposer(app, "blue fish blue fish blue");
        await waitForChip(app, "No results");

        // --- 3. Escape closes it and the caret goes home. ---
        await body.nativeClickAtElement(REPLACEMENT);
        await app.nativeKey("Escape");
        await body.waitForCondition<boolean>(`!(${exists(BAR)})`, { timeoutMs: 4000 });
        await body.waitForCondition<boolean>(caretIn(EDITOR), { timeoutMs: 4000 });

        // --- 4. ⌘F from the composer is still the transcript's. ---
        const find = await app.performMenuItem("edit.find");
        expect(find.found && find.performed, "Find… performs from the composer").toBe(true);
        await body.waitForCondition<boolean>(exists(TRANSCRIPT_BAR), { timeoutMs: 4000 });
        expect(await body.evalJS<boolean>(exists(BAR)), "⌘F does not open the composer's bar").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

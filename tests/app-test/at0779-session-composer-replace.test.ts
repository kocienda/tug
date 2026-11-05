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
 *   3. With the bar still open, typing another match into the composer
 *      moves the count with it: the engine watches the composer's view, so
 *      no find gesture is needed for the chip to catch up.
 *      Edit ▸ Find ▸ Find Next with the caret in the composer then steps
 *      the composer's bar, the search over the text the caret is in, and
 *      not the transcript's.
 *   4. Escape closes the bar and hands the caret back to the composer.
 *   5. Edit ▸ Find… from the composer still opens the transcript's bar.
 *
 * And, in a second launch, the composer's writability is read from its own
 * view: with the bar open, a permission dialog stands the composer down, and
 * the bar's replace row hides while Find and Replace… goes disabled; denying
 * the dialog gives both back. No host pushes that state into the bar or the
 * menu gate.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/composer-find-bar.tsx
 * @covers tugdeck/src/components/tugways/editor-find-engine.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/undo-menu-state-plugin.ts
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
const DIALOG = `${CARD} [data-slot="session-permission-dialog"]`;
const DENY = `${DIALOG} .tug-inline-dialog-actions .tug-button-outlined-danger`;
const FEED_CODE_OUTPUT = 0x40;

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

        // --- 3. The count follows typing in the composer. ---
        await body.nativeClickAtElement(EDITOR);
        await body.waitForCondition<boolean>(caretIn(EDITOR), { timeoutMs: 4000 });
        await app.nativeKey("End");
        await app.nativeType(" red");
        await waitForComposer(app, "blue fish blue fish blue red");
        await waitForChip(app, "1 of 1");
        await app.nativeType(" red");
        await waitForComposer(app, "blue fish blue fish blue red red");
        await waitForChip(app, "1 of 2");

        // ⌘G with the caret in the composer steps the composer's own bar,
        // the search over the text the caret is in, and not the transcript's.
        // From the end of the message the first press wraps to the first
        // match and the second lands on the last.
        for (let i = 0; i < 2; i++) {
          const stepped = await app.performMenuItem("edit.findNext");
          expect(stepped.found && stepped.performed, "Find Next performs from the composer").toBe(true);
          if (i === 0) await waitForChip(app, "1 of 2");
        }
        await waitForChip(app, "2 of 2");
        expect(await body.evalJS<boolean>(exists(TRANSCRIPT_BAR)), "the transcript's bar stays shut").toBe(false);

        // --- 4. Escape closes it and the caret goes home. ---
        await body.nativeClickAtElement(REPLACEMENT);
        await app.nativeKey("Escape");
        await body.waitForCondition<boolean>(`!(${exists(BAR)})`, { timeoutMs: 4000 });
        await body.waitForCondition<boolean>(caretIn(EDITOR), { timeoutMs: 4000 });

        // --- 5. ⌘F from the composer is still the transcript's. ---
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

describe.skipIf(!SHOULD_RUN)("AT0779: a stood-down composer offers no replace", () => {
  test(
    "a permission dialog hides the composer bar's replace row and disables ⌥⌘F; denying it restores both",
    async () => {
      const app = await launchTugApp({ testName: "at0779-session-composer-stood-down" });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        const body = app.body("A");
        await body.waitForCondition<boolean>(exists(EDITOR), { timeoutMs: 8000 });

        await body.nativeClickAtElement(EDITOR);
        await body.waitForCondition<boolean>(caretIn(EDITOR), { timeoutMs: 4000 });
        const opened = await app.performMenuItem("edit.findAndReplace");
        expect(opened.found && opened.enabled, "Find and Replace… is enabled while the composer is writable").toBe(true);
        await body.waitForCondition<boolean>(exists(REPLACEMENT), { timeoutMs: 4000 });

        // A live turn with a pending permission request: the inline dialog
        // stands the composer down, which makes its view read-only.
        await app.driveSession("A", { op: "send", text: "count lines with tokei" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: FEED_CODE_OUTPUT,
          decoded: {
            type: "assistant_text",
            status: "partial",
            tug_session_id: SID,
            msg_id: "at0779-msg-1",
            text: "Running tokei…",
            is_partial: true,
            rev: 0,
            seq: 0,
          },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: FEED_CODE_OUTPUT,
          decoded: {
            type: "control_request_forward",
            tug_session_id: SID,
            request_id: "at0779-perm-1",
            is_question: false,
            tool_name: "Bash",
            input: { command: "tokei" },
            permission_suggestions: [],
          },
        });
        await body.waitForCondition<boolean>(exists(DIALOG), { timeoutMs: 6000 });

        // The bar stays, and its replace row follows the composer's view.
        await body.waitForCondition<boolean>(`!(${exists(REPLACEMENT)})`, { timeoutMs: 4000 });
        expect(await body.evalJS<boolean>(exists(BAR)), "the bar itself stays open").toBe(true);
        const stoodDown = await app.performMenuItem("edit.findAndReplace");
        expect(stoodDown.found, "Find and Replace… is in the menu").toBe(true);
        expect(
          stoodDown.found && stoodDown.enabled,
          "Find and Replace… is disabled while the composer is read-only",
        ).toBe(false);

        // Deny: the composer takes edits again, and both come back.
        await body.click(DENY);
        await body.waitForCondition<boolean>(`!(${exists(DIALOG)})`, { timeoutMs: 6000 });
        await body.waitForCondition<boolean>(exists(REPLACEMENT), { timeoutMs: 4000 });
        await body.waitForCondition<boolean>(caretIn(EDITOR), { timeoutMs: 6000 });
        const restored = await app.performMenuItem("edit.findAndReplace");
        expect(restored.found && restored.enabled, "Find and Replace… is enabled again").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

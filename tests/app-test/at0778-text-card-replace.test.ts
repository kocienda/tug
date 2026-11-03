/**
 * at0778-text-card-replace.test.ts — find and replace in the Text card
 * ([AT0778]).
 *
 * ## Why this exists
 *
 * Replace is a capability of the shared find bar, carried by the shared CM6
 * engine: ⌥⌘F opens the Text card's bar with its replace row, Replace swaps
 * the active match and moves on, All swaps every match, and each gesture is
 * one transaction, so one ⌘Z undoes one gesture. A read-only file offers none
 * of it: the menu item validates false there, and the bar ⌘F opens has no
 * replace row.
 *
 * ## Test matrix (one launch, two cards over real temp files)
 *
 *   1. Edit ▸ Find ▸ Find and Replace… with the caret in the writable card's
 *      editor is enabled, performs, and opens the bar with the replace row.
 *   2. Replace swaps the first match and leaves the other two counted.
 *   3. All swaps the rest, and the chip reads "No results".
 *   4. One Edit ▸ Undo, back in the editor, undoes the whole of All and
 *      nothing before it.
 *   5. In the read-only card the item is disabled, and ⌘F's bar has no
 *      replace row.
 *
 * The menu items are performed through `performMenuItem`, so AppKit's
 * validation, the action and `sendControl` all run — the app's own path for
 * a menu command.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/editor-find-engine.ts
 * @covers tugdeck/src/components/tugways/tug-find-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-find-bar.css
 * @covers tugdeck/src/components/tugways/cards/text-card-find-bar.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/find-session.ts
 * @covers tugdeck/src/settings-api.ts
 * @covers tugapp/Sources/MenuBarBuilder.swift
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App, type BodyApp } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

let dir = "";
let writablePath = "";
let readOnlyPath = "";

const WRITABLE_BODY = [
  "alpha meridian one",
  "beta meridian two",
  "gamma meridian three",
].join("\n");
const READ_ONLY_BODY = "locked meridian text";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0778-"));
  writablePath = join(dir, "writable.txt");
  readOnlyPath = join(dir, "locked.txt");
  writeFileSync(writablePath, WRITABLE_BODY);
  writeFileSync(readOnlyPath, READ_ONLY_BODY);
  chmodSync(readOnlyPath, 0o444);
});

afterAll(() => {
  if (dir === "" || !existsSync(dir)) return;
  if (readOnlyPath !== "" && existsSync(readOnlyPath)) chmodSync(readOnlyPath, 0o644);
  rmSync(dir, { recursive: true, force: true });
});

function pane(id: string, cardId: string, x: number) {
  return {
    id,
    position: { x, y: 30 },
    size: { width: 560, height: 420 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
  };
}

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "text", title: "Writable", closable: true },
      { id: "B", componentId: "text", title: "Locked", closable: true },
    ],
    panes: [pane("p1", "A", 20), pane("p2", "B", 600)],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const editorOf = (card: string) =>
  `[data-card-id="${card}"] [data-slot="tug-text-card-editor"] .cm-content`;
const barOf = (card: string) =>
  `[data-card-id="${card}"] [data-slot="text-card-find-bar"]`;
const BAR_A = barOf("A");
const QUERY_A = `${BAR_A} [data-testid="text-card-find-input"] .cm-content`;
const REPLACEMENT_A = `${BAR_A} [data-testid="text-card-replace-input"] .cm-content`;
const CHIP_A = `${BAR_A} [data-slot="find-count"] [data-slot="find-count-value"]`;

async function waitForText(body: BodyApp, card: string, needle: string): Promise<void> {
  await body.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(editorOf(card))});
      return el !== null && el.innerText.indexOf(${JSON.stringify(needle)}) !== -1;
    })()`,
    { timeoutMs: 15_000 },
  );
}

/** The writable card's document, line by line, as the editor shows it. */
async function linesOf(body: BodyApp): Promise<string[]> {
  return JSON.parse(
    await body.evalJS<string>(
      `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
        `${editorOf("A")} .cm-line`,
      )})).map(function(l){ return l.textContent; }))`,
    ),
  ) as string[];
}

async function waitForLines(body: BodyApp, expected: string[]): Promise<void> {
  try {
    await body.waitForCondition<boolean>(
      `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
        `${editorOf("A")} .cm-line`,
      )})).map(function(l){ return l.textContent; })) === ${JSON.stringify(
        JSON.stringify(expected),
      )}`,
      { timeoutMs: 6000 },
    );
  } catch {
    // A timeout says which document it was waiting for and which it found,
    // so a red names its stage without a second run.
    throw new Error(
      `document never read ${JSON.stringify(expected)}; it reads ${JSON.stringify(await linesOf(body))}`,
    );
  }
}

async function waitForChip(body: BodyApp, expected: string): Promise<void> {
  await body.waitForCondition<boolean>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(CHIP_A)});
      return el !== null && (el.textContent || '').trim() === ${JSON.stringify(expected)};
    })()`,
    { timeoutMs: 6000 },
  );
}

/** Keystrokes `typeReplacement` clears with — past any remembered replacement. */
const REPLACEMENT_CLEAR_KEYSTROKES = 16;

/**
 * Type `text` into the replacement field as its whole content. The field seeds
 * from the deck-wide remembered replacement, and a click collapses that seed's
 * selection, so it is cleared with bare Backspaces and Deletes first.
 */
async function typeReplacement(app: App, body: BodyApp, text: string): Promise<void> {
  await body.nativeClickAtElement(REPLACEMENT_A);
  // The click's focus grant lands a beat later; a key sent before it would
  // edit the query field instead.
  await body.waitForCondition<boolean>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(REPLACEMENT_A)});
      return el !== null && document.activeElement !== null && el.contains(document.activeElement);
    })()`,
    { timeoutMs: 4000 },
  );
  for (let i = 0; i < REPLACEMENT_CLEAR_KEYSTROKES; i++) await app.nativeKey("Backspace");
  for (let i = 0; i < REPLACEMENT_CLEAR_KEYSTROKES; i++) await app.nativeKey("Delete");
  await app.nativeType(text);
  await body.waitForCondition<boolean>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(`${REPLACEMENT_A} .cm-line`)});
      return el !== null && el.textContent === ${JSON.stringify(text)};
    })()`,
    { timeoutMs: 4000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0778: find and replace in the Text card", () => {
  test(
    "⌥⌘F opens the replace row; Replace, All and one Undo; a read-only file offers none of it",
    async () => {
      const app: App = await launchTugApp({ testName: "at0778-text-card-replace" });
      try {
        await app.seedDeckState({
          state: deckShape(),
          cardStates: {
            A: { content: { path: writablePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            B: { content: { path: readOnlyPath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
          },
          focusCardId: "A",
        });
        const a = await waitForBodyReady(app, "A");
        const b = await waitForBodyReady(app, "B");
        await waitForText(a, "A", "alpha meridian");
        await waitForText(b, "B", "locked meridian");

        // --- 1. The menu item opens the bar with its replace row. ---
        await a.nativeClickAtElement(editorOf("A"));
        const opened = await app.performMenuItem("edit.findAndReplace");
        expect(opened.found && opened.enabled, "Find and Replace… is enabled in a writable file").toBe(true);
        expect(opened.found && opened.performed, "Find and Replace… performs").toBe(true);
        await a.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(REPLACEMENT_A)}) !== null`,
          { timeoutMs: 4000 },
        );
        // The bar takes the caret into its query field on mount.
        await a.waitForCondition<boolean>(
          `(() => {
            const q = document.querySelector(${JSON.stringify(QUERY_A)});
            return q !== null && document.activeElement !== null && q.contains(document.activeElement);
          })()`,
          { timeoutMs: 4000 },
        );
        await app.nativeType("meridian");
        // The whole query first: the count already reads 3 at "me", and a
        // key still in flight would land in whatever field is clicked next.
        await a.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${QUERY_A} .cm-line`)})?.textContent === "meridian"`,
          { timeoutMs: 4000 },
        );
        await waitForChip(a, "1 of 3");

        // --- 2. Replace swaps the active match and moves on. ---
        await typeReplacement(app, a, "pole");
        await a.click(`${BAR_A} [data-testid="find-replace-next"]`);
        await waitForLines(a, ["alpha pole one", "beta meridian two", "gamma meridian three"]);
        await waitForChip(a, "1 of 2");

        // --- 3. All swaps the rest. ---
        await a.click(`${BAR_A} [data-testid="find-replace-all"]`);
        await waitForLines(a, ["alpha pole one", "beta pole two", "gamma pole three"]);
        await waitForChip(a, "No results");

        // --- 4. One Undo undoes the whole of All, and only All. ---
        await a.nativeClickAtElement(REPLACEMENT_A);
        await app.nativeKey("Escape");
        await a.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BAR_A)}) === null`,
          { timeoutMs: 4000 },
        );
        await a.nativeClickAtElement(editorOf("A"));
        const undone = await app.performMenuItem("edit.undo");
        expect(undone.found && undone.performed, "Undo performs").toBe(true);
        await waitForLines(a, ["alpha pole one", "beta meridian two", "gamma meridian three"]);
        expect(await linesOf(a)).toEqual([
          "alpha pole one",
          "beta meridian two",
          "gamma meridian three",
        ]);

        // --- 5. A read-only file offers no replace. ---
        await b.nativeClickAtElement(editorOf("B"));
        const refused = await app.performMenuItem("edit.findAndReplace");
        expect(refused.found, "the item exists").toBe(true);
        expect(refused.found && refused.enabled, "Find and Replace… is disabled in a read-only file").toBe(false);
        const find = await app.performMenuItem("edit.find");
        expect(find.found && find.performed, "Find… performs in a read-only file").toBe(true);
        await b.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(barOf("B"))}) !== null`,
          { timeoutMs: 4000 },
        );
        expect(
          await b.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(
              `${barOf("B")} [data-testid="text-card-replace-input"]`,
            )}) === null`,
          ),
          "the read-only card's bar has no replace row",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

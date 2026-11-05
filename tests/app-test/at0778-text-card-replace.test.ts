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
 *      editor is enabled, performs, and opens the bar with the replace row;
 *      Tab moves the caret between the query and the replacement field
 *      without writing a tab.
 *   2. Replace swaps the first match and leaves the other two counted. With
 *      the caret back in the editor, Edit ▸ Find ▸ Find Next steps through
 *      the shared engine — its trace gesture and landing ring — and Edit ▸
 *      Find ▸ Replace swaps one more, the card answering for its bar.
 *   3. Edit ▸ Find ▸ Replace All swaps the rest, and the chip reads "No
 *      results". Both buttons are then disabled, and Return in the
 *      replacement field is refused visibly: the chip takes its refusal
 *      mark. Edit ▸ Find ▸ Replace stays enabled — its gate is the bar, not
 *      the match — and its press is refused the same way.
 *   4. One Edit ▸ Undo, back in the editor, undoes the whole of Replace All
 *      and nothing before it.
 *   5. In the read-only card Find and Replace… is disabled, ⌘F's bar has no
 *      replace row, and Replace and Replace All are disabled over it.
 *   6. A query of `\n` in that bar matches the two characters, never the
 *      file's newlines: the query is literal, as in the transcript and Help.
 *   7. Tab in that bar, which has no replace row, engages the focus cycle
 *      and steps to the options; ⇧Tab steps back off them.
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
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/lib/find-session.ts
 * @covers tugdeck/src/components/tugways/tug-find-cluster.tsx
 * @covers tugdeck/src/components/tugways/tug-find-cluster.css
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
import { awaitGesture, markTrace } from "./find-probes";

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
// A literal backslash-n on the second line, between two real newlines, so a
// `\n` query that meant newline would count two and a literal one counts one.
const READ_ONLY_BODY = ["locked meridian text", "C:\\new", "end"].join("\n");

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

/**
 * Wait until exactly `n` of the writable card's lines still read "meridian".
 * Used where which match a step replaced depends on where a click put the
 * caret, and only how many are left is the claim.
 */
async function waitForMeridians(body: BodyApp, n: number): Promise<void> {
  try {
    await body.waitForCondition<boolean>(
      `Array.from(document.querySelectorAll(${JSON.stringify(
        `${editorOf("A")} .cm-line`,
      )})).filter(function(l){ return (l.textContent || '').indexOf('meridian') !== -1; }).length === ${n}`,
      { timeoutMs: 6000 },
    );
  } catch {
    throw new Error(
      `document never held ${n} "meridian" lines; it reads ${JSON.stringify(await linesOf(body))}`,
    );
  }
}

/** The count chip's refusal mark: absent, or the refusal counter's parity. */
async function refusalOf(body: BodyApp): Promise<string | null> {
  return body.evalJS<string | null>(
    `document.querySelector(${JSON.stringify(`${BAR_A} [data-slot="find-count"]`)})?.getAttribute("data-refused") ?? null`,
  );
}

/**
 * Poll a menu item's validated state until its enabled bit reads `want`, and
 * return the last reading — the gate as AppKit would present it.
 */
async function waitMenuEnabled(
  app: App,
  identifier: string,
  want: boolean,
): Promise<{ found: boolean; enabled?: boolean }> {
  const deadline = Date.now() + 4000;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === want) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
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

        // Tab moves the caret from the query to the replacement field and
        // back, and writes no tab into either field on its way.
        await app.nativeKey("Tab");
        await a.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(REPLACEMENT_A)});
            return el !== null && document.activeElement !== null && el.contains(document.activeElement);
          })()`,
          { timeoutMs: 4000 },
        );
        await app.nativeKey("Tab");
        await a.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(QUERY_A)});
            return el !== null && document.activeElement !== null && el.contains(document.activeElement);
          })()`,
          { timeoutMs: 4000 },
        );
        expect(
          await a.evalJS<string>(
            `document.querySelector(${JSON.stringify(`${QUERY_A} .cm-line`)})?.textContent ?? ""`,
          ),
          "Tab wrote nothing into the query",
        ).toBe("meridian");

        // --- 2. Replace swaps the active match and moves on. ---
        await typeReplacement(app, a, "pole");
        await a.click(`${BAR_A} [data-testid="find-replace-next"]`);
        await waitForLines(a, ["alpha pole one", "beta meridian two", "gamma meridian three"]);
        await waitForChip(a, "1 of 2");

        // The caret back in the editor, outside the bar. ⌘G from there steps
        // through the shared engine, as a step from the bar does: the trace
        // records the gesture and the landing ring is drawn. The ring lives
        // for well under a second, so an observer installed before the press
        // is what sees it.
        await a.nativeClickAtElement(editorOf("A"));
        await a.evalJS<boolean>(
          `(function () {
            window.__at0778Ring = false;
            new MutationObserver(function (records) {
              for (var r of records) for (var n of r.addedNodes) {
                if (n.classList && n.classList.contains("tugx-find-flash-overlay")) window.__at0778Ring = true;
              }
            }).observe(document.body, { childList: true, subtree: true });
            return true;
          })()`,
        );
        const stepMark = await markTrace(a);
        const stepped = await app.performMenuItem("edit.findNext");
        expect(stepped.found && stepped.performed, "Find Next performs from the editor").toBe(true);
        await awaitGesture(a, stepMark, "meridian");
        await a.waitForCondition<boolean>("window.__at0778Ring === true", { timeoutMs: 4000 });

        // The card answers Replace for the bar it owns. Which match goes
        // depends on where the click put the caret, so the claim is how many
        // are left.
        const replaced = await app.performMenuItem("edit.replaceNext");
        expect(replaced.found && replaced.enabled, "Replace is enabled with the bar open").toBe(true);
        expect(replaced.found && replaced.performed, "Replace performs").toBe(true);
        await waitForMeridians(a, 1);
        await waitForChip(a, "1 of 1");

        // --- 3. Replace All swaps the rest. ---
        const replacedAll = await app.performMenuItem("edit.replaceAll");
        expect(replacedAll.found && replacedAll.enabled, "Replace All is enabled with the bar open").toBe(true);
        expect(replacedAll.found && replacedAll.performed, "Replace All performs").toBe(true);
        await waitForLines(a, ["alpha pole one", "beta pole two", "gamma pole three"]);
        await waitForChip(a, "No results");

        // --- 3b. Nothing left to replace: both disabled, a press refused visibly. ---
        expect(
          await a.evalJS<string>(
            `JSON.stringify(["find-replace-next", "find-replace-all"].map(function(id){
              var el = document.querySelector(${JSON.stringify(BAR_A)} + ' [data-testid="' + id + '"]');
              return el === null ? null : el.disabled;
            }))`,
          ),
          "Replace and All are disabled at zero matches",
        ).toBe(JSON.stringify([true, true]));
        // Return in the replacement field is Replace's keyboard press, and it
        // still arrives: the chip takes the refusal mark and the text stays.
        await a.nativeClickAtElement(REPLACEMENT_A);
        await a.waitForCondition<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(REPLACEMENT_A)});
            return el !== null && document.activeElement !== null && el.contains(document.activeElement);
          })()`,
          { timeoutMs: 4000 },
        );
        await app.nativeKey("Enter");
        await a.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${BAR_A} [data-slot="find-count"]`)})?.hasAttribute("data-refused") === true`,
          { timeoutMs: 4000 },
        );
        expect(await linesOf(a)).toEqual(["alpha pole one", "beta pole two", "gamma pole three"]);
        // The menu item's gate is the bar, not the match, so it stays enabled,
        // and its press is refused the same way: the mark plays again.
        const firstMark = await refusalOf(a);
        const refusedPress = await app.performMenuItem("edit.replaceNext");
        expect(refusedPress.found && refusedPress.enabled, "Replace stays enabled at zero matches").toBe(true);
        expect(refusedPress.found && refusedPress.performed, "and its press arrives").toBe(true);
        await a.waitForCondition<boolean>(
          `(() => {
            const v = document.querySelector(${JSON.stringify(`${BAR_A} [data-slot="find-count"]`)})?.getAttribute("data-refused") ?? null;
            return v !== null && v !== ${JSON.stringify(firstMark)};
          })()`,
          { timeoutMs: 4000 },
        );
        expect(await linesOf(a)).toEqual(["alpha pole one", "beta pole two", "gamma pole three"]);

        // --- 4. One Undo undoes the whole of Replace All, and only it. ---
        await a.nativeClickAtElement(REPLACEMENT_A);
        await app.nativeKey("Escape");
        await a.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BAR_A)}) === null`,
          { timeoutMs: 4000 },
        );
        await a.nativeClickAtElement(editorOf("A"));
        const undone = await app.performMenuItem("edit.undo");
        expect(undone.found && undone.performed, "Undo performs").toBe(true);
        await waitForMeridians(a, 1);
        expect(
          (await linesOf(a)).filter((l) => l.includes("pole")).length,
          "the two single replaces stand",
        ).toBe(2);

        // --- 5. A read-only file offers no replace. ---
        await b.nativeClickAtElement(editorOf("B"));
        // The host merges each body's gates under the card the shell holds
        // key, and that hand-over trails the click: a gate read before it
        // answers for A's writable file. So the gate is waited on to settle.
        expect(
          (await waitMenuEnabled(app, "edit.findAndReplace", false)).enabled,
          "Find and Replace… settles disabled over the read-only file",
        ).toBe(false);
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
        for (const id of ["edit.replaceNext", "edit.replaceAll"]) {
          const item = await waitMenuEnabled(app, id, false);
          expect(item.found, `${id} exists`).toBe(true);
          expect(item.enabled, `${id} is disabled over a bar with no replace row`).toBe(false);
        }

        // --- 6. A backslash in the query is the character itself. ---
        const queryB = `${barOf("B")} [data-testid="text-card-find-input"] .cm-content`;
        const chipB = `${barOf("B")} [data-slot="find-count"] [data-slot="find-count-value"]`;
        await b.waitForCondition<boolean>(
          `(() => {
            const q = document.querySelector(${JSON.stringify(queryB)});
            return q !== null && document.activeElement !== null && q.contains(document.activeElement);
          })()`,
          { timeoutMs: 4000 },
        );
        await app.nativeType("\\n");
        await b.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${queryB} .cm-line`)})?.textContent === "\\\\n"`,
          { timeoutMs: 4000 },
        );
        await b.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(chipB)})?.textContent || '').trim() === "1 of 1"`,
          { timeoutMs: 4000 },
        );

        // --- 7. Tab in a bar with no replace row is never dead. ---
        // It engages the focus cycle at the query's stop and steps to the
        // options group, writing nothing into the query; ⇧Tab steps back.
        const optionsB = `${barOf("B")} [data-slot="find-cluster"]`;
        await app.nativeKey("Tab");
        await b.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${optionsB} [data-key-view]`)}) !== null ||
            (document.activeElement !== null && document.querySelector(${JSON.stringify(optionsB)})?.contains(document.activeElement) === true)`,
          { timeoutMs: 4000 },
        );
        expect(
          await b.evalJS<string>(
            `document.querySelector(${JSON.stringify(`${queryB} .cm-line`)})?.textContent ?? ""`,
          ),
          "Tab wrote nothing into the query",
        ).toBe("\\n");
        await app.nativeKey("Tab", ["shift"]);
        await b.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${optionsB} [data-key-view]`)}) === null &&
            !(document.activeElement !== null && document.querySelector(${JSON.stringify(optionsB)})?.contains(document.activeElement) === true)`,
          { timeoutMs: 4000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

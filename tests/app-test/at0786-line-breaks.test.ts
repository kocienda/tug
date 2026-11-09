/**
 * at0786-line-breaks.test.ts — Text ▸ Add Line Breaks and Remove Line Breaks
 * on the CM6 editor substrate.
 *
 * Add Line Breaks turns the editor's soft wraps into real newlines at the
 * points where the view wraps them now. Where it wraps is layout, which a
 * unit test over an `EditorState` cannot see — the transform itself is
 * unit-tested over given break points (`editor-line-breaks.test.ts`), and
 * this file holds the half only the running app has: that the break points
 * read off the live view are the ones the user sees. So the claims are:
 *
 *   - **What is seen becomes what is stored.** A typed line long enough to
 *     wrap in a narrow pane becomes several lines, each of which then fits
 *     on one visual row, and joined with spaces they are the line typed.
 *   - **Remove Line Breaks puts the paragraph back.** A bare caret widens to
 *     its paragraph, and the lines join with one space each.
 *   - **Each is one transaction.** One undo takes Remove back whole.
 *
 * Driven through `dispatchControlAction` — the same wire `AppDelegate`'s
 * `performAddLineBreaks` sends — so the test needs no key window.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/editor-line-breaks.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App, type BodyApp } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const EDITOR = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

const TYPED =
  "the quick brown fox jumps over the lazy dog and keeps on running past the barn and into the field beyond the hill";

/** One narrow pane holding the gallery text editor, so a long line wraps. */
function deck() {
  return {
    cards: [{ id: "A", componentId: "gallery-text-editor", title: "Card A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 380, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function seed(app: App): Promise<BodyApp> {
  await app.seedDeckState({ state: deck(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  return waitForBodyReady(app, "A");
}

interface Row {
  text: string;
  rows: number;
}

/** Each document line's text, and how many visual rows it takes. */
const READ_LINES = `(function(){
  var lines = document.querySelectorAll(${JSON.stringify(`${EDITOR} .cm-line`)});
  return Array.prototype.map.call(lines, function (line) {
    var range = document.createRange();
    range.selectNodeContents(line);
    var tops = {};
    Array.prototype.forEach.call(range.getClientRects(), function (r) {
      if (r.width > 0) tops[Math.round(r.top)] = true;
    });
    return { text: line.textContent, rows: Object.keys(tops).length };
  });
})()`;

/** Poll the editor's lines until `done` holds, and return the last reading. */
async function settleLines(page: BodyApp, done: (rows: Row[]) => boolean, timeoutMs = 4000): Promise<Row[]> {
  const deadline = Date.now() + timeoutMs;
  let last: Row[] = [];
  while (Date.now() < deadline) {
    last = await page.evalJS<Row[]>(READ_LINES);
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe.skipIf(!SHOULD_RUN)("AT0786: Add Line Breaks / Remove Line Breaks", () => {
  test(
    "soft wraps become real newlines, and Remove joins them back in one undoable step",
    async () => {
      const app = await launchTugApp({ testName: "at0786" });
      try {
        const body = await seed(app);
        await app.awaitEngineReady("A");
        await body.nativeClickAtElement(EDITOR);
        await body.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(EDITOR)})`,
          { timeoutMs: 2000 },
        );

        await app.nativeType(TYPED);
        const typed = await settleLines(body, (r) => r.length === 1 && r[0].text === TYPED);
        expect(typed.map((r) => r.text), "one document line holds the typed text").toEqual([TYPED]);
        expect(typed[0].rows, "and the pane is narrow enough that it wraps").toBeGreaterThan(1);
        const wrappedRows = typed[0].rows;

        // The caret sits on the typed line, so Add acts on that line.
        await app.dispatchControlAction("add-line-breaks");
        const broken = await settleLines(body, (r) => r.length > 1);
        expect(broken.length, "one document line per visual row the wrap made").toBe(wrappedRows);
        expect(broken.every((r) => r.rows === 1), `every line now fits on one row: ${JSON.stringify(broken)}`).toBe(true);
        expect(broken.map((r) => r.text).join(" "), "and joined with spaces they are the typed line").toBe(TYPED);

        // The caret is still in the paragraph, so Remove widens to all of it.
        await app.dispatchControlAction("remove-line-breaks");
        const joined = await settleLines(body, (r) => r.length === 1);
        expect(joined.map((r) => r.text), "Remove joins the paragraph back").toEqual([TYPED]);

        // One transaction: one undo restores every line Remove joined.
        await app.dispatchControlAction("undo");
        const undone = await settleLines(body, (r) => r.length === wrappedRows);
        expect(undone.map((r) => r.text), "one undo takes Remove back whole").toEqual(broken.map((r) => r.text));
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0786] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

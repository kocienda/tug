/**
 * at0388-press-collapses-selection.test.ts — pressing inside a
 * selection collapses it on the way DOWN, not on the way up.
 *
 * ## Why this exists
 *
 * WebKit and CM6 both defer collapsing a selection when the press
 * lands inside it, so that press can begin a drag of the selected
 * text. The cost is a wash: the range stays painted for as long as
 * the button is held, and after a Select All "inside the selection"
 * is everywhere — so an ordinary click anywhere in an editor lit the
 * WHOLE document until release. Reported as a flash; it is the
 * deferral, made maximally visible by ⌘A.
 *
 * The test reproduces that mechanism: select a line, then press
 * inside the selection and read what is selected WHILE THE BUTTON IS
 * STILL DOWN — the release is what used to hide the bug. The read is
 * `window.getSelection().toString()`: what the user has actually got
 * selected and therefore what is painted, not an internal range the
 * surface reports about itself.
 *
 * The line is selected by pressing its gutter number (at0386's
 * gesture) rather than by ⌘A or a sweep across the text: the
 * deferral is the same whatever made the range, and the gutter press
 * is a selection primitive that stands up in a headless run without
 * the responder chain or CM6's own drag-select. ⌘A is merely the
 * case that makes the wash span the whole document.
 *
 * The pre-assertion — the line really is selected before the press —
 * keeps the post-assertion from passing vacuously.
 *
 * @covers tugdeck/src/components/tugways/press-collapses-selection.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-card-editor"]`;
const CONTENT = `${EDITOR} .cm-content`;
const GUTTER_CELLS = `${EDITOR} .cm-lineNumbers .cm-gutterElement`;

/** Six lines, each its own word, so a selection names itself. */
const LINES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
const FIXTURE = `${LINES.join("\n")}\n`;

/** The line the gesture happens on (1-based), and its text. */
const TARGET_LINE = 3;
const TARGET_TEXT = LINES[TARGET_LINE - 1] as string;

function mkFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0388-"));
  const file = path.join(dir, "lines.txt");
  fs.writeFileSync(file, FIXTURE, "utf8");
  return { dir, file };
}

async function seedTextCard(app: App, filePath: string): Promise<void> {
  // The gutter makes the selection, so it has to be on before the card mounts.
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","settings",` +
      `{kind:"json",value:{lineNumbers:true,lineWrap:false,softTabs:true,tabSize:4,` +
      `foldGutter:false,highlightActiveLine:true,showSpaces:false,showTabs:false}}), null)`,
  );
  await app.seedDeckState({
    state: {
      cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 620, height: 560 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    },
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
}

/**
 * The center of the gutter cell labelled `n`, in viewport coordinates.
 * Found by the number it renders rather than by index: the gutter's first
 * `.cm-gutterElement` is CM6's width spacer, not line 1.
 */
function gutterCellCenterExpr(n: number): string {
  return `(function(){
    var cells = document.querySelectorAll(${JSON.stringify(GUTTER_CELLS)});
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].textContent.trim() !== ${JSON.stringify(String(n))}) continue;
      var r = cells[i].getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  })()`;
}

/**
 * The center of the standing selection's own first client rect.
 *
 * Taken from the selection rather than from the line box on purpose:
 * "inside the selection" is what decides whether the press is deferred,
 * and WebKit answers that question with these exact rectangles. A point
 * picked off the `.cm-line` instead can land in the hanging-indent
 * padding — left of the first glyph, outside every selection rect —
 * where the press is NOT deferred and the test would pass without ever
 * reaching the behavior it means to pin.
 */
const SELECTION_POINT = `(function(){
  var sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return null;
  var rects = sel.getRangeAt(0).getClientRects();
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i];
    if (r.width < 4 || r.height < 4) continue;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return null;
})()`;

/** What the user has selected, with the trailing line break normalized off. */
const SELECTED_TEXT = `(function(){
  var sel = window.getSelection();
  return sel === null ? null : sel.toString().replace(/\\n$/, "");
})()`;

describe.skipIf(!SHOULD_RUN)(
  "at0388: a press inside a selection collapses it immediately",
  () => {
    test(
      "nothing stays selected while the button is held down",
      async () => {
        const { dir, file } = mkFixture();
        const app = await launchTugApp({
          testName: "at0388-press-collapses-selection",
        });
        try {
          await seedTextCard(app, file);

          // The file is in the buffer and the gutter has rendered its numbers.
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(CONTENT)});
              if (!el || el.innerText.indexOf(${JSON.stringify(LINES[5])}) === -1) return false;
              return document.querySelectorAll(${JSON.stringify(GUTTER_CELLS)}).length > 6;
            })()`,
            { timeoutMs: 20000 },
          );

          // A standing selection: the gutter press selects the whole line.
          const cell = await app.evalJS<{ x: number; y: number } | null>(
            gutterCellCenterExpr(TARGET_LINE),
          );
          expect(cell).not.toBeNull();
          await app.nativeClick(cell as { x: number; y: number });
          await app.waitForCondition<boolean>(
            `${SELECTED_TEXT} === ${JSON.stringify(TARGET_TEXT)}`,
            { timeoutMs: 6000 },
          );

          // Press inside that selection and HOLD.
          const inside = await app.evalJS<{ x: number; y: number } | null>(
            SELECTION_POINT,
          );
          expect(inside).not.toBeNull();
          const point = inside as { x: number; y: number };
          await app.nativeMouseDown(point);
          try {
            await app.waitForCondition<boolean>(
              `${SELECTED_TEXT} === ""`,
              { timeoutMs: 6000 },
            );
            const held = await app.evalJS<string | null>(SELECTED_TEXT);
            note("at0388 selection while held", JSON.stringify(held));
            expect(held).toBe("");
          } finally {
            await app.nativeMouseUp(point);
          }

          // And the release leaves a live caret rather than a dead editor:
          // the press placed one, and it is still collapsed.
          await app.waitForCondition<boolean>(`${SELECTED_TEXT} === ""`, {
            timeoutMs: 6000,
          });
          const after = await app.evalJS<string | null>(SELECTED_TEXT);
          note("at0388 selection after release", JSON.stringify(after));
          expect(after).toBe("");
        } finally {
          await app.close();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

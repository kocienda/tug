/**
 * at0828-text-card-markdown-preview.test.ts — the Text card's Markdown
 * preview ([AT0828]): the status strip's Preview toggle lays a rendered,
 * read-only view of the buffer over the editor, and takes it off again with
 * the editor exactly as it was left.
 *
 * Scenario: seed a Text card on a real Markdown file, put a caret in the
 * editor, type (so the buffer differs from the file) and select a few
 * characters. Press the Preview toggle with a real click. The toggle reads
 * pressed, the rendered heading is on screen and carries the unsaved edit,
 * the editor is still mounted beneath it but inert, the caret cell is hidden
 * while the counts stay, and the line-ending popup is disabled. An insert
 * aimed at the editor changes neither the buffer nor the preview. Press
 * ⌥⌘P: the preview is gone, the editor has its text and its selection.
 * Choose View ▸ Show Markdown Preview, which puts the preview up and reads
 * checked, and choose it again: the row is unchecked, the selection is still
 * there, and typing replaces it, which is the keyboard being back in the
 * editor.
 *
 * A second Text card beside it holds a plain-text file. Its strip has no
 * Preview toggle, and once it is the key card the View row is dark.
 *
 * The buffer is read through `textContent`: a covered editor is
 * `visibility: hidden`, which `innerText` skips. The refused insert goes
 * through the page's own input pipeline rather than real keys: in preview no
 * view takes a printable key, AppKit answers such a key with a beep, and a
 * beep is what the harness's silence contract counts.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-status-bar.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.css
 * @covers tugdeck/src/components/tugways/tug-push-button.tsx
 * @covers tugdeck/src/components/tugways/tug-push-button.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugapp/Sources/MenuStateSync.swift
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import { AUTOMATIC_SAVE_MODE, mkSeededTugbank } from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const PLAIN_CARD = '[data-card-id="B"]';
const EDITOR = `${CARD} [data-slot="tug-text-card-editor"]`;
const EDITOR_CONTENT = `${EDITOR} .cm-content`;
const PREVIEW = `${CARD} [data-testid="text-card-preview"]`;
const TOGGLE = `${CARD} [data-testid="text-card-status-preview"]`;
const STATUS_BAR = `${CARD} [data-slot="text-card-status-bar"]`;
const CARET_CELL = `${CARD} [data-testid="text-card-status-caret"]`;
const COUNTS_CELL = `${CARD} [data-testid="text-card-status-counts"]`;

const FIXTURE_CONTENT = "# Preview Heading\n\nSome *emphasis* here.\n\nlast line words";
const PLAIN_CONTENT = "plain text, nothing to render";

const MENU_ROW = "view.markdownPreview";

/** Poll the View row until its check mark reads `checked`; the last reading. */
async function waitMenuChecked(
  app: App,
  checked: boolean,
): Promise<{ found: boolean; enabled?: boolean; state?: number; keyEquivalent?: string }> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const last = await app.menuItemState(MENU_ROW);
    if (last.found && last.enabled && (last.state === 1) === checked) return last;
    if (Date.now() >= deadline) return last;
    await Bun.sleep(100);
  }
}

/** The editor's buffer as the DOM holds it, visible or covered. */
const BUFFER_TEXT = `(document.querySelector(${JSON.stringify(EDITOR_CONTENT)})?.textContent ?? "")`;

/** Whether the strip's line-ending popup refuses a press. */
const LINE_ENDING_DISABLED = `(() => {
  const buttons = Array.from(document.querySelectorAll(${JSON.stringify(`${STATUS_BAR} button`)}));
  const popup = buttons.find((b) => (b.textContent ?? "").includes("Unix (LF)"));
  return popup === undefined ? null : popup.disabled === true;
})()`;

async function seedTextCards(app: App, filePath: string, plainPath: string): Promise<void> {
  await app.seedDeckState({
    state: {
      cards: [
        { id: "A", componentId: "text", title: "File", closable: true },
        { id: "B", componentId: "text", title: "Plain", closable: true },
      ],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 540, height: 560 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["standard"],
        },
        {
          id: "p2",
          position: { x: 600, y: 40 },
          size: { width: 360, height: 400 },
          cardIds: ["B"],
          activeCardId: "B",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    },
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
      B: { content: { path: plainPath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
}

async function pressed(app: App): Promise<string | null> {
  return app
    .body("A")
    .evalJS<string | null>(
      `document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute("aria-pressed") ?? null`,
    );
}

describe.skipIf(!SHOULD_RUN)("at0828: Text card Markdown preview", () => {
  test(
    "the Preview toggle lays a read-only rendering over the editor and takes it off intact",
    async () => {
      const { file } = mkTextFixture("at0828-", FIXTURE_CONTENT, { name: "notes.md" });
      const plain = mkTextFixture("at0828-plain-", PLAIN_CONTENT, { name: "plain.txt" });
      const app = await launchTugApp({
        testName: "at0828-text-card-markdown-preview",
        env: { TUGBANK_PATH: mkSeededTugbank([AUTOMATIC_SAVE_MODE]) },
      });
      try {
        await seedTextCards(app, file, plain.file);
        const body = app.body("A");

        await body.waitForCondition<boolean>(
          `${BUFFER_TEXT}.includes("Preview Heading")`,
          { timeoutMs: 15000 },
        );

        // A Markdown file's strip offers the toggle, off.
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TOGGLE)}) !== null`,
          { timeoutMs: 5000 },
        );
        expect(await pressed(app), "the toggle starts off").toBe("false");
        const rowOff = await waitMenuChecked(app, false);
        expect(rowOff, "View ▸ Show Markdown Preview is lit and unchecked over a Markdown file").toMatchObject({
          found: true,
          enabled: true,
          state: 0,
          keyEquivalent: "p",
        });

        // Edit the buffer and leave a selection behind. The click lands on
        // the editor's open space, which puts the caret at the document's
        // end.
        await body.nativeClickAtElement(EDITOR_CONTENT);
        await app.nativeType(" unsaved");
        await body.waitForCondition<boolean>(
          `${BUFFER_TEXT}.includes("words unsaved")`,
          { timeoutMs: 5000 },
        );
        for (let i = 0; i < 7; i++) await app.nativeKey("ArrowLeft", ["shift"]);
        await body.waitForCondition<boolean>(
          `document.getSelection().toString() === "unsaved"`,
          { timeoutMs: 5000 },
        );
        const bufferBefore = await body.evalJS<string>(BUFFER_TEXT);

        // --- Into preview. ---
        await body.nativeClickAtElement(TOGGLE);
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${PREVIEW} h1`)}) !== null`,
          { timeoutMs: 5000 },
        );
        expect(await pressed(app), "the toggle reads pressed").toBe("true");
        expect(
          (await waitMenuChecked(app, true)).state,
          "the View row reads checked while the preview is up",
        ).toBe(1);
        expect(
          await body.evalJS<string>(
            `document.querySelector(${JSON.stringify(`${PREVIEW} h1`)}).textContent`,
          ),
          "the heading is rendered, not shown as source",
        ).toBe("Preview Heading");
        const previewText = await body.evalJS<string>(
          `document.querySelector(${JSON.stringify(PREVIEW)}).textContent`,
        );
        expect(previewText, "the preview renders the buffer, unsaved edit included").toContain(
          "last line words unsaved",
        );
        expect(previewText, "emphasis is rendered, its markers gone").not.toContain("*emphasis*");

        // The editor is still mounted, covered and out of the keyboard's reach.
        expect(
          await body.evalJS<boolean>(
            `(() => {
              const el = document.querySelector(${JSON.stringify(EDITOR)});
              return el !== null && el.inert === true &&
                getComputedStyle(el).visibility === "hidden";
            })()`,
          ),
          "the editor stays mounted, inert and hidden, under the preview",
        ).toBe(true);

        // The strip: no caret, counts still there, line ending refused.
        expect(
          await body.evalJS<string>(
            `getComputedStyle(document.querySelector(${JSON.stringify(CARET_CELL)})).visibility`,
          ),
          "the caret cell is hidden in preview",
        ).toBe("hidden");
        expect(
          await body.evalJS<string>(
            `getComputedStyle(document.querySelector(${JSON.stringify(COUNTS_CELL)})).visibility`,
          ),
          "the counts stay",
        ).toBe("visible");
        expect(
          await body.evalJS<boolean | null>(LINE_ENDING_DISABLED),
          "the line-ending popup is disabled in preview",
        ).toBe(true);

        // An insert aimed straight at the editor, through the same input
        // pipeline typing takes, changes nothing: not the buffer, not the
        // preview.
        await body.evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
            if (!el) return false;
            el.focus();
            return document.execCommand("insertText", false, "zzz");
          })()`,
        );
        expect(await body.evalJS<string>(BUFFER_TEXT), "typing in preview edits nothing").toBe(
          bufferBefore,
        );
        expect(
          await body.evalJS<string>(
            `document.querySelector(${JSON.stringify(PREVIEW)}).textContent`,
          ),
          "typing in preview writes nothing into the rendering",
        ).toBe(previewText);

        // --- Back to the editor. ---
        await app.nativeKey("p", ["cmd", "alt"]);
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PREVIEW)}) === null`,
          { timeoutMs: 5000 },
        );
        expect(await pressed(app), "the toggle reads off again").toBe("false");
        expect((await waitMenuChecked(app, false)).state, "the View row is unchecked again").toBe(0);
        expect(
          await body.evalJS<boolean>(
            `(() => {
              const el = document.querySelector(${JSON.stringify(EDITOR)});
              return el !== null && el.inert === false &&
                getComputedStyle(el).visibility === "visible";
            })()`,
          ),
          "the editor is uncovered",
        ).toBe(true);
        expect(await body.evalJS<string>(BUFFER_TEXT), "the buffer came back as it was left").toBe(
          bufferBefore,
        );
        expect(
          await body.evalJS<string>(
            `getComputedStyle(document.querySelector(${JSON.stringify(CARET_CELL)})).visibility`,
          ),
          "the caret cell is back",
        ).toBe("visible");
        expect(
          await body.evalJS<boolean | null>(LINE_ENDING_DISABLED),
          "the line-ending popup is live again",
        ).toBe(false);

        // The selection survived the round trip.
        await body.waitForCondition<boolean>(
          `document.getSelection().toString() === "unsaved"`,
          { timeoutMs: 5000 },
        );

        // --- The View row is the same toggle, both ways. ---
        expect(await app.performMenuItem(MENU_ROW), "the View row performs").toMatchObject({
          found: true,
          performed: true,
        });
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${PREVIEW} h1`)}) !== null`,
          { timeoutMs: 5000 },
        );
        expect((await waitMenuChecked(app, true)).state, "the row is checked again").toBe(1);
        expect(await app.performMenuItem(MENU_ROW), "the View row performs").toMatchObject({
          found: true,
          performed: true,
        });
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PREVIEW)}) === null`,
          { timeoutMs: 5000 },
        );
        expect((await waitMenuChecked(app, false)).state, "the row is unchecked").toBe(0);

        // The keyboard is back in the editor: typing replaces exactly what
        // was selected before the first press.
        await body.waitForCondition<boolean>(
          `document.getSelection().toString() === "unsaved"`,
          { timeoutMs: 5000 },
        );
        await app.nativeType("kept");
        await body.waitForCondition<boolean>(
          `${BUFFER_TEXT}.includes("last line words kept") && !${BUFFER_TEXT}.includes("unsaved")`,
          { timeoutMs: 5000 },
        );

        // --- A plain-text file has no preview to offer. ---
        const plainBody = app.body("B");
        const plainContent = `${PLAIN_CARD} [data-slot="tug-text-card-editor"] .cm-content`;
        await plainBody.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(plainContent)})?.textContent ?? "").includes("nothing to render")`,
          { timeoutMs: 10000 },
        );
        expect(
          await plainBody.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(
              `${PLAIN_CARD} [data-testid="text-card-status-preview"]`,
            )}).length`,
          ),
          "no Preview toggle on a plain-text file",
        ).toBe(0);
        await plainBody.nativeClickAtElement(plainContent);
        const dark = Date.now() + 4000;
        let row = await app.menuItemState(MENU_ROW);
        while (!(row.found && row.enabled === false) && Date.now() < dark) {
          await Bun.sleep(100);
          row = await app.menuItemState(MENU_ROW);
        }
        expect(row, "the View row is dark over a plain-text card").toMatchObject({
          found: true,
          enabled: false,
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
